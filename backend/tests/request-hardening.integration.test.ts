import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { TestTenants, createAccount, createSession, prisma, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('The HTTP request envelope', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  describe('request size', () => {
    // A body larger than the parser accepts is the caller sending too much,
    // not the server failing. It must not be reported as a server fault, which
    // would page an on-call engineer for someone else's oversized paste.
    it('answers an oversized body with a user-facing limit message', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(200_000) }));
      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: 'Request body is too large' });
    });

    it('still accepts an ordinary body of a few kilobytes', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: `${randomUUID()}@example.test`, password: 'a'.repeat(72) });
      expect(response.status).toBe(401);
    });
  });

  describe('response headers', () => {
    it('never lets an API response be cached', async () => {
      for (const path of ['/api/health', '/api/auth/me', `/api/public/${f.business.slug}`]) {
        const response = await request(app).get(path);
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    it('sends the hardening headers and hides the server framework', async () => {
      const response = await request(app).get('/api/health');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers).toHaveProperty('strict-transport-security');
    });

    it('publishes the remaining request budget', async () => {
      const response = await request(app).get('/api/health');
      expect(response.headers).toHaveProperty('ratelimit');
    });
  });

  describe('cross-origin access', () => {
    it('lets a configured browser origin read with credentials', async () => {
      const origin = config.origins[0];
      const response = await request(app).get('/api/health').set('Origin', origin);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('withholds the sharing header from an unknown origin', async () => {
      const response = await request(app).get('/api/health').set('Origin', 'https://attacker.invalid');
      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('accepts a mutation from a configured origin', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Origin', config.origins[0])
        .send({});
      expect(response.status).toBe(200);
    });

    // Reads are not state changes, so the origin rules deliberately do not
    // apply to them; the session cookie is SameSite=Lax regardless.
    it('leaves a cross-site read alone', async () => {
      const response = await request(app).get('/api/health').set('Sec-Fetch-Site', 'cross-site');
      expect(response.status).toBe(200);
    });

    it('allows a same-origin mutation that carries no Origin header at all', async () => {
      const response = await request(app).post('/api/auth/logout').send({});
      expect(response.status).toBe(200);
    });
  });

  describe('session cookies', () => {
    it('issues an http-only, lax, root-path session cookie', async () => {
      const email = `${randomUUID()}@example.test`;
      const response = await request(app).post('/api/auth/register').send({
        accountType: 'STUDENT', name: 'Cookie Student', username: `cookie_${randomUUID().slice(0, 8)}`,
        email, password: 'Courtly-cookie-test-1',
      });
      expect(response.status).toBe(201);
      const [cookie] = response.headers['set-cookie'] as unknown as string[];
      expect(cookie).toContain(`${config.sessionCookie}=`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/');
      // Development runs over http; the secure flag belongs to production.
      expect(cookie).not.toContain('Secure');
      await prisma.user.deleteMany({ where: { email } });
    });

    it('refuses an empty or unknown session cookie without leaking which it was', async () => {
      for (const value of ['', 'not-a-real-session-token']) {
        const response = await request(app)
          .get('/api/auth/me').set('Cookie', `${config.sessionCookie}=${value}`);
        expect(response.status).toBe(401);
        expect(response.body.error).toBe('Session expired. Please sign in again');
      }
    });

    it('asks an unauthenticated caller to sign in when no cookie is sent at all', async () => {
      const response = await request(app).get('/api/auth/me');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('Please sign in to continue');
    });
  });

  describe('error translation', () => {
    it('turns a duplicate account into a conflict a person can act on', async () => {
      const email = `${randomUUID()}@example.test`;
      const body = { accountType: 'STUDENT' as const, name: 'Twice Over', username: `twice_${randomUUID().slice(0, 8)}`, email, password: 'Courtly-duplicate-1' };
      expect((await request(app).post('/api/auth/register').send(body)).status).toBe(201);
      const duplicate = await request(app).post('/api/auth/register').send(body);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toBe('This record already exists. Please use a different email or username.');
      await prisma.user.deleteMany({ where: { email } });
    });

    it('names the first problem when a body fails validation', async () => {
      const response = await request(app).post('/api/auth/register').send({
        accountType: 'STUDENT', name: 'Short Password', username: `short_${randomUUID().slice(0, 8)}`,
        email: `${randomUUID()}@example.test`, password: 'short',
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Use a password with at least 12 characters');
      expect(response.body.issues).toBeDefined();
    });

    it('answers an unknown route with the same JSON shape as any other error', async () => {
      const response = await request(app).get(`/${randomUUID()}`);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Route not found' });
      expect(response.headers['content-type']).toContain('application/json');
    });

    // Provider routers are mounted behind requireAuth, so an unknown path
    // under /api stops at the session check. Answering 404 there would tell an
    // unauthenticated caller which internal routes exist.
    it('stops an unauthenticated caller at the session check, not at the route table', async () => {
      const response = await request(app).get(`/api/${randomUUID()}`);
      expect(response.status).toBe(401);

      const authenticated = await request(app)
        .get(`/api/${randomUUID()}`).set('Cookie', f.cookie);
      expect(authenticated.status).toBe(404);
      expect(authenticated.body).toEqual({ error: 'Route not found' });
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      const account = await createAccount(f, { name: 'Strict Student' });
      const { cookie } = await createSession(f, account.id);
      const response = await request(app)
        .patch('/api/account/profile')
        .set('Cookie', cookie)
        .send({ name: 'Strict Student', accountType: 'CLUB' });
      expect(response.status).toBe(400);
    });
  });

  describe('route mounting order', () => {
    // The student router sits in front of every provider guard, so a student
    // account reaches its own routes and stops at the workspace boundary.
    it('sends a student to their own routes and refuses the provider ones', async () => {
      const account = await createAccount(f, { name: 'Mounted Student' });
      const { cookie } = await createSession(f, account.id);
      expect((await request(app).get('/api/account/notifications').set('Cookie', cookie)).status).toBe(200);
      const workspace = await request(app).get('/api/workspace').set('Cookie', cookie);
      expect(workspace.status).toBe(403);
      expect(workspace.body.error).toBe('Select a business workspace to continue');
    });

    it('refuses a provider account the student self-service routes', async () => {
      const response = await request(app).get('/api/account/notifications').set('Cookie', f.coachCookie);
      expect(response.status).toBe(403);
      expect(response.body.error)
        .toBe('A student account is required to book or manage personal bookings');
    });

    it('requires a session before either side of the boundary', async () => {
      expect((await request(app).get('/api/account/notifications')).status).toBe(401);
      expect((await request(app).get('/api/workspace')).status).toBe(401);
    });
  });
});
