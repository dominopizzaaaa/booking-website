import { Router, type Request, type RequestHandler, type Response } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { config, production, skipRateLimits } from './config.js';
import { sharedRateLimit } from './rate-limit.js';
import { asyncRoute, HttpError } from './http.js';
import { adminChatListQuery, chatThreadForAdmin, listChatThreadsForAdmin, threadQuery } from './chat.js';
import { adminSafeguardingRouter } from './safeguarding.js';
import { verifyTotp } from './account-security-crypto.js';

// The platform admin console is separate from provider (business) logins.
// Production admits only explicitly configured named operators. A shared
// password remains a non-production compatibility path, and its sessions are
// deliberately excluded from sensitive reads and every enforcement mutation.
export const adminRouter = Router();
const adminCookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
const adminLimit = sharedRateLimit({
  name: 'admin-login',
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  message: { error: 'Too many attempts. Please try again later.' },
});

function businessDeletionMode(): 'all' | 'demo-only' {
  return config.realBusinessDeletionEnabled ? 'all' : 'demo-only';
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
export type AdminOperator = { id: string; name: string; email: string };
export type AdminSessionContext =
  | { mode: 'named'; operator: AdminOperator }
  | { mode: 'legacy'; operator: null };
export type AdminRequest = Request & { admin: AdminSessionContext };

type AdminSessionPayload = {
  v: 1; mode: 'named' | 'legacy'; operatorId?: string; operatorName?: string; operatorEmail?: string;
  credentialVersion: string; expiresAt: number;
};

const DUMMY_BCRYPT_HASH = '$2b$12$iqhVwv9QRpq.hKuJLYeuHOuO5.J3oBTOj5BSn5lUbyZp1KiVkRfsC';
const namedLoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
  totpCode: z.string().trim().regex(/^\d{6}$/).optional(),
}).strict();
const legacyLoginBody = z.object({ password: z.string().min(1).max(200) }).strict();

function adminAuthMode(): 'named' | 'legacy' | 'disabled' {
  if (config.adminOperators.length && config.adminConfigurationValid
    && (!production || config.adminSessionSecretConfigured)) return 'named';
  if (!production && config.adminPassword) return 'legacy';
  return 'disabled';
}
function credentialVersion(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}
function sign(value: string) {
  return createHmac('sha256', config.adminSessionSecret).update(value).digest('base64url');
}
function issueAdminSession(res: Response, context: AdminSessionContext) {
  const expiresAt = Date.now() + config.adminSessionHours * 3600_000;
  const credentials = context.mode === 'named'
    ? (() => {
      const configured = config.adminOperators.find(operator => operator.id === context.operator.id);
      return `${configured?.passwordHash ?? ''}:${configured?.totpSecret ?? ''}`;
    })()
    : config.adminPassword;
  const payload: AdminSessionPayload = {
    v: 1, mode: context.mode, expiresAt, credentialVersion: credentialVersion(credentials),
    ...(context.mode === 'named' ? {
      operatorId: context.operator.id, operatorName: context.operator.name, operatorEmail: context.operator.email,
    } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const token = `${encoded}.${sign(encoded)}`;
  res.cookie(config.adminCookie, token, { ...adminCookieOptions, expires: new Date(expiresAt) });
}
function readAdminSession(token: unknown): AdminSessionContext | null {
  if (typeof token !== 'string') return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra || !safeEqual(signature, sign(encoded))) return null;
  let payload: AdminSessionPayload;
  try {
    payload = z.object({
      v: z.literal(1), mode: z.enum(['named', 'legacy']), operatorId: z.string().optional(),
      operatorName: z.string().optional(), operatorEmail: z.string().optional(),
      credentialVersion: z.string().min(1), expiresAt: z.number().finite(),
    }).strict().parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
  } catch { return null; }
  if (payload.expiresAt <= Date.now()) return null;
  if (payload.mode !== adminAuthMode()) return null;
  if (payload.mode === 'named') {
    if (!payload.operatorId || !payload.operatorName || !payload.operatorEmail) return null;
    const configured = config.adminOperators.find(operator => operator.id === payload.operatorId);
    if (!configured || payload.operatorName !== configured.name || payload.operatorEmail !== configured.email
      || !safeEqual(payload.credentialVersion, credentialVersion(`${configured.passwordHash}:${configured.totpSecret ?? ''}`))) return null;
    return { mode: 'named', operator: { id: configured.id, name: configured.name, email: configured.email } };
  }
  if (production || !config.adminPassword
    || !safeEqual(payload.credentialVersion, credentialVersion(config.adminPassword))) return null;
  return { mode: 'legacy', operator: null };
}
export const requireAdmin: RequestHandler = asyncRoute(async (req, _res, next) => {
  if (adminAuthMode() === 'disabled') throw new HttpError(503, 'Admin console is not configured');
  const session = readAdminSession(req.cookies?.[config.adminCookie]);
  if (!session) throw new HttpError(401, 'Please sign in to the admin console');
  (req as unknown as AdminRequest).admin = session;
  next();
});
export const requireNamedAdmin: RequestHandler = asyncRoute(async (req, _res, next) => {
  if (adminAuthMode() === 'disabled') throw new HttpError(503, 'Admin console is not configured');
  const session = (req as unknown as Partial<AdminRequest>).admin ?? readAdminSession(req.cookies?.[config.adminCookie]);
  if (!session) throw new HttpError(401, 'Please sign in to the admin console');
  if (session.mode !== 'named') {
    throw new HttpError(403, 'A named admin operator is required for this action', { code: 'NAMED_ADMIN_REQUIRED' });
  }
  (req as unknown as AdminRequest).admin = session;
  next();
});
adminRouter.use('/admin/safeguarding', requireAdmin, requireNamedAdmin, adminSafeguardingRouter);

adminRouter.get('/admin/session', asyncRoute(async (req, res) => {
  const mode = adminAuthMode();
  const session = mode === 'disabled' ? null : readAdminSession(req.cookies?.[config.adminCookie]);
  res.json({
    configured: mode !== 'disabled', authMode: mode, authenticated: !!session,
    operator: session?.operator ?? null, sensitiveAccess: session?.mode === 'named',
    businessDeletionMode: businessDeletionMode(),
  });
}));
adminRouter.post('/admin/login', adminLimit, asyncRoute(async (req, res) => {
  const mode = adminAuthMode();
  if (mode === 'disabled') throw new HttpError(503, 'Admin console is not configured');
  if (mode === 'named') {
    const { email, password, totpCode } = namedLoginBody.parse(req.body);
    const configured = config.adminOperators.find(operator => operator.email === email);
    const matches = await bcrypt.compare(password, configured?.passwordHash ?? DUMMY_BCRYPT_HASH);
    const mfaMatches = !configured?.totpSecret
      || (typeof totpCode === 'string' && verifyTotp(configured.totpSecret, totpCode) !== null);
    if (!configured || !matches || !mfaMatches) throw new HttpError(401, 'Incorrect admin credentials');
    const operator = { id: configured.id, name: configured.name, email: configured.email };
    issueAdminSession(res, { mode: 'named', operator });
    res.json({ ok: true, authMode: 'named', operator });
    return;
  }
  const { password } = legacyLoginBody.parse(req.body);
  if (!safeEqual(password, config.adminPassword)) throw new HttpError(401, 'Incorrect admin password');
  issueAdminSession(res, { mode: 'legacy', operator: null });
  res.json({ ok: true, authMode: 'legacy', operator: null });
}));
adminRouter.post('/admin/logout', asyncRoute(async (_req, res) => {
  res.clearCookie(config.adminCookie, adminCookieOptions);
  res.json({ ok: true });
}));

adminRouter.get('/admin/overview', requireAdmin, asyncRoute(async (_req, res) => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400_000);
  const [businesses, demoBusinesses, users, memberships, students, bookings, upcoming, weekBookings, payments, packages, chatThreads, chatMessages] = await Promise.all([
    prisma.business.count(),
    prisma.business.count({ where: { isDemo: true } }),
    prisma.user.count(),
    prisma.membership.count(),
    prisma.student.count(),
    prisma.booking.count(),
    prisma.booking.count({ where: { startAt: { gte: now }, status: { not: 'CANCELLED' } } }),
    prisma.booking.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.payment.aggregate({
      where: {
        kind: { in: ['STUDENT_TO_CLUB', 'STUDENT_TO_COACH'] },
        reversedAt: null,
      },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.lessonPackage.count(),
    prisma.chatThread.count(),
    prisma.chatMessage.count({ where: { kind: { not: 'SYSTEM' } } }),
  ]);
  res.json({
    generatedAt: now.toISOString(),
    totals: {
      businesses, demoBusinesses, realBusinesses: businesses - demoBusinesses,
      users, memberships, students, bookings, upcomingBookings: upcoming,
      bookingsLast7Days: weekBookings, packages,
      paymentsCount: payments._count, paymentsTotal: payments._sum.amount ?? 0,
      chatThreads, chatMessages,
    },
  });
}));

adminRouter.get('/admin/businesses', requireAdmin, asyncRoute(async (req, res) => {
  const { search, filter } = z.object({
    search: z.string().trim().max(120).optional(),
    filter: z.enum(['all', 'real', 'demo']).default('all'),
  }).parse(req.query);
  const where = {
    ...(filter === 'demo' ? { isDemo: true } : filter === 'real' ? { isDemo: false } : {}),
    ...(search ? { OR: [
      { name: { contains: search, mode: 'insensitive' as const } },
      { ownerName: { contains: search, mode: 'insensitive' as const } },
      { email: { contains: search, mode: 'insensitive' as const } },
      { slug: { contains: search, mode: 'insensitive' as const } },
    ] } : {}),
  };
  const businesses = await prisma.business.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 200,
    select: {
      id: true, name: true, slug: true, ownerName: true, email: true, currency: true,
      timezone: true, isDemo: true, createdAt: true,
      _count: { select: { memberships: true, students: true, bookings: true, locations: true, services: true, instructors: true } },
    },
  });
  res.json({ businesses: businesses.map(b => ({
    ...b,
    createdAt: b.createdAt.toISOString(),
    counts: { ...b._count, users: b._count.memberships },
    _count: undefined,
  })) });
}));

// Several foreign keys are intentionally onDelete: Restrict (a booking pins its
// service/instructor/location; a participant pins its student/package). Delete
// the owned rows in dependency order first, then let the remaining relations
// cascade from Business. This mirrors the integration fixture teardown.
async function deleteBusinessDeep(tx: Prisma.TransactionClient, businessId: string) {
  const institutionalUserIds = (await tx.membership.findMany({
    where: { businessId, user: { accountType: 'CLUB' } },
    select: { userId: true },
  })).map(membership => membership.userId);
  const disposableUserIds = (await tx.user.findMany({
    where: {
      OR: [
        { id: { startsWith: 'seed-instructor-' } },
        { id: { startsWith: 'seed-student-' } },
      ],
      email: { endsWith: '@sample.courtly.invalid' },
      AND: [{ OR: [
        { memberships: { some: { businessId } } },
        { students: { some: { businessId } } },
      ] }],
    },
    select: { id: true },
  })).map(user => user.id);
  const placeholderUserIds = (await tx.membership.findMany({
    where: { businessId, user: {
      passwordHash: null, accountType: 'COACH', email: { endsWith: '@unclaimed.courtly.invalid' },
    } },
    select: { userId: true },
  })).map(membership => membership.userId);
  const conditionalUserIds = [...new Set([...disposableUserIds, ...placeholderUserIds])].sort();
  const deletionCandidateUserIds = [...new Set([...institutionalUserIds, ...conditionalUserIds])].sort();
  if (deletionCandidateUserIds.length) {
    // OAuth completion takes a foreign-key lock on its user. Locking the same
    // rows closes the gap between checking for a connection and deleting the
    // account, so a concurrent callback cannot lose newly stored credentials.
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "User"
      WHERE "id" IN (${Prisma.join(deletionCandidateUserIds)})
      ORDER BY "id"
      FOR UPDATE
    `);
    const conditionallyRemovableUserIds = conditionalUserIds.length
      ? (await tx.user.findMany({
        where: {
          id: { in: conditionalUserIds },
          memberships: { none: { businessId: { not: businessId } } },
          students: { none: { businessId: { not: businessId } } },
        },
        select: { id: true },
      })).map(user => user.id)
      : [];
    const userIdsToDelete = [...new Set([...institutionalUserIds, ...conditionallyRemovableUserIds])];
    const connected = userIdsToDelete.length
      ? await tx.calendarConnection.findFirst({
        where: { userId: { in: userIdsToDelete } },
        select: { id: true },
      })
      : null;
    if (connected) {
      throw new HttpError(409, 'This business cannot be deleted while an account that would be removed still has a Google Calendar connection. Disconnect the calendar and wait for cleanup to finish, then try again.');
    }
  }
  // Provider reconciliation and the shared venue ledger use restrictive links
  // so history cannot disappear accidentally. Explicit whole-business teardown
  // removes those children first, in dependency order. Payment receipts reject
  // independent deletion and cascade from the payment removed below.
  await tx.paymentRefund.deleteMany({ where: { businessId } });
  await tx.paymentSettlement.deleteMany({ where: { paymentIntent: { businessId } } });
  await tx.payment.deleteMany({ where: { businessId } });
  // Online checkout history pins its target rows with RESTRICT relations.
  // Remove intents first, then reservations, before clearing lesson/package
  // records during an explicit whole-business teardown.
  await tx.paymentIntent.deleteMany({ where: { businessId } });
  await tx.venueUnitAllocation.deleteMany({ where: { businessId } });
  await tx.venueReservation.deleteMany({ where: { businessId } });
  await tx.participant.deleteMany({ where: { booking: { businessId } } });
  await tx.booking.deleteMany({ where: { businessId } });
  await tx.lessonPackage.deleteMany({ where: { businessId } });
  await tx.student.deleteMany({ where: { businessId } });
  await tx.business.delete({ where: { id: businessId } });
  // A CLUB login is the deleted business itself, not a portable person. Both
  // halves must disappear in this transaction so the deferred shape invariant
  // never observes an orphaned institutional account.
  if (institutionalUserIds.length) {
    await tx.user.deleteMany({ where: { id: { in: institutionalUserIds } } });
  }
  if (conditionalUserIds.length) {
    await tx.user.deleteMany({
      where: {
        id: { in: conditionalUserIds },
        memberships: { none: {} },
        students: { none: {} },
      },
    });
  }
}

adminRouter.delete('/admin/businesses/:id', requireAdmin, requireNamedAdmin, asyncRoute(async (req, res) => {
  const id = z.string().trim().min(1).max(200).parse(req.params.id);
  await prisma.$transaction(async tx => {
    // Lock the target while applying the destructive-action policy so its demo
    // classification cannot change between authorization and deletion.
    const [business] = await tx.$queryRaw<Array<{ id: string; isDemo: boolean }>>`
      SELECT "id", "isDemo"
      FROM "Business"
      WHERE "id" = ${id}
      FOR UPDATE
    `;
    if (!business) throw new HttpError(404, 'Business not found');
    if (!business.isDemo && !config.realBusinessDeletionEnabled) {
      throw new HttpError(403, 'Only demo businesses can be deleted in this environment');
    }
    await deleteBusinessDeep(tx, id);
  }, { timeout: 30_000 });
  res.json({ ok: true });
}));

adminRouter.post('/admin/purge-demos', requireAdmin, requireNamedAdmin, asyncRoute(async (_req, res) => {
  // Purging is one platform operation. Keeping every demo in the same
  // transaction avoids per-workspace commit overhead and cannot leave a
  // half-purged platform if a later workspace fails its teardown.
  const deleted = await prisma.$transaction(async tx => {
    // Hold each selected row through teardown so a concurrent reclassification
    // cannot turn a demo into a real business after the purge has selected it.
    const demos = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Business"
      WHERE "isDemo" = true
      ORDER BY "id"
      FOR UPDATE
    `;
    for (const demo of demos) await deleteBusinessDeep(tx, demo.id);
    return demos.length;
  }, { timeout: 30_000 });
  res.json({ ok: true, deleted });
}));

// Every conversation is readable here for safety review when the generalized
// contract is requested. Legacy clients continue receiving SESSION rows. The console only
// reads: it has no account identity to post as and exposes no actions.
adminRouter.get('/admin/chats', requireAdmin, requireNamedAdmin, asyncRoute(async (req, res) => {
  res.json(await listChatThreadsForAdmin(adminChatListQuery.parse(req.query)));
}));

adminRouter.get('/admin/chats/:threadId', requireAdmin, requireNamedAdmin, asyncRoute(async (req, res) => {
  const { before, contract } = threadQuery.parse(req.query);
  const threadId = z.string().trim().min(1).max(200).parse(req.params.threadId);
  res.json(await chatThreadForAdmin(threadId, { before, includeAccountChats: contract === 'accounts' }));
}));
