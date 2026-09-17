import { Router } from 'express';
import { z } from 'zod';
import { prisma } from './db.js';
import { adminOnly, asyncRoute, coachScope, HttpError } from './http.js';
import { bookingInput, cancelBooking, createBookings, lockInstructors, rescheduleBooking } from './scheduling.js';
import { bookingInclude, bookingJson, withoutBookingFinancials } from './serializers.js';
import { createBookingAccountAlerts } from './account-notifications.js';
export const bookingsRouter = Router();
bookingsRouter.post('/bookings', asyncRoute(async (req, res) => {
  const input = bookingInput.parse(req.body);
  coachScope(req, input.instructorId);
  if (req.auth.membership!.role === 'COACH' && input.packageId) {
    throw new HttpError(403, 'Coaches cannot apply lesson packages');
  }
  // Provider-created bookings may select an existing customer, but they may
  // never mint a guest/contact-only identity. The scheduler enforces that the
  // selected Customer is linked to a registered global account.
  const result = await createBookings(req.auth.business!.id, input, { requireLinkedCustomer: true });
  res.status(201).json(req.auth.membership!.role === 'COACH'
    ? { ...result, bookings: result.bookings.map(withoutBookingFinancials) }
    : result);
}));
bookingsRouter.get('/bookings', asyncRoute(async (req, res) => {
  const coach = req.auth.membership!.role === 'COACH';
  const bookings = await prisma.booking.findMany({ where: { businessId: req.auth.business!.id, instructorId: coach ? req.auth.membership!.instructorId || '__none__' : undefined }, include: bookingInclude, orderBy: { startAt: 'asc' } });
  res.json(bookings.map(b => {
    const json = bookingJson(b);
    return coach ? withoutBookingFinancials(json) : json;
  }));
}));
bookingsRouter.patch('/bookings/:id', asyncRoute(async (req, res) => {
  const body = z.object({ status: z.enum(['CONFIRMED', 'PENDING', 'CANCELLED', 'COMPLETED']).optional(), notes: z.string().max(2000).optional() }).strict().parse(req.body);
  const result = await prisma.$transaction(async tx => {
    const initial = await tx.booking.findFirst({ where: { id: req.params.id, businessId: req.auth.business.id } });
    if (!initial) throw new HttpError(404, 'Booking not found');
    coachScope(req, initial.instructorId);
    await lockInstructors(tx, [initial.instructorId]);
    const current = await tx.booking.findUniqueOrThrow({ where: { id: initial.id } });
    coachScope(req, current.instructorId);
    if (current.instructorId !== initial.instructorId) throw new HttpError(409, 'Session changed. Please retry.');
    const statusChanged = body.status !== undefined && body.status !== current.status;
    if (statusChanged && current.status === 'CANCELLED') throw new HttpError(400, 'Cancelled sessions cannot be reopened. Create a new booking.');
    if (statusChanged && body.status === 'CONFIRMED') {
      const location = await tx.location.findUniqueOrThrow({ where: { id: current.locationId } });
      if ((location.type === 'RENTED' || location.requiresApproval) && req.auth.membership!.role === 'COACH') {
        throw new HttpError(403, 'Only an owner or admin can confirm a lesson that requires venue approval');
      }
    }
    if (statusChanged && body.status === 'CANCELLED') await cancelBooking(tx, req.auth.business.id, current.id);
    else if (statusChanged && body.status) {
      await tx.booking.update({ where: { id: current.id }, data: { status: body.status } });
      const event = body.status === 'CONFIRMED' ? 'CONFIRMED'
        : body.status === 'PENDING' ? 'PENDING'
          : body.status === 'COMPLETED' ? 'COMPLETED'
            : null;
      if (event) await createBookingAccountAlerts(tx, current.id, event);
    }
    if (body.notes !== undefined) await tx.booking.update({ where: { id: current.id }, data: { notes: body.notes } });
    return tx.booking.findUniqueOrThrow({ where: { id: current.id }, include: bookingInclude });
  });
  const json = bookingJson(result);
  res.json(req.auth.membership!.role === 'COACH' ? withoutBookingFinancials(json) : json);
}));
bookingsRouter.patch('/bookings/:id/participants/:participantId', asyncRoute(async (req, res) => {
  const body = z.object({ attendance: z.enum(['UNMARKED', 'PRESENT', 'ABSENT']) }).strict().parse(req.body);
  const result = await prisma.$transaction(async tx => {
    const initial = await tx.booking.findFirst({ where: { id: req.params.id, businessId: req.auth.business.id } });
    if (!initial) throw new HttpError(404, 'Booking not found');
    coachScope(req, initial.instructorId);
    await lockInstructors(tx, [initial.instructorId]);
    const participant = await tx.participant.findFirst({ where: { id: req.params.participantId, bookingId: req.params.id, cancelledAt: null, booking: { businessId: req.auth.business.id } }, include: { booking: true } });
    if (!participant) throw new HttpError(404, 'Participant not found');
    coachScope(req, participant.booking.instructorId);
    if (participant.booking.instructorId !== initial.instructorId) throw new HttpError(409, 'Session changed. Please retry.');
    if (participant.booking.status === 'CANCELLED') throw new HttpError(400, 'Cannot mark attendance for a cancelled lesson');
    return tx.participant.update({ where: { id: participant.id }, data: body });
  });
  res.json({ id: result.id, attendance: result.attendance });
}));
bookingsRouter.post('/bookings/:id/reschedule', asyncRoute(async (req, res) => {
  const changes = z.object({ startAt: z.string().datetime({ offset: true }) }).strict().parse(req.body);
  const initial = await prisma.booking.findFirst({ where: { id: req.params.id, businessId: req.auth.business.id } });
  if (!initial) throw new HttpError(404, 'Booking not found');
  coachScope(req, initial.instructorId);
  const result = await prisma.$transaction(async tx => {
    await lockInstructors(tx, [initial.instructorId]);
    const current = await tx.booking.findUniqueOrThrow({ where: { id: initial.id } });
    coachScope(req, current.instructorId);
    if (current.instructorId !== initial.instructorId) throw new HttpError(409, 'Session changed. Please retry.');
    return rescheduleBooking(tx, req.auth.business.id, req.params.id, changes);
  }, { timeout: 30_000 });
  res.json(req.auth.membership!.role === 'COACH' ? withoutBookingFinancials(result) : result);
}));
bookingsRouter.post('/payments', adminOnly, asyncRoute(async (req, res) => {
  const input = z.object({ customerId: z.string().min(1), bookingId: z.string().min(1).optional(), packageId: z.string().min(1).optional(), participantId: z.string().min(1).optional(), amount: z.number().int().positive().max(100_000_000), method: z.enum(['CASH', 'BANK_TRANSFER', 'OTHER']), note: z.string().max(1000).default('') }).refine(x => !(x.bookingId && x.packageId), { message: 'Record a payment against a booking or a package, not both' }).parse(req.body);
  const result = await prisma.$transaction(async tx => {
    const customer = await tx.customer.findFirst({ where: { id: input.customerId, businessId: req.auth.business.id } });
    if (!customer) throw new HttpError(404, 'Customer not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${customer.id}`}, 0))`;
    if (input.bookingId) {
      const booking = await tx.booking.findFirst({ where: { id: input.bookingId, businessId: req.auth.business.id } });
      if (!booking) throw new HttpError(404, 'Booking not found');
      await lockInstructors(tx, [booking.instructorId]);
      const participant = await tx.participant.findFirst({ where: { bookingId: input.bookingId, customerId: customer.id, cancelledAt: null, ...(input.participantId ? { id: input.participantId } : {}) }, include: { booking: true } });
      if (!participant) throw new HttpError(400, 'Customer is not enrolled in this booking');
      if (participant.booking.status === 'CANCELLED') throw new HttpError(400, 'Cannot charge a cancelled booking');
      if (participant.packageId) throw new HttpError(400, 'Record payment against this participant’s package instead');
      if (participant.paid) throw new HttpError(409, 'This participant is already paid');
      const previous = await tx.payment.aggregate({ where: { bookingId: input.bookingId, customerId: customer.id }, _sum: { amount: true } });
      if ((previous._sum.amount ?? 0) + input.amount > participant.price + 0.001) throw new HttpError(400, 'Payment exceeds this participant’s remaining balance');
      if ((previous._sum.amount ?? 0) + input.amount >= participant.price - 0.001) await tx.participant.update({ where: { id: participant.id }, data: { paid: true } });
    }
    if (input.packageId) {
      await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${input.packageId} AND "businessId" = ${req.auth.business.id} FOR UPDATE`;
      const pkg = await tx.lessonPackage.findFirst({ where: { id: input.packageId, businessId: req.auth.business.id, customerId: customer.id } });
      if (!pkg) throw new HttpError(404, 'Package not found for this customer');
      if (pkg.paid) throw new HttpError(409, 'Package is already paid');
      const previous = await tx.payment.aggregate({ where: { packageId: pkg.id }, _sum: { amount: true } });
      if ((previous._sum.amount ?? 0) + input.amount > pkg.price + 0.001) throw new HttpError(400, 'Payment exceeds the package balance');
      if ((previous._sum.amount ?? 0) + input.amount >= pkg.price - 0.001) {
        await tx.lessonPackage.update({ where: { id: pkg.id }, data: { paid: true } });
        await tx.participant.updateMany({ where: { packageId: pkg.id, cancelledAt: null }, data: { paid: true } });
      }
    }
    const { participantId: _participantId, ...data } = input;
    const payment = await tx.payment.create({ data: { ...data, businessId: req.auth.business.id } });
    await tx.notification.create({ data: { businessId: req.auth.business.id, title: 'Payment recorded', message: `${req.auth.business.currency} ${(input.amount / 100).toFixed(2)} recorded for ${customer.name}. Receipt queued in Courtly; no external message has been sent.` } });
    return { ...payment, customerName: customer.name };
  });
  res.status(201).json(result);
}));
