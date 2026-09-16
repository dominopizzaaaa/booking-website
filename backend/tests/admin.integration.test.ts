import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma, TestTenants, verifyTestDatabase } from './fixtures.js';

// The admin console is gated by a single ADMIN_PASSWORD held only in the host
// environment. config.adminPassword is read at request time, so the suite sets
// it directly rather than depending on process start-up order.
const PASSWORD = 'test-admin-password-123';
beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Platform admin console', () => {
  let tenants: TestTenants;
  const original = config.adminPassword;

  beforeEach(() => { config.adminPassword = PASSWORD; tenants = new TestTenants(); });
  afterEach(async () => { config.adminPassword = original; await tenants.cleanup(); });

  const signIn = async () => {
    const res = await request(app).post('/api/admin/login').send({ password: PASSWORD });
    expect(res.status).toBe(200);
    return res.headers['set-cookie'];
  };

  it('rejects the overview without a session and reports configuration state', async () => {
    const session = await request(app).get('/api/admin/session');
    expect(session.body).toMatchObject({ configured: true, authenticated: false });
    const denied = await request(app).get('/api/admin/overview');
    expect(denied.status).toBe(401);
  });

  it('rejects an incorrect password and rate-limits nothing on success', async () => {
    const wrong = await request(app).post('/api/admin/login').send({ password: 'nope' });
    expect(wrong.status).toBe(401);
    const cookie = await signIn();
    const authed = await request(app).get('/api/admin/session').set('Cookie', cookie);
    expect(authed.body).toMatchObject({ authenticated: true });
  });

  it('returns platform totals and can permanently delete a business with all children', async () => {
    const f = await tenants.fixture();
    const cookie = await signIn();

    const overview = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(overview.status).toBe(200);
    expect(overview.body.totals.businesses).toBeGreaterThanOrEqual(1);

    const list = await request(app).get('/api/admin/businesses').query({ search: f.business.slug }).set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.businesses.some((b: { id: string }) => b.id === f.business.id)).toBe(true);

    const del = await request(app).delete(`/api/admin/businesses/${f.business.id}`).set('Cookie', cookie);
    expect(del.status).toBe(200);
    expect(await prisma.business.count({ where: { id: f.business.id } })).toBe(0);
  });

  it('purges only demo workspaces and leaves real providers intact', async () => {
    const real = await tenants.fixture();
    const demoId = `courtly-test-demo-${real.business.id}`;
    tenants.own(demoId);
    await prisma.business.create({ data: { id: demoId, slug: demoId, name: 'Demo co', ownerName: 'Demo', email: `${demoId}@example.test`, isDemo: true } });

    const cookie = await signIn();
    const purge = await request(app).post('/api/admin/purge-demos').set('Cookie', cookie);
    expect(purge.status).toBe(200);
    expect(purge.body.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.business.count({ where: { id: demoId } })).toBe(0);
    expect(await prisma.business.count({ where: { id: real.business.id } })).toBe(1);
  });

  it('treats a session as invalid once the password is rotated', async () => {
    const cookie = await signIn();
    config.adminPassword = 'a-different-password-entirely';
    const res = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });
});
