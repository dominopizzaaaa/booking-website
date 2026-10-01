import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { seedBusiness } from '../src/seed.js';
import { prisma, TestTenants, verifyTestDatabase } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('seedBusiness', () => {
  it('snapshots the club money path on every seeded booking and student payment', async () => {
    const rollback = new Error('Roll back the seed fixture');

    await expect(prisma.$transaction(async tx => {
      const { business } = await seedBusiness(tx, {
        slug: `courtly-test-seed-${randomUUID()}`,
        isDemo: true,
      });
      expect(business.kind).toBe('CLUB');
      // 35 sessions this week plus four attended sessions in the two weeks before.
      expect(await tx.booking.count({ where: { businessId: business.id } })).toBe(39);
      expect(await tx.booking.count({
        where: { businessId: business.id, paymentRoute: { not: 'CLUB' } },
      })).toBe(0);

      expect(await tx.payment.count({ where: { businessId: business.id } })).toBeGreaterThan(0);
      expect(await tx.payment.count({
        where: { businessId: business.id, kind: { not: 'STUDENT_TO_CLUB' } },
      })).toBe(0);

      throw rollback;
    }, { timeout: 60_000 })).rejects.toBe(rollback);
  }, 70_000);

  it('shows the training-companion features with data that respects their invariants', async () => {
    const rollback = new Error('Roll back the seed fixture');

    await expect(prisma.$transaction(async tx => {
      const { business } = await seedBusiness(tx, { slug: `courtly-test-seed-${randomUUID()}`, isDemo: true });
      const businessId = business.id;
      expect(business).toMatchObject({
        description: expect.stringMatching(/\S/u), publicPhone: expect.stringMatching(/\S/u),
        websiteUrl: expect.stringMatching(/^https:\/\/\S+$/u),
      });
      const areas = (await tx.location.findMany({ where: { businessId, type: { not: 'ONLINE' } } })).map(location => location.area);
      expect(areas.length).toBeGreaterThan(0);
      expect(areas.every(area => area.length > 0)).toBe(true);

      const coaches = await tx.user.findMany({ where: { memberships: { some: { businessId, instructorId: { not: null } } } } });
      expect(coaches).toHaveLength(3);
      for (const coach of coaches) {
        expect(coach.accountType).toBe('COACH');
        expect(coach.bio.length).toBeGreaterThan(0);
        expect(coach.languages.length).toBeGreaterThan(0);
        expect(coach.coachingLevels.length).toBeGreaterThan(0);
        expect(coach.coachingAgeGroups.length).toBeGreaterThan(0);
        expect(coach.qualifications.length).toBeGreaterThan(0);
        expect(coach.coachingSince).toBeGreaterThanOrEqual(1950);
      }

      // Shared feedback sits on attended places of ended club sessions and is
      // written by that session's coach account.
      const feedback = await tx.sessionFeedback.findMany({
        where: { businessId },
        include: { participant: true, booking: { include: { instructor: { include: { membership: true } } } } },
      });
      const shared = feedback.filter(item => item.visibility === 'SHARED');
      expect(shared.length).toBeGreaterThanOrEqual(3);
      expect(feedback.some(item => item.visibility === 'PRIVATE')).toBe(true);
      expect(shared.some(item => item.firstViewedAt)).toBe(true);
      for (const item of feedback) {
        expect(item.participant.bookingId).toBe(item.bookingId);
        expect(['PRESENT', 'LATE']).toContain(item.participant.attendance);
        expect(item.participant.cancelledAt).toBeNull();
        expect(item.booking.status).toBe('COMPLETED');
        expect(item.booking.endAt.getTime()).toBeLessThan(Date.now());
        expect(item.authorRole).toBe('COACH');
        expect(item.authorUserId).toBe(item.booking.instructor.membership?.userId);
        if (item.visibility === 'SHARED') {
          expect(item.sharedAt).not.toBeNull();
          expect(item.summary || item.strengths || item.focusAreas || item.nextGoal).toBeTruthy();
        }
      }

      const groups = await tx.trainingGroup.findMany({ where: { businessId }, include: { members: true } });
      expect(groups.length).toBeGreaterThanOrEqual(1);
      for (const group of groups) {
        expect(group.active).toBe(true);
        expect(group.members.length).toBeGreaterThan(0);
        expect(group.members.length).toBeLessThanOrEqual(group.capacity ?? Number.MAX_SAFE_INTEGER);
        expect(group.members.every(member => member.active && member.leftAt === null && member.businessId === businessId)).toBe(true);
        expect(await tx.service.count({ where: { id: group.serviceId!, businessId, active: true } })).toBe(1);
        expect(await tx.location.count({ where: { id: group.locationId!, businessId, active: true } })).toBe(1);
        expect(await tx.instructor.count({ where: { id: group.instructorId!, businessId, active: true } })).toBe(1);
      }

      // Every package balance is fully explained by its labelled ledger.
      const packages = await tx.lessonPackage.findMany({ where: { businessId }, include: { creditEvents: { orderBy: { sequence: 'asc' } } } });
      for (const pkg of packages) {
        expect(pkg.creditEvents[0]).toMatchObject({ kind: 'GRANTED', delta: pkg.totalCredits });
        expect(pkg.creditEvents.reduce((balance, event) => balance + event.delta, 0)).toBe(pkg.totalCredits - pkg.usedCredits);
        expect(pkg.creditEvents.at(-1)).toMatchObject({ totalAfter: pkg.totalCredits, usedAfter: pkg.usedCredits });
        expect(pkg.creditEvents.filter(event => event.kind === 'USED')).toEqual([]);
        const consumed = await tx.participant.count({ where: { packageId: pkg.id, creditConsumed: true } });
        const reserved = await tx.venueReservation.count({ where: { packageId: pkg.id, creditConsumed: true } });
        expect(pkg.usedCredits).toBe(consumed + reserved);
        const booked = pkg.creditEvents.filter(event => event.kind === 'BOOKED');
        expect(booked).toHaveLength(consumed);
        expect(booked.every(event => event.bookingId && event.participantId)).toBe(true);
        expect(pkg.creditEvents.filter(event => event.kind === 'RENTAL_RESERVED')).toHaveLength(reserved);
      }
      expect(packages.some(pkg => pkg.creditEvents.some(event => event.kind === 'BOOKED'))).toBe(true);

      const counters = await tx.clubFunnelCounter.findMany({ where: { businessId } });
      expect(new Set(counters.map(counter => counter.metric))).toEqual(new Set([
        'PAGE_VIEW', 'AVAILABILITY_CHECK', 'BOOKING_CREATED', 'REBOOK_CREATED',
        'WAITLIST_JOINED', 'WAITLIST_ACCEPTED', 'SEARCH_IMPRESSION',
      ]));
      expect(counters.every(counter => counter.count > 0)).toBe(true);

      throw rollback;
    }, { timeout: 60_000 })).rejects.toBe(rollback);
  }, 70_000);

  it('leaves a committed demo removable by the platform teardown', async () => {
    const tenants = new TestTenants();
    const originalOperators = config.adminOperators;
    const password = 'seed-teardown-admin-password';
    const { business } = await seedBusiness(prisma, { slug: `courtly-test-seed-${randomUUID()}`, isDemo: true });
    tenants.own(business.id);
    // Fall back to the fixture teardown if the platform route ever fails.
    const sampleUsers = await prisma.user.findMany({
      where: { OR: [{ memberships: { some: { businessId: business.id } } }, { students: { some: { businessId: business.id } } }] },
      select: { id: true },
    });
    for (const user of sampleUsers) tenants.ownUser(user.id);
    try {
      expect(await prisma.sessionFeedback.count({ where: { businessId: business.id } })).toBeGreaterThan(0);
      expect(await prisma.trainingGroupMember.count({ where: { businessId: business.id } })).toBeGreaterThan(0);
      expect(await prisma.packageCreditEvent.count({ where: { businessId: business.id } })).toBeGreaterThan(0);
      config.adminOperators = [{
        id: 'seed_teardown_operator', name: 'Seed Teardown Operator', email: 'seed-teardown@example.test',
        passwordHash: await bcrypt.hash(password, 12),
      }];
      const login = await request(app).post('/api/admin/login')
        .send({ email: 'seed-teardown@example.test', password }).expect(200);
      await request(app).delete(`/api/admin/businesses/${business.id}`).set('Cookie', login.headers['set-cookie']!).expect(200);
      expect(await prisma.business.count({ where: { id: business.id } })).toBe(0);
      expect(await prisma.packageCreditEvent.count({ where: { businessId: business.id } })).toBe(0);
      expect(await prisma.sessionFeedback.count({ where: { businessId: business.id } })).toBe(0);
      expect(await prisma.trainingGroup.count({ where: { businessId: business.id } })).toBe(0);
      expect(await prisma.clubFunnelCounter.count({ where: { businessId: business.id } })).toBe(0);
      expect(await prisma.user.count({ where: { id: { in: sampleUsers.map(user => user.id) } } })).toBe(0);
    } finally {
      config.adminOperators = originalOperators;
      await tenants.cleanup();
    }
  }, 70_000);
});
