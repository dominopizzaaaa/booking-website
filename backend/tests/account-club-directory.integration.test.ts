import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  createAccount, createSession, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Student club directory', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function studentCookie() {
    const student = await createAccount(club, {
      name: 'Directory Student',
      email: `directory-${randomUUID()}@example.test`,
      accountType: 'STUDENT',
    });
    return (await createSession(club, student.id)).cookie;
  }

  it('requires a registered student account', async () => {
    await request(app).get('/api/account/clubs').expect(401);
    const denied = await request(app).get('/api/account/clubs')
      .set('Cookie', club.cookie).expect(403);
    expect(denied.body.error).toBe('A student account is required to book or manage personal bookings');
  });

  it('strictly validates its bounded page query', async () => {
    const cookie = await studentCookie();
    await request(app).get('/api/account/clubs').query({ limit: 0 }).set('Cookie', cookie).expect(400);
    await request(app).get('/api/account/clubs').query({ limit: 51 }).set('Cookie', cookie).expect(400);
    await request(app).get('/api/account/clubs').query({ extra: 'nope' }).set('Cookie', cookie).expect(400);
  });

  it('lists every bookable club with public, deduplicated catalog summaries', async () => {
    const alphabeticClub = await tenants.fixture();
    const unavailableClub = await tenants.fixture();
    const privateDemoClub = await tenants.fixture();
    const legacyClub = await tenants.fixture();
    const pagePrefix = `zzzzzzzzzz-directory-${randomUUID()}`;
    const alphaSlug = `${pagePrefix}-alpha`;
    const demoSlug = `${pagePrefix}-demo`;
    const hiddenSlug = `${pagePrefix}-hidden`;
    const legacySlug = `${pagePrefix}-legacy`;
    const soloSlug = `${pagePrefix}-solo`;
    const zebraSlug = `${pagePrefix}-zebra`;
    await prisma.business.update({
      where: { id: club.business.id },
      data: { name: 'Directory Zebra Club', slug: zebraSlug, tagline: 'Three racket sports.' },
    });
    await prisma.business.update({
      where: { id: alphabeticClub.business.id },
      data: { name: 'Directory Alpha Club', slug: alphaSlug },
    });
    await prisma.business.update({
      where: { id: unavailableClub.business.id },
      data: { name: 'Directory Hidden Club', slug: hiddenSlug },
    });
    await prisma.business.update({
      where: { id: privateDemoClub.business.id },
      data: { name: 'Directory Private Demo Club', slug: demoSlug, isDemo: true },
    });
    await prisma.business.update({
      where: { id: legacyClub.business.id },
      data: { name: 'Directory Legacy Club', slug: legacySlug, legacyReadOnly: true },
    });
    await prisma.user.update({
      where: { id: unavailableClub.coachUser.id },
      data: { passwordHash: null },
    });

    await prisma.service.update({
      where: { id: club.service.id },
      data: { category: 'Tennis' },
    });
    await prisma.service.create({
      data: {
        businessId: club.business.id, name: 'Tennis clinic', category: ' tennis ',
        type: 'GROUP', capacity: 4, price: 5_000,
        locations: { create: {
          locationId: club.location.id, price: 4_500, duration: 60,
          instructors: { create: { instructorId: club.instructor.id } },
        } },
      },
    });
    const secondLocation = await prisma.location.create({
      data: { businessId: club.business.id, name: 'Directory Second Court', active: true },
    });
    const secondCoach = await createAccount(club, {
      name: 'Directory Second Coach',
      email: `directory-coach-${randomUUID()}@example.test`,
      accountType: 'COACH',
    });
    const secondInstructor = await prisma.instructor.create({
      data: { businessId: club.business.id, name: secondCoach.name, initials: 'DS' },
    });
    await prisma.membership.create({
      data: { userId: secondCoach.id, businessId: club.business.id, instructorId: secondInstructor.id },
    });
    await prisma.service.create({
      data: {
        businessId: club.business.id, name: 'Badminton fundamentals', category: 'Badminton',
        type: 'GROUP', capacity: 4, price: 4_000,
        locations: { create: {
          locationId: secondLocation.id, price: 3_000, duration: 60,
          instructors: { create: { instructorId: secondInstructor.id } },
        } },
      },
    });

    const historicalSolo = await prisma.$transaction(async tx => {
      const business = await tx.business.create({
        data: {
          name: 'Directory Historical Solo Practice', slug: soloSlug,
          ownerName: club.coachUser.name, email: club.coachUser.email,
          kind: 'SOLO', legacyReadOnly: true,
        },
      });
      const instructor = await tx.instructor.create({
        data: {
          businessId: business.id, name: club.coachUser.name, initials: 'DS',
          email: club.coachUser.email,
        },
      });
      await tx.membership.create({
        data: { businessId: business.id, userId: club.coachUser.id, instructorId: instructor.id },
      });
      const location = await tx.location.create({
        data: { businessId: business.id, name: 'Solo Court' },
      });
      await tx.service.create({
        data: {
          businessId: business.id, name: 'Solo tennis', category: 'Tennis',
          locations: { create: {
            locationId: location.id, price: 2_000, duration: 60,
            instructors: { create: { instructorId: instructor.id } },
          } },
        },
      });
      return business;
    });
    tenants.own(historicalSolo.id);

    const cookie = await studentCookie();
    const entries: Array<Record<string, any>> = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = pagePrefix;
    do {
      const page = await request(app).get('/api/account/clubs')
        .query({ cursor, limit: 1 }).set('Cookie', cookie).expect(200);
      entries.push(...page.body.clubs);
      cursor = page.body.nextCursor;
      if (cursor) {
        expect(seenCursors.has(cursor)).toBe(false);
        seenCursors.add(cursor);
      }
    } while (cursor);
    expect(cursor).toBeNull();
    const ownEntries = entries.filter(entry => [alphaSlug, zebraSlug].includes(entry.business.slug));

    expect(ownEntries.map((entry: { business: { name: string } }) => entry.business.name))
      .toEqual(['Directory Alpha Club', 'Directory Zebra Club']);
    const zebra = ownEntries[1];
    expect(zebra).toMatchObject({
      business: {
        name: 'Directory Zebra Club', slug: zebraSlug, kind: 'CLUB',
        tagline: 'Three racket sports.',
      },
      serviceCount: 3, coachCount: 2, locationCount: 2, priceFrom: 3_000,
    });
    expect(zebra.sports.map((sport: string) => sport.trim().toLocaleLowerCase()))
      .toEqual(['badminton', 'tennis']);
    expect(zebra.business).not.toHaveProperty('id');
    expect(zebra.business).not.toHaveProperty('email');
    expect(zebra.business).not.toHaveProperty('isDemo');
    expect(JSON.stringify(zebra)).not.toContain(club.instructor.id);
    expect(entries.some(entry => entry.business.slug === hiddenSlug)).toBe(false);
    expect(entries.some(entry => entry.business.slug === demoSlug)).toBe(false);
    expect(entries.some(entry => entry.business.slug === legacySlug)).toBe(false);
    expect(entries.some(entry => entry.business.slug === soloSlug)).toBe(false);
    expect(seenCursors.has(alphaSlug)).toBe(true);
    await request(app).get(`/api/public/${legacySlug}`).expect(404);
    await request(app).get(`/api/public/${soloSlug}`).expect(404);

    for (const entry of ownEntries) {
      await request(app).get(`/api/public/${entry.business.slug}`).expect(200);
    }
  });
});
