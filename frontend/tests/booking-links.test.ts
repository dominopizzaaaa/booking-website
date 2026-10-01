import { describe, expect, it } from 'vitest';
import { parseBookingPreselection, rebookHref, searchResultHref } from '../src/lib/booking-links';

describe('booking links', () => {
  it('builds a re-booking link that preselects the same Class, coach and venue', () => {
    expect(rebookHref('elever badminton', { serviceId: 'svc_1', instructorId: 'coach_1', locationId: 'loc_1' }))
      .toBe('/book/elever%20badminton?service=svc_1&coach=coach_1&venue=loc_1&rebook=1');
  });

  it('builds a search-result link with the exact slot and attribution', () => {
    const href = searchResultHref({
      business: { slug: 'club' }, service: { id: 's' }, instructor: { id: 'i' }, location: { id: 'l' },
      startAt: '2026-10-04T01:00:00.000Z',
    }, '2026-10-04');
    expect(href).toBe('/book/club?service=s&coach=i&venue=l&date=2026-10-04&start=2026-10-04T01%3A00%3A00.000Z&source=search');
  });

  it('round-trips through the parser and labels the source', () => {
    const rebook = parseBookingPreselection(new URLSearchParams('service=svc_1&coach=coach_1&venue=loc_1&rebook=1'));
    expect(rebook).toEqual({
      serviceId: 'svc_1', instructorId: 'coach_1', locationId: 'loc_1', date: undefined, startAt: undefined, source: 'REBOOK',
    });
    const search = parseBookingPreselection(new URLSearchParams('service=s&date=2026-10-04&start=2026-10-04T01:00:00.000Z&source=search'));
    expect(search).toMatchObject({ serviceId: 's', date: '2026-10-04', startAt: '2026-10-04T01:00:00.000Z', source: 'SEARCH' });
  });

  it('drops malformed values instead of trusting them', () => {
    const parsed = parseBookingPreselection(new URLSearchParams('service=<script>&coach=&date=04-10-2026&start=tomorrow'));
    expect(parsed).toEqual({
      serviceId: undefined, instructorId: undefined, locationId: undefined, date: undefined, startAt: undefined, source: 'DIRECT',
    });
  });
});
