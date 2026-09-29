import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../http.js';
import type { PaymentProvider } from './provider.js';
import { applyProviderPaymentIntent } from './fulfillment.js';
import { assertLegalAcceptanceEnabled } from '../legal-policy-gate.js';
import {
  acceptedCheckoutData, assertCheckoutAcceptance, assertCheckoutBusinessDetailsReady,
  assertCurrentCheckoutMerchant, assertPaymentCommercialApprovalEnabled, assertStoredCheckoutAcceptance,
  bookingCheckoutReview, checkoutAcceptanceEvidence, packageCheckoutReview,
  type CheckoutAcceptance, type CheckoutReview,
} from './compliance.js';

export type CheckoutKind = 'PACKAGE' | 'BOOKING';

export type CheckoutPreparation = {
  intentId: string;
  kind: CheckoutKind;
  amount: number;
  currency: string;
  providerAccountReference: string;
  providerReference: string | null;
  idempotencyKey: string;
  receiptEmail: string;
  review: CheckoutReview;
  replay: boolean;
};

/** Revalidate mutable merchant and connected-account state after preparation
 * and immediately before the external provider operation. */
export async function assertCurrentProviderCheckout(preparation: CheckoutPreparation) {
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: preparation.intentId },
    select: {
      businessId: true, provider: true, providerAccountReference: true, amount: true, currency: true,
      checkoutSnapshot: true, business: { select: {
        id: true, name: true, legalName: true, registrationNumber: true, supportEmail: true,
        supportAddress: true, gstRegistrationStatus: true, gstRegistrationNumber: true,
        pricesIncludeGst: true, paymentAccount: { select: {
          provider: true, providerAccountId: true, chargesEnabled: true,
        } },
      } },
    },
  });
  if (!intent || intent.provider !== 'STRIPE'
    || intent.amount !== preparation.amount || intent.currency !== preparation.currency
    || intent.providerAccountReference !== preparation.providerAccountReference) {
    throw new HttpError(409, 'This checkout attempt no longer matches its payment contract');
  }
  const account = intent.business.paymentAccount;
  if (!account || account.provider !== 'STRIPE' || !account.chargesEnabled
    || account.providerAccountId !== preparation.providerAccountReference) {
    throw new HttpError(409, 'This club is no longer ready to accept online payments');
  }
  assertCurrentCheckoutMerchant(preparation.review, intent.business);
}

async function checkoutAccount(userId: string) {
  const account = await prisma.user.findUnique({
    where: { id: userId }, select: { name: true, email: true },
  });
  if (!account?.email) throw new HttpError(403, 'An account email is required to make a payment');
  return { name: account.name, email: account.email };
}

export async function checkoutReviewFor(input: {
  userId: string; kind: CheckoutKind; targetId: string;
}): Promise<CheckoutReview> {
  const purchaser = await checkoutAccount(input.userId);
  if (input.kind === 'PACKAGE') {
    const offer = await prisma.packageOffer.findFirst({
      where: { id: input.targetId, active: true },
      include: {
        business: true,
        services: {
          include: { service: { select: { name: true } } },
          orderBy: { serviceId: 'asc' },
        },
        rentalLocations: {
          include: { location: { select: { name: true } } },
          orderBy: { locationId: 'asc' },
        },
      },
    });
    if (!offer || offer.business.kind !== 'CLUB' || offer.business.isDemo
      || offer.business.legacyReadOnly) throw new HttpError(404, 'Package offer not found');
    return packageCheckoutReview({
      purchaser, business: offer.business, offer,
      scopeNames: [
        ...offer.services.map(scope => `Class: ${scope.service.name}`),
        ...offer.rentalLocations.map(scope => `Court rental: ${scope.location.name}`),
      ],
    });
  }

  const participant = await prisma.participant.findFirst({
    where: { id: input.targetId, student: { userId: input.userId } },
    include: { booking: { include: { business: true, service: true, instructor: true, location: true } } },
  });
  if (!participant) throw new HttpError(404, 'Booking participant not found');
  const business = participant.booking.business;
  if (participant.cancelledAt || participant.booking.status === 'CANCELLED') {
    throw new HttpError(409, 'Cancelled bookings cannot be paid');
  }
  if (participant.packageId || participant.paid) throw new HttpError(409, 'This booking is already paid');
  if (participant.booking.paymentRoute !== 'CLUB' || business.kind !== 'CLUB'
    || business.isDemo || business.legacyReadOnly) {
    throw new HttpError(409, 'This historical booking cannot receive a new payment');
  }
  const collected = await prisma.payment.aggregate({ where: {
    bookingId: participant.bookingId, studentId: participant.studentId,
    kind: { not: 'CLUB_TO_COACH' }, reversedAt: null,
  }, _sum: { amount: true } });
  const outstanding = participant.price - (collected._sum.amount ?? 0);
  if (outstanding <= 0) throw new HttpError(409, 'This booking is already paid');
  return bookingCheckoutReview({
    purchaser, business, booking: participant.booking, participant, amount: outstanding,
    service: participant.booking.service, instructor: participant.booking.instructor,
    location: participant.booking.location,
  });
}

export function checkoutIntentJson(intent: {
  id: string; kind: string; status: string; amount: number; currency: string; provider: string;
  providerReference: string | null; packageOfferId: string | null; packageId: string | null;
  participantId: string | null; reservationId: string | null; failureCode: string | null;
  createdAt: Date; confirmedAt: Date | null; failedAt: Date | null;
}, clientSecret: string | null = null) {
  return {
    id: intent.id, kind: intent.kind, status: intent.status, amount: intent.amount,
    currency: intent.currency, provider: intent.provider, providerReference: intent.providerReference,
    packageOfferId: intent.packageOfferId, packageId: intent.packageId, participantId: intent.participantId,
    reservationId: intent.reservationId, failureCode: intent.failureCode, clientSecret,
    createdAt: intent.createdAt.toISOString(), confirmedAt: intent.confirmedAt?.toISOString() ?? null,
    failedAt: intent.failedAt?.toISOString() ?? null,
  };
}

function assertReplay(intent: { kind: string; packageOfferId: string | null; participantId: string | null },
  kind: CheckoutKind, targetId: string) {
  const matches = kind === 'PACKAGE'
    ? intent.kind === kind && intent.packageOfferId === targetId && intent.participantId === null
    : intent.kind === kind && intent.participantId === targetId && intent.packageOfferId === null;
  if (!matches) throw new HttpError(409, 'This idempotency key was already used for a different checkout');
}

export async function prepareCheckout(input: {
  userId: string; kind: CheckoutKind; targetId: string; idempotencyKey: string;
  acceptance: CheckoutAcceptance; sessionId: string; ip?: string; userAgent?: string;
}): Promise<CheckoutPreparation> {
  assertLegalAcceptanceEnabled();
  assertPaymentCommercialApprovalEnabled();
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-intent:${input.userId}:${input.idempotencyKey}`}, 0))`;
    const checkoutAccount = await tx.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } });
    if (!checkoutAccount?.email) throw new HttpError(403, 'An account email is required to make a payment');
    const receiptEmail = checkoutAccount.email;
    const existing = await tx.paymentIntent.findUnique({
      where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      assertReplay(existing, input.kind, input.targetId);
      const acceptedReview = existing.checkoutSnapshot && typeof existing.checkoutSnapshot === 'object'
        && !Array.isArray(existing.checkoutSnapshot)
        && 'review' in existing.checkoutSnapshot
        ? (existing.checkoutSnapshot as { review: CheckoutReview }).review : null;
      if (!acceptedReview || acceptedReview.reviewHash !== existing.acceptedReviewHash) {
        throw new HttpError(409, 'This checkout attempt does not contain its accepted transaction review.');
      }
      const currentBusiness = await tx.business.findUnique({
        where: { id: existing.businessId },
        select: {
          id: true, name: true, legalName: true, registrationNumber: true, supportEmail: true,
          supportAddress: true, gstRegistrationStatus: true, gstRegistrationNumber: true,
          pricesIncludeGst: true,
        },
      });
      if (!currentBusiness) {
        throw new HttpError(409, 'This club is no longer available for online checkout');
      }
      const review = assertCurrentCheckoutMerchant(acceptedReview, currentBusiness);
      assertStoredCheckoutAcceptance(existing, input.acceptance);
      return {
        intentId: existing.id, kind: input.kind, amount: existing.amount, currency: existing.currency,
        providerAccountReference: existing.providerAccountReference,
        providerReference: existing.providerReference, idempotencyKey: existing.idempotencyKey,
        receiptEmail, review, replay: true,
      };
    }

    if (input.kind === 'PACKAGE') {
      const offer = await tx.packageOffer.findFirst({
        where: { id: input.targetId, active: true },
        include: {
          business: { include: { paymentAccount: true } },
          services: { include: { service: { select: { name: true } } }, orderBy: { serviceId: 'asc' } },
          rentalLocations: { include: { location: { select: { name: true } } }, orderBy: { locationId: 'asc' } },
        },
      });
      if (!offer || offer.business.kind !== 'CLUB' || offer.business.isDemo
        || offer.business.legacyReadOnly) throw new HttpError(404, 'Package offer not found');
      const account = offer.business.paymentAccount;
      if (!account || account.provider !== 'STRIPE' || !account.chargesEnabled) {
        throw new HttpError(409, 'This club is not ready to accept online payments');
      }
      const review = packageCheckoutReview({
        purchaser: { name: checkoutAccount.name, email: receiptEmail }, business: offer.business, offer,
        scopeNames: [
          ...offer.services.map(scope => `Class: ${scope.service.name}`),
          ...offer.rentalLocations.map(scope => `Court rental: ${scope.location.name}`),
        ],
      });
      assertCheckoutAcceptance(review, input.acceptance);
      assertCheckoutBusinessDetailsReady(review);
      const evidence = checkoutAcceptanceEvidence(input);
      const created = await tx.paymentIntent.create({ data: {
        userId: input.userId, businessId: offer.businessId, kind: 'PACKAGE',
        packageOfferId: offer.id, amount: offer.price, currency: offer.business.currency,
        provider: 'STRIPE', providerAccountReference: account.providerAccountId,
        providerReference: null, idempotencyKey: input.idempotencyKey,
        checkoutSnapshot: {
          kind: 'PACKAGE', name: offer.name, totalCredits: offer.totalCredits,
          validityDays: offer.validityDays, serviceIds: offer.services.map(scope => scope.serviceId),
          rentalLocationIds: offer.rentalLocations.map(scope => scope.locationId),
          review,
        },
        ...acceptedCheckoutData(review, input.acceptance, evidence),
      } });
      return {
        intentId: created.id, kind: 'PACKAGE', amount: created.amount, currency: created.currency,
        providerAccountReference: account.providerAccountId, providerReference: null,
        idempotencyKey: created.idempotencyKey, receiptEmail, review, replay: false,
      };
    }

    // Different browser attempts may legitimately carry different idempotency
    // keys. Serialize them on the purchased participant as well, then join the
    // existing payment-party lock used by fulfillment and offline receipts.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-checkout-participant:${input.targetId}`}, 0))`;
    const initialParticipant = await tx.participant.findFirst({
      where: { id: input.targetId, student: { userId: input.userId } },
      select: { studentId: true },
    });
    if (!initialParticipant) throw new HttpError(404, 'Booking participant not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${initialParticipant.studentId}`}, 0))`;
    const participant = await tx.participant.findFirst({
      where: { id: input.targetId, student: { userId: input.userId } },
      include: { student: true, booking: { include: {
        business: { include: { paymentAccount: true } }, service: true, instructor: true, location: true,
      } } },
    });
    if (!participant) throw new HttpError(404, 'Booking participant not found');
    const business = participant.booking.business;
    if (participant.cancelledAt || participant.booking.status === 'CANCELLED') {
      throw new HttpError(409, 'Cancelled bookings cannot be paid');
    }
    if (participant.packageId || participant.paid) throw new HttpError(409, 'This booking is already paid');
    if (participant.booking.paymentRoute !== 'CLUB' || business.kind !== 'CLUB'
      || business.isDemo || business.legacyReadOnly) {
      throw new HttpError(409, 'This historical booking cannot receive a new payment');
    }
    const account = business.paymentAccount;
    if (!account || account.provider !== 'STRIPE' || !account.chargesEnabled) {
      throw new HttpError(409, 'This club is not ready to accept online payments');
    }
    const collected = await tx.payment.aggregate({ where: {
      bookingId: participant.bookingId, studentId: participant.studentId,
      kind: { not: 'CLUB_TO_COACH' }, reversedAt: null,
    }, _sum: { amount: true } });
    const outstanding = participant.price - (collected._sum.amount ?? 0);
    if (outstanding <= 0) throw new HttpError(409, 'This booking is already paid');
    const review = bookingCheckoutReview({
      purchaser: { name: checkoutAccount.name, email: receiptEmail }, business, booking: participant.booking,
      participant, amount: outstanding, service: participant.booking.service,
      instructor: participant.booking.instructor, location: participant.booking.location,
    });
    assertCheckoutAcceptance(review, input.acceptance);
    assertCheckoutBusinessDetailsReady(review);
    const activeCheckout = await tx.paymentIntent.findFirst({
      where: {
        participantId: participant.id, provider: 'STRIPE',
        status: { in: ['REQUIRES_CONFIRMATION', 'FAILED'] },
      },
    });
    if (activeCheckout) {
      if (activeCheckout.status !== 'FAILED') {
        throw new HttpError(409, 'A card checkout is already in progress for this booking');
      }
      if (activeCheckout.userId !== input.userId || activeCheckout.businessId !== business.id
        || activeCheckout.amount !== outstanding || activeCheckout.currency !== business.currency
        || activeCheckout.providerAccountReference !== account.providerAccountId) {
        throw new HttpError(409, 'The existing card checkout no longer matches this booking');
      }
      assertStoredCheckoutAcceptance(activeCheckout, input.acceptance);
      return {
        intentId: activeCheckout.id, kind: 'BOOKING', amount: activeCheckout.amount,
        currency: activeCheckout.currency, providerAccountReference: activeCheckout.providerAccountReference,
        providerReference: activeCheckout.providerReference, idempotencyKey: activeCheckout.idempotencyKey,
        receiptEmail, review, replay: true,
      };
    }
    const created = await tx.paymentIntent.create({ data: {
      userId: input.userId, businessId: business.id, kind: 'BOOKING', participantId: participant.id,
      amount: outstanding, currency: business.currency, provider: 'STRIPE',
      providerAccountReference: account.providerAccountId, providerReference: null,
      idempotencyKey: input.idempotencyKey, checkoutSnapshot: {
        kind: 'BOOKING', bookingId: participant.bookingId, studentId: participant.studentId, review,
      },
      ...acceptedCheckoutData(review, input.acceptance, checkoutAcceptanceEvidence(input)),
    } });
    return {
      intentId: created.id, kind: 'BOOKING', amount: created.amount, currency: created.currency,
      providerAccountReference: account.providerAccountId, providerReference: null,
      idempotencyKey: created.idempotencyKey, receiptEmail, review, replay: false,
    };
  }, { timeout: 30_000 });
}

export async function createOrResumeProviderCheckout(
  provider: PaymentProvider, preparation: CheckoutPreparation,
  preflight: (preparation: CheckoutPreparation) => Promise<void> = assertCurrentProviderCheckout,
) {
  assertLegalAcceptanceEnabled();
  assertPaymentCommercialApprovalEnabled();
  await preflight(preparation);
  const remote = preparation.providerReference
    ? await provider.retrievePaymentIntent(preparation.providerReference, preparation)
    : await provider.createPaymentIntent({
      amount: preparation.amount, currency: preparation.currency,
      providerAccountReference: preparation.providerAccountReference,
      idempotencyKey: `courtly:${preparation.intentId}`, receiptEmail: preparation.receiptEmail,
      metadata: { courtlyPaymentIntentId: preparation.intentId, courtlyKind: preparation.kind },
    });
  if (remote.amount !== preparation.amount || remote.currency !== preparation.currency) {
    throw new HttpError(502, 'Payment provider returned a mismatched checkout');
  }
  await prisma.paymentIntent.updateMany({
    where: { id: preparation.intentId, providerReference: null },
    data: { providerReference: remote.id },
  });
  await applyProviderPaymentIntent(preparation.intentId, remote);
  const intent = await prisma.paymentIntent.findUniqueOrThrow({ where: { id: preparation.intentId } });
  return { intent, clientSecret: remote.clientSecret, replay: preparation.replay };
}
