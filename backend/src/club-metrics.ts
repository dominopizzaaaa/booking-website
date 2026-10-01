import type { Prisma, PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { prisma } from './db.js';

export const clubMetrics = [
  'PAGE_VIEW', 'AVAILABILITY_CHECK', 'BOOKING_CREATED', 'REBOOK_CREATED',
  'WAITLIST_JOINED', 'WAITLIST_ACCEPTED', 'SEARCH_IMPRESSION',
] as const;
export type ClubMetric = (typeof clubMetrics)[number];

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Increment a person-free daily counter for one club. The row holds only the
 * club, its local calendar day, the metric name and a count, so the funnel can
 * be reported without tracking any visitor, account, session or device.
 *
 * Counting is best-effort: inside a caller's transaction a failure would
 * otherwise abort the real work, so callers outside a transaction should use
 * `recordClubMetricSoon`.
 */
export async function recordClubMetric(
  db: Db, businessId: string, metric: ClubMetric, options: { timezone?: string; amount?: number; now?: Date } = {},
) {
  const amount = Math.max(1, Math.floor(options.amount ?? 1));
  const day = DateTime.fromJSDate(options.now ?? new Date(), { zone: options.timezone ?? 'Asia/Singapore' }).toISODate();
  await db.$executeRaw`
    INSERT INTO "ClubFunnelCounter" ("businessId", "day", "metric", "count")
    VALUES (${businessId}, ${day}::date, ${metric}, ${amount})
    ON CONFLICT ("businessId", "day", "metric")
    DO UPDATE SET "count" = "ClubFunnelCounter"."count" + EXCLUDED."count"
  `;
}

/** Fire-and-forget counter for read paths, where analytics must never fail a request. */
export function recordClubMetricSoon(businessId: string, metric: ClubMetric, options: { timezone?: string; amount?: number } = {}) {
  void recordClubMetric(prisma, businessId, metric, options).catch(() => undefined);
}
