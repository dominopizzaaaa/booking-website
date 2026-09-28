import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBookings } from '../src/scheduling.js';
import { createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('operations schema invariants', () => {
  let tenants: TestTenants;
  let first: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    first = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function failedBookingIntent(fixture: Fixture) {
    const student = await createStudent(fixture);
    const booking = (await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }))).bookings[0]!;
    const participant = await prisma.participant.findFirstOrThrow({
      where: { bookingId: booking.id, studentId: student.id },
    });
    const intent = await prisma.paymentIntent.create({ data: {
      userId: student.userId!, businessId: fixture.business.id, kind: 'BOOKING',
      participantId: participant.id, amount: participant.price, currency: fixture.business.currency,
      status: 'FAILED', provider: 'SIMULATED_STRIPE', providerReference: `sim_pi_${randomUUID()}`,
      idempotencyKey: randomUUID(), failedAt: new Date(),
    } });
    return { student, booking, participant, intent };
  }

  it('keeps a simulated failed checkout terminal', async () => {
    const { intent } = await failedBookingIntent(first);

    await expect(prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: 'SUCCEEDED', failedAt: null, confirmedAt: new Date() },
    })).rejects.toThrow();
    await expect(prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } }))
      .resolves.toMatchObject({ status: 'FAILED' });
  });

  it('allows only one retryable Stripe booking checkout per participant at the database boundary', async () => {
    const student = await createStudent(first);
    const booking = (await createBookings(first.business.id, inputFor(first, {
      studentId: student.id, student: undefined, startAt: first.starts.plus({ days: 2 }).toISO()!,
    }))).bookings[0]!;
    const participant = await prisma.participant.findFirstOrThrow({
      where: { bookingId: booking.id, studentId: student.id },
    });
    const base = {
      userId: student.userId!, businessId: first.business.id, kind: 'BOOKING',
      participantId: participant.id, amount: participant.price, currency: first.business.currency,
      provider: 'STRIPE', providerAccountReference: `acct_${randomUUID().replaceAll('-', '')}`,
    };
    const active = await prisma.paymentIntent.create({ data: {
      ...base, providerReference: `pi_${randomUUID()}`, idempotencyKey: randomUUID(),
    } });
    await expect(prisma.paymentIntent.create({ data: {
      ...base, providerReference: `pi_${randomUUID()}`, idempotencyKey: randomUUID(), status: 'FAILED',
    } })).rejects.toThrow();
    await prisma.paymentIntent.update({ where: { id: active.id }, data: {
      status: 'CANCELLED', failureCode: 'CHECKOUT_REPLACED',
    } });
    await expect(prisma.paymentIntent.create({ data: {
      ...base, providerReference: `pi_${randomUUID()}`, idempotencyKey: randomUUID(),
    } })).resolves.toMatchObject({ participantId: participant.id, status: 'REQUIRES_CONFIRMATION' });
  });

  it('rejects a refund linked to a payment from another business', async () => {
    const second = await tenants.fixture();
    const source = await failedBookingIntent(first);
    const otherStudent = await createStudent(second);
    const otherPayment = await prisma.payment.create({ data: {
      businessId: second.business.id, studentId: otherStudent.id, kind: 'STUDENT_TO_CLUB',
      amount: source.intent.amount, method: 'CASH',
    } });

    await expect(prisma.$executeRaw`
      INSERT INTO "PaymentRefund" ("id", "businessId", "paymentIntentId", "paymentId",
        "amount", "status", "reason", "updatedAt")
      VALUES (${randomUUID()}, ${first.business.id}, ${source.intent.id}, ${otherPayment.id},
        ${source.intent.amount}, 'PENDING', 'Cross-tenant test', NOW())
    `).rejects.toThrow();
  });

  it('rejects a refund linked to another payment intent in the same business', async () => {
    async function succeededCheckout(day: number) {
      const student = await createStudent(first);
      const booking = (await createBookings(first.business.id, inputFor(first, {
        studentId: student.id, student: undefined, startAt: first.starts.plus({ days: day }).toISO()!,
      }))).bookings[0]!;
      const participant = await prisma.participant.findFirstOrThrow({
        where: { bookingId: booking.id, studentId: student.id },
      });
      return prisma.$transaction(async tx => {
        const intent = await tx.paymentIntent.create({ data: {
          userId: student.userId!, businessId: first.business.id, kind: 'BOOKING',
          participantId: participant.id, amount: participant.price, currency: first.business.currency,
          status: 'SUCCEEDED', provider: 'STRIPE', providerAccountReference: `acct_${randomUUID()}`,
          providerReference: `pi_${randomUUID()}`, idempotencyKey: randomUUID(), confirmedAt: new Date(),
          checkoutSnapshot: { kind: 'BOOKING', bookingId: booking.id, studentId: student.id },
        } });
        const payment = await tx.payment.create({ data: {
          businessId: first.business.id, studentId: student.id, bookingId: booking.id,
          kind: 'STUDENT_TO_CLUB', amount: participant.price, method: 'STRIPE', paymentIntentId: intent.id,
        } });
        await tx.participant.update({ where: { id: participant.id }, data: { paid: true } });
        return { intent, payment };
      });
    }
    const firstCheckout = await succeededCheckout(4);
    const secondCheckout = await succeededCheckout(5);

    await expect(prisma.$executeRaw`
      INSERT INTO "PaymentRefund" ("id", "businessId", "paymentIntentId", "paymentId",
        "amount", "status", "reason", "updatedAt")
      VALUES (${randomUUID()}, ${first.business.id}, ${secondCheckout.intent.id}, ${firstCheckout.payment.id},
        ${secondCheckout.intent.amount}, 'PENDING', 'Wrong intent test', NOW())
    `).rejects.toThrow();
  });

  it('allows a rental refund without a legacy payment row', async () => {
    const student = await createStudent(first);
    const intent = await prisma.paymentIntent.create({ data: {
      userId: student.userId!, businessId: first.business.id, kind: 'RENTAL',
      amount: 4_000, currency: first.business.currency, provider: 'STRIPE',
      providerAccountReference: `acct_${randomUUID()}`, providerReference: `pi_${randomUUID()}`,
      idempotencyKey: randomUUID(),
    } });

    await expect(prisma.paymentRefund.create({ data: {
      businessId: first.business.id, paymentIntentId: intent.id, paymentId: null,
      amount: intent.amount, reason: 'Rental refund without ledger payment',
    } })).resolves.toMatchObject({ paymentId: null });
  });

  it('rejects direct audit mutation or deletion while retaining cascade teardown', async () => {
    const event = await prisma.businessAuditEvent.create({ data: {
      businessId: first.business.id, actorUserId: first.user.id, actorName: first.user.name,
      actorEmail: first.user.email, actorAccountType: 'CLUB', actorAccessKind: 'CLUB',
      actorPermissionsSnapshot: [], action: 'SETTINGS_UPDATED', resourceType: 'BUSINESS',
      resourceId: first.business.id, summary: 'Updated settings.', metadata: {},
    } });

    await expect(prisma.businessAuditEvent.update({
      where: { id: event.id }, data: { summary: 'Rewritten history.' },
    })).rejects.toThrow();
    await expect(prisma.businessAuditEvent.delete({ where: { id: event.id } })).rejects.toThrow();
    await expect(prisma.businessAuditEvent.findUniqueOrThrow({ where: { id: event.id } }))
      .resolves.toMatchObject({ summary: 'Updated settings.' });
  });
});
