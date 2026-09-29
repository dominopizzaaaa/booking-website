import { describe, expect, it, vi } from 'vitest';
import { CaptureEmailProvider, EmailProviderError, type EmailProvider } from '../src/email-provider.js';
import { config } from '../src/config.js';
import { deriveEmailVerificationToken, emailVerificationTokenDigest } from '../src/email-verification-token.js';
import { deriveFamilyHandoverToken, familyHandoverTokenDigest } from '../src/family-handover-token.js';
import { claimOutboundDeliveries, processOutboundDeliveries, retryDelayMs, type DeliveryDb } from '../src/outbound-worker.js';

function database(job: Record<string, unknown>) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const handoverFindUnique = vi.fn(async () => null);
  const verificationFindUnique = vi.fn(async () => null);
  return {
    db: {
      $queryRaw: vi.fn(async () => [job]),
      outboundDelivery: { updateMany },
      childAccountHandover: { findUnique: handoverFindUnique },
      emailVerificationClaim: { findUnique: verificationFindUnique },
    } as unknown as DeliveryDb,
    updateMany,
    findUnique: handoverFindUnique,
    verificationFindUnique,
  };
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

  it('reconstructs a valid handover claim URL without a persisted bearer token', async () => {
    const keyId = 'handover-test';
    const key = Buffer.alloc(32, 19);
    const handoverId = 'handover-123';
    const expiresAt = new Date('2030-10-02T09:30:00.000Z');
    const token = deriveFamilyHandoverToken(handoverId, keyId, { keys: new Map([[keyId, key]]) });
    const original = {
      activeKeyId: config.familyHandoverTokens.activeKeyId,
      keys: config.familyHandoverTokens.keys,
    };
    config.familyHandoverTokens.activeKeyId = keyId;
    config.familyHandoverTokens.keys = new Map([[keyId, key]]);
    try {
      const secureJob = {
        ...job, eventType: 'FAMILY_HANDOVER_SECURITY', recipientEmail: 'child@example.test',
        payload: { handoverId, tokenKeyId: keyId, expiresAt: expiresAt.toISOString() },
      };
      const { db, findUnique } = database(secureJob);
      findUnique.mockResolvedValue({
        status: 'PENDING', expiresAt, destinationEmail: 'child@example.test',
        tokenHash: familyHandoverTokenDigest(token),
      });
      const provider = new CaptureEmailProvider();
      await processOutboundDeliveries({
        provider, from: { email: 'updates@courtly.test', name: 'Courtly' }, db,
        now: () => new Date('2029-10-02T09:30:00.000Z'),
      });
      expect(provider.messages[0]?.text).toContain(encodeURIComponent(token));
      expect(JSON.stringify(secureJob)).not.toContain(token);
      expect(JSON.stringify(secureJob)).not.toContain('claimUrl');
    } finally {
      config.familyHandoverTokens.activeKeyId = original.activeKeyId;
      config.familyHandoverTokens.keys = original.keys;
    }
  });

  it('suppresses a handover delivery whose live request is no longer pending', async () => {
    const secureJob = {
      ...job, eventType: 'FAMILY_HANDOVER_SECURITY',
      payload: { handoverId: 'handover-closed', tokenKeyId: 'old', expiresAt: '2030-10-02T09:30:00.000Z' },
    };
    const { db, updateMany, findUnique } = database(secureJob);
    findUnique.mockResolvedValue({
      status: 'CANCELLED', expiresAt: new Date('2030-10-02T09:30:00.000Z'),
      destinationEmail: secureJob.recipientEmail, tokenHash: '0'.repeat(64),
    });
    const provider = new CaptureEmailProvider();
    await processOutboundDeliveries({ provider, from: { email: 'updates@courtly.test', name: 'Courtly' }, db });
    expect(provider.messages).toHaveLength(0);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'SUPPRESSED', lastErrorCode: 'HANDOVER_UNAVAILABLE' }),
    }));
  });

  it('reconstructs a valid email-verification URL without persisting the bearer token', async () => {
    const tokenKeyId = 'verification-v2';
    const keyring = { enabled: true, keys: new Map([[tokenKeyId, Buffer.alloc(32, 27)]]) };
    const claimId = 'verification-123';
    const expiresAt = new Date('2030-10-02T09:30:00.000Z');
    const token = deriveEmailVerificationToken(claimId, tokenKeyId, keyring);
    const verificationJob = {
      ...job, eventType: 'EMAIL_VERIFICATION', recipientEmail: 'student@example.test',
      payload: { claimId, tokenKeyId, expiresAt: expiresAt.toISOString() },
    };
    const { db, updateMany, verificationFindUnique } = database(verificationJob);
    verificationFindUnique.mockResolvedValue({
      email: verificationJob.recipientEmail, expiresAt,
      tokenHash: emailVerificationTokenDigest(token), tokenKeyId, consumedAt: null, revokedAt: null,
    });
    const provider = new CaptureEmailProvider();

    const configurable = config as typeof config & { emailVerificationTokens: { enabled: boolean; activeKeyId: string; keys: Map<string, Buffer> } };
    const original = configurable.emailVerificationTokens;
    configurable.emailVerificationTokens = { enabled: true, activeKeyId: tokenKeyId, ...keyring };
    try {
      await processOutboundDeliveries({
        provider, from: { email: 'updates@courtly.test', name: 'Courtly' }, db,
        now: () => new Date('2029-10-02T09:30:00.000Z'),
      });
    } finally {
      configurable.emailVerificationTokens = original;
    }

    expect(provider.messages).toHaveLength(1);
    expect(provider.messages[0]?.text).toContain('/account/verify-email#token=');
    expect(provider.messages[0]?.text).toContain(encodeURIComponent(token));
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'ACCEPTED' }),
    }));
    expect(JSON.stringify(verificationJob)).not.toContain(token);
    expect(JSON.stringify(verificationJob)).not.toContain('verificationUrl');
  });

  it.each([
    ['expired', {
      expiresAt: new Date('2029-10-02T09:30:00.000Z'), consumedAt: null, revokedAt: null,
      email: 'student@example.test',
    }],
    ['consumed', {
      expiresAt: new Date('2030-10-02T09:30:00.000Z'), consumedAt: new Date('2029-09-01T00:00:00.000Z'),
      revokedAt: null, email: 'student@example.test',
    }],
    ['revoked', {
      expiresAt: new Date('2030-10-02T09:30:00.000Z'), consumedAt: null,
      revokedAt: new Date('2029-09-01T00:00:00.000Z'), email: 'student@example.test',
    }],
    ['address-mismatched', {
      expiresAt: new Date('2030-10-02T09:30:00.000Z'), consumedAt: null, revokedAt: null,
      email: 'different@example.test',
    }],
  ] as const)('suppresses an %s email-verification claim before provider dispatch', async (state, claim) => {
    const tokenKeyId = config.emailVerificationTokens.activeKeyId;
    const claimId = 'verification-' + state;
    const verificationJob = {
      ...job, eventType: 'EMAIL_VERIFICATION', recipientEmail: 'student@example.test',
      payload: { claimId, tokenKeyId, expiresAt: claim.expiresAt.toISOString() },
    };
    const { db, updateMany, verificationFindUnique } = database(verificationJob);
    verificationFindUnique.mockResolvedValue({
      ...claim,
      tokenHash: emailVerificationTokenDigest(deriveEmailVerificationToken(claimId)), tokenKeyId,
    });
    const provider = new CaptureEmailProvider();

    await processOutboundDeliveries({
      provider, from: { email: 'updates@courtly.test', name: 'Courtly' }, db,
      now: () => new Date('2029-10-02T09:30:00.000Z'),
    });

    expect(provider.messages).toHaveLength(0);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'SUPPRESSED', lastErrorCode: 'EMAIL_VERIFICATION_UNAVAILABLE',
      }),
    }));
  });

  it('suppresses an email-verification claim whose derived token digest does not match', async () => {
    const tokenKeyId = 'verification-mismatch-v1';
    const original = config.emailVerificationTokens;
    config.emailVerificationTokens = {
      enabled: true, activeKeyId: tokenKeyId,
      keys: new Map([[tokenKeyId, Buffer.alloc(32, 29)]]),
    };
    const claimId = 'verification-digest-mismatch';
    const expiresAt = new Date('2030-10-02T09:30:00.000Z');
    const verificationJob = {
      ...job, eventType: 'EMAIL_VERIFICATION', recipientEmail: 'student@example.test',
      payload: { claimId, tokenKeyId, expiresAt: expiresAt.toISOString() },
    };
    const { db, updateMany, verificationFindUnique } = database(verificationJob);
    verificationFindUnique.mockResolvedValue({
      email: verificationJob.recipientEmail, expiresAt,
      tokenHash: '0'.repeat(64), tokenKeyId, consumedAt: null, revokedAt: null,
    });
    const provider = new CaptureEmailProvider();

    try {
      await processOutboundDeliveries({
        provider, from: { email: 'updates@courtly.test', name: 'Courtly' }, db,
        now: () => new Date('2029-10-02T09:30:00.000Z'),
      });
    } finally { config.emailVerificationTokens = original; }

    expect(provider.messages).toHaveLength(0);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'SUPPRESSED', lastErrorCode: 'EMAIL_VERIFICATION_TOKEN_MISMATCH',
      }),
    }));
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
