import { Router, type RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireStudent } from './auth.js';
import { prisma } from './db.js';
import {
  asyncRoute, coachScope, coachScoped, hasClubPermission, HttpError,
  requireAccountCapability, requireCoachOrClubPermission, type AccountRequest, type WorkspaceRequest,
} from './http.js';
import { sharedRateLimit } from './rate-limit.js';
import { publicBookingBusiness } from './serializers.js';
import { createAccountAlert } from './account-notifications.js';
import { recordClubMetric } from './club-metrics.js';
import {
  closeLiveWaitlistEntries, countHeldWaitlistOffers, createBookingsInTransaction, evaluateSlot,
  GROUP_FULL_REASON, lockInstructors, resolveAccountStudent, schedulingContext,
} from './scheduling.js';

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

// Implements docs/TRAINING_COMPANION.md §4. A waitlist is a queue of club-local
// students for one full group Class occurrence. An offer holds a place until
// its deadline; evaluateSlot counts held places, so a public booking cannot
// take a place promised to the next person in the queue.

const LIVE_STATUSES = ['WAITING', 'OFFERED'] as const;
/** An offer never holds a place longer than this, so a silent student cannot stall the queue. */
const OFFER_HOLD_MS = 12 * 3_600_000;
/** Shorter than this and nobody can reasonably respond before bookings close. */
const MIN_OFFER_MS = 10 * 60_000;
const CLOSED_HISTORY_MS = 14 * 86_400_000;
const ACCOUNT_LIST_LIMIT = 100;
const PROVIDER_LIST_LIMIT = 200;
const SWEEP_BATCH = 100;

const CLOSED_CANCELLED = 'The Class was cancelled.';
const CLOSED_STARTED = 'The Class has started.';
const CLOSED_NOTICE = 'The Class is now inside its booking notice period.';
const CLOSED_UNBOOKABLE = 'The Class is no longer taking bookings.';
const CLOSED_NO_TIME = 'There is not enough time left to offer a place before bookings close.';

const waitlistBookingSelect = {
  id: true, businessId: true, serviceId: true, instructorId: true, locationId: true,
  startAt: true, endAt: true, status: true, type: true, capacity: true, paymentRoute: true,
  business: { select: { kind: true, legacyReadOnly: true, timezone: true } },
  service: { select: { name: true, noticeHours: true } },
} satisfies Prisma.BookingSelect;
type WaitlistBooking = Prisma.BookingGetPayload<{ select: typeof waitlistBookingSelect }>;

/** Bookings close to new students once the service notice period begins. */
const bookingsCloseAt = (booking: WaitlistBooking) =>
  booking.startAt.getTime() - booking.service.noticeHours * 3_600_000;

/**
 * Why a booking can no longer use its waitlist, or null while it can. Only a
 * live, writable club group Class outside its notice period keeps a queue.
 */
function closureReason(booking: WaitlistBooking, now: Date) {
  if (booking.status === 'CANCELLED') return CLOSED_CANCELLED;
  if (booking.status === 'COMPLETED' || booking.startAt <= now) return CLOSED_STARTED;
  if (booking.status !== 'PENDING' && booking.status !== 'CONFIRMED') return CLOSED_UNBOOKABLE;
  if (booking.type !== 'GROUP' || booking.paymentRoute !== 'CLUB'
    || booking.business.kind !== 'CLUB' || booking.business.legacyReadOnly) return CLOSED_UNBOOKABLE;
  if (bookingsCloseAt(booking) <= now.getTime()) return CLOSED_NOTICE;
  return null;
}

/**
 * The service, venue and coach must still form a bookable combination, or an
 * accepted offer could never become a booking. schedulingContext is the
 * authority that booking itself uses; it reads without failing the
 * transaction, so a refusal can be caught here.
 */
async function stillBookable(tx: Tx, booking: WaitlistBooking) {
  try {
    await schedulingContext(tx, booking.businessId, booking.serviceId, booking.instructorId, booking.locationId);
    return true;
  } catch (error) {
    if (error instanceof HttpError) return false;
    throw error;
  }
}

async function freePlaces(db: Db, booking: Pick<WaitlistBooking, 'id' | 'capacity'>, now: Date) {
  const active = await db.participant.count({ where: { bookingId: booking.id, cancelledAt: null } });
  const held = await countHeldWaitlistOffers(db, booking.id, undefined, now);
  return Math.max(0, booking.capacity - active - held);
}

const offerDeadline = (booking: WaitlistBooking, now: Date) =>
  new Date(Math.min(now.getTime() + OFFER_HOLD_MS, bookingsCloseAt(booking)));

/** An offer whose deadline passed no longer holds a place. */
async function expireStaleOffers(tx: Tx, bookingId: string, now: Date) {
  const result = await tx.waitlistEntry.updateMany({
    where: { bookingId, status: 'OFFERED', offerExpiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}

async function makeOffer(
  tx: Tx, entry: { id: string; student: { userId: string | null } }, booking: WaitlistBooking, now: Date, deadline: Date,
) {
  // Conditional on WAITING so a concurrent terminal decision always wins.
  const changed = await tx.waitlistEntry.updateMany({
    where: { id: entry.id, status: 'WAITING' },
    data: { status: 'OFFERED', offeredAt: now, offerExpiresAt: deadline },
  });
  if (!changed.count) return false;
  if (entry.student.userId) {
    await createAccountAlert(tx, {
      kind: 'WAITLIST_OFFERED', userId: entry.student.userId, businessId: booking.businessId, bookingId: booking.id,
      serviceName: booking.service.name, startAt: booking.startAt, expiresAt: deadline, timezone: booking.business.timezone,
    });
  }
  return true;
}

/**
 * Offer free places on a group Class to the next waiting students, in queue
 * order. Caller holds the instructor lock. Stale offers are expired first;
 * a Class that can no longer take students closes its queue instead.
 */
export async function offerWaitlistPlaces(tx: Tx, bookingId: string, options: { now?: Date } = {}): Promise<void> {
  const now = options.now ?? new Date();
  // Most bookings never have a queue; avoid loading anything else for them.
  if (!await tx.waitlistEntry.findFirst({ where: { bookingId, status: { in: [...LIVE_STATUSES] } }, select: { id: true } })) return;
  const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: waitlistBookingSelect });
  if (!booking) return;
  await expireStaleOffers(tx, bookingId, now);
  const reason = closureReason(booking, now);
  if (reason) {
    await closeLiveWaitlistEntries(tx, bookingId, reason);
    return;
  }
  let free = await freePlaces(tx, booking, now);
  if (free <= 0) return;
  const waiting = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "WaitlistEntry"
    WHERE "bookingId" = ${bookingId} AND "status" = 'WAITING'
    ORDER BY "sequence" ASC
    LIMIT ${free}
    FOR UPDATE`;
  if (!waiting.length) return;
  if (!await stillBookable(tx, booking)) {
    await closeLiveWaitlistEntries(tx, bookingId, CLOSED_UNBOOKABLE);
    return;
  }
  const deadline = offerDeadline(booking, now);
  if (deadline.getTime() - now.getTime() < MIN_OFFER_MS) {
    // Live offers keep their (earlier) deadlines; only the queue behind them ends.
    await closeLiveWaitlistEntries(tx, bookingId, CLOSED_NO_TIME, { statuses: ['WAITING'] });
    return;
  }
  const entries = await tx.waitlistEntry.findMany({
    where: { id: { in: waiting.map(row => row.id) }, status: 'WAITING' },
    select: { id: true, student: { select: { userId: true } } },
    orderBy: { sequence: 'asc' },
  });
  for (const entry of entries) {
    if (free <= 0) break;
    if (await makeOffer(tx, entry, booking, now, deadline)) free -= 1;
  }
}

/** Close every live entry for a booking that can no longer take students. */
export async function closeWaitlistForBooking(tx: Tx, bookingId: string, reason: string): Promise<void> {
  await closeLiveWaitlistEntries(tx, bookingId, reason);
}

/**
 * Expire stale offers, pass places on, and close queues for Classes inside
 * their notice period. Only bookings that need one of those actions are
 * selected, so a quiet queue costs one indexed scan per sweep. Tests pass
 * `businessIds` so a sweep never touches another tenant's rows.
 */
export async function sweepWaitlists(options: { now?: Date; limit?: number; businessIds?: string[] } = {}) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SWEEP_BATCH;
  const scope = options.businessIds
    ? Prisma.sql`AND booking."businessId" IN (${Prisma.join(options.businessIds.length ? options.businessIds : [''])})`
    : Prisma.empty;
  // Timestamps are stored as UTC wall-clock values; convert the bound instant
  // explicitly so the comparison ignores the session time zone.
  const at = Prisma.sql`(${now}::timestamptz AT TIME ZONE 'UTC')`;
  const due = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT booking."id"
    FROM "Booking" AS booking
    JOIN "Service" AS service ON service."id" = booking."serviceId"
    WHERE EXISTS (
        SELECT 1 FROM "WaitlistEntry" AS live
        WHERE live."bookingId" = booking."id" AND live."status" IN ('WAITING', 'OFFERED')
      )
      AND (
        booking."status" NOT IN ('PENDING', 'CONFIRMED')
        OR booking."startAt" - make_interval(hours => service."noticeHours") <= ${at}
        OR EXISTS (
          SELECT 1 FROM "WaitlistEntry" AS stale
          WHERE stale."bookingId" = booking."id" AND stale."status" = 'OFFERED' AND stale."offerExpiresAt" <= ${at}
        )
        OR (
          EXISTS (
            SELECT 1 FROM "WaitlistEntry" AS waiting
            WHERE waiting."bookingId" = booking."id" AND waiting."status" = 'WAITING'
          )
          AND booking."capacity" > (
            SELECT count(*) FROM "Participant" AS participant
            WHERE participant."bookingId" = booking."id" AND participant."cancelledAt" IS NULL
          ) + (
            SELECT count(*) FROM "WaitlistEntry" AS held
            WHERE held."bookingId" = booking."id" AND held."status" = 'OFFERED' AND held."offerExpiresAt" > ${at}
          )
        )
      )
      ${scope}
    ORDER BY booking."startAt" ASC, booking."id" ASC
    LIMIT ${limit}`;
  let processed = 0;
  for (const { id } of due) {
    try {
      await prisma.$transaction(async tx => {
        const booking = await tx.booking.findUnique({ where: { id }, select: { instructorId: true } });
        if (!booking) return;
        // The instructor lock serializes this with bookings, cancellations and
        // student decisions, so replicas sweeping together cannot double-offer.
        await lockInstructors(tx, [booking.instructorId]);
        const current = await tx.booking.findUnique({ where: { id }, select: { instructorId: true } });
        if (!current || current.instructorId !== booking.instructorId) return;
        await offerWaitlistPlaces(tx, id, { now });
      }, { timeout: 15_000 });
      processed += 1;
    } catch (error) {
      // One bad Class must not stop the rest of the batch.
      console.error('Waitlist sweep failed', error);
    }
  }
  return processed;
}

export function startWaitlistWorker(intervalMs = 60_000): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await sweepWaitlists(); }
    catch (error) { console.error('Waitlist sweep tick failed', error); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

/* ------------------------------------------------------------------------ */
/* Serialization                                                             */
/* ------------------------------------------------------------------------ */

const accountEntryInclude = {
  business: true,
  booking: {
    select: {
      id: true, serviceId: true, instructorId: true, locationId: true, startAt: true, endAt: true,
      capacity: true, price: true,
      service: { select: { name: true } }, instructor: { select: { name: true } }, location: { select: { name: true } },
    },
  },
} satisfies Prisma.WaitlistEntryInclude;
type AccountEntry = Prisma.WaitlistEntryGetPayload<{ include: typeof accountEntryInclude }>;

/** Live entries queued ahead of each WAITING entry; null once offered or closed. */
async function aheadCounts(db: Db, entries: Array<{ id: string; bookingId: string; sequence: number; status: string }>) {
  const waiting = entries.filter(entry => entry.status === 'WAITING');
  const counts = new Map<string, number>();
  if (!waiting.length) return counts;
  const live = await db.waitlistEntry.findMany({
    where: { bookingId: { in: [...new Set(waiting.map(entry => entry.bookingId))] }, status: { in: [...LIVE_STATUSES] } },
    select: { bookingId: true, sequence: true },
  });
  for (const entry of waiting) {
    counts.set(entry.id, live.filter(other => other.bookingId === entry.bookingId && other.sequence < entry.sequence).length);
  }
  return counts;
}

const accountEntryJson = (entry: AccountEntry, aheadCount: number | null) => ({
  id: entry.id,
  status: entry.status,
  aheadCount: entry.status === 'WAITING' ? aheadCount ?? 0 : null,
  offeredAt: entry.offeredAt?.toISOString() ?? null,
  offerExpiresAt: entry.offerExpiresAt?.toISOString() ?? null,
  createdAt: entry.createdAt.toISOString(),
  closedReason: entry.closedReason,
  business: publicBookingBusiness(entry.business),
  booking: {
    id: entry.booking.id, serviceId: entry.booking.serviceId, serviceName: entry.booking.service.name,
    instructorId: entry.booking.instructorId, instructorName: entry.booking.instructor.name,
    locationId: entry.booking.locationId, locationName: entry.booking.location.name,
    startAt: entry.booking.startAt.toISOString(), endAt: entry.booking.endAt.toISOString(),
    capacity: entry.booking.capacity, price: entry.booking.price,
  },
});

async function loadAccountEntry(entryId: string, userId: string) {
  const entry = await prisma.waitlistEntry.findFirst({
    where: { id: entryId, student: { userId } }, include: accountEntryInclude,
  });
  if (!entry) throw new HttpError(404, 'Waitlist place not found');
  return accountEntryJson(entry, (await aheadCounts(prisma, [entry])).get(entry.id) ?? null);
}

type ProviderEntryRow = Prisma.WaitlistEntryGetPayload<{ include: { student: { select: { name: true } } } }>;

const providerEntryJson = (entry: ProviderEntryRow, position: number | null) => ({
  id: entry.id, studentId: entry.studentId, studentName: entry.student.name, status: entry.status,
  position: entry.status === 'WAITING' ? position : null,
  offeredAt: entry.offeredAt?.toISOString() ?? null,
  offerExpiresAt: entry.offerExpiresAt?.toISOString() ?? null,
  createdAt: entry.createdAt.toISOString(),
});

async function loadProviderEntry(entryId: string, businessId: string) {
  const entry = await prisma.waitlistEntry.findFirstOrThrow({
    where: { id: entryId, businessId }, include: { student: { select: { name: true } } },
  });
  const position = entry.status === 'WAITING'
    ? await prisma.waitlistEntry.count({
      where: { bookingId: entry.bookingId, businessId, status: 'WAITING', sequence: { lte: entry.sequence } },
    })
    : null;
  return providerEntryJson(entry, position);
}

/* ------------------------------------------------------------------------ */
/* Student routes                                                            */
/* ------------------------------------------------------------------------ */

export const waitlistAccountRouter = Router();
export const waitlistWorkspaceRouter = Router();

/** Guardians cannot queue a child; only a self-managed account acts for itself. */
const requireSelfManaged: RequestHandler = (req, _res, next) => {
  if ((req as AccountRequest).auth.user.accountControl !== 'SELF') {
    return next(new HttpError(403, 'Only a self-managed student account can use waitlists'));
  }
  next();
};

const waitlistMutationLimit = sharedRateLimit({
  name: 'waitlist-mutation',
  windowMs: 60 * 60_000, limit: 80, standardHeaders: 'draft-8', legacyHeaders: false,
  // Authentication runs first, so people sharing a network do not share a budget.
  keyGenerator: req => (req as AccountRequest).auth?.user.id ?? 'unauthenticated',
  message: { error: 'Too many waitlist requests. Please try again later.' },
});

// The router is mounted on the bare /api prefix, so guards are applied per
// route rather than with router.use, which would intercept unrelated routes.
const studentGuards = [requireAccountCapability('commerce'), requireStudent, requireSelfManaged];
const studentMutation = [...studentGuards, waitlistMutationLimit];

const waitlistJoinInput = z.object({
  serviceId: z.string().trim().min(1).max(200),
  instructorId: z.string().trim().min(1).max(200),
  locationId: z.string().trim().min(1).max(200),
  startAt: z.string().datetime({ offset: true }),
}).strict();
const acceptInput = z.object({ packageId: z.string().trim().min(1).max(200).optional() }).strict();
const emptyInput = z.object({}).strict();

function requireAccountEmail(req: WorkspaceRequest) {
  const email = req.auth.user.email;
  if (!email) throw new HttpError(403, 'An account email is required to book a class');
  return email;
}

waitlistAccountRouter.post('/public/:slug/waitlist', ...studentMutation, asyncRoute(async (req, res) => {
  const input = waitlistJoinInput.parse(req.body);
  const user = req.auth.user;
  const email = requireAccountEmail(req);
  // Historical SOLO practices stay closed to new commercial activity.
  const business = await prisma.business.findFirst({ where: { slug: req.params.slug, kind: 'CLUB', legacyReadOnly: false } });
  if (!business) throw new HttpError(404, 'Booking page not found');
  const startAt = new Date(input.startAt);
  const result = await prisma.$transaction(async tx => {
    await lockInstructors(tx, [input.instructorId]);
    const ctx = await schedulingContext(tx, business.id, input.serviceId, input.instructorId, input.locationId);
    if (ctx.service.type !== 'GROUP') throw new HttpError(400, 'Only group Classes have a waitlist');
    const booking = await tx.booking.findFirst({
      where: {
        businessId: business.id, serviceId: input.serviceId, instructorId: input.instructorId,
        locationId: input.locationId, startAt, type: 'GROUP', status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: waitlistBookingSelect,
    });
    if (!booking) throw new HttpError(404, 'Class not found');
    const existing = await tx.waitlistEntry.findFirst({
      where: { bookingId: booking.id, status: { in: [...LIVE_STATUSES] }, student: { userId: user.id } },
      select: { id: true },
    });
    if (existing) return { entryId: existing.id, created: false };
    const reason = closureReason(booking, new Date());
    if (reason) throw new HttpError(409, reason);
    if (await tx.participant.findFirst({
      where: { bookingId: booking.id, cancelledAt: null, student: { userId: user.id } }, select: { id: true },
    })) {
      throw new HttpError(409, 'You already have a place in this Class.');
    }
    // The same authoritative evaluation as booking: notice, coach and student
    // conflicts, and places net of held offers. Only "full" admits a queue.
    const slot = await evaluateSlot(tx, ctx, startAt, { studentUserIds: [user.id] });
    if (slot.available) throw new HttpError(409, 'This Class still has places. Book it directly.');
    if (slot.reason !== GROUP_FULL_REASON) throw new HttpError(409, slot.reason ?? CLOSED_UNBOOKABLE);
    const student = await resolveAccountStudent(tx, business.id, user.id, { name: user.name, email });
    const entry = await tx.waitlistEntry.create({
      data: { businessId: business.id, bookingId: booking.id, studentId: student.id },
      select: { id: true },
    });
    await recordClubMetric(tx, business.id, 'WAITLIST_JOINED', { timezone: business.timezone });
    return { entryId: entry.id, created: true };
  }, { timeout: 30_000 });
  res.status(result.created ? 201 : 200).json({ entry: await loadAccountEntry(result.entryId, user.id) });
}));

waitlistAccountRouter.get('/account/waitlist', ...studentGuards, asyncRoute(async (req, res) => {
  const entries = await prisma.waitlistEntry.findMany({
    where: {
      student: { userId: req.auth.user.id },
      OR: [
        { status: { in: [...LIVE_STATUSES] } },
        // Terminal rows never change again, so updatedAt is when they closed.
        { updatedAt: { gte: new Date(Date.now() - CLOSED_HISTORY_MS) } },
      ],
    },
    include: accountEntryInclude,
    orderBy: [{ booking: { startAt: 'asc' } }, { sequence: 'asc' }],
    take: ACCOUNT_LIST_LIMIT,
  });
  const ahead = await aheadCounts(prisma, entries);
  res.json({ entries: entries.map(entry => accountEntryJson(entry, ahead.get(entry.id) ?? null)) });
}));

/**
 * Serialize a student's decision on their own entry: the instructor lock
 * first (the same order as booking), then the entry row, then a reload so
 * exactly one concurrent accept, decline or withdrawal wins.
 */
async function lockOwnEntry(tx: Tx, entryId: string, userId: string) {
  const initial = await tx.waitlistEntry.findFirst({
    where: { id: entryId, student: { userId } }, select: { booking: { select: { instructorId: true } } },
  });
  if (!initial) throw new HttpError(404, 'Waitlist place not found');
  await lockInstructors(tx, [initial.booking.instructorId]);
  await tx.$queryRaw`SELECT "id" FROM "WaitlistEntry" WHERE "id" = ${entryId} FOR UPDATE`;
  const entry = await tx.waitlistEntry.findFirst({
    where: { id: entryId, student: { userId } }, include: { booking: { select: waitlistBookingSelect } },
  });
  if (!entry) throw new HttpError(404, 'Waitlist place not found');
  if (entry.booking.instructorId !== initial.booking.instructorId) {
    throw new HttpError(409, 'This Class changed. Please refresh and try again.');
  }
  return entry;
}

waitlistAccountRouter.post('/account/waitlist/:id/accept', ...studentMutation, asyncRoute(async (req, res) => {
  const body = acceptInput.parse(req.body ?? {});
  const user = req.auth.user;
  const email = requireAccountEmail(req);
  const outcome = await prisma.$transaction(async tx => {
    const entry = await lockOwnEntry(tx, req.params.id, user.id);
    if (entry.status === 'ACCEPTED') throw new HttpError(409, 'You have already accepted this place.');
    if (entry.status !== 'OFFERED') throw new HttpError(409, 'This place is no longer on offer.');
    const now = new Date();
    if (!entry.offerExpiresAt || entry.offerExpiresAt <= now) {
      // Commit the expiry and pass the place on before refusing, so the
      // next student is not kept waiting for the worker.
      await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'EXPIRED' } });
      await offerWaitlistPlaces(tx, entry.bookingId, { now });
      return { kind: 'EXPIRED' as const };
    }
    const reason = closureReason(entry.booking, now);
    if (reason) {
      await closeLiveWaitlistEntries(tx, entry.bookingId, reason);
      return { kind: 'CLOSED' as const, reason };
    }
    const booking = entry.booking;
    // An ordinary CLUB booking through the one booking path: conflicts,
    // package eligibility and credits, chat, Calendar and alerts all apply.
    const result = await createBookingsInTransaction(tx, booking.businessId, {
      serviceId: booking.serviceId, instructorId: booking.instructorId, locationId: booking.locationId,
      startAt: booking.startAt.toISOString(), repeatWeeks: 1, notes: '', address: '',
      ...(body.packageId ? { packageId: body.packageId } : {}),
      student: { name: user.name, email },
    }, { studentUserId: user.id, waitlistEntryId: entry.id });
    if (result.bookings.length !== 1 || result.bookings[0]!.id !== booking.id) {
      throw new HttpError(409, 'This Class changed. Please refresh and try again.');
    }
    await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'ACCEPTED', respondedAt: now } });
    await recordClubMetric(tx, booking.businessId, 'WAITLIST_ACCEPTED', { timezone: booking.business.timezone });
    return { kind: 'ACCEPTED' as const, bookings: result.bookings };
  }, { timeout: 30_000 });
  if (outcome.kind === 'EXPIRED') {
    throw new HttpError(409, 'This offer has expired and the place has passed to the next person.', { code: 'WAITLIST_OFFER_EXPIRED' });
  }
  if (outcome.kind === 'CLOSED') throw new HttpError(409, outcome.reason, { code: 'WAITLIST_CLOSED' });
  res.json({ entry: await loadAccountEntry(req.params.id, user.id), bookings: outcome.bookings });
}));

waitlistAccountRouter.post('/account/waitlist/:id/decline', ...studentMutation, asyncRoute(async (req, res) => {
  emptyInput.parse(req.body ?? {});
  const user = req.auth.user;
  await prisma.$transaction(async tx => {
    const entry = await lockOwnEntry(tx, req.params.id, user.id);
    if (entry.status === 'DECLINED') return;
    if (entry.status !== 'OFFERED') throw new HttpError(409, 'There is no open offer to decline.');
    await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'DECLINED', respondedAt: new Date() } });
    await offerWaitlistPlaces(tx, entry.bookingId);
  }, { timeout: 30_000 });
  res.json({ entry: await loadAccountEntry(req.params.id, user.id) });
}));

waitlistAccountRouter.delete('/account/waitlist/:id', ...studentMutation, asyncRoute(async (req, res) => {
  const user = req.auth.user;
  await prisma.$transaction(async tx => {
    const entry = await lockOwnEntry(tx, req.params.id, user.id);
    if (entry.status === 'WITHDRAWN') return;
    if (entry.status !== 'WAITING' && entry.status !== 'OFFERED') {
      throw new HttpError(409, 'This waitlist place has already closed.');
    }
    await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'WITHDRAWN', respondedAt: new Date() } });
    // Leaving with an offer in hand passes the held place on immediately.
    if (entry.status === 'OFFERED') await offerWaitlistPlaces(tx, entry.bookingId);
  }, { timeout: 30_000 });
  res.json({ entry: await loadAccountEntry(req.params.id, user.id) });
}));

/* ------------------------------------------------------------------------ */
/* Workspace routes                                                          */
/* ------------------------------------------------------------------------ */

waitlistWorkspaceRouter.get('/bookings/:id/waitlist', requireCoachOrClubPermission('BOOKINGS_VIEW'), asyncRoute(async (req, res) => {
  const businessId = req.auth.business.id;
  const booking = await prisma.booking.findFirst({ where: { id: req.params.id, businessId }, select: waitlistBookingSelect });
  if (!booking) throw new HttpError(404, 'Booking not found');
  coachScope(req, booking.instructorId);
  const now = new Date();
  const entries = await prisma.waitlistEntry.findMany({
    where: { bookingId: booking.id, businessId },
    include: { student: { select: { name: true } } },
    orderBy: { sequence: 'asc' },
    take: PROVIDER_LIST_LIMIT,
  });
  const placesFree = await freePlaces(prisma, booking, now);
  let position = 0;
  res.json({
    entries: entries.map(entry => providerEntryJson(entry, entry.status === 'WAITING' ? ++position : null)),
    placesFree,
    canManage: (coachScoped(req.auth) || hasClubPermission(req.auth, 'BOOKINGS_MANAGE')) && closureReason(booking, now) === null,
  });
}));

/** Tenant- and coach-scoped counterpart of lockOwnEntry for the club side. */
async function lockWorkspaceEntry(tx: Tx, req: WorkspaceRequest, entryId: string) {
  const businessId = req.auth.business.id;
  const initial = await tx.waitlistEntry.findFirst({
    where: { id: entryId, businessId }, select: { booking: { select: { instructorId: true } } },
  });
  if (!initial) throw new HttpError(404, 'Waitlist entry not found');
  coachScope(req, initial.booking.instructorId);
  await lockInstructors(tx, [initial.booking.instructorId]);
  await tx.$queryRaw`SELECT "id" FROM "WaitlistEntry" WHERE "id" = ${entryId} FOR UPDATE`;
  const entry = await tx.waitlistEntry.findFirst({
    where: { id: entryId, businessId },
    include: { booking: { select: waitlistBookingSelect }, student: { select: { userId: true } } },
  });
  if (!entry) throw new HttpError(404, 'Waitlist entry not found');
  coachScope(req, entry.booking.instructorId);
  if (entry.booking.instructorId !== initial.booking.instructorId) {
    throw new HttpError(409, 'This Class changed. Please refresh and try again.');
  }
  return entry;
}

// A manual offer may skip the queue order, but never the place count: it
// needs a place that is neither taken nor already held by another offer.
waitlistWorkspaceRouter.post('/waitlist/:id/offer', requireCoachOrClubPermission('BOOKINGS_MANAGE'), asyncRoute(async (req, res) => {
  emptyInput.parse(req.body ?? {});
  await prisma.$transaction(async tx => {
    const entry = await lockWorkspaceEntry(tx, req, req.params.id);
    if (entry.status !== 'WAITING') throw new HttpError(409, 'Only a waiting student can be offered a place.');
    const now = new Date();
    await expireStaleOffers(tx, entry.bookingId, now);
    const reason = closureReason(entry.booking, now)
      ?? (await stillBookable(tx, entry.booking) ? null : CLOSED_UNBOOKABLE);
    if (reason) throw new HttpError(409, reason);
    if (await freePlaces(tx, entry.booking, now) <= 0) {
      throw new HttpError(409, 'No place is free to offer. A place opens when a student cancels or an offer ends.');
    }
    const deadline = offerDeadline(entry.booking, now);
    if (deadline.getTime() - now.getTime() < MIN_OFFER_MS) throw new HttpError(409, CLOSED_NO_TIME);
    if (!await makeOffer(tx, entry, entry.booking, now, deadline)) {
      throw new HttpError(409, 'Only a waiting student can be offered a place.');
    }
  }, { timeout: 30_000 });
  res.json({ entry: await loadProviderEntry(req.params.id, req.auth.business.id) });
}));

waitlistWorkspaceRouter.delete('/waitlist/:id', requireCoachOrClubPermission('BOOKINGS_MANAGE'), asyncRoute(async (req, res) => {
  await prisma.$transaction(async tx => {
    const entry = await lockWorkspaceEntry(tx, req, req.params.id);
    if (entry.status === 'REMOVED') return;
    if (entry.status !== 'WAITING' && entry.status !== 'OFFERED') {
      throw new HttpError(409, 'This waitlist entry has already closed.');
    }
    const reason = 'The club removed you from the waitlist.';
    await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'REMOVED', closedReason: reason } });
    if (entry.student.userId) {
      await createAccountAlert(tx, {
        kind: 'WAITLIST_CLOSED', userId: entry.student.userId, businessId: entry.businessId, bookingId: entry.bookingId,
        serviceName: entry.booking.service.name, startAt: entry.booking.startAt,
        timezone: entry.booking.business.timezone, reason,
      });
    }
    if (entry.status === 'OFFERED') await offerWaitlistPlaces(tx, entry.bookingId);
  }, { timeout: 30_000 });
  res.json({ entry: await loadProviderEntry(req.params.id, req.auth.business.id) });
}));
