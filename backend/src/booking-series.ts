import { Router } from 'express';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError, requireClubPermission } from './http.js';
import {
  coachAcceptanceFor, evaluateSlot, hasTimeConflict, lockInstructors, paymentRouteFor, schedulingContext,
  selectEligibleLessonPackage, type Tx,
} from './scheduling.js';
import { bookingInclude, bookingJson } from './serializers.js';
import { enqueueCalendarSync } from './calendar-sync.js';
import { createBookingAccountAlerts } from './account-notifications.js';
import { notifyWorkspace } from './notifications.js';
import { ensureChatThread } from './chat-events.js';
import { reserveBookingUnit } from './venue-allocations.js';

const seriesParticipantInput = z.object({
  studentId: z.string().min(1),
  packageId: z.string().min(1).optional(),
}).strict();

export const bookingSeriesInput = z.object({
  serviceId: z.string().min(1), instructorId: z.string().min(1), locationId: z.string().min(1),
  name: z.string().trim().max(120).default(''),
  occurrenceStartAts: z.array(z.string().datetime({ offset: true })).min(2).max(24),
  participants: z.array(seriesParticipantInput).min(1).max(100),
  notes: z.string().max(2000).default(''), address: z.string().max(500).default(''),
}).strict();

export type BookingSeriesInput = z.infer<typeof bookingSeriesInput>;
type SeriesActor = { userId: string; accountType: 'CLUB'; instructorId: null };

function normalizedOccurrenceDates(values: string[]) {
  const dates = values.map(value => new Date(value));
  for (let index = 1; index < dates.length; index++) {
    if (dates[index]!.getTime() <= dates[index - 1]!.getTime()) {
      throw new HttpError(400, 'Occurrence start times must be unique and in chronological order');
    }
  }
  return dates;
}

async function seriesStudents(tx: Tx, businessId: string, participants: BookingSeriesInput['participants']) {
  const studentIds = participants.map(participant => participant.studentId);
  if (new Set(studentIds).size !== studentIds.length) {
    throw new HttpError(400, 'Each student may appear only once in a series roster');
  }
  const students = await tx.student.findMany({
    where: { businessId, id: { in: studentIds } },
    select: { id: true, userId: true, name: true },
  });
  if (students.length !== studentIds.length) throw new HttpError(404, 'Student not found');
  if (students.some(student => !student.userId)) {
    throw new HttpError(400, 'Every student must be linked to a registered account');
  }
  const byId = new Map(students.map(student => [student.id, student]));
  return participants.map(participant => ({ ...participant, student: byId.get(participant.studentId)! }));
}

/** Create a finite series and its complete initial roster as one aggregate. */
export async function createBookingSeriesInTransaction(
  tx: Tx, businessId: string, input: BookingSeriesInput, actor: SeriesActor,
) {
  const occurrenceDates = normalizedOccurrenceDates(input.occurrenceStartAts);
  await lockInstructors(tx, [input.instructorId]);
  const ctx = await schedulingContext(tx, businessId, input.serviceId, input.instructorId, input.locationId);
  if (ctx.business.kind !== 'CLUB' || ctx.business.legacyReadOnly) {
    throw new HttpError(409, 'This historical business is read-only and cannot create a series');
  }
  const roster = await seriesStudents(tx, businessId, input.participants);
  if (ctx.service.type === 'PRIVATE' && roster.length !== 1) {
    throw new HttpError(400, 'Private series must have exactly one student');
  }
  if (ctx.service.type === 'GROUP' && roster.length > ctx.service.capacity) {
    throw new HttpError(409, 'The roster exceeds this group capacity');
  }

  const studentUserIds = roster.map(entry => entry.student.userId!);
  const slots = [];
  const conflicts: Array<{ startAt: string; reason: string }> = [];
  for (const startAt of occurrenceDates) {
    const slot = await evaluateSlot(tx, ctx, startAt, { studentUserIds });
    if (!slot.available || slot.groupId) conflicts.push({
      startAt: startAt.toISOString(),
      reason: slot.groupId ? 'A group already occupies this time' : slot.reason ?? 'Requested time is unavailable',
    });
    slots.push(slot);
  }
  for (let index = 1; index < slots.length; index++) {
    const previous = slots[index - 1]!;
    const current = slots[index]!;
    if (hasTimeConflict(
      { startAt: current.startAt, endAt: current.endAt, bufferMinutes: ctx.service.bufferMinutes, location: ctx.location },
      { startAt: previous.startAt, endAt: previous.endAt, bufferMinutes: ctx.service.bufferMinutes, location: ctx.location },
    )) conflicts.push({
      startAt: current.startAt.toISOString(), reason: 'Requested series occurrences conflict with each other',
    });
  }
  if (conflicts.length) {
    throw new HttpError(409, 'One or more requested sessions are unavailable. No bookings were created.', { conflicts });
  }

  const packages = new Map<string, Awaited<ReturnType<typeof selectEligibleLessonPackage>>>();
  for (const entry of roster) {
    if (!entry.packageId) continue;
    const pkg = await selectEligibleLessonPackage(tx, {
      packageId: entry.packageId, businessId, studentId: entry.studentId, serviceId: input.serviceId,
      sessionDates: slots.map(slot => slot.startAt),
    });
    const reserved = await tx.lessonPackage.updateMany({
      where: { id: pkg.id, usedCredits: { lte: pkg.totalCredits - slots.length } },
      data: { usedCredits: { increment: slots.length } },
    });
    if (!reserved.count) throw new HttpError(409, `Not enough package credits for ${entry.student.name}`);
    packages.set(entry.studentId, pkg);
  }

  const series = await tx.bookingSeries.create({
    data: {
      businessId, name: input.name, createdByRole: actor.accountType, createdByUserId: actor.userId,
      members: { create: roster.map(entry => ({ studentId: entry.studentId })) },
    },
  });
  const paymentRoute = paymentRouteFor(ctx.business);
  const coachAcceptance = coachAcceptanceFor({ requireLinkedStudent: true, actor }, input.instructorId);
  const initialStatus = coachAcceptance === 'PENDING'
    ? 'PENDING'
    : (ctx.location.requiresApproval || ctx.location.type === 'RENTED') ? 'PENDING' : 'CONFIRMED';
  const bookings = [];
  for (const [position, slot] of slots.entries()) {
    const booking = await tx.booking.create({
      data: {
        businessId, serviceId: input.serviceId, instructorId: input.instructorId, locationId: input.locationId,
        startAt: slot.startAt, endAt: slot.endAt, duration: ctx.assignment.duration,
        bufferMinutes: ctx.service.bufferMinutes, price: ctx.assignment.price, type: ctx.service.type,
        capacity: ctx.service.type === 'PRIVATE' ? 1 : ctx.service.capacity, status: initialStatus,
        paymentRoute, coachAcceptance, createdByRole: actor.accountType, createdByUserId: actor.userId,
        recurringId: series.id, seriesId: series.id, seriesPosition: position,
        venueRequirement: slot.venueUnit ? 'UNIT' : 'NONE',
        venueApproval: (ctx.location.requiresApproval || ctx.location.type === 'RENTED') ? 'PENDING' : 'NOT_REQUIRED',
        notes: input.notes, address: input.address,
        participants: { create: roster.map(entry => {
          const pkg = packages.get(entry.studentId);
          return { studentId: entry.studentId, notes: '', price: ctx.assignment.price, packageId: pkg?.id ?? null,
            paid: pkg?.paid ?? false, creditConsumed: !!pkg, attendance: 'UNMARKED' };
        }) },
      },
      include: bookingInclude,
    });
    if (slot.venueUnit) await reserveBookingUnit(tx, {
      businessId, locationId: input.locationId, unitId: slot.venueUnit.id, unitName: slot.venueUnit.name,
      bookingId: booking.id, startAt: slot.startAt, endAt: slot.endAt,
    });
    await enqueueCalendarSync(tx, booking.id);
    await ensureChatThread(tx, booking.id);
    await createBookingAccountAlerts(tx, booking.id,
      coachAcceptance === 'PENDING' ? 'CLUB_ASSIGNED' : initialStatus === 'PENDING' ? 'REQUESTED' : 'CREATED',
      studentUserIds);
    bookings.push(bookingJson(booking));
  }
  await notifyWorkspace(tx, {
    businessId, instructorId: input.instructorId, bookingId: bookings[0]?.id ?? null,
    type: coachAcceptance === 'PENDING' ? 'PENDING_ACTION' : 'BOOKING',
    actionNeeded: coachAcceptance === 'PENDING',
    title: coachAcceptance === 'PENDING' ? 'Class series awaiting coach acceptance' : 'Class series created',
    message: `${slots.length} sessions were created for ${roster.length} student${roster.length === 1 ? '' : 's'}.`,
  });
  return { series: { id: series.id, name: series.name, occurrenceCount: bookings.length, memberCount: roster.length }, bookings };
}

export function createBookingSeries(businessId: string, input: BookingSeriesInput, actor: SeriesActor) {
  return prisma.$transaction(tx => createBookingSeriesInTransaction(tx, businessId, input, actor), { timeout: 30_000 });
}

export const bookingSeriesRouter = Router();
bookingSeriesRouter.post('/booking-series', requireClubPermission('BOOKINGS_MANAGE'), asyncRoute(async (req, res) => {
  const result = await createBookingSeries(req.auth.business.id, bookingSeriesInput.parse(req.body), {
    userId: req.auth.user.id, accountType: 'CLUB', instructorId: null,
  });
  res.status(201).json(result);
}));
