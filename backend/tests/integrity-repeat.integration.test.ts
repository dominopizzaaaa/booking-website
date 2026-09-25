import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { flagPrivateSessionsAfterClub } from '../src/integrity.js';
import {
  TestTenants, createAccount, createStudent, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

const tenants = new TestTenants();

describe('Club safeguard identity and repeat detections', () => {
  let club: Fixture;

  beforeAll(async () => {
    await verifyTestDatabase();
    club = await tenants.fixture();
  });

  afterAll(async () => {
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  it('keeps a departed coach identifiable while updating one repeat flag', async () => {
    const studentAccount = await createAccount(club, {
      name: 'Repeat Safeguard Student',
      email: `repeat-safeguard-student-${randomUUID()}@example.test`,
    });
    const clubStudent = await createStudent(club, {
      userId: studentAccount.id,
      name: studentAccount.name,
      email: studentAccount.email,
    });

    const clubLesson = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id,
      instructorId: club.instructor.id,
      locationId: club.location.id,
      startAt: club.starts.plus({ days: 1 }).toISO(),
      studentId: clubStudent.id,
    }).expect(201);
    expect(clubLesson.body.bookings[0].paymentRoute).toBe('CLUB');

    const historical = await prisma.$transaction(async tx => {
      const business = await tx.business.create({
        data: {
          name: 'Repeat Safeguard Practice',
          slug: `repeat-safeguard-practice-${randomUUID()}`,
          ownerName: club.coachUser.name,
          email: club.coachUser.email,
          kind: 'SOLO',
          legacyReadOnly: true,
        },
      });
      const instructor = await tx.instructor.create({
        data: {
          businessId: business.id,
          name: club.coachUser.name,
          initials: 'TC',
          email: club.coachUser.email,
        },
      });
      const membership = await tx.membership.create({
        data: {
          businessId: business.id,
          userId: club.coachUser.id,
          instructorId: instructor.id,
        },
      });
      const location = await tx.location.create({
        data: { businessId: business.id, name: 'Practice Court', travelMinutes: 20 },
      });
      const service = await tx.service.create({
        data: {
          businessId: business.id,
          name: 'Direct coaching',
          type: 'PRIVATE',
          capacity: 1,
          duration: 60,
          price: 8000,
          noticeHours: 0,
          bufferMinutes: 0,
          locations: {
            create: {
              locationId: location.id,
              price: 8000,
              duration: 60,
              instructors: { create: { instructorId: instructor.id } },
            },
          },
        },
      });
      const student = await tx.student.create({
        data: {
          businessId: business.id,
          userId: studentAccount.id,
          name: studentAccount.name,
          initials: 'RS',
          email: studentAccount.email,
        },
      });
      return { business, instructor, membership, location, service, student };
    });
    tenants.own(historical.business.id);
    expect(historical.business).toMatchObject({ kind: 'SOLO', legacyReadOnly: true });

    // Removing a coach must revoke access and bookability without erasing the
    // account link on the historical club roster. The coach can keep using a
    // retained historical practice, and that identity must still drive the
    // safeguard when Courtly audits an old direct booking.
    await request(app).post('/api/auth/switch-workspace')
      .set('Cookie', club.coachCookie)
      .send({ membershipId: club.coachMembership.id })
      .expect(200);
    await request(app).delete(`/api/staff/${club.coachMembership.id}`)
      .set('Cookie', club.cookie)
      .expect(200);
    expect(await prisma.membership.findUniqueOrThrow({
      where: { id: club.coachMembership.id },
    })).toMatchObject({ active: false, instructorId: club.instructor.id });
    expect(await prisma.instructor.findUniqueOrThrow({
      where: { id: club.instructor.id },
      include: { membership: true },
    })).toMatchObject({
      active: false,
      membership: { id: club.coachMembership.id, userId: club.coachUser.id },
    });
    expect(await prisma.authSession.findUniqueOrThrow({
      where: { id: club.session.id },
    })).toMatchObject({ activeMembershipId: club.membership.id });
    expect(await prisma.authSession.findFirstOrThrow({
      where: { userId: club.coachUser.id },
    })).toMatchObject({ activeMembershipId: null });
    await request(app).get('/api/workspace')
      .set('Cookie', club.coachCookie)
      .expect(403);
    await request(app).post('/api/auth/switch-workspace')
      .set('Cookie', club.coachCookie)
      .send({ membershipId: club.coachMembership.id })
      .expect(403);
    const publicClub = await request(app).get(`/api/public/${club.business.slug}`).expect(200);
    expect(publicClub.body.instructors.map((instructor: { id: string }) => instructor.id))
      .not.toContain(club.instructor.id);
    const activeStaff = await request(app).get('/api/staff')
      .set('Cookie', club.cookie)
      .expect(200);
    expect(activeStaff.body.map((membership: { id: string }) => membership.id))
      .not.toContain(club.coachMembership.id);

    await request(app).post('/api/auth/switch-workspace')
      .set('Cookie', club.coachCookie)
      .send({ membershipId: historical.membership.id })
      .expect(403);

    const createHistoricalDirectLesson = async (days: number) => {
      const startAt = club.starts.plus({ days });
      const created = await prisma.$transaction(async tx => {
        // Reconstruct the old contract without reopening SOLO commerce to current writes.
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
        const booking = await tx.booking.create({
          data: {
            businessId: historical.business.id,
            serviceId: historical.service.id,
            instructorId: historical.instructor.id,
            locationId: historical.location.id,
            startAt: startAt.toJSDate(),
            endAt: startAt.plus({ minutes: 60 }).toJSDate(),
            duration: 60,
            type: 'PRIVATE',
            capacity: 1,
            price: 8000,
            paymentRoute: 'DIRECT',
            createdByUserId: club.coachUser.id,
            createdByRole: 'COACH',
            participants: {
              create: { studentId: historical.student.id, price: 8000 },
            },
          },
        });
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`);
        await flagPrivateSessionsAfterClub(tx, booking.id);
        return booking;
      });
      expect(created.paymentRoute).toBe('DIRECT');
      return created.id;
    };
    const integrityAlerts = () => prisma.notification.findMany({
      where: { businessId: club.business.id, type: 'INTEGRITY' },
      orderBy: { createdAt: 'asc' },
    });

    const firstBookingId = await createHistoricalDirectLesson(2);
    const firstFlag = await prisma.integrityFlag.findFirstOrThrow({
      where: {
        businessId: club.business.id,
        coachUserId: club.coachUser.id,
        studentUserId: studentAccount.id,
      },
    });
    expect(firstFlag).toMatchObject({
      bookingId: firstBookingId,
      occurrences: 1,
      status: 'OPEN',
      outsideBusinessId: historical.business.id,
    });
    const alertsAfterFirst = await integrityAlerts();
    expect(alertsAfterFirst).toHaveLength(1);
    expect(alertsAfterFirst[0]).toMatchObject({
      integrityFlagId: firstFlag.id,
      instructorId: null,
      actionNeeded: true,
    });

    await request(app).patch(`/api/integrity-flags/${firstFlag.id}`)
      .set('Cookie', club.cookie)
      .send({ status: 'REVIEWING', note: 'Checking with the coach' })
      .expect(200);

    const secondBookingId = await createHistoricalDirectLesson(3);
    const reopened = await prisma.integrityFlag.findUniqueOrThrow({ where: { id: firstFlag.id } });
    expect(reopened).toMatchObject({
      bookingId: secondBookingId,
      occurrences: 2,
      status: 'OPEN',
      resolvedAt: null,
      resolvedByUserId: null,
    });
    expect(await prisma.integrityFlag.count({
      where: {
        businessId: club.business.id,
        coachUserId: club.coachUser.id,
        studentUserId: studentAccount.id,
      },
    })).toBe(1);
    const alertsAfterSecond = await integrityAlerts();
    expect(alertsAfterSecond).toHaveLength(2);
    expect(alertsAfterSecond.every(alert => alert.integrityFlagId === firstFlag.id)).toBe(true);
    expect(alertsAfterSecond.filter(alert => alert.actionNeeded)).toHaveLength(1);

    const dismissed = await request(app).patch(`/api/integrity-flags/${firstFlag.id}`)
      .set('Cookie', club.cookie)
      .send({ status: 'DISMISSED', note: 'Approved private arrangement' })
      .expect(200);
    expect(dismissed.body.resolvedAt).not.toBeNull();

    const thirdBookingId = await createHistoricalDirectLesson(4);
    const stillDismissed = await prisma.integrityFlag.findUniqueOrThrow({ where: { id: firstFlag.id } });
    expect(stillDismissed).toMatchObject({
      bookingId: thirdBookingId,
      occurrences: 3,
      status: 'DISMISSED',
      resolutionNote: 'Approved private arrangement',
      resolvedByUserId: club.user.id,
    });
    expect(stillDismissed.resolvedAt).not.toBeNull();
    expect(await prisma.integrityFlag.count({
      where: {
        businessId: club.business.id,
        coachUserId: club.coachUser.id,
        studentUserId: studentAccount.id,
      },
    })).toBe(1);
    const alertsAfterDismissedRepeat = await integrityAlerts();
    expect(alertsAfterDismissedRepeat.map(alert => alert.id))
      .toEqual(alertsAfterSecond.map(alert => alert.id));
    expect(alertsAfterDismissedRepeat.every(alert => !alert.actionNeeded)).toBe(true);

    const listed = await request(app).get('/api/integrity-flags')
      .set('Cookie', club.cookie)
      .expect(200);
    expect(listed.body.flags).toEqual(expect.arrayContaining([expect.objectContaining({
      id: firstFlag.id,
      occurrences: 3,
      status: 'DISMISSED',
      flaggedSessionAt: club.starts.plus({ days: 4 }).toUTC().toISO(),
      flaggedServiceName: historical.service.name,
    })]));

    const restored = await request(app).post('/api/staff')
      .set('Cookie', club.cookie)
      .send({ email: club.coachUser.email, instructorId: null })
      .expect(200);
    expect(restored.body).toMatchObject({
      id: club.coachMembership.id,
      instructorId: club.instructor.id,
      active: true,
    });
    expect(await prisma.membership.count({
      where: { userId: club.coachUser.id, businessId: club.business.id },
    })).toBe(1);
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: club.instructor.id } }))
      .toMatchObject({ active: true });
    const restoredStaff = await request(app).get('/api/staff')
      .set('Cookie', club.cookie)
      .expect(200);
    expect(restoredStaff.body).toEqual(expect.arrayContaining([expect.objectContaining({
      id: club.coachMembership.id,
      instructorId: club.instructor.id,
      active: true,
    })]));
  });
});
