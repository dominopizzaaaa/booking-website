import { createHash, randomBytes, randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { auditRouter } from '../src/audit-routes.js';
import { requireAuth, requireWorkspace } from '../src/auth.js';
import { config } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

const testApp = express();
testApp.use(express.json());
testApp.use(cookieParser());
testApp.use('/api', requireAuth, requireWorkspace, auditRouter);
testApp.use(((error, _req, res, _next) => {
  if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
  if (error instanceof ZodError) { res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid input' }); return; }
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
}) satisfies ErrorRequestHandler);

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('club audit history', () => {
  let tenants: TestTenants;
  let fixture: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function staffCookie(permissions: string[]) {
    const suffix = randomUUID().replaceAll('-', '');
    const user = await prisma.user.create({ data: {
      name: 'Audit Staff', username: `audit_${suffix.slice(0, 18)}`, email: `audit-${suffix}@example.test`,
      passwordHash: 'not-used', accountType: 'STUDENT',
    } });
    tenants.ownUser(user.id);
    const access = await prisma.clubStaffAccess.create({ data: {
      businessId: fixture.business.id, userId: user.id, invitedByUserId: fixture.user.id,
      accessLevel: 'CUSTOM', permissions,
    } });
    const token = randomBytes(32).toString('base64url');
    await prisma.authSession.create({ data: {
      id: createHash('sha256').update(token).digest('hex'), userId: user.id, activeStaffAccessId: access.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    return `${config.sessionCookie}=${token}`;
  }

  async function createEvent(overrides: { businessId?: string; action?: string; summary: string; createdAt: Date; metadata?: object }) {
    return prisma.businessAuditEvent.create({ data: {
      businessId: overrides.businessId ?? fixture.business.id, actorUserId: fixture.user.id,
      actorName: 'Club Operator', actorEmail: 'private@example.test', actorAccountType: 'CLUB',
      actorAccessKind: 'CLUB_ACCOUNT', actorPermissionsSnapshot: ['AUDIT_VIEW'],
      action: overrides.action ?? 'STAFF_INVITATION_CREATED', resourceType: 'ClubStaffInvitation',
      resourceId: randomUUID(), summary: overrides.summary,
      metadata: overrides.metadata ?? { email: 'invitee@example.test', accessLevel: 'FINANCE', permissions: ['AUDIT_VIEW'], token: 'secret' },
      requestId: 'internal-request-id', createdAt: overrides.createdAt,
    } });
  }

  it('requires AUDIT_VIEW for named staff and never grants coach affiliation access', async () => {
    const deniedStaff = await staffCookie(['BOOKINGS_VIEW']);
    await request(testApp).get('/api/audit-events').set('Cookie', deniedStaff).expect(403);
    await request(testApp).get('/api/audit-events').set('Cookie', fixture.coachCookie).expect(403);

    const allowedStaff = await staffCookie(['AUDIT_VIEW']);
    await request(testApp).get('/api/audit-events').set('Cookie', allowedStaff).expect(200, { events: [], nextCursor: null });
  });

  it('paginates newest-first inside the selected tenant and returns only allowlisted metadata', async () => {
    const other = await tenants.fixture();
    const base = Date.now() - 60_000;
    await Promise.all([
      createEvent({ summary: 'Old event', createdAt: new Date(base) }),
      createEvent({ summary: 'Middle event', createdAt: new Date(base + 1_000), action: 'UNRECOGNISED_EVENT', metadata: { token: 'secret' } }),
      createEvent({ summary: 'Invited invitee@example.test as finance', createdAt: new Date(base + 2_000) }),
      createEvent({ businessId: other.business.id, summary: 'Other tenant event', createdAt: new Date(base + 3_000) }),
    ]);

    const first = await request(testApp).get('/api/audit-events?limit=2').set('Cookie', fixture.cookie).expect(200);
    expect(first.body.events.map((event: { summary: string }) => event.summary)).toEqual(['Invited [redacted email] as finance', 'Recorded unrecognised event']);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.events[0]).toMatchObject({
      actor: { name: 'Club Operator', accountType: 'CLUB', accessKind: 'CLUB_ACCOUNT', accessLevel: null, permissions: ['AUDIT_VIEW'] },
      resource: { type: 'ClubStaffInvitation' },
      metadata: { accessLevel: 'FINANCE', permissions: ['AUDIT_VIEW'] },
    });
    expect(first.body.events[0].actor).not.toHaveProperty('email');
    expect(first.body.events[0]).not.toHaveProperty('requestId');
    expect(first.body.events[0].metadata).not.toHaveProperty('email');
    expect(first.body.events[0].metadata).not.toHaveProperty('token');
    expect(first.body.events[1].metadata).toEqual({});

    const second = await request(testApp)
      .get(`/api/audit-events?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set('Cookie', fixture.cookie).expect(200);
    expect(second.body.events.map((event: { summary: string }) => event.summary)).toEqual(['Old event']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('rejects malformed cursors', async () => {
    await request(testApp).get('/api/audit-events?cursor=not-a-cursor').set('Cookie', fixture.cookie)
      .expect(400, { error: 'Invalid audit cursor' });
  });
});
