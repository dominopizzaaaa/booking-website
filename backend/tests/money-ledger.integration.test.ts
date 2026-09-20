import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createPackage, createSession, createStudent, linkedInputFor,
  prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('The money ledger', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  const pay = (body: Record<string, unknown>) =>
    request(app).post('/api/payments').set('Cookie', f.cookie).send(body);
  const reverse = (id: string, reason = '') =>
    request(app).delete(`/api/payments/${id}`).set('Cookie', f.cookie).send({ reason });

  async function bookedLesson() {
    const input = await linkedInputFor(f);
    const created = await request(app).post('/api/bookings').set('Cookie', f.cookie).send(input);
    expect(created.status).toBe(201);
    const booking = created.body.bookings[0];
    return { booking, participant: booking.participants[0], studentId: booking.participants[0].studentId };
  }

  describe('a lesson paid in instalments', () => {
    // Coaches are paid in cash as often as not, and a student who is short
    // this week settles the rest next week. Neither instalment may be lost,
    // and the lesson only counts as paid once the whole price is in.
    it('accumulates instalments and marks the lesson paid only on the last one', async () => {
      const { booking, studentId } = await bookedLesson();
      const body = { studentId, bookingId: booking.id, method: 'CASH' as const };

      const first = await pay({ ...body, amount: 3_000 });
      expect(first.status).toBe(201);
      expect((await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } })).paid).toBe(false);

      const second = await pay({ ...body, amount: 4_000 });
      expect(second.status).toBe(201);
      expect((await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } })).paid).toBe(false);

      const final = await pay({ ...body, amount: 1_000 });
      expect(final.status).toBe(201);
      expect((await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } })).paid).toBe(true);
    });

    it('refuses the instalment that would take the lesson past its price', async () => {
      const { booking, studentId } = await bookedLesson();
      const body = { studentId, bookingId: booking.id, method: 'CASH' as const };
      expect((await pay({ ...body, amount: 7_999 })).status).toBe(201);

      const overpay = await pay({ ...body, amount: 2 });
      expect(overpay.status).toBe(400);
      expect(overpay.body.error).toBe('Payment exceeds this participant’s remaining balance');
      expect(await prisma.payment.count({ where: { bookingId: booking.id, reversedAt: null } })).toBe(1);

      expect((await pay({ ...body, amount: 1 })).status).toBe(201);
    });

    it('refuses a further payment once the lesson is settled', async () => {
      const { booking, studentId } = await bookedLesson();
      const body = { studentId, bookingId: booking.id, method: 'CASH' as const };
      expect((await pay({ ...body, amount: 8_000 })).status).toBe(201);
      const again = await pay({ ...body, amount: 1_000 });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('This participant is already paid');
    });

    // Reversal is a correction, so what is left must still be counted. Taking
    // back one instalment leaves the lesson unpaid but not unrecorded.
    it('returns the lesson to unpaid when an instalment is reversed and keeps the rest', async () => {
      const { booking, studentId } = await bookedLesson();
      const body = { studentId, bookingId: booking.id, method: 'CASH' as const };
      expect((await pay({ ...body, amount: 5_000 })).status).toBe(201);
      const second = await pay({ ...body, amount: 3_000 });
      expect((await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } })).paid).toBe(true);

      const reversal = await reverse(second.body.id, 'Recorded twice');
      expect(reversal.status).toBe(200);
      expect(reversal.body.payment.reversedAt).not.toBeNull();
      expect((await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } })).paid).toBe(false);

      // The reversed row stays in the ledger; only the live one still counts.
      const live = await prisma.payment.aggregate({
        where: { bookingId: booking.id, reversedAt: null }, _sum: { amount: true },
      });
      expect(live._sum.amount).toBe(5_000);
      expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(2);

      // The freed balance can be recorded again without fighting the old row.
      expect((await pay({ ...body, amount: 3_000 })).status).toBe(201);
      expect((await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } })).paid).toBe(true);
    });

    it('tells the student when a payment they were credited with is taken back', async () => {
      const account = await createAccount(f, { name: 'Alerted Student' });
      const student = await createStudent(f, { userId: account.id, name: 'Alerted Student' });
      const input = await linkedInputFor(f, { studentId: student.id });
      const created = await request(app).post('/api/bookings').set('Cookie', f.cookie).send(input);
      const booking = created.body.bookings[0];

      const payment = await pay({ studentId: student.id, bookingId: booking.id, amount: 8_000, method: 'CASH' });
      await reverse(payment.body.id, 'Wrong student');

      const alerts = await prisma.accountNotification.findMany({
        where: { userId: account.id, bookingId: booking.id }, orderBy: { createdAt: 'asc' },
      });
      expect(alerts.map(alert => alert.type))
        .toEqual(expect.arrayContaining(['PAYMENT_RECORDED', 'PAYMENT_REVERSED']));
      expect(alerts.find(alert => alert.type === 'PAYMENT_REVERSED')?.actionNeeded).toBe(true);
    });

    it('refuses a second reversal of the same payment', async () => {
      const { booking, studentId } = await bookedLesson();
      const payment = await pay({ studentId, bookingId: booking.id, amount: 8_000, method: 'CASH' });
      expect((await reverse(payment.body.id)).status).toBe(200);
      const again = await reverse(payment.body.id);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('This payment has already been reversed');
    });
  });

  describe('a package paid in instalments', () => {
    it('settles every lesson riding on the package at the moment it is paid off', async () => {
      const student = await createStudent(f);
      const pkg = await createPackage(f, student.id, { paid: false, price: 40_000, totalCredits: 5 });
      const input = await linkedInputFor(f, { studentId: student.id, packageId: pkg.id, repeatWeeks: 2 });
      const created = await request(app).post('/api/bookings').set('Cookie', f.cookie).send(input);
      expect(created.status).toBe(201);
      expect(await prisma.participant.count({ where: { packageId: pkg.id, paid: true } })).toBe(0);

      const body = { studentId: student.id, packageId: pkg.id, method: 'BANK_TRANSFER' as const };
      expect((await pay({ ...body, amount: 20_000 })).status).toBe(201);
      expect(await prisma.participant.count({ where: { packageId: pkg.id, paid: true } })).toBe(0);

      const final = await pay({ ...body, amount: 20_000 });
      expect(final.status).toBe(201);
      expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).paid).toBe(true);
      expect(await prisma.participant.count({ where: { packageId: pkg.id, paid: true } })).toBe(2);

      // Reversing the settling instalment takes the whole package, and every
      // lesson riding on it, back to unpaid together.
      expect((await reverse(final.body.id, 'Transfer bounced')).status).toBe(200);
      expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).paid).toBe(false);
      expect(await prisma.participant.count({ where: { packageId: pkg.id, paid: true } })).toBe(0);
    });

    it('refuses an instalment beyond the package price', async () => {
      const student = await createStudent(f);
      const pkg = await createPackage(f, student.id, { paid: false, price: 40_000 });
      const body = { studentId: student.id, packageId: pkg.id, method: 'CASH' as const };
      expect((await pay({ ...body, amount: 39_000 })).status).toBe(201);
      const overpay = await pay({ ...body, amount: 1_001 });
      expect(overpay.status).toBe(400);
      expect(overpay.body.error).toBe('Payment exceeds the package balance');
    });

    // A lesson taken on a package is already paid for through the package.
    // Charging it again would double-bill the student.
    it('sends a lesson taken on a package back to the package', async () => {
      const student = await createStudent(f);
      const pkg = await createPackage(f, student.id, { paid: false, price: 40_000 });
      const input = await linkedInputFor(f, { studentId: student.id, packageId: pkg.id });
      const created = await request(app).post('/api/bookings').set('Cookie', f.cookie).send(input);
      const response = await pay({
        studentId: student.id, bookingId: created.body.bookings[0].id, amount: 8_000, method: 'CASH',
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Record payment against this participant’s package instead');
    });
  });

  describe('what a club has collected and what it still owes', () => {
    it('separates money taken from students from money paid out to coaches', async () => {
      const { booking, studentId } = await bookedLesson();
      const receipt = await pay({ studentId, bookingId: booking.id, amount: 8_000, method: 'CASH' });
      expect(receipt.body.kind).toBe('STUDENT_TO_CLUB');
      expect(receipt.body.instructorId).toBeNull();
      expect(receipt.body.studentName).toBeTruthy();

      const payout = await request(app).post('/api/payouts').set('Cookie', f.cookie)
        .send({ instructorId: f.instructor.id, amount: 5_000, method: 'BANK_TRANSFER' });
      expect(payout.status).toBe(201);
      expect(payout.body).toMatchObject({ kind: 'CLUB_TO_COACH', studentId: null });
      expect(payout.body.instructorName).toBe(f.instructor.name);

      const collected = await prisma.payment.aggregate({
        where: { businessId: f.business.id, kind: { not: 'CLUB_TO_COACH' }, reversedAt: null },
        _sum: { amount: true },
      });
      const owed = await prisma.payment.aggregate({
        where: { businessId: f.business.id, kind: 'CLUB_TO_COACH', reversedAt: null },
        _sum: { amount: true },
      });
      expect(collected._sum.amount).toBe(8_000);
      expect(owed._sum.amount).toBe(5_000);
    });

    it('writes a default note naming the coach when a payout carries none', async () => {
      const payout = await request(app).post('/api/payouts').set('Cookie', f.cookie)
        .send({ instructorId: f.instructor.id, amount: 5_000, method: 'CASH' });
      expect(payout.body.note).toBe(`Coach payout · ${f.instructor.name}`);
    });

    it('refuses a payout to a coach on another club roster', async () => {
      const other = await tenants.fixture();
      const response = await request(app).post('/api/payouts').set('Cookie', f.cookie)
        .send({ instructorId: other.instructor.id, amount: 5_000, method: 'CASH' });
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Coach not found on this roster');
    });

    it('refuses an amount that is zero, negative or fractional', async () => {
      const { booking, studentId } = await bookedLesson();
      for (const amount of [0, -100, 80.5]) {
        const response = await pay({ studentId, bookingId: booking.id, amount, method: 'CASH' });
        expect(response.status, String(amount)).toBe(400);
      }
    });

    it('refuses a receipt aimed at both a booking and a package', async () => {
      const student = await createStudent(f);
      const pkg = await createPackage(f, student.id, { paid: false });
      const input = await linkedInputFor(f, { studentId: student.id });
      const created = await request(app).post('/api/bookings').set('Cookie', f.cookie).send(input);
      const response = await pay({
        studentId: student.id, bookingId: created.body.bookings[0].id, packageId: pkg.id,
        amount: 1_000, method: 'CASH',
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Record a payment against a booking or a package, not both');
    });

    // A coach inside a club is kept out of the club's books entirely: not the
    // ledger, not the payouts, and not a receipt of their own.
    it('keeps the ledger out of a club coach’s reach', async () => {
      const { booking, studentId } = await bookedLesson();
      const receipt = await request(app).post('/api/payments').set('Cookie', f.coachCookie)
        .send({ studentId, bookingId: booking.id, amount: 8_000, method: 'CASH' });
      expect(receipt.status).toBe(403);

      const payout = await request(app).post('/api/payouts').set('Cookie', f.coachCookie)
        .send({ instructorId: f.instructor.id, amount: 5_000, method: 'CASH' });
      expect(payout.status).toBe(403);

      const workspace = await request(app).get('/api/workspace').set('Cookie', f.coachCookie);
      expect(workspace.status).toBe(200);
      expect(workspace.body.payments).toEqual([]);
      expect(workspace.body.packages).toEqual([]);
      for (const scoped of workspace.body.bookings) {
        expect(scoped).not.toHaveProperty('price');
        for (const participant of scoped.participants) {
          expect(participant).not.toHaveProperty('paid');
          expect(participant).not.toHaveProperty('price');
        }
      }
    });
  });

  describe('a coach running their own practice', () => {
    it('is paid by the student directly and cannot pay itself a club payout', async () => {
      const coach = await createAccount(f, {
        name: `Solo Coach ${randomUUID()}`, accountType: 'COACH', passwordHash: 'registered-provider-account',
      });
      const { cookie } = await createSession(f, coach.id);
      const practice = await request(app).post('/api/auth/practice').set('Cookie', cookie)
        .send({ name: `Solo practice ${randomUUID()}` });
      expect(practice.status).toBe(201);
      const businessId = practice.body.business.id as string;
      tenants.own(businessId);

      const student = await prisma.student.create({
        data: {
          businessId, userId: (await createAccount(f, { name: 'Direct Student' })).id,
          name: 'Direct Student', initials: 'DS', email: `${randomUUID()}@example.test`,
        },
      });
      const receipt = await request(app).post('/api/payments').set('Cookie', cookie)
        .send({ studentId: student.id, amount: 8_000, method: 'CASH' });
      expect(receipt.status).toBe(201);
      expect(receipt.body.kind).toBe('STUDENT_TO_COACH');

      const payout = await request(app).post('/api/payouts').set('Cookie', cookie)
        .send({ instructorId: practice.body.membership.instructorId, amount: 5_000, method: 'CASH' });
      expect(payout.status).toBe(400);
      expect(payout.body.error)
        .toBe('Coach payouts apply to a club or academy. An independent coach is paid directly by their students.');
    });
  });
});
