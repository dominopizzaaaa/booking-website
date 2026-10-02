import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { SINGAPORE_TIME_ZONE } from './children-policy.js';

type Tx = Prisma.TransactionClient;

/**
 * Lifecycle events the platform writes into a session chat. The chat router
 * and the booking lifecycle both write through here, so every system line has
 * one wording and one place that decides whether it counts as unread.
 */
export const chatSystemEvents = [
  'OPENED',
  'JOINED',
  'LEFT',
  'REMINDER',
  'CANCELLED',
  'RESCHEDULED',
  'PROPOSAL_ACCEPTED',
  'PROPOSAL_DECLINED',
  'PROPOSAL_WITHDRAWN',
  'COACH_ASSIGNED',
  'COACH_REMOVED',
] as const;

export type ChatSystemEvent = (typeof chatSystemEvents)[number];
export type ChatRole = 'STUDENT' | 'COACH' | 'CLUB';

/**
 * Events that never raise an unread badge. The opening line only introduces
 * the chat, and a club account is not an attendee, so it is not nagged by the
 * day-before reminder written for the coach and students.
 */
export function silentChatEventsFor(role: ChatRole): ChatSystemEvent[] {
  return role === 'CLUB' ? ['OPENED', 'REMINDER'] : ['OPENED'];
}

/**
 * Every time a chat shows or reads is Singapore time, whichever club the
 * conversation belongs to. Courtly operates in Singapore, and one clock means
 * "tomorrow at 5pm" reads the same for everyone in a conversation.
 */
export const CHAT_TIME_ZONE = SINGAPORE_TIME_ZONE;

export const chatWhen = (date: Date) =>
  DateTime.fromJSDate(date, { zone: CHAT_TIME_ZONE }).setLocale('en').toFormat("ccc, d LLL 'at' h:mm a");

const sessionSelect = {
  id: true, businessId: true, startAt: true, status: true, paymentRoute: true,
  business: { select: { kind: true, legacyReadOnly: true, timezone: true } },
  service: { select: { name: true } },
  instructor: { select: { name: true } },
  location: { select: { name: true } },
} satisfies Prisma.BookingSelect;

type ChatSession = Prisma.BookingGetPayload<{ select: typeof sessionSelect }>;

/** Chat exists only around bookings made under an active club's money path. */
export const chatEligible = (booking: Pick<ChatSession, 'paymentRoute' | 'business'>) =>
  booking.paymentRoute === 'CLUB' && booking.business.kind === 'CLUB' && !booking.business.legacyReadOnly;

export function chatOpeningLine(session: {
  serviceName: string; instructorName: string; locationName: string; startAt: Date;
}) {
  return `This is the chat for ${session.serviceName} on ${chatWhen(session.startAt)} `
    + `with ${session.instructorName} at ${session.locationName}. Your coach, the club and everyone booked into `
    + 'this session can read and reply here.';
}

/**
 * Return the booking's thread, creating it with its opening line the first
 * time. Concurrent creators race on the unique booking index; exactly one
 * insert wins and only the winner writes the opening line.
 */
export async function ensureChatThread(tx: Tx, bookingId: string) {
  const existing = await tx.chatThread.findUnique({ where: { bookingId }, select: { id: true } });
  if (existing) return existing.id;
  const session = await tx.booking.findUnique({ where: { id: bookingId }, select: sessionSelect });
  if (!session || !chatEligible(session)) return null;
  const now = new Date();
  const inserted = await tx.chatThread.createMany({
    data: [{ businessId: session.businessId, bookingId, lastMessageAt: now, createdAt: now }],
    skipDuplicates: true,
  });
  const thread = await tx.chatThread.findUniqueOrThrow({ where: { bookingId }, select: { id: true } });
  if (inserted.count === 1) {
    await tx.chatMessage.create({
      data: {
        threadId: thread.id, kind: 'SYSTEM', event: 'OPENED', senderRole: 'SYSTEM',
        body: chatOpeningLine({
          serviceName: session.service.name, instructorName: session.instructor.name,
          locationName: session.location.name, startAt: session.startAt,
        }),
        createdAt: now,
      },
    });
  }
  return thread.id;
}

export type SystemLine = {
  event: Exclude<ChatSystemEvent, 'OPENED'>;
  body: string;
  /** Whose action produced the line; they are not shown it as unread. */
  actor?: { userId: string; name: string } | null;
  /**
   * Lifecycle notices only annotate a conversation that already exists, so a
   * booking created before chat shipped does not gain a thread just to be
   * told it was cancelled. Arrivals and reminders open the thread themselves.
   */
  openThread?: boolean;
};

/** Write a lifecycle line when the caller already knows the conversation. */
export async function postThreadSystemLine(tx: Tx, threadId: string, line: SystemLine) {
  const createdAt = new Date();
  const message = await tx.chatMessage.create({
    data: {
      threadId, kind: 'SYSTEM', event: line.event, senderRole: 'SYSTEM',
      senderUserId: line.actor?.userId ?? null, senderName: line.actor?.name ?? '',
      body: line.body, createdAt,
    },
  });
  await tx.chatThread.updateMany({ where: { id: threadId, lastMessageAt: { lt: createdAt } }, data: { lastMessageAt: createdAt } });
  return message;
}

export async function postChatSystemLine(tx: Tx, bookingId: string, line: SystemLine) {
  const threadId = line.openThread
    ? await ensureChatThread(tx, bookingId)
    : (await tx.chatThread.findUnique({ where: { bookingId }, select: { id: true } }))?.id ?? null;
  if (!threadId) return null;
  return postThreadSystemLine(tx, threadId, line);
}

/** Everything a booking lifecycle writer needs to annotate its chat. */
export async function describeSession(tx: Tx, bookingId: string) {
  const session = await tx.booking.findUnique({ where: { id: bookingId }, select: sessionSelect });
  if (!session) return null;
  return {
    ...session,
    when: chatWhen(session.startAt),
  };
}

export async function noteSessionCancelled(tx: Tx, bookingId: string) {
  await postChatSystemLine(tx, bookingId, {
    event: 'CANCELLED',
    body: 'This session was cancelled. You can still message here, or use + to agree on another time.',
  });
}

export async function noteSessionMoved(tx: Tx, bookingId: string) {
  const session = await describeSession(tx, bookingId);
  if (!session) return;
  await postChatSystemLine(tx, bookingId, {
    event: 'RESCHEDULED',
    body: `This session moved to ${session.when}.${session.status === 'PENDING' ? ' The club is confirming the venue.' : ''}`,
  });
}

export async function noteStudentLeft(tx: Tx, bookingId: string, student: { userId: string | null; name: string }) {
  await postChatSystemLine(tx, bookingId, {
    event: 'LEFT',
    body: `${student.name} cancelled their place in this session.`,
    actor: student.userId ? { userId: student.userId, name: student.name } : null,
  });
}

export async function noteStudentJoined(tx: Tx, bookingId: string, student: { userId: string | null; name: string }) {
  await postChatSystemLine(tx, bookingId, {
    event: 'JOINED',
    body: `${student.name} joined this session.`,
    actor: student.userId ? { userId: student.userId, name: student.name } : null,
    openThread: true,
  });
}
