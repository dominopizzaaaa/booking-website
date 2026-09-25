import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
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

const passwords = {
  club: 'Test-Elever-Club!2026',
  loh: 'Test-Elever-Loh!2026',
  eng: 'Test-Elever-Eng!2026',
  dominic: 'Test-Elever-Dominic!2026',
  students: 'Test-Elever-Students!2026',
} as const;

const applicationTables = [
  'AccountNotification', 'AuthSession', 'Availability', 'AvailabilityException', 'Booking',
  'Business', 'Instructor', 'IntegrityFlag', 'LessonPackage', 'Location', 'Membership',
  'Notification', 'Participant', 'Payment', 'RescheduleRequest', 'Service',
  'ServiceInstructor', 'ServiceLocation', 'Student', 'User',
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
  // Desktop preload hooks are unrelated to the CLI under test and can make a
  // child Node process fail before TSX starts.
  delete env.NODE_OPTIONS;
  return env;
}

function migrate(url: string) {
  return spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', prismaSchema], {
    cwd: backendDirectory,
    encoding: 'utf8',
    env: childEnvironment({ DATABASE_URL: url }),
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runProvisioner(url: string, fingerprint: string): ProvisionResult {
  return spawnSync(process.execPath, [tsxCli, provisioner], {
    cwd: backendDirectory,
    encoding: 'utf8',
    env: childEnvironment({
      DATABASE_URL: url,
      ELEVER_RESET_CONFIRMATION: resetConfirmation,
      ELEVER_EXPECTED_DATABASE_SHA256: fingerprint,
      ELEVER_CLUB_PASSWORD: passwords.club,
      ELEVER_LOH_PASSWORD: passwords.loh,
      ELEVER_ENG_PASSWORD: passwords.eng,
      ELEVER_DOMINIC_PASSWORD: passwords.dominic,
      ELEVER_STUDENT_PASSWORD: passwords.students,
    }),
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
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
      if (!/^elever_fixture_[a-f0-9_]+$/.test(schema)) {
        throw new Error(`Refusing to drop unexpected schema ${schema}`);
      }
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await admin?.$disconnect();
  });

  it('rejects a wrong database fingerprint before making any write', async () => {
    const database = db!;
    await database.user.create({
      data: {
        id: 'fingerprint-sentinel',
        name: 'Fingerprint Sentinel',
        email: 'fingerprint-sentinel@example.test',
        accountType: 'STUDENT',
      },
    });
    const before = await snapshot(database);

    const result = runProvisioner(url, '0'.repeat(64));

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'ELEVER_EXPECTED_DATABASE_SHA256 does not match DATABASE_URL; no data was changed',
    );
    expect(await snapshot(database)).toEqual(before);
    expect(await database.user.findUnique({ where: { id: 'fingerprint-sentinel' } })).toMatchObject({
      email: 'fingerprint-sentinel@example.test',
    });
  }, 30_000);

  it('atomically replaces the schema with the exact Elever account, tenancy, schedule, and ledger graph', async () => {
    const database = db!;
    const result = runProvisioner(url, fingerprint);
    if (result.status !== 0) throw new Error(commandFailure('Elever provisioner', result));

    expect(result.stdout).toContain('\"ok\": true');
    expect(await database.user.findUnique({ where: { id: 'fingerprint-sentinel' } })).toBeNull();

    const businesses = await database.business.findMany({ orderBy: { name: 'asc' } });
    expect(businesses.map(({ name, slug, kind, isDemo }) => ({ name, slug, kind, isDemo }))).toEqual([
      { name: 'Elever Badminton Academy', slug: 'elever-badminton-academy', kind: 'CLUB', isDemo: false },
      { name: 'Eng Chin An Private Coaching', slug: 'eng-chin-an-private-coaching', kind: 'SOLO', isDemo: false },
      { name: 'Loh Kean Hean Private Coaching', slug: 'loh-kean-hean-private-coaching', kind: 'SOLO', isDemo: false },
    ]);
    const businessByName = Object.fromEntries(businesses.map(business => [business.name, business]));
    const club = businessByName['Elever Badminton Academy']!;
    const engPractice = businessByName['Eng Chin An Private Coaching']!;
    const lohPractice = businessByName['Loh Kean Hean Private Coaching']!;

    const users = await database.user.findMany({ orderBy: { name: 'asc' } });
    expect(users.map(({ name, accountType }) => ({ name, accountType }))).toEqual([
      { name: 'Aaron', accountType: 'STUDENT' },
      { name: 'Benjamin', accountType: 'STUDENT' },
      { name: 'Carol', accountType: 'STUDENT' },
      { name: 'Dominic', accountType: 'STUDENT' },
      { name: 'Elever Badminton Academy', accountType: 'CLUB' },
      { name: 'Eng Chin An', accountType: 'COACH' },
      { name: 'James', accountType: 'STUDENT' },
      { name: 'Julian', accountType: 'STUDENT' },
      { name: 'Lauren', accountType: 'STUDENT' },
      { name: 'Loh Kean Hean', accountType: 'COACH' },
      { name: 'Sean', accountType: 'STUDENT' },
    ]);

    const featuredCredentials = [
      ['investors@eleverbadminton.com', passwords.club],
      ['loh.kean.hean@eleverbadminton.com', passwords.loh],
      ['eng.chin.an@eleverbadminton.com', passwords.eng],
      ['dominic.student@eleverbadminton.com', passwords.dominic],
    ] as const;
    for (const [email, password] of featuredCredentials) {
      const user = users.find(candidate => candidate.email === email);
      expect(user?.passwordHash, `${email} should have a password hash`).toBeTruthy();
      expect(await bcrypt.compare(password, user!.passwordHash!)).toBe(true);
    }

    const memberships = await database.membership.findMany({
      include: { user: true, business: true, instructor: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(memberships).toHaveLength(5);
    expect(memberships.filter(item => item.user.accountType === 'STUDENT')).toHaveLength(0);
    expect(memberships.filter(item => item.user.accountType === 'CLUB')).toEqual([
      expect.objectContaining({
        businessId: club.id,
        instructorId: null,
        user: expect.objectContaining({ name: 'Elever Badminton Academy' }),
      }),
    ]);
    for (const [coachName, practiceId] of [
      ['Loh Kean Hean', lohPractice.id],
      ['Eng Chin An', engPractice.id],
    ] as const) {
      const coachMemberships = memberships.filter(item => item.user.name === coachName);
      expect(coachMemberships).toHaveLength(2);
      expect(coachMemberships.map(item => item.businessId).sort()).toEqual([club.id, practiceId].sort());
      expect(coachMemberships.every(item => item.active && item.instructor?.name === coachName)).toBe(true);
    }

    const students = await database.student.findMany({
      include: { user: true, business: true },
      orderBy: { name: 'asc' },
    });
    expect(students).toHaveLength(8);
    expect(students.every(student => student.user?.accountType === 'STUDENT' && student.user.name === student.name)).toBe(true);
    expect(students.filter(student => student.businessId === club.id).map(student => student.name)).toEqual(
      ['Aaron', 'Benjamin', 'James', 'Julian', 'Lauren', 'Sean'],
    );
    expect(students.filter(student => student.businessId === lohPractice.id).map(student => student.name)).toEqual(['Carol']);
    expect(students.filter(student => student.businessId === engPractice.id).map(student => student.name)).toEqual(['Dominic']);

    const bookings = await database.booking.findMany({
      include: { instructor: true, participants: { include: { student: true } } },
      orderBy: { startAt: 'asc' },
    });
    expect(bookings).toHaveLength(52);
    const clubBookings = bookings.filter(booking => booking.businessId === club.id);
    const lohBookings = bookings.filter(booking => booking.businessId === lohPractice.id);
    const engBookings = bookings.filter(booking => booking.businessId === engPractice.id);
    expect([clubBookings.length, lohBookings.length, engBookings.length]).toEqual([30, 11, 11]);
    expect(clubBookings.every(booking =>
      booking.type === 'GROUP' && booking.paymentRoute === 'CLUB' && booking.price === 4800
      && booking.duration === 120 && booking.capacity === 8 && booking.createdByRole === 'CLUB'
      && booking.participants.map(participant => participant.student.name).sort().join('|')
        === 'Aaron|Benjamin|James|Julian|Lauren|Sean'
    )).toBe(true);
    expect(clubBookings.filter(booking => booking.instructor.name === 'Loh Kean Hean')).toHaveLength(15);
    expect(clubBookings.filter(booking => booking.instructor.name === 'Eng Chin An')).toHaveLength(15);
    for (const [practiceBookings, studentName, coachName] of [
      [lohBookings, 'Carol', 'Loh Kean Hean'],
      [engBookings, 'Dominic', 'Eng Chin An'],
    ] as const) {
      expect(practiceBookings.every(booking =>
        booking.type === 'PRIVATE' && booking.paymentRoute === 'DIRECT' && booking.price === 12000
        && booking.duration === 60 && booking.capacity === 1 && booking.createdByRole === 'COACH'
        && booking.coachAcceptance === 'NOT_REQUIRED' && booking.instructor.name === coachName
        && booking.participants.length === 1 && booking.participants[0]?.student.name === studentName
      )).toBe(true);
    }

    expect(bookings.filter(booking => booking.status === 'PENDING')).toEqual([
      expect.objectContaining({
        businessId: club.id,
        paymentRoute: 'CLUB',
        coachAcceptance: 'PENDING',
        instructor: expect.objectContaining({ name: 'Eng Chin An' }),
      }),
    ]);
    expect(bookings.filter(booking => booking.status === 'COMPLETED').length).toBeGreaterThanOrEqual(28);
    expect(bookings.filter(booking => booking.startAt > new Date()).length).toBeGreaterThanOrEqual(20);
    expect(bookings.every(booking => booking.createdAt <= booking.startAt)).toBe(true);
    expect(bookings.filter(booking => booking.coachAcceptance === 'ACCEPTED').every(booking =>
      booking.coachRespondedAt !== null
      && booking.coachRespondedAt >= booking.createdAt
      && booking.coachRespondedAt <= booking.startAt
    )).toBe(true);
    expect(bookings.filter(booking => booking.coachAcceptance !== 'ACCEPTED').every(booking => booking.coachRespondedAt === null)).toBe(true);

    const participantCount = bookings.reduce((total, booking) => total + booking.participants.length, 0);
    expect(participantCount).toBe(202);
    const nonCompletedParticipants = bookings
      .filter(booking => booking.status !== 'COMPLETED')
      .reduce((total, booking) => total + booking.participants.length, 0);
    const expectedPaidParticipants = 202 - Math.ceil(nonCompletedParticipants / 3);
    expect(bookings.flatMap(booking => booking.participants).filter(participant => participant.paid)).toHaveLength(expectedPaidParticipants);

    const payments = await database.payment.findMany({
      include: { booking: true, student: true, instructor: true },
      orderBy: { paidAt: 'asc' },
    });
    const payouts = payments.filter(payment => payment.kind === 'CLUB_TO_COACH');
    const receipts = payments.filter(payment => payment.kind !== 'CLUB_TO_COACH');
    expect(payments).toHaveLength(expectedPaidParticipants + 2);
    expect(payouts.map(payment => ({
      businessId: payment.businessId,
      coach: payment.instructor?.name,
      amount: payment.amount,
      studentId: payment.studentId,
      bookingId: payment.bookingId,
    })).sort((left, right) => String(left.coach).localeCompare(String(right.coach)))).toEqual([
      { businessId: club.id, coach: 'Eng Chin An', amount: 32000, studentId: null, bookingId: null },
      { businessId: club.id, coach: 'Loh Kean Hean', amount: 32000, studentId: null, bookingId: null },
    ]);
    expect(receipts.every(payment =>
      payment.student !== null && payment.instructorId === null && payment.booking !== null
      && payment.packageId === null && payment.reversedAt === null
      && payment.kind === (payment.booking.paymentRoute === 'CLUB' ? 'STUDENT_TO_CLUB' : 'STUDENT_TO_COACH')
      && payment.businessId === payment.booking.businessId && payment.paidAt >= payment.booking.createdAt
      && payment.paidAt <= payment.booking.startAt
    )).toBe(true);

    const counts = await snapshot(database);
    expect(counts._prisma_migrations.count).toBe(16);
    expect(await database.$queryRawUnsafe<Array<{ failed: number; rolledBack: number }>>(`
      SELECT
        COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS failed,
        COUNT(*) FILTER (WHERE rolled_back_at IS NOT NULL)::int AS "rolledBack"
      FROM "_prisma_migrations"
    `)).toEqual([{ failed: 0, rolledBack: 0 }]);
    expect(Object.fromEntries(applicationTables.map(table => [table, counts[table].count]))).toEqual({
      AccountNotification: 2,
      AuthSession: 0,
      Availability: 28,
      AvailabilityException: 0,
      Booking: 52,
      Business: 3,
      Instructor: 4,
      IntegrityFlag: 0,
      LessonPackage: 0,
      Location: 3,
      Membership: 5,
      Notification: 4,
      Participant: 202,
      Payment: expectedPaidParticipants + 2,
      RescheduleRequest: 0,
      Service: 3,
      ServiceInstructor: 4,
      ServiceLocation: 3,
      Student: 8,
      User: 11,
    });
  }, 180_000);

  it('rolls the reset back when an unexpected foreign-key table prevents non-CASCADE truncation', async () => {
    const database = db!;
    const club = await database.business.findUniqueOrThrow({ where: { slug: 'elever-badminton-academy' } });
    await database.$executeRawUnsafe(`
      CREATE TABLE "UnexpectedFixtureReference" (
        id TEXT PRIMARY KEY,
        "businessId" TEXT NOT NULL REFERENCES "Business"(id)
      )
    `);
    await database.$executeRawUnsafe(
      `INSERT INTO "UnexpectedFixtureReference" (id, "businessId") VALUES ('preserve-me', $1)`,
      club.id,
    );
    const before = await snapshot(database);

    const result = runProvisioner(url, fingerprint);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/cannot truncate a table referenced in a foreign key constraint/i);
    expect(await snapshot(database)).toEqual(before);
    expect(await database.$queryRawUnsafe(
      `SELECT id, "businessId" FROM "UnexpectedFixtureReference"`,
    )).toEqual([{ id: 'preserve-me', businessId: club.id }]);
    expect(await database.business.findUnique({ where: { id: club.id } })).toMatchObject({
      name: 'Elever Badminton Academy',
      slug: 'elever-badminton-academy',
    });
  }, 180_000);
});
