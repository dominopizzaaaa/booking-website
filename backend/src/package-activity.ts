import { Router } from 'express';
import { Prisma, type PackageCreditEvent } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { requireStudent } from './auth.js';
import { asyncRoute, HttpError, requireAccountCapability, requireClubPermission } from './http.js';
import { createAccountAlert } from './account-notifications.js';

type Tx = Prisma.TransactionClient;

// The account router is mounted on the bare /api prefix right after
// authentication, so every route carries its own capability and role guard.
export const packageActivityAccountRouter = Router();
export const packageActivityWorkspaceRouter = Router();

const packageId = z.string().trim().min(1).max(200);
// Activity is bounded per response. A package holds at most a few hundred
// credits, so this keeps every realistic history while refusing to stream an
// arbitrarily long ledger in one request.
const activityLimit = 1000;

const activityPackageSelect = {
  id: true, businessId: true, name: true, totalCredits: true, usedCredits: true, expiresAt: true,
  business: { select: { name: true, slug: true, currency: true, timezone: true } },
} satisfies Prisma.LessonPackageSelect;
type ActivityPackage = Prisma.LessonPackageGetPayload<{ select: typeof activityPackageSelect }>;

type SessionDetails = { serviceName: string; startAt: string; timezone: string };

function creditEventJson(event: PackageCreditEvent, session: SessionDetails | null) {
  return {
    id: event.id,
    kind: event.kind,
    delta: event.delta,
    balanceAfter: event.totalAfter - event.usedAfter,
    totalAfter: event.totalAfter,
    note: event.note,
    createdAt: event.createdAt.toISOString(),
    bookingId: event.bookingId,
    reservationId: event.reservationId,
    session,
  };
}

/**
 * Both the learner and the club read the same projection of the ledger. The
 * trigger-written rows are authoritative; the only derived entry is the final
 * EXPIRED line, which records that unused credits lapsed without pretending a
 * database write happened at the expiry instant.
 */
async function packageActivity(pkg: ActivityPackage, now = new Date()) {
  const newest = await prisma.packageCreditEvent.findMany({
    where: { packageId: pkg.id, businessId: pkg.businessId },
    orderBy: { sequence: 'desc' },
    take: activityLimit,
  });
  const events = newest.reverse();
  const bookingIds = [...new Set(events.map(event => event.bookingId).filter((id): id is string => !!id))];
  // A ledger label is plain text written inside the club's own transaction,
  // but the session lookup still pins the booking to this package's business.
  const bookings = bookingIds.length
    ? await prisma.booking.findMany({
      where: { id: { in: bookingIds }, businessId: pkg.businessId },
      select: { id: true, startAt: true, service: { select: { name: true } } },
    })
    : [];
  const sessions = new Map(bookings.map(booking => [booking.id, {
    serviceName: booking.service.name, startAt: booking.startAt.toISOString(), timezone: pkg.business.timezone,
  }]));
  const remainingCredits = Math.max(0, pkg.totalCredits - pkg.usedCredits);
  const json = events.map(event => creditEventJson(event, event.bookingId ? sessions.get(event.bookingId) ?? null : null));
  if (pkg.expiresAt < now && remainingCredits > 0) {
    json.push({
      id: `expiry:${pkg.id}`, kind: 'EXPIRED', delta: -remainingCredits, balanceAfter: 0,
      totalAfter: pkg.totalCredits, note: `${remainingCredits} unused credit${remainingCredits === 1 ? '' : 's'} expired`,
      createdAt: pkg.expiresAt.toISOString(), bookingId: null, reservationId: null, session: null,
    });
  }
  return {
    package: {
      id: pkg.id, name: pkg.name, totalCredits: pkg.totalCredits, usedCredits: pkg.usedCredits,
      remainingCredits, expiresAt: pkg.expiresAt.toISOString(),
      business: { name: pkg.business.name, slug: pkg.business.slug, currency: pkg.business.currency },
    },
    events: json,
  };
}

packageActivityAccountRouter.get(
  '/account/packages/:id/activity',
  requireAccountCapability('commerce'),
  requireStudent,
  asyncRoute(async (req, res) => {
    const id = packageId.parse(req.params.id);
    // Ownership is the learner's linked club record. Another learner's or an
    // unlinked package answers exactly like a package that does not exist.
    const pkg = await prisma.lessonPackage.findFirst({
      where: { id, student: { userId: req.auth.user.id } }, select: activityPackageSelect,
    });
    if (!pkg) throw new HttpError(404, 'Package not found');
    res.json(await packageActivity(pkg));
  }),
);

packageActivityWorkspaceRouter.get('/packages/:id/activity', requireClubPermission('PACKAGES_VIEW'), asyncRoute(async (req, res) => {
  const id = packageId.parse(req.params.id);
  const pkg = await prisma.lessonPackage.findFirst({
    where: { id, businessId: req.auth.business.id }, select: activityPackageSelect,
  });
  if (!pkg) throw new HttpError(404, 'Package not found');
  res.json(await packageActivity(pkg));
}));

/* ------------------------------------------------------------------------ */
/* Low-balance and expiry reminders                                          */
/* ------------------------------------------------------------------------ */

type PackageAlertKind = 'PACKAGE_LOW' | 'PACKAGE_EXPIRING';
const expiringWindowMs = 14 * 86_400_000;
const defaultBatchSize = 200;

const reminderPackageSelect = {
  id: true, businessId: true, name: true, totalCredits: true, usedCredits: true, expiresAt: true, paid: true,
  business: { select: { kind: true, legacyReadOnly: true, timezone: true } },
  student: { select: { user: { select: { id: true, accountType: true, accountControl: true, accountStatus: true } } } },
} satisfies Prisma.LessonPackageSelect;
type ReminderPackage = Prisma.LessonPackageGetPayload<{ select: typeof reminderPackageSelect }>;

/** The one definition of when each reminder is due, rechecked under the lock. */
function reminderDue(kind: PackageAlertKind, pkg: ReminderPackage, now: Date) {
  const learner = pkg.student.user;
  // Only a self-managed, active learner receives package nudges. A guardian-
  // managed child has no direct inbox, and legacy practices cannot sell or
  // redeem new sessions, so a reminder there would point nowhere.
  if (!learner || learner.accountType !== 'STUDENT' || learner.accountControl !== 'SELF' || learner.accountStatus !== 'ACTIVE') return false;
  if (pkg.business.kind !== 'CLUB' || pkg.business.legacyReadOnly) return false;
  if (!pkg.paid || pkg.expiresAt <= now) return false;
  const remaining = pkg.totalCredits - pkg.usedCredits;
  if (kind === 'PACKAGE_LOW') return pkg.usedCredits > 0 && remaining <= 1;
  return remaining > 0 && pkg.expiresAt.getTime() <= now.getTime() + expiringWindowMs;
}

async function dueCandidates(kind: PackageAlertKind, now: Date, limit: number, businessIds?: string[]) {
  // Production sweeps every club; tests narrow the sweep to the businesses
  // they own so a shared database never receives cross-tenant writes.
  const scope = businessIds
    ? Prisma.sql`AND package."businessId" IN (${Prisma.join(businessIds.length ? businessIds : [''])})`
    : Prisma.empty;
  // Package timestamps are stored as UTC wall-clock values. Convert the bound
  // instants explicitly so the comparison ignores the session time zone.
  const condition = kind === 'PACKAGE_LOW'
    ? Prisma.sql`package."usedCredits" > 0 AND package."totalCredits" - package."usedCredits" <= 1`
    : Prisma.sql`package."totalCredits" - package."usedCredits" > 0
      AND package."expiresAt" <= (${new Date(now.getTime() + expiringWindowMs)}::timestamptz AT TIME ZONE 'UTC')`;
  return prisma.$queryRaw<Array<{ id: string }>>`
    SELECT package."id"
    FROM "LessonPackage" AS package
    JOIN "Business" AS business ON business."id" = package."businessId"
    JOIN "Student" AS student ON student."id" = package."studentId"
    JOIN "User" AS learner ON learner."id" = student."userId"
    WHERE package."paid" = true
      AND package."expiresAt" > (${now}::timestamptz AT TIME ZONE 'UTC')
      AND ${condition}
      AND business."kind" = 'CLUB' AND business."legacyReadOnly" = false
      AND learner."accountType" = 'STUDENT' AND learner."accountControl" = 'SELF' AND learner."accountStatus" = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM "AccountNotification" AS alert
        WHERE alert."packageId" = package."id" AND alert."type" = ${kind}
      )
      ${scope}
    ORDER BY package."expiresAt" ASC, package."id" ASC
    LIMIT ${limit}`;
}

async function remindPackage(tx: Tx, kind: PackageAlertKind, id: string, now: Date) {
  // Several API replicas may select the same candidate. The per-package lock
  // serializes them, and the dedupe read after waiting sees the winner's row.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`package-alert:${kind}:${id}`}, 0))`;
  if (await tx.accountNotification.findFirst({ where: { packageId: id, type: kind }, select: { id: true } })) return false;
  const pkg = await tx.lessonPackage.findUnique({ where: { id }, select: reminderPackageSelect });
  if (!pkg || !reminderDue(kind, pkg, now)) return false;
  const userId = pkg.student.user!.id;
  const remaining = pkg.totalCredits - pkg.usedCredits;
  if (kind === 'PACKAGE_LOW') {
    await createAccountAlert(tx, {
      kind, userId, businessId: pkg.businessId, packageId: pkg.id, packageName: pkg.name, remaining,
    });
  } else {
    await createAccountAlert(tx, {
      kind, userId, businessId: pkg.businessId, packageId: pkg.id, packageName: pkg.name, remaining,
      expiresAt: pkg.expiresAt, timezone: pkg.business.timezone,
    });
  }
  return true;
}

/**
 * One bounded sweep. Each reminder is sent at most once per package and type,
 * deduplicated by AccountNotification.packageId + type, so a later restore and
 * re-use never repeats it. Returns how many alerts this call created.
 */
export async function sendPackageAlerts(options: { now?: Date; businessIds?: string[]; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? defaultBatchSize;
  const sent: Record<PackageAlertKind, number> = { PACKAGE_LOW: 0, PACKAGE_EXPIRING: 0 };
  for (const kind of ['PACKAGE_LOW', 'PACKAGE_EXPIRING'] as const) {
    for (const { id } of await dueCandidates(kind, now, limit, options.businessIds)) {
      try {
        if (await prisma.$transaction(tx => remindPackage(tx, kind, id, now), { timeout: 15_000 })) sent[kind] += 1;
      } catch (error) {
        // One unexpected package must not stop the rest of the batch.
        console.error('Package reminder failed', error);
      }
    }
  }
  return { low: sent.PACKAGE_LOW, expiring: sent.PACKAGE_EXPIRING };
}

export function startPackageAlertWorker(intervalMs = 15 * 60_000): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await sendPackageAlerts(); }
    catch (error) { console.error('Package reminder tick failed', error); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
