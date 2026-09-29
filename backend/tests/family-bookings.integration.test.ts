import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { CURRENT_PRIVACY_POLICY_VERSION, DEFAULT_GUARDIAN_PERMISSIONS } from '../src/children-policy.js';
import {
  createAccount, createSession, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('guardian-authorized child bookings', () => {
  let tenants: TestTenants;
  let fixture: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function adultGuardian(name = 'Booking Guardian', accountType: 'STUDENT' | 'COACH' = 'STUDENT') {
    const user = await createAccount(fixture, { name, accountType });
    await prisma.user.update({
      where: { id: user.id },
      data: { dateOfBirth: new Date('1990-01-01T00:00:00.000Z') },
    });
    return { user: await prisma.user.findUniqueOrThrow({ where: { id: user.id } }), ...(await createSession(fixture, user.id)) };
  }

  async function managedChild(guardianUserId: string, options: {
    dateOfBirth?: string; permissions?: string[]; policyVersion?: string; accountStatus?: string;
  } = {}) {
    const identity = randomUUID().replaceAll('-', '');
    const result = await prisma.$transaction(async tx => {
      const child = await tx.user.create({ data: {
        name: `Child ${identity.slice(0, 6)}`,
        legalName: `Child Legal ${identity.slice(0, 6)}`,
        username: `child_${identity.slice(0, 18)}`,
        dateOfBirth: new Date(`${options.dateOfBirth ?? '2015-06-15'}T00:00:00.000Z`),
        email: null, emailVerifiedAt: null, passwordHash: null,
        accountType: 'STUDENT', accountControl: 'GUARDIAN_MANAGED',
        accountStatus: options.accountStatus ?? 'ACTIVE',
        profileVisibility: 'CLUBS_ONLY', phone: '', parentName: '',
      } });
      const link = await tx.guardianChildLink.create({ data: {
        guardianUserId, childUserId: child.id, relationshipType: 'PARENT',
        permissions: options.permissions ?? [...DEFAULT_GUARDIAN_PERMISSIONS],
      } });
      await tx.childConsentRecord.create({ data: {
        linkId: link.id, guardianUserId, childUserId: child.id, eventType: 'GRANTED',
        relationshipType: link.relationshipType, permissions: link.permissions,
        privacyPolicyVersion: options.policyVersion ?? CURRENT_PRIVACY_POLICY_VERSION,
      } });
      return { child, link };
    });
    fixture.tracker.ownUser(result.child.id);
    return result;
  }

  const bookingBody = () => ({
    businessSlug: fixture.business.slug,
    serviceId: fixture.service.id,
    instructorId: fixture.instructor.id,
    locationId: fixture.location.id,
    startAt: fixture.starts.toISO()!,
    notes: 'Needs a left-handed racket',
  });

  it('lists only minimal eligible identities and books an unpaid club lesson for the child', async () => {
    const guardian = await adultGuardian();
    const { child } = await managedChild(guardian.user.id);

    const list = await request(app).get('/api/family/booking-children')
      .set('Cookie', guardian.cookie).expect(200);
    expect(list.body).toEqual({ children: [{
      id: child.id, displayName: child.name, username: child.username,
    }] });
    expect(JSON.stringify(list.body)).not.toContain(child.legalName);
    expect(JSON.stringify(list.body)).not.toContain('dateOfBirth');

    const created = await request(app).post(`/api/family/children/${child.id}/bookings`)
      .set('Cookie', guardian.cookie).send(bookingBody()).expect(201);
    expect(created.body.bookedFor).toEqual({
      id: child.id, displayName: child.name, username: child.username,
    });
    expect(created.body.bookings).toHaveLength(1);
    expect(created.body.bookings[0]).toMatchObject({
      paymentRoute: 'CLUB', coachAcceptance: 'NOT_REQUIRED', createdByRole: 'STUDENT',
      participants: [{ name: child.name, email: null, paid: false, packageId: null }],
    });

    const persisted = await prisma.booking.findUniqueOrThrow({
      where: { id: created.body.bookings[0].id },
      include: { participants: { include: { student: true } }, chatThread: true },
    });
    expect(persisted).toMatchObject({
      paymentRoute: 'CLUB', coachAcceptance: 'NOT_REQUIRED', createdByRole: 'STUDENT',
      createdByUserId: guardian.user.id,
    });
    expect(persisted.participants[0]).toMatchObject({ paid: false, packageId: null, creditConsumed: false });
    expect(persisted.participants[0]!.student).toMatchObject({
      userId: child.id, name: child.name, email: null, phone: '', parentName: '',
    });
    expect(await prisma.payment.count({ where: { bookingId: persisted.id } })).toBe(0);
    expect(await prisma.lessonPackage.count({ where: { studentId: persisted.participants[0]!.studentId } })).toBe(0);
    expect(await prisma.venueReservation.count({ where: { userId: child.id } })).toBe(0);

    await request(app).get(`/api/chats/${persisted.chatThread!.id}`)
      .set('Cookie', guardian.cookie).expect(404);
  });

  it('records a coach guardian as the coach actor while preserving child-side acceptance semantics', async () => {
    const guardian = await adultGuardian('Coach Parent', 'COACH');
    const { child } = await managedChild(guardian.user.id);
    const created = await request(app).post(`/api/family/children/${child.id}/bookings`)
      .set('Cookie', guardian.cookie).send(bookingBody()).expect(201);

    expect(created.body.bookings[0]).toMatchObject({
      createdByRole: 'COACH',
      coachAcceptance: 'NOT_REQUIRED',
      participants: [{ name: child.name, email: null }],
    });
    const persisted = await prisma.booking.findUniqueOrThrow({
      where: { id: created.body.bookings[0].id },
      include: { participants: { include: { student: true } } },
    });
    expect(persisted).toMatchObject({
      createdByUserId: guardian.user.id, createdByRole: 'COACH', coachAcceptance: 'NOT_REQUIRED',
    });
    expect(persisted.participants[0]!.student.userId).toBe(child.id);
  });

  it('uses a strict request body and cannot apply package or caller-selected identity fields', async () => {
    const guardian = await adultGuardian();
    const { child } = await managedChild(guardian.user.id);
    for (const forbidden of [
      { packageId: randomUUID() }, { studentId: randomUUID() },
      { student: { name: 'Guardian', email: guardian.user.email } }, { paid: true },
    ]) {
      await request(app).post(`/api/family/children/${child.id}/bookings`)
        .set('Cookie', guardian.cookie).send({ ...bookingBody(), ...forbidden }).expect(400);
    }
    expect(await prisma.booking.count({ where: { businessId: fixture.business.id } })).toBe(0);
    expect(await prisma.student.count({ where: { businessId: fixture.business.id } })).toBe(0);
  });

  it('returns the same privacy-safe not-found response for missing, unrelated, or unauthorized children', async () => {
    const guardian = await adultGuardian('Authorized Guardian');
    const outsider = await adultGuardian('Unrelated Guardian');
    const { child, link } = await managedChild(guardian.user.id);
    const assertHidden = async (cookie: string, childId: string) => {
      const response = await request(app).post(`/api/family/children/${childId}/bookings`)
        .set('Cookie', cookie).send(bookingBody()).expect(404);
      expect(response.body).toMatchObject({ code: 'CHILD_NOT_FOUND' });
    };
    await assertHidden(outsider.cookie, child.id);
    await assertHidden(guardian.cookie, randomUUID());

    await prisma.guardianChildLink.update({
      where: { id: link.id },
      data: { permissions: DEFAULT_GUARDIAN_PERMISSIONS.filter(permission => permission !== 'BOOKINGS_MANAGE') },
    });
    await assertHidden(guardian.cookie, child.id);
    expect(await prisma.booking.count({ where: { businessId: fixture.business.id } })).toBe(0);
  });

  it('checks current consent on the exact guardian link rather than another co-guardian', async () => {
    const staleGuardian = await adultGuardian('Stale Consent Guardian');
    const currentGuardian = await adultGuardian('Current Consent Guardian');
    const { child, link } = await managedChild(currentGuardian.user.id);
    const staleLink = await prisma.guardianChildLink.create({ data: {
      guardianUserId: staleGuardian.user.id, childUserId: child.id, relationshipType: 'PARENT',
      permissions: [...DEFAULT_GUARDIAN_PERMISSIONS],
    } });
    await prisma.childConsentRecord.create({ data: {
      linkId: staleLink.id, guardianUserId: staleGuardian.user.id, childUserId: child.id,
      eventType: 'GRANTED', relationshipType: staleLink.relationshipType,
      permissions: staleLink.permissions, privacyPolicyVersion: '2025-01-01',
    } });

    const stale = await request(app).post(`/api/family/children/${child.id}/bookings`)
      .set('Cookie', staleGuardian.cookie).send(bookingBody()).expect(404);
    expect(stale.body).toMatchObject({ code: 'CHILD_NOT_FOUND' });
    expect((await request(app).get('/api/family/booking-children')
      .set('Cookie', staleGuardian.cookie).expect(200)).body.children).toEqual([]);

    await request(app).post(`/api/family/children/${child.id}/bookings`)
      .set('Cookie', currentGuardian.cookie).send(bookingBody()).expect(201);
    expect(link.id).not.toBe(staleLink.id);
  });

  it('fails closed after withdrawal, deletion, link end, handover, or adulthood', async () => {
    const guardian = await adultGuardian();
    const bodyAt = (days: number) => ({ ...bookingBody(), startAt: fixture.starts.plus({ days }).toISO()! });

    const withdrawn = await managedChild(guardian.user.id);
    await request(app).post(`/api/family/children/${withdrawn.child.id}/consent/withdraw`)
      .set('Cookie', guardian.cookie).send({}).expect(200);

    const deleted = await managedChild(guardian.user.id);
    await request(app).post(`/api/family/children/${deleted.child.id}/deletion-request`)
      .set('Cookie', guardian.cookie).send({}).expect(200);

    const ended = await managedChild(guardian.user.id);
    await prisma.$transaction(async tx => {
      await tx.guardianChildLink.update({
        where: { id: ended.link.id }, data: { status: 'ENDED', endedAt: new Date() },
      });
      await tx.user.update({
        where: { id: ended.child.id }, data: { accountStatus: 'CONSENT_REQUIRED' },
      });
    });

    const handedOver = await managedChild(guardian.user.id);
    await prisma.$transaction(async tx => {
      await tx.guardianChildLink.update({
        where: { id: handedOver.link.id }, data: { status: 'ENDED', endedAt: new Date() },
      });
      await tx.user.update({ where: { id: handedOver.child.id }, data: {
        accountControl: 'SELF', email: `${randomUUID()}@example.test`,
        emailVerifiedAt: new Date(), passwordHash: 'handover-complete', profileVisibility: 'CLUBS_ONLY',
      } });
    });

    // An adult managed identity is a handover-remediation state even when its
    // persisted status has not yet changed. It must not enter booking choices.
    const adult = await managedChild(guardian.user.id, { dateOfBirth: '1990-01-01' });

    for (const [index, childId] of [
      withdrawn.child.id, deleted.child.id, ended.child.id, handedOver.child.id, adult.child.id,
    ].entries()) {
      const response = await request(app).post(`/api/family/children/${childId}/bookings`)
        .set('Cookie', guardian.cookie).send(bodyAt(index + 1)).expect(404);
      expect(response.body).toMatchObject({ code: 'CHILD_NOT_FOUND' });
    }
    expect(await prisma.booking.count({ where: { businessId: fixture.business.id } })).toBe(0);
  });
});
