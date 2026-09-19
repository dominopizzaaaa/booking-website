import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { createBookings } from '../src/scheduling.js';
import {
  createPackage, createStudent, linkedInputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Payment request integrity and reversal concurrency', () => {
  let tenants: TestTenants;
  let fixture: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function runQueuedBehindPaymentLock<T>(
    lockKey: string,
    actions: Array<() => PromiseLike<T>>,
  ): Promise<T[]> {
    let releaseLock!: () => void;
    let lockAcquired!: () => void;
    const acquired = new Promise<void>(resolve => { lockAcquired = resolve; });
    const release = new Promise<void>(resolve => { releaseLock = resolve; });
    const holder = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      lockAcquired();
      await release;
    }, { timeout: 30_000 });

    await Promise.race([
      acquired,
      holder.then(() => { throw new Error('Control transaction ended before acquiring its advisory lock'); }),
    ]);
    const pending = actions.map(action => Promise.resolve().then(action));
    let queueError: unknown;
    try {
      await expect.poll(async () => {
        const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
          SELECT count(*)::bigint AS waiting
          FROM pg_locks
          WHERE locktype = 'advisory' AND mode = 'ExclusiveLock'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND objsubid = 1 AND NOT granted
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${lockKey}, 0)
        `;
        return Number(rows[0]?.waiting ?? 0);
      }, { timeout: 3_000 }).toBe(actions.length);
    } catch (error) {
      queueError = error;
    } finally {
      releaseLock();
    }

    // Always drain the control transaction and every HTTP request, including
    // when the queue assertion fails, so a failed test cannot leak work into
    // tenant cleanup or the next concurrency test.
    const [holderResults, requestResults] = await Promise.all([
      Promise.allSettled([holder]),
      Promise.allSettled(pending),
    ]);
    if (queueError) throw queueError;
    const holderFailure = holderResults.find(result => result.status === 'rejected');
    if (holderFailure?.status === 'rejected') throw holderFailure.reason;
    const requestFailure = requestResults.find(result => result.status === 'rejected');
    if (requestFailure?.status === 'rejected') throw requestFailure.reason;
    return requestResults.map(result => (result as PromiseFulfilledResult<T>).value);
  }

  it('rejects unknown fields on student payments and coach payouts', async () => {
    const student = await createStudent(fixture);

    await request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
      studentId: student.id, amount: 1_000, method: 'CASH', unexpected: true,
    }).expect(400);
    await request(app).post('/api/payouts').set('Cookie', fixture.cookie).send({
      instructorId: fixture.instructor.id, amount: 1_000, method: 'BANK_TRANSFER', unexpected: true,
    }).expect(400);

    expect(await prisma.payment.count({ where: { businessId: fixture.business.id } })).toBe(0);
  });

  it('reverses a student payment exactly once under concurrent requests', async () => {
    const created = await createBookings(fixture.business.id, await linkedInputFor(fixture));
    const booking = created.bookings[0]!;
    const participant = booking.participants[0]!;
    const paymentResponse = await request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
      studentId: participant.studentId, bookingId: booking.id, amount: participant.price, method: 'CASH',
    }).expect(201);
    const paymentId = paymentResponse.body.id as string;

    const responses = await runQueuedBehindPaymentLock(`payment:${participant.studentId}`, [
      () => request(app).delete(`/api/payments/${paymentId}`).set('Cookie', fixture.cookie).send({ reason: 'First correction' }),
      () => request(app).delete(`/api/payments/${paymentId}`).set('Cookie', fixture.cookie).send({ reason: 'Second correction' }),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = responses.find(response => response.status === 200)!;
    const loser = responses.find(response => response.status === 409)!;
    expect(loser.body.error).toBe('This payment has already been reversed');

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.reversedAt).not.toBeNull();
    expect(payment.reversedByUserId).toBe(fixture.user.id);
    expect(payment.reversedReason).toBe(winner.body.payment.reversedReason);
    expect(['First correction', 'Second correction']).toContain(payment.reversedReason);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participant.id } }))
      .toMatchObject({ paid: false });
    expect(await prisma.payment.count({
      where: { bookingId: booking.id, studentId: participant.studentId, reversedAt: null },
    })).toBe(0);
    expect(await prisma.notification.count({
      where: { businessId: fixture.business.id, title: 'Payment reversed' },
    })).toBe(1);
  });

  it('reverses a coach payout exactly once under concurrent requests', async () => {
    const payoutResponse = await request(app).post('/api/payouts').set('Cookie', fixture.cookie).send({
      instructorId: fixture.instructor.id, amount: 12_500, method: 'BANK_TRANSFER',
    }).expect(201);
    const paymentId = payoutResponse.body.id as string;

    const responses = await runQueuedBehindPaymentLock(`payout:${fixture.instructor.id}`, [
      () => request(app).delete(`/api/payments/${paymentId}`).set('Cookie', fixture.cookie).send({ reason: 'Duplicate one' }),
      () => request(app).delete(`/api/payments/${paymentId}`).set('Cookie', fixture.cookie).send({ reason: 'Duplicate two' }),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = responses.find(response => response.status === 200)!;
    const loser = responses.find(response => response.status === 409)!;
    expect(loser.body.error).toBe('This payment has already been reversed');

    const payout = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payout.reversedAt).not.toBeNull();
    expect(payout.reversedByUserId).toBe(fixture.user.id);
    expect(payout.reversedReason).toBe(winner.body.payment.reversedReason);
    expect(['Duplicate one', 'Duplicate two']).toContain(payout.reversedReason);
    expect(await prisma.payment.count({
      where: { instructorId: fixture.instructor.id, kind: 'CLUB_TO_COACH', reversedAt: null },
    })).toBe(0);
    expect(await prisma.notification.count({
      where: { businessId: fixture.business.id, title: 'Coach payout reversed' },
    })).toBe(1);
  });

  it('serializes concurrent booking payments so they cannot overpay the participant', async () => {
    const created = await createBookings(fixture.business.id, await linkedInputFor(fixture));
    const booking = created.bookings[0]!;
    const participant = booking.participants[0]!;

    const responses = await runQueuedBehindPaymentLock(`payment:${participant.studentId}`, [
      () => request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
        studentId: participant.studentId, bookingId: booking.id, amount: 5_000, method: 'CASH',
      }),
      () => request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
        studentId: participant.studentId, bookingId: booking.id, amount: 5_000, method: 'BANK_TRANSFER',
      }),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([201, 400]);
    expect(responses.find(response => response.status === 400)?.body.error)
      .toBe('Payment exceeds this participant’s remaining balance');
    const ledger = await prisma.payment.findMany({
      where: { bookingId: booking.id, studentId: participant.studentId },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 5_000, reversedAt: null, kind: 'STUDENT_TO_CLUB' });
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participant.id } }))
      .toMatchObject({ paid: false });
    expect(await prisma.notification.count({
      where: { businessId: fixture.business.id, bookingId: booking.id, title: 'Payment recorded' },
    })).toBe(1);
  });

  it('serializes concurrent package payments so they cannot overpay the package', async () => {
    const student = await createStudent(fixture);
    const pkg = await createPackage(fixture, student.id, { paid: false });

    const responses = await runQueuedBehindPaymentLock(`payment:${student.id}`, [
      () => request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
        studentId: student.id, packageId: pkg.id, amount: 25_000, method: 'CASH',
      }),
      () => request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
        studentId: student.id, packageId: pkg.id, amount: 25_000, method: 'OTHER',
      }),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([201, 400]);
    expect(responses.find(response => response.status === 400)?.body.error)
      .toBe('Payment exceeds the package balance');
    const ledger = await prisma.payment.findMany({
      where: { packageId: pkg.id, studentId: student.id },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 25_000, reversedAt: null, kind: 'STUDENT_TO_CLUB' });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } }))
      .toMatchObject({ paid: false });
    expect(await prisma.notification.count({
      where: { businessId: fixture.business.id, title: 'Payment recorded' },
    })).toBe(1);
  });

  it('keeps the ledger and paid state consistent when reversal races a replacement payment', async () => {
    const created = await createBookings(fixture.business.id, await linkedInputFor(fixture));
    const booking = created.bookings[0]!;
    const participant = booking.participants[0]!;
    const originalResponse = await request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
      studentId: participant.studentId, bookingId: booking.id, amount: 4_000, method: 'CASH',
    }).expect(201);
    const originalPaymentId = originalResponse.body.id as string;

    const [reversalResponse, replacementResponse] = await runQueuedBehindPaymentLock(
      `payment:${participant.studentId}`,
      [
        () => request(app).delete(`/api/payments/${originalPaymentId}`).set('Cookie', fixture.cookie)
          .send({ reason: 'Replace the receipt' }),
        () => request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
          studentId: participant.studentId, bookingId: booking.id, amount: 4_000, method: 'BANK_TRANSFER',
        }),
      ],
    );

    expect(reversalResponse.status).toBe(200);
    expect(replacementResponse.status).toBe(201);
    const ledger = await prisma.payment.findMany({
      where: { bookingId: booking.id, studentId: participant.studentId },
      orderBy: { paidAt: 'asc' },
    });
    expect(ledger).toHaveLength(2);
    const originalPayment = ledger.find(payment => payment.id === originalPaymentId)!;
    expect(originalPayment).toMatchObject({
      amount: 4_000, reversedByUserId: fixture.user.id, reversedReason: 'Replace the receipt',
    });
    expect(originalPayment.reversedAt).not.toBeNull();
    expect(ledger.filter(payment => payment.reversedAt === null)).toEqual([
      expect.objectContaining({ id: replacementResponse.body.id, amount: 4_000 }),
    ]);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participant.id } }))
      .toMatchObject({ paid: false });
  });
});
