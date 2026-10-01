import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createSession, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

async function metricCount(businessId: string, metric: string) {
  const rows = await prisma.clubFunnelCounter.findMany({ where: { businessId, metric } });
  return rows.reduce((sum, row) => sum + row.count, 0);
}

// Funnel counters are fire-and-forget on read paths, so wait for the write.
async function expectMetric(businessId: string, metric: string, expected: number) {
  await vi.waitFor(async () => {
    expect(await metricCount(businessId, metric)).toBe(expected);
  }, { timeout: 5_000, interval: 25 });
}

describe.sequential('Coach profiles', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  const patchMe = (cookie: string, body: unknown) =>
    request(app).patch('/api/auth/me').set('Cookie', cookie).send(body as object);

  it('lets a coach write a normalized profile and keeps omitted fields on partial edits', async () => {
    const initial = await request(app).get('/api/auth/me').set('Cookie', f.coachCookie).expect(200);
    expect(initial.body.user.coachProfile).toEqual({
      bio: '', languages: [], coachingLevels: [], coachingAgeGroups: [], qualifications: [], coachingSince: null,
    });

    const saved = await patchMe(f.coachCookie, {
      coachProfile: {
        bio: '  Footwork first, then power.  ',
        languages: ['English', ' english ', '', 'Mandarin', 'MANDARIN'],
        coachingLevels: ['ADVANCED', 'BEGINNER', 'BEGINNER'],
        coachingAgeGroups: ['ADULT', 'JUNIOR'],
        qualifications: ['  Level 2 Coach ', 'level 2 coach', 'First Aid'],
        coachingSince: 2015,
      },
    }).expect(200);
    expect(saved.body.user.coachProfile).toEqual({
      bio: 'Footwork first, then power.',
      languages: ['English', 'Mandarin'],
      coachingLevels: ['BEGINNER', 'ADVANCED'],
      coachingAgeGroups: ['JUNIOR', 'ADULT'],
      qualifications: ['Level 2 Coach', 'First Aid'],
      coachingSince: 2015,
    });

    const partial = await patchMe(f.coachCookie, { name: 'Coach Renamed', coachProfile: { bio: 'Shorter bio' } }).expect(200);
    expect(partial.body.user.name).toBe('Coach Renamed');
    expect(partial.body.user.coachProfile).toMatchObject({
      bio: 'Shorter bio', languages: ['English', 'Mandarin'], coachingSince: 2015,
    });
    const cleared = await patchMe(f.coachCookie, { coachProfile: { coachingSince: null, languages: [] } }).expect(200);
    expect(cleared.body.user.coachProfile).toMatchObject({ coachingSince: null, languages: [], bio: 'Shorter bio' });
  });

  it('validates every coach profile limit', async () => {
    const nextYear = DateTime.now().setZone('Asia/Singapore').year + 1;
    const invalid: unknown[] = [
      { bio: 'x'.repeat(601) },
      { languages: Array.from({ length: 9 }, (_, index) => `Language ${index}`) },
      { languages: ['x'.repeat(41)] },
      { coachingLevels: ['EXPERT'] },
      { coachingAgeGroups: ['TODDLER'] },
      { qualifications: Array.from({ length: 11 }, (_, index) => `Qualification ${index}`) },
      { qualifications: ['x'.repeat(81)] },
      { coachingSince: 1949 },
      { coachingSince: nextYear },
      { coachingSince: 2010.5 },
      { verified: true },
    ];
    for (const coachProfile of invalid) {
      await patchMe(f.coachCookie, { coachProfile }).expect(400);
    }
    // Limits apply after blanks and repeats are removed.
    const repeated = await patchMe(f.coachCookie, {
      coachProfile: { languages: [...Array.from({ length: 8 }, (_, index) => `Language ${index}`), 'language 0', ' '] },
    }).expect(200);
    expect(repeated.body.user.coachProfile.languages).toHaveLength(8);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: f.coachUser.id } });
    expect(stored.bio).toBe('');
    expect(stored.coachingSince).toBeNull();
  });

  it('rejects a coaching profile on student and club accounts and serializes null for them', async () => {
    const student = await createAccount(f, { name: 'Profile Student' });
    const studentSession = await createSession(f, student.id);
    const studentMe = await request(app).get('/api/auth/me').set('Cookie', studentSession.cookie).expect(200);
    expect(studentMe.body.user.coachProfile).toBeNull();
    const denied = await patchMe(studentSession.cookie, { coachProfile: { bio: 'I coach too' } }).expect(400);
    expect(denied.body.error).toBe('Only coach accounts have a coaching profile');
    const clubDenied = await patchMe(f.cookie, { coachProfile: { bio: 'We coach' } }).expect(400);
    expect(clubDenied.body.error).toBe('Only coach accounts have a coaching profile');
    const clubMe = await request(app).get('/api/auth/me').set('Cookie', f.cookie).expect(200);
    expect(clubMe.body.user.coachProfile).toBeNull();
    // The student-only profile route never accepts coach columns either.
    await request(app).patch('/api/account/profile').set('Cookie', studentSession.cookie)
      .send({ coachProfile: { bio: 'Sneaky' } }).expect(400);
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    expect(unchanged.bio).toBe('');
  });

  it('publishes the coach profile on the booking page without contact details', async () => {
    const before = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(before.body.instructors).toHaveLength(1);
    // A coach who has said nothing about themselves has no public profile.
    expect(before.body.instructors[0].profile).toBeNull();

    await prisma.user.update({ where: { id: f.coachUser.id }, data: { sports: ['Tennis'], phone: '+65 9000 0000' } });
    const sportsOnly = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(sportsOnly.body.instructors[0].profile).toEqual({
      bio: '', languages: [], coachingLevels: [], coachingAgeGroups: [], qualifications: [], coachingSince: null,
      sports: ['Tennis'],
    });

    await patchMe(f.coachCookie, {
      coachProfile: { bio: 'Patient with juniors.', languages: ['English'], coachingLevels: ['BEGINNER'], coachingSince: 2012 },
    }).expect(200);
    const after = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    const coach = after.body.instructors[0];
    expect(Object.keys(coach).sort()).toEqual(['active', 'color', 'id', 'initials', 'name', 'profile', 'specialty']);
    expect(coach.profile).toEqual({
      bio: 'Patient with juniors.', languages: ['English'], coachingLevels: ['BEGINNER'], coachingAgeGroups: [],
      qualifications: [], coachingSince: 2012, sports: ['Tennis'],
    });
    const text = JSON.stringify(after.body);
    expect(text).not.toContain(f.coachUser.email);
    expect(text).not.toContain('+65 9000 0000');
    expect(text).not.toContain(f.coachUser.username);
    expect(text).not.toContain(f.coachUser.id);
  });
});

describe.sequential('Club public profile', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  const patchBusiness = (body: unknown) =>
    request(app).patch('/api/business').set('Cookie', f.cookie).send(body as object);

  it('edits description, phone and an https website and publishes them', async () => {
    const saved = await patchBusiness({
      description: '  Coaching for every level since 2001.  ', publicPhone: ' +65 6123 4567 ',
      websiteUrl: 'https://club.example/about', supportEmail: 'Help@Club.Example',
    }).expect(200);
    expect(saved.body).toMatchObject({
      description: 'Coaching for every level since 2001.', publicPhone: '+65 6123 4567',
      websiteUrl: 'https://club.example/about', supportEmail: 'help@club.example',
    });
    const me = await request(app).get('/api/auth/me').set('Cookie', f.cookie).expect(200);
    expect(me.body.business).toMatchObject({
      description: 'Coaching for every level since 2001.', publicPhone: '+65 6123 4567',
      websiteUrl: 'https://club.example/about',
    });

    const page = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(page.body.business).toEqual({
      name: f.business.name, slug: f.business.slug, ownerName: f.business.ownerName,
      timezone: 'Asia/Singapore', currency: f.business.currency, color: f.business.color,
      tagline: f.business.tagline, cancellationHours: f.business.cancellationHours, kind: 'CLUB',
      description: 'Coaching for every level since 2001.', publicPhone: '+65 6123 4567',
      websiteUrl: 'https://club.example/about', supportEmail: 'help@club.example',
    });
    expect(JSON.stringify(page.body)).not.toContain(f.business.email);

    const cleared = await patchBusiness({ websiteUrl: '' }).expect(200);
    expect(cleared.body.websiteUrl).toBe('');
  });

  it('rejects unsafe or oversized public profile values', async () => {
    for (const websiteUrl of [
      'http://club.example', 'javascript:alert(1)', 'HTTPS://club.example', 'https://', 'club.example',
      'https://club example.com', `https://club.example/${'x'.repeat(190)}`,
    ]) {
      await patchBusiness({ websiteUrl }).expect(400);
    }
    await patchBusiness({ description: 'x'.repeat(1201) }).expect(400);
    await patchBusiness({ publicPhone: '1'.repeat(41) }).expect(400);
    const stored = await prisma.business.findUniqueOrThrow({ where: { id: f.business.id } });
    expect(stored).toMatchObject({ description: '', publicPhone: '', websiteUrl: '' });
    // Coaches never edit club settings.
    await request(app).patch('/api/business').set('Cookie', f.coachCookie).send({ description: 'Mine now' }).expect(403);
  });

  it('stores a venue area on create and edit and exposes it publicly', async () => {
    const created = await request(app).post('/api/locations').set('Cookie', f.cookie)
      .send({ name: 'East Courts', address: '1 Tampines Ave', area: '  Tampines · East  ' }).expect(201);
    expect(created.body.area).toBe('Tampines · East');
    await request(app).post('/api/locations').set('Cookie', f.cookie)
      .send({ name: 'Too long', area: 'x'.repeat(61) }).expect(400);

    const edited = await request(app).patch(`/api/locations/${f.location.id}`).set('Cookie', f.cookie)
      .send({ area: 'Bishan · Central' }).expect(200);
    expect(edited.body.area).toBe('Bishan · Central');
    await request(app).patch(`/api/locations/${f.location.id}`).set('Cookie', f.cookie)
      .send({ area: 'x'.repeat(61) }).expect(400);
    expect((await prisma.location.findUniqueOrThrow({ where: { id: f.location.id } })).area).toBe('Bishan · Central');
    const listed = await request(app).get('/api/locations').set('Cookie', f.cookie).expect(200);
    expect(listed.body.find((location: { id: string }) => location.id === created.body.id).area).toBe('Tampines · East');

    const page = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(page.body.locations).toEqual([expect.objectContaining({ id: f.location.id, area: 'Bishan · Central' })]);
  });

  it('summarizes exactly the bookable catalogue on the booking page', async () => {
    await prisma.location.update({ where: { id: f.location.id }, data: { area: 'Bishan · Central' } });
    await prisma.service.update({ where: { id: f.service.id }, data: { category: 'Tennis' } });
    const east = await prisma.location.create({
      data: { businessId: f.business.id, name: 'East Hall', area: ' Tampines · East ' },
    });
    await prisma.service.create({
      data: {
        businessId: f.business.id, name: 'Badminton group', category: ' Badminton ', type: 'GROUP', capacity: 6,
        locations: { create: {
          locationId: east.id, price: 2_500, duration: 90,
          instructors: { create: { instructorId: f.instructor.id } },
        } },
      },
    });
    // Neither of these can be booked, so neither may shape the summary.
    const archived = await prisma.location.create({
      data: { businessId: f.business.id, name: 'Archived Court', area: 'Jurong · West', active: false },
    });
    await prisma.service.create({
      data: {
        businessId: f.business.id, name: 'Squash ghost', category: 'Squash',
        locations: { create: {
          locationId: archived.id, price: 100, duration: 60,
          instructors: { create: { instructorId: f.instructor.id } },
        } },
      },
    });

    const page = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(page.body.summary).toEqual({
      sports: ['Badminton', 'Tennis'], priceFrom: 2_500, coachCount: 1, locationCount: 2,
      serviceCount: 2, groupClassCount: 1, areas: ['Bishan · Central', 'Tampines · East'],
    });

    await prisma.serviceLocation.deleteMany({ where: { service: { businessId: f.business.id } } });
    const empty = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(empty.body.summary).toEqual({
      sports: [], priceFrom: null, coachCount: 0, locationCount: 0, serviceCount: 0, groupClassCount: 0, areas: [],
    });
  });
});

describe.sequential('Club funnel counters', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  it('counts page views, availability checks, bookings and re-bookings without identifying anyone', async () => {
    await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    await expectMetric(f.business.id, 'PAGE_VIEW', 2);

    await request(app).get(`/api/public/${f.business.slug}/slots`).query({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id, date: f.starts.toISODate()!,
    }).expect(200);
    await request(app).get(`/api/public/${f.business.slug}/next-available`).query({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id, limit: 1,
    }).expect(200);
    await expectMetric(f.business.id, 'AVAILABILITY_CHECK', 2);
    // A rejected request is not an availability check.
    await request(app).get(`/api/public/${f.business.slug}/next-available`).query({ serviceId: f.service.id }).expect(400);

    const student = await createAccount(f, { name: 'Funnel Student' });
    const session = await createSession(f, student.id);
    const book = (startAt: DateTime, source?: string) => request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', session.cookie).send({
        serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
        startAt: startAt.toISO(), ...(source ? { source } : {}),
      });
    await book(f.starts, 'SEARCH').expect(201);
    await expectMetric(f.business.id, 'BOOKING_CREATED', 1);
    await book(f.starts.plus({ hours: 2 }), 'REBOOK').expect(201);
    await expectMetric(f.business.id, 'BOOKING_CREATED', 2);
    await expectMetric(f.business.id, 'REBOOK_CREATED', 1);
    await book(f.starts.plus({ hours: 4 }), 'ELSEWHERE').expect(400);
    // A failed booking is not a conversion.
    await book(f.starts, 'REBOOK').expect(409);
    await book(f.starts.plus({ hours: 6 })).expect(201);
    await expectMetric(f.business.id, 'BOOKING_CREATED', 3);
    expect(await metricCount(f.business.id, 'REBOOK_CREATED')).toBe(1);

    const booking = await prisma.booking.findFirstOrThrow({ where: { businessId: f.business.id }, orderBy: { startAt: 'asc' } });
    expect(booking).not.toHaveProperty('source');
    const rows = await prisma.clubFunnelCounter.findMany({ where: { businessId: f.business.id } });
    const today = DateTime.now().setZone('Asia/Singapore').toISODate();
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['businessId', 'count', 'day', 'metric']);
      expect(DateTime.fromJSDate(row.day, { zone: 'UTC' }).toISODate()).toBe(today);
    }
  });

  it('counts nothing for an unknown or legacy booking page', async () => {
    const slug = `missing-${randomUUID()}`;
    await request(app).get(`/api/public/${slug}`).expect(404);
    await request(app).get(`/api/public/${slug}/next-available`).query({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
    }).expect(404);
    expect(await prisma.clubFunnelCounter.count({ where: { businessId: f.business.id } })).toBe(0);
  });
});
