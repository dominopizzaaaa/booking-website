import { describe, expect, it } from 'vitest';
import {
  feedbackAuthor,
  feedbackSections,
  formatAttendanceRate,
  formatHours,
  formatWeeks,
  goalByline,
  monthLabel,
  monthlyBars,
  monthlySummary,
  plural,
  progressDate,
  streakDetail,
} from '../src/lib/progress-format';

describe('progress number formatting', () => {
  it('reads the API attendance rate as a 0–1 fraction and says so plainly when there is none', () => {
    expect(formatAttendanceRate(0.8333)).toBe('83%');
    expect(formatAttendanceRate(1)).toBe('100%');
    expect(formatAttendanceRate(0)).toBe('0%');
    expect(formatAttendanceRate(null)).toBe('Not yet');
    expect(formatAttendanceRate(undefined)).toBe('Not yet');
    expect(formatAttendanceRate(Number.NaN)).toBe('Not yet');
    // Out-of-range values never render as impossible percentages.
    expect(formatAttendanceRate(1.4)).toBe('100%');
    expect(formatAttendanceRate(-0.2)).toBe('0%');
  });

  it('pluralizes weeks and Classes and keeps hours to one decimal', () => {
    expect(formatWeeks(0)).toBe('0 weeks');
    expect(formatWeeks(1)).toBe('1 week');
    expect(formatWeeks(6)).toBe('6 weeks');
    expect(formatWeeks(-2)).toBe('0 weeks');
    expect(plural(1, 'Class', 'Classes')).toBe('1 Class');
    expect(plural(12, 'Class', 'Classes')).toBe('12 Classes');
    expect(formatHours(7.25)).toBe('7.3');
    expect(formatHours(12)).toBe('12');
    expect(formatHours(-1)).toBe('0');
  });

  it('describes the current streak against the longest one', () => {
    expect(streakDetail(0, 0)).toBe('No active streak');
    expect(streakDetail(0, 4)).toBe('No active streak · best 4 weeks');
    expect(streakDetail(3, 3)).toBe('Longest so far');
    expect(streakDetail(2, 5)).toBe('Best 5 weeks');
  });
});

describe('monthly attendance chart', () => {
  const monthly = [
    { month: '2026-05', attended: 0 },
    { month: '2026-06', attended: 2 },
    { month: '2026-07', attended: 4 },
    { month: '2026-08', attended: 1 },
    { month: '2026-09', attended: 3 },
    { month: '2026-10', attended: 0 },
  ];

  it('labels months without shifting them across a timezone boundary', () => {
    expect(monthLabel('2026-01')).toBe('Jan');
    expect(monthLabel('2026-12', 'long')).toBe('December 2026');
    expect(monthLabel('not-a-month')).toBe('not-a-month');
  });

  it('scales bars to the busiest month', () => {
    const bars = monthlyBars(monthly);
    expect(bars.map(bar => bar.percent)).toEqual([0, 50, 100, 25, 75, 0]);
    expect(bars[2]).toMatchObject({ month: '2026-07', short: 'Jul', long: 'July 2026', attended: 4 });
    expect(monthlyBars([{ month: '2026-10', attended: 0 }])[0].percent).toBe(0);
  });

  it('provides a text alternative that names the total and busiest month', () => {
    expect(monthlySummary(monthly)).toBe('10 Classes attended in the last 6 months. Busiest month: July 2026 (4).');
    expect(monthlySummary(monthly.map(entry => ({ ...entry, attended: 0 })))).toBe('No Classes attended in the last 6 months.');
    expect(monthlySummary([{ month: '2026-10', attended: 1 }])).toBe('1 Class attended in this month. Busiest month: October 2026 (1).');
    expect(monthlySummary([])).toBe('No monthly attendance recorded yet.');
  });
});

describe('goals and shared feedback', () => {
  it('dates progress in Singapore unless the Class supplies its own club timezone', () => {
    expect(progressDate('2026-09-30T16:30:00.000Z')).toBe('1 Oct 2026');
    expect(progressDate('2026-09-30T16:30:00.000Z', 'Europe/London')).toBe('30 Sep 2026');
    expect(progressDate('2026-09-30T16:30:00.000Z', 'Not/AZone')).toBe('1 Oct 2026');
    expect(progressDate('garbage')).toBe('garbage');
  });

  it('attributes a goal to its coach and club', () => {
    expect(goalByline({ text: 'Split-step before every return', setAt: '2026-09-20T02:00:00.000Z', coachName: 'Dominic Loh', businessName: 'Elever Academy' }))
      .toBe('Set by Dominic Loh at Elever Academy on 20 Sep 2026');
  });

  it('names the author by role without exposing anything else', () => {
    const base = { coachName: 'Dominic Loh', business: { name: 'Elever Academy', slug: 'elever' } };
    expect(feedbackAuthor({ ...base, authorRole: 'COACH' })).toBe('Coach Dominic Loh');
    expect(feedbackAuthor({ ...base, authorRole: 'CLUB' })).toBe('Elever Academy');
    expect(feedbackAuthor({ ...base, authorRole: 'STAFF' })).toBe('Elever Academy staff');
  });

  it('keeps only the feedback sections that were written, in reading order', () => {
    expect(feedbackSections({ summary: ' Great footwork. ', strengths: '', focusAreas: 'Backhand grip', nextGoal: '   ' })).toEqual([
      { label: 'Summary', text: 'Great footwork.' },
      { label: 'Focus areas', text: 'Backhand grip' },
    ]);
    expect(feedbackSections({ summary: '', strengths: '', focusAreas: '', nextGoal: '' })).toEqual([]);
  });
});
