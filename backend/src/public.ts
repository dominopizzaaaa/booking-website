import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { prisma } from './db.js';
import { asyncRoute, HttpError } from './http.js';
import { bookingInclude, bookingJson, publicBookingBusiness, publicInstructor, publicLocation, serviceJson } from './serializers.js';
import { bookingInput, createBookings, evaluateSlot, lockInstructors, managementTokenHash, refundParticipant, rescheduleBooking, schedulingContext } from './scheduling.js';
export const publicRouter = Router();
const bookingLimit = rateLimit({ windowMs: 60 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please try again later.' } });
const slotLimit = rateLimit({ windowMs: 5 * 60_000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many availability checks. Please wait a moment.' } });
async function businessForSlug(slug: string) {
  const business = await prisma.business.findUnique({ where: { slug } });
  if (!business) throw new HttpError(404, 'Booking page not found');
  return business;
}
publicRouter.get('/public/:slug', asyncRoute(async (req, res) => {
  const business = await businessForSlug(req.params.slug);
  const [instructors, locations, services] = await Promise.all([
    prisma.instructor.findMany({ where: { businessId: business.id, active: true }, orderBy: { name: 'asc' } }),
    prisma.location.findMany({ where: { businessId: business.id, active: true }, orderBy: { name: 'asc' } }),
    prisma.service.findMany({ where: { businessId: business.id, active: true }, include: { locations: { include: { instructors: true } } }, orderBy: { name: 'asc' } }),
  ]);
  res.json({ business: publicBookingBusiness(business), instructors: instructors.map(publicInstructor), locations: locations.map(publicLocation), services: services.map(serviceJson) });
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
publicRouter.post('/public/:slug/bookings', bookingLimit, asyncRoute(async (req, res) => {
  const input = bookingInput.parse(req.body);
  if (input.customerId || input.packageId) throw new HttpError(403, 'Guest bookings require contact details. Contact your coach to apply package credits.');
  const business = await businessForSlug(req.params.slug);
  const result = await createBookings(business.id, input, { guest: true });
  // A guest must never receive another group participant's identity, a team's
  // private lesson notes, or another participant's management credential.
  res.status(201).json({ ...result, bookings: result.bookings.map(b => {
    const { notes: _internalNotes, ...publicBooking } = b;
    return { ...publicBooking, participants: b.participants.filter(p => p.email === input.customer!.email) };
  }) });
}));
async function managed(token: string) {
  const participant = await prisma.participant.findUnique({ where: { managementTokenHash: managementTokenHash(token) }, include: { customer: true, booking: { include: { ...bookingInclude, business: true } } } });
  if (!participant) throw new HttpError(404, 'Management link not found');
  if (participant.managementTokenRevokedAt || participant.managementTokenExpiresAt <= new Date()) throw new HttpError(410, 'This management link has expired. Please contact your coach.');
  return participant;
}
function canManage(p: Awaited<ReturnType<typeof managed>>) {
  return !p.cancelledAt && !['CANCELLED', 'COMPLETED'].includes(p.booking.status) && p.booking.startAt.getTime() - Date.now() >= p.booking.business.cancellationHours * 3600_000;
}
function manageJson(p: Awaited<ReturnType<typeof managed>>) {
  const single = bookingJson({ ...p.booking, participants: [{ ...p, cancelledAt: null }] }, { includeNotes: false });
  if (p.cancelledAt) single.status = 'CANCELLED';
  return { business: publicBookingBusiness(p.booking.business), booking: single, participant: single.participants[0], location: publicLocation(p.booking.location), canCancel: canManage(p), canReschedule: canManage(p) && p.booking.type === 'PRIVATE', management: { cancellationHours: p.booking.business.cancellationHours, reminders: 'Queued in Courtly; external delivery is not configured', venueReserved: false } };
}
publicRouter.get('/manage/:token', asyncRoute(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(manageJson(await managed(req.params.token))); }));
publicRouter.post('/manage/:token/cancel', bookingLimit, asyncRoute(async (req, res) => {
  const initial = await managed(req.params.token);
  await prisma.$transaction(async tx => {
    await lockInstructors(tx, [initial.booking.instructorId]);
    const participant = await tx.participant.findUniqueOrThrow({ where: { id: initial.id }, include: { booking: { include: { business: true } } } });
    if (participant.cancelledAt || participant.booking.status === 'CANCELLED') return;
    if (participant.booking.instructorId !== initial.booking.instructorId) throw new HttpError(409, 'Session changed. Please refresh and try again');
    if (participant.booking.status === 'COMPLETED' || participant.booking.startAt.getTime() - Date.now() < participant.booking.business.cancellationHours * 3600_000) throw new HttpError(400, `Cancellation requires ${participant.booking.business.cancellationHours} hours notice. Please contact your coach.`);
    await refundParticipant(tx, participant);
    await tx.participant.update({ where: { id: participant.id }, data: { cancelledAt: new Date() } });
    const remaining = await tx.participant.count({ where: { bookingId: participant.bookingId, cancelledAt: null } });
    if (!remaining) await tx.booking.update({ where: { id: participant.bookingId }, data: { status: 'CANCELLED' } });
    await tx.notification.create({ data: { businessId: participant.booking.businessId, instructorId: participant.booking.instructorId, title: 'Guest cancelled a booking', message: 'The player cancelled using their private link. Any consumed package credit was restored. Cancellation notice queued; no external message sent.' } });
  });
  res.json(manageJson(await managed(req.params.token)));
}));
publicRouter.post('/manage/:token/reschedule', bookingLimit, asyncRoute(async (req, res) => {
  const changes = z.object({ startAt: z.string().datetime({ offset: true }) }).strict().parse(req.body);
  const initial = await managed(req.params.token);
  await prisma.$transaction(async tx => {
    await lockInstructors(tx, [initial.booking.instructorId]);
    const p = await tx.participant.findUniqueOrThrow({ where: { id: initial.id }, include: { booking: { include: { business: true } } } });
    if (p.booking.instructorId !== initial.booking.instructorId) throw new HttpError(409, 'Session changed. Please refresh and try again');
    if (p.cancelledAt || !['CONFIRMED', 'PENDING'].includes(p.booking.status) || p.booking.startAt.getTime() - Date.now() < p.booking.business.cancellationHours * 3600_000) throw new HttpError(400, 'This booking is outside the self-service rescheduling window. Contact your coach.');
    if (p.booking.type !== 'PRIVATE') throw new HttpError(400, 'Please contact your coach to move your place in a group session');
    await rescheduleBooking(tx, p.booking.businessId, p.bookingId, changes);
  }, { timeout: 30_000 });
  res.json(manageJson(await managed(req.params.token)));
}));
