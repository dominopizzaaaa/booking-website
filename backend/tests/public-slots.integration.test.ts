import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createSession, createStudent, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type Slot = { startAt: string; endAt: string; available: boolean; placesRemaining: number; reason?: string };

describe.sequential('The public slot grid', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  const query = (overrides: Record<string, string> = {}) => ({
    serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
    date: f.starts.toISODate()!, ...overrides,
  });

  const loadSlots = (overrides: Record<string, string> = {}) =>
    request(app).get(`/api/public/${f.business.slug}/slots`).query(query(overrides));

  const localTimes = (slots: Slot[]) =>
    slots.map(slot => DateTime.fromISO(slot.startAt, { zone: 'Asia/Singapore' }).toFormat('HH:mm'));

  it('offers a half-hourly grid that never runs past the closing time', async () => {
    const response = await loadSlots();
    expect(response.status).toBe(200);
    const times = localTimes(response.body.slots);
    expect(times[0]).toBe('08:00');
    expect(times[1]).toBe('08:30');
    // Availability closes at 20:00 and the lesson lasts an hour, so the last
    // start that still fits is 19:00.
    expect(times.at(-1)).toBe('19:00');
    expect(new Set(times).size).toBe(times.length);
  });

  it('reports the session duration on every slot and one free place for a private lesson', async () => {
    const { body } = await loadSlots();
    for (const slot of body.slots as Slot[]) {
      expect(new Date(slot.endAt).getTime() - new Date(slot.startAt).getTime()).toBe(60 * 60_000);
    }
    expect((body.slots as Slot[]).every(slot => slot.available)).toBe(true);
    expect((body.slots as Slot[])[0].placesRemaining).toBe(1);
  });

  // A slot the student cannot take still appears, with the reason, rather than
  // silently vanishing from a day that looks empty for no stated cause.
  it('keeps a taken slot visible and says why it cannot be booked', async () => {
    const student = await createStudent(f);
    await prisma.booking.create({
      data: {
        businessId: f.business.id, serviceId: f.service.id, instructorId: f.instructor.id,
        locationId: f.location.id, startAt: f.starts.toJSDate(), endAt: f.starts.plus({ minutes: 60 }).toJSDate(),
        duration: 60, bufferMinutes: 0, status: 'CONFIRMED', type: 'PRIVATE', capacity: 1, price: 8_000,
        paymentRoute: 'CLUB', coachAcceptance: 'NOT_REQUIRED', createdByRole: 'CLUB',
        participants: { create: { studentId: student.id, price: 8_000 } },
      },
    });
    const { body } = await loadSlots();
    const taken = (body.slots as Slot[]).find(slot => slot.startAt === f.starts.toUTC().toISO());
    expect(taken?.available).toBe(false);
    expect(taken?.reason).toBe('Coach already has a session or preparation buffer');
  });

  it('closes the whole day when the coach has blocked it', async () => {
    await prisma.availabilityException.create({
      data: {
        businessId: f.business.id, instructorId: f.instructor.id,
        date: f.starts.toISODate()!, reason: 'Away',
      },
    });
    const { body } = await loadSlots();
    expect((body.slots as Slot[]).every(slot => !slot.available)).toBe(true);
    expect((body.slots as Slot[])[0].reason).toBe('Coach is unavailable on this date');
  });

  // Notice is measured from now, so the cut-off moves through the grid rather
  // than closing the whole day.
  it('refuses the slots that fall inside the service notice period', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { noticeHours: 400 } });
    const { body } = await loadSlots();
    const slots = body.slots as Slot[];
    const cutoff = Date.now() + 400 * 3_600_000;
    for (const slot of slots) {
      expect(slot.available).toBe(new Date(slot.startAt).getTime() >= cutoff);
      if (!slot.available) expect(slot.reason).toBe('At least 400 hours notice is required');
    }
  });

  it('counts the places left in a group and shows a full one as unavailable', async () => {
    const service = await prisma.service.create({
      data: {
        businessId: f.business.id, name: `Group clinic ${randomUUID()}`, type: 'GROUP', capacity: 2,
        duration: 60, price: 4_000, noticeHours: 0, bufferMinutes: 0,
        locations: {
          create: {
            locationId: f.location.id, price: 4_000, duration: 60,
            instructors: { create: { instructorId: f.instructor.id } },
          },
        },
      },
    });
    const group = await prisma.booking.create({
      data: {
        businessId: f.business.id, serviceId: service.id, instructorId: f.instructor.id,
        locationId: f.location.id, startAt: f.starts.toJSDate(), endAt: f.starts.plus({ minutes: 60 }).toJSDate(),
        duration: 60, bufferMinutes: 0, status: 'CONFIRMED', type: 'GROUP', capacity: 2, price: 4_000,
        paymentRoute: 'CLUB', coachAcceptance: 'NOT_REQUIRED', createdByRole: 'CLUB',
        participants: { create: { studentId: (await createStudent(f)).id, price: 4_000 } },
      },
    });
    const first = await loadSlots({ serviceId: service.id });
    const joinable = (first.body.slots as Slot[]).find(slot => slot.startAt === f.starts.toUTC().toISO());
    expect(joinable).toMatchObject({ available: true, placesRemaining: 1 });

    await prisma.participant.create({
      data: { bookingId: group.id, studentId: (await createStudent(f)).id, price: 4_000 },
    });
    const second = await loadSlots({ serviceId: service.id });
    const full = (second.body.slots as Slot[]).find(slot => slot.startAt === f.starts.toUTC().toISO());
    expect(full).toMatchObject({ available: false, placesRemaining: 0, reason: 'This group is full' });
  });

  it('reads the calendar day in the business timezone, not the server one', async () => {
    await prisma.business.update({ where: { id: f.business.id }, data: { timezone: 'America/New_York' } });
    const { body } = await loadSlots();
    const zones = (body.slots as Slot[]).map(slot =>
      DateTime.fromISO(slot.startAt, { zone: 'America/New_York' }).toISODate());
    expect(new Set(zones)).toEqual(new Set([f.starts.toISODate()]));
  });

  it('returns an empty grid for a weekday the coach does not work', async () => {
    const day = f.starts.plus({ days: 1 });
    await prisma.availability.deleteMany({
      where: { businessId: f.business.id, dayOfWeek: day.weekday % 7 },
    });
    const { body } = await loadSlots({ date: day.toISODate()! });
    expect(body.slots).toEqual([]);
  });

  describe('input handling', () => {
    it('rejects a malformed or impossible calendar date', async () => {
      expect((await loadSlots({ date: '2026-3-1' })).status).toBe(400);
      const impossible = await loadSlots({ date: '2026-02-30' });
      expect(impossible.status).toBe(400);
      expect(impossible.body.error).toBe('Invalid calendar date');
    });

    it('refuses a date beyond the next year rather than scanning it', async () => {
      const response = await loadSlots({
        date: DateTime.now().plus({ years: 1, days: 2 }).toISODate()!,
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Choose a date within the next year');
    });

    it('requires every part of the scheduling tuple', async () => {
      for (const missing of ['serviceId', 'instructorId', 'locationId', 'date']) {
        const values = query();
        delete (values as Record<string, string>)[missing];
        const response = await request(app)
          .get(`/api/public/${f.business.slug}/slots`).query(values);
        expect(response.status).toBe(400);
      }
    });

    it('reports an unknown booking page rather than an empty day', async () => {
      const response = await request(app)
        .get(`/api/public/${randomUUID()}/slots`).query(query());
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Booking page not found');
    });

    it('refuses a coach, service or venue from another business', async () => {
      const other = await tenants.fixture();
      for (const overrides of [
        { serviceId: other.service.id }, { instructorId: other.instructor.id }, { locationId: other.location.id },
      ]) {
        const response = await loadSlots(overrides);
        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Service, coach or location not found');
      }
    });

    it('refuses a coach who is not assigned to this service at this venue', async () => {
      const service = await prisma.service.create({
        data: {
          businessId: f.business.id, name: `Unassigned ${randomUUID()}`, type: 'PRIVATE', capacity: 1,
          duration: 60, price: 8_000, noticeHours: 0, bufferMinutes: 0,
          locations: { create: { locationId: f.location.id, price: 8_000, duration: 60 } },
        },
      });
      const response = await loadSlots({ serviceId: service.id });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('This service is not offered by that coach at this location');
    });

    it('does not offer slots for an archived service or venue', async () => {
      await prisma.service.update({ where: { id: f.service.id }, data: { active: false } });
      expect((await loadSlots()).status).toBe(404);
      await prisma.service.update({ where: { id: f.service.id }, data: { active: true } });
      await prisma.location.update({ where: { id: f.location.id }, data: { active: false } });
      expect((await loadSlots()).status).toBe(404);
    });

    // The grid is public, but booking from it is not: a slot is only ever a
    // proposal until a signed-in student account claims it.
    it('is readable without a session while booking still requires a student account', async () => {
      expect((await loadSlots()).status).toBe(200);
      const anonymous = await request(app)
        .post(`/api/public/${f.business.slug}/bookings`)
        .send({ ...query(), startAt: f.starts.toISO() });
      expect(anonymous.status).toBe(401);

      const coach = await request(app)
        .post(`/api/public/${f.business.slug}/bookings`)
        .set('Cookie', f.coachCookie)
        .send({
          serviceId: f.service.id, instructorId: f.instructor.id,
          locationId: f.location.id, startAt: f.starts.toISO(),
        });
      expect(coach.status).toBe(403);
    });

    it('lets a signed-in student book a slot the grid offered', async () => {
      const account = await createAccount(f, { name: 'Slot Student' });
      const { cookie } = await createSession(f, account.id);
      const offered = (await loadSlots()).body.slots as Slot[];
      const response = await request(app)
        .post(`/api/public/${f.business.slug}/bookings`)
        .set('Cookie', cookie)
        .send({
          serviceId: f.service.id, instructorId: f.instructor.id,
          locationId: f.location.id, startAt: offered[0].startAt,
        });
      expect(response.status).toBe(201);
      expect(response.body.bookings[0]).toMatchObject({ status: 'CONFIRMED', paymentRoute: 'CLUB' });

      const after = (await loadSlots()).body.slots as Slot[];
      expect(after[0]).toMatchObject({ available: false });
    });
  });
});
