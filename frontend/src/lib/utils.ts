import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatInTimeZone } from 'date-fns-tz';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const money = (value: number, currency = 'SGD') => new Intl.NumberFormat('en-SG', { style: 'currency', currency, maximumFractionDigits: value % 100 === 0 ? 0 : 2 }).format(value / 100);
export const dateKey = (value: Date | string = new Date(), timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'yyyy-MM-dd');
export const time = (value: Date | string, timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'h:mm a');
export const shortDate = (value: Date | string, timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'EEE, d MMM');
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
export function addDaysKey(key: string, days: number) { const d = new Date(`${key}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return dateKey(d); }
