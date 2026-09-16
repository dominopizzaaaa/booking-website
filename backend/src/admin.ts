import { Router, type RequestHandler, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { prisma } from './db.js';
import { config, production } from './config.js';
import { asyncRoute, HttpError } from './http.js';

// The platform admin console is separate from provider (business) logins. It is
// gated by a single ADMIN_PASSWORD set in the host environment (Railway). No
// admin credentials are stored in the database; the session is a stateless,
// HMAC-signed cookie keyed by the password itself, so rotating the password
// immediately invalidates every existing admin session.
export const adminRouter = Router();
const adminCookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
const adminLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
function sign(value: string) {
  return createHmac('sha256', config.adminPassword).update(value).digest('base64url');
}
function issueAdminSession(res: Response) {
  const expiresAt = Date.now() + config.adminSessionHours * 3600_000;
  const payload = String(expiresAt);
  const token = `${payload}.${sign(payload)}`;
  res.cookie(config.adminCookie, token, { ...adminCookieOptions, expires: new Date(expiresAt) });
}
function adminSessionValid(token: unknown) {
  if (typeof token !== 'string' || !config.adminPassword) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
const requireAdmin: RequestHandler = asyncRoute(async (req, _res, next) => {
  if (!config.adminPassword) throw new HttpError(503, 'Admin console is not configured');
  if (!adminSessionValid(req.cookies?.[config.adminCookie])) throw new HttpError(401, 'Please sign in to the admin console');
  next();
});

adminRouter.get('/admin/session', asyncRoute(async (req, res) => {
  res.json({ configured: !!config.adminPassword, authenticated: adminSessionValid(req.cookies?.[config.adminCookie]) });
}));
adminRouter.post('/admin/login', adminLimit, asyncRoute(async (req, res) => {
  if (!config.adminPassword) throw new HttpError(503, 'Admin console is not configured');
  const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
  if (!safeEqual(password, config.adminPassword)) throw new HttpError(401, 'Incorrect admin password');
  issueAdminSession(res);
  res.json({ ok: true });
}));
adminRouter.post('/admin/logout', asyncRoute(async (_req, res) => {
  res.clearCookie(config.adminCookie, adminCookieOptions);
  res.json({ ok: true });
}));

adminRouter.get('/admin/overview', requireAdmin, asyncRoute(async (_req, res) => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400_000);
  const [businesses, demoBusinesses, users, memberships, customers, bookings, upcoming, weekBookings, payments, packages] = await Promise.all([
    prisma.business.count(),
    prisma.business.count({ where: { isDemo: true } }),
    prisma.user.count(),
    prisma.membership.count(),
    prisma.customer.count(),
    prisma.booking.count(),
    prisma.booking.count({ where: { startAt: { gte: now }, status: { not: 'CANCELLED' } } }),
    prisma.booking.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.payment.aggregate({ _sum: { amount: true }, _count: true }),
    prisma.lessonPackage.count(),
  ]);
  res.json({
    generatedAt: now.toISOString(),
    totals: {
      businesses, demoBusinesses, realBusinesses: businesses - demoBusinesses,
      users, memberships, customers, bookings, upcomingBookings: upcoming,
      bookingsLast7Days: weekBookings, packages,
      paymentsCount: payments._count, paymentsTotal: payments._sum.amount ?? 0,
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
      _count: { select: { memberships: true, customers: true, bookings: true, locations: true, services: true, instructors: true } },
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
// service/instructor/location; a participant pins its customer/package). Delete
// the owned rows in dependency order first, then let the remaining relations
// cascade from Business. This mirrors the integration fixture teardown.
async function deleteBusinessDeep(tx: Prisma.TransactionClient, businessId: string) {
  const disposableUserIds = (await tx.user.findMany({
    where: {
      OR: [
        { id: { startsWith: 'seed-instructor-' } },
        { id: { startsWith: 'seed-customer-' } },
      ],
      email: { endsWith: '@sample.courtly.invalid' },
      AND: [{ OR: [
        { memberships: { some: { businessId } } },
        { customers: { some: { businessId } } },
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
  await tx.payment.deleteMany({ where: { businessId } });
  await tx.participant.deleteMany({ where: { booking: { businessId } } });
  await tx.booking.deleteMany({ where: { businessId } });
  await tx.lessonPackage.deleteMany({ where: { businessId } });
  await tx.customer.deleteMany({ where: { businessId } });
  await tx.business.delete({ where: { id: businessId } });
  const removableUserIds = [...new Set([...disposableUserIds, ...placeholderUserIds])];
  if (removableUserIds.length) {
    await tx.user.deleteMany({
      where: {
        id: { in: removableUserIds },
        memberships: { none: {} },
        customers: { none: {} },
      },
    });
  }
}

adminRouter.delete('/admin/businesses/:id', requireAdmin, asyncRoute(async (req, res) => {
  const id = z.string().trim().min(1).max(200).parse(req.params.id);
  const business = await prisma.business.findUnique({ where: { id }, select: { id: true } });
  if (!business) throw new HttpError(404, 'Business not found');
  await prisma.$transaction(tx => deleteBusinessDeep(tx, id), { timeout: 30_000 });
  res.json({ ok: true });
}));

adminRouter.post('/admin/purge-demos', requireAdmin, asyncRoute(async (_req, res) => {
  const demos = await prisma.business.findMany({ where: { isDemo: true }, select: { id: true } });
  for (const demo of demos) await prisma.$transaction(tx => deleteBusinessDeep(tx, demo.id), { timeout: 30_000 });
  res.json({ ok: true, deleted: demos.length });
}));
