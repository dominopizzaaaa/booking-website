import { Router } from 'express';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError } from './http.js';
import { guardianEligible, hasCurrentLinkConsent } from './family.js';
import { buildProgressSummary, progressFiltersQuery } from './feedback.js';

// Read-only guardian projections of a managed child's training record. Mounted
// at /api/family behind authentication and the Family feature flag.
export const familyProgressRouter = Router();

const SCHEDULE_HISTORY_DAYS = 90;
const SCHEDULE_LIMIT = 500;

const childParams = z.object({ id: z.string().trim().min(1).max(200) }).strict();
const emptyQuery = z.object({}).strict();

const childNotFound = () => new HttpError(404, 'Child profile not found', { code: 'CHILD_NOT_FOUND' });

/**
 * The same authority as booking for the child: this guardian's own ACTIVE link
 * with BOOKINGS_MANAGE, current-policy consent on that exact link (greatest
 * sequence, never timestamps), and a child who is still an active managed
 * student. Every failure is the same 404 so another family's child is never
 * confirmed to exist.
 */
async function authorizedChild(guardian: Parameters<typeof guardianEligible>[0] & { id: string }, childId: string) {
  if (!guardianEligible(guardian)) throw childNotFound();
  const link = await prisma.guardianChildLink.findFirst({
    where: {
      guardianUserId: guardian.id, childUserId: childId, status: 'ACTIVE',
      permissions: { has: 'BOOKINGS_MANAGE' },
    },
    select: {
      id: true,
      child: { select: { id: true, name: true, username: true, accountType: true, accountControl: true, accountStatus: true } },
    },
  });
  if (!link) throw childNotFound();
  const { child } = link;
  if (child.accountType !== 'STUDENT' || child.accountControl !== 'GUARDIAN_MANAGED' || child.accountStatus !== 'ACTIVE') {
    throw childNotFound();
  }
  if (!await hasCurrentLinkConsent(prisma, link.id)) throw childNotFound();
  return { id: child.id, name: child.name, username: child.username };
}

familyProgressRouter.get('/children/:id/schedule', asyncRoute(async (req, res) => {
  const { id } = childParams.parse(req.params);
  emptyQuery.parse(req.query);
  const child = await authorizedChild(req.auth.user, id);
  const since = new Date(Date.now() - SCHEDULE_HISTORY_DAYS * 24 * 60 * 60_000);
  // The child's own places only: no other participants, notes, or prices.
  const places = await prisma.participant.findMany({
    where: { cancelledAt: null, student: { userId: child.id }, booking: { startAt: { gte: since } } },
    select: {
      id: true, attendance: true,
      feedback: { select: { visibility: true } },
      booking: {
        select: {
          id: true, startAt: true, endAt: true, status: true, type: true,
          business: { select: { name: true, slug: true, timezone: true } },
          service: { select: { name: true, category: true } },
          instructor: { select: { name: true } },
          location: { select: { name: true, address: true, area: true, mapsUrl: true } },
        },
      },
    },
    orderBy: [{ booking: { startAt: 'asc' } }, { id: 'asc' }],
    take: SCHEDULE_LIMIT,
  });
  res.json({
    child,
    bookings: places.map(place => ({
      participantId: place.id,
      bookingId: place.booking.id,
      business: place.booking.business,
      serviceName: place.booking.service.name,
      sport: place.booking.service.category,
      type: place.booking.type,
      coachName: place.booking.instructor.name,
      location: place.booking.location,
      startAt: place.booking.startAt.toISOString(),
      endAt: place.booking.endAt.toISOString(),
      status: place.booking.status,
      attendance: place.attendance,
      hasFeedback: place.feedback?.visibility === 'SHARED' && place.booking.status !== 'CANCELLED',
    })),
  });
}));

familyProgressRouter.get('/children/:id/progress', asyncRoute(async (req, res) => {
  const { id } = childParams.parse(req.params);
  const filters = progressFiltersQuery.parse(req.query);
  const child = await authorizedChild(req.auth.user, id);
  res.json({ ...await buildProgressSummary(child.id, filters), child });
}));
