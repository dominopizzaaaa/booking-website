import type { CoachProfile, CoachingAgeGroup, CoachingLevel } from './types';

/** Limits match the API so the editor can explain a problem before saving. */
export const coachProfileLimits = {
  bio: 600, languages: 8, language: 40, qualifications: 10, qualification: 80, coachingSinceMin: 1950,
} as const;

export const coachingLevelOptions: Array<{ value: CoachingLevel; label: string }> = [
  { value: 'BEGINNER', label: 'Beginner' },
  { value: 'INTERMEDIATE', label: 'Intermediate' },
  { value: 'ADVANCED', label: 'Advanced' },
  { value: 'COMPETITIVE', label: 'Competitive' },
];

export const coachingAgeGroupOptions: Array<{ value: CoachingAgeGroup; label: string }> = [
  { value: 'JUNIOR', label: 'Juniors (under 13)' },
  { value: 'TEEN', label: 'Teens (13–17)' },
  { value: 'ADULT', label: 'Adults' },
  { value: 'SENIOR', label: 'Seniors' },
];

export const emptyCoachProfile: CoachProfile = {
  bio: '', languages: [], coachingLevels: [], coachingAgeGroups: [], qualifications: [], coachingSince: null,
};

/** Trim, drop blanks, and remove case-insensitive repeats while keeping the first spelling. */
export function distinctEntries(values: readonly string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

/** Languages are typed as a comma-separated line. */
export function parseLanguages(text: string) {
  return distinctEntries(text.split(','));
}

/** Qualifications often contain commas, so each one takes its own line. */
export function parseQualifications(text: string) {
  return distinctEntries(text.split(/\r?\n/u));
}

export type CoachProfileDraft = {
  bio: string; languages: string; coachingLevels: CoachingLevel[]; coachingAgeGroups: CoachingAgeGroup[];
  qualifications: string; coachingSince: string;
};

export function draftFromCoachProfile(profile: CoachProfile | null | undefined): CoachProfileDraft {
  const value = profile ?? emptyCoachProfile;
  return {
    bio: value.bio ?? '',
    languages: (value.languages ?? []).join(', '),
    coachingLevels: [...(value.coachingLevels ?? [])],
    coachingAgeGroups: [...(value.coachingAgeGroups ?? [])],
    qualifications: (value.qualifications ?? []).join('\n'),
    coachingSince: value.coachingSince ? String(value.coachingSince) : '',
  };
}

/** Keep vocabulary in canonical order regardless of the order boxes were ticked. */
function canonical<T extends string>(values: readonly T[], options: Array<{ value: T }>) {
  return options.map(option => option.value).filter(value => values.includes(value));
}

export function coachProfileFromDraft(draft: CoachProfileDraft): CoachProfile {
  const year = draft.coachingSince.trim();
  return {
    bio: draft.bio.trim(),
    languages: parseLanguages(draft.languages),
    coachingLevels: canonical(draft.coachingLevels, coachingLevelOptions),
    coachingAgeGroups: canonical(draft.coachingAgeGroups, coachingAgeGroupOptions),
    qualifications: parseQualifications(draft.qualifications),
    coachingSince: year ? Number(year) : null,
  };
}

/** A sentence for the person, or null when the profile can be saved. */
export function coachProfileError(profile: CoachProfile, currentYear = new Date().getFullYear()): string | null {
  if (profile.bio.length > coachProfileLimits.bio) return `Keep your bio to ${coachProfileLimits.bio} characters.`;
  if (profile.languages.length > coachProfileLimits.languages) return `List at most ${coachProfileLimits.languages} languages.`;
  if (profile.languages.some(language => language.length > coachProfileLimits.language)) {
    return `Keep each language to ${coachProfileLimits.language} characters.`;
  }
  if (profile.qualifications.length > coachProfileLimits.qualifications) {
    return `List at most ${coachProfileLimits.qualifications} qualifications.`;
  }
  if (profile.qualifications.some(item => item.length > coachProfileLimits.qualification)) {
    return `Keep each qualification to ${coachProfileLimits.qualification} characters.`;
  }
  if (profile.coachingSince !== null) {
    if (!Number.isInteger(profile.coachingSince)) return 'Use a four-digit year for when you started coaching.';
    if (profile.coachingSince < coachProfileLimits.coachingSinceMin) return `Use a year from ${coachProfileLimits.coachingSinceMin} onwards.`;
    if (profile.coachingSince > currentYear) return 'The year you started coaching cannot be in the future.';
  }
  return null;
}

export function yearsCoachingLabel(coachingSince: number | null, currentYear = new Date().getFullYear()) {
  if (!coachingSince || coachingSince > currentYear) return null;
  const years = currentYear - coachingSince;
  if (years < 1) return 'Started coaching this year';
  return `Coaching since ${coachingSince} · ${years} year${years === 1 ? '' : 's'}`;
}

export function profileIsEmpty(profile: CoachProfile, sports: readonly string[] = []) {
  return !profile.bio && !profile.languages.length && !profile.coachingLevels.length && !profile.coachingAgeGroups.length
    && !profile.qualifications.length && profile.coachingSince === null && !sports.length;
}

export const coachingLevelLabel = (value: CoachingLevel) => coachingLevelOptions.find(option => option.value === value)?.label ?? value;
export const coachingAgeGroupLabel = (value: CoachingAgeGroup) => coachingAgeGroupOptions.find(option => option.value === value)?.label ?? value;
