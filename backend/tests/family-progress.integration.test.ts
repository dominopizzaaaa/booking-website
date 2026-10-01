import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { CURRENT_PRIVACY_POLICY_VERSION, DEFAULT_GUARDIAN_PERMISSIONS } from '../src/children-policy.js';
import { createBookings } from '../src/scheduling.js';
import {
  createAccount, createSession, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('guardian projections of a managed child', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => { tenants = new TestTenants(); f = await tenants.fixture(); });
  afterEach(async () => { await tenants.cleanup(); });

  async function adultGuardian(name = 'Projection Guardian', accountType: 'STUDENT' | 'COACH' = 'STUDENT') {
    const user = await createAccount(f, { name, accountType });
    await prisma.user.update({
      where: { id: user.id },
      data: { dateOfBirth: new Date('1988-02-02T00:00:00.000Z'), emailVerifiedAt: new Date() },
    });
    return { user, ...(await createSession(f, user.id)) };
  }

  async function managedChild(guardianUserId: string, options: { permissions?: readonly string[]; policyVersion?: string } = {}) {
    const identity = randomUUID().replaceAll('-', '');
    const result = await prisma.$transaction(async tx => {
      const child = await tx.user.create({ data: {
        name: `Junior ${identity.slice(0, 6)}`, legalName: `Junior Legal ${identity.slice(0, 6)}`,
        username: `junior_${identity.slice(0, 18)}`, dateOfBirth: new Date('2014-07-07T00:00:00.000Z'),
        email: null, emailVerifiedAt: null, passwordHash: null,
        accountType: 'STUDENT', accountControl: 'GUARDIAN_MANAGED', accountStatus: 'ACTIVE',
        profileVisibility: 'CLUBS_ONLY', phone: '', parentName: '',
      } });
      const link = await linkGuardian(tx, guardianUserId, child.id, options);
      return { child, link };
    });
    tenants.ownUser(result.child.id);
    return result;
  }

  async function linkGuardian(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0] | typeof prisma,
    guardianUserId: string, childUserId: string,
    options: { permissions?: readonly string[]; policyVersion?: string } = {},
  ) {
    const link = await tx.guardianChildLink.create({ data: {
      guardianUserId, childUserId, relationshipType: 'PARENT',
      permissions: [...(options.permissions ?? DEFAULT_GUARDIAN_PERMISSIONS)],
    } });
    await tx.childConsentRecord.create({ data: {
      linkId: link.id, guardianUserId, childUserId, eventType: 'GRANTED', relationshipType: 'PARENT',
      permissions: link.permissions, privacyPolicyVersion: options.policyVersion ?? CURRENT_PRIVACY_POLICY_VERSION,
    } });
    return link;
  }

  const bookForChild = async (cookie: string, childId: string, overrides: Record<string, unknown> = {}) => {
    const response = await request(app).post(`/api/family/children/${childId}/bookings`).set('Cookie', cookie).send({
      businessSlug: f.business.slug, serviceId: f.service.id, instructorId: f.instructor.id,
      locationId: f.location.id, startAt: f.starts.toISO(), ...overrides,
    }).expect(201);
    return { bookingId: response.body.bookings[0].id as string, participantId: response.body.bookings[0].participants.at(-1).id as string };
  };

  async function moveTo(bookingId: string, startAt: Date) {
    await prisma.booking.update({ where: { id: bookingId }, data: { startAt, endAt: new Date(startAt.getTime() + 3_600_000) } });
  }

  const schedule = (cookie: string, childId: string) =>
    request(app).get(`/api/family/children/${childId}/schedule`).set('Cookie', cookie);
  const progress = (cookie: string, childId: string) =>
    request(app).get(`/api/family/children/${childId}/progress`).set('Cookie', cookie);

  it('projects only the child’s own places from 90 days ago onward, without other learners, notes or prices', async () => {
    const guardian = await adultGuardian();
    const { child } = await managedChild(guardian.user.id);
    await prisma.location.update({ where: { id: f.location.id }, data: { address: '1 Court Road', area: 'Tampines · East' } });

    const upcoming = await bookForChild(guardian.cookie, child.id, { notes: 'Needs a left-handed racket' });
    const group = await prisma.service.create({ data: {
      businessId: f.business.id, name: 'Junior squad', category: 'Badminton', type: 'GROUP', capacity: 4, duration: 60,
      price: 2500, noticeHours: 0, locations: { create: {
        locationId: f.location.id, price: 2500, duration: 60, instructors: { create: { instructorId: f.instructor.id } },
      } },
    } });
    const groupStart = f.starts.plus({ days: 1 });
    const classmate = await createStudent(f, { name: 'Classmate Hidden' });
    await createBookings(f.business.id, inputFor(f, {
      serviceId: group.id, studentId: classmate.id, student: undefined, startAt: groupStart.toISO()!,
    }));
    const squad = await bookForChild(guardian.cookie, child.id, { serviceId: group.id, startAt: groupStart.toISO() });
    const old = await bookForChild(guardian.cookie, child.id, { startAt: f.starts.plus({ days: 2 }).toISO() });
    await moveTo(old.bookingId, new Date(Date.now() - 100 * 86_400_000));
    const recent = await bookForChild(guardian.cookie, child.id, { startAt: f.starts.plus({ days: 3 }).toISO() });
    const recentStart = new Date(Date.now() - 30 * 86_400_000);
    await moveTo(recent.bookingId, recentStart);
    await prisma.participant.update({ where: { id: recent.participantId }, data: { attendance: 'PRESENT' } });
    await prisma.sessionFeedback.create({ data: {
      businessId: f.business.id, bookingId: recent.bookingId, participantId: recent.participantId,
      authorName: 'Test Coach', authorRole: 'COACH', visibility: 'SHARED', summary: 'Lovely serve',
      clubNote: 'INTERNAL-ONLY-REMARK', sharedAt: new Date(),
    } });
    await prisma.sessionFeedback.create({ data: {
      businessId: f.business.id, bookingId: squad.bookingId, participantId: squad.participantId,
      authorName: 'Test Coach', authorRole: 'COACH', visibility: 'PRIVATE', summary: 'Draft only',
    } });

    const response = await schedule(guardian.cookie, child.id).expect(200);
    expect(response.body.child).toEqual({ id: child.id, name: child.name, username: child.username });
    expect(response.body.bookings.map((item: { bookingId: string }) => item.bookingId))
      .toEqual([recent.bookingId, upcoming.bookingId, squad.bookingId]);
    expect(response.body.bookings[0]).toEqual({
      participantId: recent.participantId, bookingId: recent.bookingId,
      business: { name: f.business.name, slug: f.business.slug, timezone: 'Asia/Singapore' },
      serviceName: 'Private tennis', sport: 'Tennis', type: 'PRIVATE', coachName: 'Test Coach',
      location: { name: 'Test Court', address: '1 Court Road', area: 'Tampines · East', mapsUrl: '' },
      startAt: recentStart.toISOString(), endAt: new Date(recentStart.getTime() + 3_600_000).toISOString(),
      status: 'CONFIRMED', attendance: 'PRESENT', hasFeedback: true,
    });
    expect(response.body.bookings[2]).toMatchObject({ type: 'GROUP', sport: 'Badminton', hasFeedback: false });
    const serialized = JSON.stringify(response.body);
    for (const hidden of ['Classmate Hidden', 'left-handed', 'price', 'notes', 'INTERNAL', 'clubNote', child.legalName]) {
      expect(serialized).not.toContain(hidden);
    }
    await request(app).get(`/api/family/children/${child.id}/schedule`).query({ from: 'x' })
      .set('Cookie', guardian.cookie).expect(400);

    const projected = await progress(guardian.cookie, child.id).expect(200);
    expect(projected.body.child).toEqual({ id: child.id, name: child.name, username: child.username });
    expect(projected.body.stats).toMatchObject({ attended: 1, booked: 4, upcoming: 2, hoursOnCourt: 1, clubs: 1 });
    expect(projected.body.feedback).toHaveLength(1);
    expect(projected.body.feedback[0]).toMatchObject({ summary: 'Lovely serve', viewed: false, authorRole: 'COACH' });
    expect(projected.body.filters.sports).toEqual(['Badminton', 'Tennis']);
    expect(JSON.stringify(projected.body)).not.toMatch(/INTERNAL|clubNote|Draft only|Classmate/);
    const sportOnly = await request(app).get(`/api/family/children/${child.id}/progress`).query({ sport: 'badminton' })
      .set('Cookie', guardian.cookie).expect(200);
    expect(sportOnly.body.stats).toMatchObject({ attended: 0, booked: 1 });
  });

  it('answers the same not-found for another family, an unknown child, or a link without booking authority', async () => {
    const guardian = await adultGuardian('Own Guardian');
    const outsider = await adultGuardian('Other Family Guardian');
    const { child } = await managedChild(guardian.user.id);
    const { child: otherChild } = await managedChild(outsider.user.id);
    const { child: profileOnlyChild } = await managedChild(guardian.user.id, {
      permissions: DEFAULT_GUARDIAN_PERMISSIONS.filter(permission => permission !== 'BOOKINGS_MANAGE'),
    });

    const expectHidden = async (cookie: string, childId: string) => {
      for (const call of [schedule, progress]) {
        const response = await call(cookie, childId).expect(404);
        expect(response.body).toMatchObject({ error: 'Child profile not found', code: 'CHILD_NOT_FOUND' });
      }
    };
    await expectHidden(outsider.cookie, child.id);
    await expectHidden(guardian.cookie, otherChild.id);
    await expectHidden(guardian.cookie, randomUUID());
    await expectHidden(guardian.cookie, profileOnlyChild.id);
    // A coach or club workspace session is not guardian authority either.
    await expectHidden(f.coachCookie, child.id);
    await expectHidden(f.cookie, child.id);

    await schedule(guardian.cookie, child.id).expect(200);
    await progress(outsider.cookie, otherChild.id).expect(200);
    await request(app).get(`/api/family/children/${child.id}/schedule`).expect(401);
  });

  it('follows current consent on the exact link and fails closed after withdrawal or deletion', async () => {
    const guardian = await adultGuardian('Consenting Guardian');
    const coGuardian = await adultGuardian('Withdrawing Co Guardian', 'COACH');
    const staleGuardian = await adultGuardian('Stale Policy Guardian');
    const { child } = await managedChild(guardian.user.id);
    await linkGuardian(prisma, coGuardian.user.id, child.id);
    await linkGuardian(prisma, staleGuardian.user.id, child.id, { policyVersion: '2025-01-01' });

    await schedule(coGuardian.cookie, child.id).expect(200);
    await schedule(staleGuardian.cookie, child.id).expect(404);

    await request(app).post(`/api/family/children/${child.id}/consent/withdraw`).set('Cookie', coGuardian.cookie)
      .send({}).expect(200);
    await schedule(coGuardian.cookie, child.id).expect(404);
    await progress(coGuardian.cookie, child.id).expect(404);
    // Another guardian's withdrawal does not affect a link with its own current consent.
    await schedule(guardian.cookie, child.id).expect(200);

    await request(app).post(`/api/family/children/${child.id}/deletion-request`).set('Cookie', guardian.cookie)
      .send({}).expect(200);
    for (const call of [schedule, progress]) {
      expect((await call(guardian.cookie, child.id).expect(404)).body.code).toBe('CHILD_NOT_FOUND');
    }
  });

  it('withdraws access on the guardian’s own consent withdrawal', async () => {
    const guardian = await adultGuardian();
    const { child } = await managedChild(guardian.user.id);
    await progress(guardian.cookie, child.id).expect(200);
    await request(app).post(`/api/family/children/${child.id}/consent/withdraw`).set('Cookie', guardian.cookie)
      .send({}).expect(200);
    for (const call of [schedule, progress]) await call(guardian.cookie, child.id).expect(404);
  });
});
