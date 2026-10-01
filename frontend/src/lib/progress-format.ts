import { formatInTimeZone } from 'date-fns-tz';
import { monthLabel, monthlyChart } from './progress';
import type { LearnerFeedback, ProgressSummary } from './types';

/**
 * Presentation helpers for a learner's progress summary. The server owns every
 * number (streaks, rates, monthly totals); these only turn them into words so
 * the guardian view and the student app describe progress the same way.
 */

const PROGRESS_ZONE = 'Asia/Singapore';
const number = new Intl.NumberFormat('en-SG', { maximumFractionDigits: 1 });

export function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${number.format(count)} ${count === 1 ? singular : pluralForm}`;
}

/** The API sends attended ÷ (attended + absent) as a 0–1 fraction, or null before any marked Class. */
export function formatAttendanceRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return 'Not yet';
  return `${Math.round(Math.min(1, Math.max(0, rate)) * 100)}%`;
}

export function formatWeeks(weeks: number): string {
  return plural(Math.max(0, Math.floor(weeks)), 'week');
}

export function streakDetail(current: number, longest: number): string {
  if (current <= 0) return longest > 0 ? `No active streak · best ${formatWeeks(longest)}` : 'No active streak';
  return longest > current ? `Best ${formatWeeks(longest)}` : 'Longest so far';
}

export function formatHours(hours: number): string {
  return number.format(Math.max(0, hours));
}

// Month labels and bar scaling are shared with the student Progress view so a
// guardian and a learner always see the same chart for the same numbers.
export { monthLabel };

export type MonthlyBar = { month: string; short: string; long: string; attended: number; percent: number };

export function monthlyBars(monthly: ProgressSummary['monthly']): MonthlyBar[] {
  return monthlyChart(monthly).bars.map(bar => ({
    month: bar.month, short: bar.label, long: bar.longLabel, attended: bar.attended, percent: bar.percent,
  }));
}

/** A one-sentence text alternative for the monthly attendance chart. */
export function monthlySummary(monthly: ProgressSummary['monthly']): string {
  const months = monthly.length;
  const total = monthly.reduce((sum, entry) => sum + Math.max(0, entry.attended), 0);
  const span = months === 1 ? 'this month' : `the last ${months} months`;
  if (!months) return 'No monthly attendance recorded yet.';
  if (!total) return `No Classes attended in ${span}.`;
  const busiest = monthly.reduce((best, entry) => (entry.attended > best.attended ? entry : best), monthly[0]);
  return `${plural(total, 'Class', 'Classes')} attended in ${span}. Busiest month: ${monthLabel(busiest.month, 'long')} (${busiest.attended}).`;
}

export function progressDate(value: string, timezone = PROGRESS_ZONE): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try { return formatInTimeZone(date, timezone, 'd MMM yyyy'); } catch { return formatInTimeZone(date, PROGRESS_ZONE, 'd MMM yyyy'); }
}

export function goalByline(goal: NonNullable<ProgressSummary['currentGoal']>): string {
  return `Set by ${goal.coachName} at ${goal.businessName} on ${progressDate(goal.setAt)}`;
}

/** Who shared the note: the coach, the club account, or a named member of club staff. */
export function feedbackAuthor(feedback: Pick<LearnerFeedback, 'authorRole' | 'coachName' | 'business'>): string {
  if (feedback.authorRole === 'CLUB') return feedback.business.name;
  if (feedback.authorRole === 'STAFF') return `${feedback.business.name} staff`;
  return `Coach ${feedback.coachName}`;
}

export function feedbackSections(feedback: Pick<LearnerFeedback, 'summary' | 'strengths' | 'focusAreas' | 'nextGoal'>) {
  return ([
    ['Summary', feedback.summary],
    ['Strengths', feedback.strengths],
    ['Focus areas', feedback.focusAreas],
    ['Next goal', feedback.nextGoal],
  ] as const)
    .map(([label, text]) => ({ label, text: (text ?? '').trim() }))
    .filter(section => section.text.length > 0);
}
