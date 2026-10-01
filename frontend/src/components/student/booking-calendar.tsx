'use client';

import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  calendarFilterOptions, calendarFiltersActive, dayCellLabel, dayDots, dayLabel,
  dotLabels, dotOrder, emptyCalendarFilters, filterCalendarEvents, groupEventsByDay, monthGrid,
  monthKeyOf, monthTitle, sessionCountText, shiftDay, shiftMonth, shiftMonthKeepingDay, weekdayHeadings, weekdayOf,
  type CalendarDot, type CalendarEvent, type CalendarFilters,
} from '@/lib/student-calendar';
import { cn, time } from '@/lib/utils';
import { Disclosure } from '@/components/ui/progressive-disclosure';
import { compactButton, field, focusRing, panel, statusClass } from './styles';

const dotColour: Record<CalendarDot, string> = {
  action: 'bg-[#b3483a]',
  pending: 'bg-[#b8892f]',
  confirmed: 'bg-[#2f7a57]',
  completed: 'bg-[#6b8296]',
  cancelled: 'bg-white ring-1 ring-inset ring-[#8b4d3c]',
};

function countSentence(count: number) {
  return count === 0 ? 'No sessions' : sessionCountText(count);
}

function Dot({ dot, className }: { dot: CalendarDot; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block h-2 w-2 shrink-0 rounded-full', dotColour[dot], className)} />;
}

/**
 * A month of sessions with an agenda for the chosen day.
 *
 * The grid follows the ARIA date-grid pattern: one day is in the tab order,
 * arrow keys move a week or a day (crossing into the next month when they
 * must), Home/End go to the week's edges and Page Up/Down change month.
 * Moving focus also chooses the day, so the agenda below always describes
 * the square that has focus.
 */
export function BookingCalendar({
  events,
  todayKey,
  onOpen,
  idPrefix,
  label,
  emptyDayAction,
  openLabel,
}: {
  events: CalendarEvent[];
  todayKey: string;
  onOpen: (event: CalendarEvent) => void;
  idPrefix: string;
  label: string;
  emptyDayAction?: ReactNode;
  openLabel?: (event: CalendarEvent) => string;
}) {
  const [monthKey, setMonthKey] = useState(() => monthKeyOf(todayKey));
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [filters, setFilters] = useState<CalendarFilters>(emptyCalendarFilters);
  const focusPending = useRef(false);
  const gridRef = useRef<HTMLTableElement>(null);

  const options = useMemo(() => calendarFilterOptions(events), [events]);
  const visible = useMemo(() => filterCalendarEvents(events, filters), [events, filters]);
  const byDay = useMemo(() => groupEventsByDay(visible), [visible]);
  const weeks = useMemo(() => monthGrid(monthKey), [monthKey]);
  const headings = useMemo(() => weekdayHeadings(), []);
  const agenda = byDay.get(selectedKey) ?? [];
  const monthCount = visible.filter(event => monthKeyOf(event.dayKey) === monthKey).length;
  const filtering = calendarFiltersActive(filters);
  const presentDots = dotOrder.filter(dot => visible.some(event => event.dot === dot));

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${selectedKey}"]`)?.focus();
  }, [selectedKey, monthKey]);

  function choose(key: string, moveFocus: boolean) {
    focusPending.current = moveFocus;
    setSelectedKey(key);
    if (monthKeyOf(key) !== monthKey) setMonthKey(monthKeyOf(key));
  }

  function changeMonth(delta: number) {
    const next = shiftMonth(monthKey, delta);
    setMonthKey(next);
    setSelectedKey(monthKeyOf(todayKey) === next ? todayKey : `${next}-01`);
  }

  function goToday() {
    setMonthKey(monthKeyOf(todayKey));
    setSelectedKey(todayKey);
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>, key: string) {
    const fromWeekStart = (weekdayOf(key) + 6) % 7;
    const moves: Record<string, () => string> = {
      ArrowLeft: () => shiftDay(key, -1),
      ArrowRight: () => shiftDay(key, 1),
      ArrowUp: () => shiftDay(key, -7),
      ArrowDown: () => shiftDay(key, 7),
      Home: () => shiftDay(key, -fromWeekStart),
      End: () => shiftDay(key, 6 - fromWeekStart),
      PageUp: () => shiftMonthKeepingDay(key, -1),
      PageDown: () => shiftMonthKeepingDay(key, 1),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    choose(move(), true);
  }

  const titleId = `${idPrefix}-month`;
  const agendaId = `${idPrefix}-agenda`;
  return (
    <section aria-label={label} className="space-y-4">
      {(options.clubs.length > 1 || options.coaches.length > 1 || options.sports.length > 1) && (
        <Disclosure title="Filter calendar" summary="Narrow sessions by club, coach, or sport.">
        <fieldset>
          <legend className="sr-only">Filter the calendar</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {options.clubs.length > 1 && (
              <div>
                <label htmlFor={`${idPrefix}-club`} className="text-xs font-semibold text-[#465e4c]">Club</label>
                <select id={`${idPrefix}-club`} value={filters.club} onChange={(event) => setFilters(current => ({ ...current, club: event.target.value }))} className={cn(field, 'mt-2 w-full bg-white')}>
                  <option value="">All clubs</option>
                  {options.clubs.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            )}
            {options.coaches.length > 1 && (
              <div>
                <label htmlFor={`${idPrefix}-coach`} className="text-xs font-semibold text-[#465e4c]">Coach</label>
                <select id={`${idPrefix}-coach`} value={filters.coach} onChange={(event) => setFilters(current => ({ ...current, coach: event.target.value }))} className={cn(field, 'mt-2 w-full bg-white')}>
                  <option value="">All coaches</option>
                  {options.coaches.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            )}
            {options.sports.length > 1 && (
              <div>
                <label htmlFor={`${idPrefix}-sport`} className="text-xs font-semibold text-[#465e4c]">Sport</label>
                <select id={`${idPrefix}-sport`} value={filters.sport} onChange={(event) => setFilters(current => ({ ...current, sport: event.target.value }))} className={cn(field, 'mt-2 w-full bg-white')}>
                  <option value="">All sports</option>
                  {options.sports.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            )}
          </div>
          {filtering && (
            <button type="button" className={cn(compactButton, 'mt-3')} onClick={() => setFilters(emptyCalendarFilters)}>
              Clear calendar filters
            </button>
          )}
        </fieldset>
        </Disclosure>
      )}

      <div className={cn(panel, 'p-3 sm:p-5')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Previous month" onClick={() => changeMonth(-1)} className={cn('grid h-11 w-11 place-items-center rounded-full text-[#344d40] hover:bg-[#f0f4ec]', focusRing)}>
              <ChevronLeft size={19} aria-hidden="true" />
            </button>
            <h3 id={titleId} aria-live="polite" className="min-w-[9.5rem] text-center text-base font-semibold tracking-tight text-[#263e33]">
              {monthTitle(monthKey)}
            </h3>
            <button type="button" aria-label="Next month" onClick={() => changeMonth(1)} className={cn('grid h-11 w-11 place-items-center rounded-full text-[#344d40] hover:bg-[#f0f4ec]', focusRing)}>
              <ChevronRight size={19} aria-hidden="true" />
            </button>
          </div>
          <button type="button" className={compactButton} onClick={goToday} aria-label="Go to today">
            <CalendarDays size={14} aria-hidden="true" /> Today
          </button>
        </div>
        <p className="!mt-1 px-1 text-[11px] text-[#59675c]">
          {countSentence(monthCount)} this month{filtering ? ' with the current filters' : ''}.
        </p>

        <table ref={gridRef} role="grid" aria-labelledby={titleId} className="mt-3 w-full table-fixed border-collapse">
          <thead>
            <tr>
              {headings.map(heading => (
                <th key={heading.long} scope="col" className="pb-2 text-center text-[10px] font-semibold uppercase tracking-wide text-[#59675c]">
                  <abbr title={heading.long} className="no-underline">{heading.short}</abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map(week => (
              <tr key={week[0].key}>
                {week.map(day => {
                  const dayEvents = byDay.get(day.key) ?? [];
                  const selected = day.key === selectedKey;
                  const today = day.key === todayKey;
                  const dots = dayDots(dayEvents);
                  return (
                    <td key={day.key} role="gridcell" aria-selected={selected} className="p-0.5 align-top">
                      <button
                        type="button"
                        data-day={day.key}
                        tabIndex={selected ? 0 : -1}
                        aria-label={dayCellLabel(day.key, dayEvents.length, { today })}
                        aria-current={today ? 'date' : undefined}
                        aria-controls={agendaId}
                        onClick={() => choose(day.key, false)}
                        onKeyDown={(event) => handleKey(event, day.key)}
                        className={cn(
                          'flex h-14 w-full flex-col items-center justify-start gap-1 rounded-xl pt-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]',
                          selected ? 'bg-[#174c3c] font-semibold text-white' : day.inMonth ? 'text-[#263e33] hover:bg-[#f0f4ec]' : 'text-[#637363] hover:bg-[#f6f8f3]',
                          today && !selected && 'ring-1 ring-inset ring-[#174c3c]',
                        )}
                      >
                        <span aria-hidden="true">{day.dayOfMonth}</span>
                        {dots.length > 0 && (
                          <span aria-hidden="true" className="flex items-center gap-0.5">
                            {dots.slice(0, 3).map(dot => (
                              <Dot key={dot} dot={dot} className={selected ? 'ring-1 ring-white' : undefined} />
                            ))}
                          </span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {presentDots.length > 0 && (
          <ul aria-label="Calendar key" className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 px-1">
            {presentDots.map(dot => (
              <li key={dot} className="inline-flex items-center gap-1.5 text-[11px] text-[#59675c]">
                <Dot dot={dot} /> {dotLabels[dot]}
              </li>
            ))}
          </ul>
        )}
      </div>

      <section id={agendaId} aria-labelledby={`${agendaId}-heading`} className={cn(panel, 'p-4 sm:p-5')}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={`${agendaId}-heading`} className="text-base font-semibold tracking-tight text-[#263e33]">
            {dayLabel(selectedKey)}
          </h3>
          <span className="text-xs text-[#59675c]">{countSentence(agenda.length)}</span>
        </div>
        {agenda.length ? (
          <ul className="mt-3 space-y-2">
            {agenda.map(event => (
              <li key={event.id}>
                <button
                  type="button"
                  onClick={() => onOpen(event)}
                  aria-label={openLabel ? openLabel(event) : `Open details for ${event.title} at ${event.clubName}`}
                  className="flex w-full items-start gap-3 rounded-xl border border-[#e8ece5] bg-white p-3 text-left transition hover:bg-[#fafbf7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]"
                >
                  <Dot dot={event.dot} className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold text-[#294536]">{event.title}</span>
                      <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-medium', statusClass(event.statusLabel))}>{event.statusLabel}</span>
                    </span>
                    <span className="mt-1 block text-xs text-[#59675c]">
                      {time(event.startAt, event.timezone)} – {time(event.endAt, event.timezone)} · {event.clubName}
                    </span>
                    <span className="mt-0.5 block text-xs text-[#59675c]">
                      {event.coachName}{event.locationName ? ` · ${event.locationName}` : ''}
                    </span>
                  </span>
                  <ChevronRight size={16} aria-hidden="true" className="mt-1 shrink-0 text-[#59675c]" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-3 rounded-xl border border-dashed border-[#dfe5dc] bg-[#fafbf8] px-4 py-6 text-center">
            <p className="text-xs text-[#59675c]">
              {filtering ? 'Nothing on this day matches the calendar filters.' : 'Nothing booked on this day.'}
            </p>
            {emptyDayAction && !filtering && selectedKey >= todayKey && <div className="mt-3">{emptyDayAction}</div>}
          </div>
        )}
      </section>
    </section>
  );
}
