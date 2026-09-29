import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authRouter, requireAuth } from '../src/auth.js';
import { CURRENT_PRIVACY_POLICY_VERSION, DEFAULT_GUARDIAN_PERMISSIONS } from '../src/children-policy.js';
import { config } from '../src/config.js';
import { familyPublicRouter, familyRouter } from '../src/family.js';
import { deriveFamilyHandoverToken } from '../src/family-handover-token.js';
import { HttpError } from '../src/http.js';
import { prisma, verifyTestDatabase } from './fixtures.js';

const testApp = express();
testApp.use(express.json());
testApp.use(cookieParser());
testApp.use('/api/auth', authRouter);
testApp.use('/api/family', familyPublicRouter);
testApp.use('/api/family', requireAuth, familyRouter);
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, ...error.details });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    res.status(409).json({ error: 'This record already exists. Please use a different email or username.' });
    return;
  }
  if (error instanceof Error && error.name === 'ZodError') {
    const zod = error as Error & { issues?: Array<{ message?: string }>; flatten?: () => unknown };
    res.status(400).json({ error: zod.issues?.[0]?.message || 'Invalid input', issues: zod.flatten?.() });
    return;
  }
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error' });
};
testApp.use(errorHandler);

const ownedUserIds = new Set<string>();
const originalEmailEnabled = config.email.enabled;
const originalHandoverTokenConfig = {
  enabled: config.familyHandoverTokens.enabled,
  activeKeyId: config.familyHandoverTokens.activeKeyId,
  keys: config.familyHandoverTokens.keys,
};
const familyTestKeyId = 'family-test-v1';
const familyTestKey = Buffer.alloc(32, 29);

async function createUser(overrides: Record<string, unknown> = {}) {
  const identity = randomUUID().replaceAll('-', '');
  const user = await prisma.user.create({
    data: {
      name: 'Family Guardian',
      legalName: 'Family Guardian',
      username: `guardian_${identity.slice(0, 16)}`,
      email: `${identity}@example.test`,
      emailVerifiedAt: null,
      passwordHash: await bcrypt.hash('Courtly-family-test-123', 4),
      accountType: 'STUDENT',
      accountControl: 'SELF',
      accountStatus: 'ACTIVE',
      profileVisibility: 'PUBLIC',
      dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
      ...overrides,
    },
  });
  ownedUserIds.add(user.id);
  return user;
}

async function sessionFor(userId: string) {
  const token = randomBytes(32).toString('base64url');
  await prisma.authSession.create({
    data: {
      id: createHash('sha256').update(token).digest('hex'),
      userId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return `${config.sessionCookie}=${token}`;
}

const childInput = (overrides: Record<string, unknown> = {}) => ({
  legalName: 'River Morgan',
  displayName: 'River',
  username: `river_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  dateOfBirth: '2015-06-15',
  sports: ['Tennis', 'Badminton'],
  relationship: 'Parent',
  profileVisibility: 'CLUBS_ONLY',
  legalGuardianConfirmed: true,
  privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
  ...overrides,
});
const registrationInput = (email: string, overrides: Record<string, unknown> = {}) => ({
  accountType: 'STUDENT',
  name: 'Reserved Email Student',
  username: `reserved_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  email,
  password: 'Courtly-reserved-email-123',
  dateOfBirth: '1990-01-01',
  ...overrides,
});

function resultChild(body: any) { return body.child ?? body; }
function resultHandover(body: any) { return body.handover ?? body; }
const sensitiveChildProjectionKeys = [
  'legalName', 'username', 'dateOfBirth', 'sports', 'profileVisibility',
  'accountControl', 'accountStatus', 'ageBand', 'requiredAction', 'handover',
  'deletionRequestedAt',
] as const;

function expectRenewalOnlyProjection(value: Record<string, unknown>, childId: string) {
  expect(value).toMatchObject({
    id: childId,
    displayName: 'River',
    access: 'CONSENT_RENEWAL',
    link: expect.objectContaining({ status: expect.stringMatching(/^(ACTIVE|WITHDRAWN)$/u) }),
  });
  for (const key of sensitiveChildProjectionKeys) expect(value).not.toHaveProperty(key);
  expect(value.link).not.toHaveProperty('permissions');
}

async function createGuardian(overrides: Record<string, unknown> = {}) {
  const user = await createUser(overrides);
  return { user, cookie: await sessionFor(user.id) };
}

async function createChild(cookie: string, overrides: Record<string, unknown> = {}) {
  const response = await request(testApp).post('/api/family/children')
    .set('Cookie', cookie).send(childInput(overrides)).expect(201);
  const child = resultChild(response.body);
  ownedUserIds.add(child.id);
  return child;
}

async function linkGuardianToChild(
  guardianUserId: string,
  childUserId: string,
  options: { permissions?: string[]; currentConsent?: boolean } = {},
) {
  const permissions = options.permissions ?? [...DEFAULT_GUARDIAN_PERMISSIONS];
  return prisma.$transaction(async tx => {
    const link = await tx.guardianChildLink.create({
      data: { guardianUserId, childUserId, relationshipType: 'PARENT', permissions },
    });
    if (options.currentConsent !== false) {
      await tx.childConsentRecord.create({ data: {
        linkId: link.id, guardianUserId, childUserId, eventType: 'GRANTED',
        relationshipType: link.relationshipType,
        privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
        permissions: link.permissions,
      } });
    }
    return link;
  });
}

async function appendConsentDecision(
  link: { id: string; guardianUserId: string; childUserId: string; relationshipType: string; permissions: string[] },
  eventType: 'GRANTED' | 'RENEWED' | 'WITHDRAWN',
) {
  return prisma.childConsentRecord.create({ data: {
    linkId: link.id,
    guardianUserId: link.guardianUserId,
    childUserId: link.childUserId,
    eventType,
    relationshipType: link.relationshipType,
    privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
    permissions: link.permissions,
  } });
}

async function createPendingHandoverFixture(input: {
  childUserId: string; guardianUserId: string; destinationEmail?: string;
  initiatedAt?: Date; expiresAt?: Date;
}) {
  const handoverId = randomUUID();
  const token = deriveFamilyHandoverToken(handoverId, familyTestKeyId);
  const initiatedAt = input.initiatedAt ?? new Date();
  const expiresAt = input.expiresAt ?? new Date(initiatedAt.getTime() + 7 * 24 * 60 * 60_000);
  const handover = await prisma.childAccountHandover.create({ data: {
    id: handoverId,
    childUserId: input.childUserId,
    initiatedByGuardianUserId: input.guardianUserId,
    destinationEmail: input.destinationEmail ?? `${randomUUID()}@example.test`,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    status: 'PENDING',
    initiatedAt,
    lastSentAt: initiatedAt,
    expiresAt,
  } });
  return { handover, token };
}

async function cleanupFamilyRows() {
  const userIds = [...ownedUserIds];
  if (!userIds.length) return;
  await prisma.$transaction(async tx => {
    // Consent evidence is protected by an append-only trigger. Disable triggers
    // only for this transaction and only while removing this suite's own rows.
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const handoverIds = (await tx.childAccountHandover.findMany({
      where: { OR: [{ initiatedByGuardianUserId: { in: userIds } }, { childUserId: { in: userIds } }] },
      select: { id: true },
    })).map(handover => handover.id);
    if (handoverIds.length) {
      await tx.outboundDelivery.deleteMany({
        where: { OR: handoverIds.map(id => ({ dedupeKey: `family-handover:${id}:security-claim` })) },
      });
    }
    await tx.childConsentRecord.deleteMany({
      where: { OR: [{ guardianUserId: { in: userIds } }, { childUserId: { in: userIds } }] },
    });
    await tx.childAccountHandover.deleteMany({
      where: { OR: [{ initiatedByGuardianUserId: { in: userIds } }, { childUserId: { in: userIds } }] },
    });
    await tx.guardianChildLink.deleteMany({
      where: { OR: [{ guardianUserId: { in: userIds } }, { childUserId: { in: userIds } }] },
    });
    await tx.outboundDelivery.deleteMany({ where: { recipientUserId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
  });
  ownedUserIds.clear();
}

function tokenFromDelivery(delivery: { payload: unknown }) {
  const payload = delivery.payload as { handoverId?: string; tokenKeyId?: string };
  if (!payload.handoverId || !payload.tokenKeyId) {
    throw new Error('Family handover delivery did not contain derivation metadata');
  }
  return deriveFamilyHandoverToken(payload.handoverId, payload.tokenKeyId);
}

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => {
  config.email.enabled = originalEmailEnabled;
  config.familyHandoverTokens.enabled = originalHandoverTokenConfig.enabled;
  config.familyHandoverTokens.activeKeyId = originalHandoverTokenConfig.activeKeyId;
  config.familyHandoverTokens.keys = originalHandoverTokenConfig.keys;
  await prisma.$disconnect();
});

describe.sequential('family accounts', () => {
  beforeEach(() => {
    config.email.enabled = true;
    config.familyHandoverTokens.enabled = true;
    config.familyHandoverTokens.activeKeyId = familyTestKeyId;
    config.familyHandoverTokens.keys = new Map([[familyTestKeyId, familyTestKey]]);
  });
  afterEach(async () => {
    config.email.enabled = originalEmailEnabled;
    config.familyHandoverTokens.enabled = originalHandoverTokenConfig.enabled;
    config.familyHandoverTokens.activeKeyId = originalHandoverTokenConfig.activeKeyId;
    config.familyHandoverTokens.keys = originalHandoverTokenConfig.keys;
    await cleanupFamilyRows();
  });

  it('requires authentication and an eligible adult personal account', async () => {
    await request(testApp).get('/api/family').expect(401);

    const teen = await createGuardian({ dateOfBirth: new Date('2010-01-01T00:00:00.000Z') });
    const teenResponse = await request(testApp).get('/api/family').set('Cookie', teen.cookie).expect(200);
    expect(teenResponse.body.guardian.eligible).toBe(false);
    const denied = await request(testApp).post('/api/family/children').set('Cookie', teen.cookie)
      .send(childInput()).expect(403);
    expect(denied.body).toMatchObject({ code: 'FAMILY_MANAGEMENT_REQUIRED' });

    const guardian = await createGuardian();
    const family = await request(testApp).get('/api/family').set('Cookie', guardian.cookie).expect(200);
    expect(family.body).toMatchObject({
      guardian: { eligible: true, reason: null },
      children: [],
      privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      handoverAvailable: true,
    });
  });

  it('sets a missing DOB once, applies age policy, and strictly rejects malformed, future, or repeated values', async () => {
    const guardian = await createGuardian({ dateOfBirth: null });

    for (const dateOfBirth of ['1990-1-01', '1990-02-30', '1990-01-01T00:00:00Z', '2999-01-01']) {
      const response = await request(testApp).post('/api/family/date-of-birth')
        .set('Cookie', guardian.cookie).send({ dateOfBirth });
      expect(response.status).toBe(400);
    }
    await request(testApp).post('/api/family/date-of-birth')
      .set('Cookie', guardian.cookie).send({ dateOfBirth: '1990-01-01', unexpected: true }).expect(400);

    const set = await request(testApp).post('/api/family/date-of-birth')
      .set('Cookie', guardian.cookie).send({ dateOfBirth: '1990-01-01' }).expect(200);
    expect((set.body.user ?? set.body).dateOfBirth).toBe('1990-01-01');
    await request(testApp).post('/api/family/date-of-birth')
      .set('Cookie', guardian.cookie).send({ dateOfBirth: '1991-01-01' }).expect(409);

    const unreviewedChild = await createGuardian({ dateOfBirth: null });
    const childDob = await request(testApp).post('/api/family/date-of-birth')
      .set('Cookie', unreviewedChild.cookie).send({ dateOfBirth: '2015-06-15' }).expect(403);
    expect(childDob.body).toMatchObject({ code: 'PARENT_ACCOUNT_REQUIRED' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: unreviewedChild.user.id } }))
      .toMatchObject({ dateOfBirth: null });
  });

  it('creates a credential-free private child with immutable consent evidence and rejects invalid input', async () => {
    const guardian = await createGuardian();
    await request(testApp).post('/api/family/children').set('Cookie', guardian.cookie)
      .send(childInput({ dateOfBirth: '2015-02-30' })).expect(400);
    await request(testApp).post('/api/family/children').set('Cookie', guardian.cookie)
      .send(childInput({ dateOfBirth: '2000-01-01' })).expect(400);
    await request(testApp).post('/api/family/children').set('Cookie', guardian.cookie)
      .send(childInput({ profileVisibility: 'PUBLIC' })).expect(400);
    await request(testApp).post('/api/family/children').set('Cookie', guardian.cookie)
      .send(childInput({ legalGuardianConfirmed: false })).expect(400);
    const stalePolicy = await request(testApp).post('/api/family/children').set('Cookie', guardian.cookie)
      .send(childInput({ privacyPolicyVersion: 'stale-policy' })).expect(409);
    expect(stalePolicy.body).toMatchObject({ code: 'PRIVACY_POLICY_CHANGED' });
    await request(testApp).post('/api/family/children').set('Cookie', guardian.cookie)
      .send(childInput({ unexpected: true })).expect(400);

    const child = await createChild(guardian.cookie);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: child.id } });
    expect(stored).toMatchObject({
      name: 'River', legalName: 'River Morgan', email: null, passwordHash: null, phone: '',
      accountType: 'STUDENT', accountControl: 'GUARDIAN_MANAGED', accountStatus: 'ACTIVE',
      profileVisibility: 'CLUBS_ONLY',
    });
    const link = await prisma.guardianChildLink.findUniqueOrThrow({
      where: { guardianUserId_childUserId: { guardianUserId: guardian.user.id, childUserId: child.id } },
    });
    expect(link).toMatchObject({ relationshipType: 'PARENT', status: 'ACTIVE' });
    expect(await prisma.childConsentRecord.findMany({ where: { linkId: link.id } }))
      .toEqual([expect.objectContaining({ eventType: 'GRANTED', privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION })]);
  });

  it('rejects a duplicate username without leaving partial child, link, or consent rows', async () => {
    const guardian = await createGuardian();
    const username = `duplicate_${randomUUID().slice(0, 8)}`;
    await createChild(guardian.cookie, { username });

    const response = await request(testApp).post('/api/family/children').set('Cookie', guardian.cookie)
      .send(childInput({ username }));
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'USERNAME_TAKEN' });
    expect(await prisma.user.count({ where: { username } })).toBe(1);
    expect(await prisma.guardianChildLink.count({ where: { guardianUserId: guardian.user.id } })).toBe(1);
    expect(await prisma.childConsentRecord.count({ where: { guardianUserId: guardian.user.id } })).toBe(1);
  });

  it('edits only allowed child fields and keeps immutable identity fields unchanged', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: child.id } });

    const edited = await request(testApp).patch(`/api/family/children/${child.id}`)
      .set('Cookie', guardian.cookie).send({
        legalName: 'River A. Morgan', displayName: 'Riv', sports: ['Padel', 'padel', 'Tennis'],
        profileVisibility: 'PRIVATE',
      }).expect(200);
    expect(resultChild(edited.body)).toMatchObject({
      legalName: 'River A. Morgan', displayName: 'Riv', sports: ['Padel', 'Tennis'], profileVisibility: 'PRIVATE',
    });

    await request(testApp).patch(`/api/family/children/${child.id}`).set('Cookie', guardian.cookie)
      .send({ username: 'changed_username' }).expect(400);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: child.id } });
    expect(after.username).toBe(before.username);
    expect(after.dateOfBirth).toEqual(before.dateOfBirth);
    expect(after.accountControl).toBe('GUARDIAN_MANAGED');
  });

  it('allows partial profile edits but requires privacy authority for visibility changes', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie);
    const link = await prisma.guardianChildLink.findFirstOrThrow({
      where: { guardianUserId: guardian.user.id, childUserId: child.id },
    });
    await prisma.guardianChildLink.update({
      where: { id: link.id },
      data: { permissions: link.permissions.filter(permission => permission !== 'PRIVACY_MANAGE') },
    });

    const edited = await request(testApp).patch(`/api/family/children/${child.id}`)
      .set('Cookie', guardian.cookie).send({ displayName: 'Riv' }).expect(200);
    expect(resultChild(edited.body)).toMatchObject({
      displayName: 'Riv', profileVisibility: 'CLUBS_ONLY',
    });
    const denied = await request(testApp).patch(`/api/family/children/${child.id}`)
      .set('Cookie', guardian.cookie).send({ profileVisibility: 'PRIVATE' }).expect(403);
    expect(denied.body).toMatchObject({
      code: 'GUARDIAN_PERMISSION_REQUIRED', permission: 'PRIVACY_MANAGE',
    });
  });

  it('withdraws and renews consent append-only while revoking stale child sessions', async () => {
    const guardian = await createGuardian();
    const coGuardian = await createGuardian({ name: 'Second Guardian', legalName: 'Second Guardian' });
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const coGuardianLink = await linkGuardianToChild(coGuardian.user.id, child.id);
    await sessionFor(child.id);
    const createdHandover = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: `${randomUUID()}@example.test` }).expect(201);
    const handoverId = resultHandover(createdHandover.body).id;
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handoverId}:security-claim` },
    });

    const withdrawn = await request(testApp).post(`/api/family/children/${child.id}/consent/withdraw`)
      .set('Cookie', guardian.cookie).send({}).expect(200);
    expect(resultChild(withdrawn.body)).toMatchObject({
      id: child.id, access: 'CONSENT_RENEWAL',
      link: expect.objectContaining({ status: 'WITHDRAWN' }),
    });
    expect(await prisma.guardianChildLink.findUniqueOrThrow({ where: {
      guardianUserId_childUserId: { guardianUserId: guardian.user.id, childUserId: child.id },
    } }))
      .toMatchObject({ status: 'WITHDRAWN' });
    expect(await prisma.guardianChildLink.findUniqueOrThrow({ where: { id: coGuardianLink.id } }))
      .toMatchObject({ status: 'ACTIVE' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: child.id } }))
      .toMatchObject({ accountStatus: 'ACTIVE' });
    expect(await prisma.authSession.count({ where: { userId: child.id } })).toBe(0);
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handoverId } }))
      .toMatchObject({ status: 'CANCELLED' });
    expect(await prisma.outboundDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
      .toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'CONSENT_WITHDRAWN' });
    const withdrawnFamily = await request(testApp).get('/api/family')
      .set('Cookie', guardian.cookie).expect(200);
    const withdrawnProjection = withdrawnFamily.body.children.find(
      (candidate: { id?: string }) => candidate.id === child.id,
    );
    expectRenewalOnlyProjection(withdrawnProjection, child.id);
    expect(withdrawnProjection.link).toMatchObject({ status: 'WITHDRAWN' });
    await request(testApp).get(`/api/family/children/${child.id}/export`)
      .set('Cookie', guardian.cookie).expect(404);
    await request(testApp).get(`/api/family/children/${child.id}/export`)
      .set('Cookie', coGuardian.cookie).expect(200);

    const renewed = await request(testApp).post(`/api/family/children/${child.id}/consent/renew`)
      .set('Cookie', guardian.cookie).send({
        legalGuardianConfirmed: true, privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      }).expect(200);
    expect(resultChild(renewed.body)).toMatchObject({ accountStatus: 'ACTIVE' });
    expect(await prisma.guardianChildLink.findFirstOrThrow({ where: { childUserId: child.id } }))
      .toMatchObject({ status: 'ACTIVE' });
    const eventTypes = (await prisma.childConsentRecord.findMany({
      where: { linkId: resultChild(renewed.body).link.id }, select: { eventType: true },
    })).map(event => event.eventType);
    expect(eventTypes).toEqual(expect.arrayContaining([
      'GRANTED', 'HANDOVER_STARTED', 'WITHDRAWN', 'HANDOVER_CANCELLED', 'RENEWED',
    ]));
  });

  it('orders concurrent consent decisions by the database sequence, not transaction time', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie);
    const link = await prisma.guardianChildLink.findFirstOrThrow({
      where: { guardianUserId: guardian.user.id, childUserId: child.id },
    });
    const olderTransaction = new PrismaClient();
    let releaseOlder!: () => void;
    const olderMayProceed = new Promise<void>(resolve => { releaseOlder = resolve; });
    let olderStarted!: () => void;
    const olderDidStart = new Promise<void>(resolve => { olderStarted = resolve; });

    try {
      const laterCommit = olderTransaction.$transaction(async tx => {
        // Establish an earlier transaction timestamp, then wait. With the old
        // createdAt ordering this later decision incorrectly appeared older.
        const [started] = await tx.$queryRaw<Array<{ startedAt: Date }>>`
          SELECT CURRENT_TIMESTAMP AS "startedAt"
        `;
        olderStarted();
        await olderMayProceed;
        const decision = await tx.childConsentRecord.create({ data: {
          linkId: link.id, guardianUserId: link.guardianUserId, childUserId: link.childUserId,
          eventType: 'WITHDRAWN', relationshipType: link.relationshipType,
          privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION, permissions: link.permissions,
        } });
        await tx.guardianChildLink.update({
          where: { id: link.id }, data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
        });
        await tx.user.update({
          where: { id: child.id }, data: { accountStatus: 'CONSENT_REQUIRED' },
        });
        return { decision, startedAt: started!.startedAt };
      }, { timeout: 15_000 });
      await olderDidStart;
      const earlierCommit = await prisma.childConsentRecord.create({ data: {
        linkId: link.id, guardianUserId: link.guardianUserId, childUserId: link.childUserId,
        eventType: 'RENEWED', relationshipType: link.relationshipType,
        privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION, permissions: link.permissions,
      } });
      releaseOlder();
      const latest = await laterCommit;

      expect(latest.startedAt.getTime()).toBeLessThan(earlierCommit.createdAt.getTime());
      expect(latest.decision.sequence).toBe(earlierCommit.sequence + 1);
      const decisions = await prisma.childConsentRecord.findMany({
        where: { linkId: link.id, eventType: { in: ['GRANTED', 'RENEWED', 'WITHDRAWN'] } },
        orderBy: { sequence: 'asc' },
        select: { eventType: true, sequence: true },
      });
      expect(decisions.map(record => record.eventType)).toEqual(['GRANTED', 'RENEWED', 'WITHDRAWN']);

      const family = await request(testApp).get('/api/family')
        .set('Cookie', guardian.cookie).expect(200);
      expect(family.body.children[0].consent).toMatchObject({ status: 'WITHDRAWN' });
      expect(family.body.children[0].access).toBe('CONSENT_RENEWAL');
    } finally {
      releaseOlder?.();
      await olderTransaction.$disconnect();
    }
  });

  it('does not let consent-only withdrawal cancel or disclose another guardian handover', async () => {
    const initiatingGuardian = await createGuardian();
    const withdrawingGuardian = await createGuardian({
      name: 'Consent Guardian', legalName: 'Consent Guardian',
    });
    const child = await createChild(initiatingGuardian.cookie, { dateOfBirth: '2010-06-15' });
    const withdrawingLink = await linkGuardianToChild(withdrawingGuardian.user.id, child.id, {
      permissions: ['CONSENT_MANAGE'],
    });
    const destinationEmail = `${randomUUID()}@example.test`;
    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', initiatingGuardian.cookie).send({ destinationEmail }).expect(201);
    const handoverId = resultHandover(created.body).id;
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handoverId}:security-claim` },
    });

    const withdrawn = await request(testApp)
      .post(`/api/family/children/${child.id}/consent/withdraw`)
      .set('Cookie', withdrawingGuardian.cookie).send({}).expect(200);

    expectRenewalOnlyProjection(resultChild(withdrawn.body), child.id);
    expect(JSON.stringify(withdrawn.body)).not.toContain(destinationEmail);
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handoverId } }))
      .toMatchObject({
        status: 'PENDING',
        initiatedByGuardianUserId: initiatingGuardian.user.id,
        cancelledAt: null,
      });
    expect(await prisma.outboundDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
      .toMatchObject({ status: 'QUEUED', lastErrorCode: null });
    expect(await prisma.childConsentRecord.count({
      where: { linkId: withdrawingLink.id, eventType: 'HANDOVER_CANCELLED' },
    })).toBe(0);
  });

  it('lets an authorized co-guardian withdrawal cancel another guardian handover', async () => {
    const initiatingGuardian = await createGuardian();
    const withdrawingGuardian = await createGuardian({
      name: 'Authorized Guardian', legalName: 'Authorized Guardian',
    });
    const child = await createChild(initiatingGuardian.cookie, { dateOfBirth: '2010-06-15' });
    const withdrawingLink = await linkGuardianToChild(withdrawingGuardian.user.id, child.id);
    const destinationEmail = `${randomUUID()}@example.test`;
    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', initiatingGuardian.cookie).send({ destinationEmail }).expect(201);
    const handoverId = resultHandover(created.body).id;
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handoverId}:security-claim` },
    });

    const withdrawn = await request(testApp)
      .post(`/api/family/children/${child.id}/consent/withdraw`)
      .set('Cookie', withdrawingGuardian.cookie).send({}).expect(200);

    expectRenewalOnlyProjection(resultChild(withdrawn.body), child.id);
    expect(JSON.stringify(withdrawn.body)).not.toContain(destinationEmail);
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handoverId } }))
      .toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(Date) });
    expect(await prisma.outboundDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
      .toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'CONSENT_WITHDRAWN' });
    expect(await prisma.childConsentRecord.findFirst({
      where: { linkId: withdrawingLink.id, eventType: 'HANDOVER_CANCELLED' },
    })).toMatchObject({
      guardianUserId: withdrawingGuardian.user.id,
      childUserId: child.id,
      metadata: { handoverId, reason: 'CONSENT_WITHDRAWN' },
    });
  });

  it('filters the Family list by exact link permission and keeps consent-only renewal responses minimal', async () => {
    const guardian = await createGuardian();
    const sourceGuardian = await createGuardian();
    const fullChild = await createChild(guardian.cookie, {
      legalName: 'Full Child', displayName: 'Full Child',
    });
    const noProfileChild = await createChild(sourceGuardian.cookie, {
      legalName: 'No Profile Child', displayName: 'No Profile Child',
    });
    const noRenewalChild = await createChild(sourceGuardian.cookie, {
      legalName: 'No Renewal Child', displayName: 'No Renewal Child',
    });
    const endedChild = await createChild(sourceGuardian.cookie, {
      legalName: 'Ended Child', displayName: 'Ended Child',
    });
    const consentOnlyChild = await createChild(sourceGuardian.cookie, {
      legalName: 'Consent Only Child', displayName: 'River',
    });

    await linkGuardianToChild(guardian.user.id, noProfileChild.id, {
      permissions: ['CONSENT_MANAGE'],
    });
    const noRenewalLink = await linkGuardianToChild(guardian.user.id, noRenewalChild.id, {
      permissions: ['PROFILE_MANAGE'],
    });
    await prisma.guardianChildLink.update({
      where: { id: noRenewalLink.id },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });
    const endedLink = await linkGuardianToChild(guardian.user.id, endedChild.id);
    await prisma.guardianChildLink.update({
      where: { id: endedLink.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    const consentOnlyLink = await linkGuardianToChild(guardian.user.id, consentOnlyChild.id, {
      permissions: ['CONSENT_MANAGE'],
    });
    await appendConsentDecision(consentOnlyLink, 'WITHDRAWN');
    await prisma.guardianChildLink.update({
      where: { id: consentOnlyLink.id },
      data: { status: 'WITHDRAWN', withdrawnAt: new Date() },
    });

    const family = await request(testApp).get('/api/family').set('Cookie', guardian.cookie).expect(200);
    expect(family.body.children).toHaveLength(2);
    expect(family.body.children.map((child: { id: string }) => child.id)).toEqual(
      expect.arrayContaining([fullChild.id, consentOnlyChild.id]),
    );
    const fullProjection = family.body.children.find(
      (candidate: { id?: string }) => candidate.id === fullChild.id,
    );
    const consentOnlyProjection = family.body.children.find(
      (candidate: { id?: string }) => candidate.id === consentOnlyChild.id,
    );
    expect(fullProjection).toMatchObject({ id: fullChild.id, legalName: 'Full Child' });
    expectRenewalOnlyProjection(consentOnlyProjection, consentOnlyChild.id);
    expect(consentOnlyProjection.link).toMatchObject({ status: 'WITHDRAWN' });

    const renewed = await request(testApp)
      .post(`/api/family/children/${consentOnlyChild.id}/consent/renew`)
      .set('Cookie', guardian.cookie)
      .send({ legalGuardianConfirmed: true, privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION })
      .expect(200);
    expectRenewalOnlyProjection(resultChild(renewed.body), consentOnlyChild.id);
    expect(resultChild(renewed.body).link).toMatchObject({ status: 'ACTIVE' });
    const relisted = await request(testApp).get('/api/family').set('Cookie', guardian.cookie).expect(200);
    expect(relisted.body.children.map((child: { id: string }) => child.id)).toEqual([fullChild.id]);
  });

  it.each([
    ['profile editing', 'PROFILE_MANAGE', 'patch', (childId: string) => `/api/family/children/${childId}`, { displayName: 'Denied' }],
    ['consent withdrawal', 'CONSENT_MANAGE', 'post', (childId: string) => `/api/family/children/${childId}/consent/withdraw`, {}],
    ['consent renewal', 'CONSENT_MANAGE', 'post', (childId: string) => `/api/family/children/${childId}/consent/renew`, { legalGuardianConfirmed: true, privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION }],
    ['deletion', 'DELETION_REQUEST', 'post', (childId: string) => `/api/family/children/${childId}/deletion-request`, {}],
    ['handover creation', 'HANDOVER_MANAGE', 'post', (childId: string) => `/api/family/children/${childId}/handovers`, { destinationEmail: 'denied-handover@example.test' }],
    ['data export', 'DATA_EXPORT', 'get', (childId: string) => `/api/family/children/${childId}/export`, undefined],
  ] as const)('requires the exact guardian permission for %s', async (
    _case, missingPermission, method, pathFor, body,
  ) => {
    const sourceGuardian = await createGuardian();
    const guardian = await createGuardian();
    const child = await createChild(sourceGuardian.cookie, { dateOfBirth: '2010-06-15' });
    await linkGuardianToChild(guardian.user.id, child.id, {
      permissions: DEFAULT_GUARDIAN_PERMISSIONS.filter(permission => permission !== missingPermission),
    });

    let call = request(testApp)[method](pathFor(child.id)).set('Cookie', guardian.cookie);
    if (body !== undefined) call = call.send(body);
    const denied = await call.expect(404);
    expect(denied.body).toMatchObject({ code: 'CHILD_NOT_FOUND' });
  });

  it('exports only the authorized child data as a JSON attachment without credentials or token digests', async () => {
    const guardian = await createGuardian();
    const stranger = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const coGuardian = await createGuardian({ name: 'Private Co Guardian', legalName: 'Private Co Guardian' });
    await linkGuardianToChild(coGuardian.user.id, child.id);
    const destinationEmail = `${randomUUID()}@example.test`;
    await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail }).expect(201);

    await request(testApp).get(`/api/family/children/${child.id}/export`)
      .set('Cookie', stranger.cookie).expect(404);
    const response = await request(testApp).get(`/api/family/children/${child.id}/export`)
      .set('Cookie', guardian.cookie).expect(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-disposition']).toMatch(/attachment;.*filename=/iu);
    const serialized = typeof response.text === 'string' && response.text ? response.text : JSON.stringify(response.body);
    const exported = JSON.parse(serialized.replace(/^\uFEFF/u, ''));
    expect(JSON.stringify(exported)).toContain(child.id);
    expect(JSON.stringify(exported)).not.toMatch(/passwordHash|tokenHash|session|claimUrl/iu);
    expect(JSON.stringify(exported)).not.toContain(coGuardian.user.username);
    expect(JSON.stringify(exported)).not.toContain(destinationEmail);
    expect(exported.handoverHistory).toContainEqual(expect.objectContaining({
      maskedDestinationEmail: `${destinationEmail[0]}********@example.test`,
    }));
  });

  it('marks a child for deletion, records evidence, revokes sessions, and prevents further edits', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    await sessionFor(child.id);
    const createdHandover = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: `${randomUUID()}@example.test` }).expect(201);
    const handoverId = resultHandover(createdHandover.body).id;
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handoverId}:security-claim` },
    });

    const deleted = await request(testApp).post(`/api/family/children/${child.id}/deletion-request`)
      .set('Cookie', guardian.cookie).send({}).expect(200);
    expect(resultChild(deleted.body)).toMatchObject({
      accountStatus: 'DELETION_REQUESTED', profileVisibility: 'PRIVATE',
    });
    expect(await prisma.authSession.count({ where: { userId: child.id } })).toBe(0);
    expect(await prisma.childConsentRecord.count({
      where: { childUserId: child.id, eventType: 'DELETION_REQUESTED' },
    })).toBe(1);
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handoverId } }))
      .toMatchObject({ status: 'CANCELLED' });
    expect(await prisma.outboundDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
      .toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'DELETION_REQUESTED' });
    await request(testApp).patch(`/api/family/children/${child.id}`).set('Cookie', guardian.cookie)
      .send({
        legalName: 'Must Not Change', displayName: 'River', sports: ['Tennis'], profileVisibility: 'PRIVATE',
      }).expect(409);
  });

  it('creates and cancels an email-backed handover without exposing the raw token in API or database fields', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const destinationEmail = `${randomUUID()}@example.test`;

    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: destinationEmail.toUpperCase() }).expect(201);
    const handover = resultHandover(created.body);
    expect(created.body).toMatchObject({ emailQueued: true });
    expect(handover).toMatchObject({ status: 'PENDING', emailQueued: true });
    expect(new Date(handover.expiresAt).getTime() - new Date(handover.createdAt).getTime())
      .toBe(7 * 24 * 60 * 60_000);
    expect(JSON.stringify(created.body)).not.toMatch(/token|claimUrl/iu);

    const stored = await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handover.id } });
    expect(stored.destinationEmail).toBe(destinationEmail);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handover.id}:security-claim` },
    });
    expect(delivery).toMatchObject({ eventType: 'FAMILY_HANDOVER_SECURITY', status: 'QUEUED' });
    const token = tokenFromDelivery(delivery);
    expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(delivery.payload)).not.toContain(token);
    expect(JSON.stringify(delivery.payload)).not.toContain('claimUrl');
    expect(JSON.stringify(delivery.payload)).not.toContain('actionUrl');

    await request(testApp).delete(`/api/family/children/${child.id}/handovers/${handover.id}`)
      .set('Cookie', guardian.cookie).send({}).expect(200, { ok: true });
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handover.id } }))
      .toMatchObject({ status: 'CANCELLED' });
    expect(await prisma.outboundDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
      .toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'HANDOVER_CANCELLED' });
    const cancelledLookup = await request(testApp).get(`/api/family/handovers/${token}`).expect(409);
    expect(cancelledLookup.body).toMatchObject({ code: 'HANDOVER_CANCELLED' });
    const cancelledCompletion = await request(testApp).post(`/api/family/handovers/${token}/complete`)
      .send({ password: 'Courtly-child-password-123' }).expect(409);
    expect(cancelledCompletion.body).toMatchObject({ code: 'HANDOVER_CANCELLED' });
  });

  it.each([
    ['authorized co-guardian', 'ACTIVE', true, 200],
    ['initiator without handover permission', 'ACTIVE', false, 404],
    ['withdrawn initiator', 'WITHDRAWN', true, 404],
    ['ended initiator', 'ENDED', true, 404],
  ] as const)('enforces cancellation authority for %s', async (
    _case, linkStatus, retainPermission, expectedStatus,
  ) => {
    const initiator = await createGuardian();
    const coGuardian = await createGuardian();
    const child = await createChild(initiator.cookie, { dateOfBirth: '2010-06-15' });
    await linkGuardianToChild(coGuardian.user.id, child.id);
    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', initiator.cookie).send({ destinationEmail: `${randomUUID()}@example.test` }).expect(201);
    const handover = resultHandover(created.body);

    const actor = _case === 'authorized co-guardian' ? coGuardian : initiator;
    if (_case !== 'authorized co-guardian') {
      const link = await prisma.guardianChildLink.findUniqueOrThrow({ where: {
        guardianUserId_childUserId: { guardianUserId: initiator.user.id, childUserId: child.id },
      } });
      await prisma.$transaction(async tx => {
        // Simulate a stale/corrupt pending row left by an older deployment.
        // The current graph invariant prevents loss of initiating authority
        // through normal writes, while the route must still fail closed.
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.guardianChildLink.update({
          where: { id: link.id },
          data: {
            permissions: retainPermission
              ? link.permissions
              : link.permissions.filter(permission => permission !== 'HANDOVER_MANAGE'),
            status: linkStatus,
            ...(linkStatus === 'WITHDRAWN' ? { withdrawnAt: new Date() } : {}),
            ...(linkStatus === 'ENDED' ? { endedAt: new Date() } : {}),
          },
        });
      });
    }

    const response = await request(testApp)
      .delete(`/api/family/children/${child.id}/handovers/${handover.id}`)
      .set('Cookie', actor.cookie).send({}).expect(expectedStatus);
    if (expectedStatus === 200) {
      expect(response.body).toEqual({ ok: true });
      expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handover.id } }))
        .toMatchObject({ status: 'CANCELLED' });
    } else {
      expect(response.body).toMatchObject({ code: 'HANDOVER_NOT_FOUND' });
      expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handover.id } }))
        .toMatchObject({ status: 'PENDING' });
    }
  });

  it('refuses to create a handover when transactional email is unavailable', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    config.email.enabled = false;

    const unavailable = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: `${randomUUID()}@example.test` })
      .expect(503);
    expect(unavailable.body).toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
    expect(await prisma.childAccountHandover.count({ where: { childUserId: child.id } })).toBe(0);
  });

  it('rolls back a handover when its mandatory security email is suppressed', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const unavailable = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: 'claim@example.invalid' })
      .expect(503);
    expect(unavailable.body).toMatchObject({ code: 'FEATURE_UNAVAILABLE' });
    expect(await prisma.childAccountHandover.count({ where: { childUserId: child.id } })).toBe(0);
    expect(await prisma.outboundDelivery.count({ where: { recipientKey: 'claim@example.invalid' } })).toBe(0);
    expect(await prisma.childConsentRecord.count({
      where: { childUserId: child.id, eventType: 'HANDOVER_STARTED' },
    })).toBe(0);
  });

  it('requires the initiating guardian link itself to have current consent', async () => {
    const guardian = await createGuardian();
    const coGuardian = await createGuardian({ name: 'Consenting Guardian', legalName: 'Consenting Guardian' });
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    await linkGuardianToChild(coGuardian.user.id, child.id);
    const link = await prisma.guardianChildLink.findFirstOrThrow({
      where: { guardianUserId: guardian.user.id, childUserId: child.id },
    });
    await appendConsentDecision(link, 'WITHDRAWN');

    const denied = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: `${randomUUID()}@example.test` })
      .expect(409);
    expect(denied.body).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: child.id } }))
      .toMatchObject({ accountStatus: 'ACTIVE' });
    expect(await prisma.childAccountHandover.count({ where: { childUserId: child.id } })).toBe(0);
  });

  it('requires an active child account before creating a handover', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    await prisma.user.update({ where: { id: child.id }, data: { accountStatus: 'CONSENT_REQUIRED' } });

    const denied = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: `${randomUUID()}@example.test` })
      .expect(409);
    expect(denied.body).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(await prisma.childAccountHandover.count({ where: { childUserId: child.id } })).toBe(0);
  });

  it('reserves a pending destination email across children under concurrent creation', async () => {
    const firstGuardian = await createGuardian();
    const secondGuardian = await createGuardian();
    const firstChild = await createChild(firstGuardian.cookie, { dateOfBirth: '2010-06-15' });
    const secondChild = await createChild(secondGuardian.cookie, { dateOfBirth: '2010-06-15' });
    const destinationEmail = `${randomUUID()}@example.test`;

    const responses = await Promise.all([
      request(testApp).post(`/api/family/children/${firstChild.id}/handovers`)
        .set('Cookie', firstGuardian.cookie).send({ destinationEmail }),
      request(testApp).post(`/api/family/children/${secondChild.id}/handovers`)
        .set('Cookie', secondGuardian.cookie).send({ destinationEmail: destinationEmail.toUpperCase() }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(responses.find(response => response.status === 409)?.body)
      .toMatchObject({ code: 'EMAIL_CONFLICT' });
    expect(await prisma.childAccountHandover.count({
      where: { destinationEmail, status: 'PENDING' },
    })).toBe(1);
  });

  it('releases an expired destination reservation before creating a handover for another child', async () => {
    const firstGuardian = await createGuardian();
    const secondGuardian = await createGuardian();
    const firstChild = await createChild(firstGuardian.cookie, { dateOfBirth: '2010-06-15' });
    const secondChild = await createChild(secondGuardian.cookie, { dateOfBirth: '2010-06-15' });
    const destinationEmail = `${randomUUID()}@example.test`;
    const initiatedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const { handover: stale } = await createPendingHandoverFixture({
      childUserId: firstChild.id, guardianUserId: firstGuardian.user.id, destinationEmail, initiatedAt,
      expiresAt: new Date(initiatedAt.getTime() + 7 * 24 * 60 * 60_000),
    });

    const created = await request(testApp).post(`/api/family/children/${secondChild.id}/handovers`)
      .set('Cookie', secondGuardian.cookie).send({ destinationEmail }).expect(201);
    expect(resultHandover(created.body)).toMatchObject({ status: 'PENDING' });
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: stale.id } }))
      .toMatchObject({ status: 'EXPIRED' });
  });

  it('reserves a live handover destination against registration and releases it after expiry', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const destinationEmail = `${randomUUID()}@example.test`;
    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail }).expect(201);
    const handoverId = resultHandover(created.body).id;
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handoverId}:security-claim` },
    });

    const reserved = await request(testApp).post('/api/auth/register')
      .send(registrationInput(destinationEmail.toUpperCase())).expect(409);
    expect(reserved.body).toEqual({
      error: 'This record already exists. Please use a different email or username.',
    });
    expect(await prisma.user.findUnique({ where: { email: destinationEmail } })).toBeNull();
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handoverId } }))
      .toMatchObject({ status: 'PENDING' });

    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      const initiatedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
      await tx.childAccountHandover.update({
        where: { id: handoverId },
        data: {
          initiatedAt, lastSentAt: initiatedAt,
          expiresAt: new Date(initiatedAt.getTime() + 7 * 24 * 60 * 60_000),
        },
      });
    });
    const released = await request(testApp).post('/api/auth/register')
      .send(registrationInput(destinationEmail.toUpperCase())).expect(201);
    ownedUserIds.add(released.body.user.id);
    expect(released.body.user.email).toBe(destinationEmail);
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handoverId } }))
      .toMatchObject({ status: 'EXPIRED' });
    expect(await prisma.outboundDelivery.findUniqueOrThrow({ where: { id: delivery.id } }))
      .toMatchObject({ status: 'SUPPRESSED', lastErrorCode: 'HANDOVER_EXPIRED' });
  });

  it('serializes registration and handover creation for the same normalized email', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const destinationEmail = `${randomUUID()}@example.test`;

    const [registration, handover] = await Promise.all([
      request(testApp).post('/api/auth/register').send(registrationInput(destinationEmail.toUpperCase())),
      request(testApp).post(`/api/family/children/${child.id}/handovers`)
        .set('Cookie', guardian.cookie).send({ destinationEmail }),
    ]);
    expect([registration.status, handover.status].sort()).toEqual([201, 409]);
    const winnerCount = Number(await prisma.user.findUnique({ where: { email: destinationEmail } }) !== null)
      + await prisma.childAccountHandover.count({
        where: { destinationEmail, status: 'PENDING' },
      });
    expect(winnerCount).toBe(1);
    if (registration.status === 201) {
      ownedUserIds.add(registration.body.user.id);
      expect(handover.body).toMatchObject({ code: 'EMAIL_CONFLICT' });
    } else {
      expect(registration.body).toEqual({
        error: 'This record already exists. Please use a different email or username.',
      });
      expect(resultHandover(handover.body)).toMatchObject({ status: 'PENDING' });
    }
  });

  it('supports public lookup and one-time completion, then rejects replay', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    await sessionFor(child.id);
    const destinationEmail = `${randomUUID()}@example.test`;
    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail }).expect(201);
    const handover = resultHandover(created.body);
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handover.id}:security-claim` },
    });
    const token = tokenFromDelivery(delivery);

    const preview = await request(testApp).get(`/api/family/handovers/${token}`).expect(200);
    expect(preview.body).toMatchObject({ childName: 'River', status: 'PENDING' });
    expect(JSON.stringify(preview.body)).not.toContain(token);

    const completed = await request(testApp).post(`/api/family/handovers/${token}/complete`)
      .send({ password: 'Courtly-child-password-123' }).expect(200);
    expect(completed.body).toMatchObject({ ok: true });
    const account = await prisma.user.findUniqueOrThrow({ where: { id: child.id } });
    expect(account).toMatchObject({
      email: destinationEmail, accountControl: 'SELF', accountStatus: 'ACTIVE', profileVisibility: 'CLUBS_ONLY',
    });
    expect(account.emailVerifiedAt).not.toBeNull();
    expect(await bcrypt.compare('Courtly-child-password-123', account.passwordHash!)).toBe(true);
    expect(await prisma.authSession.count({ where: { userId: child.id } })).toBe(0);
    expect(await prisma.guardianChildLink.count({ where: { childUserId: child.id, status: 'ACTIVE' } })).toBe(0);
    const initiatingLink = await prisma.guardianChildLink.findFirstOrThrow({
      where: { guardianUserId: guardian.user.id, childUserId: child.id },
    });
    expect(await prisma.childConsentRecord.count({
      where: { linkId: initiatingLink.id, eventType: 'HANDOVER_COMPLETED' },
    })).toBe(1);
    const replay = await request(testApp).post(`/api/family/handovers/${token}/complete`)
      .send({ password: 'Courtly-child-password-456' })
      .expect(409);
    expect(replay.body).toMatchObject({ code: 'HANDOVER_ALREADY_USED' });
    const completedPreview = await request(testApp).get(`/api/family/handovers/${token}`).expect(409);
    expect(completedPreview.body).toMatchObject({ code: 'HANDOVER_ALREADY_USED' });
  });

  it('rejects completion after the initiating link loses current consent', async () => {
    const guardian = await createGuardian();
    const coGuardian = await createGuardian({ name: 'Current Guardian', legalName: 'Current Guardian' });
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    await linkGuardianToChild(coGuardian.user.id, child.id);
    const initiatingLink = await prisma.guardianChildLink.findFirstOrThrow({
      where: { guardianUserId: guardian.user.id, childUserId: child.id },
    });
    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: `${randomUUID()}@example.test` }).expect(201);
    const handover = resultHandover(created.body);
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handover.id}:security-claim` },
    });
    await appendConsentDecision(initiatingLink, 'WITHDRAWN');

    const denied = await request(testApp).post(`/api/family/handovers/${tokenFromDelivery(delivery)}/complete`)
      .send({ password: 'Courtly-child-password-123' }).expect(409);
    expect(denied.body).toMatchObject({ code: 'HANDOVER_UNAVAILABLE' });
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handover.id } }))
      .toMatchObject({ status: 'PENDING' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: child.id } }))
      .toMatchObject({ accountControl: 'GUARDIAN_MANAGED', accountStatus: 'ACTIVE', email: null });
  });

  it('rejects expired handovers and destination-email collisions without transferring the child', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const occupied = await createUser();

    const collision = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: occupied.email })
      .expect(409);
    expect(collision.body).toMatchObject({ code: 'EMAIL_CONFLICT' });

    const destinationEmail = `${randomUUID()}@example.test`;
    const initiatedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const { handover, token } = await createPendingHandoverFixture({
      childUserId: child.id, guardianUserId: guardian.user.id, destinationEmail, initiatedAt,
      expiresAt: new Date(initiatedAt.getTime() + 7 * 24 * 60 * 60_000),
    });

    const expired = await request(testApp).post(`/api/family/handovers/${token}/complete`)
      .send({ password: 'Courtly-child-password-123' })
      .expect(410);
    expect(expired.body).toMatchObject({ code: 'HANDOVER_EXPIRED' });
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handover.id } }))
      .toMatchObject({ status: 'EXPIRED' });
    const expiredPreview = await request(testApp).get(`/api/family/handovers/${token}`).expect(410);
    expect(expiredPreview.body).toMatchObject({ code: 'HANDOVER_EXPIRED' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
      email: null, passwordHash: null, accountControl: 'GUARDIAN_MANAGED',
    });
  });

  it('does not disclose malformed or unknown public handover tokens', async () => {
    const malformed = await request(testApp).get('/api/family/handovers/not-valid!').expect(404);
    const unknown = await request(testApp)
      .get(`/api/family/handovers/${randomBytes(32).toString('base64url')}`).expect(404);
    expect(malformed.body).toMatchObject({ code: 'HANDOVER_NOT_FOUND' });
    expect(unknown.body).toMatchObject({ code: 'HANDOVER_NOT_FOUND' });
    const malformedCompletion = await request(testApp)
      .post('/api/family/handovers/not-valid!/complete')
      .send({ password: 'Courtly-child-password-123' }).expect(404);
    expect(malformedCompletion.body).toMatchObject({ code: 'HANDOVER_NOT_FOUND' });
  });

  it('detects a destination-email collision at completion without consuming the handover', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const destinationEmail = `${randomUUID()}@example.test`;
    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail }).expect(201);
    const handover = resultHandover(created.body);
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handover.id}:security-claim` },
    });
    const token = tokenFromDelivery(delivery);
    await createUser({ email: destinationEmail });

    const collision = await request(testApp).post(`/api/family/handovers/${token}/complete`)
      .send({ password: 'Courtly-child-password-123' })
      .expect(409);
    expect(collision.body).toMatchObject({ code: 'EMAIL_CONFLICT' });
    expect(await prisma.childAccountHandover.findUniqueOrThrow({ where: { id: handover.id } }))
      .toMatchObject({ status: 'PENDING' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: child.id } })).toMatchObject({
      email: null, passwordHash: null, accountControl: 'GUARDIAN_MANAGED',
    });
  });

  it('serializes concurrent handover completion so exactly one request owns the account', async () => {
    const guardian = await createGuardian();
    const child = await createChild(guardian.cookie, { dateOfBirth: '2010-06-15' });
    const created = await request(testApp).post(`/api/family/children/${child.id}/handovers`)
      .set('Cookie', guardian.cookie).send({ destinationEmail: `${randomUUID()}@example.test` }).expect(201);
    const handover = resultHandover(created.body);
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `family-handover:${handover.id}:security-claim` },
    });
    const token = tokenFromDelivery(delivery);

    const responses = await Promise.all([
      request(testApp).post(`/api/family/handovers/${token}/complete`).send({ password: 'Courtly-child-password-123' }),
      request(testApp).post(`/api/family/handovers/${token}/complete`).send({ password: 'Courtly-child-password-456' }),
    ]);
    if (responses.some(response => response.status === 500)) {
      // Preserve the server error text in the assertion output when the
      // concurrency contract regresses.
      throw new Error(JSON.stringify(responses.map(response => ({
        status: response.status, body: response.body,
      }))));
    }
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await prisma.childAccountHandover.count({ where: { id: handover.id, status: 'COMPLETED' } })).toBe(1);
    expect(await prisma.childConsentRecord.count({
      where: { childUserId: child.id, eventType: 'HANDOVER_COMPLETED' },
    })).toBe(1);
    const account = await prisma.user.findUniqueOrThrow({ where: { id: child.id } });
    const passwords = await Promise.all([
      bcrypt.compare('Courtly-child-password-123', account.passwordHash!),
      bcrypt.compare('Courtly-child-password-456', account.passwordHash!),
    ]);
    expect(passwords.filter(Boolean)).toHaveLength(1);
  });
});
