import { clsx, type ClassValue } from 'clsx';
import { addDays, addWeeks } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const money = (value: number, currency = 'SGD') => new Intl.NumberFormat('en-SG', { style: 'currency', currency, maximumFractionDigits: value % 100 === 0 ? 0 : 2 }).format(value / 100);
export const dateKey = (value: Date | string = new Date(), timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'yyyy-MM-dd');
export const time = (value: Date | string, timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'h:mm a');
export const shortDate = (value: Date | string, timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'EEE, d MMM');
/** Match the backend's calendar-week recurrence in the business timezone. */
export function addCalendarWeeks(value: Date | string, weeks: number, timezone: string) {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return new Date(Number.NaN);
  return fromZonedTime(addWeeks(toZonedTime(date, timezone), weeks), timezone);
}
export function coversWeeklyOccurrences(
  expiresAt: Date | string, startAt: Date | string, occurrences: number, timezone: string, now = Date.now(),
) {
  const expiry = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt;
  const lastStart = addCalendarWeeks(startAt, Math.max(0, occurrences - 1), timezone);
  return occurrences >= 1 && Number.isFinite(expiry.getTime()) && Number.isFinite(lastStart.getTime())
    && expiry.getTime() >= now && lastStart.getTime() <= expiry.getTime();
}
// Kept in step with `initials` in backend/src/http.ts. Parenthesized text is
// descriptive rather than part of a person's name, so complete and unfinished
// qualifiers are removed before reading the first two words.
export function initials(name: string) {
  const normalized = name.normalize('NFC');
  const withoutQualifiers = normalized.replace(/[(（][^)）]*(?:[)）]|$)/gu, ' ');
  const words = withoutQualifiers
    .split(/\s+/)
    .map(word => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(word => word.length > 0);
  const letters = words.slice(0, 2).map(word => [...word][0]).join('');
  return (letters || [...withoutQualifiers].find(character => /[\p{L}\p{N}]/u.test(character)) || '?').toUpperCase();
}
export function endOfDateKey(key: string, timezone = 'Asia/Singapore') {
  return fromZonedTime(new Date(`${key}T23:59:59`), timezone);
}
export function addDaysKey(key: string, days: number, timezone = 'Asia/Singapore') {
  const zoned = new Date(`${key}T12:00:00`);
  return dateKey(fromZonedTime(addDays(zoned, days), timezone), timezone);
}
