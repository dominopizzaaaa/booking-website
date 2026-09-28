import type { TransactionalEmailEvent } from './email-templates.js';

export type OutboundTransaction = {
  outboundDelivery: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  notificationPreference?: { findUnique(args: { where: { userId: string } }): Promise<{ emailTransactionalEnabled?: boolean; emailReminderEnabled?: boolean; emailActionNeededEnabled?: boolean } | null> };
};

export type QueueEmailInput = {
  eventType: TransactionalEmailEvent; dedupeKey: string; recipientEmail: string; recipientName: string;
  recipientUserId?: string | null; businessId?: string | null; bookingId?: string | null;
  notificationId?: string | null; accountNotificationId?: string | null; title: string; message: string;
  actionUrl?: string; actionLabel?: string; actionNeeded?: boolean; category?: 'TRANSACTIONAL' | 'REMINDER';
};

export function normalizedRecipient(email: string) { return email.trim().toLowerCase(); }
export function isDeliverableEmail(email: string) {
  const value = normalizedRecipient(email);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && !value.endsWith('.invalid');
}

export async function queueOutboundEmail(tx: OutboundTransaction, input: QueueEmailInput) {
  const email = normalizedRecipient(input.recipientEmail);
  let suppressed = !isDeliverableEmail(email);
  let suppressionCode = suppressed ? 'INVALID_RECIPIENT' : null;
  if (!suppressed && input.recipientUserId && tx.notificationPreference) {
    const preference = await tx.notificationPreference.findUnique({ where: { userId: input.recipientUserId } });
    const permitted = input.category === 'REMINDER'
      ? preference?.emailReminderEnabled !== false
      : input.actionNeeded
        ? preference?.emailActionNeededEnabled !== false
        : preference?.emailTransactionalEnabled !== false;
    if (!permitted) { suppressed = true; suppressionCode = 'USER_PREFERENCE'; }
  }
  return tx.outboundDelivery.create({ data: {
    channel: 'EMAIL', eventType: input.eventType, eventVersion: 1, dedupeKey: input.dedupeKey,
    recipientKey: email, recipientUserId: input.recipientUserId ?? null, recipientEmail: email,
    recipientName: input.recipientName.trim(), businessId: input.businessId ?? null, bookingId: input.bookingId ?? null,
    notificationId: input.notificationId ?? null, accountNotificationId: input.accountNotificationId ?? null,
    template: 'transactional-v1', payload: { title: input.title, message: input.message, actionUrl: input.actionUrl, actionLabel: input.actionLabel },
    status: suppressed ? 'SUPPRESSED' : 'QUEUED', ...(suppressionCode ? { lastErrorCode: suppressionCode } : {}),
  } });
}
