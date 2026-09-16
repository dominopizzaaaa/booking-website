import { describe, expect, it } from 'vitest';
import { fitsWorkingHours, hasTimeConflict, travelMinutes } from '../src/scheduling.js';

const at = (time: string) => new Date(`2026-09-14T${time}:00+08:00`);
const location = (id = 'court-a', travel = 20) => ({ id, travelMinutes: travel });
const session = (start: string, end: string, bufferMinutes = 0, venue = location()) => ({
  startAt: at(start), endAt: at(end), bufferMinutes, location: venue,
});

describe('travelMinutes', () => {
  it('does not add travel at the same location', () => {
    expect(travelMinutes(location('court-a', 90), location('court-a', 45))).toBe(0);
  });

  it.each([[10, 35], [35, 10], [0, 35], [35, 0], [0, 0]])(
    'uses the larger location allowance in either direction (%i, %i)', (from, to) => {
      const a = location('court-a', from);
      const b = location('court-b', to);
      expect(travelMinutes(a, b)).toBe(Math.max(from, to));
      expect(travelMinutes(b, a)).toBe(Math.max(from, to));
    },
  );
});

describe('hasTimeConflict', () => {
  it.each([
    ['equal sessions', '09:00', '10:00', '09:00', '10:00'],
    ['candidate starts during an existing session', '09:30', '10:30', '09:00', '10:00'],
    ['candidate ends during an existing session', '08:30', '09:30', '09:00', '10:00'],
    ['candidate contains the existing session', '08:00', '11:00', '09:00', '10:00'],
    ['candidate is contained in the existing session', '09:15', '09:45', '09:00', '10:00'],
  ])('detects global coach overlap: %s', (_label, start, end, oldStart, oldEnd) => {
    const candidate = session(start, end, 0, location('court-a', 0));
    const existing = session(oldStart, oldEnd, 0, location('court-b', 0));
    expect(hasTimeConflict(candidate, existing)).toBe(true);
    expect(hasTimeConflict(existing, candidate)).toBe(true);
  });

  it('allows adjacent sessions at one venue without any travel allowance', () => {
    const first = session('09:00', '10:00', 0, location('same-court', 60));
    const next = session('10:00', '11:00', 0, location('same-court', 90));
    expect(hasTimeConflict(next, first)).toBe(false);
    expect(hasTimeConflict(first, next)).toBe(false);
  });

  it.each([[10, 35], [35, 10]])(
    'requires max travel plus preparation of the later session (%i, %i)', (earlierTravel, laterTravel) => {
      const earlier = session('09:00', '10:00', 70, location('court-a', earlierTravel));
      const tooSoon = session('10:49', '11:49', 15, location('court-b', laterTravel));
      const exactBoundary = session('10:50', '11:50', 15, location('court-b', laterTravel));
      expect(hasTimeConflict(tooSoon, earlier)).toBe(true);
      expect(hasTimeConflict(earlier, tooSoon)).toBe(true);
      expect(hasTimeConflict(exactBoundary, earlier)).toBe(false);
      expect(hasTimeConflict(earlier, exactBoundary)).toBe(false);
    },
  );

  it('applies candidate preparation before, not after, the candidate session', () => {
    const candidate = session('10:00', '11:00', 15);
    expect(hasTimeConflict(candidate, session('09:00', '09:46'))).toBe(true);
    expect(hasTimeConflict(candidate, session('09:00', '09:45'))).toBe(false);
    expect(hasTimeConflict(candidate, session('11:00', '12:00'))).toBe(false);
  });

  it('applies existing preparation before, not after, the existing session', () => {
    const existing = session('10:00', '11:00', 15);
    expect(hasTimeConflict(session('09:00', '09:46'), existing)).toBe(true);
    expect(hasTimeConflict(session('09:00', '09:45'), existing)).toBe(false);
    expect(hasTimeConflict(session('11:00', '12:00'), existing)).toBe(false);
  });
});

describe('fitsWorkingHours', () => {
  const timezone = 'Asia/Singapore';
  const monday = [{ dayOfWeek: 1, startTime: '09:00', endTime: '18:00' }];

  it('accepts exact opening and closing boundaries', () => {
    expect(fitsWorkingHours(at('09:00'), at('18:00'), timezone, monday)).toBe(true);
  });

  it.each([['08:59', '10:00'], ['17:00', '18:01']])(
    'rejects a session outside a boundary (%s–%s)', (start, end) => {
      expect(fitsWorkingHours(at(start), at(end), timezone, monday)).toBe(false);
    },
  );

  it('requires preparation to fit before the session, including the exact boundary', () => {
    expect(fitsWorkingHours(at('09:00'), at('10:00'), timezone, monday, 15)).toBe(false);
    expect(fitsWorkingHours(at('09:14'), at('10:14'), timezone, monday, 15)).toBe(false);
    expect(fitsWorkingHours(at('09:15'), at('10:15'), timezone, monday, 15)).toBe(true);
    expect(fitsWorkingHours(at('17:00'), at('18:00'), timezone, monday, 15)).toBe(true);
  });

  it('uses Singapore local time instead of UTC clock hours', () => {
    const start = new Date('2026-09-14T01:00:00Z');
    const end = new Date('2026-09-14T02:00:00Z');
    expect(fitsWorkingHours(start, end, timezone, monday)).toBe(true);
    expect(fitsWorkingHours(start, end, 'UTC', monday)).toBe(false);
  });

  it('uses the Singapore weekday when UTC is still the previous day', () => {
    const start = new Date('2026-09-13T16:30:00Z');
    const end = new Date('2026-09-13T17:30:00Z');
    expect(fitsWorkingHours(start, end, timezone, [
      { dayOfWeek: 1, startTime: '00:00', endTime: '02:00' },
    ])).toBe(true);
    expect(fitsWorkingHours(start, end, timezone, [
      { dayOfWeek: 0, startTime: '00:00', endTime: '02:00' },
    ])).toBe(false);
  });

  it('maps Sunday to dayOfWeek 0', () => {
    const start = new Date('2026-09-13T09:00:00+08:00');
    const end = new Date('2026-09-13T10:00:00+08:00');
    expect(fitsWorkingHours(start, end, timezone, [
      { dayOfWeek: 0, startTime: '09:00', endTime: '10:00' },
    ])).toBe(true);
    expect(fitsWorkingHours(start, end, timezone, monday)).toBe(false);
  });

  it('rejects missing availability and the wrong weekday', () => {
    expect(fitsWorkingHours(at('10:00'), at('11:00'), timezone, [])).toBe(false);
    expect(fitsWorkingHours(at('10:00'), at('11:00'), timezone, [
      { dayOfWeek: 2, startTime: '09:00', endTime: '18:00' },
    ])).toBe(false);
  });

  it('requires the whole session and preparation to fit a single availability block', () => {
    const blocks = [
      { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '13:00', endTime: '18:00' },
    ];
    expect(fitsWorkingHours(at('11:30'), at('13:30'), timezone, blocks)).toBe(false);
    expect(fitsWorkingHours(at('13:00'), at('14:00'), timezone, blocks, 15)).toBe(false);
    expect(fitsWorkingHours(at('13:15'), at('14:15'), timezone, blocks, 15)).toBe(true);
  });

  it('handles minute-level opening hours', () => {
    const blocks = [{ dayOfWeek: 1, startTime: '09:30', endTime: '10:45' }];
    expect(fitsWorkingHours(at('09:45'), at('10:45'), timezone, blocks, 15)).toBe(true);
    expect(fitsWorkingHours(at('09:44'), at('10:44'), timezone, blocks, 15)).toBe(false);
  });

  it('rejects a session crossing Singapore midnight', () => {
    expect(fitsWorkingHours(
      new Date('2026-09-14T23:30:00+08:00'),
      new Date('2026-09-15T00:30:00+08:00'), timezone,
      [
        { dayOfWeek: 1, startTime: '00:00', endTime: '23:59' },
        { dayOfWeek: 2, startTime: '00:00', endTime: '23:59' },
      ],
    )).toBe(false);
  });

  it('rejects preparation spilling into the previous Singapore day', () => {
    const blocks = [
      { dayOfWeek: 0, startTime: '00:00', endTime: '23:59' },
      { dayOfWeek: 1, startTime: '00:00', endTime: '23:59' },
    ];
    expect(fitsWorkingHours(at('00:10'), at('01:10'), timezone, blocks, 15)).toBe(false);
    expect(fitsWorkingHours(at('00:15'), at('01:15'), timezone, blocks, 15)).toBe(true);
  });
});
