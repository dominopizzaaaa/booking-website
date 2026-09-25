import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { flagPrivateSessionsAfterClub } from '../src/integrity.js';
import {
  TestTenants, createAccount, createStudent, prisma,
  verifyTestDatabase, type Fixture,
} from './fixtures.js';

const tenants = new TestTenants();

describe('Club safeguard alert lifecycle', () => {
  let club: Fixture;

  beforeAll(async () => {
    await verifyTestDatabase();
    club = await tenants.fixture();
  });

  afterAll(async () => {
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  it('links each actionable repeat alert to one club-only flag until dismissal', async () => {
    const studentAccount = await createAccount(club, {
      name: 'Integrity Alert Student',
      email: `integrity-alert-student-${randomUUID()}@example.test`,
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
    expect(clubLesson.body.bookings[0]).toMatchObject({ paymentRoute: 'CLUB' });

    const historical = await prisma.$transaction(async tx => {
      const business = await tx.business.create({
        data: {
          name: 'Integrity Alert Practice',
          slug: `integrity-alert-practice-${randomUUID()}`,
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
        data: { businessId: business.id, name: 'Private Court', travelMinutes: 20 },
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
          initials: 'IA',
          email: studentAccount.email,
        },
      });
      return { business, instructor, membership, location, service, student };
    });
    tenants.own(historical.business.id);
    expect(historical.business).toMatchObject({ kind: 'SOLO', legacyReadOnly: true });

    // Retired practices remain relationally complete so old contracts can be
    // audited, but a coach cannot select one to create another direct sale.
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
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
      status: 'OPEN',
      occurrences: 1,
      outsideBusinessId: historical.business.id,
    });
    const firstAlerts = await integrityAlerts();
    expect(firstAlerts).toHaveLength(1);
    expect(firstAlerts[0]).toMatchObject({
      businessId: club.business.id,
      instructorId: null,
      bookingId: null,
      integrityFlagId: firstFlag.id,
      actionNeeded: true,
    });

    const clubWorkspace = await request(app).get('/api/workspace')
      .set('Cookie', club.cookie).expect(200);
    expect(clubWorkspace.body.notifications).toEqual(expect.arrayContaining([expect.objectContaining({
      id: firstAlerts[0]!.id,
      instructorId: null,
      integrityFlagId: firstFlag.id,
      actionNeeded: true,
    })]));
    expect(clubWorkspace.body.integrityFlags).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstFlag.id, status: 'OPEN', occurrences: 1 }),
    ]));

    const coachWorkspace = await request(app).get('/api/workspace')
      .set('Cookie', club.coachCookie).expect(200);
    expect(coachWorkspace.body.notifications).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'INTEGRITY' })]),
    );
    expect(coachWorkspace.body.integrityFlags).toEqual([]);
    await request(app).get('/api/integrity-flags')
      .set('Cookie', club.coachCookie).expect(403);

    const reviewing = await request(app).patch(`/api/integrity-flags/${firstFlag.id}`)
      .set('Cookie', club.cookie)
      .send({ status: 'REVIEWING', note: 'Checking the arrangement' })
      .expect(200);
    expect(reviewing.body).toMatchObject({
      id: firstFlag.id, status: 'REVIEWING', resolutionNote: 'Checking the arrangement',
    });

    const secondBookingId = await createHistoricalDirectLesson(3);
    expect(await prisma.integrityFlag.findUniqueOrThrow({ where: { id: firstFlag.id } }))
      .toMatchObject({ id: firstFlag.id, bookingId: secondBookingId, status: 'OPEN', occurrences: 2 });
    expect(await prisma.integrityFlag.count({
      where: {
        businessId: club.business.id,
        coachUserId: club.coachUser.id,
        studentUserId: studentAccount.id,
      },
    })).toBe(1);
    const secondAlerts = await integrityAlerts();
    expect(secondAlerts).toHaveLength(2);
    const repeatedAlert = secondAlerts.find(alert => alert.id !== firstAlerts[0]!.id);
    expect(secondAlerts.map(alert => alert.id)).toContain(firstAlerts[0]!.id);
    expect(secondAlerts.find(alert => alert.id === firstAlerts[0]!.id))
      .toMatchObject({ integrityFlagId: firstFlag.id, actionNeeded: false });
    expect(repeatedAlert).toMatchObject({ integrityFlagId: firstFlag.id, actionNeeded: true });

    const upheld = await request(app).patch(`/api/integrity-flags/${firstFlag.id}`)
      .set('Cookie', club.cookie)
      .send({ status: 'UPHELD', note: 'Club relationship confirmed' })
      .expect(200);
    expect(upheld.body).toMatchObject({ status: 'UPHELD', resolutionNote: 'Club relationship confirmed' });
    expect(upheld.body.resolvedAt).not.toBeNull();
    expect((await integrityAlerts()).map(alert => alert.actionNeeded)).toEqual([false, false]);

    const thirdBookingId = await createHistoricalDirectLesson(4);
    expect(await prisma.integrityFlag.findUniqueOrThrow({ where: { id: firstFlag.id } }))
      .toMatchObject({ id: firstFlag.id, bookingId: thirdBookingId, status: 'OPEN', occurrences: 3 });
    const thirdAlerts = await integrityAlerts();
    expect(thirdAlerts).toHaveLength(3);
    expect(thirdAlerts.filter(alert => alert.actionNeeded)).toEqual([expect.objectContaining({
      integrityFlagId: firstFlag.id,
      actionNeeded: true,
    })]);
    expect(thirdAlerts.filter(alert => !alert.actionNeeded).map(alert => alert.id))
      .toEqual(expect.arrayContaining(secondAlerts.map(alert => alert.id)));

    const dismissed = await request(app).patch(`/api/integrity-flags/${firstFlag.id}`)
      .set('Cookie', club.cookie)
      .send({ status: 'DISMISSED', note: 'Approved private arrangement' })
      .expect(200);
    expect(dismissed.body).toMatchObject({
      status: 'DISMISSED',
      resolutionNote: 'Approved private arrangement',
    });
    expect((await integrityAlerts()).every(alert => !alert.actionNeeded)).toBe(true);

    const fourthBookingId = await createHistoricalDirectLesson(5);
    expect(await prisma.integrityFlag.findUniqueOrThrow({ where: { id: firstFlag.id } }))
      .toMatchObject({
        id: firstFlag.id,
        bookingId: fourthBookingId,
        status: 'DISMISSED',
        occurrences: 4,
        resolutionNote: 'Approved private arrangement',
      });
    const finalAlerts = await integrityAlerts();
    expect(finalAlerts).toHaveLength(3);
    expect(finalAlerts.every(alert => !alert.actionNeeded)).toBe(true);
  });
});
