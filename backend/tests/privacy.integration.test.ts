import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { activeEmailVerificationToken, deriveEmailVerificationToken } from '../src/email-verification-token.js';
import { CURRENT_LEGAL_POLICY_SET_HASH, CURRENT_PRIVACY_NOTICE_VERSION, CURRENT_TERMS_VERSION } from '../src/legal-policy.js';
import { prisma, verifyTestDatabase } from './fixtures.js';
import { currentSignupAcceptance } from './helpers/legal.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

const ownedUserIds = new Set<string>();
const originalEmailEnabled = config.email.enabled;
const originalAdminPassword = config.adminPassword;
const originalAdminOperators = config.adminOperators;

async function sessionFor(userId: string) {
  const token = randomBytes(32).toString('base64url');
  await prisma.authSession.create({ data: {
    id: createHash('sha256').update(token).digest('hex'), userId,
    recentAuthAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
  } });
  return `${config.sessionCookie}=${token}`;
}

async function verifiedAccount() {
  const suffix = randomUUID().replaceAll('-', '');
  const user = await prisma.user.create({ data: {
    name: 'Privacy Subject', legalName: 'Privacy Subject', username: `privacy_${suffix.slice(0, 18)}`,
    email: `${suffix}@example.test`, emailVerifiedAt: new Date(), passwordHash: await bcrypt.hash('privacy-test-password', 4),
    accountType: 'STUDENT', accountControl: 'SELF', accountStatus: 'ACTIVE',
    profileVisibility: 'PRIVATE', dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
    termsAcceptedVersion: CURRENT_TERMS_VERSION, termsAcceptedAt: new Date(),
    privacyNoticeAcceptedVersion: CURRENT_PRIVACY_NOTICE_VERSION, privacyNoticeAcceptedAt: new Date(),
    signupPolicySetHash: CURRENT_LEGAL_POLICY_SET_HASH,
  } });
  ownedUserIds.add(user.id);
  return { user, cookie: await sessionFor(user.id) };
}

afterEach(async () => {
  config.email.enabled = originalEmailEnabled;
  config.adminPassword = originalAdminPassword;
  config.adminOperators = originalAdminOperators;
  if (ownedUserIds.size) {
    const ids = [...ownedUserIds];
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      await tx.privacyRequestEvent.deleteMany({ where: { request: { subjectUserId: { in: ids } } } });
      await tx.privacyRequest.deleteMany({ where: { subjectUserId: { in: ids } } });
      await tx.outboundDelivery.deleteMany({ where: { recipientUserId: { in: ids } } });
      await tx.user.deleteMany({ where: { id: { in: ids } } });
    });
    ownedUserIds.clear();
  }
});

describe.sequential('privacy operations', () => {
  it('publishes DPO contact, legal routes, versions, and request tracking time', async () => {
    const response = await request(app).get('/api/public/compliance').expect(200);
    expect(response.body).toMatchObject({
      dataProtectionOfficer: { email: 'domksj23@gmail.com' },
      legal: {
        terms: { version: CURRENT_TERMS_VERSION, path: '/legal/terms' },
        privacy: { version: CURRENT_PRIVACY_NOTICE_VERSION, path: '/legal/privacy' },
        childPrivacy: { path: '/legal/child-privacy' },
      },
      privacyRequests: { authenticatedPath: '/api/privacy/requests', responseTrackingDays: 30 },
    });
  });

  it('requires exact signup evidence, persists it, starts teens private, and queues verification', async () => {
    config.email.enabled = true;
    const base = {
      accountType: 'STUDENT', name: 'Private Teen', username: `teen_${randomUUID().slice(0, 8)}`,
      email: `${randomUUID()}@example.test`, password: 'Courtly-private-teen-123', dateOfBirth: '2011-01-01',
    };
    await request(app).post('/api/auth/register').send(base).expect(400);
    const stale = await request(app).post('/api/auth/register').send({
      ...base, ...currentSignupAcceptance, termsVersion: 'superseded',
    }).expect(409);
    expect(stale.body).toMatchObject({ code: 'LEGAL_DOCUMENTS_CHANGED', termsVersion: CURRENT_TERMS_VERSION });
    const staleHash = await request(app).post('/api/auth/register').send({
      ...base, ...currentSignupAcceptance, policySetHash: '0'.repeat(64),
    }).expect(409);
    expect(staleHash.body).toMatchObject({
      code: 'LEGAL_DOCUMENTS_CHANGED', policySetHash: CURRENT_LEGAL_POLICY_SET_HASH,
    });

    const registered = await request(app).post('/api/auth/register').send({
      ...base, username: `teen_${randomUUID().slice(0, 8)}`, ...currentSignupAcceptance,
    }).expect(201);
    ownedUserIds.add(registered.body.user.id);
    expect(registered.body.user).toMatchObject({ profileVisibility: 'PRIVATE', emailVerified: false });
    expect(registered.body.user.signupEvidence).toMatchObject({
      termsVersion: CURRENT_TERMS_VERSION, privacyPolicyVersion: CURRENT_PRIVACY_NOTICE_VERSION,
    });
    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: registered.body.user.id } });
    expect(persisted).toMatchObject({
      termsAcceptedVersion: CURRENT_TERMS_VERSION,
      privacyNoticeAcceptedVersion: CURRENT_PRIVACY_NOTICE_VERSION,
      signupPolicySetHash: CURRENT_LEGAL_POLICY_SET_HASH, emailVerifiedAt: null,
    });
    const claim = await prisma.emailVerificationClaim.findFirstOrThrow({ where: { userId: persisted.id } });
    const acceptance = await prisma.signupAcceptanceEvidence.findUniqueOrThrow({ where: { userId: persisted.id } });
    expect(acceptance).toMatchObject({
      termsVersion: CURRENT_TERMS_VERSION, privacyNoticeVersion: CURRENT_PRIVACY_NOTICE_VERSION,
      policySetHash: CURRENT_LEGAL_POLICY_SET_HASH, acceptedAt: persisted.termsAcceptedAt,
    });
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({
      where: { dedupeKey: `email-verification:${claim.id}` },
    });
    expect(delivery).toMatchObject({ eventType: 'EMAIL_VERIFICATION', status: 'QUEUED' });
    expect(delivery.payload).toMatchObject({ claimId: claim.id, tokenKeyId: claim.tokenKeyId });
    expect(delivery.payload).not.toHaveProperty('token');

    await request(app).post('/api/auth/verify-email')
      .send({ token: deriveEmailVerificationToken(claim.id, claim.tokenKeyId) }).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: persisted.id } })).emailVerifiedAt).not.toBeNull();
    await request(app).post('/api/auth/verify-email')
      .send({ token: deriveEmailVerificationToken(claim.id, claim.tokenKeyId) }).expect(410);
  });

  it('revokes an older claim when an authenticated account requests a new verification email', async () => {
    config.email.enabled = true;
    const suffix = randomUUID().replaceAll('-', '');
    const user = await prisma.user.create({ data: {
      name: 'Unverified Account', legalName: 'Unverified Account', username: `unverified_${suffix.slice(0, 16)}`,
      email: `${suffix}@example.test`, passwordHash: await bcrypt.hash('privacy-test-password', 4),
      accountType: 'STUDENT', accountControl: 'SELF', accountStatus: 'ACTIVE',
      profileVisibility: 'PRIVATE', dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
      termsAcceptedVersion: CURRENT_TERMS_VERSION, termsAcceptedAt: new Date(),
      privacyNoticeAcceptedVersion: CURRENT_PRIVACY_NOTICE_VERSION, privacyNoticeAcceptedAt: new Date(),
      signupPolicySetHash: CURRENT_LEGAL_POLICY_SET_HASH,
    } });
    ownedUserIds.add(user.id);
    const firstId = randomUUID();
    const { keyId: firstTokenKeyId, token: firstToken } = activeEmailVerificationToken(firstId);
    await prisma.emailVerificationClaim.create({ data: {
      id: firstId, userId: user.id, email: user.email!,
      tokenHash: createHash('sha256').update(firstToken).digest('hex'), tokenKeyId: firstTokenKeyId,
      expiresAt: new Date(Date.now() + 60_000),
    } });

    const response = await request(app).post('/api/auth/email-verification/resend')
      .set('Cookie', await sessionFor(user.id)).send({}).expect(200);
    expect(response.body).toMatchObject({ ok: true, emailQueued: true, alreadyVerified: false });
    const claims = await prisma.emailVerificationClaim.findMany({
      where: { userId: user.id }, orderBy: { createdAt: 'asc' },
    });
    expect(claims).toHaveLength(2);
    expect(claims.find(candidate => candidate.id === firstId)?.revokedAt).not.toBeNull();
    expect(claims.find(candidate => candidate.id !== firstId)?.revokedAt).toBeNull();
    await request(app).post('/api/auth/verify-email').send({ token: firstToken }).expect(410);
  });

  it('keeps signup acceptance content-bound and immutable at the database boundary', async () => {
    config.email.enabled = true;
    const suffix = randomUUID().replaceAll('-', '');
    const registered = await request(app).post('/api/auth/register').send({
      accountType: 'STUDENT', name: 'Evidence Account', username: `evidence_${suffix.slice(0, 16)}`,
      email: `${suffix}@example.test`, password: 'Courtly-evidence-test-123',
      dateOfBirth: '1990-01-01', ...currentSignupAcceptance,
    }).expect(201);
    const userId = registered.body.user.id as string;
    ownedUserIds.add(userId);

    const evidence = await prisma.signupAcceptanceEvidence.findUniqueOrThrow({ where: { userId } });
    expect(evidence.policySetHash).toBe(CURRENT_LEGAL_POLICY_SET_HASH);
    await expect(prisma.user.update({
      where: { id: userId }, data: { signupPolicySetHash: '0'.repeat(64) },
    })).rejects.toThrow(/signup acceptance evidence is immutable/i);
    await expect(prisma.signupAcceptanceEvidence.update({
      where: { id: evidence.id }, data: { policySetHash: '0'.repeat(64) },
    })).rejects.toThrow(/append-only/i);
    await expect(prisma.signupAcceptanceEvidence.delete({ where: { id: evidence.id } }))
      .rejects.toThrow(/append-only/i);
    await expect(prisma.$executeRawUnsafe('TRUNCATE TABLE "SignupAcceptanceEvidence"'))
      .rejects.toThrow(/append-only/i);

    await prisma.user.delete({ where: { id: userId } });
    ownedUserIds.delete(userId);
    expect(await prisma.signupAcceptanceEvidence.findUnique({ where: { id: evidence.id } })).toBeNull();
  });

  it('tracks one open request per type, consent consequences, cancellation, and 30-day dates', async () => {
    const subject = await verifiedAccount();
    const missingAcknowledgement = await request(app).post('/api/privacy/requests')
      .set('Cookie', subject.cookie).send({ type: 'CONSENT_WITHDRAWAL', details: 'Stop optional uses.' }).expect(400);
    expect(missingAcknowledgement.body.error).toContain('consequences');

    const created = await request(app).post('/api/privacy/requests')
      .set('Cookie', subject.cookie).send({ type: 'ACCESS', details: 'Please provide my account data.' }).expect(201);
    const requestId = created.body.request.id as string;
    const submitted = new Date(created.body.request.submittedAt).getTime();
    expect(new Date(created.body.request.responseDueAt).getTime() - submitted).toBe(30 * 86_400_000);
    expect(created.body.request.identityVerifiedAt).toBeNull();
    await request(app).post('/api/privacy/requests').set('Cookie', subject.cookie)
      .send({ type: 'ACCESS', details: 'Duplicate.' }).expect(409);
    const listed = await request(app).get('/api/privacy/requests').set('Cookie', subject.cookie).expect(200);
    expect(listed.body.requests).toHaveLength(1);
    const cancelled = await request(app).post(`/api/privacy/requests/${requestId}/cancel`)
      .set('Cookie', subject.cookie).send({}).expect(200);
    expect(cancelled.body.request).toMatchObject({ status: 'CANCELLED', decision: 'WITHDRAWN_BY_SUBJECT' });
    expect(await prisma.privacyRequestEvent.count({ where: { requestId } })).toBe(2);
  });

  it('cursor-paginates subject history without overlap', async () => {
    const subject = await verifiedAccount();
    const base = Date.now();
    await prisma.privacyRequest.createMany({ data: [0, 1, 2].map(index => ({
      id: `privacy-page-${randomUUID()}`, subjectUserId: subject.user.id, type: 'ACCESS',
      status: 'CANCELLED', details: `Page ${index}`, submittedAt: new Date(base - index * 1000),
      acknowledgementDueAt: new Date(base + 30 * 86_400_000), responseDueAt: new Date(base + 30 * 86_400_000),
      decision: 'WITHDRAWN_BY_SUBJECT', decisionReason: 'Test history.', cancelledAt: new Date(base),
    })) });

    const first = await request(app).get('/api/privacy/requests?limit=2').set('Cookie', subject.cookie).expect(200);
    expect(first.body.requests.map((item: { details: string }) => item.details)).toEqual(['Page 0', 'Page 1']);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app).get(`/api/privacy/requests?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('Cookie', subject.cookie).expect(200);
    expect(second.body.requests.map((item: { details: string }) => item.details)).toEqual(['Page 2']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('requires verified email and records reviewed operator delay, hold, and terminal decisions', async () => {
    const subject = await verifiedAccount();
    const created = await request(app).post('/api/privacy/requests').set('Cookie', subject.cookie).send({
      type: 'DELETION', details: 'Delete what is no longer required.',
    }).expect(201);
    const id = created.body.request.id as string;
    const earlier = await prisma.privacyRequest.create({ data: {
      subjectUserId: subject.user.id, type: 'ACCESS', details: 'Earlier active case.',
      acknowledgementDueAt: new Date(Date.now() + 20 * 86_400_000),
      responseDueAt: new Date(Date.now() + 20 * 86_400_000),
    } });
    await prisma.privacyRequest.create({ data: {
      subjectUserId: subject.user.id, type: 'CORRECTION', status: 'COMPLETED', details: 'Closed case.',
      submittedAt: new Date(Date.now() - 30 * 86_400_000),
      acknowledgementDueAt: new Date(Date.now() - 20 * 86_400_000),
      responseDueAt: new Date(Date.now() - 10 * 86_400_000), identityVerifiedAt: new Date(),
      decision: 'FULFILLED', decisionReason: 'Completed.', completedAt: new Date(),
    } });
    const operatorPassword = 'privacy-operator-test-password';
    const namedOperator = {
      id: 'privacy_ops_1', name: 'Priya Privacy', email: 'priya.privacy@example.test',
      passwordHash: await bcrypt.hash(operatorPassword, 12),
    };
    config.adminOperators = [namedOperator];
    await request(app).get('/api/admin/privacy-requests')
      .set('X-Courtly-Privacy-Operator', '1').expect(401);
    const operator = request.agent(app);
    await operator.post('/api/admin/login').send({ email: namedOperator.email, password: operatorPassword }).expect(200);
    await operator.get('/api/admin/privacy-requests?status=COMPLETED&overdue=true')
      .set('X-Courtly-Privacy-Operator', '1').expect(400);
    const activePage = await operator.get('/api/admin/privacy-requests?status=ACTIVE&limit=1')
      .set('X-Courtly-Privacy-Operator', '1').expect(200);
    expect(activePage.body.requests).toHaveLength(1);
    expect(activePage.body.requests[0].id).toBe(earlier.id);
    expect(activePage.body.nextCursor).toEqual(expect.any(String));
    const nextActivePage = await operator.get(`/api/admin/privacy-requests?status=ACTIVE&limit=1&cursor=${encodeURIComponent(activePage.body.nextCursor)}`)
      .set('X-Courtly-Privacy-Operator', '1').expect(200);
    expect(nextActivePage.body.requests.map((item: { id: string }) => item.id)).toEqual([id]);
    expect(nextActivePage.body.nextCursor).toBeNull();
    await operator.patch(`/api/admin/privacy-requests/${id}`).send({
      status: 'IN_REVIEW', note: 'Review started.', externalAuditReference: 'CASE-2026-001',
    }).expect(403);
    const unverifiedReview = await operator.patch(`/api/admin/privacy-requests/${id}`)
      .set('X-Courtly-Privacy-Operator', '1').send({
        status: 'IN_REVIEW', note: 'Review started without verification.',
        externalAuditReference: 'CASE-2026-001',
      }).expect(409);
    expect(unverifiedReview.body).toMatchObject({ code: 'PRIVACY_IDENTITY_VERIFICATION_REQUIRED' });
    const estimatedResponseAt = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const reviewed = await operator.patch(`/api/admin/privacy-requests/${id}`)
      .set('X-Courtly-Privacy-Operator', '1').send({
        status: 'IN_REVIEW', note: 'Identity and records reviewed.', identityVerified: true,
        externalAuditReference: 'CASE-2026-001',
        delayReason: 'Additional third-party records require review.', estimatedResponseAt,
        legalHold: true, legalHoldReason: 'Active payment dispute; review on case closure.',
      }).expect(200);
    expect(reviewed.body.request).toMatchObject({ status: 'IN_REVIEW', legalHold: true });
    expect(reviewed.body.request.identityVerifiedAt).not.toBeNull();
    const closed = await operator.patch(`/api/admin/privacy-requests/${id}`)
      .set('X-Courtly-Privacy-Operator', '1').send({
        status: 'PARTIALLY_COMPLETED', note: 'Removed profile data and retained minimum ledger evidence.',
        externalAuditReference: 'CASE-2026-001',
        legalHold: false, decision: 'PARTIALLY_FULFILLED',
        decisionReason: 'Payment records remain under the documented dispute hold.',
      }).expect(200);
    expect(closed.body.request).toMatchObject({ status: 'PARTIALLY_COMPLETED', legalHold: false });
    await operator.patch(`/api/admin/privacy-requests/${id}`)
      .set('X-Courtly-Privacy-Operator', '1').send({
        status: 'COMPLETED', note: 'Rewrite.', decision: 'FULFILLED', decisionReason: 'Rewrite.',
        externalAuditReference: 'CASE-2026-001',
      }).expect(409);
    const operatorEvents = await prisma.privacyRequestEvent.findMany({
      where: { requestId: id, actorKind: 'OPERATOR' }, orderBy: { createdAt: 'asc' },
    });
    expect(operatorEvents).toHaveLength(2);
    expect(operatorEvents.every(event => event.actorUserId === namedOperator.id
      && event.actorNameSnapshot === namedOperator.name
      && event.actorEmailSnapshot === namedOperator.email)).toBe(true);
    expect(operatorEvents.every(event => (event.metadata as { externalAuditReference?: string })
      .externalAuditReference === 'CASE-2026-001')).toBe(true);
    const history = await operator.get(`/api/admin/privacy-requests/${id}/events?limit=1`)
      .set('X-Courtly-Privacy-Operator', '1').expect(200);
    expect(history.body.events).toHaveLength(1);
    expect(history.body.events[0]).toMatchObject({
      actorKind: 'OPERATOR',
      actorNameSnapshot: namedOperator.name, actorEmailSnapshot: namedOperator.email,
      metadata: { externalAuditReference: 'CASE-2026-001' },
    });
    expect(history.body.events[0]).not.toHaveProperty('actorUserId');
    expect(history.body.nextCursor).toEqual(expect.any(String));
    await request(app).get(`/api/admin/privacy-requests/${id}/events`)
      .set('X-Courtly-Privacy-Operator', '1').expect(401);

    const operatorCancellation = await operator.patch(`/api/admin/privacy-requests/${earlier.id}`)
      .set('X-Courtly-Privacy-Operator', '1').send({
        status: 'CANCELLED', note: 'Operator must not impersonate the subject.',
        externalAuditReference: 'CASE-2026-002', decision: 'WITHDRAWN_BY_SUBJECT',
        decisionReason: 'Not a subject action.',
      }).expect(400);
    expect(operatorCancellation.body.error).toBeTruthy();
  });

  it('rejects privacy requests from an unverified account', async () => {
    const subject = await verifiedAccount();
    await prisma.user.update({ where: { id: subject.user.id }, data: { emailVerifiedAt: null } });
    const response = await request(app).post('/api/privacy/requests').set('Cookie', subject.cookie)
      .send({ type: 'ACCESS', details: '' }).expect(403);
    expect(response.body).toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
  });
});
