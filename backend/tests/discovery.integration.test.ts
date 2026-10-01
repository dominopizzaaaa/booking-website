import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createSession, createStudent, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type SearchResult = {
  business: Record<string, unknown> & { slug: string; name: string };
  service: { id: string; name: string; category: string; type: string; duration: number };
  instructor: { id: string; name: string; initials: string; color: string };
  location: { id: string; name: string; area: string; address: string };
  startAt: string; endAt: string; price: number; placesRemaining: number;
};

const ZONE = 'Asia/Singapore';
const localDay = (offset: number, zone = ZONE) => DateTime.now().setZone(zone).startOf('day').plus({ days: offset });
const localTime = (iso: string, zone = ZONE) => DateTime.fromISO(iso, { zone }).toFormat('HH:mm');

async function studentCookie(f: Fixture, name = 'Discovery Student') {
  const account = await createAccount(f, { name });
  return { account, cookie: (await createSession(f, account.id)).cookie };
}

async function metricCount(businessId: string, metric: string) {
  const rows = await prisma.clubFunnelCounter.findMany({ where: { businessId, metric } });
  return rows.reduce((sum, row) => sum + row.count, 0);
}

/** A whole-day booking that makes every slot of that coach unavailable. */
async function blockCoachDay(f: Fixture, day: DateTime, from = '08:00', to = '20:00') {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const startAt = day.set({ hour: fh, minute: fm });
  const endAt = day.set({ hour: th, minute: tm });
  await prisma.booking.create({
    data: {
      businessId: f.business.id, serviceId: f.service.id, instructorId: f.instructor.id,
      locationId: f.location.id, startAt: startAt.toJSDate(), endAt: endAt.toJSDate(),
      duration: endAt.diff(startAt, 'minutes').minutes, bufferMinutes: 0, status: 'CONFIRMED',
      type: 'PRIVATE', capacity: 1, price: 8_000, paymentRoute: 'CLUB',
      coachAcceptance: 'NOT_REQUIRED', createdByRole: 'CLUB',
    },
  });
}

async function addService(f: Fixture, overrides: { name?: string; category: string; type?: string; capacity?: number; price?: number }) {
  return prisma.service.create({
    data: {
      businessId: f.business.id, name: overrides.name ?? `Class ${randomUUID().slice(0, 6)}`,
      category: overrides.category, type: overrides.type ?? 'PRIVATE', capacity: overrides.capacity ?? 1,
      noticeHours: 0, bufferMinutes: 0,
      locations: { create: {
        locationId: f.location.id, price: overrides.price ?? 8_000, duration: 60,
        instructors: { create: { instructorId: f.instructor.id } },
      } },
    },
  });
}

describe.sequential('Saved clubs', () => {
  let tenants: TestTenants;
  let f: Fixture;
  let g: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
    g = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  it('requires a signed-in student account on every discovery route', async () => {
    for (const [method, path] of [
      ['get', '/api/account/favorites'], ['put', `/api/account/favorites/${f.business.slug}`],
      ['delete', `/api/account/favorites/${f.business.slug}`], ['get', '/api/account/sessions/search'],
    ] as const) {
      await request(app)[method](path).expect(401);
      for (const cookie of [f.cookie, f.coachCookie]) {
        const denied = await request(app)[method](path).set('Cookie', cookie).query({ date: localDay(3).toISODate() }).expect(403);
        expect(denied.body.error).toBe('A student account is required to book or manage personal bookings');
      }
    }
  });

  it('saves idempotently, lists newest first, removes idempotently and stays private to the account', async () => {
    const { cookie } = await studentCookie(f);
    const first = await request(app).put(`/api/account/favorites/${f.business.slug}`).set('Cookie', cookie).send({}).expect(200);
    expect(first.body).toEqual({ slug: f.business.slug, savedAt: expect.any(String) });
    const again = await request(app).put(`/api/account/favorites/${f.business.slug}`).set('Cookie', cookie).send({}).expect(200);
    expect(again.body).toEqual(first.body);
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await request(app).put(`/api/account/favorites/${g.business.slug}`).set('Cookie', cookie).expect(200);

    const listed = await request(app).get('/api/account/favorites').set('Cookie', cookie).expect(200);
    expect(listed.body).toEqual({ favorites: [second.body, first.body] });
    expect(await prisma.favoriteClub.count({ where: { business: { id: { in: [f.business.id, g.business.id] } } } })).toBe(2);

    const other = await studentCookie(f, 'Other Student');
    expect((await request(app).get('/api/account/favorites').set('Cookie', other.cookie).expect(200)).body).toEqual({ favorites: [] });
    // Another student's removal cannot touch this account's saved clubs.
    await request(app).delete(`/api/account/favorites/${f.business.slug}`).set('Cookie', other.cookie).expect(200);
    expect((await request(app).get('/api/account/favorites').set('Cookie', cookie).expect(200)).body.favorites).toHaveLength(2);

    expect((await request(app).delete(`/api/account/favorites/${f.business.slug}`).set('Cookie', cookie).expect(200)).body).toEqual({ ok: true });
    expect((await request(app).delete(`/api/account/favorites/${f.business.slug}`).set('Cookie', cookie).expect(200)).body).toEqual({ ok: true });
    expect((await request(app).get('/api/account/favorites').set('Cookie', cookie).expect(200)).body).toEqual({ favorites: [second.body] });
  });

  it('only saves bookable club pages', async () => {
    const { cookie } = await studentCookie(f);
    await request(app).put(`/api/account/favorites/missing-${randomUUID()}`).set('Cookie', cookie).expect(404);
    await prisma.business.update({ where: { id: g.business.id }, data: { legacyReadOnly: true } });
    const legacy = await request(app).put(`/api/account/favorites/${g.business.slug}`).set('Cookie', cookie).expect(404);
    expect(legacy.body.error).toBe('Club not found');
    await request(app).put(`/api/account/favorites/${f.business.slug}`).set('Cookie', cookie).send({ note: 'x' }).expect(400);
    expect(await prisma.favoriteClub.count({ where: { business: { id: { in: [f.business.id, g.business.id] } } } })).toBe(0);
  });

  it('caps saved clubs at 200 while staying idempotent at the cap', async () => {
    const { account, cookie } = await studentCookie(f);
    const legacyIds = Array.from({ length: 199 }, () => `courtly-test-saved-${randomUUID()}`);
    try {
      // Retained legacy practices still occupy saved rows, which exercises
      // the cap without building 199 complete club aggregates.
      await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.business.createMany({ data: legacyIds.map(id => ({
          id, slug: id, name: 'Saved legacy practice', ownerName: 'Owner', email: `${id}@example.test`,
          kind: 'SOLO', legacyReadOnly: true,
        })) });
        await tx.favoriteClub.createMany({ data: legacyIds.map(businessId => ({ userId: account.id, businessId })) });
      });
      await request(app).put(`/api/account/favorites/${f.business.slug}`).set('Cookie', cookie).expect(200);
      const full = await request(app).put(`/api/account/favorites/${g.business.slug}`).set('Cookie', cookie).expect(409);
      expect(full.body.error).toBe('You can save up to 200 clubs. Remove one to save another.');
      await request(app).put(`/api/account/favorites/${f.business.slug}`).set('Cookie', cookie).expect(200);
      // Legacy rows are not offered back as saved clubs.
      expect((await request(app).get('/api/account/favorites').set('Cookie', cookie).expect(200)).body.favorites
        .map((favorite: { slug: string }) => favorite.slug)).toEqual([f.business.slug]);
      await request(app).delete(`/api/account/favorites/${f.business.slug}`).set('Cookie', cookie).expect(200);
      await request(app).put(`/api/account/favorites/${g.business.slug}`).set('Cookie', cookie).expect(200);
    } finally {
      await prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
        await tx.favoriteClub.deleteMany({ where: { businessId: { in: legacyIds } } });
        await tx.business.deleteMany({ where: { id: { in: legacyIds } } });
      });
    }
  });

  it('marks saved clubs and venue areas in the club directory', async () => {
    const prefix = `zzzzzzzzzz-saved-${randomUUID()}`;
    await prisma.business.update({ where: { id: f.business.id }, data: { slug: `${prefix}-a` } });
    await prisma.business.update({ where: { id: g.business.id }, data: { slug: `${prefix}-b` } });
    // Same area, different spelling: the label must not depend on row order.
    await prisma.location.update({ where: { id: f.location.id }, data: { area: ' tampines · east ' } });
    const second = await prisma.location.create({ data: { businessId: f.business.id, name: 'Second hall', area: 'Tampines · East' } });
    await prisma.serviceLocation.create({
      data: { serviceId: f.service.id, locationId: second.id, price: 7_000, duration: 60,
        instructors: { create: { instructorId: f.instructor.id } } },
    });
    const { cookie } = await studentCookie(f);
    await request(app).put(`/api/account/favorites/${prefix}-a`).set('Cookie', cookie).expect(200);
    const page = await request(app).get('/api/account/clubs').query({ cursor: prefix, limit: 2 }).set('Cookie', cookie).expect(200);
    const bySlug = new Map(page.body.clubs.map((club: { business: { slug: string } }) => [club.business.slug, club]));
    expect(bySlug.get(`${prefix}-a`)).toMatchObject({ favorite: true, areas: ['Tampines · East'], priceFrom: 7_000 });
    expect(bySlug.get(`${prefix}-b`)).toMatchObject({ favorite: false, areas: [] });
  });
});

describe.sequential('Availability-first session search', () => {
  let tenants: TestTenants;
  let f: Fixture;
  let sport: string;
  const date = () => localDay(3).toISODate()!;
  const search = (cookie: string, query: Record<string, string>) =>
    request(app).get('/api/account/sessions/search').set('Cookie', cookie).query(query);

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
    // A unique sport keeps every search inside this test's own clubs.
    sport = `Sport ${randomUUID().slice(0, 8)}`;
    await prisma.service.update({ where: { id: f.service.id }, data: { category: sport } });
    await prisma.location.update({ where: { id: f.location.id }, data: { area: 'Bishan · Central', address: '5 Bishan Road' } });
  });
  afterEach(async () => { await tenants.cleanup(); });

  it('strictly validates the query', async () => {
    const { cookie } = await studentCookie(f);
    await search(cookie, {}).expect(400);
    await search(cookie, { date: '2026-02-30' }).expect(400);
    await search(cookie, { date: localDay(-5).toISODate()! }).expect(400);
    const late = await search(cookie, { date: localDay(70).toISODate()! }).expect(400);
    expect(late.body.error).toBe('Choose a date from today up to 60 days ahead');
    await search(cookie, { date: date(), timeOfDay: 'night' }).expect(400);
    await search(cookie, { date: date(), type: 'private' }).expect(400);
    await search(cookie, { date: date(), extra: 'x' }).expect(400);
    await search(cookie, { date: date(), q: 'x'.repeat(81) }).expect(400);
  });

  it('filters by sport, type, area and club, sorts by time then price, and bounds results', async () => {
    const g = await tenants.fixture();
    const clubName = `Riverside ${randomUUID().slice(0, 8)} Racket Club`;
    await prisma.business.update({ where: { id: g.business.id }, data: { name: clubName } });
    await prisma.location.update({ where: { id: g.location.id }, data: { area: 'Tampines · East', address: '9 Tampines Ave' } });
    await prisma.service.update({ where: { id: g.service.id }, data: { category: ` ${sport.toUpperCase()} `, type: 'GROUP', capacity: 4 } });
    await prisma.serviceLocation.updateMany({ where: { serviceId: g.service.id }, data: { price: 3_000 } });
    const { cookie } = await studentCookie(f);

    const all = await search(cookie, { date: date(), sport: sport.toLowerCase() }).expect(200);
    // Two combinations x 23 half-hourly starts, capped at 40 results.
    expect(all.body.truncated).toBe(true);
    const results = all.body.results as SearchResult[];
    expect(results).toHaveLength(40);
    const order = results.map(result => [result.startAt, result.price] as const);
    expect(order).toEqual([...order].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]));
    expect(localTime(results[0].startAt)).toBe('08:00');
    expect(results[0].business.slug).toBe(g.business.slug);
    expect(results[1].business.slug).toBe(f.business.slug);
    expect(Object.keys(results[0]).sort()).toEqual(['business', 'endAt', 'instructor', 'location', 'placesRemaining', 'price', 'service', 'startAt']);
    expect(results[0]).toMatchObject({
      service: { id: g.service.id, category: ` ${sport.toUpperCase()} `, type: 'GROUP', duration: 60 },
      instructor: { id: g.instructor.id, name: 'Test Coach', initials: 'TC', color: 'sage' },
      location: { id: g.location.id, name: 'Test Court', area: 'Tampines · East', address: '9 Tampines Ave' },
      price: 3_000, placesRemaining: 4,
    });
    expect(results[0].business).toMatchObject({ name: clubName, slug: g.business.slug, kind: 'CLUB', timezone: ZONE });
    expect(results[0].business).not.toHaveProperty('id');
    expect(results[0].business).not.toHaveProperty('email');
    expect(JSON.stringify(results)).not.toContain(g.coachUser.email);

    const slugs = async (query: Record<string, string>) => {
      const response = await search(cookie, { date: date(), sport, ...query }).expect(200);
      return [...new Set((response.body.results as SearchResult[]).map(result => result.business.slug))];
    };
    expect(await slugs({ type: 'GROUP' })).toEqual([g.business.slug]);
    expect(await slugs({ type: 'PRIVATE' })).toEqual([f.business.slug]);
    expect(await slugs({ area: 'tampines' })).toEqual([g.business.slug]);
    expect(await slugs({ area: '5 BISHAN' })).toEqual([f.business.slug]);
    expect(await slugs({ q: clubName.slice(0, 20).toLowerCase() })).toEqual([g.business.slug]);
    expect(await slugs({ q: 'bishan' })).toEqual([f.business.slug]);
    expect(await slugs({ q: 'no such club anywhere' })).toEqual([]);
    // Sport is a category match, not a substring of a longer sport name.
    expect(await slugs({ sport: sport.slice(0, -1) })).toEqual([]);

    const groupOnly = await search(cookie, { date: date(), sport, type: 'GROUP' }).expect(200);
    expect(groupOnly.body).toMatchObject({ truncated: false });
    expect(groupOnly.body.results).toHaveLength(23);
  });

  it('applies local time-of-day windows in each club timezone', async () => {
    const { cookie } = await studentCookie(f);
    const times = async (timeOfDay: string) => ((await search(cookie, { date: date(), sport, timeOfDay }).expect(200))
      .body.results as SearchResult[]).map(result => localTime(result.startAt));
    expect(await times('morning')).toEqual(['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    expect(await times('afternoon')).toEqual(['12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30']);
    expect(await times('evening')).toEqual(['17:00', '17:30', '18:00', '18:30', '19:00']);

    const zone = 'America/Los_Angeles';
    await prisma.business.update({ where: { id: f.business.id }, data: { timezone: zone } });
    const searchDate = localDay(3, zone).toISODate()!;
    const response = await search(cookie, { date: searchDate, sport, timeOfDay: 'morning' }).expect(200);
    const results = response.body.results as SearchResult[];
    expect(results[0].startAt).toBe(DateTime.fromISO(searchDate, { zone }).set({ hour: 8 }).toUTC().toISO());
    expect(results.map(result => localTime(result.startAt, zone))).toEqual(['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  it('uses evaluateSlot for group places, full groups and coach conflicts', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 4 } });
    const day = localDay(3);
    const [first, second] = [await createStudent(f, { name: 'Group One' }), await createStudent(f, { name: 'Group Two' })];
    const group = (hour: number, capacity: number, price: number, studentIds: string[]) => prisma.booking.create({
      data: {
        businessId: f.business.id, serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
        startAt: day.set({ hour }).toJSDate(), endAt: day.set({ hour: hour + 1 }).toJSDate(), duration: 60,
        bufferMinutes: 0, status: 'CONFIRMED', type: 'GROUP', capacity, price, paymentRoute: 'CLUB',
        coachAcceptance: 'NOT_REQUIRED', createdByRole: 'CLUB',
        participants: { create: studentIds.map(studentId => ({ studentId, price })) },
      },
    });
    await group(10, 4, 6_500, [first.id]);
    await group(14, 2, 6_500, [first.id, second.id]);
    const { cookie } = await studentCookie(f);
    const results = (await search(cookie, { date: date(), sport }).expect(200)).body.results as SearchResult[];
    const at = (time: string) => results.find(result => localTime(result.startAt) === time);
    // Joining keeps the existing group's price snapshot and counts its places.
    expect(at('10:00')).toMatchObject({ placesRemaining: 3, price: 6_500 });
    expect(at('14:00')).toBeUndefined();
    // Neighbouring starts overlap the coach's existing groups.
    expect(at('09:30')).toBeUndefined();
    expect(at('13:30')).toBeUndefined();
    expect(at('08:00')).toMatchObject({ placesRemaining: 4, price: 8_000 });
  });

  it('only searches public clubs with a bookable coach', async () => {
    const demo = await tenants.fixture();
    const legacy = await tenants.fixture();
    const unbookable = await tenants.fixture();
    for (const club of [demo, legacy, unbookable]) {
      await prisma.service.update({ where: { id: club.service.id }, data: { category: sport } });
    }
    await prisma.business.update({ where: { id: demo.business.id }, data: { isDemo: true } });
    await prisma.business.update({ where: { id: legacy.business.id }, data: { legacyReadOnly: true } });
    await prisma.user.update({ where: { id: unbookable.coachUser.id }, data: { passwordHash: null } });
    const { cookie } = await studentCookie(f);
    const results = (await search(cookie, { date: date(), sport, timeOfDay: 'evening' }).expect(200)).body.results as SearchResult[];
    expect(new Set(results.map(result => result.business.slug))).toEqual(new Set([f.business.slug]));
  });

  it('skips coaches who are away on the searched date', async () => {
    const { cookie } = await studentCookie(f);
    await prisma.availabilityException.create({
      data: { businessId: f.business.id, instructorId: f.instructor.id, date: date(), reason: 'Tournament' },
    });
    expect((await search(cookie, { date: date(), sport }).expect(200)).body).toEqual({ results: [], truncated: false });
  });

  it('reports truncation when the combination bound is reached', async () => {
    const weekday = localDay(3).weekday % 7;
    await prisma.availability.deleteMany({ where: { instructorId: f.instructor.id, dayOfWeek: weekday } });
    await prisma.availability.create({
      data: { businessId: f.business.id, instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek: weekday, startTime: '10:00', endTime: '11:00' },
    });
    for (let index = 1; index < 40; index++) await addService(f, { category: sport, price: 8_000 + index });
    const { cookie } = await studentCookie(f);
    const exact = await search(cookie, { date: date(), sport }).expect(200);
    expect(exact.body.truncated).toBe(false);
    expect(exact.body.results).toHaveLength(40);

    await addService(f, { category: sport, price: 9_999 });
    const over = await search(cookie, { date: date(), sport }).expect(200);
    expect(over.body.truncated).toBe(true);
    const results = over.body.results as SearchResult[];
    expect(results).toHaveLength(40);
    expect(new Set(results.map(result => result.service.id)).size).toBe(40);
    // The cheapest combinations at the same time are kept.
    expect(results.some(result => result.price === 9_999)).toBe(false);
  }, 30_000);

  it('reports truncation when the slot evaluation bound is reached', async () => {
    const day = localDay(3);
    const weekday = day.weekday % 7;
    await prisma.availability.deleteMany({ where: { instructorId: f.instructor.id, dayOfWeek: weekday } });
    await prisma.availability.create({
      data: { businessId: f.business.id, instructorId: f.instructor.id, locationId: f.location.id, dayOfWeek: weekday, startTime: '00:00', endTime: '23:30' },
    });
    // The coach is busy all day, so every evaluation is a rejection.
    await blockCoachDay(f, day, '00:00', '23:59');
    for (let index = 1; index < 13; index++) await addService(f, { category: sport });
    const { cookie } = await studentCookie(f);
    // 13 combinations x 46 starts = 598 evaluations, inside the bound.
    expect((await search(cookie, { date: date(), sport }).expect(200)).body).toEqual({ results: [], truncated: false });
    await addService(f, { category: sport });
    // 14 x 46 = 644 candidates: the 600-evaluation bound stops the scan.
    expect((await search(cookie, { date: date(), sport }).expect(200)).body).toEqual({ results: [], truncated: true });
  }, 60_000);

  it('records one search impression per club in the results', async () => {
    const g = await tenants.fixture();
    const unseen = await tenants.fixture();
    await prisma.service.update({ where: { id: g.service.id }, data: { category: sport } });
    const { cookie } = await studentCookie(f);
    await search(cookie, { date: date(), sport }).expect(200);
    await search(cookie, { date: date(), sport, timeOfDay: 'evening' }).expect(200);
    await vi.waitFor(async () => {
      expect(await metricCount(f.business.id, 'SEARCH_IMPRESSION')).toBe(2);
      expect(await metricCount(g.business.id, 'SEARCH_IMPRESSION')).toBe(2);
    }, { timeout: 5_000, interval: 25 });
    expect(await metricCount(unseen.business.id, 'SEARCH_IMPRESSION')).toBe(0);
  });

  it('rate-limits searches per account', async () => {
    const { cookie } = await studentCookie(f);
    for (let attempt = 0; attempt < 30; attempt++) {
      await search(cookie, { date: date(), sport: 'Nothing matches this sport' }).expect(200);
    }
    const limited = await search(cookie, { date: date(), sport: 'Nothing matches this sport' }).expect(429);
    expect(limited.body).toEqual({ error: 'Too many searches. Please wait a moment.' });
    const other = await studentCookie(f, 'Second Searcher');
    await search(other.cookie, { date: date(), sport: 'Nothing matches this sport' }).expect(200);
  }, 30_000);
});

describe.sequential('Next available slots', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
    // Close today and tomorrow so the scan starts on a whole future day.
    for (const offset of [0, 1]) {
      await prisma.availabilityException.create({
        data: { businessId: f.business.id, instructorId: f.instructor.id, date: localDay(offset).toISODate()! },
      });
    }
  });
  afterEach(async () => { await tenants.cleanup(); });

  const nextAvailable = (query: Record<string, string | number> = {}) =>
    request(app).get(`/api/public/${f.business.slug}/next-available`).query({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id, ...query,
    });

  it('returns the next available slots in order, five by default', async () => {
    const response = await nextAvailable().expect(200);
    const day = localDay(2);
    expect(response.body).toEqual({
      slots: ['08:00', '08:30', '09:00', '09:30', '10:00'].map(time => {
        const start = DateTime.fromISO(`${day.toISODate()}T${time}`, { zone: ZONE });
        return {
          startAt: start.toUTC().toISO(), endAt: start.plus({ hours: 1 }).toUTC().toISO(),
          available: true, placesRemaining: 1,
        };
      }),
    });
    expect((await nextAvailable({ limit: 2 }).expect(200)).body.slots).toHaveLength(2);
    expect((await nextAvailable({ limit: 10 }).expect(200)).body.slots).toHaveLength(10);
    await nextAvailable({ limit: 0 }).expect(400);
    await nextAvailable({ limit: 11 }).expect(400);
    await nextAvailable({ date: day.toISODate()! }).expect(400);
  });

  it('skips taken times and reports group places from evaluateSlot', async () => {
    await blockCoachDay(f, localDay(2), '08:00', '09:00');
    const taken = await nextAvailable({ limit: 1 }).expect(200);
    expect(localTime(taken.body.slots[0].startAt)).toBe('09:00');

    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 3 } });
    await prisma.booking.deleteMany({ where: { businessId: f.business.id } });
    const student = await createStudent(f);
    await prisma.booking.create({
      data: {
        businessId: f.business.id, serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
        startAt: localDay(2).set({ hour: 8 }).toJSDate(), endAt: localDay(2).set({ hour: 9 }).toJSDate(), duration: 60,
        bufferMinutes: 0, status: 'CONFIRMED', type: 'GROUP', capacity: 3, price: 8_000, paymentRoute: 'CLUB',
        coachAcceptance: 'NOT_REQUIRED', createdByRole: 'CLUB',
        participants: { create: { studentId: student.id, price: 8_000 } },
      },
    });
    const group = await nextAvailable({ limit: 1 }).expect(200);
    expect(group.body.slots[0]).toMatchObject({ placesRemaining: 2 });
    expect(localTime(group.body.slots[0].startAt)).toBe('08:00');
  });

  it('looks at most 28 days ahead', async () => {
    for (let offset = 2; offset < 27; offset++) {
      await prisma.availabilityException.create({
        data: { businessId: f.business.id, instructorId: f.instructor.id, date: localDay(offset).toISODate()! },
      });
    }
    const lastDay = await nextAvailable({ limit: 1 }).expect(200);
    expect(DateTime.fromISO(lastDay.body.slots[0].startAt, { zone: ZONE }).toISODate()).toBe(localDay(27).toISODate());
    await prisma.availabilityException.create({
      data: { businessId: f.business.id, instructorId: f.instructor.id, date: localDay(27).toISODate()! },
    });
    expect((await nextAvailable().expect(200)).body).toEqual({ slots: [] });
  });

  it('stops after 400 slot evaluations', async () => {
    // 23 starts a day: 17 blocked days spend 391 evaluations, leaving nine.
    for (let offset = 2; offset <= 18; offset++) await blockCoachDay(f, localDay(offset));
    const within = await nextAvailable().expect(200);
    expect(within.body.slots).toHaveLength(5);
    expect(DateTime.fromISO(within.body.slots[0].startAt, { zone: ZONE }).toISODate()).toBe(localDay(19).toISODate());
    expect(localTime(within.body.slots[0].startAt)).toBe('08:00');
    // An 18th blocked day spends 414 > 400 before any free start is reached.
    await blockCoachDay(f, localDay(19));
    expect((await nextAvailable().expect(200)).body).toEqual({ slots: [] });
  }, 30_000);

  it('answers 404 for an unknown page or combination', async () => {
    await request(app).get(`/api/public/missing-${randomUUID()}/next-available`).query({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
    }).expect(404);
    await nextAvailable({ serviceId: 'missing-service' }).expect(404);
    await nextAvailable({ instructorId: 'missing-coach' }).expect(404);
    const other = await tenants.fixture();
    // Another club's catalogue never resolves through this page.
    await nextAvailable({ serviceId: other.service.id }).expect(404);
    await prisma.business.update({ where: { id: f.business.id }, data: { legacyReadOnly: true } });
    await nextAvailable().expect(404);
  });
});
