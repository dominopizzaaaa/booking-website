import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { createStudent, prisma, TestTenants, verifyTestDatabase } from './fixtures.js';

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

  it('counts only active payments collected from students', async () => {
    const f = await tenants.fixture();
    const student = await createStudent(f, { name: 'Admin totals student' });
    const cookie = await signIn();
    const before = await request(app).get('/api/admin/overview').set('Cookie', cookie).expect(200);

    await prisma.payment.createMany({
      data: [
        {
          businessId: f.business.id, studentId: student.id, kind: 'STUDENT_TO_CLUB',
          amount: 1_250, method: 'CASH',
        },
        {
          businessId: f.business.id, studentId: student.id, kind: 'STUDENT_TO_CLUB',
          amount: 1_750, method: 'BANK_TRANSFER',
        },
        {
          businessId: f.business.id, studentId: student.id, kind: 'STUDENT_TO_CLUB',
          amount: 8_000, method: 'OTHER', reversedAt: new Date(),
          reversedReason: 'Test reversal',
        },
        {
          businessId: f.business.id, studentId: null, instructorId: f.instructor.id,
          kind: 'CLUB_TO_COACH', amount: 900, method: 'BANK_TRANSFER',
        },
      ],
    });

    const inserted = await prisma.payment.aggregate({
      where: {
        businessId: f.business.id,
        kind: { in: ['STUDENT_TO_CLUB', 'STUDENT_TO_COACH'] },
        reversedAt: null,
      },
      _count: true,
      _sum: { amount: true },
    });
    expect(inserted).toMatchObject({ _count: 2, _sum: { amount: 3_000 } });

    // Other integration files use the same test database in parallel. Retry
    // until their short-lived fixtures settle, then compare the endpoint with
    // the database definition of active student receipts.
    await expect.poll(async () => {
      const overview = await request(app).get('/api/admin/overview').set('Cookie', cookie).expect(200);
      const expected = await prisma.payment.aggregate({
        where: {
          kind: { in: ['STUDENT_TO_CLUB', 'STUDENT_TO_COACH'] },
          reversedAt: null,
        },
        _count: true,
        _sum: { amount: true },
      });
      return {
        endpointCount: overview.body.totals.paymentsCount,
        endpointTotal: overview.body.totals.paymentsTotal,
        databaseCount: expected._count,
        databaseTotal: expected._sum.amount ?? 0,
      };
    }).toSatisfy(result => result.endpointCount === result.databaseCount
      && result.endpointTotal === result.databaseTotal);
  });

  it('returns platform totals and can permanently delete a business with all children', async () => {
    const f = await tenants.fixture();
    const cookie = await signIn();
    await prisma.payment.create({
      data: {
        businessId: f.business.id, studentId: null, instructorId: f.instructor.id,
        kind: 'CLUB_TO_COACH', amount: 2_500, method: 'BANK_TRANSFER',
      },
    });

    const overview = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(overview.status).toBe(200);
    expect(overview.body.totals.businesses).toBeGreaterThanOrEqual(1);
    expect(overview.body.totals.users).toBeGreaterThanOrEqual(1);
    expect(overview.body.totals.memberships).toBeGreaterThanOrEqual(1);

    const list = await request(app).get('/api/admin/businesses').query({ search: f.business.slug }).set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect(list.body.businesses.some((b: { id: string }) => b.id === f.business.id)).toBe(true);

    const del = await request(app).delete(`/api/admin/businesses/${f.business.id}`).set('Cookie', cookie);
    expect(del.status).toBe(200);
    expect(await prisma.business.count({ where: { id: f.business.id } })).toBe(0);
    expect(await prisma.membership.count({ where: { id: f.membership.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: f.user.id } })).toBe(0);
    expect(await prisma.user.count({ where: { id: f.coachUser.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { businessId: f.business.id } })).toBe(0);

    // The institutional CLUB login is the business and is deleted with it; the
    // portable coach account survives and the fixture can remove it afterward.
    await tenants.cleanup();
    expect(await prisma.user.count({ where: { id: f.coachUser.id } })).toBe(0);
  });

  it('purges only demo workspaces and leaves real providers intact', async () => {
    const real = await tenants.fixture();
    const demoId = `courtly-test-demo-${real.business.id}`;
    const demoAccountId = `${demoId}-club-account`;
    tenants.own(demoId);
    tenants.ownUser(demoAccountId);
    await prisma.$transaction(async tx => {
      await tx.business.create({ data: { id: demoId, slug: demoId, name: 'Demo co', ownerName: 'Demo', email: `${demoId}@example.test`, isDemo: true } });
      await tx.user.create({ data: { id: demoAccountId, name: 'Demo co', email: `${demoAccountId}@example.test`, accountType: 'CLUB' } });
      await tx.membership.create({ data: { userId: demoAccountId, businessId: demoId } });
    });

    const cookie = await signIn();
    const purge = await request(app).post('/api/admin/purge-demos').set('Cookie', cookie);
    expect(purge.status).toBe(200);
    expect(purge.body.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.business.count({ where: { id: demoId } })).toBe(0);
    expect(await prisma.user.count({ where: { id: demoAccountId } })).toBe(0);
    expect(await prisma.business.count({ where: { id: real.business.id } })).toBe(1);
  });

  it('treats a session as invalid once the password is rotated', async () => {
    const cookie = await signIn();
    config.adminPassword = 'a-different-password-entirely';
    const res = await request(app).get('/api/admin/overview').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });
});
