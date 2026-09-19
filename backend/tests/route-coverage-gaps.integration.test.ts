import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createSession, createStudent, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type HistoricalBookingOptions = {
  instructorId?: string;
  startAt?: DateTime;
  status?: string;
  studentUserId?: string | null;
  name?: string;
};

async function historicalBooking(f: Fixture, options: HistoricalBookingOptions = {}) {
  const startAt = options.startAt ?? f.starts;
  const student = await createStudent(f, {
    userId: options.studentUserId ?? null,
    name: options.name ?? `Historical Student ${randomUUID()}`,
  });
  const booking = await prisma.booking.create({
    data: {
      businessId: f.business.id,
      serviceId: f.service.id,
      instructorId: options.instructorId ?? f.instructor.id,
      locationId: f.location.id,
      startAt: startAt.toJSDate(),
      endAt: startAt.plus({ minutes: 60 }).toJSDate(),
      duration: 60,
      bufferMinutes: 0,
      status: options.status ?? 'CONFIRMED',
      type: 'PRIVATE',
      capacity: 1,
      price: 8_000,
      paymentRoute: 'CLUB',
      coachAcceptance: 'NOT_REQUIRED',
      createdByRole: 'CLUB',
      createdByUserId: f.user.id,
      participants: {
        create: { studentId: student.id, price: 8_000 },
      },
    },
    include: { participants: true },
  });
  return { booking, participant: booking.participants[0]!, student };
}

async function rosterCoach(f: Fixture, name = `Roster Coach ${randomUUID()}`) {
  const account = await createAccount(f, {
    name,
    email: `${randomUUID()}@example.test`,
    accountType: 'COACH',
    passwordHash: 'registered-provider-account',
  });
  const instructor = await prisma.instructor.create({
    data: { businessId: f.business.id, name, initials: 'RC', email: account.email },
  });
  const membership = await prisma.membership.create({
    data: { userId: account.id, businessId: f.business.id, instructorId: instructor.id },
  });
  const session = await createSession(f, account.id, membership.id);
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
  return { account, instructor, membership, session };
}

describe.sequential('Previously uncovered provider routes', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  async function advisoryLockWaiterCount(lockKey: string) {
    const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*)::bigint AS waiting
      FROM pg_locks
      WHERE locktype = 'advisory' AND objsubid = 1 AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid::bigint = ((hashtextextended(${lockKey}, 0) >> 32) & 4294967295)
        AND objid::bigint = (hashtextextended(${lockKey}, 0) & 4294967295)
    `;
    return Number(rows[0]?.waiting ?? 0);
  }

  async function withHeldInstructorLock<T>(
    action: () => Promise<T>,
    mutate: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    let continueHolder!: () => void;
    let locked!: () => void;
    const lockHeld = new Promise<void>(resolve => { locked = resolve; });
    const continueTransaction = new Promise<void>(resolve => { continueHolder = resolve; });
    let shouldMutate = false;
    const holder = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${f.instructor.id}, 0))`;
      locked();
      await continueTransaction;
      if (shouldMutate) await mutate(tx);
    }, { timeout: 30_000 });

    try {
      await Promise.race([lockHeld, holder]);
    } catch (error) {
      continueHolder();
      await Promise.allSettled([holder]);
      throw error;
    }

    const pending = Promise.resolve().then(action);
    void pending.catch(() => {});
    try {
      await expect.poll(
        () => advisoryLockWaiterCount(f.instructor.id),
        { timeout: 5_000 },
      ).toBe(1);
      // The route has read the initial booking and is visibly waiting for its
      // scheduling lock. Commit the student link while it waits so the
      // post-lock participant query must observe the newly registered account.
      shouldMutate = true;
    } catch (cause) {
      throw new Error('Request did not reach the instructor-lock barrier', { cause });
    } finally {
      continueHolder();
      await Promise.allSettled([holder, pending]);
    }

    await holder;
    return pending;
  }

  it('lists tenant instructors in name order and keeps manager updates strict and scoped', async () => {
    const other = await tenants.fixture();
    const alpha = await prisma.instructor.create({
      data: { businessId: f.business.id, name: 'Alpha Archived', initials: 'AA', active: false },
    });
    const zulu = await prisma.instructor.create({
      data: { businessId: f.business.id, name: 'Zulu Unclaimed', initials: 'ZU' },
    });

    const listed = await request(app).get('/api/instructors').set('Cookie', f.cookie).expect(200);
    expect(listed.body.map((instructor: { id: string }) => instructor.id)).toEqual([
      alpha.id, f.instructor.id, zulu.id,
    ]);
    expect(listed.body).toContainEqual(expect.objectContaining({ id: alpha.id, active: false }));
    expect(JSON.stringify(listed.body)).not.toContain(other.instructor.id);
    expect(Object.keys(listed.body[0]).sort()).toEqual([
      'active', 'color', 'email', 'id', 'initials', 'name',
      'rescheduleNoticeHours', 'specialty',
    ]);

    await request(app).get('/api/instructors').set('Cookie', f.coachCookie).expect(403);
    await request(app).patch(`/api/instructors/${f.instructor.id}`).set('Cookie', f.coachCookie)
      .send({ specialty: 'Coach overwrite' }).expect(403);
    await request(app).patch(`/api/instructors/${f.instructor.id}`).set('Cookie', f.cookie)
      .send({}).expect(400);
    await request(app).patch(`/api/instructors/${f.instructor.id}`).set('Cookie', f.cookie)
      .send({ name: 'Identity overwrite' }).expect(400);
    await request(app).patch(`/api/instructors/${f.instructor.id}`).set('Cookie', f.cookie)
      .send({ rescheduleNoticeHours: 721 }).expect(400);
    await request(app).patch(`/api/instructors/${other.instructor.id}`).set('Cookie', f.cookie)
      .send({ specialty: 'Foreign overwrite' }).expect(404);

    const updated = await request(app).patch(`/api/instructors/${f.instructor.id}`).set('Cookie', f.cookie).send({
      specialty: 'Doubles strategy', color: '#335577', rescheduleNoticeHours: 72, active: false,
    }).expect(200);
    expect(updated.body).toMatchObject({
      id: f.instructor.id, name: f.instructor.name, email: f.instructor.email,
      specialty: 'Doubles strategy', color: '#335577', rescheduleNoticeHours: 72, active: false,
    });
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: other.instructor.id } }))
      .toMatchObject({ specialty: other.instructor.specialty, active: true });

    // A coach manages this same route in their own SOLO practice, but not while
    // they are a roster coach inside somebody else's club.
    const practice = await request(app).post('/api/auth/practice').set('Cookie', f.coachCookie)
      .send({ name: 'Route Coverage Practice' }).expect(201);
    tenants.own(practice.body.business.id);
    const soloList = await request(app).get('/api/instructors').set('Cookie', f.coachCookie).expect(200);
    expect(soloList.body).toEqual([expect.objectContaining({
      id: practice.body.membership.instructorId, name: f.coachUser.name, active: true,
    })]);
    await request(app).patch(`/api/instructors/${practice.body.membership.instructorId}`)
      .set('Cookie', f.coachCookie).send({ specialty: 'Solo specialist' }).expect(200);
    const soloArchived = await request(app).delete(`/api/instructors/${practice.body.membership.instructorId}`)
      .set('Cookie', f.coachCookie).expect(200);
    expect(soloArchived.body).toEqual({ ok: true, deactivated: true });
  });

  it('hard-deletes disposable instructors but archives referenced history and removes bookability', async () => {
    const other = await tenants.fixture();
    const historical = await historicalBooking(f);
    const before = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(before.body.instructors).toContainEqual(expect.objectContaining({ id: f.instructor.id }));

    await request(app).delete(`/api/instructors/${f.instructor.id}`)
      .set('Cookie', f.coachCookie).expect(403);
    await request(app).delete(`/api/instructors/${f.instructor.id}`)
      .set('Cookie', other.cookie).expect(404);

    const archived = await request(app).delete(`/api/instructors/${f.instructor.id}`)
      .set('Cookie', f.cookie).expect(200);
    expect(archived.body).toEqual({ ok: true, deactivated: true });
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: f.instructor.id } }))
      .toMatchObject({ active: false });
    expect(await prisma.membership.findUniqueOrThrow({ where: { id: f.coachMembership.id } }))
      .toMatchObject({ active: true, instructorId: f.instructor.id });
    expect(await prisma.booking.findUnique({ where: { id: historical.booking.id } })).not.toBeNull();

    const retained = await request(app).get('/api/instructors').set('Cookie', f.cookie).expect(200);
    expect(retained.body).toContainEqual(expect.objectContaining({ id: f.instructor.id, active: false }));
    const publicAfter = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(publicAfter.body.instructors.map((instructor: { id: string }) => instructor.id))
      .not.toContain(f.instructor.id);
    await request(app).get(`/api/public/${f.business.slug}/slots`).query({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      date: f.starts.toISODate(),
    }).expect(404);

    const disposable = await prisma.instructor.create({
      data: { businessId: f.business.id, name: 'Disposable Coach', initials: 'DC' },
    });
    const removed = await request(app).delete(`/api/instructors/${disposable.id}`)
      .set('Cookie', f.cookie).expect(200);
    expect(removed.body).toEqual({ ok: true, deactivated: false });
    expect(await prisma.instructor.findUnique({ where: { id: disposable.id } })).toBeNull();
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: other.instructor.id } }))
      .toMatchObject({ active: true });
  });

  it('lists reschedule requests by status and recency while isolating clubs and coaches', async () => {
    const otherTenant = await tenants.fixture();
    const secondCoach = await rosterCoach(f, 'Second Request Coach');
    const ownAcceptedBooking = await historicalBooking(f, { startAt: f.starts.plus({ days: 1 }) });
    const ownOlderBooking = await historicalBooking(f, { startAt: f.starts.plus({ days: 3 }) });
    const ownNewerBooking = await historicalBooking(f, { startAt: f.starts.plus({ days: 5 }) });
    const secondCoachBooking = await historicalBooking(f, {
      instructorId: secondCoach.instructor.id, startAt: f.starts.plus({ days: 7 }),
    });
    const foreignBooking = await historicalBooking(otherTenant, { startAt: otherTenant.starts.plus({ days: 9 }) });
    const now = Date.now();

    const requestFor = (fixture: Fixture, bookingId: string, overrides: {
      status: string; createdAt: Date; proposedStartAt: Date;
    }) => prisma.rescheduleRequest.create({
      data: {
        businessId: fixture.business.id, bookingId, requestedByRole: 'CLUB',
        requestedByUserId: fixture.user.id, originalStartAt: fixture.starts.toJSDate(),
        proposedStartAt: overrides.proposedStartAt,
        proposedEndAt: new Date(overrides.proposedStartAt.getTime() + 60 * 60_000),
        status: overrides.status, createdAt: overrides.createdAt,
        ...(overrides.status === 'ACCEPTED' ? { respondedAt: overrides.createdAt } : {}),
      },
    });

    const accepted = await requestFor(f, ownAcceptedBooking.booking.id, {
      status: 'ACCEPTED', createdAt: new Date(now - 4_000),
      proposedStartAt: f.starts.plus({ days: 2 }).toJSDate(),
    });
    const ownOlder = await requestFor(f, ownOlderBooking.booking.id, {
      status: 'PENDING', createdAt: new Date(now - 3_000),
      proposedStartAt: f.starts.plus({ days: 4 }).toJSDate(),
    });
    const ownNewer = await requestFor(f, ownNewerBooking.booking.id, {
      status: 'PENDING', createdAt: new Date(now - 2_000),
      proposedStartAt: f.starts.plus({ days: 6 }).toJSDate(),
    });
    const secondCoachRequest = await requestFor(f, secondCoachBooking.booking.id, {
      status: 'PENDING', createdAt: new Date(now - 1_000),
      proposedStartAt: f.starts.plus({ days: 8 }).toJSDate(),
    });
    const foreign = await requestFor(otherTenant, foreignBooking.booking.id, {
      status: 'ACCEPTED', createdAt: new Date(now),
      proposedStartAt: otherTenant.starts.plus({ days: 10 }).toJSDate(),
    });

    const clubList = await request(app).get('/api/reschedule-requests').set('Cookie', f.cookie).expect(200);
    expect(clubList.body.requests.map((item: { id: string }) => item.id)).toEqual([
      accepted.id, secondCoachRequest.id, ownNewer.id, ownOlder.id,
    ]);
    expect(JSON.stringify(clubList.body)).not.toContain(foreign.id);
    expect(clubList.body.requests[0]).toMatchObject({
      id: accepted.id, bookingId: ownAcceptedBooking.booking.id, requestedByRole: 'CLUB',
      requestedByUserId: f.user.id, status: 'ACCEPTED',
      serviceName: f.service.name, instructorName: f.instructor.name,
      locationName: f.location.name, businessName: f.business.name, timezone: f.business.timezone,
    });
    expect(clubList.body.requests[0]).not.toHaveProperty('booking');
    expect(clubList.body.requests[0]).not.toHaveProperty('participants');
    expect(clubList.body.requests[0]).not.toHaveProperty('price');

    const ownCoachList = await request(app).get('/api/reschedule-requests')
      .set('Cookie', f.coachCookie).expect(200);
    expect(ownCoachList.body.requests.map((item: { id: string }) => item.id)).toEqual([
      accepted.id, ownNewer.id, ownOlder.id,
    ]);
    const secondCoachList = await request(app).get('/api/reschedule-requests')
      .set('Cookie', secondCoach.session.cookie).expect(200);
    expect(secondCoachList.body.requests.map((item: { id: string }) => item.id))
      .toEqual([secondCoachRequest.id]);
    const foreignList = await request(app).get('/api/reschedule-requests')
      .set('Cookie', otherTenant.cookie).expect(200);
    expect(foreignList.body.requests.map((item: { id: string }) => item.id)).toEqual([foreign.id]);
  });

  it('one-sided rescheduling accepts only strict input for an unlinked historical student', async () => {
    const historical = await historicalBooking(f);
    const movedStart = f.starts.plus({ days: 1 });

    await request(app).post(`/api/bookings/${historical.booking.id}/reschedule`)
      .set('Cookie', f.coachCookie)
      .send({ startAt: movedStart.toISO(), unexpected: true }).expect(400);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: historical.booking.id } }))
      .toMatchObject({ startAt: f.starts.toJSDate() });

    const moved = await request(app).post(`/api/bookings/${historical.booking.id}/reschedule`)
      .set('Cookie', f.coachCookie).send({ startAt: movedStart.toISO() }).expect(200);
    expect(moved.body).toMatchObject({
      id: historical.booking.id, startAt: movedStart.toUTC().toISO(),
      endAt: movedStart.plus({ hours: 1 }).toUTC().toISO(), status: 'CONFIRMED',
    });
    expect(moved.body).not.toHaveProperty('price');
    expect(moved.body.participants).toEqual([expect.objectContaining({ id: historical.participant.id })]);
    expect(moved.body.participants[0]).not.toHaveProperty('paid');
    expect(moved.body.participants[0]).not.toHaveProperty('price');
    expect(moved.body.participants[0]).not.toHaveProperty('packageId');
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: historical.booking.id } }))
      .toMatchObject({ startAt: movedStart.toJSDate(), endAt: movedStart.plus({ hours: 1 }).toJSDate() });
    expect(await prisma.notification.findMany({ where: { bookingId: historical.booking.id } }))
      .toEqual([expect.objectContaining({ businessId: f.business.id, type: 'RESCHEDULE' })]);
  });

  it('keeps provider withdrawal bodies strict and leaves rejected requests pending', async () => {
    const studentAccount = await createAccount(f, { name: 'Withdrawal Student' });
    const historical = await historicalBooking(f, {
      studentUserId: studentAccount.id, startAt: f.starts.plus({ days: 1 }),
    });
    const proposedStart = f.starts.plus({ days: 2 });
    const proposed = await request(app).post(`/api/bookings/${historical.booking.id}/reschedule-requests`)
      .set('Cookie', f.cookie).send({ startAt: proposedStart.toISO() }).expect(201);

    await request(app).post(`/api/reschedule-requests/${proposed.body.id}/withdraw`)
      .set('Cookie', f.cookie).send({ unexpected: true }).expect(400);
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: proposed.body.id } }))
      .toMatchObject({ status: 'PENDING', respondedAt: null });

    const withdrawn = await request(app).post(`/api/reschedule-requests/${proposed.body.id}/withdraw`)
      .set('Cookie', f.cookie).send({}).expect(200);
    expect(withdrawn.body).toMatchObject({ id: proposed.body.id, status: 'WITHDRAWN' });
  });

  it('rejects registered students, foreign bookings, and another coach schedule without moving anything', async () => {
    const otherTenant = await tenants.fixture();
    const studentAccount = await createAccount(f, { name: 'Registered Route Student' });
    const registered = await historicalBooking(f, { studentUserId: studentAccount.id });
    const foreign = await historicalBooking(otherTenant);
    const secondCoach = await rosterCoach(f, 'Other Schedule Coach');
    const otherSchedule = await historicalBooking(f, {
      instructorId: secondCoach.instructor.id, startAt: f.starts.plus({ days: 2 }),
    });

    const rejected = await request(app).post(`/api/bookings/${registered.booking.id}/reschedule`)
      .set('Cookie', f.cookie).send({ startAt: f.starts.plus({ days: 1 }).toISO() }).expect(409);
    expect(rejected.body.error).toBe(
      'Propose a new time instead. A session with a registered student moves only once they accept the change.',
    );
    await request(app).post(`/api/bookings/${foreign.booking.id}/reschedule`)
      .set('Cookie', f.cookie).send({ startAt: otherTenant.starts.plus({ days: 1 }).toISO() }).expect(404);
    const wrongCoach = await request(app).post(`/api/bookings/${otherSchedule.booking.id}/reschedule`)
      .set('Cookie', f.coachCookie).send({ startAt: f.starts.plus({ days: 3 }).toISO() }).expect(403);
    expect(wrongCoach.body.error).toBe('Coaches can only access their own schedule');

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: registered.booking.id } }))
      .toMatchObject({ startAt: f.starts.toJSDate() });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: foreign.booking.id } }))
      .toMatchObject({ startAt: otherTenant.starts.toJSDate() });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: otherSchedule.booking.id } }))
      .toMatchObject({ startAt: f.starts.plus({ days: 2 }).toJSDate() });
  });

  it('rechecks for a newly linked student after taking the one-sided reschedule lock', async () => {
    const historical = await historicalBooking(f);
    const account = await createAccount(f, { name: historical.student.name });
    const proposedStart = f.starts.plus({ days: 1 });

    const response = await withHeldInstructorLock(
      () => request(app).post(`/api/bookings/${historical.booking.id}/reschedule`)
        .set('Cookie', f.cookie).send({ startAt: proposedStart.toISO() }),
      tx => tx.student.update({
        where: { id: historical.student.id }, data: { userId: account.id },
      }),
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toBe(
      'Propose a new time instead. A session with a registered student moves only once they accept the change.',
    );
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: historical.booking.id } }))
      .toMatchObject({ startAt: f.starts.toJSDate(), endAt: f.starts.plus({ hours: 1 }).toJSDate() });
    expect(await prisma.notification.count({ where: { bookingId: historical.booking.id, type: 'RESCHEDULE' } }))
      .toBe(0);
  });

  it('refuses a one-sided move while the assigned coach has not accepted the lesson', async () => {
    const historical = await historicalBooking(f);
    await prisma.booking.update({
      where: { id: historical.booking.id },
      data: { status: 'PENDING', coachAcceptance: 'PENDING' },
    });

    const response = await request(app).post(`/api/bookings/${historical.booking.id}/reschedule`)
      .set('Cookie', f.cookie).send({ startAt: f.starts.plus({ days: 1 }).toISO() }).expect(400);
    expect(response.body.error).toBe(
      'This lesson is still waiting for the coach to accept it. Reschedule it once it is confirmed.',
    );
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: historical.booking.id } }))
      .toMatchObject({
        status: 'PENDING', coachAcceptance: 'PENDING', startAt: f.starts.toJSDate(),
      });
    expect(await prisma.notification.count({
      where: { bookingId: historical.booking.id, type: 'RESCHEDULE' },
    })).toBe(0);
  });

  it('refuses one-sided moves for terminal booking lifecycle states', async () => {
    const cancelled = await historicalBooking(f, { status: 'CANCELLED' });
    const completed = await historicalBooking(f, {
      status: 'COMPLETED', startAt: f.starts.plus({ days: 2 }),
    });

    for (const [bookingId, proposedStart] of [
      [cancelled.booking.id, f.starts.plus({ days: 1 })],
      [completed.booking.id, f.starts.plus({ days: 3 })],
    ] as const) {
      const response = await request(app).post(`/api/bookings/${bookingId}/reschedule`)
        .set('Cookie', f.cookie).send({ startAt: proposedStart.toISO() }).expect(400);
      expect(response.body.error).toBe('Only active sessions can be rescheduled');
    }
    expect(await prisma.notification.count({ where: { businessId: f.business.id, type: 'RESCHEDULE' } })).toBe(0);
  });

  it('keeps a historical booking unchanged when the requested slot conflicts or is outside working hours', async () => {
    const target = await historicalBooking(f);
    const occupiedStart = f.starts.plus({ days: 1 });
    await historicalBooking(f, { startAt: occupiedStart, name: 'Blocking Student' });

    const collision = await request(app).post(`/api/bookings/${target.booking.id}/reschedule`)
      .set('Cookie', f.cookie).send({ startAt: occupiedStart.toISO() }).expect(409);
    expect(collision.body).toMatchObject({
      error: 'Requested time is unavailable',
      conflicts: [{
        date: occupiedStart.toISO(),
        reason: 'Coach already has a session or preparation buffer',
      }],
    });

    const outsideHours = f.starts.plus({ days: 2 }).set({ hour: 21 });
    const closed = await request(app).post(`/api/bookings/${target.booking.id}/reschedule`)
      .set('Cookie', f.cookie).send({ startAt: outsideHours.toISO() }).expect(409);
    expect(closed.body).toMatchObject({
      error: 'Requested time is unavailable',
      conflicts: [{ date: outsideHours.toISO(), reason: 'Outside working hours at this location' }],
    });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: target.booking.id } }))
      .toMatchObject({ startAt: f.starts.toJSDate(), endAt: f.starts.plus({ hours: 1 }).toJSDate() });
    expect(await prisma.notification.count({ where: { bookingId: target.booking.id, type: 'RESCHEDULE' } })).toBe(0);
  });
});
