import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  createAccount, createSession, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

const configBody = {
  sport: 'Badminton', rules: 'Non-marking shoes only.', amenities: ['Showers', 'Racket hire'],
  unitLabel: 'Court', price: 2_400, startInterval: 30, minDuration: 60, durationIncrement: 30,
  maxDuration: 120, noticeHours: 0, advanceDays: 60, cancellationHours: 24,
  units: [{ name: 'Court 1' }, { name: 'Court 2' }],
  openingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, startTime: '08:00', endTime: '20:00' })),
};

const locationBody = {
  name: 'Atomic Training Ground', address: '1 Rally Road', type: 'FACILITY' as const, color: '#78915e',
  requiresApproval: false, travelMinutes: 10, notes: 'Bring non-marking shoes.', source: 'MANUAL' as const,
  placeId: '', mapsUrl: '', latitude: null, longitude: null, active: true,
};

describe.sequential('venue rentals', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function account(accountType: 'STUDENT' | 'COACH' | 'CLUB' = 'STUDENT') {
    const user = await createAccount(club, {
      name: `${accountType} renter`, email: `${randomUUID()}@example.test`, accountType,
    });
    return { user, ...(await createSession(club, user.id)) };
  }

  async function configure(fixture = club, overrides: Record<string, unknown> = {}) {
    return request(app).post('/api/rentals').set('Cookie', fixture.cookie)
      .send({ locationId: fixture.location.id, ...configBody, ...overrides }).expect(201);
  }

  function compositeBody(
    mode: 'CREATE' | 'UPDATE',
    overrides: { location?: Record<string, unknown>; rental?: Record<string, unknown> } = {},
  ) {
    return {
      mode, location: { ...locationBody, ...overrides.location },
      rental: { enabled: true, ...configBody, ...overrides.rental },
    };
  }

  function futureStart(days = 7, hour = 10) {
    return DateTime.now().setZone('Asia/Singapore').plus({ days }).startOf('day').set({ hour });
  }

  it('keeps manager configuration club-only, tenant-bound, strict and within the agreed numeric contract', async () => {
    const student = await account();
    await request(app).post('/api/rentals').set('Cookie', student.cookie)
      .send({ locationId: club.location.id, ...configBody }).expect(403);
    await request(app).post('/api/rentals').set('Cookie', club.coachCookie)
      .send({ locationId: club.location.id, ...configBody }).expect(403);

    const other = await tenants.fixture();
    await request(app).post('/api/rentals').set('Cookie', club.cookie)
      .send({ locationId: other.location.id, ...configBody }).expect(404);
    await request(app).post('/api/rentals').set('Cookie', club.cookie)
      .send({ locationId: club.location.id, ...configBody, extra: true }).expect(400);
    await request(app).post('/api/rentals').set('Cookie', club.cookie)
      .send({ locationId: club.location.id, ...configBody, startInterval: 20 }).expect(400);
    await request(app).post('/api/rentals').set('Cookie', club.cookie)
      .send({ locationId: club.location.id, ...configBody, minDuration: 45 }).expect(400);
    await request(app).post('/api/rentals').set('Cookie', club.cookie)
      .send({ locationId: club.location.id, ...configBody, price: 100_000_000, maxDuration: 1440 }).expect(400);
    await request(app).patch(`/api/rentals/${club.location.id}`).set('Cookie', club.cookie)
      .send({ price: 1_000 }).expect(409);

    const created = await configure(club, { price: 0 });
    expect(created.body.rental).toMatchObject({
      id: club.location.id, locationId: club.location.id, enabled: true, price: 0, sport: 'Badminton',
      amenities: ['Showers', 'Racket hire'], club: { name: club.business.name, slug: club.business.slug },
    });
    expect(created.body.rental).not.toHaveProperty('businessId');
    expect(created.body.rental).not.toHaveProperty('email');

    const unitId = created.body.rental.units[0].id as string;
    const updated = await request(app).patch(`/api/rentals/${club.location.id}`).set('Cookie', club.cookie).send({
      price: 3_000, units: [{ id: unitId, name: 'Show Court' }, { name: 'Match Court' }],
    }).expect(200);
    expect(updated.body.rental.units.filter((unit: { active: boolean }) => unit.active)
      .map((unit: { name: string }) => unit.name)).toEqual(['Show Court', 'Match Court']);
    expect(updated.body.rental.units).toContainEqual(expect.objectContaining({ name: 'Court 2', active: false }));
    const disabled = await request(app).delete(`/api/rentals/${club.location.id}`).set('Cookie', club.cookie).send({}).expect(200);
    expect(disabled.body).toEqual({ ok: true });
    const managerView = await request(app).get(`/api/rentals/${club.location.id}`).set('Cookie', club.cookie).expect(200);
    expect(managerView.body.rental.enabled).toBe(false);
    await request(app).get(`/api/rentals/${club.location.id}`).set('Cookie', student.cookie).expect(404);
  });

  it('atomically creates a rental location and replays the same client save key without duplicates', async () => {
    const locationId = `rental_loc_${randomUUID().replaceAll('-', '')}`;
    const body = compositeBody('CREATE');
    const student = await account();
    await request(app).put(`/api/rental-locations/${locationId}`).set('Cookie', student.cookie).send(body).expect(403);
    await request(app).put(`/api/rental-locations/${locationId}`).set('Cookie', club.coachCookie).send(body).expect(403);
    const first = await request(app).put(`/api/rental-locations/${locationId}`)
      .set('Cookie', club.cookie).send(body).expect(201);
    const replay = await request(app).put(`/api/rental-locations/${locationId}`)
      .set('Cookie', club.cookie).send(body).expect(200);

    expect(first.body).toMatchObject({ location: { id: locationId, name: locationBody.name }, replay: false });
    expect(replay.body).toMatchObject({ location: { id: locationId }, rental: { enabled: true }, replay: true });
    expect(await prisma.location.count({ where: { id: locationId, businessId: club.business.id } })).toBe(1);
    expect(await prisma.venueUnit.count({ where: { locationId } })).toBe(2);
    expect(await prisma.venueOpeningHour.count({ where: { locationId } })).toBe(7);

    await request(app).put(`/api/rental-locations/${locationId}`).set('Cookie', club.cookie)
      .send(compositeBody('CREATE', { location: { name: 'Conflicting replay' } })).expect(409);
    const otherClub = await tenants.fixture();
    await request(app).put(`/api/rental-locations/${locationId}`).set('Cookie', otherClub.cookie)
      .send(body).expect(409);
  });

  it('rolls back location and inventory changes when rental or core location validation fails', async () => {
    const original = await prisma.location.findUniqueOrThrow({ where: { id: club.location.id } });
    const failedCreateId = `rental_loc_${randomUUID().replaceAll('-', '')}`;
    await request(app).put(`/api/rental-locations/${failedCreateId}`).set('Cookie', club.cookie)
      .send(compositeBody('CREATE', { rental: { minDuration: 45, durationIncrement: 30 } })).expect(400);
    expect(await prisma.location.findUnique({ where: { id: failedCreateId } })).toBeNull();

    const invalidLocationId = `rental_loc_${randomUUID().replaceAll('-', '')}`;
    await request(app).put(`/api/rental-locations/${invalidLocationId}`).set('Cookie', club.cookie)
      .send(compositeBody('CREATE', { location: { name: '' } })).expect(400);
    expect(await prisma.location.findUnique({ where: { id: invalidLocationId } })).toBeNull();

    await request(app).put(`/api/rental-locations/${club.location.id}`).set('Cookie', club.cookie)
      .send(compositeBody('UPDATE', {
        location: { name: 'Must roll back' },
        rental: { minDuration: 45, durationIncrement: 30 },
      })).expect(400);
    expect(await prisma.location.findUniqueOrThrow({ where: { id: club.location.id } })).toMatchObject({
      name: original.name, rentalEnabled: false,
    });
    expect(await prisma.venueUnit.count({ where: { locationId: club.location.id } })).toBe(0);

    await request(app).put(`/api/rental-locations/${club.location.id}`).set('Cookie', club.cookie)
      .send(compositeBody('UPDATE', { location: { name: '' } })).expect(400);
    expect(await prisma.location.findUniqueOrThrow({ where: { id: club.location.id } })).toMatchObject({
      name: original.name, rentalEnabled: false,
    });
  });

  it('updates core and rental fields together, and type-change plus disable succeeds together', async () => {
    await request(app).put(`/api/rental-locations/${club.location.id}`).set('Cookie', club.cookie)
      .send(compositeBody('UPDATE')).expect(200);
    const updated = await request(app).put(`/api/rental-locations/${club.location.id}`).set('Cookie', club.cookie)
      .send(compositeBody('UPDATE', {
        location: { name: 'Renamed Atomic Ground', address: '2 Rally Road' },
        rental: { price: 3_750, units: [{ name: 'Show Court' }, { name: 'Match Court' }] },
      })).expect(200);
    expect(updated.body).toMatchObject({
      location: { name: 'Renamed Atomic Ground', address: '2 Rally Road' },
      rental: { enabled: true, price: 3_750 },
    });
    expect(updated.body.rental.units.filter((unit: { active: boolean }) => unit.active)).toHaveLength(2);

    const disabled = await request(app).put(`/api/rental-locations/${club.location.id}`)
      .set('Cookie', club.cookie).send({
        mode: 'UPDATE', location: { ...locationBody, name: 'Online fallback', type: 'ONLINE' }, rental: { enabled: false },
      }).expect(200);
    expect(disabled.body).toMatchObject({ location: { type: 'ONLINE' }, rental: { enabled: false } });
  });

  it('rolls the whole save back when an active package offer prevents rental disable', async () => {
    await request(app).put(`/api/rental-locations/${club.location.id}`).set('Cookie', club.cookie)
      .send(compositeBody('UPDATE')).expect(200);
    await prisma.packageOffer.create({ data: {
      businessId: club.business.id, name: 'Rental pass', description: '', price: 8_000, totalCredits: 4,
      validityDays: 30, active: true, rentalLocations: { create: { locationId: club.location.id } },
    } });

    await request(app).put(`/api/rental-locations/${club.location.id}`).set('Cookie', club.cookie).send({
      mode: 'UPDATE', location: { ...locationBody, name: 'Must not persist', type: 'RENTED' },
      rental: { enabled: false },
    }).expect(409);
    const retained = await prisma.location.findUniqueOrThrow({ where: { id: club.location.id } });
    expect(retained).toMatchObject({ name: locationBody.name, type: 'FACILITY', rentalEnabled: true });
    expect(await prisma.venueUnit.count({ where: { locationId: club.location.id, active: true } })).toBe(2);
  });

  it('confirms a free rental without a ledger row and rejects meaningless failure or package payment paths', async () => {
    const configured = await configure(club, { price: 0 });
    const student = await account();
    const base = {
      unitId: configured.body.rental.units[0].id, startAt: futureStart().toUTC().toISO(), duration: 60,
      idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
    };
    const free = await request(app).post(`/api/rentals/${club.location.id}/reservations`)
      .set('Cookie', student.cookie).send(base).expect(201);
    expect(free.body).toMatchObject({
      reservation: { price: 0, paymentStatus: 'PAID' }, paymentIntent: { amount: 0, status: 'SUCCEEDED' },
    });
    expect(await prisma.payment.count({ where: { paymentIntentId: free.body.paymentIntent.id } })).toBe(0);
    await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', student.cookie).send({
      ...base, startAt: futureStart(8).toUTC().toISO(), idempotencyKey: randomUUID(), simulatedOutcome: 'FAILED',
    }).expect(400);
    await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', student.cookie).send({
      ...base, startAt: futureStart(9).toUTC().toISO(), idempotencyKey: randomUUID(), packageId: 'unused-package',
    }).expect(400);
  });

  it('filters private inventory and returns public-safe directory and details to every signed-in role', async () => {
    await configure();
    const hidden = await tenants.fixture();
    await configure(hidden);
    await prisma.business.update({ where: { id: hidden.business.id }, data: { isDemo: true } });
    const unrelated = await tenants.fixture();
    const student = await account('STUDENT');
    const coach = await account('COACH');

    await request(app).get('/api/rentals').expect(401);
    for (const cookie of [student.cookie, coach.cookie, club.cookie]) {
      const response = await request(app).get('/api/rentals').query({ query: 'Test Court', sport: 'badminton' })
        .set('Cookie', cookie).expect(200);
      expect(response.body.rentals.some((rental: { id: string }) => rental.id === club.location.id)).toBe(true);
      expect(response.body.rentals.some((rental: { id: string }) => rental.id === hidden.location.id)).toBe(false);
      expect(response.body.rentals.some((rental: { id: string }) => rental.id === unrelated.location.id)).toBe(false);
      await request(app).get(`/api/rentals/${club.location.id}`).set('Cookie', cookie).expect(200);
    }
    await request(app).get('/api/rentals').query({ unexpected: 'no' }).set('Cookie', student.cookie).expect(400);
    await request(app).get(`/api/rentals/${hidden.location.id}`).set('Cookie', student.cookie).expect(404);
  });

  it('generates timezone-aware unit slots and applies duration, interval, notice, advance, and half-open occupancy rules', async () => {
    const configured = await configure();
    const student = await account();
    const start = futureStart();
    const unit = configured.body.rental.units[0];
    await prisma.venueReservation.create({ data: {
      businessId: club.business.id, locationId: club.location.id, unitId: unit.id, userId: student.user.id,
      startAt: start.toJSDate(), endAt: start.plus({ minutes: 60 }).toJSDate(), duration: 60, price: 2_400,
      status: 'PENDING', paymentStatus: 'UNPAID',
    } });
    const slots = await request(app).get(`/api/rentals/${club.location.id}/slots`)
      .query({ date: start.toISODate(), duration: 60 }).set('Cookie', student.cookie).expect(200);
    expect(slots.body.timezone).toBe('Asia/Singapore');
    expect(slots.body.slots).not.toContainEqual(expect.objectContaining({ unitId: unit.id, startAt: start.toUTC().toISO() }));
    expect(slots.body.slots).toContainEqual(expect.objectContaining({ unitId: unit.id, startAt: start.plus({ minutes: 60 }).toUTC().toISO() }));
    expect(slots.body.slots[0].price).toBe(2_400);
    await request(app).get(`/api/rentals/${club.location.id}/slots`)
      .query({ date: start.toISODate(), duration: 75 }).set('Cookie', student.cookie).expect(400);
    const tooFar = futureStart(61);
    const empty = await request(app).get(`/api/rentals/${club.location.id}/slots`)
      .query({ date: tooFar.toISODate(), duration: 60 }).set('Cookie', student.cookie).expect(200);
    expect(empty.body.slots).toEqual([]);
  });

  it('aligns hourly rental starts to wall-clock :00 even when opening begins at :15', async () => {
    const day = futureStart(7, 7);
    const dayOfWeek = day.weekday % 7;
    const configured = await configure(club, {
      startInterval: 60,
      openingHours: [{ dayOfWeek, startTime: '07:15', endTime: '11:15' }],
    });
    const student = await account();
    const slots = await request(app).get(`/api/rentals/${club.location.id}/slots`)
      .query({ date: day.toISODate(), duration: 60 }).set('Cookie', student.cookie).expect(200);
    const starts = slots.body.slots
      .filter((slot: { unitId: string }) => slot.unitId === configured.body.rental.units[0].id)
      .map((slot: { startAt: string }) => DateTime.fromISO(slot.startAt).setZone('Asia/Singapore').toFormat('HH:mm'));
    expect(starts).toEqual(['08:00', '09:00', '10:00']);

    await request(app).post(`/api/rentals/${club.location.id}/reservations`)
      .set('Cookie', student.cookie).send({
        unitId: configured.body.rental.units[0].id,
        startAt: day.set({ minute: 15 }).toUTC().toISO(), duration: 60,
        idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
      }).expect(409);
  });

  it('creates idempotent simulated payments, maps concurrent overlaps to one 409, and omits legacy payments for non-students', async () => {
    const configured = await configure();
    const student = await account('STUDENT');
    const coach = await account('COACH');
    const unitId = configured.body.rental.units[0].id as string;
    const start = futureStart().toUTC().toISO()!;
    const body = { unitId, startAt: start, duration: 60, idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED' };
    const paid = await request(app).post(`/api/rentals/${club.location.id}/reservations`)
      .set('Cookie', student.cookie).send(body).expect(201);
    const replay = await request(app).post(`/api/rentals/${club.location.id}/reservations`)
      .set('Cookie', student.cookie).send(body).expect(200);
    expect(replay.body.paymentIntent.id).toBe(paid.body.paymentIntent.id);
    expect(replay.body.reservation.id).toBe(paid.body.reservation.id);
    expect(await prisma.payment.count({ where: { paymentIntentId: paid.body.paymentIntent.id } })).toBe(1);

    const raceStart = futureStart(8).toUTC().toISO()!;
    const [first, second] = await Promise.all([
      request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', student.cookie)
        .send({ ...body, startAt: raceStart, idempotencyKey: randomUUID() }),
      request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', student.cookie)
        .send({ ...body, startAt: raceStart, idempotencyKey: randomUUID() }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const winner = first.status === 201 ? first : second;
    expect(winner.body.reservation).toMatchObject({ paymentStatus: 'PAID', price: 2_400 });
    expect(await prisma.payment.count({ where: { paymentIntentId: winner.body.paymentIntent.id } })).toBe(1);

    const failed = await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', coach.cookie).send({
      unitId, startAt: futureStart(9).toUTC().toISO(), duration: 60, idempotencyKey: randomUUID(), simulatedOutcome: 'FAILED',
    }).expect(201);
    expect(failed.body).toMatchObject({ reservation: null, paymentIntent: { status: 'FAILED' } });
    expect(await prisma.venueReservation.count({ where: { userId: coach.user.id } })).toBe(0);

    const coachPaid = await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', coach.cookie).send({
      unitId, startAt: futureStart(10).toUTC().toISO(), duration: 60, idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
    }).expect(201);
    expect(coachPaid.body.paymentIntent.status).toBe('SUCCEEDED');
    expect(await prisma.payment.count({ where: { paymentIntentId: coachPaid.body.paymentIntent.id } })).toBe(0);
    const clubPaid = await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', club.cookie).send({
      unitId, startAt: futureStart(11).toUTC().toISO(), duration: 60, idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
    }).expect(201);
    expect(clubPaid.body.paymentIntent.status).toBe('SUCCEEDED');
    expect(await prisma.payment.count({ where: { paymentIntentId: clubPaid.body.paymentIntent.id } })).toBe(0);
  });

  it('redeems only a student-owned rental entitlement and restores exactly one credit on cancellation', async () => {
    const configured = await configure();
    const student = await account();
    const profile = await prisma.student.create({ data: {
      businessId: club.business.id, userId: student.user.id, name: student.user.name, email: student.user.email, initials: 'SR',
    } });
    const pkg = await prisma.lessonPackage.create({ data: {
      businessId: club.business.id, studentId: profile.id, name: 'Court pack', totalCredits: 3, usedCredits: 0,
      price: 6_000, paid: true, expiresAt: futureStart(90).toJSDate(),
      rentalLocations: { create: { locationId: club.location.id } },
    } });
    const result = await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', student.cookie).send({
      unitId: configured.body.rental.units[0].id, startAt: futureStart().toUTC().toISO(), duration: 60,
      packageId: pkg.id, idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
    }).expect(201);
    expect(result.body).toMatchObject({
      reservation: { paymentStatus: 'PACKAGE', packageId: pkg.id, creditConsumed: true },
      paymentIntent: { status: 'SUCCEEDED', amount: 0 },
    });
    expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).usedCredits).toBe(1);
    expect(await prisma.payment.count({ where: { paymentIntentId: result.body.paymentIntent.id } })).toBe(0);

    const cancelled = await request(app).post(`/api/rentals/reservations/${result.body.reservation.id}/cancel`)
      .set('Cookie', student.cookie).send({}).expect(200);
    expect(cancelled.body.reservation).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', creditConsumed: false });
    expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).usedCredits).toBe(0);
    await request(app).post(`/api/rentals/reservations/${result.body.reservation.id}/cancel`)
      .set('Cookie', student.cookie).send({}).expect(409);
    expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).usedCredits).toBe(0);
  });

  it('keeps an offer-backed rental package contract immutable after checkout and use', async () => {
    const configured = await configure();
    const student = await account();
    const offer = await request(app).post('/api/package-offers').set('Cookie', club.cookie).send({
      name: 'Four court visits', description: 'Use on the club courts', price: 8_000,
      totalCredits: 4, validityDays: 90, serviceIds: [], rentalLocationIds: [club.location.id],
    }).expect(201);
    const checkout = await request(app).post(`/api/account/package-offers/${offer.body.id}/checkout`)
      .set('Cookie', student.cookie).send({
        idempotencyKey: `rental-package-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED',
      }).expect(201);
    const packageId = checkout.body.package.id as string;
    const startAt = futureStart().toUTC().toISO();
    await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', student.cookie).send({
      unitId: configured.body.rental.units[0].id, startAt, duration: 60, packageId,
      idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
    }).expect(201);

    for (const change of [
      { name: 'Reduced rental pass' },
      { totalCredits: 1 },
      { expiresAt: futureStart(1).toUTC().toISO() },
    ]) {
      const response = await request(app).patch(`/api/packages/${packageId}`)
        .set('Cookie', club.cookie).send(change).expect(409);
      expect(response.body.error).toBe(
        'A purchased package keeps the student, name, scope, credits, price, and expiry agreed at checkout',
      );
    }
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: packageId } })).toMatchObject({
      name: 'Four court visits', totalCredits: 4, usedCredits: 1,
    });
  });

  it('rejects another student package and a package scoped to another rental location', async () => {
    const configured = await configure();
    const renter = await account();
    const owner = await account();
    const ownerProfile = await prisma.student.create({ data: {
      businessId: club.business.id, userId: owner.user.id, name: owner.user.name, email: owner.user.email, initials: 'OP',
    } });
    const otherLocation = await prisma.location.create({ data: {
      businessId: club.business.id, name: 'Other rental', type: 'FACILITY', active: true, rentalEnabled: true, sport: 'Tennis',
    } });
    const wrongOwner = await prisma.lessonPackage.create({ data: {
      businessId: club.business.id, studentId: ownerProfile.id, name: 'Owner pass', totalCredits: 1, price: 1_000,
      paid: true, expiresAt: futureStart(90).toJSDate(),
      rentalLocations: { create: { locationId: club.location.id } },
    } });
    const renterProfile = await prisma.student.create({ data: {
      businessId: club.business.id, userId: renter.user.id, name: renter.user.name, email: renter.user.email, initials: 'RP',
    } });
    const wrongScope = await prisma.lessonPackage.create({ data: {
      businessId: club.business.id, studentId: renterProfile.id, name: 'Other court pass', totalCredits: 1, price: 1_000,
      paid: true, expiresAt: futureStart(90).toJSDate(),
      rentalLocations: { create: { locationId: otherLocation.id } },
    } });
    const base = {
      unitId: configured.body.rental.units[0].id, startAt: futureStart().toUTC().toISO(), duration: 60,
      idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
    };
    await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', renter.cookie)
      .send({ ...base, packageId: wrongOwner.id }).expect(404);
    await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', renter.cookie)
      .send({ ...base, idempotencyKey: randomUUID(), packageId: wrongScope.id }).expect(409);
    expect(await prisma.venueReservation.count({ where: { userId: renter.user.id } })).toBe(0);
    expect(await prisma.lessonPackage.findMany({ where: { id: { in: [wrongOwner.id, wrongScope.id] } }, select: { usedCredits: true } }))
      .toEqual([{ usedCredits: 0 }, { usedCredits: 0 }]);
  });

  it('lists only the authenticated renter reservations and reverses a paid student ledger row on cancellation', async () => {
    const configured = await configure();
    const student = await account();
    const other = await account();
    const paid = await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', student.cookie).send({
      unitId: configured.body.rental.units[0].id, startAt: futureStart().toUTC().toISO(), duration: 60,
      idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
    }).expect(201);
    const mine = await request(app).get('/api/rentals/reservations/mine').set('Cookie', student.cookie).expect(200);
    expect(mine.body.reservations.map((reservation: { id: string }) => reservation.id)).toContain(paid.body.reservation.id);
    expect(mine.body.reservations[0].businessName).toBe(club.business.name);
    const originalUnitName = paid.body.reservation.unitName as string;
    await request(app).patch(`/api/rentals/${club.location.id}`).set('Cookie', club.cookie).send({
      cancellationHours: 8760, units: configured.body.rental.units.map((unit: { id: string; name: string }, index: number) => ({
        id: unit.id, name: index === 0 ? 'Renamed after booking' : unit.name,
      })),
    }).expect(200);
    const snapshotted = await request(app).get('/api/rentals/reservations/mine').set('Cookie', student.cookie).expect(200);
    expect(snapshotted.body.reservations[0]).toMatchObject({
      unitName: originalUnitName, cancellationDeadline: paid.body.reservation.cancellationDeadline, cancellable: true,
    });
    const hidden = await request(app).get('/api/rentals/reservations/mine').set('Cookie', other.cookie).expect(200);
    expect(hidden.body.reservations).toEqual([]);
    await request(app).post(`/api/rentals/reservations/${paid.body.reservation.id}/cancel`)
      .set('Cookie', other.cookie).send({}).expect(404);
    await request(app).post(`/api/rentals/reservations/${paid.body.reservation.id}/cancel`)
      .set('Cookie', student.cookie).send({}).expect(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { paymentIntentId: paid.body.paymentIntent.id } });
    expect(payment.reversedAt).not.toBeNull();
  });
});
