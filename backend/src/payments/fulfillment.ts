import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError, initials } from '../http.js';
import type { ProviderPaymentIntent } from './provider.js';
import type { StripeWebhookEvent } from './webhooks.js';

type Tx = Prisma.TransactionClient;
type JsonObject = Record<string, unknown>;

type BookingFulfillmentContract = {
  intent: { businessId: string; userId: string; amount: number };
  snapshot: BookingCheckoutSnapshot;
  participant: {
    bookingId: string; studentId: string; price: number; paid: boolean; packageId: string | null;
    cancelledAt: Date | null;
    student: { businessId: string; userId: string | null };
    booking: {
      businessId: string; status: string; paymentRoute: string;
      business: { kind: string; isDemo: boolean; legacyReadOnly: boolean };
    };
  };
  collectedAmount: number;
};

export type PackageCheckoutSnapshot = {
  kind: 'PACKAGE';
  name: string;
  totalCredits: number;
  validityDays: number;
  serviceIds: string[];
  rentalLocationIds: string[];
};

export type BookingCheckoutSnapshot = {
  kind: 'BOOKING';
  bookingId: string;
  studentId: string;
};

export type CheckoutSnapshot = PackageCheckoutSnapshot | BookingCheckoutSnapshot;

function paidCheckoutConflict(reason: string): HttpError {
  return new HttpError(409,
    `Paid Stripe checkout cannot be fulfilled safely: ${reason}. Reconcile or refund the provider payment before retrying.`);
}

/**
 * A provider success may arrive long after checkout preparation. Make the
 * entitlement decision only from the locked, current participant and ledger.
 */
export function assertBookingFulfillmentContract(contract: BookingFulfillmentContract) {
  const { intent, snapshot, participant, collectedAmount } = contract;
  if (participant.bookingId !== snapshot.bookingId || participant.studentId !== snapshot.studentId
    || participant.booking.businessId !== intent.businessId
    || participant.student.businessId !== intent.businessId
    || participant.student.userId !== intent.userId) {
    throw paidCheckoutConflict('the booking party or tenant no longer matches the checkout contract');
  }
  if (participant.cancelledAt || participant.booking.status === 'CANCELLED') {
    throw paidCheckoutConflict('the booking participant or session was cancelled');
  }
  if (participant.booking.paymentRoute !== 'CLUB'
    || participant.booking.business.kind !== 'CLUB'
    || participant.booking.business.isDemo
    || participant.booking.business.legacyReadOnly) {
    throw paidCheckoutConflict('the booking is not an active club-collected contract');
  }
  if (participant.packageId) {
    throw paidCheckoutConflict('the participant is now covered by a package');
  }
  const outstanding = participant.price - collectedAmount;
  if (participant.paid || outstanding <= 0) {
    throw paidCheckoutConflict('the participant is already paid');
  }
  if (outstanding !== intent.amount) {
    throw paidCheckoutConflict('the participant balance changed after checkout began');
  }
}

function checkoutSnapshot(value: Prisma.JsonValue | null): CheckoutSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw paidCheckoutConflict('the immutable checkout contract is unavailable');
  }
  const record = value as JsonObject;
  if (record.kind === 'BOOKING' && typeof record.bookingId === 'string'
    && typeof record.studentId === 'string') {
    return { kind: 'BOOKING', bookingId: record.bookingId, studentId: record.studentId };
  }
  if (record.kind === 'PACKAGE' && typeof record.name === 'string'
    && record.name.length > 0
    && Number.isSafeInteger(record.totalCredits) && (record.totalCredits as number) > 0
    && Number.isSafeInteger(record.validityDays) && (record.validityDays as number) > 0
    && Array.isArray(record.serviceIds) && record.serviceIds.every(id => typeof id === 'string')
    && Array.isArray(record.rentalLocationIds)
    && record.rentalLocationIds.every(id => typeof id === 'string')
    && record.serviceIds.length + record.rentalLocationIds.length > 0) {
    return {
      kind: 'PACKAGE', name: record.name, totalCredits: record.totalCredits as number,
      validityDays: record.validityDays as number, serviceIds: record.serviceIds as string[],
      rentalLocationIds: record.rentalLocationIds as string[],
    };
  }
  throw paidCheckoutConflict('the immutable checkout contract is invalid');
}

export function providerIntentFromWebhook(event: StripeWebhookEvent): ProviderPaymentIntent | null {
  if (!event.type.startsWith('payment_intent.')) return null;
  const object = event.dataObject;
  if (typeof object.id !== 'string' || typeof object.status !== 'string'
    || typeof object.amount !== 'number' || !Number.isSafeInteger(object.amount)
    || typeof object.currency !== 'string') {
    throw new HttpError(400, 'Stripe payment intent event is malformed');
  }
  const state = event.type === 'payment_intent.succeeded' ? 'SUCCEEDED'
    : event.type === 'payment_intent.payment_failed' ? 'FAILED'
      : event.type === 'payment_intent.canceled' ? 'CANCELLED' : null;
  if (!state) return null;
  const lastError = object.last_payment_error && typeof object.last_payment_error === 'object'
    ? object.last_payment_error as JsonObject : {};
  return {
    id: object.id, state, providerStatus: object.status, amount: object.amount,
    currency: object.currency.toUpperCase(), clientSecret: null,
    latestChargeId: typeof object.latest_charge === 'string' ? object.latest_charge : null,
    failureCode: typeof lastError.code === 'string' ? lastError.code : null,
  };
}

async function ensureStudent(tx: Tx, businessId: string, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-student:${businessId}:${userId}`}, 0))`;
  const account = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  if (account.accountType !== 'STUDENT') {
    throw paidCheckoutConflict('the checkout account can no longer receive a student entitlement');
  }
  if (!account.email) {
    throw paidCheckoutConflict('the checkout account can no longer receive a student entitlement');
  }
  const existing = await tx.student.findFirst({ where: { businessId, userId } });
  if (existing) return existing;
  const conflicting = await tx.student.findFirst({
    where: { businessId, email: account.email }, select: { userId: true },
  });
  if (conflicting) {
    throw paidCheckoutConflict('the club must connect the existing student record before fulfillment');
  }
  return tx.student.create({ data: {
    businessId, userId, name: account.name, email: account.email, phone: account.phone,
    parentName: account.parentName, initials: initials(account.name),
  } });
}

async function assertLiveClub(tx: Tx, businessId: string) {
  const business = await tx.business.findUnique({
    where: { id: businessId }, select: { kind: true, isDemo: true, legacyReadOnly: true },
  });
  if (!business || business.kind !== 'CLUB' || business.isDemo || business.legacyReadOnly) {
    throw paidCheckoutConflict('the checkout tenant is not an active club');
  }
}

async function assertPackageTarget(tx: Tx, intent: {
  businessId: string; packageOfferId: string | null;
}, snapshot: PackageCheckoutSnapshot) {
  if (!intent.packageOfferId) throw paidCheckoutConflict('the package offer is unavailable');
  const offer = await tx.packageOffer.findFirst({
    where: { id: intent.packageOfferId, businessId: intent.businessId }, select: { id: true },
  });
  if (!offer) throw paidCheckoutConflict('the package offer no longer belongs to the checkout tenant');

  const serviceIds = [...new Set(snapshot.serviceIds)];
  const rentalLocationIds = [...new Set(snapshot.rentalLocationIds)];
  if (serviceIds.length !== snapshot.serviceIds.length
    || rentalLocationIds.length !== snapshot.rentalLocationIds.length) {
    throw paidCheckoutConflict('the package scope snapshot is invalid');
  }
  const [serviceCount, locationCount] = await Promise.all([
    serviceIds.length ? tx.service.count({
      where: { id: { in: serviceIds }, businessId: intent.businessId },
    }) : Promise.resolve(0),
    rentalLocationIds.length ? tx.location.count({
      where: { id: { in: rentalLocationIds }, businessId: intent.businessId },
    }) : Promise.resolve(0),
  ]);
  if (serviceCount !== serviceIds.length || locationCount !== rentalLocationIds.length) {
    throw paidCheckoutConflict('the package scope no longer matches the checkout tenant');
  }
}

async function fulfillSucceeded(tx: Tx, intentId: string, provider: ProviderPaymentIntent, eventAt: Date) {
  await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${intentId} FOR UPDATE`;
  const intent = await tx.paymentIntent.findUnique({ where: { id: intentId }, include: { payment: true } });
  if (!intent) throw new HttpError(404, 'Payment intent not found');
  if (intent.providerReference !== provider.id || intent.amount !== provider.amount
    || intent.currency !== provider.currency) {
    throw paidCheckoutConflict('the provider payment does not match the checkout contract');
  }
  if (intent.status === 'SUCCEEDED') {
    if (!intent.payment || intent.payment.reversedAt
      || intent.payment.businessId !== intent.businessId
      || intent.payment.amount !== intent.amount
      || intent.payment.kind !== 'STUDENT_TO_CLUB') {
      throw paidCheckoutConflict('the local success record has no matching active ledger receipt');
    }
    return intent;
  }
  if (intent.status === 'REFUNDED') return intent;
  if (intent.status === 'FAILED' && intent.lastProviderEventAt
    && eventAt.getTime() < intent.lastProviderEventAt.getTime()) return intent;
  // Stripe keeps a PaymentIntent reusable after a failed confirmation. A
  // later card attempt can therefore produce a valid success for the same
  // immutable checkout contract. Never grant entitlement for an older event.
  if (intent.status !== 'REQUIRES_CONFIRMATION' && intent.status !== 'FAILED') {
    throw paidCheckoutConflict(`the local checkout is ${intent.status.toLowerCase()}`);
  }
  const snapshot = checkoutSnapshot(intent.checkoutSnapshot);
  if (intent.kind !== snapshot.kind) {
    throw paidCheckoutConflict('the checkout target type does not match its immutable snapshot');
  }
  let packageId: string | null = null;
  if (snapshot.kind === 'PACKAGE') {
    await assertLiveClub(tx, intent.businessId);
    await assertPackageTarget(tx, intent, snapshot);
    const student = await ensureStudent(tx, intent.businessId, intent.userId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${student.id}`}, 0))`;
    const expiresAt = new Date(eventAt.getTime() + snapshot.validityDays * 86_400_000);
    const pkg = await tx.lessonPackage.create({ data: {
      businessId: intent.businessId, studentId: student.id, offerId: intent.packageOfferId,
      name: snapshot.name, serviceId: null, totalCredits: snapshot.totalCredits, usedCredits: 0,
      price: intent.amount, expiresAt, paid: true,
      services: { create: snapshot.serviceIds.map(serviceId => ({ serviceId })) },
      rentalLocations: { create: snapshot.rentalLocationIds.map(locationId => ({ locationId })) },
    } });
    packageId = pkg.id;
    await tx.payment.create({ data: {
      businessId: intent.businessId, studentId: student.id, packageId,
      paymentIntentId: intent.id, kind: 'STUDENT_TO_CLUB', amount: intent.amount,
      method: 'STRIPE', note: `Online checkout for ${snapshot.name}`,
    } });
  } else {
    if (!intent.participantId) throw paidCheckoutConflict('the booking participant is unavailable');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${snapshot.studentId}`}, 0))`;
    await tx.$queryRaw`SELECT id FROM "Participant" WHERE id = ${intent.participantId} FOR UPDATE`;
    // Student cancellation updates Participant before it may cancel Booking,
    // so use the same row order and then make both decisions from locked state.
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${snapshot.bookingId} FOR UPDATE`;
    const participant = await tx.participant.findUnique({
      where: { id: intent.participantId },
      include: { student: true, booking: { include: { business: true } } },
    });
    if (!participant) throw paidCheckoutConflict('the booking participant is unavailable');
    const collected = await tx.payment.aggregate({ where: {
      bookingId: participant.bookingId, studentId: participant.studentId,
      kind: { not: 'CLUB_TO_COACH' }, reversedAt: null,
    }, _sum: { amount: true } });
    assertBookingFulfillmentContract({
      intent, snapshot, participant, collectedAmount: collected._sum.amount ?? 0,
    });
    await tx.payment.create({ data: {
      businessId: intent.businessId, studentId: participant.studentId, bookingId: snapshot.bookingId,
      paymentIntentId: intent.id, kind: 'STUDENT_TO_CLUB', amount: intent.amount,
      method: 'STRIPE', note: 'Online lesson checkout',
    } });
    await tx.participant.update({ where: { id: participant.id }, data: { paid: true } });
  }
  return tx.paymentIntent.update({ where: { id: intent.id }, data: {
    status: 'SUCCEEDED', packageId, confirmedAt: eventAt, failedAt: null, failureCode: null,
    lastProviderEventAt: eventAt, providerChargeReference: provider.latestChargeId,
  } });
}

export async function applyProviderPaymentIntent(
  intentId: string, provider: ProviderPaymentIntent, eventAt = new Date(),
) {
  if (provider.state === 'SUCCEEDED') {
    return prisma.$transaction(tx => fulfillSucceeded(tx, intentId, provider, eventAt), { timeout: 30_000 });
  }
  if (provider.state === 'PROCESSING' || provider.state === 'REQUIRES_CONFIRMATION') {
    const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.status !== 'FAILED' || provider.state !== 'REQUIRES_CONFIRMATION') return intent;
    if (intent.provider !== 'STRIPE' || intent.providerReference !== provider.id
      || intent.amount !== provider.amount || intent.currency !== provider.currency) {
      throw new HttpError(409, 'Provider payment does not match the checkout contract');
    }
    return prisma.paymentIntent.update({ where: { id: intent.id }, data: {
      status: 'REQUIRES_CONFIRMATION', failureCode: null, failedAt: null, lastProviderEventAt: eventAt,
      ...(provider.latestChargeId ? { providerChargeReference: provider.latestChargeId } : {}),
    } });
  }
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${intentId} FOR UPDATE`;
    const intent = await tx.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new HttpError(404, 'Payment intent not found');
    if (intent.providerReference !== provider.id || intent.amount !== provider.amount
      || intent.currency !== provider.currency) {
      throw new HttpError(409, 'Provider payment does not match the checkout contract');
    }
    if (intent.status !== 'REQUIRES_CONFIRMATION') return intent;
    return tx.paymentIntent.update({ where: { id: intent.id }, data: {
      status: provider.state, failureCode: provider.failureCode,
      failedAt: provider.state === 'FAILED' ? eventAt : null, lastProviderEventAt: eventAt,
      ...(provider.latestChargeId ? { providerChargeReference: provider.latestChargeId } : {}),
    } });
  });
}
