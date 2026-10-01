import { describe, expect, it } from 'vitest';
import {
  normalizeRecentSearch, readRecentSearches, RECENT_SEARCH_LIMIT, recentSearchesKey, recentSearchLabel, rememberSearch,
  writeRecentSearches, type RecentSearch,
} from '../src/lib/recent-searches';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const search = (overrides: Partial<RecentSearch> = {}): RecentSearch => ({
  sport: 'Tennis', timeOfDay: 'evening', type: 'any', area: '', q: '', ...overrides,
});

describe('recent searches', () => {
  it('keeps the newest five, de-duplicated without regard to case', () => {
    let list: RecentSearch[] = [];
    for (const sport of ['Tennis', 'Badminton', 'Squash', 'Padel', 'Pickleball', 'Table tennis']) list = rememberSearch(list, search({ sport }));
    expect(list).toHaveLength(RECENT_SEARCH_LIMIT);
    expect(list[0].sport).toBe('Table tennis');
    expect(list.map(item => item.sport)).not.toContain('Tennis');
    list = rememberSearch(list, search({ sport: 'squash' }));
    expect(list[0].sport).toBe('squash');
    expect(list.filter(item => item.sport.toLowerCase() === 'squash')).toHaveLength(1);
  });

  it('does not remember an empty search', () => {
    const empty = search({ sport: '', timeOfDay: 'any' });
    expect(rememberSearch([], empty)).toEqual([]);
    expect(normalizeRecentSearch(empty)).toBeNull();
  });

  it('round-trips through namespaced per-account storage', () => {
    const storage = new MemoryStorage();
    const list = rememberSearch([], search({ area: 'Tampines' }));
    expect(writeRecentSearches('user-1', list, storage)).toBe(true);
    expect(storage.values.has(recentSearchesKey('user-1'))).toBe(true);
    expect(recentSearchesKey('user-1')).toBe('courtly:student:recent-searches:user-1');
    expect(readRecentSearches('user-1', storage)).toEqual(list);
    expect(readRecentSearches('user-2', storage)).toEqual([]);
    writeRecentSearches('user-1', [], storage);
    expect(storage.values.has(recentSearchesKey('user-1'))).toBe(false);
  });

  it('survives corrupt, tampered or blocked storage', () => {
    const storage = new MemoryStorage();
    storage.setItem(recentSearchesKey('user-1'), '{not json');
    expect(readRecentSearches('user-1', storage)).toEqual([]);
    storage.setItem(recentSearchesKey('user-1'), JSON.stringify([
      { sport: 'Tennis', timeOfDay: 'midnight', type: 'VIP', area: 7 },
      'junk',
      { sport: 'tennis', timeOfDay: 'any', type: 'any' },
      { sport: 'x'.repeat(200) },
    ]));
    const read = readRecentSearches('user-1', storage);
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual({ sport: 'Tennis', timeOfDay: 'any', type: 'any', area: '', q: '' });
    expect(read[1].sport).toHaveLength(60);
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(readRecentSearches('user-1', blocked)).toEqual([]);
    expect(writeRecentSearches('user-1', [search()], blocked)).toBe(false);
  });

  it('labels a search in plain words', () => {
    expect(recentSearchLabel(search({ type: 'GROUP', area: 'Tampines', q: 'Riverside' }))).toBe('Tennis · Evening · Group · Tampines · “Riverside”');
    expect(recentSearchLabel(search({ sport: '', timeOfDay: 'any', area: 'Jurong' }))).toBe('Any sport · Jurong');
  });
});
