import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { processCalendarDisconnects, processCalendarRevocations } from '../src/calendar-sync.js';
import { config } from '../src/config.js';
import { prisma, TestTenants, createAccount, createSession, verifyTestDatabase, type Fixture } from './fixtures.js';

const tenants = new TestTenants();
const originalCalendarConfig = { ...config.googleCalendar };

describe.sequential('Google Calendar account routes', () => {
  let fixture: Fixture;
  let studentCookie: string;
  let studentUserId: string;

  beforeAll(async () => {
    await verifyTestDatabase();
    fixture = await tenants.fixture();
    const student = await createAccount(fixture, { name: 'Calendar Student' });
    studentUserId = student.id;
    studentCookie = (await createSession(fixture, student.id)).cookie;
  });

  beforeEach(() => {
    Object.assign(config.googleCalendar, {
      enabled: true, clientId: 'client-id', clientSecret: 'client-secret',
      redirectUri: 'http://localhost:3000/api/calendar/google/callback', activeKeyId: 'route-test',
      keys: new Map([['route-test', Buffer.alloc(32, 9)]]),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.calendarOAuthAttempt.deleteMany();
    await prisma.calendarConnection.deleteMany({ where: { userId: studentUserId } });
    await prisma.calendarRevocationJob.deleteMany();
  });

  afterAll(async () => {
    Object.assign(config.googleCalendar, originalCalendarConfig);
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  it('returns a sanitized disconnected status for eligible and ineligible accounts', async () => {
    const student = await request(app).get('/api/calendar/connection').set('Cookie', studentCookie).expect(200);
    expect(student.body).toMatchObject({
      configured: true, eligible: true, provider: 'GOOGLE', state: 'DISCONNECTED', connected: false,
      syncEnabled: false, busyCheckEnabled: false,
    });
    const club = await request(app).get('/api/calendar/connection').set('Cookie', fixture.cookie).expect(200);
    expect(club.body).toMatchObject({ configured: true, eligible: false, provider: 'GOOGLE' });
    expect(JSON.stringify(student.body)).not.toMatch(/token|scope|cipher/i);
  });

  it('refuses club connections and rejects an unallowlisted return path', async () => {
    await request(app).post('/api/calendar/google/connect').set('Cookie', fixture.cookie)
      .send({ returnTo: '/account' }).expect(403);
    await request(app).post('/api/calendar/google/connect').set('Cookie', studentCookie)
      .send({ returnTo: '//attacker.invalid' }).expect(400);
  });

  it('stores only a state digest and an encrypted verifier bound to the user session', async () => {
    const response = await request(app).post('/api/calendar/google/connect').set('Cookie', studentCookie)
      .send({ returnTo: '/manage?tab=profile' }).expect(200);
    const authorization = new URL(response.body.authorizationUrl);
    const state = authorization.searchParams.get('state')!;
    const attempt = await prisma.calendarOAuthAttempt.findUniqueOrThrow({
      where: { stateDigest: createHash('sha256').update(state).digest('hex') },
    });
    expect(attempt.stateDigest).not.toBe(state);
    expect(attempt.codeVerifierCiphertext).toMatch(/^v1.route-test./);
    expect(attempt.returnTo).toBe('/manage?tab=profile');
    expect(attempt.expiresAt.getTime() - attempt.createdAt.getTime()).toBe(10 * 60_000);
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('accepts ordinary Google callback extras and consumes state before reporting a provider denial', async () => {
    const connected = await request(app).post('/api/calendar/google/connect').set('Cookie', studentCookie)
      .send({ returnTo: '/manage?tab=profile' }).expect(200);
    const state = new URL(connected.body.authorizationUrl).searchParams.get('state')!;
    const storedAttempt = await prisma.calendarOAuthAttempt.findUnique({
      where: { stateDigest: createHash('sha256').update(state).digest('hex') },
    });
    expect(storedAttempt).toMatchObject({ returnTo: '/manage?tab=profile', consumedAt: null });
    expect(storedAttempt?.authSessionId).toBe((await prisma.authSession.findFirstOrThrow({
      where: { userId: storedAttempt!.userId }, orderBy: { createdAt: 'desc' },
    })).id);
    const callback = await request(app).get('/api/calendar/google/callback').set('Cookie', studentCookie).query({
      state, error: 'access_denied', scope: 'openid', authuser: '0', prompt: 'consent', hd: 'example.test',
    }).expect(303);
    expect(await prisma.calendarOAuthAttempt.findUnique({
      where: { stateDigest: createHash('sha256').update(state).digest('hex') },
    })).toMatchObject({ returnTo: '/manage?tab=profile', consumedAt: expect.any(Date) });
    expect(callback.headers.location).toBe('http://localhost:3000/manage?tab=profile&calendar=error');
    const replay = await request(app).get('/api/calendar/google/callback').set('Cookie', studentCookie).query({
      state, error: 'access_denied',
    }).expect(303);
    expect(replay.headers.location).toBe('http://localhost:3000/account?calendar=error');
  });

  it('consumes a callback only in the browser session that started it', async () => {
    const connected = await request(app).post('/api/calendar/google/connect').set('Cookie', studentCookie)
      .send({ returnTo: '/manage?tab=profile' }).expect(200);
    const state = new URL(connected.body.authorizationUrl).searchParams.get('state')!;
    const account = await createAccount(fixture, { name: 'Other Calendar Student' });
    const other = await createSession(fixture, account.id);
    const wrong = await request(app).get('/api/calendar/google/callback').set('Cookie', other.cookie)
      .query({ state, error: 'access_denied' }).expect(303);
    expect(wrong.headers.location).toBe('http://localhost:3000/account?calendar=error');
    expect(await prisma.calendarOAuthAttempt.findUnique({
      where: { stateDigest: createHash('sha256').update(state).digest('hex') },
    })).toMatchObject({ consumedAt: null });
  });

  it('durably retries revocation when a newly issued grant belongs to a different Google account', async () => {
    await prisma.calendarConnection.create({
      data: {
        userId: studentUserId, providerAccountId: 'existing-google-account',
        providerEmail: 'existing@example.test', accessTokenCiphertext: 'retained-existing-ciphertext',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const connected = await request(app).post('/api/calendar/google/connect').set('Cookie', studentCookie)
      .send({ returnTo: '/account' }).expect(200);
    const state = new URL(connected.body.authorizationUrl).searchParams.get('state')!;
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/calendar.events',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: 'different-google-account', email: 'different@example.test',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'server_error' }), { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));

    const callback = await request(app).get('/api/calendar/google/callback').set('Cookie', studentCookie)
      .query({ state, code: 'authorization-code' }).expect(303);
    expect(callback.headers.location).toBe('http://localhost:3000/account?calendar=error');
    const cleanup = await prisma.calendarRevocationJob.findFirstOrThrow();
    expect(cleanup.tokenCiphertext).not.toContain('new-refresh-token');
    expect(cleanup).toMatchObject({ leaseToken: null, leasedUntil: null, lastErrorCode: 'PROVIDER_UNAVAILABLE' });
    expect(await prisma.calendarConnection.findUniqueOrThrow({ where: { userId: studentUserId } }))
      .toMatchObject({ providerAccountId: 'existing-google-account' });

    expect(await processCalendarRevocations()).toBe(1);
    expect(await prisma.calendarRevocationJob.count()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('allows explicit local disconnect cleanup when Google Calendar configuration is disabled', async () => {
    const connection = await prisma.calendarConnection.create({
      data: {
        userId: studentUserId, providerAccountId: 'disabled-config-account',
        providerEmail: 'disabled@example.test', accessTokenCiphertext: 'unreadable-without-keyring',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    config.googleCalendar.enabled = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await request(app).delete('/api/calendar/connection')
      .set('Cookie', studentCookie).send({}).expect(202);
    expect(response.body).toMatchObject({
      configured: false, state: 'DISCONNECTING', connected: false,
    });
    expect(await processCalendarDisconnects()).toBe(1);
    expect(await prisma.calendarConnection.findUnique({ where: { id: connection.id } })).toBeNull();
    expect(await prisma.calendarRevocationJob.count()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
