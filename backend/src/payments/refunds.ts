import type { Prisma } from '@prisma/client';
import { createBookingAccountAlerts } from '../account-notifications.js';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { HttpError } from '../http.js';
import { notifyWorkspace } from '../notifications.js';
import { releaseRentalUnit } from '../venue-allocations.js';
import {
  disabledPaymentProvider, PaymentProviderError, type PaymentProvider,
  type ProviderRefund,
} from './provider.js';
import { StripePaymentProvider } from './stripe.js';
import type { StripeWebhookEvent } from './webhooks.js';

type Tx = Prisma.TransactionClient;

export type RefundPreparation = {
  refundId: string;
  paymentIntentId: string;
  providerPaymentIntentId: string;
  providerAccountReference: string;
  amount: number;
  currency: string;
  providerRefundId: string | null;
};

export type RefundExecutionResult = {
  refundId: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
};

type RefundableIntent = {
  id: string;
  businessId: string;
  provider: string;
  providerReference: string | null;
  providerAccountReference: string;
  amount: number;
  currency: string;
  status: string;
};

function configuredProvider(): PaymentProvider {
  return config.payments.mode === 'stripe'
    ? new StripePaymentProvider({ enabled: true, secretKey: config.payments.secretKey })
    : disabledPaymentProvider;
}

function providerFailure(error: unknown): HttpError {
  if (error instanceof PaymentProviderError) {
    const status = error.code === 'PAYMENT_PROVIDER_DISABLED' ? 503
      : error.status && error.status >= 400 && error.status < 500 ? 400 : 502;
    return new HttpError(status, error.transient
      ? 'The payment provider is temporarily unavailable. Please retry.'
      : 'The payment provider could not complete this refund.', { code: error.code });
  }
  return new HttpError(502, 'The payment provider could not complete this refund.');
}

function preparation(refund: {
  id: string; paymentIntentId: string; providerRefundId: string | null;
}, intent: RefundableIntent): RefundPreparation {
  if (intent.provider !== 'STRIPE' || !intent.providerReference
    || !intent.providerAccountReference || !['SUCCEEDED', 'REFUNDED'].includes(intent.status)) {
    throw new HttpError(409, 'The live checkout intent cannot be refunded safely');
  }
  return {
    refundId: refund.id, paymentIntentId: intent.id,
    providerPaymentIntentId: intent.providerReference,
    providerAccountReference: intent.providerAccountReference,
    amount: intent.amount, currency: intent.currency,
    providerRefundId: refund.providerRefundId,
  };
}

/**
 * Called from the same transaction that validates the domain cancellation.
 * The advisory lock makes concurrent requests reuse one active provider
 * refund, whose database id is also the stable Stripe idempotency key.
 */
export async function prepareProviderRefund(
  tx: Tx, input: {
    intent: RefundableIntent; paymentId: string | null; reason: string; requestedByUserId: string;
  },
): Promise<RefundPreparation> {
  const { intent } = input;
  if (intent.provider !== 'STRIPE' || !intent.providerReference
    || !intent.providerAccountReference || intent.status !== 'SUCCEEDED') {
    throw new HttpError(409, 'The live checkout intent cannot be refunded safely');
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-refund:${intent.id}`}, 0))`;
  const existing = await tx.paymentRefund.findFirst({
    where: {
      paymentIntentId: intent.id, paymentId: input.paymentId, amount: intent.amount,
      status: { in: ['PENDING', 'SUCCEEDED'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  const refund = existing ?? await tx.paymentRefund.create({ data: {
    businessId: intent.businessId, paymentIntentId: intent.id, paymentId: input.paymentId,
    amount: intent.amount, reason: input.reason, requestedByUserId: input.requestedByUserId,
  } });
  return preparation(refund, intent);
}

async function recordProviderFailure(refundId: string, error: PaymentProviderError) {
  // A timeout or transport failure is ambiguous: Stripe may have accepted the
  // idempotent request. Keep it pending so a retry retrieves or safely repeats
  // the same operation. A definite provider rejection can be retried as a new
  // audit attempt after its FAILED row is retained.
  await prisma.paymentRefund.updateMany({ where: { id: refundId, status: 'PENDING' }, data: {
    status: error.transient ? 'PENDING' : 'FAILED',
    failureCode: error.providerCode || error.code,
  } });
}

function assertMatchingProviderRefund(
  prepared: RefundPreparation, remote: ProviderRefund,
) {
  if (remote.paymentIntentId !== prepared.providerPaymentIntentId
    || remote.amount !== prepared.amount || remote.currency !== prepared.currency) {
    throw new HttpError(502, 'The payment provider returned a mismatched refund');
  }
}

async function finalizeRentalRefund(tx: Tx, refund: RefundWithRelations, now: Date) {
  const reservationId = refund.paymentIntent.reservationId;
  if (!reservationId) throw new HttpError(409, 'The rental refund has no reservation');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`venue-reservation:${reservationId}`}, 0))`;
  const reservation = await tx.venueReservation.findUnique({ where: { id: reservationId } });
  if (!reservation || reservation.businessId !== refund.businessId) {
    throw new HttpError(409, 'The rental reservation cannot be refunded safely');
  }
  if (reservation.packageId || reservation.creditConsumed) {
    throw new HttpError(409, 'A card refund cannot alter a package-backed rental');
  }
  if (refund.payment && !refund.payment.reversedAt) {
    await tx.payment.update({ where: { id: refund.payment.id }, data: {
      reversedAt: now, reversedByUserId: refund.requestedByUserId, reversedReason: refund.reason,
    } });
  }
  if (refund.paymentIntent.status === 'SUCCEEDED') {
    await tx.paymentIntent.update({ where: { id: refund.paymentIntent.id }, data: { status: 'REFUNDED' } });
  }
  if (reservation.status !== 'CANCELLED' || !reservation.cancelledAt) {
    await tx.venueReservation.update({ where: { id: reservation.id }, data: {
      status: 'CANCELLED', paymentStatus: 'REFUNDED', creditConsumed: false, cancelledAt: now,
    } });
    await releaseRentalUnit(tx, reservation.id);
  }
}

async function finalizeLedgerRefund(tx: Tx, refund: RefundWithRelations, now: Date) {
  const payment = refund.payment;
  if (!payment) throw new HttpError(409, 'The checkout payment cannot be refunded safely');
  const isPayout = payment.kind === 'CLUB_TO_COACH';
  if (isPayout || !payment.studentId || !payment.student) {
    throw new HttpError(409, 'The live student payment cannot be refunded safely');
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${payment.studentId}`}, 0))`;
  if (payment.packageId) {
    await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${payment.packageId} AND "businessId" = ${refund.businessId} FOR UPDATE`;
  }
  if (!payment.reversedAt) {
    await tx.payment.update({ where: { id: payment.id }, data: {
      reversedAt: now, reversedByUserId: refund.requestedByUserId, reversedReason: refund.reason,
    } });
  }
  if (refund.paymentIntent.status === 'SUCCEEDED') {
    await tx.paymentIntent.update({ where: { id: refund.paymentIntent.id }, data: { status: 'REFUNDED' } });
  }

  if (payment.bookingId) {
    const participant = await tx.participant.findFirst({
      where: { bookingId: payment.bookingId, studentId: payment.studentId, cancelledAt: null },
    });
    if (participant && !participant.packageId) {
      const remaining = await tx.payment.aggregate({ where: {
        bookingId: payment.bookingId, studentId: payment.studentId,
        kind: { not: 'CLUB_TO_COACH' }, reversedAt: null,
      }, _sum: { amount: true } });
      const stillPaid = (remaining._sum.amount ?? 0) >= participant.price;
      if (participant.paid !== stillPaid) {
        await tx.participant.update({ where: { id: participant.id }, data: { paid: stillPaid } });
      }
      if (!stillPaid) {
        await createBookingAccountAlerts(tx, payment.bookingId, 'PAYMENT_REVERSED', [payment.student.userId]);
      }
    }
  }
  if (payment.packageId) {
    const pkg = await tx.lessonPackage.findFirst({
      where: { id: payment.packageId, businessId: refund.businessId },
    });
    if (pkg) {
      const remaining = await tx.payment.aggregate({ where: {
        packageId: pkg.id, kind: { not: 'CLUB_TO_COACH' }, reversedAt: null,
      }, _sum: { amount: true } });
      const stillPaid = (remaining._sum.amount ?? 0) >= pkg.price;
      if (pkg.paid !== stillPaid) {
        await tx.lessonPackage.update({ where: { id: pkg.id }, data: { paid: stillPaid } });
        await tx.participant.updateMany({
          where: { packageId: pkg.id, cancelledAt: null }, data: { paid: stillPaid },
        });
      }
    }
  }
  await notifyWorkspace(tx, {
    businessId: refund.businessId, instructorId: null, bookingId: payment.bookingId, type: 'PAYMENT',
    title: 'Payment reversed',
    message: `${refund.business.currency} ${(payment.amount / 100).toFixed(2)} recorded for ${payment.student.name} was reversed${refund.reason ? `: ${refund.reason}` : '.'}`,
  });
}

const refundInclude = {
  business: { select: { currency: true } },
  payment: { include: { student: true } },
  paymentIntent: true,
} satisfies Prisma.PaymentRefundInclude;
type RefundWithRelations = Prisma.PaymentRefundGetPayload<{ include: typeof refundInclude }>;

/** Apply provider truth and all local side effects in one transaction. */
export async function reconcileProviderRefund(
  refundId: string, remote: ProviderRefund,
): Promise<RefundExecutionResult> {
  return prisma.$transaction(async tx => {
    // Match the preparation routes' domain-first lock order. Reading the
    // immutable relationships before locking is safe; all mutable state is
    // reloaded after the locks have been acquired.
    const snapshot = await tx.paymentRefund.findUnique({
      where: { id: refundId },
      include: { payment: { select: { studentId: true, packageId: true } }, paymentIntent: true },
    });
    if (!snapshot) throw new HttpError(404, 'Payment refund not found');
    if (snapshot.paymentIntent.kind === 'RENTAL') {
      if (!snapshot.paymentIntent.reservationId) throw new HttpError(409, 'The rental refund has no reservation');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`venue-reservation:${snapshot.paymentIntent.reservationId}`}, 0))`;
    } else {
      if (!snapshot.payment?.studentId) throw new HttpError(409, 'The live student payment cannot be refunded safely');
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${snapshot.payment.studentId}`}, 0))`;
      if (snapshot.payment.packageId) {
        await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${snapshot.payment.packageId} AND "businessId" = ${snapshot.businessId} FOR UPDATE`;
      }
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-refund:${refundId}`}, 0))`;
    const refund = await tx.paymentRefund.findUnique({ where: { id: refundId }, include: refundInclude });
    if (!refund) throw new HttpError(404, 'Payment refund not found');
    const prepared = preparation(refund, refund.paymentIntent);
    assertMatchingProviderRefund(prepared, remote);
    if (refund.status === 'SUCCEEDED') return { refundId, status: 'SUCCEEDED' };
    if (['FAILED', 'CANCELLED'].includes(refund.status) && remote.state !== 'SUCCEEDED') {
      return { refundId, status: refund.status as 'FAILED' | 'CANCELLED' };
    }

    if (remote.state !== 'SUCCEEDED') {
      await tx.paymentRefund.update({ where: { id: refund.id }, data: {
        providerRefundId: remote.id, status: remote.state, failureCode: remote.failureCode,
      } });
      return { refundId, status: remote.state === 'PENDING' ? 'PENDING' : remote.state };
    }

    const now = new Date();
    if (refund.paymentIntent.kind === 'RENTAL') await finalizeRentalRefund(tx, refund, now);
    else await finalizeLedgerRefund(tx, refund, now);
    await tx.paymentRefund.update({ where: { id: refund.id }, data: {
      providerRefundId: remote.id, status: 'SUCCEEDED', failureCode: null, succeededAt: now,
    } });
    return { refundId, status: 'SUCCEEDED' };
  }, { timeout: 30_000 });
}

/** Calls Stripe only after the caller's preparation transaction committed. */
export async function executePreparedRefund(
  prepared: RefundPreparation, provider: PaymentProvider = configuredProvider(),
): Promise<RefundExecutionResult> {
  const current = await prisma.paymentRefund.findUnique({ where: { id: prepared.refundId } });
  if (!current) throw new HttpError(404, 'Payment refund not found');
  if (current.status === 'SUCCEEDED') return { refundId: current.id, status: 'SUCCEEDED' };
  let remote: ProviderRefund;
  try {
    remote = current.providerRefundId
      ? await provider.retrieveRefund(current.providerRefundId, {
          providerAccountReference: prepared.providerAccountReference,
        })
      : await provider.createRefund({
          paymentIntentId: prepared.providerPaymentIntentId, amount: prepared.amount,
          providerAccountReference: prepared.providerAccountReference,
          idempotencyKey: `courtly:refund:${prepared.refundId}`, reason: 'requested_by_customer',
          metadata: { courtlyPaymentRefundId: prepared.refundId, courtlyPaymentIntentId: prepared.paymentIntentId },
        });
  } catch (error) {
    if (error instanceof PaymentProviderError) await recordProviderFailure(prepared.refundId, error);
    throw providerFailure(error);
  }
  try {
    assertMatchingProviderRefund(prepared, remote);
  } catch (error) {
    await prisma.paymentRefund.updateMany({ where: { id: prepared.refundId, status: 'PENDING' }, data: {
      providerRefundId: remote.id, failureCode: 'PROVIDER_RESPONSE_MISMATCH',
    } });
    throw error;
  }
  const result = await reconcileProviderRefund(prepared.refundId, remote);
  if (result.status === 'FAILED' || result.status === 'CANCELLED') {
    throw new HttpError(409, 'The payment provider did not complete this refund');
  }
  return result;
}

function webhookString(object: Readonly<Record<string, unknown>>, field: string) {
  const value = object[field];
  return typeof value === 'string' && value ? value : null;
}

/** Parse only Stripe refund objects; charge events are intentionally ignored. */
export function providerRefundFromWebhook(event: StripeWebhookEvent): ProviderRefund | null {
  if (!['refund.created', 'refund.updated', 'refund.failed'].includes(event.type)) return null;
  const object = event.dataObject;
  const id = webhookString(object, 'id');
  const paymentIntentId = webhookString(object, 'payment_intent');
  const status = webhookString(object, 'status');
  const currency = webhookString(object, 'currency');
  const amount = object.amount;
  if (!id || !paymentIntentId || !status || !currency
    || typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
    throw new HttpError(400, 'Stripe refund event is malformed');
  }
  const state = status === 'succeeded' ? 'SUCCEEDED'
    : status === 'failed' ? 'FAILED'
    : status === 'canceled' ? 'CANCELLED'
    : status === 'pending' || status === 'requires_action' ? 'PENDING' : null;
  if (!state) throw new HttpError(400, 'Stripe refund event has an unsupported status');
  return {
    id, paymentIntentId, state, providerStatus: status, amount, currency: currency.toUpperCase(),
    failureCode: webhookString(object, 'failure_reason'),
  };
}

export async function applyProviderRefundWebhook(event: StripeWebhookEvent, remote: ProviderRefund) {
  const metadata = event.dataObject.metadata;
  const localId = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).courtlyPaymentRefundId : null;
  const refund = typeof localId === 'string'
    ? await prisma.paymentRefund.findFirst({ where: {
        id: localId, paymentIntent: { provider: 'STRIPE', providerAccountReference: event.account },
        OR: [{ providerRefundId: remote.id }, { providerRefundId: null }],
      } })
    : await prisma.paymentRefund.findFirst({ where: {
        providerRefundId: remote.id,
        paymentIntent: { provider: 'STRIPE', providerAccountReference: event.account },
      } });
  if (!refund) throw new HttpError(404, 'Webhook refund is not known');
  return reconcileProviderRefund(refund.id, remote);
}
