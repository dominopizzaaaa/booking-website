import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBookings } from '../src/scheduling.js';
import {
  executePreparedRefund, prepareProviderRefund, providerRefundFromWebhook, reconcileProviderRefund,
} from '../src/payments/refunds.js';
import { PaymentProviderError, type PaymentProvider, type ProviderRefund } from '../src/payments/provider.js';
import type { StripeWebhookEvent } from '../src/payments/webhooks.js';
import {
  createAccount, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

function provider(createRefund: PaymentProvider['createRefund'], retrieveRefund?: PaymentProvider['retrieveRefund']): PaymentProvider {
  return {
    name: 'STRIPE', enabled: true, createRefund,
    retrieveRefund: retrieveRefund ?? vi.fn(),
    createPaymentIntent: vi.fn(), retrievePaymentIntent: vi.fn(), cancelPaymentIntent: vi.fn(),
    retrieveBalanceTransaction: vi.fn(),
  };
}

describe.sequential('durable provider refunds', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function paidStripeBooking() {
    const account = await createAccount(club);
    const student = await createStudent(club, {
      userId: account.id, name: account.name, email: account.email,
    });
    const created = await createBookings(club.business.id, inputFor(club, {
      studentId: undefined, student: { name: account.name, email: account.email, phone: '', parentName: '' },
    }), { studentUserId: account.id });
    const booking = created.bookings[0]!;
    const participant = await prisma.participant.findFirstOrThrow({
      where: { bookingId: booking.id, studentId: student.id },
    });
    const providerReference = `pi_${randomUUID().replaceAll('-', '')}`;
    const intent = await prisma.$transaction(async tx => {
      const checkout = await tx.paymentIntent.create({ data: {
        userId: account.id, businessId: club.business.id, kind: 'BOOKING', participantId: participant.id,
        amount: participant.price, currency: club.business.currency, status: 'SUCCEEDED', provider: 'STRIPE',
        providerAccountReference: 'acct_refund_test', providerReference, idempotencyKey: randomUUID(),
        checkoutSnapshot: { kind: 'BOOKING', bookingId: booking.id, studentId: student.id },
        confirmedAt: new Date(),
      } });
      const payment = await tx.payment.create({ data: {
        businessId: club.business.id, studentId: student.id, bookingId: booking.id,
        paymentIntentId: checkout.id, amount: participant.price, kind: 'STUDENT_TO_CLUB',
        method: 'STRIPE', note: 'Live checkout',
      } });
      await tx.participant.update({ where: { id: participant.id }, data: { paid: true } });
      return { ...checkout, payment };
    });
    const prepared = await prisma.$transaction(tx => prepareProviderRefund(tx, {
      intent, paymentId: intent.payment.id, reason: 'Customer requested a refund',
      requestedByUserId: club.user.id,
    }));
    return { intent, participant, prepared };
  }

  it('keeps every local money and booking state intact after an ambiguous provider failure', async () => {
    const { intent, participant, prepared } = await paidStripeBooking();
    const createRefund = vi.fn().mockRejectedValue(new PaymentProviderError(
      'PROVIDER_TIMEOUT', { status: 504, transient: true },
    ));

    await expect(executePreparedRefund(prepared, provider(createRefund)))
      .rejects.toMatchObject({ status: 502 });

    expect(createRefund).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `courtly:refund:${prepared.refundId}`,
      paymentIntentId: intent.providerReference, amount: intent.amount,
    }));
    await expect(prisma.paymentRefund.findUniqueOrThrow({ where: { id: prepared.refundId } }))
      .resolves.toMatchObject({ status: 'PENDING', failureCode: 'PROVIDER_TIMEOUT' });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: intent.payment.id } }))
      .resolves.toMatchObject({ reversedAt: null });
    await expect(prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }))
      .resolves.toMatchObject({ status: 'SUCCEEDED' });
    await expect(prisma.participant.findUniqueOrThrow({ where: { id: participant.id } }))
      .resolves.toMatchObject({ paid: true });
  });

  it('records provider pending first and applies all local reversal state only after success', async () => {
    const { intent, participant, prepared } = await paidStripeBooking();
    const pending: ProviderRefund = {
      id: 're_pending', paymentIntentId: intent.providerReference!, state: 'PENDING',
      providerStatus: 'pending', amount: intent.amount, currency: intent.currency, failureCode: null,
    };
    const succeeded: ProviderRefund = { ...pending, state: 'SUCCEEDED', providerStatus: 'succeeded' };
    const createRefund = vi.fn().mockResolvedValue(pending);
    const retrieveRefund = vi.fn().mockResolvedValue(succeeded);
    const runtime = provider(createRefund, retrieveRefund);

    await expect(executePreparedRefund(prepared, runtime)).resolves.toEqual({
      refundId: prepared.refundId, status: 'PENDING',
    });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: intent.payment.id } }))
      .resolves.toMatchObject({ reversedAt: null });
    await expect(prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }))
      .resolves.toMatchObject({ status: 'SUCCEEDED' });

    await expect(executePreparedRefund(prepared, runtime)).resolves.toEqual({
      refundId: prepared.refundId, status: 'SUCCEEDED',
    });
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(retrieveRefund).toHaveBeenCalledWith('re_pending', {
      providerAccountReference: prepared.providerAccountReference,
    });
    await expect(prisma.paymentRefund.findUniqueOrThrow({ where: { id: prepared.refundId } }))
      .resolves.toMatchObject({ status: 'SUCCEEDED', providerRefundId: 're_pending', failureCode: null });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: intent.payment.id } }))
      .resolves.toMatchObject({ reversedReason: 'Customer requested a refund' });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: intent.payment.id } })).reversedAt).not.toBeNull();
    await expect(prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }))
      .resolves.toMatchObject({ status: 'REFUNDED' });
    await expect(prisma.participant.findUniqueOrThrow({ where: { id: participant.id } }))
      .resolves.toMatchObject({ paid: false });

    await expect(executePreparedRefund(prepared, runtime)).resolves.toEqual({
      refundId: prepared.refundId, status: 'SUCCEEDED',
    });
    expect(retrieveRefund).toHaveBeenCalledTimes(1);
  });

  it('parses refund webhook state without accepting malformed or unrelated objects', () => {
    const event = (type: string, dataObject: Record<string, unknown>): StripeWebhookEvent => ({
      id: 'evt_refund', type, account: 'acct_refund_test', createdAt: new Date(),
      livemode: true, dataObject, payloadHash: 'a'.repeat(64), raw: {},
    });
    expect(providerRefundFromWebhook(event('refund.updated', {
      id: 're_123', payment_intent: 'pi_123', status: 'succeeded', amount: 5000, currency: 'sgd',
    }))).toMatchObject({ id: 're_123', state: 'SUCCEEDED', currency: 'SGD' });
    expect(providerRefundFromWebhook(event('charge.updated', { id: 'ch_123' }))).toBeNull();
    expect(() => providerRefundFromWebhook(event('refund.updated', { id: 're_bad' })))
      .toThrowError(expect.objectContaining({ status: 400 }));
  });

  it('does not let a delayed pending event overwrite a terminal provider failure', async () => {
    const { intent, prepared } = await paidStripeBooking();
    await prisma.paymentRefund.update({ where: { id: prepared.refundId }, data: {
      status: 'FAILED', providerRefundId: 're_terminal', failureCode: 'declined',
    } });
    const result = await reconcileProviderRefund(prepared.refundId, {
      id: 're_terminal', paymentIntentId: intent.providerReference!, state: 'PENDING',
      providerStatus: 'pending', amount: intent.amount, currency: intent.currency, failureCode: null,
    });
    expect(result).toEqual({ refundId: prepared.refundId, status: 'FAILED' });
    await expect(prisma.paymentRefund.findUniqueOrThrow({ where: { id: prepared.refundId } }))
      .resolves.toMatchObject({ status: 'FAILED', failureCode: 'declined' });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: intent.payment.id } }))
      .resolves.toMatchObject({ reversedAt: null });
  });
});
