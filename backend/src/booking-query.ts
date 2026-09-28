import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { HttpError } from './http.js';

const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
const optionalText = z.preprocess(first, z.string().trim().min(1).optional());
const dateValue = z.preprocess(first, z.string().trim().min(1).optional());

export const bookingListQuery = z.object({
  from: dateValue,
  to: dateValue,
  status: z.preprocess(first, z.enum(['CONFIRMED', 'PENDING', 'CANCELLED', 'COMPLETED']).optional()),
  instructorId: optionalText,
  locationId: optionalText,
  serviceId: optionalText,
  q: z.preprocess(first, z.string().trim().max(200).optional()),
  cursor: optionalText,
  limit: z.preprocess(first, z.coerce.number().int().min(1).max(100).default(30)),
  sort: z.preprocess(first, z.enum(['asc', 'desc']).default('asc')),
}).passthrough();

type ParsedBookingListQuery = {
  from?: string;
  to?: string;
  status?: 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'COMPLETED';
  instructorId?: string;
  locationId?: string;
  serviceId?: string;
  q?: string;
  cursor?: string;
  limit: number;
  sort: 'asc' | 'desc';
};

export type BookingListQuery = Omit<ParsedBookingListQuery, 'from' | 'to'> & { from?: Date; to?: Date };
export type BookingCursor = { startAt: Date; id: string };

export function calendarDateBoundary(value: string | undefined, timezone: string, inclusiveEnd = false) {
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const parsed = dateOnly
    ? DateTime.fromISO(value, { zone: timezone }).startOf('day').plus(inclusiveEnd ? { days: 1 } : {})
    : DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) throw new HttpError(400, 'Use a valid ISO date');
  return parsed.toJSDate();
}

export function localCalendarDate(date: Date, timezone: string) {
  return DateTime.fromJSDate(date).setZone(timezone).toISODate()!;
}

export function parseBookingListQuery(raw: unknown, timezone = 'UTC'): BookingListQuery {
  // Zod preprocessors intentionally accept unknown input, which makes their
  // inferred output too broad for downstream Prisma filters. Runtime parsing
  // still establishes this narrower output contract.
  const parsed = bookingListQuery.parse(raw) as ParsedBookingListQuery;
  const query: BookingListQuery = {
    status: parsed.status,
    instructorId: parsed.instructorId,
    locationId: parsed.locationId,
    serviceId: parsed.serviceId,
    q: parsed.q,
    cursor: parsed.cursor,
    limit: parsed.limit,
    sort: parsed.sort,
    from: calendarDateBoundary(parsed.from, timezone),
    to: calendarDateBoundary(parsed.to, timezone, true),
  };
  if (query.from && query.to && query.from >= query.to) throw new HttpError(400, 'The end date must be after the start date');
  return query;
}

export function encodeBookingCursor(cursor: BookingCursor) {
  return Buffer.from(JSON.stringify({ startAt: cursor.startAt.toISOString(), id: cursor.id }), 'utf8').toString('base64url');
}

export function decodeBookingCursor(value: string | undefined): BookingCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = z.object({ startAt: z.string().datetime(), id: z.string().min(1) }).strict()
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { startAt: new Date(parsed.startAt), id: parsed.id };
  } catch {
    throw new HttpError(400, 'Invalid booking cursor');
  }
}

export function bookingWhere(
  businessId: string, query: BookingListQuery, instructorScope?: string, cursor = decodeBookingCursor(query.cursor),
): Prisma.BookingWhereInput {
  const boundary: Prisma.BookingWhereInput | undefined = cursor ? { OR: query.sort === 'asc' ? [
    { startAt: { gt: cursor.startAt } },
    { startAt: cursor.startAt, id: { gt: cursor.id } },
  ] : [
    { startAt: { lt: cursor.startAt } },
    { startAt: cursor.startAt, id: { lt: cursor.id } },
  ] } : undefined;
  const q = query.q || undefined;
  return {
    businessId,
    instructorId: instructorScope ?? query.instructorId,
    locationId: query.locationId, serviceId: query.serviceId, status: query.status,
    startAt: query.from || query.to ? { gte: query.from, lt: query.to } : undefined,
    ...(boundary ? { AND: [boundary] } : {}),
    ...(q ? { OR: [
      { id: { contains: q, mode: 'insensitive' } },
      { service: { name: { contains: q, mode: 'insensitive' } } },
      { instructor: { name: { contains: q, mode: 'insensitive' } } },
      { location: { name: { contains: q, mode: 'insensitive' } } },
      { participants: { some: { cancelledAt: null, student: { name: { contains: q, mode: 'insensitive' } } } } },
    ] } : {}),
  };
}

export function bookingOrder(sort: 'asc' | 'desc'): Prisma.BookingOrderByWithRelationInput[] {
  return [{ startAt: sort }, { id: sort }];
}
