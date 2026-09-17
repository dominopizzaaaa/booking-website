import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { HttpError } from './http.js';
import { notifyWorkspace } from './notifications.js';
import { createBookingAccountAlerts } from './account-notifications.js';
import { evaluateSlot, lockInstructors, schedulingContext } from './scheduling.js';
import { bookingInclude, bookingJson } from './serializers.js';

type Tx = Prisma.TransactionClient;

export type RequesterRole = 'CUSTOMER' | 'COACH' | 'CLUB';

export const rescheduleRequestInput = z.object({
  startAt: z.string().datetime({ offset: true }),
  message: z.string().trim().max(500).default(''),
}).strict();

export const rescheduleResponseInput = z.object({
  message: z.string().trim().max(500).default(''),
}).strict();

const requestInclude = {
  booking: {
    include: {
      business: { select: { id: true, name: true, timezone: true } },
      instructor: { select: { id: true, name: true, rescheduleNoticeHours: true } },
      service: { select: { name: true } },
      location: { select: { name: true } },
    },
  },
} satisfies Prisma.RescheduleRequestInclude;

type FullRescheduleRequest = Prisma.RescheduleRequestGetPayload<{ include: typeof requestInclude }>;

export const rescheduleRequestJson = (request: FullRescheduleRequest) => ({
  id: request.id,
  bookingId: request.bookingId,
  participantId: request.participantId,
  requestedByRole: request.requestedByRole as RequesterRole,
  requestedByUserId: request.requestedByUserId,
  proposedStartAt: request.proposedStartAt.toISOString(),
  proposedEndAt: request.proposedEndAt.toISOString(),
  originalStartAt: request.originalStartAt.toISOString(),
  message: request.message,
  status: request.status,
  respondedAt: request.respondedAt?.toISOString() ?? null,
  responseMessage: request.responseMessage,
  createdAt: request.createdAt.toISOString(),
  serviceName: request.booking.service.name,
  instructorName: request.booking.instructor.name,
  locationName: request.booking.location.name,
  businessName: request.booking.business.name,
  timezone: request.booking.business.timezone,
});

export const rescheduleRequestSummary = (request: FullRescheduleRequest) => rescheduleRequestJson(request);

/**
 * The coach's protection window. A coach sets how late a reschedule may still
 * be negotiated for their own sessions; the club's cancellation notice is a
 * floor, so whichever window is stricter wins. Returned in hours.
 */
export function rescheduleNoticeHours(
  instructor: { rescheduleNoticeHours: number },
  business: { cancellationHours: number },
) {
  return Math.max(instructor.rescheduleNoticeHours, business.cancellationHours);
}

export function assertInsideRescheduleWindow(
  booking: { startAt: Date },
  instructor: { rescheduleNoticeHours: number },
  business: { cancellationHours: number },
) {
  const hours = rescheduleNoticeHours(instructor, business);
  if (booking.startAt.getTime() - Date.now() < hours * 3_600_000) {
    throw new HttpError(400, `Reschedule requests close ${hours} hours before the session starts. Please contact the coach directly.`);
  }
}

/**
 * Who must answer a request. A request never travels back to the side that
 * raised it, and a customer always negotiates with the coach's side rather
 * than with another customer in a group.
 */
export function responderFor(role: RequesterRole): 'PROVIDER' | 'CUSTOMER' {
  return role === 'CUSTOMER' ? 'PROVIDER' : 'CUSTOMER';
}

async function loadRequest(tx: Tx, requestId: string) {
  const request = await tx.rescheduleRequest.findUnique({ where: { id: requestId }, include: requestInclude });
  if (!request) throw new HttpError(404, 'Reschedule request not found');
  return request;
}

/**
 * Raise a proposal. The proposed time is validated against live availability
 * straight away so neither side is asked to consider a slot that cannot be
 * booked, but nothing moves until the other side accepts.
 */
export async function createRescheduleRequest(
  tx: Tx,
  options: {
    bookingId: string;
    businessId: string;
    role: RequesterRole;
    userId: string | null;
    participantId?: string | null;
    startAt: string;
    message: string;
  },
) {
  const booking = await tx.booking.findFirst({
    where: { id: options.bookingId, businessId: options.businessId },
    include: {
      business: true, instructor: true, service: true, location: true,
      participants: { where: { cancelledAt: null }, include: { customer: true } },
    },
  });
  if (!booking) throw new HttpError(404, 'Booking not found');
  await lockInstructors(tx, [booking.instructorId]);
  if (['CANCELLED', 'COMPLETED'].includes(booking.status)) {
    throw new HttpError(400, 'Only an active session can be rescheduled');
  }
  if (booking.coachAcceptance === 'PENDING') {
    throw new HttpError(400, 'This lesson is still waiting for the coach to accept it. Reschedule it once it is confirmed.');
  }
  assertInsideRescheduleWindow(booking, booking.instructor, booking.business);

  const proposedStart = new Date(options.startAt);
  if (proposedStart.getTime() === booking.startAt.getTime()) {
    throw new HttpError(400, 'Choose a time different from the current one');
  }
  const ctx = await schedulingContext(tx, options.businessId, booking.serviceId, booking.instructorId, booking.locationId);
  const slot = await evaluateSlot(tx, ctx, proposedStart, booking.id, {
    duration: booking.duration, bufferMinutes: booking.bufferMinutes,
  });
  if (!slot.available || slot.groupId) {
    throw new HttpError(409, 'That time is not available', {
      conflicts: [{ date: options.startAt, reason: slot.reason || 'A group already occupies that time' }],
    });
  }

  // One live proposal per booking. A second one would leave both sides unsure
  // which time is actually being negotiated.
  const open = await tx.rescheduleRequest.findFirst({
    where: { bookingId: booking.id, status: 'PENDING' },
  });
  if (open) {
    throw new HttpError(409, open.requestedByRole === options.role
      ? 'You already have a reschedule request awaiting a reply for this session'
      : 'The other side has already proposed a new time. Respond to that request first.');
  }

  const created = await tx.rescheduleRequest.create({
    data: {
      businessId: options.businessId,
      bookingId: booking.id,
      requestedByRole: options.role,
      requestedByUserId: options.userId,
      participantId: options.participantId ?? null,
      proposedStartAt: proposedStart,
      proposedEndAt: slot.endAt,
      originalStartAt: booking.startAt,
      message: options.message,
    },
    include: requestInclude,
  });

  const when = DateTime.fromJSDate(proposedStart, { zone: booking.business.timezone })
    .setLocale('en-SG').toFormat("ccc, d LLL yyyy 'at' h:mm a");
  if (responderFor(options.role) === 'PROVIDER') {
    const asker = booking.participants.find(p => p.id === options.participantId)?.customer.name
      ?? 'A customer';
    await notifyWorkspace(tx, {
      businessId: options.businessId,
      instructorId: booking.instructorId,
      bookingId: booking.id,
      type: 'RESCHEDULE',
      title: 'Reschedule requested',
      message: `${asker} asked to move ${booking.service.name} to ${when}. Accept or decline the request.`,
      actionNeeded: true,
    });
  } else {
    await createBookingAccountAlerts(
      tx, booking.id, 'RESCHEDULE_REQUESTED',
      booking.participants.map(p => p.customer.userId),
      { whenAt: proposedStart },
    );
    // The club still wants this on its own board even when its coach raised it.
    await notifyWorkspace(tx, {
      businessId: options.businessId,
      instructorId: booking.instructorId,
      bookingId: booking.id,
      type: 'RESCHEDULE',
      title: 'Reschedule proposed to the customer',
      message: `${booking.instructor.name} proposed moving ${booking.service.name} to ${when}. Waiting for the customer to respond.`,
    });
  }
  return created;
}

/**
 * Accept a proposal and actually move the booking. The slot is re-evaluated
 * inside this transaction, because time has passed since the proposal and the
 * coach's calendar may have changed underneath it.
 */
export async function acceptRescheduleRequest(
  tx: Tx,
  requestId: string,
  responder: { role: RequesterRole; userId: string | null; message: string },
) {
  const request = await loadRequest(tx, requestId);
  if (request.status !== 'PENDING') throw new HttpError(409, 'This reschedule request has already been answered');
  if (request.requestedByRole === responder.role) {
    throw new HttpError(403, 'A reschedule request is accepted by the other side, not by the side that raised it');
  }

  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: request.bookingId },
    include: { business: true, instructor: true, participants: { where: { cancelledAt: null }, include: { customer: true, package: true } } },
  });
  await lockInstructors(tx, [booking.instructorId]);
  if (['CANCELLED', 'COMPLETED'].includes(booking.status)) throw new HttpError(400, 'Only an active session can be rescheduled');
  assertInsideRescheduleWindow(booking, booking.instructor, booking.business);

  const ctx = await schedulingContext(tx, booking.businessId, booking.serviceId, booking.instructorId, booking.locationId);
  const slot = await evaluateSlot(tx, ctx, request.proposedStartAt, booking.id, {
    duration: booking.duration, bufferMinutes: booking.bufferMinutes,
  });
  if (!slot.available || slot.groupId) {
    // The proposal went stale. Close it rather than leaving a request that can
    // never be accepted, and say why.
    await tx.rescheduleRequest.update({
      where: { id: request.id },
      data: {
        status: 'EXPIRED', respondedAt: new Date(), respondedByUserId: responder.userId,
        responseMessage: slot.reason || 'That time is no longer available',
      },
    });
    throw new HttpError(409, 'That time is no longer available. Ask for another time.', {
      conflicts: [{ date: request.proposedStartAt.toISOString(), reason: slot.reason || 'No longer available' }],
    });
  }
  if (booking.participants.some(p => p.package && p.package.expiresAt < request.proposedStartAt)) {
    throw new HttpError(400, 'A lesson package would expire before the proposed time');
  }

  const updated = await tx.booking.update({
    where: { id: booking.id },
    data: {
      startAt: request.proposedStartAt,
      endAt: slot.endAt,
      status: (ctx.location.requiresApproval || ctx.location.type === 'RENTED') ? 'PENDING' : 'CONFIRMED',
    },
    include: bookingInclude,
  });
  await tx.rescheduleRequest.update({
    where: { id: request.id },
    data: {
      status: 'ACCEPTED', respondedAt: new Date(), respondedByUserId: responder.userId,
      responseMessage: responder.message,
    },
  });

  await notifyWorkspace(tx, {
    businessId: booking.businessId, instructorId: booking.instructorId, bookingId: booking.id,
    type: 'RESCHEDULE', title: 'Reschedule accepted',
    message: `${updated.service.name} moved to its new time. Both sides agreed to the change.`,
  });
  await createBookingAccountAlerts(
    tx, booking.id,
    request.requestedByRole === 'CUSTOMER' ? 'RESCHEDULE_ACCEPTED' : 'RESCHEDULED',
    booking.participants.map(p => p.customer.userId),
  );
  return { request: await loadRequest(tx, request.id), booking: bookingJson(updated) };
}

export async function declineRescheduleRequest(
  tx: Tx,
  requestId: string,
  responder: { role: RequesterRole; userId: string | null; message: string },
) {
  const request = await loadRequest(tx, requestId);
  if (request.status !== 'PENDING') throw new HttpError(409, 'This reschedule request has already been answered');
  if (request.requestedByRole === responder.role) {
    throw new HttpError(403, 'Withdraw your own request instead of declining it');
  }
  await tx.rescheduleRequest.update({
    where: { id: request.id },
    data: {
      status: 'DECLINED', respondedAt: new Date(), respondedByUserId: responder.userId,
      responseMessage: responder.message,
    },
  });
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: request.bookingId },
    include: { participants: { where: { cancelledAt: null }, include: { customer: true } } },
  });
  if (request.requestedByRole === 'CUSTOMER') {
    await createBookingAccountAlerts(tx, booking.id, 'RESCHEDULE_DECLINED', booking.participants.map(p => p.customer.userId));
  } else {
    await notifyWorkspace(tx, {
      businessId: request.businessId, instructorId: booking.instructorId, bookingId: booking.id,
      type: 'RESCHEDULE', title: 'Reschedule declined',
      message: `${request.booking.service.name} keeps its original time. The customer declined the proposed change.`,
      actionNeeded: true,
    });
  }
  return loadRequest(tx, request.id);
}

export async function withdrawRescheduleRequest(
  tx: Tx,
  requestId: string,
  requester: { role: RequesterRole; userId: string | null },
) {
  const request = await loadRequest(tx, requestId);
  if (request.status !== 'PENDING') throw new HttpError(409, 'This reschedule request has already been answered');
  if (request.requestedByRole !== requester.role) {
    throw new HttpError(403, 'Only the side that raised a request can withdraw it');
  }
  await tx.rescheduleRequest.update({
    where: { id: request.id },
    data: { status: 'WITHDRAWN', respondedAt: new Date(), respondedByUserId: requester.userId },
  });
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: request.bookingId },
    include: { participants: { where: { cancelledAt: null }, include: { customer: true } } },
  });
  if (requester.role === 'CUSTOMER') {
    await notifyWorkspace(tx, {
      businessId: request.businessId, instructorId: booking.instructorId, bookingId: booking.id,
      type: 'RESCHEDULE', title: 'Reschedule request withdrawn',
      message: `${request.booking.service.name} keeps its original time. The customer withdrew their request.`,
    });
  } else {
    await createBookingAccountAlerts(tx, booking.id, 'RESCHEDULE_WITHDRAWN', booking.participants.map(p => p.customer.userId));
  }
  return loadRequest(tx, request.id);
}
