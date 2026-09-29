import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { config, skipRateLimits } from './config.js';
import { asyncRoute, HttpError, type AccountRequest } from './http.js';
import { authState } from './serializers.js';
import { initials } from './http.js';
import { sportsSchema, usernameSchema } from './account-profile.js';
import { hasCurrentChildConsent, loadAccountPolicy } from './account-policy.js';
import {
  ADULT_AGE,
  CHILD_AGE,
  CURRENT_PRIVACY_POLICY_VERSION,
  DEFAULT_GUARDIAN_PERMISSIONS,
  ageOnSingaporeDate,
  parseDateOfBirth,
  type GuardianPermission,
} from './children-policy.js';
import { assertLegalAcceptanceEnabled } from './legal-policy-gate.js';
import { enqueueFamilyHandoverSecurityEmail } from './outbound-events.js';
import { activeFamilyHandoverToken, familyHandoverTokenDigest } from './family-handover-token.js';
import { lockAccountEmailClaim } from './account-email-claim.js';
import { createBookingsInTransaction, type GuardianBookingInput } from './scheduling.js';

const HANDOVER_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const HANDOVER_COOLDOWN_MS = 60_000;
const SERIALIZABLE_RETRY_LIMIT = 3;
const consentDecisionEvents = ['GRANTED', 'RENEWED', 'WITHDRAWN'] as const;
const familyDashboardEvents = [...consentDecisionEvents, 'DELETION_REQUESTED'] as const;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

type FamilyDb = Pick<Prisma.TransactionClient,
  'user' | 'guardianChildLink' | 'childConsentRecord' | 'childAccountHandover'
  | 'student' | 'authSession' | 'venueReservation' | 'accountNotification' | 'outboundDelivery'
>;

const familyLinkInclude = {
  child: {
    include: {
      childHandovers: {
        where: { status: 'PENDING' },
        orderBy: [{ initiatedAt: 'desc' as const }, { id: 'desc' as const }],
        take: 1,
      },
    },
  },
  consentRecords: {
    where: { eventType: { in: [...familyDashboardEvents] } },
    orderBy: { sequence: 'desc' as const },
    take: 50,
  },
} satisfies Prisma.GuardianChildLinkInclude;

type FamilyLink = Prisma.GuardianChildLinkGetPayload<{ include: typeof familyLinkInclude }>;
type FamilyHandover = FamilyLink['child']['childHandovers'][number];
type ConsentRecord = FamilyLink['consentRecords'][number];

function isSerializationFailure(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return true;
  }
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const metadata = JSON.stringify(error.meta ?? {});
  return error.code === 'P2010' && (metadata.includes('40001') || metadata.includes('could not serialize access'));
}

async function serializableFamilyTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationFailure(error) || attempt >= SERIALIZABLE_RETRY_LIMIT) throw error;
    }
  }
}

function dateOnly(value: Date | null) {
  return value?.toISOString().slice(0, 10) ?? null;
}

function maskedEmail(value: string) {
  const [local, domain] = value.split('@');
  if (!local || !domain) return null;
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(3, Math.min(8, local.length - 1)))}@${domain}`;
}

function handoverJson(handover: FamilyHandover, emailQueued: boolean, now = new Date()) {
  const status = handover.status === 'PENDING' && handover.expiresAt <= now
    ? 'EXPIRED'
    : handover.status;
  return {
    id: handover.id,
    status,
    maskedDestinationEmail: maskedEmail(handover.destinationEmail),
    createdAt: handover.initiatedAt.toISOString(),
    expiresAt: handover.expiresAt.toISOString(),
    completedAt: handover.completedAt?.toISOString() ?? null,
    cancelledAt: handover.cancelledAt?.toISOString() ?? null,
    emailQueued,
  };
}

async function handoverEmailQueued(db: FamilyDb, handover: FamilyHandover) {
  const delivery = await db.outboundDelivery.findFirst({
    where: {
      channel: 'EMAIL',
      dedupeKey: `family-handover:${handover.id}:security-claim`,
      recipientKey: handover.destinationEmail,
    },
    select: { status: true },
  });
  return Boolean(delivery && ['QUEUED', 'SENDING', 'ACCEPTED', 'DELIVERED'].includes(delivery.status));
}

function consentJson(records: ConsentRecord[]) {
  const decisions = records.filter(record =>
    (consentDecisionEvents as readonly string[]).includes(record.eventType));
  const latest = decisions[0];
  if (!latest) return null;
  const granted = latest.eventType === 'WITHDRAWN'
    ? decisions.find(record => record.eventType === 'GRANTED' || record.eventType === 'RENEWED')
    : latest;
  return {
    status: latest.eventType,
    policyVersion: latest.privacyPolicyVersion,
    consentedAt: (granted ?? latest).createdAt.toISOString(),
    expiresAt: null,
    withdrawnAt: latest.eventType === 'WITHDRAWN' ? latest.createdAt.toISOString() : null,
  };
}

async function familyChildJson(link: FamilyLink, db: FamilyDb = prisma) {
  const policy = await loadAccountPolicy(link.child, { db });
  const pending = link.child.childHandovers[0] ?? null;
  const pendingEmailQueued = pending ? await handoverEmailQueued(db, pending) : false;
  const deletion = link.consentRecords.find(record => record.eventType === 'DELETION_REQUESTED');
  return {
    id: link.child.id,
    legalName: link.child.legalName,
    displayName: link.child.name,
    username: link.child.username,
    dateOfBirth: dateOnly(link.child.dateOfBirth),
    sports: link.child.sports,
    profileVisibility: link.child.profileVisibility,
    accountControl: link.child.accountControl,
    accountStatus: policy.reason === 'CONSENT_REQUIRED'
      && link.child.accountStatus !== 'DELETION_REQUESTED'
      ? 'CONSENT_REQUIRED'
      : link.child.accountStatus,
    ageBand: policy.ageBand,
    requiredAction: policy.reason,
    link: {
      id: link.id,
      status: link.status,
      relationshipType: link.relationshipType,
      permissions: link.permissions,
      createdAt: link.createdAt.toISOString(),
      endedAt: link.endedAt?.toISOString() ?? null,
    },
    consent: consentJson(link.consentRecords),
    handover: pending ? handoverJson(pending, pendingEmailQueued) : null,
    deletionRequestedAt: deletion?.createdAt.toISOString() ?? null,
  };
}

function renewalChildJson(link: FamilyLink) {
  return {
    id: link.child.id,
    displayName: link.child.name,
    access: 'CONSENT_RENEWAL' as const,
    link: {
      id: link.id,
      status: link.status,
      relationshipType: link.relationshipType,
    },
    consent: consentJson(link.consentRecords),
  };
}

function guardianEligible(user: {
  accountType: string; accountControl: string; accountStatus: string; dateOfBirth: Date | null;
}) {
  const age = ageOnSingaporeDate(user.dateOfBirth);
  return user.accountType !== 'CLUB'
    && user.accountControl === 'SELF'
    && user.accountStatus === 'ACTIVE'
    && age !== null
    && age >= ADULT_AGE;
}

function guardianEmailVerified(user: { emailVerifiedAt: Date | null; createdAt: Date }, now = new Date()) {
  // Existing production accounts predate verification. Give that cohort a
  // bounded transition through 29 October 2026; every new account and all
  // accounts after the cutoff must prove control of their email first.
  const transitionCutoff = new Date('2026-10-29T00:00:00.000Z');
  const signupEvidenceLaunchedAt = new Date('2026-09-29T00:00:00.000Z');
  return Boolean(user.emailVerifiedAt)
    || (user.createdAt < signupEvidenceLaunchedAt && now < transitionCutoff);
}

function assertGuardianEligible(user: {
  accountType: string; accountControl: string; accountStatus: string; dateOfBirth: Date | null;
  emailVerifiedAt: Date | null; createdAt: Date;
}) {
  if (!guardianEligible(user)) {
    throw new HttpError(403, 'Only an eligible adult personal account can manage children', {
      code: 'FAMILY_MANAGEMENT_REQUIRED',
    });
  }
  if (!guardianEmailVerified(user)) {
    throw new HttpError(403, 'Verify your email before managing a child profile', {
      code: 'EMAIL_VERIFICATION_REQUIRED',
    });
  }
}

function validDateOfBirth(value: string, context: z.RefinementCtx) {
  try {
    const parsed = parseDateOfBirth(value);
    if (parsed.getUTCFullYear() < 1900) throw new Error('outside supported range');
    ageOnSingaporeDate(parsed);
    return parsed;
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Date of birth must be a valid date from 1900 onwards and cannot be in the future',
    });
    return z.NEVER;
  }
}

const dateOfBirthSchema = z.string().trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must use YYYY-MM-DD')
  .transform(validDateOfBirth);
const emptyBody = z.object({}).strict();
const emptyQuery = z.object({}).strict();
const childParams = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const handoverParams = z.object({
  id: z.string().trim().min(1).max(200),
  handoverId: z.string().trim().min(1).max(200),
}).strict();
const tokenParams = z.object({
  token: z.string().trim().min(20).max(200)
    .regex(/^[A-Za-z0-9_-]+$/, 'Handover token is invalid'),
}).strict();
const setDateOfBirthBody = z.object({ dateOfBirth: dateOfBirthSchema }).strict();
const createChildBody = z.object({
  legalName: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(120),
  username: usernameSchema,
  dateOfBirth: dateOfBirthSchema,
  sports: sportsSchema,
  relationship: z.string().trim().min(2).max(80),
  profileVisibility: z.enum(['PRIVATE', 'CLUBS_ONLY']),
  legalGuardianConfirmed: z.literal(true),
  privacyPolicyVersion: z.string().trim().min(1).max(120),
}).strict();
const updateChildBody = z.object({
  legalName: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(120),
  sports: sportsSchema,
  profileVisibility: z.enum(['PRIVATE', 'CLUBS_ONLY']),
}).partial().strict().refine(value => Object.keys(value).length > 0, 'Provide at least one child profile field');
const renewConsentBody = z.object({
  legalGuardianConfirmed: z.literal(true),
  privacyPolicyVersion: z.string().trim().min(1).max(120),
}).strict();
const createHandoverBody = z.object({
  destinationEmail: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
}).strict();
const completeHandoverBody = z.object({
  password: z.string().min(12, 'Use a password with at least 12 characters').max(72)
    .refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes'),
}).strict();
const guardianBookingBody = z.object({
  businessSlug: z.string().trim().min(1).max(200),
  serviceId: z.string().trim().min(1).max(200),
  instructorId: z.string().trim().min(1).max(200),
  locationId: z.string().trim().min(1).max(200),
  startAt: z.string().datetime({ offset: true }),
  repeatWeeks: z.number().int().min(1).max(12).default(1),
  notes: z.string().max(2000).default(''),
  address: z.string().max(500).default(''),
}).strict();

function assertCurrentPrivacyPolicy(version: string) {
  assertLegalAcceptanceEnabled();
  if (version !== CURRENT_PRIVACY_POLICY_VERSION) {
    throw new HttpError(409, 'The child privacy policy changed. Review the current policy and try again', {
      code: 'PRIVACY_POLICY_CHANGED',
      privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
    });
  }
}

async function childLock(tx: Prisma.TransactionClient, childUserId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:family-child:${childUserId}`}, 0))`;
}

async function lockGuardian(tx: Prisma.TransactionClient, guardianUserId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:family-guardian:${guardianUserId}`}, 0))`;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${guardianUserId} FOR UPDATE`;
  const guardian = await tx.user.findUnique({ where: { id: guardianUserId } });
  if (!guardian) throw new HttpError(401, 'Please sign in to continue');
  assertGuardianEligible(guardian);
  return guardian;
}

async function authorizedLink(
  db: FamilyDb,
  guardianUserId: string,
  childUserId: string,
  permission: GuardianPermission,
  statuses: readonly string[] = ['ACTIVE'],
) {
  const link = await db.guardianChildLink.findFirst({
    where: {
      guardianUserId, childUserId, status: { in: [...statuses] },
      permissions: { has: permission },
    },
    include: familyLinkInclude,
  });
  if (!link) {
    throw new HttpError(404, 'Child profile not found', { code: 'CHILD_NOT_FOUND' });
  }
  return link;
}

async function lockedAuthorizedLink(
  tx: Prisma.TransactionClient,
  guardianUserId: string,
  childUserId: string,
  permission: GuardianPermission,
  statuses: readonly string[] = ['ACTIVE'],
) {
  await childLock(tx, childUserId);
  await tx.$queryRaw`SELECT id FROM "GuardianChildLink"
    WHERE "guardianUserId" = ${guardianUserId} AND "childUserId" = ${childUserId}
    FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${childUserId} FOR UPDATE`;
  return authorizedLink(tx, guardianUserId, childUserId, permission, statuses);
}

async function appendConsentEvent(
  tx: Prisma.TransactionClient,
  link: Pick<FamilyLink, 'id' | 'guardianUserId' | 'childUserId' | 'relationshipType' | 'permissions'>,
  eventType: 'GRANTED' | 'RENEWED' | 'WITHDRAWN' | 'HANDOVER_STARTED'
    | 'HANDOVER_CANCELLED' | 'HANDOVER_COMPLETED' | 'DELETION_REQUESTED',
  metadata?: Prisma.InputJsonValue,
) {
  // All Family lifecycle events take the child lock before INSERT. PostgreSQL's
  // statement-level account-shape lock then serializes sequence assignment, so
  // transaction start timestamps cannot reorder decisions.
  await childLock(tx, link.childUserId);
  return tx.childConsentRecord.create({ data: {
    linkId: link.id,
    guardianUserId: link.guardianUserId,
    childUserId: link.childUserId,
    eventType,
    relationshipType: link.relationshipType,
    privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
    permissions: link.permissions,
    ...(metadata === undefined ? {} : { metadata }),
  } });
}

async function hasCurrentLinkConsent(db: FamilyDb, linkId: string) {
  const latest = await db.childConsentRecord.findFirst({
    where: { linkId, eventType: { in: [...consentDecisionEvents] } },
    orderBy: { sequence: 'desc' },
    select: { eventType: true, privacyPolicyVersion: true },
  });
  return (latest?.eventType === 'GRANTED' || latest?.eventType === 'RENEWED')
    && latest.privacyPolicyVersion === CURRENT_PRIVACY_POLICY_VERSION;
}

function bookingChildJson(child: Pick<FamilyLink['child'], 'id' | 'name' | 'username'>) {
  return { id: child.id, displayName: child.name, username: child.username };
}

function bookingEligibleManagedChild(child: FamilyLink['child']) {
  const age = ageOnSingaporeDate(child.dateOfBirth);
  return child.accountType === 'STUDENT'
    && child.accountControl === 'GUARDIAN_MANAGED'
    && child.accountStatus === 'ACTIVE'
    && age !== null
    && age < ADULT_AGE;
}

async function recomputeManagedChildConsent(tx: Prisma.TransactionClient, childUserId: string) {
  const child = await tx.user.findUnique({ where: { id: childUserId } });
  if (!child || child.accountControl !== 'GUARDIAN_MANAGED'
    || child.accountStatus === 'DELETION_REQUESTED') return;
  const current = await hasCurrentChildConsent(childUserId, tx);
  await tx.user.update({
    where: { id: childUserId },
    data: {
      accountStatus: current ? 'ACTIVE' : 'CONSENT_REQUIRED',
      ...(!current ? { profileVisibility: 'PRIVATE' } : {}),
    },
  });
}

function assertManagedChild(child: FamilyLink['child']) {
  if (child.accountControl !== 'GUARDIAN_MANAGED') {
    throw new HttpError(409, 'This profile is no longer guardian-managed', {
      code: 'CHILD_NOT_GUARDIAN_MANAGED',
    });
  }
  if (child.accountStatus === 'DELETION_REQUESTED') {
    throw new HttpError(409, 'This child profile is pending deletion', {
      code: 'CHILD_DELETION_REQUESTED',
    });
  }
}

async function refreshedChild(
  db: FamilyDb,
  guardianUserId: string,
  childUserId: string,
  permission: GuardianPermission,
  statuses: readonly string[] = ['ACTIVE'],
) {
  return familyChildJson(
    await authorizedLink(db, guardianUserId, childUserId, permission, statuses),
    db,
  );
}

function handoverStateError(status: string): HttpError | null {
  if (status === 'COMPLETED') {
    return new HttpError(409, 'This handover link has already been used', {
      code: 'HANDOVER_ALREADY_USED',
    });
  }
  if (status === 'EXPIRED') {
    return new HttpError(410, 'This handover link has expired', { code: 'HANDOVER_EXPIRED' });
  }
  if (status === 'CANCELLED') {
    return new HttpError(409, 'This handover link was cancelled', {
      code: 'HANDOVER_CANCELLED',
    });
  }
  return null;
}

function publicHandoverToken(params: unknown) {
  const parsed = tokenParams.safeParse(params);
  if (!parsed.success) {
    throw new HttpError(404, 'Handover not found', { code: 'HANDOVER_NOT_FOUND' });
  }
  return parsed.data.token;
}

async function suppressQueuedHandoverDelivery(
  tx: Prisma.TransactionClient,
  handoverId: string,
  now: Date,
  reason: string,
) {
  await tx.outboundDelivery.updateMany({
    where: {
      channel: 'EMAIL',
      dedupeKey: `family-handover:${handoverId}:security-claim`,
      status: { in: ['QUEUED', 'SENDING'] },
    },
    data: {
      status: 'SUPPRESSED',
      leaseToken: null,
      leasedUntil: null,
      lastErrorCode: reason,
      lastErrorAt: now,
    },
  });
}

async function cancelPendingChildHandover(
  tx: Prisma.TransactionClient,
  link: Pick<FamilyLink, 'id' | 'guardianUserId' | 'childUserId' | 'relationshipType' | 'permissions'>,
  now: Date,
  reason: string,
  options: { restrictCrossGuardian?: boolean } = {},
) {
  const mayCancelCrossGuardian = !options.restrictCrossGuardian
    || link.permissions.includes('HANDOVER_MANAGE');
  const pending = await tx.childAccountHandover.findFirst({
    where: {
      childUserId: link.childUserId,
      status: 'PENDING',
      ...(mayCancelCrossGuardian ? {} : { initiatedByGuardianUserId: link.guardianUserId }),
    },
    orderBy: [{ initiatedAt: 'desc' }, { id: 'desc' }],
  });
  if (!pending) return;
  await tx.$queryRaw`SELECT id FROM "ChildAccountHandover" WHERE id = ${pending.id} FOR UPDATE`;
  const live = await tx.childAccountHandover.findUnique({ where: { id: pending.id } });
  if (!live || live.status !== 'PENDING') return;
  await tx.childAccountHandover.update({
    where: { id: live.id },
    data: { status: 'CANCELLED', cancelledAt: now },
  });
  await suppressQueuedHandoverDelivery(tx, live.id, now, reason);
  await appendConsentEvent(tx, link, 'HANDOVER_CANCELLED', {
    handoverId: live.id,
    reason,
  });
}

const publicHandoverLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: skipRateLimits,
  message: { error: 'Too many handover attempts. Please try again later.' },
});

const familyMutationLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: req => skipRateLimits() || ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  // Authentication runs before this router, so shared networks do not merge
  // separate guardians into one privacy-sensitive mutation budget.
  keyGenerator: req => (req as AccountRequest).auth?.user.id ?? 'unauthenticated',
  message: { error: 'Too many family changes. Please wait a moment.' },
});

export const familyRouter = Router();
export const familyPublicRouter = Router();
familyRouter.use(familyMutationLimit);

familyRouter.get('/', asyncRoute(async (req, res) => {
  emptyQuery.parse(req.query);
  const links = await prisma.guardianChildLink.findMany({
    where: {
      guardianUserId: req.auth.user.id,
      OR: [
        { status: 'ACTIVE', permissions: { has: 'PROFILE_MANAGE' } },
        { status: 'WITHDRAWN', permissions: { has: 'CONSENT_MANAGE' } },
      ],
    },
    include: familyLinkInclude,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  res.json({
    guardian: {
      eligible: guardianEligible(req.auth.user) && guardianEmailVerified(req.auth.user),
      // Report the actual verification state. Legacy accounts may remain
      // temporarily eligible during the bounded transition without being
      // represented to clients as verified.
      emailVerified: req.auth.user.emailVerifiedAt !== null,
      reason: req.auth.policy.reason,
    },
    children: await Promise.all(links.map(link => link.status === 'ACTIVE'
      ? familyChildJson(link)
      : renewalChildJson(link))),
    privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
    handoverAvailable: config.email.enabled && config.familyHandoverTokens.enabled,
  });
}));

familyRouter.get('/booking-children', asyncRoute(async (req, res) => {
  emptyQuery.parse(req.query);
  const guardian = await prisma.user.findUnique({ where: { id: req.auth.user.id } });
  if (!guardian) throw new HttpError(401, 'Please sign in to continue');
  assertGuardianEligible(guardian);

  const links = await prisma.guardianChildLink.findMany({
    where: {
      guardianUserId: guardian.id,
      status: 'ACTIVE',
      permissions: { has: 'BOOKINGS_MANAGE' },
    },
    include: familyLinkInclude,
    orderBy: [{ child: { name: 'asc' } }, { childUserId: 'asc' }],
  });
  const children = links.filter(link => {
    const consent = link.consentRecords.find(record =>
      (consentDecisionEvents as readonly string[]).includes(record.eventType));
    return bookingEligibleManagedChild(link.child)
      && (consent?.eventType === 'GRANTED' || consent?.eventType === 'RENEWED')
      && consent.privacyPolicyVersion === CURRENT_PRIVACY_POLICY_VERSION;
  }).map(link => bookingChildJson(link.child));
  res.json({ children });
}));

familyRouter.post('/children/:id/bookings', asyncRoute(async (req, res) => {
  const { id } = childParams.parse(req.params);
  const body = guardianBookingBody.parse(req.body);
  const result = await prisma.$transaction(async tx => {
    // Consent mutation, deletion and handover completion use this same lock.
    // Retain it through scheduling so authority and the booking commit as one
    // decision rather than as a stale preflight check.
    await childLock(tx, id);
    const guardian = await lockGuardian(tx, req.auth.user.id);
    await tx.$queryRaw`SELECT id FROM "GuardianChildLink"
      WHERE "guardianUserId" = ${guardian.id} AND "childUserId" = ${id}
      FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
    const link = await authorizedLink(tx, guardian.id, id, 'BOOKINGS_MANAGE');
    if (!bookingEligibleManagedChild(link.child) || !await hasCurrentLinkConsent(tx, link.id)) {
      throw new HttpError(404, 'Child profile not found', { code: 'CHILD_NOT_FOUND' });
    }
    const business = await tx.business.findFirst({
      where: { slug: body.businessSlug, kind: 'CLUB', legacyReadOnly: false },
      select: { id: true },
    });
    if (!business) throw new HttpError(404, 'Booking page not found');

    const bookingInput: GuardianBookingInput = {
      serviceId: body.serviceId, instructorId: body.instructorId, locationId: body.locationId,
      startAt: body.startAt, repeatWeeks: body.repeatWeeks, notes: body.notes, address: body.address,
    };
    if (guardian.accountType !== 'STUDENT' && guardian.accountType !== 'COACH') {
      throw new HttpError(403, 'Only a personal guardian account can book for a child', {
        code: 'FAMILY_MANAGEMENT_REQUIRED',
      });
    }
    const created = await createBookingsInTransaction(tx, business.id, bookingInput, {
      guardianUserId: guardian.id,
      guardianAccountType: guardian.accountType,
      managedChildUserId: id,
    });
    return { bookedFor: bookingChildJson(link.child), ...created };
  }, { timeout: 30_000 });
  res.status(201).json(result);
}));

familyRouter.post('/date-of-birth', asyncRoute(async (req, res) => {
  const body = setDateOfBirthBody.parse(req.body);
  const result = await serializableFamilyTransaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${req.auth.user.id} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: req.auth.user.id } });
    if (!user) throw new HttpError(401, 'Please sign in to continue');
    if (user.accountType === 'CLUB' || user.accountControl !== 'SELF') {
      throw new HttpError(403, 'This account cannot set a personal date of birth', {
        code: 'DATE_OF_BIRTH_NOT_ALLOWED',
      });
    }
    if (user.dateOfBirth) {
      throw new HttpError(409, 'Date of birth has already been set and cannot be changed', {
        code: 'DATE_OF_BIRTH_IMMUTABLE',
      });
    }
    const age = ageOnSingaporeDate(body.dateOfBirth);
    if (age !== null && age < CHILD_AGE) {
      throw new HttpError(403, 'A parent or guardian must create and manage this child account', {
        code: 'PARENT_ACCOUNT_REQUIRED',
      });
    }
    await tx.user.update({ where: { id: user.id }, data: { dateOfBirth: body.dateOfBirth } });
    return user.id;
  });
  res.json(await authState(result, req.auth.membership?.id ?? null, req.auth.staffAccess?.id ?? null));
}));

familyRouter.post('/children', asyncRoute(async (req, res) => {
  const body = createChildBody.parse(req.body);
  assertCurrentPrivacyPolicy(body.privacyPolicyVersion);
  const childAge = ageOnSingaporeDate(body.dateOfBirth);
  if (childAge === null || childAge >= ADULT_AGE) {
    throw new HttpError(400, 'Managed child profiles are only available for people under 18', {
      code: 'MANAGED_CHILD_AGE_REQUIRED',
    });
  }

  let link: FamilyLink;
  try {
    link = await prisma.$transaction(async tx => {
      await lockGuardian(tx, req.auth.user.id);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:family-username:${body.username}`}, 0))`;
      const child = await tx.user.create({ data: {
        legalName: body.legalName,
        name: body.displayName,
        username: body.username,
        dateOfBirth: body.dateOfBirth,
        email: null,
        emailVerifiedAt: null,
        passwordHash: null,
        accountType: 'STUDENT',
        accountControl: 'GUARDIAN_MANAGED',
        accountStatus: 'ACTIVE',
        profileVisibility: body.profileVisibility,
        sports: body.sports,
        phone: '',
        parentName: '',
      } });
      const createdLink = await tx.guardianChildLink.create({
        data: {
          guardianUserId: req.auth.user.id,
          childUserId: child.id,
          relationshipType: body.relationship.toUpperCase(),
          permissions: [...DEFAULT_GUARDIAN_PERMISSIONS],
        },
        include: familyLinkInclude,
      });
      await appendConsentEvent(tx, createdLink, 'GRANTED');
      return authorizedLink(tx, req.auth.user.id, child.id, 'PROFILE_MANAGE');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'That username is already taken', { code: 'USERNAME_TAKEN' });
    }
    throw error;
  }

  res.status(201).json({ child: await familyChildJson(link) });
}));

familyRouter.patch('/children/:id', asyncRoute(async (req, res) => {
  const { id } = childParams.parse(req.params);
  const body = updateChildBody.parse(req.body);
  const child = await prisma.$transaction(async tx => {
    const link = await lockedAuthorizedLink(tx, req.auth.user.id, id, 'PROFILE_MANAGE');
    assertManagedChild(link.child);
    if (body.profileVisibility !== undefined
      && body.profileVisibility !== link.child.profileVisibility
      && !link.permissions.includes('PRIVACY_MANAGE')) {
      throw new HttpError(403, 'Privacy management permission is required to change visibility', {
        code: 'GUARDIAN_PERMISSION_REQUIRED',
        permission: 'PRIVACY_MANAGE',
      });
    }
    await tx.user.update({ where: { id }, data: {
      ...(body.legalName === undefined ? {} : { legalName: body.legalName }),
      ...(body.displayName === undefined ? {} : { name: body.displayName }),
      ...(body.sports === undefined ? {} : { sports: body.sports }),
      ...(body.profileVisibility === undefined ? {} : { profileVisibility: body.profileVisibility }),
    } });
    if (body.displayName !== undefined) {
      await tx.student.updateMany({
        where: { userId: id },
        data: { name: body.displayName, initials: initials(body.displayName) },
      });
    }
    return refreshedChild(tx, req.auth.user.id, id, 'PROFILE_MANAGE');
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  res.json({ child });
}));

familyRouter.post('/children/:id/consent/withdraw', asyncRoute(async (req, res) => {
  const { id } = childParams.parse(req.params);
  emptyBody.parse(req.body ?? {});
  const child = await prisma.$transaction(async tx => {
    const link = await lockedAuthorizedLink(tx, req.auth.user.id, id, 'CONSENT_MANAGE');
    assertManagedChild(link.child);
    const latest = link.consentRecords.find(record =>
      (consentDecisionEvents as readonly string[]).includes(record.eventType));
    if (!latest || latest.eventType === 'WITHDRAWN') {
      throw new HttpError(409, 'Guardian consent is already withdrawn', {
        code: 'CONSENT_ALREADY_WITHDRAWN',
      });
    }
    await appendConsentEvent(tx, link, 'WITHDRAWN');
    const withdrawnAt = new Date();
    await cancelPendingChildHandover(tx, link, withdrawnAt, 'CONSENT_WITHDRAWN', {
      restrictCrossGuardian: true,
    });
    await tx.guardianChildLink.update({
      where: { id: link.id },
      data: { status: 'WITHDRAWN', withdrawnAt },
    });
    await recomputeManagedChildConsent(tx, id);
    await tx.authSession.deleteMany({ where: { userId: id } });
    return renewalChildJson(await authorizedLink(
      tx, req.auth.user.id, id, 'CONSENT_MANAGE', ['WITHDRAWN'],
    ));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  res.json({ child });
}));

familyRouter.post('/children/:id/consent/renew', asyncRoute(async (req, res) => {
  const { id } = childParams.parse(req.params);
  const body = renewConsentBody.parse(req.body);
  assertCurrentPrivacyPolicy(body.privacyPolicyVersion);
  const child = await prisma.$transaction(async tx => {
    const link = await lockedAuthorizedLink(
      tx, req.auth.user.id, id, 'CONSENT_MANAGE', ['ACTIVE', 'WITHDRAWN'],
    );
    assertManagedChild(link.child);
    const latest = link.consentRecords.find(record =>
      (consentDecisionEvents as readonly string[]).includes(record.eventType));
    if (latest && (latest.eventType === 'GRANTED' || latest.eventType === 'RENEWED')
      && latest.privacyPolicyVersion === CURRENT_PRIVACY_POLICY_VERSION) {
      throw new HttpError(409, 'Guardian consent is already current', {
        code: 'CONSENT_ALREADY_CURRENT',
      });
    }
    await appendConsentEvent(tx, link, 'RENEWED');
    if (link.status === 'WITHDRAWN') {
      await tx.guardianChildLink.update({
        where: { id: link.id },
        data: { status: 'ACTIVE', activatedAt: new Date(), withdrawnAt: null },
      });
    }
    await recomputeManagedChildConsent(tx, id);
    const refreshedLink = await authorizedLink(
      tx, req.auth.user.id, id, 'CONSENT_MANAGE', ['ACTIVE'],
    );
    return refreshedLink.permissions.includes('PROFILE_MANAGE')
      ? familyChildJson(refreshedLink, tx)
      : renewalChildJson(refreshedLink);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  res.json({ child });
}));

familyRouter.post('/children/:id/deletion-request', asyncRoute(async (req, res) => {
  const { id } = childParams.parse(req.params);
  emptyBody.parse(req.body ?? {});
  const child = await prisma.$transaction(async tx => {
    const link = await lockedAuthorizedLink(tx, req.auth.user.id, id, 'DELETION_REQUEST');
    assertManagedChild(link.child);
    const now = new Date();
    await cancelPendingChildHandover(tx, link, now, 'DELETION_REQUESTED');
    await appendConsentEvent(tx, link, 'DELETION_REQUESTED');
    await tx.user.update({
      where: { id },
      data: { accountStatus: 'DELETION_REQUESTED', profileVisibility: 'PRIVATE' },
    });
    await tx.authSession.deleteMany({ where: { userId: id } });
    return refreshedChild(tx, req.auth.user.id, id, 'DELETION_REQUEST');
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  res.json({ child });
}));

familyRouter.post('/children/:id/handovers', asyncRoute(async (req, res) => {
  const { id } = childParams.parse(req.params);
  const body = createHandoverBody.parse(req.body);
  if (!config.email.enabled || !config.familyHandoverTokens.enabled) {
    throw new HttpError(503, 'Verified handover is unavailable because secure email delivery is not configured', {
      code: 'FEATURE_UNAVAILABLE',
    });
  }
  const handoverId = randomUUID();
  const { keyId: tokenKeyId, token } = activeFamilyHandoverToken(handoverId);
  const tokenHash = familyHandoverTokenDigest(token);
  let result: { handover: FamilyHandover; emailQueued: boolean };
  try {
    result = await serializableFamilyTransaction(async tx => {
      const link = await lockedAuthorizedLink(tx, req.auth.user.id, id, 'HANDOVER_MANAGE');
      assertManagedChild(link.child);
      if (link.child.accountStatus !== 'ACTIVE') {
        throw new HttpError(409, 'This child account needs current consent before handover', {
          code: 'CONSENT_REQUIRED',
        });
      }
      const age = ageOnSingaporeDate(link.child.dateOfBirth);
      if (age === null || age < CHILD_AGE) {
        throw new HttpError(409, 'This child is not yet eligible for account handover', {
          code: 'HANDOVER_NOT_ELIGIBLE',
        });
      }
      if (!await hasCurrentLinkConsent(tx, link.id)) {
        throw new HttpError(409, 'Current guardian consent is required before account handover', {
          code: 'CONSENT_REQUIRED',
        });
      }
      const now = new Date();
      const destinationClaim = await lockAccountEmailClaim(tx, body.destinationEmail, { now });
      const current = link.child.childHandovers[0];
      if (current) {
        await tx.$queryRaw`SELECT id FROM "ChildAccountHandover" WHERE id = ${current.id} FOR UPDATE`;
        if (current.expiresAt > now) {
          throw new HttpError(409, 'A handover is already pending for this child', {
            code: 'HANDOVER_PENDING',
          });
        }
        if (!destinationClaim.expiredHandoverIds.includes(current.id)) {
          await tx.childAccountHandover.update({
            where: { id: current.id },
            data: { status: 'EXPIRED' },
          });
          await suppressQueuedHandoverDelivery(tx, current.id, now, 'HANDOVER_EXPIRED');
        }
      }
      const mostRecent = await tx.childAccountHandover.findFirst({
        where: { childUserId: id },
        orderBy: [{ lastSentAt: 'desc' }, { id: 'desc' }],
        select: { lastSentAt: true },
      });
      if (mostRecent && now.getTime() - mostRecent.lastSentAt.getTime() < HANDOVER_COOLDOWN_MS) {
        const retryAfterSeconds = Math.max(1, Math.ceil(
          (HANDOVER_COOLDOWN_MS - (now.getTime() - mostRecent.lastSentAt.getTime())) / 1000,
        ));
        throw new HttpError(429, 'Please wait before creating another handover', {
          code: 'HANDOVER_COOLDOWN',
          retryAfterSeconds,
        });
      }
      if (destinationClaim.pendingHandover) {
        throw new HttpError(409, 'This email cannot be used for handover', { code: 'EMAIL_CONFLICT' });
      }
      const emailOwner = await tx.user.findUnique({
        where: { email: body.destinationEmail },
        select: { id: true },
      });
      if (emailOwner) {
        throw new HttpError(409, 'This email cannot be used for handover', { code: 'EMAIL_CONFLICT' });
      }
      const expiresAt = new Date(now.getTime() + HANDOVER_LIFETIME_MS);
      const handover = await tx.childAccountHandover.create({ data: {
        id: handoverId,
        childUserId: id,
        initiatedByGuardianUserId: req.auth.user.id,
        destinationEmail: body.destinationEmail,
        tokenHash,
        expiresAt,
        initiatedAt: now,
        lastSentAt: now,
      } });
      await appendConsentEvent(tx, link, 'HANDOVER_STARTED', { handoverId: handover.id });
      const delivery = await enqueueFamilyHandoverSecurityEmail(tx, {
        handoverId: handover.id,
        recipientEmail: body.destinationEmail,
        recipientName: link.child.name,
        recipientUserId: null,
        tokenKeyId,
        expiresAt,
      });
      const deliveryStatus = delivery && typeof delivery === 'object' && 'status' in delivery
        ? String(delivery.status)
        : null;
      if (deliveryStatus !== 'QUEUED') {
        throw new HttpError(503, 'The handover email cannot be queued for this address', {
          code: 'FEATURE_UNAVAILABLE',
        });
      }
      return { handover, emailQueued: true };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'This email cannot be used for handover', { code: 'EMAIL_CONFLICT' });
    }
    throw error;
  }

  res.status(201).json({
    handover: handoverJson(result.handover, result.emailQueued),
    emailQueued: result.emailQueued,
  });
}));

familyRouter.delete('/children/:id/handovers/:handoverId', asyncRoute(async (req, res) => {
  const { id, handoverId } = handoverParams.parse(req.params);
  emptyBody.parse(req.body ?? {});
  await prisma.$transaction(async tx => {
    await childLock(tx, id);
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "GuardianChildLink"
      WHERE "guardianUserId" = ${req.auth.user.id} AND "childUserId" = ${id}
      FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ChildAccountHandover"
      WHERE id = ${handoverId} AND "childUserId" = ${id} FOR UPDATE`;
    const handover = await tx.childAccountHandover.findFirst({
      where: { id: handoverId, childUserId: id },
    });
    if (!handover) {
      throw new HttpError(404, 'Handover not found', { code: 'HANDOVER_NOT_FOUND' });
    }
    const link = await tx.guardianChildLink.findUnique({
      where: {
        guardianUserId_childUserId: { guardianUserId: req.auth.user.id, childUserId: id },
      },
      include: familyLinkInclude,
    });
    const activeAuthority = link?.status === 'ACTIVE' && link.permissions.includes('HANDOVER_MANAGE');
    if (!link || !activeAuthority) {
      throw new HttpError(404, 'Handover not found', { code: 'HANDOVER_NOT_FOUND' });
    }
    const now = new Date();
    if (handover.status === 'PENDING' && handover.expiresAt <= now) {
      await tx.childAccountHandover.update({ where: { id: handover.id }, data: { status: 'EXPIRED' } });
      await suppressQueuedHandoverDelivery(tx, handover.id, now, 'HANDOVER_EXPIRED');
      return { error: handoverStateError('EXPIRED') };
    }
    const stateError = handoverStateError(handover.status);
    if (stateError) return { error: stateError };
    await tx.childAccountHandover.update({
      where: { id: handover.id },
      data: { status: 'CANCELLED', cancelledAt: now },
    });
    await suppressQueuedHandoverDelivery(tx, handover.id, now, 'HANDOVER_CANCELLED');
    await appendConsentEvent(tx, link, 'HANDOVER_CANCELLED', { handoverId: handover.id });
    return { error: null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).then(result => {
    if (result.error) throw result.error;
  });
  res.json({ ok: true });
}));

familyRouter.get('/children/:id/export', asyncRoute(async (req, res) => {
  emptyQuery.parse(req.query);
  const { id } = childParams.parse(req.params);
  const child = await prisma.$transaction(async tx => {
    const lockedLink = await lockedAuthorizedLink(
      tx, req.auth.user.id, id, 'DATA_EXPORT', ['ACTIVE'],
    );
    if (!await hasCurrentLinkConsent(tx, lockedLink.id)) {
      throw new HttpError(409, 'Current guardian consent is required to export this profile', {
        code: 'CONSENT_REQUIRED',
      });
    }
    const lockedChild = await tx.user.findUnique({
      where: { id },
      select: {
        id: true, legalName: true, name: true, username: true, dateOfBirth: true,
        sports: true, accountType: true, accountControl: true, accountStatus: true,
        profileVisibility: true, phone: true, parentName: true, createdAt: true,
        childLinks: {
          select: {
            id: true, guardianUserId: true, relationshipType: true, status: true, permissions: true,
            createdAt: true, activatedAt: true, withdrawnAt: true, endedAt: true,
            guardian: { select: { name: true, username: true } },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        childConsentRecords: {
          select: {
            guardianUserId: true, eventType: true, relationshipType: true, privacyPolicyVersion: true,
            permissions: true, metadata: true, createdAt: true,
            guardian: { select: { name: true, username: true } },
          },
          orderBy: [{ createdAt: 'asc' }, { linkId: 'asc' }, { sequence: 'asc' }],
        },
        childHandovers: {
          select: {
            id: true, initiatedByGuardianUserId: true, destinationEmail: true, status: true, expiresAt: true,
            initiatedAt: true, lastSentAt: true, completedAt: true, cancelledAt: true,
            initiatedByGuardian: { select: { name: true, username: true } },
          },
          orderBy: [{ initiatedAt: 'asc' }, { id: 'asc' }],
        },
        students: {
          select: {
            id: true, name: true, email: true, phone: true, parentName: true, notes: true, createdAt: true,
            business: { select: { name: true, slug: true } },
            participants: {
              select: {
                id: true, attendance: true, paid: true, price: true, notes: true, cancelledAt: true,
                booking: { select: {
                  id: true, startAt: true, endAt: true, status: true, type: true,
                  service: { select: { name: true } },
                  instructor: { select: { name: true } },
                  location: { select: { name: true, address: true } },
                } },
              },
              orderBy: { id: 'asc' },
            },
            packages: {
              select: {
                id: true, name: true, totalCredits: true, usedCredits: true, price: true,
                expiresAt: true, paid: true,
              },
              orderBy: { id: 'asc' },
            },
            payments: {
              select: {
                id: true, kind: true, amount: true, method: true, note: true, paidAt: true, reversedAt: true,
              },
              orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
            },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
        venueReservations: {
          select: {
            id: true, startAt: true, endAt: true, duration: true, price: true, status: true,
            paymentStatus: true, notes: true, createdAt: true, cancelledAt: true,
            business: { select: { name: true, slug: true } },
            location: { select: { name: true, address: true } },
            unit: { select: { name: true } },
          },
          orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        },
        accountNotifications: {
          select: { type: true, title: true, message: true, read: true, actionNeeded: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!lockedChild) {
      throw new HttpError(404, 'Child profile not found', { code: 'CHILD_NOT_FOUND' });
    }
    return lockedChild;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  const guardianLinks = child.childLinks.map(({ guardianUserId, guardian, ...link }) => ({
    ...link,
    guardian: guardianUserId === req.auth.user.id ? guardian : null,
  }));
  const consentHistory = child.childConsentRecords.map(({ guardianUserId, guardian, ...record }) => ({
    ...record,
    guardian: guardianUserId === req.auth.user.id ? guardian : null,
  }));
  const handoverHistory = child.childHandovers.map((handover) => ({
    id: handover.id,
    maskedDestinationEmail: maskedEmail(handover.destinationEmail),
    status: handover.status,
    expiresAt: handover.expiresAt,
    initiatedAt: handover.initiatedAt,
    lastSentAt: handover.lastSentAt,
    completedAt: handover.completedAt,
    cancelledAt: handover.cancelledAt,
    initiatedByGuardian: handover.initiatedByGuardianUserId === req.auth.user.id
      ? handover.initiatedByGuardian
      : null,
  }));
  const payload = {
    format: 'COURTLY_CHILD_DATA_EXPORT',
    version: 1,
    exportedAt: new Date().toISOString(),
    subject: {
      id: child.id, legalName: child.legalName, displayName: child.name, username: child.username,
      dateOfBirth: dateOnly(child.dateOfBirth), sports: child.sports, accountType: child.accountType,
      accountControl: child.accountControl, accountStatus: child.accountStatus,
      profileVisibility: child.profileVisibility, phone: child.phone, parentName: child.parentName,
      createdAt: child.createdAt,
    },
    guardianLinks,
    consentHistory,
    handoverHistory,
    clubRecords: child.students,
    venueReservations: child.venueReservations,
    notifications: child.accountNotifications,
  };
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="courtly-child-${child.username}-data.json"`);
  res.send(JSON.stringify(payload, null, 2));
}));

familyPublicRouter.get('/handovers/:token', publicHandoverLimit, asyncRoute(async (req, res) => {
  emptyQuery.parse(req.query);
  const token = publicHandoverToken(req.params);
  const tokenHash = digest(token);
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:family-handover-token:${tokenHash}`}, 0))`;
    const initial = await tx.childAccountHandover.findUnique({
      where: { tokenHash }, select: { childUserId: true },
    });
    if (!initial) return { handover: null, error: null };
    await childLock(tx, initial.childUserId);
    await tx.$queryRaw`SELECT id FROM "ChildAccountHandover" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    const handover = await tx.childAccountHandover.findUnique({
      where: { tokenHash },
      include: { child: true, initiatedByGuardian: true },
    });
    if (!handover) return { handover: null, error: null };
    if (handover.status === 'PENDING' && handover.expiresAt <= new Date()) {
      const now = new Date();
      await tx.childAccountHandover.update({ where: { id: handover.id }, data: { status: 'EXPIRED' } });
      await suppressQueuedHandoverDelivery(tx, handover.id, now, 'HANDOVER_EXPIRED');
      return { handover: null, error: handoverStateError('EXPIRED') };
    }
    const error = handoverStateError(handover.status);
    return { handover: error ? null : handover, error };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (result.error) throw result.error;
  if (!result.handover) {
    throw new HttpError(404, 'Handover not found', { code: 'HANDOVER_NOT_FOUND' });
  }
  res.json({
    childName: result.handover.child.name,
    guardianName: result.handover.initiatedByGuardian.name,
    maskedDestinationEmail: maskedEmail(result.handover.destinationEmail),
    expiresAt: result.handover.expiresAt.toISOString(),
    status: result.handover.status,
  });
}));

familyPublicRouter.post('/handovers/:token/complete', publicHandoverLimit, asyncRoute(async (req, res) => {
  const token = publicHandoverToken(req.params);
  const body = completeHandoverBody.parse(req.body);
  const tokenHash = digest(token);
  // Hash before looking up the token. This keeps expensive credential work out
  // of the transaction and narrows timing differences for unknown claim links.
  const passwordHash = await bcrypt.hash(body.password, 12);
  let result: { error: HttpError | null; username?: string; loginEmail?: string };
  try {
    result = await serializableFamilyTransaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:family-handover-token:${tokenHash}`}, 0))`;
      const initial = await tx.childAccountHandover.findUnique({
        where: { tokenHash }, select: { childUserId: true },
      });
      if (!initial) return { error: new HttpError(404, 'Handover not found', { code: 'HANDOVER_NOT_FOUND' }) };
      await childLock(tx, initial.childUserId);
      await tx.$queryRaw`SELECT id FROM "ChildAccountHandover" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${initial.childUserId} FOR UPDATE`;
      const handover = await tx.childAccountHandover.findUnique({
        where: { tokenHash },
        include: { child: true },
      });
      if (!handover) return { error: new HttpError(404, 'Handover not found', { code: 'HANDOVER_NOT_FOUND' }) };
      const now = new Date();
      if (handover.status === 'PENDING' && handover.expiresAt <= now) {
        await tx.childAccountHandover.update({ where: { id: handover.id }, data: { status: 'EXPIRED' } });
        await suppressQueuedHandoverDelivery(tx, handover.id, now, 'HANDOVER_EXPIRED');
        return { error: handoverStateError('EXPIRED')! };
      }
      const stateError = handoverStateError(handover.status);
      if (stateError) return { error: stateError };
      if (handover.child.accountControl !== 'GUARDIAN_MANAGED'
        || handover.child.accountStatus !== 'ACTIVE') {
        return { error: new HttpError(409, 'This handover can no longer be completed', {
          code: 'HANDOVER_UNAVAILABLE',
        }) };
      }
      const age = ageOnSingaporeDate(handover.child.dateOfBirth);
      if (age === null || age < CHILD_AGE) {
        return { error: new HttpError(409, 'This handover can no longer be completed', {
          code: 'HANDOVER_UNAVAILABLE',
        }) };
      }
      const activeLinks = await tx.guardianChildLink.findMany({
        where: { childUserId: handover.childUserId, status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const initiatingLink = activeLinks.find(link =>
        link.guardianUserId === handover.initiatedByGuardianUserId
        && link.permissions.includes('HANDOVER_MANAGE'));
      if (!initiatingLink) {
        return { error: new HttpError(409, 'This handover can no longer be completed', {
          code: 'HANDOVER_UNAVAILABLE',
        }) };
      }
      if (!await hasCurrentLinkConsent(tx, initiatingLink.id)) {
        return { error: new HttpError(409, 'This handover can no longer be completed', {
          code: 'HANDOVER_UNAVAILABLE',
        }) };
      }
      const destinationClaim = await lockAccountEmailClaim(tx, handover.destinationEmail, {
        now, excludeHandoverId: handover.id,
      });
      const emailOwner = await tx.user.findUnique({
        where: { email: handover.destinationEmail }, select: { id: true },
      });
      if (emailOwner && emailOwner.id !== handover.childUserId) {
        return { error: new HttpError(409, 'This email cannot be used for handover', { code: 'EMAIL_CONFLICT' }) };
      }
      if (destinationClaim.pendingHandover) {
        return { error: new HttpError(409, 'This email cannot be used for handover', { code: 'EMAIL_CONFLICT' }) };
      }
      // The database guardian-link invariant runs on every link update. End all
      // authority first; only then may this identity become SELF-controlled.
      await tx.guardianChildLink.updateMany({
        where: { childUserId: handover.childUserId, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: now },
      });
      await appendConsentEvent(tx, initiatingLink, 'HANDOVER_COMPLETED', { handoverId: handover.id });
      await tx.user.update({
        where: { id: handover.childUserId },
        data: {
          email: handover.destinationEmail,
          emailVerifiedAt: now,
          passwordHash,
          accountControl: 'SELF',
          accountStatus: 'ACTIVE',
          profileVisibility: 'CLUBS_ONLY',
        },
      });
      await tx.student.updateMany({
        where: { userId: handover.childUserId },
        data: { email: handover.destinationEmail },
      });
      await tx.authSession.deleteMany({ where: { userId: handover.childUserId } });
      await tx.childAccountHandover.updateMany({
        where: {
          childUserId: handover.childUserId,
          status: 'PENDING',
          id: { not: handover.id },
        },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      await tx.childAccountHandover.update({
        where: { id: handover.id },
        data: { status: 'COMPLETED', completedAt: now },
      });
      await suppressQueuedHandoverDelivery(tx, handover.id, now, 'HANDOVER_COMPLETED');
      return {
        error: null,
        username: handover.child.username,
        loginEmail: handover.destinationEmail,
      };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new HttpError(409, 'This email cannot be used for handover', { code: 'EMAIL_CONFLICT' });
    }
    throw error;
  }
  if (result.error) throw result.error;
  res.json({ ok: true, username: result.username, loginEmail: result.loginEmail });
}));
