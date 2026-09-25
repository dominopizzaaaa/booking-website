import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { calendarSecretAad, decryptCalendarSecret, encryptCalendarSecret } from '../src/calendar-crypto.js';
import {
  disconnectCalendarConnection,
  processCalendarDisconnects,
  processCalendarSyncJobs,
  processOrphanCalendarProjections,
  queueCalendarBookingsForUser,
  refreshDueCalendarBusyIntervals,
} from '../src/calendar-sync.js';
import { config } from '../src/config.js';
import { createBookings } from '../src/scheduling.js';
import {
  createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

type EventPayload = {
  id: string;
  extendedProperties?: { private?: { courtlyBookingId?: string; courtlyRevision?: string } };
  [key: string]: unknown;
};

type ProviderCall = {
  method: string;
  url: URL;
  accessToken: string | null;
  formToken: string | null;
  refreshToken: string | null;
  eventId: string | null;
  body: EventPayload | null;
};

type WriteGate = {
  bookingId: string;
  used: boolean;
  reached: () => void;
  released: Promise<void>;
  release: () => void;
};

type RefreshGate = {
  used: boolean;
  reached: () => void;
  released: Promise<void>;
  release: () => void;
  accessToken: string;
  refreshToken: string;
};

const eventsPath = '/calendar/v3/calendars/primary/events';
const originalCalendarConfig = {
  ...config.googleCalendar,
  keys: new Map(config.googleCalendar.keys),
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bookingIdFrom(body: EventPayload | null) {
  return body?.extendedProperties?.private?.courtlyBookingId;
}

function mockGoogleCalendar() {
  const events = new Map<string, { accessToken: string | null; body: EventPayload }>();
  const calls: ProviderCall[] = [];
  const gates: WriteGate[] = [];
  const refreshGates: RefreshGate[] = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const accessToken = new Headers(init.headers).get('Authorization')?.replace(/^Bearer /, '') ?? null;
    const formToken = init.body instanceof URLSearchParams ? init.body.get('token') : null;
    const refreshToken = init.body instanceof URLSearchParams ? init.body.get('refresh_token') : null;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as EventPayload : null;
    const eventId = url.pathname.startsWith(`${eventsPath}/`)
      ? decodeURIComponent(url.pathname.slice(eventsPath.length + 1))
      : body?.id ?? null;
    calls.push({ method, url, accessToken, formToken, refreshToken, eventId, body });

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token' && method === 'POST') {
      const gate = refreshGates.find(candidate => !candidate.used);
      if (!gate) return jsonResponse({ error: 'unexpected_refresh' }, 500);
      gate.used = true;
      gate.reached();
      await gate.released;
      return jsonResponse({
        access_token: gate.accessToken, refresh_token: gate.refreshToken, expires_in: 3_600,
      });
    }

    if (url.origin === 'https://www.googleapis.com'
      && (method === 'POST' || method === 'PUT')
      && (url.pathname === eventsPath || url.pathname.startsWith(`${eventsPath}/`))
      && body && eventId) {
      const gate = gates.find(candidate => !candidate.used && candidate.bookingId === bookingIdFrom(body));
      if (gate) {
        gate.used = true;
        gate.reached();
        await gate.released;
      }
      if (method === 'POST' && events.has(eventId)) {
        return jsonResponse({ error: { status: 'ALREADY_EXISTS' } }, 409);
      }
      if (method === 'PUT' && !events.has(eventId)) {
        return jsonResponse({ error: { status: 'NOT_FOUND' } }, 404);
      }
      events.set(eventId, { accessToken, body });
      return jsonResponse({ etag: `etag-${body.extendedProperties?.private?.courtlyRevision ?? 'unknown'}` });
    }

    if (url.origin === 'https://www.googleapis.com'
      && method === 'DELETE' && url.pathname.startsWith(`${eventsPath}/`) && eventId) {
      events.delete(eventId);
      return new Response(null, { status: 204 });
    }

    if (url.origin === 'https://www.googleapis.com'
      && method === 'GET' && url.pathname === eventsPath) {
      return jsonResponse({
        timeZone: 'Asia/Singapore',
        items: [{
          start: { dateTime: new Date(Date.now() + 60_000).toISOString() },
          end: { dateTime: new Date(Date.now() + 120_000).toISOString() },
        }],
      });
    }

    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/revoke' && method === 'POST') {
      return new Response(null, { status: 200 });
    }

    return jsonResponse({ error: { message: `Unexpected test request: ${method} ${url.toString()}` } }, 500);
  });

  function pauseNextWrite(bookingId: string) {
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { markReached = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    gates.push({ bookingId, used: false, reached: markReached, released, release });
    return { reached, release };
  }

  function pauseNextRefresh(accessToken: string, refreshToken: string) {
    let markReached!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { markReached = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    refreshGates.push({
      used: false, reached: markReached, released, release, accessToken, refreshToken,
    });
    return { reached, release };
  }

  return {
    calls,
    events,
    pauseNextWrite,
    pauseNextRefresh,
    releaseAll: () => {
      gates.forEach(gate => gate.release());
      refreshGates.forEach(gate => gate.release());
    },
    writesFor: (bookingId: string) => calls.filter(call =>
      (call.method === 'POST' || call.method === 'PUT') && bookingIdFrom(call.body) === bookingId),
  };
}

type FakeGoogle = ReturnType<typeof mockGoogleCalendar>;

describe.sequential('Calendar projection worker', () => {
  let tenants: TestTenants;
  let fixture: Fixture;
  let google: FakeGoogle;

  beforeAll(verifyTestDatabase, 15_000);

  beforeEach(async () => {
    Object.assign(config.googleCalendar, {
      enabled: true,
      clientId: 'worker-client-id',
      clientSecret: 'worker-client-secret',
      redirectUri: 'http://localhost:3000/api/calendar/google/callback',
      activeKeyId: 'worker-test',
      keys: new Map([['worker-test', Buffer.alloc(32, 17)]]),
      requestTimeoutMs: 10_000,
      workerIntervalMs: 30_000,
      busyRefreshMinutes: 10,
      busyCacheMinutes: 30,
    });
    tenants = new TestTenants();
    fixture = await tenants.fixture();
    google = mockGoogleCalendar();
  });

  afterEach(async () => {
    google?.releaseAll();
    vi.restoreAllMocks();
    try { await tenants?.cleanup(); }
    finally { Object.assign(config.googleCalendar, originalCalendarConfig); }
  });

  afterAll(async () => {
    Object.assign(config.googleCalendar, originalCalendarConfig);
    await prisma.$disconnect();
  });

  async function connection(userId: string, label: string) {
    const id = `calendar-worker-${randomUUID()}`;
    const accessToken = `${label}-access-${randomUUID()}`;
    const refreshToken = `${label}-refresh-${randomUUID()}`;
    const created = await prisma.calendarConnection.create({
      data: {
        id, userId, providerAccountId: `${label}-${randomUUID()}`,
        providerEmail: `${label}-${randomUUID()}@example.test`, calendarTimeZone: 'Asia/Singapore',
        accessTokenCiphertext: encryptCalendarSecret(
          accessToken, calendarSecretAad('connection', id, 'access-token'),
        ),
        refreshTokenCiphertext: encryptCalendarSecret(
          refreshToken, calendarSecretAad('connection', id, 'refresh-token'),
        ),
        accessTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
        syncEnabled: true, busyCheckEnabled: false,
        busyRefreshAfter: new Date(Date.now() + 24 * 60 * 60_000),
      },
    });
    return { connection: created, accessToken, refreshToken };
  }

  async function confirmedBooking() {
    const student = await createStudent(fixture, { name: 'Calendar Worker Student' });
    if (!student.userId) throw new Error('Calendar worker fixture requires a linked student');
    const coach = await connection(fixture.coachUser.id, 'coach');
    const learner = await connection(student.userId, 'student');
    const result = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }));
    return { student, coach, learner, bookingId: result.bookings[0]!.id };
  }

  it('materializes the coalesced revision for coach and student, then updates without duplicates', async () => {
    const { student, coach, learner, bookingId } = await confirmedBooking();
    const initialJob = await prisma.calendarSyncJob.findUniqueOrThrow({ where: { bookingId } });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ status: 'CONFIRMED', calendarRevision: 1 });

    expect(await queueCalendarBookingsForUser(fixture.coachUser.id)).toBe(1);
    expect(await queueCalendarBookingsForUser(student.userId!)).toBe(1);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ calendarRevision: 3 });
    expect(await prisma.calendarSyncJob.findUniqueOrThrow({ where: { bookingId } }))
      .toMatchObject({ id: initialJob.id, requestedRevision: 3, attempts: 0 });
    expect(await prisma.calendarSyncJob.count({ where: { bookingId } })).toBe(1);

    await processCalendarSyncJobs();
    const firstProjections = await prisma.calendarEventProjection.findMany({
      where: { bookingId }, include: { connection: { select: { userId: true } } },
      orderBy: { connectionId: 'asc' },
    });
    expect(firstProjections).toHaveLength(2);
    expect(new Set(firstProjections.map(projection => projection.connection.userId))).toEqual(
      new Set([fixture.coachUser.id, student.userId]),
    );
    expect(firstProjections.every(projection => projection.syncedRevision === 3)).toBe(true);
    expect(google.writesFor(bookingId).map(call => call.method)).toEqual(['POST', 'POST']);
    expect(new Set(google.writesFor(bookingId).map(call => call.accessToken))).toEqual(
      new Set([coach.accessToken, learner.accessToken]),
    );
    expect(await prisma.calendarSyncJob.findUnique({ where: { bookingId } })).toBeNull();

    await queueCalendarBookingsForUser(student.userId!);
    await processCalendarSyncJobs();
    const updatedProjections = await prisma.calendarEventProjection.findMany({
      where: { bookingId }, include: { connection: { select: { userId: true } } },
      orderBy: { connectionId: 'asc' },
    });
    expect(updatedProjections.map(projection => ({
      id: projection.id, eventId: projection.providerEventId, userId: projection.connection.userId,
    }))).toEqual(firstProjections.map(projection => ({
      id: projection.id, eventId: projection.providerEventId, userId: projection.connection.userId,
    })));
    expect(updatedProjections.every(projection => projection.syncedRevision === 4)).toBe(true);
    expect(google.writesFor(bookingId).map(call => call.method)).toEqual(['POST', 'POST', 'PUT', 'PUT']);
    expect([...google.events.values()].filter(event => bookingIdFrom(event.body) === bookingId)).toHaveLength(2);
  });

  it('does not project a pending lesson and creates both events after confirmation queues a revision', async () => {
    await prisma.location.update({ where: { id: fixture.location.id }, data: { requiresApproval: true } });
    const student = await createStudent(fixture, { name: 'Pending Calendar Student' });
    if (!student.userId) throw new Error('Calendar worker fixture requires a linked student');
    await connection(fixture.coachUser.id, 'pending-coach');
    await connection(student.userId, 'pending-student');
    const bookingId = (await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }))).bookings[0]!.id;

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ status: 'PENDING', calendarRevision: 1 });
    await processCalendarSyncJobs();
    expect(google.writesFor(bookingId)).toHaveLength(0);
    expect(await prisma.calendarEventProjection.count({ where: { bookingId } })).toBe(0);

    await request(app).patch(`/api/bookings/${bookingId}`).set('Cookie', fixture.cookie)
      .send({ status: 'CONFIRMED' }).expect(200);
    expect(await prisma.calendarSyncJob.findUniqueOrThrow({ where: { bookingId } }))
      .toMatchObject({ requestedRevision: 2 });
    await processCalendarSyncJobs();

    expect(await prisma.calendarEventProjection.count({ where: { bookingId } })).toBe(2);
    expect(google.writesFor(bookingId).map(call => call.method)).toEqual(['POST', 'POST']);
  });

  it('deletes remote copies and local projections when a confirmed lesson is cancelled', async () => {
    const { bookingId } = await confirmedBooking();
    await processCalendarSyncJobs();
    const projected = await prisma.calendarEventProjection.findMany({ where: { bookingId } });
    expect(projected).toHaveLength(2);

    await request(app).patch(`/api/bookings/${bookingId}`).set('Cookie', fixture.cookie)
      .send({ status: 'CANCELLED' }).expect(200);
    await processCalendarSyncJobs();

    expect(await prisma.calendarEventProjection.count({ where: { bookingId } })).toBe(0);
    expect(await prisma.calendarSyncJob.findUnique({ where: { bookingId } })).toBeNull();
    expect(projected.every(projection => !google.events.has(projection.providerEventId))).toBe(true);
    const deletedIds = google.calls.filter(call => call.method === 'DELETE').map(call => call.eventId);
    expect(new Set(deletedIds)).toEqual(new Set(projected.map(projection => projection.providerEventId)));
  });

  it('keeps existing historical events and projections when a lesson is completed', async () => {
    const { bookingId } = await confirmedBooking();
    await processCalendarSyncJobs();
    const projected = await prisma.calendarEventProjection.findMany({ where: { bookingId } });
    const callsBeforeCompletion = google.calls.length;

    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        startAt: new Date(Date.now() - 2 * 60 * 60_000),
        endAt: new Date(Date.now() - 60 * 60_000),
      },
    });
    await request(app).patch(`/api/bookings/${bookingId}`).set('Cookie', fixture.cookie)
      .send({ status: 'COMPLETED' }).expect(200);
    await processCalendarSyncJobs();

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ status: 'COMPLETED', calendarRevision: 2 });
    const retained = await prisma.calendarEventProjection.findMany({ where: { bookingId } });
    expect(retained.map(projection => ({
      id: projection.id, eventId: projection.providerEventId, revision: projection.syncedRevision,
    }))).toEqual(projected.map(projection => ({
      id: projection.id, eventId: projection.providerEventId, revision: projection.syncedRevision,
    })));
    expect(retained.every(projection => google.events.has(projection.providerEventId))).toBe(true);
    expect(google.calls).toHaveLength(callsBeforeCompletion);
  });

  it('retains a cancelled projection while reauthentication is required', async () => {
    const { coach, bookingId } = await confirmedBooking();
    await processCalendarSyncJobs();
    const coachProjection = await prisma.calendarEventProjection.findUniqueOrThrow({
      where: { connectionId_bookingId: { connectionId: coach.connection.id, bookingId } },
    });
    await prisma.calendarConnection.update({
      where: { id: coach.connection.id }, data: { status: 'REAUTH_REQUIRED' },
    });

    await request(app).patch(`/api/bookings/${bookingId}`).set('Cookie', fixture.cookie)
      .send({ status: 'CANCELLED' }).expect(200);
    await processCalendarSyncJobs();

    expect(await prisma.calendarEventProjection.findUnique({ where: { id: coachProjection.id } }))
      .toMatchObject({ providerEventId: coachProjection.providerEventId });
    expect(google.events.has(coachProjection.providerEventId)).toBe(true);
    expect(await prisma.calendarEventProjection.count({ where: { bookingId } })).toBe(1);
    expect(await prisma.calendarSyncJob.findUnique({ where: { bookingId } })).toBeNull();
  });

  it('preserves a newer revision queued while an older leased revision is writing', async () => {
    const student = await createStudent(fixture, { name: 'Concurrent Calendar Student' });
    if (!student.userId) throw new Error('Calendar worker fixture requires a linked student');
    await connection(student.userId, 'concurrent-student');
    const bookingId = (await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }))).bookings[0]!.id;
    const gate = google.pauseNextWrite(bookingId);
    const firstWorker = processCalendarSyncJobs();

    await gate.reached;
    try {
      await queueCalendarBookingsForUser(student.userId);
      const leasedNewRevision = await prisma.calendarSyncJob.findUniqueOrThrow({ where: { bookingId } });
      expect(leasedNewRevision).toMatchObject({ requestedRevision: 2, attempts: 0 });
      expect(leasedNewRevision.leaseToken).not.toBeNull();
      expect(leasedNewRevision.leasedUntil).not.toBeNull();
    } finally {
      gate.release();
    }
    await firstWorker;

    expect(await prisma.calendarEventProjection.findFirstOrThrow({ where: { bookingId } }))
      .toMatchObject({ syncedRevision: 1 });
    expect(await prisma.calendarSyncJob.findUniqueOrThrow({ where: { bookingId } }))
      .toMatchObject({ requestedRevision: 2, attempts: 0, leaseToken: null, leasedUntil: null });

    await processCalendarSyncJobs();
    expect(await prisma.calendarEventProjection.findFirstOrThrow({ where: { bookingId } }))
      .toMatchObject({ syncedRevision: 2 });
    expect(await prisma.calendarSyncJob.findUnique({ where: { bookingId } })).toBeNull();
    expect(google.writesFor(bookingId).map(call => call.method)).toEqual(['POST', 'PUT']);
  }, 20_000);

  it('serializes concurrent refreshes and preserves the rotated refresh token', async () => {
    const student = await createStudent(fixture, { name: 'Rotating Calendar Student' });
    if (!student.userId) throw new Error('Calendar worker fixture requires a linked student');
    const learner = await connection(student.userId, 'rotating-student');
    await prisma.calendarConnection.update({
      where: { id: learner.connection.id },
      data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    const firstBookingId = (await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }))).bookings[0]!.id;
    const rotatedAccessToken = `rotated-access-${randomUUID()}`;
    const rotatedRefreshToken = `rotated-refresh-${randomUUID()}`;
    const gate = google.pauseNextRefresh(rotatedAccessToken, rotatedRefreshToken);
    const firstWorker = processCalendarSyncJobs();

    await gate.reached;
    try {
      const secondBookingId = (await createBookings(fixture.business.id, inputFor(fixture, {
        studentId: student.id, student: undefined, startAt: fixture.starts.plus({ days: 1 }).toISO()!,
      }))).bookings[0]!.id;
      const secondWorker = processCalendarSyncJobs();
      await expect.poll(async () => (await prisma.calendarSyncJob.findUnique({
        where: { bookingId: secondBookingId }, select: { leaseToken: true },
      }))?.leaseToken).toEqual(expect.any(String));
      expect(google.calls.filter(call => call.url.pathname === '/token')).toHaveLength(1);
      gate.release();
      await Promise.all([firstWorker, secondWorker]);

      const persisted = await prisma.calendarConnection.findUniqueOrThrow({
        where: { id: learner.connection.id },
      });
      expect(decryptCalendarSecret(
        persisted.refreshTokenCiphertext!,
        calendarSecretAad('connection', persisted.id, 'refresh-token'),
      )).toBe(rotatedRefreshToken);
      expect(google.calls.filter(call => call.url.pathname === '/token')).toHaveLength(1);
      expect(google.calls.filter(call => call.url.pathname === '/token').map(call => call.refreshToken))
        .toEqual([learner.refreshToken]);
      expect(new Set([
        ...google.writesFor(firstBookingId), ...google.writesFor(secondBookingId),
      ].map(call => call.accessToken))).toEqual(new Set([rotatedAccessToken]));
    } finally {
      gate.release();
    }
  }, 20_000);

  it('persists a rotated token during disconnect and revokes that generation', async () => {
    const student = await createStudent(fixture, { name: 'Disconnecting Refresh Student' });
    if (!student.userId) throw new Error('Calendar worker fixture requires a linked student');
    const learner = await connection(student.userId, 'disconnecting-refresh');
    await prisma.calendarConnection.update({
      where: { id: learner.connection.id },
      data: {
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
        busyCheckEnabled: true, busyRefreshAfter: new Date(Date.now() - 60_000),
      },
    });
    const rotatedAccessToken = `disconnect-access-${randomUUID()}`;
    const rotatedRefreshToken = `disconnect-refresh-${randomUUID()}`;
    const gate = google.pauseNextRefresh(rotatedAccessToken, rotatedRefreshToken);
    const busyWorker = refreshDueCalendarBusyIntervals();

    await gate.reached;
    try {
      await disconnectCalendarConnection(student.userId);
      const leasedDisconnect = await prisma.calendarConnection.findUniqueOrThrow({
        where: { id: learner.connection.id },
      });
      expect(leasedDisconnect).toMatchObject({
        status: 'DISCONNECTING', busyRefreshLeaseToken: expect.any(String),
      });
      expect(leasedDisconnect.busyRefreshLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
      gate.release();
      await busyWorker;

      const disconnecting = await prisma.calendarConnection.findUniqueOrThrow({
        where: { id: learner.connection.id },
      });
      expect(disconnecting).toMatchObject({
        status: 'DISCONNECTING', busyCheckEnabled: false,
        busyRefreshLeaseUntil: null, busyRefreshLeaseToken: null,
      });
      expect(decryptCalendarSecret(
        disconnecting.refreshTokenCiphertext!,
        calendarSecretAad('connection', disconnecting.id, 'refresh-token'),
      )).toBe(rotatedRefreshToken);
      expect(await prisma.calendarBusyInterval.count({
        where: { connectionId: learner.connection.id },
      })).toBe(0);

      expect(await processCalendarDisconnects()).toBe(1);
      expect(await prisma.calendarConnection.findUnique({ where: { id: learner.connection.id } })).toBeNull();
      expect(google.calls.filter(call => call.url.pathname === '/revoke').map(call => call.formToken))
        .toEqual([rotatedRefreshToken]);
    } finally {
      gate.release();
    }
  }, 20_000);

  it('deletes projected events before revoking and removing a disconnected connection', async () => {
    const { student, learner, bookingId } = await confirmedBooking();
    await processCalendarSyncJobs();
    const studentProjection = await prisma.calendarEventProjection.findUniqueOrThrow({
      where: { connectionId_bookingId: { connectionId: learner.connection.id, bookingId } },
    });

    expect(await disconnectCalendarConnection(student.userId!)).toMatchObject({
      id: learner.connection.id, status: 'DISCONNECTING', syncEnabled: false, busyCheckEnabled: false,
    });
    await processCalendarSyncJobs();
    await processCalendarDisconnects();

    expect(await prisma.calendarConnection.findUnique({ where: { id: learner.connection.id } })).toBeNull();
    expect(await prisma.calendarEventProjection.findUnique({ where: { id: studentProjection.id } })).toBeNull();
    expect(google.events.has(studentProjection.providerEventId)).toBe(false);
    const revocations = google.calls.filter(call =>
      call.url.origin === 'https://oauth2.googleapis.com' && call.url.pathname === '/revoke');
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.formToken).toBe(learner.refreshToken);
  });

  it('completes explicit local cleanup when a disconnect token can no longer be decrypted', async () => {
    const { student, learner, bookingId } = await confirmedBooking();
    await processCalendarSyncJobs();
    await disconnectCalendarConnection(student.userId!);
    await prisma.calendarConnection.update({
      where: { id: learner.connection.id },
      data: { accessTokenCiphertext: 'v1.removed-key.invalid.invalid.invalid', refreshTokenCiphertext: null },
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await processCalendarSyncJobs();
    expect(await prisma.calendarEventProjection.count({
      where: { connectionId: learner.connection.id, bookingId },
    })).toBe(0);
    await processCalendarDisconnects();

    expect(await prisma.calendarConnection.findUnique({ where: { id: learner.connection.id } })).toBeNull();
    expect(warning).toHaveBeenCalled();
  });

  it('uses an orphan projection to delete a remote event after its booking is removed', async () => {
    const student = await createStudent(fixture, { name: 'Orphan Projection Student' });
    await connection(fixture.coachUser.id, 'orphan-coach');
    const bookingId = (await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
    }))).bookings[0]!.id;
    await processCalendarSyncJobs();
    const projection = await prisma.calendarEventProjection.findFirstOrThrow({ where: { bookingId } });
    expect(google.events.has(projection.providerEventId)).toBe(true);

    await prisma.participant.deleteMany({ where: { bookingId } });
    await prisma.booking.delete({ where: { id: bookingId } });
    expect(await prisma.calendarEventProjection.findUniqueOrThrow({ where: { id: projection.id } }))
      .toMatchObject({ bookingId: null });

    await processOrphanCalendarProjections();
    expect(await prisma.calendarEventProjection.findUnique({ where: { id: projection.id } })).toBeNull();
    expect(google.events.has(projection.providerEventId)).toBe(false);
    expect(google.calls.some(call => call.method === 'DELETE' && call.eventId === projection.providerEventId))
      .toBe(true);
  });
});
