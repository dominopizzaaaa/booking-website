import { dayKeyFor, dayLabel, shiftDay } from './student-calendar';
import type { RecentSearch } from './recent-searches';
import type { SessionSearchFilters, SessionSearchResult } from './types';

/** The server accepts a search date from today to 60 days ahead. */
export const SEARCH_WINDOW_DAYS = 60;

export function searchDateBounds(todayKey: string) {
  return { min: todayKey, max: shiftDay(todayKey, SEARCH_WINDOW_DAYS) };
}

export type FindTimeForm = RecentSearch & { date: string };

/** Only the filters someone actually chose go on the wire. */
export function buildSearchFilters(form: FindTimeForm): SessionSearchFilters {
  const filters: SessionSearchFilters = { date: form.date };
  if (form.sport.trim()) filters.sport = form.sport.trim();
  if (form.timeOfDay !== 'any') filters.timeOfDay = form.timeOfDay;
  if (form.type !== 'any') filters.type = form.type;
  if (form.area.trim()) filters.area = form.area.trim();
  if (form.q.trim()) filters.q = form.q.trim();
  return filters;
}

export type SearchResultGroup = {
  dayKey: string;
  label: string;
  times: Array<{ startAt: string; results: SessionSearchResult[] }>;
};

/**
 * Results grouped by the club-local day and then by start time, so several
 * Classes at 6 pm read as one moment with choices rather than a long list.
 * Within a time the cheaper option comes first, matching the server order.
 */
export function groupSearchResults(results: SessionSearchResult[]): SearchResultGroup[] {
  const sorted = [...results].sort((a, b) =>
    new Date(a.startAt).getTime() - new Date(b.startAt).getTime() || a.price - b.price);
  const groups: SearchResultGroup[] = [];
  for (const result of sorted) {
    const dayKey = dayKeyFor(result.startAt, result.business.timezone);
    if (!dayKey) continue;
    let group = groups.find(candidate => candidate.dayKey === dayKey);
    if (!group) {
      group = { dayKey, label: dayLabel(dayKey), times: [] };
      groups.push(group);
    }
    const moment = group.times.find(candidate => candidate.startAt === result.startAt);
    if (moment) moment.results.push(result);
    else group.times.push({ startAt: result.startAt, results: [result] });
  }
  return groups.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

/** Only group Classes have places to count; a private lesson is simply available. */
export function placesText(result: Pick<SessionSearchResult, 'service' | 'placesRemaining'>) {
  if (result.service.type !== 'GROUP') return '';
  const places = Math.max(0, result.placesRemaining);
  return places === 1 ? '1 place left' : `${places} places left`;
}

export function resultCountText(count: number, truncated: boolean) {
  if (count === 0) return 'No open sessions found';
  const base = count === 1 ? '1 open session found' : `${count} open sessions found`;
  return truncated ? `${base} (showing the first ${count})` : base;
}

/** Optimistic saved-club toggle; returns a new set so React state stays immutable. */
export function withFavorite(favorites: ReadonlySet<string>, slug: string, saved: boolean) {
  const next = new Set(favorites);
  if (saved) next.add(slug);
  else next.delete(slug);
  return next;
}
