import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError, initials, type AuthRequest } from './http.js';

export const staffRouter = Router();

const ownerOnly = asyncRoute((req, _res, next) => {
  if (!req.auth) throw new HttpError(401, 'Please sign in to continue');
  if (req.auth.membership?.role !== 'OWNER') throw new HttpError(403, 'Only the owner can manage staff access');
  next();
});

const idSchema = z.string().trim().min(1).max(200);
const roleSchema = z.enum(['ADMIN', 'COACH']);
const instructorIdSchema = idSchema.nullable().optional();
const createStaffSchema = z.object({
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
  role: roleSchema,
  instructorId: instructorIdSchema,
}).strict();
const updateStaffSchema = z.object({
  role: roleSchema.optional(),
  instructorId: instructorIdSchema,
}).strict().refine(value => Object.keys(value).length > 0, 'Provide a role or instructor to update');

// Select identity fields explicitly so password hashes never enter a staff response.
const staffSelect = {
  id: true, userId: true, role: true, instructorId: true, active: true, createdAt: true,
  user: { select: { name: true, email: true, accountType: true } },
} satisfies Prisma.MembershipSelect;
type StaffMembership = Prisma.MembershipGetPayload<{ select: typeof staffSelect }>;

const staffJson = (membership: StaffMembership) => ({
  id: membership.id,
  userId: membership.userId,
  name: membership.user.name,
  email: membership.user.email,
  accountType: membership.user.accountType,
  role: membership.role,
  instructorId: membership.instructorId,
  active: membership.active,
  createdAt: membership.createdAt,
});

function ownerBusinessId(req: AuthRequest) {
  const membership = req.auth?.membership;
  if (!membership || membership.role !== 'OWNER') throw new HttpError(403, 'Only the owner can manage staff access');
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
        id: true, userId: true, role: true,
        user: { select: { id: true, email: true, passwordHash: true, accountType: true } },
      } },
    },
  });
  if (!instructor) throw new HttpError(400, 'Choose an instructor from this business');
  if (instructor.membership && instructor.membership.id !== membershipId) {
    const migrated = instructor.membership.id === `legacy-membership-${instructor.id}`
      && instructor.membership.userId === `legacy-instructor-${instructor.id}`
      && instructor.membership.user.id === `legacy-instructor-${instructor.id}`
      && instructor.membership.user.email === `legacy-instructor-${createHash('md5').update(instructor.id).digest('hex')}@unclaimed.courtly.invalid`;
    const seeded = instructor.membership.id === `seed-membership-${instructor.id}`
      && instructor.membership.userId === `seed-instructor-${instructor.id}`
      && instructor.membership.user.id === `seed-instructor-${instructor.id}`
      && instructor.membership.user.email === `seed-instructor-${instructor.id}@unclaimed.courtly.invalid`;
    const placeholder = (migrated || seeded)
      && instructor.membership.role === 'COACH'
      && instructor.membership.user.passwordHash === null
      && instructor.membership.user.accountType === 'COACH';
    if (replacePlaceholder && placeholder) {
      return { membershipId: instructor.membership.id, userId: instructor.membership.userId };
    }
    throw new HttpError(409, 'This instructor already has a staff membership');
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

const newInstructor = (businessId: string, user: { name: string; email: string }) => ({
  business: { connect: { id: businessId } },
  name: user.name,
  email: user.email,
  initials: initials(user.name),
});

staffRouter.get('/staff', ownerOnly, asyncRoute(async (req, res) => {
  const staff = await prisma.membership.findMany({
    where: { businessId: ownerBusinessId(req), user: { passwordHash: { not: null } } },
    select: staffSelect,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  res.json(staff.map(staffJson));
}));

staffRouter.post('/staff', ownerOnly, asyncRoute(async (req, res) => {
  const input = createStaffSchema.parse(req.body);
  const businessId = ownerBusinessId(req);
  const staff = await prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({
      where: { email: input.email },
      select: { id: true, name: true, email: true, passwordHash: true, accountType: true },
    });
    if (!user || user.passwordHash === null) {
      throw new HttpError(404, 'No registered Courtly account was found for this email. Ask this person to self-register first');
    }
    if (user.accountType === 'CUSTOMER') {
      throw new HttpError(400, 'This account is registered as a customer, not a provider');
    }

    const existing = await tx.membership.findUnique({
      where: { userId_businessId: { userId: user.id, businessId } },
      select: { id: true },
    });
    if (existing) throw new HttpError(409, 'This account already has access to this business');

    const placeholder = input.instructorId
      ? await validateInstructor(tx, businessId, input.instructorId, undefined, true)
      : null;
    if (placeholder) await removePlaceholder(tx, placeholder);
    const created = await tx.membership.create({
      data: {
        user: { connect: { id: user.id } },
        business: { connect: { id: businessId } },
        role: input.role,
        active: true,
        ...(input.instructorId
          ? { instructor: { connect: { id: input.instructorId } } }
          : input.role === 'COACH'
            ? { instructor: { create: newInstructor(businessId, user) } }
            : {}),
      },
      select: staffSelect,
    });
    if (created.instructorId) {
      const linked = await tx.instructor.findFirst({ where: { id: created.instructorId, businessId }, select: { id: true } });
      if (!linked) throw new HttpError(400, 'Instructor membership must belong to this business');
      await tx.instructor.update({
        where: { id: created.instructorId },
        data: { active: true, name: created.user.name, email: created.user.email, initials: initials(created.user.name) },
      });
    }
    return created;
  }, { isolationLevel: 'Serializable' });
  res.status(201).json(staffJson(staff));
}));

staffRouter.patch('/staff/:membershipId', ownerOnly, asyncRoute(async (req, res) => {
  const membershipId = idSchema.parse(req.params.membershipId);
  const input = updateStaffSchema.parse(req.body);
  const businessId = ownerBusinessId(req);
  const staff = await prisma.$transaction(async tx => {
    const current = await tx.membership.findFirst({
      where: { id: membershipId, businessId },
      select: staffSelect,
    });
    if (!current) throw new HttpError(404, 'Staff membership not found');
    if (current.role === 'OWNER' || current.userId === req.auth.user.id) {
      throw new HttpError(403, 'Owner access cannot be changed here');
    }

    const role = input.role ?? current.role;
    const requestedInstructorId = input.instructorId === undefined ? current.instructorId : input.instructorId;
    const placeholder = input.instructorId
      ? await validateInstructor(tx, businessId, input.instructorId, current.id, true)
      : null;
    if (placeholder) await removePlaceholder(tx, placeholder);
    const createRoster = role === 'COACH' && requestedInstructorId === null;

    const updated = await tx.membership.update({
      where: { id: current.id },
      data: {
        role,
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

staffRouter.delete('/staff/:membershipId', ownerOnly, asyncRoute(async (req, res) => {
  const membershipId = idSchema.parse(req.params.membershipId);
  const businessId = ownerBusinessId(req);
  await prisma.$transaction(async tx => {
    const current = await tx.membership.findFirst({
      where: { id: membershipId, businessId },
      select: { id: true, userId: true, role: true, instructorId: true },
    });
    if (!current) throw new HttpError(404, 'Staff membership not found');
    if (current.role === 'OWNER' || current.userId === req.auth.user.id) {
      throw new HttpError(403, 'Owner access cannot be removed');
    }

    await tx.authSession.updateMany({
      where: { activeMembershipId: current.id },
      data: { activeMembershipId: null },
    });
    await tx.membership.delete({ where: { id: current.id } });
    if (current.instructorId) {
      await tx.instructor.updateMany({
        where: { id: current.instructorId, businessId }, data: { active: false },
      });
    }
  }, { isolationLevel: 'Serializable' });
  res.json({ ok: true });
}));
