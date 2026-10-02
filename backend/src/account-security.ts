import { Router, type Response } from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, serializableTransaction } from './db.js';
import { config, skipRateLimits } from './config.js';
import { sharedRateLimit } from './rate-limit.js';
import { asyncRoute, HttpError, requireRecentAuth, type AccountRequest } from './http.js';
import { lockAccountEmailClaim, normalizedAccountEmail } from './account-email-claim.js';
import {
  activeSecurityClaimToken, decryptMfaSecret, deriveSecurityClaimToken, encryptMfaSecret,
  generateRecoveryCodes, generateTotpSecret, recoveryCodeDigest, securityTokenDigest, verifyTotp,
} from './account-security-crypto.js';
import {
  enqueueEmailChangeSecurityEmail, enqueuePasswordResetSecurityEmail, queueOutboundEmail,
} from './outbound-events.js';

const RESET_LIFETIME_MS = 30 * 60_000;
const EMAIL_CHANGE_LIFETIME_MS = 30 * 60_000;
const MFA_CHALLENGE_LIFETIME_MS = 5 * 60_000;
const tokenSchema = z.string().trim().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/);
const passwordSchema = z.string().min(12, 'Use a password with at least 12 characters').max(72)
  .refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes');
const otpSchema = z.string().trim().min(6).max(32);
const passwordResetRequestLimit = sharedRateLimit({
  name: 'password-reset-request',
  windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits, message: { error: 'Too many security requests. Please try again later.' },
});
const passwordResetConfirmLimit = sharedRateLimit({
  name: 'password-reset-confirm',
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits, message: { error: 'Too many security attempts. Please try again later.' },
});
const emailChangeConfirmLimit = sharedRateLimit({
  name: 'email-change-confirm',
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits, message: { error: 'Too many security attempts. Please try again later.' },
});
const recentAuthAttemptLimit = sharedRateLimit({
  name: 'recent-auth-attempt', keyGenerator: request => (request as AccountRequest).auth.user.id,
  windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits, message: { error: 'Too many identity confirmation attempts. Please try again later.' },
});
const emailChangeRequestLimit = sharedRateLimit({
  name: 'email-change-request', keyGenerator: request => (request as AccountRequest).auth.user.id,
  windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits, message: { error: 'Too many email-change requests. Please try again later.' },
});
const dummyPasswordHash = '$2b$12$QrsSSNoV/kdmGVRTVVmoIOKhMlSeSPFjGtV8.iKB7MHYFUPprZWyK';

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function securityAvailable() {
  return config.accountSecurityKeys.enabled
    && config.accountSecurityKeys.keys.has(config.accountSecurityKeys.activeKeyId);
}

function assertSecurityAvailable() {
  if (!securityAvailable()) throw new HttpError(503, 'Account security is temporarily unavailable', {
    code: 'ACCOUNT_SECURITY_UNAVAILABLE',
  });
}

function claimTokenMatches(
  purpose: 'password-reset' | 'email-change', id: string, keyId: string, supplied: string,
) {
  try { return safeEqual(deriveSecurityClaimToken(purpose, id, keyId), supplied); }
  catch { return false; }
}

type SecurityTx = Prisma.TransactionClient;

async function recordSecurityEvent(
  tx: SecurityTx, userId: string, eventType: string,
  options: { sessionPublicId?: string | null; metadata?: Prisma.InputJsonObject } = {},
) {
  await tx.accountSecurityEvent.create({ data: {
    userId, subjectUserIdSnapshot: userId, eventType,
    sessionPublicId: options.sessionPublicId ?? null, metadata: options.metadata ?? {},
  } });
}

async function verifySecondFactor(
  tx: SecurityTx, userId: string, input: string, now = new Date(),
  method?: 'TOTP' | 'RECOVERY_CODE',
) {
  await tx.$queryRaw`SELECT "userId" FROM "AccountMfaCredential" WHERE "userId" = ${userId} FOR UPDATE`;
  const credential = await tx.accountMfaCredential.findUnique({ where: { userId } });
  if (!credential?.enabledAt) return false;
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (method !== 'RECOVERY_CODE' && /^\d{6}$/.test(compact)) {
    const step = verifyTotp(decryptMfaSecret(credential.secretCiphertext, userId), compact, {
      now: now.getTime(), afterStep: credential.lastUsedStep,
    });
    if (step === null) return false;
    await tx.accountMfaCredential.update({ where: { userId }, data: { lastUsedStep: step } });
    return true;
  }
  if (method === 'TOTP') return false;
  const codes = await tx.accountMfaRecoveryCode.findMany({
    where: { userId, consumedAt: null }, select: { id: true, codeHash: true, keyId: true },
  });
  const matching = codes.find(code => {
    try { return safeEqual(code.codeHash, recoveryCodeDigest(userId, compact, code.keyId)); }
    catch { return false; }
  });
  if (!matching) return false;
  const consumed = await tx.accountMfaRecoveryCode.updateMany({
    where: { id: matching.id, consumedAt: null }, data: { consumedAt: now },
  });
  if (consumed.count === 1) {
    await recordSecurityEvent(tx, userId, 'MFA_RECOVERY_CODE_USED', { metadata: { recoveryCodeId: matching.id } });
  }
  return consumed.count === 1;
}

export async function createMfaLoginChallenge(userId: string) {
  assertSecurityAvailable();
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MFA_CHALLENGE_LIFETIME_MS);
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:mfa-challenge:${userId}`}, 0))`;
    await tx.mfaLoginChallenge.updateMany({
      where: { userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now },
    });
    await tx.mfaLoginChallenge.create({ data: { userId, tokenHash: securityTokenDigest(token), expiresAt } });
  });
  return { challengeToken: token, expiresAt };
}

export async function consumeMfaLoginChallenge(
  challengeId: string, method: 'TOTP' | 'RECOVERY_CODE', code: string,
) {
  assertSecurityAvailable();
  const tokenHash = securityTokenDigest(challengeId);
  const result = await serializableTransaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "MfaLoginChallenge" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    const challenge = await tx.mfaLoginChallenge.findUnique({ where: { tokenHash } });
    const now = new Date();
    if (!challenge || challenge.consumedAt || challenge.revokedAt || challenge.expiresAt <= now || challenge.attempts >= 5) {
      throw new HttpError(401, 'MFA challenge is invalid or expired', { code: 'MFA_CHALLENGE_INVALID' });
    }
    const valid = await verifySecondFactor(tx, challenge.userId, code, now, method);
    if (!valid) {
      const attempts = challenge.attempts + 1;
      await tx.mfaLoginChallenge.update({
        where: { id: challenge.id }, data: { attempts, ...(attempts >= 5 ? { revokedAt: now } : {}) },
      });
      return { valid: false as const };
    }
    await tx.mfaLoginChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
    return { valid: true as const, userId: challenge.userId, authenticatedAt: now };
  });
  if (!result.valid) throw new HttpError(401, 'MFA code is incorrect', { code: 'MFA_CODE_INVALID' });
  return result;
}

export const accountSecurityPublicRouter = Router();
export const accountSecurityRouter = Router();

accountSecurityPublicRouter.post('/password-reset/request', passwordResetRequestLimit, asyncRoute(async (req, res) => {
  const { email } = z.object({ email: z.string().trim().max(254).email().transform(normalizedAccountEmail) }).strict().parse(req.body);
  // Always return the same result, including when delivery or the keyring is
  // unavailable. Recovery requests must not disclose account existence.
  try {
    if (config.email.enabled && securityAvailable()) {
      const user = await prisma.user.findUnique({
        where: { email }, select: { id: true, name: true, email: true, passwordHash: true, accountControl: true },
      });
      if (user?.email && user.passwordHash && user.accountControl === 'SELF') {
        const now = new Date();
        await prisma.$transaction(async tx => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:password-reset:${user.id}`}, 0))`;
          await tx.passwordResetClaim.updateMany({
            where: { userId: user.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now },
          });
          const id = randomUUID();
          const { keyId, token } = activeSecurityClaimToken('password-reset', id);
          const expiresAt = new Date(now.getTime() + RESET_LIFETIME_MS);
          await tx.passwordResetClaim.create({ data: {
            id, userId: user.id, email, tokenHash: securityTokenDigest(token), tokenKeyId: keyId, expiresAt,
          } });
          await enqueuePasswordResetSecurityEmail(tx, {
            claimId: id, tokenKeyId: keyId, recipientEmail: email, recipientName: user.name,
            recipientUserId: user.id, expiresAt,
          });
        });
      }
    }
  } catch (error) {
    // Recovery request responses must not reveal account existence or whether
    // a known account's queue/database operation failed. Operators still get
    // the error class without request secrets.
    console.error(JSON.stringify({ event: 'password_reset_request_failed', errorType: error instanceof Error ? error.name : 'UnknownError' }));
  }
  res.status(202).json({ ok: true });
}));

accountSecurityPublicRouter.post('/password-reset/confirm', passwordResetConfirmLimit, asyncRoute(async (req, res) => {
  assertSecurityAvailable();
  const { token, password } = z.object({ token: tokenSchema, password: passwordSchema }).strict().parse(req.body);
  const tokenHash = securityTokenDigest(token);
  const passwordHash = await bcrypt.hash(password, 12);
  await serializableTransaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "PasswordResetClaim" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    const claim = await tx.passwordResetClaim.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!claim || claim.consumedAt || claim.revokedAt || claim.expiresAt <= new Date()
      || claim.user.email !== claim.email || claim.user.accountControl !== 'SELF'
      || !claimTokenMatches('password-reset', claim.id, claim.tokenKeyId, token)) {
      throw new HttpError(410, 'This password reset link is invalid or expired', { code: 'PASSWORD_RESET_EXPIRED' });
    }
    const now = new Date();
    await tx.user.update({ where: { id: claim.userId }, data: { passwordHash } });
    await tx.passwordResetClaim.update({ where: { id: claim.id }, data: { consumedAt: now } });
    await Promise.all([
      tx.passwordResetClaim.updateMany({ where: { userId: claim.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.emailChangeClaim.updateMany({ where: { userId: claim.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.emailVerificationClaim.updateMany({ where: { userId: claim.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.mfaLoginChallenge.updateMany({ where: { userId: claim.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.authSession.deleteMany({ where: { userId: claim.userId } }),
    ]);
    await recordSecurityEvent(tx, claim.userId, 'PASSWORD_RESET_COMPLETED');
    await queueOutboundEmail(tx, {
      eventType: 'ACCOUNT_SECURITY_NOTICE', category: 'SECURITY',
      dedupeKey: `password-reset:${claim.id}:completed`,
      recipientEmail: claim.email, recipientName: claim.user.name, recipientUserId: claim.userId,
      title: 'Your Courtly password was reset',
      message: 'Your Courtly password was changed and all signed-in devices were signed out. If you did not make this change, contact support immediately.',
    });
  });
  res.json({ ok: true });
}));

accountSecurityPublicRouter.post('/email-change/confirm', emailChangeConfirmLimit, asyncRoute(async (req, res) => {
  assertSecurityAvailable();
  const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
  const tokenHash = securityTokenDigest(token);
  const email = await serializableTransaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "EmailChangeClaim" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    const claim = await tx.emailChangeClaim.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!claim || claim.consumedAt || claim.revokedAt || claim.expiresAt <= new Date()
      || claim.user.email !== claim.oldEmail
      || !claimTokenMatches('email-change', claim.id, claim.tokenKeyId, token)) {
      throw new HttpError(410, 'This email change link is invalid or expired', { code: 'EMAIL_CHANGE_INVALID' });
    }
    const now = new Date();
    const emailClaim = await lockAccountEmailClaim(tx, claim.newEmail, { now });
    if (emailClaim.pendingHandover) throw new HttpError(409, 'This email address is not available');
    const collision = await tx.user.findFirst({ where: { email: claim.newEmail, id: { not: claim.userId } }, select: { id: true } });
    if (collision) throw new HttpError(409, 'This email address is not available');
    await tx.user.update({ where: { id: claim.userId }, data: { email: claim.newEmail, emailVerifiedAt: now } });
    await tx.student.updateMany({ where: { userId: claim.userId }, data: { email: claim.newEmail } });
    await tx.instructor.updateMany({ where: { membership: { userId: claim.userId } }, data: { email: claim.newEmail } });
    await tx.emailChangeClaim.update({ where: { id: claim.id }, data: { consumedAt: now } });
    await Promise.all([
      tx.emailChangeClaim.updateMany({ where: { userId: claim.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.emailVerificationClaim.updateMany({ where: { userId: claim.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.passwordResetClaim.updateMany({ where: { userId: claim.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.mfaLoginChallenge.updateMany({ where: { userId: claim.userId, consumedAt: null, revokedAt: null }, data: { revokedAt: now } }),
      tx.authSession.deleteMany({ where: { userId: claim.userId } }),
    ]);
    await recordSecurityEvent(tx, claim.userId, 'EMAIL_CHANGE_COMPLETED');
    await queueOutboundEmail(tx, {
      eventType: 'ACCOUNT_SECURITY_NOTICE', category: 'SECURITY',
      dedupeKey: `email-change:${claim.id}:old-address-notice`,
      recipientEmail: claim.oldEmail, recipientName: claim.user.name, recipientUserId: claim.userId,
      title: 'Your Courtly email address changed',
      message: `Your Courtly sign-in email was changed to ${claim.newEmail}. If you did not make this change, contact support immediately.`,
    });
    await queueOutboundEmail(tx, {
      eventType: 'ACCOUNT_SECURITY_NOTICE', category: 'SECURITY',
      dedupeKey: `email-change:${claim.id}:new-address-notice`,
      recipientEmail: claim.newEmail, recipientName: claim.user.name, recipientUserId: claim.userId,
      title: 'Your new Courtly email address is active',
      message: 'This address is now your verified Courtly sign-in email. All earlier sessions were signed out.',
    });
    return claim.newEmail;
  });
  res.json({ ok: true, email });
}));

accountSecurityRouter.get('/', asyncRoute(async (req, res) => {
  const now = new Date();
  const idleBoundary = new Date(now.getTime() - config.sessionIdleMinutes * 60_000);
  const [credential, recoveryCodesRemaining, sessions] = await Promise.all([
    prisma.accountMfaCredential.findUnique({ where: { userId: req.auth.user.id }, select: { enabledAt: true } }),
    prisma.accountMfaRecoveryCode.count({ where: { userId: req.auth.user.id, consumedAt: null } }),
    prisma.authSession.findMany({
      where: { userId: req.auth.user.id, expiresAt: { gt: now }, lastSeenAt: { gt: idleBoundary } },
      orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
      select: { publicId: true, createdAt: true, lastSeenAt: true, expiresAt: true, userAgent: true },
    }),
  ]);
  const recentUntil = req.auth.session.recentAuthAt
    ? new Date(req.auth.session.recentAuthAt.getTime() + config.recentAuthMinutes * 60_000) : null;
  res.json({
    email: req.auth.user.email, emailVerified: Boolean(req.auth.user.emailVerifiedAt),
    mfa: {
      enabled: Boolean(credential?.enabledAt), verifiedAt: credential?.enabledAt?.toISOString() ?? null,
      recoveryCodesRemaining,
    },
    sessions: sessions.map(session => ({
      id: session.publicId, current: session.publicId === req.auth.session.publicId,
      createdAt: session.createdAt.toISOString(), lastSeenAt: session.lastSeenAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(), userAgent: session.userAgent,
      ipAddress: null, deviceLabel: null,
    })),
    recentAuth: {
      authenticatedAt: req.auth.session.recentAuthAt?.toISOString() ?? null,
      expiresAt: recentUntil && recentUntil > new Date() ? recentUntil.toISOString() : null,
    },
  });
}));

accountSecurityRouter.post('/recent-auth', recentAuthAttemptLimit, asyncRoute(async (req, res) => {
  const { password, method, code } = z.object({
    password: z.string().min(1).max(72), method: z.enum(['TOTP', 'RECOVERY_CODE']).optional(),
    code: otpSchema.optional(),
  }).strict().parse(req.body);
  const hash = req.auth.user.passwordHash;
  const passwordValid = await bcrypt.compare(password, hash || dummyPasswordHash);
  if (!hash || !passwordValid) throw new HttpError(401, 'Password or MFA code is incorrect');
  const enabled = await prisma.accountMfaCredential.findUnique({
    where: { userId: req.auth.user.id }, select: { enabledAt: true },
  });
  if (enabled?.enabledAt) {
    if (!code) throw new HttpError(401, 'MFA code is required', { code: 'MFA_CODE_REQUIRED' });
    const valid = await prisma.$transaction(async tx => {
      const recentAuthAt = new Date();
      const accepted = await verifySecondFactor(tx, req.auth.user.id, code, new Date(), method);
      if (accepted) {
        const live = await tx.authSession.updateMany({
          where: { id: req.auth.session.id, userId: req.auth.user.id }, data: { recentAuthAt },
        });
        if (!live.count) throw new HttpError(401, 'Session expired. Please sign in again');
        await recordSecurityEvent(tx, req.auth.user.id, 'RECENT_AUTH_SUCCEEDED', {
          sessionPublicId: req.auth.session.publicId, metadata: { mfaUsed: true },
        });
      }
      return accepted;
    });
    if (!valid) throw new HttpError(401, 'Password or MFA code is incorrect');
  } else {
    await prisma.$transaction(async tx => {
      await tx.authSession.update({ where: { id: req.auth.session.id }, data: { recentAuthAt: new Date() } });
      await recordSecurityEvent(tx, req.auth.user.id, 'RECENT_AUTH_SUCCEEDED', {
        sessionPublicId: req.auth.session.publicId, metadata: { mfaUsed: false },
      });
    });
  }
  const recentAuthAt = new Date();
  res.json({ ok: true, recentAuthUntil: new Date(recentAuthAt.getTime() + config.recentAuthMinutes * 60_000).toISOString() });
}));

accountSecurityRouter.post('/email-change', emailChangeRequestLimit, requireRecentAuth, asyncRoute(async (req, res) => {
  assertSecurityAvailable();
  if (!config.email.enabled) throw new HttpError(503, 'Email change is temporarily unavailable', { code: 'EMAIL_CHANGE_UNAVAILABLE' });
  const { email } = z.object({ email: z.string().trim().max(254).email().transform(normalizedAccountEmail) }).strict().parse(req.body);
  const user = req.auth.user;
  if (!user.email || user.accountControl !== 'SELF') throw new HttpError(403, 'This account cannot change its sign-in email');
  if (email === user.email) throw new HttpError(400, 'Choose a different email address');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EMAIL_CHANGE_LIFETIME_MS);
  await prisma.$transaction(async tx => {
    const destination = await lockAccountEmailClaim(tx, email, { now });
    if (destination.pendingHandover) throw new HttpError(409, 'This email address is not available');
    const collision = await tx.user.findUnique({ where: { email }, select: { id: true } });
    if (collision) throw new HttpError(409, 'This email address is not available');
    await tx.emailChangeClaim.updateMany({
      where: { newEmail: email, expiresAt: { lte: now }, consumedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:email-change:${user.id}`}, 0))`;
    await tx.emailChangeClaim.updateMany({
      where: { userId: user.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now },
    });
    const id = randomUUID();
    const { keyId, token } = activeSecurityClaimToken('email-change', id);
    await tx.emailChangeClaim.create({ data: {
      id, userId: user.id, oldEmail: user.email!, newEmail: email, tokenHash: securityTokenDigest(token), tokenKeyId: keyId, expiresAt,
    } });
    const queued = await enqueueEmailChangeSecurityEmail(tx, {
      claimId: id, tokenKeyId: keyId, recipientEmail: email, recipientName: user.name, recipientUserId: user.id, expiresAt,
    });
    if (!queued || typeof queued !== 'object' || !('status' in queued) || String(queued.status) !== 'QUEUED') {
      throw new HttpError(503, 'Email change verification cannot be queued', { code: 'EMAIL_CHANGE_UNAVAILABLE' });
    }
    await recordSecurityEvent(tx, user.id, 'EMAIL_CHANGE_STARTED');
  });
  res.status(202).json({ ok: true, expiresAt: expiresAt.toISOString() });
}));

accountSecurityRouter.post('/mfa/enrollment', requireRecentAuth, asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  assertSecurityAvailable();
  if (!req.auth.user.email || req.auth.user.accountControl !== 'SELF') throw new HttpError(403, 'This account cannot enable MFA');
  const existing = await prisma.accountMfaCredential.findUnique({
    where: { userId: req.auth.user.id }, select: { enabledAt: true },
  });
  if (existing?.enabledAt) {
    throw new HttpError(409, 'Two-step verification is already enabled. Disable it before enrolling a new authenticator.');
  }
  const secret = generateTotpSecret();
  const ciphertext = encryptMfaSecret(secret, req.auth.user.id);
  const enrollmentId = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:mfa-enrollment:${req.auth.user.id}`}, 0))`;
    const existing = await tx.accountMfaCredential.findUnique({ where: { userId: req.auth.user.id } });
    if (existing?.enabledAt) throw new HttpError(409, 'MFA is already enabled');
    await tx.accountMfaEnrollment.updateMany({
      where: { userId: req.auth.user.id, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date() },
    });
    await tx.accountMfaEnrollment.create({ data: {
      id: enrollmentId, userId: req.auth.user.id, secretCiphertext: ciphertext, expiresAt,
    } });
  });
  const label = encodeURIComponent(`Courtly:${req.auth.user.email}`);
  const issuer = encodeURIComponent('Courtly');
  res.status(201).json({
    enrollmentId, secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
    expiresAt: expiresAt.toISOString(),
  });
}));

accountSecurityRouter.post('/mfa/enable', requireRecentAuth, asyncRoute(async (req, res) => {
  const { enrollmentId, code } = z.object({ enrollmentId: z.string().uuid(), code: otpSchema }).strict().parse(req.body);
  assertSecurityAvailable();
  const recoveryCodes = generateRecoveryCodes();
  const enabledAt = new Date();
  const enabled = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "AccountMfaEnrollment" WHERE "id" = ${enrollmentId} FOR UPDATE`;
    const enrollment = await tx.accountMfaEnrollment.findFirst({ where: { id: enrollmentId, userId: req.auth.user.id } });
    if (!enrollment || enrollment.consumedAt || enrollment.revokedAt || enrollment.expiresAt <= enabledAt || enrollment.attempts >= 5) {
      throw new HttpError(409, 'No pending MFA enrollment is available');
    }
    const step = verifyTotp(decryptMfaSecret(enrollment.secretCiphertext, req.auth.user.id), code, { now: enabledAt.getTime() });
    if (step === null) {
      const attempts = enrollment.attempts + 1;
      await tx.accountMfaEnrollment.update({ where: { id: enrollment.id }, data: {
        attempts, ...(attempts >= 5 ? { revokedAt: enabledAt } : {}),
      } });
      return false;
    }
    const keyId = config.accountSecurityKeys.activeKeyId;
    await tx.accountMfaCredential.upsert({
      where: { userId: req.auth.user.id },
      create: { userId: req.auth.user.id, secretCiphertext: enrollment.secretCiphertext, enabledAt, lastUsedStep: step },
      update: { secretCiphertext: enrollment.secretCiphertext, enabledAt, lastUsedStep: step },
    });
    await tx.accountMfaEnrollment.update({ where: { id: enrollment.id }, data: { consumedAt: enabledAt } });
    await tx.accountMfaEnrollment.updateMany({
      where: { userId: req.auth.user.id, id: { not: enrollment.id }, consumedAt: null, revokedAt: null },
      data: { revokedAt: enabledAt },
    });
    await tx.accountMfaRecoveryCode.deleteMany({ where: { userId: req.auth.user.id } });
    await tx.accountMfaRecoveryCode.createMany({ data: recoveryCodes.map(value => ({
      userId: req.auth.user.id, keyId, codeHash: recoveryCodeDigest(req.auth.user.id, value, keyId),
    })) });
    await recordSecurityEvent(tx, req.auth.user.id, 'MFA_ENABLED', { sessionPublicId: req.auth.session.publicId });
    return true;
  });
  if (!enabled) throw new HttpError(400, 'MFA code is incorrect', { code: 'MFA_CODE_INVALID' });
  res.json({ ok: true, enabledAt: enabledAt.toISOString(), recoveryCodes });
}));

accountSecurityRouter.post('/mfa/recovery-codes', requireRecentAuth, asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  assertSecurityAvailable();
  const credential = await prisma.accountMfaCredential.findUnique({ where: { userId: req.auth.user.id } });
  if (!credential?.enabledAt) throw new HttpError(409, 'MFA is not enabled');
  const recoveryCodes = generateRecoveryCodes();
  const keyId = config.accountSecurityKeys.activeKeyId;
  await prisma.$transaction(async tx => {
    await tx.accountMfaRecoveryCode.deleteMany({ where: { userId: req.auth.user.id } });
    await tx.accountMfaRecoveryCode.createMany({ data: recoveryCodes.map(value => ({
      userId: req.auth.user.id, keyId, codeHash: recoveryCodeDigest(req.auth.user.id, value, keyId),
    })) });
    await recordSecurityEvent(tx, req.auth.user.id, 'MFA_RECOVERY_CODES_REPLACED', {
      sessionPublicId: req.auth.session.publicId,
    });
  });
  res.json({ ok: true, recoveryCodes });
}));

accountSecurityRouter.delete('/mfa', requireRecentAuth, asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  await prisma.$transaction(async tx => {
    await tx.accountMfaCredential.deleteMany({ where: { userId: req.auth.user.id } });
    await tx.accountMfaEnrollment.updateMany({
      where: { userId: req.auth.user.id, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date() },
    });
    await tx.accountMfaRecoveryCode.deleteMany({ where: { userId: req.auth.user.id } });
    await tx.mfaLoginChallenge.updateMany({ where: { userId: req.auth.user.id, consumedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.authSession.deleteMany({ where: { userId: req.auth.user.id, id: { not: req.auth.session.id } } });
    await recordSecurityEvent(tx, req.auth.user.id, 'MFA_DISABLED', { sessionPublicId: req.auth.session.publicId });
  });
  res.json({ ok: true });
}));

accountSecurityRouter.get('/sessions', asyncRoute(async (req, res) => {
  const now = new Date();
  const sessions = await prisma.authSession.findMany({
    where: {
      userId: req.auth.user.id, expiresAt: { gt: now },
      lastSeenAt: { gt: new Date(now.getTime() - config.sessionIdleMinutes * 60_000) },
    }, orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    select: { publicId: true, createdAt: true, lastSeenAt: true, expiresAt: true, userAgent: true },
  });
  res.json({ sessions: sessions.map(session => ({
    id: session.publicId, current: session.publicId === req.auth.session.publicId,
    createdAt: session.createdAt.toISOString(), lastSeenAt: session.lastSeenAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(), userAgent: session.userAgent,
  })) });
}));

accountSecurityRouter.delete('/sessions/:sessionId', requireRecentAuth, asyncRoute(async (req, res) => {
  const sessionId = z.string().trim().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/).parse(req.params.sessionId);
  const removed = await prisma.$transaction(async tx => {
    const result = await tx.authSession.deleteMany({ where: { publicId: sessionId, userId: req.auth.user.id } });
    if (result.count) await recordSecurityEvent(tx, req.auth.user.id, 'SESSION_REVOKED', {
      sessionPublicId: req.auth.session.publicId, metadata: { revokedSessionPublicId: sessionId },
    });
    return result;
  });
  if (!removed.count) throw new HttpError(404, 'Session not found');
  if (sessionId === req.auth.session.publicId) clearSessionCookie(res);
  res.json({ ok: true });
}));

accountSecurityRouter.post('/sessions/revoke-others', requireRecentAuth, asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const removed = await prisma.$transaction(async tx => {
    const result = await tx.authSession.deleteMany({ where: { userId: req.auth.user.id, id: { not: req.auth.session.id } } });
    await recordSecurityEvent(tx, req.auth.user.id, 'OTHER_SESSIONS_REVOKED', {
      sessionPublicId: req.auth.session.publicId, metadata: { revokedCount: result.count },
    });
    return result;
  });
  res.json({ ok: true, revoked: removed.count });
}));

export function clearSessionCookie(res: Response) {
  res.clearCookie(config.sessionCookie, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
}
