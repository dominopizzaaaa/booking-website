import { describe, expect, it } from 'vitest';
import { addDaysKey, cn, dateKey, initials, money, shortDate, time } from '../src/lib/utils';

// Money is integer minor units everywhere in Courtly. These assertions exist
// because a float slipping into this helper is invisible until a receipt is
// wrong by a cent.
describe('money', () => {
  it('renders whole dollars without cents and part-dollars with them', () => {
    expect(money(8000)).toBe('$80');
    expect(money(8050)).toBe('$80.50');
  });

  it('formats zero and keeps large amounts grouped', () => {
    expect(money(0)).toBe('$0');
    expect(money(123456789)).toBe('$1,234,567.89');
  });

  it('honours the business currency rather than assuming Singapore dollars', () => {
    expect(money(2500, 'USD')).toContain('25');
    expect(money(2500, 'USD')).not.toBe(money(2500, 'SGD'));
  });

  it('keeps a negative correction readable', () => {
    expect(money(-8000)).toContain('80');
    expect(money(-8000).startsWith('-')).toBe(true);
  });
});

describe('date helpers', () => {
  // A booking made at 23:00 in Singapore is still "today" there while UTC has
  // already rolled over. Every day-grouping in both apps depends on this.
  it('keys a date by the business timezone, not the host clock', () => {
    expect(dateKey('2026-03-01T16:30:00.000Z')).toBe('2026-03-02');
    expect(dateKey('2026-03-01T16:30:00.000Z', 'UTC')).toBe('2026-03-01');
  });

  it('formats times and short dates in the business timezone', () => {
    expect(time('2026-03-01T02:00:00.000Z')).toBe('10:00 AM');
    expect(time('2026-03-01T02:00:00.000Z', 'UTC')).toBe('2:00 AM');
    expect(shortDate('2026-03-01T02:00:00.000Z')).toBe('Sun, 1 Mar');
  });

  it('accepts a Date as readily as an ISO string', () => {
    expect(dateKey(new Date('2026-03-01T16:30:00.000Z'))).toBe('2026-03-02');
  });

  it('steps day keys forwards and backwards across month and year ends', () => {
    expect(addDaysKey('2026-03-01', 1)).toBe('2026-03-02');
    expect(addDaysKey('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysKey('2026-03-01', 0)).toBe('2026-03-01');
  });

  it('steps a whole week without drifting', () => {
    expect(addDaysKey('2026-03-01', 7)).toBe('2026-03-08');
    expect(addDaysKey(addDaysKey('2026-03-01', 7), -7)).toBe('2026-03-01');
  });

  it('handles a leap day', () => {
    expect(addDaysKey('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysKey('2028-02-29', 1)).toBe('2028-03-01');
  });
});

// This must stay in step with `initials` in backend/src/http.ts: the avatar the
// server stores and the one the browser draws have to agree.
describe('initials', () => {
  it('reads the first letter of the first two words', () => {
    expect(initials('Marcus Tan')).toBe('MT');
    expect(initials('Marcus Wei Tan')).toBe('MW');
    expect(initials('Marcus')).toBe('M');
  });

  it('drops a parenthesised role qualifier, finished or not', () => {
    expect(initials('Dominic (Coach)')).toBe('D');
    expect(initials('Dominic (Coach')).toBe('D');
    expect(initials('Dominic （教练）')).toBe('D');
    expect(initials('(Coach) Dominic Koh')).toBe('DK');
  });

  it('keeps punctuation inside a real name', () => {
    expect(initials('Mary-Jane Watson')).toBe('MW');
    expect(initials("O'Brien Smith")).toBe('OS');
  });

  it('ignores leading punctuation and collapsed whitespace', () => {
    expect(initials('  ...Marcus   Tan  ')).toBe('MT');
  });

  it('falls back to any letter or digit, then to a question mark', () => {
    expect(initials('(Coach)')).toBe('?');
    expect(initials('   ')).toBe('?');
    expect(initials('!!!')).toBe('?');
    expect(initials('7 Academy')).toBe('7A');
  });

  it('handles non-Latin scripts and characters outside the basic plane', () => {
    expect(initials('陈 伟')).toBe('陈伟');
    expect(initials('Иван Петров')).toBe('ИП');
    expect(initials('𝒜lice Smith')).toBe('𝒜S');
  });
});

describe('cn', () => {
  it('merges conflicting Tailwind utilities so the last one wins', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('drops falsy branches instead of emitting empty classes', () => {
    expect(cn('rounded', false && 'hidden', undefined, 'p-2')).toBe('rounded p-2');
  });
});
