import type { BookingSource } from './types';

/**
 * Links into a club's public booking page that preselect a Class, coach and
 * venue (and optionally a day and start time). The booking page treats every
 * value as a suggestion: anything that is no longer bookable is ignored and
 * the person simply chooses again.
 */
export type BookingPreselection = {
  serviceId?: string;
  instructorId?: string;
  locationId?: string;
  /** Club-local calendar day, YYYY-MM-DD. */
  date?: string;
  /** Exact slot start as an ISO instant. */
  startAt?: string;
  source: BookingSource;
};

const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function bookingPath(slug: string, values: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  const query = params.toString();
  return `/book/${encodeURIComponent(slug)}${query ? `?${query}` : ''}`;
}

/** "Book again" from an existing booking: same Class, coach and venue. */
export function rebookHref(slug: string, booking: { serviceId: string; instructorId: string; locationId: string }) {
  return bookingPath(slug, {
    service: booking.serviceId, coach: booking.instructorId, venue: booking.locationId, rebook: '1',
  });
}

/** A specific slot found through availability-first search. */
export function searchResultHref(result: {
  business: { slug: string };
  service: { id: string };
  instructor: { id: string };
  location: { id: string };
  startAt: string;
}, date: string) {
  return bookingPath(result.business.slug, {
    service: result.service.id, coach: result.instructor.id, venue: result.location.id,
    date: datePattern.test(date) ? date : undefined, start: result.startAt, source: 'search',
  });
}

/** Read and validate preselection query parameters; invalid values are dropped. */
export function parseBookingPreselection(params: Pick<URLSearchParams, 'get'>): BookingPreselection {
  const id = (key: string) => {
    const value = params.get(key)?.trim();
    return value && idPattern.test(value) ? value : undefined;
  };
  const date = params.get('date')?.trim();
  const start = params.get('start')?.trim();
  const startValid = !!start && !Number.isNaN(Date.parse(start)) && /\d{4}-\d{2}-\d{2}T/.test(start);
  const rebook = params.get('rebook') === '1';
  const source: BookingSource = rebook ? 'REBOOK' : params.get('source') === 'search' ? 'SEARCH' : 'DIRECT';
  return {
    serviceId: id('service'),
    instructorId: id('coach'),
    locationId: id('venue'),
    date: date && datePattern.test(date) ? date : undefined,
    startAt: startValid ? new Date(start!).toISOString() : undefined,
    source,
  };
}
