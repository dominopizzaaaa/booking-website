import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import type { EmailProvider } from './email-provider.js';
import { EmailProviderError } from './email-provider.js';
import { renderTransactionalEmail, type TransactionalEmailEvent } from './email-templates.js';

export type ClaimedDelivery = { id: string; eventType: string; recipientEmail: string; recipientName: string; payload: unknown; attempts: number; leaseToken: string };
export type DeliveryDb = {
  $queryRaw<T>(query: unknown): Promise<T>;
  outboundDelivery: { updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }> };
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

function payloadOf(delivery: ClaimedDelivery) {
  const payload = delivery.payload && typeof delivery.payload === 'object' ? delivery.payload as Record<string, unknown> : {};
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
      const rendered = renderTransactionalEmail(payloadOf(job));
      const receipt = await options.provider.send({ deliveryId: job.id, to: { email: job.recipientEmail, name: job.recipientName }, from: options.from, replyTo: options.replyTo, ...rendered });
      await db.outboundDelivery.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: { status: 'ACCEPTED', attempts: { increment: 1 }, acceptedAt: receipt.acceptedAt, providerMessageId: receipt.providerMessageId, leasedUntil: null, leaseToken: null, lastErrorCode: null, lastErrorAt: null } });
    } catch (error) {
      const failure = error instanceof EmailProviderError ? error : new EmailProviderError('Email delivery failed', 'EMAIL_SEND_FAILED', true);
      const attempts = job.attempts + 1;
      const retry = failure.transient && attempts < maxAttempts;
      const delay = failure.retryAfterMs ?? retryDelayMs(job.attempts, options.random);
      const now = options.now?.() ?? new Date();
      // A retry remains queued with a future availability timestamp. Keeping
      // one durable queue state makes the database constraint and worker
      // recovery rules agree after a process dies or a lease expires.
      await db.outboundDelivery.updateMany({ where: { id: job.id, leaseToken: job.leaseToken }, data: { status: retry ? 'QUEUED' : 'FAILED', attempts: { increment: 1 }, availableAt: retry ? new Date(now.getTime() + Math.min(delay, maxDelayMs)) : now, failedAt: retry ? null : now, lastErrorCode: failure.code, lastErrorAt: now, leasedUntil: null, leaseToken: null } });
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
