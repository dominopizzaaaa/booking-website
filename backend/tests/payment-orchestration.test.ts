import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkoutIntentJson, checkoutReviewFor, createOrResumeProviderCheckout, prepareCheckout } from '../src/payments/checkout.js';
import { CURRENT_PRIVACY_POLICY_VERSION } from '../src/children-policy.js';
import { CHECKOUT_POLICY_VERSION } from '../src/payments/compliance.js';
import {
  applyProviderPaymentIntent, assertBookingFulfillmentContract, providerIntentFromWebhook,
} from '../src/payments/fulfillment.js';
import type { ProviderPaymentIntent } from '../src/payments/provider.js';
import type { StripeWebhookEvent } from '../src/payments/webhooks.js';
import { createBookings } from '../src/scheduling.js';
import {
  createSession, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

function webhook(type: string, object: Record<string, unknown>): StripeWebhookEvent {
  return {
    id: 'evt_123', type, account: 'acct_club', createdAt: new Date('2026-09-28T10:00:00Z'),
    livemode: false, dataObject: object, payloadHash: 'a'.repeat(64), raw: {},
  };
}

describe('payment checkout orchestration', () => {
  function bookingContract(overrides: {
    intent?: Partial<{ businessId: string; userId: string; amount: number }>;
    snapshot?: Partial<{ kind: 'BOOKING'; bookingId: string; studentId: string }>;
    participant?: Partial<{
      bookingId: string; studentId: string; price: number; paid: boolean; packageId: string | null;
      cancelledAt: Date | null;
    }>;
    booking?: Partial<{ businessId: string; status: string; paymentRoute: string }>;
    business?: Partial<{ kind: string; isDemo: boolean; legacyReadOnly: boolean }>;
    student?: Partial<{ businessId: string; userId: string | null }>;
    collectedAmount?: number;
  } = {}) {
    return {
      intent: { businessId: 'club_1', userId: 'user_1', amount: 8_000, ...overrides.intent },
      snapshot: { kind: 'BOOKING' as const, bookingId: 'booking_1', studentId: 'student_1', ...overrides.snapshot },
      participant: {
        bookingId: 'booking_1', studentId: 'student_1', price: 10_000, paid: false,
        packageId: null, cancelledAt: null, ...overrides.participant,
        student: { businessId: 'club_1', userId: 'user_1', ...overrides.student },
        booking: {
          businessId: 'club_1', status: 'CONFIRMED', paymentRoute: 'CLUB', ...overrides.booking,
          business: { kind: 'CLUB', isDemo: false, legacyReadOnly: false, ...overrides.business },
        },
      },
      collectedAmount: overrides.collectedAmount ?? 2_000,
    };
  }

  it('serializes only browser-safe intent fields and adds the ephemeral client secret', () => {
    const result = checkoutIntentJson({
      id: 'local_1', kind: 'PACKAGE', status: 'REQUIRES_CONFIRMATION', amount: 12_500,
      currency: 'SGD', provider: 'STRIPE', providerReference: 'pi_123',
      packageOfferId: 'offer_1', packageId: null, participantId: null, reservationId: null,
      failureCode: null, createdAt: new Date('2026-09-28T10:00:00Z'),
      confirmedAt: null, failedAt: null,
    }, 'pi_123_secret_client');
    expect(result).toMatchObject({
      id: 'local_1', status: 'REQUIRES_CONFIRMATION', amount: 12_500,
      clientSecret: 'pi_123_secret_client', createdAt: '2026-09-28T10:00:00.000Z',
    });
    expect(result).not.toHaveProperty('idempotencyKey');
    expect(result).not.toHaveProperty('checkoutSnapshot');
  });

  it('maps a successful Stripe event to the provider-neutral fulfillment input', () => {
    expect(providerIntentFromWebhook(webhook('payment_intent.succeeded', {
      id: 'pi_123', status: 'succeeded', amount: 12_500, currency: 'sgd', latest_charge: 'ch_123',
      metadata: { courtlyPaymentIntentId: 'local_1' },
    }))).toEqual({
      id: 'pi_123', state: 'SUCCEEDED', providerStatus: 'succeeded', amount: 12_500,
      currency: 'SGD', clientSecret: null, latestChargeId: 'ch_123', failureCode: null,
    });
  });

  it('captures only the provider failure code and ignores unrelated event types', () => {
    expect(providerIntentFromWebhook(webhook('payment_intent.payment_failed', {
      id: 'pi_123', status: 'requires_payment_method', amount: 12_500, currency: 'sgd',
      last_payment_error: { code: 'card_declined', message: 'provider detail' },
    }))).toMatchObject({ state: 'FAILED', failureCode: 'card_declined' });
    expect(providerIntentFromWebhook(webhook('charge.updated', { id: 'ch_123' }))).toBeNull();
  });

  it('rejects malformed terminal events before fulfillment', () => {
    expect(() => providerIntentFromWebhook(webhook('payment_intent.succeeded', {
      id: 'pi_123', status: 'succeeded', amount: '12500', currency: 'sgd',
    }))).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it('accepts fulfillment only when the locked provider amount exactly clears the current balance', () => {
    expect(() => assertBookingFulfillmentContract(bookingContract())).not.toThrow();
    expect(() => assertBookingFulfillmentContract(bookingContract({ collectedAmount: 4_000 })))
      .toThrowError(expect.objectContaining({
        status: 409, message: expect.stringContaining('balance changed after checkout began'),
      }));
    expect(() => assertBookingFulfillmentContract(bookingContract({
      intent: { amount: 6_000 }, collectedAmount: 2_000,
    }))).toThrowError(expect.objectContaining({ status: 409 }));
  });

  it('rejects a delayed success when the participant or booking was cancelled', () => {
    expect(() => assertBookingFulfillmentContract(bookingContract({
      participant: { cancelledAt: new Date('2026-09-28T09:00:00Z') },
    }))).toThrowError(expect.objectContaining({ status: 409, message: expect.stringContaining('cancelled') }));
    expect(() => assertBookingFulfillmentContract(bookingContract({
      booking: { status: 'CANCELLED' },
    }))).toThrowError(expect.objectContaining({ status: 409, message: expect.stringContaining('cancelled') }));
  });

  it('rejects stale tenant, party, package, and non-club fulfillment state', () => {
    const conflicts = [
      bookingContract({ student: { businessId: 'another_club' } }),
      bookingContract({ student: { userId: 'another_user' } }),
      bookingContract({ participant: { packageId: 'package_1' } }),
      bookingContract({ booking: { paymentRoute: 'DIRECT' } }),
      bookingContract({ business: { kind: 'SOLO' } }),
      bookingContract({ participant: { paid: true } }),
    ];
    for (const contract of conflicts) {
      expect(() => assertBookingFulfillmentContract(contract))
        .toThrowError(expect.objectContaining({ status: 409 }));
    }
  });
});

describe.sequential('delayed Stripe fulfillment', () => {
  let tenants: TestTenants;
  let fixture: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function enableMerchantCheckout() {
    await prisma.business.update({ where: { id: fixture.business.id }, data: {
      legalName: `${fixture.business.name} Pte. Ltd.`, supportEmail: fixture.business.email,
      supportAddress: '1 Test Court, Singapore 123456', gstRegistrationStatus: 'NOT_REGISTERED',
    } });
    await prisma.businessPaymentAccount.create({ data: {
      businessId: fixture.business.id, providerAccountId: `acct_${randomUUID().replaceAll('-', '')}`,
      settlementCurrency: fixture.business.currency, chargesEnabled: true,
    } });
  }

  async function prepareAcceptedBookingCheckout(input: {
    userId: string; participantId: string; idempotencyKey: string; sessionId: string;
  }) {
    const review = await checkoutReviewFor({
      userId: input.userId, kind: 'BOOKING', targetId: input.participantId,
    });
    return prepareCheckout({
      userId: input.userId, kind: 'BOOKING', targetId: input.participantId,
      idempotencyKey: input.idempotencyKey, sessionId: input.sessionId,
      acceptance: {
        accepted: true, reviewHash: review.reviewHash, termsVersion: CHECKOUT_POLICY_VERSION,
        cancellationRefundPolicyVersion: CHECKOUT_POLICY_VERSION, packageTermsVersion: null,
      },
    });
  }

  function succeededProvider(id: string, amount: number, currency = 'SGD'): ProviderPaymentIntent {
    return {
      id, state: 'SUCCEEDED', providerStatus: 'succeeded', amount, currency, clientSecret: null,
      latestChargeId: `ch_${id}`, failureCode: null,
    };
  }

  async function bookingCheckout() {
    const student = await createStudent(fixture);
    const created = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }));
    const participant = await prisma.participant.findUniqueOrThrow({
      where: { id: created.bookings[0]!.participants[0]!.id },
    });
    const providerReference = `pi_${randomUUID()}`;
    const intent = await prisma.paymentIntent.create({ data: {
      userId: student.userId!, businessId: fixture.business.id, kind: 'BOOKING',
      participantId: participant.id, amount: participant.price, currency: fixture.business.currency,
      status: 'REQUIRES_CONFIRMATION', provider: 'STRIPE',
      providerAccountReference: `acct_${fixture.business.id}`, providerReference,
      idempotencyKey: randomUUID(), checkoutSnapshot: {
        kind: 'BOOKING', bookingId: participant.bookingId, studentId: participant.studentId,
      },
    } });
    return { student, participant, intent, provider: succeededProvider(providerReference, intent.amount) };
  }

  it('allows only one active Stripe checkout across different idempotency keys for a participant', async () => {
    const student = await createStudent(fixture);
    const studentSession = await createSession(fixture, student.userId!);
    const created = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    await enableMerchantCheckout();

    const first = await prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey: `first-${randomUUID()}`,
      sessionId: studentSession.session.id,
    });
    expect(first.replay).toBe(false);
    await expect(prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey: `second-${randomUUID()}`,
      sessionId: studentSession.session.id,
    })).rejects.toMatchObject({ status: 409, message: 'A card checkout is already in progress for this booking' });
    expect(await prisma.paymentIntent.count({ where: { participantId, provider: 'STRIPE' } })).toBe(1);
  });

  it('resumes the same failed Stripe checkout when the browser supplies a fresh key', async () => {
    const student = await createStudent(fixture);
    const studentSession = await createSession(fixture, student.userId!);
    const created = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    await enableMerchantCheckout();
    const first = await prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey: `first-${randomUUID()}`,
      sessionId: studentSession.session.id,
    });
    const providerReference = `pi_${randomUUID()}`;
    await prisma.paymentIntent.update({ where: { id: first.intentId }, data: { providerReference } });
    await applyProviderPaymentIntent(first.intentId, {
      id: providerReference, state: 'FAILED', providerStatus: 'requires_payment_method',
      amount: first.amount, currency: first.currency, clientSecret: 'secret_retry',
      latestChargeId: null, failureCode: 'card_declined',
    });

    const retry = await prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey: `second-${randomUUID()}`,
      sessionId: studentSession.session.id,
    });
    expect(retry).toMatchObject({ intentId: first.intentId, providerReference, replay: true });
    const retrievePaymentIntent = vi.fn().mockResolvedValue({
      id: providerReference, state: 'REQUIRES_CONFIRMATION', providerStatus: 'requires_payment_method',
      amount: first.amount, currency: first.currency, clientSecret: 'secret_retry',
      latestChargeId: null, failureCode: null,
    });
    const result = await createOrResumeProviderCheckout({
      name: 'STRIPE', enabled: true, retrievePaymentIntent,
      createPaymentIntent: vi.fn(), cancelPaymentIntent: vi.fn(), createRefund: vi.fn(),
      retrieveRefund: vi.fn(), retrieveBalanceTransaction: vi.fn(),
    }, retry);

    expect(retrievePaymentIntent).toHaveBeenCalledWith(providerReference, retry);
    expect(result).toMatchObject({ clientSecret: 'secret_retry', replay: true, intent: {
      id: first.intentId, status: 'REQUIRES_CONFIRMATION', failedAt: null, failureCode: null,
    } });
    expect(await prisma.paymentIntent.count({ where: { participantId, provider: 'STRIPE' } })).toBe(1);
  });

  it('requires a renewed review when exact-key replay merchant disclosures changed', async () => {
    const student = await createStudent(fixture);
    const studentSession = await createSession(fixture, student.userId!);
    const created = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    await enableMerchantCheckout();
    const idempotencyKey = `merchant-change-${randomUUID()}`;
    await prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey, sessionId: studentSession.session.id,
    });

    const supportEmail = `new-payments-${randomUUID()}@example.test`;
    await prisma.business.update({
      where: { id: fixture.business.id }, data: { supportEmail },
    });

    await expect(prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey, sessionId: studentSession.session.id,
    })).rejects.toMatchObject({
      status: 409, details: {
        code: 'CHECKOUT_REVIEW_CHANGED',
        review: { merchant: expect.objectContaining({ supportEmail }) },
      },
    });
  });

  it('revalidates unsafe current GST declarations on exact-key replay', async () => {
    const student = await createStudent(fixture);
    const studentSession = await createSession(fixture, student.userId!);
    const created = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    await enableMerchantCheckout();
    const idempotencyKey = `tax-change-${randomUUID()}`;
    await prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey, sessionId: studentSession.session.id,
    });

    await prisma.business.update({ where: { id: fixture.business.id }, data: {
      gstRegistrationStatus: 'REGISTERED', gstRegistrationNumber: 'M91234567X', pricesIncludeGst: false,
    } });

    await expect(prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey, sessionId: studentSession.session.id,
    })).rejects.toMatchObject({
      status: 409, details: {
        code: 'MERCHANT_IDENTITY_REQUIRED', missingFields: ['GST-inclusive displayed prices'],
      },
    });
  });

  it('revalidates unsafe current GST declarations before fresh-key failed-intent reuse', async () => {
    const student = await createStudent(fixture);
    const studentSession = await createSession(fixture, student.userId!);
    const created = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    await enableMerchantCheckout();
    const first = await prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey: `first-${randomUUID()}`,
      sessionId: studentSession.session.id,
    });
    const providerReference = `pi_${randomUUID()}`;
    await prisma.paymentIntent.update({
      where: { id: first.intentId }, data: { providerReference },
    });
    await applyProviderPaymentIntent(first.intentId, {
      id: providerReference, state: 'FAILED', providerStatus: 'requires_payment_method',
      amount: first.amount, currency: first.currency, clientSecret: 'secret_retry',
      latestChargeId: null, failureCode: 'card_declined',
    });
    await prisma.business.update({ where: { id: fixture.business.id }, data: {
      gstRegistrationStatus: 'REGISTERED', gstRegistrationNumber: 'M91234567X', pricesIncludeGst: false,
    } });

    await expect(prepareAcceptedBookingCheckout({
      userId: student.userId!, participantId, idempotencyKey: `retry-${randomUUID()}`,
      sessionId: studentSession.session.id,
    })).rejects.toMatchObject({
      status: 409, details: {
        code: 'MERCHANT_IDENTITY_REQUIRED', missingFields: ['GST-inclusive displayed prices'],
      },
    });
  });

  it.each([
    ['participant', async (participantId: string, bookingId: string) => {
      await prisma.participant.update({ where: { id: participantId }, data: { cancelledAt: new Date() } });
    }],
    ['booking', async (_participantId: string, bookingId: string) => {
      await prisma.booking.update({ where: { id: bookingId }, data: { status: 'CANCELLED' } });
    }],
  ] as const)('does not grant a paid entitlement after %s cancellation', async (_label, cancel) => {
    const checkout = await bookingCheckout();
    await cancel(checkout.participant.id, checkout.participant.bookingId);

    await expect(applyProviderPaymentIntent(checkout.intent.id, checkout.provider))
      .rejects.toMatchObject({
        status: 409, message: expect.stringContaining('refund the provider payment'),
      });
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: checkout.intent.id } }))
      .toMatchObject({ status: 'REQUIRES_CONFIRMATION', packageId: null });
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: checkout.participant.id } }))
      .toMatchObject({ paid: false });
    expect(await prisma.payment.count({ where: { paymentIntentId: checkout.intent.id } })).toBe(0);
  });

  it('rejects a delayed success when another receipt changed the outstanding balance', async () => {
    const checkout = await bookingCheckout();
    await prisma.payment.create({ data: {
      businessId: fixture.business.id, studentId: checkout.student.id,
      bookingId: checkout.participant.bookingId, kind: 'STUDENT_TO_CLUB', amount: 1_000, method: 'CASH',
    } });

    await expect(applyProviderPaymentIntent(checkout.intent.id, checkout.provider))
      .rejects.toThrowError('the participant balance changed after checkout began');
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: checkout.participant.id } }))
      .toMatchObject({ paid: false });
    expect(await prisma.payment.count({ where: { paymentIntentId: checkout.intent.id } })).toBe(0);
  });

  it('fulfills a delayed success once under concurrent duplicate delivery', async () => {
    const checkout = await bookingCheckout();

    const results = await Promise.all([
      applyProviderPaymentIntent(checkout.intent.id, checkout.provider),
      applyProviderPaymentIntent(checkout.intent.id, checkout.provider),
    ]);

    expect(results.every(result => result?.status === 'SUCCEEDED')).toBe(true);
    expect(await prisma.payment.count({ where: { paymentIntentId: checkout.intent.id } })).toBe(1);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: checkout.participant.id } }))
      .toMatchObject({ paid: true });
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: checkout.intent.id } }))
      .toMatchObject({ status: 'SUCCEEDED', failureCode: null });
  });

  it('fulfills a later successful retry of the same failed Stripe intent', async () => {
    const checkout = await bookingCheckout();
    const failedAt = new Date('2026-09-28T10:00:00Z');
    await applyProviderPaymentIntent(checkout.intent.id, {
      ...checkout.provider, state: 'FAILED', providerStatus: 'requires_payment_method',
      latestChargeId: null, failureCode: 'card_declined',
    }, failedAt);
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: checkout.intent.id } }))
      .toMatchObject({ status: 'FAILED', failureCode: 'card_declined', failedAt });

    const succeededAt = new Date('2026-09-28T10:01:00Z');
    const result = await applyProviderPaymentIntent(checkout.intent.id, checkout.provider, succeededAt);

    expect(result).toMatchObject({ status: 'SUCCEEDED', failureCode: null, failedAt: null, confirmedAt: succeededAt });
    expect(await prisma.payment.count({ where: { paymentIntentId: checkout.intent.id } })).toBe(1);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: checkout.participant.id } }))
      .toMatchObject({ paid: true });
  });

  it('rejects a second retryable provider intent for the same participant', async () => {
    const first = await bookingCheckout();
    const secondReference = `pi_${randomUUID()}`;
    await expect(prisma.paymentIntent.create({ data: {
      userId: first.student.userId!, businessId: fixture.business.id, kind: 'BOOKING',
      participantId: first.participant.id, amount: first.intent.amount, currency: first.intent.currency,
      status: 'REQUIRES_CONFIRMATION', provider: 'STRIPE',
      providerAccountReference: first.intent.providerAccountReference, providerReference: secondReference,
      idempotencyKey: randomUUID(), checkoutSnapshot: {
        kind: 'BOOKING', bookingId: first.participant.bookingId, studentId: first.participant.studentId,
      },
    } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.paymentIntent.count({ where: {
      participantId: first.participant.id, provider: 'STRIPE',
    } })).toBe(1);
  });

  it('does not create a package when the checkout tenant becomes ineligible', async () => {
    const student = await createStudent(fixture);
    const offer = await prisma.packageOffer.create({ data: {
      businessId: fixture.business.id, name: 'Live pass', price: 25_000, totalCredits: 5, validityDays: 90,
      services: { create: { serviceId: fixture.service.id } },
    } });
    const providerReference = `pi_${randomUUID()}`;
    const intent = await prisma.paymentIntent.create({ data: {
      userId: student.userId!, businessId: fixture.business.id, kind: 'PACKAGE',
      packageOfferId: offer.id, amount: offer.price, currency: fixture.business.currency,
      status: 'REQUIRES_CONFIRMATION', provider: 'STRIPE',
      providerAccountReference: `acct_${fixture.business.id}`, providerReference,
      idempotencyKey: randomUUID(), checkoutSnapshot: {
        kind: 'PACKAGE', name: offer.name, totalCredits: offer.totalCredits,
        validityDays: offer.validityDays, serviceIds: [fixture.service.id], rentalLocationIds: [],
      },
    } });
    await prisma.business.update({ where: { id: fixture.business.id }, data: { isDemo: true } });

    await expect(applyProviderPaymentIntent(
      intent.id, succeededProvider(providerReference, intent.amount),
    )).rejects.toMatchObject({ status: 409, message: expect.stringContaining('active club') });
    expect(await prisma.lessonPackage.count({ where: { businessId: fixture.business.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { paymentIntentId: intent.id } })).toBe(0);
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }))
      .toMatchObject({ status: 'REQUIRES_CONFIRMATION', packageId: null });
  });

  it('does not create a package entitlement for an email-less managed child account', async () => {
    const child = await prisma.$transaction(async tx => {
      await tx.user.update({
        where: { id: fixture.coachUser.id },
        data: { dateOfBirth: new Date('1990-01-01T00:00:00.000Z') },
      });
      const managedChild = await tx.user.create({ data: {
        name: 'Managed Child', legalName: 'Managed Child',
        username: `managed_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        email: null, passwordHash: null, accountType: 'STUDENT', accountControl: 'GUARDIAN_MANAGED',
        dateOfBirth: new Date('2015-01-01T00:00:00.000Z'), profileVisibility: 'PRIVATE',
      } });
      const link = await tx.guardianChildLink.create({ data: {
        guardianUserId: fixture.coachUser.id, childUserId: managedChild.id, relationshipType: 'PARENT',
      } });
      await tx.childConsentRecord.create({ data: {
        linkId: link.id, guardianUserId: fixture.coachUser.id, childUserId: managedChild.id,
        eventType: 'GRANTED', relationshipType: link.relationshipType, permissions: link.permissions,
        privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      } });
      return managedChild;
    });
    fixture.tracker.ownUser(child.id);
    const linkedStudent = await prisma.student.create({ data: {
      businessId: fixture.business.id, userId: child.id, name: child.name, initials: 'MC', email: null,
    } });
    const offer = await prisma.packageOffer.create({ data: {
      businessId: fixture.business.id, name: 'Managed-child pass', price: 25_000, totalCredits: 5, validityDays: 90,
      services: { create: { serviceId: fixture.service.id } },
    } });
    const providerReference = `pi_${randomUUID()}`;
    const intent = await prisma.paymentIntent.create({ data: {
      userId: child.id, businessId: fixture.business.id, kind: 'PACKAGE', packageOfferId: offer.id,
      amount: offer.price, currency: fixture.business.currency, status: 'REQUIRES_CONFIRMATION', provider: 'STRIPE',
      providerAccountReference: `acct_${fixture.business.id}`, providerReference, idempotencyKey: randomUUID(),
      checkoutSnapshot: {
        kind: 'PACKAGE', name: offer.name, totalCredits: offer.totalCredits,
        validityDays: offer.validityDays, serviceIds: [fixture.service.id], rentalLocationIds: [],
      },
    } });

    await expect(applyProviderPaymentIntent(
      intent.id, succeededProvider(providerReference, intent.amount),
    )).rejects.toMatchObject({
      status: 409, message: expect.stringContaining('checkout account can no longer receive a student entitlement'),
    });
    expect(await prisma.student.findUniqueOrThrow({ where: { id: linkedStudent.id } }))
      .toMatchObject({ userId: child.id, email: null });
    expect(await prisma.lessonPackage.count({ where: { student: { userId: child.id } } })).toBe(0);
    expect(await prisma.payment.count({ where: { paymentIntentId: intent.id } })).toBe(0);
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }))
      .toMatchObject({ status: 'REQUIRES_CONFIRMATION', packageId: null });
  });
});
