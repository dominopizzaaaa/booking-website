import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, requireClubPermission } from './http.js';

// Growth insights are aggregate and person-free: they read the club's daily
// funnel counters plus counts over its own bookings, feedback and waitlist.
// They are a club-side view, so a coach working in the club receives 403.
export const insightsRouter = Router();

const growthQuery = z.object({
  days: z.coerce.number().int('Choose a whole number of days').min(7).max(90).default(30),
}).strict();

const ratio = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

insightsRouter.get('/insights/growth', requireClubPermission('BOOKINGS_VIEW'), asyncRoute(async (req, res) => {
  const { days } = growthQuery.parse(req.query);
  const business = req.auth.business;
  const businessId = business.id;
  // The window is the last `days` calendar days in the club's own zone,
  // including today, so counters and bookings share the same day boundaries.
  const today = DateTime.now().setZone(business.timezone).startOf('day');
  const firstDay = today.minus({ days: days - 1 });
  const windowStart = firstDay.toJSDate();
  const windowEnd = today.plus({ days: 1 }).toJSDate();
  const now = new Date();
  // ClubFunnelCounter.day is a SQL date holding the club-local calendar day.
  // Prisma exchanges @db.Date values as UTC midnight of that date.
  const dayValue = (day: DateTime) => new Date(`${day.toISODate()}T00:00:00.000Z`);

  const attendedWhere: Prisma.ParticipantWhereInput = {
    cancelledAt: null,
    attendance: { in: ['PRESENT', 'LATE'] },
    booking: { businessId, status: { not: 'CANCELLED' }, startAt: { gte: windowStart, lt: windowEnd }, endAt: { lte: now } },
  };
  const [counters, places, attendedPlaces, withSharedFeedback, viewed, waiting, offered] = await Promise.all([
    prisma.clubFunnelCounter.findMany({
      where: { businessId, day: { gte: dayValue(firstDay), lte: dayValue(today) } },
      select: { day: true, metric: true, count: true },
    }),
    prisma.participant.groupBy({
      by: ['studentId'],
      where: { cancelledAt: null, booking: { businessId, status: { not: 'CANCELLED' }, startAt: { gte: windowStart, lt: windowEnd } } },
      _count: { _all: true },
    }),
    prisma.participant.count({ where: attendedWhere }),
    prisma.participant.count({ where: { ...attendedWhere, feedback: { is: { visibility: 'SHARED' } } } }),
    prisma.participant.count({
      where: { ...attendedWhere, feedback: { is: { visibility: 'SHARED', firstViewedAt: { not: null } } } },
    }),
    prisma.waitlistEntry.count({ where: { businessId, status: 'WAITING' } }),
    prisma.waitlistEntry.count({ where: { businessId, status: 'OFFERED' } }),
  ]);

  const funnel = {
    pageViews: 0, availabilityChecks: 0, bookings: 0, rebooks: 0,
    waitlistJoined: 0, waitlistAccepted: 0, searchImpressions: 0,
  };
  const funnelKey: Record<string, keyof typeof funnel> = {
    PAGE_VIEW: 'pageViews', AVAILABILITY_CHECK: 'availabilityChecks', BOOKING_CREATED: 'bookings',
    REBOOK_CREATED: 'rebooks', WAITLIST_JOINED: 'waitlistJoined', WAITLIST_ACCEPTED: 'waitlistAccepted',
    SEARCH_IMPRESSION: 'searchImpressions',
  };
  const daily = Array.from({ length: days }, (_, index) => ({
    day: firstDay.plus({ days: index }).toISODate()!, pageViews: 0, availabilityChecks: 0, bookings: 0,
  }));
  const dailyByDay = new Map(daily.map(entry => [entry.day, entry]));
  for (const counter of counters) {
    const key = funnelKey[counter.metric];
    if (!key) continue;
    funnel[key] += counter.count;
    const entry = dailyByDay.get(counter.day.toISOString().slice(0, 10));
    if (!entry) continue;
    if (key === 'pageViews') entry.pageViews += counter.count;
    else if (key === 'availabilityChecks') entry.availabilityChecks += counter.count;
    else if (key === 'bookings') entry.bookings += counter.count;
  }

  const activeStudents = places.length;
  const returningStudents = places.filter(row => row._count._all >= 2).length;
  res.json({
    days,
    funnel,
    daily,
    retention: { activeStudents, returningStudents, repeatRate: ratio(returningStudents, activeStudents) },
    feedback: {
      attendedPlaces, withSharedFeedback, coverage: ratio(withSharedFeedback, attendedPlaces),
      viewed, viewRate: ratio(viewed, withSharedFeedback),
    },
    waitlist: { waiting, offered },
  });
}));
