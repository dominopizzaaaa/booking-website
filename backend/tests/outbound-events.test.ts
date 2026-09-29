import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { enqueueFamilyHandoverSecurityEmail, isDeliverableEmail, normalizedRecipient, queueOutboundEmail, type OutboundTransaction } from '../src/outbound-events.js';

function transaction(preference: Record<string, boolean | Date | null> | null = null) {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => args.data);
  const findUnique = vi.fn(async () => preference);
  return { tx: { outboundDelivery: { create }, notificationPreference: { findUnique } } as OutboundTransaction, create };
}

const emailEnabled = config.email.enabled;
afterEach(() => { config.email.enabled = emailEnabled; });

describe('outbound event queue', () => {
  it('normalizes recipients and queues a minimal versioned snapshot', async () => {
    const { tx, create } = transaction();
    await queueOutboundEmail(tx, { eventType: 'BOOKING_CONFIRMED', dedupeKey: 'booking:b1:confirmed:u1', recipientEmail: ' Student@Example.Test ', recipientName: ' Avery ', recipientUserId: 'u1', businessId: 'club-1', bookingId: 'b1', title: 'Confirmed', message: 'Your class is confirmed.' });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ recipientEmail: 'student@example.test', recipientKey: 'student@example.test', recipientName: 'Avery', status: 'QUEUED', eventVersion: 1 }) });
  });

  it('suppresses invalid placeholders and user-disabled reminders', async () => {
    expect(isDeliverableEmail('seed@example.invalid')).toBe(false);
    expect(normalizedRecipient(' A@EXAMPLE.COM ')).toBe('a@example.com');
    const invalid = transaction();
    await queueOutboundEmail(invalid.tx, { eventType: 'COACH_INVITED', dedupeKey: 'invite:1', recipientEmail: 'seed@example.invalid', recipientName: 'Seed', title: 'Invite', message: 'Join.' });
    expect(invalid.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'SUPPRESSED', lastErrorCode: 'INVALID_RECIPIENT' }) });
    const disabled = transaction({ emailReminderEnabled: false });
    await queueOutboundEmail(disabled.tx, { eventType: 'BOOKING_REMINDER', category: 'REMINDER', dedupeKey: 'reminder:b1:start:u1', recipientEmail: 'student@example.com', recipientName: 'Avery', recipientUserId: 'u1', title: 'Tomorrow', message: 'Reminder.' });
    expect(disabled.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'SUPPRESSED', lastErrorCode: 'USER_PREFERENCE' }) });
  });

  it.each([
    ['an unbound recipient', null, undefined],
    ['an account with no preference row', null, 'u1'],
    ['an opted-out account', { emailMarketingEnabled: false }, 'u2'],
    ['an opted-in account', { emailMarketingEnabled: true }, 'u3'],
  ] as const)('hard-suppresses marketing for %s', async (_description, preference, recipientUserId) => {
    const { tx, create } = transaction(preference);
    await queueOutboundEmail(tx, {
      eventType: 'COACH_INVITED', category: 'MARKETING',
      dedupeKey: 'marketing:blocked',
      recipientEmail: 'student@example.com', recipientName: 'Avery', recipientUserId,
      title: 'New programme', message: 'See what is new.',
    });

    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      status: 'SUPPRESSED', lastErrorCode: 'MARKETING_DISABLED',
    }) });
    expect(tx.notificationPreference.findUnique).not.toHaveBeenCalled();
  });

  it('queues a durable family-handover security event without requiring a recipient user', async () => {
    config.email.enabled = true;
    const { tx, create } = transaction();
    const expiresAt = new Date('2026-10-02T09:30:00.000Z');

    await enqueueFamilyHandoverSecurityEmail(tx, {
      handoverId: 'handover-1', recipientEmail: ' Guardian@Example.com ', recipientName: ' Rowan ',
      tokenKeyId: 'key-1', expiresAt,
    });

    expect(tx.notificationPreference?.findUnique).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      eventType: 'FAMILY_HANDOVER_SECURITY', template: 'family-handover-security-v1',
      dedupeKey: 'family-handover:handover-1:security-claim',
      recipientEmail: 'guardian@example.com', recipientUserId: null, status: 'QUEUED',
      payload: {
        handoverId: 'handover-1',
        tokenKeyId: 'key-1',
        expiresAt: expiresAt.toISOString(),
      },
    }) });
    const persisted = JSON.stringify(create.mock.calls[0]?.[0]);
    expect(persisted).not.toContain('token=');
    expect(persisted).not.toContain('claimUrl');
    expect(persisted).not.toContain('actionUrl');
  });

  it('bypasses optional preferences for security mail but obeys hard suppression', async () => {
    config.email.enabled = true;
    const optedOut = transaction({
      emailTransactionalEnabled: false, emailReminderEnabled: false,
      emailActionNeededEnabled: false, emailMarketingEnabled: false,
    });
    const input = {
      handoverId: 'handover-2', recipientEmail: 'guardian@example.com', recipientName: 'Guardian',
      recipientUserId: 'guardian-1', tokenKeyId: 'key-1',
      expiresAt: new Date('2026-10-03T00:00:00.000Z'),
    };
    await enqueueFamilyHandoverSecurityEmail(optedOut.tx, input);
    expect(optedOut.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'QUEUED' }) });

    const hardSuppressed = transaction({ emailSuppressedAt: new Date('2026-09-01T00:00:00.000Z') });
    await enqueueFamilyHandoverSecurityEmail(hardSuppressed.tx, input);
    expect(hardSuppressed.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      status: 'SUPPRESSED', lastErrorCode: 'HARD_SUPPRESSION',
    }) });
  });

  it('does not create a delivery when the email provider is disabled', async () => {
    config.email.enabled = false;
    const { tx, create } = transaction();
    const result = await enqueueFamilyHandoverSecurityEmail(tx, {
      handoverId: 'handover-disabled', recipientEmail: 'guardian@example.com', recipientName: 'Guardian',
      tokenKeyId: 'key-1',
      expiresAt: new Date('2026-10-03T00:00:00.000Z'),
    });
    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(tx.notificationPreference?.findUnique).not.toHaveBeenCalled();
  });
});
