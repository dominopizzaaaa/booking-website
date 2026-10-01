import { describe, expect, it } from 'vitest';
import type { GrowthInsights } from '../src/lib/types';
import { busiestDay, dailyBars, dailyTotal, formatRate, funnelSteps, growthRates, rate } from '../src/lib/insights';

const insights = (overrides: Partial<GrowthInsights['funnel']> = {}): GrowthInsights => ({
  days: 7,
  funnel: { pageViews: 200, availabilityChecks: 80, bookings: 20, rebooks: 5, waitlistJoined: 4, waitlistAccepted: 1, searchImpressions: 50, ...overrides },
  daily: [
    { day: '2026-09-25', pageViews: 10, availabilityChecks: 4, bookings: 0 },
    { day: '2026-09-26', pageViews: 40, availabilityChecks: 10, bookings: 3 },
    { day: '2026-09-27', pageViews: 40, availabilityChecks: 12, bookings: 1 },
    { day: '2026-09-28', pageViews: 0, availabilityChecks: 0, bookings: 0 },
  ],
  retention: { activeStudents: 10, returningStudents: 4, repeatRate: 0.4 },
  feedback: { attendedPlaces: 0, withSharedFeedback: 0, coverage: null, viewed: 0, viewRate: null },
  waitlist: { waiting: 2, offered: 1 },
});

describe('rate', () => {
  it('returns null instead of dividing by zero or a negative total', () => {
    expect(rate(5, 0)).toBeNull();
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, -1)).toBeNull();
    expect(rate(Number.NaN, 4)).toBeNull();
  });

  it('divides normally and never reports a negative share', () => {
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(-3, 4)).toBe(0);
  });
});

describe('formatRate', () => {
  it('shows a dash when there is not enough data', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(undefined)).toBe('—');
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('rounds to whole percent and keeps tiny non-zero shares visible', () => {
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.004)).toBe('<1%');
    expect(formatRate(0.255)).toBe('26%');
    expect(formatRate(1.5)).toBe('150%');
  });
});

describe('funnel', () => {
  it('converts each step from the one before it', () => {
    const steps = funnelSteps(insights().funnel);
    expect(steps.map(step => [step.id, step.value, step.fromPrevious])).toEqual([
      ['pageViews', 200, null], ['availabilityChecks', 80, 0.4], ['bookings', 20, 0.25],
    ]);
  });

  it('leaves conversion empty when a previous step had nothing', () => {
    const steps = funnelSteps(insights({ pageViews: 0, availabilityChecks: 0, bookings: 2 }).funnel);
    expect(steps[1].fromPrevious).toBeNull();
    expect(steps[2].fromPrevious).toBeNull();
  });

  it('derives headline rates with the same zero guards', () => {
    expect(growthRates(insights())).toEqual({ viewToBooking: 0.1, rebookShare: 0.25, waitlistAcceptance: 0.25 });
    expect(growthRates(insights({ pageViews: 0, bookings: 0, waitlistJoined: 0, waitlistAccepted: 0, rebooks: 0 }))).toEqual({
      viewToBooking: null, rebookShare: null, waitlistAcceptance: null,
    });
  });
});

describe('daily chart', () => {
  it('scales bars to the busiest day and leaves empty days at zero', () => {
    expect(dailyBars(insights().daily, 'pageViews').map(bar => bar.height)).toEqual([0.25, 1, 1, 0]);
  });

  it('draws a flat chart instead of dividing by zero when nothing happened', () => {
    const empty = insights().daily.map(day => ({ ...day, bookings: 0 }));
    expect(dailyBars(empty, 'bookings').every(bar => bar.height === 0)).toBe(true);
    expect(busiestDay(empty, 'bookings')).toBeNull();
  });

  it('totals a metric and names the earliest busiest day', () => {
    expect(dailyTotal(insights().daily, 'availabilityChecks')).toBe(26);
    expect(busiestDay(insights().daily, 'pageViews')).toEqual({ day: '2026-09-26', value: 40 });
  });
});
