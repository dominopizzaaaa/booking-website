import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { adminOnly, asyncRoute, HttpError } from './http.js';
import { notifyWorkspace } from './notifications.js';

type Tx = Prisma.TransactionClient;

/**
 * The club safeguard.
 *
 * A club invests in introducing a coach to a student. If the two later book
 * privately on Courtly — outside the club, with the money going straight from
 * student to coach — the club is cut out of a relationship it created. Courtly
 * does not block that booking: people move on for legitimate reasons, and an
 * automated refusal would be wrong as often as it was right. Instead the club
 * is told, once per pair, with enough detail to look into it.
 *
 * Detection is deliberately conservative: it fires only when the *same*
 * account-backed coach and the *same* account-backed student share a prior
 * lesson that ran through a club (paymentRoute CLUB), and then share a lesson
 * outside that club that does not (paymentRoute DIRECT).
 */
export async function flagPrivateSessionsAfterClub(
  tx: Tx,
  bookingId: string,
) {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, businessId: true, startAt: true, paymentRoute: true,
      business: { select: { name: true } },
      service: { select: { name: true } },
      instructor: { select: { id: true, name: true, membership: { select: { userId: true } } } },
      participants: {
        where: { cancelledAt: null },
        select: { customer: { select: { userId: true, name: true } } },
      },
    },
  });
  // Only a lesson paid straight to the coach can bypass a club.
  if (!booking || booking.paymentRoute !== 'DIRECT') return 0;

  const coachUserId = booking.instructor.membership?.userId;
  if (!coachUserId) return 0;
  const students = booking.participants
    .map(participant => participant.customer)
    .filter((customer): customer is { userId: string; name: string } => typeof customer.userId === 'string');
  if (!students.length) return 0;

  let flagged = 0;
  for (const student of students) {
    // Every club where this exact coach account taught this exact student
    // account through the club's own books, before now.
    const clubHistory = await tx.booking.findMany({
      where: {
        id: { not: booking.id },
        businessId: { not: booking.businessId },
        paymentRoute: 'CLUB',
        status: { not: 'CANCELLED' },
        instructor: { membership: { is: { userId: coachUserId } } },
        participants: { some: { cancelledAt: null, customer: { userId: student.userId } } },
      },
      select: {
        businessId: true, startAt: true,
        instructor: { select: { id: true, name: true } },
        business: { select: { name: true } },
      },
      orderBy: { startAt: 'asc' },
    });
    if (!clubHistory.length) continue;

    // Name the coach the way this club knows them: the roster name on the
    // club's own books, not whatever they call themselves elsewhere.
    const byClub = new Map<string, { instructorId: string; coachName: string; name: string; first: Date; sessions: number }>();
    for (const past of clubHistory) {
      const existing = byClub.get(past.businessId);
      if (existing) existing.sessions += 1;
      else byClub.set(past.businessId, {
        instructorId: past.instructor.id, coachName: past.instructor.name,
        name: past.business.name, first: past.startAt, sessions: 1,
      });
    }

    for (const [clubBusinessId, club] of byClub) {
      const detail = `${club.coachName} and ${student.name} have ${club.sessions} session${club.sessions === 1 ? '' : 's'} together booked through ${club.name}. They now also have a private session (${booking.service.name}) booked outside the club at ${booking.business.name}, paid directly to the coach.`;
      // One flag per coach/student pair per club. A repeat private booking
      // raises the count instead of burying the club in duplicates.
      const existing = await tx.integrityFlag.findUnique({
        where: {
          businessId_coachUserId_customerUserId_type: {
            businessId: clubBusinessId, coachUserId, customerUserId: student.userId,
            type: 'PRIVATE_SESSION_AFTER_CLUB',
          },
        },
        select: { id: true, status: true, occurrences: true },
      });
      if (existing) {
        await tx.integrityFlag.update({
          where: { id: existing.id },
          data: {
            occurrences: existing.occurrences + 1,
            lastSeenAt: new Date(),
            bookingId: booking.id,
            outsideBusinessId: booking.businessId,
            outsideBusinessName: booking.business.name,
            detail,
            // A dismissed flag stays dismissed; the club already ruled on it.
            ...(existing.status === 'DISMISSED' ? {} : { status: 'OPEN' }),
          },
        });
        continue;
      }
      await tx.integrityFlag.create({
        data: {
          businessId: clubBusinessId,
          instructorId: club.instructorId,
          coachUserId,
          customerUserId: student.userId,
          coachName: club.coachName,
          customerName: student.name,
          bookingId: booking.id,
          outsideBusinessId: booking.businessId,
          outsideBusinessName: booking.business.name,
          detail,
        },
      });
      await notifyWorkspace(tx, {
        businessId: clubBusinessId,
        instructorId: club.instructorId,
        type: 'INTEGRITY',
        title: 'Private session flagged for review',
        message: `${club.coachName} and ${student.name}, who train together through your club, now have a private session booked outside it. Open Integrity to review.`,
        actionNeeded: true,
      });
      flagged += 1;
    }
  }
  return flagged;
}

const flagInclude = {
  booking: { select: { startAt: true, service: { select: { name: true } } } },
} satisfies Prisma.IntegrityFlagInclude;

type FullIntegrityFlag = Prisma.IntegrityFlagGetPayload<{ include: typeof flagInclude }>;

export const integrityFlagJson = (flag: FullIntegrityFlag) => ({
  id: flag.id,
  instructorId: flag.instructorId,
  coachName: flag.coachName,
  customerName: flag.customerName,
  type: flag.type,
  status: flag.status,
  detail: flag.detail,
  occurrences: flag.occurrences,
  outsideBusinessName: flag.outsideBusinessName,
  firstSeenAt: flag.firstSeenAt.toISOString(),
  lastSeenAt: flag.lastSeenAt.toISOString(),
  resolvedAt: flag.resolvedAt?.toISOString() ?? null,
  resolutionNote: flag.resolutionNote,
  flaggedSessionAt: flag.booking?.startAt.toISOString() ?? null,
  flaggedServiceName: flag.booking?.service.name ?? null,
});

export const integrityFlagInclude = flagInclude;

// --- Review API -----------------------------------------------------------

export const integrityRouter = Router();

const resolutionInput = z.object({
  status: z.enum(['OPEN', 'REVIEWING', 'DISMISSED', 'UPHELD']),
  note: z.string().trim().max(1000).default(''),
}).strict();

integrityRouter.get('/integrity-flags', adminOnly, asyncRoute(async (req, res) => {
  const flags = await prisma.integrityFlag.findMany({
    where: { businessId: req.auth.business.id },
    include: flagInclude,
    orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
    take: 200,
  });
  res.json({ flags: flags.map(integrityFlagJson) });
}));

integrityRouter.patch('/integrity-flags/:id', adminOnly, asyncRoute(async (req, res) => {
  const input = resolutionInput.parse(req.body);
  const flag = await prisma.integrityFlag.findFirst({
    where: { id: req.params.id, businessId: req.auth.business.id },
    select: { id: true },
  });
  if (!flag) throw new HttpError(404, 'Flag not found');
  const resolved = input.status === 'DISMISSED' || input.status === 'UPHELD';
  const updated = await prisma.integrityFlag.update({
    where: { id: flag.id },
    data: {
      status: input.status,
      resolutionNote: input.note,
      resolvedAt: resolved ? new Date() : null,
      resolvedByUserId: resolved ? req.auth.user.id : null,
    },
    include: flagInclude,
  });
  res.json(integrityFlagJson(updated));
}));
