import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createSession, createStudent, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

/**
 * One lesson, followed from all three seats.
 *
 * The narrower suites prove each rule in isolation. This one checks that the
 * club's view, the coach's view and the student's view describe the same
 * lesson at every step, because that agreement is what the product is.
 */
describe.sequential('A lesson seen from every seat', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  const asClub = (method: 'get' | 'post' | 'patch' | 'delete', path: string) =>
    request(app)[method](`/api${path}`).set('Cookie', f.cookie);

  async function newCoachAccount(name = `Journey Coach ${randomUUID()}`) {
    const account = await createAccount(f, {
      name, accountType: 'COACH', passwordHash: 'registered-provider-account',
    });
    return account;
  }

  async function studentWithAccount(name = 'Journey Student') {
    const account = await createAccount(f, { name });
    const student = await createStudent(f, { userId: account.id, name });
    const { cookie } = await createSession(f, account.id);
    return { account, student, cookie };
  }

  it('walks a club-assigned lesson from roster to payout, agreeing at every step', async () => {
    // 1. The club adds a coach who already holds their own portable account.
    const coachAccount = await newCoachAccount();
    const hired = await asClub('post', '/staff').send({ email: coachAccount.email });
    expect(hired.status).toBe(201);
    expect(hired.body).toMatchObject({ accountType: 'COACH', active: true, email: coachAccount.email });
    const instructorId = hired.body.instructorId as string;
    expect(instructorId).toBeTruthy();

    const coachSession = await createSession(f, coachAccount.id, hired.body.id);
    const coachCookie = coachSession.cookie;

    // 2. The club opens the coach for business at its own venue.
    const serviceLocation = await prisma.serviceLocation.findUniqueOrThrow({
      where: { serviceId_locationId: { serviceId: f.service.id, locationId: f.location.id } },
    });
    await prisma.serviceInstructor.create({
      data: { serviceLocationId: serviceLocation.id, instructorId },
    });
    await prisma.availability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: f.business.id, instructorId, locationId: f.location.id,
        dayOfWeek, startTime: '08:00', endTime: '20:00',
      })),
    });

    // 3. The club books a student in with that coach. The student is told; the
    //    coach is asked; nothing is confirmed yet.
    const { account, student, cookie: studentCookie } = await studentWithAccount();
    const assigned = await asClub('post', '/bookings').send({
      serviceId: f.service.id, instructorId, locationId: f.location.id,
      startAt: f.starts.toISO(), studentId: student.id,
    });
    expect(assigned.status).toBe(201);
    const booking = assigned.body.bookings[0];
    expect(booking).toMatchObject({ status: 'PENDING', coachAcceptance: 'PENDING', paymentRoute: 'CLUB' });

    const clubBoard = await asClub('get', '/workspace');
    expect(clubBoard.body.notifications.some((n: { type: string; actionNeeded: boolean }) =>
      n.type === 'PENDING_ACTION' && n.actionNeeded)).toBe(true);

    const coachBoard = await request(app).get('/api/workspace').set('Cookie', coachCookie);
    expect(coachBoard.status).toBe(200);
    expect(coachBoard.body.bookings.map((b: { id: string }) => b.id)).toEqual([booking.id]);
    expect(coachBoard.body.bookings[0]).not.toHaveProperty('price');

    const waiting = await request(app).get('/api/account/bookings').set('Cookie', studentCookie);
    expect(waiting.status).toBe(200);
    expect(waiting.body.bookings[0]).toMatchObject({ awaitingCoach: true, canReschedule: false });
    const assignedAlert = await prisma.accountNotification.findFirst({
      where: { userId: account.id, bookingId: booking.id, type: 'BOOKING_ASSIGNED' },
    });
    expect(assignedAlert?.actionNeeded).toBe(false);

    // 4. The coach accepts. Every seat now says confirmed.
    const accepted = await request(app).post(`/api/bookings/${booking.id}/accept`)
      .set('Cookie', coachCookie).send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: 'CONFIRMED', coachAcceptance: 'ACCEPTED' });

    const confirmedForStudent = await request(app).get('/api/account/bookings').set('Cookie', studentCookie);
    expect(confirmedForStudent.body.bookings[0]).toMatchObject({ awaitingCoach: false, canCancel: true });
    expect(confirmedForStudent.body.bookings[0].booking.status).toBe('CONFIRMED');
    expect(await prisma.accountNotification.count({
      where: { userId: account.id, bookingId: booking.id, type: 'BOOKING_CONFIRMED' },
    })).toBe(1);

    // 5. The lesson happens. Attendance opens only once it has ended.
    const early = await request(app)
      .patch(`/api/bookings/${booking.id}/participants/${booking.participants[0].id}`)
      .set('Cookie', coachCookie).send({ attendance: 'PRESENT' });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('Attendance can only be marked after the lesson has ended');

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        startAt: new Date(Date.now() - 2 * 3_600_000),
        endAt: new Date(Date.now() - 3_600_000),
      },
    });
    const marked = await request(app)
      .patch(`/api/bookings/${booking.id}/participants/${booking.participants[0].id}`)
      .set('Cookie', coachCookie).send({ attendance: 'PRESENT' });
    expect(marked.status).toBe(200);
    expect(marked.body.attendance).toBe('PRESENT');

    const completed = await asClub('patch', `/bookings/${booking.id}`).send({ status: 'COMPLETED' });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('COMPLETED');

    // 6. The student pays the club, and the club pays the coach. Both legs sit
    //    in one ledger, on opposite sides of it.
    const receipt = await asClub('post', '/payments').send({
      studentId: student.id, bookingId: booking.id, amount: 8_000, method: 'CASH',
    });
    expect(receipt.status).toBe(201);
    expect(receipt.body.kind).toBe('STUDENT_TO_CLUB');

    const payout = await asClub('post', '/payouts').send({
      instructorId, amount: 5_000, method: 'BANK_TRANSFER',
    });
    expect(payout.status).toBe(201);
    expect(payout.body.kind).toBe('CLUB_TO_COACH');

    const finalClubBoard = await asClub('get', '/workspace');
    const kinds = finalClubBoard.body.payments.map((p: { kind: string }) => p.kind);
    expect(kinds).toEqual(expect.arrayContaining(['STUDENT_TO_CLUB', 'CLUB_TO_COACH']));

    const coachLedger = await request(app).get('/api/workspace').set('Cookie', coachCookie);
    expect(coachLedger.body.payments).toEqual([]);

    const studentAlerts = await request(app).get('/api/account/notifications').set('Cookie', studentCookie);
    expect(studentAlerts.body.notifications.some((n: { type: string }) => n.type === 'PAYMENT_RECORDED')).toBe(true);

    // 7. The coach leaves. Access ends; the history that names them does not.
    const removed = await asClub('delete', `/staff/${hired.body.id}`);
    expect(removed.status).toBe(200);

    const afterLeaving = await request(app).get('/api/workspace').set('Cookie', coachCookie);
    expect(afterLeaving.status).toBe(403);

    const retained = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id }, include: { instructor: true },
    });
    expect(retained.instructorId).toBe(instructorId);
    expect(retained.instructor.active).toBe(false);
    expect(await prisma.membership.count({ where: { id: hired.body.id } })).toBe(1);

    const studentHistory = await request(app).get('/api/account/bookings').set('Cookie', studentCookie);
    expect(studentHistory.status).toBe(200);
    expect(studentHistory.body.bookings[0].booking.instructorName).toBe(coachAccount.name);
  });

  it('lets a student negotiate a new time that only moves once the club agrees', async () => {
    const { account, student, cookie: studentCookie } = await studentWithAccount('Negotiating Student');
    const created = await asClub('post', '/bookings').send({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.toISO(), studentId: student.id,
    });
    expect(created.status).toBe(201);
    const booking = created.body.bookings[0];
    // The club booked its own roster coach, so there is a coach decision to
    // settle before either side can negotiate a time.
    const accepted = await request(app).post(`/api/bookings/${booking.id}/accept`)
      .set('Cookie', f.coachCookie).send({});
    expect(accepted.status).toBe(200);

    const participantId = booking.participants[0].id;
    const proposedStartAt = f.starts.plus({ days: 1 }).toISO();
    const proposal = await request(app)
      .post(`/api/account/bookings/${participantId}/reschedule-requests`)
      .set('Cookie', studentCookie).send({ startAt: proposedStartAt, message: 'Exams that week' });
    expect(proposal.status).toBe(201);
    expect(proposal.body.rescheduleRequest).toMatchObject({ requestedByRole: 'STUDENT', status: 'PENDING' });

    // Nothing has moved yet.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).startAt.toISOString())
      .toBe(f.starts.toUTC().toISO());

    const clubQueue = await asClub('get', '/reschedule-requests');
    expect(clubQueue.status).toBe(200);
    expect(clubQueue.body.requests[0]).toMatchObject({ bookingId: booking.id, status: 'PENDING' });
    const requestId = clubQueue.body.requests[0].id as string;

    // The side that asked cannot also answer.
    const selfAccept = await request(app)
      .post(`/api/account/reschedule-requests/${requestId}/accept`)
      .set('Cookie', studentCookie).send({});
    expect(selfAccept.status).toBe(403);

    const agreed = await asClub('post', `/reschedule-requests/${requestId}/accept`).send({ message: 'No problem' });
    expect(agreed.status).toBe(200);
    expect(agreed.body.request.status).toBe('ACCEPTED');
    expect(agreed.body.booking.startAt).toBe(new Date(proposedStartAt!).toISOString());

    const moved = await request(app).get('/api/account/bookings').set('Cookie', studentCookie);
    expect(moved.body.bookings[0].booking.startAt).toBe(new Date(proposedStartAt!).toISOString());
    expect(moved.body.bookings[0].rescheduleRequest).toBeNull();
    expect(await prisma.accountNotification.count({
      where: { userId: account.id, bookingId: booking.id, type: 'RESCHEDULE_ACCEPTED' },
    })).toBe(1);
  });

  it('gives the club the lesson back when its coach cannot take it', async () => {
    const { account, student, cookie: studentCookie } = await studentWithAccount('Reassigned Student');
    const pkg = await prisma.lessonPackage.create({
      data: {
        businessId: f.business.id, studentId: student.id, name: 'Five lessons',
        serviceId: f.service.id, totalCredits: 5, usedCredits: 0, price: 40_000,
        expiresAt: f.starts.plus({ months: 6 }).toJSDate(), paid: true,
      },
    });
    const created = await asClub('post', '/bookings').send({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.toISO(), studentId: student.id, packageId: pkg.id,
    });
    expect(created.status).toBe(201);
    const booking = created.body.bookings[0];
    expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).usedCredits).toBe(1);

    const declined = await request(app).post(`/api/bookings/${booking.id}/decline`)
      .set('Cookie', f.coachCookie).send({ message: 'Away that week' });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ status: 'CANCELLED', coachAcceptance: 'DECLINED' });

    // The slot is released, the credit comes back, and the club is asked to
    // find another coach.
    expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).usedCredits).toBe(0);
    const board = await asClub('get', '/workspace');
    const reassign = board.body.notifications.find((n: { title: string }) =>
      n.title === 'Coach declined an assigned lesson');
    expect(reassign).toMatchObject({ actionNeeded: true, type: 'PENDING_ACTION' });
    expect(reassign.message).toContain('Away that week');

    const studentView = await request(app).get('/api/account/bookings').set('Cookie', studentCookie);
    expect(studentView.body.bookings[0].booking.status).toBe('CANCELLED');
    const declinedAlert = await prisma.accountNotification.findFirst({
      where: { userId: account.id, bookingId: booking.id, type: 'BOOKING_CANCELLED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(declinedAlert?.title).toBe('Your coach could not take this lesson');
    expect(declinedAlert?.actionNeeded).toBe(true);
  });

  // A coach working inside a club is a coach and nothing more: their own
  // schedule, none of the club's roster, students, money or safeguard.
  it('keeps a club coach in their own lane across every workspace surface', async () => {
    const otherCoachAccount = await newCoachAccount('Other Coach');
    const hired = await asClub('post', '/staff').send({ email: otherCoachAccount.email });
    expect(hired.status).toBe(201);

    const mine = await createStudent(f, { name: 'Mine' });
    const theirs = await createStudent(f, { name: 'Theirs' });
    const otherInstructorId = hired.body.instructorId as string;
    const serviceLocation = await prisma.serviceLocation.findUniqueOrThrow({
      where: { serviceId_locationId: { serviceId: f.service.id, locationId: f.location.id } },
    });
    await prisma.serviceInstructor.create({
      data: { serviceLocationId: serviceLocation.id, instructorId: otherInstructorId },
    });
    for (const [instructorId, studentId, startAt] of [
      [f.instructor.id, mine.id, f.starts],
      [otherInstructorId, theirs.id, f.starts.plus({ hours: 3 })],
    ] as const) {
      await prisma.booking.create({
        data: {
          businessId: f.business.id, serviceId: f.service.id, instructorId,
          locationId: f.location.id, startAt: startAt.toJSDate(), endAt: startAt.plus({ minutes: 60 }).toJSDate(),
          duration: 60, bufferMinutes: 0, status: 'CONFIRMED', type: 'PRIVATE', capacity: 1, price: 8_000,
          paymentRoute: 'CLUB', coachAcceptance: 'NOT_REQUIRED', createdByRole: 'CLUB',
          participants: { create: { studentId, price: 8_000 } },
        },
      });
    }

    const board = await request(app).get('/api/workspace').set('Cookie', f.coachCookie);
    expect(board.status).toBe(200);
    expect(board.body.instructors.map((i: { id: string }) => i.id)).toEqual([f.instructor.id]);
    expect(board.body.students.map((s: { name: string }) => s.name)).toEqual(['Mine']);
    expect(board.body.bookings).toHaveLength(1);
    expect(board.body.packages).toEqual([]);
    expect(board.body.payments).toEqual([]);
    expect(board.body.integrityFlags).toEqual([]);
    for (const service of board.body.services) {
      expect(service).not.toHaveProperty('price');
      for (const location of service.locations) expect(location).not.toHaveProperty('price');
    }

    // The club-only surfaces answer the same way however they are reached.
    for (const [method, path] of [
      ['get', '/staff'], ['get', '/integrity-flags'], ['get', '/instructors'],
      ['get', '/locations'], ['get', '/packages'],
    ] as const) {
      const response = await request(app)[method](`/api${path}`).set('Cookie', f.coachCookie);
      expect(response.status, path).toBe(403);
    }
    const foreign = await request(app).post('/api/bookings').set('Cookie', f.coachCookie).send({
      serviceId: f.service.id, instructorId: otherInstructorId, locationId: f.location.id,
      startAt: f.starts.plus({ days: 2 }).toISO(), studentId: theirs.id,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe('Coaches can only access their own schedule');
  });
});
