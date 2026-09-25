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
  club: 'ELEVER_CLUB_PASSWORD', loh: 'ELEVER_LOH_PASSWORD', eng: 'ELEVER_ENG_PASSWORD',
  dominic: 'ELEVER_DOMINIC_PASSWORD', students: 'ELEVER_STUDENT_PASSWORD',
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
  'CalendarRevocationJob', 'CalendarSyncJob', 'CalendarConnection', 'AuthSession', 'Availability',
  'AvailabilityException', 'Booking', 'Business', 'Instructor', 'IntegrityFlag', 'LessonPackage',
  'LessonPackageLocation', 'LessonPackageService', 'Location', 'Membership', 'Notification', 'PackageOffer',
  'PackageOfferLocation', 'PackageOfferService', 'Participant', 'Payment', 'PaymentIntent', 'RescheduleRequest',
  'Service', 'ServiceInstructor', 'ServiceLocation', 'Student', 'User', 'VenueOpeningHour', 'VenueReservation', 'VenueUnit',
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

const namedStudents = [
  ['james', 'James'], ['julian', 'Julian'], ['sean', 'Sean'], ['lauren', 'Lauren'],
  ['aaron', 'Aaron'], ['benjamin', 'Benjamin'], ['carol', 'Carol'], ['dominic', 'Dominic'],
] as const;
const numberedStudents = Array.from({ length: 12 }, (_, index) => ({
  key: `student${index + 1}`, name: `Student ${index + 1}`, username: `elever_student_${index + 1}`,
  email: `student.${index + 1}@eleverbadminton.com`, phone: `+65 8200 ${String(index + 1).padStart(4, '0')}`,
}));
const studentDefinitions = [
  ...namedStudents.map(([key, name], index) => ({
    key, name, username: `elever_${key}`,
    email: key === 'dominic' ? credentials.dominic.email : `${key}.student@eleverbadminton.com`,
    phone: `+65 8100 ${String(index + 1).padStart(4, '0')}`,
  })),
  ...numberedStudents,
];
type StudentKey = (typeof studentDefinitions)[number]['key'];
type CoachKey = 'loh' | 'eng';
const showcaseNow = DateTime.fromISO('2026-09-25T12:00:00', { zone: 'Asia/Singapore' });
const october = (day: number, hour: number, minute = 0) =>
  DateTime.fromObject({ year: 2026, month: 10, day, hour, minute }, { zone: 'Asia/Singapore' });

async function hashPasswords() {
  return Object.fromEntries(await Promise.all(
    Object.entries(credentials).map(async ([key, credential]) => [key, await bcrypt.hash(credential.password!, 12)]),
  )) as Record<keyof typeof credentials, string>;
}

async function createService(
  tx: Prisma.TransactionClient, businessId: string, locationId: string, instructorIds: string[],
  definition: { name: string; description: string; type: 'GROUP' | 'PRIVATE'; duration: number; price: number; capacity: number; color: string },
) {
  return tx.service.create({ data: {
    businessId, ...definition, category: 'Badminton', bufferMinutes: 15, noticeHours: 2, active: true,
    locations: { create: {
      locationId, price: definition.price, duration: definition.duration,
      instructors: { create: instructorIds.map(instructorId => ({ instructorId })) },
    } },
  } });
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
      tagline: 'Train with purpose. Play with confidence.', cancellationHours: 24, kind: 'CLUB',
      legacyReadOnly: false, isDemo: false, createdAt: october(1, 0).minus({ years: 2 }).toJSDate(),
    } });
    const clubUser = await tx.user.create({ data: {
      name: club.name, email: credentials.club.email, username: 'elever_badminton', sports: ['Badminton'],
      passwordHash: passwordHashes.club, accountType: 'CLUB', phone: '+65 6970 2026', parentName: '', createdAt: club.createdAt,
    } });
    await tx.membership.create({ data: { userId: clubUser.id, businessId: club.id, createdAt: club.createdAt } });

    const coachDefinitions = {
      loh: { name: 'Loh Kean Hean', username: 'loh_kean_hean', email: credentials.loh.email, phone: '+65 8100 1001', specialty: 'Doubles strategy · front-court movement · match play', color: '#2d7564' },
      eng: { name: 'Eng Chin An', username: 'eng_chin_an', email: credentials.eng.email, phone: '+65 8100 1002', specialty: 'Technical foundations · footwork · player development', color: '#557a9b' },
    } as const;
    const coachUsers = {} as Record<CoachKey, { id: string; name: string; email: string }>;
    const instructors = {} as Record<CoachKey, { id: string; name: string }>;
    for (const key of ['loh', 'eng'] as const) {
      const definition = coachDefinitions[key];
      const user = await tx.user.create({ data: {
        name: definition.name, email: definition.email, username: definition.username, sports: ['Badminton'],
        passwordHash: passwordHashes[key], accountType: 'COACH', phone: definition.phone, parentName: '', createdAt: club.createdAt,
      } });
      coachUsers[key] = user;
      const instructor = await tx.instructor.create({ data: {
        businessId: club.id, name: definition.name, initials: initials(definition.name), color: definition.color,
        email: definition.email, specialty: definition.specialty, rescheduleNoticeHours: key === 'loh' ? 36 : 24, active: true,
      } });
      instructors[key] = instructor;
      await tx.membership.create({ data: {
        userId: user.id, businessId: club.id, instructorId: instructor.id, createdAt: club.createdAt,
      } });
    }

    const studentUsers = {} as Record<StudentKey, { id: string; name: string; email: string }>;
    const students = {} as Record<StudentKey, { id: string; name: string }>;
    for (const [index, definition] of studentDefinitions.entries()) {
      const user = await tx.user.create({ data: {
        name: definition.name, email: definition.email, username: definition.username, sports: ['Badminton'],
        passwordHash: definition.key === 'dominic' ? passwordHashes.dominic : passwordHashes.students,
        accountType: 'STUDENT', phone: definition.phone, parentName: '', createdAt: october(1, 0).minus({ months: 10 }).toJSDate(),
      } });
      studentUsers[definition.key] = user;
      students[definition.key] = await tx.student.create({ data: {
        businessId: club.id, userId: user.id, name: user.name, email: user.email, phone: definition.phone,
        initials: initials(user.name), parentName: '', notes: index < 8 ? 'Elever investor showcase student.' : 'October 2026 academy student.',
        createdAt: october(1, 0).minus({ months: 9 }).plus({ days: index }).toJSDate(),
      } });
    }

    const trainingLocation = await tx.location.create({ data: {
      businessId: club.id, name: 'Elever Performance Hall',
      address: 'Singapore Badminton Hall, 1 Lorong 23 Geylang, Singapore 388352', type: 'FACILITY',
      color: '#2d7564', requiresApproval: false, travelMinutes: 15, sport: 'Badminton',
      notes: 'Dedicated academy hall for classes and one-to-one coaching.', active: true,
    } });
    const rentalLocation = await tx.location.create({ data: {
      businessId: club.id, name: 'Elever Kallang Courts',
      address: '52 Stadium Road, Singapore 397724', type: 'FACILITY', color: '#557a9b', requiresApproval: false,
      travelMinutes: 15, notes: 'Court rental check-in is at the Elever reception desk.', active: true,
      sport: 'Badminton', rentalEnabled: true, rentalUnitLabel: 'Court', rentalPrice: 3600, rentalStartInterval: 30,
      rentalMinDuration: 60, rentalBookingIncrement: 30, rentalMaxDuration: 120, rentalNoticeHours: 2,
      rentalAdvanceDays: 60, rentalCancellationHours: 24,
      rules: 'Non-marking court shoes are required. Check in 10 minutes before the reservation.',
      amenities: JSON.stringify(['Air conditioning', 'Changing rooms', 'Racket hire', 'Shuttlecocks']),
    } });
    const units = await Promise.all(['Court 1', 'Court 2', 'Court 3', 'Court 4'].map(name => tx.venueUnit.create({
      data: { businessId: club.id, locationId: rentalLocation.id, name, active: true },
    })));
    await tx.venueOpeningHour.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId: club.id, locationId: rentalLocation.id, dayOfWeek,
      startTime: dayOfWeek === 0 || dayOfWeek === 6 ? '08:00' : '07:00',
      endTime: dayOfWeek === 0 || dayOfWeek === 6 ? '20:00' : '22:00',
    })) });

    const groupService = await createService(tx, club.id, trainingLocation.id, Object.values(instructors).map(item => item.id), {
      name: 'Junior Performance Class', description: 'Weekly academy class covering technique, movement, drills and match play.',
      type: 'GROUP', duration: 120, price: 4800, capacity: 12, color: '#2d7564',
    });
    const privateService = await createService(tx, club.id, trainingLocation.id, Object.values(instructors).map(item => item.id), {
      name: '1:1 Badminton Coaching', description: 'Focused individual coaching built around the player’s current game.',
      type: 'PRIVATE', duration: 60, price: 12000, capacity: 1, color: '#557a9b',
    });
    await tx.availability.createMany({ data: Object.values(instructors).flatMap(instructor =>
      Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: club.id, instructorId: instructor.id, locationId: trainingLocation.id, dayOfWeek, startTime: '07:00', endTime: '22:00',
      })),
    ) });

    const groupKeys = studentDefinitions.slice(0, 12).map(item => item.key);
    type Session = {
      serviceId: string; instructorId: string; start: DateTime; duration: number; price: number; capacity: number; type: 'GROUP' | 'PRIVATE';
      studentKeys: StudentKey[]; status: 'COMPLETED' | 'CONFIRMED' | 'PENDING'; acceptance: 'ACCEPTED' | 'PENDING'; notes: string;
    };
    const sessions: Session[] = [];
    for (const [day, coach] of [[3, 'loh'], [6, 'eng'], [10, 'loh'], [13, 'eng'], [17, 'loh'], [20, 'eng'], [24, 'loh'], [27, 'eng'], [31, 'loh']] as const) {
      sessions.push({
        serviceId: groupService.id, instructorId: instructors[coach].id, start: october(day, day === 31 ? 10 : 18),
        duration: 120, price: 4800, capacity: 12, type: 'GROUP', studentKeys: groupKeys, status: 'CONFIRMED', acceptance: 'ACCEPTED',
        notes: `${day === 31 ? 'Saturday' : day % 7 === 3 ? 'Saturday' : 'Tuesday'} Junior Performance Class.`,
      });
    }
    const privateKeys = studentDefinitions.map(item => item.key);
    for (let day = 1; day <= 30; day += 1) {
      const coach: CoachKey = day % 2 ? 'loh' : 'eng';
      const studentKey = privateKeys[(day * 7) % privateKeys.length];
      const pending = day === 30;
      sessions.push({
        serviceId: privateService.id, instructorId: instructors[coach].id, start: october(day, 9 + (day % 7)),
        duration: 60, price: 12000, capacity: 1, type: 'PRIVATE', studentKeys: [studentKey],
        status: pending ? 'PENDING' : 'CONFIRMED', acceptance: pending ? 'PENDING' : 'ACCEPTED',
        notes: pending ? '1:1 club session awaiting coach acceptance.' : '1:1 club coaching session.',
      });
    }

    let participantSequence = 0;
    let receiptSequence = 0;
    for (const session of sessions.sort((left, right) => left.start.toMillis() - right.start.toMillis())) {
      const bookingId = randomUUID();
      const createdAt = DateTime.min(session.start.minus({ days: 14 }), showcaseNow.minus({ hours: 3 }));
      await tx.booking.create({ data: {
        id: bookingId, businessId: club.id, serviceId: session.serviceId, instructorId: session.instructorId, locationId: trainingLocation.id,
        startAt: session.start.toJSDate(), endAt: session.start.plus({ minutes: session.duration }).toJSDate(), duration: session.duration,
        bufferMinutes: 15, status: session.status, type: session.type, capacity: session.capacity, price: session.price, notes: session.notes,
        address: trainingLocation.address, paymentRoute: 'CLUB', coachAcceptance: session.acceptance,
        coachRespondedAt: session.acceptance === 'ACCEPTED'
          ? DateTime.min(createdAt.plus({ days: 2 }), showcaseNow.minus({ hours: 2 })).toJSDate()
          : null,
        createdByUserId: clubUser.id, createdByRole: 'CLUB', createdAt: createdAt.toJSDate(),
      } });
      for (const [index, key] of session.studentKeys.entries()) {
        const paid = session.status !== 'PENDING' && participantSequence++ % 4 !== 0;
        await tx.participant.create({ data: {
          id: randomUUID(), bookingId, studentId: students[key].id, attendance: 'UNMARKED', paid, price: session.price,
          notes: '', packageId: null, creditConsumed: false, cancelledAt: null,
        } });
        if (paid) await tx.payment.create({ data: {
          businessId: club.id, studentId: students[key].id, bookingId, kind: 'STUDENT_TO_CLUB', amount: session.price,
          method: receiptSequence % 3 === 0 ? 'SIMULATED_STRIPE' : 'BANK_TRANSFER',
          note: `October showcase class receipt ${String(++receiptSequence).padStart(3, '0')}`,
          paidAt: DateTime.min(createdAt.plus({ days: 1 }), showcaseNow.minus({ hours: 1 })).toJSDate(),
        } });
      }
    }
    const bookingCheckoutParticipant = await tx.participant.findFirstOrThrow({
      where: { paid: false, booking: { businessId: club.id, type: 'PRIVATE', status: 'CONFIRMED' } },
      include: { booking: true, student: { select: { userId: true } } }, orderBy: { booking: { startAt: 'asc' } },
    });
    if (!bookingCheckoutParticipant.student.userId) throw new Error('Booking checkout participant must have an account');
    const bookingIntent = await tx.paymentIntent.create({ data: {
      userId: bookingCheckoutParticipant.student.userId,
      businessId: club.id, kind: 'BOOKING', participantId: bookingCheckoutParticipant.id, amount: bookingCheckoutParticipant.price,
      currency: 'SGD', status: 'SUCCEEDED', provider: 'SIMULATED_STRIPE', providerReference: 'sim_pi_ele_booking_checkout',
      idempotencyKey: 'elever-booking-checkout', createdAt: showcaseNow.minus({ days: 1 }).toJSDate(),
      confirmedAt: showcaseNow.minus({ days: 1 }).toJSDate(),
    } });
    await tx.payment.create({ data: {
      businessId: club.id, studentId: bookingCheckoutParticipant.studentId, bookingId: bookingCheckoutParticipant.bookingId,
      paymentIntentId: bookingIntent.id, kind: 'STUDENT_TO_CLUB', amount: bookingCheckoutParticipant.price,
      method: 'SIMULATED_STRIPE', note: 'Online class checkout', paidAt: showcaseNow.minus({ days: 1 }).toJSDate(),
    } });
    await tx.participant.update({ where: { id: bookingCheckoutParticipant.id }, data: { paid: true } });

    const classOffer = await tx.packageOffer.create({ data: {
      businessId: club.id, name: 'October Class Pass', description: 'Eight credits for Elever group and individual classes.',
      price: 32000, totalCredits: 8, validityDays: 90, active: true, createdAt: showcaseNow.minus({ days: 10 }).toJSDate(),
    } });
    await tx.packageOfferService.createMany({ data: [
      { offerId: classOffer.id, businessId: club.id, serviceId: groupService.id },
      { offerId: classOffer.id, businessId: club.id, serviceId: privateService.id },
    ] });
    const flexOffer = await tx.packageOffer.create({ data: {
      businessId: club.id, name: 'Elever Play Pass', description: 'Six flexible credits for classes or a court reservation.',
      price: 28800, totalCredits: 6, validityDays: 120, active: true, createdAt: showcaseNow.minus({ days: 8 }).toJSDate(),
    } });
    await tx.packageOfferService.create({ data: { offerId: flexOffer.id, businessId: club.id, serviceId: groupService.id } });
    await tx.packageOfferLocation.create({ data: { offerId: flexOffer.id, businessId: club.id, locationId: rentalLocation.id } });
    const rentalOffer = await tx.packageOffer.create({ data: {
      businessId: club.id, name: 'Court Rental Bundle', description: 'Five one-credit court reservations at Elever Kallang Courts.',
      price: 15000, totalCredits: 5, validityDays: 60, active: true, createdAt: showcaseNow.minus({ days: 6 }).toJSDate(),
    } });
    await tx.packageOfferLocation.create({ data: { offerId: rentalOffer.id, businessId: club.id, locationId: rentalLocation.id } });

    const jamesPurchaseAt = showcaseNow.minus({ days: 5 });
    const dominicPurchaseAt = showcaseNow.minus({ days: 3 });
    const jamesPackage = await tx.lessonPackage.create({ data: {
      businessId: club.id, studentId: students.james.id, offerId: flexOffer.id, name: flexOffer.name, serviceId: null,
      totalCredits: flexOffer.totalCredits, usedCredits: 1, price: flexOffer.price, paid: true,
      expiresAt: jamesPurchaseAt.plus({ days: flexOffer.validityDays }).toJSDate(),
    } });
    await tx.lessonPackageService.create({ data: { packageId: jamesPackage.id, businessId: club.id, serviceId: groupService.id } });
    await tx.lessonPackageLocation.create({ data: { packageId: jamesPackage.id, businessId: club.id, locationId: rentalLocation.id } });
    const dominicPackage = await tx.lessonPackage.create({ data: {
      businessId: club.id, studentId: students.dominic.id, offerId: classOffer.id, name: classOffer.name, serviceId: null,
      totalCredits: classOffer.totalCredits, usedCredits: 0, price: classOffer.price, paid: true,
      expiresAt: dominicPurchaseAt.plus({ days: classOffer.validityDays }).toJSDate(),
    } });
    await tx.lessonPackageService.createMany({ data: [
      { packageId: dominicPackage.id, businessId: club.id, serviceId: groupService.id },
      { packageId: dominicPackage.id, businessId: club.id, serviceId: privateService.id },
    ] });
    const packagePurchases = [
      { pkg: jamesPackage, offer: flexOffer, user: studentUsers.james, student: students.james, at: jamesPurchaseAt },
      { pkg: dominicPackage, offer: classOffer, user: studentUsers.dominic, student: students.dominic, at: dominicPurchaseAt },
    ];
    for (const purchase of packagePurchases) {
      const intent = await tx.paymentIntent.create({ data: {
        userId: purchase.user.id, businessId: club.id, kind: 'PACKAGE', packageOfferId: purchase.offer.id, packageId: purchase.pkg.id,
        amount: purchase.offer.price, currency: 'SGD', status: 'SUCCEEDED', provider: 'SIMULATED_STRIPE',
        providerReference: `sim_pi_ele_${purchase.user.id.slice(-8)}_package`, idempotencyKey: `elever-package-${purchase.user.id}`,
        createdAt: purchase.at.toJSDate(), confirmedAt: purchase.at.toJSDate(),
      } });
      await tx.payment.create({ data: {
        businessId: club.id, studentId: purchase.student.id, packageId: purchase.pkg.id, paymentIntentId: intent.id,
        kind: 'STUDENT_TO_CLUB', amount: purchase.offer.price, method: 'SIMULATED_STRIPE',
        note: `Online checkout for ${purchase.offer.name}`, paidAt: purchase.at.toJSDate(),
      } });
    }
    await tx.paymentIntent.create({ data: {
      userId: studentUsers.carol.id, businessId: club.id, kind: 'PACKAGE', packageOfferId: rentalOffer.id,
      amount: rentalOffer.price, currency: 'SGD', status: 'FAILED', provider: 'SIMULATED_STRIPE',
      providerReference: 'sim_pi_ele_carol_failed_package', idempotencyKey: 'elever-package-carol-failed',
      createdAt: showcaseNow.minus({ days: 2 }).toJSDate(), failedAt: showcaseNow.minus({ days: 2 }).toJSDate(),
    } });

    const rentalPlans = [
      { key: 'james', unit: 0, day: 16, hour: 19, duration: 90, packageId: jamesPackage.id, paymentStatus: 'PACKAGE', creditConsumed: true },
      { key: 'dominic', unit: 1, day: 21, hour: 20, duration: 60, packageId: null, paymentStatus: 'PAID', creditConsumed: false },
      { key: 'student1', unit: 2, day: 25, hour: 10, duration: 120, packageId: null, paymentStatus: 'PAID', creditConsumed: false },
      { key: 'student8', unit: 3, day: 29, hour: 18, duration: 60, packageId: null, paymentStatus: 'PAID', creditConsumed: false },
    ] as const;
    for (const plan of rentalPlans) {
      const startAt = october(plan.day, plan.hour);
      const amount = Math.round(rentalLocation.rentalPrice * plan.duration / 60);
      const reservation = await tx.venueReservation.create({ data: {
        businessId: club.id, locationId: rentalLocation.id, unitId: units[plan.unit].id, userId: studentUsers[plan.key].id,
        startAt: startAt.toJSDate(), endAt: startAt.plus({ minutes: plan.duration }).toJSDate(), duration: plan.duration,
        price: amount, status: 'CONFIRMED', paymentStatus: plan.paymentStatus, packageId: plan.packageId,
        creditConsumed: plan.creditConsumed, notes: 'October investor showcase court reservation.',
        createdAt: showcaseNow.minus({ days: 4, hours: plan.unit }).toJSDate(),
      } });
      const intent = await tx.paymentIntent.create({ data: {
        userId: studentUsers[plan.key].id, businessId: club.id, kind: 'RENTAL', reservationId: reservation.id,
        amount: plan.packageId ? 0 : amount, currency: 'SGD', status: 'SUCCEEDED', provider: 'SIMULATED_STRIPE',
        providerReference: `sim_pi_ele_rental_${plan.day}_${plan.unit}`, idempotencyKey: `elever-rental-${plan.day}-${plan.key}`,
        createdAt: showcaseNow.minus({ days: 4, hours: plan.unit }).toJSDate(),
        confirmedAt: showcaseNow.minus({ days: 4, hours: plan.unit }).toJSDate(),
      } });
      if (!plan.packageId) await tx.payment.create({ data: {
        businessId: club.id, studentId: students[plan.key].id, paymentIntentId: intent.id, kind: 'STUDENT_TO_CLUB',
        amount, method: 'SIMULATED_STRIPE', note: `Online venue rental · ${rentalLocation.name}`,
        paidAt: showcaseNow.minus({ days: 4, hours: plan.unit }).toJSDate(),
      } });
    }

    await tx.payment.createMany({ data: [
      { businessId: club.id, studentId: null, instructorId: instructors.loh.id, kind: 'CLUB_TO_COACH', amount: 68000, method: 'BANK_TRANSFER', note: 'September coaching payout · Loh Kean Hean', paidAt: showcaseNow.minus({ days: 2 }).toJSDate() },
      { businessId: club.id, studentId: null, instructorId: instructors.eng.id, kind: 'CLUB_TO_COACH', amount: 62000, method: 'BANK_TRANSFER', note: 'September coaching payout · Eng Chin An', paidAt: showcaseNow.minus({ days: 2 }).toJSDate() },
    ] });

    const integrityFlag = await tx.integrityFlag.create({ data: {
      businessId: club.id, instructorId: instructors.loh.id, coachUserId: coachUsers.loh.id, studentUserId: studentUsers.carol.id,
      coachName: coachUsers.loh.name, studentName: studentUsers.carol.name, bookingId: null, outsideBusinessId: null,
      outsideBusinessName: 'Legacy private practice', status: 'REVIEWING', occurrences: 2,
      detail: 'Historical safeguard evidence retained from a legacy private practice. The outside session is read-only and is not part of the active October fixture.',
      firstSeenAt: showcaseNow.minus({ months: 2 }).toJSDate(), lastSeenAt: showcaseNow.minus({ weeks: 2 }).toJSDate(),
    } });
    await tx.notification.createMany({ data: [
      { businessId: club.id, type: 'NOTICE', title: 'October showcase is ready', message: 'The academy schedule includes weekly classes, individual coaching, packages and court reservations.', read: true, createdAt: showcaseNow.minus({ hours: 3 }).toJSDate() },
      { businessId: club.id, instructorId: instructors.eng.id, type: 'PENDING_ACTION', title: 'Class acceptance needed', message: 'The 30 October 1:1 class is awaiting Chin An’s acceptance.', actionNeeded: true, read: false, createdAt: showcaseNow.minus({ hours: 2 }).toJSDate() },
      { businessId: club.id, type: 'PAYMENT', title: 'Simulated Stripe activity ready', message: 'Package and rental checkouts are represented in the October ledger.', read: false, createdAt: showcaseNow.minus({ hours: 1 }).toJSDate() },
      { businessId: club.id, integrityFlagId: integrityFlag.id, type: 'INTEGRITY', title: 'Private session needs your review', message: 'Loh Kean Hean and Carol have historical private-session evidence from a retired practice. Review the details and record your decision here.', actionNeeded: true, read: false, createdAt: showcaseNow.minus({ minutes: 30 }).toJSDate() },
    ] });
    await tx.accountNotification.createMany({ data: [
      { userId: studentUsers.dominic.id, businessId: club.id, type: 'PAYMENT_RECORDED', title: 'Package purchase confirmed', message: 'October Class Pass is ready to use.', read: false, createdAt: showcaseNow.minus({ days: 3 }).toJSDate() },
      { userId: studentUsers.dominic.id, businessId: club.id, type: 'PAYMENT_RECORDED', title: 'Court reservation confirmed', message: 'Court 2 is reserved at Elever Kallang Courts.', read: false, createdAt: showcaseNow.minus({ days: 4 }).toJSDate() },
    ] });

    const [invalidBookingTimes, invalidPaymentTimes] = await Promise.all([
      tx.booking.count({ where: { OR: [{ createdAt: { gt: showcaseNow.toJSDate() } }, { coachRespondedAt: { gt: showcaseNow.toJSDate() } }] } }),
      tx.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM "Payment" p JOIN "Booking" b ON b.id = p."bookingId"
        WHERE p."paidAt" < b."createdAt"
      `,
    ]);
    if (invalidBookingTimes || invalidPaymentTimes[0]?.count) throw new Error('Fixture contains impossible audit timestamps');
    const migrationsAfter = await tx.$queryRaw<typeof migrationsBefore>`
      SELECT id, migration_name, checksum, started_at::text, finished_at::text, rolled_back_at::text, applied_steps_count
      FROM "_prisma_migrations" ORDER BY started_at, id
    `;
    if (JSON.stringify(migrationsAfter) !== JSON.stringify(migrationsBefore)) throw new Error('Migration history changed during fixture provisioning');
    return { clubId: club.id, clubSlug: club.slug };
  }, { maxWait: 10_000, timeout: 120_000 });

  const counts = await Promise.all([
    prisma.business.count(), prisma.user.count(), prisma.membership.count(), prisma.instructor.count(), prisma.student.count(),
    prisma.booking.count(), prisma.participant.count(), prisma.payment.count(), prisma.packageOffer.count(),
    prisma.lessonPackage.count(), prisma.venueReservation.count(), prisma.paymentIntent.count(), prisma.notification.count(),
  ]);
  console.log(JSON.stringify({
    ok: true, business: { id: result.clubId, slug: result.clubSlug },
    counts: Object.fromEntries([
      'businesses', 'users', 'memberships', 'instructors', 'students', 'bookings', 'participants', 'payments',
      'packageOffers', 'packages', 'reservations', 'paymentIntents', 'notifications',
    ].map((key, index) => [key, counts[index]])),
  }, null, 2));
}

main().catch(error => {
  console.error('Elever provisioning failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
