import type { FeedbackAuthorRole, LearnerFeedback, ProgressFilters, ProgressSummary } from './types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM' → "Oct" or "October 2026"; anything else is returned unchanged. */
export function monthLabel(monthKey: string, style: 'short' | 'long' = 'short') {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  const index = match ? Number(match[2]) - 1 : -1;
  if (!match || index < 0 || index > 11) return monthKey;
  return style === 'short' ? MONTHS[index].slice(0, 3) : `${MONTHS[index]} ${match[1]}`;
}

export type MonthlyBar = { month: string; label: string; longLabel: string; attended: number; percent: number };

/**
 * Bars scale against the busiest month so the shape is readable, and the
 * same numbers are returned as a sentence for people who cannot see the
 * chart. A zero month keeps a zero-height bar rather than disappearing, so
 * gaps in training read as gaps.
 */
export function monthlyChart(monthly: ProgressSummary['monthly']) {
  const rows = [...monthly].sort((a, b) => a.month.localeCompare(b.month));
  const max = rows.reduce((value, row) => Math.max(value, row.attended), 0);
  const bars: MonthlyBar[] = rows.map(row => ({
    month: row.month,
    label: monthLabel(row.month, 'short'),
    longLabel: monthLabel(row.month, 'long'),
    attended: row.attended,
    percent: max === 0 ? 0 : Math.round((row.attended / max) * 100),
  }));
  const total = rows.reduce((value, row) => value + row.attended, 0);
  const summary = bars.length === 0
    ? 'No monthly attendance yet.'
    : `Sessions attended per month: ${bars.map(bar => `${bar.longLabel}, ${bar.attended}`).join('; ')}.`;
  return { bars, max, total, summary };
}

export function streakText(weeks: number) {
  if (!Number.isFinite(weeks) || weeks <= 0) return 'No current streak';
  return weeks === 1 ? '1-week streak' : `${weeks}-week streak`;
}

export function weeksText(weeks: number) {
  const value = Number.isFinite(weeks) && weeks > 0 ? Math.floor(weeks) : 0;
  return value === 1 ? '1 week' : `${value} weeks`;
}

/** The server sends a 0–1 ratio, or null when nothing has been marked yet. */
export function attendanceRateText(rate: number | null | undefined) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return 'Not enough data yet';
  const percent = rate <= 1 ? rate * 100 : rate;
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

export function hoursText(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) return '0 hours';
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} hour${rounded === 1 ? '' : 's'}`;
}

export function authorRoleLabel(role: FeedbackAuthorRole) {
  if (role === 'CLUB') return 'Club';
  if (role === 'STAFF') return 'Club staff';
  return 'Coach';
}

export type FeedbackField = { key: 'summary' | 'strengths' | 'focusAreas' | 'nextGoal'; label: string; text: string };

/** The parts of a coach's note that were actually written, in reading order. */
export function feedbackFields(item: Pick<LearnerFeedback, 'summary' | 'strengths' | 'focusAreas' | 'nextGoal'>): FeedbackField[] {
  const fields: FeedbackField[] = [
    { key: 'summary', label: 'Summary', text: item.summary },
    { key: 'strengths', label: 'What went well', text: item.strengths },
    { key: 'focusAreas', label: 'What to work on', text: item.focusAreas },
    { key: 'nextGoal', label: 'Next goal', text: item.nextGoal },
  ];
  return fields.map(field => ({ ...field, text: (field.text ?? '').trim() })).filter(field => field.text.length > 0);
}

export function feedbackPreview(item: Pick<LearnerFeedback, 'summary' | 'strengths' | 'focusAreas' | 'nextGoal'>, max = 140) {
  const text = feedbackFields(item)[0]?.text ?? '';
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1)).trimEnd()}…` : flat;
}

/** Newest shared note first; the server already orders, but a client filter must not depend on it. */
export function latestFeedback<T extends Pick<LearnerFeedback, 'sharedAt'>>(feedback: T[]): T | null {
  return [...feedback].sort((a, b) => new Date(b.sharedAt).getTime() - new Date(a.sharedAt).getTime())[0] ?? null;
}

export function cleanProgressFilters(filters: ProgressFilters): ProgressFilters {
  const cleaned: ProgressFilters = {};
  if (filters.businessSlug?.trim()) cleaned.businessSlug = filters.businessSlug.trim();
  if (filters.coach?.trim()) cleaned.coach = filters.coach.trim();
  if (filters.sport?.trim()) cleaned.sport = filters.sport.trim();
  return cleaned;
}

export function progressFiltersActive(filters: ProgressFilters) {
  return Object.keys(cleanProgressFilters(filters)).length > 0;
}

/** Client-side equivalent of the learner filters, for projections that do not accept them. */
export function filterFeedback<T extends Pick<LearnerFeedback, 'business' | 'coachName' | 'sport'>>(feedback: T[], filters: ProgressFilters) {
  const { businessSlug, coach, sport } = cleanProgressFilters(filters);
  return feedback.filter(item =>
    (!businessSlug || item.business.slug === businessSlug)
    && (!coach || item.coachName.trim().toLowerCase() === coach.toLowerCase())
    && (!sport || item.sport.trim().toLowerCase() === sport.toLowerCase()));
}

export function hasProgressData(summary: Pick<ProgressSummary, 'stats' | 'feedback' | 'currentGoal'> | null | undefined) {
  return !!summary && (summary.stats.attended > 0 || summary.feedback.length > 0 || !!summary.currentGoal);
}
