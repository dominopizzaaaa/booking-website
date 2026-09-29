import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { CURRENT_PRIVACY_POLICY_VERSION, DEFAULT_GUARDIAN_PERMISSIONS } from '../src/children-policy.js';
import {
  createAccount, createSession, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Live account-action gates', () => {
  let tenants: TestTenants;
  let fixture: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  it('recomputes persisted account state for every ordinary account surface', async () => {
    const account = await createAccount(fixture, { name: 'Action Gate Staff Student' });
    const access = await prisma.clubStaffAccess.create({
      data: {
        businessId: fixture.business.id, userId: account.id, accessLevel: 'CUSTOM',
        permissions: ['STAFF_MANAGE'], invitedByUserId: fixture.user.id,
      },
    });
    const { session, cookie } = await createSession(fixture, account.id);
    await prisma.authSession.update({
      where: { id: session.id }, data: { activeStaffAccessId: access.id },
    });

    const routes = [
      { surface: 'direct/account chat', method: 'GET', path: '/api/chats?contract=accounts' },
      { surface: 'session chat', method: 'GET', path: '/api/chats' },
      { surface: 'calendar', method: 'GET', path: '/api/calendar/connection' },
      { surface: 'workspace', method: 'GET', path: '/api/workspace' },
      { surface: 'staff', method: 'GET', path: '/api/staff-access' },
      { surface: 'package', method: 'GET', path: '/api/account/packages' },
      { surface: 'payment', method: 'GET', path: '/api/payments/capabilities' },
      { surface: 'rental', method: 'GET', path: '/api/rentals' },
    ] as const;

    for (const route of routes) {
      const response = await request(app).get(route.path).set('Cookie', cookie);
      expect(response.status, `${route.surface} precondition`).toBe(200);
    }

    await prisma.user.update({
      where: { id: account.id }, data: { accountStatus: 'DELETION_REQUESTED' },
    });
    expect(await prisma.authSession.findUnique({ where: { id: session.id } })).not.toBeNull();

    for (const route of routes) {
      const response = await request(app).get(route.path).set('Cookie', cookie);
      expect(response.status, `${route.surface} ${route.method} ${route.path}`).toBe(403);
      expect(response.body, `${route.surface} ${route.method} ${route.path}`).toEqual({
        error: 'Account action is required before continuing',
        code: 'ACCOUNT_ACTION_REQUIRED',
        reason: 'DELETION_REQUESTED',
      });
    }
  });

  it('rejects an existing session after its user becomes guardian managed', async () => {
    const child = await createAccount(fixture, { name: 'Stale Session Child' });
    const { session, cookie } = await createSession(fixture, child.id);
    await request(app).get('/api/chats').set('Cookie', cookie).expect(200);

    const guardian = await createAccount(fixture, { name: 'Stale Session Guardian' });
    await prisma.user.update({
      where: { id: guardian.id }, data: { dateOfBirth: new Date('1990-01-01T00:00:00.000Z') },
    });
    await prisma.$transaction(async tx => {
      const link = await tx.guardianChildLink.create({
        data: {
          guardianUserId: guardian.id, childUserId: child.id, relationshipType: 'PARENT',
          permissions: [...DEFAULT_GUARDIAN_PERMISSIONS],
        },
      });
      await tx.childConsentRecord.create({
        data: {
          linkId: link.id, guardianUserId: guardian.id, childUserId: child.id,
          eventType: 'GRANTED', relationshipType: link.relationshipType,
          privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION, permissions: link.permissions,
        },
      });
      await tx.user.update({
        where: { id: child.id },
        data: {
          dateOfBirth: new Date('2012-01-01T00:00:00.000Z'),
          accountControl: 'GUARDIAN_MANAGED', email: null, emailVerifiedAt: null,
          passwordHash: null, phone: '', profileVisibility: 'CLUBS_ONLY',
        },
      });
    });
    expect(await prisma.authSession.findUnique({ where: { id: session.id } })).not.toBeNull();

    const response = await request(app).get('/api/chats').set('Cookie', cookie).expect(403);
    expect(response.body).toEqual({
      error: 'Account action is required before continuing',
      code: 'ACCOUNT_ACTION_REQUIRED',
      reason: 'GUARDIAN_SESSION_STALE',
    });
  });
});
