import { describe, expect, it, vi } from 'vitest';
import { isDeliverableEmail, normalizedRecipient, queueOutboundEmail, type OutboundTransaction } from '../src/outbound-events.js';

function transaction(preference: Record<string, boolean> | null = null) {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => args.data);
  const findUnique = vi.fn(async () => preference);
  return { tx: { outboundDelivery: { create }, notificationPreference: { findUnique } } as OutboundTransaction, create };
}

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
});
