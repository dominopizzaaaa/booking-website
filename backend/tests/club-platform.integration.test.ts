import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { initials } from '../src/http.js';
import { parseMapsLink } from '../src/venues.js';
import {
  TestTenants, createAccount, createStudent, createSession, prisma, publicInputFor,
  verifyTestDatabase, type Fixture,
} from './fixtures.js';

const password = 'a-long-enough-test-password';
const tenants = new TestTenants();

describe('Name initials', () => {
  it('reads letters rather than whatever follows a space', () => {
    // A role qualifier describes the person but is not part of their name.
    expect(initials('Dominic (Coach)')).toBe('D');
    expect(initials('Dominic (Head Coach)')).toBe('D');
    expect(initials('Dominic (')).toBe('D');
    expect(initials('D(')).toBe('D');
    expect(initials('  Mary-Jane   Watson ')).toBe('MW');
    expect(initials('陈 伟')).toBe('陈伟');
    expect(initials('陈 伟（教练）')).toBe('陈伟');
    expect(initials('(Coach)')).toBe('?');
    expect(initials('(((')).toBe('?');
  });
});

describe('Google Maps venue links', () => {
  it('reads a place and coordinates out of a pasted link, and refuses anything else', () => {
    const place = parseMapsLink('https://www.google.com/maps/place/Kallang+Tennis+Centre/@1.3045,103.8745,17z/data=x');
    expect(place).toMatchObject({
      name: 'Kallang Tennis Centre', latitude: 1.3045, longitude: 103.8745, source: 'GOOGLE_MAPS',
    });
    const query = parseMapsLink('https://www.google.com/maps/search/?api=1&query=Singapore+Tennis+Club&query_place_id=ChIJabc123');
    expect(query).toMatchObject({ name: 'Singapore Tennis Club', placeId: 'ChIJabc123' });
    expect(parseMapsLink('https://example.com/maps/place/Somewhere')).toBeNull();
    expect(parseMapsLink('not a url')).toBeNull();
  });
});

describe('Club and coach platform', () => {
  let club: Fixture;

  beforeAll(async () => {
    await verifyTestDatabase();
    club = await tenants.fixture();
  });

  afterAll(async () => {
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  async function coachOnRoster(f: Fixture) {
    const email = `${randomUUID()}@example.test`;
    const account = await createAccount(f, {
      name: 'Roster Coach', email, accountType: 'COACH', passwordHash: await bcrypt.hash(password, 4),
    });
    const instructor = await prisma.instructor.create({
      data: { businessId: f.business.id, name: 'Roster Coach', initials: 'RC', email },
    });
    const membership = await prisma.membership.create({
      data: { userId: account.id, businessId: f.business.id, instructorId: instructor.id },
    });
    const serviceLocation = await prisma.serviceLocation.findUniqueOrThrow({
      where: { serviceId_locationId: { serviceId: f.service.id, locationId: f.location.id } },
    });
    await prisma.serviceInstructor.create({
      data: { serviceLocationId: serviceLocation.id, instructorId: instructor.id },
    });
    await prisma.availability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: f.business.id, instructorId: instructor.id, locationId: f.location.id,
        dayOfWeek, startTime: '08:00', endTime: '20:00',
      })),
    });
    const session = await createSession(f, account.id, membership.id);
    return { account, instructor, membership, session };
  }

  it('requires the assigned coach to accept a lesson the club scheduled for them', async () => {
    const coach = await coachOnRoster(club);
    const otherCoach = await coachOnRoster(club);
    const student = await createStudent(club, { name: 'Assigned Student' });

    const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: coach.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 1 }).toISO(), studentId: student.id,
    }).expect(201);
    const booking = created.body.bookings[0];
    // The student is not asked to accept; the coach is.
    expect(booking).toMatchObject({ status: 'PENDING', coachAcceptance: 'PENDING', createdByRole: 'CLUB' });

    // Until the coach answers, the session is not confirmed and cannot be
    // renegotiated by anyone.
    await request(app).post(`/api/bookings/${booking.id}/reschedule-requests`)
      .set('Cookie', club.cookie).send({ startAt: club.starts.plus({ days: 2 }).toISO() }).expect(400);
    await request(app).patch(`/api/bookings/${booking.id}`)
      .set('Cookie', club.cookie).send({ status: 'CONFIRMED' }).expect(400);
    await request(app).patch(`/api/bookings/${booking.id}`)
      .set('Cookie', club.cookie).send({ status: 'COMPLETED' }).expect(400);
    await request(app).patch(`/api/bookings/${booking.id}`)
      .set('Cookie', coach.session.cookie).send({ status: 'CONFIRMED' }).expect(400);
    await request(app).post(`/api/bookings/${booking.id}/accept`)
      .set('Cookie', club.cookie).send({}).expect(403);
    await request(app).post(`/api/bookings/${booking.id}/decline`)
      .set('Cookie', club.cookie).send({}).expect(403);
    await request(app).post(`/api/bookings/${booking.id}/accept`)
      .set('Cookie', otherCoach.session.cookie).send({}).expect(403);
    await request(app).post(`/api/bookings/${booking.id}/decline`)
      .set('Cookie', otherCoach.session.cookie).send({}).expect(403);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).toMatchObject({
      status: 'PENDING', coachAcceptance: 'PENDING', coachRespondedAt: null,
    });

    const accepted = await request(app).post(`/api/bookings/${booking.id}/accept`)
      .set('Cookie', coach.session.cookie).send({}).expect(200);
    expect(accepted.body).toMatchObject({ status: 'CONFIRMED', coachAcceptance: 'ACCEPTED' });
    await request(app).post(`/api/bookings/${booking.id}/accept`)
      .set('Cookie', coach.session.cookie).send({}).expect(409);

    const alerts = await prisma.accountNotification.findMany({
      where: { bookingId: booking.id }, orderBy: { createdAt: 'asc' },
    });
    expect(alerts.map(alert => alert.type)).toEqual(['BOOKING_ASSIGNED', 'BOOKING_CONFIRMED']);
  });

  it('keeps venue approval pending after coach acceptance until the club confirms it', async () => {
    const coach = await coachOnRoster(club);
    const student = await createStudent(club, { name: 'Venue Approval Student' });
    await prisma.location.update({ where: { id: club.location.id }, data: { requiresApproval: true } });
    try {
      const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
        serviceId: club.service.id, instructorId: coach.instructor.id, locationId: club.location.id,
        startAt: club.starts.plus({ days: 11 }).toISO(), studentId: student.id,
      }).expect(201);
      const bookingId = created.body.bookings[0].id as string;

      const accepted = await request(app).post(`/api/bookings/${bookingId}/accept`)
        .set('Cookie', coach.session.cookie).send({}).expect(200);
      expect(accepted.body).toMatchObject({ status: 'PENDING', coachAcceptance: 'ACCEPTED' });
      await request(app).patch(`/api/bookings/${bookingId}`)
        .set('Cookie', coach.session.cookie).send({ status: 'CONFIRMED' }).expect(403);
      const confirmed = await request(app).patch(`/api/bookings/${bookingId}`)
        .set('Cookie', club.cookie).send({ status: 'CONFIRMED' }).expect(200);
      expect(confirmed.body).toMatchObject({ status: 'CONFIRMED', coachAcceptance: 'ACCEPTED' });
    } finally {
      await prisma.location.update({ where: { id: club.location.id }, data: { requiresApproval: false } });
    }
  });

  it('rejects coach decisions when a malformed assignment is not pending or is terminal', async () => {
    const coach = await coachOnRoster(club);
    const student = await createStudent(club, { name: 'Malformed Assignment Student' });
    const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: coach.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 12 }).toISO(), studentId: student.id,
    }).expect(201);
    const bookingId = created.body.bookings[0].id as string;

    await prisma.booking.update({ where: { id: bookingId }, data: { status: 'CONFIRMED' } });
    await request(app).post(`/api/bookings/${bookingId}/accept`)
      .set('Cookie', coach.session.cookie).send({}).expect(409);
    await request(app).post(`/api/bookings/${bookingId}/decline`)
      .set('Cookie', coach.session.cookie).send({}).expect(409);

    for (const status of ['CANCELLED', 'COMPLETED'] as const) {
      await prisma.booking.update({ where: { id: bookingId }, data: { status } });
      await request(app).post(`/api/bookings/${bookingId}/accept`)
        .set('Cookie', coach.session.cookie).send({}).expect(400);
      await request(app).post(`/api/bookings/${bookingId}/decline`)
        .set('Cookie', coach.session.cookie).send({}).expect(400);
    }
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({
      status: 'COMPLETED', coachAcceptance: 'PENDING', coachRespondedAt: null,
    });
  });

  it('releases the slot and tells the club when the assigned coach declines', async () => {
    const coach = await coachOnRoster(club);
    const student = await createStudent(club, { name: 'Declined Student' });
    const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: coach.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 3 }).toISO(), studentId: student.id,
    }).expect(201);
    const bookingId = created.body.bookings[0].id as string;

    await request(app).post(`/api/bookings/${bookingId}/decline`)
      .set('Cookie', coach.session.cookie).send({ message: 'Away that week' }).expect(200);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({
      coachAcceptance: 'DECLINED', status: 'CANCELLED',
    });
    const reassign = await prisma.notification.findFirstOrThrow({
      where: { businessId: club.business.id, bookingId, type: 'PENDING_ACTION' },
      orderBy: { createdAt: 'desc' },
    });
    expect(reassign.actionNeeded).toBe(true);
    expect(reassign.message).toContain('Away that week');
  });

  it('moves a session only once both sides agree, and closes requests inside the coach window', async () => {
    const account = await createAccount(club, { name: 'Negotiating Student' });
    const session = await createSession(club, account.id);
    const created = await request(app).post(`/api/public/${club.business.slug}/bookings`)
      .set('Cookie', session.cookie).send(publicInputFor(club, {
        startAt: club.starts.plus({ days: 4 }).toISO()!,
      })).expect(201);
    const bookingId = created.body.bookings[0].id as string;
    const participantId = created.body.bookings[0].participants[0].id as string;
    const proposed = club.starts.plus({ days: 5 });

    const requested = await request(app).post(`/api/account/bookings/${participantId}/reschedule-requests`)
      .set('Cookie', session.cookie).send({ startAt: proposed.toISO(), message: 'Exam clash' }).expect(201);
    const requestId = requested.body.rescheduleRequest.id as string;
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ startAt: club.starts.plus({ days: 4 }).toJSDate() });

    // A second live proposal would leave both sides unsure which time is
    // actually under discussion.
    await request(app).post(`/api/account/bookings/${participantId}/reschedule-requests`)
      .set('Cookie', session.cookie).send({ startAt: club.starts.plus({ days: 6 }).toISO() }).expect(409);

    await request(app).post(`/api/reschedule-requests/${requestId}/decline`)
      .set('Cookie', club.cookie).send({ message: 'Court is booked' }).expect(200);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ startAt: club.starts.plus({ days: 4 }).toJSDate() });

    const providerProposal = await request(app).post(`/api/bookings/${bookingId}/reschedule-requests`)
      .set('Cookie', club.cookie).send({ startAt: club.starts.plus({ days: 6 }).toISO() }).expect(201);
    await request(app).post(`/api/reschedule-requests/${providerProposal.body.id}/accept`)
      .set('Cookie', club.cookie).send({}).expect(403);
    await request(app).post(`/api/reschedule-requests/${providerProposal.body.id}/withdraw`)
      .set('Cookie', club.cookie).send({}).expect(200);

    const second = await request(app).post(`/api/account/bookings/${participantId}/reschedule-requests`)
      .set('Cookie', session.cookie).send({ startAt: proposed.toISO() }).expect(201);
    const acceptance = await request(app)
      .post(`/api/reschedule-requests/${second.body.rescheduleRequest.id}/accept`)
      .set('Cookie', club.cookie).send({}).expect(200);
    expect(acceptance.body.booking.startAt).toBe(proposed.toUTC().toISO());

    // The coach's own protection window closes negotiation near the session.
    await prisma.instructor.update({
      where: { id: club.instructor.id }, data: { rescheduleNoticeHours: 720 },
    });
    const refused = await request(app).post(`/api/account/bookings/${participantId}/reschedule-requests`)
      .set('Cookie', session.cookie).send({ startAt: club.starts.plus({ days: 7 }).toISO() }).expect(400);
    expect(refused.body.error).toContain('720 hours');
    const listed = await request(app).get('/api/account/bookings').set('Cookie', session.cookie).expect(200);
    expect(listed.body.bookings[0]).toMatchObject({
      canReschedule: false, management: { rescheduleNoticeHours: 720 },
    });
    await prisma.instructor.update({
      where: { id: club.instructor.id }, data: { rescheduleNoticeHours: 24 },
    });
  });

  it('reverses a recorded payment and returns the participant to unpaid', async () => {
    const student = await createStudent(club, { name: 'Paying Student' });
    const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: club.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 8 }).toISO(), studentId: student.id,
    }).expect(201);
    const booking = created.body.bookings[0];
    // A club collects from the student; the coach is paid later by the club.
    expect(booking.paymentRoute).toBe('CLUB');

    const payment = await request(app).post('/api/payments').set('Cookie', club.cookie).send({
      studentId: student.id, bookingId: booking.id, amount: booking.price,
      method: 'BANK_TRANSFER', note: 'Lesson payment',
    }).expect(201);
    expect(payment.body.kind).toBe('STUDENT_TO_CLUB');
    expect(await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } }))
      .toMatchObject({ paid: true });

    await request(app).delete(`/api/payments/${payment.body.id}`)
      .set('Cookie', club.cookie).send({ reason: 'Recorded against the wrong lesson' }).expect(200);
    expect(await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } }))
      .toMatchObject({ paid: false });
    // The row survives the correction so the ledger still shows what happened.
    const reversed = await prisma.payment.findUniqueOrThrow({ where: { id: payment.body.id } });
    expect(reversed.reversedAt).not.toBeNull();
    expect(reversed.reversedReason).toBe('Recorded against the wrong lesson');
    await request(app).delete(`/api/payments/${payment.body.id}`).set('Cookie', club.cookie).send({}).expect(409);

    // The balance is free again, so the same lesson can be recorded correctly.
    await request(app).post('/api/payments').set('Cookie', club.cookie).send({
      studentId: student.id, bookingId: booking.id, amount: booking.price, method: 'CASH', note: 'Re-recorded',
    }).expect(201);
    expect(await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } }))
      .toMatchObject({ paid: true });
  });

  it('records and reverses a coach payout without inventing a student party', async () => {
    const isolated = new TestTenants();
    const emptyClub = await isolated.fixture();
    try {
      expect(await prisma.student.count({ where: { businessId: emptyClub.business.id } })).toBe(0);

      const created = await request(app).post('/api/payouts').set('Cookie', emptyClub.cookie).send({
        instructorId: emptyClub.instructor.id, amount: 12_500, method: 'BANK_TRANSFER',
        note: 'September coaching',
      }).expect(201);
      expect(created.body).toMatchObject({
        kind: 'CLUB_TO_COACH', studentId: null, studentName: null,
        instructorId: emptyClub.instructor.id, instructorName: emptyClub.instructor.name,
      });

      const workspace = await request(app).get('/api/workspace')
        .set('Cookie', emptyClub.cookie).expect(200);
      expect(workspace.body.payments).toContainEqual(expect.objectContaining({
        id: created.body.id, studentId: null, studentName: null,
        instructorId: emptyClub.instructor.id, instructorName: emptyClub.instructor.name,
      }));

      const reversed = await request(app).delete(`/api/payments/${created.body.id}`)
        .set('Cookie', emptyClub.cookie).send({ reason: 'Duplicate payroll entry' }).expect(200);
      expect(reversed.body.payment).toMatchObject({
        id: created.body.id, kind: 'CLUB_TO_COACH', studentId: null, studentName: null,
        instructorId: emptyClub.instructor.id, instructorName: emptyClub.instructor.name,
        reversedReason: 'Duplicate payroll entry',
      });
      expect(reversed.body.payment.reversedAt).not.toBeNull();
      expect(await prisma.accountNotification.count({
        where: { businessId: emptyClub.business.id, type: 'PAYMENT_REVERSED' },
      })).toBe(0);
      expect(await prisma.notification.findFirst({
        where: { businessId: emptyClub.business.id, type: 'PAYOUT', title: 'Coach payout reversed' },
      })).toMatchObject({ instructorId: emptyClub.instructor.id });
    } finally {
      await isolated.cleanup();
    }
  });

  it('flags a private session between a coach and a student who met through a club', async () => {
    const coach = await coachOnRoster(club);
    const studentAccount = await createAccount(club, { name: 'Shared Student' });
    const clubStudent = await createStudent(club, {
      name: 'Shared Student', email: studentAccount.email, userId: studentAccount.id,
    });
    await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: coach.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 9 }).toISO(), studentId: clubStudent.id,
    }).expect(201);

    // The same coach account now runs its own practice, where students pay the
    // coach directly.
    const practiceAuth = await request(app).post('/api/auth/practice')
      .set('Cookie', coach.session.cookie).send({ name: 'Roster Coach Practice' }).expect(201);
    const practiceBusiness = await prisma.business.findUniqueOrThrow({ where: { id: practiceAuth.body.business.id } });
    tenants.own(practiceBusiness.id);
    const practiceInstructor = await prisma.instructor.findUniqueOrThrow({
      where: { id: practiceAuth.body.membership.instructorId },
    });
    const practiceLocation = await prisma.location.create({
      data: { businessId: practiceBusiness.id, name: 'Private Court', travelMinutes: 20 },
    });
    const practiceService = await prisma.service.create({
      data: {
        businessId: practiceBusiness.id, name: 'Private coaching', type: 'PRIVATE',
        capacity: 1, duration: 60, price: 8000, noticeHours: 0, bufferMinutes: 0,
        locations: { create: {
          locationId: practiceLocation.id, price: 8000, duration: 60,
          instructors: { create: { instructorId: practiceInstructor.id } },
        } },
      },
    });
    await prisma.availability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: practiceBusiness.id, instructorId: practiceInstructor.id, locationId: practiceLocation.id,
        dayOfWeek, startTime: '08:00', endTime: '20:00',
      })),
    });
    const practiceStudent = await prisma.student.create({
      data: {
        businessId: practiceBusiness.id, name: 'Shared Student', initials: 'SS',
        email: studentAccount.email, userId: studentAccount.id,
      },
    });
    const priv = await request(app).post('/api/bookings')
      .set('Cookie', coach.session.cookie)
      .send({
        serviceId: practiceService.id, instructorId: practiceInstructor.id, locationId: practiceLocation.id,
        startAt: club.starts.plus({ days: 10 }).toISO(), studentId: practiceStudent.id,
      }).expect(201);
    expect(priv.body.bookings[0].paymentRoute).toBe('DIRECT');

    const flags = await request(app).get('/api/integrity-flags').set('Cookie', club.cookie).expect(200);
    const flag = flags.body.flags.find((candidate: { studentName: string }) => candidate.studentName === 'Shared Student');
    expect(flag).toMatchObject({
      status: 'OPEN', type: 'PRIVATE_SESSION_AFTER_CLUB', coachName: 'Roster Coach',
      outsideBusinessName: practiceBusiness.name,
    });
    expect(flag.detail).toContain('paid directly to the coach');

    const clubWorkspace = await request(app).get('/api/workspace').set('Cookie', club.cookie).expect(200);
    const integrityAlert = clubWorkspace.body.notifications.find((notification: { message: string; type: string }) =>
      notification.type === 'INTEGRITY' && notification.message.includes('Shared Student'));
    expect(integrityAlert).toMatchObject({ instructorId: null, actionNeeded: true });

    // The alert is for the club account to investigate. Assigning it to this
    // instructor would expose the allegation to the implicated coach.
    await request(app).post('/api/auth/switch-workspace')
      .set('Cookie', coach.session.cookie).send({ membershipId: coach.membership.id }).expect(200);
    const coachWorkspace = await request(app).get('/api/workspace')
      .set('Cookie', coach.session.cookie).expect(200);
    expect(coachWorkspace.body.notifications).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: integrityAlert.id })]),
    );
    expect(coachWorkspace.body.integrityFlags).toEqual([]);

    // The club rules on it; the platform only reports.
    const resolved = await request(app).patch(`/api/integrity-flags/${flag.id}`)
      .set('Cookie', club.cookie).send({ status: 'DISMISSED', note: 'Agreed with the coach in advance' }).expect(200);
    expect(resolved.body).toMatchObject({ status: 'DISMISSED', resolutionNote: 'Agreed with the coach in advance' });
    expect(resolved.body.resolvedAt).not.toBeNull();

    // A coach is not shown the club's review of their own conduct.
    await request(app).get('/api/integrity-flags').set('Cookie', coach.session.cookie).expect(403);
  });

  it('lets a coach add a venue and set their own reschedule window, but not edit the club catalogue', async () => {
    const coach = await coachOnRoster(club);
    const venue = await request(app).post('/api/locations').set('Cookie', coach.session.cookie).send({
      name: 'Bishan Courts', address: '1 Bishan Street', type: 'RENTED',
      source: 'GOOGLE_MAPS', placeId: 'ChIJtest', mapsUrl: 'https://www.google.com/maps/place/Bishan+Courts',
      latitude: 1.3526, longitude: 103.8352,
    }).expect(201);
    expect(venue.body).toMatchObject({ source: 'GOOGLE_MAPS', placeId: 'ChIJtest', latitude: 1.3526 });

    // Editing and archiving the club's venues stay with the club account.
    await request(app).patch(`/api/locations/${venue.body.id}`)
      .set('Cookie', coach.session.cookie).send({ name: 'Renamed' }).expect(403);

    const updated = await request(app).patch('/api/instructors/me')
      .set('Cookie', coach.session.cookie).send({ rescheduleNoticeHours: 48 }).expect(200);
    expect(updated.body).toMatchObject({ id: coach.instructor.id, rescheduleNoticeHours: 48 });
    // A coach still cannot reach another coach's roster entry.
    await request(app).patch(`/api/instructors/${club.instructor.id}`)
      .set('Cookie', coach.session.cookie).send({ rescheduleNoticeHours: 1 }).expect(403);
  });

  it('gives a coach their own practice where students pay them directly, without joining a club', async () => {
    const email = `${randomUUID()}@example.test`;
    const account = await createAccount(club, {
      name: 'Independent Coach', email, accountType: 'COACH', passwordHash: await bcrypt.hash(password, 4),
    });
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email, password }).expect(200);
    const created = await agent.post('/api/auth/practice').send({ name: 'Independent Coaching' }).expect(201);
    tenants.own(created.body.business.id);
    expect(created.body.business).toMatchObject({ kind: 'SOLO', name: 'Independent Coaching' });
    // The coach stays a coach: a practice is not a club, and no second role
    // is invented for running one.
    expect(created.body.user.accountType).toBe('COACH');
    expect(created.body.membership.businessId).toBe(created.body.business.id);
    // One practice per coach; a club is joined only by being added to it.
    await agent.post('/api/auth/practice').send({ name: 'Another Practice' }).expect(409);
    void account;
  });
});
