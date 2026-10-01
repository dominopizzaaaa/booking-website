import { Router, type RequestHandler, type Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { config, production, skipRateLimits } from './config.js';
import { sharedRateLimit } from './rate-limit.js';
import { asyncRoute, HttpError, requireAccountCapability, type AccountRequest, type MembershipWithBusiness } from './http.js';
import { authState, isAccessibleWorkspaceMembership, isSupportedWorkspaceMembership } from './serializers.js';
import { seedBusiness } from './seed.js';
import { editableClubAccountProfile, editableCoachAccountProfile, editablePersonalProfile, sportsSchema, updatePersonalProfile, usernameSchema } from './account-profile.js';
import { CHILD_AGE, ageOnSingaporeDate, parseDateOfBirth } from './children-policy.js';
import { loadAccountPolicy } from './account-policy.js';
import { lockAccountEmailClaim } from './account-email-claim.js';
import { CURRENT_LEGAL_POLICY_SET_HASH, CURRENT_PRIVACY_NOTICE_VERSION, CURRENT_TERMS_VERSION } from './legal-policy.js';
import { assertLegalAcceptanceEnabled } from './legal-policy-gate.js';
import {
  activeEmailVerificationToken,
  configuredEmailVerificationKeyring,
  deriveEmailVerificationToken,
  emailVerificationTokenDigest,
} from './email-verification-token.js';
import { enqueueEmailVerificationSecurityEmail } from './outbound-events.js';
import { createMfaLoginChallenge, consumeMfaLoginChallenge } from './account-security.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
const membershipOrder = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const dummyPasswordHash = '$2b$12$QrsSSNoV/kdmGVRTVVmoIOKhMlSeSPFjGtV8.iKB7MHYFUPprZWyK';
const bcryptHash = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const SERIALIZABLE_RETRY_LIMIT = 3;
const EMAIL_VERIFICATION_LIFETIME_MS = 24 * 60 * 60_000;

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
  options: { recentAuthAt?: Date | null; userAgent?: string | null } = {},
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
  const now = new Date();
  await prisma.authSession.deleteMany({ where: { OR: [
    { expiresAt: { lt: now } },
    { lastSeenAt: { lt: new Date(now.getTime() - config.sessionIdleMinutes * 60_000) } },
  ] } });
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000);
  await prisma.authSession.create({ data: {
    id: digest(token), userId, activeMembershipId, activeStaffAccessId, expiresAt,
    lastSeenAt: now, recentAuthAt: options.recentAuthAt ?? null,
    userAgent: options.userAgent?.slice(0, 500) ?? null,
  } });
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
  const now = new Date();
  const idleExpiresAt = session
    ? new Date(session.lastSeenAt.getTime() + config.sessionIdleMinutes * 60_000) : null;
  if (!session || session.expiresAt < now || idleExpiresAt! < now) {
    if (session) await prisma.authSession.deleteMany({ where: { id: session.id } });
    throw new HttpError(401, 'Session expired. Please sign in again');
  }
  // Persist activity at most once per minute to avoid turning every request
  // into a write while still providing useful device-session visibility.
  if (now.getTime() - session.lastSeenAt.getTime() >= 60_000) {
    await prisma.authSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    session.lastSeenAt = now;
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
const registrationLimit = sharedRateLimit({
  name: 'auth-register',
  windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  message: { error: 'Too many attempts. Please try again later.' },
});
const loginLimit = sharedRateLimit({
  name: 'auth-login',
  windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  // Only failed credentials should spend the brute-force budget. Successful
  // sign-ins are ordinary use and must not lock out a shared office or test
  // runner that legitimately signs several accounts in from one address.
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please try again later.' },
});
const emailVerificationLimit = sharedRateLimit({
  name: 'auth-verification-resend',
  windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  message: { error: 'Too many verification emails requested. Please try again later.' },
});
const emailVerificationAttemptLimit = sharedRateLimit({
  name: 'auth-verification-attempt',
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  message: { error: 'Too many verification attempts. Please try again later.' },
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
  termsAccepted: z.literal(true),
  privacyNoticeAcknowledged: z.literal(true),
  termsVersion: z.string().trim().min(1).max(120),
  privacyPolicyVersion: z.string().trim().min(1).max(120),
  policySetHash: z.string().trim().toLowerCase().regex(/^[0-9a-f]{64}$/),
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

function assertCurrentSignupDocuments(input: {
  termsVersion: string; privacyPolicyVersion: string; policySetHash: string;
}) {
  assertLegalAcceptanceEnabled();
  if (input.termsVersion !== CURRENT_TERMS_VERSION
    || input.privacyPolicyVersion !== CURRENT_PRIVACY_NOTICE_VERSION
    || input.policySetHash !== CURRENT_LEGAL_POLICY_SET_HASH) {
    throw new HttpError(409, "Courtly's legal documents changed. Review the current versions and try again.", {
      code: 'LEGAL_DOCUMENTS_CHANGED',
      termsVersion: CURRENT_TERMS_VERSION,
      privacyPolicyVersion: CURRENT_PRIVACY_NOTICE_VERSION,
      policySetHash: CURRENT_LEGAL_POLICY_SET_HASH,
    });
  }
}

export function assertSignupEmailVerificationAvailable(
  isProduction = production,
  emailEnabled = config.email.enabled,
  keyring = configuredEmailVerificationKeyring(),
) {
  if (!isProduction || (emailEnabled && keyring.enabled && keyring.keys.has(keyring.activeKeyId))) return;
  throw new HttpError(503, 'Account registration is temporarily unavailable because email verification is not configured.', {
    code: 'SIGNUP_EMAIL_VERIFICATION_UNAVAILABLE',
  });
}

async function createEmailVerification(
  tx: Prisma.TransactionClient,
  user: { id: string; email: string | null; name: string },
  issuedAt: Date,
) {
  if (!user.email) throw new HttpError(500, 'Credentialed account is missing an email address');
  const claimId = randomUUID();
  const expiresAt = new Date(issuedAt.getTime() + EMAIL_VERIFICATION_LIFETIME_MS);
  const { keyId: tokenKeyId, token } = activeEmailVerificationToken(claimId);
  const claim = await tx.emailVerificationClaim.create({ data: {
    id: claimId, userId: user.id, email: user.email,
    tokenHash: emailVerificationTokenDigest(token), tokenKeyId, expiresAt,
  } });
  const delivery = await enqueueEmailVerificationSecurityEmail(tx, {
    claimId: claim.id, tokenKeyId, recipientEmail: user.email, recipientName: user.name,
    recipientUserId: user.id, expiresAt,
  });
  if (config.email.enabled && (!delivery || typeof delivery !== 'object'
    || !('status' in delivery) || String(delivery.status) !== 'QUEUED')) {
    throw new HttpError(503, 'Verification email cannot be queued for this address', {
      code: 'EMAIL_VERIFICATION_UNAVAILABLE',
    });
  }
  return { claim, delivery };
}
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
  assertCurrentSignupDocuments(body);
  assertSignupEmailVerificationAvailable();
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
    const acceptedAt = new Date();
    const userData = {
      name: accountName, legalName: accountName, dateOfBirth,
      username: body.username, email: body.email, passwordHash, accountType: body.accountType,
      sports: body.sports,
      // Self-managed teens start private. Public discovery requires a later
      // deliberate profile choice rather than a signup default.
      profileVisibility: age !== null && age < 18 ? 'PRIVATE' : 'PUBLIC',
      termsAcceptedVersion: body.termsVersion, termsAcceptedAt: acceptedAt,
      privacyNoticeAcceptedVersion: body.privacyPolicyVersion, privacyNoticeAcceptedAt: acceptedAt,
      signupPolicySetHash: CURRENT_LEGAL_POLICY_SET_HASH,
      phone: body.phone ?? '', parentName: body.parentName ?? '',
    };
    if (body.accountType !== 'CLUB') {
      const user = await tx.user.create({ data: userData });
      await tx.signupAcceptanceEvidence.create({ data: {
        id: randomUUID(), userId: user.id, termsVersion: body.termsVersion,
        privacyNoticeVersion: body.privacyPolicyVersion,
        policySetHash: CURRENT_LEGAL_POLICY_SET_HASH, acceptedAt, createdAt: acceptedAt,
      } });
      await createEmailVerification(tx, user, acceptedAt);
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
    await tx.signupAcceptanceEvidence.create({ data: {
      id: randomUUID(), userId: user.id, termsVersion: body.termsVersion,
      privacyNoticeVersion: body.privacyPolicyVersion,
      policySetHash: CURRENT_LEGAL_POLICY_SET_HASH, acceptedAt, createdAt: acceptedAt,
    } });
    await createEmailVerification(tx, user, acceptedAt);
    // A club account is the club, not a person, so it gets no roster entry of
    // its own. Whoever coaches here — including the founder — registers a coach
    // account and is added to the roster like anyone else.
    const membership = await tx.membership.create({
      data: { userId: user.id, businessId: business.id },
    });
    return { user, membershipId: membership.id };
  });
  await issueSession(result.user.id, res, result.membershipId, null, req.cookies?.[config.sessionCookie], {
    recentAuthAt: new Date(), userAgent: req.get('user-agent') ?? null,
  });
  res.status(201).json(await authState(result.user.id, result.membershipId));
}));

const verificationToken = z.string().trim().min(20).max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'Verification token is invalid');

authRouter.post('/verify-email', emailVerificationAttemptLimit, asyncRoute(async (req, res) => {
  const { token } = z.object({ token: verificationToken }).strict().parse(req.body);
  const tokenHash = emailVerificationTokenDigest(token);
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:email-verification:${tokenHash}`}, 0))`;
    await tx.$queryRaw`SELECT id FROM "EmailVerificationClaim" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    const claim = await tx.emailVerificationClaim.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!claim) return { code: 'EMAIL_VERIFICATION_NOT_FOUND' as const, status: 404 };
    if (claim.revokedAt || claim.consumedAt || claim.expiresAt <= new Date()) {
      return { code: 'EMAIL_VERIFICATION_EXPIRED' as const, status: 410 };
    }
    let expectedToken: string;
    try { expectedToken = deriveEmailVerificationToken(claim.id, claim.tokenKeyId); }
    catch { return { code: 'EMAIL_VERIFICATION_NOT_FOUND' as const, status: 404 }; }
    if (expectedToken !== token || claim.user.email !== claim.email) {
      return { code: 'EMAIL_VERIFICATION_NOT_FOUND' as const, status: 404 };
    }
    const now = new Date();
    await tx.user.update({ where: { id: claim.userId }, data: { emailVerifiedAt: now } });
    await tx.emailVerificationClaim.update({ where: { id: claim.id }, data: { consumedAt: now } });
    return { code: null, status: 200, verifiedAt: now };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (result.code) throw new HttpError(result.status, 'This verification link is invalid or has expired', { code: result.code });
  res.json({ ok: true, verifiedAt: result.verifiedAt.toISOString() });
}));

authRouter.post('/email-verification/resend', requireAuth, emailVerificationLimit, asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  if (req.auth.user.emailVerifiedAt) {
    res.json({ ok: true, emailQueued: false, alreadyVerified: true });
    return;
  }
  const verificationKeyring = configuredEmailVerificationKeyring();
  if (!config.email.enabled || !verificationKeyring.enabled
    || !verificationKeyring.keys.has(verificationKeyring.activeKeyId)) {
    throw new HttpError(503, 'Verification email is temporarily unavailable', {
      code: 'EMAIL_VERIFICATION_UNAVAILABLE',
    });
  }
  const issuedAt = new Date();
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:email-verification-user:${req.auth.user.id}`}, 0))`;
    const user = await tx.user.findUnique({
      where: { id: req.auth.user.id }, select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });
    if (!user) throw new HttpError(404, 'Account not found');
    if (user.emailVerifiedAt) return { alreadyVerified: true, expiresAt: null };
    await tx.emailVerificationClaim.updateMany({
      where: { userId: user.id, consumedAt: null, revokedAt: null },
      data: { revokedAt: issuedAt },
    });
    const { claim } = await createEmailVerification(tx, user, issuedAt);
    return { alreadyVerified: false, expiresAt: claim.expiresAt };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  res.json({
    ok: true, emailQueued: !result.alreadyVerified, alreadyVerified: result.alreadyVerified,
    expiresAt: result.expiresAt?.toISOString() ?? null,
  });
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
  const mfa = await prisma.accountMfaCredential.findUnique({
    where: { userId: user.id }, select: { enabledAt: true },
  });
  if (mfa?.enabledAt) {
    const challenge = await createMfaLoginChallenge(user.id);
    res.status(202).json({
      mfaRequired: true, challengeId: challenge.challengeToken,
      methods: ['TOTP', 'RECOVERY_CODE'],
      expiresAt: challenge.expiresAt.toISOString(),
    });
    return;
  }
  await issueSession(user.id, res, membership?.id ?? null, activeStaffAccessId, previousToken, {
    recentAuthAt: new Date(), userAgent: req.get('user-agent') ?? null,
  });
  res.json(await authState(user.id, membership?.id ?? null));
}));

authRouter.post('/mfa/challenge', loginLimit, asyncRoute(async (req, res) => {
  const { challengeId, method, code } = z.object({
    challengeId: z.string().trim().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/),
    method: z.enum(['TOTP', 'RECOVERY_CODE']),
    code: z.string().trim().min(6).max(32),
  }).strict().parse(req.body);
  const completed = await consumeMfaLoginChallenge(challengeId, method, code);
  const user = await prisma.user.findUnique({
    where: { id: completed.userId },
    include: { memberships: { include: { business: true }, orderBy: membershipOrder } },
  });
  if (!user) throw new HttpError(401, 'MFA challenge is invalid or expired');
  const previousToken = req.cookies?.[config.sessionCookie];
  const previousSession = typeof previousToken === 'string'
    ? await prisma.authSession.findUnique({ where: { id: digest(previousToken) } }) : null;
  const currentId = previousSession?.userId === user.id && previousSession.expiresAt > new Date()
    ? previousSession.activeMembershipId : null;
  const membership = selectedMembership(user.accountType, user.memberships, currentId);
  const activeStaffAccessId = membership ? null
    : previousSession?.userId === user.id ? previousSession.activeStaffAccessId : null;
  await issueSession(user.id, res, membership?.id ?? null, activeStaffAccessId, previousToken, {
    recentAuthAt: completed.authenticatedAt, userAgent: req.get('user-agent') ?? null,
  });
  res.json(await authState(user.id, membership?.id ?? null));
}));

authRouter.post('/demo', sharedRateLimit({
  name: 'auth-demo',
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
        // Demo accounts have intentionally unshared random passwords. Treat
        // the explicit demo-entry action as fresh authentication so the
        // disposable workspace can exercise protected product flows without
        // inventing a reusable credential.
        await prisma.authSession.update({
          where: { id: existing.id },
          data: {
            activeMembershipId: membership.id,
            ...(membership.business.isDemo ? { recentAuthAt: new Date() } : {}),
          },
        });
        res.json(await authState(existing.userId, membership.id));
        return;
      }
    }
  }
  const result = await prisma.$transaction(
    tx => seedBusiness(tx, { isDemo: true, slug: `marcus-tan-${randomBytes(6).toString('hex')}` }),
    { timeout: 60_000 },
  );
  await issueSession(result.clubAccount.id, res, result.clubMembership.id, null, typeof previous === 'string' ? previous : undefined, {
    recentAuthAt: new Date(), userAgent: req.get('user-agent') ?? null,
  });
  res.status(201).json(await authState(result.clubAccount.id, result.clubMembership.id));
}));

authRouter.post('/logout', asyncRoute(async (req, res) => {
  const token = req.cookies?.[config.sessionCookie];
  if (typeof token === 'string') {
    // Ordinary sign-out is local to this browser. Global revocation is an
    // explicit, recent-authenticated action in the security centre.
    await prisma.authSession.deleteMany({ where: { id: digest(token) } });
  }
  res.clearCookie(config.sessionCookie, cookieOptions);
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, asyncRoute(async (req, res) => {
  res.json(await authState(req.auth.user.id, req.auth.membership?.id ?? null, req.auth.staffAccess?.id ?? null));
}));

authRouter.patch('/me', requireAuth, requireAccountCapability('profileEdit'), asyncRoute(async (req, res) => {
  const { accountType } = req.auth.user;
  // A coaching profile describes a person who teaches. Clubs and students get
  // a sentence rather than a generic unknown-field error.
  if (accountType !== 'COACH' && req.body && typeof req.body === 'object'
    && Object.prototype.hasOwnProperty.call(req.body, 'coachProfile')) {
    throw new HttpError(400, 'Only coach accounts have a coaching profile');
  }
  const input = accountType === 'CLUB'
    ? editableClubAccountProfile.parse(req.body)
    : accountType === 'COACH'
      ? editableCoachAccountProfile.parse(req.body)
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
