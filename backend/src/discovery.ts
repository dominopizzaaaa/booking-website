import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { requireStudent } from './auth.js';
import { skipRateLimits } from './config.js';
import { prisma } from './db.js';
import { asyncRoute, HttpError, requireAccountCapability, type AccountRequest } from './http.js';
import { sharedRateLimit } from './rate-limit.js';
import { bookableInstructorWhere, evaluateSlot, schedulingContext } from './scheduling.js';
import { publicBookingBusiness } from './serializers.js';
import { recordClubMetricSoon } from './club-metrics.js';
import { slotGridMinutes } from './public.js';

// Mounted on /api directly after authentication. Capability and role guards
// are applied per route so this router never gates unrelated /api paths.
export const discoveryRouter = Router();
const directoryGuards = [requireAccountCapability('directory'), requireStudent] as const;

export const MAX_FAVORITE_CLUBS = 200;
export const SEARCH_MAX_COMBINATIONS = 40;
export const SEARCH_MAX_EVALUATIONS = 600;
export const SEARCH_MAX_RESULTS = 40;
const SEARCH_MAX_DAYS_AHEAD = 60;
// Raw assignment rows read before availability narrows them to combinations.
// It only bounds the candidate query; the combination bound above is the
// product rule.
const SEARCH_MAX_ASSIGNMENT_ROWS = 500;

const slugParam = z.string().trim().min(1).max(200);
const emptyBody = z.object({}).strict();

const favoriteJson = (favorite: { createdAt: Date; business: { slug: string } }) => ({
  slug: favorite.business.slug, savedAt: favorite.createdAt.toISOString(),
});

discoveryRouter.get('/account/favorites', ...directoryGuards, asyncRoute(async (req, res) => {
  const favorites = await prisma.favoriteClub.findMany({
    // A saved club that can no longer take bookings is not offered back.
    where: { userId: req.auth.user.id, business: { kind: 'CLUB', legacyReadOnly: false } },
    select: { createdAt: true, business: { select: { slug: true } } },
    orderBy: [{ createdAt: 'desc' }, { businessId: 'asc' }],
    take: MAX_FAVORITE_CLUBS,
  });
  res.json({ favorites: favorites.map(favoriteJson) });
}));

discoveryRouter.put('/account/favorites/:slug', ...directoryGuards, asyncRoute(async (req, res) => {
  emptyBody.parse(req.body ?? {});
  const slug = slugParam.parse(req.params.slug);
  const userId = req.auth.user.id;
  const favorite = await prisma.$transaction(async tx => {
    const business = await tx.business.findFirst({
      where: { slug, kind: 'CLUB', legacyReadOnly: false }, select: { id: true },
    });
    if (!business) throw new HttpError(404, 'Club not found');
    // Serialize one account's saves so the cap cannot be raced past.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`favorite-clubs:${userId}`}, 0))`;
    const existing = await tx.favoriteClub.findUnique({
      where: { userId_businessId: { userId, businessId: business.id } },
      select: { createdAt: true, business: { select: { slug: true } } },
    });
    if (existing) return existing;
    if (await tx.favoriteClub.count({ where: { userId } }) >= MAX_FAVORITE_CLUBS) {
      throw new HttpError(409, `You can save up to ${MAX_FAVORITE_CLUBS} clubs. Remove one to save another.`);
    }
    return tx.favoriteClub.create({
      data: { userId, businessId: business.id },
      select: { createdAt: true, business: { select: { slug: true } } },
    });
  });
  res.json(favoriteJson(favorite));
}));

// Removal is idempotent and deliberately accepts any slug: a club that has
// since become unavailable must still be removable from the saved list.
discoveryRouter.delete('/account/favorites/:slug', ...directoryGuards, asyncRoute(async (req, res) => {
  const slug = slugParam.parse(req.params.slug);
  await prisma.favoriteClub.deleteMany({ where: { userId: req.auth.user.id, business: { slug } } });
  res.json({ ok: true });
}));

const searchLimit = sharedRateLimit({
  name: 'account-session-search',
  windowMs: 5 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  // Authentication runs first, so the quota belongs to the account rather
  // than to a shared network address.
  keyGenerator: req => (req as AccountRequest).auth?.user.id ?? 'unauthenticated',
  message: { error: 'Too many searches. Please wait a moment.' },
});

const optionalFilter = (maximum: number) => z.string().trim().max(maximum)
  .transform(value => value || undefined).optional();
const searchQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date as YYYY-MM-DD'),
  sport: optionalFilter(60),
  timeOfDay: z.enum(['any', 'morning', 'afternoon', 'evening']).default('any'),
  type: z.enum(['any', 'PRIVATE', 'GROUP']).default('any'),
  area: optionalFilter(60),
  q: optionalFilter(80),
}).strict();

// Local start-time windows, in minutes after midnight, end exclusive.
const timeOfDayWindows = {
  any: [0, 24 * 60],
  morning: [5 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 23 * 60],
} as const;

type Combination = {
  businessId: string; slug: string; timezone: string; serviceId: string; serviceName: string;
  locationId: string; locationName: string; instructorId: string; instructorName: string;
  price: number; noticeHours: number; day: DateTime; minutes: number[];
};

/**
 * Availability-first search across every public club. Each candidate is a
 * real start time from the same grid as the booking page and every result is
 * confirmed by evaluateSlot, so group places, coach conflicts and notice are
 * authoritative rather than estimated. Work is bounded per request: at most
 * 40 coach/venue/Class combinations, 600 slot evaluations and 40 results.
 */
discoveryRouter.get('/account/sessions/search', ...directoryGuards, searchLimit, asyncRoute(async (req, res) => {
  const filters = searchQuery.parse(req.query);
  const calendarDay = DateTime.fromISO(filters.date, { zone: 'UTC' });
  if (!calendarDay.isValid || calendarDay.toISODate() !== filters.date) throw new HttpError(400, 'Invalid calendar date');
  // A loose global bound for the 400; the exact today..+60 window is applied
  // below in each club's own timezone.
  const utcToday = DateTime.utc().startOf('day');
  if (calendarDay < utcToday.minus({ days: 1 }) || calendarDay > utcToday.plus({ days: SEARCH_MAX_DAYS_AHEAD + 1 })) {
    throw new HttpError(400, `Choose a date from today up to ${SEARCH_MAX_DAYS_AHEAD} days ahead`);
  }
  // A calendar date names the same weekday in every timezone.
  const dayOfWeek = calendarDay.weekday % 7;
  const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const });

  const assignmentWhere: Prisma.ServiceInstructorWhereInput = {
    instructor: { AND: [bookableInstructorWhere(), { availability: { some: { dayOfWeek } } }] },
    serviceLocation: {
      location: { active: true },
      service: {
        active: true,
        ...(filters.type !== 'any' ? { type: filters.type } : {}),
        // Categories are free text; the exact trimmed comparison happens below.
        ...(filters.sport ? { category: contains(filters.sport) } : {}),
        business: { kind: 'CLUB', isDemo: false, legacyReadOnly: false },
      },
    },
    AND: [
      ...(filters.area ? [{ serviceLocation: { location: { OR: [{ area: contains(filters.area) }, { address: contains(filters.area) }] } } }] : []),
      ...(filters.q ? [{ OR: [
        { serviceLocation: { service: { business: { name: contains(filters.q) } } } },
        { serviceLocation: { location: { area: contains(filters.q) } } },
        { serviceLocation: { location: { address: contains(filters.q) } } },
      ] }] : []),
    ],
  };
  const assignments = await prisma.serviceInstructor.findMany({
    where: assignmentWhere,
    select: {
      instructorId: true,
      instructor: { select: { name: true } },
      serviceLocation: {
        select: {
          locationId: true, price: true, duration: true,
          location: { select: { name: true } },
          service: {
            select: {
              id: true, name: true, category: true, noticeHours: true, businessId: true,
              business: { select: { slug: true, timezone: true } },
            },
          },
        },
      },
    },
    orderBy: [{ serviceLocationId: 'asc' }, { instructorId: 'asc' }],
    take: SEARCH_MAX_ASSIGNMENT_ROWS + 1,
  });
  let truncated = assignments.length > SEARCH_MAX_ASSIGNMENT_ROWS;
  const sportKey = filters.sport?.toLocaleLowerCase();
  const rows = assignments.slice(0, SEARCH_MAX_ASSIGNMENT_ROWS)
    .filter(row => !sportKey || row.serviceLocation.service.category.trim().toLocaleLowerCase() === sportKey);

  const instructorIds = [...new Set(rows.map(row => row.instructorId))];
  const [blocks, exceptions] = instructorIds.length ? await Promise.all([
    prisma.availability.findMany({
      where: { instructorId: { in: instructorIds }, dayOfWeek },
      select: { instructorId: true, locationId: true, dayOfWeek: true, startTime: true, endTime: true },
    }),
    prisma.availabilityException.findMany({
      where: { instructorId: { in: instructorIds }, date: filters.date }, select: { instructorId: true },
    }),
  ]) : [[], []];
  const blockedInstructors = new Set(exceptions.map(exception => exception.instructorId));
  const [windowStart, windowEnd] = timeOfDayWindows[filters.timeOfDay];
  const now = Date.now();

  const combinations: Combination[] = [];
  for (const row of rows) {
    const { service } = row.serviceLocation;
    const timezone = service.business.timezone;
    if (blockedInstructors.has(row.instructorId)) continue;
    const day = DateTime.fromISO(filters.date, { zone: timezone }).startOf('day');
    const localToday = DateTime.now().setZone(timezone).startOf('day');
    if (!day.isValid || day < localToday || day > localToday.plus({ days: SEARCH_MAX_DAYS_AHEAD })) continue;
    const earliest = now + service.noticeHours * 3600_000;
    const comboBlocks = blocks.filter(block => block.instructorId === row.instructorId
      && block.locationId === row.serviceLocation.locationId);
    // Notice and time-of-day filtering only discard starts evaluateSlot would
    // reject or the learner excluded, so the evaluation budget goes further.
    const minutes = slotGridMinutes(comboBlocks, dayOfWeek, row.serviceLocation.duration)
      .filter(minute => minute >= windowStart && minute < windowEnd
        && day.plus({ minutes: minute }).toMillis() >= earliest);
    if (!minutes.length) continue;
    combinations.push({
      businessId: service.businessId, slug: service.business.slug, timezone,
      serviceId: service.id, serviceName: service.name,
      locationId: row.serviceLocation.locationId, locationName: row.serviceLocation.location.name,
      instructorId: row.instructorId, instructorName: row.instructor.name,
      price: row.serviceLocation.price, noticeHours: service.noticeHours, day, minutes,
    });
  }
  // Prefer the combinations that can offer the earliest, cheapest times.
  const firstStart = (combo: Combination) => combo.day.plus({ minutes: combo.minutes[0] }).toMillis();
  combinations.sort((a, b) => firstStart(a) - firstStart(b) || a.price - b.price
    || a.slug.localeCompare(b.slug) || a.serviceId.localeCompare(b.serviceId)
    || a.locationId.localeCompare(b.locationId) || a.instructorId.localeCompare(b.instructorId));
  if (combinations.length > SEARCH_MAX_COMBINATIONS) truncated = true;
  const selected = combinations.slice(0, SEARCH_MAX_COMBINATIONS);

  // Evaluating candidates in result order means the first 40 available slots
  // are exactly the 40 earliest-then-cheapest results.
  const candidates = selected.flatMap((combo, index) => combo.minutes.map(minute => ({
    index, startAt: combo.day.plus({ minutes: minute }).toJSDate(),
  }))).sort((a, b) => a.startAt.getTime() - b.startAt.getTime()
    || selected[a.index].price - selected[b.index].price || a.index - b.index);

  const results = await prisma.$transaction(async tx => {
    const contexts = new Map<number, Awaited<ReturnType<typeof schedulingContext>> | null>();
    const found = [];
    let evaluations = 0;
    for (let position = 0; position < candidates.length; position++) {
      if (found.length >= SEARCH_MAX_RESULTS || evaluations >= SEARCH_MAX_EVALUATIONS) {
        truncated = true;
        break;
      }
      const candidate = candidates[position];
      const combo = selected[candidate.index];
      if (!contexts.has(candidate.index)) {
        try {
          contexts.set(candidate.index, await schedulingContext(tx, combo.businessId, combo.serviceId, combo.instructorId, combo.locationId));
        } catch (error) {
          // The catalogue changed between the candidate query and now.
          if (error instanceof HttpError) contexts.set(candidate.index, null);
          else throw error;
        }
      }
      const ctx = contexts.get(candidate.index);
      if (!ctx) continue;
      evaluations++;
      const slot = await evaluateSlot(tx, ctx, candidate.startAt);
      if (!slot.available) continue;
      // Joining an existing group keeps that group's price snapshot.
      const price = slot.groupId
        ? (await tx.booking.findUnique({ where: { id: slot.groupId }, select: { price: true } }))?.price ?? ctx.assignment.price
        : ctx.assignment.price;
      found.push({
        businessId: ctx.business.id,
        timezone: ctx.business.timezone,
        result: {
          business: publicBookingBusiness(ctx.business),
          service: {
            id: ctx.service.id, name: ctx.service.name, category: ctx.service.category,
            type: ctx.service.type as 'PRIVATE' | 'GROUP', duration: ctx.assignment.duration,
          },
          instructor: {
            id: ctx.instructor.id, name: ctx.instructor.name, initials: ctx.instructor.initials, color: ctx.instructor.color,
          },
          location: { id: ctx.location.id, name: ctx.location.name, area: ctx.location.area, address: ctx.location.address },
          startAt: slot.startAt.toISOString(), endAt: slot.endAt.toISOString(),
          price, placesRemaining: slot.placesRemaining,
        },
      });
    }
    return found;
  }, { timeout: 20_000, maxWait: 5_000 });

  results.sort((a, b) => a.result.startAt.localeCompare(b.result.startAt) || a.result.price - b.result.price);
  const impressions = new Map(results.map(entry => [entry.businessId, entry.timezone]));
  for (const [businessId, timezone] of impressions) recordClubMetricSoon(businessId, 'SEARCH_IMPRESSION', { timezone });
  res.json({ results: results.map(entry => entry.result), truncated });
}));
