import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import type { EmailProvider } from './email-provider.js';
import { EmailProviderError } from './email-provider.js';
import { renderTransactionalEmail, type TransactionalEmailEvent } from './email-templates.js';
import {
  FamilyHandoverTokenError,
  deriveFamilyHandoverToken,
  familyHandoverClaimUrl,
  familyHandoverTokenDigest,
} from './family-handover-token.js';
import {
  deriveEmailVerificationToken,
  emailVerificationTokenDigest,
  emailVerificationUrl,
} from './email-verification-token.js';
import {
  deriveSecurityClaimToken, emailChangeUrl, passwordResetUrl, securityTokenDigest,
} from './account-security-crypto.js';

export type ClaimedDelivery = { id: string; eventType: string; recipientEmail: string; recipientName: string; payload: unknown; attempts: number; leaseToken: string };
export type DeliveryDb = {
  $queryRaw<T>(query: unknown): Promise<T>;
  outboundDelivery: { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> };
  childAccountHandover: { findUnique(args: {
    where: { id: string };
    select: { status: true; expiresAt: true; destinationEmail: true; tokenHash: true };
  }): Promise<{ status: string; expiresAt: Date; destinationEmail: string; tokenHash: string } | null> };
  emailVerificationClaim: { findUnique(args: {
    where: { id: string };
    select: { email: true; expiresAt: true; tokenHash: true; tokenKeyId: true; consumedAt: true; revokedAt: true };
  }): Promise<{ email: string; expiresAt: Date; tokenHash: string; tokenKeyId: string; consumedAt: Date | null; revokedAt: Date | null } | null> };
  passwordResetClaim?: { findUnique(args: {
    where: { id: string };
    select: { email: true; expiresAt: true; tokenHash: true; tokenKeyId: true; consumedAt: true; revokedAt: true };
  }): Promise<{ email: string; expiresAt: Date; tokenHash: string; tokenKeyId: string; consumedAt: Date | null; revokedAt: Date | null } | null> };
  emailChangeClaim?: { findUnique(args: {
    where: { id: string };
    select: { newEmail: true; expiresAt: true; tokenHash: true; tokenKeyId: true; consumedAt: true; revokedAt: true };
  }): Promise<{ newEmail: string; expiresAt: Date; tokenHash: string; tokenKeyId: string; consumedAt: Date | null; revokedAt: Date | null } | null> };
};
const defaultDb = prisma as unknown as DeliveryDb;
const maxAttempts = 8;
const maxDelayMs = 24 * 60 * 60_000;
const baseDelays = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];

export function retryDelayMs(attempts: number, random = Math.random) {
  const base = baseDelays[Math.min(Math.max(0, attempts), baseDelays.length - 1)] ?? maxDelayMs;
  return Math.min(maxDelayMs, Math.round(base * (0.8 + random() * 0.4)));
}

export async function claimOutboundDeliveries(db: DeliveryDb = defaultDb, limit = 25, leaseMs = 60_000) {
  const leaseToken = randomUUID();
  const rows = await db.$queryRaw<Omit<ClaimedDelivery, 'leaseToken'>[]>(Prisma.sql`
    WITH candidates AS (
      SELECT "id" FROM "OutboundDelivery"
      WHERE "channel" = 'EMAIL' AND "status" IN ('QUEUED', 'SENDING')
        AND "availableAt" <= CURRENT_TIMESTAMP
        AND ("leasedUntil" IS NULL OR "leasedUntil" < CURRENT_TIMESTAMP)
      ORDER BY "availableAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED LIMIT ${limit}
    )
    UPDATE "OutboundDelivery" AS delivery
    SET "status" = 'SENDING', "leasedUntil" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'), "leaseToken" = ${leaseToken}, "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates WHERE delivery."id" = candidates."id" RETURNING delivery.*
  `);
  return rows.map(row => ({ ...row, leaseToken }));
}

class SuppressDeliveryError extends Error {
  constructor(readonly code: string) { super(code); }
}

async function payloadOf(delivery: ClaimedDelivery, db: DeliveryDb, now: Date) {
  const payload = delivery.payload && typeof delivery.payload === 'object' ? delivery.payload as Record<string, unknown> : {};
  if (delivery.eventType === 'FAMILY_HANDOVER_SECURITY') {
    if (typeof payload.handoverId !== 'string' || typeof payload.tokenKeyId !== 'string'
      || typeof payload.expiresAt !== 'string') {
      throw new EmailProviderError('Family handover delivery payload is invalid', 'HANDOVER_DELIVERY_INVALID', false);
    }
    const expiresAt = new Date(payload.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new EmailProviderError('Family handover delivery payload is invalid', 'HANDOVER_DELIVERY_INVALID', false);
    }
    const handover = await db.childAccountHandover.findUnique({
      where: { id: payload.handoverId },
      select: { status: true, expiresAt: true, destinationEmail: true, tokenHash: true },
    });
    if (!handover || handover.status !== 'PENDING' || handover.expiresAt <= now
      || handover.expiresAt.getTime() !== expiresAt.getTime()
      || handover.destinationEmail !== delivery.recipientEmail) {
      throw new SuppressDeliveryError('HANDOVER_UNAVAILABLE');
    }
    let token: string;
    try {
      token = deriveFamilyHandoverToken(payload.handoverId, payload.tokenKeyId);
    } catch (error) {
      if (error instanceof FamilyHandoverTokenError) {
        throw new EmailProviderError('Family handover token key is unavailable', 'HANDOVER_TOKEN_KEY_UNAVAILABLE', true);
      }
      throw error;
    }
    if (familyHandoverTokenDigest(token) !== handover.tokenHash) {
      throw new EmailProviderError('Family handover token digest does not match', 'HANDOVER_TOKEN_MISMATCH', false);
    }
    return {
      eventType: 'FAMILY_HANDOVER_SECURITY' as const,
      recipientName: delivery.recipientName,
      claimUrl: familyHandoverClaimUrl(token),
      expiresAt,
    };
  }
  if (delivery.eventType === 'EMAIL_VERIFICATION') {
    if (typeof payload.claimId !== 'string' || typeof payload.tokenKeyId !== 'string'
      || typeof payload.expiresAt !== 'string') {
      throw new EmailProviderError('Email verification delivery payload is invalid', 'EMAIL_VERIFICATION_DELIVERY_INVALID', false);
    }
    const expiresAt = new Date(payload.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new EmailProviderError('Email verification delivery payload is invalid', 'EMAIL_VERIFICATION_DELIVERY_INVALID', false);
    }
    const claim = await db.emailVerificationClaim.findUnique({
      where: { id: payload.claimId },
      select: { email: true, expiresAt: true, tokenHash: true, tokenKeyId: true, consumedAt: true, revokedAt: true },
    });
    if (!claim || claim.consumedAt || claim.revokedAt || claim.expiresAt <= now
      || claim.expiresAt.getTime() !== expiresAt.getTime() || claim.email !== delivery.recipientEmail
      || claim.tokenKeyId !== payload.tokenKeyId) {
      throw new SuppressDeliveryError('EMAIL_VERIFICATION_UNAVAILABLE');
    }
    let token: string;
    try { token = deriveEmailVerificationToken(payload.claimId, payload.tokenKeyId); }
    catch {
      throw new EmailProviderError('Email verification token key is unavailable',
        'EMAIL_VERIFICATION_TOKEN_KEY_UNAVAILABLE', true);
    }
    if (emailVerificationTokenDigest(token) !== claim.tokenHash) {
      throw new SuppressDeliveryError('EMAIL_VERIFICATION_TOKEN_MISMATCH');
    }
    return {
      eventType: 'EMAIL_VERIFICATION' as const, recipientName: delivery.recipientName,
      verificationUrl: emailVerificationUrl(token), expiresAt,
    };
  }
  if (delivery.eventType === 'PASSWORD_RESET' || delivery.eventType === 'EMAIL_CHANGE_VERIFICATION') {
    if (typeof payload.claimId !== 'string' || typeof payload.tokenKeyId !== 'string'
      || typeof payload.expiresAt !== 'string') {
      throw new EmailProviderError('Account security delivery payload is invalid', 'ACCOUNT_SECURITY_DELIVERY_INVALID', false);
    }
    const expiresAt = new Date(payload.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new EmailProviderError('Account security delivery payload is invalid', 'ACCOUNT_SECURITY_DELIVERY_INVALID', false);
    }
    const passwordReset = delivery.eventType === 'PASSWORD_RESET';
    const claim = passwordReset
      ? await db.passwordResetClaim?.findUnique({ where: { id: payload.claimId }, select: { email: true, expiresAt: true, tokenHash: true, tokenKeyId: true, consumedAt: true, revokedAt: true } })
      : await db.emailChangeClaim?.findUnique({ where: { id: payload.claimId }, select: { newEmail: true, expiresAt: true, tokenHash: true, tokenKeyId: true, consumedAt: true, revokedAt: true } });
    const claimEmail = claim && ('email' in claim ? claim.email : claim.newEmail);
    if (!claim || claim.consumedAt || claim.revokedAt || claim.expiresAt <= now
      || claim.expiresAt.getTime() !== expiresAt.getTime() || claimEmail !== delivery.recipientEmail
      || claim.tokenKeyId !== payload.tokenKeyId) throw new SuppressDeliveryError('ACCOUNT_SECURITY_CLAIM_UNAVAILABLE');
    let token: string;
    try { token = deriveSecurityClaimToken(passwordReset ? 'password-reset' : 'email-change', payload.claimId, payload.tokenKeyId); }
    catch { throw new EmailProviderError('Account security key is unavailable', 'ACCOUNT_SECURITY_KEY_UNAVAILABLE', true); }
    if (securityTokenDigest(token) !== claim.tokenHash) throw new SuppressDeliveryError('ACCOUNT_SECURITY_TOKEN_MISMATCH');
    return passwordReset
      ? { eventType: 'PASSWORD_RESET' as const, recipientName: delivery.recipientName, resetUrl: passwordResetUrl(token), expiresAt }
      : { eventType: 'EMAIL_CHANGE_VERIFICATION' as const, recipientName: delivery.recipientName, confirmationUrl: emailChangeUrl(token), expiresAt };
  }
  return { eventType: delivery.eventType as TransactionalEmailEvent, recipientName: delivery.recipientName,
    title: String(payload.title ?? 'Courtly update'), message: String(payload.message ?? ''),
    actionUrl: typeof payload.actionUrl === 'string' ? payload.actionUrl : undefined,
    actionLabel: typeof payload.actionLabel === 'string' ? payload.actionLabel : undefined };
}

export async function processOutboundDeliveries(options: { provider: EmailProvider; from: { email: string; name: string }; replyTo?: string; db?: DeliveryDb; limit?: number; now?: () => Date; random?: () => number }) {
  if (options.provider.kind === 'disabled') return 0;
  const db = options.db ?? defaultDb;
  const jobs = await claimOutboundDeliveries(db, options.limit);
  for (const job of jobs) {
    try {
      const rendered = renderTransactionalEmail(await payloadOf(job, db, options.now?.() ?? new Date()));
      const receipt = await options.provider.send({ deliveryId: job.id, to: { email: job.recipientEmail, name: job.recipientName }, from: options.from, replyTo: options.replyTo, ...rendered });
      await db.outboundDelivery.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: 'SENDING' }, data: { status: 'ACCEPTED', attempts: { increment: 1 }, acceptedAt: receipt.acceptedAt, providerMessageId: receipt.providerMessageId, leasedUntil: null, leaseToken: null, lastErrorCode: null, lastErrorAt: null } });
    } catch (error) {
      if (error instanceof SuppressDeliveryError) {
        await db.outboundDelivery.updateMany({
          where: { id: job.id, leaseToken: job.leaseToken, status: 'SENDING' },
          data: { status: 'SUPPRESSED', lastErrorCode: error.code, lastErrorAt: options.now?.() ?? new Date(), leasedUntil: null, leaseToken: null },
        });
        continue;
      }
      const failure = error instanceof EmailProviderError ? error : new EmailProviderError('Email delivery failed', 'EMAIL_SEND_FAILED', true);
      const attempts = job.attempts + 1;
      const retry = failure.transient && attempts < maxAttempts;
      const delay = failure.retryAfterMs ?? retryDelayMs(job.attempts, options.random);
      const now = options.now?.() ?? new Date();
      // A retry remains queued with a future availability timestamp. Keeping
      // one durable queue state makes the database constraint and worker
      // recovery rules agree after a process dies or a lease expires.
      await db.outboundDelivery.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, status: 'SENDING' }, data: { status: retry ? 'QUEUED' : 'FAILED', attempts: { increment: 1 }, availableAt: retry ? new Date(now.getTime() + Math.min(delay, maxDelayMs)) : now, failedAt: retry ? null : now, lastErrorCode: failure.code, lastErrorAt: now, leasedUntil: null, leaseToken: null } });
    }
  }
  return jobs.length;
}

export function startOutboundWorker(options: Parameters<typeof processOutboundDeliveries>[0] & { intervalMs?: number }) {
  let running = false; let stopped = false;
  const tick = async () => { if (running || stopped) return; running = true; try { await processOutboundDeliveries(options); } catch (error) { console.error('Outbound worker tick failed', error); } finally { running = false; } };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? 30_000); timer.unref(); void tick();
  return () => { stopped = true; clearInterval(timer); };
}
