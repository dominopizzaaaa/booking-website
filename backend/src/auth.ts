import { Router, type RequestHandler, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { prisma } from './db.js';
import { config, production } from './config.js';
import { asyncRoute, HttpError, initials, type AccountRequest, type AuthRequest, type MembershipWithBusiness } from './http.js';
import { authState } from './serializers.js';
import { seedBusiness } from './seed.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
const membershipOrder = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const dummyPasswordHash = '$2b$12$QrsSSNoV/kdmGVRTVVmoIOKhMlSeSPFjGtV8.iKB7MHYFUPprZWyK';
const bcryptHash = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function selectedMembership(
  accountType: string,
  memberships: MembershipWithBusiness[],
  requestedId?: string | null,
) {
  if (accountType === 'CUSTOMER') return null;
  const requested = requestedId ? memberships.find(membership => membership.id === requestedId && membership.active) : null;
  return requested ?? memberships.find(membership => membership.active) ?? null;
}

export async function issueSession(
  userId: string,
  res: Response,
  activeMembershipId: string | null,
  previousToken?: string,
) {
  if (activeMembershipId) {
    const owned = await prisma.membership.findFirst({
      where: { id: activeMembershipId, userId, active: true }, select: { id: true },
    });
    if (!owned) throw new HttpError(403, 'Workspace membership does not belong to this account');
  }
  if (previousToken) await prisma.authSession.deleteMany({ where: { id: digest(previousToken) } });
  await prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000);
  await prisma.authSession.create({ data: { id: digest(token), userId, activeMembershipId, expiresAt } });
  res.cookie(config.sessionCookie, token, { ...cookieOptions, expires: expiresAt });
}

export const requireAuth: RequestHandler = asyncRoute(async (req, _res, next) => {
  const token = req.cookies?.[config.sessionCookie];
  if (typeof token !== 'string') throw new HttpError(401, 'Please sign in to continue');
  const session = await prisma.authSession.findUnique({
    where: { id: digest(token) },
    include: { user: { include: { memberships: { include: { business: true }, orderBy: membershipOrder } } } },
  });
  if (!session || session.expiresAt < new Date()) {
    if (session) await prisma.authSession.deleteMany({ where: { id: session.id } });
    throw new HttpError(401, 'Session expired. Please sign in again');
  }
  const { memberships, ...user } = session.user;
  const membership = user.accountType === 'CUSTOMER'
    ? null
    : memberships.find(candidate => candidate.id === session.activeMembershipId && candidate.active
      && candidate.userId === user.id && candidate.businessId === candidate.business.id) ?? null;
  if (session.activeMembershipId && !membership) {
    await prisma.authSession.update({ where: { id: session.id }, data: { activeMembershipId: null } });
    session.activeMembershipId = null;
  }
  (req as AccountRequest).auth = {
    user,
    session,
    membership,
    business: membership?.business ?? null,
    memberships,
  };
  next();
});

export const requireWorkspace: RequestHandler = (req, _res, next) => {
  const auth = (req as AccountRequest).auth;
  if (!auth) return next(new HttpError(401, 'Please sign in to continue'));
  const { user, membership, business } = auth;
  if (!user.passwordHash || user.accountType === 'CUSTOMER' || !membership || !business || !membership.active
    || membership.userId !== user.id || membership.businessId !== business.id) {
    return next(new HttpError(403, 'Select a business workspace to continue'));
  }
  next();
};

export const requireCustomer: RequestHandler = (req, _res, next) => {
  const auth = (req as AccountRequest).auth;
  if (!auth) return next(new HttpError(401, 'Please sign in to continue'));
  if (!auth.user.passwordHash || auth.user.accountType !== 'CUSTOMER') {
    return next(new HttpError(403, 'A customer account is required to book or manage personal bookings'));
  }
  next();
};

const authRouter = Router();
const authLimit = rateLimit({
  windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});
const credentials = z.object({
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
  password: z.string().min(8).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes'),
}).strict();
const registration = z.object({
  accountType: z.enum(['CUSTOMER', 'COACH', 'OWNER']).default('OWNER'),
  businessName: z.string().trim().min(2).max(120).optional(),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
  password: z.string().min(12, 'Use a password with at least 12 characters').max(72)
    .refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes'),
  phone: z.string().trim().max(40).optional(),
  parentName: z.string().trim().max(120).optional(),
}).strict().superRefine((value, context) => {
  if (value.accountType === 'OWNER' && !value.businessName) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['businessName'], message: 'Business name is required for an owner account' });
  }
});

authRouter.post('/register', authLimit, asyncRoute(async (req, res) => {
  const body = registration.parse(req.body);
  const passwordHash = await bcrypt.hash(body.password, 12);
  const result = await prisma.$transaction(async tx => {
    const userData = {
      name: body.name, email: body.email, passwordHash, accountType: body.accountType,
      phone: body.phone ?? '', parentName: body.parentName ?? '',
    };
    if (body.accountType !== 'OWNER') {
      const user = await tx.user.create({ data: userData });
      return { user, membershipId: null as string | null };
    }
    const businessName = body.businessName!;
    const business = await tx.business.create({
      data: {
        name: businessName, ownerName: body.name, email: body.email,
        slug: `${businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'courtly'}-${randomBytes(4).toString('hex')}`,
      },
    });
    const instructor = await tx.instructor.create({
      data: { businessId: business.id, name: body.name, initials: initials(body.name), email: body.email },
    });
    const user = await tx.user.create({ data: userData });
    const membership = await tx.membership.create({
      data: { userId: user.id, businessId: business.id, role: 'OWNER', instructorId: instructor.id },
    });
    if (membership.businessId !== instructor.businessId) throw new HttpError(400, 'Instructor membership must belong to this business');
    return { user, membershipId: membership.id };
  });
  await issueSession(result.user.id, res, result.membershipId, req.cookies?.[config.sessionCookie]);
  res.status(201).json(await authState(result.user.id, result.membershipId));
}));

authRouter.post('/login', authLimit, asyncRoute(async (req, res) => {
  const body = credentials.parse(req.body);
  const user = await prisma.user.findUnique({
    where: { email: body.email },
    include: { memberships: { include: { business: true }, orderBy: membershipOrder } },
  });
  const usableHash = typeof user?.passwordHash === 'string' && bcryptHash.test(user.passwordHash);
  let valid = false;
  try { valid = await bcrypt.compare(body.password, usableHash ? user.passwordHash! : dummyPasswordHash); }
  catch { valid = false; }
  if (!user || !usableHash || !valid) throw new HttpError(401, 'Email or password is incorrect');

  const previousToken = req.cookies?.[config.sessionCookie];
  const previousSession = typeof previousToken === 'string'
    ? await prisma.authSession.findUnique({ where: { id: digest(previousToken) } })
    : null;
  const currentId = previousSession?.userId === user.id && previousSession.expiresAt > new Date()
    ? previousSession.activeMembershipId
    : null;
  const membership = selectedMembership(user.accountType, user.memberships, currentId);
  await issueSession(user.id, res, membership?.id ?? null, previousToken);
  res.json(await authState(user.id, membership?.id ?? null));
}));

authRouter.post('/demo', rateLimit({
  windowMs: 60 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Demo limit reached. Try again later.' },
}), asyncRoute(async (req, res) => {
  if (!config.demoEnabled) throw new HttpError(403, 'Demo mode is disabled');
  const previous = req.cookies?.[config.sessionCookie];
  if (typeof previous === 'string') {
    const existing = await prisma.authSession.findUnique({
      where: { id: digest(previous) },
      include: { user: { include: { memberships: { include: { business: true }, orderBy: membershipOrder } } } },
    });
    if (existing && existing.expiresAt > new Date()) {
      const membership = selectedMembership(existing.user.accountType, existing.user.memberships, existing.activeMembershipId);
      if (membership) {
        if (membership.id !== existing.activeMembershipId) {
          await prisma.authSession.update({ where: { id: existing.id }, data: { activeMembershipId: membership.id } });
        }
        res.json(await authState(existing.userId, membership.id));
        return;
      }
    }
  }
  const result = await prisma.$transaction(
    tx => seedBusiness(tx, { isDemo: true, slug: `marcus-tan-${randomBytes(6).toString('hex')}` }),
    { timeout: 60_000 },
  );
  await issueSession(result.owner.id, res, result.ownerMembership.id, typeof previous === 'string' ? previous : undefined);
  res.status(201).json(await authState(result.owner.id, result.ownerMembership.id));
}));

authRouter.post('/logout', asyncRoute(async (req, res) => {
  const token = req.cookies?.[config.sessionCookie];
  if (typeof token === 'string') {
    const session = await prisma.authSession.findUnique({ where: { id: digest(token) }, select: { userId: true } });
    // A deliberate sign-out invalidates every session for this identity. This
    // also prevents a removed club membership from leaving another stale
    // browser session authenticated under the same account.
    if (session) await prisma.authSession.deleteMany({ where: { userId: session.userId } });
  }
  res.clearCookie(config.sessionCookie, cookieOptions);
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, asyncRoute(async (req, res) => {
  res.json(await authState(req.auth.user.id, req.auth.membership?.id ?? null));
}));

const editableProfile = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  parentName: z.string().trim().max(120).optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one profile field' });

authRouter.patch('/me', requireAuth, asyncRoute(async (req, res) => {
  const input = editableProfile.parse(req.body);
  await prisma.$transaction(async tx => {
    await tx.user.update({ where: { id: req.auth.user.id }, data: input });
    if (input.name !== undefined) {
      // A provider can belong to more than one workspace. Keep every roster
      // identity explicitly linked through one of this user's memberships in
      // step with the global profile, without touching unrelated instructors.
      await tx.instructor.updateMany({
        where: { membership: { is: { userId: req.auth.user.id } } },
        data: { name: input.name, initials: initials(input.name) },
      });
    }
    await tx.customer.updateMany({
      where: { userId: req.auth.user.id },
      data: {
        ...(input.name !== undefined ? { name: input.name, initials: initials(input.name) } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.parentName !== undefined ? { parentName: input.parentName } : {}),
      },
    });
  });
  res.json(await authState(req.auth.user.id, req.auth.membership?.id ?? null));
}));

const switchWorkspace = asyncRoute(async (req, res) => {
  const { membershipId } = z.object({ membershipId: z.string().trim().min(1).max(200).nullable() }).strict().parse(req.body);
  if (membershipId === null) {
    await prisma.authSession.update({
      where: { id: req.auth.session.id, userId: req.auth.user.id },
      data: { activeMembershipId: null },
    });
    res.json(await authState(req.auth.user.id, null));
    return;
  }
  if (req.auth.user.accountType === 'CUSTOMER') throw new HttpError(403, 'This account cannot access business workspaces');
  const membership = await prisma.membership.findUnique({
    where: { id: membershipId },
    include: { business: true },
  });
  if (!membership || membership.userId !== req.auth.user.id || !membership.active) {
    throw new HttpError(403, 'Workspace membership is not available to this account');
  }
  await prisma.authSession.update({
    where: { id: req.auth.session.id, userId: req.auth.user.id },
    data: { activeMembershipId: membership.id },
  });
  res.json(await authState(req.auth.user.id, membership.id));
});
authRouter.post(['/switch-workspace', '/workspace'], requireAuth, switchWorkspace);

export { authRouter };
