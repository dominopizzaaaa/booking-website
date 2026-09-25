import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../src/config.js';

const databaseUrl = process.env.DATABASE_URL!;
const backendDirectory = fileURLToPath(new URL('../', import.meta.url));
const prismaSchema = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const provisioner = fileURLToPath(new URL('../prisma/provision-elever-showcase.ts', import.meta.url));
const resetConfirmation = 'DELETE ALL COURTLY APPLICATION DATA AND PROVISION ELEVER';
const expectedMigrationCount = readdirSync(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).length;

const passwords = {
  club: 'Test-Elever-Club!2026', loh: 'Test-Elever-Loh!2026', eng: 'Test-Elever-Eng!2026',
  dominic: 'Test-Elever-Dominic!2026', students: 'Test-Elever-Students!2026',
} as const;
const expectedStudentNames = [
  'James', 'Julian', 'Sean', 'Lauren', 'Aaron', 'Benjamin', 'Carol', 'Dominic',
  ...Array.from({ length: 12 }, (_, index) => 'Student ' + (index + 1)),
].sort();
const expectedOctoberDates = Array.from(
  { length: 31 },
  (_, index) => '2026-10-' + String(index + 1).padStart(2, '0'),
);
const singaporeDateFormatter = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
});
function singaporeDate(value: Date) {
  const parts = Object.fromEntries(
    singaporeDateFormatter.formatToParts(value).map(part => [part.type, part.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day;
}

const applicationTables = [
  'AccountNotification', 'CalendarBusyInterval', 'CalendarEventProjection', 'CalendarOAuthAttempt',
  'CalendarRevocationJob', 'CalendarSyncJob', 'CalendarConnection', 'AuthSession', 'Availability',
  'AvailabilityException', 'Booking', 'Business', 'Instructor', 'IntegrityFlag', 'LessonPackage',
  'LessonPackageLocation', 'LessonPackageService', 'Location', 'Membership', 'Notification', 'PackageOffer',
  'PackageOfferLocation', 'PackageOfferService', 'Participant', 'Payment', 'PaymentIntent', 'RescheduleRequest',
  'Service', 'ServiceInstructor', 'ServiceLocation', 'Student', 'User', 'VenueOpeningHour', 'VenueReservation', 'VenueUnit',
] as const;
const snapshotTables = [...applicationTables, '_prisma_migrations'] as const;
type ProvisionResult = SpawnSyncReturns<string>;
type Snapshot = Record<(typeof snapshotTables)[number], { count: number; digest: string }>;

function isolatedUrl(schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}
function childEnvironment(overrides: Record<string, string>) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_OPTIONS;
  return env;
}
function migrate(url: string) {
  return spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', prismaSchema], {
    cwd: backendDirectory, encoding: 'utf8', env: childEnvironment({ DATABASE_URL: url }),
    timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
  });
}
function runProvisioner(url: string, fingerprint: string): ProvisionResult {
  return spawnSync(process.execPath, [tsxCli, provisioner], {
    cwd: backendDirectory, encoding: 'utf8',
    env: childEnvironment({
      DATABASE_URL: url, ELEVER_RESET_CONFIRMATION: resetConfirmation, ELEVER_EXPECTED_DATABASE_SHA256: fingerprint,
      ELEVER_CLUB_PASSWORD: passwords.club, ELEVER_LOH_PASSWORD: passwords.loh, ELEVER_ENG_PASSWORD: passwords.eng,
      ELEVER_DOMINIC_PASSWORD: passwords.dominic, ELEVER_STUDENT_PASSWORD: passwords.students,
    }),
    timeout: 180_000, maxBuffer: 10 * 1024 * 1024,
  });
}
function commandFailure(label: string, result: ProvisionResult) {
  return `${label} failed (status ${String(result.status)}):\n${result.stdout}\n${result.stderr}`;
}
async function snapshot(db: PrismaClient): Promise<Snapshot> {
  const result = {} as Snapshot;
  for (const table of snapshotTables) {
    const [row] = await db.$queryRawUnsafe<Array<{ count: number; digest: string }>>(
      `SELECT COUNT(*)::int AS count, md5(COALESCE(string_agg(to_jsonb(row_value)::text, E'\n' ORDER BY to_jsonb(row_value)::text), '')) AS digest FROM "${table}" AS row_value`,
    );
    if (!row) throw new Error(`Could not snapshot ${table}`);
    result[table] = row;
  }
  return result;
}

describe.sequential('Elever showcase provisioner integration', () => {
  let admin: PrismaClient | undefined;
  let db: PrismaClient | undefined;
  let schema = '';
  let url = '';
  let fingerprint = '';

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      throw new Error('Elever fixture integration tests require a local PostgreSQL DATABASE_URL');
    }
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    await admin.$queryRaw`SELECT 1`;
    schema = `elever_fixture_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    url = isolatedUrl(schema);
    fingerprint = createHash('sha256').update(url).digest('hex');
    const migration = migrate(url);
    if (migration.status !== 0) throw new Error(commandFailure('Migration', migration));
    db = new PrismaClient({ datasourceUrl: url });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (admin && schema) {
      if (!/^elever_fixture_[a-f0-9_]+$/.test(schema)) throw new Error(`Refusing to drop unexpected schema ${schema}`);
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await admin?.$disconnect();
  });

  it('rejects a wrong database fingerprint before making any write', async () => {
    const database = db!;
    await database.user.create({ data: {
      id: 'fingerprint-sentinel', name: 'Fingerprint Sentinel', email: 'fingerprint-sentinel@example.test',
      username: 'fingerprint_sentinel', sports: ['Badminton'], accountType: 'STUDENT',
    } });
    const before = await snapshot(database);
    const result = runProvisioner(url, '0'.repeat(64));
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'ELEVER_EXPECTED_DATABASE_SHA256 does not match DATABASE_URL; no data was changed',
    );
    expect(await snapshot(database)).toEqual(before);
  }, 30_000);

  it('atomically replaces the schema with the exact October 2026 Elever marketplace graph', async () => {
    const database = db!;
    const result = runProvisioner(url, fingerprint);
    if (result.status !== 0) throw new Error(commandFailure('Elever provisioner', result));
    expect(result.stdout).toContain('"ok": true');
    expect(await database.user.findUnique({ where: { id: 'fingerprint-sentinel' } })).toBeNull();

    const businesses = await database.business.findMany();
    expect(businesses).toHaveLength(1);
    expect(businesses[0]).toMatchObject({
      name: 'Elever Badminton Academy', slug: 'elever-badminton-academy', kind: 'CLUB', legacyReadOnly: false, isDemo: false,
    });
    const club = businesses[0];
    expect(await database.business.count({ where: { kind: 'SOLO' } })).toBe(0);

    const users = await database.user.findMany({ orderBy: { username: 'asc' } });
    expect(users).toHaveLength(23);
    expect(users.every(user => /^[a-z0-9_]{3,30}$/.test(user.username) && user.sports.join('|') === 'Badminton')).toBe(true);
    expect(users.map(user => user.username)).toEqual([
      'elever_aaron', 'elever_badminton', 'elever_benjamin', 'elever_carol', 'elever_dominic', 'eng_chin_an',
      'elever_james', 'elever_julian', 'elever_lauren', 'loh_kean_hean', 'elever_sean',
      ...Array.from({ length: 12 }, (_, index) => `elever_student_${index + 1}`).sort(),
    ].sort());
    expect(users.filter(user => user.accountType === 'STUDENT')).toHaveLength(20);
    const featuredCredentials = [
      ['investors@eleverbadminton.com', passwords.club], ['loh.kean.hean@eleverbadminton.com', passwords.loh],
      ['eng.chin.an@eleverbadminton.com', passwords.eng], ['dominic.student@eleverbadminton.com', passwords.dominic],
    ] as const;
    for (const [email, password] of featuredCredentials) {
      const user = users.find(candidate => candidate.email === email)!;
      expect(await bcrypt.compare(password, user.passwordHash!)).toBe(true);
    }
    expect(users.filter(user => user.accountType === 'STUDENT').map(user => user.name).sort())
      .toEqual(expectedStudentNames);

    const memberships = await database.membership.findMany({ include: { user: true, instructor: true } });
    expect(memberships).toHaveLength(3);
    expect(memberships.filter(item => item.user.accountType === 'CLUB')).toEqual([
      expect.objectContaining({ businessId: club.id, instructorId: null }),
    ]);
    expect(memberships.filter(item => item.user.accountType === 'COACH').every(item =>
      item.businessId === club.id && item.active && item.instructor?.name === item.user.name
    )).toBe(true);
    expect(await database.student.count({ where: { businessId: club.id } })).toBe(20);
    expect(await database.student.count({ where: { name: { startsWith: 'Student ' } } })).toBe(12);

    const locations = await database.location.findMany({
      include: { venueUnits: true, openingHours: true }, orderBy: { name: 'asc' },
    });
    expect(locations).toHaveLength(2);
    const rental = locations.find(location => location.name === 'Elever Kallang Courts')!;
    expect(rental).toMatchObject({
      type: 'FACILITY', active: true, sport: 'Badminton', rentalEnabled: true, rentalUnitLabel: 'Court',
      rentalPrice: 3600, rentalStartInterval: 30, rentalMinDuration: 60, rentalBookingIncrement: 30,
      rentalMaxDuration: 120, rentalNoticeHours: 2, rentalAdvanceDays: 60, rentalCancellationHours: 24,
    });
    expect(JSON.parse(rental.amenities)).toEqual(['Air conditioning', 'Changing rooms', 'Racket hire', 'Shuttlecocks']);
    expect(rental.venueUnits.map(unit => unit.name).sort()).toEqual(['Court 1', 'Court 2', 'Court 3', 'Court 4']);
    expect(rental.openingHours).toHaveLength(7);

    const bookings = await database.booking.findMany({
      include: { instructor: true, service: true, participants: { include: { student: true } } }, orderBy: { startAt: 'asc' },
    });
    expect(bookings).toHaveLength(39);
    expect(bookings.every(booking => booking.businessId === club.id && booking.paymentRoute === 'CLUB'
      && booking.createdByRole === 'CLUB' && booking.startAt >= new Date('2026-09-30T16:00:00.000Z')
      && booking.startAt < new Date('2026-11-01T16:00:00.000Z'))).toBe(true);
    expect([...new Set(bookings.map(booking => singaporeDate(booking.startAt)))].sort())
      .toEqual(expectedOctoberDates);
    expect(await database.booking.count({ where: { paymentRoute: 'DIRECT' } })).toBe(0);
    const groupClasses = bookings.filter(booking => booking.type === 'GROUP');
    const privateClasses = bookings.filter(booking => booking.type === 'PRIVATE');
    expect([groupClasses.length, privateClasses.length]).toEqual([9, 30]);
    expect(groupClasses.every(booking => booking.service.name === 'Junior Performance Class'
      && booking.participants.length === 12 && booking.capacity === 12 && booking.price === 4800)).toBe(true);
    expect(privateClasses.every(booking => booking.service.name === '1:1 Badminton Coaching'
      && booking.participants.length === 1 && booking.capacity === 1 && booking.price === 12000)).toBe(true);
    expect(new Set(privateClasses.map(booking => booking.participants[0].student.name)).size).toBe(20);
    expect(bookings.filter(booking => booking.status === 'PENDING')).toEqual([
      expect.objectContaining({ coachAcceptance: 'PENDING', paymentRoute: 'CLUB' }),
    ]);
    expect(bookings.filter(booking => booking.status === 'COMPLETED')).toHaveLength(0);
    expect(bookings.flatMap(booking => booking.participants)).toHaveLength(138);
    expect(bookings.flatMap(booking => booking.participants).filter(participant => participant.paid)).toHaveLength(103);

    const offers = await database.packageOffer.findMany({
      include: { services: true, rentalLocations: true }, orderBy: { name: 'asc' },
    });
    expect(offers.map(offer => ({
      name: offer.name, price: offer.price, credits: offer.totalCredits, validity: offer.validityDays,
      services: offer.services.length, rentals: offer.rentalLocations.length, active: offer.active,
    }))).toEqual([
      { name: 'Court Rental Bundle', price: 15000, credits: 5, validity: 60, services: 0, rentals: 1, active: true },
      { name: 'Elever Play Pass', price: 28800, credits: 6, validity: 120, services: 1, rentals: 1, active: true },
      { name: 'October Class Pass', price: 32000, credits: 8, validity: 90, services: 2, rentals: 0, active: true },
    ]);
    const packages = await database.lessonPackage.findMany({
      include: { student: true, offer: true, services: true, rentalLocations: true }, orderBy: { student: { name: 'asc' } },
    });
    expect(packages.map(pkg => ({
      student: pkg.student.name, offer: pkg.offer?.name, name: pkg.name, paid: pkg.paid, used: pkg.usedCredits,
      services: pkg.services.length, rentals: pkg.rentalLocations.length,
    }))).toEqual([
      { student: 'Dominic', offer: 'October Class Pass', name: 'October Class Pass', paid: true, used: 0, services: 2, rentals: 0 },
      { student: 'James', offer: 'Elever Play Pass', name: 'Elever Play Pass', paid: true, used: 1, services: 1, rentals: 1 },
    ]);

    const reservations = await database.venueReservation.findMany({ include: { user: true, unit: true }, orderBy: { startAt: 'asc' } });
    expect(reservations).toHaveLength(4);
    expect(reservations.every(item => item.businessId === club.id && item.locationId === rental.id
      && item.status === 'CONFIRMED' && item.startAt >= new Date('2026-09-30T16:00:00.000Z')
      && item.startAt < new Date('2026-11-01T16:00:00.000Z'))).toBe(true);
    expect(reservations.map(item => [item.user.name, item.duration, item.price, item.paymentStatus])).toEqual([
      ['James', 90, 5400, 'PACKAGE'], ['Dominic', 60, 3600, 'PAID'],
      ['Student 1', 120, 7200, 'PAID'], ['Student 8', 60, 3600, 'PAID'],
    ]);
    expect(reservations.filter(item => item.creditConsumed && item.packageId)).toHaveLength(1);

    const intents = await database.paymentIntent.findMany({
      include: {
        payment: { include: { student: { select: { userId: true } } } },
        participant: { include: {
          student: { select: { userId: true } }, booking: { select: { id: true, paymentRoute: true } },
        } },
        reservation: { select: { id: true, userId: true } },
        package: { include: { student: { select: { userId: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(intents).toHaveLength(8);
    expect(intents.every(intent => intent.provider === 'SIMULATED_STRIPE')).toBe(true);
    expect(intents.filter(intent => intent.kind === 'PACKAGE')).toHaveLength(3);
    expect(intents.filter(intent => intent.kind === 'BOOKING')).toHaveLength(1);
    expect(intents.filter(intent => intent.kind === 'RENTAL')).toHaveLength(4);
    expect(intents.filter(intent => intent.status === 'SUCCEEDED')).toHaveLength(7);
    expect(intents.filter(intent => intent.status === 'FAILED')).toEqual([
      expect.objectContaining({ kind: 'PACKAGE', packageId: null, payment: null }),
    ]);
    const paidIntents = intents.filter(intent => intent.status === 'SUCCEEDED' && intent.amount > 0);
    expect(paidIntents).toHaveLength(6);
    for (const intent of paidIntents) {
      expect(intent.payment).toMatchObject({
        paymentIntentId: intent.id, businessId: intent.businessId, amount: intent.amount,
        method: 'SIMULATED_STRIPE', kind: 'STUDENT_TO_CLUB', reversedAt: null,
      });
      expect(intent.currency).toBe('SGD');
      expect(intent.payment?.student?.userId).toBe(intent.userId);
      if (intent.kind === 'PACKAGE') {
        expect(intent.package?.student.userId).toBe(intent.userId);
        expect(intent.payment?.packageId).toBe(intent.packageId);
        expect(intent.payment?.bookingId).toBeNull();
      } else if (intent.kind === 'BOOKING') {
        expect(intent.participant?.student.userId).toBe(intent.userId);
        expect(intent.participant?.booking.paymentRoute).toBe('CLUB');
        expect(intent.payment?.bookingId).toBe(intent.participant?.booking.id);
        expect(intent.payment?.studentId).toBe(intent.participant?.studentId);
        expect(intent.payment?.packageId).toBeNull();
      } else {
        expect(intent.reservation?.userId).toBe(intent.userId);
        expect(intent.payment?.bookingId).toBeNull();
        expect(intent.payment?.packageId).toBeNull();
      }
    }
    expect(intents.filter(intent => intent.status === 'SUCCEEDED' && intent.amount === 0)).toEqual([
      expect.objectContaining({
        kind: 'RENTAL', payment: null,
        reservation: expect.objectContaining({ userId: expect.any(String) }),
      }),
    ]);

    const payments = await database.payment.findMany({ include: { booking: true, paymentIntent: true } });
    expect(payments).toHaveLength(110);
    expect(payments.filter(payment => payment.kind === 'CLUB_TO_COACH')).toHaveLength(2);
    expect(payments.filter(payment => payment.kind === 'STUDENT_TO_CLUB')).toHaveLength(108);
    expect(payments.filter(payment => payment.kind === 'STUDENT_TO_COACH')).toHaveLength(0);
    expect(payments.filter(payment => payment.bookingId)).toHaveLength(103);
    expect(payments.filter(payment => payment.paymentIntentId)).toHaveLength(6);
    expect(payments.every(payment => payment.reversedAt === null)).toBe(true);

    const flag = await database.integrityFlag.findFirst({ where: { businessId: club.id } });
    expect(flag).toMatchObject({
      coachName: 'Loh Kean Hean', studentName: 'Carol', bookingId: null, outsideBusinessId: null,
      outsideBusinessName: 'Legacy private practice', status: 'REVIEWING', occurrences: 2,
    });
    expect(await database.notification.findFirst({ where: { integrityFlagId: flag!.id } })).toMatchObject({
      type: 'INTEGRITY', title: 'Private session needs your review', actionNeeded: true, instructorId: null,
    });

    const counts = await snapshot(database);
    expect(counts._prisma_migrations.count).toBe(expectedMigrationCount);
    expect(await database.$queryRawUnsafe<Array<{ failed: number; rolledBack: number }>>(
      `SELECT COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS failed, COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL)::int AS "rolledBack" FROM "_prisma_migrations"`,
    )).toEqual([{ failed: 0, rolledBack: 0 }]);
    expect(Object.fromEntries(applicationTables.map(table => [table, counts[table].count]))).toEqual({
      AccountNotification: 2, CalendarBusyInterval: 0, CalendarEventProjection: 0, CalendarOAuthAttempt: 0,
      CalendarRevocationJob: 0, CalendarSyncJob: 0, CalendarConnection: 0, AuthSession: 0, Availability: 14,
      AvailabilityException: 0, Booking: 39, Business: 1, Instructor: 2, IntegrityFlag: 1, LessonPackage: 2,
      LessonPackageLocation: 1, LessonPackageService: 3, Location: 2, Membership: 3, Notification: 4,
      PackageOffer: 3, PackageOfferLocation: 2, PackageOfferService: 3, Participant: 138, Payment: 110,
      PaymentIntent: 8, RescheduleRequest: 0, Service: 2, ServiceInstructor: 4, ServiceLocation: 2,
      Student: 20, User: 23, VenueOpeningHour: 7, VenueReservation: 4, VenueUnit: 4,
    });
  }, 180_000);

  it('rolls the reset back when an unexpected foreign-key table prevents non-CASCADE truncation', async () => {
    const database = db!;
    const club = await database.business.findUniqueOrThrow({ where: { slug: 'elever-badminton-academy' } });
    await database.$executeRawUnsafe(`CREATE TABLE "UnexpectedFixtureReference" (id TEXT PRIMARY KEY, "businessId" TEXT NOT NULL REFERENCES "Business"(id))`);
    await database.$executeRawUnsafe(`INSERT INTO "UnexpectedFixtureReference" (id, "businessId") VALUES ('preserve-me', $1)`, club.id);
    const before = await snapshot(database);
    const result = runProvisioner(url, fingerprint);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/cannot truncate a table referenced in a foreign key constraint/i);
    expect(await snapshot(database)).toEqual(before);
    expect(await database.$queryRawUnsafe(`SELECT id, "businessId" FROM "UnexpectedFixtureReference"`))
      .toEqual([{ id: 'preserve-me', businessId: club.id }]);
  }, 180_000);
});
