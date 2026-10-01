import { describe, expect, it } from 'vitest';
import {
  coachProfileError, coachProfileFromDraft, distinctEntries, draftFromCoachProfile, emptyCoachProfile, parseLanguages,
  parseQualifications, profileIsEmpty, yearsCoachingLabel,
} from '../src/lib/coach-profile';

describe('list parsing', () => {
  it('trims, drops blanks, and removes case-insensitive repeats keeping the first spelling', () => {
    expect(distinctEntries([' English', 'english ', '', 'Mandarin', 'MANDARIN'])).toEqual(['English', 'Mandarin']);
    expect(parseLanguages('English, , Malay,english')).toEqual(['English', 'Malay']);
  });

  it('keeps commas inside a qualification line', () => {
    expect(parseQualifications('ITF Level 1, 2019\n\n First Aid \r\nfirst aid')).toEqual(['ITF Level 1, 2019', 'First Aid']);
  });
});

describe('draft round trip', () => {
  it('turns a saved profile into editable text and back', () => {
    const profile = {
      bio: 'Patient coach.', languages: ['English', 'Mandarin'], coachingLevels: ['ADVANCED', 'BEGINNER'] as const,
      coachingAgeGroups: ['ADULT'] as const, qualifications: ['ITF Level 1'], coachingSince: 2015,
    };
    const draft = draftFromCoachProfile({ ...profile, coachingLevels: [...profile.coachingLevels], coachingAgeGroups: [...profile.coachingAgeGroups] });
    expect(draft.languages).toBe('English, Mandarin');
    expect(coachProfileFromDraft(draft)).toEqual({
      ...profile, coachingLevels: ['BEGINNER', 'ADVANCED'], coachingAgeGroups: ['ADULT'],
    });
  });

  it('treats a blank year as not shown', () => {
    expect(coachProfileFromDraft({ ...draftFromCoachProfile(null), coachingSince: ' ' }).coachingSince).toBeNull();
    expect(draftFromCoachProfile(null)).toMatchObject({ bio: '', languages: '', qualifications: '', coachingSince: '' });
  });
});

describe('coachProfileError', () => {
  const valid = { ...emptyCoachProfile, bio: 'Hi' };
  it('accepts an empty or complete profile', () => {
    expect(coachProfileError(emptyCoachProfile, 2026)).toBeNull();
    expect(coachProfileError({ ...valid, coachingSince: 2026 }, 2026)).toBeNull();
  });

  it('mirrors the API limits', () => {
    expect(coachProfileError({ ...valid, bio: 'x'.repeat(601) }, 2026)).toBe('Keep your bio to 600 characters.');
    expect(coachProfileError({ ...valid, languages: Array.from({ length: 9 }, (_, i) => `L${i}`) }, 2026)).toBe('List at most 8 languages.');
    expect(coachProfileError({ ...valid, languages: ['x'.repeat(41)] }, 2026)).toBe('Keep each language to 40 characters.');
    expect(coachProfileError({ ...valid, qualifications: Array.from({ length: 11 }, (_, i) => `Q${i}`) }, 2026)).toBe('List at most 10 qualifications.');
    expect(coachProfileError({ ...valid, qualifications: ['x'.repeat(81)] }, 2026)).toBe('Keep each qualification to 80 characters.');
  });

  it('checks the coaching year', () => {
    expect(coachProfileError({ ...valid, coachingSince: 1949 }, 2026)).toBe('Use a year from 1950 onwards.');
    expect(coachProfileError({ ...valid, coachingSince: 2027 }, 2026)).toBe('The year you started coaching cannot be in the future.');
    expect(coachProfileError({ ...valid, coachingSince: Number.NaN }, 2026)).toBe('Use a four-digit year for when you started coaching.');
  });
});

describe('preview helpers', () => {
  it('describes experience in years', () => {
    expect(yearsCoachingLabel(2016, 2026)).toBe('Coaching since 2016 · 10 years');
    expect(yearsCoachingLabel(2025, 2026)).toBe('Coaching since 2025 · 1 year');
    expect(yearsCoachingLabel(2026, 2026)).toBe('Started coaching this year');
    expect(yearsCoachingLabel(null, 2026)).toBeNull();
  });

  it('knows when a card would show only a name', () => {
    expect(profileIsEmpty(emptyCoachProfile)).toBe(true);
    expect(profileIsEmpty(emptyCoachProfile, ['Tennis'])).toBe(false);
    expect(profileIsEmpty({ ...emptyCoachProfile, languages: ['English'] })).toBe(false);
  });
});
