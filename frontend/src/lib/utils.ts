import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatInTimeZone } from 'date-fns-tz';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const money = (value: number, currency = 'SGD') => new Intl.NumberFormat('en-SG', { style: 'currency', currency, maximumFractionDigits: value % 100 === 0 ? 0 : 2 }).format(value / 100);
export const dateKey = (value: Date | string = new Date(), timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'yyyy-MM-dd');
export const time = (value: Date | string, timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'h:mm a');
export const shortDate = (value: Date | string, timezone = 'Asia/Singapore') => formatInTimeZone(value, timezone, 'EEE, d MMM');
export function initials(name: string) { return name.trim().split(/\s+/).map(n => n[0]).slice(0, 2).join('').toUpperCase(); }
export function addDaysKey(key: string, days: number) { const d = new Date(`${key}T12:00:00+08:00`); d.setUTCDate(d.getUTCDate() + days); return dateKey(d); }
