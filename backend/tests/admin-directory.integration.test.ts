import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { TestTenants, createStudent, prisma, verifyTestDatabase, type Fixture } from './fixtures.js';

const PASSWORD = 'test-admin-directory-password';
beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('The platform business directory', () => {
  let tenants: TestTenants;
  let f: Fixture;
  let cookie: string[];
  const original = config.adminPassword;

  beforeEach(async () => {
    config.adminPassword = PASSWORD;
    tenants = new TestTenants();
    f = await tenants.fixture();
    const signIn = await request(app).post('/api/admin/login').send({ password: PASSWORD });
    expect(signIn.status).toBe(200);
    cookie = signIn.headers['set-cookie'] as unknown as string[];
  });

  afterEach(async () => {
    config.adminPassword = original;
    await tenants.cleanup();
  });

  const list = (query: Record<string, string> = {}) =>
    request(app).get('/api/admin/businesses').set('Cookie', cookie).query(query);

  const slugs = (body: { businesses: Array<{ slug: string }> }) => body.businesses.map(b => b.slug);

  it('finds a business by name, owner, email or slug, ignoring case', async () => {
    const marker = randomUUID().slice(0, 12);
    const business = await prisma.business.update({
      where: { id: f.business.id },
      data: {
        name: `Kallang ${marker} Academy`, ownerName: `Owner ${marker}`,
        email: `${marker}@directory.test`, slug: `slug-${marker}`,
      },
    });
    for (const search of [
      `Kallang ${marker}`, `owner ${marker}`.toUpperCase(), `${marker}@directory.test`, `SLUG-${marker}`,
    ]) {
      const response = await list({ search });
      expect(response.status, search).toBe(200);
      expect(slugs(response.body), search).toContain(business.slug);
    }
  });

  it('returns nothing rather than everything when a search matches no one', async () => {
    const response = await list({ search: `no-such-business-${randomUUID()}` });
    expect(response.status).toBe(200);
    expect(response.body.businesses).toEqual([]);
  });

  it('separates demo workspaces from real ones', async () => {
    const demo = await tenants.fixture();
    await prisma.business.update({ where: { id: demo.business.id }, data: { isDemo: true } });

    const all = await list({ filter: 'all' });
    expect(slugs(all.body)).toEqual(expect.arrayContaining([f.business.slug, demo.business.slug]));

    const real = await list({ filter: 'real' });
    expect(slugs(real.body)).toContain(f.business.slug);
    expect(slugs(real.body)).not.toContain(demo.business.slug);

    const demos = await list({ filter: 'demo' });
    expect(slugs(demos.body)).toContain(demo.business.slug);
    expect(slugs(demos.body)).not.toContain(f.business.slug);
  });

  it('applies the search and the filter together', async () => {
    const marker = randomUUID().slice(0, 12);
    const demo = await tenants.fixture();
    await prisma.business.update({
      where: { id: demo.business.id }, data: { isDemo: true, name: `Shared ${marker}` },
    });
    await prisma.business.update({ where: { id: f.business.id }, data: { name: `Shared ${marker}` } });

    expect(slugs((await list({ search: marker, filter: 'all' })).body)).toHaveLength(2);
    expect(slugs((await list({ search: marker, filter: 'demo' })).body)).toEqual([demo.business.slug]);
    expect(slugs((await list({ search: marker, filter: 'real' })).body)).toEqual([f.business.slug]);
  });

  it('defaults to every business and refuses an unknown filter', async () => {
    expect((await list()).status).toBe(200);
    const unknown = await list({ filter: 'archived' });
    expect(unknown.status).toBe(400);
  });

  it('reports the size of each workspace without exposing its records', async () => {
    await createStudent(f, { name: 'Directory Student' });
    const response = await list({ search: f.business.slug });
    const entry = response.body.businesses.find((b: { slug: string }) => b.slug === f.business.slug);
    expect(entry).toMatchObject({
      id: f.business.id, ownerName: f.business.ownerName, currency: 'SGD', timezone: 'Asia/Singapore', isDemo: false,
    });
    expect(entry.counts).toMatchObject({ users: 2, students: 1, bookings: 0, locations: 1, services: 1, instructors: 1 });
    expect(entry).not.toHaveProperty('_count');
    // The directory is a size and health view, not a data export.
    for (const field of ['students', 'bookings', 'payments', 'memberships']) {
      expect(Array.isArray(entry[field])).toBe(false);
    }
  });

  it('lists the newest workspace first', async () => {
    const newer = await tenants.fixture();
    const response = await list();
    const order = slugs(response.body);
    expect(order.indexOf(newer.business.slug)).toBeLessThan(order.indexOf(f.business.slug));
  });

  it('refuses the directory without an admin session and once the password rotates', async () => {
    expect((await request(app).get('/api/admin/businesses')).status).toBe(401);
    config.adminPassword = 'a-different-admin-password';
    expect((await list()).status).toBe(401);
  });

  it('refuses a search longer than the console can send', async () => {
    expect((await list({ search: 'x'.repeat(121) })).status).toBe(400);
    expect((await list({ search: 'x'.repeat(120) })).status).toBe(200);
  });

  it('reports a business that no longer exists rather than silently succeeding', async () => {
    const response = await request(app)
      .delete(`/api/admin/businesses/${randomUUID()}`).set('Cookie', cookie);
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Business not found');
  });

  // A club account is the club, not a portable person, so deleting the club
  // must take its login with it rather than leave one that opens nothing.
  it('removes the institutional login along with the club it is', async () => {
    const doomed = await tenants.fixture();
    const response = await request(app)
      .delete(`/api/admin/businesses/${doomed.business.id}`).set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(await prisma.business.count({ where: { id: doomed.business.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: doomed.user.id } })).toBe(0);
    // The coach keeps their own portable account and simply loses this club.
    expect(await prisma.user.count({ where: { id: doomed.coachUser.id } })).toBe(1);
    expect(await prisma.membership.count({ where: { businessId: doomed.business.id } })).toBe(0);
  });

  it('counts the platform the same way the directory lists it', async () => {
    const overview = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(overview.status).toBe(200);
    const { totals } = overview.body;
    expect(totals.businesses).toBe(totals.realBusinesses + totals.demoBusinesses);
    expect(totals.realBusinesses).toBe(await prisma.business.count({ where: { isDemo: false } }));
    expect(totals.demoBusinesses).toBe(await prisma.business.count({ where: { isDemo: true } }));
    expect(Date.parse(overview.body.generatedAt)).not.toBeNaN();
  });
});
