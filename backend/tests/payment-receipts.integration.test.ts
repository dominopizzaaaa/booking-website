import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { checkoutReviewFor, prepareCheckout } from '../src/payments/checkout.js';
import { CHECKOUT_POLICY_VERSION } from '../src/payments/compliance.js';
import { applyProviderPaymentIntent } from '../src/payments/fulfillment.js';
import { createBookings } from '../src/scheduling.js';
import { createSession, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('customer payment receipts', () => {
  let tenants: TestTenants;
  let fixture: Fixture;
  let emailEnabled: boolean;

  beforeEach(async () => {
    emailEnabled = config.email.enabled;
    config.email.enabled = true;
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });
  afterEach(async () => {
    config.email.enabled = emailEnabled;
    await tenants.cleanup();
  });

  async function enableLivePayments() {
    await prisma.business.update({ where: { id: fixture.business.id }, data: {
      legalName: 'Receipt Rackets Pte. Ltd.', registrationNumber: '202612345N',
      supportEmail: 'receipts@example.test', supportAddress: '1 Court Lane, Singapore 123456',
      gstRegistrationStatus: 'NOT_REGISTERED',
    } });
    await prisma.businessPaymentAccount.create({ data: {
      businessId: fixture.business.id, providerAccountId: `acct_${randomUUID().replaceAll('-', '')}`,
      settlementCurrency: 'SGD', chargesEnabled: true,
    } });
  }

  async function successfulCheckout() {
    const student = await createStudent(fixture, { name: 'Receipt Student' });
    const session = await createSession(fixture, student.userId!);
    const created = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    await enableLivePayments();
    const review = await checkoutReviewFor({ userId: student.userId!, kind: 'BOOKING', targetId: participantId });
    const prepared = await prepareCheckout({
      userId: student.userId!, kind: 'BOOKING', targetId: participantId,
      idempotencyKey: randomUUID(), sessionId: session.session.id,
      acceptance: {
        accepted: true, reviewHash: review.reviewHash, termsVersion: CHECKOUT_POLICY_VERSION,
        cancellationRefundPolicyVersion: CHECKOUT_POLICY_VERSION, packageTermsVersion: null,
      },
    });
    const providerReference = `pi_${randomUUID()}`;
    await prisma.paymentIntent.update({ where: { id: prepared.intentId }, data: { providerReference } });
    const issuedAt = new Date('2026-09-30T07:45:00.000Z');
    await applyProviderPaymentIntent(prepared.intentId, {
      id: providerReference, state: 'SUCCEEDED', providerStatus: 'succeeded',
      amount: prepared.amount, currency: prepared.currency, clientSecret: null,
      latestChargeId: `ch_${randomUUID()}`, failureCode: null,
    }, issuedAt);
    return { student, session, prepared, review, issuedAt };
  }

  async function successfulPackageCheckout() {
    const student = await createStudent(fixture, { name: 'Package Receipt Student' });
    const session = await createSession(fixture, student.userId!);
    await enableLivePayments();
    const offer = await prisma.packageOffer.create({ data: {
      businessId: fixture.business.id, name: 'Six Class pass', description: 'Six coached Classes',
      price: 42_000, totalCredits: 6, validityDays: 90,
      services: { create: { serviceId: fixture.service.id } },
    } });
    const review = await checkoutReviewFor({ userId: student.userId!, kind: 'PACKAGE', targetId: offer.id });
    const prepared = await prepareCheckout({
      userId: student.userId!, kind: 'PACKAGE', targetId: offer.id,
      idempotencyKey: randomUUID(), sessionId: session.session.id,
      acceptance: {
        accepted: true, reviewHash: review.reviewHash, termsVersion: CHECKOUT_POLICY_VERSION,
        cancellationRefundPolicyVersion: CHECKOUT_POLICY_VERSION, packageTermsVersion: CHECKOUT_POLICY_VERSION,
      },
    });
    const providerReference = `pi_${randomUUID()}`;
    await prisma.paymentIntent.update({ where: { id: prepared.intentId }, data: { providerReference } });
    await applyProviderPaymentIntent(prepared.intentId, {
      id: providerReference, state: 'SUCCEEDED', providerStatus: 'succeeded',
      amount: prepared.amount, currency: prepared.currency, clientSecret: null,
      latestChargeId: `ch_${randomUUID()}`, failureCode: null,
    }, new Date('2026-09-30T08:15:00.000Z'));
    return { student, prepared, review, offer };
  }

  it('issues one immutable snapshot and one idempotent receipt email for a live success', async () => {
    const checkout = await successfulCheckout();
    await applyProviderPaymentIntent(checkout.prepared.intentId, {
      id: (await prisma.paymentIntent.findUniqueOrThrow({ where: { id: checkout.prepared.intentId } })).providerReference!,
      state: 'SUCCEEDED', providerStatus: 'succeeded', amount: checkout.prepared.amount,
      currency: checkout.prepared.currency, clientSecret: null, latestChargeId: 'ch_replay', failureCode: null,
    }, checkout.issuedAt);

    const receipts = await prisma.paymentReceipt.findMany({ where: { paymentIntentId: checkout.prepared.intentId } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      userId: checkout.student.userId, businessId: fixture.business.id, kind: 'BOOKING',
      amount: checkout.prepared.amount, currency: 'SGD', paymentProvider: 'STRIPE',
      checkoutReviewHash: checkout.review.reviewHash, merchantSnapshot: checkout.review.merchant,
      purchaserSnapshot: checkout.review.purchaser, itemSnapshot: checkout.review.item,
      issuedAt: checkout.issuedAt,
    });
    expect(receipts[0]!.receiptNumber).toMatch(/^RCT-20260930-[A-F0-9]{20}$/u);
    await expect(prisma.paymentReceipt.update({
      where: { id: receipts[0]!.id }, data: { amount: receipts[0]!.amount + 1 },
    })).rejects.toThrowError('Payment receipts are immutable');
    await expect(prisma.paymentReceipt.delete({
      where: { id: receipts[0]!.id },
    })).rejects.toThrowError('Payment receipts cannot be deleted independently');

    const deliveries = await prisma.outboundDelivery.findMany({
      where: { dedupeKey: `payment-receipt:${receipts[0]!.id}` },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      eventType: 'PAYMENT_RECEIPT', recipientUserId: checkout.student.userId,
      recipientEmail: checkout.review.purchaser.email, status: 'QUEUED',
    });
    expect(JSON.stringify(deliveries[0]!.payload)).not.toMatch(/card|charge|client.secret|cvc/iu);
  });

  it('lists and renders only the signed-in customer receipt', async () => {
    const checkout = await successfulCheckout();
    const receipt = await prisma.paymentReceipt.findUniqueOrThrow({
      where: { paymentIntentId: checkout.prepared.intentId },
    });
    const list = await request(app).get('/api/payments/receipts').set('Cookie', checkout.session.cookie).expect(200);
    expect(list.body.receipts).toHaveLength(1);
    expect(list.body.receipts[0]).toMatchObject({
      id: receipt.id, receiptNumber: receipt.receiptNumber, paymentStatus: 'PAID',
      refundStatus: 'NONE', refundedAmount: 0,
    });

    const document = await request(app)
      .get(`/api/payments/receipts/${receipt.id}/document?download=1`)
      .set('Cookie', checkout.session.cookie).expect(200);
    expect(document.headers['content-type']).toContain('text/html');
    expect(document.headers['content-disposition']).toContain('attachment');
    expect(document.text).toContain('Payment receipt');
    expect(document.text).toContain('Receipt Rackets Pte. Ltd.');
    expect(document.text).toContain('Receipt, not tax invoice.');
    expect(document.text).not.toContain('is the seller');

    await prisma.paymentRefund.create({ data: {
      businessId: fixture.business.id, paymentIntentId: checkout.prepared.intentId, paymentId: receipt.paymentId,
      amount: Math.floor(receipt.amount / 2), status: 'SUCCEEDED', reason: 'Partial customer refund',
      providerRefundId: `re_${randomUUID()}`, succeededAt: new Date(),
    } });
    const refunded = await request(app)
      .get(`/api/payments/receipts/${receipt.id}`).set('Cookie', checkout.session.cookie).expect(200);
    expect(refunded.body.receipt).toMatchObject({
      paymentStatus: 'PAID', refundStatus: 'PARTIALLY_REFUNDED',
      refundedAmount: Math.floor(receipt.amount / 2),
    });

    const other = await createStudent(fixture, { name: 'Other Student' });
    const otherSession = await createSession(fixture, other.userId!);
    await request(app).get(`/api/payments/receipts/${receipt.id}`).set('Cookie', otherSession.cookie).expect(404);
  });

  it('issues the same durable receipt contract for a successful live Package payment', async () => {
    const checkout = await successfulPackageCheckout();
    const receipt = await prisma.paymentReceipt.findUniqueOrThrow({
      where: { paymentIntentId: checkout.prepared.intentId },
    });
    expect(receipt).toMatchObject({
      userId: checkout.student.userId, businessId: fixture.business.id, kind: 'PACKAGE',
      amount: checkout.offer.price, currency: 'SGD', paymentProvider: 'STRIPE',
      checkoutReviewHash: checkout.review.reviewHash, merchantSnapshot: checkout.review.merchant,
      purchaserSnapshot: checkout.review.purchaser, itemSnapshot: checkout.review.item,
    });
    await expect(prisma.lessonPackage.findFirstOrThrow({
      where: { offerId: checkout.offer.id, student: { userId: checkout.student.userId } },
    })).resolves.toMatchObject({ name: checkout.offer.name, paid: true, totalCredits: 6 });
    await expect(prisma.outboundDelivery.count({
      where: { dedupeKey: `payment-receipt:${receipt.id}`, eventType: 'PAYMENT_RECEIPT' },
    })).resolves.toBe(1);
  });
});
