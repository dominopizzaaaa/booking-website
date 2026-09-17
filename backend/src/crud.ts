import { Router } from 'express';
import type { Availability, AvailabilityException, Business, Student, Instructor, LessonPackage, Location, Prisma } from '@prisma/client';
import { DateTime, IANAZone } from 'luxon';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError, coachScope, coachScoped, requireBusinessManager, requireClubAccount, initials, type AuthRequest } from './http.js';
import { bookableInstructorWhere } from './scheduling.js';
import { withoutServiceFinancials } from './serializers.js';

export const crudRouter = Router();
type Tx = Prisma.TransactionClient;
const idSchema = z.string().trim().min(1).max(200);
const nameSchema = z.string().trim().min(1).max(120);
const emailSchema = z.string().trim().max(254).email().transform(value => value.toLowerCase());
const colorSchema = z.string().trim().min(1).max(40);
// All monetary API values are integer minor units (SGD cents), matching the frontend contract.
const priceSchema = z.number().int().min(0).max(100_000_000);
const durationSchema = z.number().int().min(15).max(480);
const serviceLocationsInclude = { locations: { include: { instructors: true } } } satisfies Prisma.ServiceInclude;
type ServiceWithLocations = Prisma.ServiceGetPayload<{ include: typeof serviceLocationsInclude }>;
type StudentWithBookings = Student & { participants: { booking: { startAt: Date } }[] };
type PackageWithStudent = LessonPackage & { student: { name: string } };

const serviceJson = (service: ServiceWithLocations) => ({
  id: service.id, name: service.name, description: service.description, category: service.category,
  type: service.type, duration: service.duration, price: service.price, capacity: service.capacity,
  bufferMinutes: service.bufferMinutes, noticeHours: service.noticeHours, color: service.color, active: service.active,
  locations: service.locations.map(location => ({ locationId: location.locationId, price: location.price,
    duration: location.duration, instructorIds: location.instructors.map(instructor => instructor.instructorId) })),
});
const instructorJson = (instructor: Instructor) => ({ id: instructor.id, name: instructor.name, initials: instructor.initials,
  color: instructor.color, email: instructor.email, specialty: instructor.specialty,
  rescheduleNoticeHours: instructor.rescheduleNoticeHours, active: instructor.active });
const locationJson = (location: Location) => ({ id: location.id, name: location.name, address: location.address,
  type: location.type, color: location.color, requiresApproval: location.requiresApproval,
  travelMinutes: location.travelMinutes, notes: location.notes, source: location.source, placeId: location.placeId,
  mapsUrl: location.mapsUrl, latitude: location.latitude, longitude: location.longitude, active: location.active });
const availabilityJson = (availability: Availability) => ({ id: availability.id, instructorId: availability.instructorId,
  locationId: availability.locationId, dayOfWeek: availability.dayOfWeek, startTime: availability.startTime, endTime: availability.endTime });
const exceptionJson = (exception: AvailabilityException) => ({ id: exception.id, instructorId: exception.instructorId,
  date: exception.date, reason: exception.reason });
const packageJson = (pkg: PackageWithStudent) => ({ id: pkg.id, studentId: pkg.studentId, studentName: pkg.student.name,
  name: pkg.name, serviceId: pkg.serviceId, totalCredits: pkg.totalCredits, usedCredits: pkg.usedCredits,
  price: pkg.price, expiresAt: pkg.expiresAt.toISOString(), paid: pkg.paid });
const businessJson = (business: Business) => ({ id: business.id, name: business.name, slug: business.slug,
  ownerName: business.ownerName, email: business.email, timezone: business.timezone, currency: business.currency,
  color: business.color, tagline: business.tagline, cancellationHours: business.cancellationHours,
  kind: business.kind, isDemo: business.isDemo });
function studentJson(student: StudentWithBookings) {
  const lastBookingAt = student.participants.reduce<Date | null>((latest, participant) =>
    !latest || participant.booking.startAt > latest ? participant.booking.startAt : latest, null);
  return { id: student.id, userId: student.userId, name: student.name, email: student.email, phone: student.phone, initials: student.initials,
    notes: student.notes, parentName: student.parentName, createdAt: student.createdAt.toISOString(),
    bookingCount: student.participants.length, lastBookingAt: lastBookingAt?.toISOString() ?? null };
}
function studentInclude(businessId: string, instructorId?: string) {
  return { participants: { where: { cancelledAt: null, booking: { businessId, instructorId, status: { not: 'CANCELLED' } } },
    select: { booking: { select: { startAt: true } } } } } satisfies Prisma.StudentInclude;
}
function scopedInstructor(req: AuthRequest, requested?: string) {
  if (!coachScoped(req.auth)) return requested;
  const instructorId = req.auth.membership?.instructorId;
  if (!instructorId) throw new HttpError(403, 'This coach account is not linked to a roster entry in this club');
  if (requested) coachScope(req, requested);
  return instructorId;
}
async function requireInstructor(tx: Tx, businessId: string, instructorId: string, active = false) {
  const instructor = await tx.instructor.findFirst({
    where: { id: instructorId, ...(active ? bookableInstructorWhere(businessId) : { businessId }) },
  });
  if (!instructor) throw new HttpError(404, 'Instructor not found or unavailable');
  return instructor;
}
async function requireLocation(tx: Tx, businessId: string, locationId: string, active = false) {
  const location = await tx.location.findFirst({ where: { id: locationId, businessId, ...(active ? { active: true } : {}) } });
  if (!location) throw new HttpError(404, 'Location not found or unavailable');
  return location;
}
async function lockInstructor(tx: Tx, instructorId: string) {
  // Use the scheduling lock so availability changes and booking creation cannot interleave.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${instructorId}, 0))`;
}

const serviceLocationSchema = z.object({ locationId: idSchema, price: priceSchema, duration: durationSchema,
  instructorIds: z.array(idSchema).max(200).refine(ids => new Set(ids).size === ids.length, 'Duplicate instructors are not allowed'),
}).strict();
const serviceSchema = z.object({
  name: nameSchema, description: z.string().trim().max(4000).default(''), category: z.string().trim().min(1).max(120).default('Tennis'),
  type: z.enum(['PRIVATE', 'GROUP']).default('PRIVATE'), duration: durationSchema.default(60), price: priceSchema.default(8000),
  capacity: z.number().int().min(1).max(100).default(1), bufferMinutes: z.number().int().min(0).max(240).default(0),
  noticeHours: z.number().int().min(0).max(720).default(2), color: colorSchema.default('sage'), active: z.boolean().default(true),
  locations: z.array(serviceLocationSchema).max(200).refine(locations => new Set(locations.map(location => location.locationId)).size === locations.length,
    'Duplicate locations are not allowed').optional(),
}).strict();
type ServiceLocationInput = z.infer<typeof serviceLocationSchema>;
async function validateServiceLocations(tx: Tx, businessId: string, mappings: ServiceLocationInput[]) {
  const locationIds = mappings.map(mapping => mapping.locationId);
  const instructorIds = [...new Set(mappings.flatMap(mapping => mapping.instructorIds))];
  const [locationCount, instructorCount] = await Promise.all([
    tx.location.count({ where: { id: { in: locationIds }, businessId, active: true } }),
    tx.instructor.count({ where: { id: { in: instructorIds }, ...bookableInstructorWhere(businessId) } }),
  ]);
  if (locationCount !== locationIds.length) throw new HttpError(400, 'Every service location must be active and belong to this business');
  if (instructorCount !== instructorIds.length) throw new HttpError(400, 'Every assigned instructor must be active and belong to this business');
}
const mappingData = (mapping: ServiceLocationInput) => ({ price: mapping.price, duration: mapping.duration,
  instructors: { create: mapping.instructorIds.map(instructorId => ({ instructorId })) } });

crudRouter.get('/services', asyncRoute(async (req, res) => {
  const coach = coachScoped(req.auth);
  const instructorId = coach ? scopedInstructor(req) : undefined;
  const assignedLocationScope = { instructors: { some: { instructorId } } };
  const services = await prisma.service.findMany({
    where: {
      businessId: req.auth.business.id,
      ...(coach ? { locations: { some: assignedLocationScope } } : {}),
    },
    include: {
      locations: coach
        ? { where: assignedLocationScope, include: { instructors: { where: { instructorId } } } }
        : serviceLocationsInclude.locations,
    },
    orderBy: { name: 'asc' },
  });
  res.json(services.map(service => {
    const json = serviceJson(service);
    return coach ? withoutServiceFinancials(json) : json;
  }));
}));
crudRouter.post('/services', requireBusinessManager, asyncRoute(async (req, res) => {
  const { locations, ...input } = serviceSchema.parse(req.body);
  const businessId = req.auth.business.id;
  const service = await prisma.$transaction(async tx => {
    let mappings = locations;
    if (mappings === undefined) {
      const [activeLocations, activeInstructors] = await Promise.all([
        tx.location.findMany({ where: { businessId, active: true }, select: { id: true } }),
        tx.instructor.findMany({ where: bookableInstructorWhere(businessId), select: { id: true } }),
      ]);
      mappings = activeLocations.map(location => ({ locationId: location.id, price: input.price, duration: input.duration,
        instructorIds: activeInstructors.map(instructor => instructor.id) }));
    }
    await validateServiceLocations(tx, businessId, mappings);
    return tx.service.create({ data: { ...input, businessId, capacity: input.type === 'PRIVATE' ? 1 : input.capacity,
      locations: { create: mappings.map(mapping => ({ locationId: mapping.locationId, ...mappingData(mapping) })) } }, include: serviceLocationsInclude });
  });
  res.status(201).json(serviceJson(service));
}));
crudRouter.patch('/services/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  const { locations, ...input } = serviceSchema.partial().parse(req.body);
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  const service = await prisma.$transaction(async tx => {
    const instructorIds = await tx.instructor.findMany({ where: { businessId }, select: { id: true } });
    for (const instructor of instructorIds.sort((a, b) => a.id.localeCompare(b.id))) await lockInstructor(tx, instructor.id);
    const current = await tx.service.findFirst({ where: { id, businessId } });
    if (!current) throw new HttpError(404, 'Service not found');
    if (locations !== undefined) await validateServiceLocations(tx, businessId, locations);
    // Only the catalog changes: Booking and Participant pricing, duration and capacity remain snapshots.
    return tx.service.update({ where: { id, businessId }, data: { ...input,
      capacity: (input.type ?? current.type) === 'PRIVATE' ? 1 : input.capacity ?? current.capacity,
      ...(locations === undefined ? {} : { locations: {
        deleteMany: { locationId: { notIn: locations.map(location => location.locationId) } },
        upsert: locations.map(mapping => ({ where: { serviceId_locationId: { serviceId: id, locationId: mapping.locationId } },
          create: { locationId: mapping.locationId, ...mappingData(mapping) },
          update: { price: mapping.price, duration: mapping.duration,
            instructors: { deleteMany: {}, create: mapping.instructorIds.map(instructorId => ({ instructorId })) } } })),
      } }),
    }, include: serviceLocationsInclude });
  });
  res.json(serviceJson(service));
}));
crudRouter.delete('/services/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  const deactivated = await prisma.$transaction(async tx => {
    const service = await tx.service.findFirst({ where: { id, businessId }, include: { _count: { select: { bookings: true, packages: true } } } });
    if (!service) throw new HttpError(404, 'Service not found');
    const referenced = service._count.bookings > 0 || service._count.packages > 0;
    if (referenced) await tx.service.update({ where: { id, businessId }, data: { active: false } });
    else await tx.service.delete({ where: { id, businessId } });
    return referenced;
  });
  res.json({ ok: true, deactivated });
}));

const instructorSchema = z.object({ name: nameSchema, email: z.union([emailSchema, z.literal('')]).default(''),
  specialty: z.string().trim().max(500).default(''), color: colorSchema.default('sage'), active: z.boolean().default(true) }).strict();
const noticeHoursSchema = z.number().int().min(0).max(720);
const instructorUpdateSchema = z.object({
  specialty: z.string().trim().max(500).optional(),
  color: colorSchema.optional(),
  rescheduleNoticeHours: noticeHoursSchema.optional(),
  active: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide instructor details to update');
// A coach's own reschedule protection window is theirs to set, so it is the
// one roster field a coach can change without club-management access.
const coachSelfUpdateSchema = z.object({
  rescheduleNoticeHours: noticeHoursSchema,
}).strict();
crudRouter.get('/instructors', requireBusinessManager, asyncRoute(async (req, res) => {
  const instructors = await prisma.instructor.findMany({ where: { businessId: req.auth.business.id }, orderBy: { name: 'asc' } });
  res.json(instructors.map(instructorJson));
}));
crudRouter.post('/instructors', requireClubAccount, asyncRoute(async (req, res) => {
  const input = instructorSchema.parse(req.body);
  const businessId = req.auth.business!.id;
  const instructor = await prisma.$transaction(async tx => {
    const user = await tx.user.findUnique({ where: { email: input.email }, select: {
      id: true, name: true, email: true, accountType: true, passwordHash: true,
      memberships: { where: { businessId }, select: { id: true, active: true, instructorId: true } },
    } });
    if (!user || !user.passwordHash || user.accountType !== 'COACH') {
      throw new HttpError(404, 'Ask the coach to register their own Courtly coach account first');
    }
    const existing = user.memberships[0];
    if (existing?.active) throw new HttpError(409, 'This account already has access to this business');
    if (existing) {
      if (!existing.instructorId) {
        throw new HttpError(409, 'This former coach affiliation is missing its retained coach profile. Contact support before restoring access.');
      }
      const restored = await tx.instructor.updateMany({
        where: { id: existing.instructorId, businessId },
        data: {
          name: user.name, email: user.email, initials: initials(user.name),
          specialty: input.specialty, color: input.color, active: input.active,
        },
      });
      if (restored.count !== 1) {
        throw new HttpError(409, 'This former coach affiliation is missing its retained coach profile. Contact support before restoring access.');
      }
      await tx.membership.update({ where: { id: existing.id }, data: { active: true } });
      return {
        instructor: await tx.instructor.findUniqueOrThrow({ where: { id: existing.instructorId } }),
        restored: true,
      };
    }
    const created = await tx.instructor.create({ data: { ...input, name: user.name, email: user.email, businessId, initials: initials(user.name) } });
    await tx.membership.create({ data: { userId: user.id, businessId, instructorId: created.id } });
    return { instructor: created, restored: false };
  }, { isolationLevel: 'Serializable' });
  res.status(instructor.restored ? 200 : 201).json(instructorJson(instructor.instructor));
}));
crudRouter.patch('/instructors/me', asyncRoute(async (req, res) => {
  const input = coachSelfUpdateSchema.parse(req.body);
  const membership = req.auth.membership!;
  const instructorId = membership.instructorId;
  if (!instructorId) throw new HttpError(400, 'This account is not linked to a coach profile in this business');
  await requireInstructor(prisma, req.auth.business.id, instructorId);
  const instructor = await prisma.instructor.update({
    where: { id: instructorId, businessId: req.auth.business.id }, data: input,
  });
  res.json(instructorJson(instructor));
}));
crudRouter.patch('/instructors/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  // Name and email belong to the linked global account. Clubs may edit only
  // their own roster metadata and visibility.
  const input = instructorUpdateSchema.parse(req.body);
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  await requireInstructor(prisma, businessId, id);
  const instructor = await prisma.instructor.update({ where: { id, businessId }, data: input });
  res.json(instructorJson(instructor));
}));
crudRouter.delete('/instructors/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  const deactivated = await prisma.$transaction(async tx => {
    await lockInstructor(tx, id);
    const instructor = await tx.instructor.findFirst({ where: { id, businessId }, include: { membership: { select: { id: true } },
      _count: { select: { bookings: true, payouts: true, assignments: true, availability: true, exceptions: true } } } });
    if (!instructor) throw new HttpError(404, 'Instructor not found');
    const notificationCount = await tx.notification.count({ where: { businessId, instructorId: id } });
    const referenced = !!instructor.membership || notificationCount > 0 || Object.values(instructor._count).some(count => count > 0);
    if (referenced) await tx.instructor.update({ where: { id, businessId }, data: { active: false } });
    else await tx.instructor.delete({ where: { id, businessId } });
    return referenced;
  });
  res.json({ ok: true, deactivated });
}));

const locationSchema = z.object({ name: nameSchema, address: z.string().trim().max(500).default(''),
  type: z.enum(['FACILITY', 'RENTED', 'HOME', 'ONLINE']).default('FACILITY'), color: colorSchema.default('sage'),
  requiresApproval: z.boolean().default(false), travelMinutes: z.number().int().min(0).max(240).default(20),
  notes: z.string().trim().max(2000).default(''),
  source: z.enum(['MANUAL', 'GOOGLE_MAPS']).default('MANUAL'),
  placeId: z.string().trim().max(300).default(''),
  mapsUrl: z.string().trim().max(2000).refine(value => !value || /^https?:\/\//i.test(value), 'Use a full https link').default(''),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  active: z.boolean().default(true) }).strict();
crudRouter.get('/locations', requireBusinessManager, asyncRoute(async (req, res) => {
  const locations = await prisma.location.findMany({ where: { businessId: req.auth.business.id }, orderBy: { name: 'asc' } });
  res.json(locations.map(locationJson));
}));
// A coach who teaches somewhere new should not have to wait on the club's
// office to add the venue, so creating one is open to every workspace role.
// Editing and archiving stay with the club or the coach's own SOLO practice.
crudRouter.post('/locations', asyncRoute(async (req, res) => {
  const input = locationSchema.parse(req.body);
  const location = await prisma.location.create({ data: { ...input, businessId: req.auth.business.id } });
  res.status(201).json(locationJson(location));
}));
crudRouter.patch('/locations/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  const input = locationSchema.partial().parse(req.body);
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  await requireLocation(prisma, businessId, id);
  const location = await prisma.location.update({ where: { id, businessId }, data: input });
  res.json(locationJson(location));
}));
crudRouter.delete('/locations/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  const deactivated = await prisma.$transaction(async tx => {
    const location = await tx.location.findFirst({ where: { id, businessId }, include: { _count: { select: { bookings: true, services: true, availability: true } } } });
    if (!location) throw new HttpError(404, 'Location not found');
    const referenced = Object.values(location._count).some(count => count > 0);
    if (referenced) await tx.location.update({ where: { id, businessId }, data: { active: false } });
    else await tx.location.delete({ where: { id, businessId } });
    return referenced;
  });
  res.json({ ok: true, deactivated });
}));

const studentNotesSchema = z.string().trim().max(4000);
const studentSchema = z.object({ name: nameSchema, email: emailSchema, phone: z.string().trim().max(40).default(''),
  notes: studentNotesSchema.default(''), parentName: z.string().trim().max(120).default('') }).strict();
const connectStudentSchema = z.object({ email: emailSchema, notes: studentNotesSchema.default('') }).strict();
const linkedStudentUpdateSchema = z.object({ notes: studentNotesSchema }).strict();
crudRouter.get('/students', asyncRoute(async (req, res) => {
  const businessId = req.auth.business.id;
  const instructorId = scopedInstructor(req);
  const students = await prisma.student.findMany({ where: { businessId,
    ...(instructorId ? { participants: { some: { booking: { businessId, instructorId } } } } : {}) },
    include: studentInclude(businessId, instructorId), orderBy: { name: 'asc' } });
  res.json(students.map(studentJson));
}));
crudRouter.post('/students', requireBusinessManager, asyncRoute(async (req, res) => {
  const input = connectStudentSchema.parse(req.body);
  const businessId = req.auth.business!.id;
  const student = await prisma.$transaction(async tx => {
    const [matched] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE email = ${input.email} FOR UPDATE`;
    const user = matched ? await tx.user.findUnique({
      where: { id: matched.id },
      select: { id: true, name: true, email: true, phone: true, parentName: true, passwordHash: true, accountType: true },
    }) : null;
    if (!user?.passwordHash || user.accountType !== 'STUDENT') {
      throw new HttpError(404, 'Ask the student to register their own Courtly student account first');
    }
    if (await tx.student.findFirst({ where: { businessId, userId: user.id }, select: { id: true } })) {
      throw new HttpError(409, 'This student already belongs to this business');
    }
    const existing = await tx.student.findUnique({ where: { businessId_email: { businessId, email: user.email } } });
    if (existing?.userId) throw new HttpError(409, 'This student email is linked to another account');
    if (existing) throw new HttpError(409, 'An unverified historical student record already uses this email. It cannot be claimed automatically');
    return tx.student.create({ data: {
      businessId, userId: user.id, name: user.name, email: user.email, phone: user.phone,
      parentName: user.parentName, initials: initials(user.name), notes: input.notes,
    }, include: studentInclude(businessId) });
  }, { isolationLevel: 'Serializable' });
  res.status(201).json(studentJson(student));
}));
crudRouter.patch('/students/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  const student = await prisma.$transaction(async tx => {
    const current = await tx.student.findFirst({ where: { id, businessId }, select: { id: true, userId: true } });
    if (!current) throw new HttpError(404, 'Student not found');
    // Linked identity belongs to the global account. A manager may annotate
    // the business relationship, but only the student can change who they
    // are. Lock the account before reading it so a simultaneous profile update
    // either runs wholly before or wholly after this self-healing local edit.
    if (current.userId) {
      const input = linkedStudentUpdateSchema.parse(req.body);
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${current.userId} FOR UPDATE`;
      const account = await tx.user.findUniqueOrThrow({ where: { id: current.userId }, select: {
        name: true, email: true, phone: true, parentName: true,
      } });
      return tx.student.update({ where: { id, businessId }, data: {
        ...input, name: account.name, email: account.email, phone: account.phone, parentName: account.parentName,
        initials: initials(account.name),
      }, include: studentInclude(businessId) });
    }
    const input = studentSchema.partial().parse(req.body);
    return tx.student.update({ where: { id, businessId }, data: { ...input,
      ...(input.name === undefined ? {} : { initials: initials(input.name) }) }, include: studentInclude(businessId) });
  });
  res.json(studentJson(student));
}));
crudRouter.delete('/students/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  await prisma.$transaction(async tx => {
    const student = await tx.student.findFirst({ where: { id, businessId }, include: { _count: { select: { participants: true, packages: true, payments: true } } } });
    if (!student) throw new HttpError(404, 'Student not found');
    if (Object.values(student._count).some(count => count > 0)) throw new HttpError(409, 'Students with booking, package or payment history cannot be deleted');
    await tx.student.delete({ where: { id, businessId } });
  });
  res.json({ ok: true });
}));

const packageSchema = z.object({ studentId: idSchema, name: nameSchema, serviceId: idSchema.nullable().default(null),
  totalCredits: z.number().int().min(1).max(500), price: priceSchema,
  expiresAt: z.string().datetime({ offset: true }).transform(value => new Date(value)), paid: z.boolean().default(false) }).strict();
async function validatePackageReferences(tx: Tx, businessId: string, studentId?: string, serviceId?: string | null) {
  if (studentId && !await tx.student.findFirst({ where: { id: studentId, businessId }, select: { id: true } })) {
    throw new HttpError(404, 'Student not found');
  }
  if (serviceId && !await tx.service.findFirst({ where: { id: serviceId, businessId, active: true }, select: { id: true } })) {
    throw new HttpError(404, 'Service not found or unavailable');
  }
}
crudRouter.get('/packages', requireBusinessManager, asyncRoute(async (req, res) => {
  const packages = await prisma.lessonPackage.findMany({ where: { businessId: req.auth.business.id }, include: { student: { select: { name: true } } }, orderBy: { expiresAt: 'asc' } });
  res.json(packages.map(packageJson));
}));
crudRouter.post('/packages', requireBusinessManager, asyncRoute(async (req, res) => {
  const input = packageSchema.parse(req.body);
  const businessId = req.auth.business.id;
  const pkg = await prisma.$transaction(async tx => {
    await validatePackageReferences(tx, businessId, input.studentId, input.serviceId);
    const created = await tx.lessonPackage.create({ data: { ...input, businessId }, include: { student: { select: { name: true } } } });
    if (input.paid && input.price > 0) {
      await tx.payment.create({ data: { businessId, studentId: input.studentId, packageId: created.id, amount: input.price,
        kind: req.auth.business.kind === 'SOLO' ? 'STUDENT_TO_COACH' : 'STUDENT_TO_CLUB',
        method: 'OTHER', note: 'Payment already received when package was created' } });
    }
    return created;
  });
  res.status(201).json(packageJson(pkg));
}));
crudRouter.patch('/packages/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  // usedCredits is deliberately absent; booking and cancellation transactions own the credit ledger.
  const input = packageSchema.partial().parse(req.body);
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  const pkg = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${id} AND "businessId" = ${businessId} FOR UPDATE`;
    const current = await tx.lessonPackage.findFirst({ where: { id, businessId }, include: { _count: { select: { participants: true, payments: true } } } });
    if (!current) throw new HttpError(404, 'Package not found');
    await validatePackageReferences(tx, businessId, input.studentId,
      input.serviceId === current.serviceId ? undefined : input.serviceId);
    if (input.totalCredits !== undefined && input.totalCredits < current.usedCredits) throw new HttpError(400, 'Total credits cannot be lower than credits already used');
    const hasHistory = current.usedCredits > 0 || current._count.participants > 0 || current._count.payments > 0 || current.paid;
    if (hasHistory && ((input.studentId !== undefined && input.studentId !== current.studentId)
      || (input.serviceId !== undefined && input.serviceId !== current.serviceId))) {
      throw new HttpError(409, 'A package with history cannot be transferred to another student or service');
    }
    if ((current.paid || current._count.payments > 0) && input.price !== undefined && input.price !== current.price) {
      throw new HttpError(409, 'The price of a package with payment history cannot be changed');
    }
    if (input.paid !== undefined && input.paid !== current.paid) throw new HttpError(400, 'Record package payments through the payments endpoint');
    if (input.expiresAt !== undefined) {
      const laterBooking = await tx.participant.findFirst({ where: { packageId: id, cancelledAt: null,
        booking: { businessId, status: { not: 'CANCELLED' }, startAt: { gt: input.expiresAt } } }, select: { id: true } });
      if (laterBooking) throw new HttpError(409, 'Package expiry cannot precede an existing booked lesson');
    }
    return tx.lessonPackage.update({ where: { id, businessId }, data: input, include: { student: { select: { name: true } } } });
  });
  res.json(packageJson(pkg));
}));
crudRouter.delete('/packages/:id', requireBusinessManager, asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${id} AND "businessId" = ${businessId} FOR UPDATE`;
    const pkg = await tx.lessonPackage.findFirst({ where: { id, businessId }, include: { _count: { select: { participants: true, payments: true } } } });
    if (!pkg) throw new HttpError(404, 'Package not found');
    if (pkg.usedCredits > 0 || pkg._count.participants > 0 || pkg._count.payments > 0 || pkg.paid) {
      throw new HttpError(409, 'Packages with consumed credits, bookings or payment history cannot be deleted');
    }
    await tx.lessonPackage.delete({ where: { id, businessId } });
  });
  res.json({ ok: true });
}));

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a valid time in HH:mm format');
const availabilitySchema = z.object({ instructorId: idSchema, locationId: idSchema, dayOfWeek: z.number().int().min(0).max(6),
  startTime: timeSchema, endTime: timeSchema }).strict().refine(input => input.startTime < input.endTime,
  { path: ['endTime'], message: 'End time must be after start time on the same day' });
crudRouter.get('/availability', asyncRoute(async (req, res) => {
  const query = z.object({ instructorId: idSchema.optional(), locationId: idSchema.optional() }).strict().parse(req.query);
  const businessId = req.auth.business.id;
  const instructorId = scopedInstructor(req, query.instructorId);
  if (query.instructorId) await requireInstructor(prisma, businessId, query.instructorId);
  if (query.locationId) await requireLocation(prisma, businessId, query.locationId);
  const availability = await prisma.availability.findMany({ where: { businessId, instructorId, locationId: query.locationId },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { instructorId: 'asc' }] });
  res.json(availability.map(availabilityJson));
}));
crudRouter.post('/availability', asyncRoute(async (req, res) => {
  const input = availabilitySchema.parse(req.body);
  coachScope(req, input.instructorId);
  const businessId = req.auth.business.id;
  const availability = await prisma.$transaction(async tx => {
    await lockInstructor(tx, input.instructorId);
    await requireInstructor(tx, businessId, input.instructorId, true);
    await requireLocation(tx, businessId, input.locationId, true);
    const key = { instructorId: input.instructorId, locationId: input.locationId, dayOfWeek: input.dayOfWeek, startTime: input.startTime };
    // Multiple venues can be offered in the same window; the instructor booking lock
    // prevents real sessions from overlapping globally across those venues.
    const overlapping = await tx.availability.findFirst({ where: { businessId, instructorId: input.instructorId, locationId: input.locationId,
      dayOfWeek: input.dayOfWeek, startTime: { lt: input.endTime }, endTime: { gt: input.startTime },
      NOT: { startTime: input.startTime } } });
    if (overlapping) throw new HttpError(409, 'Availability overlaps another window for this instructor');
    return tx.availability.upsert({ where: { instructorId_locationId_dayOfWeek_startTime: key },
      create: { ...input, businessId }, update: { endTime: input.endTime } });
  });
  res.status(201).json(availabilityJson(availability));
}));
crudRouter.delete('/availability/:id', asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  await prisma.$transaction(async tx => {
    const availability = await tx.availability.findFirst({ where: { id, businessId } });
    if (!availability) throw new HttpError(404, 'Availability not found');
    coachScope(req, availability.instructorId);
    await lockInstructor(tx, availability.instructorId);
    await tx.availability.delete({ where: { id, businessId } });
  });
  res.json({ ok: true });
}));

const exceptionSchema = z.object({ instructorId: idSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD format').refine(value => {
    const date = DateTime.fromISO(value, { zone: 'UTC' });
    return date.isValid && date.toISODate() === value;
  }, 'Date must be a valid calendar date'), reason: z.string().trim().min(1).max(1000).default('Unavailable') }).strict();
crudRouter.get('/exceptions', asyncRoute(async (req, res) => {
  const query = z.object({ instructorId: idSchema.optional() }).strict().parse(req.query);
  const businessId = req.auth.business.id;
  const instructorId = scopedInstructor(req, query.instructorId);
  if (query.instructorId) await requireInstructor(prisma, businessId, query.instructorId);
  const exceptions = await prisma.availabilityException.findMany({ where: { businessId, instructorId }, orderBy: [{ date: 'asc' }, { instructorId: 'asc' }] });
  res.json(exceptions.map(exceptionJson));
}));
crudRouter.post('/exceptions', asyncRoute(async (req, res) => {
  const input = exceptionSchema.parse(req.body);
  coachScope(req, input.instructorId);
  const businessId = req.auth.business.id;
  const exception = await prisma.$transaction(async tx => {
    await lockInstructor(tx, input.instructorId);
    await requireInstructor(tx, businessId, input.instructorId);
    return tx.availabilityException.upsert({ where: { instructorId_date: { instructorId: input.instructorId, date: input.date } },
      create: { ...input, businessId }, update: { reason: input.reason } });
  });
  res.status(201).json(exceptionJson(exception));
}));
crudRouter.delete('/exceptions/:id', asyncRoute(async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const businessId = req.auth.business.id;
  await prisma.$transaction(async tx => {
    const exception = await tx.availabilityException.findFirst({ where: { id, businessId } });
    if (!exception) throw new HttpError(404, 'Blocked date not found');
    coachScope(req, exception.instructorId);
    await lockInstructor(tx, exception.instructorId);
    await tx.availabilityException.delete({ where: { id, businessId } });
  });
  res.json({ ok: true });
}));

const businessSchema = z.object({ name: nameSchema.optional(), ownerName: nameSchema.optional(), email: emailSchema.optional(),
  timezone: z.string().trim().max(100).refine(zone => IANAZone.isValidZone(zone), 'Choose a valid IANA timezone').optional(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a three-letter currency code').transform(value => value.toUpperCase()).optional(),
  color: colorSchema.optional(), tagline: z.string().trim().max(500).optional(),
  cancellationHours: z.number().int().min(0).max(720).optional() }).strict();
crudRouter.patch('/business', requireBusinessManager, asyncRoute(async (req, res) => {
  const input = businessSchema.parse(req.body);
  const business = await prisma.$transaction(async tx => {
    const updated = await tx.business.update({ where: { id: req.auth.business.id }, data: input });
    if (req.auth.user.accountType === 'CLUB' && input.name !== undefined) {
      await tx.user.update({ where: { id: req.auth.user.id }, data: { name: input.name } });
    }
    return updated;
  });
  res.json(businessJson(business));
}));
crudRouter.patch('/notifications/read', asyncRoute(async (req, res) => {
  const input = z.object({ ids: z.array(idSchema).max(1000).optional() }).strict().parse(req.body ?? {});
  const businessId = req.auth.business.id;
  const instructorId = scopedInstructor(req);
  const scope = { businessId, ...(instructorId ? { instructorId } : {}) };
  const count = await prisma.$transaction(async tx => {
    if (input.ids) {
      const ids = [...new Set(input.ids)];
      const accessible = await tx.notification.count({ where: { ...scope, id: { in: ids } } });
      if (accessible !== ids.length) throw new HttpError(404, 'Notification not found or inaccessible');
    }
    const result = await tx.notification.updateMany({ where: { ...scope, read: false, ...(input.ids ? { id: { in: input.ids } } : {}) }, data: { read: true } });
    return result.count;
  });
  res.json({ ok: true, count });
}));

export default crudRouter;
