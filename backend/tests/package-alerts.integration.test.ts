import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendPackageAlerts } from '../src/package-activity.js';
import { CURRENT_PRIVACY_POLICY_VERSION, DEFAULT_GUARDIAN_PERMISSIONS } from '../src/children-policy.js';
import {
  createAccount, createPackage, createStudent, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

const day = 86_400_000;

describe.sequential('package reminders', () => {
  let tenants: TestTenants;
  let club: Fixture;
  let now: Date;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
    now = new Date();
  });
  afterEach(async () => { await tenants.cleanup(); });

  const sweep = (fixtures: Fixture[] = [club], at = now) =>
    sendPackageAlerts({ now: at, businessIds: fixtures.map(fixture => fixture.business.id) });
  const alerts = (packageId: string) => prisma.accountNotification.findMany({
    where: { packageId }, orderBy: [{ createdAt: 'asc' }, { type: 'asc' }],
  });
  async function learnerPackage(values: { totalCredits: number; usedCredits: number; expiresInDays?: number; paid?: boolean }, fixture = club) {
    const student = await createStudent(fixture);
    const pkg = await createPackage(fixture, student.id, {
      totalCredits: values.totalCredits, usedCredits: values.usedCredits, paid: values.paid ?? true,
      expiresAt: new Date(now.getTime() + (values.expiresInDays ?? 90) * day),
    });
    return { student, pkg };
  }

  it('sends one low-balance alert when a used package reaches its last credit or runs out', async () => {
    const last = await learnerPackage({ totalCredits: 5, usedCredits: 4 });
    const empty = await learnerPackage({ totalCredits: 3, usedCredits: 3 });
    const two = await learnerPackage({ totalCredits: 5, usedCredits: 3 });
    const untouchedSingle = await learnerPackage({ totalCredits: 1, usedCredits: 0 });

    expect(await sweep()).toEqual({ low: 2, expiring: 0 });
    expect(await alerts(last.pkg.id)).toEqual([expect.objectContaining({
      userId: last.student.userId, businessId: club.business.id, bookingId: null, packageId: last.pkg.id,
      type: 'PACKAGE_LOW', title: 'One package credit left', message: 'Five lessons has 1 credit left.',
      read: false, actionNeeded: false,
    })]);
    expect(await alerts(empty.pkg.id)).toEqual([expect.objectContaining({
      userId: empty.student.userId, type: 'PACKAGE_LOW', title: 'Package credits used up',
    })]);
    expect(await alerts(two.pkg.id)).toEqual([]);
    expect(await alerts(untouchedSingle.pkg.id)).toEqual([]);

    // Deduplicated per package and type: a restored and re-used credit, and a
    // later sweep, never repeat the reminder.
    await prisma.lessonPackage.update({ where: { id: last.pkg.id }, data: { usedCredits: 2 } });
    await prisma.lessonPackage.update({ where: { id: last.pkg.id }, data: { usedCredits: 5 } });
    expect(await sweep()).toEqual({ low: 0, expiring: 0 });
    expect(await alerts(last.pkg.id)).toHaveLength(1);

    // A package that reaches the threshold later is picked up then.
    await prisma.lessonPackage.update({ where: { id: two.pkg.id }, data: { usedCredits: 4 } });
    expect(await sweep()).toEqual({ low: 1, expiring: 0 });
    expect((await alerts(two.pkg.id)).map(alert => alert.type)).toEqual(['PACKAGE_LOW']);
  });

  it('warns once about credits expiring within fourteen days', async () => {
    const soon = await learnerPackage({ totalCredits: 6, usedCredits: 2, expiresInDays: 10 });
    const later = await learnerPackage({ totalCredits: 6, usedCredits: 2, expiresInDays: 15 });
    const usedUp = await learnerPackage({ totalCredits: 2, usedCredits: 2, expiresInDays: 5 });
    const lastDay = await learnerPackage({ totalCredits: 4, usedCredits: 0, expiresInDays: 14 });

    expect(await sweep()).toEqual({ low: 1, expiring: 2 });
    expect(await alerts(soon.pkg.id)).toEqual([expect.objectContaining({
      userId: soon.student.userId, type: 'PACKAGE_EXPIRING', title: 'Package credits expiring soon', packageId: soon.pkg.id,
    })]);
    expect((await alerts(soon.pkg.id))[0]!.message).toMatch(/^4 credits in Five lessons expire on \d{1,2} [A-Z][a-z]{2,3} \d{4}\. Book a session to use them\.$/u);
    expect((await alerts(lastDay.pkg.id)).map(alert => alert.type)).toEqual(['PACKAGE_EXPIRING']);
    expect(await alerts(later.pkg.id)).toEqual([]);
    // No credits remain, so only the used-up reminder applies.
    expect((await alerts(usedUp.pkg.id)).map(alert => alert.type)).toEqual(['PACKAGE_LOW']);

    // Five days on, the later package enters the window; the first is not repeated.
    expect(await sweep([club], new Date(now.getTime() + 5 * day))).toEqual({ low: 0, expiring: 1 });
    expect((await alerts(later.pkg.id)).map(alert => alert.type)).toEqual(['PACKAGE_EXPIRING']);
    expect(await alerts(soon.pkg.id)).toHaveLength(1);
  });

  it('skips unpaid, expired, legacy, non-active and guardian-managed learners', async () => {
    const unpaid = await learnerPackage({ totalCredits: 3, usedCredits: 3, expiresInDays: 3, paid: false });
    const expired = await learnerPackage({ totalCredits: 3, usedCredits: 2, expiresInDays: -1 });
    const unlinkedStudent = await createStudent(club, { userId: null, name: 'Walk-in Student' });
    const unlinked = await createPackage(club, unlinkedStudent.id, {
      totalCredits: 2, usedCredits: 2, expiresAt: new Date(now.getTime() + 3 * day),
    });

    const deleting = await learnerPackage({ totalCredits: 3, usedCredits: 3, expiresInDays: 3 });
    await prisma.user.update({ where: { id: deleting.student.userId! }, data: { accountStatus: 'DELETION_REQUESTED' } });

    // A managed child has no direct inbox; its guardian is reached through
    // Family instead, so package nudges never target the child account.
    const childAccount = await createAccount(club, { name: 'Managed Child' });
    const guardian = await createAccount(club, { name: 'Child Guardian' });
    await prisma.user.update({ where: { id: guardian.id }, data: { dateOfBirth: new Date('1985-01-01T00:00:00.000Z') } });
    await prisma.$transaction(async tx => {
      const link = await tx.guardianChildLink.create({ data: {
        guardianUserId: guardian.id, childUserId: childAccount.id, relationshipType: 'PARENT',
        permissions: [...DEFAULT_GUARDIAN_PERMISSIONS],
      } });
      await tx.childConsentRecord.create({ data: {
        linkId: link.id, guardianUserId: guardian.id, childUserId: childAccount.id, eventType: 'GRANTED',
        relationshipType: link.relationshipType, privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION, permissions: link.permissions,
      } });
      await tx.user.update({ where: { id: childAccount.id }, data: {
        dateOfBirth: new Date('2016-03-01T00:00:00.000Z'), accountControl: 'GUARDIAN_MANAGED',
        email: null, emailVerifiedAt: null, passwordHash: null, phone: '', profileVisibility: 'CLUBS_ONLY',
      } });
    });
    const childStudent = await prisma.student.create({ data: {
      businessId: club.business.id, userId: childAccount.id, name: 'Managed Child', initials: 'MC', email: null,
    } });
    const childPackage = await createPackage(club, childStudent.id, {
      totalCredits: 2, usedCredits: 2, expiresAt: new Date(now.getTime() + 3 * day),
    });

    const legacy = await tenants.fixture();
    const legacyLearner = await learnerPackage({ totalCredits: 2, usedCredits: 2, expiresInDays: 3 }, legacy);
    await prisma.$executeRaw`UPDATE "Business" SET "legacyReadOnly" = true WHERE "id" = ${legacy.business.id}`;

    expect(await sweep([club, legacy])).toEqual({ low: 0, expiring: 0 });
    for (const packageId of [unpaid.pkg.id, expired.pkg.id, unlinked.id, deleting.pkg.id, childPackage.id, legacyLearner.pkg.id]) {
      expect(await alerts(packageId)).toEqual([]);
    }
  });

  it('stays inside the requested businesses and sends exactly once across concurrent sweeps', async () => {
    const other = await tenants.fixture();
    const outside = await learnerPackage({ totalCredits: 2, usedCredits: 2, expiresInDays: 4 }, other);
    const packages = await Promise.all(Array.from({ length: 4 }, () => learnerPackage({ totalCredits: 3, usedCredits: 2, expiresInDays: 7 })));

    const results = await Promise.all([sweep(), sweep(), sweep()]);
    expect(results.reduce((total, result) => total + result.low, 0)).toBe(4);
    expect(results.reduce((total, result) => total + result.expiring, 0)).toBe(4);
    for (const { pkg } of packages) {
      expect((await alerts(pkg.id)).map(alert => alert.type).sort()).toEqual(['PACKAGE_EXPIRING', 'PACKAGE_LOW']);
    }
    expect(await alerts(outside.pkg.id)).toEqual([]);
    expect(await sendPackageAlerts({ now, businessIds: [] })).toEqual({ low: 0, expiring: 0 });
    expect(await alerts(outside.pkg.id)).toEqual([]);
  });

  it('processes a bounded batch and resumes on the next sweep', async () => {
    const packages = await Promise.all(Array.from({ length: 3 }, () => learnerPackage({ totalCredits: 2, usedCredits: 1 })));
    expect(await sendPackageAlerts({ now, businessIds: [club.business.id], limit: 2 })).toEqual({ low: 2, expiring: 0 });
    expect(await sendPackageAlerts({ now, businessIds: [club.business.id], limit: 2 })).toEqual({ low: 1, expiring: 0 });
    const types = await Promise.all(packages.map(async ({ pkg }) => (await alerts(pkg.id)).map(alert => alert.type)));
    expect(types).toEqual([['PACKAGE_LOW'], ['PACKAGE_LOW'], ['PACKAGE_LOW']]);
    expect(await prisma.accountNotification.count({ where: { businessId: club.business.id } })).toBe(3);
  });
});
