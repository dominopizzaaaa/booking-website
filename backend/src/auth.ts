import { Router, type RequestHandler, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { prisma } from './db.js';
import { config, production, skipRateLimits } from './config.js';
import { asyncRoute, HttpError, requireAccountCapability, type AccountRequest, type MembershipWithBusiness } from './http.js';
import { authState, isAccessibleWorkspaceMembership, isSupportedWorkspaceMembership } from './serializers.js';
import { seedBusiness } from './seed.js';
import { editableClubAccountProfile, editablePersonalProfile, sportsSchema, updatePersonalProfile, usernameSchema } from './account-profile.js';
import { CHILD_AGE, ageOnSingaporeDate, parseDateOfBirth } from './children-policy.js';
import { loadAccountPolicy } from './account-policy.js';
import { lockAccountEmailClaim } from './account-email-claim.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
const membershipOrder = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const dummyPasswordHash = '$2b$12$QrsSSNoV/kdmGVRTVVmoIOKhMlSeSPFjGtV8.iKB7MHYFUPprZWyK';
const bcryptHash = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const SERIALIZABLE_RETRY_LIMIT = 3;

async function serializableAuthTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)
        || error.code !== 'P2034' || attempt >= SERIALIZABLE_RETRY_LIMIT) throw error;
    }
  }
}

function selectedMembership(
  accountType: string,
  memberships: MembershipWithBusiness[],
  requestedId?: string | null,
) {
  if (accountType === 'STUDENT') return null;
  // A club belongs to one club. Ignore any request to select another.
  if (accountType === 'CLUB') {
    return memberships.find(membership => isAccessibleWorkspaceMembership(membership)
      && membership.instructorId === null) ?? null;
  }
  const requested = requestedId
    ? memberships.find(membership => membership.id === requestedId && isAccessibleWorkspaceMembership(membership))
    : null;
  return requested ?? memberships.find(isAccessibleWorkspaceMembership) ?? null;
}

export async function issueSession(
  userId: string,
  res: Response,
  activeMembershipId: string | null,
  activeStaffAccessId: string | null = null,
  previousToken?: string,
) {
  if (activeMembershipId) {
    const owned = await prisma.membership.findFirst({
      where: {
        id: activeMembershipId, userId, active: true,
        business: { kind: 'CLUB', legacyReadOnly: false },
      },
      select: { id: true },
    });
    if (!owned) throw new HttpError(403, 'Workspace membership does not belong to this account');
  }
  if (previousToken) await prisma.authSession.deleteMany({ where: { id: digest(previousToken) } });
  await prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000);
  await prisma.authSession.create({ data: { id: digest(token), userId, activeMembershipId, activeStaffAccessId, expiresAt } });
  res.cookie(config.sessionCookie, token, { ...cookieOptions, expires: expiresAt });
}

export const requireAuth: RequestHandler = asyncRoute(async (req, _res, next) => {
  if ((req as AccountRequest).auth) { next(); return; }
  const token = req.cookies?.[config.sessionCookie];
  if (typeof token !== 'string') throw new HttpError(401, 'Please sign in to continue');
  const session = await prisma.authSession.findUnique({
    where: { id: digest(token) },
    include: { user: { include: {
      memberships: { include: { business: true }, orderBy: membershipOrder },
      staffAccesses: { include: { business: true }, orderBy: membershipOrder },
    } } },
  });
  if (!session || session.expiresAt < new Date()) {
    if (session) await prisma.authSession.deleteMany({ where: { id: session.id } });
    throw new HttpError(401, 'Session expired. Please sign in again');
  }
  const { memberships: allMemberships, staffAccesses: allStaffAccesses, ...user } = session.user;
  const memberships = allMemberships.filter(isSupportedWorkspaceMembership);
  const membership = user.accountType === 'STUDENT'
    ? null
    : memberships.find(candidate => candidate.id === session.activeMembershipId
      && isAccessibleWorkspaceMembership(candidate)
      && candidate.userId === user.id && candidate.businessId === candidate.business.id) ?? null;
  if (session.activeMembershipId && !membership) {
    await prisma.authSession.update({ where: { id: session.id }, data: { activeMembershipId: null } });
    session.activeMembershipId = null;
  }
  const staffAccesses = allStaffAccesses.filter(access => access.active && !access.revokedAt
    && access.business.kind === 'CLUB' && !access.business.legacyReadOnly);
  const staffAccess = membership ? null : staffAccesses.find(access => access.id === session.activeStaffAccessId
    && access.userId === user.id && access.businessId === access.business.id) ?? null;
  if (session.activeStaffAccessId && !staffAccess) {
    await prisma.authSession.update({ where: { id: session.id }, data: { activeStaffAccessId: null } });
    session.activeStaffAccessId = null;
  }
  const business = membership?.business ?? staffAccess?.business ?? null;
  const policy = await loadAccountPolicy(user, { sessionCreatedAt: session.createdAt });
  (req as AccountRequest).auth = {
    user,
    session,
    membership,
    staffAccess,
    business,
    memberships,
    staffAccesses,
    accessMode: staffAccess ? 'STAFF' : membership ? user.accountType === 'CLUB' ? 'CLUB_ACCOUNT' : 'COACH' : 'NONE',
    permissions: staffAccess?.permissions ?? [],
    policy,
  };
  next();
});

export const requireWorkspace: RequestHandler = (req, _res, next) => {
  const auth = (req as AccountRequest).auth;
  if (!auth) return next(new HttpError(401, 'Please sign in to continue'));
  const { user, membership, business } = auth;
  const validMembership = Boolean(membership?.active && membership.userId === user.id && membership.businessId === business?.id);
  const validStaff = Boolean(auth.staffAccess?.active && !auth.staffAccess.revokedAt
    && auth.staffAccess.userId === user.id && auth.staffAccess.businessId === business?.id);
  if (!auth.policy.capabilities.workspace || !user.passwordHash || !business || (!validMembership && !validStaff)
    || business.kind !== 'CLUB' || business.legacyReadOnly) {
    return next(new HttpError(403, 'Select a business workspace to continue'));
  }
  next();
};

export const requireStudent: RequestHandler = (req, _res, next) => {
  const auth = (req as AccountRequest).auth;
  if (!auth) return next(new HttpError(401, 'Please sign in to continue'));
  if (!auth.policy.capabilities.ordinaryAccess) {
    return next(new HttpError(403, 'Account action is required before continuing', {
      code: 'ACCOUNT_ACTION_REQUIRED', reason: auth.policy.reason,
    }));
  }
  if (!auth.user.passwordHash || auth.user.accountType !== 'STUDENT') {
    return next(new HttpError(403, 'A student account is required to book or manage personal bookings'));
  }
  next();
};

const authRouter = Router();
const registrationLimit = rateLimit({
  windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  message: { error: 'Too many attempts. Please try again later.' },
});
const loginLimit = rateLimit({
  windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  // Only failed credentials should spend the brute-force budget. Successful
  // sign-ins are ordinary use and must not lock out a shared office or test
  // runner that legitimately signs several accounts in from one address.
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please try again later.' },
});
const credentials = z.object({
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
  password: z.string().min(8).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes'),
}).strict();
const dateOfBirthSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must use YYYY-MM-DD')
  .refine(value => {
    try { ageOnSingaporeDate(parseDateOfBirth(value)); return true; }
    catch { return false; }
  }, 'Date of birth must be a valid date and cannot be in the future');
const registration = z.object({
  // Account type must always be an explicit choice. Silently creating an
  // club workspace when an older or custom client omits this field is both
  // surprising and difficult for the user to undo.
  accountType: z.enum(['STUDENT', 'COACH', 'CLUB']),
  businessName: z.string().trim().min(2).max(120).optional(),
  name: z.string().trim().min(2).max(120),
  username: usernameSchema,
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
  password: z.string().min(12, 'Use a password with at least 12 characters').max(72)
    .refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes'),
  phone: z.string().trim().max(40).optional(),
  parentName: z.string().trim().max(120).optional(),
  sports: sportsSchema.optional().default([]),
  dateOfBirth: dateOfBirthSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.accountType === 'CLUB' && !value.businessName) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['businessName'], message: 'A club or academy name is required' });
  }
  if (value.accountType === 'CLUB' && value.dateOfBirth !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dateOfBirth'], message: 'Club accounts do not have a date of birth' });
  }
  if (value.accountType !== 'CLUB' && value.dateOfBirth === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dateOfBirth'], message: 'Date of birth is required' });
  }
});
const clubProfile = z.object({
  name: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
  tagline: z.string().trim().max(500),
  color: z.string().trim().min(1).max(40),
  cancellationHours: z.number().int().min(0).max(720),
  username: usernameSchema,
  sports: sportsSchema,
}).strict();

authRouter.post('/register', registrationLimit, asyncRoute(async (req, res) => {
  const body = registration.parse(req.body);
  const dateOfBirth = body.accountType === 'CLUB' ? null : parseDateOfBirth(body.dateOfBirth!);
  const age = ageOnSingaporeDate(dateOfBirth);
  if (age !== null && age < CHILD_AGE) {
    throw new HttpError(400, 'A parent or guardian must create and manage this child account', {
      code: 'PARENT_ACCOUNT_REQUIRED',
    });
  }
  const passwordHash = await bcrypt.hash(body.password, 12);
  const result = await serializableAuthTransaction(async tx => {
    const emailClaim = await lockAccountEmailClaim(tx, body.email);
    if (emailClaim.pendingHandover) {
      throw new HttpError(409, 'This record already exists. Please use a different email or username.');
    }
    const accountName = body.accountType === 'CLUB' ? body.businessName! : body.name;
    const userData = {
      name: accountName, legalName: accountName, dateOfBirth,
      username: body.username, email: body.email, passwordHash, accountType: body.accountType,
      sports: body.sports,
      profileVisibility: age !== null && age < 18 ? 'CLUBS_ONLY' : 'PUBLIC',
      phone: body.phone ?? '', parentName: body.parentName ?? '',
    };
    if (body.accountType !== 'CLUB') {
      const user = await tx.user.create({ data: userData });
      return { user, membershipId: null as string | null };
    }
    const businessName = body.businessName!;
    const business = await tx.business.create({
      data: {
        name: businessName, ownerName: body.name, email: body.email, kind: 'CLUB',
        slug: `${businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'courtly'}-${randomBytes(4).toString('hex')}`,
      },
    });
    const user = await tx.user.create({ data: userData });
    // A club account is the club, not a person, so it gets no roster entry of
    // its own. Whoever coaches here — including the founder — registers a coach
    // account and is added to the roster like anyone else.
    const membership = await tx.membership.create({
      data: { userId: user.id, businessId: business.id },
    });
    return { user, membershipId: membership.id };
  });
  await issueSession(result.user.id, res, result.membershipId, null, req.cookies?.[config.sessionCookie]);
  res.status(201).json(await authState(result.user.id, result.membershipId));
}));

authRouter.post('/login', loginLimit, asyncRoute(async (req, res) => {
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
  const activeStaffAccessId = membership ? null : previousSession?.userId === user.id ? previousSession.activeStaffAccessId : null;
  await issueSession(user.id, res, membership?.id ?? null, activeStaffAccessId, previousToken);
  res.json(await authState(user.id, membership?.id ?? null));
}));

authRouter.post('/demo', rateLimit({
  windowMs: 60 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
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
  await issueSession(result.clubAccount.id, res, result.clubMembership.id, null, typeof previous === 'string' ? previous : undefined);
  res.status(201).json(await authState(result.clubAccount.id, result.clubMembership.id));
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
  res.json(await authState(req.auth.user.id, req.auth.membership?.id ?? null, req.auth.staffAccess?.id ?? null));
}));

authRouter.patch('/me', requireAuth, requireAccountCapability('profileEdit'), asyncRoute(async (req, res) => {
  const input = req.auth.user.accountType === 'CLUB'
    ? editableClubAccountProfile.parse(req.body)
    : editablePersonalProfile.parse(req.body);
  await updatePersonalProfile(req.auth.user.id, input);
  res.json(await authState(req.auth.user.id, req.auth.membership?.id ?? null, req.auth.staffAccess?.id ?? null));
}));

authRouter.patch('/club-profile', requireAuth, requireAccountCapability('workspace'), asyncRoute(async (req, res) => {
  const { user, membership, business } = req.auth;
  if (!user.passwordHash || user.accountType !== 'CLUB' || !membership || !business
    || !isAccessibleWorkspaceMembership(membership) || membership.instructorId !== null
    || membership.userId !== user.id || membership.businessId !== business.id) {
    throw new HttpError(403, 'Only the club account can edit this club profile');
  }
  const input = clubProfile.parse(req.body);
  await prisma.$transaction(async tx => {
    await tx.business.update({
      where: { id: business.id },
      data: {
        name: input.name, ownerName: input.ownerName, email: input.email, tagline: input.tagline,
        color: input.color, cancellationHours: input.cancellationHours,
      },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { name: input.name, username: input.username, sports: input.sports },
    });
  });
  res.json(await authState(user.id, membership.id));
}));

const switchWorkspace = asyncRoute(async (req, res) => {
  const { membershipId } = z.object({ membershipId: z.string().trim().min(1).max(200).nullable() }).strict().parse(req.body);
  if (req.auth.user.accountType === 'CLUB') {
    throw new HttpError(403, 'A club account belongs to one club and cannot switch workspaces');
  }
  if (membershipId === null) {
    await prisma.authSession.update({
      where: { id: req.auth.session.id, userId: req.auth.user.id },
      data: { activeMembershipId: null, activeStaffAccessId: null },
    });
    res.json(await authState(req.auth.user.id, null, null));
    return;
  }
  if (req.auth.user.accountType === 'STUDENT') throw new HttpError(403, 'This account cannot access business workspaces');
  const membership = await prisma.membership.findUnique({
    where: { id: membershipId },
    include: { business: true },
  });
  if (!membership || membership.userId !== req.auth.user.id || !isAccessibleWorkspaceMembership(membership)) {
    throw new HttpError(403, 'Workspace membership is not available to this account');
  }
  await prisma.authSession.update({
    where: { id: req.auth.session.id, userId: req.auth.user.id },
    data: { activeMembershipId: membership.id, activeStaffAccessId: null },
  });
  res.json(await authState(req.auth.user.id, membership.id));
});
authRouter.post(['/switch-workspace', '/workspace'], requireAuth, requireAccountCapability('workspace'), switchWorkspace);

authRouter.post('/workspace-access', requireAuth, requireAccountCapability('workspace'), asyncRoute(async (req, res) => {
  const input = z.object({
    source: z.enum(['MEMBERSHIP', 'STAFF']),
    id: z.string().trim().min(1).max(200).nullable(),
  }).strict().parse(req.body);
  if (input.id === null) {
    if (req.auth.user.accountType === 'CLUB') throw new HttpError(403, 'A club account belongs to one club and cannot leave its workspace');
    await prisma.authSession.update({ where: { id: req.auth.session.id }, data: { activeMembershipId: null, activeStaffAccessId: null } });
    res.json(await authState(req.auth.user.id, null, null));
    return;
  }
  if (input.source === 'MEMBERSHIP') {
    const membership = await prisma.membership.findFirst({
      where: { id: input.id, userId: req.auth.user.id, active: true, business: { kind: 'CLUB', legacyReadOnly: false } },
      include: { business: true },
    });
    if (!membership) throw new HttpError(403, 'Workspace membership is not available to this account');
    await prisma.authSession.update({ where: { id: req.auth.session.id }, data: { activeMembershipId: membership.id, activeStaffAccessId: null } });
    res.json(await authState(req.auth.user.id, membership.id, null));
    return;
  }
  const access = await prisma.clubStaffAccess.findFirst({
    where: { id: input.id, userId: req.auth.user.id, active: true, revokedAt: null, business: { kind: 'CLUB', legacyReadOnly: false } },
  });
  if (!access) throw new HttpError(403, 'Staff workspace access is not available to this account');
  await prisma.authSession.update({ where: { id: req.auth.session.id }, data: { activeMembershipId: null, activeStaffAccessId: access.id } });
  res.json(await authState(req.auth.user.id, null, access.id));
}));

export { authRouter };
