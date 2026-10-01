import type { SessionTimeOfDay } from './types';

/**
 * The last few "Find a time" searches, remembered per account in this browser
 * only. The date is deliberately not kept: yesterday's date is never the one
 * someone wants back, while "Tennis, evenings, near Tampines" usually is.
 */
export type RecentSearch = {
  sport: string;
  timeOfDay: SessionTimeOfDay;
  type: 'any' | 'PRIVATE' | 'GROUP';
  area: string;
  q: string;
};

export const RECENT_SEARCH_LIMIT = 5;
const MAX_TEXT = 60;
const timesOfDay: SessionTimeOfDay[] = ['any', 'morning', 'afternoon', 'evening'];
const classTypes: RecentSearch['type'][] = ['any', 'PRIVATE', 'GROUP'];

export function recentSearchesKey(userId: string) {
  return `courtly:student:recent-searches:${userId}`;
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT) : '';
}

/** Accept only well-formed entries; storage is user-editable and may be stale. */
export function normalizeRecentSearch(value: unknown): RecentSearch | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const timeOfDay = timesOfDay.includes(record.timeOfDay as SessionTimeOfDay) ? record.timeOfDay as SessionTimeOfDay : 'any';
  const type = classTypes.includes(record.type as RecentSearch['type']) ? record.type as RecentSearch['type'] : 'any';
  const search = { sport: text(record.sport), timeOfDay, type, area: text(record.area), q: text(record.q) };
  return isEmptySearch(search) ? null : search;
}

export function isEmptySearch(search: RecentSearch) {
  return !search.sport && search.timeOfDay === 'any' && search.type === 'any' && !search.area && !search.q;
}

function signature(search: RecentSearch) {
  return [search.sport, search.timeOfDay, search.type, search.area, search.q].map(value => value.toLowerCase()).join('|');
}

/** Newest first, de-duplicated without regard to case, capped at five. */
export function rememberSearch(list: RecentSearch[], search: RecentSearch): RecentSearch[] {
  const next = normalizeRecentSearch(search);
  if (!next) return list.slice(0, RECENT_SEARCH_LIMIT);
  const key = signature(next);
  return [next, ...list.filter(item => signature(item) !== key)].slice(0, RECENT_SEARCH_LIMIT);
}

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>;

function browserStorage() {
  return typeof window === 'undefined' ? undefined : window.localStorage;
}

export function readRecentSearches(userId: string, storage?: ReadableStorage): RecentSearch[] {
  try {
    const raw = (storage ?? browserStorage())?.getItem(recentSearchesKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Stored newest first; keep the first copy of any repeated search.
    const seen = new Set<string>();
    const list: RecentSearch[] = [];
    for (const item of parsed) {
      const search = normalizeRecentSearch(item);
      if (!search || seen.has(signature(search))) continue;
      seen.add(signature(search));
      list.push(search);
    }
    return list.slice(0, RECENT_SEARCH_LIMIT);
  } catch {
    return [];
  }
}

export function writeRecentSearches(userId: string, list: RecentSearch[], storage?: WritableStorage) {
  try {
    const target = storage ?? browserStorage();
    if (!target) return false;
    if (list.length === 0) target.removeItem(recentSearchesKey(userId));
    else target.setItem(recentSearchesKey(userId), JSON.stringify(list.slice(0, RECENT_SEARCH_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

export function timeOfDayLabel(value: SessionTimeOfDay) {
  if (value === 'morning') return 'Morning';
  if (value === 'afternoon') return 'Afternoon';
  if (value === 'evening') return 'Evening';
  return 'Any time';
}

export function classTypeLabel(value: RecentSearch['type']) {
  if (value === 'PRIVATE') return 'Private';
  if (value === 'GROUP') return 'Group';
  return 'Any Class';
}

/** "Tennis · Evening · Group · Tampines · “Riverside”". */
export function recentSearchLabel(search: RecentSearch) {
  return [
    search.sport || 'Any sport',
    search.timeOfDay !== 'any' ? timeOfDayLabel(search.timeOfDay) : '',
    search.type !== 'any' ? classTypeLabel(search.type) : '',
    search.area,
    search.q ? `“${search.q}”` : '',
  ].filter(Boolean).join(' · ');
}
