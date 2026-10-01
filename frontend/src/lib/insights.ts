import type { GrowthInsights } from './types';

/**
 * Arithmetic behind the club growth view. Every rate guards its divisor: a
 * new club with no page views yet should read "—", never NaN% or Infinity%.
 */

export const growthPeriods = [7, 30, 90] as const;
export type GrowthPeriod = (typeof growthPeriods)[number];

/** A ratio, or null when there is nothing to divide by. */
export function rate(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.max(0, numerator) / denominator;
}

/** Whole percent with a dash for "not enough data". Values above 100% stay honest. */
export function formatRate(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const percent = value * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

export type FunnelStep = {
  id: 'pageViews' | 'availabilityChecks' | 'bookings';
  label: string;
  value: number;
  /** Conversion from the previous step; null for the first step or an empty previous step. */
  fromPrevious: number | null;
};

export function funnelSteps(funnel: GrowthInsights['funnel']): FunnelStep[] {
  return [
    { id: 'pageViews', label: 'Booking page views', value: funnel.pageViews, fromPrevious: null },
    { id: 'availabilityChecks', label: 'Availability checks', value: funnel.availabilityChecks, fromPrevious: rate(funnel.availabilityChecks, funnel.pageViews) },
    { id: 'bookings', label: 'Bookings', value: funnel.bookings, fromPrevious: rate(funnel.bookings, funnel.availabilityChecks) },
  ];
}

export function growthRates(insights: GrowthInsights) {
  const { funnel } = insights;
  return {
    viewToBooking: rate(funnel.bookings, funnel.pageViews),
    rebookShare: rate(funnel.rebooks, funnel.bookings),
    waitlistAcceptance: rate(funnel.waitlistAccepted, funnel.waitlistJoined),
  };
}

export type DailyMetric = 'pageViews' | 'availabilityChecks' | 'bookings';

export type DailyBar = { day: string; value: number; height: number };

/**
 * Bar heights as a share of the tallest day (0–1). Zero days stay at zero so
 * an empty chart is visibly empty rather than a row of minimum stubs.
 */
export function dailyBars(daily: GrowthInsights['daily'], metric: DailyMetric): DailyBar[] {
  const max = Math.max(0, ...daily.map(day => day[metric] || 0));
  return daily.map(day => {
    const value = Math.max(0, day[metric] || 0);
    return { day: day.day, value, height: max > 0 ? value / max : 0 };
  });
}

export function dailyTotal(daily: GrowthInsights['daily'], metric: DailyMetric) {
  return daily.reduce((sum, day) => sum + Math.max(0, day[metric] || 0), 0);
}

/** The busiest day, for the chart's text alternative. Ties keep the earliest day. */
export function busiestDay(daily: GrowthInsights['daily'], metric: DailyMetric) {
  let best: { day: string; value: number } | null = null;
  for (const day of daily) {
    const value = day[metric] || 0;
    if (value > 0 && (!best || value > best.value)) best = { day: day.day, value };
  }
  return best;
}
