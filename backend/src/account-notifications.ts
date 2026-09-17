import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError } from './http.js';

export const accountRouter = Router();
export type BookingAccountAlert =
  | 'CREATED'
  | 'REQUESTED'
  | 'CONFIRMED'
  | 'PENDING'
  | 'COMPLETED'
  | 'PROVIDER_CANCELLED'
  | 'CUSTOMER_CANCELLED'
  | 'RESCHEDULED';

type Tx = Prisma.TransactionClient;

const accountNotificationInclude = {
  business: { select: { name: true, slug: true } },
} satisfies Prisma.AccountNotificationInclude;

type FullAccountNotification = Prisma.AccountNotificationGetPayload<{ include: typeof accountNotificationInclude }>;

export const accountNotificationJson = (notification: FullAccountNotification) => ({
  id: notification.id,
  userId: notification.userId,
  businessId: notification.businessId,
  bookingId: notification.bookingId,
  type: notification.type,
  title: notification.title,
  message: notification.message,
  read: notification.read,
  actionNeeded: notification.actionNeeded,
  createdAt: notification.createdAt.toISOString(),
  business: notification.business
    ? { name: notification.business.name, slug: notification.business.slug }
    : null,
});

/**
 * Persist an account-scoped booking alert. Callers can provide explicit users
 * for a new group enrollment or customer cancellation; otherwise every active
 * account-backed participant receives the event exactly once.
 */
export async function createBookingAccountAlerts(
  tx: Tx,
  bookingId: string,
  event: BookingAccountAlert,
  explicitUserIds?: Array<string | null | undefined>,
) {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: {
      id: true, businessId: true, startAt: true, status: true,
      business: { select: { name: true, timezone: true } },
      service: { select: { name: true } },
      instructor: { select: { name: true } },
      location: { select: { name: true } },
      participants: {
        where: { cancelledAt: null },
        select: { customer: { select: { userId: true } } },
      },
    },
  });
  const userIds = [...new Set((explicitUserIds
    ?? booking.participants.map(participant => participant.customer.userId))
    .filter((userId): userId is string => typeof userId === 'string'))];
  if (!userIds.length) return 0;

  const when = DateTime.fromJSDate(booking.startAt, { zone: booking.business.timezone })
    .setLocale('en-SG')
    .toFormat("ccc, d LLL yyyy 'at' h:mm a");
  const lesson = `${booking.service.name} with ${booking.instructor.name} at ${booking.location.name}`;
  const reschedulePending = booking.status === 'PENDING';
  const copy: Record<BookingAccountAlert, { type: string; title: string; message: string; actionNeeded: boolean }> = {
    CREATED: {
      type: 'BOOKING_CREATED', title: 'Booking confirmed',
      message: `${lesson} is confirmed for ${when}.`, actionNeeded: false,
    },
    REQUESTED: {
      type: 'BOOKING_REQUESTED', title: 'Booking request received',
      message: `${lesson} was requested for ${when} and is awaiting confirmation from ${booking.business.name}.`, actionNeeded: false,
    },
    CONFIRMED: {
      type: 'BOOKING_CONFIRMED', title: 'Booking confirmed',
      message: `${booking.business.name} confirmed ${lesson} for ${when}.`, actionNeeded: false,
    },
    PENDING: {
      type: 'BOOKING_PENDING', title: 'Booking awaiting confirmation',
      message: `${booking.business.name} marked ${lesson} for ${when} as pending confirmation. No action is needed from you while they review it.`, actionNeeded: false,
    },
    COMPLETED: {
      type: 'BOOKING_COMPLETED', title: 'Session completed',
      message: `${lesson}, scheduled for ${when}, was marked complete.`, actionNeeded: false,
    },
    PROVIDER_CANCELLED: {
      type: 'BOOKING_CANCELLED', title: 'Booking cancelled',
      message: `${booking.business.name} cancelled ${lesson}, previously scheduled for ${when}.`, actionNeeded: true,
    },
    CUSTOMER_CANCELLED: {
      type: 'BOOKING_CANCELLED', title: 'Booking cancelled',
      message: `You cancelled ${lesson}, previously scheduled for ${when}.`, actionNeeded: false,
    },
    RESCHEDULED: {
      type: 'BOOKING_RESCHEDULED',
      title: reschedulePending ? 'Booking rescheduled · confirmation pending' : 'Booking rescheduled',
      message: reschedulePending
        ? `${lesson} was rescheduled to ${when} and is awaiting venue confirmation from ${booking.business.name}. No action is needed from you while the venue is confirmed.`
        : `${lesson} was rescheduled to ${when}. Please review the updated time.`,
      actionNeeded: !reschedulePending,
    },
  };
  const alert = copy[event];
  const result = await tx.accountNotification.createMany({
    data: userIds.map(userId => ({
      userId, businessId: booking.businessId, bookingId: booking.id, ...alert,
    })),
  });
  return result.count;
}

accountRouter.get('/notifications', asyncRoute(async (req, res) => {
  const notifications = await prisma.accountNotification.findMany({
    where: { userId: req.auth.user.id },
    include: accountNotificationInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  res.json({ notifications: notifications.map(accountNotificationJson) });
}));

const notificationId = z.string().trim().min(1).max(200);
accountRouter.patch('/notifications/read', asyncRoute(async (req, res) => {
  const input = z.object({ ids: z.array(notificationId).max(1000).optional() }).strict().parse(req.body ?? {});
  const count = await prisma.$transaction(async tx => {
    const ids = input.ids ? [...new Set(input.ids)] : undefined;
    if (ids) {
      const accessible = await tx.accountNotification.count({
        where: { userId: req.auth.user.id, id: { in: ids } },
      });
      if (accessible !== ids.length) throw new HttpError(404, 'Notification not found or inaccessible');
    }
    const result = await tx.accountNotification.updateMany({
      where: {
        userId: req.auth.user.id, read: false,
        ...(ids ? { id: { in: ids } } : {}),
      },
      data: { read: true },
    });
    return result.count;
  });
  res.json({ ok: true, count });
}));
