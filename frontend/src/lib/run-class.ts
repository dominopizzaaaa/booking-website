import type { Attendance, FeedbackInput, FeedbackVisibility, ProviderFeedback } from './types';

/**
 * Court-side roll call and coach feedback, without a DOM.
 *
 * The "Run this Class" screen and the booking detail share these rules so the
 * two places a coach can mark attendance never disagree about what counts as
 * attended, what "Mark all present" will touch, or whether a note is saved.
 */

/** Values a person can choose. UNMARKED is the starting state, not a choice. */
export const attendanceChoices = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED'] as const satisfies readonly Attendance[];
export type AttendanceChoice = (typeof attendanceChoices)[number];

export const attendanceLabels: Record<Attendance, string> = {
  UNMARKED: 'Not marked',
  PRESENT: 'Present',
  LATE: 'Late',
  ABSENT: 'Absent',
  EXCUSED: 'Excused',
};

/** LATE still means the learner trained, so it counts as attended everywhere. */
export function isAttended(attendance: Attendance) {
  return attendance === 'PRESENT' || attendance === 'LATE';
}

/** The API refuses feedback for a place that was not attended. */
export function feedbackAllowedFor(attendance: Attendance) {
  return isAttended(attendance);
}

type RosterEntry = { id: string; attendance: Attendance; cancelled?: boolean };

/** Cancelled places stay on the booking for history but are not on the roll. */
export function activeRoster<T extends RosterEntry>(participants: readonly T[]) {
  return participants.filter(participant => !participant.cancelled);
}

export type AttendanceSummary = {
  total: number; marked: number; unmarked: number; attended: number;
  present: number; late: number; absent: number; excused: number;
};

export function attendanceSummary(participants: readonly RosterEntry[]): AttendanceSummary {
  const roster = activeRoster(participants);
  const count = (value: Attendance) => roster.filter(participant => participant.attendance === value).length;
  const present = count('PRESENT');
  const late = count('LATE');
  const absent = count('ABSENT');
  const excused = count('EXCUSED');
  const unmarked = count('UNMARKED');
  return { total: roster.length, marked: roster.length - unmarked, unmarked, attended: present + late, present, late, absent, excused };
}

export function attendanceSummaryText(summary: AttendanceSummary) {
  if (!summary.total) return 'No learners on the roster';
  const parts = [`${summary.marked} of ${summary.total} marked`];
  if (summary.present) parts.push(`${summary.present} present`);
  if (summary.late) parts.push(`${summary.late} late`);
  if (summary.absent) parts.push(`${summary.absent} absent`);
  if (summary.excused) parts.push(`${summary.excused} excused`);
  return parts.join(' · ');
}

export type BulkPresentPlan =
  | { kind: 'ALL'; label: string; participantIds: undefined; count: number }
  | { kind: 'REMAINING'; label: string; participantIds: string[]; count: number }
  | { kind: 'NONE'; label: string; participantIds: []; count: 0 };

/**
 * What "Mark all present" will change.
 *
 * A fresh roll call marks everyone. Once a coach has recorded someone as late,
 * absent or excused, a bulk action must not quietly overwrite that decision,
 * so it narrows to the learners still unmarked and says so.
 */
export function bulkPresentPlan(participants: readonly RosterEntry[]): BulkPresentPlan {
  const roster = activeRoster(participants);
  const unmarked = roster.filter(participant => participant.attendance === 'UNMARKED');
  if (!unmarked.length) return { kind: 'NONE', label: 'Everyone is marked', participantIds: [], count: 0 };
  if (unmarked.length === roster.length) {
    return { kind: 'ALL', label: 'Mark all present', participantIds: undefined, count: roster.length };
  }
  return {
    kind: 'REMAINING',
    label: `Mark remaining ${unmarked.length} present`,
    participantIds: unmarked.map(participant => participant.id),
    count: unmarked.length,
  };
}

/* Feedback drafts --------------------------------------------------------- */

export const feedbackLimits = {
  summary: 2000, strengths: 600, focusAreas: 600, nextGoal: 300, clubNote: 1000,
} as const;

export type FeedbackDraft = {
  visibility: FeedbackVisibility; summary: string; strengths: string; focusAreas: string; nextGoal: string; clubNote: string;
};
type FeedbackTextField = Exclude<keyof FeedbackDraft, 'visibility'>;
const textFields: FeedbackTextField[] = ['summary', 'strengths', 'focusAreas', 'nextGoal', 'clubNote'];
const learnerFields: FeedbackTextField[] = ['summary', 'strengths', 'focusAreas', 'nextGoal'];

export const emptyFeedbackDraft: FeedbackDraft = {
  visibility: 'PRIVATE', summary: '', strengths: '', focusAreas: '', nextGoal: '', clubNote: '',
};

export function draftFromFeedback(feedback: ProviderFeedback | null | undefined): FeedbackDraft {
  if (!feedback) return { ...emptyFeedbackDraft };
  return {
    visibility: feedback.visibility,
    summary: feedback.summary ?? '', strengths: feedback.strengths ?? '', focusAreas: feedback.focusAreas ?? '',
    nextGoal: feedback.nextGoal ?? '', clubNote: feedback.clubNote ?? '',
  };
}

/** Compare after trimming: the API trims, so whitespace alone is not a change. */
export function feedbackDirty(draft: FeedbackDraft, saved: ProviderFeedback | null | undefined) {
  const baseline = draftFromFeedback(saved);
  if (draft.visibility !== baseline.visibility) return true;
  return textFields.some(field => draft[field].trim() !== baseline[field].trim());
}

export function hasLearnerContent(draft: FeedbackDraft) {
  return learnerFields.some(field => draft[field].trim().length > 0);
}

/** A sentence for the person, or null when the draft can be saved. */
export function feedbackDraftError(draft: FeedbackDraft): string | null {
  for (const field of textFields) {
    if (draft[field].trim().length > feedbackLimits[field]) {
      return `Keep ${fieldNames[field]} to ${feedbackLimits[field]} characters.`;
    }
  }
  if (draft.visibility === 'SHARED' && !hasLearnerContent(draft)) {
    return 'Add a summary, strength, focus area or next goal before sharing with the learner.';
  }
  return null;
}

const fieldNames: Record<FeedbackTextField, string> = {
  summary: 'the summary', strengths: 'strengths', focusAreas: 'focus areas', nextGoal: 'the next goal', clubNote: 'the internal note',
};

export function feedbackInputFromDraft(draft: FeedbackDraft): FeedbackInput {
  return {
    visibility: draft.visibility,
    summary: draft.summary.trim(), strengths: draft.strengths.trim(), focusAreas: draft.focusAreas.trim(),
    nextGoal: draft.nextGoal.trim(), clubNote: draft.clubNote.trim(),
  };
}

export type FeedbackStatus = 'NOT_STARTED' | 'UNSAVED' | 'DRAFT' | 'SHARED';

export function feedbackStatus(draft: FeedbackDraft, saved: ProviderFeedback | null | undefined): FeedbackStatus {
  if (feedbackDirty(draft, saved)) return 'UNSAVED';
  if (!saved) return 'NOT_STARTED';
  return saved.visibility === 'SHARED' ? 'SHARED' : 'DRAFT';
}

export const feedbackStatusLabels: Record<FeedbackStatus, string> = {
  NOT_STARTED: 'No feedback yet',
  UNSAVED: 'Unsaved changes',
  DRAFT: 'Saved · club only',
  SHARED: 'Saved · shared',
};
