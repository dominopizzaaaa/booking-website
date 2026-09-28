import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, coachScoped, hasClubPermission, HttpError } from './http.js';

export const operationsRouter = Router();

const inboxQuery = z.object({
  category: z.preprocess(value => Array.isArray(value) ? value[0] : value,
    z.enum(['coach', 'venue', 'attendance', 'reschedule', 'payment', 'rental']).optional()),
  cursor: z.preprocess(value => Array.isArray(value) ? value[0] : value, z.string().min(1).optional()),
  limit: z.preprocess(value => Array.isArray(value) ? value[0] : value, z.coerce.number().int().min(1).max(100).default(30)),
}).passthrough();

type Category = NonNullable<z.infer<typeof inboxQuery>['category']>;
type InboxCursor = { sortAt: string; id: string };
type InboxItem = {
  id: string; category: Category; severity: 'urgent' | 'attention' | 'info'; sortAt: string;
  title: string; detail: string; entityType: 'booking' | 'rescheduleRequest' | 'participant' | 'rentalReservation';
  entityId: string; destination: { view: string; params: Record<string, string> };
};

function encodeCursor(item: InboxItem) {
  return Buffer.from(JSON.stringify({ sortAt: item.sortAt, id: item.id }), 'utf8').toString('base64url');
}

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    return z.object({ sortAt: z.string().datetime(), id: z.string().min(1) }).strict()
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'Invalid inbox cursor');
  }
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cursorTieBreaker(prefix: string, cursor: InboxCursor) {
  const itemPrefix = `${prefix}:`;
  if (cursor.id.startsWith(itemPrefix)) {
    return { includeEqualTime: true, entityIdAfter: cursor.id.slice(itemPrefix.length) };
  }
  return { includeEqualTime: compareText(itemPrefix, cursor.id) > 0, entityIdAfter: undefined };
}

function directAfterCursor<T>(dateField: string, prefix: string, cursor: InboxCursor): T {
  const at = new Date(cursor.sortAt);
  const tie = cursorTieBreaker(prefix, cursor);
  const sameTime = tie.includeEqualTime
    ? { [dateField]: at, ...(tie.entityIdAfter === undefined ? {} : { id: { gt: tie.entityIdAfter } }) }
    : null;
  return {
    OR: [
      { [dateField]: { gt: at } },
      ...(sameTime ? [sameTime] : []),
    ],
  } as T;
}

function participantAfterCursor(cursor: InboxCursor): Prisma.ParticipantWhereInput {
  const at = new Date(cursor.sortAt);
  const tie = cursorTieBreaker('payment', cursor);
  return {
    OR: [
      { booking: { startAt: { gt: at } } },
      ...(tie.includeEqualTime ? [{
        booking: { startAt: at },
        ...(tie.entityIdAfter === undefined ? {} : { id: { gt: tie.entityIdAfter } }),
      }] : []),
    ],
  };
}

function urgency(at: Date, now: Date): InboxItem['severity'] {
  if (at.getTime() <= now.getTime() + 24 * 3_600_000) return 'urgent';
  if (at.getTime() <= now.getTime() + 7 * 86_400_000) return 'attention';
  return 'info';
}

const bookingCategories = new Set<Category>(['coach', 'venue', 'attendance', 'reschedule']);

operationsRouter.get('/operations/inbox', asyncRoute(async (req, res) => {
  const query = inboxQuery.parse(req.query);
  const cursor = decodeCursor(query.cursor);
  const businessId = req.auth.business.id;
  const coach = coachScoped(req.auth);
  const canViewBookings = coach || hasClubPermission(req.auth, 'BOOKINGS_VIEW');
  const canViewPayments = !coach && hasClubPermission(req.auth, 'PAYMENTS_VIEW');
  const canViewRentals = !coach && hasClubPermission(req.auth, 'RENTALS_VIEW');
  if (!canViewBookings && !canViewPayments && !canViewRentals) {
    throw new HttpError(403, 'This workspace requires bookings, payments, or rentals view permission');
  }
  if (query.category && bookingCategories.has(query.category) && !canViewBookings) {
    throw new HttpError(403, 'This workspace requires bookings view permission');
  }
  if (query.category === 'payment' && !canViewPayments) {
    throw new HttpError(403, 'This workspace requires payments view permission');
  }
  if (query.category === 'rental' && !canViewRentals) {
    throw new HttpError(403, 'This workspace requires rentals view permission');
  }
  const instructorId = coach ? req.auth.membership?.instructorId || '__none__' : undefined;
  const now = new Date();
  const coachWhere: Prisma.BookingWhereInput = {
    businessId, instructorId, status: 'PENDING', coachAcceptance: 'PENDING', endAt: { gte: now },
  };
  const venueWhere: Prisma.BookingWhereInput = {
    businessId, status: 'PENDING', coachAcceptance: { not: 'PENDING' }, endAt: { gte: now },
  };
  const attendanceWhere: Prisma.BookingWhereInput = {
    businessId, instructorId, status: { in: ['CONFIRMED', 'COMPLETED'] }, endAt: { lte: now },
    participants: { some: { cancelledAt: null, attendance: 'UNMARKED' } },
  };
  const rescheduleWhere: Prisma.RescheduleRequestWhereInput = {
    businessId, status: 'PENDING', ...(instructorId ? { booking: { instructorId } } : {}),
  };
  const paymentWhere: Prisma.ParticipantWhereInput = {
    cancelledAt: null, paid: false, packageId: null,
    booking: { businessId, status: { not: 'CANCELLED' } },
  };
  const rentalWhere: Prisma.VenueReservationWhereInput = {
    businessId, OR: [{ status: 'PENDING' }, { paymentStatus: 'UNPAID' }],
  };
  const wants = (category: Category) => !query.category || query.category === category;
  const take = query.limit + 1;
  const [
    coachCount, venueCount, attendanceCount, rescheduleCount, paymentCount, rentalCount,
    coachBookings, venueBookings, attendanceBookings, reschedules, unpaid, rentals,
  ] = await Promise.all([
    canViewBookings ? prisma.booking.count({ where: coachWhere }) : 0,
    canViewBookings && !coach ? prisma.booking.count({ where: venueWhere }) : 0,
    canViewBookings ? prisma.booking.count({ where: attendanceWhere }) : 0,
    canViewBookings ? prisma.rescheduleRequest.count({ where: rescheduleWhere }) : 0,
    canViewPayments ? prisma.participant.count({ where: paymentWhere }) : 0,
    canViewRentals ? prisma.venueReservation.count({ where: rentalWhere }) : 0,
    canViewBookings && wants('coach') ? prisma.booking.findMany({
      where: cursor ? { AND: [coachWhere, directAfterCursor<Prisma.BookingWhereInput>('startAt', 'coach-acceptance', cursor)] } : coachWhere,
      include: { service: true, instructor: true, location: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take,
    }) : [],
    canViewBookings && !coach && wants('venue') ? prisma.booking.findMany({
      where: cursor ? { AND: [venueWhere, directAfterCursor<Prisma.BookingWhereInput>('startAt', 'venue', cursor)] } : venueWhere,
      include: { service: true, location: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take,
    }) : [],
    canViewBookings && wants('attendance') ? prisma.booking.findMany({
      where: cursor ? { AND: [attendanceWhere, directAfterCursor<Prisma.BookingWhereInput>('endAt', 'attendance', cursor)] } : attendanceWhere,
      include: { service: true, participants: { where: { cancelledAt: null, attendance: 'UNMARKED' } } },
      orderBy: [{ endAt: 'asc' }, { id: 'asc' }], take,
    }) : [],
    canViewBookings && wants('reschedule') ? prisma.rescheduleRequest.findMany({
      where: cursor ? { AND: [rescheduleWhere, directAfterCursor<Prisma.RescheduleRequestWhereInput>('proposedStartAt', 'reschedule', cursor)] } : rescheduleWhere,
      include: { booking: { include: { service: true } } },
      orderBy: [{ proposedStartAt: 'asc' }, { id: 'asc' }], take,
    }) : [],
    canViewPayments && wants('payment') ? prisma.participant.findMany({
      where: cursor ? { AND: [paymentWhere, participantAfterCursor(cursor)] } : paymentWhere,
      include: { student: true, booking: { include: { service: true } } },
      orderBy: [{ booking: { startAt: 'asc' } }, { id: 'asc' }], take,
    }) : [],
    canViewRentals && wants('rental') ? prisma.venueReservation.findMany({
      where: cursor ? { AND: [rentalWhere, directAfterCursor<Prisma.VenueReservationWhereInput>('startAt', 'rental', cursor)] } : rentalWhere,
      include: { location: true, unit: true, user: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take,
    }) : [],
  ]);

  const items: InboxItem[] = [
    ...coachBookings.map(booking => ({ id: `coach-acceptance:${booking.id}`, category: 'coach' as const, severity: urgency(booking.startAt, now), sortAt: booking.startAt.toISOString(), title: 'Coach confirmation needed', detail: `${booking.service.name} with ${booking.instructor.name} at ${booking.location.name}`, entityType: 'booking' as const, entityId: booking.id, destination: { view: 'bookings', params: { bookingId: booking.id } } })),
    ...venueBookings.map(booking => ({ id: `venue:${booking.id}`, category: 'venue' as const, severity: urgency(booking.startAt, now), sortAt: booking.startAt.toISOString(), title: 'Venue confirmation needed', detail: `${booking.service.name} at ${booking.location.name}`, entityType: 'booking' as const, entityId: booking.id, destination: { view: 'bookings', params: { bookingId: booking.id } } })),
    ...attendanceBookings.map(booking => ({ id: `attendance:${booking.id}`, category: 'attendance' as const, severity: 'urgent' as const, sortAt: booking.endAt.toISOString(), title: 'Attendance needs marking', detail: `${booking.service.name} · ${booking.participants.length} unmarked`, entityType: 'booking' as const, entityId: booking.id, destination: { view: 'bookings', params: { bookingId: booking.id } } })),
    ...reschedules.map(request => ({ id: `reschedule:${request.id}`, category: 'reschedule' as const, severity: urgency(request.proposedStartAt, now), sortAt: request.proposedStartAt.toISOString(), title: 'Reschedule response needed', detail: request.booking.service.name, entityType: 'rescheduleRequest' as const, entityId: request.id, destination: { view: 'bookings', params: { bookingId: request.bookingId, rescheduleRequestId: request.id } } })),
    ...unpaid.map(participant => ({ id: `payment:${participant.id}`, category: 'payment' as const, severity: participant.booking.endAt <= now ? 'attention' as const : 'info' as const, sortAt: participant.booking.startAt.toISOString(), title: 'Payment outstanding', detail: `${participant.student.name} · ${participant.booking.service.name}`, entityType: 'participant' as const, entityId: participant.id, destination: { view: 'payments', params: { bookingId: participant.bookingId, participantId: participant.id } } })),
    ...rentals.map(rental => ({ id: `rental:${rental.id}`, category: 'rental' as const, severity: urgency(rental.startAt, now), sortAt: rental.startAt.toISOString(), title: 'Rental reservation needs attention', detail: `${rental.user.name} · ${rental.location.name} · ${rental.unit.name}`, entityType: 'rentalReservation' as const, entityId: rental.id, destination: { view: 'rentals', params: { reservationId: rental.id, mode: 'manage' } } })),
  ].sort((a, b) => compareText(a.sortAt, b.sortAt) || compareText(a.id, b.id));

  const page = items.slice(0, query.limit);
  const counts = {
    all: coachCount + venueCount + attendanceCount + rescheduleCount + paymentCount + rentalCount,
    coach: coachCount, venue: venueCount, attendance: attendanceCount,
    reschedule: rescheduleCount, payment: paymentCount, rental: rentalCount,
  };
  res.json({ items: page, nextCursor: items.length > query.limit && page.length ? encodeCursor(page.at(-1)!) : null, counts });
}));
