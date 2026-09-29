import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, effectiveClubPermissions, HttpError, requireClubPermission } from './http.js';
import type { AdminRequest } from './admin.js';

const REPORT_STATUSES = ['OPEN', 'IN_REVIEW', 'REFERRED_TO_PLATFORM', 'ACTION_TAKEN', 'CLOSED_NO_ACTION'] as const;
const CLUB_REPORT_STATUSES = ['IN_REVIEW', 'REFERRED_TO_PLATFORM'] as const;
const REPORT_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const THREAD_KINDS = ['SESSION', 'ACCOUNT'] as const;
const ACCOUNT_TYPES = ['STUDENT', 'COACH', 'CLUB'] as const;
const CHAT_ROLES = ['STUDENT', 'COACH', 'CLUB', 'SYSTEM'] as const;
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;

const reportId = z.string().trim().min(1).max(200);
const listQuery = z.object({
  status: z.preprocess(first, z.enum(REPORT_STATUSES).optional()),
  severity: z.preprocess(first, z.enum(REPORT_SEVERITIES).optional()),
  cursor: z.preprocess(first, z.string().trim().min(1).max(1_000).optional()),
  q: z.preprocess(first, z.string().trim().max(80).optional()),
  limit: z.preprocess(first, z.coerce.number().int().min(1).max(50).default(30)),
}).strict();

const adminUpdateBody = z.object({
  status: z.enum(REPORT_STATUSES).optional(),
  severity: z.enum(REPORT_SEVERITIES).optional(),
  assignedTo: z.string().trim().min(1).max(120).nullable().optional(),
  note: z.string().trim().min(1).max(2_000),
}).strict().refine(value => value.status !== undefined || value.severity !== undefined || value.assignedTo !== undefined,
  'Provide at least one report update');

const clubUpdateBody = z.object({
  status: z.enum(CLUB_REPORT_STATUSES).optional(),
  severity: z.enum(REPORT_SEVERITIES).optional(),
  assignment: z.enum(['SELF', 'UNASSIGNED']).optional(),
  note: z.string().trim().min(1).max(2_000),
}).strict().refine(value => value.status !== undefined || value.severity !== undefined || value.assignment !== undefined,
  'Provide at least one report update');

const accountActionBody = z.object({
  action: z.enum(['RESTRICT_ACCOUNT_CHAT', 'RESTORE_ACCOUNT_CHAT']),
  note: z.string().trim().min(1).max(1_000),
}).strict();

function platformActorName(operator: { id: string; name: string; email: string }) {
  // This schema predates named platform operators and has one bounded snapshot
  // column. Preserve all three identity values without exceeding its limit.
  const suffix = ` <${operator.email}> [${operator.id}]`;
  let name = operator.name;
  while (name && Buffer.byteLength(`${name}${suffix}`, 'utf8') > 120) name = [...name].slice(0, -1).join('');
  return `${name}${suffix}`;
}

type ReportCursor = { createdAt: Date; id: string };

function encodeCursor(cursor: ReportCursor) {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): ReportCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded = z.object({ createdAt: z.string().datetime(), id: reportId }).strict()
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { createdAt: new Date(decoded.createdAt), id: decoded.id };
  } catch {
    throw new HttpError(400, 'Invalid safeguarding report cursor');
  }
}

const reportSelect = {
  id: true, threadId: true, messageId: true, businessId: true, bookingId: true,
  reporterUserId: true, subjectUserId: true, category: true, status: true, severity: true,
  childInvolved: true, description: true, evidence: true, evidenceHash: true, assignedClubUserId: true, assignedTo: true,
  createdAt: true, updatedAt: true,
  thread: { select: { kind: true } },
  message: { select: { id: true, senderName: true, senderRole: true, body: true, createdAt: true } },
  business: { select: { id: true, name: true, slug: true, timezone: true } },
  booking: { select: {
    id: true, startAt: true,
    service: { select: { name: true } },
    business: { select: { timezone: true } },
  } },
  reporter: { select: { id: true, name: true, username: true, accountType: true, email: true } },
  subject: { select: { id: true, name: true, username: true, accountType: true, safetyStatus: true } },
} satisfies Prisma.ChatSafetyReportSelect;

const reportDetailSelect = {
  ...reportSelect,
  auditEvents: {
    select: {
      id: true, action: true, actorKind: true, actorName: true, note: true, fromStatus: true,
      toStatus: true, fromSeverity: true, toSeverity: true, assignedTo: true, assignedClubUserId: true, createdAt: true,
    },
    // Keep the newest decisions visible on a long-running case. One extra row
    // lets the response disclose that earlier retained history exists.
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 501,
  },
} satisfies Prisma.ChatSafetyReportSelect;

type ReportRecord = Prisma.ChatSafetyReportGetPayload<{ select: typeof reportSelect }>;
type DetailedReportRecord = Prisma.ChatSafetyReportGetPayload<{ select: typeof reportDetailSelect }>;
type EvidenceObject = Record<string, Prisma.JsonValue>;

function objectValue(value: Prisma.JsonValue | null | undefined): EvidenceObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as EvidenceObject : null;
}

function textValue(value: Prisma.JsonValue | undefined, max: number, allowEmpty = false) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000]/gu, '').slice(0, max);
  return text || allowEmpty ? text : undefined;
}

function enumValue<const T extends readonly string[]>(value: Prisma.JsonValue | undefined, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : undefined;
}

function dateValue(value: Prisma.JsonValue | undefined) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function nestedObject(source: EvidenceObject | null, key: string) {
  return source ? objectValue(source[key]) : null;
}

function evidenceMessage(value: Prisma.JsonValue | null | undefined) {
  const message = objectValue(value);
  if (!message) return null;
  const sender = nestedObject(message, 'sender');
  const senderName = textValue(message.senderName, 200, true) ?? textValue(sender?.name, 200, true) ?? '';
  const body = textValue(message.body, 20_000, true);
  const createdAt = dateValue(message.createdAt);
  if (body === undefined || !createdAt) return null;
  const id = textValue(message.id, 200);
  const senderRole = enumValue(message.senderRole, CHAT_ROLES) ?? enumValue(sender?.role, CHAT_ROLES);
  return { ...(id ? { id } : {}), senderName, ...(senderRole ? { senderRole } : {}), body, createdAt };
}

function evidenceBusiness(evidence: EvidenceObject | null, report: ReportRecord) {
  const snapshot = nestedObject(evidence, 'business');
  const name = textValue(snapshot?.name, 200) ?? report.business?.name;
  if (!name) return null;
  const id = textValue(snapshot?.id, 200) ?? report.business?.id;
  const slug = textValue(snapshot?.slug, 200) ?? report.business?.slug;
  return { ...(id ? { id } : {}), name, ...(slug ? { slug } : {}) };
}

function evidenceSession(evidence: EvidenceObject | null, report: ReportRecord) {
  const snapshot = nestedObject(evidence, 'session');
  const bookingId = textValue(snapshot?.bookingId, 200) ?? report.booking?.id ?? report.bookingId ?? undefined;
  const serviceName = textValue(snapshot?.serviceName, 200) ?? report.booking?.service.name;
  const startAt = dateValue(snapshot?.startAt) ?? report.booking?.startAt.toISOString();
  const timezone = textValue(snapshot?.timezone, 100) ?? report.booking?.business.timezone ?? report.business?.timezone;
  if (!bookingId && !serviceName && !startAt && !timezone) return null;
  return {
    ...(bookingId ? { bookingId } : {}), ...(serviceName ? { serviceName } : {}),
    ...(startAt ? { startAt } : {}), ...(timezone ? { timezone } : {}),
  };
}

function evidenceThread(evidence: EvidenceObject | null, report: ReportRecord) {
  const snapshot = nestedObject(evidence, 'thread');
  const id = textValue(snapshot?.id, 200) ?? report.threadId ?? undefined;
  const kind = enumValue(snapshot?.kind, THREAD_KINDS) ?? enumValue(report.thread?.kind, THREAD_KINDS)
    ?? (report.bookingId ? 'SESSION' : 'ACCOUNT');
  return { ...(id ? { id } : {}), kind };
}

function evidenceMembers(evidence: EvidenceObject | null) {
  const value = evidence?.members;
  if (!Array.isArray(value)) return undefined;
  const members = value.slice(0, 100).flatMap(item => {
    const member = objectValue(item);
    if (!member) return [];
    const name = textValue(member.name, 200, true) ?? '';
    const username = textValue(member.username, 30);
    const role = enumValue(member.role, CHAT_ROLES);
    return [{ name, ...(username ? { username } : {}), ...(role ? { role } : {}) }];
  });
  return members.length ? members : undefined;
}

function safeEvidence(report: ReportRecord) {
  const evidence = objectValue(report.evidence);
  const context = Array.isArray(evidence?.context)
    ? evidence.context.slice(0, 100).map(evidenceMessage).filter((message): message is NonNullable<typeof message> => !!message)
    : undefined;
  const reportedMessage = evidenceMessage(evidence?.reportedMessage) ?? (report.message ? {
    id: report.message.id, senderName: report.message.senderName,
    ...(enumValue(report.message.senderRole, CHAT_ROLES) ? { senderRole: enumValue(report.message.senderRole, CHAT_ROLES) } : {}),
    body: report.message.body, createdAt: report.message.createdAt.toISOString(),
  } : null);
  const members = evidenceMembers(evidence);
  return {
    thread: evidenceThread(evidence, report),
    business: evidenceBusiness(evidence, report),
    session: evidenceSession(evidence, report),
    ...(members ? { members } : {}),
    reportedMessage,
    ...(context?.length ? { context } : {}),
  };
}

function subjectJson(report: ReportRecord, platform: boolean) {
  const evidence = objectValue(report.evidence);
  const snapshot = nestedObject(evidence, 'subject');
  const name = report.subject?.name ?? textValue(snapshot?.name, 200, true) ?? 'Unavailable account';
  const username = report.subject?.username ?? textValue(snapshot?.username, 30, true) ?? '';
  const accountType = enumValue(report.subject?.accountType, ACCOUNT_TYPES) ?? enumValue(snapshot?.accountType, ACCOUNT_TYPES);
  return {
    name, username, ...(accountType ? { accountType } : {}),
    ...(platform && (report.subject?.id ?? report.subjectUserId) ? { userId: report.subject?.id ?? report.subjectUserId! } : {}),
    ...(platform && report.subject?.safetyStatus ? { safetyStatus: report.subject.safetyStatus } : {}),
  };
}

function reporterJson(report: ReportRecord) {
  const evidence = objectValue(report.evidence);
  const snapshot = nestedObject(evidence, 'reporter');
  const name = report.reporter?.name ?? textValue(snapshot?.name, 200, true);
  const username = report.reporter?.username ?? textValue(snapshot?.username, 30, true);
  const accountType = enumValue(report.reporter?.accountType, ACCOUNT_TYPES) ?? enumValue(snapshot?.accountType, ACCOUNT_TYPES);
  const email = report.reporter?.email ?? textValue(snapshot?.email, 320, true);
  if (!accountType) return null;
  return {
    name: name ?? '', username: username ?? '', ...(accountType ? { accountType } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

function reportSummaryJson(report: ReportRecord) {
  const evidence = safeEvidence(report);
  return {
    id: report.id, category: report.category, status: report.status, severity: report.severity,
    childInvolved: report.childInvolved, assignedTo: report.assignedTo, threadKind: evidence.thread.kind,
    subject: subjectJson(report, false), createdAt: report.createdAt.toISOString(), updatedAt: report.updatedAt.toISOString(),
    business: evidence.business, session: evidence.session, reportedMessage: evidence.reportedMessage,
  };
}

function reportJson(report: DetailedReportRecord, platform: boolean) {
  const summary = reportSummaryJson(report);
  if (!platform) return summary;
  const auditHistoryHasEarlier = report.auditEvents.length > 500;
  const audits = report.auditEvents.slice(0, 500).reverse();
  return {
    ...summary,
    subject: subjectJson(report, true),
    reporter: reporterJson(report),
    description: report.description || null,
    evidence: safeEvidence(report),
    evidenceHash: report.evidenceHash,
    audits: audits.map(event => ({
      id: event.id, action: event.action, actorKind: event.actorKind, actorName: event.actorName,
      note: event.note, fromStatus: event.fromStatus, toStatus: event.toStatus,
      fromSeverity: event.fromSeverity, toSeverity: event.toSeverity, assignedTo: event.assignedTo,
      assignedClubUserId: event.assignedClubUserId,
      createdAt: event.createdAt.toISOString(),
    })),
    auditHistoryHasEarlier,
    targetSafetyStatus: report.subject?.safetyStatus ?? null,
  };
}

function cursorWhere(cursor: ReportCursor | undefined): Prisma.ChatSafetyReportWhereInput {
  return cursor ? { OR: [
    { createdAt: { lt: cursor.createdAt } },
    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
  ] } : {};
}

function clubScope(businessId: string): Prisma.ChatSafetyReportWhereInput {
  return {
    businessId,
    OR: [
      { thread: { is: { kind: 'SESSION' } } },
      // Once the source thread is deleted the immutable snapshot remains the
      // only thread-kind evidence. A live ACCOUNT thread can never be made
      // visible to a club by malformed or inconsistent snapshot JSON.
      { threadId: null, evidence: { path: ['thread', 'kind'], equals: 'SESSION' } },
    ],
  };
}

function searchWhere(q: string | undefined, platform: boolean): Prisma.ChatSafetyReportWhereInput {
  if (!q) return {};
  const contains = { contains: q, mode: 'insensitive' as const };
  return { OR: [
    { id: contains }, { assignedTo: contains },
    { subject: { is: { OR: [{ name: contains }, { username: contains }] } } },
    { business: { is: { OR: [{ name: contains }, { slug: contains }] } } },
    ...(platform ? [{ reporter: { is: { OR: [{ name: contains }, { username: contains }] } } }] : []),
  ] };
}

async function listReports(scope: Prisma.ChatSafetyReportWhereInput, rawQuery: unknown, platform: boolean) {
  const query = listQuery.parse(rawQuery);
  const cursor = decodeCursor(query.cursor);
  const reports = await prisma.chatSafetyReport.findMany({
    where: { AND: [scope, cursorWhere(cursor), searchWhere(query.q, platform),
      ...(query.status ? [{ status: query.status }] : []),
      ...(query.severity ? [{ severity: query.severity }] : []),
    ] },
    select: reportSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });
  const page = reports.slice(0, query.limit);
  return {
    reports: page.map(reportSummaryJson),
    nextCursor: reports.length > query.limit && page.length
      ? encodeCursor({ createdAt: page.at(-1)!.createdAt, id: page.at(-1)!.id })
      : null,
  };
}

async function findReport(
  db: Prisma.TransactionClient | typeof prisma, id: string, scope: Prisma.ChatSafetyReportWhereInput,
) {
  const report = await db.chatSafetyReport.findFirst({ where: { AND: [{ id }, scope] }, select: reportDetailSelect });
  if (!report) throw new HttpError(404, 'Safeguarding report not found');
  return report;
}

async function lockReport(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "ChatSafetyReport" WHERE "id" = ${id} FOR UPDATE`;
}

type StaffReviewAuthority = { accessId: string; businessId: string; userId: string };

async function requireLiveStaffReviewAuthority(
  tx: Prisma.TransactionClient, authority: StaffReviewAuthority | undefined,
) {
  if (!authority) return;
  const [access] = await tx.$queryRaw<Array<{
    id: string; businessId: string; userId: string; active: boolean; revokedAt: Date | null; permissions: string[];
  }>>`
    SELECT "id", "businessId", "userId", "active", "revokedAt", "permissions"
    FROM "ClubStaffAccess"
    WHERE "id" = ${authority.accessId}
    FOR SHARE
  `;
  if (!access || access.businessId !== authority.businessId || access.userId !== authority.userId
    || !access.active || access.revokedAt
    || !effectiveClubPermissions(access.permissions).includes('SAFEGUARDING_REVIEW')) {
    throw new HttpError(403, 'This workspace requires safeguarding review permission');
  }
}

async function updateReport(
  scope: Prisma.ChatSafetyReportWhereInput, id: string,
  update: {
    status?: typeof REPORT_STATUSES[number]; severity?: typeof REPORT_SEVERITIES[number];
    assignedTo?: string | null; assignedClubUserId?: string | null; note: string;
  },
  actor: { kind: string; userId: string | null; name: string }, platform: boolean,
  staffAuthority?: StaffReviewAuthority,
) {
  return prisma.$transaction(async tx => {
    // Middleware authorization is a request snapshot. Holding a share lock on
    // the selected live grant makes this mutation serialize with permission
    // downgrades and revocation, whose UPDATE takes the conflicting row lock.
    await requireLiveStaffReviewAuthority(tx, staffAuthority);
    await lockReport(tx, id);
    const current = await findReport(tx, id, scope);
    const data: Prisma.ChatSafetyReportUpdateInput = {};
    if (update.status !== undefined) data.status = update.status;
    if (update.severity !== undefined) data.severity = update.severity;
    if (update.assignedTo !== undefined) data.assignedTo = update.assignedTo;
    if (update.assignedClubUserId !== undefined) {
      data.assignedClubUser = update.assignedClubUserId
        ? { connect: { id: update.assignedClubUserId } }
        : { disconnect: true };
    }
    const toStatus = update.status ?? current.status;
    const toSeverity = update.severity ?? current.severity;
    const assignedTo = update.assignedTo === undefined ? current.assignedTo : update.assignedTo;
    const assignedClubUserId = update.assignedClubUserId === undefined
      ? current.assignedClubUserId : update.assignedClubUserId;
    // The database guard requires the immutable event to exist in this same
    // transaction before any mutable case decision can change. This ordering
    // makes bypasses through future ORM code fail closed.
    await tx.chatSafetyAuditEvent.create({ data: {
      reportId: id, actorKind: actor.kind, actorUserId: actor.userId, actorName: actor.name,
      action: 'REPORT_REVIEW_UPDATED', note: update.note,
      fromStatus: current.status, toStatus, fromSeverity: current.severity, toSeverity, assignedTo, assignedClubUserId,
    } });
    await tx.$executeRaw`SELECT set_config('courtly.safeguarding_audited_reports', ${id}, true)`;
    if (Object.keys(data).length) await tx.chatSafetyReport.update({ where: { id }, data });
    return reportJson(await findReport(tx, id, scope), platform);
  });
}

export const safeguardingRouter = Router();
export const adminSafeguardingRouter = Router();

safeguardingRouter.get('/safeguarding/reports', requireClubPermission('SAFEGUARDING_VIEW'), asyncRoute(async (req, res) => {
  res.json(await listReports(clubScope(req.auth.business.id), req.query, false));
}));

safeguardingRouter.get('/safeguarding/reports/:id', requireClubPermission('SAFEGUARDING_VIEW'), asyncRoute(async (req, res) => {
  const id = reportId.parse(req.params.id);
  res.json({ report: reportJson(await findReport(prisma, id, clubScope(req.auth.business.id)), false) });
}));

safeguardingRouter.patch('/safeguarding/reports/:id', requireClubPermission('SAFEGUARDING_REVIEW'), asyncRoute(async (req, res) => {
  const id = reportId.parse(req.params.id);
  const body = clubUpdateBody.parse(req.body);
  // assignedTo is an operator-facing label, not an authorization identifier.
  // assignedClubUserId is the stable club owner while the label is a snapshot
  // that remains useful after a rename or account deletion.
  const assignedTo = body.assignment === 'SELF' ? req.auth.user.name : body.assignment === 'UNASSIGNED' ? null : undefined;
  const assignedClubUserId = body.assignment === 'SELF' ? req.auth.user.id
    : body.assignment === 'UNASSIGNED' ? null : undefined;
  const report = await updateReport(clubScope(req.auth.business.id), id, {
    status: body.status, severity: body.severity, assignedTo, assignedClubUserId, note: body.note,
  }, {
    kind: req.auth.accessMode === 'STAFF' ? 'CLUB_STAFF' : 'CLUB_ACCOUNT',
    userId: req.auth.user.id, name: req.auth.user.name,
  }, false, req.auth.staffAccess ? {
    accessId: req.auth.staffAccess.id, businessId: req.auth.business.id, userId: req.auth.user.id,
  } : undefined);
  res.json({ report });
}));

adminSafeguardingRouter.get('/reports', asyncRoute(async (req, res) => {
  res.json(await listReports({}, req.query, true));
}));

adminSafeguardingRouter.get('/reports/:id', asyncRoute(async (req, res) => {
  const id = reportId.parse(req.params.id);
  res.json({ report: reportJson(await findReport(prisma, id, {}), true) });
}));

adminSafeguardingRouter.patch('/reports/:id', asyncRoute(async (req, res) => {
  const id = reportId.parse(req.params.id);
  const body = adminUpdateBody.parse(req.body);
  const operator = (req as unknown as AdminRequest).admin.operator!;
  const report = await updateReport({}, id, {
    ...body,
    // An explicit platform label replaces any previously selected club owner.
    ...(body.assignedTo !== undefined ? { assignedClubUserId: null } : {}),
  }, {
    kind: 'PLATFORM_ADMIN', userId: null, name: platformActorName(operator),
  }, true);
  res.json({ report });
}));

adminSafeguardingRouter.post('/reports/:id/account-action', asyncRoute(async (req, res) => {
  const id = reportId.parse(req.params.id);
  const body = accountActionBody.parse(req.body);
  const operator = (req as unknown as AdminRequest).admin.operator!;
  const report = await prisma.$transaction(async tx => {
    await lockReport(tx, id);
    const current = await findReport(tx, id, {});
    if (!current.subjectUserId) throw new HttpError(409, 'The reported account is no longer available');
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${current.subjectUserId} FOR UPDATE`;
    const subject = await tx.user.findUnique({
      where: { id: current.subjectUserId }, select: { id: true, safetyStatus: true },
    });
    if (!subject) throw new HttpError(409, 'The reported account is no longer available');
    const restricting = body.action === 'RESTRICT_ACCOUNT_CHAT';
    const latestHere = await tx.chatSafetyAuditEvent.findFirst({
      where: { reportId: id, action: { in: ['RESTRICT_ACCOUNT_CHAT', 'RESTORE_ACCOUNT_CHAT'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { action: true },
    });
    if (latestHere?.action === body.action) return reportJson(current, true);
    let activeFromOtherCase = false;
    if (!restricting) {
      // A different case may independently justify the account-wide contact
      // restriction. Restore only when this case owns every currently active
      // restriction, rather than letting one reviewer silently undo another.
      const activeRestrictions = await tx.$queryRaw<Array<{ reportId: string; action: string }>>`
        SELECT latest."reportId", latest."action" FROM (
          SELECT DISTINCT ON (event."reportId") event."reportId", event."action"
          FROM "ChatSafetyAuditEvent" AS event
          JOIN "ChatSafetyReport" AS report ON report."id" = event."reportId"
          WHERE report."subjectUserId" = ${subject.id}
            AND event."action" IN ('RESTRICT_ACCOUNT_CHAT', 'RESTORE_ACCOUNT_CHAT')
          ORDER BY event."reportId", event."createdAt" DESC, event."id" DESC
        ) AS latest
        WHERE latest."action" = 'RESTRICT_ACCOUNT_CHAT'`;
      activeFromOtherCase = activeRestrictions.some(action => action.reportId !== id);
      if (latestHere?.action !== 'RESTRICT_ACCOUNT_CHAT') {
        throw new HttpError(409, 'This case does not own the account chat restriction');
      }
    }
    const toStatus = restricting ? 'ACTION_TAKEN' : current.status;
    // Insert the attributable evidence first so the database decision guard can
    // verify the case mutation belongs to this transaction.
    await tx.chatSafetyAuditEvent.create({ data: {
      reportId: id, actorKind: 'PLATFORM_ADMIN', actorUserId: null,
      actorName: platformActorName(operator),
      action: body.action, note: body.note, fromStatus: current.status, toStatus,
      fromSeverity: current.severity, toSeverity: current.severity, assignedTo: current.assignedTo,
      assignedClubUserId: current.assignedClubUserId,
    } });
    await tx.$executeRaw`SELECT set_config('courtly.safeguarding_audited_reports', ${id}, true)`;
    const desiredStatus = restricting || activeFromOtherCase ? 'ACCOUNT_CHAT_RESTRICTED' : 'ACTIVE';
    if (subject.safetyStatus !== desiredStatus) {
      await tx.user.update({ where: { id: subject.id }, data: { safetyStatus: desiredStatus } });
    }
    if (toStatus !== current.status) {
      await tx.chatSafetyReport.update({ where: { id }, data: { status: toStatus } });
    }
    return reportJson(await findReport(tx, id, {}), true);
  });
  res.json({ report });
}));
