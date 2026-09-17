import { Router } from 'express';
import { z } from 'zod';
import { prisma } from './db.js';
import { adminOnly, asyncRoute, coachScope, HttpError } from './http.js';
import { bookingInput, cancelBooking, createBookings, lockInstructors, rescheduleBooking } from './scheduling.js';
import { bookingInclude, bookingJson, withoutBookingFinancials } from './serializers.js';
import { createBookingAccountAlerts } from './account-notifications.js';
import { notifyWorkspace } from './notifications.js';
import {
  acceptRescheduleRequest,
  createRescheduleRequest,
  declineRescheduleRequest,
  rescheduleRequestInput,
  rescheduleRequestJson,
  rescheduleResponseInput,
  withdrawRescheduleRequest,
  type RequesterRole,
} from './reschedule.js';
export const bookingsRouter = Router();

/** A workspace member acts either as the club's office or as the coach. */
const requesterRole = (role: string): RequesterRole => role === 'COACH' ? 'COACH' : 'CLUB';
bookingsRouter.post('/bookings', asyncRoute(async (req, res) => {
  const input = bookingInput.parse(req.body);
  coachScope(req, input.instructorId);
  if (req.auth.membership!.role === 'COACH' && input.packageId) {
    throw new HttpError(403, 'Coaches cannot apply lesson packages');
  }
  // Provider-created bookings may select an existing customer, but they may
  // never mint a guest/contact-only identity. The scheduler enforces that the
  // selected Customer is linked to a registered global account.
  const membership = req.auth.membership!;
  const result = await createBookings(req.auth.business!.id, input, {
    requireLinkedCustomer: true,
    actor: {
      userId: req.auth.user.id,
      role: membership.role as 'OWNER' | 'ADMIN' | 'COACH',
      instructorId: membership.instructorId,
    },
  });
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

// A club may assign a student to a coach without asking the student, but the
// coach decides whether they can actually teach it. Only the assigned coach —
// or an owner acting on a coach's behalf after speaking to them — may answer.
const acceptanceDecision = z.object({ message: z.string().trim().max(500).default('') }).strict();
bookingsRouter.post('/bookings/:id/accept', asyncRoute(async (req, res) => {
  acceptanceDecision.parse(req.body ?? {});
  const result = await prisma.$transaction(async tx => {
    const initial = await tx.booking.findFirst({ where: { id: req.params.id, businessId: req.auth.business.id } });
    if (!initial) throw new HttpError(404, 'Booking not found');
    coachScope(req, initial.instructorId);
    await lockInstructors(tx, [initial.instructorId]);
    const current = await tx.booking.findUniqueOrThrow({ where: { id: initial.id }, include: { location: true } });
    if (current.instructorId !== initial.instructorId) throw new HttpError(409, 'Session changed. Please retry.');
    if (current.coachAcceptance !== 'PENDING') throw new HttpError(409, 'This lesson is not waiting for a coach decision');
    if (current.status === 'CANCELLED') throw new HttpError(400, 'A cancelled lesson cannot be accepted');
    // Accepting settles the coach's half only. A venue that still needs
    // approval keeps the booking pending for the club to secure.
    const venuePending = current.location.requiresApproval || current.location.type === 'RENTED';
    const updated = await tx.booking.update({
      where: { id: current.id },
      data: { coachAcceptance: 'ACCEPTED', coachRespondedAt: new Date(), status: venuePending ? 'PENDING' : 'CONFIRMED' },
      include: bookingInclude,
    });
    await notifyWorkspace(tx, {
      businessId: req.auth.business.id, instructorId: current.instructorId, bookingId: current.id,
      type: 'BOOKING', title: 'Coach accepted an assigned lesson',
      message: `${updated.service.name} with ${updated.instructor.name} was accepted.${venuePending ? ' The venue still needs to be secured.' : ''}`,
    });
    await createBookingAccountAlerts(tx, current.id, 'COACH_ACCEPTED');
    return updated;
  });
  const json = bookingJson(result);
  res.json(req.auth.membership!.role === 'COACH' ? withoutBookingFinancials(json) : json);
}));

bookingsRouter.post('/bookings/:id/decline', asyncRoute(async (req, res) => {
  const body = acceptanceDecision.parse(req.body ?? {});
  const result = await prisma.$transaction(async tx => {
    const initial = await tx.booking.findFirst({ where: { id: req.params.id, businessId: req.auth.business.id } });
    if (!initial) throw new HttpError(404, 'Booking not found');
    coachScope(req, initial.instructorId);
    await lockInstructors(tx, [initial.instructorId]);
    const current = await tx.booking.findUniqueOrThrow({ where: { id: initial.id } });
    if (current.instructorId !== initial.instructorId) throw new HttpError(409, 'Session changed. Please retry.');
    if (current.coachAcceptance !== 'PENDING') throw new HttpError(409, 'This lesson is not waiting for a coach decision');
    await tx.booking.update({
      where: { id: current.id },
      data: { coachAcceptance: 'DECLINED', coachRespondedAt: new Date() },
    });
    await createBookingAccountAlerts(tx, current.id, 'COACH_DECLINED');
    // Declining releases the slot: credits return and the club is told it must
    // find another coach, rather than leaving a lesson nobody will teach.
    await cancelBooking(tx, req.auth.business.id, current.id);
    await notifyWorkspace(tx, {
      businessId: req.auth.business.id, bookingId: current.id,
      type: 'PENDING_ACTION', actionNeeded: true, title: 'Coach declined an assigned lesson',
      message: `The assigned coach cannot take this lesson${body.message ? `: ${body.message}` : '.'} Reassign it to another coach.`,
    });
    return tx.booking.findUniqueOrThrow({ where: { id: current.id }, include: bookingInclude });
  });
  const json = bookingJson(result);
  res.json(req.auth.membership!.role === 'COACH' ? withoutBookingFinancials(json) : json);
}));

// Rescheduling is a negotiation. The provider side proposes; the customer
// accepts. The one-sided move below stays only for a booking with nobody to
// ask — otherwise it would move a session under a student's feet.
bookingsRouter.post('/bookings/:id/reschedule-requests', asyncRoute(async (req, res) => {
  const input = rescheduleRequestInput.parse(req.body);
  const membership = req.auth.membership!;
  const request = await prisma.$transaction(async tx => {
    const initial = await tx.booking.findFirst({ where: { id: req.params.id, businessId: req.auth.business.id } });
    if (!initial) throw new HttpError(404, 'Booking not found');
    coachScope(req, initial.instructorId);
    return createRescheduleRequest(tx, {
      bookingId: initial.id,
      businessId: req.auth.business.id,
      role: requesterRole(membership.role),
      userId: req.auth.user.id,
      startAt: input.startAt,
      message: input.message,
    });
  }, { timeout: 30_000 });
  res.status(201).json(rescheduleRequestJson(request));
}));

bookingsRouter.get('/reschedule-requests', asyncRoute(async (req, res) => {
  const membership = req.auth.membership!;
  const coach = membership.role === 'COACH';
  const requests = await prisma.rescheduleRequest.findMany({
    where: {
      businessId: req.auth.business.id,
      ...(coach ? { booking: { instructorId: membership.instructorId || '__none__' } } : {}),
    },
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
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 200,
  });
  res.json({ requests: requests.map(rescheduleRequestJson) });
}));

bookingsRouter.post('/reschedule-requests/:requestId/accept', asyncRoute(async (req, res) => {
  const body = rescheduleResponseInput.parse(req.body ?? {});
  const membership = req.auth.membership!;
  const result = await prisma.$transaction(async tx => {
    const request = await tx.rescheduleRequest.findFirst({
      where: { id: req.params.requestId, businessId: req.auth.business.id },
      include: { booking: { select: { instructorId: true } } },
    });
    if (!request) throw new HttpError(404, 'Reschedule request not found');
    coachScope(req, request.booking.instructorId);
    return acceptRescheduleRequest(tx, request.id, {
      role: requesterRole(membership.role), userId: req.auth.user.id, message: body.message,
    });
  }, { timeout: 30_000 });
  res.json({ request: rescheduleRequestJson(result.request), booking: result.booking });
}));

bookingsRouter.post('/reschedule-requests/:requestId/decline', asyncRoute(async (req, res) => {
  const body = rescheduleResponseInput.parse(req.body ?? {});
  const membership = req.auth.membership!;
  const request = await prisma.$transaction(async tx => {
    const found = await tx.rescheduleRequest.findFirst({
      where: { id: req.params.requestId, businessId: req.auth.business.id },
      include: { booking: { select: { instructorId: true } } },
    });
    if (!found) throw new HttpError(404, 'Reschedule request not found');
    coachScope(req, found.booking.instructorId);
    return declineRescheduleRequest(tx, found.id, {
      role: requesterRole(membership.role), userId: req.auth.user.id, message: body.message,
    });
  });
  res.json(rescheduleRequestJson(request));
}));

bookingsRouter.post('/reschedule-requests/:requestId/withdraw', asyncRoute(async (req, res) => {
  const membership = req.auth.membership!;
  const request = await prisma.$transaction(async tx => {
    const found = await tx.rescheduleRequest.findFirst({
      where: { id: req.params.requestId, businessId: req.auth.business.id },
      include: { booking: { select: { instructorId: true } } },
    });
    if (!found) throw new HttpError(404, 'Reschedule request not found');
    coachScope(req, found.booking.instructorId);
    return withdrawRescheduleRequest(tx, found.id, {
      role: requesterRole(membership.role), userId: req.auth.user.id,
    });
  });
  res.json(rescheduleRequestJson(request));
}));

bookingsRouter.post('/bookings/:id/reschedule', asyncRoute(async (req, res) => {
  const changes = z.object({ startAt: z.string().datetime({ offset: true }) }).strict().parse(req.body);
  const initial = await prisma.booking.findFirst({ where: { id: req.params.id, businessId: req.auth.business.id } });
  if (!initial) throw new HttpError(404, 'Booking not found');
  coachScope(req, initial.instructorId);
  const hasAccountParticipant = await prisma.participant.findFirst({
    where: { bookingId: initial.id, cancelledAt: null, customer: { userId: { not: null } } },
    select: { id: true },
  });
  if (hasAccountParticipant) {
    throw new HttpError(409, 'Propose a new time instead. A session with a registered customer moves only once they accept the change.');
  }
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
    let paymentKind: 'CUSTOMER_TO_CLUB' | 'CUSTOMER_TO_COACH' = req.auth.business.kind === 'SOLO' ? 'CUSTOMER_TO_COACH' : 'CUSTOMER_TO_CLUB';
    let alertBookingId: string | null = null;
    if (input.bookingId) {
      const booking = await tx.booking.findFirst({ where: { id: input.bookingId, businessId: req.auth.business.id } });
      if (!booking) throw new HttpError(404, 'Booking not found');
      await lockInstructors(tx, [booking.instructorId]);
      const participant = await tx.participant.findFirst({ where: { bookingId: input.bookingId, customerId: customer.id, cancelledAt: null, ...(input.participantId ? { id: input.participantId } : {}) }, include: { booking: true } });
      if (!participant) throw new HttpError(400, 'Customer is not enrolled in this booking');
      if (participant.booking.status === 'CANCELLED') throw new HttpError(400, 'Cannot charge a cancelled booking');
      if (participant.packageId) throw new HttpError(400, 'Record payment against this participant’s package instead');
      if (participant.paid) throw new HttpError(409, 'This participant is already paid');
      const previous = await tx.payment.aggregate({ where: { bookingId: input.bookingId, customerId: customer.id, kind: { not: 'CLUB_TO_COACH' }, reversedAt: null }, _sum: { amount: true } });
      if ((previous._sum.amount ?? 0) + input.amount > participant.price + 0.001) throw new HttpError(400, 'Payment exceeds this participant’s remaining balance');
      if ((previous._sum.amount ?? 0) + input.amount >= participant.price - 0.001) await tx.participant.update({ where: { id: participant.id }, data: { paid: true } });
      // A club lesson is money the club collects. Recording it as paid straight
      // to the coach would leave the club's books wrong and hide the payout
      // the club still owes.
      paymentKind = participant.booking.paymentRoute === 'CLUB' ? 'CUSTOMER_TO_CLUB' : 'CUSTOMER_TO_COACH';
      alertBookingId = participant.bookingId;
    }
    if (input.packageId) {
      await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${input.packageId} AND "businessId" = ${req.auth.business.id} FOR UPDATE`;
      const pkg = await tx.lessonPackage.findFirst({ where: { id: input.packageId, businessId: req.auth.business.id, customerId: customer.id } });
      if (!pkg) throw new HttpError(404, 'Package not found for this customer');
      if (pkg.paid) throw new HttpError(409, 'Package is already paid');
      const previous = await tx.payment.aggregate({ where: { packageId: pkg.id, kind: { not: 'CLUB_TO_COACH' }, reversedAt: null }, _sum: { amount: true } });
      if ((previous._sum.amount ?? 0) + input.amount > pkg.price + 0.001) throw new HttpError(400, 'Payment exceeds the package balance');
      if ((previous._sum.amount ?? 0) + input.amount >= pkg.price - 0.001) {
        await tx.lessonPackage.update({ where: { id: pkg.id }, data: { paid: true } });
        await tx.participant.updateMany({ where: { packageId: pkg.id, cancelledAt: null }, data: { paid: true } });
      }
    }
    const { participantId: _participantId, ...data } = input;
    const payment = await tx.payment.create({ data: { ...data, kind: paymentKind, businessId: req.auth.business.id } });
    await notifyWorkspace(tx, {
      businessId: req.auth.business.id, bookingId: alertBookingId, type: 'PAYMENT', title: 'Payment recorded',
      message: `${req.auth.business.currency} ${(input.amount / 100).toFixed(2)} recorded for ${customer.name}${paymentKind === 'CUSTOMER_TO_CLUB' ? ' by the club' : ' by the coach'}. Receipt queued in Courtly; no external message has been sent.`,
    });
    if (alertBookingId) await createBookingAccountAlerts(tx, alertBookingId, 'PAYMENT_RECORDED', [customer.userId]);
    return { ...payment, customerName: customer.name, instructorName: null as string | null };
  });
  res.status(201).json(result);
}));

// Recording a payment is a human action and humans mistype. A reversal undoes
// the balance it created and flips the participant or package back to unpaid,
// while keeping both rows so the correction stays visible in the ledger.
bookingsRouter.delete('/payments/:id', adminOnly, asyncRoute(async (req, res) => {
  const reason = z.object({ reason: z.string().trim().max(500).default('') }).strict().parse(req.body ?? {});
  const result = await prisma.$transaction(async tx => {
    const payment = await tx.payment.findFirst({
      where: { id: req.params.id, businessId: req.auth.business.id },
      include: { customer: true },
    });
    if (!payment) throw new HttpError(404, 'Payment not found');
    if (payment.reversedAt) throw new HttpError(409, 'This payment has already been reversed');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${payment.customerId}`}, 0))`;
    const reversed = await tx.payment.update({
      where: { id: payment.id },
      data: { reversedAt: new Date(), reversedByUserId: req.auth.user.id, reversedReason: reason.reason },
    });

    if (payment.bookingId) {
      const participant = await tx.participant.findFirst({
        where: { bookingId: payment.bookingId, customerId: payment.customerId, cancelledAt: null },
      });
      if (participant && !participant.packageId) {
        const remaining = await tx.payment.aggregate({
          where: {
            bookingId: payment.bookingId, customerId: payment.customerId,
            kind: { not: 'CLUB_TO_COACH' }, reversedAt: null,
          },
          _sum: { amount: true },
        });
        const stillPaid = (remaining._sum.amount ?? 0) >= participant.price - 0.001;
        if (participant.paid !== stillPaid) {
          await tx.participant.update({ where: { id: participant.id }, data: { paid: stillPaid } });
        }
        if (!stillPaid) {
          await createBookingAccountAlerts(tx, payment.bookingId, 'PAYMENT_REVERSED', [payment.customer.userId]);
        }
      }
    }
    if (payment.packageId) {
      const pkg = await tx.lessonPackage.findFirst({ where: { id: payment.packageId, businessId: req.auth.business.id } });
      if (pkg) {
        const remaining = await tx.payment.aggregate({
          where: { packageId: pkg.id, kind: { not: 'CLUB_TO_COACH' }, reversedAt: null },
          _sum: { amount: true },
        });
        const stillPaid = (remaining._sum.amount ?? 0) >= pkg.price - 0.001;
        if (pkg.paid !== stillPaid) {
          await tx.lessonPackage.update({ where: { id: pkg.id }, data: { paid: stillPaid } });
          // Participants riding on this package follow the package's state.
          await tx.participant.updateMany({
            where: { packageId: pkg.id, cancelledAt: null }, data: { paid: stillPaid },
          });
        }
      }
    }

    await notifyWorkspace(tx, {
      businessId: req.auth.business.id, bookingId: payment.bookingId, type: 'PAYMENT',
      title: 'Payment reversed',
      message: `${req.auth.business.currency} ${(payment.amount / 100).toFixed(2)} recorded for ${payment.customer.name} was reversed${reason.reason ? `: ${reason.reason}` : '.'}`,
    });
    return { ...reversed, customerName: payment.customer.name };
  });
  res.json({ ok: true, payment: { ...result, reversedAt: result.reversedAt?.toISOString() ?? null } });
}));

// The second leg of a club lesson: the club paying the coach for work already
// done. Kept in the same ledger so a club can see, per coach, what it has
// collected and what it still owes.
bookingsRouter.post('/payouts', adminOnly, asyncRoute(async (req, res) => {
  const input = z.object({
    instructorId: z.string().trim().min(1).max(200),
    amount: z.number().int().positive().max(100_000_000),
    method: z.enum(['CASH', 'BANK_TRANSFER', 'OTHER']),
    note: z.string().trim().max(1000).default(''),
  }).strict().parse(req.body);
  if (req.auth.business.kind !== 'CLUB') {
    throw new HttpError(400, 'Coach payouts apply to a club or academy. An independent coach is paid directly by their students.');
  }
  const result = await prisma.$transaction(async tx => {
    const instructor = await tx.instructor.findFirst({
      where: { id: input.instructorId, businessId: req.auth.business.id },
    });
    if (!instructor) throw new HttpError(404, 'Coach not found on this roster');
    // A payout is not owed by a customer, but Payment.customerId is required.
    // Attribute it to the coach's own club customer record when one exists so
    // the ledger stays queryable, otherwise refuse rather than invent a row.
    const anchor = await tx.customer.findFirst({
      where: { businessId: req.auth.business.id, email: instructor.email || '__none__' },
      select: { id: true },
    }) ?? await tx.customer.findFirst({ where: { businessId: req.auth.business.id }, select: { id: true } });
    if (!anchor) throw new HttpError(400, 'Add at least one customer before recording coach payouts');
    const payout = await tx.payment.create({
      data: {
        businessId: req.auth.business.id, customerId: anchor.id, instructorId: instructor.id,
        kind: 'CLUB_TO_COACH', amount: input.amount, method: input.method,
        note: input.note || `Coach payout · ${instructor.name}`,
      },
    });
    await notifyWorkspace(tx, {
      businessId: req.auth.business.id, instructorId: instructor.id, type: 'PAYOUT',
      title: 'Coach payout recorded',
      message: `${req.auth.business.currency} ${(input.amount / 100).toFixed(2)} recorded as paid to ${instructor.name}.`,
    });
    return { ...payout, customerName: instructor.name, instructorName: instructor.name };
  });
  res.status(201).json(result);
}));
