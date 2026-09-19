import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { createAccount, createSession, prisma, TestTenants, verifyTestDatabase } from './fixtures.js';

const originalConfig = {
  adminPassword: config.adminPassword,
  demoEnabled: config.demoEnabled,
  googleMapsApiKey: config.googleMapsApiKey,
};

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('HTTP, authentication, and admin boundaries', () => {
  let tenants: TestTenants;

  beforeEach(() => {
    tenants = new TestTenants();
  });

  afterEach(async () => {
    config.adminPassword = originalConfig.adminPassword;
    config.demoEnabled = originalConfig.demoEnabled;
    config.googleMapsApiKey = originalConfig.googleMapsApiKey;
    await tenants.cleanup();
  });

  it('reports a connected database and the configured venue-search capability', async () => {
    config.googleMapsApiKey = '';
    const keyless = await request(app).get('/api/health').expect(200);
    expect(keyless.headers['cache-control']).toBe('no-store');
    expect(keyless.body).toEqual({
      ok: true,
      service: 'courtly',
      database: 'connected',
      accountModel: 'student-coach-club-affiliations',
      capabilities: {
        accountProfile: true,
        rescheduleRequests: true,
        coachAcceptance: true,
        paymentReversal: true,
        integrityFlags: true,
        venueSearch: 'maps-link',
      },
    });

    config.googleMapsApiKey = 'test-google-maps-key';
    const configured = await request(app).get('/api/health').expect(200);
    expect(configured.body.capabilities.venueSearch).toBe('google-places');
  });

  it('returns stable JSON errors for missing routes and invalid request encodings', async () => {
    const missing = await request(app).get('/not-a-courtly-route').expect(404);
    expect(missing.body).toEqual({ error: 'Route not found' });

    const malformed = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(malformed.body).toEqual({ error: 'Invalid JSON request body' });

    const nonJson = await request(app)
      .post('/api/auth/logout')
      .set('Content-Type', 'text/plain')
      .send('logout')
      .expect(415);
    expect(nonJson.body).toEqual({ error: 'Use application/json' });
  });

  it('rejects disallowed mutation origins and origin-less cross-site mutations', async () => {
    const disallowedOrigin = await request(app)
      .post('/api/auth/logout')
      .set('Origin', 'https://attacker.invalid')
      .send({})
      .expect(403);
    expect(disallowedOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect(disallowedOrigin.body).toEqual({ error: 'Request origin is not allowed' });

    const crossSite = await request(app)
      .post('/api/auth/logout')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({})
      .expect(403);
    expect(crossSite.body).toEqual({ error: 'Cross-site requests are not allowed' });
  });

  it('reuses one demo session and revokes it on logout', async () => {
    config.demoEnabled = true;
    const club = await tenants.fixture();

    const reused = await request(app).post('/api/auth/demo')
      .set('Cookie', club.cookie).send({}).expect(200);
    expect(reused.body).toMatchObject({
      user: { id: club.user.id },
      membership: { id: club.membership.id },
      business: { id: club.business.id, isDemo: false },
    });
    expect(await prisma.authSession.count({ where: { userId: club.user.id } })).toBe(1);

    const logout = await request(app).post('/api/auth/logout')
      .set('Cookie', club.cookie).send({}).expect(200);
    expect(logout.body).toEqual({ ok: true });
    expect(logout.headers['set-cookie']?.join(';')).toContain(`${config.sessionCookie}=;`);
    await request(app).get('/api/auth/me').set('Cookie', club.cookie).expect(401);
    expect(await prisma.authSession.count({ where: { userId: club.user.id } })).toBe(0);
  });

  it('validates registration and login bodies without accepting unknown fields', async () => {
    const password = 'Courtly-http-test-123';
    const missingTypeEmail = `${randomUUID()}@example.test`;
    const missingType = await request(app).post('/api/auth/register').send({
      name: 'Missing Type', email: missingTypeEmail, password,
    }).expect(400);
    expect(missingType.body.error).toBeTruthy();

    const missingClubNameEmail = `${randomUUID()}@example.test`;
    const missingClubName = await request(app).post('/api/auth/register').send({
      accountType: 'CLUB', name: 'Club Contact', email: missingClubNameEmail, password,
    }).expect(400);
    expect(missingClubName.body.error).toBe('A club or academy name is required');

    const unknownRegistrationEmail = `${randomUUID()}@example.test`;
    await request(app).post('/api/auth/register').send({
      accountType: 'STUDENT', name: 'Strict Registration', email: unknownRegistrationEmail, password,
      businessKind: 'SOLO',
    }).expect(400);
    expect(await prisma.user.count({
      where: { email: { in: [missingTypeEmail, missingClubNameEmail, unknownRegistrationEmail] } },
    })).toBe(0);

    const email = `${randomUUID()}@example.test`;
    const registered = await request(app).post('/api/auth/register').send({
      accountType: 'STUDENT', name: 'HTTP Student', email: email.toUpperCase(), password,
    }).expect(201);
    tenants.ownUser(registered.body.user.id);
    expect(registered.body.user).toMatchObject({ email, accountType: 'STUDENT' });

    await request(app).post('/api/auth/login').send({
      email: 'not-an-email', password: 'short',
    }).expect(400);
    await request(app).post('/api/auth/login').send({
      email, password, remember: true,
    }).expect(400);
    const loggedIn = await request(app).post('/api/auth/login').send({
      email: email.toUpperCase(), password,
    }).expect(200);
    expect(loggedIn.body.user).toMatchObject({ id: registered.body.user.id, email });
  });

  it('denies solo-practice creation to student and club accounts', async () => {
    const club = await tenants.fixture();
    const student = await createAccount(club, {
      name: 'Practice Student', accountType: 'STUDENT',
      email: `${randomUUID()}@example.test`,
    });
    const studentSession = await createSession(club, student.id);

    const studentDenied = await request(app).post('/api/auth/practice')
      .set('Cookie', studentSession.cookie).send({ name: 'Student Practice' }).expect(403);
    expect(studentDenied.body.error).toBe('Only a coach account can run its own practice');

    const clubDenied = await request(app).post('/api/auth/practice')
      .set('Cookie', club.cookie).send({ name: 'Club Practice' }).expect(403);
    expect(clubDenied.body.error).toBe('Only a coach account can run its own practice');
    expect(await prisma.business.count({
      where: { kind: 'SOLO', memberships: { some: { userId: { in: [student.id, club.user.id] } } } },
    })).toBe(0);
  });

  it('keeps the workspace-switch alias identical to the canonical route', async () => {
    const first = await tenants.fixture();
    const second = await tenants.fixture();
    await prisma.membership.delete({ where: { id: second.coachMembership.id } });
    const destination = await prisma.membership.create({
      data: {
        userId: first.coachUser.id,
        businessId: second.business.id,
        instructorId: second.instructor.id,
      },
    });
    const canonicalSession = await createSession(first, first.coachUser.id, first.coachMembership.id);
    const aliasSession = await createSession(first, first.coachUser.id, first.coachMembership.id);

    const canonical = await request(app).post('/api/auth/switch-workspace')
      .set('Cookie', canonicalSession.cookie).send({ membershipId: destination.id }).expect(200);
    const alias = await request(app).post('/api/auth/workspace')
      .set('Cookie', aliasSession.cookie).send({ membershipId: destination.id }).expect(200);

    expect(alias.body).toEqual(canonical.body);
    expect(alias.body).toMatchObject({
      user: { id: first.coachUser.id, accountType: 'COACH' },
      membership: { id: destination.id, businessId: second.business.id },
      business: { id: second.business.id },
    });
    const selected = await prisma.authSession.findMany({
      where: { id: { in: [canonicalSession.session.id, aliasSession.session.id] } },
      select: { activeMembershipId: true },
    });
    expect(selected).toHaveLength(2);
    expect(selected.every(session => session.activeMembershipId === destination.id)).toBe(true);
  });

  it('requires a strict admin login body and clears the admin session on logout', async () => {
    config.adminPassword = 'http-admin-password-123';
    const agent = request.agent(app);

    await agent.post('/api/admin/login').send({
      password: config.adminPassword, remember: true,
    }).expect(400);

    const login = await agent.post('/api/admin/login').send({ password: config.adminPassword }).expect(200);
    expect(login.body).toEqual({ ok: true });
    expect((await agent.get('/api/admin/session').expect(200)).body).toEqual({
      configured: true, authenticated: true,
    });

    const logout = await agent.post('/api/admin/logout').send({}).expect(200);
    expect(logout.body).toEqual({ ok: true });
    expect(logout.headers['set-cookie']?.join(';')).toContain(`${config.adminCookie}=;`);
    expect((await agent.get('/api/admin/session').expect(200)).body).toEqual({
      configured: true, authenticated: false,
    });
  });
});
