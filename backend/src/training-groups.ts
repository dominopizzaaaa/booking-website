import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError, requireClubPermission } from './http.js';
import { bookableInstructorWhere } from './scheduling.js';

type Tx = Prisma.TransactionClient;

// Training groups are a club-local operating roster, never an account type or
// a teaching affiliation. Only club-side people with the named student
// permission read or change them; a coach working in the club gets 403 from
// the permission guard because coaches never manage cohorts.
export const trainingGroupsRouter = Router();

const id = z.string().trim().min(1).max(200);
const optionalId = id.nullable().optional();
const groupFields = {
  name: z.string().trim().min(1, 'Give the group a name').max(80),
  sport: z.string().trim().max(40).optional(),
  level: z.string().trim().max(40).optional(),
  ageBand: z.string().trim().max(40).optional(),
  description: z.string().trim().max(600).optional(),
  scheduleNote: z.string().trim().max(120).optional(),
  capacity: z.number().int().min(1).max(500).nullable().optional(),
  serviceId: optionalId,
  locationId: optionalId,
  instructorId: optionalId,
};
const groupCreate = z.object(groupFields).strict();
const groupPatch = z.object({
  ...groupFields,
  name: groupFields.name.optional(),
  active: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one training group field to update' });
const membersInput = z.object({
  studentIds: z.array(id).max(200, 'A training group can list at most 200 students at once'),
}).strict();
const listQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() }).strict();

const groupInclude = {
  members: {
    where: { active: true },
    include: { student: { select: { name: true, initials: true } } },
    orderBy: [{ student: { name: 'asc' } }, { joinedAt: 'asc' }],
  },
} satisfies Prisma.TrainingGroupInclude;
type GroupWithMembers = Prisma.TrainingGroupGetPayload<{ include: typeof groupInclude }>;

function trainingGroupJson(group: GroupWithMembers) {
  return {
    id: group.id, name: group.name, sport: group.sport, level: group.level, ageBand: group.ageBand,
    description: group.description, scheduleNote: group.scheduleNote, capacity: group.capacity,
    serviceId: group.serviceId, locationId: group.locationId, instructorId: group.instructorId,
    active: group.active, createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString(),
    members: group.members.map(member => ({
      studentId: member.studentId, name: member.student.name, initials: member.student.initials,
      joinedAt: member.joinedAt.toISOString(),
    })),
  };
}

/**
 * Scheduling defaults are optional, but a newly chosen default must be live in
 * this club so the series dialog it prefills can actually book it. A default
 * that is archived later is kept and simply ignored by the workspace.
 */
async function validateDefaults(
  tx: Tx, businessId: string,
  next: { serviceId?: string | null; locationId?: string | null; instructorId?: string | null },
  current?: { serviceId: string | null; locationId: string | null; instructorId: string | null },
) {
  const changed = (key: 'serviceId' | 'locationId' | 'instructorId') =>
    typeof next[key] === 'string' && next[key] !== current?.[key];
  if (changed('serviceId') && !await tx.service.findFirst({
    where: { id: next.serviceId!, businessId, active: true }, select: { id: true },
  })) throw new HttpError(400, 'Choose an active Class from this club');
  if (changed('locationId') && !await tx.location.findFirst({
    where: { id: next.locationId!, businessId, active: true }, select: { id: true },
  })) throw new HttpError(400, 'Choose an active venue from this club');
  if (changed('instructorId') && !await tx.instructor.findFirst({
    where: { id: next.instructorId!, ...bookableInstructorWhere(businessId) }, select: { id: true },
  })) throw new HttpError(400, 'Choose a bookable coach from this club');
}

async function lockGroup(tx: Tx, businessId: string, groupId: string) {
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "TrainingGroup" WHERE "id" = ${groupId} AND "businessId" = ${businessId} FOR UPDATE`;
  if (!locked) throw new HttpError(404, 'Training group not found');
}

trainingGroupsRouter.get('/training-groups', requireClubPermission('STUDENTS_VIEW'), asyncRoute(async (req, res) => {
  const query = listQuery.parse(req.query);
  const groups = await prisma.trainingGroup.findMany({
    where: { businessId: req.auth.business.id, ...(query.includeArchived === 'true' ? {} : { active: true }) },
    include: groupInclude,
    orderBy: [{ active: 'desc' }, { name: 'asc' }, { createdAt: 'asc' }],
  });
  res.json({ groups: groups.map(trainingGroupJson) });
}));

trainingGroupsRouter.post('/training-groups', requireClubPermission('STUDENTS_MANAGE'), asyncRoute(async (req, res) => {
  const input = groupCreate.parse(req.body);
  const businessId = req.auth.business.id;
  const group = await prisma.$transaction(async tx => {
    await validateDefaults(tx, businessId, input);
    return tx.trainingGroup.create({ data: { businessId, ...input }, include: groupInclude });
  });
  res.status(201).json(trainingGroupJson(group));
}));

trainingGroupsRouter.patch('/training-groups/:id', requireClubPermission('STUDENTS_MANAGE'), asyncRoute(async (req, res) => {
  const groupId = id.parse(req.params.id);
  const input = groupPatch.parse(req.body);
  const businessId = req.auth.business.id;
  const group = await prisma.$transaction(async tx => {
    await lockGroup(tx, businessId, groupId);
    const current = await tx.trainingGroup.findUniqueOrThrow({
      where: { id: groupId }, include: { _count: { select: { members: { where: { active: true } } } } },
    });
    await validateDefaults(tx, businessId, input, current);
    if (input.capacity != null && input.capacity < current._count.members) {
      throw new HttpError(409, `This group already has ${current._count.members} members. Remove some before lowering its capacity`);
    }
    return tx.trainingGroup.update({ where: { id: groupId, businessId }, data: input, include: groupInclude });
  });
  res.json(trainingGroupJson(group));
}));

trainingGroupsRouter.put('/training-groups/:id/members', requireClubPermission('STUDENTS_MANAGE'), asyncRoute(async (req, res) => {
  const groupId = id.parse(req.params.id);
  const studentIds = [...new Set(membersInput.parse(req.body).studentIds)];
  const businessId = req.auth.business.id;
  const group = await prisma.$transaction(async tx => {
    await lockGroup(tx, businessId, groupId);
    const current = await tx.trainingGroup.findUniqueOrThrow({ where: { id: groupId } });
    if (!current.active) throw new HttpError(409, 'Restore this training group before changing its members');
    if (current.capacity != null && studentIds.length > current.capacity) {
      throw new HttpError(409, `This group has room for ${current.capacity} member${current.capacity === 1 ? '' : 's'}`);
    }
    const found = studentIds.length
      ? await tx.student.count({ where: { id: { in: studentIds }, businessId } })
      : 0;
    if (found !== studentIds.length) throw new HttpError(400, 'Every member must be a student of this club');
    const existing = await tx.trainingGroupMember.findMany({ where: { groupId, businessId } });
    const wanted = new Set(studentIds);
    const now = new Date();
    const leaving = existing.filter(member => member.active && !wanted.has(member.studentId)).map(member => member.id);
    if (leaving.length) {
      await tx.trainingGroupMember.updateMany({ where: { id: { in: leaving } }, data: { active: false, leftAt: now } });
    }
    // A returning student keeps their one membership row; joinedAt restarts
    // so the roster shows when the current stint began.
    const returning = existing.filter(member => !member.active && wanted.has(member.studentId)).map(member => member.id);
    if (returning.length) {
      await tx.trainingGroupMember.updateMany({ where: { id: { in: returning } }, data: { active: true, leftAt: null, joinedAt: now } });
    }
    const known = new Set(existing.map(member => member.studentId));
    const joining = studentIds.filter(studentId => !known.has(studentId));
    if (joining.length) {
      await tx.trainingGroupMember.createMany({
        data: joining.map(studentId => ({ businessId, groupId, studentId, active: true, joinedAt: now })),
      });
    }
    // Membership changes are edits to the group; keep updatedAt truthful.
    return tx.trainingGroup.update({ where: { id: groupId, businessId }, data: { updatedAt: now }, include: groupInclude });
  });
  res.json(trainingGroupJson(group));
}));

trainingGroupsRouter.delete('/training-groups/:id', requireClubPermission('STUDENTS_MANAGE'), asyncRoute(async (req, res) => {
  const groupId = id.parse(req.params.id);
  const businessId = req.auth.business.id;
  const group = await prisma.$transaction(async tx => {
    await lockGroup(tx, businessId, groupId);
    // Archiving keeps the roster for history and a later restore.
    return tx.trainingGroup.update({ where: { id: groupId, businessId }, data: { active: false }, include: groupInclude });
  });
  res.json(trainingGroupJson(group));
}));
