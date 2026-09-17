import type { Prisma } from '@prisma/client';

/**
 * The shared alert vocabulary for both audiences.
 *
 * Provider `Notification` rows and customer `AccountNotification` rows are
 * stored separately on purpose, but they are read by the same kind of person
 * doing the same kind of triage, so they draw their `type` from one list. The
 * frontend maps each value to an icon; an unknown value falls back to NOTICE
 * rather than breaking, which keeps old rows readable after a deploy.
 */
export const notificationTypes = [
  'BOOKING',
  'PAYMENT',
  'PAYOUT',
  'RESCHEDULE',
  'CANCELLATION',
  'PENDING_ACTION',
  'INTEGRITY',
  'ATTENDANCE',
  'NOTICE',
] as const;

export type NotificationType = (typeof notificationTypes)[number];

type Tx = Prisma.TransactionClient;

type ProviderAlert = {
  businessId: string;
  instructorId?: string | null;
  bookingId?: string | null;
  type: NotificationType;
  title: string;
  message: string;
  actionNeeded?: boolean;
};

/**
 * Write one workspace alert. Every provider-facing alert goes through here so
 * that a type is always supplied; the untyped default in the schema exists
 * only for rows written before typed alerts shipped.
 */
export function notifyWorkspace(tx: Tx, alert: ProviderAlert) {
  return tx.notification.create({
    data: {
      businessId: alert.businessId,
      instructorId: alert.instructorId ?? null,
      bookingId: alert.bookingId ?? null,
      type: alert.type,
      title: alert.title,
      message: alert.message,
      actionNeeded: alert.actionNeeded ?? false,
    },
  });
}
