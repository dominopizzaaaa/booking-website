import { describe, expect, it } from 'vitest';
import { calendarDateBoundary, localCalendarDate, parseBookingListQuery } from '../src/booking-query.js';

describe('local calendar date filters', () => {
  it('maps an inclusive Singapore calendar-day range to exclusive UTC instants', () => {
    const query = parseBookingListQuery({ from: '2026-09-28', to: '2026-09-28' }, 'Asia/Singapore');
    expect(query.from?.toISOString()).toBe('2026-09-27T16:00:00.000Z');
    expect(query.to?.toISOString()).toBe('2026-09-28T16:00:00.000Z');
  });

  it('respects daylight-saving boundaries for inclusive local days', () => {
    expect(calendarDateBoundary('2026-03-08', 'America/New_York')?.toISOString())
      .toBe('2026-03-08T05:00:00.000Z');
    expect(calendarDateBoundary('2026-03-08', 'America/New_York', true)?.toISOString())
      .toBe('2026-03-09T04:00:00.000Z');
  });

  it('retains the selected local dates for export labels', () => {
    const query = parseBookingListQuery({ from: '2026-09-28', to: '2026-09-30' }, 'Asia/Singapore');
    expect(localCalendarDate(query.from!, 'Asia/Singapore')).toBe('2026-09-28');
    expect(localCalendarDate(new Date(query.to!.getTime() - 1), 'Asia/Singapore')).toBe('2026-09-30');
  });

  it('rejects invalid dates and reversed ranges', () => {
    expect(() => parseBookingListQuery({ from: '2026-02-30' }, 'Asia/Singapore')).toThrow('Use a valid ISO date');
    expect(() => parseBookingListQuery({ from: '2026-09-29', to: '2026-09-28' }, 'Asia/Singapore'))
      .toThrow('The end date must be after the start date');
  });
});
