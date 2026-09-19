import request from 'supertest';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  createAccount, createSession, prisma, publicInputFor, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Concurrent reschedule decisions', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => { tenants = new TestTenants(); f = await tenants.fixture(); });
  afterEach(async () => { await tenants.cleanup(); });

  async function providerProposal(day: number) {
    const account = await createAccount(f, { name: `Concurrent Student ${day}` });
    const session = await createSession(f, account.id);
    const originalStart = f.starts.plus({ days: day });
    const proposedStart = originalStart.plus({ days: 1 });
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', session.cookie).send(publicInputFor(f, { startAt: originalStart.toISO()! })).expect(201);
    const bookingId = created.body.bookings[0].id as string;
    const proposed = await request(app).post(`/api/bookings/${bookingId}/reschedule-requests`)
      .set('Cookie', f.cookie).send({ startAt: proposedStart.toISO() }).expect(201);
    return {
      account, cookie: session.cookie, bookingId, requestId: proposed.body.id as string,
      originalStart: originalStart.toJSDate(), proposedStart: proposedStart.toJSDate(),
    };
  }

  function expectFirstDecisionWins(responses: Array<{ status: number; body: { error?: string } }>) {
    expect(responses[0]?.status).toBe(200);
    expect(responses[1]?.status).toBe(409);
    expect(responses[1]?.body.error).toBe('This reschedule request has already been answered');
  }

  async function terminalState(requestId: string, bookingId: string) {
    return Promise.all([
      prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } }),
      prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
      prisma.notification.findMany({
        where: { businessId: f.business.id, bookingId, title: { in: ['Reschedule accepted', 'Reschedule declined'] } },
      }),
      prisma.accountNotification.findMany({
        where: { bookingId, type: { in: ['BOOKING_RESCHEDULED', 'RESCHEDULE_WITHDRAWN'] } },
      }),
    ]);
  }

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

  async function waitForAdvisoryLockWaiters(lockKey: string, expected: number) {
    await expect.poll(
      () => advisoryLockWaiterCount(lockKey),
      { timeout: 5_000 },
    ).toBe(expected);
  }

  async function withHeldRescheduleRequestLock<T>(
    requestId: string,
    actions: Array<() => Promise<T>>,
  ) {
    const lockKey = `reschedule-request:${requestId}`;
    let releaseLock!: () => void;
    let locked!: () => void;
    const lockHeld = new Promise<void>(resolve => { locked = resolve; });
    const release = new Promise<void>(resolve => { releaseLock = resolve; });
    const holder = prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      locked();
      await release;
    }, { timeout: 30_000 });

    try {
      await Promise.race([lockHeld, holder]);
    } catch (error) {
      releaseLock();
      await Promise.allSettled([holder]);
      throw error;
    }

    const pending: Array<Promise<T>> = [];
    try {
      // Queue each contender behind the held lock before starting the next so
      // the test controls which terminal decision reaches the lock first.
      for (const action of actions) {
        const contender = Promise.resolve().then(action);
        void contender.catch(() => {});
        pending.push(contender);
        await waitForAdvisoryLockWaiters(lockKey, pending.length);
      }
    } catch (cause) {
      throw new Error('Reschedule decision did not reach the advisory-lock barrier', { cause });
    } finally {
      releaseLock();
      await Promise.allSettled([holder, ...pending]);
    }

    await holder;
    return Promise.all(pending);
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
      await waitForAdvisoryLockWaiters(f.instructor.id, 1);
      // Mutate only after the route has read the old lifecycle state and is
      // visibly waiting to acquire this lock. Its post-lock reload must then
      // observe the committed change.
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

  it('allows exactly one of two concurrent accepts to move the booking and notify each side', async () => {
    const proposal = await providerProposal(0);

    const responses = await withHeldRescheduleRequestLock(proposal.requestId, [
      () => request(app).post(`/api/account/reschedule-requests/${proposal.requestId}/accept`)
        .set('Cookie', proposal.cookie).send({ message: 'First tab' }),
      () => request(app).post(`/api/account/reschedule-requests/${proposal.requestId}/accept`)
        .set('Cookie', proposal.cookie).send({ message: 'Second tab' }),
    ]);

    expectFirstDecisionWins(responses);
    const [decision, booking, providerAlerts, accountAlerts] = await terminalState(proposal.requestId, proposal.bookingId);
    expect(decision.status).toBe('ACCEPTED');
    expect(decision.responseMessage).toBe('First tab');
    expect(booking.startAt).toEqual(proposal.proposedStart);
    expect(providerAlerts).toHaveLength(1);
    expect(providerAlerts[0]?.title).toBe('Reschedule accepted');
    expect(accountAlerts).toHaveLength(1);
    expect(accountAlerts[0]?.type).toBe('BOOKING_RESCHEDULED');
  });

  it('serializes concurrent accept and decline so the booking moves only when accept wins', async () => {
    const proposal = await providerProposal(2);

    const responses = await withHeldRescheduleRequestLock(proposal.requestId, [
      () => request(app).post(`/api/account/reschedule-requests/${proposal.requestId}/accept`)
        .set('Cookie', proposal.cookie).send({ message: 'Accept response' }),
      () => request(app).post(`/api/account/reschedule-requests/${proposal.requestId}/decline`)
        .set('Cookie', proposal.cookie).send({ message: 'Decline response' }),
    ]);

    expectFirstDecisionWins(responses);
    const [decision, booking, providerAlerts, accountAlerts] = await terminalState(proposal.requestId, proposal.bookingId);
    expect(decision.status).toBe('ACCEPTED');
    expect(booking.startAt).toEqual(proposal.proposedStart);
    expect(providerAlerts).toHaveLength(1);
    expect(providerAlerts[0]?.title).toBe('Reschedule accepted');
    expect(accountAlerts).toHaveLength(1);
    expect(accountAlerts[0]?.type).toBe('BOOKING_RESCHEDULED');
  });

  it('serializes concurrent accept and withdraw so the booking moves only when accept wins', async () => {
    const proposal = await providerProposal(4);

    const responses = await withHeldRescheduleRequestLock(proposal.requestId, [
      () => request(app).post(`/api/account/reschedule-requests/${proposal.requestId}/accept`)
        .set('Cookie', proposal.cookie).send({ message: 'Accept response' }),
      () => request(app).post(`/api/reschedule-requests/${proposal.requestId}/withdraw`)
        .set('Cookie', f.cookie).send({}),
    ]);

    expectFirstDecisionWins(responses);
    const [decision, booking, providerAlerts, accountAlerts] = await terminalState(proposal.requestId, proposal.bookingId);
    expect(decision.status).toBe('ACCEPTED');
    expect(booking.startAt).toEqual(proposal.proposedStart);
    expect(providerAlerts).toHaveLength(1);
    expect(accountAlerts).toHaveLength(1);
    expect(accountAlerts[0]?.type).toBe('BOOKING_RESCHEDULED');
  });

  it('reloads a booking after the instructor lock before creating a proposal', async () => {
    const proposal = await providerProposal(6);
    await prisma.rescheduleRequest.delete({ where: { id: proposal.requestId } });
    await prisma.notification.deleteMany({ where: { bookingId: proposal.bookingId, type: 'RESCHEDULE' } });
    await prisma.accountNotification.deleteMany({ where: { bookingId: proposal.bookingId, type: 'RESCHEDULE_REQUESTED' } });

    const response = await withHeldInstructorLock(
      () => request(app).post(`/api/bookings/${proposal.bookingId}/reschedule-requests`)
        .set('Cookie', f.cookie).send({ startAt: proposal.proposedStart.toISOString() }),
      tx => tx.booking.update({
        where: { id: proposal.bookingId },
        data: { status: 'PENDING', coachAcceptance: 'PENDING', createdByRole: 'CLUB' },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(
      'This lesson is still waiting for the coach to accept it. Reschedule it once it is confirmed.',
    );
    expect(await prisma.rescheduleRequest.count({ where: { bookingId: proposal.bookingId } })).toBe(0);
    expect(await prisma.notification.count({ where: { bookingId: proposal.bookingId, type: 'RESCHEDULE' } })).toBe(0);
    expect(await prisma.accountNotification.count({
      where: { bookingId: proposal.bookingId, type: 'RESCHEDULE_REQUESTED' },
    })).toBe(0);
  });

  it('does not resurrect a booking that becomes terminal while proposal creation waits for its lock', async () => {
    const proposal = await providerProposal(8);
    await prisma.rescheduleRequest.delete({ where: { id: proposal.requestId } });
    await prisma.notification.deleteMany({ where: { bookingId: proposal.bookingId, type: 'RESCHEDULE' } });
    await prisma.accountNotification.deleteMany({ where: { bookingId: proposal.bookingId, type: 'RESCHEDULE_REQUESTED' } });

    const response = await withHeldInstructorLock(
      () => request(app).post(`/api/bookings/${proposal.bookingId}/reschedule-requests`)
        .set('Cookie', f.cookie).send({ startAt: proposal.proposedStart.toISOString() }),
      tx => tx.booking.update({
        where: { id: proposal.bookingId }, data: { status: 'CANCELLED' },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Only an active session can be rescheduled');
    expect(await prisma.rescheduleRequest.count({ where: { bookingId: proposal.bookingId } })).toBe(0);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: proposal.bookingId } }))
      .toMatchObject({ status: 'CANCELLED', startAt: proposal.originalStart });
  });

  it('does not accept a proposal after the booking becomes terminal behind the instructor lock', async () => {
    const proposal = await providerProposal(10);

    const response = await withHeldInstructorLock(
      () => request(app).post(`/api/account/reschedule-requests/${proposal.requestId}/accept`)
        .set('Cookie', proposal.cookie).send({}),
      tx => tx.booking.update({
        where: { id: proposal.bookingId }, data: { status: 'COMPLETED' },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Only an active session can be rescheduled');
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: proposal.requestId } }))
      .toMatchObject({ status: 'PENDING', respondedAt: null });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: proposal.bookingId } }))
      .toMatchObject({ status: 'COMPLETED', startAt: proposal.originalStart });
    expect(await prisma.notification.count({
      where: { bookingId: proposal.bookingId, title: 'Reschedule accepted' },
    })).toBe(0);
  });

  it('rejects acceptance when the booking starts awaiting its coach behind the instructor lock', async () => {
    const proposal = await providerProposal(12);

    const response = await withHeldInstructorLock(
      () => request(app).post(`/api/account/reschedule-requests/${proposal.requestId}/accept`)
        .set('Cookie', proposal.cookie).send({}),
      tx => tx.booking.update({
        where: { id: proposal.bookingId },
        data: { status: 'PENDING', coachAcceptance: 'PENDING', createdByRole: 'CLUB' },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe(
      'This lesson is still waiting for the coach to accept it. Reschedule it once it is confirmed.',
    );
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: proposal.requestId } }))
      .toMatchObject({ status: 'PENDING', respondedAt: null });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: proposal.bookingId } }))
      .toMatchObject({ status: 'PENDING', coachAcceptance: 'PENDING', startAt: proposal.originalStart });
  });
});
