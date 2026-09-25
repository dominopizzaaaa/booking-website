import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { createBookings } from '../src/scheduling.js';
import {
  TestTenants, createAccount, createPackage, createSession, createStudent, inputFor, prisma,
  publicInputFor, verifyTestDatabase, type Fixture,
} from './fixtures.js';

const originalConfig = {
  adminPassword: config.adminPassword,
  demoEnabled: config.demoEnabled,
};

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

async function legacyBooking(
  fixture: Fixture,
  dayOffset: number,
  options: { studentId?: string; packageId?: string } = {},
) {
  const studentId = options.studentId ?? (await createStudent(fixture, {
    name: `Legacy cancellation student ${dayOffset}`,
  })).id;
  const created = await createBookings(fixture.business.id, inputFor(fixture, {
    startAt: fixture.starts.plus({ days: dayOffset }).toISO()!,
    studentId, student: undefined, packageId: options.packageId,
  }));
  const booking = created.bookings[0]!;
  const participantId = booking.participants[0]!.id;
  const token = randomBytes(32).toString('base64url');
  await prisma.participant.update({
    where: { id: participantId },
    data: {
      managementTokenHash: createHash('sha256').update(token).digest('hex'),
      managementTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000),
      managementTokenRevokedAt: null,
    },
  });
  return { bookingId: booking.id, participantId, studentId, token };
}

describe.sequential('Final backend branch coverage', () => {
  let tenants: TestTenants;
  let fixture: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });

  afterEach(async () => {
    config.adminPassword = originalConfig.adminPassword;
    config.demoEnabled = originalConfig.demoEnabled;
    await tenants.cleanup();
  });

  it('treats a student declining their own reschedule request as a withdrawal', async () => {
    const account = await createAccount(fixture, { name: 'Withdrawing Student' });
    const session = await createSession(fixture, account.id);
    const created = await request(app).post(`/api/public/${fixture.business.slug}/bookings`)
      .set('Cookie', session.cookie).send(publicInputFor(fixture)).expect(201);
    const bookingId = created.body.bookings[0].id as string;
    const participantId = created.body.bookings[0].participants[0].id as string;

    const proposed = await request(app)
      .post(`/api/account/bookings/${participantId}/reschedule-requests`)
      .set('Cookie', session.cookie)
      .send({ startAt: fixture.starts.plus({ days: 1 }).toISO(), message: 'School event' })
      .expect(201);
    const requestId = proposed.body.rescheduleRequest.id as string;

    const withdrawn = await request(app)
      .post(`/api/account/reschedule-requests/${requestId}/decline`)
      .set('Cookie', session.cookie).send({ message: 'Original time now works' }).expect(200);
    expect(withdrawn.body).toMatchObject({
      booking: { id: bookingId, startAt: fixture.starts.toUTC().toISO() },
      rescheduleRequest: null,
    });
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } }))
      .toMatchObject({
        requestedByRole: 'STUDENT', requestedByUserId: account.id, status: 'WITHDRAWN',
        respondedByUserId: account.id, responseMessage: '',
      });
    expect((await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).respondedAt)
      .not.toBeNull();
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ startAt: fixture.starts.toJSDate(), status: 'CONFIRMED' });
    expect(await prisma.notification.findFirst({
      where: { bookingId, title: 'Reschedule request withdrawn' },
    })).not.toBeNull();
  });

  it('keeps legacy cancellation strict and refunds one package credit exactly once', async () => {
    const student = await createStudent(fixture, { name: 'Legacy Package Student' });
    const pkg = await createPackage(fixture, student.id, { totalCredits: 2 });
    const legacy = await legacyBooking(fixture, 1, { studentId: student.id, packageId: pkg.id });

    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } }))
      .toMatchObject({ usedCredits: 1 });
    await request(app).post(`/api/manage/${legacy.token}/cancel`)
      .send({ unexpected: true }).expect(400);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: legacy.participantId } }))
      .toMatchObject({ cancelledAt: null, creditConsumed: true });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } }))
      .toMatchObject({ usedCredits: 1 });

    const cancelled = await request(app).post(`/api/manage/${legacy.token}/cancel`)
      .send({}).expect(200);
    expect(cancelled.body).toMatchObject({
      booking: { id: legacy.bookingId, status: 'CANCELLED' },
      participant: { name: student.name, cancelled: true },
      canCancel: false,
    });
    const repeated = await request(app).post(`/api/manage/${legacy.token}/cancel`)
      .send({}).expect(200);
    expect(repeated.body).toMatchObject({
      booking: { id: legacy.bookingId, status: 'CANCELLED' },
      participant: { cancelled: true },
      canCancel: false,
    });

    expect(await prisma.participant.findUniqueOrThrow({ where: { id: legacy.participantId } }))
      .toMatchObject({ creditConsumed: false });
    expect((await prisma.participant.findUniqueOrThrow({ where: { id: legacy.participantId } })).cancelledAt)
      .not.toBeNull();
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } }))
      .toMatchObject({ usedCredits: 0 });
    expect(await prisma.notification.count({
      where: { bookingId: legacy.bookingId, title: 'Student cancelled a booking' },
    })).toBe(1);
  });

  it('rejects legacy cancellation inside the notice window and after completion or elapsed time', async () => {
    const notice = await legacyBooking(fixture, 2);
    const completed = await legacyBooking(fixture, 3);
    const elapsed = await legacyBooking(fixture, 4);
    const soon = new Date(Date.now() + 2 * 3_600_000);
    const past = new Date(Date.now() - 2 * 3_600_000);

    await prisma.booking.update({
      where: { id: notice.bookingId },
      data: { startAt: soon, endAt: new Date(soon.getTime() + 3_600_000) },
    });
    await prisma.booking.update({
      where: { id: completed.bookingId }, data: { status: 'COMPLETED' },
    });
    await prisma.booking.update({
      where: { id: elapsed.bookingId },
      data: { startAt: past, endAt: new Date(past.getTime() + 3_600_000) },
    });

    for (const legacy of [notice, completed, elapsed]) {
      const rejected = await request(app).post(`/api/manage/${legacy.token}/cancel`)
        .send({}).expect(400);
      expect(rejected.body.error).toBe(
        `Cancellation requires ${fixture.business.cancellationHours} hours notice. Please contact your coach.`,
      );
      expect(await prisma.participant.findUniqueOrThrow({ where: { id: legacy.participantId } }))
        .toMatchObject({ cancelledAt: null });
    }
    expect(await prisma.notification.count({
      where: { businessId: fixture.business.id, title: 'Student cancelled a booking' },
    })).toBe(0);
  });

  it('uses the club money path for unallocated payments and keeps roster coaches out of the ledger', async () => {
    const clubStudent = await createStudent(fixture, { name: 'Club Unallocated Payer' });
    const clubPayment = await request(app).post('/api/payments').set('Cookie', fixture.cookie).send({
      studentId: clubStudent.id, amount: 2_500, method: 'CASH', note: 'Account credit',
    }).expect(201);
    expect(clubPayment.body).toMatchObject({
      businessId: fixture.business.id, studentId: clubStudent.id, bookingId: null,
      packageId: null, instructorId: null, kind: 'STUDENT_TO_CLUB', amount: 2_500,
    });

    const paymentCount = await prisma.payment.count({ where: { businessId: fixture.business.id } });
    const deniedPayment = await request(app).post('/api/payments')
      .set('Cookie', fixture.coachCookie).send({
        studentId: clubStudent.id, amount: 3_500, method: 'BANK_TRANSFER', note: 'Hidden account credit',
      }).expect(403);
    expect(deniedPayment.body.error).toBe('Only the club account can do this');

    const deniedPayout = await request(app).post('/api/payouts')
      .set('Cookie', fixture.coachCookie).send({
        instructorId: fixture.instructor.id, amount: 1_500, method: 'CASH', note: 'Hidden payout',
      }).expect(403);
    expect(deniedPayout.body.error).toBe('Only the club account can do this');
    expect(await prisma.payment.count({ where: { businessId: fixture.business.id } }))
      .toBe(paymentCount);
  });

  it('refuses demo creation while demo mode is disabled', async () => {
    config.demoEnabled = false;
    const response = await request(app).post('/api/auth/demo').send({}).expect(403);
    expect(response.body).toEqual({ error: 'Demo mode is disabled' });
  });

  it('reports and enforces an unconfigured admin console', async () => {
    config.adminPassword = '';
    const session = await request(app).get('/api/admin/session').expect(200);
    expect(session.body).toEqual({ configured: false, authenticated: false });
    const login = await request(app).post('/api/admin/login')
      .send({ password: 'unused-admin-password' }).expect(503);
    expect(login.body).toEqual({ error: 'Admin console is not configured' });
    const overview = await request(app).get('/api/admin/overview').expect(503);
    expect(overview.body).toEqual({ error: 'Admin console is not configured' });
  });

  it('returns packages and availability exceptions directly for a club manager', async () => {
    const student = await createStudent(fixture, { name: 'Listed Package Student' });
    const pkg = await createPackage(fixture, student.id, { totalCredits: 8, usedCredits: 2 });
    const exception = await prisma.availabilityException.create({
      data: {
        businessId: fixture.business.id, instructorId: fixture.instructor.id,
        date: fixture.starts.toISODate()!, reason: 'Tournament day',
      },
    });

    const packages = await request(app).get('/api/packages').set('Cookie', fixture.cookie).expect(200);
    expect(packages.body).toEqual([expect.objectContaining({
      id: pkg.id, studentId: student.id, studentName: student.name,
      totalCredits: 8, usedCredits: 2, paid: true,
    })]);
    const exceptions = await request(app).get('/api/exceptions')
      .set('Cookie', fixture.cookie).expect(200);
    expect(exceptions.body).toEqual([{
      id: exception.id, instructorId: fixture.instructor.id,
      date: fixture.starts.toISODate(), reason: 'Tournament day',
    }]);
  });

  it('lets a coach explicitly leave all workspaces with membershipId null', async () => {
    const session = await createSession(fixture, fixture.coachUser.id, fixture.coachMembership.id);
    const switched = await request(app).post('/api/auth/switch-workspace')
      .set('Cookie', session.cookie).send({ membershipId: null }).expect(200);
    expect(switched.body).toMatchObject({
      user: { id: fixture.coachUser.id, accountType: 'COACH' },
      membership: null, business: null,
      memberships: [expect.objectContaining({ id: fixture.coachMembership.id })],
    });
    expect(await prisma.authSession.findUniqueOrThrow({ where: { id: session.session.id } }))
      .toMatchObject({ activeMembershipId: null });
    const denied = await request(app).get('/api/workspace')
      .set('Cookie', session.cookie).expect(403);
    expect(denied.body).toEqual({ error: 'Select a business workspace to continue' });
  });
});
