import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { TestTenants, createStudent, prisma, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Management catalog input boundaries', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  const post = (path: string, body: unknown) =>
    request(app).post(`/api${path}`).set('Cookie', f.cookie).send(body as object);
  const patch = (path: string, body: unknown) =>
    request(app).patch(`/api${path}`).set('Cookie', f.cookie).send(body as object);

  describe('services', () => {
    const service = (overrides: Record<string, unknown> = {}) => ({
      name: `Service ${randomUUID()}`, ...overrides,
    });

    it('fills in the defaults a minimal service does not state', async () => {
      const response = await post('/services', service());
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        category: 'Tennis', type: 'PRIVATE', duration: 60, price: 8_000,
        capacity: 1, bufferMinutes: 0, noticeHours: 2, color: 'sage', active: true,
      });
      // With no explicit mapping, a new service is offered wherever the
      // business can currently teach it.
      expect(response.body.locations).toHaveLength(1);
      expect(response.body.locations[0].instructorIds).toEqual([f.instructor.id]);
    });

    // A private lesson has exactly one place. Accepting a larger capacity would
    // let a second student be enrolled in a session sold as one-to-one.
    it('holds a private service to a single place whatever capacity is sent', async () => {
      const created = await post('/services', service({ type: 'PRIVATE', capacity: 8 }));
      expect(created.body.capacity).toBe(1);

      const group = await post('/services', service({ type: 'GROUP', capacity: 8 }));
      expect(group.body.capacity).toBe(8);

      const narrowed = await patch(`/services/${group.body.id}`, { type: 'PRIVATE' });
      expect(narrowed.body.capacity).toBe(1);
    });

    it('keeps the group capacity when an unrelated field is edited', async () => {
      const group = await post('/services', service({ type: 'GROUP', capacity: 6 }));
      const renamed = await patch(`/services/${group.body.id}`, { name: `Renamed ${randomUUID()}` });
      expect(renamed.body.capacity).toBe(6);
    });

    it('refuses durations, prices and windows outside their allowed range', async () => {
      for (const invalid of [
        { duration: 14 }, { duration: 481 }, { duration: 60.5 },
        { price: -1 }, { price: 100_000_001 }, { price: 80.5 },
        { capacity: 0 }, { capacity: 101 },
        { bufferMinutes: -1 }, { bufferMinutes: 241 },
        { noticeHours: -1 }, { noticeHours: 721 },
      ]) {
        const response = await post('/services', service(invalid));
        expect(response.status, JSON.stringify(invalid)).toBe(400);
      }
    });

    it('accepts the exact edges of each range', async () => {
      const response = await post('/services', service({
        type: 'GROUP', duration: 15, price: 0, capacity: 100, bufferMinutes: 240, noticeHours: 720,
      }));
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ duration: 15, price: 0, capacity: 100, bufferMinutes: 240, noticeHours: 720 });
    });

    it('refuses a venue or coach listed twice for one service', async () => {
      const mapping = { locationId: f.location.id, price: 8_000, duration: 60, instructorIds: [f.instructor.id] };
      const duplicateLocation = await post('/services', service({ locations: [mapping, mapping] }));
      expect(duplicateLocation.status).toBe(400);
      expect(duplicateLocation.body.error).toBe('Duplicate locations are not allowed');

      const duplicateInstructor = await post('/services', service({
        locations: [{ ...mapping, instructorIds: [f.instructor.id, f.instructor.id] }],
      }));
      expect(duplicateInstructor.status).toBe(400);
      expect(duplicateInstructor.body.error).toBe('Duplicate instructors are not allowed');
    });

    it('refuses a venue or coach that belongs to another business', async () => {
      const other = await tenants.fixture();
      const foreignLocation = await post('/services', service({
        locations: [{ locationId: other.location.id, price: 8_000, duration: 60, instructorIds: [] }],
      }));
      expect(foreignLocation.status).toBe(400);
      expect(foreignLocation.body.error).toBe('Every service location must be active and belong to this business');

      const foreignInstructor = await post('/services', service({
        locations: [{ locationId: f.location.id, price: 8_000, duration: 60, instructorIds: [other.instructor.id] }],
      }));
      expect(foreignInstructor.status).toBe(400);
      expect(foreignInstructor.body.error).toBe('Every assigned instructor must be active and belong to this business');
    });

    it('refuses an archived venue as a service location', async () => {
      const archived = await prisma.location.create({
        data: { businessId: f.business.id, name: `Archived ${randomUUID()}`, active: false },
      });
      const response = await post('/services', service({
        locations: [{ locationId: archived.id, price: 8_000, duration: 60, instructorIds: [] }],
      }));
      expect(response.status).toBe(400);
    });

    it('rejects an unknown service type or an unknown field', async () => {
      expect((await post('/services', service({ type: 'SEMI_PRIVATE' }))).status).toBe(400);
      expect((await post('/services', service({ businessId: f.business.id }))).status).toBe(400);
    });
  });

  describe('venues', () => {
    const venue = (overrides: Record<string, unknown> = {}) => ({ name: `Venue ${randomUUID()}`, ...overrides });

    it('defaults a new venue to a facility that needs no approval', async () => {
      const response = await post('/locations', venue());
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        type: 'FACILITY', requiresApproval: false, travelMinutes: 20,
        source: 'MANUAL', latitude: null, longitude: null, active: true,
      });
    });

    it('accepts each venue type Courtly knows about', async () => {
      for (const type of ['FACILITY', 'RENTED', 'HOME', 'ONLINE']) {
        const response = await post('/locations', venue({ type }));
        expect(response.status, type).toBe(201);
        expect(response.body.type).toBe(type);
      }
      expect((await post('/locations', venue({ type: 'BEACH' }))).status).toBe(400);
    });

    it('requires a full link rather than a bare hostname', async () => {
      const bad = await post('/locations', venue({ mapsUrl: 'maps.google.com/place' }));
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('Use a full https link');
      expect((await post('/locations', venue({ mapsUrl: 'https://maps.google.com/place' }))).status).toBe(201);
      expect((await post('/locations', venue({ mapsUrl: '' }))).status).toBe(201);
    });

    it('keeps coordinates inside the world', async () => {
      expect((await post('/locations', venue({ latitude: 91 }))).status).toBe(400);
      expect((await post('/locations', venue({ latitude: -91 }))).status).toBe(400);
      expect((await post('/locations', venue({ longitude: 181 }))).status).toBe(400);
      expect((await post('/locations', venue({ longitude: -181 }))).status).toBe(400);
      const edge = await post('/locations', venue({ latitude: 90, longitude: -180 }));
      expect(edge.status).toBe(201);
      expect(edge.body).toMatchObject({ latitude: 90, longitude: -180 });
    });

    it('bounds the travel allowance', async () => {
      expect((await post('/locations', venue({ travelMinutes: -1 }))).status).toBe(400);
      expect((await post('/locations', venue({ travelMinutes: 241 }))).status).toBe(400);
      expect((await post('/locations', venue({ travelMinutes: 0 }))).status).toBe(201);
    });
  });

  describe('the business profile', () => {
    it('refuses a timezone the scheduler could not read a calendar day in', async () => {
      const response = await patch('/business', { timezone: 'Mars/Olympus' });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Choose a valid IANA timezone');
      expect((await patch('/business', { timezone: 'Europe/Lisbon' })).body.timezone).toBe('Europe/Lisbon');
    });

    it('normalises a currency code and refuses anything else', async () => {
      expect((await patch('/business', { currency: 'usd' })).body.currency).toBe('USD');
      expect((await patch('/business', { currency: 'Dollars' })).status).toBe(400);
      expect((await patch('/business', { currency: 'US' })).status).toBe(400);
    });

    it('bounds the cancellation notice a club can demand', async () => {
      expect((await patch('/business', { cancellationHours: -1 })).status).toBe(400);
      expect((await patch('/business', { cancellationHours: 721 })).status).toBe(400);
      expect((await patch('/business', { cancellationHours: 0 })).body.cancellationHours).toBe(0);
      expect((await patch('/business', { cancellationHours: 720 })).body.cancellationHours).toBe(720);
    });

    // The club account is the club. Renaming one has to rename the other, or
    // the sign-in name and the booking page drift apart.
    it('renames the institutional account along with the club', async () => {
      const name = `Renamed Club ${randomUUID()}`;
      expect((await patch('/business', { name })).body.name).toBe(name);
      const account = await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } });
      expect(account.name).toBe(name);
    });

    it('refuses to move the money path, the slug or the demo flag', async () => {
      for (const invalid of [{ kind: 'SOLO' }, { slug: 'new-slug' }, { isDemo: true }, { id: 'other' }]) {
        expect((await patch('/business', invalid)).status, JSON.stringify(invalid)).toBe(400);
      }
      const unchanged = await prisma.business.findUniqueOrThrow({ where: { id: f.business.id } });
      expect(unchanged).toMatchObject({ kind: 'CLUB', slug: f.business.slug, isDemo: false });
    });
  });

  describe('working hours and blocked dates', () => {
    const hours = (overrides: Record<string, unknown> = {}) => ({
      instructorId: f.instructor.id, locationId: f.location.id,
      dayOfWeek: 1, startTime: '09:00', endTime: '17:00', ...overrides,
    });

    it('insists on a 24-hour HH:mm time', async () => {
      for (const invalid of ['9:00', '09:60', '24:00', '0900', '09:00:00', 'morning']) {
        const response = await post('/availability', hours({ startTime: invalid }));
        expect(response.status, invalid).toBe(400);
        expect(response.body.error).toBe('Use a valid time in HH:mm format');
      }
      // A venue of its own, because the fixture already opens 08:00–20:00
      // every day at the shared one and windows there would overlap.
      const quiet = await prisma.location.create({
        data: { businessId: f.business.id, name: `Quiet court ${randomUUID()}` },
      });
      const wholeDay = await post('/availability', hours({
        locationId: quiet.id, startTime: '00:00', endTime: '23:59',
      }));
      expect(wholeDay.status).toBe(201);
      expect(wholeDay.body).toMatchObject({ startTime: '00:00', endTime: '23:59' });
    });

    it('refuses a window that ends before it starts or lasts no time at all', async () => {
      const backwards = await post('/availability', hours({ startTime: '17:00', endTime: '09:00' }));
      expect(backwards.status).toBe(400);
      expect(backwards.body.error).toBe('End time must be after start time on the same day');
      expect((await post('/availability', hours({ startTime: '09:00', endTime: '09:00' }))).status).toBe(400);
    });

    it('accepts every weekday and nothing outside the week', async () => {
      for (const dayOfWeek of [0, 1, 2, 3, 4, 5, 6]) {
        const response = await post('/availability', hours({ dayOfWeek, startTime: '06:00', endTime: '07:00' }));
        expect(response.status, String(dayOfWeek)).toBe(201);
      }
      expect((await post('/availability', hours({ dayOfWeek: 7 }))).status).toBe(400);
      expect((await post('/availability', hours({ dayOfWeek: -1 }))).status).toBe(400);
    });

    it('insists a blocked date is a real calendar day', async () => {
      const block = (date: string) => post('/exceptions', { instructorId: f.instructor.id, date });
      expect((await block('2026-02-30')).body.error).toBe('Date must be a valid calendar date');
      expect((await block('2026-13-01')).status).toBe(400);
      expect((await block('01-03-2026')).status).toBe(400);
      const leapYear = await block('2028-02-29');
      expect(leapYear.status).toBe(201);
      expect(leapYear.body).toMatchObject({ date: '2028-02-29', reason: 'Unavailable' });
    });

    it('replaces the reason when the same date is blocked again', async () => {
      const date = f.starts.plus({ days: 3 }).toISODate()!;
      await post('/exceptions', { instructorId: f.instructor.id, date, reason: 'Travelling' });
      const updated = await post('/exceptions', { instructorId: f.instructor.id, date, reason: 'Injured' });
      expect(updated.body.reason).toBe('Injured');
      expect(await prisma.availabilityException.count({
        where: { businessId: f.business.id, instructorId: f.instructor.id, date },
      })).toBe(1);
    });
  });

  describe('lesson packages', () => {
    const expiresAt = () => f.starts.plus({ months: 3 }).toISO();

    it('requires at least one credit and refuses a fractional one', async () => {
      const student = await createStudent(f);
      const base = { studentId: student.id, name: 'Ten lessons', price: 50_000, expiresAt: expiresAt() };
      expect((await post('/packages', { ...base, totalCredits: 0 })).status).toBe(400);
      expect((await post('/packages', { ...base, totalCredits: 2.5 })).status).toBe(400);
      expect((await post('/packages', { ...base, totalCredits: 501 })).status).toBe(400);
      expect((await post('/packages', { ...base, totalCredits: 1 })).status).toBe(201);
    });

    it('accepts a package with no service restriction and refuses an unknown service', async () => {
      const student = await createStudent(f);
      const base = { studentId: student.id, name: 'Any lesson', totalCredits: 5, price: 50_000, expiresAt: expiresAt() };
      expect((await post('/packages', { ...base, serviceId: null })).status).toBe(201);
      const unknown = await post('/packages', { ...base, serviceId: randomUUID() });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('Service not found or unavailable');
    });

    it('refuses a student from another business', async () => {
      const other = await tenants.fixture();
      const foreign = await createStudent(other);
      const response = await post('/packages', {
        studentId: foreign.id, name: 'Foreign', totalCredits: 5, price: 50_000, expiresAt: expiresAt(),
      });
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Student not found');
    });

    // Marking a package paid is a money event and belongs in the ledger, not
    // in a catalog edit that leaves no payment behind it.
    it('records the matching receipt when a package is created already paid', async () => {
      const student = await createStudent(f);
      const created = await post('/packages', {
        studentId: student.id, name: 'Prepaid', totalCredits: 5, price: 50_000,
        expiresAt: expiresAt(), paid: true,
      });
      expect(created.status).toBe(201);
      const payments = await prisma.payment.findMany({ where: { packageId: created.body.id } });
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ amount: 50_000, kind: 'STUDENT_TO_CLUB', studentId: student.id });

      const flipped = await patch(`/packages/${created.body.id}`, { paid: false });
      expect(flipped.status).toBe(400);
      expect(flipped.body.error).toBe('Record package payments through the payments endpoint');
    });

    it('writes no receipt for a free package', async () => {
      const student = await createStudent(f);
      const created = await post('/packages', {
        studentId: student.id, name: 'Complimentary', totalCredits: 2, price: 0,
        expiresAt: expiresAt(), paid: true,
      });
      expect(created.status).toBe(201);
      expect(await prisma.payment.count({ where: { packageId: created.body.id } })).toBe(0);
    });

    it('refuses an expiry that is not a real instant', async () => {
      const student = await createStudent(f);
      const base = { studentId: student.id, name: 'Bad expiry', totalCredits: 5, price: 50_000 };
      expect((await post('/packages', { ...base, expiresAt: '2026-03-01' })).status).toBe(400);
      expect((await post('/packages', { ...base, expiresAt: 'next year' })).status).toBe(400);
    });
  });

  describe('a coach reschedule window', () => {
    it('is bounded and settable by the coach it protects', async () => {
      const set = (rescheduleNoticeHours: number) => request(app)
        .patch('/api/instructors/me').set('Cookie', f.coachCookie).send({ rescheduleNoticeHours });
      expect((await set(-1)).status).toBe(400);
      expect((await set(721)).status).toBe(400);
      expect((await set(0)).body.rescheduleNoticeHours).toBe(0);
      expect((await set(720)).body.rescheduleNoticeHours).toBe(720);
    });

    it('is the only roster field a coach may change about themselves', async () => {
      const response = await request(app)
        .patch('/api/instructors/me').set('Cookie', f.coachCookie)
        .send({ rescheduleNoticeHours: 48, active: false });
      expect(response.status).toBe(400);
      const unchanged = await prisma.instructor.findUniqueOrThrow({ where: { id: f.instructor.id } });
      expect(unchanged.active).toBe(true);
    });
  });
});
