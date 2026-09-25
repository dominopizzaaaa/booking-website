import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError, initials, requireClubAccount, type AuthRequest } from './http.js';
import { resolveRegisteredAccountIdentity } from './account-directory.js';

export const staffRouter = Router();

const idSchema = z.string().trim().min(1).max(200);
const instructorIdSchema = idSchema.nullable().optional();
const rescheduleNoticeHoursSchema = z.number().int().min(0).max(720).optional();
// Everyone a club adds is a coach: there is no other thing to be. The club
// account is the club, and it is created with the club rather than invited.
const legacyCreateStaffSchema = z.object({
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
  instructorId: instructorIdSchema,
  rescheduleNoticeHours: rescheduleNoticeHoursSchema,
}).strict();
const queryCreateStaffSchema = z.object({
  query: z.string().trim().min(2).max(254),
  instructorId: instructorIdSchema,
  rescheduleNoticeHours: rescheduleNoticeHoursSchema,
}).strict();
const createStaffSchema = z.union([queryCreateStaffSchema, legacyCreateStaffSchema])
  .transform(input => ({
    query: 'query' in input ? input.query : input.email,
    instructorId: input.instructorId,
    rescheduleNoticeHours: input.rescheduleNoticeHours,
  }));
const updateStaffSchema = z.object({
  instructorId: instructorIdSchema,
}).strict();

// Select identity fields explicitly so password hashes never enter a staff response.
const staffSelect = {
  id: true, userId: true, instructorId: true, active: true, createdAt: true,
  user: { select: { name: true, username: true, email: true, accountType: true, sports: true } },
} satisfies Prisma.MembershipSelect;
type StaffMembership = Prisma.MembershipGetPayload<{ select: typeof staffSelect }>;
type InstructorAffiliation = {
  id: string;
  userId: string;
  user: { id: string; email: string; passwordHash: string | null; accountType: string };
};

const staffJson = (membership: StaffMembership) => ({
  id: membership.id,
  userId: membership.userId,
  name: membership.user.name,
  username: membership.user.username,
  email: membership.user.email,
  accountType: membership.user.accountType,
  sports: membership.user.sports,
  instructorId: membership.instructorId,
  active: membership.active,
  createdAt: membership.createdAt,
});

// Only deterministic credential-less placeholders may give their roster row
// to a newly registered coach. A deactivated real affiliation stays attached
// forever because historical lessons use it to identify that coach.
export function isReplaceableInstructorPlaceholder(
  instructorId: string,
  membership: InstructorAffiliation | null | undefined,
) {
  if (!membership) return false;
  const migrated = membership.id === `legacy-membership-${instructorId}`
    && membership.userId === `legacy-instructor-${instructorId}`
    && membership.user.id === `legacy-instructor-${instructorId}`
    && membership.user.email === `legacy-instructor-${createHash('md5').update(instructorId).digest('hex')}@unclaimed.courtly.invalid`;
  const seeded = membership.id === `seed-membership-${instructorId}`
    && membership.userId === `seed-instructor-${instructorId}`
    && membership.user.id === `seed-instructor-${instructorId}`
    && membership.user.email === `seed-instructor-${instructorId}@unclaimed.courtly.invalid`;
  return (migrated || seeded)
    && membership.user.passwordHash === null
    && membership.user.accountType === 'COACH';
}

function clubBusinessId(req: AuthRequest) {
  const membership = req.auth?.membership;
  if (!membership || req.auth?.user.accountType !== 'CLUB'
    || req.auth.business?.kind !== 'CLUB' || membership.instructorId !== null) {
    throw new HttpError(403, 'Only the club account can manage its coaches');
  }
  return membership.businessId;
}

async function validateInstructor(
  tx: Prisma.TransactionClient,
  businessId: string,
  instructorId: string,
  membershipId?: string,
  replacePlaceholder = false,
) {
  const instructor = await tx.instructor.findFirst({
    where: { id: instructorId, businessId },
    select: {
      id: true,
      membership: { select: {
        id: true, userId: true,
        user: { select: { id: true, email: true, passwordHash: true, accountType: true } },
      } },
    },
  });
  if (!instructor) throw new HttpError(400, 'Choose an instructor from this business');
  if (instructor.membership && instructor.membership.id !== membershipId) {
    const placeholder = isReplaceableInstructorPlaceholder(instructor.id, instructor.membership);
    if (replacePlaceholder && placeholder) {
      return { membershipId: instructor.membership.id, userId: instructor.membership.userId };
    }
    throw new HttpError(409, 'This instructor is already linked to a coach affiliation');
  }
  return null;
}

async function removePlaceholder(
  tx: Prisma.TransactionClient,
  placeholder: { membershipId: string; userId: string },
) {
  await tx.membership.delete({ where: { id: placeholder.membershipId } });
  // Migration-only placeholder accounts have no credentials and should not
  // outlive their last placeholder membership after the roster is claimed.
  await tx.user.deleteMany({
    where: {
      id: placeholder.userId,
      passwordHash: null, accountType: 'COACH', memberships: { none: {} },
    },
  });
}

const newInstructor = (
  businessId: string,
  user: { name: string; email: string },
  rescheduleNoticeHours?: number,
) => ({
  business: { connect: { id: businessId } },
  name: user.name,
  email: user.email,
  initials: initials(user.name),
  ...(rescheduleNoticeHours === undefined ? {} : { rescheduleNoticeHours }),
});

staffRouter.get('/staff', requireClubAccount, asyncRoute(async (req, res) => {
  const staff = await prisma.membership.findMany({
    // A removed affiliation remains in the database to preserve the coach
    // identity behind historical lessons. This endpoint is the access roster,
    // however, so only memberships that can currently enter the club belong
    // in the list. Re-adding the same email restores the retained row below.
    where: { businessId: clubBusinessId(req), active: true, user: { passwordHash: { not: null } } },
    select: staffSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  res.json(staff.map(staffJson));
}));

staffRouter.post('/staff', requireClubAccount, asyncRoute(async (req, res) => {
  const input = createStaffSchema.parse(req.body);
  const businessId = clubBusinessId(req);
  const staff = await prisma.$transaction(async tx => {
    const user = await resolveRegisteredAccountIdentity(tx, input.query);
    if (!user) {
      throw new HttpError(404, 'No registered Courtly account was found for this name, username, or email. Ask this person to self-register first.');
    }
    if (user.accountType === 'STUDENT') {
      throw new HttpError(400, 'This account is registered as a student, not a coach');
    }

    const existing = await tx.membership.findUnique({
      where: { userId_businessId: { userId: user.id, businessId } },
      select: { id: true, active: true, instructorId: true },
    });
    if (existing?.active) throw new HttpError(409, 'This account already has access to this business');

    // Only a coach joins a club's roster. A club account is the club itself,
    // created with it, and belongs to that one club alone.
    if (user.accountType !== 'COACH') {
      throw new HttpError(400, 'Only a coach account can be added to a club. Ask them to register as a coach first.');
    }

    if (existing) {
      if (!existing.instructorId) {
        throw new HttpError(409, 'This former coach affiliation is missing its retained coach profile. Contact support before restoring access.');
      }
      // Re-using the retained roster identity is what keeps old club lessons
      // attributable to this coach account. A new or different profile here
      // would silently sever that history and bypass the club safeguard.
      if (input.instructorId && input.instructorId !== existing.instructorId) {
        throw new HttpError(409, 'This coach has a retained profile with lesson history. Re-add them without choosing a different coach profile.');
      }
      const restored = await tx.membership.update({
        where: { id: existing.id },
        data: { active: true },
        select: staffSelect,
      });
      const activated = await tx.instructor.updateMany({
        where: { id: existing.instructorId, businessId },
        data: {
          active: true, name: user.name, email: user.email, initials: initials(user.name),
          ...(input.rescheduleNoticeHours === undefined ? {} : { rescheduleNoticeHours: input.rescheduleNoticeHours }),
        },
      });
      if (activated.count !== 1) {
        throw new HttpError(409, 'This former coach affiliation is missing its retained coach profile. Contact support before restoring access.');
      }
      return { staff: restored, restored: true };
    }

    const placeholder = input.instructorId
      ? await validateInstructor(tx, businessId, input.instructorId, undefined, true)
      : null;
    if (placeholder) await removePlaceholder(tx, placeholder);
    const created = await tx.membership.create({
      data: {
        user: { connect: { id: user.id } },
        business: { connect: { id: businessId } },
        active: true,
        // Every coach on a roster has a roster entry; one is created unless the
        // club is reconnecting an existing profile with history behind it.
        ...(input.instructorId
          ? { instructor: { connect: { id: input.instructorId } } }
          : { instructor: { create: newInstructor(businessId, user, input.rescheduleNoticeHours) } }),
      },
      select: staffSelect,
    });
    if (created.instructorId) {
      const linked = await tx.instructor.findFirst({ where: { id: created.instructorId, businessId }, select: { id: true } });
      if (!linked) throw new HttpError(400, 'Instructor membership must belong to this business');
      await tx.instructor.update({
        where: { id: created.instructorId },
        data: {
          active: true, name: created.user.name, email: created.user.email, initials: initials(created.user.name),
          ...(input.rescheduleNoticeHours === undefined ? {} : { rescheduleNoticeHours: input.rescheduleNoticeHours }),
        },
      });
    }
    return { staff: created, restored: false };
  }, { isolationLevel: 'Serializable' });
  res.status(staff.restored ? 200 : 201).json(staffJson(staff.staff));
}));

staffRouter.patch('/staff/:membershipId', requireClubAccount, asyncRoute(async (req, res) => {
  const membershipId = idSchema.parse(req.params.membershipId);
  const input = updateStaffSchema.parse(req.body);
  const businessId = clubBusinessId(req);
  const staff = await prisma.$transaction(async tx => {
    const current = await tx.membership.findFirst({
      where: { id: membershipId, businessId },
      select: staffSelect,
    });
    if (!current) throw new HttpError(404, 'Staff membership not found');
    if (current.userId === req.auth.user.id) {
      throw new HttpError(403, 'The club account cannot change its own access here');
    }
    if (!current.active) {
      throw new HttpError(409, 'Coach access has been removed. Add the coach again to restore it.');
    }

    const requestedInstructorId = input.instructorId === undefined ? current.instructorId : input.instructorId;
    if (current.instructorId && requestedInstructorId !== current.instructorId) {
      const historicalLessons = await tx.booking.count({
        where: { businessId, instructorId: current.instructorId },
      });
      if (historicalLessons) {
        throw new HttpError(409, 'This coach profile has lesson history and cannot be replaced. Edit its roster details instead.');
      }
    }
    const placeholder = input.instructorId
      ? await validateInstructor(tx, businessId, input.instructorId, current.id, true)
      : null;
    if (placeholder) await removePlaceholder(tx, placeholder);
    // A coach without a roster entry cannot be scheduled, so detaching one
    // immediately creates a fresh profile in its place.
    const createRoster = requestedInstructorId === null;

    const updated = await tx.membership.update({
      where: { id: current.id },
      data: {
        ...(createRoster
          ? { instructor: { create: newInstructor(businessId, current.user) } }
          : input.instructorId === undefined
            ? {}
            : input.instructorId === null
              ? { instructor: { disconnect: true } }
              : { instructor: { connect: { id: input.instructorId } } }),
      },
      select: staffSelect,
    });
    if (current.instructorId && current.instructorId !== updated.instructorId) {
      await tx.instructor.updateMany({
        where: { id: current.instructorId, businessId },
        data: { active: false },
      });
    }
    if (updated.instructorId) {
      const linked = await tx.instructor.findFirst({ where: { id: updated.instructorId, businessId }, select: { id: true } });
      if (!linked) throw new HttpError(400, 'Instructor membership must belong to this business');
      await tx.instructor.update({
        where: { id: updated.instructorId },
        data: { active: true, name: updated.user.name, email: updated.user.email, initials: initials(updated.user.name) },
      });
    }
    return updated;
  }, { isolationLevel: 'Serializable' });
  res.json(staffJson(staff));
}));

staffRouter.delete('/staff/:membershipId', requireClubAccount, asyncRoute(async (req, res) => {
  const membershipId = idSchema.parse(req.params.membershipId);
  const businessId = clubBusinessId(req);
  await prisma.$transaction(async tx => {
    const current = await tx.membership.findFirst({
      where: { id: membershipId, businessId },
      select: { id: true, userId: true, instructorId: true },
    });
    if (!current) throw new HttpError(404, 'Staff membership not found');
    if (current.userId === req.auth.user.id) {
      throw new HttpError(403, 'The club account cannot remove its own access');
    }

    await tx.authSession.updateMany({
      where: { activeMembershipId: current.id },
      data: { activeMembershipId: null },
    });
    // Access revocation must not erase the affiliation: historical bookings
    // resolve their coach account through this link for the club safeguard.
    await tx.membership.update({
      where: { id: current.id },
      data: { active: false },
    });
    if (current.instructorId) {
      await tx.instructor.updateMany({
        where: { id: current.instructorId, businessId }, data: { active: false },
      });
    }
  }, { isolationLevel: 'Serializable' });
  res.json({ ok: true });
}));
