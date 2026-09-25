import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createPackage, createSession, createStudent, prisma, verifyTestDatabase, type Fixture,
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

  it('keeps retained solo practices out of provider reschedule routes', async () => {
    const historical = await prisma.$transaction(async tx => {
      const business = await tx.business.create({
        data: {
          name: 'Retained Privacy Practice', slug: `retained-privacy-${club.business.id}`,
          ownerName: club.coachUser.name, email: club.coachUser.email,
          kind: 'SOLO', legacyReadOnly: true,
        },
      });
      const instructor = await tx.instructor.create({
        data: {
          businessId: business.id, name: club.coachUser.name, initials: 'TC',
          email: club.coachUser.email,
        },
      });
      const membership = await tx.membership.create({
        data: {
          businessId: business.id, userId: club.coachUser.id, instructorId: instructor.id,
        },
      });
      return { business, membership };
    });
    tenants.own(historical.business.id);
    const legacySession = await createSession(club, club.coachUser.id, historical.membership.id);
    const { booking, studentSession } = await clubBooking(9);
    const requestId = await studentProposal(booking, studentSession.cookie, 10);

    const denied = await request(app).post(`/api/reschedule-requests/${requestId}/accept`)
      .set('Cookie', legacySession.cookie).send({}).expect(403);
    expect(denied.body.error).toBe('Select a business workspace to continue');
    expect(await prisma.authSession.findUniqueOrThrow({ where: { id: legacySession.session.id } }))
      .toMatchObject({ activeMembershipId: null });
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } }))
      .toMatchObject({ status: 'PENDING' });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } }))
      .toMatchObject({ startAt: club.starts.plus({ days: 9 }).toJSDate() });
  });
});
