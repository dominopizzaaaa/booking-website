import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { createBookings } from '../src/scheduling.js';
import {
  createAccount, createPackage, createSession, createStudent, inputFor, prisma, publicInputFor, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Package offers and simulated checkout', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function studentSeat() {
    const account = await createAccount(club);
    const student = await createStudent(club, { userId: account.id, name: account.name, email: account.email });
    const session = await createSession(club, account.id);
    return { account, student, ...session };
  }

  function createOffer(overrides: Record<string, unknown> = {}) {
    return request(app).post('/api/package-offers').set('Cookie', club.cookie).send({
      name: 'Six lesson pass', description: 'A flexible club pass', price: 42_000,
      totalCredits: 6, validityDays: 120, serviceIds: [club.service.id], rentalLocationIds: [],
      ...overrides,
    });
  }

  it('keeps offer CRUD club-only, strict, tenant-scoped, and archives purchased history', async () => {
    const created = await createOffer();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      businessId: club.business.id, name: 'Six lesson pass', price: 42_000, totalCredits: 6,
      active: true, serviceIds: [club.service.id], rentalLocationIds: [],
      services: [{ id: club.service.id, name: club.service.name }],
    });

    await request(app).post('/api/package-offers').set('Cookie', club.coachCookie)
      .send({ name: 'Coach pass', price: 1000, totalCredits: 1, validityDays: 30, serviceIds: [club.service.id], rentalLocationIds: [] })
      .expect(403);
    await request(app).patch(`/api/package-offers/${created.body.id}`).set('Cookie', club.cookie)
      .send({ active: false, unexpected: true }).expect(400);

    const other = await tenants.fixture();
    await request(app).patch(`/api/package-offers/${created.body.id}`).set('Cookie', other.cookie)
      .send({ name: 'Stolen offer' }).expect(404);

    const removed = await request(app).delete(`/api/package-offers/${created.body.id}`).set('Cookie', club.cookie).send({}).expect(200);
    expect(removed.body).toEqual({ deleted: true, archived: false });
    expect(await prisma.packageOffer.findUnique({ where: { id: created.body.id } })).toBeNull();
  });

  it('derives a club coach booking identity and terms from the authenticated affiliation', async () => {
    const student = await createStudent(club);
    const otherInstructor = await prisma.instructor.create({
      data: { businessId: club.business.id, name: 'Other Coach', initials: 'OC' },
    });
    const mismatch = await request(app).post('/api/bookings').set('Cookie', club.coachCookie).send(inputFor(club, {
      studentId: student.id, student: undefined, instructorId: otherInstructor.id,
    })).expect(403);
    expect(mismatch.body.error).toBe('Coaches can only create lessons on their own schedule');
    expect(await prisma.booking.count({ where: { businessId: club.business.id } })).toBe(0);

    const { instructorId: _clientInstructorId, ...coachInput } = inputFor(club, {
      studentId: student.id, student: undefined,
    });
    const own = await request(app).post('/api/bookings').set('Cookie', club.coachCookie).send(coachInput).expect(201);
    expect(own.body.bookings[0]).toMatchObject({
      instructorId: club.coachMembership.instructorId,
      paymentRoute: 'CLUB',
      createdByRole: 'COACH',
      coachAcceptance: 'NOT_REQUIRED',
      status: 'CONFIRMED',
    });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: own.body.bookings[0].id } })).toMatchObject({
      businessId: club.business.id,
      instructorId: club.coachMembership.instructorId,
      createdByUserId: club.coachUser.id,
      paymentRoute: 'CLUB',
      createdByRole: 'COACH',
      coachAcceptance: 'NOT_REQUIRED',
      status: 'CONFIRMED',
    });

    const groupService = await prisma.service.create({ data: {
      businessId: club.business.id, name: 'Crafted group clinic', type: 'GROUP', capacity: 4, noticeHours: 0,
      locations: { create: {
        locationId: club.location.id, price: 5000, duration: 60,
        instructors: { create: { instructorId: club.instructor.id } },
      } },
    } });
    const groupAttempt = await request(app).post('/api/bookings').set('Cookie', club.coachCookie).send({
      ...coachInput, serviceId: groupService.id, startAt: club.starts.plus({ days: 1 }).toISO(),
    }).expect(403);
    expect(groupAttempt.body.error).toBe('Coaches can only create private lessons');
    expect(await prisma.booking.count({ where: { businessId: club.business.id, serviceId: groupService.id } })).toBe(0);
  });

  it('validates offer scopes against active same-tenant services and rentable facilities', async () => {
    const other = await tenants.fixture();
    await createOffer({ serviceIds: [other.service.id] }).expect(400);
    await createOffer({ serviceIds: [], rentalLocationIds: [] }).expect(400);

    const rental = await prisma.location.create({ data: {
      businessId: club.business.id, name: 'Bookable court', type: 'FACILITY', active: true,
      rentalEnabled: true, sport: 'Tennis', rentalPrice: 2500,
    } });
    const created = await createOffer({ serviceIds: [], rentalLocationIds: [rental.id] }).expect(201);
    expect(created.body).toMatchObject({
      serviceIds: [], rentalLocationIds: [rental.id], rentalLocations: [{ id: rental.id, name: rental.name }],
    });
  });

  it('lists active offers and atomically snapshots a successful purchase', async () => {
    const offer = await createOffer().then(response => response.body);
    const seat = await studentSeat();
    const listing = await request(app).get('/api/account/package-offers')
      .set('Cookie', seat.cookie).query({ businessSlug: club.business.slug }).expect(200);
    expect(listing.body).toMatchObject({
      business: { name: club.business.name, slug: club.business.slug, currency: club.business.currency },
      offers: [{ id: offer.id, active: true }],
    });

    const checkout = await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: `package-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED' }).expect(201);
    expect(checkout.body).toMatchObject({
      paymentIntent: { kind: 'PACKAGE', status: 'SUCCEEDED', amount: 42_000, currency: 'SGD' },
      package: { offerId: offer.id, name: 'Six lesson pass', totalCredits: 6, usedCredits: 0, remainingCredits: 6, paid: true, state: 'ACTIVE', serviceIds: [club.service.id] },
      participant: null,
    });
    const packageId = checkout.body.package.id as string;
    const intentId = checkout.body.paymentIntent.id as string;
    expect(await prisma.payment.findUniqueOrThrow({ where: { paymentIntentId: intentId } })).toMatchObject({
      businessId: club.business.id, studentId: seat.student.id, packageId, amount: 42_000,
      method: 'SIMULATED_STRIPE', kind: 'STUDENT_TO_CLUB', reversedAt: null,
    });
    expect(await prisma.lessonPackageService.findMany({ where: { packageId } }))
      .toEqual([expect.objectContaining({ businessId: club.business.id, serviceId: club.service.id })]);
    expect(await prisma.notification.count({ where: { businessId: club.business.id, type: 'PAYMENT' } })).toBe(1);
    expect(await prisma.accountNotification.count({ where: { userId: seat.account.id, type: 'PAYMENT_RECORDED' } })).toBe(1);

    const packages = await request(app).get('/api/account/packages').set('Cookie', seat.cookie).expect(200);
    expect(packages.body.packages).toEqual([expect.objectContaining({ id: packageId, remainingCredits: 6, state: 'ACTIVE' })]);
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: packageId } }))
      .toMatchObject({ scopeSnapshotSealed: true });
    const otherStudent = await createStudent(club);
    for (const change of [
      { studentId: otherStudent.id },
      { name: 'Rewritten pass' },
      { serviceId: club.service.id },
      { totalCredits: 60 },
      { price: 41_000 },
      { expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() },
    ]) {
      const response = await request(app).patch(`/api/packages/${packageId}`)
        .set('Cookie', club.cookie).send(change).expect(409);
      expect(response.body.error).toBe('A purchased package keeps the student, name, scope, credits, price, and expiry agreed at checkout');
    }
    const workspace = await request(app).get('/api/workspace').set('Cookie', club.cookie).expect(200);
    expect(workspace.body.packages).toContainEqual(expect.objectContaining({
      id: packageId, offerId: offer.id, serviceId: null,
      serviceIds: [club.service.id], rentalLocationIds: [],
    }));

    const deleted = await request(app).delete(`/api/package-offers/${offer.id}`).set('Cookie', club.cookie).send({}).expect(200);
    expect(deleted.body).toEqual({ deleted: false, archived: true });
    expect(await prisma.packageOffer.findUniqueOrThrow({ where: { id: offer.id } })).toMatchObject({ active: false });
  });

  it('keeps the sold price fixed while allowing other package offer edits', async () => {
    const offer = await createOffer().then(response => response.body);
    const seat = await studentSeat();
    await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({
        idempotencyKey: `sold-price-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED',
      }).expect(201);

    const priceChange = await request(app).patch(`/api/package-offers/${offer.id}`)
      .set('Cookie', club.cookie).send({ price: 43_000 }).expect(409);
    expect(priceChange.body.error).toBe('The price of a package offer cannot change after its first sale');

    const copyChange = await request(app).patch(`/api/package-offers/${offer.id}`)
      .set('Cookie', club.cookie).send({ description: 'Updated copy for future customers', validityDays: 180 })
      .expect(200);
    expect(copyChange.body).toMatchObject({
      price: 42_000, description: 'Updated copy for future customers', validityDays: 180,
    });
  });

  it('preserves the business currency after successful and refunded checkouts while allowing a no-op', async () => {
    const offer = await createOffer().then(response => response.body);
    const seat = await studentSeat();
    const checkout = await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({
        idempotencyKey: `currency-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED',
      }).expect(201);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { paymentIntentId: checkout.body.paymentIntent.id },
    });

    const unchanged = await request(app).patch('/api/business').set('Cookie', club.cookie)
      .send({ currency: 'sgd' }).expect(200);
    expect(unchanged.body.currency).toBe('SGD');

    const succeededChange = await request(app).patch('/api/business').set('Cookie', club.cookie)
      .send({ currency: 'USD' }).expect(409);
    expect(succeededChange.body.error)
      .toBe('Currency cannot change after a checkout has succeeded or been refunded');
    expect(await prisma.business.findUniqueOrThrow({ where: { id: club.business.id } }))
      .toMatchObject({ currency: 'SGD' });
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: checkout.body.paymentIntent.id } }))
      .toMatchObject({ status: 'SUCCEEDED', currency: 'SGD' });

    await request(app).delete(`/api/payments/${payment.id}`).set('Cookie', club.cookie)
      .send({ reason: 'Customer requested a refund' }).expect(200);
    expect(await prisma.paymentIntent.findUniqueOrThrow({ where: { id: checkout.body.paymentIntent.id } }))
      .toMatchObject({ status: 'REFUNDED', currency: 'SGD' });

    const refundedChange = await request(app).patch('/api/business').set('Cookie', club.cookie)
      .send({ currency: 'USD' }).expect(409);
    expect(refundedChange.body.error)
      .toBe('Currency cannot change after a checkout has succeeded or been refunded');
    expect(await prisma.business.findUniqueOrThrow({ where: { id: club.business.id } }))
      .toMatchObject({ currency: 'SGD' });
  });

  it('replays a refunded package checkout as the original successful request', async () => {
    const offer = await createOffer().then(response => response.body);
    const seat = await studentSeat();
    const key = `refunded-package-${randomUUID()}`;
    const checkout = await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: key, simulatedOutcome: 'SUCCEEDED' }).expect(201);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { paymentIntentId: checkout.body.paymentIntent.id },
    });

    await request(app).delete(`/api/payments/${payment.id}`).set('Cookie', club.cookie)
      .send({ reason: 'Package no longer needed' }).expect(200);

    const replay = await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: key, simulatedOutcome: 'SUCCEEDED' }).expect(200);
    expect(replay.body).toMatchObject({
      paymentIntent: { id: checkout.body.paymentIntent.id, kind: 'PACKAGE', status: 'REFUNDED' },
      package: { id: checkout.body.package.id, paid: false, state: 'UNPAID' },
      participant: null,
    });
    await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: key, simulatedOutcome: 'FAILED' }).expect(409);
    expect(await prisma.paymentIntent.count({ where: { userId: seat.account.id, idempotencyKey: key } })).toBe(1);
    expect(await prisma.lessonPackage.count({ where: { id: checkout.body.package.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { paymentIntentId: checkout.body.paymentIntent.id } })).toBe(1);
  });

  it('persists failed attempts only and makes exact retries idempotent while rejecting tampering', async () => {
    const firstOffer = await createOffer().then(response => response.body);
    const secondOffer = await createOffer({ name: 'Second pass' }).then(response => response.body);
    const seat = await studentSeat();
    const key = `failure-${randomUUID()}`;
    const body = { idempotencyKey: key, simulatedOutcome: 'FAILED' as const };
    const failed = await request(app).post(`/api/account/package-offers/${firstOffer.id}/checkout`)
      .set('Cookie', seat.cookie).send(body).expect(201);
    expect(failed.body).toMatchObject({ paymentIntent: { kind: 'PACKAGE', status: 'FAILED' }, package: null, participant: null });
    expect(await prisma.lessonPackage.count({ where: { offerId: firstOffer.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { businessId: club.business.id } })).toBe(0);

    const replay = await request(app).post(`/api/account/package-offers/${firstOffer.id}/checkout`)
      .set('Cookie', seat.cookie).send(body).expect(200);
    expect(replay.body.paymentIntent.id).toBe(failed.body.paymentIntent.id);
    await request(app).post(`/api/account/package-offers/${firstOffer.id}/checkout`).set('Cookie', seat.cookie)
      .send({ ...body, simulatedOutcome: 'SUCCEEDED' }).expect(409);
    await request(app).post(`/api/account/package-offers/${secondOffer.id}/checkout`).set('Cookie', seat.cookie)
      .send(body).expect(409);
    expect(await prisma.paymentIntent.count({ where: { userId: seat.account.id } })).toBe(1);
  });

  it('enforces immutable purchased service scope while keeping legacy packages compatible', async () => {
    const seat = await studentSeat();
    const otherLocation = await prisma.location.create({ data: { businessId: club.business.id, name: 'Second court' } });
    const otherService = await prisma.service.create({ data: {
      businessId: club.business.id, name: 'Other lesson', noticeHours: 0,
      locations: { create: {
        locationId: otherLocation.id, price: 9000, duration: 60,
        instructors: { create: { instructorId: club.instructor.id } },
      } },
    } });
    await prisma.availability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId: club.business.id, instructorId: club.instructor.id, locationId: otherLocation.id,
      dayOfWeek, startTime: '08:00', endTime: '20:00',
    })) });
    const offer = await createOffer().then(response => response.body);
    const checkout = await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: `scope-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED' }).expect(201);
    const packageId = checkout.body.package.id as string;
    await expect(prisma.lessonPackageService.create({ data: {
      packageId, businessId: club.business.id, serviceId: otherService.id,
    } })).rejects.toThrow(/scope snapshot is immutable/u);
    await expect(prisma.lessonPackageService.delete({
      where: { packageId_serviceId: { packageId, serviceId: club.service.id } },
    })).rejects.toThrow(/scope snapshot is immutable/u);
    await expect(createBookings(club.business.id, inputFor(club, {
      studentId: seat.student.id, student: undefined, packageId, serviceId: otherService.id, locationId: otherLocation.id,
      startAt: club.starts.plus({ days: 1 }).toISO()!,
    }))).rejects.toMatchObject({ status: 400, message: 'Package does not cover this service' });
    await createBookings(club.business.id, inputFor(club, {
      studentId: seat.student.id, student: undefined, packageId,
    }));
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: packageId } })).toMatchObject({ usedCredits: 1 });

    const legacy = await createPackage(club, seat.student.id, { serviceId: null, paid: false });
    await createBookings(club.business.id, inputFor(club, {
      studentId: seat.student.id, student: undefined, packageId: legacy.id, serviceId: otherService.id,
      locationId: otherLocation.id, startAt: club.starts.plus({ days: 2 }).toISO()!,
    }));
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ usedCredits: 1, paid: false });
  });

  it('spends one purchased group-service credit when the student joins through the public booking path', async () => {
    await prisma.service.update({ where: { id: club.service.id }, data: { type: 'GROUP', capacity: 4 } });
    const otherGroup = await prisma.service.create({ data: {
      businessId: club.business.id, name: 'Other group clinic', type: 'GROUP', capacity: 4, noticeHours: 0,
      locations: { create: {
        locationId: club.location.id, price: 6000, duration: 60,
        instructors: { create: { instructorId: club.instructor.id } },
      } },
    } });
    const offer = await createOffer().then(response => response.body);
    const seat = await studentSeat();
    const checkout = await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({
        idempotencyKey: `group-package-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED',
      }).expect(201);
    const packageId = checkout.body.package.id as string;

    const wrongScope = await request(app).post(`/api/public/${club.business.slug}/bookings`)
      .set('Cookie', seat.cookie).send(publicInputFor(club, {
        serviceId: otherGroup.id, packageId, startAt: club.starts.plus({ days: 1 }).toISO()!,
      })).expect(400);
    expect(wrongScope.body.error).toBe('Package does not cover this service');
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: packageId } }))
      .toMatchObject({ usedCredits: 0 });

    const starter = await createAccount(club, { name: 'Group Starter' });
    const starterSession = await createSession(club, starter.id);
    const created = await request(app).post(`/api/public/${club.business.slug}/bookings`)
      .set('Cookie', starterSession.cookie).send(publicInputFor(club)).expect(201);
    const joined = await request(app).post(`/api/public/${club.business.slug}/bookings`)
      .set('Cookie', seat.cookie).send(publicInputFor(club, { packageId })).expect(201);

    expect(joined.body.bookings[0]).toMatchObject({
      id: created.body.bookings[0].id, type: 'GROUP', paymentRoute: 'CLUB',
      participants: [{ studentId: seat.student.id, packageId, paid: true }],
    });
    expect(await prisma.booking.findUniqueOrThrow({
      where: { id: created.body.bookings[0].id }, include: { participants: true },
    })).toMatchObject({
      paymentRoute: 'CLUB',
      participants: expect.arrayContaining([
        expect.objectContaining({ studentId: seat.student.id, packageId, creditConsumed: true, paid: true }),
      ]),
    });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: packageId } }))
      .toMatchObject({ usedCredits: 1 });
    expect(await prisma.participant.count({ where: { packageId, creditConsumed: true } })).toBe(1);
  });

  it('checks booking ownership, charges the remaining amount, replays safely, and derives club payment kind', async () => {
    const seat = await studentSeat();
    const created = await createBookings(club.business.id, inputFor(club, {
      studentId: seat.student.id, student: undefined,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    await prisma.payment.create({ data: {
      businessId: club.business.id, studentId: seat.student.id, bookingId: created.bookings[0]!.id,
      amount: 3000, kind: 'STUDENT_TO_CLUB', method: 'CASH',
    } });
    const key = `booking-${randomUUID()}`;
    const paid = await request(app).post(`/api/account/bookings/${participantId}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: key, simulatedOutcome: 'SUCCEEDED' }).expect(201);
    expect(paid.body).toMatchObject({
      paymentIntent: { kind: 'BOOKING', status: 'SUCCEEDED', amount: 5000 },
      package: null, participant: { id: participantId, bookingId: created.bookings[0]!.id, paid: true },
    });
    expect(await prisma.payment.findUniqueOrThrow({ where: { paymentIntentId: paid.body.paymentIntent.id } }))
      .toMatchObject({ amount: 5000, method: 'SIMULATED_STRIPE', kind: 'STUDENT_TO_CLUB' });

    const replay = await request(app).post(`/api/account/bookings/${participantId}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: key, simulatedOutcome: 'SUCCEEDED' }).expect(200);
    expect(replay.body.paymentIntent.id).toBe(paid.body.paymentIntent.id);
    await request(app).post(`/api/account/bookings/${participantId}/checkout`).set('Cookie', seat.cookie)
      .send({ idempotencyKey: key, simulatedOutcome: 'FAILED' }).expect(409);
    await request(app).post(`/api/account/bookings/${participantId}/checkout`).set('Cookie', seat.cookie)
      .send({ idempotencyKey: `already-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED' }).expect(409);

    const stranger = await createAccount(club);
    const strangerSession = await createSession(club, stranger.id);
    await request(app).post(`/api/account/bookings/${participantId}/checkout`).set('Cookie', strangerSession.cookie)
      .send({ idempotencyKey: `cross-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED' }).expect(404);
  });

  it('replays a refunded booking checkout as the original successful request', async () => {
    const seat = await studentSeat();
    const created = await createBookings(club.business.id, inputFor(club, {
      studentId: seat.student.id, student: undefined, startAt: club.starts.plus({ days: 2 }).toISO()!,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    const key = `refunded-booking-${randomUUID()}`;
    const checkout = await request(app).post(`/api/account/bookings/${participantId}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: key, simulatedOutcome: 'SUCCEEDED' }).expect(201);
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { paymentIntentId: checkout.body.paymentIntent.id },
    });

    await request(app).delete(`/api/payments/${payment.id}`).set('Cookie', club.cookie)
      .send({ reason: 'Booking payment refunded' }).expect(200);

    const replay = await request(app).post(`/api/account/bookings/${participantId}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: key, simulatedOutcome: 'SUCCEEDED' }).expect(200);
    expect(replay.body).toMatchObject({
      paymentIntent: { id: checkout.body.paymentIntent.id, kind: 'BOOKING', status: 'REFUNDED' },
      package: null,
      participant: { id: participantId, bookingId: created.bookings[0]!.id, paid: false },
    });
    await request(app).post(`/api/account/bookings/${participantId}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: key, simulatedOutcome: 'FAILED' }).expect(409);
    expect(await prisma.paymentIntent.count({ where: { userId: seat.account.id, idempotencyKey: key } })).toBe(1);
    expect(await prisma.payment.count({ where: { paymentIntentId: checkout.body.paymentIntent.id } })).toBe(1);
  });

  it('records failed booking checkout without a payment or paid mutation', async () => {
    const seat = await studentSeat();
    const created = await createBookings(club.business.id, inputFor(club, {
      studentId: seat.student.id, student: undefined, startAt: club.starts.plus({ days: 3 }).toISO()!,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    const failed = await request(app).post(`/api/account/bookings/${participantId}/checkout`)
      .set('Cookie', seat.cookie).send({ idempotencyKey: `booking-fail-${randomUUID()}`, simulatedOutcome: 'FAILED' }).expect(201);
    expect(failed.body).toMatchObject({ paymentIntent: { kind: 'BOOKING', status: 'FAILED', amount: 8000 } });
    expect(await prisma.payment.count({ where: { bookingId: created.bookings[0]!.id } })).toBe(0);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participantId } })).toMatchObject({ paid: false });
  });

  it('refuses package and booking checkout for demo tenants', async () => {
    const seat = await studentSeat();
    const offer = await createOffer().then(response => response.body);
    const created = await createBookings(club.business.id, inputFor(club, {
      studentId: seat.student.id, student: undefined, startAt: club.starts.plus({ days: 5 }).toISO()!,
    }));
    const participantId = created.bookings[0]!.participants[0]!.id;
    await prisma.business.update({ where: { id: club.business.id }, data: { isDemo: true } });

    await request(app).post(`/api/account/package-offers/${offer.id}/checkout`)
      .set('Cookie', seat.cookie).send({
        idempotencyKey: `demo-package-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED',
      }).expect(404);
    const bookingCheckout = await request(app).post(`/api/account/bookings/${participantId}/checkout`)
      .set('Cookie', seat.cookie).send({
        idempotencyKey: `demo-booking-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED',
      }).expect(409);
    expect(bookingCheckout.body.error).toBe('This historical booking is read-only and cannot receive a new payment');

    expect(await prisma.paymentIntent.count({ where: { businessId: club.business.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { businessId: club.business.id } })).toBe(0);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participantId } }))
      .toMatchObject({ paid: false });
  });
});
