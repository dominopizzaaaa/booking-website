import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { deriveSecurityClaimToken, generateTotpCode, generateTotpSecret, encryptMfaSecret } from '../src/account-security-crypto.js';
import { prisma, verifyTestDatabase } from './fixtures.js';

const ownedUsers = new Set<string>();
const originalEmail = { ...config.email };

async function createUser(password = 'Courtly-security-test-123') {
  const id = randomUUID();
  ownedUsers.add(id);
  await prisma.$executeRaw`INSERT INTO "User"
    ("id", "name", "legalName", "username", "email", "emailVerifiedAt", "passwordHash", "accountType", "dateOfBirth")
    VALUES (${id}, 'Security Test', 'Security Test', ${`security_${id.replaceAll('-', '').slice(0, 16)}`},
      ${`${id}@example.test`}, CURRENT_TIMESTAMP, ${await bcrypt.hash(password, 4)}, 'STUDENT', DATE '1990-01-01')`;
  return prisma.$queryRaw<{ id: string; email: string }[]>`SELECT "id", "email" FROM "User" WHERE "id" = ${id}`
    .then(rows => rows[0]!);
}

async function sessionFor(userId: string, recent = true, lastSeenAt = new Date()) {
  const token = randomBytes(32).toString('base64url');
  const session = await prisma.authSession.create({ data: {
    id: createHash('sha256').update(token).digest('hex'), userId, lastSeenAt,
    recentAuthAt: recent ? new Date() : null, expiresAt: new Date(Date.now() + 3_600_000),
    userAgent: 'Courtly Test Browser',
  } });
  return { session, cookie: `${config.sessionCookie}=${token}` };
}

beforeAll(verifyTestDatabase, 15_000);
beforeEach(async () => {
  config.email.enabled = true; config.email.mode = 'capture';
  await prisma.rateLimitCounter.deleteMany({
    where: { namespace: { in: [
      'password-reset-request', 'password-reset-confirm', 'email-change-confirm',
      'recent-auth-attempt', 'email-change-request',
    ] } },
  });
});
afterEach(async () => {
  if (ownedUsers.size) await prisma.user.deleteMany({ where: { id: { in: [...ownedUsers] } } });
  ownedUsers.clear();
  Object.assign(config.email, originalEmail);
});
afterAll(() => prisma.$disconnect());

describe.sequential('account security', () => {
  it('returns generic reset issuance, stores no bearer, consumes once, and revokes sessions', async () => {
    const user = await createUser();
    await sessionFor(user.id);
    await request(app).post('/api/auth/password-reset/request').send({ email: user.email }).expect(202, { ok: true });
    await request(app).post('/api/auth/password-reset/request').send({ email: `${randomUUID()}@example.test` }).expect(202, { ok: true });
    const claim = await prisma.passwordResetClaim.findFirstOrThrow({ where: { userId: user.id } });
    const delivery = await prisma.outboundDelivery.findFirstOrThrow({ where: { dedupeKey: `password-reset:${claim.id}` } });
    const token = deriveSecurityClaimToken('password-reset', claim.id, claim.tokenKeyId);
    expect(JSON.stringify({ claim, delivery })).not.toContain(token);

    await request(app).post('/api/auth/password-reset/confirm')
      .send({ token, password: 'Courtly-new-security-password-123' }).expect(200, { ok: true });
    expect(await prisma.authSession.count({ where: { userId: user.id } })).toBe(0);
    const [updated] = await prisma.$queryRaw<{ passwordHash: string }[]>`SELECT "passwordHash" FROM "User" WHERE "id" = ${user.id}`;
    expect(await bcrypt.compare('Courtly-new-security-password-123', updated!.passwordHash)).toBe(true);
    await request(app).post('/api/auth/password-reset/confirm')
      .send({ token, password: 'Courtly-another-security-password-123' }).expect(410);
  });

  it('requires recent auth for sensitive changes and lists/revokes only public session IDs', async () => {
    const user = await createUser();
    const current = await sessionFor(user.id, false);
    const other = await sessionFor(user.id);
    const blocked = await request(app).post('/api/account/security/sessions/revoke-others')
      .set('Cookie', current.cookie).send({}).expect(428);
    expect(blocked.body.code).toBe('RECENT_AUTH_REQUIRED');
    const recent = await request(app).post('/api/account/security/recent-auth')
      .set('Cookie', current.cookie).send({ password: 'Courtly-security-test-123' }).expect(200);
    expect(recent.body.recentAuthUntil).toEqual(expect.any(String));
    const listed = await request(app).get('/api/account/security').set('Cookie', current.cookie).expect(200);
    expect(listed.body.sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: current.session.publicId, current: true })]));
    expect(JSON.stringify(listed.body)).not.toContain(current.session.id);
    await request(app).post('/api/account/security/sessions/revoke-others')
      .set('Cookie', current.cookie).send({}).expect(200, { ok: true, revoked: 1 });
    expect(await prisma.authSession.findUnique({ where: { id: other.session.id } })).toBeNull();
  });

  it('enforces idle expiry and completes MFA login with a replay-resistant TOTP', async () => {
    const user = await createUser();
    const stale = await sessionFor(user.id, true, new Date(Date.now() - config.sessionIdleMinutes * 60_000 - 1));
    await request(app).get('/api/account/security').set('Cookie', stale.cookie).expect(401);

    const secret = generateTotpSecret();
    await prisma.accountMfaCredential.create({ data: {
      userId: user.id, secretCiphertext: encryptMfaSecret(secret, user.id), enabledAt: new Date(),
    } });
    const first = await request(app).post('/api/auth/login')
      .send({ email: user.email, password: 'Courtly-security-test-123' }).expect(202);
    expect(first.body).toMatchObject({ mfaRequired: true, methods: ['TOTP', 'RECOVERY_CODE'] });
    const code = generateTotpCode(secret);
    await request(app).post('/api/auth/mfa/challenge').send({
      challengeId: first.body.challengeId, method: 'TOTP', code,
    }).expect(200);
    const second = await request(app).post('/api/auth/login')
      .send({ email: user.email, password: 'Courtly-security-test-123' }).expect(202);
    await request(app).post('/api/auth/mfa/challenge').send({
      challengeId: second.body.challengeId, method: 'TOTP', code,
    }).expect(401);
  });

  it('binds MFA enablement to a short-lived enrollment and stores recovery codes only as digests', async () => {
    const user = await createUser();
    const session = await sessionFor(user.id);
    const enrollment = await request(app).post('/api/account/security/mfa/enrollment')
      .set('Cookie', session.cookie).send({}).expect(201);
    expect(enrollment.body).toMatchObject({
      enrollmentId: expect.any(String), secret: expect.any(String),
      otpauthUri: expect.stringContaining('otpauth://totp/'), expiresAt: expect.any(String),
    });

    const validCode = generateTotpCode(enrollment.body.secret);
    const invalidCode = `${validCode.slice(0, -1)}${validCode.endsWith('0') ? '1' : '0'}`;
    const rejected = await request(app).post('/api/account/security/mfa/enable').set('Cookie', session.cookie).send({
      enrollmentId: enrollment.body.enrollmentId, code: invalidCode,
    }).expect(400);
    expect(rejected.body).toMatchObject({ code: 'MFA_CODE_INVALID' });
    expect(await prisma.accountMfaEnrollment.findUniqueOrThrow({
      where: { id: enrollment.body.enrollmentId }, select: { attempts: true },
    })).toEqual({ attempts: 1 });

    const enabled = await request(app).post('/api/account/security/mfa/enable').set('Cookie', session.cookie).send({
      enrollmentId: enrollment.body.enrollmentId, code: validCode,
    }).expect(200);
    expect(enabled.body).toMatchObject({
      ok: true, enabledAt: expect.any(String), recoveryCodes: expect.any(Array),
    });
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    const storedCodes = await prisma.accountMfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(storedCodes).toHaveLength(10);
    expect(JSON.stringify(storedCodes)).not.toContain(enabled.body.recoveryCodes[0]);
    expect(await prisma.accountMfaEnrollment.findUniqueOrThrow({
      where: { id: enrollment.body.enrollmentId }, select: { consumedAt: true },
    })).toEqual({ consumedAt: expect.any(Date) });
  });

  it('confirms an email change without a session, notifies the old address, and revokes all sessions', async () => {
    const user = await createUser();
    const session = await sessionFor(user.id);
    const destination = `${randomUUID()}@example.test`;
    await request(app).post('/api/account/security/email-change').set('Cookie', session.cookie)
      .send({ email: destination }).expect(202);
    const claim = await prisma.emailChangeClaim.findFirstOrThrow({ where: { userId: user.id } });
    const token = deriveSecurityClaimToken('email-change', claim.id, claim.tokenKeyId);
    await request(app).post('/api/auth/email-change/confirm').send({ token }).expect(200, { ok: true, email: destination });
    const [updated] = await prisma.$queryRaw<{ email: string }[]>`SELECT "email" FROM "User" WHERE "id" = ${user.id}`;
    expect(updated!.email).toBe(destination);
    expect(await prisma.authSession.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.outboundDelivery.findFirst({
      where: { dedupeKey: `email-change:${claim.id}:old-address-notice`, recipientEmail: user.email! },
    })).not.toBeNull();
  });
});
