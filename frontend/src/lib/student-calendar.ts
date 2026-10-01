import { formatInTimeZone } from 'date-fns-tz';
import {
  bookingCancelled, bookingState, childScheduleState, incomingRequest, type StudentBookingState,
} from './student-bookings';
import type { AccountBooking, ChildScheduleItem } from './types';

/*
 * Calendar arithmetic works on calendar-day keys (YYYY-MM-DD) rather than Date
 * objects. A session belongs to the day it happens on at its club, and doing
 * the grid in UTC-anchored key space means the browser's own time zone can
 * never move a 23:30 lesson onto the next square.
 */

export type CalendarDot = 'confirmed' | 'pending' | 'action' | 'cancelled' | 'completed';
export type CalendarDay = { key: string; dayOfMonth: number; weekday: number; inMonth: boolean };
export type WeekStart = 0 | 1;

/** One thing on the calendar, independent of whose booking it is. */
export type CalendarEvent = {
  id: string;
  dayKey: string;
  startAt: string;
  endAt: string;
  timezone: string;
  title: string;
  clubSlug: string;
  clubName: string;
  coachName: string;
  locationName: string;
  sport: string;
  dot: CalendarDot;
  statusLabel: StudentBookingState;
};

export type CalendarFilters = { club: string; coach: string; sport: string };
export const emptyCalendarFilters: CalendarFilters = { club: '', coach: '', sport: '' };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
const monthKeyPattern = /^\d{4}-\d{2}$/;

function utcFromKey(key: string) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day || 1));
}

function keyFromUtc(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function isDayKey(value: string) {
  return dayKeyPattern.test(value) && !Number.isNaN(utcFromKey(value).getTime());
}

/** The club-local calendar day of an instant; '' when the instant is invalid. */
export function dayKeyFor(value: string | Date, timezone: string) {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return formatInTimeZone(date, timezone || 'Asia/Singapore', 'yyyy-MM-dd');
  } catch {
    return formatInTimeZone(date, 'Asia/Singapore', 'yyyy-MM-dd');
  }
}

export function monthKeyOf(dayKey: string) {
  return dayKey.slice(0, 7);
}

export function shiftDay(dayKey: string, days: number) {
  const date = utcFromKey(dayKey);
  date.setUTCDate(date.getUTCDate() + days);
  return keyFromUtc(date);
}

export function shiftMonth(monthKey: string, months: number) {
  const [year, month] = monthKey.split('-').map(Number);
  return keyFromUtc(new Date(Date.UTC(year, month - 1 + months, 1))).slice(0, 7);
}

export function daysInMonth(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Same day number in another month, clamped: 31 January + 1 month is 28 or 29 February. */
export function shiftMonthKeepingDay(dayKey: string, months: number) {
  const target = shiftMonth(monthKeyOf(dayKey), months);
  const day = Math.min(Number(dayKey.slice(8, 10)), daysInMonth(target));
  return `${target}-${String(day).padStart(2, '0')}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(dayKey: string) {
  return utcFromKey(dayKey).getUTCDay();
}

/**
 * The weeks that cover a month, padded with the neighbouring months' days so
 * every row has seven cells. Weeks start on Monday by default, the Singapore
 * convention; Sunday-first is supported for completeness.
 */
export function monthGrid(monthKey: string, weekStartsOn: WeekStart = 1): CalendarDay[][] {
  if (!monthKeyPattern.test(monthKey)) return [];
  const first = `${monthKey}-01`;
  const lead = (weekdayOf(first) - weekStartsOn + 7) % 7;
  const total = Math.ceil((lead + daysInMonth(monthKey)) / 7) * 7;
  const start = shiftDay(first, -lead);
  const weeks: CalendarDay[][] = [];
  for (let index = 0; index < total; index += 1) {
    const key = shiftDay(start, index);
    if (index % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({
      key,
      dayOfMonth: Number(key.slice(8, 10)),
      weekday: weekdayOf(key),
      inMonth: monthKeyOf(key) === monthKey,
    });
  }
  return weeks;
}

export function weekdayHeadings(weekStartsOn: WeekStart = 1) {
  return Array.from({ length: 7 }, (_, index) => {
    const long = WEEKDAYS[(index + weekStartsOn) % 7];
    return { long, short: long.slice(0, 3) };
  });
}

/** "Saturday 4 October". Built by hand so every ICU build says the same thing. */
export function dayLabel(dayKey: string) {
  const date = utcFromKey(dayKey);
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

export function monthTitle(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}

export function sessionCountText(count: number) {
  return count === 0 ? 'no sessions' : count === 1 ? '1 session' : `${count} sessions`;
}

/** The accessible name of one day square, e.g. "Saturday 4 October, 2 sessions, today". */
export function dayCellLabel(dayKey: string, count: number, options: { today?: boolean } = {}) {
  return `${dayLabel(dayKey)}, ${sessionCountText(count)}${options.today ? ', today' : ''}`;
}

export const dotOrder: CalendarDot[] = ['action', 'pending', 'confirmed', 'completed', 'cancelled'];
export const dotLabels: Record<CalendarDot, string> = {
  action: 'Needs your reply',
  pending: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function dotForState(state: StudentBookingState): CalendarDot {
  if (state === 'Cancelled') return 'cancelled';
  if (state === 'Completed') return 'completed';
  if (state === 'Awaiting coach' || state === 'Awaiting confirmation') return 'pending';
  return 'confirmed';
}

/**
 * A booking's dot. Anything waiting on the learner outranks its status: a
 * coach's proposed new time is the one thing on the calendar that stalls
 * until they answer it.
 */
export function bookingDot(item: AccountBooking, now = Date.now()): CalendarDot {
  if (bookingCancelled(item)) return 'cancelled';
  const state = bookingState(item, now);
  if (incomingRequest(item) && state !== 'Completed') return 'action';
  return dotForState(state);
}

/** The distinct dots for a day, most urgent first. */
export function dayDots(events: Pick<CalendarEvent, 'dot'>[]) {
  const present = new Set(events.map(event => event.dot));
  return dotOrder.filter(dot => present.has(dot));
}

export function accountBookingEvent(item: AccountBooking, now = Date.now(), sport = ''): CalendarEvent {
  const timezone = item.business.timezone || 'Asia/Singapore';
  return {
    id: item.booking.id,
    dayKey: dayKeyFor(item.booking.startAt, timezone),
    startAt: item.booking.startAt,
    endAt: item.booking.endAt,
    timezone,
    title: item.booking.serviceName,
    clubSlug: item.business.slug,
    clubName: item.business.name,
    coachName: item.booking.instructorName,
    locationName: item.booking.locationName,
    sport,
    dot: bookingDot(item, now),
    statusLabel: bookingState(item, now),
  };
}

export function childScheduleEvent(item: ChildScheduleItem, now = Date.now()): CalendarEvent {
  const timezone = item.business.timezone || 'Asia/Singapore';
  const state = childScheduleState(item, now);
  return {
    id: item.participantId,
    dayKey: dayKeyFor(item.startAt, timezone),
    startAt: item.startAt,
    endAt: item.endAt,
    timezone,
    title: item.serviceName,
    clubSlug: item.business.slug,
    clubName: item.business.name,
    coachName: item.coachName,
    locationName: item.location.name,
    sport: item.sport,
    dot: dotForState(state),
    statusLabel: state,
  };
}

export function groupEventsByDay<T extends { dayKey: string; startAt: string }>(events: T[]) {
  const days = new Map<string, T[]>();
  for (const event of events) {
    if (!event.dayKey) continue;
    const list = days.get(event.dayKey) ?? [];
    list.push(event);
    days.set(event.dayKey, list);
  }
  for (const list of days.values()) {
    list.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  }
  return days;
}

/** Filter choices come from the learner's own sessions, never a global list. */
export function calendarFilterOptions(events: Pick<CalendarEvent, 'clubSlug' | 'clubName' | 'coachName' | 'sport'>[]) {
  const clubs = new Map<string, string>();
  const coaches = new Map<string, string>();
  const sports = new Map<string, string>();
  for (const event of events) {
    if (event.clubSlug && !clubs.has(event.clubSlug)) clubs.set(event.clubSlug, event.clubName);
    const coach = event.coachName.trim();
    if (coach && !coaches.has(coach.toLowerCase())) coaches.set(coach.toLowerCase(), coach);
    const sport = event.sport.trim();
    if (sport && !sports.has(sport.toLowerCase())) sports.set(sport.toLowerCase(), sport);
  }
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  return {
    clubs: [...clubs].map(([value, label]) => ({ value, label })).sort(byLabel),
    coaches: [...coaches].map(([value, label]) => ({ value, label })).sort(byLabel),
    sports: [...sports].map(([value, label]) => ({ value, label })).sort(byLabel),
  };
}

export function filterCalendarEvents<T extends Pick<CalendarEvent, 'clubSlug' | 'coachName' | 'sport'>>(events: T[], filters: CalendarFilters) {
  return events.filter(event =>
    (!filters.club || event.clubSlug === filters.club)
    && (!filters.coach || event.coachName.trim().toLowerCase() === filters.coach)
    && (!filters.sport || event.sport.trim().toLowerCase() === filters.sport));
}

export function calendarFiltersActive(filters: CalendarFilters) {
  return !!(filters.club || filters.coach || filters.sport);
}

/**
 * Account bookings carry no sport, so it is recovered from what the learner
 * already has: a coach's feedback names the sport of that exact session, and
 * a club that teaches a single sport answers for all of its Classes. Anything
 * else is left unknown rather than guessed.
 */
export function bookingSportResolver(
  clubs: Array<{ business: { slug: string }; sports: string[] }>,
  feedback: Array<{ bookingId: string; sport: string }>,
) {
  const bySession = new Map<string, string>();
  for (const item of feedback) if (item.sport.trim()) bySession.set(item.bookingId, item.sport.trim());
  const byClub = new Map<string, string>();
  for (const club of clubs) {
    const distinct = new Set(club.sports.map(sport => sport.trim().toLowerCase()).filter(Boolean));
    if (distinct.size === 1) byClub.set(club.business.slug, club.sports.find(sport => sport.trim())!.trim());
  }
  return (item: Pick<AccountBooking, 'booking' | 'business'>) =>
    bySession.get(item.booking.id) ?? byClub.get(item.business.slug) ?? '';
}

export type HomeView = 'list' | 'calendar';
type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

export function homeViewKey(userId: string) {
  return `courtly:student:home-view:${userId}`;
}

function browserStorage() {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

/** The remembered List/Calendar choice; storage that is blocked or absent means List. */
export function readHomeView(userId: string, storage?: ReadableStorage): HomeView {
  try {
    const target = storage ?? browserStorage();
    return target?.getItem(homeViewKey(userId)) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

export function writeHomeView(userId: string, view: HomeView, storage?: WritableStorage) {
  try {
    const target = storage ?? browserStorage();
    if (!target) return false;
    target.setItem(homeViewKey(userId), view);
    return true;
  } catch {
    // A private window or blocked storage keeps the choice for this visit only.
    return false;
  }
}
