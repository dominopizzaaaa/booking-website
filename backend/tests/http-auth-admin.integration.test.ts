import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { createAccount, createSession, prisma, TestTenants, verifyTestDatabase } from './fixtures.js';
import { currentSignupAcceptance } from './helpers/legal.js';

const originalConfig = {
  adminPassword: config.adminPassword,
  demoEnabled: config.demoEnabled,
  familyFeatureEnabled: config.familyFeatureEnabled,
  googleMapsApiKey: config.googleMapsApiKey,
  realBusinessDeletionEnabled: config.realBusinessDeletionEnabled,
};

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('HTTP, authentication, and admin boundaries', () => {
  let tenants: TestTenants;
  const adultDateOfBirth = '1990-01-01';
  const dateYearsAgo = (years: number) => DateTime.now().setZone('Asia/Singapore').minus({ years }).toISODate()!;
  const adultCapabilities = {
    ordinaryAccess: true, familyManagement: true, payments: true, staffAccess: true,
    directory: true, chat: true, commerce: true, rentals: true, calendar: true,
    workspace: true, profileEdit: true,
  };

  beforeEach(() => {
    tenants = new TestTenants();
  });

  afterEach(async () => {
    config.adminPassword = originalConfig.adminPassword;
    config.demoEnabled = originalConfig.demoEnabled;
    config.familyFeatureEnabled = originalConfig.familyFeatureEnabled;
    config.googleMapsApiKey = originalConfig.googleMapsApiKey;
    config.realBusinessDeletionEnabled = originalConfig.realBusinessDeletionEnabled;
    await tenants.cleanup();
  });

  async function credentialedStudent(dateOfBirth: string | null) {
    const identity = randomUUID().replace(/-/g, '');
    const email = `${identity}@example.test`;
    const password = 'Courtly-legacy-child-123';
    const user = await prisma.user.create({
      data: {
        name: 'Legacy Child', legalName: 'Legacy Child', username: `legacy_${identity.slice(0, 18)}`,
        email, passwordHash: await bcrypt.hash(password, 4), accountType: 'STUDENT',
        dateOfBirth: dateOfBirth ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null,
        profileVisibility: 'CLUBS_ONLY',
      },
    });
    tenants.ownUser(user.id);
    const agent = request.agent(app);
    const login = await agent.post('/api/auth/login').send({ email, password }).expect(200);
    return { agent, login, user };
  }

  it('reports a connected database and the configured venue-search capability', async () => {
    config.googleMapsApiKey = '';
    const keyless = await request(app).get('/api/health').expect(200);
    expect(keyless.headers['cache-control']).toBe('no-store');
    expect(keyless.body).toEqual({
      ok: true,
      service: 'courtly',
      database: 'connected',
      schema: 'ready',
      accountModel: 'student-coach-club-affiliations',
      capabilities: {
        accountProfile: true,
        rescheduleRequests: true,
        coachAcceptance: true,
        paymentReversal: true,
        integrityFlags: true,
        simulatedStripe: config.payments.mode === 'simulated',
        packageMarketplace: true,
        venueRentals: true,
        accountDirectory: true,
        sessionChat: true,
        accountChat: true,
        accountSecurity: config.accountSecurityKeys.enabled
          ? (config.email.enabled ? 'configured' : 'recovery-disabled')
          : 'disabled',
        namedClubStaff: true,
        bookingSeries: true,
        operationalInbox: true,
        bookingExport: true,
        payments: config.payments.mode,
        transactionalEmail: config.email.enabled ? 'configured' : 'disabled',
        family: config.familyFeatureEnabled ? 'enabled' : 'disabled',
        familyHandover: config.email.enabled && config.familyHandoverTokens.enabled
          ? 'configured'
          : 'disabled',
        venueSearch: 'maps-link',
        googleCalendar: 'disabled',
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
    await prisma.authSession.update({
      where: { id: club.session.id },
      data: { recentAuthAt: null },
    });

    const reused = await request(app).post('/api/auth/demo')
      .set('Cookie', club.cookie).send({}).expect(200);
    expect(reused.body).toMatchObject({
      user: { id: club.user.id },
      membership: { id: club.membership.id },
      business: { id: club.business.id, isDemo: false },
    });
    expect(await prisma.authSession.count({ where: { userId: club.user.id } })).toBe(1);
    // Entering the demo route while already signed in to a real account must
    // not become a passwordless recent-authentication bypass.
    expect((await prisma.authSession.findFirstOrThrow({ where: { userId: club.user.id } })).recentAuthAt).toBeNull();

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
      name: 'Missing Type', username: `missing_${randomUUID().slice(0, 8)}`, email: missingTypeEmail, password,
    }).expect(400);
    expect(missingType.body.error).toBeTruthy();

    const missingClubNameEmail = `${randomUUID()}@example.test`;
    const missingClubName = await request(app).post('/api/auth/register').send({
      accountType: 'CLUB', name: 'Club Contact', username: `club_${randomUUID().slice(0, 8)}`,
      email: missingClubNameEmail, password, ...currentSignupAcceptance,
    }).expect(400);
    expect(missingClubName.body.error).toBe('A club or academy name is required');

    const unknownRegistrationEmail = `${randomUUID()}@example.test`;
    await request(app).post('/api/auth/register').send({
      accountType: 'STUDENT', name: 'Strict Registration', username: `strict_${randomUUID().slice(0, 8)}`,
      email: unknownRegistrationEmail, password, dateOfBirth: adultDateOfBirth,
      ...currentSignupAcceptance, businessKind: 'SOLO',
    }).expect(400);
    expect(await prisma.user.count({
      where: { email: { in: [missingTypeEmail, missingClubNameEmail, unknownRegistrationEmail] } },
    })).toBe(0);

    const email = `${randomUUID()}@example.test`;
    const username = `http_${randomUUID().slice(0, 8)}`;
    const registered = await request(app).post('/api/auth/register').send({
      accountType: 'STUDENT', name: 'HTTP Student', username: username.toUpperCase(),
      email: email.toUpperCase(), password, dateOfBirth: adultDateOfBirth, ...currentSignupAcceptance,
    }).expect(201);
    tenants.ownUser(registered.body.user.id);
    expect(registered.body.user).toMatchObject({
      username, email, accountType: 'STUDENT', dateOfBirth: adultDateOfBirth,
      ageBand: 'ADULT', needsAgeReview: false, requiredAction: null, accountActionRequired: false,
    });
    expect(registered.body.user.capabilities).toEqual(adultCapabilities);
    expect(registered.body.user).not.toHaveProperty('emailVerifiedAt');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: registered.body.user.id } })).emailVerifiedAt)
      .toBeNull();

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

  it.each(['STUDENT', 'COACH'] as const)(
    'requires a date of birth when registering a %s account', async accountType => {
      const email = `${accountType.toLowerCase()}-missing-dob-${randomUUID()}@example.test`;
      const response = await request(app).post('/api/auth/register').send({
        accountType, name: `${accountType} Missing DOB`,
        username: `missing_${randomUUID().slice(0, 8)}`, email, password: 'Courtly-missing-dob-123',
        ...currentSignupAcceptance,
      }).expect(400);
      expect(response.body.error).toBe('Date of birth is required');
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    },
  );

  it.each([
    ['pre-1900', '1899-12-31', 'Date of birth must be a valid date and cannot be in the future'],
    ['malformed', '1990-1-01', 'Date of birth must use YYYY-MM-DD'],
    ['impossible', '2000-02-30', 'Date of birth must be a valid date and cannot be in the future'],
    ['future', '2999-01-01', 'Date of birth must be a valid date and cannot be in the future'],
  ])('rejects a %s personal registration date of birth', async (_case, dateOfBirth, error) => {
    const email = `invalid-dob-${randomUUID()}@example.test`;
    const response = await request(app).post('/api/auth/register').send({
      accountType: 'STUDENT', name: 'Invalid DOB', username: `invalid_${randomUUID().slice(0, 8)}`,
      email, password: 'Courtly-invalid-dob-123', dateOfBirth, ...currentSignupAcceptance,
    }).expect(400);
    expect(response.body.error).toBe(error);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it.each(['STUDENT', 'COACH'] as const)(
    'returns the stable parent-account requirement for an under-13 %s registration', async accountType => {
      const email = `child-${accountType.toLowerCase()}-${randomUUID()}@example.test`;
      const response = await request(app).post('/api/auth/register').send({
        accountType, name: 'Under Thirteen', username: `child_${randomUUID().slice(0, 8)}`,
        email, password: 'Courtly-child-register-123', dateOfBirth: dateYearsAgo(10),
        ...currentSignupAcceptance,
      }).expect(400);
      expect(response.body).toEqual({
        error: 'A parent or guardian must create and manage this child account',
        code: 'PARENT_ACCOUNT_REQUIRED',
      });
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    },
  );

  it('keeps club accounts DOB-free and serializes their account policy', async () => {
    const rejectedEmail = `club-dob-${randomUUID()}@example.test`;
    const rejected = await request(app).post('/api/auth/register').send({
      accountType: 'CLUB', businessName: 'DOB Club', name: 'Club Contact',
      username: `club_${randomUUID().slice(0, 8)}`, email: rejectedEmail,
      password: 'Courtly-club-dob-123', dateOfBirth: adultDateOfBirth, ...currentSignupAcceptance,
    }).expect(400);
    expect(rejected.body.error).toBe('Club accounts do not have a date of birth');
    expect(await prisma.user.findUnique({ where: { email: rejectedEmail } })).toBeNull();

    const email = `club-no-dob-${randomUUID()}@example.test`;
    const registered = await request(app).post('/api/auth/register').send({
      accountType: 'CLUB', businessName: 'No DOB Academy', name: 'Club Contact',
      username: `club_${randomUUID().slice(0, 8)}`, email, password: 'Courtly-club-no-dob-123',
      ...currentSignupAcceptance,
    }).expect(201);
    tenants.own(registered.body.business.id);
    tenants.ownUser(registered.body.user.id);
    expect(registered.body.user).toMatchObject({
      accountType: 'CLUB', dateOfBirth: null, ageBand: 'UNKNOWN', needsAgeReview: false,
      requiredAction: null, accountActionRequired: false,
    });
    expect(registered.body.user.capabilities).toEqual({
      ...adultCapabilities, familyManagement: false, calendar: false,
    });
    expect(registered.body.user).not.toHaveProperty('emailVerifiedAt');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: registered.body.user.id } })).emailVerifiedAt)
      .toBeNull();
  });

  it('flags an unknown-DOB legacy personal account for age review without removing established access', async () => {
    const { agent, user } = await credentialedStudent(null);
    const account = await agent.get('/api/auth/me').expect(200);
    expect(account.body.user).toMatchObject({
      id: user.id, accountType: 'STUDENT', dateOfBirth: null, ageBand: 'UNKNOWN',
      needsAgeReview: true, requiredAction: null, accountActionRequired: false,
    });
    expect(account.body.user.capabilities).toEqual(adultCapabilities);
  });

  it('removes Family from the authenticated capability contract while the deployment gate is closed', async () => {
    const { agent } = await credentialedStudent(adultDateOfBirth);

    config.familyFeatureEnabled = false;
    const disabled = await agent.get('/api/auth/me').expect(200);
    expect(disabled.body.user.capabilities).toEqual({
      ...adultCapabilities, familyManagement: false,
    });

    config.familyFeatureEnabled = true;
    const enabled = await agent.get('/api/auth/me').expect(200);
    expect(enabled.body.user.capabilities.familyManagement).toBe(true);
  });

  it('gates every embedded account route for a credentialed under-13 SELF legacy row', async () => {
    const dateOfBirth = dateYearsAgo(10);
    const { agent, login, user } = await credentialedStudent(dateOfBirth);
    expect(login.body.user).toMatchObject({
      id: user.id, dateOfBirth, ageBand: 'CHILD', needsAgeReview: false,
      requiredAction: 'PARENT_ACCOUNT_REQUIRED', accountActionRequired: true,
      capabilities: { ordinaryAccess: false, commerce: false, directory: false, profileEdit: true },
    });

    const missingParticipant = randomUUID();
    const missingRequest = randomUUID();
    const routes = [
      ['club directory', () => agent.get('/api/account/clubs').query({ limit: 0 })],
      ['new booking', () => agent.post(`/api/public/missing-${randomUUID()}/bookings`).send({ unexpected: true })],
      ['booking history', () => agent.get('/api/account/bookings').query({ unexpected: true })],
      ['booking cancellation', () => agent.post(`/api/account/bookings/${missingParticipant}/cancel`).send({ unexpected: true })],
      ['reschedule proposal', () => agent.post(`/api/account/bookings/${missingParticipant}/reschedule-requests`).send({})],
      ['reschedule acceptance', () => agent.post(`/api/account/reschedule-requests/${missingRequest}/accept`).send({ unexpected: true })],
      ['reschedule decline', () => agent.post(`/api/account/reschedule-requests/${missingRequest}/decline`).send({ unexpected: true })],
      ['notification preferences read', () => agent.get('/api/account/notification-preferences')],
      ['notification preferences update', () => agent.patch('/api/account/notification-preferences').send({ unexpected: true })],
    ] as const;
    for (const [label, call] of routes) {
      const response = await call();
      expect(response.status, label).toBe(403);
      expect(response.body, label).toEqual({
        error: 'Account action is required before continuing',
        code: 'ACCOUNT_ACTION_REQUIRED', reason: 'PARENT_ACCOUNT_REQUIRED',
      });
    }
    expect(await prisma.notificationPreference.findUnique({ where: { userId: user.id } })).toBeNull();
  });

  it('allows teen account access but blocks a new commercial booking at the capability gate', async () => {
    const email = `teen-${randomUUID()}@example.test`;
    const dateOfBirth = dateYearsAgo(15);
    const agent = request.agent(app);
    const registered = await agent.post('/api/auth/register').send({
      accountType: 'STUDENT', name: 'Teen Student', username: `teen_${randomUUID().slice(0, 8)}`,
      email, password: 'Courtly-teen-register-123', dateOfBirth, ...currentSignupAcceptance,
    }).expect(201);
    tenants.ownUser(registered.body.user.id);
    expect(registered.body.user).toMatchObject({
      dateOfBirth, profileVisibility: 'PRIVATE', ageBand: 'TEEN', needsAgeReview: false,
      requiredAction: null, accountActionRequired: false,
    });
    expect(registered.body.user.capabilities).toEqual({
      ordinaryAccess: true, familyManagement: false, payments: false, staffAccess: false,
      directory: true, chat: true, commerce: false, rentals: false, calendar: true,
      workspace: false, profileEdit: true,
    });
    const denied = await agent.post(`/api/public/missing-${randomUUID()}/bookings`)
      .send({ unexpected: true }).expect(403);
    expect(denied.body).toEqual({
      error: 'This account cannot perform that action', code: 'CAPABILITY_REQUIRED',
      reason: null, capability: 'commerce',
    });
  });

  it('does not expose the retired solo-practice route', async () => {
    const club = await tenants.fixture();
    await request(app).post('/api/auth/practice')
      .set('Cookie', club.cookie).send({ name: 'Club Practice' }).expect(404);
    expect(await prisma.business.count({
      where: { kind: 'SOLO', memberships: { some: { userId: club.user.id } } },
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
    config.realBusinessDeletionEnabled = false;
    const agent = request.agent(app);

    await agent.post('/api/admin/login').send({
      password: config.adminPassword, remember: true,
    }).expect(400);

    const login = await agent.post('/api/admin/login').send({ password: config.adminPassword }).expect(200);
    expect(login.body).toEqual({ ok: true, authMode: 'legacy', operator: null });
    expect((await agent.get('/api/admin/session').expect(200)).body).toEqual({
      configured: true, authenticated: true, authMode: 'legacy', operator: null, sensitiveAccess: false,
      businessDeletionMode: 'demo-only',
    });

    const logout = await agent.post('/api/admin/logout').send({}).expect(200);
    expect(logout.body).toEqual({ ok: true });
    expect(logout.headers['set-cookie']?.join(';')).toContain(`${config.adminCookie}=;`);
    expect((await agent.get('/api/admin/session').expect(200)).body).toEqual({
      configured: true, authenticated: false, authMode: 'legacy', operator: null, sensitiveAccess: false,
      businessDeletionMode: 'demo-only',
    });
  });
});
