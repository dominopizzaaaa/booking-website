import { randomUUID } from 'node:crypto';
import { Prisma, type CalendarConnection } from '@prisma/client';
import { prisma } from './db.js';
import { config } from './config.js';
import {
  calendarSecretAad,
  CalendarCryptoError,
  decryptCalendarSecret,
  encryptCalendarSecret,
} from './calendar-crypto.js';
import {
  deleteGoogleCalendarEvent,
  GoogleCalendarError,
  googleProviderEventId,
  listGoogleBusyIntervals,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  writeGoogleCalendarEvent,
} from './google-calendar.js';

type DbTransaction = Prisma.TransactionClient;
type CalendarDb = DbTransaction | typeof prisma;
const jobLeaseMs = 60_000;
const batchSize = 20;
const maxBackoffMs = 6 * 60 * 60_000;
const accessTokenFreshnessMs = 60_000;
const refreshPollMs = 50;

function retryAt(attempts: number) {
  const exponent = Math.min(10, Math.max(0, attempts));
  const base = Math.min(maxBackoffMs, 5_000 * (2 ** exponent));
  return new Date(Date.now() + base + Math.floor(Math.random() * Math.min(5_000, base / 4)));
}

/**
 * Atomically mark a booking revision and coalesce all pending provider work.
 * Call this inside the transaction that changes calendar-visible state.
 */
export async function enqueueCalendarSync(tx: DbTransaction, bookingId: string) {
  // Calendar is optional. A future connection queues every relevant booking,
  // so disabled deployments do not need an unprocessable global outbox.
  if (!config.googleCalendar.enabled) return 0;
  const relevant = await tx.booking.findFirst({
    where: {
      id: bookingId,
      OR: [
        { calendarSyncJob: { isNot: null } },
        { calendarProjections: { some: {} } },
        { instructor: { membership: { user: { calendarConnection: { isNot: null } } } } },
        { participants: {
          some: {
            cancelledAt: null,
            student: { user: { calendarConnection: { isNot: null } } },
          },
        } },
      ],
    },
    select: { id: true },
  });
  if (!relevant) return 0;
  const booking = await tx.booking.update({
    where: { id: bookingId },
    data: { calendarRevision: { increment: 1 } },
    select: { calendarRevision: true },
  });
  await tx.calendarSyncJob.upsert({
    where: { bookingId },
    create: { bookingId, requestedRevision: booking.calendarRevision },
    update: {
      requestedRevision: booking.calendarRevision,
      availableAt: new Date(),
      attempts: 0,
      lastErrorCode: null,
      // Preserve an active lease. Its worker reads current booking state and
      // its revision-qualified completion cannot remove this newer request.
    },
  });
  return booking.calendarRevision;
}

function bookingIdsForUser(db: CalendarDb, userId: string) {
  return db.booking.findMany({
    where: {
      OR: [
        { instructor: { membership: { userId } } },
        { participants: { some: { cancelledAt: null, student: { userId } } } },
        { calendarProjections: { some: { connection: { userId } } } },
      ],
    },
    select: { id: true },
  });
}

/** Queue every booking currently or historically projected for one user. */
export async function queueCalendarBookingsForUser(userId: string) {
  return prisma.$transaction(async tx => {
    return queueCalendarBookingsForUserInTransaction(tx, userId);
  }, { timeout: 30_000 });
}

export async function queueCalendarBookingsForUserInTransaction(tx: DbTransaction, userId: string) {
  const bookings = await bookingIdsForUser(tx, userId);
  for (const booking of bookings) await enqueueCalendarSync(tx, booking.id);
  return bookings.length;
}

async function usableAccessToken(connection: CalendarConnection) {
  const aad = calendarSecretAad('connection', connection.id, 'access-token');
  const token = decryptCalendarSecret(connection.accessTokenCiphertext, aad);
  const accessKeyId = connection.accessTokenCiphertext.split('.')[1];
  const refreshKeyId = connection.refreshTokenCiphertext?.split('.')[1];
  if (accessKeyId !== config.googleCalendar.activeKeyId
    || (connection.refreshTokenCiphertext && refreshKeyId !== config.googleCalendar.activeKeyId)) {
    const accessTokenCiphertext = accessKeyId === config.googleCalendar.activeKeyId
      ? connection.accessTokenCiphertext
      : encryptCalendarSecret(token, aad);
    const refreshTokenCiphertext = connection.refreshTokenCiphertext && refreshKeyId !== config.googleCalendar.activeKeyId
      ? encryptCalendarSecret(
        decryptCalendarSecret(
          connection.refreshTokenCiphertext, calendarSecretAad('connection', connection.id, 'refresh-token'),
        ),
        calendarSecretAad('connection', connection.id, 'refresh-token'),
      )
      : connection.refreshTokenCiphertext;
    const rewrapped = await prisma.calendarConnection.updateMany({
      where: {
        id: connection.id, accessTokenCiphertext: connection.accessTokenCiphertext,
        refreshTokenCiphertext: connection.refreshTokenCiphertext,
      },
      data: { accessTokenCiphertext, refreshTokenCiphertext },
    });
    if (rewrapped.count) return { value: token, ciphertext: accessTokenCiphertext };
    const winner = await prisma.calendarConnection.findUniqueOrThrow({ where: { id: connection.id } });
    return usableAccessToken(winner);
  }
  return { value: token, ciphertext: connection.accessTokenCiphertext };
}

function credentialGenerationChanged(current: CalendarConnection, previous: CalendarConnection) {
  return current.accessTokenCiphertext !== previous.accessTokenCiphertext
    || current.refreshTokenCiphertext !== previous.refreshTokenCiphertext;
}

async function releaseRefreshLease(connectionId: string, leaseToken: string) {
  await prisma.calendarConnection.updateMany({
    where: { id: connectionId, busyRefreshLeaseToken: leaseToken },
    data: { busyRefreshLeaseUntil: null, busyRefreshLeaseToken: null },
  });
}

async function activeConnectionLease(connectionId: string) {
  const connection = await prisma.calendarConnection.findUnique({
    where: { id: connectionId },
    select: { busyRefreshLeaseToken: true, busyRefreshLeaseUntil: true },
  });
  return connection?.busyRefreshLeaseToken
    && connection.busyRefreshLeaseUntil && connection.busyRefreshLeaseUntil > new Date()
    ? connection.busyRefreshLeaseToken
    : null;
}

async function accessToken(connection: CalendarConnection, inheritedLeaseToken?: string) {
  let current = await prisma.calendarConnection.findUniqueOrThrow({ where: { id: connection.id } });
  let callerLeaseToken = inheritedLeaseToken;
  for (;;) {
    if (current.accessTokenExpiresAt.getTime() > Date.now() + accessTokenFreshnessMs) {
      return usableAccessToken(current);
    }
    if (!current.refreshTokenCiphertext) {
      await prisma.calendarConnection.updateMany({
        where: {
          id: current.id, accessTokenCiphertext: current.accessTokenCiphertext,
          refreshTokenCiphertext: null, status: { not: 'DISCONNECTING' },
        },
        data: { status: 'REAUTH_REQUIRED', lastErrorCode: 'REFRESH_TOKEN_MISSING' },
      });
      throw new GoogleCalendarError('REAUTH_REQUIRED', { reauth: true });
    }

    const now = new Date();
    const leaseToken = callerLeaseToken ?? randomUUID();
    const ownsOuterLease = Boolean(callerLeaseToken);
    const claimed = await prisma.calendarConnection.updateMany({
      where: {
        id: current.id, accessTokenCiphertext: current.accessTokenCiphertext,
        refreshTokenCiphertext: current.refreshTokenCiphertext,
        accessTokenExpiresAt: { lte: new Date(now.getTime() + accessTokenFreshnessMs) },
        ...(callerLeaseToken
          ? { busyRefreshLeaseToken: callerLeaseToken, busyRefreshLeaseUntil: { gt: now } }
          : { OR: [
            { busyRefreshLeaseUntil: null },
            { busyRefreshLeaseUntil: { lt: now } },
          ] }),
      },
      data: {
        busyRefreshLeaseToken: leaseToken,
        // An inherited lease must cover both refresh and its caller's provider
        // request. A refresh-only claimant releases the same bounded lease as
        // soon as the rotated generation is durable.
        busyRefreshLeaseUntil: new Date(now.getTime() + config.googleCalendar.requestTimeoutMs
          + jobLeaseMs),
      },
    });
    if (!claimed.count) {
      const winner = await prisma.calendarConnection.findUniqueOrThrow({ where: { id: current.id } });
      if (callerLeaseToken && winner.busyRefreshLeaseToken !== callerLeaseToken) {
        callerLeaseToken = undefined;
      }
      const waitUntil = winner.busyRefreshLeaseUntil?.getTime() ?? Date.now();
      const generationChanged = credentialGenerationChanged(winner, current);
      current = winner;
      if (!generationChanged && winner.busyRefreshLeaseToken && waitUntil > Date.now()) {
        await new Promise(resolve => setTimeout(resolve, Math.min(refreshPollMs, waitUntil - Date.now())));
      }
      continue;
    }

    const currentAad = calendarSecretAad('connection', current.id, 'access-token');
    const refreshAad = calendarSecretAad('connection', current.id, 'refresh-token');
    try {
      const refresh = decryptCalendarSecret(current.refreshTokenCiphertext, refreshAad);
      // The lease is committed before this bounded provider request begins.
      const refreshed = await refreshGoogleAccessToken(refresh);
      const accessTokenCiphertext = encryptCalendarSecret(refreshed.accessToken, currentAad);
      const refreshTokenCiphertext = encryptCalendarSecret(refreshed.refreshToken ?? refresh, refreshAad);
      const update = await prisma.calendarConnection.updateMany({
        where: {
          id: current.id, accessTokenCiphertext: current.accessTokenCiphertext,
          refreshTokenCiphertext: current.refreshTokenCiphertext, busyRefreshLeaseToken: leaseToken,
        },
        data: {
          accessTokenCiphertext, refreshTokenCiphertext,
          accessTokenExpiresAt: refreshed.expiresAt, lastErrorCode: null,
          ...(!ownsOuterLease ? { busyRefreshLeaseUntil: null, busyRefreshLeaseToken: null } : {}),
        },
      });
      if (!update.count) {
        if (!ownsOuterLease) await releaseRefreshLease(current.id, leaseToken);
        current = await prisma.calendarConnection.findUniqueOrThrow({ where: { id: current.id } });
        continue;
      }
      await prisma.calendarConnection.updateMany({
        where: { id: current.id, status: 'REAUTH_REQUIRED', disconnectRequestedAt: null },
        data: { status: 'ACTIVE', lastErrorCode: null },
      });
      return { value: refreshed.accessToken, ciphertext: accessTokenCiphertext };
    } catch (error) {
      const winner = await prisma.calendarConnection.findUnique({ where: { id: current.id } });
      if (winner && credentialGenerationChanged(winner, current)) {
        if (!ownsOuterLease) await releaseRefreshLease(current.id, leaseToken);
        current = winner;
        continue;
      }
      if (error instanceof GoogleCalendarError && error.reauth) {
        await prisma.calendarConnection.updateMany({
          where: {
            id: current.id, accessTokenCiphertext: current.accessTokenCiphertext,
            refreshTokenCiphertext: current.refreshTokenCiphertext,
            busyRefreshLeaseToken: leaseToken, status: { not: 'DISCONNECTING' },
          },
          data: { status: 'REAUTH_REQUIRED', lastErrorCode: error.code },
        });
      }
      if (!ownsOuterLease) await releaseRefreshLease(current.id, leaseToken);
      throw error;
    }
  }
}

async function withGoogleAccess<T>(
  connection: CalendarConnection,
  operation: (accessToken: string) => Promise<T>,
  connectionLeaseToken?: string,
) {
  let credential: Awaited<ReturnType<typeof accessToken>> | undefined;
  try {
    credential = await accessToken(connection, connectionLeaseToken);
    return await operation(credential.value);
  } catch (error) {
    if (error instanceof CalendarCryptoError) {
      await prisma.calendarConnection.updateMany({
        where: { id: connection.id, status: { not: 'DISCONNECTING' } },
        data: { status: 'REAUTH_REQUIRED', lastErrorCode: 'TOKEN_DECRYPT_FAILED' },
      });
    }
    if (error instanceof GoogleCalendarError && credential) {
      await prisma.calendarConnection.updateMany({
        where: {
          id: connection.id, accessTokenCiphertext: credential.ciphertext,
          ...(error.reauth ? { status: { not: 'DISCONNECTING' } } : {}),
        },
        data: {
          lastErrorCode: error.code,
          ...(error.reauth ? { status: 'REAUTH_REQUIRED' } : {}),
        },
      });
    }
    throw error;
  }
}

type BookingGraph = Prisma.BookingGetPayload<{
  include: {
    business: { select: { name: true; timezone: true } };
    service: { select: { name: true } };
    instructor: { include: { membership: { select: { userId: true } } } };
    location: { select: { name: true; address: true } };
    participants: { include: { student: { select: { userId: true } } } };
    calendarProjections: { include: { connection: true } };
  };
}>;

const bookingGraph = {
  business: { select: { name: true, timezone: true } },
  service: { select: { name: true } },
  instructor: { include: { membership: { select: { userId: true } } } },
  location: { select: { name: true, address: true } },
  participants: { include: { student: { select: { userId: true } } } },
  calendarProjections: { include: { connection: true } },
} satisfies Prisma.BookingInclude;

function desiredUsers(booking: BookingGraph) {
  const ids = new Set<string>();
  const coachUserId = booking.instructor.membership?.userId;
  if (coachUserId) ids.add(coachUserId);
  for (const participant of booking.participants) {
    if (!participant.cancelledAt && participant.student.userId) ids.add(participant.student.userId);
  }
  return ids;
}

type ClaimedJob = { id: string; bookingId: string; requestedRevision: number; attempts: number; leaseToken: string };

async function renewJobLease(job: ClaimedJob, db: CalendarDb = prisma) {
  const renewed = await db.calendarSyncJob.updateMany({
    where: { id: job.id, leaseToken: job.leaseToken, requestedRevision: job.requestedRevision },
    data: { leasedUntil: new Date(Date.now() + config.googleCalendar.requestTimeoutMs + jobLeaseMs) },
  });
  return renewed.count === 1;
}

async function requeueCurrentBookingRevision(bookingId: string) {
  try {
    await prisma.$transaction(async tx => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId }, select: { calendarRevision: true },
      });
      if (!booking) return;
      await tx.calendarSyncJob.upsert({
        where: { bookingId },
        create: { bookingId, requestedRevision: booking.calendarRevision },
        update: {
          requestedRevision: booking.calendarRevision, availableAt: new Date(),
          attempts: 0, lastErrorCode: null,
          // A current worker may still own this row. Keep its lease; if it
          // wins, its revision-fenced completion is safe, otherwise expiry
          // makes this repair request claimable.
        },
      });
    });
  } catch (error) {
    // Booking deletion can win after the read. Its SET NULL projection is the
    // durable cleanup path, so a missing parent needs no replacement job.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)
      || !['P2003', 'P2025'].includes(error.code)) throw error;
  }
}

async function retainLeaseOrRequeue(job: ClaimedJob) {
  if (await renewJobLease(job)) return true;
  await requeueCurrentBookingRevision(job.bookingId);
  return false;
}

async function reserveProjection(connection: CalendarConnection, job: ClaimedJob) {
  return prisma.$transaction(async tx => {
    // This is the same lock taken by disconnectCalendarConnection(). It makes
    // the projection visible before a disconnect can become observable, so a
    // provider event can never be created after its cleanup record disappears.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar-connection:${connection.id}`}, 0))`;
    if (!await renewJobLease(job, tx)) return { state: 'stale' as const };
    const [currentConnection, currentBooking] = await Promise.all([
      tx.calendarConnection.findUnique({ where: { id: connection.id } }),
      tx.booking.findUnique({
        where: { id: job.bookingId }, select: { id: true, calendarRevision: true },
      }),
    ]);
    if (!currentBooking || currentBooking.calendarRevision !== job.requestedRevision) {
      return { state: 'stale' as const };
    }
    if (!currentConnection || currentConnection.status !== 'ACTIVE' || !currentConnection.syncEnabled) {
      return { state: 'skip' as const };
    }
    const existing = await tx.calendarEventProjection.findUnique({
      where: { connectionId_bookingId: {
        connectionId: currentConnection.id, bookingId: currentBooking.id,
      } },
    });
    if (existing?.syncedRevision !== undefined
      && existing.syncedRevision >= currentBooking.calendarRevision) {
      return { state: 'current' as const };
    }
    if (existing?.cleanupLeaseUntil && existing.cleanupLeaseUntil > new Date()
      && existing.cleanupLeaseToken) {
      return { state: 'busy' as const };
    }
    const providerEventId = existing?.providerEventId
      ?? googleProviderEventId(currentConnection.id, currentBooking.id);
    const projectionLeaseToken = randomUUID();
    const projection = existing
      ? await tx.calendarEventProjection.update({
        where: { id: existing.id },
        data: {
          cleanupLeaseUntil: new Date(Date.now() + jobLeaseMs),
          cleanupLeaseToken: projectionLeaseToken,
        },
      })
      : await tx.calendarEventProjection.create({
        data: {
          connectionId: currentConnection.id, bookingId: currentBooking.id,
          providerEventId, syncedRevision: 0,
          cleanupLeaseUntil: new Date(Date.now() + config.googleCalendar.requestTimeoutMs + jobLeaseMs),
          cleanupLeaseToken: projectionLeaseToken,
        },
      });
    return {
      state: 'ready' as const, connection: currentConnection, projection,
      projectionLeaseToken,
      // A prior reservation may represent a timed-out POST. PUT-with-404
      // fallback remains idempotent for both that case and a real event.
      knownToExist: Boolean(existing),
    };
  });
}

async function synchronizeBooking(job: ClaimedJob) {
  const { bookingId, requestedRevision } = job;
  if (!await renewJobLease(job)) return;
  const currentJob = await prisma.calendarSyncJob.findUnique({
    where: { bookingId }, select: { requestedRevision: true },
  });
  if (!currentJob || currentJob.requestedRevision !== requestedRevision) return;
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, include: bookingGraph });
  if (!booking || booking.calendarRevision !== requestedRevision) return;
  // Completion freezes an existing enabled projection as historical truth.
  // It never creates a late event, but disabling/disconnecting still removes
  // the user's remote copy as explicitly requested.
  const desiredUserIds = ['CONFIRMED', 'COMPLETED'].includes(booking.status)
    ? desiredUsers(booking)
    : new Set<string>();
  const connections = desiredUserIds.size ? await prisma.calendarConnection.findMany({
    where: { userId: { in: [...desiredUserIds] }, status: 'ACTIVE', syncEnabled: true },
  }) : [];
  const desiredConnections = new Map(connections.map(connection => [connection.userId, connection]));

  for (const projection of booking.calendarProjections) {
    if (desiredConnections.has(projection.connection.userId)) continue;
    // Keep the local mapping while authorization is unavailable. Reconnect
    // queues this booking again, allowing the still-known remote event to be
    // deleted instead of silently orphaning it. A deliberate disconnect is
    // different: local cleanup must complete even if Google already revoked
    // the grant, after which the connection itself can be removed.
    if (projection.connection.status === 'REAUTH_REQUIRED') continue;
    if (!await renewJobLease(job)) return;
    const deletionLeaseToken = randomUUID();
    const leasedProjection = await prisma.calendarEventProjection.updateMany({
      where: {
        id: projection.id, syncedRevision: projection.syncedRevision,
        OR: [
          { cleanupLeaseUntil: null },
          { cleanupLeaseUntil: { lt: new Date() } },
        ],
      },
      data: {
        cleanupLeaseUntil: new Date(Date.now() + config.googleCalendar.requestTimeoutMs + jobLeaseMs),
        cleanupLeaseToken: deletionLeaseToken,
      },
    });
    if (!leasedProjection.count) throw new Error('Calendar projection is already being synchronized');
    if (projection.connection.status === 'DISCONNECTING') {
      try {
        await withGoogleAccess(projection.connection, token =>
          deleteGoogleCalendarEvent(token, projection.providerEventId));
      } catch (error) {
        if (error instanceof CalendarCryptoError) {
          console.warn(`Google Calendar event ${projection.providerEventId} could not be removed because its connection token is unreadable`);
        } else if (!(error instanceof GoogleCalendarError) || !error.reauth) {
          await prisma.calendarEventProjection.updateMany({
            where: { id: projection.id, cleanupLeaseToken: deletionLeaseToken },
            data: { cleanupLeaseUntil: null, cleanupLeaseToken: null },
          });
          throw error;
        }
      }
      if (!await retainLeaseOrRequeue(job)) return;
      await prisma.calendarEventProjection.deleteMany({
        where: {
          id: projection.id, syncedRevision: projection.syncedRevision,
          cleanupLeaseToken: deletionLeaseToken,
        },
      });
      continue;
    }
    try {
      await withGoogleAccess(projection.connection, token =>
        deleteGoogleCalendarEvent(token, projection.providerEventId));
    } catch (error) {
      await prisma.calendarEventProjection.updateMany({
        where: { id: projection.id, cleanupLeaseToken: deletionLeaseToken },
        data: { cleanupLeaseUntil: null, cleanupLeaseToken: null },
      });
      throw error;
    }
    if (!await retainLeaseOrRequeue(job)) return;
    await prisma.calendarEventProjection.deleteMany({
      where: {
        id: projection.id, syncedRevision: projection.syncedRevision,
        cleanupLeaseToken: deletionLeaseToken,
      },
    });
  }
  if (booking.status === 'COMPLETED') return;

  for (const connection of desiredConnections.values()) {
    const reserved = await reserveProjection(connection, job);
    if (reserved.state === 'stale') return;
    if (reserved.state === 'busy') {
      throw new Error('Calendar projection is already being synchronized');
    }
    if (reserved.state !== 'ready') continue;
    try {
      const result = await withGoogleAccess(reserved.connection, token =>
        writeGoogleCalendarEvent(token, reserved.projection.providerEventId, {
          bookingId: booking.id, revision: booking.calendarRevision,
          summary: `${booking.service.name} at ${booking.business.name}`,
          location: [booking.location.name, booking.location.address].filter(Boolean).join(' — '),
          startAt: booking.startAt, endAt: booking.endAt, timeZone: booking.business.timezone,
        }, reserved.knownToExist));
      await prisma.calendarEventProjection.updateMany({
        where: {
          id: reserved.projection.id, cleanupLeaseToken: reserved.projectionLeaseToken,
          syncedRevision: { lte: booking.calendarRevision },
        },
        data: {
          providerEtag: result.etag, syncedRevision: booking.calendarRevision, cleanupAfter: new Date(),
          cleanupLeaseUntil: null, cleanupLeaseToken: null,
        },
      });
    } catch (error) {
      await prisma.calendarEventProjection.updateMany({
        where: { id: reserved.projection.id, cleanupLeaseToken: reserved.projectionLeaseToken },
        data: { cleanupAfter: new Date(), cleanupLeaseUntil: null, cleanupLeaseToken: null },
      });
      throw error;
    }
    if (!await retainLeaseOrRequeue(job)) return;
  }

  await prisma.calendarConnection.updateMany({
    where: {
      id: { in: connections.map(connection => connection.id) }, status: 'ACTIVE', syncEnabled: true,
    },
    data: { lastSyncedAt: new Date(), lastErrorCode: null },
  });
}

async function claimSyncJobs() {
  const leaseToken = randomUUID();
  const rows = await prisma.$queryRaw<Array<Omit<ClaimedJob, 'leaseToken'>>>(Prisma.sql`
    WITH candidates AS (
      SELECT "id" FROM "CalendarSyncJob"
      WHERE "availableAt" <= CURRENT_TIMESTAMP
        AND ("leasedUntil" IS NULL OR "leasedUntil" < CURRENT_TIMESTAMP)
      ORDER BY "availableAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "CalendarSyncJob" AS job
    SET "leasedUntil" = CURRENT_TIMESTAMP + (${jobLeaseMs} * INTERVAL '1 millisecond'),
        "leaseToken" = ${leaseToken},
        "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE job."id" = candidates."id"
    RETURNING job."id", job."bookingId", job."requestedRevision", job."attempts"
  `);
  return rows.map(row => ({ ...row, leaseToken }));
}

async function finishJob(job: ClaimedJob) {
  const deleted = await prisma.calendarSyncJob.deleteMany({
    where: { id: job.id, leaseToken: job.leaseToken, requestedRevision: job.requestedRevision },
  });
  if (!deleted.count) {
    await prisma.calendarSyncJob.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken },
      data: { leasedUntil: null, leaseToken: null, availableAt: new Date() },
    });
  }
}

async function failJob(job: ClaimedJob, error: unknown) {
  const code = error instanceof GoogleCalendarError ? error.code : 'SYNC_FAILED';
  const transient = !(error instanceof GoogleCalendarError) || error.transient || error.reauth;
  const failed = await prisma.calendarSyncJob.updateMany({
    where: {
      id: job.id, leaseToken: job.leaseToken, requestedRevision: job.requestedRevision,
    },
    data: {
      attempts: { increment: 1 },
      availableAt: transient ? retryAt(job.attempts) : new Date(Date.now() + maxBackoffMs),
      lastErrorCode: code,
      leasedUntil: null, leaseToken: null,
    },
  });
  if (!failed.count) {
    await prisma.calendarSyncJob.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken },
      data: { leasedUntil: null, leaseToken: null, availableAt: new Date() },
    });
  }
}

export async function processCalendarSyncJobs() {
  if (!config.googleCalendar.enabled) return 0;
  const jobs = await claimSyncJobs();
  for (const job of jobs) {
    try {
      await synchronizeBooking(job);
      await finishJob(job);
    } catch (error) {
      await failJob(job, error);
    }
  }
  return jobs.length;
}

type ClaimedConnection = CalendarConnection & { busyRefreshLeaseToken: string };
type ClaimedDisconnect = CalendarConnection & { busyRefreshLeaseToken: string };

async function claimBusyConnections() {
  const leaseToken = randomUUID();
  const rows = await prisma.$queryRaw<CalendarConnection[]>(Prisma.sql`
    WITH candidates AS (
      SELECT "id" FROM "CalendarConnection"
      WHERE "status" = 'ACTIVE' AND "busyCheckEnabled" = true
        AND "busyRefreshAfter" <= CURRENT_TIMESTAMP
        AND ("busyRefreshLeaseUntil" IS NULL OR "busyRefreshLeaseUntil" < CURRENT_TIMESTAMP)
      ORDER BY "busyRefreshAfter" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "CalendarConnection" AS connection
    SET "busyRefreshLeaseUntil" = CURRENT_TIMESTAMP + (${jobLeaseMs} * INTERVAL '1 millisecond'),
        "busyRefreshLeaseToken" = ${leaseToken},
        "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE connection."id" = candidates."id"
    RETURNING connection.*
  `);
  return rows.map(row => ({ ...row, busyRefreshLeaseToken: leaseToken })) as ClaimedConnection[];
}

async function refreshBusyConnection(connection: ClaimedConnection) {
  const now = new Date();
  const timeMin = new Date(now.getTime() - 86_400_000);
  const timeMax = new Date(now.getTime() + 366 * 86_400_000);
  const expiresAt = new Date(now.getTime() + config.googleCalendar.busyCacheMinutes * 60_000);
  const intervals = await withGoogleAccess(connection, token => listGoogleBusyIntervals(token, {
    timeMin, timeMax, timeZone: connection.calendarTimeZone,
  }), connection.busyRefreshLeaseToken);
  await prisma.$transaction(async tx => {
    const [owned] = await tx.$queryRaw<Array<{ id: string; status: string; busyCheckEnabled: boolean }>>(Prisma.sql`
      SELECT "id", "status", "busyCheckEnabled"
      FROM "CalendarConnection"
      WHERE "id" = ${connection.id}
        AND "busyRefreshLeaseToken" = ${connection.busyRefreshLeaseToken}
      FOR UPDATE
    `);
    if (!owned) return;
    if (owned.status !== 'ACTIVE' || !owned.busyCheckEnabled) {
      await tx.calendarBusyInterval.deleteMany({ where: { connectionId: connection.id } });
      await tx.calendarConnection.updateMany({
        where: { id: connection.id, busyRefreshLeaseToken: connection.busyRefreshLeaseToken },
        data: { busyRefreshLeaseUntil: null, busyRefreshLeaseToken: null },
      });
      return;
    }
    await tx.calendarBusyInterval.deleteMany({ where: { connectionId: connection.id } });
    if (intervals.length) await tx.calendarBusyInterval.createMany({
      data: intervals.map(interval => ({ connectionId: connection.id, ...interval, expiresAt })),
    });
    await tx.calendarConnection.update({
      where: { id: connection.id },
      data: {
        busyLastRefreshedAt: now,
        busyRefreshAfter: new Date(now.getTime() + config.googleCalendar.busyRefreshMinutes * 60_000),
        busyRefreshFailures: 0, busyRefreshLeaseUntil: null, busyRefreshLeaseToken: null, lastErrorCode: null,
      },
    });
  });
}

async function failBusyRefresh(connection: ClaimedConnection, error: unknown) {
  const code = error instanceof GoogleCalendarError ? error.code : 'BUSY_REFRESH_FAILED';
  await prisma.$transaction(async tx => {
    const [current] = await tx.$queryRaw<Array<{ status: string; busyCheckEnabled: boolean }>>(Prisma.sql`
      SELECT "status", "busyCheckEnabled"
      FROM "CalendarConnection"
      WHERE "id" = ${connection.id}
        AND "busyRefreshLeaseToken" = ${connection.busyRefreshLeaseToken}
      FOR UPDATE
    `);
    if (!current) return;
    if (!current.busyCheckEnabled) {
      await tx.calendarConnection.updateMany({
        where: { id: connection.id, busyRefreshLeaseToken: connection.busyRefreshLeaseToken },
        data: { busyRefreshLeaseUntil: null, busyRefreshLeaseToken: null },
      });
      return;
    }
    await tx.calendarConnection.updateMany({
      where: { id: connection.id, busyRefreshLeaseToken: connection.busyRefreshLeaseToken },
      data: {
        busyRefreshFailures: { increment: 1 },
        busyRefreshAfter: current.status === 'DISCONNECTING'
          ? new Date()
          : retryAt(connection.busyRefreshFailures),
        busyRefreshLeaseUntil: null, busyRefreshLeaseToken: null, lastErrorCode: code,
        ...(current.status !== 'DISCONNECTING'
          && error instanceof GoogleCalendarError && error.reauth ? { status: 'REAUTH_REQUIRED' } : {}),
      },
    });
  });
}

export async function refreshDueCalendarBusyIntervals() {
  if (!config.googleCalendar.enabled) return 0;
  const connections = await claimBusyConnections();
  for (const connection of connections) {
    try { await refreshBusyConnection(connection); }
    catch (error) { await failBusyRefresh(connection, error); }
  }
  await prisma.calendarBusyInterval.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return connections.length;
}

type ClaimedRevocation = {
  id: string; tokenCiphertext: string; attempts: number; leaseToken: string;
};

export async function processCalendarRevocations() {
  const leaseToken = randomUUID();
  const jobs = await prisma.$queryRaw<Array<Omit<ClaimedRevocation, 'leaseToken'>>>(Prisma.sql`
    WITH candidates AS (
      SELECT "id" FROM "CalendarRevocationJob"
      WHERE "availableAt" <= CURRENT_TIMESTAMP
        AND ("leasedUntil" IS NULL OR "leasedUntil" < CURRENT_TIMESTAMP)
      ORDER BY "availableAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "CalendarRevocationJob" AS job
    SET "leasedUntil" = CURRENT_TIMESTAMP
          + (${jobLeaseMs + config.googleCalendar.requestTimeoutMs} * INTERVAL '1 millisecond'),
        "leaseToken" = ${leaseToken},
        "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE job."id" = candidates."id"
    RETURNING job."id", job."tokenCiphertext", job."attempts"
  `);
  const claimed = jobs.map(job => ({ ...job, leaseToken }));
  for (const job of claimed) {
    try {
      const token = decryptCalendarSecret(
        job.tokenCiphertext, calendarSecretAad('revocation-job', job.id, 'token'),
      );
      await revokeGoogleToken(token);
      await prisma.calendarRevocationJob.deleteMany({
        where: { id: job.id, leaseToken: job.leaseToken },
      });
    } catch (error) {
      if (error instanceof CalendarCryptoError) {
        console.warn(`Calendar grant ${job.id} cannot be revoked because its encryption key is unavailable`);
        await prisma.calendarRevocationJob.updateMany({
          where: { id: job.id, leaseToken: job.leaseToken },
          data: {
            attempts: { increment: 1 }, availableAt: new Date(Date.now() + maxBackoffMs),
            leasedUntil: null, leaseToken: null, lastErrorCode: 'TOKEN_DECRYPT_FAILED',
          },
        });
        continue;
      }
      const transient = !(error instanceof GoogleCalendarError) || error.transient || error.reauth;
      await prisma.calendarRevocationJob.updateMany({
        where: { id: job.id, leaseToken: job.leaseToken },
        data: {
          attempts: { increment: 1 },
          availableAt: transient ? retryAt(job.attempts) : new Date(Date.now() + maxBackoffMs),
          leasedUntil: null, leaseToken: null,
          lastErrorCode: error instanceof GoogleCalendarError ? error.code : 'REVOKE_FAILED',
        },
      });
    }
  }
  return claimed.length;
}

export async function processCalendarDisconnects() {
  if (!config.googleCalendar.enabled) {
    const connections = await prisma.calendarConnection.findMany({
      where: {
        status: 'DISCONNECTING',
        OR: [
          { busyRefreshLeaseUntil: null },
          { busyRefreshLeaseUntil: { lt: new Date() } },
        ],
      },
      select: { id: true }, orderBy: { disconnectRequestedAt: 'asc' }, take: batchSize,
    });
    let processed = 0;
    for (const candidate of connections) {
      if (await activeConnectionLease(candidate.id)) continue;
      processed += await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar-connection:${candidate.id}`}, 0))`;
        const checkedAt = new Date();
        const [connection] = await tx.$queryRaw<CalendarConnection[]>(Prisma.sql`
          SELECT * FROM "CalendarConnection"
          WHERE "id" = ${candidate.id} AND "status" = 'DISCONNECTING'
            AND ("busyRefreshLeaseUntil" IS NULL OR "busyRefreshLeaseUntil" < ${checkedAt})
          FOR UPDATE
        `);
        if (!connection) return 0;
        try {
          const token = connection.refreshTokenCiphertext
            ? decryptCalendarSecret(
              connection.refreshTokenCiphertext,
              calendarSecretAad('connection', connection.id, 'refresh-token'),
            )
            : decryptCalendarSecret(
              connection.accessTokenCiphertext,
              calendarSecretAad('connection', connection.id, 'access-token'),
            );
          const revocationJobId = randomUUID();
          await tx.calendarRevocationJob.create({
            data: {
              id: revocationJobId,
              tokenCiphertext: encryptCalendarSecret(
                token, calendarSecretAad('revocation-job', revocationJobId, 'token'),
              ),
            },
          });
        } catch (error) {
          if (!(error instanceof CalendarCryptoError)) throw error;
          console.warn(`Google Calendar connection ${connection.id} was removed locally because its token could not be decrypted`);
        }
        await tx.calendarConnection.delete({ where: { id: connection.id } });
        return 1;
      });
    }
    return processed;
  }
  const leaseToken = randomUUID();
  const claimedAt = new Date();
  const leasedUntil = new Date(claimedAt.getTime() + jobLeaseMs);
  const claimed = await prisma.$queryRaw<CalendarConnection[]>(Prisma.sql`
    WITH candidates AS (
      SELECT connection."id" FROM "CalendarConnection" AS connection
      WHERE connection."status" = 'DISCONNECTING'
        AND NOT EXISTS (
          SELECT 1 FROM "CalendarEventProjection" AS projection
          WHERE projection."connectionId" = connection."id"
        )
        AND connection."busyRefreshAfter" <= CURRENT_TIMESTAMP
        AND (connection."busyRefreshLeaseUntil" IS NULL OR connection."busyRefreshLeaseUntil" < ${claimedAt})
      ORDER BY connection."disconnectRequestedAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "CalendarConnection" AS connection
    SET "busyRefreshLeaseUntil" = ${leasedUntil},
        "busyRefreshLeaseToken" = ${leaseToken},
        "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE connection."id" = candidates."id"
    RETURNING connection.*
  `);
  const connections = claimed.map(connection => ({
    ...connection, busyRefreshLeaseToken: leaseToken,
  })) as ClaimedDisconnect[];
  for (const connection of connections) {
    try {
      const token = connection.refreshTokenCiphertext
        ? decryptCalendarSecret(
          connection.refreshTokenCiphertext, calendarSecretAad('connection', connection.id, 'refresh-token'),
        )
        : decryptCalendarSecret(
          connection.accessTokenCiphertext, calendarSecretAad('connection', connection.id, 'access-token'),
        );
      await revokeGoogleToken(token);
      await prisma.calendarConnection.deleteMany({
        where: {
          id: connection.id, status: 'DISCONNECTING',
          busyRefreshLeaseToken: connection.busyRefreshLeaseToken, projections: { none: {} },
        },
      });
    } catch (error) {
      if (error instanceof CalendarCryptoError) {
        console.warn(`Google Calendar connection ${connection.id} was removed locally because its token could not be decrypted`);
        await prisma.calendarConnection.deleteMany({ where: {
          id: connection.id, status: 'DISCONNECTING',
          busyRefreshLeaseToken: connection.busyRefreshLeaseToken, projections: { none: {} },
        } });
        continue;
      }
      const transient = !(error instanceof GoogleCalendarError) || error.transient || error.reauth;
      await prisma.calendarConnection.updateMany({
        where: {
          id: connection.id, status: 'DISCONNECTING', busyRefreshLeaseToken: connection.busyRefreshLeaseToken,
        },
        data: {
          lastErrorCode: error instanceof GoogleCalendarError ? error.code : 'REVOKE_FAILED',
          busyRefreshAfter: transient
            ? retryAt(connection.busyRefreshFailures)
            : new Date(Date.now() + maxBackoffMs),
          busyRefreshFailures: { increment: 1 },
          busyRefreshLeaseUntil: null, busyRefreshLeaseToken: null,
        },
      });
    }
  }
  return connections.length;
}

/**
 * Booking teardown leaves projections as a durable remote-cleanup record. The
 * cleanup fields provide a retry deadline and cross-process lease; no
 * user-facing transaction ever waits for this provider call.
 */
export async function processOrphanCalendarProjections() {
  if (!config.googleCalendar.enabled) return 0;
  const leaseToken = randomUUID();
  const candidates = await prisma.$queryRaw<Array<{
    id: string; cleanupAttempts: number; cleanupLeaseToken: string;
  }>>(Prisma.sql`
    WITH candidates AS (
      SELECT "id" FROM "CalendarEventProjection"
      WHERE "bookingId" IS NULL AND "cleanupAfter" <= CURRENT_TIMESTAMP
        AND ("cleanupLeaseUntil" IS NULL OR "cleanupLeaseUntil" < CURRENT_TIMESTAMP)
      ORDER BY "cleanupAfter" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "CalendarEventProjection" AS projection
    SET "cleanupLeaseUntil" = CURRENT_TIMESTAMP
          + (${jobLeaseMs + config.googleCalendar.requestTimeoutMs} * INTERVAL '1 millisecond'),
        "cleanupLeaseToken" = ${leaseToken},
        "updatedAt" = CURRENT_TIMESTAMP
    FROM candidates
    WHERE projection."id" = candidates."id"
    RETURNING projection."id", projection."cleanupAttempts", projection."cleanupLeaseToken"
  `);
  for (const candidate of candidates) {
    try {
      const projection = await prisma.calendarEventProjection.findFirst({
        where: { id: candidate.id, bookingId: null, cleanupLeaseToken: candidate.cleanupLeaseToken },
        include: { connection: true },
      });
      if (!projection) continue;
      if (projection.connection.status === 'REAUTH_REQUIRED') {
        await prisma.calendarEventProjection.updateMany({
          where: { id: projection.id, bookingId: null, cleanupLeaseToken: candidate.cleanupLeaseToken },
          data: {
            cleanupAfter: new Date(Date.now() + maxBackoffMs), cleanupAttempts: { increment: 1 },
            cleanupLeaseUntil: null, cleanupLeaseToken: null,
          },
        });
        continue;
      }
      await withGoogleAccess(projection.connection, token =>
        deleteGoogleCalendarEvent(token, projection.providerEventId));
      await prisma.calendarEventProjection.deleteMany({ where: {
        id: projection.id, bookingId: null, cleanupLeaseToken: candidate.cleanupLeaseToken,
      } });
    } catch (error) {
      if (error instanceof CalendarCryptoError) {
        const disconnecting = await prisma.calendarEventProjection.findFirst({
          where: {
            id: candidate.id, bookingId: null, cleanupLeaseToken: candidate.cleanupLeaseToken,
            connection: { status: 'DISCONNECTING' },
          },
          select: { id: true, providerEventId: true },
        });
        if (disconnecting) {
          console.warn(`Google Calendar event ${disconnecting.providerEventId} could not be removed because its connection token is unreadable`);
          await prisma.calendarEventProjection.deleteMany({ where: {
            id: disconnecting.id, bookingId: null, cleanupLeaseToken: candidate.cleanupLeaseToken,
          } });
          continue;
        }
      }
      const transient = !(error instanceof GoogleCalendarError) || error.transient || error.reauth;
      await prisma.calendarEventProjection.updateMany({
        where: { id: candidate.id, bookingId: null, cleanupLeaseToken: candidate.cleanupLeaseToken },
        data: {
          cleanupAttempts: { increment: 1 },
          cleanupAfter: transient
            ? retryAt(candidate.cleanupAttempts)
            : new Date(Date.now() + maxBackoffMs),
          cleanupLeaseUntil: null, cleanupLeaseToken: null,
        },
      });
    }
  }
  return candidates.length;
}

export async function disconnectCalendarConnection(userId: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar-user:${userId}`}, 0))`;
    await tx.calendarOAuthAttempt.deleteMany({ where: { userId } });
    const connection = await tx.calendarConnection.findUnique({ where: { userId } });
    if (!connection) return null;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar-connection:${connection.id}`}, 0))`;
    const current = await tx.calendarConnection.findUniqueOrThrow({ where: { id: connection.id } });
    const updated = await tx.calendarConnection.update({
      where: { id: current.id },
      data: {
        status: 'DISCONNECTING', syncEnabled: false, busyCheckEnabled: false,
        disconnectRequestedAt: current.disconnectRequestedAt ?? new Date(),
        busyRefreshAfter: new Date(),
        busyRefreshFailures: 0, lastErrorCode: null,
      },
    });
    await tx.calendarBusyInterval.deleteMany({ where: { connectionId: current.id } });
    await queueCalendarBookingsForUserInTransaction(tx, userId);
    return updated;
  }, { timeout: 30_000 });
}

export async function runCalendarWorkerOnce() {
  await processCalendarSyncJobs();
  await processOrphanCalendarProjections();
  await processCalendarDisconnects();
  await processCalendarRevocations();
  await refreshDueCalendarBusyIntervals();
  await prisma.calendarOAuthAttempt.deleteMany({
    where: { OR: [
      { expiresAt: { lt: new Date() } },
      { consumedAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } },
    ] },
  });
}

export function startCalendarWorker() {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await runCalendarWorkerOnce(); }
    catch (error) { console.error('Calendar worker tick failed', error); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, config.googleCalendar.workerIntervalMs);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
