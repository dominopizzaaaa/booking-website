'use client';

import Link from 'next/link';
import { ArrowRight, CalendarSearch, History, LoaderCircle, MapPin, Search, UsersRound, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { searchSessions } from '@/lib/api';
import { searchResultHref } from '@/lib/booking-links';
import {
  classTypeLabel, readRecentSearches, recentSearchLabel, rememberSearch, timeOfDayLabel, writeRecentSearches,
  type RecentSearch,
} from '@/lib/recent-searches';
import {
  buildSearchFilters, groupSearchResults, placesText, resultCountText, searchDateBounds, type FindTimeForm,
} from '@/lib/session-search';
import { shiftDay } from '@/lib/student-calendar';
import type { SessionSearchResponse, SessionTimeOfDay } from '@/lib/types';
import { cn, money, time } from '@/lib/utils';
import { Disclosure } from '@/components/ui/progressive-disclosure';
import { ErrorNotice } from './shared';
import { compactButton, eyebrow, field, panel, primaryButton } from './styles';

const timesOfDay: SessionTimeOfDay[] = ['any', 'morning', 'afternoon', 'evening'];
const classTypes: FindTimeForm['type'][] = ['any', 'PRIVATE', 'GROUP'];

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

/**
 * Availability-first search: pick a day and the kind of session, and see
 * real open times across every club. Every result comes from the same slot
 * rules as the club's own booking page, and each one links straight to that
 * page with the Class, coach, venue and time already chosen.
 */
export function FindATime({
  userId,
  todayKey,
  sports,
}: {
  userId: string;
  todayKey: string;
  sports: Array<{ key: string; label: string }>;
}) {
  const bounds = searchDateBounds(todayKey);
  const [form, setForm] = useState<FindTimeForm>({ date: todayKey, sport: '', timeOfDay: 'any', type: 'any', area: '', q: '' });
  const [results, setResults] = useState<SessionSearchResponse | null>(null);
  const [searchedDate, setSearchedDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const requestRef = useRef(0);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { setRecents(readRecentSearches(userId)); }, [userId]);

  async function run(values: FindTimeForm) {
    if (values.date < bounds.min || values.date > bounds.max) {
      setError(`Choose a date between today and ${bounds.max}.`);
      return;
    }
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const value = await searchSessions(buildSearchFilters(values));
      if (requestRef.current !== request) return;
      setResults(value);
      setSearchedDate(values.date);
      const next = rememberSearch(recents, values);
      setRecents(next);
      writeRecentSearches(userId, next);
      window.requestAnimationFrame(() => resultsHeadingRef.current?.focus({ preventScroll: false }));
    } catch (caught) {
      if (requestRef.current === request) {
        setResults(null);
        setError(messageOf(caught));
      }
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(form);
  }

  function update<K extends keyof FindTimeForm>(key: K, value: FindTimeForm[K]) {
    setForm(current => ({ ...current, [key]: value }));
  }

  function applyRecent(search: RecentSearch) {
    const next = { ...search, date: form.date };
    setForm(next);
    void run(next);
  }

  function clearRecents() {
    setRecents([]);
    writeRecentSearches(userId, []);
  }

  function retry(change: Partial<FindTimeForm>) {
    const next = { ...form, ...change };
    setForm(next);
    void run(next);
  }

  const groups = results ? groupSearchResults(results.results) : [];
  const nextDay = shiftDay(form.date, 1);
  return (
    <section id="student-find-time" aria-labelledby="student-find-time-heading" className={cn(panel, 'mt-6 scroll-mt-24 p-4 sm:p-5')}>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eef3e8] text-[#4f6847]"><CalendarSearch size={18} aria-hidden="true" /></span>
        <div>
          <p className={eyebrow}>Across every club</p>
          <h2 id="student-find-time-heading" tabIndex={-1} className="!mt-1 text-lg font-semibold tracking-tight text-[#304b39] outline-none">Find a time</h2>
          <p className="!mt-1 text-xs leading-relaxed text-[#59675c]">Choose a day and see open sessions you can book right now.</p>
        </div>
      </div>

      <form onSubmit={submit} noValidate className="mt-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="find-time-date" className="text-xs font-semibold text-[#465e4c]">Date</label>
            <input id="find-time-date" type="date" required min={bounds.min} max={bounds.max} value={form.date} onChange={(event) => update('date', event.target.value)} className={cn(field, 'mt-2 w-full')} />
          </div>
          <div>
            <label htmlFor="find-time-sport" className="text-xs font-semibold text-[#465e4c]">Sport</label>
            <select id="find-time-sport" value={form.sport} onChange={(event) => update('sport', event.target.value)} className={cn(field, 'mt-2 w-full bg-white')}>
              <option value="">Any sport</option>
              {sports.map(sport => <option key={sport.key} value={sport.label}>{sport.label}</option>)}
            </select>
          </div>
        </div>
        <Disclosure title="More filters" summary="Time, Class type, area, or club" className="mt-3">
          <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="find-time-time" className="text-xs font-semibold text-[#465e4c]">Time of day</label>
            <select id="find-time-time" value={form.timeOfDay} onChange={(event) => update('timeOfDay', event.target.value as SessionTimeOfDay)} className={cn(field, 'mt-2 w-full bg-white')} aria-describedby="find-time-time-hint">
              {timesOfDay.map(value => <option key={value} value={value}>{timeOfDayLabel(value)}</option>)}
            </select>
            <p id="find-time-time-hint" className="!mt-1 text-[10px] text-[#59675c]">Morning 5 am–12 pm · afternoon 12–5 pm · evening 5–11 pm, club time.</p>
          </div>
          <div>
            <label htmlFor="find-time-type" className="text-xs font-semibold text-[#465e4c]">Class type</label>
            <select id="find-time-type" value={form.type} onChange={(event) => update('type', event.target.value as FindTimeForm['type'])} className={cn(field, 'mt-2 w-full bg-white')}>
              {classTypes.map(value => <option key={value} value={value}>{value === 'any' ? 'Private or group' : `${classTypeLabel(value)} Classes`}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="find-time-area" className="text-xs font-semibold text-[#465e4c]">Area</label>
            <input id="find-time-area" type="search" maxLength={60} value={form.area} onChange={(event) => update('area', event.target.value)} placeholder="e.g. Tampines" className={cn(field, 'mt-2 w-full')} />
          </div>
          <div>
            <label htmlFor="find-time-keyword" className="text-xs font-semibold text-[#465e4c]">Club name</label>
            <input id="find-time-keyword" type="search" maxLength={60} value={form.q} onChange={(event) => update('q', event.target.value)} placeholder="Optional" className={cn(field, 'mt-2 w-full')} />
          </div>
          </div>
        </Disclosure>
        <button type="submit" className={cn(primaryButton, 'mt-4 w-full sm:w-auto')} disabled={loading}>
          {loading ? <LoaderCircle size={15} className="animate-spin" /> : <Search size={15} aria-hidden="true" />} Find times
        </button>
      </form>

      {recents.length > 0 && (
        <Disclosure title="Recent searches" summary={`${recents.length} saved on this device`} className="mt-4">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#465e4c]"><History size={13} aria-hidden="true" /> Search again</span>
            <button type="button" className="min-h-10 text-[11px] font-semibold text-[#174c3c] underline underline-offset-2" onClick={clearRecents}>Clear recent searches</button>
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {recents.map(search => {
              const label = recentSearchLabel(search);
              return (
                <li key={label}>
                  <button type="button" className={compactButton} onClick={() => applyRecent(search)} aria-label={`Search again: ${label}`}>
                    {label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        </Disclosure>
      )}

      {error && <div className="mt-4"><ErrorNotice message={error} /></div>}

      {results && (
        <section aria-labelledby="find-time-results-heading" aria-busy={loading} className="mt-5 border-t border-[#edf0e8] pt-4">
          <h3 id="find-time-results-heading" ref={resultsHeadingRef} tabIndex={-1} className="text-sm font-semibold text-[#304b39] outline-none">
            Open sessions
          </h3>
          <p role="status" aria-live="polite" className="!mt-1 text-xs text-[#59675c]">{resultCountText(results.results.length, results.truncated)}</p>
          {results.truncated && (
            <p className="!mt-2 rounded-xl bg-[#fcf8ec] p-3 text-xs leading-relaxed text-[#70582e]">
              There are more open sessions than we can show at once. Add a sport, time of day or area to narrow the list.
            </p>
          )}
          {groups.length === 0 ? (
            <div className="mt-3 rounded-xl border border-dashed border-[#dfe5dc] bg-[#fafbf8] p-5 text-center">
              <p className="text-sm text-[#415244]">Nothing is open for this search.</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {form.timeOfDay !== 'any' && <button type="button" className={compactButton} onClick={() => retry({ timeOfDay: 'any' })}>Try any time of day</button>}
                {(form.area || form.q) && <button type="button" className={compactButton} onClick={() => retry({ area: '', q: '' })}><X size={13} aria-hidden="true" /> Remove area and club</button>}
                {nextDay <= bounds.max && <button type="button" className={compactButton} onClick={() => retry({ date: nextDay })}>Search the next day</button>}
              </div>
            </div>
          ) : (
            <div className="mt-3 space-y-5">
              {groups.map(group => (
                <section key={group.dayKey} aria-labelledby={`find-time-day-${group.dayKey}`}>
                  <h4 id={`find-time-day-${group.dayKey}`} className="text-xs font-semibold uppercase tracking-wide text-[#59675c]">{group.label}</h4>
                  <ul className="mt-2 space-y-2">
                    {group.times.flatMap(moment => moment.results).map(result => {
                      const zone = result.business.timezone;
                      const places = placesText(result);
                      const at = time(result.startAt, zone);
                      return (
                        <li key={`${result.business.slug}-${result.service.id}-${result.instructor.id}-${result.location.id}-${result.startAt}`}>
                          <article className="flex flex-col gap-3 rounded-xl border border-[#e4e9df] bg-white p-3 sm:flex-row sm:items-center">
                            <div className="flex min-w-0 flex-1 items-start gap-3">
                              <span className="grid min-w-[4.5rem] shrink-0 place-items-center rounded-lg bg-[#edf2e7] px-2 py-1.5 text-xs font-bold text-[#34533e]">{at}</span>
                              <div className="min-w-0">
                                <h5 className="text-sm font-semibold text-[#304b39]">{result.service.name}</h5>
                                <p className="!mt-0.5 text-xs text-[#59675c]">{result.business.name} · {result.instructor.name}</p>
                                <p className="!mt-0.5 flex items-start gap-1 text-xs text-[#59675c]">
                                  <MapPin size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                                  <span>{result.location.name}{result.location.area ? ` · ${result.location.area}` : ''}</span>
                                </p>
                                <p className="!mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                  <span className="font-semibold text-[#34533e]">{money(result.price, result.business.currency)}</span>
                                  <span className="text-[#59675c]">{result.service.duration} min · {result.service.type === 'GROUP' ? 'Group' : 'Private'}</span>
                                  {places && <span className="inline-flex items-center gap-1 text-[#59675c]"><UsersRound size={12} aria-hidden="true" /> {places}</span>}
                                </p>
                              </div>
                            </div>
                            <Link
                              href={searchResultHref(result, searchedDate)}
                              className={cn(compactButton, '!min-h-11 shrink-0 self-start sm:self-center')}
                              aria-label={`Book ${result.service.name} at ${result.business.name}, ${group.label} at ${at}`}
                            >
                              Book <ArrowRight size={13} aria-hidden="true" />
                            </Link>
                          </article>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
