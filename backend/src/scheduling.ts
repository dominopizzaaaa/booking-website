import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db.js';
import { HttpError, initials, type AccountType } from './http.js';
import { bookingInclude, bookingJson } from './serializers.js';
import { createBookingAccountAlerts } from './account-notifications.js';
import { notifyWorkspace } from './notifications.js';
import { flagPrivateSessionsAfterClub } from './integrity.js';

const bookingSelection = {
  serviceId: z.string().min(1), instructorId: z.string().min(1), locationId: z.string().min(1),
  startAt: z.string().datetime({ offset: true }),
  repeatWeeks: z.number().int().min(1).max(12).default(1), packageId: z.string().min(1).optional(), notes: z.string().max(2000).default(''), address: z.string().max(500).default(''),
};
const studentContact = z.object({
  phone: z.string().trim().max(40).optional(),
  parentName: z.string().trim().max(120).optional(),
}).strict();
export const bookingInput = z.object({
  ...bookingSelection,
  studentId: z.string().min(1).optional(),
  student: studentContact.extend({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().transform(s => s.toLowerCase()),
  }).strict().optional(),
}).strict().refine(x => !!x.studentId || !!x.student, { message: 'Student details are required' });
export const publicBookingInput = z.object({
  ...bookingSelection,
  student: studentContact.optional(),
}).strict();
export type BookingInput = z.infer<typeof bookingInput>;
export type PublicBookingInput = z.infer<typeof publicBookingInput>;
export type Tx = Prisma.TransactionClient;
/**
 * Who is creating this booking, which decides two things that cannot be
 * derived later: whether the coach still has to accept it, and whose name
 * goes on the audit trail.
 *  - `studentUserId`  the student booked it themselves
 *  - `actor`           a provider created it inside a workspace
 */
export type CreateBookingsOptions =
  | { studentUserId: string }
  | {
      requireLinkedStudent: true;
      actor?: { userId: string; accountType: AccountType; instructorId: string | null };
    };

/** "CLUB" money runs through the club's books; "DIRECT" goes to the coach. */
export const paymentRouteFor = (business: { kind: string }) => business.kind === 'SOLO' ? 'DIRECT' : 'CLUB';

/**
 * A club may assign a student to a coach without asking the student, but the
 * coach must accept before the lesson counts as confirmed. A coach booking
 * their own session, or a student booking a coach directly in a solo
 * practice, needs no second acceptance from the same person.
 */
export function coachAcceptanceFor(
  options: CreateBookingsOptions,
  instructorId: string,
): 'NOT_REQUIRED' | 'PENDING' {
  if ('studentUserId' in options) return 'NOT_REQUIRED';
  const actor = options.actor;
  if (!actor) return 'NOT_REQUIRED';
  if (actor.accountType === 'COACH' && actor.instructorId === instructorId) return 'NOT_REQUIRED';
  return 'PENDING';
}

// A roster row by itself is not enough to host a new session. Legacy data can
// retain unclaimed instructors for history and later account connection, but
// only an active membership backed by a registered provider account is
// bookable. Keep this predicate shared by catalog and scheduling entry points
// so a hidden legacy coach cannot still be selected with a crafted request.
export const bookableInstructorWhere = (businessId?: string): Prisma.InstructorWhereInput => ({
  ...(businessId ? { businessId } : {}),
  active: true,
  membership: {
    is: {
      ...(businessId ? { businessId } : {}),
      active: true,
      user: {
        is: {
          passwordHash: { not: null },
          // Only a coach account teaches. A club account is the club itself
          // and never appears on its own roster.
          accountType: 'COACH',
        },
      },
    },
  },
});

export async function lockInstructors(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
}
export function travelMinutes(from: { id: string; travelMinutes: number }, to: { id: string; travelMinutes: number }) {
  return from.id === to.id ? 0 : Math.max(from.travelMinutes, to.travelMinutes);
}
export function hasTimeConflict(candidate: { startAt: Date; endAt: Date; bufferMinutes: number; location: { id: string; travelMinutes: number } }, existing: { startAt: Date; endAt: Date; bufferMinutes: number; location: { id: string; travelMinutes: number } }) {
  const travel = travelMinutes(existing.location, candidate.location) * 60_000;
  if (existing.endAt <= candidate.startAt) return existing.endAt.getTime() + travel + candidate.bufferMinutes * 60_000 > candidate.startAt.getTime();
  if (candidate.endAt <= existing.startAt) return candidate.endAt.getTime() + travel + existing.bufferMinutes * 60_000 > existing.startAt.getTime();
  return true;
}
export function fitsWorkingHours(startAt: Date, endAt: Date, timezone: string, blocks: { dayOfWeek: number; startTime: string; endTime: string }[], buffer = 0) {
  const start = DateTime.fromJSDate(startAt, { zone: timezone }).minus({ minutes: buffer });
  const end = DateTime.fromJSDate(endAt, { zone: timezone });
  if (start.toISODate() !== end.toISODate()) return false;
  return blocks.some(b => {
    if (b.dayOfWeek !== start.weekday % 7) return false;
    const [startHour, startMinute] = b.startTime.split(':').map(Number);
    const [endHour, endMinute] = b.endTime.split(':').map(Number);
    return start.toMillis() >= start.startOf('day').plus({ hours: startHour, minutes: startMinute }).toMillis()
      && end.toMillis() <= end.startOf('day').plus({ hours: endHour, minutes: endMinute }).toMillis();
  });
}
export async function schedulingContext(tx: Tx, businessId: string, serviceId: string, instructorId: string, locationId: string) {
  const [business, service, instructor, location, blocks, exceptions] = await Promise.all([
    tx.business.findUniqueOrThrow({ where: { id: businessId } }),
    tx.service.findFirst({ where: { id: serviceId, businessId, active: true }, include: { locations: { include: { instructors: true } } } }),
    tx.instructor.findFirst({ where: { id: instructorId, ...bookableInstructorWhere(businessId) } }),
    tx.location.findFirst({ where: { id: locationId, businessId, active: true } }),
    tx.availability.findMany({ where: { businessId, instructorId, locationId } }),
    tx.availabilityException.findMany({ where: { businessId, instructorId } }),
  ]);
  if (!service || !instructor || !location) throw new HttpError(404, 'Service, coach or location not found');
  const assignment = service.locations.find(l => l.locationId === locationId && l.instructors.some(i => i.instructorId === instructorId));
  if (!assignment) throw new HttpError(400, 'This service is not offered by that coach at this location');
  return { business, service, instructor, location, blocks, exceptions, assignment };
}
type Context = Awaited<ReturnType<typeof schedulingContext>>;
export async function evaluateSlot(tx: Tx, ctx: Context, startAt: Date, excludeBookingId?: string, snapshot?: { duration: number; bufferMinutes: number }) {
  const duration = snapshot?.duration ?? ctx.assignment.duration;
  const buffer = snapshot?.bufferMinutes ?? ctx.service.bufferMinutes;
  const endAt = new Date(startAt.getTime() + duration * 60_000);
  const result = (reason: string, placesRemaining = 0, groupId?: string) => ({ startAt, endAt, available: !reason, placesRemaining, reason: reason || undefined, groupId });
  if (startAt.getTime() < Date.now() + ctx.service.noticeHours * 3600_000) return result(`At least ${ctx.service.noticeHours} hours notice is required`);
  const local = DateTime.fromJSDate(startAt, { zone: ctx.business.timezone });
  if (ctx.exceptions.some(e => e.date === local.toISODate())) return result('Coach is unavailable on this date');
  if (!fitsWorkingHours(startAt, endAt, ctx.business.timezone, ctx.blocks, buffer)) return result('Outside working hours at this location');
  const nearby = await tx.booking.findMany({ where: { businessId: ctx.business.id, instructorId: ctx.instructor.id, status: { not: 'CANCELLED' }, id: excludeBookingId ? { not: excludeBookingId } : undefined, startAt: { lt: new Date(endAt.getTime() + 86400_000) }, endAt: { gt: new Date(startAt.getTime() - 86400_000) } }, include: { location: true, participants: { where: { cancelledAt: null } } } });
  const group = nearby.find(b => ctx.service.type === 'GROUP' && b.type === 'GROUP' && b.serviceId === ctx.service.id && b.locationId === ctx.location.id && b.startAt.getTime() === startAt.getTime());
  if (group && (group.endAt.getTime() !== endAt.getTime() || group.status === 'COMPLETED')) return result('Existing group has a different duration or is completed');
  const conflict = nearby.find(b => b.id !== group?.id && hasTimeConflict({ startAt, endAt, location: ctx.location, bufferMinutes: buffer }, b));
  if (conflict) return result(conflict.locationId === ctx.location.id ? 'Coach already has a session or preparation buffer' : 'Coach is booked elsewhere or needs travel time');
  const remaining = group ? group.capacity - group.participants.length : ctx.service.capacity;
  if (remaining <= 0) return result('This group is full');
  return result('', remaining, group?.id);
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

async function syncAccountContact(tx: Tx, userId: string, contact: BookingInput['student']) {
  // Booking details edit the student's personal profile, so serialize them
  // with profile edits and keep every club-local projection in lockstep.
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  const changed = contact && (contact.phone !== undefined || contact.parentName !== undefined);
  const account = changed
    ? await tx.user.update({
        where: { id: userId },
        data: {
          ...(contact.phone !== undefined ? { phone: contact.phone } : {}),
          ...(contact.parentName !== undefined ? { parentName: contact.parentName } : {}),
        },
        select: { name: true, email: true, phone: true, parentName: true },
      })
    : await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { name: true, email: true, phone: true, parentName: true },
      });
  await tx.student.updateMany({
    where: { userId },
    data: { phone: account.phone, parentName: account.parentName },
  });
  return account;
}

async function resolveAccountStudent(tx: Tx, businessId: string, userId: string, profile: NonNullable<BookingInput['student']>) {
  // Serializing first-time resolution makes creating the account-backed club
  // profile race-safe. Legacy email-only rows are intentionally never claimed:
  // registration alone does not prove ownership of an old contact address.
  const lockKey = `account-student:${businessId}:${userId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

  const account = await syncAccountContact(tx, userId, profile);
  const linked = await tx.student.findFirst({ where: { businessId, userId } });
  if (linked) return linked;

  const email = normalizeEmail(account.email);
  const legacyContact = await tx.student.findUnique({
    where: { businessId_email: { businessId, email } },
    select: { id: true, userId: true },
  });
  if (legacyContact) {
    throw new HttpError(409, legacyContact.userId
      ? 'This email is already connected to another student account for this business'
      : 'This business already has unclaimed history for this email. Ask the club to verify and connect your account before booking');
  }

  return tx.student.create({ data: {
    businessId, userId, name: account.name, email, initials: initials(account.name),
    phone: account.phone, parentName: account.parentName,
  } });
}

async function resolveBookingStudent(tx: Tx, businessId: string, input: BookingInput, options: CreateBookingsOptions) {
  if ('studentUserId' in options) {
    if (input.studentId) throw new HttpError(400, 'Account bookings cannot select a student identity');
    if (!input.student) throw new HttpError(400, 'Student account details are required');
    return resolveAccountStudent(tx, businessId, options.studentUserId, input.student);
  }

  // Provider bookings must select an existing account-backed student. They
  // cannot silently create an email-only student from request contact data.
  if (!input.studentId || input.student) throw new HttpError(400, 'Select an existing account-linked student');
  const student = await tx.student.findFirst({ where: { id: input.studentId, businessId } });
  if (!student) throw new HttpError(404, 'Student not found');
  if (!student.userId) throw new HttpError(400, 'Student must be linked to a registered account');
  return student;
}

export async function createBookingsInTransaction(tx: Tx, businessId: string, input: BookingInput, options: CreateBookingsOptions = { requireLinkedStudent: true }) {
  await lockInstructors(tx, [input.instructorId]);
  const ctx = await schedulingContext(tx, businessId, input.serviceId, input.instructorId, input.locationId);
  const accountBooking = 'studentUserId' in options;
  const student = await resolveBookingStudent(tx, businessId, input, options);
  const first = DateTime.fromISO(input.startAt, { zone: ctx.business.timezone });
  const occurrences = [];
  const conflicts = [];
  for (let week = 0; week < input.repeatWeeks; week++) {
    const date = first.plus({ weeks: week }).toJSDate();
    const slot = await evaluateSlot(tx, ctx, date);
    if (!slot.available) conflicts.push({ date: date.toISOString(), reason: slot.reason });
    if (slot.groupId && await tx.participant.findFirst({ where: { bookingId: slot.groupId, studentId: student.id, cancelledAt: null } })) conflicts.push({ date: date.toISOString(), reason: 'Student is already enrolled in this group' });
    occurrences.push(slot);
  }
  if (conflicts.length) throw new HttpError(409, 'One or more requested sessions are unavailable. No bookings were created.', { conflicts });
  let pkg = null;
  if (input.packageId) {
    await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${input.packageId} AND "businessId" = ${businessId} FOR UPDATE`;
    pkg = await tx.lessonPackage.findFirst({ where: { id: input.packageId, businessId, studentId: student.id } });
    if (!pkg || (pkg.serviceId && pkg.serviceId !== input.serviceId)) throw new HttpError(400, 'Package does not belong to this student or service');
    if (occurrences.some(s => s.startAt > pkg!.expiresAt) || pkg.expiresAt < new Date()) throw new HttpError(400, 'Package expires before one or more sessions');
    const updated = await tx.lessonPackage.updateMany({ where: { id: pkg.id, usedCredits: { lte: pkg.totalCredits - occurrences.length } }, data: { usedCredits: { increment: occurrences.length } } });
    if (!updated.count) throw new HttpError(409, 'Not enough package credits for all sessions');
  }
  const recurringId = occurrences.length > 1 ? randomUUID() : null;
  const paymentRoute = paymentRouteFor(ctx.business);
  const coachAcceptance = coachAcceptanceFor(options, input.instructorId);
  const actor = 'studentUserId' in options ? null : options.actor ?? null;
  const createdByRole = accountBooking ? 'STUDENT' : actor?.accountType === 'COACH' ? 'COACH' : 'CLUB';
  const createdByUserId = accountBooking ? options.studentUserId : actor?.userId ?? null;
  // A lesson the coach has not accepted yet is not a confirmed lesson, even at
  // a venue that needs no approval.
  const venuePendingStatus = (ctx.location.requiresApproval || ctx.location.type === 'RENTED') ? 'PENDING' : 'CONFIRMED';
  const initialStatus = coachAcceptance === 'PENDING' ? 'PENDING' : venuePendingStatus;
  const booked = [];
  for (const slot of occurrences) {
    let bookingId = slot.groupId;
    if (!bookingId) {
      const booking = await tx.booking.create({ data: { businessId, serviceId: input.serviceId, instructorId: input.instructorId, locationId: input.locationId, startAt: slot.startAt, endAt: slot.endAt, duration: ctx.assignment.duration, bufferMinutes: ctx.service.bufferMinutes, price: ctx.assignment.price, type: ctx.service.type, capacity: ctx.service.type === 'PRIVATE' ? 1 : ctx.service.capacity, status: initialStatus, paymentRoute, coachAcceptance, createdByRole, createdByUserId, recurringId, notes: accountBooking ? '' : input.notes, address: input.address } });
      bookingId = booking.id;
    }
    const existing = await tx.participant.findUnique({ where: { bookingId_studentId: { bookingId, studentId: student.id } } });
    const sessionSnapshot = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { price: true } });
    const participantData = { managementTokenHash: null, managementTokenExpiresAt: null, managementTokenRevokedAt: null, notes: accountBooking ? input.notes : '', price: sessionSnapshot.price, packageId: pkg?.id ?? null, paid: pkg?.paid ?? false, creditConsumed: !!pkg, cancelledAt: null, attendance: 'UNMARKED' };
    if (existing) await tx.participant.update({ where: { id: existing.id }, data: participantData });
    else await tx.participant.create({ data: { bookingId, studentId: student.id, ...participantData } });
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: bookingInclude });
    const json = bookingJson(booking, { includeNotes: !accountBooking });
    booked.push(accountBooking
      ? { ...json, participants: json.participants.filter(participant => participant.studentId === student.id) }
      : json);
  }
  // An enrollment can join an existing group whose coach decision was made
  // by an earlier creator. Summarize the persisted first session, not this
  // actor's creation defaults, while retaining one workspace alert per request.
  const summaryBooking = booked[0];
  const awaitingCoach = summaryBooking?.coachAcceptance === 'PENDING';
  const confirmationPending = summaryBooking?.status === 'PENDING' && !awaitingCoach;
  await notifyWorkspace(tx, {
    businessId,
    instructorId: input.instructorId,
    bookingId: summaryBooking?.id ?? null,
    type: awaitingCoach ? 'PENDING_ACTION' : 'BOOKING',
    actionNeeded: awaitingCoach,
    title: awaitingCoach
      ? `Lesson awaiting your acceptance · ${student.name}`
      : `${booked.length > 1 ? 'Recurring booking' : 'New booking'} · ${student.name}`,
    message: awaitingCoach
      ? `${ctx.service.name} with ${student.name} was assigned to ${ctx.instructor.name}. It is confirmed once the coach accepts it.`
      : `${ctx.service.name} with ${ctx.instructor.name}. ${confirmationPending ? 'Venue approval is required; no external court has been reserved. ' : ''}Booking confirmation and 24-hour reminder queued in Courtly; external delivery is not configured.`,
  });
  for (const booking of booked) {
    await createBookingAccountAlerts(
      tx, booking.id,
      booking.coachAcceptance === 'PENDING' ? 'CLUB_ASSIGNED'
        : booking.status === 'PENDING' ? 'REQUESTED' : 'CREATED',
      [student.userId],
    );
    // Only a lesson that skips the club's books can bypass a club, so the
    // safeguard is evaluated exactly where that money path is decided.
    if (paymentRoute === 'DIRECT') await flagPrivateSessionsAfterClub(tx, booking.id);
  }
  return { bookings: booked };
}
export const createBookings = (businessId: string, input: BookingInput, options: CreateBookingsOptions = { requireLinkedStudent: true }) => prisma.$transaction(tx => createBookingsInTransaction(tx, businessId, input, options), { timeout: 30_000 });

export async function refundParticipant(tx: Tx, participant: { id: string; packageId: string | null; creditConsumed: boolean }) {
  if (!participant.creditConsumed || !participant.packageId) return;
  const changed = await tx.participant.updateMany({ where: { id: participant.id, creditConsumed: true }, data: { creditConsumed: false } });
  if (changed.count) await tx.lessonPackage.updateMany({ where: { id: participant.packageId, usedCredits: { gt: 0 } }, data: { usedCredits: { decrement: 1 } } });
}
export async function cancelBooking(tx: Tx, businessId: string, bookingId: string) {
  let booking = await tx.booking.findFirst({ where: { id: bookingId, businessId } });
  if (!booking) throw new HttpError(404, 'Booking not found');
  await lockInstructors(tx, [booking.instructorId]);
  const current = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { participants: true } });
  if (current.instructorId !== booking.instructorId) throw new HttpError(409, 'Session changed concurrently. Please retry.');
  if (current.status === 'COMPLETED') throw new HttpError(400, 'A completed session cannot be cancelled');
  if (current.status === 'CANCELLED') return;
  for (const participant of current.participants) await refundParticipant(tx, participant);
  await tx.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });
  await notifyWorkspace(tx, { businessId, instructorId: current.instructorId, bookingId, type: 'CANCELLATION', title: 'Session cancelled', message: 'Package credits were restored. Cancellation notification queued; no external message has been sent.' });
  await createBookingAccountAlerts(tx, bookingId, 'PROVIDER_CANCELLED');
}

export async function rescheduleBooking(tx: Tx, businessId: string, bookingId: string, changes: { startAt: string }) {
  const original = await tx.booking.findFirst({ where: { id: bookingId, businessId } });
  if (!original) throw new HttpError(404, 'Booking not found');
  await lockInstructors(tx, [original.instructorId]);
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      service: true, instructor: true, location: true,
      participants: { include: { student: true, package: true }, where: { cancelledAt: null } },
    },
  });
  if (booking.instructorId !== original.instructorId) throw new HttpError(409, 'Session changed concurrently. Please retry.');
  if (['CANCELLED', 'COMPLETED'].includes(booking.status)) throw new HttpError(400, 'Only active sessions can be rescheduled');
  if (booking.coachAcceptance === 'PENDING') {
    throw new HttpError(400, 'This lesson is still waiting for the coach to accept it. Reschedule it once it is confirmed.');
  }
  const startAt = new Date(changes.startAt);
  // Equivalent ISO offsets represent the same instant. Return the existing
  // booking before availability evaluation or writes so retries are harmless.
  if (startAt.getTime() === booking.startAt.getTime()) return bookingJson(booking);
  const ctx = await schedulingContext(tx, businessId, booking.serviceId, booking.instructorId, booking.locationId);
  const slot = await evaluateSlot(tx, ctx, startAt, booking.id, { duration: booking.duration, bufferMinutes: booking.bufferMinutes });
  if (!slot.available || slot.groupId) throw new HttpError(409, 'Requested time is unavailable', { conflicts: [{ date: changes.startAt, reason: slot.reason || 'A group already occupies that time' }] });
  if (booking.participants.some(p => p.package && p.package.expiresAt < startAt)) throw new HttpError(400, 'Package would expire before the rescheduled session');
  const updated = await tx.booking.update({ where: { id: booking.id }, data: { startAt, endAt: slot.endAt, instructorId: ctx.instructor.id, locationId: ctx.location.id, status: (ctx.location.requiresApproval || ctx.location.type === 'RENTED') ? 'PENDING' : 'CONFIRMED' }, include: bookingInclude });
  await notifyWorkspace(tx, { businessId, instructorId: updated.instructorId, bookingId: updated.id, type: 'RESCHEDULE', title: 'Session rescheduled', message: 'Schedule updated. Change notification and reminder queued in Courtly; external delivery is not configured.' });
  await createBookingAccountAlerts(tx, booking.id, 'RESCHEDULED');
  return bookingJson(updated);
}
