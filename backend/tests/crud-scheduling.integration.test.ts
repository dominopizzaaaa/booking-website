import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createSession, createStudent, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('CRUD and schedule routes', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  async function rosterCoach(fixture: Fixture, name = `Roster Coach ${randomUUID()}`) {
    const account = await createAccount(fixture, {
      name, email: `${randomUUID()}@example.test`, accountType: 'COACH',
      passwordHash: 'registered-provider-account',
    });
    const instructor = await prisma.instructor.create({
      data: {
        businessId: fixture.business.id, name: account.name, initials: 'RC', email: account.email,
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: account.id, businessId: fixture.business.id, instructorId: instructor.id },
    });
    const session = await createSession(fixture, account.id, membership.id);
    return { account, instructor, membership, session };
  }

  const packageInput = (studentId: string, overrides: Record<string, unknown> = {}) => ({
    studentId, name: 'Six lesson pass', serviceId: f.service.id, totalCredits: 6, price: 42_000,
    expiresAt: f.starts.plus({ months: 6 }).toISO(), paid: false, ...overrides,
  });

  it('replaces service mappings while preserving booking snapshots and distinguishes archive from deletion', async () => {
    const other = await tenants.fixture();

    await request(app).post('/api/services').set('Cookie', f.cookie).send({
      name: 'Strict service',
      locations: [{
        locationId: f.location.id, price: 9_500, duration: 45,
        instructorIds: [f.instructor.id], unexpected: true,
      }],
    }).expect(400);
    await request(app).post('/api/services').set('Cookie', f.cookie).send({
      name: 'Foreign court service',
      locations: [{ locationId: other.location.id, price: 9_500, duration: 45, instructorIds: [f.instructor.id] }],
    }).expect(400);
    await request(app).post('/api/services').set('Cookie', f.coachCookie)
      .send({ name: 'Coach cannot edit catalogue' }).expect(403);

    const created = await request(app).post('/api/services').set('Cookie', f.cookie).send({
      name: 'Mapped private lesson', type: 'PRIVATE', capacity: 12, duration: 45, price: 9_500,
      locations: [{ locationId: f.location.id, price: 9_500, duration: 45, instructorIds: [f.instructor.id] }],
    }).expect(201);
    expect(created.body).toMatchObject({
      name: 'Mapped private lesson', type: 'PRIVATE', capacity: 1,
      locations: [{ locationId: f.location.id, price: 9_500, duration: 45, instructorIds: [f.instructor.id] }],
    });

    const coachCatalogue = await request(app).get('/api/services').set('Cookie', f.coachCookie).expect(200);
    const coachView = coachCatalogue.body.find((service: { id: string }) => service.id === created.body.id);
    expect(coachView).toMatchObject({
      id: created.body.id, locations: [{ locationId: f.location.id, duration: 45, instructorIds: [f.instructor.id] }],
    });
    expect(coachView).not.toHaveProperty('price');
    expect(coachView.locations[0]).not.toHaveProperty('price');

    const student = await createStudent(f, { name: 'Snapshot Student' });
    const bookingResponse = await request(app).post('/api/bookings').set('Cookie', f.cookie).send({
      serviceId: created.body.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.toISO(), studentId: student.id,
    }).expect(201);
    const bookingId = bookingResponse.body.bookings[0].id as string;
    expect(bookingResponse.body.bookings[0]).toMatchObject({
      type: 'PRIVATE', capacity: 1, price: 9_500,
    });

    const updated = await request(app).patch(`/api/services/${created.body.id}`).set('Cookie', f.cookie).send({
      type: 'GROUP', capacity: 6, price: 20_000, duration: 90,
      locations: [{ locationId: f.location.id, price: 12_500, duration: 75, instructorIds: [f.instructor.id] }],
    }).expect(200);
    expect(updated.body).toMatchObject({
      type: 'GROUP', capacity: 6, price: 20_000, duration: 90,
      locations: [{ locationId: f.location.id, price: 12_500, duration: 75, instructorIds: [f.instructor.id] }],
    });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({
      type: 'PRIVATE', capacity: 1, price: 9_500, duration: 45,
    });

    await request(app).patch(`/api/services/${other.service.id}`).set('Cookie', f.cookie)
      .send({ name: 'Cross-tenant overwrite' }).expect(404);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: other.service.id } })).name).toBe(other.service.name);

    const archived = await request(app).delete(`/api/services/${created.body.id}`)
      .set('Cookie', f.cookie).expect(200);
    expect(archived.body).toEqual({ ok: true, deactivated: true });
    expect(await prisma.service.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({ active: false });

    const disposable = await request(app).post('/api/services').set('Cookie', f.cookie)
      .send({ name: 'Disposable service', locations: [] }).expect(201);
    const removed = await request(app).delete(`/api/services/${disposable.body.id}`)
      .set('Cookie', f.cookie).expect(200);
    expect(removed.body).toEqual({ ok: true, deactivated: false });
    expect(await prisma.service.findUnique({ where: { id: disposable.body.id } })).toBeNull();
  });

  it('lets a club coach add a venue but keeps venue management tenant-scoped', async () => {
    const other = await tenants.fixture();
    const before = await prisma.location.count({ where: { businessId: f.business.id } });
    await request(app).post('/api/locations').set('Cookie', f.coachCookie)
      .send({ name: 'Bad venue', unexpected: true }).expect(400);
    expect(await prisma.location.count({ where: { businessId: f.business.id } })).toBe(before);

    const created = await request(app).post('/api/locations').set('Cookie', f.coachCookie).send({
      name: 'Coach found court', address: '15 Stadium Road', type: 'RENTED',
      source: 'GOOGLE_MAPS', placeId: 'court-place-id',
      mapsUrl: 'https://www.google.com/maps/place/Coach+Found+Court',
      latitude: 1.3045, longitude: 103.8745,
    }).expect(201);
    expect(created.body).toMatchObject({
      name: 'Coach found court', type: 'RENTED', source: 'GOOGLE_MAPS', active: true,
    });

    await request(app).patch(`/api/locations/${created.body.id}`).set('Cookie', f.coachCookie)
      .send({ name: 'Coach overwrite' }).expect(403);
    await request(app).delete(`/api/locations/${created.body.id}`).set('Cookie', f.coachCookie).expect(403);
    await request(app).patch(`/api/locations/${created.body.id}`).set('Cookie', other.cookie)
      .send({ name: 'Foreign overwrite' }).expect(404);

    const updated = await request(app).patch(`/api/locations/${created.body.id}`).set('Cookie', f.cookie)
      .send({ name: 'Club approved court', travelMinutes: 35 }).expect(200);
    expect(updated.body).toMatchObject({ name: 'Club approved court', travelMinutes: 35 });
    const removed = await request(app).delete(`/api/locations/${created.body.id}`)
      .set('Cookie', f.cookie).expect(200);
    expect(removed.body).toEqual({ ok: true, deactivated: false });
    expect(await prisma.location.findUnique({ where: { id: created.body.id } })).toBeNull();

    const archived = await request(app).delete(`/api/locations/${f.location.id}`)
      .set('Cookie', f.cookie).expect(200);
    expect(archived.body).toEqual({ ok: true, deactivated: true });
    expect(await prisma.location.findUniqueOrThrow({ where: { id: f.location.id } })).toMatchObject({ active: false });
    const listed = await request(app).get('/api/locations').set('Cookie', f.cookie).expect(200);
    expect(listed.body).toContainEqual(expect.objectContaining({ id: f.location.id, active: false }));
  });

  it('connects canonical student accounts, scopes coach visibility, and protects student history', async () => {
    const other = await tenants.fixture();
    const account = await createAccount(f, {
      name: 'Canonical Student', email: `${randomUUID()}@example.test`,
      phone: '+65 6123 4567', parentName: 'Canonical Parent',
    });
    await request(app).post('/api/students').set('Cookie', f.cookie).send({
      email: account.email, name: 'Manager supplied identity',
    }).expect(400);
    await request(app).post('/api/students').set('Cookie', f.coachCookie)
      .send({ email: account.email }).expect(403);

    const connected = await request(app).post('/api/students').set('Cookie', f.cookie).send({
      email: account.email.toUpperCase(), notes: 'Club context',
    }).expect(201);
    expect(connected.body).toMatchObject({
      userId: account.id, name: account.name, email: account.email, phone: account.phone,
      parentName: account.parentName, notes: 'Club context',
    });
    await request(app).post('/api/students').set('Cookie', f.cookie)
      .send({ email: account.email }).expect(409);
    await request(app).patch(`/api/students/${connected.body.id}`).set('Cookie', f.cookie)
      .send({ name: 'Manager rename', notes: 'Should not write' }).expect(400);
    const noted = await request(app).patch(`/api/students/${connected.body.id}`).set('Cookie', f.cookie)
      .send({ notes: 'Updated club context' }).expect(200);
    expect(noted.body).toMatchObject({ name: account.name, email: account.email, notes: 'Updated club context' });

    await request(app).patch(`/api/students/${connected.body.id}`).set('Cookie', other.cookie)
      .send({ notes: 'Foreign note' }).expect(404);
    const otherList = await request(app).get('/api/students').set('Cookie', other.cookie).expect(200);
    expect(otherList.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: connected.body.id })]));

    const hiddenAccount = await createAccount(f, { name: 'No Booking Student' });
    const hidden = await request(app).post('/api/students').set('Cookie', f.cookie)
      .send({ email: hiddenAccount.email }).expect(201);
    expect((await request(app).get('/api/students').set('Cookie', f.coachCookie).expect(200)).body).toEqual([]);

    await request(app).post('/api/bookings').set('Cookie', f.cookie).send({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.toISO(), studentId: connected.body.id,
    }).expect(201);
    const coachStudents = await request(app).get('/api/students').set('Cookie', f.coachCookie).expect(200);
    expect(coachStudents.body).toEqual([expect.objectContaining({
      id: connected.body.id, bookingCount: 1, lastBookingAt: f.starts.toUTC().toISO(),
    })]);
    expect(JSON.stringify(coachStudents.body)).not.toContain(hidden.body.id);

    await request(app).delete(`/api/students/${connected.body.id}`).set('Cookie', f.cookie).expect(409);
    await request(app).delete(`/api/students/${hidden.body.id}`).set('Cookie', f.cookie).expect(200);
    expect(await prisma.student.findUnique({ where: { id: hidden.body.id } })).toBeNull();
  });

  it('validates package ownership and freezes transfers, prices, expiry, and deletion once history exists', async () => {
    const other = await tenants.fixture();
    const student = await createStudent(f, { name: 'Package Student' });
    const secondStudent = await createStudent(f, { name: 'Second Package Student' });

    await request(app).post('/api/packages').set('Cookie', f.cookie)
      .send(packageInput(student.id, { usedCredits: 1 })).expect(400);
    await request(app).post('/api/packages').set('Cookie', f.cookie)
      .send(packageInput(other.user.id)).expect(404);
    await request(app).post('/api/packages').set('Cookie', f.cookie)
      .send(packageInput(student.id, { serviceId: other.service.id })).expect(404);
    await request(app).get('/api/packages').set('Cookie', f.coachCookie).expect(403);

    const disposable = await request(app).post('/api/packages').set('Cookie', f.cookie)
      .send(packageInput(student.id, { name: 'Disposable pass', totalCredits: 2 })).expect(201);
    const renamed = await request(app).patch(`/api/packages/${disposable.body.id}`).set('Cookie', f.cookie)
      .send({ name: 'Renamed pass', price: 12_000 }).expect(200);
    expect(renamed.body).toMatchObject({ name: 'Renamed pass', price: 12_000, usedCredits: 0 });
    await request(app).patch(`/api/packages/${disposable.body.id}`).set('Cookie', other.cookie)
      .send({ name: 'Foreign rename' }).expect(404);
    await request(app).delete(`/api/packages/${disposable.body.id}`).set('Cookie', f.cookie).expect(200);

    const paid = await request(app).post('/api/packages').set('Cookie', f.cookie)
      .send(packageInput(student.id, { name: 'Paid pass', paid: true })).expect(201);
    expect(await prisma.payment.findFirstOrThrow({ where: { packageId: paid.body.id } })).toMatchObject({
      businessId: f.business.id, studentId: student.id, amount: 42_000, kind: 'STUDENT_TO_CLUB',
    });
    await request(app).patch(`/api/packages/${paid.body.id}`).set('Cookie', f.cookie)
      .send({ price: 43_000 }).expect(409);
    await request(app).patch(`/api/packages/${paid.body.id}`).set('Cookie', f.cookie)
      .send({ paid: false }).expect(400);
    await request(app).delete(`/api/packages/${paid.body.id}`).set('Cookie', f.cookie).expect(409);

    const used = await request(app).post('/api/packages').set('Cookie', f.cookie)
      .send(packageInput(student.id, { name: 'Used pass' })).expect(201);
    await request(app).post('/api/bookings').set('Cookie', f.cookie).send({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.toISO(), repeatWeeks: 2, studentId: student.id, packageId: used.body.id,
    }).expect(201);
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: used.body.id } })).toMatchObject({ usedCredits: 2 });

    await request(app).patch(`/api/packages/${used.body.id}`).set('Cookie', f.cookie)
      .send({ studentId: secondStudent.id }).expect(409);
    await request(app).patch(`/api/packages/${used.body.id}`).set('Cookie', f.cookie)
      .send({ serviceId: null }).expect(409);
    await request(app).patch(`/api/packages/${used.body.id}`).set('Cookie', f.cookie)
      .send({ totalCredits: 1 }).expect(400);
    await request(app).patch(`/api/packages/${used.body.id}`).set('Cookie', f.cookie)
      .send({ expiresAt: f.starts.plus({ days: 1 }).toISO() }).expect(409);
    await request(app).delete(`/api/packages/${used.body.id}`).set('Cookie', f.cookie).expect(409);
    await request(app).delete(`/api/packages/${used.body.id}`).set('Cookie', other.cookie).expect(404);
  });

  it('upserts exact availability windows, rejects same-venue overlap, and scopes schedules to the coach', async () => {
    const otherTenant = await tenants.fixture();
    const otherCoach = await rosterCoach(f, 'Second Schedule Coach');
    const dayOfWeek = f.starts.weekday % 7;
    await prisma.availability.deleteMany({
      where: { businessId: f.business.id, instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek },
    });

    await request(app).get('/api/availability').set('Cookie', f.coachCookie)
      .query({ unexpected: 'query' }).expect(400);
    await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '09:00', endTime: '12:00', unexpected: true,
    }).expect(400);
    await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '12:00', endTime: '12:00',
    }).expect(400);

    const window = await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '09:00', endTime: '12:00',
    }).expect(201);
    const upserted = await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '09:00', endTime: '12:30',
    }).expect(201);
    expect(upserted.body).toMatchObject({ id: window.body.id, startTime: '09:00', endTime: '12:30' });
    expect(await prisma.availability.count({ where: {
      businessId: f.business.id, instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek, startTime: '09:00',
    } })).toBe(1);

    await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '10:00', endTime: '11:00',
    }).expect(409);
    const adjacent = await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '12:30', endTime: '13:30',
    }).expect(201);

    const secondLocation = await request(app).post('/api/locations').set('Cookie', f.coachCookie)
      .send({ name: 'Alternate court' }).expect(201);
    await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, locationId: secondLocation.body.id, dayOfWeek,
      startTime: '10:00', endTime: '11:00',
    }).expect(201);

    await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: otherCoach.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '09:00', endTime: '10:00',
    }).expect(403);
    await request(app).get('/api/availability').set('Cookie', f.coachCookie)
      .query({ instructorId: otherCoach.instructor.id }).expect(403);
    await request(app).post('/api/availability').set('Cookie', f.cookie).send({
      instructorId: otherCoach.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '09:00', endTime: '10:00',
    }).expect(201);
    const ownSchedule = await request(app).get('/api/availability').set('Cookie', f.coachCookie).expect(200);
    expect(ownSchedule.body.every((entry: { instructorId: string }) => entry.instructorId === f.instructor.id)).toBe(true);
    expect(JSON.stringify(ownSchedule.body)).not.toContain(otherCoach.instructor.id);

    await request(app).post('/api/availability').set('Cookie', f.cookie).send({
      instructorId: f.instructor.id, locationId: otherTenant.location.id, dayOfWeek,
      startTime: '14:00', endTime: '15:00',
    }).expect(404);
    await request(app).delete(`/api/availability/${window.body.id}`).set('Cookie', otherTenant.cookie).expect(404);
    await request(app).delete(`/api/availability/${adjacent.body.id}`).set('Cookie', f.coachCookie).expect(200);
  });

  it('upserts blocked dates and makes generated slots unavailable until the block is removed', async () => {
    const otherCoach = await rosterCoach(f, 'Blocked Date Coach');
    const dayOfWeek = f.starts.weekday % 7;
    const date = f.starts.toISODate()!;
    await prisma.availability.deleteMany({
      where: { businessId: f.business.id, instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek },
    });
    const availability = await request(app).post('/api/availability').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek,
      startTime: '09:00', endTime: '12:00',
    }).expect(201);
    const slotQuery = {
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id, date,
    };
    const open = await request(app).get(`/api/public/${f.business.slug}/slots`).query(slotQuery).expect(200);
    expect(open.body.slots).not.toHaveLength(0);
    expect(open.body.slots.some((slot: { available: boolean }) => slot.available)).toBe(true);

    await request(app).post('/api/exceptions').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, date: '2026-02-30', reason: 'Impossible date',
    }).expect(400);
    await request(app).post('/api/exceptions').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, date, reason: 'Away', unexpected: true,
    }).expect(400);
    const blocked = await request(app).post('/api/exceptions').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, date, reason: 'Away',
    }).expect(201);
    const revised = await request(app).post('/api/exceptions').set('Cookie', f.coachCookie).send({
      instructorId: f.instructor.id, date, reason: 'Tournament travel',
    }).expect(201);
    expect(revised.body).toMatchObject({ id: blocked.body.id, reason: 'Tournament travel' });
    expect(await prisma.availabilityException.count({ where: { instructorId: f.instructor.id, date } })).toBe(1);

    const closed = await request(app).get(`/api/public/${f.business.slug}/slots`).query(slotQuery).expect(200);
    expect(closed.body.slots).toHaveLength(open.body.slots.length);
    expect(closed.body.slots.every((slot: { available: boolean; reason?: string }) =>
      !slot.available && slot.reason === 'Coach is unavailable on this date')).toBe(true);

    const otherBlock = await request(app).post('/api/exceptions').set('Cookie', f.cookie).send({
      instructorId: otherCoach.instructor.id, date, reason: 'Other coach away',
    }).expect(201);
    await request(app).get('/api/exceptions').set('Cookie', f.coachCookie)
      .query({ instructorId: otherCoach.instructor.id }).expect(403);
    await request(app).delete(`/api/exceptions/${otherBlock.body.id}`).set('Cookie', f.coachCookie).expect(403);
    expect(await prisma.availabilityException.findUnique({ where: { id: otherBlock.body.id } })).not.toBeNull();

    await request(app).delete(`/api/exceptions/${blocked.body.id}`).set('Cookie', f.coachCookie).expect(200);
    const reopened = await request(app).get(`/api/public/${f.business.slug}/slots`).query(slotQuery).expect(200);
    expect(reopened.body.slots.some((slot: { available: boolean }) => slot.available)).toBe(true);

    await request(app).delete(`/api/availability/${availability.body.id}`).set('Cookie', f.coachCookie).expect(200);
    const noWindows = await request(app).get(`/api/public/${f.business.slug}/slots`).query(slotQuery).expect(200);
    expect(noWindows.body.slots).toEqual([]);
  });

  it('updates club identity atomically, rejects immutable fields, and lets a coach manage only their solo practice', async () => {
    const originalSlug = f.business.slug;
    const updated = await request(app).patch('/api/business').set('Cookie', f.cookie).send({
      name: 'Courtly Test Academy', ownerName: 'Institution Contact', email: 'HELLO@EXAMPLE.TEST',
      timezone: 'Australia/Sydney', currency: 'usd', cancellationHours: 36, tagline: 'Train with intent',
    }).expect(200);
    expect(updated.body).toMatchObject({
      id: f.business.id, slug: originalSlug, kind: 'CLUB', name: 'Courtly Test Academy',
      ownerName: 'Institution Contact', email: 'hello@example.test', timezone: 'Australia/Sydney',
      currency: 'USD', cancellationHours: 36, tagline: 'Train with intent',
    });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } })).toMatchObject({ name: 'Courtly Test Academy' });

    await request(app).patch('/api/business').set('Cookie', f.cookie)
      .send({ kind: 'SOLO' }).expect(400);
    await request(app).patch('/api/business').set('Cookie', f.cookie)
      .send({ timezone: 'Mars/Olympus_Mons' }).expect(400);
    await request(app).patch('/api/business').set('Cookie', f.coachCookie)
      .send({ name: 'Coach renamed the club' }).expect(403);
    expect(await prisma.business.findUniqueOrThrow({ where: { id: f.business.id } })).toMatchObject({
      name: 'Courtly Test Academy', kind: 'CLUB', slug: originalSlug,
    });

    const practice = await request(app).post('/api/auth/practice').set('Cookie', f.coachCookie)
      .send({ name: 'Coach Solo Practice' }).expect(201);
    tenants.own(practice.body.business.id);
    const soloUpdated = await request(app).patch('/api/business').set('Cookie', f.coachCookie)
      .send({ name: 'Renamed Solo Practice', currency: 'sgd' }).expect(200);
    expect(soloUpdated.body).toMatchObject({
      id: practice.body.business.id, kind: 'SOLO', name: 'Renamed Solo Practice', currency: 'SGD',
    });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: f.coachUser.id } })).toMatchObject({ name: 'Test Coach' });

    const soloLocation = await request(app).post('/api/locations').set('Cookie', f.coachCookie)
      .send({ name: 'Solo court' }).expect(201);
    const soloService = await request(app).post('/api/services').set('Cookie', f.coachCookie)
      .send({ name: 'Solo private lesson' }).expect(201);
    expect(soloService.body.locations).toEqual([expect.objectContaining({
      locationId: soloLocation.body.id, price: 8_000, duration: 60,
    })]);
  });

  it('marks provider notifications read atomically within the club or coach scope', async () => {
    const otherTenant = await tenants.fixture();
    const otherCoach = await rosterCoach(f, 'Other Alert Coach');
    const [ownFirst, ownSecond, otherAlert, clubAlert, foreignAlert] = await Promise.all([
      prisma.notification.create({ data: {
        businessId: f.business.id, instructorId: f.instructor.id, type: 'NOTICE', title: 'Own first', message: 'Own',
      } }),
      prisma.notification.create({ data: {
        businessId: f.business.id, instructorId: f.instructor.id, type: 'NOTICE', title: 'Own second', message: 'Own',
      } }),
      prisma.notification.create({ data: {
        businessId: f.business.id, instructorId: otherCoach.instructor.id, type: 'NOTICE', title: 'Other coach', message: 'Other',
      } }),
      prisma.notification.create({ data: {
        businessId: f.business.id, instructorId: null, type: 'NOTICE', title: 'Club only', message: 'Club',
      } }),
      prisma.notification.create({ data: {
        businessId: otherTenant.business.id, instructorId: otherTenant.instructor.id, type: 'NOTICE', title: 'Foreign', message: 'Foreign',
      } }),
    ]);

    await request(app).patch('/api/notifications/read').set('Cookie', f.coachCookie)
      .send({ ids: [ownFirst.id], unexpected: true }).expect(400);
    await request(app).patch('/api/notifications/read').set('Cookie', f.coachCookie)
      .send({ ids: [ownFirst.id, otherAlert.id] }).expect(404);
    expect(await prisma.notification.findMany({
      where: { id: { in: [ownFirst.id, otherAlert.id] } }, select: { id: true, read: true }, orderBy: { id: 'asc' },
    })).toEqual(expect.arrayContaining([
      { id: ownFirst.id, read: false }, { id: otherAlert.id, read: false },
    ]));

    const selected = await request(app).patch('/api/notifications/read').set('Cookie', f.coachCookie)
      .send({ ids: [ownFirst.id, ownFirst.id] }).expect(200);
    expect(selected.body).toEqual({ ok: true, count: 1 });
    const remainingOwn = await request(app).patch('/api/notifications/read').set('Cookie', f.coachCookie)
      .send({}).expect(200);
    expect(remainingOwn.body).toEqual({ ok: true, count: 1 });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: ownSecond.id } })).toMatchObject({ read: true });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: otherAlert.id } })).toMatchObject({ read: false });
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: clubAlert.id } })).toMatchObject({ read: false });

    const clubSelected = await request(app).patch('/api/notifications/read').set('Cookie', f.cookie)
      .send({ ids: [otherAlert.id, clubAlert.id, clubAlert.id] }).expect(200);
    expect(clubSelected.body).toEqual({ ok: true, count: 2 });
    await request(app).patch('/api/notifications/read').set('Cookie', f.cookie)
      .send({ ids: [foreignAlert.id] }).expect(404);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: foreignAlert.id } })).toMatchObject({ read: false });
  });
});
