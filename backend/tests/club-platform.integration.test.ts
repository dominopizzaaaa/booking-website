import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { initials } from '../src/http.js';
import { parseMapsLink } from '../src/venues.js';
import {
  TestTenants, createAccount, createCustomer, createSession, prisma, publicInputFor,
  verifyTestDatabase, type Fixture,
} from './fixtures.js';

const password = 'a-long-enough-test-password';
const tenants = new TestTenants();

describe('Name initials', () => {
  it('reads letters rather than whatever follows a space', () => {
    // The reported case: a bracketed role qualifier used to become the second
    // "initial", so the avatar read "D(" instead of "D".
    expect(initials('Dominic (Coach)')).toBe('DC');
    expect(initials('Dominic (')).toBe('D');
    expect(initials('D(')).toBe('D');
    expect(initials('  Mary-Jane   Watson ')).toBe('MW');
    expect(initials('陈 伟')).toBe('陈伟');
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
      data: { userId: account.id, businessId: f.business.id, role: 'COACH', instructorId: instructor.id },
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
    const customer = await createCustomer(club, { name: 'Assigned Student' });

    const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: coach.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 1 }).toISO(), customerId: customer.id,
    }).expect(201);
    const booking = created.body.bookings[0];
    // The student is not asked to accept; the coach is.
    expect(booking).toMatchObject({ status: 'PENDING', coachAcceptance: 'PENDING', createdByRole: 'CLUB' });

    // Until the coach answers, the session is not confirmed and cannot be
    // renegotiated by anyone.
    await request(app).post(`/api/bookings/${booking.id}/reschedule-requests`)
      .set('Cookie', club.cookie).send({ startAt: club.starts.plus({ days: 2 }).toISO() }).expect(400);

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

  it('releases the slot and tells the club when the assigned coach declines', async () => {
    const coach = await coachOnRoster(club);
    const customer = await createCustomer(club, { name: 'Declined Student' });
    const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: coach.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 3 }).toISO(), customerId: customer.id,
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
    const customer = await createCustomer(club, { name: 'Paying Student' });
    const created = await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: club.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 8 }).toISO(), customerId: customer.id,
    }).expect(201);
    const booking = created.body.bookings[0];
    // A club collects from the student; the coach is paid later by the club.
    expect(booking.paymentRoute).toBe('CLUB');

    const payment = await request(app).post('/api/payments').set('Cookie', club.cookie).send({
      customerId: customer.id, bookingId: booking.id, amount: booking.price,
      method: 'BANK_TRANSFER', note: 'Lesson payment',
    }).expect(201);
    expect(payment.body.kind).toBe('CUSTOMER_TO_CLUB');
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
      customerId: customer.id, bookingId: booking.id, amount: booking.price, method: 'CASH', note: 'Re-recorded',
    }).expect(201);
    expect(await prisma.participant.findFirstOrThrow({ where: { bookingId: booking.id } }))
      .toMatchObject({ paid: true });
  });

  it('flags a private session between a coach and a student who met through a club', async () => {
    const coach = await coachOnRoster(club);
    const studentAccount = await createAccount(club, { name: 'Shared Student' });
    const clubCustomer = await createCustomer(club, {
      name: 'Shared Student', email: studentAccount.email, userId: studentAccount.id,
    });
    await request(app).post('/api/bookings').set('Cookie', club.cookie).send({
      serviceId: club.service.id, instructorId: coach.instructor.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 9 }).toISO(), customerId: clubCustomer.id,
    }).expect(201);

    // The same coach account now runs its own practice, where students pay the
    // coach directly.
    const practice = await tenants.fixture();
    await prisma.business.update({ where: { id: practice.business.id }, data: { kind: 'SOLO' } });
    await prisma.membership.update({
      where: { id: practice.membership.id }, data: { userId: coach.account.id },
    });
    const practiceCustomer = await createCustomer(practice, {
      name: 'Shared Student', email: studentAccount.email, userId: studentAccount.id,
    });
    const priv = await request(app).post('/api/bookings')
      .set('Cookie', (await createSession(practice, coach.account.id, practice.membership.id)).cookie)
      .send({
        serviceId: practice.service.id, instructorId: practice.instructor.id, locationId: practice.location.id,
        startAt: practice.starts.plus({ days: 10 }).toISO(), customerId: practiceCustomer.id,
      }).expect(201);
    expect(priv.body.bookings[0].paymentRoute).toBe('DIRECT');

    const flags = await request(app).get('/api/integrity-flags').set('Cookie', club.cookie).expect(200);
    const flag = flags.body.flags.find((candidate: { customerName: string }) => candidate.customerName === 'Shared Student');
    expect(flag).toMatchObject({
      status: 'OPEN', type: 'PRIVATE_SESSION_AFTER_CLUB', coachName: 'Roster Coach',
      outsideBusinessName: practice.business.name,
    });
    expect(flag.detail).toContain('paid directly to the coach');

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

    // Editing and archiving the club's venues stay with an owner or admin.
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
    expect(created.body.membership.role).toBe('OWNER');
    // One practice per coach; a club is joined only by being added to it.
    await agent.post('/api/auth/practice').send({ name: 'Another Practice' }).expect(409);
    void account;
  });
});
