import { describe, expect, it } from 'vitest';
import {
  attendanceRateText, authorRoleLabel, cleanProgressFilters, feedbackFields, feedbackPreview, filterFeedback,
  hasProgressData, hoursText, latestFeedback, monthLabel, monthlyChart, progressFiltersActive, streakText, weeksText,
} from '../src/lib/progress';
import type { LearnerFeedback, ProgressSummary } from '../src/lib/types';

function feedback(overrides: Partial<LearnerFeedback> = {}): LearnerFeedback {
  return {
    id: 'f1', bookingId: 'b1', participantId: 'p1', business: { name: 'Riverside Rackets', slug: 'riverside' },
    serviceName: 'Private tennis', sport: 'Tennis', coachName: 'Jordan Coach', authorRole: 'COACH',
    sessionStartAt: '2026-09-20T02:00:00.000Z', timezone: 'Asia/Singapore',
    summary: 'Great footwork today.', strengths: '', focusAreas: 'Second serve toss', nextGoal: 'Land 7 of 10 second serves',
    sharedAt: '2026-09-20T05:00:00.000Z', editedAt: null, viewed: false,
    ...overrides,
  };
}

describe('monthly chart', () => {
  it('scales bars against the busiest month and keeps empty months', () => {
    const chart = monthlyChart([
      { month: '2026-10', attended: 2 },
      { month: '2026-08', attended: 4 },
      { month: '2026-09', attended: 0 },
    ]);
    expect(chart.bars.map(bar => [bar.label, bar.percent])).toEqual([['Aug', 100], ['Sep', 0], ['Oct', 50]]);
    expect(chart.max).toBe(4);
    expect(chart.total).toBe(6);
    expect(chart.summary).toBe('Sessions attended per month: August 2026, 4; September 2026, 0; October 2026, 2.');
  });

  it('describes an all-zero or empty history without dividing by zero', () => {
    expect(monthlyChart([{ month: '2026-10', attended: 0 }]).bars[0].percent).toBe(0);
    expect(monthlyChart([]).summary).toBe('No monthly attendance yet.');
  });

  it('labels month keys and leaves unknown input alone', () => {
    expect(monthLabel('2026-01')).toBe('Jan');
    expect(monthLabel('2026-12', 'long')).toBe('December 2026');
    expect(monthLabel('2026-13')).toBe('2026-13');
  });
});

describe('statistic wording', () => {
  it('names streaks and weeks', () => {
    expect(streakText(0)).toBe('No current streak');
    expect(streakText(1)).toBe('1-week streak');
    expect(streakText(4)).toBe('4-week streak');
    expect(weeksText(1)).toBe('1 week');
    expect(weeksText(0)).toBe('0 weeks');
  });

  it('turns the attendance ratio into a percentage, or says there is no data', () => {
    expect(attendanceRateText(null)).toBe('Not enough data yet');
    expect(attendanceRateText(0.875)).toBe('88%');
    expect(attendanceRateText(1)).toBe('100%');
    expect(attendanceRateText(0)).toBe('0%');
  });

  it('rounds hours on court to one decimal place', () => {
    expect(hoursText(0)).toBe('0 hours');
    expect(hoursText(1)).toBe('1 hour');
    expect(hoursText(7.25)).toBe('7.3 hours');
  });

  it('distinguishes who wrote the feedback', () => {
    expect(authorRoleLabel('COACH')).toBe('Coach');
    expect(authorRoleLabel('CLUB')).toBe('Club');
    expect(authorRoleLabel('STAFF')).toBe('Club staff');
  });
});

describe('coach feedback', () => {
  it('shows only the parts that were written, in reading order', () => {
    expect(feedbackFields(feedback()).map(field => field.label)).toEqual(['Summary', 'What to work on', 'Next goal']);
    expect(feedbackFields(feedback({ summary: '   ' }))[0].key).toBe('focusAreas');
  });

  it('previews the first written field and truncates long notes', () => {
    expect(feedbackPreview(feedback())).toBe('Great footwork today.');
    const long = feedbackPreview(feedback({ summary: 'word '.repeat(60) }), 20);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long.endsWith('…')).toBe(true);
  });

  it('finds the newest shared note regardless of input order', () => {
    const older = feedback({ id: 'old', sharedAt: '2026-09-01T00:00:00.000Z' });
    const newer = feedback({ id: 'new', sharedAt: '2026-09-25T00:00:00.000Z' });
    expect(latestFeedback([older, newer])?.id).toBe('new');
    expect(latestFeedback([])).toBeNull();
  });

  it('filters feedback by club, coach and sport without case sensitivity', () => {
    const items = [
      feedback({ id: 'a' }),
      feedback({ id: 'b', business: { name: 'Shuttle House', slug: 'shuttle' }, sport: 'Badminton', coachName: 'Sam Lee' }),
    ];
    expect(filterFeedback(items, { businessSlug: 'shuttle' }).map(item => item.id)).toEqual(['b']);
    expect(filterFeedback(items, { coach: 'jordan coach', sport: 'TENNIS' }).map(item => item.id)).toEqual(['a']);
    expect(filterFeedback(items, {}).map(item => item.id)).toEqual(['a', 'b']);
  });

  it('drops empty filters before they reach the API', () => {
    expect(cleanProgressFilters({ businessSlug: ' ', coach: ' Jordan ', sport: '' })).toEqual({ coach: 'Jordan' });
    expect(progressFiltersActive({ businessSlug: '' })).toBe(false);
    expect(progressFiltersActive({ sport: 'Tennis' })).toBe(true);
  });
});

describe('progress presence', () => {
  const empty: Pick<ProgressSummary, 'stats' | 'feedback' | 'currentGoal'> = {
    stats: { attended: 0, booked: 1, upcoming: 1, hoursOnCourt: 0, currentStreakWeeks: 0, longestStreakWeeks: 0, clubs: 1, coaches: 1, lastAttendedAt: null, attendanceRate: null },
    feedback: [], currentGoal: null,
  };

  it('treats a learner with nothing attended or shared as having no progress yet', () => {
    expect(hasProgressData(empty)).toBe(false);
    expect(hasProgressData(null)).toBe(false);
    expect(hasProgressData({ ...empty, stats: { ...empty.stats, attended: 1 } })).toBe(true);
    expect(hasProgressData({ ...empty, feedback: [feedback()] })).toBe(true);
  });
});
