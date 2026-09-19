import request from 'supertest';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { createBookings } from '../src/scheduling.js';
import {
  createAccount, createSession, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Participant attendance lifecycle', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => { tenants = new TestTenants(); f = await tenants.fixture(); });
  afterEach(async () => { await tenants.cleanup(); });

  async function booking() {
    const student = await createStudent(f);
    const created = await createBookings(f.business.id, inputFor(f, {
      studentId: student.id, student: undefined,
    }));
    return {
      bookingId: created.bookings[0]!.id,
      participantId: created.bookings[0]!.participants[0]!.id,
    };
  }

  const attendancePath = (ids: { bookingId: string; participantId: string }) =>
    `/api/bookings/${ids.bookingId}/participants/${ids.participantId}`;

  async function makeEnded(bookingId: string, status: 'CONFIRMED' | 'COMPLETED' = 'CONFIRMED') {
    const endAt = new Date(Date.now() - 60_000);
    await prisma.booking.update({
      where: { id: bookingId },
      data: { startAt: new Date(endAt.getTime() - 3_600_000), endAt, status, coachAcceptance: 'NOT_REQUIRED' },
    });
  }

  async function withAttendanceWaitingOnInstructorLock<T>(
    action: () => Promise<T>,
    invalidate: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ) {
    let finishHolder!: (invalidateBooking: boolean) => void;
    let lockAcquired!: () => void;
    const holderDecision = new Promise<boolean>(resolve => { finishHolder = resolve; });
    const lockHeld = new Promise<void>(resolve => { lockAcquired = resolve; });
    const holder = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${f.instructor.id}, 0))`;
      lockAcquired();
      if (await holderDecision) await invalidate(tx);
    }, { timeout: 30_000 });

    await lockHeld;
    const pending = Promise.resolve().then(action);
    let pollError: unknown;
    try {
      await expect.poll(async () => {
        const rows = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
          SELECT count(*)::bigint AS waiting
          FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${f.instructor.id}, 0)
        `;
        return Number(rows[0]?.waiting ?? 0);
      }, { timeout: 5_000 }).toBeGreaterThan(0);
    } catch (error) {
      pollError = error;
    }

    finishHolder(!pollError);
    const [holderResult, actionResult] = await Promise.allSettled([holder, pending]);
    if (pollError) throw pollError;
    if (holderResult.status === 'rejected') throw holderResult.reason;
    if (actionResult.status === 'rejected') throw actionResult.reason;
    return actionResult.value;
  }

  it('allows the club and assigned coach to record and correct attendance after a lesson ends', async () => {
    const ids = await booking();
    await makeEnded(ids.bookingId);

    await request(app).patch(attendancePath(ids)).set('Cookie', f.cookie)
      .send({ attendance: 'PRESENT' }).expect(200, { id: ids.participantId, attendance: 'PRESENT' });
    await request(app).patch(attendancePath(ids)).set('Cookie', f.coachCookie)
      .send({ attendance: 'ABSENT' }).expect(200, { id: ids.participantId, attendance: 'ABSENT' });

    await prisma.booking.update({ where: { id: ids.bookingId }, data: { status: 'COMPLETED' } });
    await request(app).patch(attendancePath(ids)).set('Cookie', f.coachCookie)
      .send({ attendance: 'UNMARKED' }).expect(200, { id: ids.participantId, attendance: 'UNMARKED' });
  });

  it.each([
    ['future confirmed lesson', { status: 'CONFIRMED', coachAcceptance: 'NOT_REQUIRED', ended: false }],
    ['pending lesson', { status: 'PENDING', coachAcceptance: 'NOT_REQUIRED', ended: true }],
    ['unaccepted assignment', { status: 'PENDING', coachAcceptance: 'PENDING', ended: true }],
    ['cancelled lesson', { status: 'CANCELLED', coachAcceptance: 'NOT_REQUIRED', ended: true }],
  ] as const)('rejects attendance for a %s', async (_label, state) => {
    const ids = await booking();
    if (state.ended) await makeEnded(ids.bookingId);
    await prisma.booking.update({
      where: { id: ids.bookingId },
      data: { status: state.status, coachAcceptance: state.coachAcceptance },
    });

    const response = await request(app).patch(attendancePath(ids)).set('Cookie', f.cookie)
      .send({ attendance: 'PRESENT' }).expect(400);
    expect(response.body.error).toContain(state.status === 'CONFIRMED' ? 'after the lesson has ended' : 'confirmed or completed');
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: ids.participantId } }))
      .toMatchObject({ attendance: 'UNMARKED' });
  });

  it('rejects cancelled, mismatched, foreign-tenant and other-coach participants', async () => {
    const ids = await booking();
    await makeEnded(ids.bookingId);
    await prisma.participant.update({ where: { id: ids.participantId }, data: { cancelledAt: new Date() } });
    await request(app).patch(attendancePath(ids)).set('Cookie', f.cookie)
      .send({ attendance: 'PRESENT' }).expect(404);

    const active = await booking();
    await makeEnded(active.bookingId);
    await request(app).patch(`/api/bookings/${active.bookingId}/participants/${ids.participantId}`)
      .set('Cookie', f.cookie).send({ attendance: 'PRESENT' }).expect(404);

    const foreign = await tenants.fixture();
    const foreignStudent = await createStudent(foreign);
    const foreignCreated = await createBookings(foreign.business.id, inputFor(foreign, {
      studentId: foreignStudent.id, student: undefined,
    }));
    const foreignIds = {
      bookingId: foreignCreated.bookings[0]!.id,
      participantId: foreignCreated.bookings[0]!.participants[0]!.id,
    };
    await makeEnded(foreignIds.bookingId);
    await request(app).patch(attendancePath(foreignIds)).set('Cookie', f.cookie)
      .send({ attendance: 'PRESENT' }).expect(404);
    await request(app).patch(attendancePath(foreignIds)).set('Cookie', f.coachCookie)
      .send({ attendance: 'PRESENT' }).expect(404);

    const otherCoach = await createAccount(f, { name: 'Other Coach', accountType: 'COACH' });
    const otherInstructor = await prisma.instructor.create({
      data: { businessId: f.business.id, name: otherCoach.name, email: otherCoach.email, initials: 'OC' },
    });
    const otherMembership = await prisma.membership.create({
      data: { businessId: f.business.id, userId: otherCoach.id, instructorId: otherInstructor.id },
    });
    const otherCoachSession = await createSession(f, otherCoach.id, otherMembership.id);
    await request(app).patch(attendancePath(active)).set('Cookie', otherCoachSession.cookie)
      .send({ attendance: 'PRESENT' }).expect(403);
    await request(app).patch(attendancePath(active)).set('Cookie', foreign.coachCookie)
      .send({ attendance: 'PRESENT' }).expect(404);
  });

  it('uses a strict body and revalidates attendance after waiting for the instructor lock', async () => {
    const ids = await booking();
    await makeEnded(ids.bookingId);

    await request(app).patch(attendancePath(ids)).set('Cookie', f.cookie)
      .send({ attendance: 'PRESENT', notes: 'not accepted here' }).expect(400);
    await request(app).patch(attendancePath(ids)).set('Cookie', f.cookie)
      .send({ attendance: 'LATE' }).expect(400);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: ids.participantId } }))
      .toMatchObject({ attendance: 'UNMARKED' });

    const response = await withAttendanceWaitingOnInstructorLock(
      () => request(app).patch(attendancePath(ids)).set('Cookie', f.cookie)
        .send({ attendance: 'PRESENT' }).expect(400),
      tx => tx.booking.update({ where: { id: ids.bookingId }, data: { status: 'CANCELLED' } }),
    );

    expect(response.body.error).toBe('Attendance can only be marked for a confirmed or completed lesson');
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: ids.bookingId } }))
      .toMatchObject({ status: 'CANCELLED' });
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: ids.participantId } }))
      .toMatchObject({ attendance: 'UNMARKED' });
  }, 15_000);
});
