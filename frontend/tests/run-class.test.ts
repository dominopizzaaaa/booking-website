import { describe, expect, it } from 'vitest';
import type { Attendance, ProviderFeedback } from '../src/lib/types';
import {
  activeRoster, attendanceSummary, attendanceSummaryText, bulkPresentPlan, draftFromFeedback, emptyFeedbackDraft,
  feedbackAllowedFor, feedbackDirty, feedbackDraftError, feedbackInputFromDraft, feedbackStatus, isAttended,
} from '../src/lib/run-class';

const place = (id: string, attendance: Attendance, cancelled = false) => ({ id, attendance, cancelled });

const savedFeedback = (overrides: Partial<ProviderFeedback> = {}): ProviderFeedback => ({
  id: 'feedback-1', bookingId: 'booking-1', participantId: 'p1', studentId: 's1', studentName: 'Ava Tan',
  authorName: 'Coach Lee', authorRole: 'COACH', editedByName: null, visibility: 'PRIVATE',
  summary: 'Good rally tolerance.', strengths: '', focusAreas: '', nextGoal: '', clubNote: '',
  sharedAt: null, editedAt: null, viewedAt: null, createdAt: '2026-10-01T10:30:00.000Z',
  ...overrides,
});

describe('attendance vocabulary', () => {
  it('counts late arrivals as attended and nothing else besides present', () => {
    expect(isAttended('PRESENT')).toBe(true);
    expect(isAttended('LATE')).toBe(true);
    for (const value of ['UNMARKED', 'ABSENT', 'EXCUSED'] as const) expect(isAttended(value)).toBe(false);
  });

  it('allows feedback only for an attended place', () => {
    expect(feedbackAllowedFor('LATE')).toBe(true);
    expect(feedbackAllowedFor('EXCUSED')).toBe(false);
    expect(feedbackAllowedFor('UNMARKED')).toBe(false);
  });
});

describe('attendanceSummary', () => {
  it('ignores cancelled places and tallies each state', () => {
    const roster = [place('a', 'PRESENT'), place('b', 'LATE'), place('c', 'ABSENT'), place('d', 'EXCUSED'), place('e', 'UNMARKED'), place('f', 'PRESENT', true)];
    expect(activeRoster(roster).map(entry => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(attendanceSummary(roster)).toEqual({
      total: 5, marked: 4, unmarked: 1, attended: 2, present: 1, late: 1, absent: 1, excused: 1,
    });
    expect(attendanceSummaryText(attendanceSummary(roster))).toBe('4 of 5 marked · 1 present · 1 late · 1 absent · 1 excused');
  });

  it('describes an empty roster in words', () => {
    expect(attendanceSummaryText(attendanceSummary([]))).toBe('No learners on the roster');
  });
});

describe('bulkPresentPlan', () => {
  it('marks everyone on a fresh roll call without naming participants', () => {
    expect(bulkPresentPlan([place('a', 'UNMARKED'), place('b', 'UNMARKED')])).toEqual({
      kind: 'ALL', label: 'Mark all present', participantIds: undefined, count: 2,
    });
  });

  it('never overwrites a recorded decision once roll call has started', () => {
    expect(bulkPresentPlan([place('a', 'LATE'), place('b', 'UNMARKED'), place('c', 'UNMARKED'), place('d', 'ABSENT')])).toEqual({
      kind: 'REMAINING', label: 'Mark remaining 2 present', participantIds: ['b', 'c'], count: 2,
    });
  });

  it('offers nothing when everyone is marked or the roster is empty', () => {
    expect(bulkPresentPlan([place('a', 'PRESENT'), place('b', 'EXCUSED')]).kind).toBe('NONE');
    expect(bulkPresentPlan([]).kind).toBe('NONE');
    expect(bulkPresentPlan([place('a', 'UNMARKED', true)]).kind).toBe('NONE');
  });
});

describe('feedback drafts', () => {
  it('starts private and empty without saved feedback', () => {
    expect(draftFromFeedback(null)).toEqual(emptyFeedbackDraft);
    expect(feedbackStatus(emptyFeedbackDraft, null)).toBe('NOT_STARTED');
  });

  it('treats whitespace-only edits as unchanged', () => {
    const saved = savedFeedback();
    const draft = { ...draftFromFeedback(saved), summary: '  Good rally tolerance.  ' };
    expect(feedbackDirty(draft, saved)).toBe(false);
    expect(feedbackStatus(draft, saved)).toBe('DRAFT');
  });

  it('reports unsaved text and visibility changes', () => {
    const saved = savedFeedback();
    expect(feedbackDirty({ ...draftFromFeedback(saved), nextGoal: 'Split step on every serve' }, saved)).toBe(true);
    expect(feedbackStatus({ ...draftFromFeedback(saved), visibility: 'SHARED' }, saved)).toBe('UNSAVED');
    expect(feedbackStatus({ ...emptyFeedbackDraft, clubNote: 'Needs a new grip' }, null)).toBe('UNSAVED');
  });

  it('reports saved shared feedback', () => {
    const saved = savedFeedback({ visibility: 'SHARED', sharedAt: '2026-10-01T11:00:00.000Z' });
    expect(feedbackStatus(draftFromFeedback(saved), saved)).toBe('SHARED');
  });

  it('refuses to share a note with nothing a learner can read', () => {
    expect(feedbackDraftError({ ...emptyFeedbackDraft, visibility: 'SHARED', clubNote: 'Internal only' }))
      .toBe('Add a summary, strength, focus area or next goal before sharing with the learner.');
    expect(feedbackDraftError({ ...emptyFeedbackDraft, visibility: 'SHARED', focusAreas: 'Footwork' })).toBeNull();
    expect(feedbackDraftError({ ...emptyFeedbackDraft, clubNote: 'Private draft' })).toBeNull();
  });

  it('enforces the API length limits after trimming', () => {
    expect(feedbackDraftError({ ...emptyFeedbackDraft, nextGoal: 'x'.repeat(301) })).toBe('Keep the next goal to 300 characters.');
    expect(feedbackDraftError({ ...emptyFeedbackDraft, nextGoal: ` ${'x'.repeat(300)} ` })).toBeNull();
    expect(feedbackDraftError({ ...emptyFeedbackDraft, clubNote: 'x'.repeat(1001) })).toBe('Keep the internal note to 1000 characters.');
  });

  it('sends trimmed values and the chosen visibility', () => {
    expect(feedbackInputFromDraft({ visibility: 'SHARED', summary: ' Great session ', strengths: '', focusAreas: ' Volleys', nextGoal: '', clubNote: ' ok ' })).toEqual({
      visibility: 'SHARED', summary: 'Great session', strengths: '', focusAreas: 'Volleys', nextGoal: '', clubNote: 'ok',
    });
  });
});
