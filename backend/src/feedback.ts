import { Router } from 'express';
import type { Prisma, SessionFeedback } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { prisma } from './db.js';
import {
  asyncRoute, coachScope, coachScoped, hasClubPermission, HttpError, requireCoachOrClubPermission,
  type AuthContext,
} from './http.js';
import { requireStudent } from './auth.js';
import { assertWritableClubBooking, lockInstructors } from './scheduling.js';
import { createAccountAlert } from './account-notifications.js';
import { hasCurrentLinkConsent } from './family.js';

type Tx = Prisma.TransactionClient;

// Provider routes run inside the workspace chain. The learner routes are
// mounted on the bare /api prefix, so each one carries its own guard.
export const feedbackRouter = Router();
export const progressRouter = Router();

/** Streaks and the monthly chart follow the platform's home calendar. */
const PROGRESS_ZONE = 'Asia/Singapore';
const ATTENDED = ['PRESENT', 'LATE'] as const;
const FEEDBACK_PAGE = 50;

const isAttended = (attendance: string) => (ATTENDED as readonly string[]).includes(attendance);

const feedbackInput = z.object({
  visibility: z.enum(['SHARED', 'PRIVATE']),
  summary: z.string().trim().max(2000).optional(),
  strengths: z.string().trim().max(600).optional(),
  focusAreas: z.string().trim().max(600).optional(),
  nextGoal: z.string().trim().max(300).optional(),
  clubNote: z.string().trim().max(1000).optional(),
}).strict();

type FeedbackBooking = {
  status: string; coachAcceptance: string; startAt: Date; paymentRoute: string;
  business: { kind: string; legacyReadOnly: boolean };
};

/**
 * Feedback describes a lesson that actually took place. It opens with the
 * court-side roll call (once the lesson has started) and never on a lesson the
 * coach has not yet agreed to teach or one that is no longer happening.
 */
function feedbackBlocker(booking: FeedbackBooking, now = Date.now()): HttpError | null {
  try {
    assertWritableClubBooking(booking);
  } catch (error) {
    return error as HttpError;
  }
  if (!['CONFIRMED', 'COMPLETED'].includes(booking.status) || booking.coachAcceptance === 'PENDING') {
    return new HttpError(400, 'Feedback can only be written for a confirmed or completed lesson');
  }
  if (booking.startAt.getTime() > now) {
    return new HttpError(400, 'Feedback can only be written once the lesson has started');
  }
  return null;
}

const mayWriteFeedback = (auth: AuthContext) => coachScoped(auth) || hasClubPermission(auth, 'BOOKINGS_MANAGE');

/** The first writer is snapshotted, so a later roster or staff change cannot rewrite who authored it. */
function feedbackActor(auth: AuthContext & { business: { name: string } }) {
  const role = auth.staffAccess ? 'STAFF' as const
    : coachScoped(auth) ? 'COACH' as const
      : 'CLUB' as const;
  // The institutional account is the club itself; a person writes under their own name.
  const name = (role === 'CLUB' ? auth.business.name : auth.user.name).trim().slice(0, 160);
  return { role, name: name || auth.business.name.slice(0, 160) || 'Club' };
}

type ProviderParticipant = { id: string; studentId: string; student: { name: string } };

function providerFeedbackJson(feedback: SessionFeedback, participant: ProviderParticipant) {
  return {
    id: feedback.id,
    bookingId: feedback.bookingId,
    participantId: participant.id,
    studentId: participant.studentId,
    studentName: participant.student.name,
    authorName: feedback.authorName,
    authorRole: feedback.authorRole,
    editedByName: feedback.editedByName,
    visibility: feedback.visibility,
    summary: feedback.summary,
    strengths: feedback.strengths,
    focusAreas: feedback.focusAreas,
    nextGoal: feedback.nextGoal,
    clubNote: feedback.clubNote,
    sharedAt: feedback.sharedAt?.toISOString() ?? null,
    editedAt: feedback.editedAt?.toISOString() ?? null,
    viewedAt: feedback.firstViewedAt?.toISOString() ?? null,
    createdAt: feedback.createdAt.toISOString(),
  };
}

/**
 * Who is told that feedback was shared. A self-managed learner reads it
 * directly. A managed child has no login, so each guardian who could book for
 * the child — an ACTIVE link with BOOKINGS_MANAGE and current consent on that
 * same link — is told instead, naming the child.
 */
async function feedbackRecipients(
  tx: Tx, learnerUserId: string | null,
): Promise<Array<{ userId: string; subjectName?: string }>> {
  if (!learnerUserId) return [];
  const learner = await tx.user.findUnique({
    where: { id: learnerUserId },
    select: { id: true, name: true, accountType: true, accountControl: true, accountStatus: true },
  });
  if (!learner || learner.accountType !== 'STUDENT') return [];
  if (learner.accountControl === 'SELF') return [{ userId: learner.id }];
  if (learner.accountControl !== 'GUARDIAN_MANAGED' || learner.accountStatus !== 'ACTIVE') return [];
  const links = await tx.guardianChildLink.findMany({
    where: { childUserId: learner.id, status: 'ACTIVE', permissions: { has: 'BOOKINGS_MANAGE' } },
    select: { id: true, guardianUserId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const recipients: Array<{ userId: string; subjectName?: string }> = [];
  for (const link of links) {
    if (await hasCurrentLinkConsent(tx, link.id)) {
      recipients.push({ userId: link.guardianUserId, subjectName: learner.name });
    }
  }
  return recipients;
}

feedbackRouter.get('/bookings/:id/feedback', requireCoachOrClubPermission('BOOKINGS_VIEW'), asyncRoute(async (req, res) => {
  const booking = await prisma.booking.findFirst({
    where: { id: req.params.id, businessId: req.auth.business.id },
    include: { business: { select: { kind: true, legacyReadOnly: true } } },
  });
  if (!booking) throw new HttpError(404, 'Booking not found');
  coachScope(req, booking.instructorId);
  const participants = await prisma.participant.findMany({
    where: { bookingId: booking.id, cancelledAt: null, booking: { businessId: req.auth.business.id } },
    include: { student: { select: { name: true } }, feedback: true },
    orderBy: [{ student: { name: 'asc' } }, { id: 'asc' }],
  });
  res.json({
    feedback: participants.flatMap(participant => participant.feedback
      ? [providerFeedbackJson(participant.feedback, participant)]
      : []),
    canWrite: mayWriteFeedback(req.auth) && !feedbackBlocker(booking),
  });
}));

feedbackRouter.put('/bookings/:id/participants/:participantId/feedback', requireCoachOrClubPermission('BOOKINGS_MANAGE'), asyncRoute(async (req, res) => {
  const input = feedbackInput.parse(req.body);
  const businessId = req.auth.business.id;
  const actor = feedbackActor(req.auth);
  const result = await prisma.$transaction(async tx => {
    const initial = await tx.booking.findFirst({ where: { id: req.params.id, businessId }, select: { id: true, instructorId: true } });
    if (!initial) throw new HttpError(404, 'Booking not found');
    coachScope(req, initial.instructorId);
    // Attendance, cancellation and acceptance all change under this lock, so
    // the write rules and the first-share decision use settled state.
    await lockInstructors(tx, [initial.instructorId]);
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: initial.id },
      include: {
        business: { select: { kind: true, legacyReadOnly: true, timezone: true, name: true } },
        service: { select: { name: true } },
        instructor: { select: { name: true } },
      },
    });
    coachScope(req, booking.instructorId);
    if (booking.instructorId !== initial.instructorId) throw new HttpError(409, 'Session changed. Please retry.');
    const blocker = feedbackBlocker(booking);
    if (blocker) throw blocker;
    const participant = await tx.participant.findFirst({
      where: { id: req.params.participantId, bookingId: booking.id, cancelledAt: null },
      include: { student: { select: { name: true, userId: true } }, feedback: true },
    });
    if (!participant) throw new HttpError(404, 'Participant not found');
    if (!isAttended(participant.attendance)) {
      throw new HttpError(400, 'Mark this learner present or late before writing feedback');
    }

    const existing = participant.feedback;
    const values = {
      summary: input.summary ?? existing?.summary ?? '',
      strengths: input.strengths ?? existing?.strengths ?? '',
      focusAreas: input.focusAreas ?? existing?.focusAreas ?? '',
      nextGoal: input.nextGoal ?? existing?.nextGoal ?? '',
      clubNote: input.clubNote ?? existing?.clubNote ?? '',
    };
    if (input.visibility === 'SHARED'
      && ![values.summary, values.strengths, values.focusAreas, values.nextGoal].some(Boolean)) {
      throw new HttpError(400, 'Add a summary, strengths, focus areas or a next goal before sharing feedback');
    }
    const now = new Date();
    // sharedAt is the immutable first-share instant; un-sharing and sharing
    // again neither moves it nor alerts the learner a second time.
    const firstShare = input.visibility === 'SHARED' && !existing?.sharedAt;
    const saved = existing
      ? await tx.sessionFeedback.update({
        where: { id: existing.id },
        data: {
          ...values, visibility: input.visibility, editedAt: now, editedByName: actor.name,
          ...(firstShare ? { sharedAt: now } : {}),
        },
      })
      : await tx.sessionFeedback.create({
        data: {
          businessId, bookingId: booking.id, participantId: participant.id,
          authorUserId: req.auth.user.id, authorName: actor.name, authorRole: actor.role,
          visibility: input.visibility, ...values, sharedAt: firstShare ? now : null,
        },
      });
    if (firstShare) {
      const coachName = actor.role === 'COACH' ? booking.instructor.name : booking.business.name;
      for (const recipient of await feedbackRecipients(tx, participant.student.userId)) {
        await createAccountAlert(tx, {
          kind: 'FEEDBACK_SHARED', userId: recipient.userId, businessId, bookingId: booking.id,
          coachName, serviceName: booking.service.name, startAt: booking.startAt,
          timezone: booking.business.timezone,
          ...(recipient.subjectName ? { subjectName: recipient.subjectName } : {}),
        });
      }
    }
    return providerFeedbackJson(saved, participant);
  }, { timeout: 30_000 });
  res.json(result);
}));

/* ------------------------------------------------------------------------ */
/* Learner progress                                                          */
/* ------------------------------------------------------------------------ */

export type ProgressFilters = { businessSlug?: string; coach?: string; sport?: string };

export const progressFiltersQuery = z.object({
  businessSlug: z.string().trim().min(1).max(200).optional(),
  coach: z.string().trim().min(1).max(160).optional(),
  sport: z.string().trim().min(1).max(80).optional(),
}).strict();

const sameText = (left: string, right: string) => left.toLocaleLowerCase('en') === right.toLocaleLowerCase('en');

/** Case-insensitive de-duplication that keeps the first display spelling. */
function distinctText(values: string[]) {
  const seen = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase('en');
    if (trimmed && !seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

const feedbackBookingWhere = (filters: ProgressFilters): Prisma.BookingWhereInput => ({
  status: { not: 'CANCELLED' },
  ...(filters.businessSlug ? { business: { slug: filters.businessSlug } } : {}),
  ...(filters.coach ? { instructor: { name: { equals: filters.coach, mode: 'insensitive' } } } : {}),
  ...(filters.sport ? { service: { category: { equals: filters.sport, mode: 'insensitive' } } } : {}),
});

const learnerFeedbackInclude = {
  booking: {
    select: {
      startAt: true,
      business: { select: { name: true, slug: true, timezone: true } },
      service: { select: { name: true, category: true } },
      instructor: { select: { name: true } },
    },
  },
} satisfies Prisma.SessionFeedbackInclude;

type LearnerFeedbackRow = Prisma.SessionFeedbackGetPayload<{ include: typeof learnerFeedbackInclude }>;

/** The learner and guardian view: shared text only, never the internal club note or staff names. */
function learnerFeedbackJson(feedback: LearnerFeedbackRow) {
  return {
    id: feedback.id,
    bookingId: feedback.bookingId,
    participantId: feedback.participantId,
    business: { name: feedback.booking.business.name, slug: feedback.booking.business.slug },
    serviceName: feedback.booking.service.name,
    sport: feedback.booking.service.category,
    coachName: feedback.booking.instructor.name,
    authorRole: feedback.authorRole,
    sessionStartAt: feedback.booking.startAt.toISOString(),
    timezone: feedback.booking.business.timezone,
    summary: feedback.summary,
    strengths: feedback.strengths,
    focusAreas: feedback.focusAreas,
    nextGoal: feedback.nextGoal,
    // Learner reads are restricted to SHARED rows, which SQL requires to have sharedAt.
    sharedAt: feedback.sharedAt!.toISOString(),
    editedAt: feedback.editedAt?.toISOString() ?? null,
    viewed: feedback.firstViewedAt !== null,
  };
}

const weekStart = (value: Date) => DateTime.fromJSDate(value, { zone: PROGRESS_ZONE }).startOf('week').toISODate()!;

/** Consecutive ISO weeks with at least one attended session. */
function streaks(attendedStarts: Date[], now: Date) {
  const weeks = new Set(attendedStarts.map(weekStart));
  const thisWeek = DateTime.fromJSDate(now, { zone: PROGRESS_ZONE }).startOf('week');
  // A streak is still alive during a week that has no session yet, so it may
  // end either this week or last week.
  let cursor = weeks.has(thisWeek.toISODate()!) ? thisWeek : thisWeek.minus({ weeks: 1 });
  let current = 0;
  while (weeks.has(cursor.toISODate()!)) {
    current += 1;
    cursor = cursor.minus({ weeks: 1 });
  }
  let longest = 0;
  let run = 0;
  let previous: DateTime | null = null;
  for (const week of [...weeks].sort()) {
    const start = DateTime.fromISO(week, { zone: PROGRESS_ZONE });
    run = previous && previous.plus({ weeks: 1 }).toISODate() === week ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = start;
  }
  return { current, longest };
}

/**
 * Build one learner's progress from their own places across every club. Used
 * by the learner route and, for a managed child, by the guardian projection;
 * the caller is responsible for authorizing access to `userId`.
 */
export async function buildProgressSummary(userId: string, filters: ProgressFilters = {}, now = new Date()) {
  const places = await prisma.participant.findMany({
    where: { cancelledAt: null, student: { userId }, booking: { status: { not: 'CANCELLED' } } },
    select: {
      attendance: true,
      booking: {
        select: {
          startAt: true, endAt: true,
          business: { select: { id: true, name: true, slug: true } },
          service: { select: { category: true } },
          instructor: { select: { id: true, name: true, membership: { select: { userId: true } } } },
        },
      },
    },
  });
  const matches = (place: typeof places[number]) =>
    (!filters.businessSlug || place.booking.business.slug === filters.businessSlug)
    && (!filters.coach || sameText(place.booking.instructor.name, filters.coach))
    && (!filters.sport || sameText(place.booking.service.category, filters.sport));

  const booked = places.filter(matches);
  const attended = booked.filter(place => isAttended(place.attendance));
  const absent = booked.filter(place => place.attendance === 'ABSENT').length;
  const minutes = attended.reduce((total, place) =>
    total + Math.max(0, place.booking.endAt.getTime() - place.booking.startAt.getTime()) / 60_000, 0);
  const lastAttended = attended.reduce<Date | null>((latest, place) =>
    !latest || place.booking.startAt > latest ? place.booking.startAt : latest, null);
  const streak = streaks(attended.map(place => place.booking.startAt), now);

  const thisMonth = DateTime.fromJSDate(now, { zone: PROGRESS_ZONE }).startOf('month');
  const monthKey = (value: Date) => DateTime.fromJSDate(value, { zone: PROGRESS_ZONE }).toFormat('yyyy-MM');
  const attendedByMonth = new Map<string, number>();
  for (const place of attended) {
    const key = monthKey(place.booking.startAt);
    attendedByMonth.set(key, (attendedByMonth.get(key) ?? 0) + 1);
  }
  const monthly = Array.from({ length: 6 }, (_, index) => {
    const month = thisMonth.minus({ months: 5 - index }).toFormat('yyyy-MM');
    return { month, attended: attendedByMonth.get(month) ?? 0 };
  });

  const feedbackWhere: Prisma.SessionFeedbackWhereInput = {
    visibility: 'SHARED',
    participant: { cancelledAt: null, student: { userId } },
    booking: feedbackBookingWhere(filters),
  };
  const [feedback, goal] = await Promise.all([
    prisma.sessionFeedback.findMany({
      where: feedbackWhere, include: learnerFeedbackInclude,
      orderBy: [{ sharedAt: 'desc' }, { id: 'desc' }], take: FEEDBACK_PAGE,
    }),
    // A later note without a goal does not erase the goal the learner is working towards.
    prisma.sessionFeedback.findFirst({
      where: { ...feedbackWhere, nextGoal: { not: '' } }, include: learnerFeedbackInclude,
      orderBy: [{ sharedAt: 'desc' }, { id: 'desc' }],
    }),
  ]);

  const clubs = new Map<string, { slug: string; name: string }>();
  for (const place of places) {
    clubs.set(place.booking.business.slug, { slug: place.booking.business.slug, name: place.booking.business.name });
  }
  return {
    stats: {
      attended: attended.length,
      booked: booked.length,
      upcoming: booked.filter(place => place.booking.startAt.getTime() > now.getTime()).length,
      hoursOnCourt: Math.round((minutes / 60) * 10) / 10,
      currentStreakWeeks: streak.current,
      longestStreakWeeks: streak.longest,
      clubs: new Set(attended.map(place => place.booking.business.id)).size,
      // A portable coach is one person across clubs; historical unlinked roster rows count separately.
      coaches: new Set(attended.map(place =>
        place.booking.instructor.membership?.userId ?? `instructor:${place.booking.instructor.id}`)).size,
      lastAttendedAt: lastAttended?.toISOString() ?? null,
      attendanceRate: attended.length + absent > 0 ? attended.length / (attended.length + absent) : null,
    },
    monthly,
    currentGoal: goal ? {
      text: goal.nextGoal,
      setAt: goal.sharedAt!.toISOString(),
      coachName: goal.booking.instructor.name,
      businessName: goal.booking.business.name,
    } : null,
    feedback: feedback.map(learnerFeedbackJson),
    filters: {
      clubs: [...clubs.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
      coaches: distinctText(places.map(place => place.booking.instructor.name)),
      sports: distinctText(places.map(place => place.booking.service.category)),
    },
  };
}

progressRouter.get('/account/progress', requireStudent, asyncRoute(async (req, res) => {
  const filters = progressFiltersQuery.parse(req.query);
  res.json(await buildProgressSummary(req.auth.user.id, filters));
}));

const feedbackParams = z.object({ id: z.string().trim().min(1).max(200) }).strict();

progressRouter.post('/account/feedback/:id/viewed', requireStudent, asyncRoute(async (req, res) => {
  const { id } = feedbackParams.parse(req.params);
  z.object({}).strict().parse(req.body ?? {});
  const where: Prisma.SessionFeedbackWhereInput = {
    id, visibility: 'SHARED',
    participant: { cancelledAt: null, student: { userId: req.auth.user.id } },
    booking: { status: { not: 'CANCELLED' } },
  };
  const feedback = await prisma.sessionFeedback.findFirst({ where, select: { id: true } });
  if (!feedback) throw new HttpError(404, 'Feedback not found');
  // Only the first view is recorded; later reads leave the original instant.
  await prisma.sessionFeedback.updateMany({ where: { ...where, firstViewedAt: null }, data: { firstViewedAt: new Date() } });
  res.json({ ok: true });
}));
