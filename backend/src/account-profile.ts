import type { Prisma } from '@prisma/client';
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

export const editablePersonalProfile = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  username: usernameSchema.optional(),
  sports: sportsSchema.optional(),
  phone: z.string().trim().max(40).optional(),
  parentName: z.string().trim().max(120).optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one profile field' });

export const editableClubAccountProfile = z.object({
  username: usernameSchema.optional(),
  sports: sportsSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one profile field' });

export type PersonalProfileInput = z.infer<typeof editablePersonalProfile>;

/**
 * Update identity-level details without requiring or selecting a business.
 * Linked student and instructor records are synchronized explicitly so each
 * workspace sees the current account details on future bookings.
 */
export async function updatePersonalProfile(userId: string, input: PersonalProfileInput) {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.user.update({ where: { id: userId }, data: input });
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
