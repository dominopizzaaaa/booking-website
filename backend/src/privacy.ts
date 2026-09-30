import { Router, type RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError, requireRecentAuth } from './http.js';
import {
  CURRENT_CHILD_PRIVACY_POLICY_VERSION, CURRENT_LEGAL_POLICY_SET_HASH, CURRENT_PRIVACY_NOTICE_VERSION,
  CURRENT_TERMS_VERSION, DATA_PROTECTION_OFFICER, LEGAL_DOCUMENTS_APPROVED, LEGAL_ROUTES,
} from './legal-policy.js';
import { requireAdmin, requireNamedAdmin, type AdminRequest } from './admin.js';

const DAY_MS = 86_400_000;
const ACTIVE_STATUSES = ['RECEIVED', 'IDENTITY_VERIFICATION', 'IN_REVIEW', 'WAITING_FOR_SUBJECT'] as const;
const TERMINAL_STATUSES = ['COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED', 'CANCELLED'] as const;
const OPERATOR_STATUSES = [...ACTIVE_STATUSES, 'COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED'] as const;
const REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'DELETION', 'CONSENT_WITHDRAWAL', 'RESTRICTION', 'OBJECTION'] as const;
const REQUEST_STATUSES = [...ACTIVE_STATUSES, ...TERMINAL_STATUSES] as const;
const DECISIONS = ['FULFILLED', 'PARTIALLY_FULFILLED', 'REFUSED', 'WITHDRAWN_BY_SUBJECT'] as const;
const TERMINAL_DECISION = {
  COMPLETED: 'FULFILLED',
  PARTIALLY_COMPLETED: 'PARTIALLY_FULFILLED',
  REFUSED: 'REFUSED',
  CANCELLED: 'WITHDRAWN_BY_SUBJECT',
} as const;
const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  RECEIVED: ['RECEIVED', 'IDENTITY_VERIFICATION', 'IN_REVIEW'],
  IDENTITY_VERIFICATION: ['IDENTITY_VERIFICATION', 'IN_REVIEW', 'WAITING_FOR_SUBJECT', 'REFUSED'],
  IN_REVIEW: ['IN_REVIEW', 'WAITING_FOR_SUBJECT', 'COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED'],
  WAITING_FOR_SUBJECT: ['WAITING_FOR_SUBJECT', 'IDENTITY_VERIFICATION', 'IN_REVIEW', 'REFUSED'],
};
const empty = z.object({}).strict();
const idParam = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const pageSize = z.coerce.number().int().min(1).max(200).default(25);
const eventPageSize = z.coerce.number().int().min(1).max(100).default(25);
const cursorValue = z.object({ at: z.string().datetime(), id: z.string().min(1).max(200) }).strict();

function encodeCursor(at: Date, id: string) {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const decoded = cursorValue.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { at: new Date(decoded.at), id: decoded.id };
  } catch {
    throw new HttpError(400, 'Invalid pagination cursor');
  }
}

const createRequestBody = z.object({
  type: z.enum(REQUEST_TYPES),
  details: z.string().trim().max(4000).default(''),
  correctionFields: z.record(z.string().trim().min(1).max(120), z.string().trim().max(2000)).optional(),
  acknowledgeConsequences: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (value.type === 'CORRECTION' && (!value.correctionFields || Object.keys(value.correctionFields).length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['correctionFields'], message: 'Describe at least one correction' });
  }
  if (value.correctionFields && Object.keys(value.correctionFields).length > 20) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['correctionFields'], message: 'Describe no more than 20 corrections' });
  }
  if (value.type !== 'CORRECTION' && value.correctionFields !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['correctionFields'], message: 'Correction fields are only valid for correction requests' });
  }
  if (value.type === 'CONSENT_WITHDRAWAL' && value.acknowledgeConsequences !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['acknowledgeConsequences'], message: 'Acknowledge the consequences of withdrawing consent' });
  }
});

const operatorQuery = z.object({
  status: z.union([z.enum(REQUEST_STATUSES), z.literal('ACTIVE')]).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  limit: pageSize,
  cursor: z.string().min(1).max(1000).optional(),
}).strict().superRefine((value, context) => {
  if (value.overdue === 'true' && value.status && value.status !== 'ACTIVE'
    && !ACTIVE_STATUSES.includes(value.status as typeof ACTIVE_STATUSES[number])) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['overdue'], message: 'Overdue filtering is only valid for active requests' });
  }
});

const subjectQuery = z.object({
  limit: pageSize,
  cursor: z.string().min(1).max(1000).optional(),
}).strict();
const eventQuery = z.object({
  limit: eventPageSize,
  cursor: z.string().min(1).max(1000).optional(),
}).strict();

const operatorUpdateBody = z.object({
  status: z.enum(OPERATOR_STATUSES),
  note: z.string().trim().min(1).max(4000),
  externalAuditReference: z.string().trim().min(1).max(200),
  identityVerified: z.boolean().optional(),
  delayReason: z.string().trim().min(1).max(2000).optional(),
  estimatedResponseAt: z.string().datetime({ offset: true }).optional(),
  legalHold: z.boolean().optional(),
  legalHoldReason: z.string().trim().min(1).max(2000).optional(),
  decision: z.enum(DECISIONS).optional(),
  decisionReason: z.string().trim().min(1).max(4000).optional(),
}).strict().superRefine((value, context) => {
  if ((value.delayReason === undefined) !== (value.estimatedResponseAt === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['delayReason'], message: 'A delay requires both a reason and estimated response time' });
  }
  if (value.legalHold === true && !value.legalHoldReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['legalHoldReason'], message: 'A legal hold requires a reason' });
  }
  if (value.legalHold === false && value.legalHoldReason !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['legalHoldReason'], message: 'Remove the legal hold reason when releasing a hold' });
  }
  if (TERMINAL_STATUSES.includes(value.status as typeof TERMINAL_STATUSES[number])) {
    if (!value.decision || !value.decisionReason) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision'], message: 'A terminal decision and reason are required' });
    } else if (value.decision !== TERMINAL_DECISION[value.status as keyof typeof TERMINAL_DECISION]) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision'], message: 'Decision does not match the terminal request status' });
    }
  } else if (value.decision || value.decisionReason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['decision'], message: 'Decision fields are only valid when closing a request' });
  }
  if (value.estimatedResponseAt && new Date(value.estimatedResponseAt).getTime() <= Date.now()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['estimatedResponseAt'], message: 'Estimated response time must be in the future' });
  }
});

function requestJson(request: {
  id: string; type: string; status: string; details: string; correctionFields: Prisma.JsonValue | null;
  submittedAt: Date; acknowledgementDueAt: Date; responseDueAt: Date; acknowledgedAt: Date | null;
  identityVerifiedAt: Date | null; delayNoticeAt: Date | null; delayReason: string | null;
  estimatedResponseAt: Date | null; legalHold: boolean; legalHoldReason: string | null; decision: string | null;
  decisionReason: string | null; completedAt: Date | null; cancelledAt: Date | null; updatedAt: Date;
}, includeOperatorDetails = false) {
  const now = new Date();
  return {
    id: request.id, type: request.type, status: request.status, details: request.details,
    correctionFields: request.correctionFields, submittedAt: request.submittedAt.toISOString(),
    acknowledgementDueAt: request.acknowledgementDueAt.toISOString(),
    responseDueAt: request.responseDueAt.toISOString(),
    overdue: ACTIVE_STATUSES.includes(request.status as typeof ACTIVE_STATUSES[number])
      && request.responseDueAt < now,
    acknowledgedAt: request.acknowledgedAt?.toISOString() ?? null,
    identityVerifiedAt: request.identityVerifiedAt?.toISOString() ?? null,
    delayNoticeAt: request.delayNoticeAt?.toISOString() ?? null,
    delayReason: request.delayReason, estimatedResponseAt: request.estimatedResponseAt?.toISOString() ?? null,
    decision: request.decision, decisionReason: request.decisionReason,
    completedAt: request.completedAt?.toISOString() ?? null,
    cancelledAt: request.cancelledAt?.toISOString() ?? null, updatedAt: request.updatedAt.toISOString(),
    ...(includeOperatorDetails ? { legalHold: request.legalHold, legalHoldReason: request.legalHoldReason } : {}),
  };
}

export const privacyPublicRouter = Router();
export const privacyRouter = Router();
export const privacyAdminRouter = Router();

privacyPublicRouter.get('/compliance', asyncRoute(async (req, res) => {
  empty.parse(req.query);
  res.json({
    dataProtectionOfficer: DATA_PROTECTION_OFFICER,
    legalPublication: {
      approved: LEGAL_DOCUMENTS_APPROVED, version: CURRENT_TERMS_VERSION,
      contentHash: CURRENT_LEGAL_POLICY_SET_HASH,
    },
    legal: {
      terms: { version: CURRENT_TERMS_VERSION, path: LEGAL_ROUTES.terms },
      privacy: { version: CURRENT_PRIVACY_NOTICE_VERSION, path: LEGAL_ROUTES.privacy },
      childPrivacy: { version: CURRENT_CHILD_PRIVACY_POLICY_VERSION, path: LEGAL_ROUTES.childPrivacy },
      acceptableUse: { path: LEGAL_ROUTES.acceptableUse },
      cancellationRefunds: { path: LEGAL_ROUTES.cancellationRefunds },
      packageTerms: { path: LEGAL_ROUTES.packageTerms },
    },
    privacyRequests: { authenticatedPath: '/api/privacy/requests', responseTrackingDays: 30 },
  });
}));

privacyRouter.get('/requests', asyncRoute(async (req, res) => {
  const query = subjectQuery.parse(req.query);
  const cursor = decodeCursor(query.cursor);
  const requests = await prisma.privacyRequest.findMany({
    where: { subjectUserId: req.auth.user.id, ...(cursor ? { OR: [
      { submittedAt: { lt: cursor.at } },
      { submittedAt: cursor.at, id: { lt: cursor.id } },
    ] } : {}) },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  });
  const page = requests.slice(0, query.limit);
  const last = page.at(-1);
  res.json({
    requests: page.map(request => requestJson(request)),
    nextCursor: requests.length > query.limit && last ? encodeCursor(last.submittedAt, last.id) : null,
  });
}));

privacyRouter.post('/requests', asyncRoute(async (req, res) => {
  const body = createRequestBody.parse(req.body);
  if (!req.auth.user.emailVerifiedAt) {
    throw new HttpError(403, 'Verify your email before submitting a privacy request', {
      code: 'EMAIL_VERIFICATION_REQUIRED',
    });
  }
  const now = new Date();
  const responseDueAt = new Date(now.getTime() + 30 * DAY_MS);
  let created;
  try {
    created = await prisma.$transaction(async tx => {
      const request = await tx.privacyRequest.create({ data: {
        subjectUserId: req.auth.user.id, type: body.type, details: body.details,
        correctionFields: body.correctionFields as Prisma.InputJsonValue | undefined, submittedAt: now,
        acknowledgementDueAt: responseDueAt, responseDueAt, identityVerifiedAt: null,
      } });
      await tx.privacyRequestEvent.create({ data: {
        requestId: request.id, action: 'REQUEST_SUBMITTED', actorKind: 'SUBJECT',
        actorUserId: req.auth.user.id, actorNameSnapshot: req.auth.user.name,
        actorEmailSnapshot: req.auth.user.email ?? '', toStatus: request.status,
        note: body.type === 'CONSENT_WITHDRAWAL'
          ? 'Subject acknowledged that withdrawing consent may limit or end affected services.'
          : '',
      } });
      return request;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'An open request of this type already exists', { code: 'PRIVACY_REQUEST_ALREADY_OPEN' });
    }
    throw error;
  }
  res.status(201).json({ request: requestJson(created) });
}));

privacyRouter.post('/requests/:id/cancel', requireRecentAuth, asyncRoute(async (req, res) => {
  empty.parse(req.body ?? {});
  const { id } = idParam.parse(req.params);
  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PrivacyRequest" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.privacyRequest.findFirst({ where: { id, subjectUserId: req.auth.user.id } });
    if (!current) throw new HttpError(404, 'Privacy request not found');
    if (!ACTIVE_STATUSES.includes(current.status as typeof ACTIVE_STATUSES[number])) {
      throw new HttpError(409, 'This privacy request is already closed', { code: 'PRIVACY_REQUEST_CLOSED' });
    }
    const now = new Date();
    const request = await tx.privacyRequest.update({ where: { id }, data: {
      status: 'CANCELLED', decision: 'WITHDRAWN_BY_SUBJECT',
      decisionReason: 'Withdrawn by the data subject.', cancelledAt: now,
    } });
    await tx.privacyRequestEvent.create({ data: {
      requestId: id, action: 'REQUEST_CANCELLED', actorKind: 'SUBJECT', actorUserId: req.auth.user.id,
      actorNameSnapshot: req.auth.user.name, actorEmailSnapshot: req.auth.user.email ?? '',
      fromStatus: current.status, toStatus: request.status, note: 'Withdrawn by the data subject.',
    } });
    return request;
  });
  res.json({ request: requestJson(updated) });
}));

// Keep this second acknowledgement explicit so generic admin tooling cannot
// accidentally mutate privacy cases. Authentication remains the admin session
// enforced by admin.ts; this header is not represented as a second factor.
const requirePrivacyOperator: RequestHandler = asyncRoute(async (req, _res, next) => {
  if (req.get('x-courtly-privacy-operator') !== '1') {
    throw new HttpError(403, 'Privacy operator confirmation is required');
  }
  next();
});

privacyAdminRouter.get('/admin/privacy-requests', requireAdmin, requireNamedAdmin, requirePrivacyOperator, asyncRoute(async (req, res) => {
  const query = operatorQuery.parse(req.query);
  const cursor = decodeCursor(query.cursor);
  const requests = await prisma.privacyRequest.findMany({
    where: {
      ...(query.status === 'ACTIVE' ? { status: { in: [...ACTIVE_STATUSES] } }
        : query.status ? { status: query.status } : {}),
      ...(query.overdue === 'true' ? { status: { in: [...ACTIVE_STATUSES] }, responseDueAt: { lt: new Date() } } : {}),
      ...(cursor ? { OR: [
        { responseDueAt: { gt: cursor.at } },
        { responseDueAt: cursor.at, id: { gt: cursor.id } },
      ] } : {}),
    },
    include: { subject: { select: { name: true, username: true, email: true, emailVerifiedAt: true } } },
    orderBy: [{ responseDueAt: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  });
  const page = requests.slice(0, query.limit);
  const last = page.at(-1);
  res.json({
    requests: page.map(request => ({ ...requestJson(request, true), subject: request.subject })),
    nextCursor: requests.length > query.limit && last ? encodeCursor(last.responseDueAt, last.id) : null,
  });
}));

privacyAdminRouter.get('/admin/privacy-requests/:id/events', requireAdmin, requireNamedAdmin, requirePrivacyOperator, asyncRoute(async (req, res) => {
  const { id } = idParam.parse(req.params);
  const query = eventQuery.parse(req.query);
  const cursor = decodeCursor(query.cursor);
  const exists = await prisma.privacyRequest.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new HttpError(404, 'Privacy request not found');
  const events = await prisma.privacyRequestEvent.findMany({
    where: { requestId: id, ...(cursor ? { OR: [
      { createdAt: { lt: cursor.at } },
      { createdAt: cursor.at, id: { lt: cursor.id } },
    ] } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
    select: {
      id: true, action: true, actorKind: true, actorNameSnapshot: true,
      actorEmailSnapshot: true, fromStatus: true, toStatus: true, note: true, metadata: true, createdAt: true,
    },
  });
  const page = events.slice(0, query.limit);
  const last = page.at(-1);
  res.json({
    events: page.map(event => {
      const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
        ? event.metadata as Record<string, unknown> : {};
      return {
        id: event.id, action: event.action, actorKind: event.actorKind,
        actorNameSnapshot: event.actorNameSnapshot, actorEmailSnapshot: event.actorEmailSnapshot,
        fromStatus: event.fromStatus, toStatus: event.toStatus, note: event.note,
        metadata: {
          ...(typeof metadata.externalAuditReference === 'string' ? { externalAuditReference: metadata.externalAuditReference } : {}),
          ...(typeof metadata.identityVerified === 'boolean' ? { identityVerified: metadata.identityVerified } : {}),
          ...(typeof metadata.delayNotified === 'boolean' ? { delayNotified: metadata.delayNotified } : {}),
          ...(typeof metadata.legalHold === 'boolean' ? { legalHold: metadata.legalHold } : {}),
          ...(typeof metadata.decision === 'string' || metadata.decision === null ? { decision: metadata.decision } : {}),
        },
        createdAt: event.createdAt.toISOString(),
      };
    }),
    nextCursor: events.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  });
}));

privacyAdminRouter.patch('/admin/privacy-requests/:id', requireAdmin, requireNamedAdmin, requirePrivacyOperator, asyncRoute(async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = operatorUpdateBody.parse(req.body);
  const operator = (req as unknown as AdminRequest).admin.operator!;
  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PrivacyRequest" WHERE id = ${id} FOR UPDATE`;
    const current = await tx.privacyRequest.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, 'Privacy request not found');
    if (TERMINAL_STATUSES.includes(current.status as typeof TERMINAL_STATUSES[number])) {
      throw new HttpError(409, 'This privacy request is already closed', { code: 'PRIVACY_REQUEST_CLOSED' });
    }
    if (!STATUS_TRANSITIONS[current.status]?.includes(body.status)) {
      throw new HttpError(409, 'That privacy request status transition is not allowed', {
        code: 'PRIVACY_REQUEST_TRANSITION_INVALID', fromStatus: current.status, toStatus: body.status,
      });
    }
    const now = new Date();
    const identityVerifiedAt = current.identityVerifiedAt ?? (body.identityVerified ? now : null);
    if (['IN_REVIEW', 'COMPLETED', 'PARTIALLY_COMPLETED'].includes(body.status) && !identityVerifiedAt) {
      throw new HttpError(409, 'Verify the requester identity before reviewing or fulfilling this request', {
        code: 'PRIVACY_IDENTITY_VERIFICATION_REQUIRED',
      });
    }
    const terminal = TERMINAL_STATUSES.includes(body.status as typeof TERMINAL_STATUSES[number]);
    const request = await tx.privacyRequest.update({ where: { id }, data: {
      status: body.status,
      ...(!current.acknowledgedAt ? { acknowledgedAt: now } : {}),
      ...(identityVerifiedAt && !current.identityVerifiedAt ? { identityVerifiedAt } : {}),
      ...(body.delayReason ? { delayNoticeAt: now, delayReason: body.delayReason, estimatedResponseAt: new Date(body.estimatedResponseAt!) } : {}),
      ...(body.legalHold === undefined ? {} : { legalHold: body.legalHold, legalHoldReason: body.legalHold ? body.legalHoldReason! : null }),
      ...(terminal ? {
        decision: body.decision!, decisionReason: body.decisionReason!,
        completedAt: now,
      } : {}),
    } });
    await tx.privacyRequestEvent.create({ data: {
      requestId: id, action: terminal ? 'REQUEST_DECIDED' : 'REQUEST_UPDATED', actorKind: 'OPERATOR',
      actorUserId: operator.id, actorNameSnapshot: operator.name,
      actorEmailSnapshot: operator.email, fromStatus: current.status, toStatus: request.status,
      note: body.note, metadata: {
        externalAuditReference: body.externalAuditReference,
        identityVerified: body.identityVerified ?? false,
        delayNotified: Boolean(body.delayReason), legalHold: request.legalHold, decision: request.decision,
      },
    } });
    return request;
  });
  res.json({ request: requestJson(updated, true) });
}));
