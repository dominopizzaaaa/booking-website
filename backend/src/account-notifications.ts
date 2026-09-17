import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError } from './http.js';
import { editablePersonalProfile, updatePersonalProfile } from './account-profile.js';
import { authState } from './serializers.js';

export const accountRouter = Router();
export type BookingAccountAlert =
  | 'CREATED'
  | 'REQUESTED'
  | 'CONFIRMED'
  | 'PENDING'
  | 'COMPLETED'
  | 'PROVIDER_CANCELLED'
  | 'STUDENT_CANCELLED'
  | 'RESCHEDULED'
  | 'CLUB_ASSIGNED'
  | 'COACH_ACCEPTED'
  | 'COACH_DECLINED'
  | 'RESCHEDULE_REQUESTED'
  | 'RESCHEDULE_ACCEPTED'
  | 'RESCHEDULE_DECLINED'
  | 'RESCHEDULE_WITHDRAWN'
  | 'PAYMENT_RECORDED'
  | 'PAYMENT_REVERSED';

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
 * for a new group enrollment or student cancellation; otherwise every active
 * account-backed participant receives the event exactly once.
 */
export async function createBookingAccountAlerts(
  tx: Tx,
  bookingId: string,
  event: BookingAccountAlert,
  explicitUserIds?: Array<string | null | undefined>,
  // A reschedule request talks about a time the booking does not hold yet, so
  // the caller can supply the instant the copy should describe.
  options: { whenAt?: Date } = {},
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
        select: { student: { select: { userId: true } } },
      },
    },
  });
  const userIds = [...new Set((explicitUserIds
    ?? booking.participants.map(participant => participant.student.userId))
    .filter((userId): userId is string => typeof userId === 'string'))];
  if (!userIds.length) return 0;

  const when = DateTime.fromJSDate(options.whenAt ?? booking.startAt, { zone: booking.business.timezone })
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
    STUDENT_CANCELLED: {
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
    CLUB_ASSIGNED: {
      type: 'BOOKING_ASSIGNED', title: 'Your club booked a lesson for you',
      message: `${booking.business.name} scheduled ${lesson} for ${when}. Your coach is confirming it; nothing is needed from you.`,
      actionNeeded: false,
    },
    COACH_ACCEPTED: {
      type: 'BOOKING_CONFIRMED', title: 'Your coach confirmed the lesson',
      message: `${lesson} on ${when} is confirmed.`, actionNeeded: false,
    },
    COACH_DECLINED: {
      type: 'BOOKING_CANCELLED', title: 'Your coach could not take this lesson',
      message: `${lesson} on ${when} was declined by the coach. ${booking.business.name} will arrange an alternative.`,
      actionNeeded: true,
    },
    RESCHEDULE_REQUESTED: {
      type: 'RESCHEDULE_REQUESTED', title: 'A new time was proposed',
      message: `${booking.business.name} asked to move ${lesson} to ${when}. Accept or decline the proposed time.`,
      actionNeeded: true,
    },
    RESCHEDULE_ACCEPTED: {
      type: 'RESCHEDULE_ACCEPTED', title: 'Your reschedule request was accepted',
      message: `${lesson} now takes place on ${when}.`, actionNeeded: false,
    },
    RESCHEDULE_DECLINED: {
      type: 'RESCHEDULE_DECLINED', title: 'Your reschedule request was declined',
      message: `${lesson} keeps its original time. Contact ${booking.business.name} to find another option.`,
      actionNeeded: true,
    },
    RESCHEDULE_WITHDRAWN: {
      type: 'RESCHEDULE_WITHDRAWN', title: 'A reschedule request was withdrawn',
      message: `The proposed new time for ${lesson} was withdrawn. The session keeps its original time.`,
      actionNeeded: false,
    },
    PAYMENT_RECORDED: {
      type: 'PAYMENT_RECORDED', title: 'Payment recorded',
      message: `${booking.business.name} recorded your payment for ${lesson} on ${when}.`,
      actionNeeded: false,
    },
    PAYMENT_REVERSED: {
      type: 'PAYMENT_REVERSED', title: 'A recorded payment was reversed',
      message: `${booking.business.name} reversed a payment recorded for ${lesson} on ${when}. This session is marked unpaid again.`,
      actionNeeded: true,
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

// Personal details belong to the student account, not to a selected club.
// This router is mounted behind requireAuth + requireStudent and deliberately
// sits before every provider-only workspace guard in app.ts.
accountRouter.patch('/profile', asyncRoute(async (req, res) => {
  const input = editablePersonalProfile.parse(req.body);
  await updatePersonalProfile(req.auth.user.id, input);
  res.json(await authState(req.auth.user.id, null));
}));

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
