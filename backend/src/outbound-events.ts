import type { TransactionalEmailEvent } from './email-templates.js';
import { config } from './config.js';

export type OutboundTransaction = {
  outboundDelivery: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  notificationPreference: { findUnique(args: { where: { userId: string } }): Promise<{
    emailTransactionalEnabled?: boolean; emailReminderEnabled?: boolean;
    emailActionNeededEnabled?: boolean; emailMarketingEnabled?: boolean;
    emailSuppressedAt?: Date | null;
  } | null> };
};

type QueueEmailBase = {
  dedupeKey: string; recipientEmail: string; recipientName: string;
  recipientUserId?: string | null; businessId?: string | null; bookingId?: string | null;
  notificationId?: string | null; accountNotificationId?: string | null; title: string; message: string;
  actionUrl?: string; actionLabel?: string; actionNeeded?: boolean;
};

export type QueueEmailInput = QueueEmailBase & {
  eventType: TransactionalEmailEvent;
  category?: 'TRANSACTIONAL' | 'REMINDER' | 'MARKETING' | 'SECURITY';
};

export type FamilyHandoverSecurityEmailInput = {
  handoverId: string;
  tokenKeyId: string;
  recipientEmail: string;
  recipientName: string;
  expiresAt: Date;
  recipientUserId?: string | null;
};

export type EmailVerificationSecurityEmailInput = {
  claimId: string;
  tokenKeyId: string;
  recipientEmail: string;
  recipientName: string;
  recipientUserId: string;
  expiresAt: Date;
};

type AccountSecurityClaimEmailInput = {
  claimId: string; tokenKeyId: string; recipientEmail: string; recipientName: string;
  recipientUserId: string; expiresAt: Date;
};

export function normalizedRecipient(email: string) { return email.trim().toLowerCase(); }
export function isDeliverableEmail(email: string) {
  const value = normalizedRecipient(email);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && !value.endsWith('.invalid');
}

export async function queueOutboundEmail(tx: OutboundTransaction, input: QueueEmailInput) {
  if ((input.eventType as TransactionalEmailEvent) === 'FAMILY_HANDOVER_SECURITY') {
    throw new TypeError('Family handover security mail must use its non-secret queue helper');
  }
  if (['PASSWORD_RESET', 'EMAIL_CHANGE_VERIFICATION'].includes(input.eventType)) {
    throw new TypeError('Bearer-bearing account security mail must use its non-secret queue helper');
  }
  // Security mail is mandatory when delivery is configured, but it must not
  // manufacture a queued record in deployments with no sending provider.
  if (input.category === 'SECURITY' && !config.email.enabled) return null;
  const email = normalizedRecipient(input.recipientEmail);
  let suppressed = input.category === 'MARKETING' && !config.marketingEnabled;
  let suppressionCode = suppressed ? 'MARKETING_DISABLED' : null;
  if (!suppressed && !isDeliverableEmail(email)) {
    suppressed = true;
    suppressionCode = 'INVALID_RECIPIENT';
  }
  if (!suppressed && input.recipientUserId) {
    const preference = await tx.notificationPreference.findUnique({ where: { userId: input.recipientUserId } });
    if (preference?.emailSuppressedAt) {
      suppressed = true; suppressionCode = 'HARD_SUPPRESSION';
    } else if (input.category !== 'SECURITY') {
      const permitted = input.category === 'REMINDER'
        ? preference?.emailReminderEnabled !== false
        : input.category === 'MARKETING'
          ? preference?.emailMarketingEnabled === true
          : input.actionNeeded
            ? preference?.emailActionNeededEnabled !== false
            : preference?.emailTransactionalEnabled !== false;
      if (!permitted) { suppressed = true; suppressionCode = 'USER_PREFERENCE'; }
    }
  }
  return tx.outboundDelivery.create({ data: {
    channel: 'EMAIL', eventType: input.eventType, eventVersion: 1, dedupeKey: input.dedupeKey,
    recipientKey: email, recipientUserId: input.recipientUserId ?? null, recipientEmail: email,
    recipientName: input.recipientName.trim(), businessId: input.businessId ?? null, bookingId: input.bookingId ?? null,
    notificationId: input.notificationId ?? null, accountNotificationId: input.accountNotificationId ?? null,
    template: 'transactional-v1',
    payload: { title: input.title, message: input.message, actionUrl: input.actionUrl, actionLabel: input.actionLabel },
    status: suppressed ? 'SUPPRESSED' : 'QUEUED', ...(suppressionCode ? { lastErrorCode: suppressionCode } : {}),
  } });
}

export async function enqueueFamilyHandoverSecurityEmail(
  tx: OutboundTransaction,
  input: FamilyHandoverSecurityEmailInput,
) {
  if (!config.email.enabled) return null;
  const expiresAt = input.expiresAt.toISOString();
  const email = normalizedRecipient(input.recipientEmail);
  let suppressed = !isDeliverableEmail(email);
  let suppressionCode = suppressed ? 'INVALID_RECIPIENT' : null;
  if (!suppressed && input.recipientUserId) {
    const preference = await tx.notificationPreference.findUnique({ where: { userId: input.recipientUserId } });
    if (preference?.emailSuppressedAt) {
      suppressed = true;
      suppressionCode = 'HARD_SUPPRESSION';
    }
  }
  return tx.outboundDelivery.create({ data: {
    channel: 'EMAIL', eventType: 'FAMILY_HANDOVER_SECURITY', eventVersion: 1,
    dedupeKey: `family-handover:${input.handoverId}:security-claim`,
    recipientKey: email, recipientUserId: input.recipientUserId ?? null, recipientEmail: email,
    recipientName: input.recipientName.trim(), businessId: null, bookingId: null,
    notificationId: null, accountNotificationId: null, template: 'family-handover-security-v1',
    // Only non-secret derivation inputs are durable. The worker reconstructs
    // the bearer link in memory immediately before provider dispatch.
    payload: { handoverId: input.handoverId, tokenKeyId: input.tokenKeyId, expiresAt },
    status: suppressed ? 'SUPPRESSED' : 'QUEUED',
    ...(suppressionCode ? { lastErrorCode: suppressionCode } : {}),
  } });
}

export async function enqueueEmailVerificationSecurityEmail(
  tx: OutboundTransaction,
  input: EmailVerificationSecurityEmailInput,
) {
  if (!config.email.enabled) return null;
  const email = normalizedRecipient(input.recipientEmail);
  let suppressed = !isDeliverableEmail(email);
  let suppressionCode = suppressed ? 'INVALID_RECIPIENT' : null;
  if (!suppressed) {
    const preference = await tx.notificationPreference.findUnique({ where: { userId: input.recipientUserId } });
    if (preference?.emailSuppressedAt) {
      suppressed = true;
      suppressionCode = 'HARD_SUPPRESSION';
    }
  }
  return tx.outboundDelivery.create({ data: {
    channel: 'EMAIL', eventType: 'EMAIL_VERIFICATION', eventVersion: 1,
    dedupeKey: `email-verification:${input.claimId}`,
    recipientKey: email, recipientUserId: input.recipientUserId, recipientEmail: email,
    recipientName: input.recipientName.trim(), businessId: null, bookingId: null,
    notificationId: null, accountNotificationId: null, template: 'email-verification-v1',
    // The worker derives the bearer from this non-secret claim ID immediately
    // before sending. No verification token is stored in the database.
    payload: { claimId: input.claimId, tokenKeyId: input.tokenKeyId, expiresAt: input.expiresAt.toISOString() },
    status: suppressed ? 'SUPPRESSED' : 'QUEUED',
    ...(suppressionCode ? { lastErrorCode: suppressionCode } : {}),
  } });
}

async function enqueueAccountSecurityClaimEmail(
  tx: OutboundTransaction,
  input: AccountSecurityClaimEmailInput,
  kind: 'password-reset' | 'email-change',
) {
  if (!config.email.enabled) return null;
  const email = normalizedRecipient(input.recipientEmail);
  let suppressed = !isDeliverableEmail(email);
  let suppressionCode = suppressed ? 'INVALID_RECIPIENT' : null;
  if (!suppressed) {
    const preference = await tx.notificationPreference.findUnique({ where: { userId: input.recipientUserId } });
    if (preference?.emailSuppressedAt) { suppressed = true; suppressionCode = 'HARD_SUPPRESSION'; }
  }
  const eventType = kind === 'password-reset' ? 'PASSWORD_RESET' : 'EMAIL_CHANGE_VERIFICATION';
  return tx.outboundDelivery.create({ data: {
    channel: 'EMAIL', eventType, eventVersion: 1,
    dedupeKey: `${kind}:${input.claimId}`, recipientKey: email,
    recipientUserId: input.recipientUserId, recipientEmail: email,
    recipientName: input.recipientName.trim(), businessId: null, bookingId: null,
    notificationId: null, accountNotificationId: null, template: `${kind}-v1`,
    payload: { claimId: input.claimId, tokenKeyId: input.tokenKeyId, expiresAt: input.expiresAt.toISOString() },
    status: suppressed ? 'SUPPRESSED' : 'QUEUED',
    ...(suppressionCode ? { lastErrorCode: suppressionCode } : {}),
  } });
}

export const enqueuePasswordResetSecurityEmail = (tx: OutboundTransaction, input: AccountSecurityClaimEmailInput) =>
  enqueueAccountSecurityClaimEmail(tx, input, 'password-reset');

export const enqueueEmailChangeSecurityEmail = (tx: OutboundTransaction, input: AccountSecurityClaimEmailInput) =>
  enqueueAccountSecurityClaimEmail(tx, input, 'email-change');
