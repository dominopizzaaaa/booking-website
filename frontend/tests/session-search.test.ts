import { describe, expect, it } from 'vitest';
import { searchResultHref } from '../src/lib/booking-links';
import {
  buildSearchFilters, groupSearchResults, placesText, resultCountText, searchDateBounds, withFavorite,
} from '../src/lib/session-search';
import type { SessionSearchResult } from '../src/lib/types';

function result(overrides: { startAt: string; price?: number; type?: 'PRIVATE' | 'GROUP'; places?: number; slug?: string; timezone?: string; service?: string }): SessionSearchResult {
  return {
    business: {
      name: 'Riverside Rackets', slug: overrides.slug ?? 'riverside', ownerName: 'Owner', timezone: overrides.timezone ?? 'Asia/Singapore',
      currency: 'SGD', color: '#174c3c', tagline: '', cancellationHours: 24,
    },
    service: { id: overrides.service ?? 'svc', name: 'Group tennis', category: 'Tennis', type: overrides.type ?? 'GROUP', duration: 60 },
    instructor: { id: 'coach', name: 'Jordan Coach', initials: 'JC', color: '#000' },
    location: { id: 'loc', name: 'Centre Court', area: 'Tampines · East', address: '1 Lane' },
    startAt: overrides.startAt, endAt: overrides.startAt, price: overrides.price ?? 3000, placesRemaining: overrides.places ?? 4,
  };
}

describe('Find a time', () => {
  it('limits the date picker to today plus 60 days', () => {
    expect(searchDateBounds('2026-10-01')).toEqual({ min: '2026-10-01', max: '2026-11-30' });
  });

  it('sends only the filters someone chose', () => {
    expect(buildSearchFilters({ date: '2026-10-04', sport: '', timeOfDay: 'any', type: 'any', area: ' ', q: '' }))
      .toEqual({ date: '2026-10-04' });
    expect(buildSearchFilters({ date: '2026-10-04', sport: 'Tennis', timeOfDay: 'evening', type: 'GROUP', area: ' Tampines ', q: 'River' }))
      .toEqual({ date: '2026-10-04', sport: 'Tennis', timeOfDay: 'evening', type: 'GROUP', area: 'Tampines', q: 'River' });
  });

  it('groups results by club-local day, then by time, cheaper first', () => {
    const groups = groupSearchResults([
      result({ startAt: '2026-10-04T10:00:00.000Z', price: 5000, service: 'b' }),
      result({ startAt: '2026-10-03T16:30:00.000Z' }),
      result({ startAt: '2026-10-04T10:00:00.000Z', price: 3000, service: 'a' }),
      result({ startAt: '2026-10-05T01:00:00.000Z' }),
    ]);
    // 16:30 UTC on 3 October is 00:30 on 4 October in Singapore.
    expect(groups.map(group => group.dayKey)).toEqual(['2026-10-04', '2026-10-05']);
    expect(groups[0].label).toBe('Sunday 4 October');
    expect(groups[0].times.map(moment => moment.startAt)).toEqual(['2026-10-03T16:30:00.000Z', '2026-10-04T10:00:00.000Z']);
    expect(groups[0].times[1].results.map(item => item.service.id)).toEqual(['a', 'b']);
  });

  it('counts places only for group Classes', () => {
    expect(placesText(result({ startAt: '2026-10-04T10:00:00.000Z', places: 1 }))).toBe('1 place left');
    expect(placesText(result({ startAt: '2026-10-04T10:00:00.000Z', places: 3 }))).toBe('3 places left');
    expect(placesText(result({ startAt: '2026-10-04T10:00:00.000Z', type: 'PRIVATE', places: 1 }))).toBe('');
  });

  it('says how many sessions were found and when the list was cut short', () => {
    expect(resultCountText(0, false)).toBe('No open sessions found');
    expect(resultCountText(1, false)).toBe('1 open session found');
    expect(resultCountText(40, true)).toBe('40 open sessions found (showing the first 40)');
  });

  it('links a result to the club page with the slot preselected', () => {
    const href = searchResultHref(result({ startAt: '2026-10-04T10:00:00.000Z' }), '2026-10-04');
    expect(href).toBe('/book/riverside?service=svc&coach=coach&venue=loc&date=2026-10-04&start=2026-10-04T10%3A00%3A00.000Z&source=search');
  });
});

describe('saved clubs', () => {
  it('toggles without mutating the previous set, so a failed save can roll back', () => {
    const before = new Set(['riverside']);
    const saved = withFavorite(before, 'shuttle', true);
    expect([...saved].sort()).toEqual(['riverside', 'shuttle']);
    expect([...before]).toEqual(['riverside']);
    const rolledBack = withFavorite(saved, 'shuttle', false);
    expect([...rolledBack]).toEqual(['riverside']);
  });
});
