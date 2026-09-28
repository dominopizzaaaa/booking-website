import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('operations inbox', () => {
  let tenants: TestTenants;
  let fixture: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  it('returns exact counts and stable keyset pages beyond the former per-category cap', async () => {
    const other = await tenants.fixture();
    const startAt = fixture.starts.plus({ days: 1 }).toJSDate();
    const endAt = fixture.starts.plus({ days: 1, hours: 1 }).toJSDate();
    const ids = Array.from({ length: 105 }, (_, index) => `ops-page-${index.toString().padStart(3, '0')}`);
    const booking = (target: Fixture, id: string) => ({
      id, businessId: target.business.id, serviceId: target.service.id, instructorId: target.instructor.id,
      locationId: target.location.id, startAt, endAt, duration: 60, status: 'PENDING',
      type: 'PRIVATE', capacity: 1, price: 8_000, coachAcceptance: 'PENDING',
    });
    await prisma.booking.createMany({ data: ids.map(id => booking(fixture, id)) });
    await prisma.booking.createMany({
      data: Array.from({ length: 7 }, (_, index) => booking(other, `ops-other-${index.toString().padStart(3, '0')}`)),
    });

    const fetchPage = async (cursor?: string) => {
      const response = await request(app).get('/api/operations/inbox')
        .query({ category: 'coach', limit: 40, ...(cursor ? { cursor } : {}) })
        .set('Cookie', fixture.cookie).expect(200);
      return response.body as {
        items: Array<{ id: string }>; nextCursor: string | null;
        counts: Record<string, number>;
      };
    };

    const first = await fetchPage();
    expect(first.counts).toEqual({
      all: 105, coach: 105, venue: 0, attendance: 0, reschedule: 0, payment: 0, rental: 0,
    });
    expect(first.items.map(item => item.id)).toEqual(ids.slice(0, 40).map(id => `coach-acceptance:${id}`));
    expect(first.nextCursor).toEqual(expect.any(String));

    const [second, repeatedSecond] = await Promise.all([
      fetchPage(first.nextCursor!),
      fetchPage(first.nextCursor!),
    ]);
    expect(repeatedSecond).toEqual(second);
    expect(second.counts).toEqual(first.counts);
    expect(second.items.map(item => item.id)).toEqual(ids.slice(40, 80).map(id => `coach-acceptance:${id}`));

    const third = await fetchPage(second.nextCursor!);
    expect(third.items.map(item => item.id)).toEqual(ids.slice(80).map(id => `coach-acceptance:${id}`));
    expect(third.nextCursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map(item => item.id))
      .toEqual(ids.map(id => `coach-acceptance:${id}`));
  });
});
