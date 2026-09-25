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

  async function purchasedPackage(rentalLocationId?: string) {
    const account = await createAccount(f);
    const student = await createStudent(f, { userId: account.id, name: account.name, email: account.email });
    const { cookie } = await createSession(f, account.id);
    const offer = await prisma.packageOffer.create({ data: {
      businessId: f.business.id, name: 'Online five-class pass', description: '',
      price: 40_000, totalCredits: 5, validityDays: 180,
      services: { create: { serviceId: f.service.id } },
      ...(rentalLocationId ? { rentalLocations: { create: { locationId: rentalLocationId } } } : {}),
    } });
    const checkout = await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', cookie).send({ idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED' });
    expect(checkout.status).toBe(201);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { paymentIntentId: checkout.body.paymentIntent.id },
    });
    return { account, student, cookie, packageId: checkout.body.package.id as string, payment };
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
    it('serializes package scopes from every legacy package response', async () => {
      const student = await createStudent(f);
      const created = await request(app).post('/api/packages').set('Cookie', f.cookie).send({
        studentId: student.id, name: 'Manual pass', serviceId: f.service.id, totalCredits: 5,
        price: 40_000, expiresAt: f.starts.plus({ months: 6 }).toUTC().toISO(), paid: false,
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ serviceIds: [], rentalLocationIds: [] });

      const rental = await prisma.location.create({ data: {
        businessId: f.business.id, name: 'Package rental court', type: 'FACILITY', active: true,
        rentalEnabled: true, sport: 'Tennis', rentalPrice: 2500,
      } });
      const purchased = await purchasedPackage(rental.id);
      const listed = await request(app).get('/api/packages').set('Cookie', f.cookie);
      expect(listed.status).toBe(200);
      expect(listed.body).toContainEqual(expect.objectContaining({
        id: purchased.packageId, serviceIds: [f.service.id], rentalLocationIds: [rental.id],
      }));

      const updated = await request(app).patch(`/api/packages/${purchased.packageId}`)
        .set('Cookie', f.cookie).send({ name: 'Renamed online pass' });
      expect(updated.status).toBe(409);
      expect(updated.body.error).toBe(
        'A purchased package keeps the student, name, scope, credits, price, and expiry agreed at checkout',
      );
      expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: purchased.packageId } }))
        .toMatchObject({ name: 'Online five-class pass' });
    });

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

    it('refunds an unused online package but refuses once one of its credits backs a live lesson', async () => {
      const unused = await purchasedPackage();
      const refunded = await reverse(unused.payment.id, 'Student changed their mind');
      expect(refunded.status).toBe(200);
      expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: unused.packageId } }))
        .toMatchObject({ paid: false, usedCredits: 0 });
      expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: unused.payment.paymentIntentId! } }))
        .toMatchObject({ status: 'REFUNDED' });

      const consumed = await purchasedPackage();
      await prisma.lessonPackage.update({ where: { id: consumed.packageId }, data: { usedCredits: 1 } });
      const consumedRejection = await reverse(consumed.payment.id, 'Refund after redemption');
      expect(consumedRejection.status).toBe(409);
      expect(consumedRejection.body.error).toBe('This purchased package has already been used and cannot be refunded');

      const used = await purchasedPackage();
      const booking = await request(app).post(`/api/public/${f.business.slug}/bookings`)
        .set('Cookie', used.cookie).send({
          serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
          startAt: f.starts.plus({ days: 1 }).toISO(), repeatWeeks: 1, packageId: used.packageId, notes: '',
        });
      expect(booking.status).toBe(201);
      // The live relationship is independently protective even if a damaged
      // legacy credit counter understates prior use.
      await prisma.lessonPackage.update({ where: { id: used.packageId }, data: { usedCredits: 0 } });

      const rejected = await reverse(used.payment.id, 'Refund after redemption');
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toBe('This purchased package has already been used and cannot be refunded');
      expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: used.packageId } }))
        .toMatchObject({ paid: true, usedCredits: 0 });
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: used.payment.id } }))
        .toMatchObject({ reversedAt: null });

      const rentalLocation = await prisma.location.create({ data: {
        businessId: f.business.id, name: 'Purchased pass court', type: 'FACILITY', active: true,
        rentalEnabled: true, sport: 'Tennis', rentalPrice: 2500,
      } });
      const rentalUse = await purchasedPackage(rentalLocation.id);
      const rentalUnit = await prisma.venueUnit.create({ data: {
        businessId: f.business.id, locationId: rentalLocation.id, name: 'Court 1',
      } });
      await prisma.venueReservation.create({ data: {
        businessId: f.business.id, locationId: rentalLocation.id, unitId: rentalUnit.id,
        userId: rentalUse.account.id, startAt: f.starts.plus({ days: 3 }).toJSDate(),
        endAt: f.starts.plus({ days: 3, hours: 1 }).toJSDate(), duration: 60, price: 2500,
        status: 'CONFIRMED', paymentStatus: 'PACKAGE', packageId: rentalUse.packageId, creditConsumed: true,
      } });
      const rentalRejection = await reverse(rentalUse.payment.id, 'Refund after rental booking');
      expect(rentalRejection.status).toBe(409);
      expect(rentalRejection.body.error).toBe('This purchased package has already been used and cannot be refunded');
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

    it('leaves a rental checkout for the reservation cancellation flow to refund', async () => {
      const account = await createAccount(f);
      const student = await createStudent(f, { userId: account.id, name: account.name, email: account.email });
      const { reservation, intent, payment } = await prisma.$transaction(async tx => {
        const unit = await tx.venueUnit.create({ data: {
          businessId: f.business.id, locationId: f.location.id, name: 'Court 1',
        } });
        const reservation = await tx.venueReservation.create({ data: {
          businessId: f.business.id, locationId: f.location.id, unitId: unit.id,
          userId: account.id, startAt: f.starts.plus({ days: 2 }).toJSDate(),
          endAt: f.starts.plus({ days: 2, hours: 1 }).toJSDate(), duration: 60, price: 2500,
          status: 'CONFIRMED', paymentStatus: 'PAID',
        } });
        const intent = await tx.paymentIntent.create({ data: {
          userId: account.id, businessId: f.business.id, kind: 'RENTAL', reservationId: reservation.id,
          amount: 2500, currency: f.business.currency, status: 'SUCCEEDED',
          providerReference: `sim_pi_${randomUUID()}`, idempotencyKey: randomUUID(), confirmedAt: new Date(),
        } });
        const payment = await tx.payment.create({ data: {
          businessId: f.business.id, studentId: student.id, paymentIntentId: intent.id,
          amount: 2500, kind: 'STUDENT_TO_CLUB', method: 'SIMULATED_STRIPE',
        } });
        return { reservation, intent, payment };
      });

      const rejected = await reverse(payment.id, 'Wrong time');
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toBe('Cancel the rental reservation to refund this payment');
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).toMatchObject({ reversedAt: null });
      expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).toMatchObject({ status: 'SUCCEEDED' });
      expect(await prisma.venueReservation.findUniqueOrThrow({ where: { id: reservation.id } }))
        .toMatchObject({ status: 'CONFIRMED', paymentStatus: 'PAID' });
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

  describe('a retained historical solo practice', () => {
    it('keeps direct receipts auditable but cannot make new ledger writes', async () => {
      const coach = await createAccount(f, {
        name: `Solo Coach ${randomUUID()}`, accountType: 'COACH', passwordHash: 'registered-provider-account',
      });
      const historical = await prisma.$transaction(async tx => {
        const business = await tx.business.create({
          data: {
            name: 'Historical Solo Practice', slug: `historical-solo-${randomUUID()}`,
            ownerName: coach.name, email: coach.email, kind: 'SOLO', legacyReadOnly: true,
          },
        });
        const instructor = await tx.instructor.create({
          data: { businessId: business.id, name: coach.name, initials: 'SC', email: coach.email },
        });
        const membership = await tx.membership.create({
          data: { businessId: business.id, userId: coach.id, instructorId: instructor.id },
        });
        return { business, instructor, membership };
      });
      tenants.own(historical.business.id);

      const student = await prisma.student.create({
        data: {
          businessId: historical.business.id, userId: (await createAccount(f, { name: 'Direct Student' })).id,
          name: 'Direct Student', initials: 'DS', email: `${randomUUID()}@example.test`,
        },
      });
      const receipt = await prisma.$transaction(async tx => {
        // Model a receipt retained from before SOLO practices became read-only.
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        return tx.payment.create({
          data: {
            businessId: historical.business.id, studentId: student.id, amount: 8_000,
            method: 'CASH', kind: 'STUDENT_TO_COACH',
          },
        });
      });
      expect(receipt.kind).toBe('STUDENT_TO_COACH');

      await expect(prisma.payment.create({
        data: {
          businessId: historical.business.id, studentId: student.id,
          amount: 5_000, method: 'CASH', kind: 'STUDENT_TO_COACH',
        },
      })).rejects.toThrow('Payment cannot create new commercial records for a SOLO or read-only business');

      const { cookie } = await createSession(f, coach.id, historical.membership.id);
      await request(app).post('/api/payments').set('Cookie', cookie)
        .send({ studentId: student.id, amount: 1_000, method: 'CASH' }).expect(403);
      expect(await prisma.payment.count({ where: { businessId: historical.business.id } })).toBe(1);
    });
  });
});
