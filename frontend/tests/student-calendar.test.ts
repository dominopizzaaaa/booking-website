import { describe, expect, it } from 'vitest';
import {
  accountBookingEvent, bookingDot, bookingSportResolver, calendarFilterOptions, childScheduleEvent, dayCellLabel,
  dayDots, dayKeyFor, dayLabel, daysInMonth, filterCalendarEvents, groupEventsByDay, homeViewKey, monthGrid, monthTitle,
  readHomeView, shiftDay, shiftMonth, shiftMonthKeepingDay, weekdayHeadings, writeHomeView,
} from '../src/lib/student-calendar';
import { bookingState, childScheduleState } from '../src/lib/student-bookings';
import type { AccountBooking, ChildScheduleItem } from '../src/lib/types';

const NOW = Date.parse('2026-10-01T04:00:00.000Z');

function booking(overrides: {
  id?: string; startAt?: string; endAt?: string; status?: AccountBooking['booking']['status'];
  coachAcceptance?: AccountBooking['booking']['coachAcceptance']; cancelledAt?: string | null;
  club?: string; coach?: string; timezone?: string; reschedule?: AccountBooking['rescheduleRequest'];
} = {}): AccountBooking {
  const club = overrides.club ?? 'riverside';
  return {
    business: {
      name: club === 'riverside' ? 'Riverside Rackets' : 'Shuttle House', slug: club, ownerName: 'Owner',
      timezone: overrides.timezone ?? 'Asia/Singapore', currency: 'SGD', color: '#174c3c', tagline: '', cancellationHours: 24,
    },
    booking: {
      id: overrides.id ?? 'booking-1', serviceId: 'svc', serviceName: 'Private tennis', instructorId: 'coach',
      instructorName: overrides.coach ?? 'Jordan Coach', locationId: 'loc', locationName: 'Centre Court', locationColor: '#000',
      startAt: overrides.startAt ?? '2026-10-04T02:00:00.000Z', endAt: overrides.endAt ?? '2026-10-04T03:00:00.000Z',
      status: overrides.status ?? 'CONFIRMED', type: 'PRIVATE', capacity: 1, price: 8000, paymentRoute: 'CLUB',
      coachAcceptance: overrides.coachAcceptance ?? 'NOT_REQUIRED', createdByRole: 'STUDENT', address: '', recurringId: null,
      participants: [],
    },
    participant: {
      id: `participant-${overrides.id ?? '1'}`, studentId: 's', name: 'Avery', email: null, attendance: 'UNMARKED',
      paid: false, price: 8000, packageId: null, notes: '', cancelledAt: overrides.cancelledAt ?? null,
    },
    rescheduleRequest: overrides.reschedule ?? null,
  };
}

describe('month grid', () => {
  it('starts weeks on Monday and pads with neighbouring months', () => {
    const weeks = monthGrid('2026-10');
    expect(weeks).toHaveLength(5);
    expect(weeks.every(week => week.length === 7)).toBe(true);
    expect(weeks[0][0]).toMatchObject({ key: '2026-09-28', inMonth: false, weekday: 1 });
    expect(weeks[0][3]).toMatchObject({ key: '2026-10-01', inMonth: true, dayOfMonth: 1 });
    expect(weeks.at(-1)!.at(-1)).toMatchObject({ key: '2026-11-01', inMonth: false, weekday: 0 });
  });

  it('supports Sunday-first weeks and a February that fits four rows exactly', () => {
    const sundayFirst = monthGrid('2026-02', 0);
    expect(sundayFirst).toHaveLength(4);
    expect(sundayFirst[0][0].key).toBe('2026-02-01');
    expect(sundayFirst[3][6].key).toBe('2026-02-28');
    const mondayFirst = monthGrid('2026-02', 1);
    expect(mondayFirst).toHaveLength(5);
    expect(mondayFirst[0][0].key).toBe('2026-01-26');
  });

  it('covers every day of the month exactly once', () => {
    for (const month of ['2026-01', '2026-02', '2028-02', '2026-12']) {
      const inMonth = monthGrid(month).flat().filter(day => day.inMonth).map(day => day.key);
      expect(inMonth).toHaveLength(daysInMonth(month));
      expect(new Set(inMonth).size).toBe(inMonth.length);
    }
    expect(daysInMonth('2028-02')).toBe(29);
  });

  it('rejects malformed month keys instead of guessing', () => {
    expect(monthGrid('October')).toEqual([]);
  });

  it('names weekdays in the grid order', () => {
    expect(weekdayHeadings().map(day => day.short)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(weekdayHeadings(0)[0]).toEqual({ long: 'Sunday', short: 'Sun' });
  });
});

describe('calendar key arithmetic', () => {
  it('moves across month and year boundaries', () => {
    expect(shiftDay('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('clamps Page Up/Down to the last day of a shorter month', () => {
    expect(shiftMonthKeepingDay('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonthKeepingDay('2028-01-31', 1)).toBe('2028-02-29');
    expect(shiftMonthKeepingDay('2026-03-15', -1)).toBe('2026-02-15');
  });

  it('places a session on its club-local day, not the browser’s', () => {
    // 00:30 on 4 October in Singapore is still 3 October in UTC.
    expect(dayKeyFor('2026-10-03T16:30:00.000Z', 'Asia/Singapore')).toBe('2026-10-04');
    expect(dayKeyFor('2026-10-03T16:30:00.000Z', 'UTC')).toBe('2026-10-03');
    expect(dayKeyFor('not a date', 'Asia/Singapore')).toBe('');
  });

  it('labels days and months without locale drift', () => {
    expect(dayLabel('2026-10-03')).toBe('Saturday 3 October');
    expect(monthTitle('2026-10')).toBe('October 2026');
    expect(dayCellLabel('2026-10-03', 2)).toBe('Saturday 3 October, 2 sessions');
    expect(dayCellLabel('2026-10-03', 1, { today: true })).toBe('Saturday 3 October, 1 session, today');
    expect(dayCellLabel('2026-10-04', 0)).toBe('Sunday 4 October, no sessions');
  });
});

describe('status dots', () => {
  it('maps every booking state to a dot', () => {
    expect(bookingDot(booking(), NOW)).toBe('confirmed');
    expect(bookingDot(booking({ status: 'PENDING' }), NOW)).toBe('pending');
    expect(bookingDot(booking({ coachAcceptance: 'PENDING', status: 'PENDING' }), NOW)).toBe('pending');
    expect(bookingDot(booking({ cancelledAt: '2026-09-30T00:00:00.000Z' }), NOW)).toBe('cancelled');
    expect(bookingDot(booking({ status: 'CANCELLED' }), NOW)).toBe('cancelled');
    expect(bookingDot(booking({ startAt: '2026-09-20T02:00:00.000Z', endAt: '2026-09-20T03:00:00.000Z' }), NOW)).toBe('completed');
  });

  it('marks a coach’s proposed new time as needing the learner', () => {
    const request = {
      id: 'r', bookingId: 'booking-1', participantId: 'p', requestedByRole: 'CLUB' as const, requestedByUserId: null,
      proposedStartAt: '2026-10-05T02:00:00.000Z', proposedEndAt: '2026-10-05T03:00:00.000Z', originalStartAt: '2026-10-04T02:00:00.000Z',
      message: '', status: 'PENDING' as const, respondedAt: null, responseMessage: '', createdAt: '2026-09-30T00:00:00.000Z',
      serviceName: 'Private tennis', instructorName: 'Jordan', locationName: 'Court', businessName: 'Riverside', timezone: 'Asia/Singapore',
    };
    expect(bookingDot(booking({ reschedule: request }), NOW)).toBe('action');
    // The learner's own request waits on the coach, not on them.
    expect(bookingDot(booking({ reschedule: { ...request, requestedByRole: 'STUDENT' } }), NOW)).toBe('confirmed');
  });

  it('orders a day’s dots by urgency and removes duplicates', () => {
    expect(dayDots([{ dot: 'confirmed' }, { dot: 'cancelled' }, { dot: 'action' }, { dot: 'confirmed' }]))
      .toEqual(['action', 'confirmed', 'cancelled']);
  });

  it('keeps the shared state wording for list and calendar', () => {
    expect(bookingState(booking({ startAt: '2026-10-01T03:30:00.000Z', endAt: '2026-10-01T05:00:00.000Z' }), NOW)).toBe('In progress');
    expect(childScheduleState({ status: 'PENDING', startAt: '2026-10-04T02:00:00.000Z', endAt: '2026-10-04T03:00:00.000Z' }, NOW)).toBe('Awaiting confirmation');
  });
});

describe('calendar events and filters', () => {
  const events = [
    accountBookingEvent(booking({ id: 'a', startAt: '2026-10-04T10:00:00.000Z', endAt: '2026-10-04T11:00:00.000Z' }), NOW, 'Tennis'),
    accountBookingEvent(booking({ id: 'b', startAt: '2026-10-04T01:00:00.000Z', endAt: '2026-10-04T02:00:00.000Z', club: 'shuttle', coach: 'Sam Lee' }), NOW, 'Badminton'),
    accountBookingEvent(booking({ id: 'c', startAt: '2026-10-09T01:00:00.000Z', endAt: '2026-10-09T02:00:00.000Z', coach: 'jordan coach' }), NOW, 'tennis'),
  ];

  it('groups by club-local day in start order', () => {
    const days = groupEventsByDay(events);
    expect(days.get('2026-10-04')!.map(event => event.id)).toEqual(['b', 'a']);
    expect(days.get('2026-10-09')!.map(event => event.id)).toEqual(['c']);
  });

  it('derives filter choices from the learner’s own sessions, case-insensitively', () => {
    const options = calendarFilterOptions(events);
    expect(options.clubs).toEqual([{ value: 'riverside', label: 'Riverside Rackets' }, { value: 'shuttle', label: 'Shuttle House' }]);
    expect(options.coaches.map(option => option.label)).toEqual(['Jordan Coach', 'Sam Lee']);
    expect(options.sports).toEqual([{ value: 'badminton', label: 'Badminton' }, { value: 'tennis', label: 'Tennis' }]);
  });

  it('applies club, coach and sport filters together', () => {
    expect(filterCalendarEvents(events, { club: 'riverside', coach: '', sport: '' }).map(event => event.id)).toEqual(['a', 'c']);
    expect(filterCalendarEvents(events, { club: '', coach: 'jordan coach', sport: 'tennis' }).map(event => event.id)).toEqual(['a', 'c']);
    expect(filterCalendarEvents(events, { club: 'shuttle', coach: '', sport: 'tennis' })).toEqual([]);
  });

  it('turns a child’s schedule item into the same event shape', () => {
    const item: ChildScheduleItem = {
      participantId: 'p1', bookingId: 'b1', business: { name: 'Riverside Rackets', slug: 'riverside', timezone: 'Asia/Singapore' },
      serviceName: 'Junior squad', sport: 'Tennis', type: 'GROUP', coachName: 'Jordan Coach',
      location: { name: 'Centre Court', address: '1 Lane', area: 'East', mapsUrl: '' },
      startAt: '2026-10-03T16:30:00.000Z', endAt: '2026-10-03T17:30:00.000Z', status: 'CONFIRMED', attendance: 'UNMARKED', hasFeedback: false,
    };
    expect(childScheduleEvent(item, NOW)).toMatchObject({ id: 'p1', dayKey: '2026-10-04', dot: 'confirmed', sport: 'Tennis', statusLabel: 'Confirmed' });
  });

  it('recovers a sport from session feedback first, then a single-sport club, else leaves it unknown', () => {
    const resolve = bookingSportResolver(
      [
        { business: { slug: 'riverside' }, sports: ['Tennis', 'Pickleball'] },
        { business: { slug: 'shuttle' }, sports: ['Badminton', 'badminton'] },
      ],
      [{ bookingId: 'a', sport: 'Pickleball' }],
    );
    expect(resolve(booking({ id: 'a' }))).toBe('Pickleball');
    expect(resolve(booking({ id: 'z', club: 'shuttle' }))).toBe('Badminton');
    expect(resolve(booking({ id: 'y' }))).toBe('');
  });
});

describe('List/Calendar preference', () => {
  class MemoryStorage {
    values = new Map<string, string>();
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) { this.values.set(key, value); }
  }

  it('is remembered per account under a namespaced key', () => {
    const storage = new MemoryStorage();
    expect(readHomeView('user-1', storage)).toBe('list');
    expect(writeHomeView('user-1', 'calendar', storage)).toBe(true);
    expect(storage.values.get(homeViewKey('user-1'))).toBe('calendar');
    expect(homeViewKey('user-1')).toBe('courtly:student:home-view:user-1');
    expect(readHomeView('user-1', storage)).toBe('calendar');
    expect(readHomeView('user-2', storage)).toBe('list');
  });

  it('falls back to the list when storage is blocked or holds nonsense', () => {
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readHomeView('user-1', blocked)).toBe('list');
    expect(writeHomeView('user-1', 'calendar', blocked)).toBe(false);
    const storage = new MemoryStorage();
    storage.setItem(homeViewKey('user-1'), 'agenda');
    expect(readHomeView('user-1', storage)).toBe('list');
  });
});
