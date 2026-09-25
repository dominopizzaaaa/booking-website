import { Router } from 'express';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { requireAuth, requireStudent } from './auth.js';
import { skipRateLimits } from './config.js';
import { prisma } from './db.js';
import { asyncRoute, HttpError } from './http.js';
import { bookingInclude, bookingJson, publicBookingBusiness, publicInstructor, publicLocation, serviceJson } from './serializers.js';
import { assertWritableClubBooking, bookableInstructorWhere, createBookings, evaluateSlot, lockInstructors, publicBookingInput, refundParticipant, rescheduleBooking, schedulingContext } from './scheduling.js';
import { createBookingAccountAlerts } from './account-notifications.js';
import { notifyWorkspace } from './notifications.js';
import { enqueueCalendarSync } from './calendar-sync.js';
import {
  acceptRescheduleRequest,
  assertInsideRescheduleWindow,
  createRescheduleRequest,
  declineRescheduleRequest,
  rescheduleNoticeHours,
  rescheduleRequestInput,
  rescheduleRequestJson,
  rescheduleResponseInput,
  withdrawRescheduleRequest,
} from './reschedule.js';

export const publicRouter = Router();
const bookingLimit = rateLimit({ windowMs: 60 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false, skip: skipRateLimits, message: { error: 'Too many requests. Please try again later.' } });
const slotLimit = rateLimit({ windowMs: 5 * 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, skip: skipRateLimits, message: { error: 'Too many availability checks. Please wait a moment.' } });
const legacyLookupLimit = rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, skip: skipRateLimits, message: { error: 'Too many management-link requests. Please try again later.' } });

async function businessForSlug(slug: string) {
  // Historical SOLO practices keep their contractual records, but the
  // marketplace must never reopen them for new bookings.
  const business = await prisma.business.findFirst({
    where: { slug, kind: 'CLUB', legacyReadOnly: false },
  });
  if (!business) throw new HttpError(404, 'Booking page not found');
  return business;
}

const bookableServiceWhere = {
  active: true,
  locations: {
    some: {
      location: { active: true },
      instructors: { some: { instructor: bookableInstructorWhere() } },
    },
  },
} satisfies Prisma.ServiceWhereInput;
const clubDirectoryQuery = z.object({
  cursor: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
}).strict();

// Explore is an account surface, but its cards deliberately carry only the
// same public-safe identity used by booking pages. A club belongs here only
// when following its link can lead to at least one real booking choice.
publicRouter.get('/account/clubs', requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const { cursor, limit } = clubDirectoryQuery.parse(req.query);
  const businesses = await prisma.business.findMany({
    where: {
      kind: 'CLUB',
      isDemo: false,
      legacyReadOnly: false,
      ...(cursor ? { slug: { gt: cursor } } : {}),
      services: { some: bookableServiceWhere },
    },
    include: {
      services: {
        where: bookableServiceWhere,
        select: {
          id: true, category: true,
          locations: {
            where: {
              location: { active: true },
              instructors: { some: { instructor: bookableInstructorWhere() } },
            },
            select: {
              locationId: true, price: true,
              instructors: {
                where: { instructor: bookableInstructorWhere() },
                select: { instructorId: true },
              },
            },
          },
        },
      },
    },
    orderBy: { slug: 'asc' },
    take: limit + 1,
  });
  const hasNextPage = businesses.length > limit;
  const page = hasNextPage ? businesses.slice(0, limit) : businesses;

  res.json({
    clubs: page.map(business => {
      const locations = business.services.flatMap(service => service.locations);
      const sportByKey = new Map<string, string>();
      for (const service of business.services) {
        const sport = service.category.trim();
        if (sport && !sportByKey.has(sport.toLocaleLowerCase())) {
          sportByKey.set(sport.toLocaleLowerCase(), sport);
        }
      }
      return {
        business: publicBookingBusiness(business),
        sports: [...sportByKey.values()].sort((a, b) => a.localeCompare(b)),
        serviceCount: business.services.length,
        coachCount: new Set(locations.flatMap(location => location.instructors.map(item => item.instructorId))).size,
        locationCount: new Set(locations.map(location => location.locationId)).size,
        priceFrom: Math.min(...locations.map(location => location.price)),
      };
    }),
    nextCursor: hasNextPage ? page.at(-1)!.slug : null,
  });
}));

publicRouter.get('/public/:slug', asyncRoute(async (req, res) => {
  const business = await businessForSlug(req.params.slug);
  const [instructors, services] = await Promise.all([
    prisma.instructor.findMany({ where: bookableInstructorWhere(business.id), orderBy: { name: 'asc' } }),
    prisma.service.findMany({
      where: { businessId: business.id, active: true },
      include: { locations: { where: { location: { active: true } }, include: { instructors: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  const bookableIds = new Set(instructors.map(instructor => instructor.id));
  const bookableServices = services.map(service => ({
    ...service,
    locations: service.locations.map(location => ({
      ...location,
      instructors: location.instructors.filter(assignment => bookableIds.has(assignment.instructorId)),
    })).filter(location => location.instructors.length > 0),
  })).filter(service => service.locations.length > 0);
  const locationIds = [...new Set(bookableServices.flatMap(service => service.locations.map(location => location.locationId)))];
  const locations = await prisma.location.findMany({
    where: { id: { in: locationIds }, businessId: business.id, active: true },
    orderBy: { name: 'asc' },
  });
  res.json({
    business: publicBookingBusiness(business),
    instructors: instructors.map(publicInstructor),
    locations: locations.map(publicLocation),
    services: bookableServices.map(serviceJson),
  });
}));

publicRouter.get('/public/:slug/slots', slotLimit, asyncRoute(async (req, res) => {
  const query = z.object({ serviceId: z.string().min(1), instructorId: z.string().min(1), locationId: z.string().min(1), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  const business = await businessForSlug(req.params.slug);
  const day = DateTime.fromISO(query.date, { zone: business.timezone }).startOf('day');
  if (!day.isValid || day.toISODate() !== query.date) throw new HttpError(400, 'Invalid calendar date');
  if (day > DateTime.now().plus({ years: 1 })) throw new HttpError(400, 'Choose a date within the next year');
  const slots = await prisma.$transaction(async tx => {
    const ctx = await schedulingContext(tx, business.id, query.serviceId, query.instructorId, query.locationId);
    const blocks = ctx.blocks.filter(b => b.dayOfWeek === day.weekday % 7);
    const minutes = new Set<number>();
    for (const block of blocks) {
      const [sh, sm] = block.startTime.split(':').map(Number); const [eh, em] = block.endTime.split(':').map(Number);
      for (let m = sh * 60 + sm; m + ctx.assignment.duration <= eh * 60 + em; m += 30) minutes.add(m);
    }
    const result = [];
    for (const minute of [...minutes].sort((a, b) => a - b)) {
      const slot = await evaluateSlot(tx, ctx, day.plus({ minutes: minute }).toJSDate());
      result.push({ startAt: slot.startAt.toISOString(), endAt: slot.endAt.toISOString(), available: slot.available, placesRemaining: slot.placesRemaining, ...(slot.reason ? { reason: slot.reason } : {}) });
    }
    return result;
  }, { timeout: 15_000 });
  res.json({ slots });
}));

publicRouter.post('/public/:slug/bookings', bookingLimit, requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const input = publicBookingInput.parse(req.body);
  const business = await businessForSlug(req.params.slug);
  const result = await createBookings(business.id, {
    ...input,
    student: {
      name: req.auth.user.name,
      email: req.auth.user.email,
      phone: input.student?.phone,
      parentName: input.student?.parentName,
    },
  }, { studentUserId: req.auth.user.id });
  res.status(201).json(result);
}));

type AccountParticipant = Awaited<ReturnType<typeof accountParticipant>>;

const accountBookingInclude = {
  ...bookingInclude,
  business: true,
  rescheduleRequests: {
    where: { status: 'PENDING' as const },
    orderBy: { createdAt: 'desc' as const },
    include: {
      booking: {
        include: {
          business: { select: { id: true, name: true, timezone: true } },
          instructor: { select: { id: true, name: true, rescheduleNoticeHours: true } },
          service: { select: { name: true } },
          location: { select: { name: true } },
        },
      },
    },
  },
} as const;

async function accountParticipant(participantId: string, userId: string) {
  const participant = await prisma.participant.findFirst({
    where: { id: participantId, student: { userId } },
    include: { student: true, booking: { include: accountBookingInclude } },
  });
  if (!participant) throw new HttpError(404, 'Booking not found');
  return participant;
}

function canManageAccount(p: AccountParticipant) {
  return p.booking.paymentRoute === 'CLUB'
    && p.booking.business.kind === 'CLUB' && !p.booking.business.legacyReadOnly
    && !p.cancelledAt
    && !['CANCELLED', 'COMPLETED'].includes(p.booking.status)
    && p.booking.startAt.getTime() > Date.now()
    && p.booking.startAt.getTime() - Date.now() >= p.booking.business.cancellationHours * 3600_000;
}

/**
 * Rescheduling closes earlier than cancelling when the coach asks for more
 * notice, so it has its own window rather than reusing the cancellation one.
 */
function canRequestReschedule(p: AccountParticipant) {
  if (p.booking.paymentRoute !== 'CLUB' || p.booking.business.kind !== 'CLUB' || p.booking.business.legacyReadOnly) return false;
  if (p.cancelledAt || !['CONFIRMED', 'PENDING'].includes(p.booking.status)) return false;
  if (p.booking.coachAcceptance === 'PENDING') return false;
  const hours = rescheduleNoticeHours(p.booking.instructor, p.booking.business);
  return p.booking.startAt.getTime() - Date.now() >= hours * 3600_000;
}

function accountBookingJson(p: AccountParticipant) {
  // Serialize exactly one participant even for group lessons. Other students'
  // identities, contact details and participant notes stay private.
  const single = bookingJson({ ...p.booking, participants: [{ ...p, cancelledAt: null }] }, { includeNotes: false });
  if (p.cancelledAt) single.status = 'CANCELLED';
  const canChange = canManageAccount(p);
  const canReschedule = canRequestReschedule(p) && p.booking.type === 'PRIVATE';
  const pending = p.booking.rescheduleRequests[0];
  return {
    business: publicBookingBusiness(p.booking.business),
    booking: single,
    participant: { ...single.participants[0], cancelled: !!p.cancelledAt, cancelledAt: p.cancelledAt?.toISOString() ?? null },
    location: publicLocation(p.booking.location),
    canCancel: canChange,
    canReschedule,
    // A pending proposal is the one thing a student may need to act on, so it
    // travels with the booking rather than requiring a second request.
    rescheduleRequest: pending ? rescheduleRequestJson(pending) : null,
    awaitingCoach: p.booking.coachAcceptance === 'PENDING',
    paymentRoute: p.booking.paymentRoute,
    management: {
      cancellationHours: p.booking.business.cancellationHours,
      rescheduleNoticeHours: rescheduleNoticeHours(p.booking.instructor, p.booking.business),
      reminders: 'Queued in Courtly; external delivery is not configured',
      venueReserved: false,
    },
  };
}

// Compatibility bridge for booking links issued before account-only booking
// was introduced. No new token is created anywhere; these routes exist only
// so an already-issued, unexpired credential can manage its existing booking.
const legacyTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const legacyTokenSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/);
const legacyParticipantInclude = {
  student: true,
  booking: { include: {
    service: { include: { locations: { include: { instructors: true } } } },
    instructor: { include: { membership: { include: { user: true } } } },
    location: true, participants: { include: { student: true } }, business: true,
  } },
} as const;
type LegacyParticipant = Awaited<ReturnType<typeof legacyParticipant>>;

async function legacyParticipant(rawToken: string) {
  const token = legacyTokenSchema.parse(rawToken);
  const currentDigest = legacyTokenHash(token);
  let participant = await prisma.participant.findUnique({
    where: { managementTokenHash: currentDigest },
    include: legacyParticipantInclude,
  });
  if (!participant) {
    // The private-token migration predates the SHA-256 runtime format and
    // stored md5(token || participant.id). Keep that one-way legacy format
    // readable so links issued before account-only booking continue to work.
    // Active CLUB rows can be upgraded to the indexed SHA-256 format, while
    // retained SOLO/read-only rows must preserve their immutable history.
    const migratedMatches = await prisma.$queryRaw<Array<{ id: string; digest: string }>>`
      SELECT participant."id", participant."managementTokenHash" AS digest
      FROM "Participant" AS participant
      WHERE length(participant."managementTokenHash") = 32
        AND participant."managementTokenHash" = md5(${token}::text || participant."id")
        AND participant."managementTokenRevokedAt" IS NULL
        AND participant."managementTokenExpiresAt" > CURRENT_TIMESTAMP
      LIMIT 2
    `;
    if (migratedMatches.length > 1) throw new HttpError(404, 'Management link not found');
    const [migrated] = migratedMatches;
    if (migrated) {
      participant = await prisma.participant.findUnique({
        where: { id: migrated.id },
        include: legacyParticipantInclude,
      });
      if (participant?.booking.business.kind === 'CLUB' && !participant.booking.business.legacyReadOnly) {
        await prisma.participant.updateMany({
          where: { id: migrated.id, managementTokenHash: migrated.digest },
          data: { managementTokenHash: currentDigest },
        });
      }
    }
  }
  if (!participant) throw new HttpError(404, 'Management link not found');
  if (!participant.managementTokenExpiresAt || participant.managementTokenRevokedAt
    || participant.managementTokenExpiresAt <= new Date()) {
    throw new HttpError(410, 'This management link has expired. Please contact your coach.');
  }
  return participant;
}

function canManageLegacy(p: LegacyParticipant) {
  return p.booking.paymentRoute === 'CLUB'
    && p.booking.business.kind === 'CLUB' && !p.booking.business.legacyReadOnly
    && !p.cancelledAt
    && !['CANCELLED', 'COMPLETED'].includes(p.booking.status)
    && p.booking.startAt.getTime() > Date.now()
    && p.booking.startAt.getTime() - Date.now() >= p.booking.business.cancellationHours * 3600_000;
}

function canRescheduleLegacy(p: LegacyParticipant) {
  if (p.booking.paymentRoute !== 'CLUB' || p.booking.business.kind !== 'CLUB' || p.booking.business.legacyReadOnly) return false;
  if (p.cancelledAt || !['CONFIRMED', 'PENDING'].includes(p.booking.status)) return false;
  if (p.booking.coachAcceptance === 'PENDING') return false;
  const hours = rescheduleNoticeHours(p.booking.instructor, p.booking.business);
  return p.booking.startAt.getTime() - Date.now() >= hours * 3600_000;
}

function legacyBookingJson(p: LegacyParticipant) {
  const single = bookingJson({ ...p.booking, participants: [{ ...p, cancelledAt: null }] }, { includeNotes: false });
  if (p.cancelledAt) single.status = 'CANCELLED';
  const canChange = canManageLegacy(p);
  const membership = p.booking.instructor.membership;
  const mapping = p.booking.service.locations.find(candidate =>
    candidate.locationId === p.booking.locationId
      && candidate.instructors.some(candidateInstructor => candidateInstructor.instructorId === p.booking.instructorId));
  const instructorCanHost = p.booking.service.active && p.booking.location.active && p.booking.instructor.active
    && !!mapping && !!membership && membership.businessId === p.booking.businessId && membership.active
    && membership.user.passwordHash !== null && membership.user.accountType === 'COACH';
  const { participants: _participants, ...booking } = single;
  const visibleParticipant = single.participants[0];
  return {
    business: publicBookingBusiness(p.booking.business),
    booking,
    participant: {
      name: visibleParticipant.name, paid: visibleParticipant.paid, price: visibleParticipant.price,
      cancelled: !!p.cancelledAt, cancelledAt: p.cancelledAt?.toISOString() ?? null,
    },
    location: publicLocation(p.booking.location),
    canCancel: canChange,
    canReschedule: canRescheduleLegacy(p) && p.booking.type === 'PRIVATE' && instructorCanHost,
    management: {
      cancellationHours: p.booking.business.cancellationHours,
      rescheduleNoticeHours: rescheduleNoticeHours(p.booking.instructor, p.booking.business),
    },
  };
}

publicRouter.get('/manage/:token', legacyLookupLimit, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(legacyBookingJson(await legacyParticipant(req.params.token)));
}));

publicRouter.post('/manage/:token/cancel', bookingLimit, asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const initial = await legacyParticipant(req.params.token);
  await prisma.$transaction(async tx => {
    await lockInstructors(tx, [initial.booking.instructorId]);
    const participant = await tx.participant.findUniqueOrThrow({
      where: { id: initial.id }, include: { student: true, booking: { include: { business: true } } },
    });
    if (participant.booking.instructorId !== initial.booking.instructorId) throw new HttpError(409, 'Session changed. Please refresh and try again');
    assertWritableClubBooking(participant.booking);
    if (participant.cancelledAt || participant.booking.status === 'CANCELLED') return;
    if (participant.booking.status === 'COMPLETED' || participant.booking.startAt.getTime() <= Date.now()
      || participant.booking.startAt.getTime() - Date.now() < participant.booking.business.cancellationHours * 3600_000) {
      throw new HttpError(400, `Cancellation requires ${participant.booking.business.cancellationHours} hours notice. Please contact your coach.`);
    }
    await refundParticipant(tx, participant);
    await tx.participant.update({ where: { id: participant.id }, data: { cancelledAt: new Date() } });
    const remaining = await tx.participant.count({ where: { bookingId: participant.bookingId, cancelledAt: null } });
    if (!remaining) await tx.booking.update({ where: { id: participant.bookingId }, data: { status: 'CANCELLED' } });
    await enqueueCalendarSync(tx, participant.bookingId);
    await notifyWorkspace(tx, {
      businessId: participant.booking.businessId, instructorId: participant.booking.instructorId,
      bookingId: participant.bookingId, type: 'CANCELLATION', actionNeeded: true,
      title: 'Student cancelled a booking',
      message: 'The student cancelled through an existing private booking link. Any consumed package credit was restored.',
    });
    await createBookingAccountAlerts(tx, participant.bookingId, 'STUDENT_CANCELLED', [participant.student.userId]);
  });
  res.json(legacyBookingJson(await legacyParticipant(req.params.token)));
}));

publicRouter.post('/manage/:token/reschedule', bookingLimit, asyncRoute(async (req, res) => {
  const changes = z.object({ startAt: z.string().datetime({ offset: true }) }).strict().parse(req.body);
  const initial = await legacyParticipant(req.params.token);
  await prisma.$transaction(async tx => {
    await lockInstructors(tx, [initial.booking.instructorId]);
    const participant = await tx.participant.findUniqueOrThrow({
      where: { id: initial.id }, include: { booking: { include: { business: true, instructor: true } } },
    });
    if (participant.booking.instructorId !== initial.booking.instructorId) throw new HttpError(409, 'Session changed. Please refresh and try again');
    assertWritableClubBooking(participant.booking);
    if (participant.cancelledAt || !['CONFIRMED', 'PENDING'].includes(participant.booking.status)
      || participant.booking.startAt.getTime() <= Date.now()) {
      throw new HttpError(400, 'This booking is outside the self-service rescheduling window. Contact your coach.');
    }
    if (participant.booking.coachAcceptance === 'PENDING') {
      throw new HttpError(400, 'This lesson is still waiting for the coach to accept it. Reschedule it once it is confirmed.');
    }
    if (participant.booking.type !== 'PRIVATE') throw new HttpError(400, 'Please contact your coach to move your place in a group session');
    assertInsideRescheduleWindow(participant.booking, participant.booking.instructor, participant.booking.business);
    await rescheduleBooking(tx, participant.booking.businessId, participant.bookingId, changes);
  }, { timeout: 30_000 });
  res.json(legacyBookingJson(await legacyParticipant(req.params.token)));
}));

publicRouter.get('/account/bookings', requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const query = z.object({ businessSlug: z.string().trim().min(1).optional() }).strict().parse(req.query);
  const participants = await prisma.participant.findMany({
    where: {
      student: { userId: req.auth.user.id },
      ...(query.businessSlug ? { booking: { business: { slug: query.businessSlug } } } : {}),
    },
    include: { student: true, booking: { include: accountBookingInclude } },
    orderBy: { booking: { startAt: 'asc' } },
  });
  res.json({ bookings: participants.map(accountBookingJson) });
}));

publicRouter.post('/account/bookings/:participantId/cancel', bookingLimit, requireAuth, requireStudent, asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const initial = await accountParticipant(req.params.participantId, req.auth.user.id);
  await prisma.$transaction(async tx => {
    await lockInstructors(tx, [initial.booking.instructorId]);
    const participant = await tx.participant.findFirst({
      where: { id: initial.id, student: { userId: req.auth.user.id } },
      include: { booking: { include: { business: true } } },
    });
    if (!participant) throw new HttpError(404, 'Booking not found');
    if (participant.booking.instructorId !== initial.booking.instructorId) throw new HttpError(409, 'Session changed. Please refresh and try again');
    assertWritableClubBooking(participant.booking);
    if (participant.cancelledAt || participant.booking.status === 'CANCELLED') return;
    if (participant.booking.status === 'COMPLETED' || participant.booking.startAt.getTime() <= Date.now() || participant.booking.startAt.getTime() - Date.now() < participant.booking.business.cancellationHours * 3600_000) {
      throw new HttpError(400, `Cancellation requires ${participant.booking.business.cancellationHours} hours notice. Please contact your coach.`);
    }
    await refundParticipant(tx, participant);
    await tx.participant.update({ where: { id: participant.id }, data: { cancelledAt: new Date() } });
    const remaining = await tx.participant.count({ where: { bookingId: participant.bookingId, cancelledAt: null } });
    if (!remaining) await tx.booking.update({ where: { id: participant.bookingId }, data: { status: 'CANCELLED' } });
    await enqueueCalendarSync(tx, participant.bookingId);
    await notifyWorkspace(tx, { businessId: participant.booking.businessId, instructorId: participant.booking.instructorId, bookingId: participant.bookingId, type: 'CANCELLATION', actionNeeded: true, title: 'Student cancelled a booking', message: 'The student cancelled through their account. Any consumed package credit was restored. Cancellation notice queued; no external message sent.' });
    await createBookingAccountAlerts(tx, participant.bookingId, 'STUDENT_CANCELLED', [req.auth.user.id]);
  });
  res.json(accountBookingJson(await accountParticipant(req.params.participantId, req.auth.user.id)));
}));

// Rescheduling from the student side is a request, not a change. The coach
// has to agree before a session actually moves.
publicRouter.post('/account/bookings/:participantId/reschedule-requests', bookingLimit, requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const input = rescheduleRequestInput.parse(req.body);
  const initial = await accountParticipant(req.params.participantId, req.auth.user.id);
  if (initial.booking.type !== 'PRIVATE') throw new HttpError(400, 'Please contact your coach to move your place in a group session');
  await prisma.$transaction(async tx => {
    const participant = await tx.participant.findFirst({
      where: { id: initial.id, student: { userId: req.auth.user.id } },
      select: { id: true, bookingId: true, booking: { select: { businessId: true } } },
    });
    if (!participant) throw new HttpError(404, 'Booking not found');
    await createRescheduleRequest(tx, {
      bookingId: participant.bookingId,
      businessId: participant.booking.businessId,
      role: 'STUDENT',
      userId: req.auth.user.id,
      participantId: participant.id,
      startAt: input.startAt,
      message: input.message,
    });
  }, { timeout: 30_000 });
  res.status(201).json(accountBookingJson(await accountParticipant(req.params.participantId, req.auth.user.id)));
}));

// Answering a proposal the provider side raised.
publicRouter.post('/account/reschedule-requests/:requestId/accept', bookingLimit, requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const body = rescheduleResponseInput.parse(req.body ?? {});
  const result = await prisma.$transaction(async tx => {
    const request = await tx.rescheduleRequest.findFirst({
      where: { id: req.params.requestId, booking: { participants: { some: { cancelledAt: null, student: { userId: req.auth.user.id } } } } },
      select: { id: true, bookingId: true },
    });
    if (!request) throw new HttpError(404, 'Reschedule request not found');
    const acceptance = await acceptRescheduleRequest(tx, request.id, {
      role: 'STUDENT', userId: req.auth.user.id, message: body.message,
    });
    if (acceptance.outcome === 'EXPIRED') return acceptance;
    const participant = await tx.participant.findFirst({
      where: { bookingId: request.bookingId, cancelledAt: null, student: { userId: req.auth.user.id } },
      select: { id: true },
    });
    return { ...acceptance, participantId: participant?.id ?? null };
  }, { timeout: 30_000 });
  if (result.outcome === 'EXPIRED') {
    throw new HttpError(result.error.status, result.error.message, result.error.details);
  }
  if (!result.participantId) throw new HttpError(404, 'Booking not found');
  res.json(accountBookingJson(await accountParticipant(result.participantId, req.auth.user.id)));
}));

publicRouter.post('/account/reschedule-requests/:requestId/decline', bookingLimit, requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const body = rescheduleResponseInput.parse(req.body ?? {});
  const participantId = await prisma.$transaction(async tx => {
    const request = await tx.rescheduleRequest.findFirst({
      where: { id: req.params.requestId, booking: { participants: { some: { cancelledAt: null, student: { userId: req.auth.user.id } } } } },
      select: { id: true, bookingId: true, requestedByRole: true },
    });
    if (!request) throw new HttpError(404, 'Reschedule request not found');
    if (request.requestedByRole === 'STUDENT') {
      await withdrawRescheduleRequest(tx, request.id, { role: 'STUDENT', userId: req.auth.user.id });
    } else {
      await declineRescheduleRequest(tx, request.id, { role: 'STUDENT', userId: req.auth.user.id, message: body.message });
    }
    const participant = await tx.participant.findFirst({
      where: { bookingId: request.bookingId, cancelledAt: null, student: { userId: req.auth.user.id } },
      select: { id: true },
    });
    return participant?.id ?? null;
  });
  if (!participantId) throw new HttpError(404, 'Booking not found');
  res.json(accountBookingJson(await accountParticipant(participantId, req.auth.user.id)));
}));
