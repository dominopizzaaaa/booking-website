import type { Prisma, User } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { prisma } from './db.js';
import { initials } from './http.js';

export const usernameSchema = z.string().trim().min(3).max(30)
  .transform(value => value.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]+$/, 'Use 3-30 lowercase letters, numbers, or underscores'));

export const sportsSchema = z.array(z.string().trim().min(1).max(40)).max(20)
  .transform(values => {
    const seen = new Set<string>();
    return values.filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

export const coachingLevels = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'COMPETITIVE'] as const;
export const coachingAgeGroups = ['JUNIOR', 'TEEN', 'ADULT', 'SENIOR'] as const;
export const COACHING_SINCE_MIN = 1950;

/** Trim, drop empties, and keep the first spelling of case-insensitive repeats. */
function distinctText(values: string[]) {
  const seen = new Set<string>();
  return values.map(value => value.trim()).filter(value => {
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The raw bound only stops abusive payloads; the visible limit applies after
// blanks and repeats are removed so a stray empty row is not an error.
const profileTextList = (itemMax: number, listMax: number, noun: string) =>
  z.array(z.string().trim().max(itemMax, `Keep each ${noun} to ${itemMax} characters`)).max(50)
    .transform(distinctText)
    .refine(values => values.length <= listMax, `Add at most ${listMax} ${noun}s`);

// Vocabulary lists are stored in canonical order so every surface reads the
// same way regardless of the order the boxes were ticked.
const vocabularyList = <T extends readonly [string, ...string[]]>(vocabulary: T) =>
  z.array(z.enum(vocabulary)).max(20)
    .transform(values => vocabulary.filter(item => values.includes(item)) as Array<T[number]>);

const currentYear = () => DateTime.now().setZone('Asia/Singapore').year;

/**
 * A coach's portable, self-described profile. Qualifications are
 * self-reported; Courtly does not verify them and the UI says so.
 */
export const coachProfileSchema = z.object({
  bio: z.string().trim().max(600, 'Keep the coaching bio to 600 characters').optional(),
  languages: profileTextList(40, 8, 'language').optional(),
  coachingLevels: vocabularyList(coachingLevels).optional(),
  coachingAgeGroups: vocabularyList(coachingAgeGroups).optional(),
  qualifications: profileTextList(80, 10, 'qualification').optional(),
  coachingSince: z.number().int('Use a four-digit year')
    .min(COACHING_SINCE_MIN, `Use a year from ${COACHING_SINCE_MIN} onwards`)
    .refine(year => year <= currentYear(), 'Coaching since cannot be in the future')
    .nullable().optional(),
}).strict();
export type CoachProfileInput = z.infer<typeof coachProfileSchema>;

type CoachProfileColumns = Pick<User, 'bio' | 'languages' | 'coachingLevels' | 'coachingAgeGroups' | 'qualifications' | 'coachingSince'>;

/** Exactly the columns a public coach card may read; never contact details. */
export const coachPublicProfileSelect = {
  accountType: true, sports: true, bio: true, languages: true, coachingLevels: true,
  coachingAgeGroups: true, qualifications: true, coachingSince: true,
} satisfies Prisma.UserSelect;

export const coachProfileJson = (user: CoachProfileColumns) => ({
  bio: user.bio, languages: user.languages, coachingLevels: user.coachingLevels,
  coachingAgeGroups: user.coachingAgeGroups, qualifications: user.qualifications,
  coachingSince: user.coachingSince,
});

/**
 * The public coach card. It never carries contact details, and it is omitted
 * entirely when the coach has said nothing about themselves yet.
 */
export function coachPublicProfileJson(user: CoachProfileColumns & Pick<User, 'sports'>) {
  const profile = { ...coachProfileJson(user), sports: user.sports };
  const empty = !profile.bio && !profile.languages.length && !profile.coachingLevels.length
    && !profile.coachingAgeGroups.length && !profile.qualifications.length
    && profile.coachingSince === null && !profile.sports.length;
  return empty ? null : profile;
}

const personalProfileFields = {
  name: z.string().trim().min(2).max(120).optional(),
  username: usernameSchema.optional(),
  sports: sportsSchema.optional(),
  phone: z.string().trim().max(40).optional(),
  parentName: z.string().trim().max(120).optional(),
};

export const editablePersonalProfile = z.object(personalProfileFields)
  .strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one profile field' });

// A separate schema rather than an optional field on the personal one, so a
// student-only route can never pass coach columns through to the database.
export const editableCoachAccountProfile = z.object({
  ...personalProfileFields,
  coachProfile: coachProfileSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one profile field' });

export const editableClubAccountProfile = z.object({
  username: usernameSchema.optional(),
  sports: sportsSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one profile field' });

export type PersonalProfileInput = z.infer<typeof editableCoachAccountProfile>;

/**
 * Update identity-level details without requiring or selecting a business.
 * Linked student and instructor records are synchronized explicitly so each
 * workspace sees the current account details on future bookings.
 */
export async function updatePersonalProfile(userId: string, input: PersonalProfileInput) {
  const { coachProfile, ...identity } = input;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Coach profile columns live on User; the database rejects them on any
    // account that is not a coach, so a mistaken caller cannot persist them.
    await tx.user.update({ where: { id: userId }, data: { ...identity, ...(coachProfile ?? {}) } });
    if (input.name !== undefined) {
      await tx.instructor.updateMany({
        where: { membership: { is: { userId } } },
        data: { name: input.name, initials: initials(input.name) },
      });
    }
    await tx.student.updateMany({
      where: { userId },
      data: {
        ...(input.name !== undefined ? { name: input.name, initials: initials(input.name) } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.parentName !== undefined ? { parentName: input.parentName } : {}),
      },
    });
  });
}
