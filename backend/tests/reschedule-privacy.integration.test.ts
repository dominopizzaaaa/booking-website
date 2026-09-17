import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createPackage, createSession, createStudent, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

const tenants = new TestTenants();

function expectNoFinancialBookingFields(booking: Record<string, any>) {
  expect(booking).not.toHaveProperty('price');
  expect(booking.participants).not.toHaveLength(0);
  for (const participant of booking.participants) {
    expect(participant).not.toHaveProperty('paid');
    expect(participant).not.toHaveProperty('price');
    expect(participant).not.toHaveProperty('packageId');
  }
}

function expectFinancialBookingFields(booking: Record<string, any>, packageId: string) {
  expect(booking.price).toBe(8000);
  expect(booking.participants[0]).toMatchObject({ paid: true, price: 8000, packageId });
}

describe.sequential('Provider reschedule response privacy', () => {
  let club: Fixture;

  beforeAll(async () => {
    await verifyTestDatabase();
    club = await tenants.fixture();
  });

  afterAll(async () => {
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  async function clubBooking(day: number) {
    const student = await createStudent(club, { name: `Reschedule Student ${day}` });
    const studentSession = await createSession(club, student.userId!);
    const pkg = await createPackage(club, student.id);
    const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: club.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: day }).toISO(), studentId: student.id, packageId: pkg.id,
    }).expect(201);
    const booking = created.body.bookings[0] as { id: string; participants: Array<{ id: string }> };
    await request(app).post(`/api/bookings/${booking.id}/accept`)
      .set('Cookie', club.coachCookie).send({}).expect(200);
    return { booking, pkg, studentSession };
  }

  async function studentProposal(
    booking: { id: string; participants: Array<{ id: string }> },
    studentCookie: string,
    day: number,
  ) {
    const response = await request(app)
      .post(`/api/account/bookings/${booking.participants[0]!.id}/reschedule-requests`)
      .set('Cookie', studentCookie).send({ startAt: club.starts.plus({ days: day }).toISO() }).expect(201);
    return response.body.rescheduleRequest.id as string;
  }

  it('never returns club financials from any coach-side reschedule response', async () => {
    const { booking, studentSession } = await clubBooking(1);

    const proposed = await request(app).post(`/api/bookings/${booking.id}/reschedule-requests`)
      .set('Cookie', club.coachCookie).send({ startAt: club.starts.plus({ days: 2 }).toISO() }).expect(201);
    expect(proposed.body).not.toHaveProperty('booking');

    const withdrawn = await request(app).post(`/api/reschedule-requests/${proposed.body.id}/withdraw`)
      .set('Cookie', club.coachCookie).send({}).expect(200);
    expect(withdrawn.body).not.toHaveProperty('booking');

    const declinedId = await studentProposal(booking, studentSession.cookie, 3);
    const declined = await request(app).post(`/api/reschedule-requests/${declinedId}/decline`)
      .set('Cookie', club.coachCookie).send({}).expect(200);
    expect(declined.body).not.toHaveProperty('booking');

    const acceptedId = await studentProposal(booking, studentSession.cookie, 4);
    const accepted = await request(app).post(`/api/reschedule-requests/${acceptedId}/accept`)
      .set('Cookie', club.coachCookie).send({}).expect(200);
    expect(accepted.body.request).toMatchObject({ id: acceptedId, status: 'ACCEPTED' });
    expectNoFinancialBookingFields(accepted.body.booking);
  });

  it('keeps full reschedule booking financials for the club account', async () => {
    const { booking, pkg, studentSession } = await clubBooking(6);
    const requestId = await studentProposal(booking, studentSession.cookie, 7);
    const accepted = await request(app).post(`/api/reschedule-requests/${requestId}/accept`)
      .set('Cookie', club.cookie).send({}).expect(200);

    expectFinancialBookingFields(accepted.body.booking, pkg.id);
  });

  it('keeps full reschedule booking financials for a coach managing a solo practice', async () => {
    const practice = await request(app).post('/api/auth/practice')
      .set('Cookie', club.coachCookie).send({ name: 'Solo Privacy Practice' }).expect(201);
    const businessId = practice.body.business.id as string;
    const instructorId = practice.body.membership.instructorId as string;
    tenants.own(businessId);

    const location = await prisma.location.create({
      data: { businessId, name: 'Solo Privacy Court', travelMinutes: 20 },
    });
    const service = await prisma.service.create({
      data: {
        businessId, name: 'Solo Privacy Lesson', type: 'PRIVATE', capacity: 1,
        duration: 60, price: 8000, noticeHours: 0, bufferMinutes: 0,
        locations: { create: {
          locationId: location.id, price: 8000, duration: 60,
          instructors: { create: { instructorId } },
        } },
      },
    });
    await prisma.availability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId, instructorId, locationId: location.id, dayOfWeek, startTime: '08:00', endTime: '20:00',
      })),
    });
    const studentAccount = await createAccount(club, { name: 'Solo Privacy Student' });
    const studentSession = await createSession(club, studentAccount.id);
    const student = await prisma.student.create({
      data: {
        businessId, userId: studentAccount.id, name: studentAccount.name, initials: 'SP', email: studentAccount.email,
      },
    });
    const pkg = await prisma.lessonPackage.create({
      data: {
        businessId, studentId: student.id, serviceId: service.id, name: 'Solo Privacy Package',
        totalCredits: 5, usedCredits: 0, price: 40000, expiresAt: club.starts.plus({ months: 6 }).toJSDate(), paid: true,
      },
    });
    const created = await request(app).post('/api/bookings').set('Cookie', club.coachCookie).send({
      serviceId: service.id, instructorId, locationId: location.id,
      startAt: club.starts.plus({ days: 9 }).toISO(), studentId: student.id, packageId: pkg.id,
    }).expect(201);
    const booking = created.body.bookings[0] as { id: string; participants: Array<{ id: string }> };
    const proposed = await request(app)
      .post(`/api/account/bookings/${booking.participants[0]!.id}/reschedule-requests`)
      .set('Cookie', studentSession.cookie).send({ startAt: club.starts.plus({ days: 10 }).toISO() }).expect(201);
    const accepted = await request(app)
      .post(`/api/reschedule-requests/${proposed.body.rescheduleRequest.id}/accept`)
      .set('Cookie', club.coachCookie).send({}).expect(200);

    expectFinancialBookingFields(accepted.body.booking, pkg.id);
  });
});
