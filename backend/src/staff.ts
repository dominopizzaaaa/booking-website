import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError } from './http.js';

export const staffRouter = Router();
const ownerOnly = asyncRoute((req, _res, next) => {
  if (!req.auth) throw new HttpError(401, 'Please sign in to continue');
  if (req.auth.user.role !== 'OWNER') throw new HttpError(403, 'Only the owner can manage staff access');
  next();
});
const idSchema = z.string().trim().min(1).max(200);
const staffFields = {
  name: z.string().trim().min(1).max(120),
  role: z.enum(['ADMIN', 'COACH']),
  instructorId: idSchema.nullable().optional(),
};
const createStaffSchema = z.object({
  ...staffFields,
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
  password: z.string().min(12, 'Use a password with at least 12 characters').max(72)
    .refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes'),
}).strict();
const updateStaffSchema = z.object(staffFields).partial().strict()
  .refine(value => Object.keys(value).length > 0, 'Provide a name, role, or instructor to update');
// Select safe fields at the database boundary: password hashes never enter a response.
const staffSelect = { id: true, name: true, email: true, role: true, instructorId: true, createdAt: true } satisfies Prisma.UserSelect;

async function validateInstructor(tx: Prisma.TransactionClient, businessId: string, role: string, instructorId: string | null, userId?: string) {
  if (role === 'COACH' && !instructorId) throw new HttpError(400, 'A coach login must be linked to an instructor');
  if (!instructorId) return;
  const instructor = await tx.instructor.findFirst({
    where: { id: instructorId, businessId }, select: { id: true, user: { select: { id: true } } },
  });
  if (!instructor) throw new HttpError(400, 'Choose an instructor from this business');
  if (instructor.user && instructor.user.id !== userId) throw new HttpError(409, 'This instructor already has a staff login');
}

staffRouter.get('/staff', ownerOnly, asyncRoute(async (req, res) => {
  const staff = await prisma.user.findMany({
    where: { businessId: req.auth.business.id }, select: staffSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  res.json(staff);
}));

staffRouter.post('/staff', ownerOnly, asyncRoute(async (req, res) => {
  const input = createStaffSchema.parse(req.body);
  const businessId = req.auth.business.id;
  const passwordHash = await bcrypt.hash(input.password, 12);
  const staff = await prisma.$transaction(async tx => {
    const instructorId = input.instructorId ?? null;
    await validateInstructor(tx, businessId, input.role, instructorId);
    return tx.user.create({
      data: { businessId, name: input.name, email: input.email, passwordHash, role: input.role, instructorId },
      select: staffSelect,
    });
  }, { isolationLevel: 'Serializable' });
  res.status(201).json(staff);
}));

staffRouter.patch('/staff/:id', ownerOnly, asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const input = updateStaffSchema.parse(req.body);
  const businessId = req.auth.business.id;
  const staff = await prisma.$transaction(async tx => {
    const current = await tx.user.findFirst({ where: { id, businessId }, select: staffSelect });
    if (!current) throw new HttpError(404, 'Staff login not found');
    if (current.role === 'OWNER' || current.id === req.auth.user.id) throw new HttpError(403, 'Owner access cannot be changed here');
    const role = input.role ?? current.role;
    const instructorId = input.instructorId === undefined ? current.instructorId : input.instructorId;
    await validateInstructor(tx, businessId, role, instructorId, current.id);
    return tx.user.update({
      where: { id, businessId, role: { not: 'OWNER' } },
      data: { ...(input.name === undefined ? {} : { name: input.name }), role, instructorId }, select: staffSelect,
    });
  }, { isolationLevel: 'Serializable' });
  res.json(staff);
}));

staffRouter.delete('/staff/:id', ownerOnly, asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  await prisma.$transaction(async tx => {
    const current = await tx.user.findFirst({ where: { id, businessId }, select: { id: true, role: true } });
    if (!current) throw new HttpError(404, 'Staff login not found');
    if (current.role === 'OWNER' || current.id === req.auth.user.id) throw new HttpError(403, 'Owner access cannot be removed');
    // AuthSession rows cascade; the instructor roster and existing lessons are preserved.
    await tx.user.delete({ where: { id, businessId, role: { not: 'OWNER' } }, select: { id: true } });
  }, { isolationLevel: 'Serializable' });
  res.json({ ok: true });
}));
