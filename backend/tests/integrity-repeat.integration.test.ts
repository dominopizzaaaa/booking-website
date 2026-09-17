import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
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

    const practiceAuth = await request(app).post('/api/auth/practice')
      .set('Cookie', club.coachCookie)
      .send({ name: 'Repeat Safeguard Practice' })
      .expect(201);
    const practice = await prisma.business.findUniqueOrThrow({
      where: { id: practiceAuth.body.business.id },
    });
    tenants.own(practice.id);
    const practiceInstructor = await prisma.instructor.findUniqueOrThrow({
      where: { id: practiceAuth.body.membership.instructorId },
    });
    const practiceLocation = await prisma.location.create({
      data: { businessId: practice.id, name: 'Practice Court', travelMinutes: 20 },
    });
    const practiceService = await prisma.service.create({
      data: {
        businessId: practice.id,
        name: 'Direct coaching',
        type: 'PRIVATE',
        capacity: 1,
        duration: 60,
        price: 8000,
        noticeHours: 0,
        bufferMinutes: 0,
        locations: {
          create: {
            locationId: practiceLocation.id,
            price: 8000,
            duration: 60,
            instructors: { create: { instructorId: practiceInstructor.id } },
          },
        },
      },
    });
    await prisma.availability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: practice.id,
        instructorId: practiceInstructor.id,
        locationId: practiceLocation.id,
        dayOfWeek,
        startTime: '08:00',
        endTime: '20:00',
      })),
    });
    const practiceStudent = await prisma.student.create({
      data: {
        businessId: practice.id,
        userId: studentAccount.id,
        name: studentAccount.name,
        initials: 'RS',
        email: studentAccount.email,
      },
    });

    // Removing a coach must revoke access and bookability without erasing the
    // account link on the historical club roster. The coach can keep using a
    // separate practice, and that retained identity must still drive the club
    // safeguard when they next book this student privately.
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
      .send({ membershipId: practiceAuth.body.membership.id })
      .expect(200);

    const createDirectLesson = async (days: number) => {
      const response = await request(app).post('/api/bookings')
        .set('Cookie', club.coachCookie)
        .send({
          serviceId: practiceService.id,
          instructorId: practiceInstructor.id,
          locationId: practiceLocation.id,
          startAt: club.starts.plus({ days }).toISO(),
          studentId: practiceStudent.id,
        })
        .expect(201);
      expect(response.body.bookings[0].paymentRoute).toBe('DIRECT');
      return response.body.bookings[0].id as string;
    };
    const integrityAlerts = () => prisma.notification.findMany({
      where: { businessId: club.business.id, type: 'INTEGRITY' },
      orderBy: { createdAt: 'asc' },
    });

    const firstBookingId = await createDirectLesson(2);
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
      outsideBusinessId: practice.id,
    });
    const alertsAfterFirst = await integrityAlerts();
    expect(alertsAfterFirst).toHaveLength(1);

    await request(app).patch(`/api/integrity-flags/${firstFlag.id}`)
      .set('Cookie', club.cookie)
      .send({ status: 'REVIEWING', note: 'Checking with the coach' })
      .expect(200);

    const secondBookingId = await createDirectLesson(3);
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
    expect((await integrityAlerts()).map(alert => alert.id)).toEqual([alertsAfterFirst[0].id]);

    const dismissed = await request(app).patch(`/api/integrity-flags/${firstFlag.id}`)
      .set('Cookie', club.cookie)
      .send({ status: 'DISMISSED', note: 'Approved private arrangement' })
      .expect(200);
    expect(dismissed.body.resolvedAt).not.toBeNull();

    const thirdBookingId = await createDirectLesson(4);
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
    expect((await integrityAlerts()).map(alert => alert.id)).toEqual([alertsAfterFirst[0].id]);

    const listed = await request(app).get('/api/integrity-flags')
      .set('Cookie', club.cookie)
      .expect(200);
    expect(listed.body.flags).toEqual(expect.arrayContaining([expect.objectContaining({
      id: firstFlag.id,
      occurrences: 3,
      status: 'DISMISSED',
      flaggedSessionAt: club.starts.plus({ days: 4 }).toUTC().toISO(),
      flaggedServiceName: practiceService.name,
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
