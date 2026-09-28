import { describe, expect, it, vi } from 'vitest';
import { CaptureEmailProvider, EmailProviderError, type EmailProvider } from '../src/email-provider.js';
import { claimOutboundDeliveries, processOutboundDeliveries, retryDelayMs, type DeliveryDb } from '../src/outbound-worker.js';

function database(job: Record<string, unknown>) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  return { db: { $queryRaw: vi.fn(async () => [job]), outboundDelivery: { updateMany } } as unknown as DeliveryDb, updateMany };
}
const job = { id: 'delivery-1', eventType: 'BOOKING_CONFIRMED', recipientEmail: 'a@example.test', recipientName: 'Avery', payload: { title: 'Confirmed', message: 'See you soon.' }, attempts: 0 };

describe('outbound worker', () => {
  it('uses bounded exponential retry delays', () => {
    expect(retryDelayMs(0, () => 0.5)).toBe(60_000);
    expect(retryDelayMs(4, () => 0.5)).toBe(12 * 60 * 60_000);
    expect(retryDelayMs(99, () => 1)).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it('marks accepted provider requests and clears the lease', async () => {
    const { db, updateMany } = database(job);
    const provider = new CaptureEmailProvider();
    expect(await processOutboundDeliveries({ provider, from: { email: 'updates@courtly.test', name: 'Courtly' }, db })).toBe(1);
    expect(provider.messages[0]).toMatchObject({ deliveryId: 'delivery-1', subject: 'Confirmed' });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED', providerMessageId: 'capture_delivery-1', leaseToken: null }) }));
  });

  it('reclaims expired sending jobs atomically without consuming another attempt', async () => {
    const crashedJob = {
      ...job, status: 'SENDING', attempts: 3,
      leasedUntil: new Date('2026-09-28T00:00:00Z'), leaseToken: 'crashed-worker-token',
    };
    const { db } = database(crashedJob);

    const [claimed] = await claimOutboundDeliveries(db, 7, 45_000);

    const query = vi.mocked(db.$queryRaw).mock.calls[0][0] as { strings: readonly string[]; values: readonly unknown[] };
    const sql = query.strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toContain(`"status" IN ('QUEUED', 'SENDING')`);
    expect(sql).toContain(`"leasedUntil" IS NULL OR "leasedUntil" < CURRENT_TIMESTAMP`);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).not.toMatch(/SET[^]*"attempts"/);
    expect(query.values).toContain(7);
    expect(query.values).toContain(45_000);
    expect(claimed).toMatchObject({ id: 'delivery-1', attempts: 3 });
    expect(claimed.leaseToken).not.toBe('crashed-worker-token');
  });

  it('retries transient errors without storing their message', async () => {
    const { db, updateMany } = database(job);
    const provider: EmailProvider = { kind: 'resend', send: vi.fn(async () => { throw new EmailProviderError('secret body', 'RESEND_HTTP_503', true); }) };
    await processOutboundDeliveries({ provider, from: { email: 'updates@courtly.test', name: 'Courtly' }, db, now: () => new Date('2026-09-28T00:00:00Z'), random: () => 0.5 });
    const data = updateMany.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'QUEUED', lastErrorCode: 'RESEND_HTTP_503', lastErrorAt: new Date('2026-09-28T00:00:00Z') });
    expect(JSON.stringify(data)).not.toContain('secret body');
  });
});
