import { PrismaClient, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { initials } from '../src/http.js';

const requiredConfirmation = 'DELETE ALL COURTLY APPLICATION DATA AND PROVISION ELEVER';
if (process.env.ELEVER_RESET_CONFIRMATION !== requiredConfirmation) {
  throw new Error(`Set ELEVER_RESET_CONFIRMATION exactly to: ${requiredConfirmation}`);
}
const databaseUrl = process.env.DATABASE_URL?.trim();
const expectedDatabaseFingerprint = process.env.ELEVER_EXPECTED_DATABASE_SHA256?.trim().toLowerCase();
if (!databaseUrl) throw new Error('DATABASE_URL must be set explicitly');
if (!expectedDatabaseFingerprint || !/^[a-f0-9]{64}$/.test(expectedDatabaseFingerprint)) {
  throw new Error('ELEVER_EXPECTED_DATABASE_SHA256 must be the 64-character SHA-256 fingerprint of the exact DATABASE_URL');
}
const actualDatabaseFingerprint = createHash('sha256').update(databaseUrl).digest();
if (!timingSafeEqual(actualDatabaseFingerprint, Buffer.from(expectedDatabaseFingerprint, 'hex'))) {
  throw new Error('ELEVER_EXPECTED_DATABASE_SHA256 does not match DATABASE_URL; no data was changed');
}
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });

const credentials = {
  club: { email: 'investors@eleverbadminton.com', password: process.env.ELEVER_CLUB_PASSWORD },
  loh: { email: 'loh.kean.hean@eleverbadminton.com', password: process.env.ELEVER_LOH_PASSWORD },
  eng: { email: 'eng.chin.an@eleverbadminton.com', password: process.env.ELEVER_ENG_PASSWORD },
  dominic: { email: 'dominic.student@eleverbadminton.com', password: process.env.ELEVER_DOMINIC_PASSWORD },
  students: { email: '', password: process.env.ELEVER_STUDENT_PASSWORD },
} as const;

const passwordEnvironmentNames = {
  club: 'ELEVER_CLUB_PASSWORD',
  loh: 'ELEVER_LOH_PASSWORD',
  eng: 'ELEVER_ENG_PASSWORD',
  dominic: 'ELEVER_DOMINIC_PASSWORD',
  students: 'ELEVER_STUDENT_PASSWORD',
} as const;
for (const [key, credential] of Object.entries(credentials) as Array<[keyof typeof credentials, (typeof credentials)[keyof typeof credentials]]>) {
  if (!credential.password || credential.password.length < 12 || Buffer.byteLength(credential.password, 'utf8') > 72) {
    throw new Error(`${passwordEnvironmentNames[key]} must contain 12-72 UTF-8 bytes`);
  }
}
if (new Set(Object.values(credentials).map(credential => credential.password)).size !== Object.keys(credentials).length) {
  throw new Error('Use a different password for every Elever credential group');
}

const allApplicationTables = [
  'AccountNotification', 'CalendarBusyInterval', 'CalendarEventProjection', 'CalendarOAuthAttempt',
  'CalendarRevocationJob',
  'CalendarSyncJob', 'CalendarConnection', 'AuthSession', 'Availability', 'AvailabilityException', 'Booking',
  'Business', 'Instructor', 'IntegrityFlag', 'LessonPackage', 'Location', 'Membership',
  'Notification', 'Participant', 'Payment', 'RescheduleRequest', 'Service',
  'ServiceInstructor', 'ServiceLocation', 'Student', 'User',
] as const;

const expectedMigrations = readdirSync(new URL('./migrations/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => ({
    migration_name: entry.name,
    checksum: createHash('sha256')
      .update(readFileSync(new URL(`./migrations/${entry.name}/migration.sql`, import.meta.url)))
      .digest('hex'),
  }))
  .sort((left, right) => left.migration_name.localeCompare(right.migration_name));

const studentDefinitions = [
  { key: 'james', name: 'James', email: 'james.student@eleverbadminton.com', phone: '+65 8100 2001', club: true },
  { key: 'julian', name: 'Julian', email: 'julian.student@eleverbadminton.com', phone: '+65 8100 2002', club: true },
  { key: 'sean', name: 'Sean', email: 'sean.student@eleverbadminton.com', phone: '+65 8100 2003', club: true },
  { key: 'lauren', name: 'Lauren', email: 'lauren.student@eleverbadminton.com', phone: '+65 8100 2004', club: true },
  { key: 'aaron', name: 'Aaron', email: 'aaron.student@eleverbadminton.com', phone: '+65 8100 2005', club: true },
  { key: 'benjamin', name: 'Benjamin', email: 'benjamin.student@eleverbadminton.com', phone: '+65 8100 2006', club: true },
  { key: 'carol', name: 'Carol', email: 'carol.student@eleverbadminton.com', phone: '+65 8100 2007', club: false },
  { key: 'dominic', name: 'Dominic', email: credentials.dominic.email, phone: '+65 8100 2008', club: false },
] as const;

type StudentKey = (typeof studentDefinitions)[number]['key'];
type CoachKey = 'loh' | 'eng';
type FixtureBusiness = {
  id: string;
  slug: string;
  instructorId: string;
  locationId: string;
  serviceId: string;
};

const now = DateTime.now().setZone('Asia/Singapore');
const monday = now.startOf('week');
const dateAt = (weekOffset: number, weekday: number, hour: number, minute = 0) =>
  monday.plus({ weeks: weekOffset, days: weekday - 1, hours: hour, minutes: minute });

async function hashPasswords() {
  return Object.fromEntries(await Promise.all(
    Object.entries(credentials).map(async ([key, credential]) => [key, await bcrypt.hash(credential.password!, 12)]),
  )) as Record<keyof typeof credentials, string>;
}

async function createService(
  tx: Prisma.TransactionClient,
  businessId: string,
  locationId: string,
  instructorIds: string[],
  definition: { name: string; description: string; type: 'GROUP' | 'PRIVATE'; duration: number; price: number; capacity: number; color: string },
) {
  return tx.service.create({
    data: {
      businessId, ...definition, category: 'Badminton', bufferMinutes: 15, noticeHours: 2, active: true,
      locations: { create: {
        locationId, price: definition.price, duration: definition.duration,
        instructors: { create: instructorIds.map(instructorId => ({ instructorId })) },
      } },
    },
  });
}

async function main() {
  const passwordHashes = await hashPasswords();
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('courtly:elever-production-reset', 0))`;
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '110s'");
    const migrationsBefore = await tx.$queryRaw<Array<{
      id: string; migration_name: string; checksum: string; started_at: string; finished_at: string | null;
      rolled_back_at: string | null; applied_steps_count: number;
    }>>`
      SELECT id, migration_name, checksum, started_at::text, finished_at::text, rolled_back_at::text, applied_steps_count
      FROM "_prisma_migrations" ORDER BY started_at, id
    `;
    const appliedMigrations = migrationsBefore
      .filter(migration => migration.finished_at !== null && migration.rolled_back_at === null)
      .map(({ migration_name, checksum }) => ({ migration_name, checksum }))
      .sort((left, right) => left.migration_name.localeCompare(right.migration_name));
    if (migrationsBefore.some(migration => migration.finished_at === null && migration.rolled_back_at === null)) {
      throw new Error('The target database has an unresolved failed migration; no data was changed');
    }
    if (JSON.stringify(appliedMigrations) !== JSON.stringify(expectedMigrations)) {
      throw new Error('The target database migration names or checksums do not match this checkout; no data was changed');
    }

    const [target] = await tx.$queryRaw<Array<{ schema_name: string | null }>>`SELECT current_schema() AS schema_name`;
    if (!target?.schema_name) throw new Error('The target database has no current schema; no data was changed');
    const quotedSchema = `"${target.schema_name.replaceAll('"', '""')}"`;
    await tx.$executeRawUnsafe(`TRUNCATE TABLE ${allApplicationTables.map(table => `${quotedSchema}."${table}"`).join(', ')} CONTINUE IDENTITY`);

    const club = await tx.business.create({ data: {
      name: 'Elever Badminton Academy', slug: 'elever-badminton-academy', ownerName: 'Elever Badminton Academy',
      email: credentials.club.email, timezone: 'Asia/Singapore', currency: 'SGD', color: '#173f35',
      tagline: 'Train with purpose. Play with confidence.', cancellationHours: 24, kind: 'CLUB', isDemo: false,
      createdAt: now.minus({ years: 2 }).toJSDate(),
    } });
    const clubUser = await tx.user.create({ data: {
      name: club.name, email: credentials.club.email, passwordHash: passwordHashes.club, accountType: 'CLUB',
      phone: '+65 6970 2026', parentName: '', createdAt: club.createdAt,
    } });
    await tx.membership.create({ data: { userId: clubUser.id, businessId: club.id, createdAt: club.createdAt } });

    const coachDefinitions = {
      loh: { name: 'Loh Kean Hean', email: credentials.loh.email, phone: '+65 8100 1001', specialty: 'Doubles strategy · front-court movement · match play', color: '#2d7564' },
      eng: { name: 'Eng Chin An', email: credentials.eng.email, phone: '+65 8100 1002', specialty: 'Technical foundations · footwork · player development', color: '#557a9b' },
    } as const;
    const coachUsers = {} as Record<CoachKey, { id: string; name: string; email: string }>;
    const clubInstructors = {} as Record<CoachKey, { id: string }>;
    for (const key of ['loh', 'eng'] as const) {
      const definition = coachDefinitions[key];
      const user = await tx.user.create({ data: {
        name: definition.name, email: definition.email, passwordHash: passwordHashes[key], accountType: 'COACH',
        phone: definition.phone, parentName: '', createdAt: club.createdAt,
      } });
      coachUsers[key] = user;
      const instructor = await tx.instructor.create({ data: {
        businessId: club.id, name: definition.name, initials: initials(definition.name), color: definition.color,
        email: definition.email, specialty: definition.specialty, rescheduleNoticeHours: 24, active: true,
      } });
      clubInstructors[key] = instructor;
      await tx.membership.create({ data: {
        userId: user.id, businessId: club.id, instructorId: instructor.id, createdAt: club.createdAt,
      } });
    }

    const studentUsers = {} as Record<StudentKey, { id: string; name: string; email: string }>;
    for (const definition of studentDefinitions) {
      const user = await tx.user.create({ data: {
        name: definition.name, email: definition.email,
        passwordHash: definition.key === 'dominic' ? passwordHashes.dominic : passwordHashes.students,
        accountType: 'STUDENT', phone: definition.phone, parentName: '', createdAt: now.minus({ months: 10 }).toJSDate(),
      } });
      studentUsers[definition.key] = user;
    }

    const clubLocation = await tx.location.create({ data: {
      businessId: club.id, name: 'Elever Training Courts', address: 'Singapore Badminton Hall, 1 Lorong 23 Geylang, Singapore 388352',
      type: 'FACILITY', color: '#2d7564', requiresApproval: false, travelMinutes: 15,
      notes: 'Arrive 10 minutes early for warm-up and court allocation.', active: true,
    } });
    const clubService = await createService(tx, club.id, clubLocation.id, Object.values(clubInstructors).map(item => item.id), {
      name: 'Elever Group Badminton', description: 'Structured group training covering technique, movement, drills and match play.',
      type: 'GROUP', duration: 120, price: 4800, capacity: 8, color: '#2d7564',
    });
    await tx.availability.createMany({ data: Object.values(clubInstructors).flatMap(instructor =>
      Array.from({ length: 7 }, (_, dayOfWeek) => ({ businessId: club.id, instructorId: instructor.id, locationId: clubLocation.id, dayOfWeek, startTime: '07:00', endTime: '22:00' })),
    ) });

    const clubStudents = {} as Record<string, { id: string }>;
    for (const definition of studentDefinitions.filter(item => item.club)) {
      clubStudents[definition.key] = await tx.student.create({ data: {
        businessId: club.id, userId: studentUsers[definition.key].id, name: definition.name, email: definition.email,
        phone: definition.phone, initials: initials(definition.name), parentName: '',
        notes: 'Elever group programme student.', createdAt: now.minus({ months: 9 }).toJSDate(),
      } });
    }

    const soloBusinesses = {} as Record<CoachKey, FixtureBusiness>;
    for (const key of ['loh', 'eng'] as const) {
      const coach = coachDefinitions[key];
      const solo = await tx.business.create({ data: {
        name: `${coach.name} Private Coaching`, slug: `${key === 'loh' ? 'loh-kean-hean' : 'eng-chin-an'}-private-coaching`,
        ownerName: coach.name, email: coach.email, timezone: 'Asia/Singapore', currency: 'SGD', color: coach.color,
        tagline: `Private badminton coaching with ${coach.name}.`, cancellationHours: 24, kind: 'SOLO', isDemo: false,
        createdAt: now.minus({ months: 14 }).toJSDate(),
      } });
      const instructor = await tx.instructor.create({ data: {
        businessId: solo.id, name: coach.name, initials: initials(coach.name), color: coach.color, email: coach.email,
        specialty: coach.specialty, rescheduleNoticeHours: 24, active: true,
      } });
      await tx.membership.create({ data: {
        userId: coachUsers[key].id, businessId: solo.id, instructorId: instructor.id, createdAt: solo.createdAt,
      } });
      const location = await tx.location.create({ data: {
        businessId: solo.id, name: `${coach.name} Private Court`, address: 'Singapore Badminton Hall, 1 Lorong 23 Geylang, Singapore 388352',
        type: 'FACILITY', color: coach.color, requiresApproval: false, travelMinutes: 15,
        notes: 'Private training court. Court details are confirmed before the lesson.', active: true,
      } });
      const service = await createService(tx, solo.id, location.id, [instructor.id], {
        name: 'Private Badminton Coaching', description: `One-to-one badminton coaching with ${coach.name}.`,
        type: 'PRIVATE', duration: 60, price: 12000, capacity: 1, color: coach.color,
      });
      await tx.availability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: solo.id, instructorId: instructor.id, locationId: location.id, dayOfWeek, startTime: '07:00', endTime: '22:00',
      })) });
      soloBusinesses[key] = { id: solo.id, slug: solo.slug, instructorId: instructor.id, locationId: location.id, serviceId: service.id };
    }

    const carol = await tx.student.create({ data: {
      businessId: soloBusinesses.loh.id, userId: studentUsers.carol.id, name: 'Carol', email: studentUsers.carol.email,
      phone: '+65 8100 2007', initials: 'C', parentName: '', notes: 'Kean Hean private student.', createdAt: now.minus({ months: 8 }).toJSDate(),
    } });
    const dominic = await tx.student.create({ data: {
      businessId: soloBusinesses.eng.id, userId: studentUsers.dominic.id, name: 'Dominic', email: studentUsers.dominic.email,
      phone: '+65 8100 2008', initials: 'D', parentName: '', notes: 'Chin An private student.', createdAt: now.minus({ months: 8 }).toJSDate(),
    } });

    type Session = {
      businessId: string; serviceId: string; instructorId: string; locationId: string; start: DateTime;
      duration: number; price: number; capacity: number; type: string; paymentRoute: 'CLUB' | 'DIRECT';
      students: Array<{ id: string; userId: string; name: string }>; status: 'COMPLETED' | 'CONFIRMED' | 'PENDING';
      acceptance: 'ACCEPTED' | 'PENDING' | 'NOT_REQUIRED'; notes: string; creatorId: string; creatorRole: 'CLUB' | 'COACH';
    };
    const groupStudents = studentDefinitions.filter(item => item.club).map(item => ({
      id: clubStudents[item.key].id, userId: studentUsers[item.key].id, name: item.name,
    }));
    const sessions: Session[] = [];
    for (let weekOffset = -8; weekOffset <= -1; weekOffset++) {
      sessions.push({ businessId: club.id, serviceId: clubService.id, instructorId: clubInstructors.loh.id, locationId: clubLocation.id,
        start: dateAt(weekOffset, 2, 18), duration: 120, price: 4800, capacity: 8, type: 'GROUP', paymentRoute: 'CLUB',
        students: groupStudents, status: 'COMPLETED', acceptance: 'ACCEPTED', notes: 'Tuesday Elever group training · completed.', creatorId: clubUser.id, creatorRole: 'CLUB' });
      sessions.push({ businessId: club.id, serviceId: clubService.id, instructorId: clubInstructors.eng.id, locationId: clubLocation.id,
        start: dateAt(weekOffset, 5, 18), duration: 120, price: 4800, capacity: 8, type: 'GROUP', paymentRoute: 'CLUB',
        students: groupStudents, status: 'COMPLETED', acceptance: 'ACCEPTED', notes: 'Friday Elever group training · completed.', creatorId: clubUser.id, creatorRole: 'CLUB' });
    }
    for (const current of [
      { key: 'loh' as const, weekday: 2, note: 'Tuesday' },
      { key: 'eng' as const, weekday: 5, note: 'Friday' },
    ]) {
      const start = dateAt(0, current.weekday, 18);
      const completed = start.plus({ minutes: 120 }) <= now;
      sessions.push({ businessId: club.id, serviceId: clubService.id, instructorId: clubInstructors[current.key].id, locationId: clubLocation.id,
        start, duration: 120, price: 4800, capacity: 8, type: 'GROUP', paymentRoute: 'CLUB', students: groupStudents,
        status: completed ? 'COMPLETED' : 'CONFIRMED', acceptance: 'ACCEPTED',
        notes: `${current.note} Elever group training${completed ? ' · completed.' : '.'}`, creatorId: clubUser.id, creatorRole: 'CLUB' });
    }
    for (let weekOffset = 1; weekOffset <= 6; weekOffset++) {
      sessions.push({ businessId: club.id, serviceId: clubService.id, instructorId: clubInstructors.loh.id, locationId: clubLocation.id,
        start: dateAt(weekOffset, 2, 18), duration: 120, price: 4800, capacity: 8, type: 'GROUP', paymentRoute: 'CLUB',
        students: groupStudents, status: 'CONFIRMED', acceptance: 'ACCEPTED', notes: 'Tuesday Elever group training.', creatorId: clubUser.id, creatorRole: 'CLUB' });
      sessions.push({ businessId: club.id, serviceId: clubService.id, instructorId: clubInstructors.eng.id, locationId: clubLocation.id,
        start: dateAt(weekOffset, 5, 18), duration: 120, price: 4800, capacity: 8, type: 'GROUP', paymentRoute: 'CLUB',
        students: groupStudents, status: weekOffset === 1 ? 'PENDING' : 'CONFIRMED', acceptance: weekOffset === 1 ? 'PENDING' : 'ACCEPTED',
        notes: weekOffset === 1 ? 'Friday Elever group training · awaiting Chin An’s acceptance.' : 'Friday Elever group training.', creatorId: clubUser.id, creatorRole: 'CLUB' });
    }
    const privatePlans = [
      { key: 'loh' as const, student: carol, studentUser: studentUsers.carol, weekday: 3, hour: 16 },
      { key: 'eng' as const, student: dominic, studentUser: studentUsers.dominic, weekday: 4, hour: 17 },
    ];
    for (const plan of privatePlans) {
      const practice = soloBusinesses[plan.key];
      for (let weekOffset = -6; weekOffset <= -1; weekOffset++) sessions.push({
        businessId: practice.id, serviceId: practice.serviceId, instructorId: practice.instructorId, locationId: practice.locationId,
        start: dateAt(weekOffset, plan.weekday, plan.hour), duration: 60, price: 12000, capacity: 1, type: 'PRIVATE', paymentRoute: 'DIRECT',
        students: [{ id: plan.student.id, userId: plan.studentUser.id, name: plan.studentUser.name }], status: 'COMPLETED', acceptance: 'NOT_REQUIRED',
        notes: `Private training with ${plan.studentUser.name} · completed.`, creatorId: coachUsers[plan.key].id, creatorRole: 'COACH',
      });
      const currentStart = dateAt(0, plan.weekday, plan.hour);
      const currentCompleted = currentStart.plus({ minutes: 60 }) <= now;
      sessions.push({
        businessId: practice.id, serviceId: practice.serviceId, instructorId: practice.instructorId, locationId: practice.locationId,
        start: currentStart, duration: 60, price: 12000, capacity: 1, type: 'PRIVATE', paymentRoute: 'DIRECT',
        students: [{ id: plan.student.id, userId: plan.studentUser.id, name: plan.studentUser.name }],
        status: currentCompleted ? 'COMPLETED' : 'CONFIRMED', acceptance: 'NOT_REQUIRED',
        notes: `Private training with ${plan.studentUser.name}${currentCompleted ? ' · completed.' : '.'}`,
        creatorId: coachUsers[plan.key].id, creatorRole: 'COACH',
      });
      for (let weekOffset = 1; weekOffset <= 4; weekOffset++) sessions.push({
        businessId: practice.id, serviceId: practice.serviceId, instructorId: practice.instructorId, locationId: practice.locationId,
        start: dateAt(weekOffset, plan.weekday, plan.hour), duration: 60, price: 12000, capacity: 1, type: 'PRIVATE', paymentRoute: 'DIRECT',
        students: [{ id: plan.student.id, userId: plan.studentUser.id, name: plan.studentUser.name }], status: 'CONFIRMED', acceptance: 'NOT_REQUIRED',
        notes: `Private training with ${plan.studentUser.name}.`, creatorId: coachUsers[plan.key].id, creatorRole: 'COACH',
      });
    }

    let participantSequence = 0;
    let paymentSequence = 0;
    let dominicCompletedBookingId: string | null = null;
    let dominicUpcomingBookingId: string | null = null;
    for (const session of sessions) {
      const bookingId = randomUUID();
      const end = session.start.plus({ minutes: session.duration });
      const createdAt = DateTime.min(session.start.minus({ days: 14 }), now.minus({ hours: 3 }));
      const coachRespondedAt = session.acceptance === 'ACCEPTED'
        ? DateTime.min(session.start.minus({ days: 3 }), now.minus({ hours: 2 }))
        : null;
      await tx.booking.create({ data: {
        id: bookingId, businessId: session.businessId, serviceId: session.serviceId, instructorId: session.instructorId, locationId: session.locationId,
        startAt: session.start.toJSDate(), endAt: end.toJSDate(), duration: session.duration, bufferMinutes: 15, status: session.status, type: session.type,
        capacity: session.capacity, price: session.price, notes: session.notes,
        address: 'Singapore Badminton Hall, 1 Lorong 23 Geylang, Singapore 388352', paymentRoute: session.paymentRoute,
        coachAcceptance: session.acceptance, coachRespondedAt: coachRespondedAt?.toJSDate() ?? null,
        createdByUserId: session.creatorId, createdByRole: session.creatorRole, createdAt: createdAt.toJSDate(),
      } });
      if (session.businessId === soloBusinesses.eng.id && session.students.some(student => student.userId === studentUsers.dominic.id)) {
        if (session.status === 'COMPLETED') dominicCompletedBookingId = bookingId;
        else dominicUpcomingBookingId ??= bookingId;
      }
      for (const [index, student] of session.students.entries()) {
        const paid = session.status === 'COMPLETED' || participantSequence++ % 3 !== 0;
        await tx.participant.create({ data: {
          id: randomUUID(), bookingId, studentId: student.id, attendance: session.status === 'COMPLETED' ? ((paymentSequence + index) % 11 === 0 ? 'ABSENT' : 'PRESENT') : 'UNMARKED',
          paid, price: session.price, notes: '', packageId: null, creditConsumed: false, cancelledAt: null,
        } });
        if (paid) await tx.payment.create({ data: {
          businessId: session.businessId, studentId: student.id, bookingId, kind: session.paymentRoute === 'CLUB' ? 'STUDENT_TO_CLUB' : 'STUDENT_TO_COACH',
          amount: session.price, method: paymentSequence % 2 ? 'BANK_TRANSFER' : 'CASH',
          note: `Elever showcase receipt ${String(++paymentSequence).padStart(3, '0')}`, paidAt: DateTime.min(session.start.minus({ days: 2 }), now.minus({ hours: 1 })).toJSDate(),
        } });
      }
    }

    await tx.payment.createMany({ data: [
      { businessId: club.id, studentId: null, instructorId: clubInstructors.loh.id, kind: 'CLUB_TO_COACH', amount: 32000, method: 'BANK_TRANSFER', note: 'August coaching payout · Loh Kean Hean', paidAt: now.minus({ days: 18 }).toJSDate() },
      { businessId: club.id, studentId: null, instructorId: clubInstructors.eng.id, kind: 'CLUB_TO_COACH', amount: 32000, method: 'BANK_TRANSFER', note: 'August coaching payout · Eng Chin An', paidAt: now.minus({ days: 18 }).toJSDate() },
    ] });
    await tx.notification.createMany({ data: [
      { businessId: club.id, type: 'NOTICE', title: 'Elever showcase is ready', message: 'The academy schedule includes completed history and upcoming group training.', read: true, createdAt: now.minus({ hours: 3 }).toJSDate() },
      { businessId: club.id, instructorId: clubInstructors.loh.id, type: 'ATTENDANCE', title: 'Attendance history is ready', message: 'Recent Elever group attendance is available for review.', read: false, createdAt: now.minus({ hours: 2 }).toJSDate() },
      { businessId: club.id, instructorId: clubInstructors.eng.id, type: 'PENDING_ACTION', title: 'Lesson acceptance needed', message: 'The next Friday group is awaiting Chin An’s acceptance.', actionNeeded: true, read: false, createdAt: now.minus({ hours: 1 }).toJSDate() },
      { businessId: club.id, type: 'PAYMENT', title: 'Student payments tracked', message: 'Paid and outstanding group lessons are visible in Finance.', read: false, createdAt: now.minus({ minutes: 30 }).toJSDate() },
    ] });
    if (!dominicCompletedBookingId || !dominicUpcomingBookingId) throw new Error('Dominic fixture bookings are incomplete');
    await tx.accountNotification.createMany({ data: [
      { userId: studentUsers.dominic.id, businessId: soloBusinesses.eng.id, bookingId: dominicCompletedBookingId,
        type: 'BOOKING_COMPLETED', title: 'Session completed', message: 'Your recent private training with Eng Chin An was marked complete.',
        read: true, createdAt: now.minus({ days: 2 }).toJSDate() },
      { userId: studentUsers.dominic.id, businessId: soloBusinesses.eng.id, bookingId: dominicUpcomingBookingId,
        type: 'BOOKING_CONFIRMED', title: 'Booking confirmed', message: 'Your next private training with Eng Chin An is confirmed.',
        read: false, createdAt: now.minus({ hours: 2 }).toJSDate() },
    ] });

    const [invalidBookingTimes, invalidPaymentTimes] = await Promise.all([
      tx.booking.count({ where: { OR: [
        { createdAt: { gt: now.toJSDate() } },
        { coachRespondedAt: { gt: now.toJSDate() } },
      ] } }),
      tx.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM "Payment" p
        JOIN "Booking" b ON b.id = p."bookingId"
        WHERE p."paidAt" < b."createdAt" OR p."paidAt" > NOW()
      `,
    ]);
    if (invalidBookingTimes || invalidPaymentTimes[0]?.count) throw new Error('Fixture contains impossible audit timestamps');

    const migrationsAfter = await tx.$queryRaw<typeof migrationsBefore>`
      SELECT id, migration_name, checksum, started_at::text, finished_at::text, rolled_back_at::text, applied_steps_count
      FROM "_prisma_migrations" ORDER BY started_at, id
    `;
    if (JSON.stringify(migrationsAfter) !== JSON.stringify(migrationsBefore)) throw new Error('Migration history changed during fixture provisioning');
    return { clubId: club.id, clubSlug: club.slug, soloSlugs: { loh: soloBusinesses.loh.slug, eng: soloBusinesses.eng.slug } };
  }, { maxWait: 10_000, timeout: 120_000 });

  const counts = await Promise.all([
    prisma.business.count(), prisma.user.count(), prisma.membership.count(), prisma.instructor.count(), prisma.student.count(),
    prisma.booking.count(), prisma.participant.count(), prisma.payment.count(), prisma.notification.count(),
  ]);
  console.log(JSON.stringify({
    ok: true, business: { id: result.clubId, slug: result.clubSlug }, soloSlugs: result.soloSlugs,
    counts: Object.fromEntries(['businesses', 'users', 'memberships', 'instructors', 'students', 'bookings', 'participants', 'payments', 'notifications'].map((key, index) => [key, counts[index]])),
  }, null, 2));
}

main().catch(error => {
  console.error('Elever provisioning failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
