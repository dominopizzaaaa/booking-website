import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../src/config.js';

const databaseUrl = process.env.DATABASE_URL!;
const migrationNames = [
  '20260916000000_initial',
  '20260916010000_minor_units',
  '20260916020000_integer_minor_units',
  '20260916030000_private_management_tokens',
  '20260916040000_global_accounts',
  '20260916050000_membership_instructor_business_invariant',
  '20260917000000_account_notifications',
  '20260917100000_club_coach_platform',
  '20260917200000_student_coach_club',
  '20260917210000_account_shape_invariants',
  '20260917220000_payment_party_invariants',
  '20260917230000_identity_tenancy_invariants',
] as const;
const migrationFiles = migrationNames.map(name =>
  fileURLToPath(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)));
const paymentBoundaryMigration = migrationFiles[migrationNames.indexOf('20260917220000_payment_party_invariants')]!;
const identityBoundaryMigration = migrationFiles[migrationNames.indexOf('20260917230000_identity_tenancy_invariants')]!;
const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

function isolatedUrl(schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function runSqlFile(url: string, file: string) {
  return spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, '--file', file], {
    encoding: 'utf8', env: process.env,
  });
}

function applyMigration(url: string, file: string) {
  const result = runSqlFile(url, file);
  if (result.status !== 0) {
    throw new Error(`Failed to apply ${file}:\n${result.stdout}\n${result.stderr}`);
  }
}

function executeSql(url: string, sql: string) {
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, '--stdin'], {
    encoding: 'utf8', env: process.env, input: sql,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to execute fixture SQL:\n${result.stdout}\n${result.stderr}`);
  }
}

const twoClubFixture = `
  BEGIN;
  INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
    ('club-a', 'Club A', 'identity-tenant-club-a', 'Club A', 'club-a@example.test', 'CLUB'),
    ('club-b', 'Club B', 'identity-tenant-club-b', 'Club B', 'club-b@example.test', 'CLUB');
  INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
    ('club-a-account', 'Club A', 'club-a-account@example.test', 'hash', 'CLUB'),
    ('club-b-account', 'Club B', 'club-b-account@example.test', 'hash', 'CLUB'),
    ('coach-a-account', 'Coach A', 'coach-a@example.test', 'hash', 'COACH'),
    ('coach-b-account', 'Coach B', 'coach-b@example.test', 'hash', 'COACH'),
    ('student-a-account', 'Student A', 'student-a@example.test', 'hash', 'STUDENT');
  INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES
    ('coach-a', 'club-a', 'Coach A', 'CA'),
    ('coach-b', 'club-b', 'Coach B', 'CB');
  INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId") VALUES
    ('club-a-membership', 'club-a-account', 'club-a', NULL),
    ('club-b-membership', 'club-b-account', 'club-b', NULL),
    ('coach-a-membership', 'coach-a-account', 'club-a', 'coach-a'),
    ('coach-b-membership', 'coach-b-account', 'club-b', 'coach-b');
  INSERT INTO "Student" ("id", "businessId", "userId", "name", "email", "initials")
    VALUES ('student-a', 'club-a', 'student-a-account', 'Student A', 'student-a@example.test', 'SA');
  COMMIT;
`;

describe.sequential('database identity and payment tenant invariants', () => {
  let admin: PrismaClient;
  const schemas = new Set<string>();

  async function createSchema() {
    const schema = `identity_tenant_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemas.add(schema);
    return schema;
  }

  async function dropSchema(schema: string) {
    if (!/^identity_tenant_[a-f0-9_]+$/.test(schema)) {
      throw new Error(`Refusing to drop unexpected schema ${schema}`);
    }
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    schemas.delete(schema);
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Migration integration tests require a local PostgreSQL DATABASE_URL');
    }
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    await admin.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    if (!admin) return;
    for (const schema of schemas) await dropSchema(schema);
    await admin.$disconnect();
  });

  it('applies on a fresh database and enforces deferred student identity plus payment tenancy', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);
      executeSql(url, twoClubFixture);

      // The constraint is deferred: an atomic flow may temporarily link a
      // non-student account as long as the committed identity is STUDENT.
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES ('atomic-account', 'Atomic Student', 'atomic-student@example.test', 'hash', 'COACH')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Student" ("id", "businessId", "userId", "name", "email", "initials") VALUES ('atomic-student', 'club-a', 'atomic-account', 'Atomic Student', 'atomic-student@example.test', 'AS')`);
        await tx.$executeRawUnsafe(`UPDATE "User" SET "accountType" = 'STUDENT' WHERE "id" = 'atomic-account'`);
      });
      expect(await db.$queryRawUnsafe(`SELECT "userId" FROM "Student" WHERE "id" = 'atomic-student'`))
        .toEqual([{ userId: 'atomic-account' }]);

      await expect(db.$executeRawUnsafe(`INSERT INTO "Student" ("id", "businessId", "userId", "name", "email", "initials") VALUES ('bad-student', 'club-a', 'coach-a-account', 'Bad Link', 'bad-link@example.test', 'BL')`))
        .rejects.toThrow('Student.userId must reference a STUDENT account');
      await expect(db.$executeRawUnsafe(`UPDATE "User" SET "accountType" = 'COACH' WHERE "id" = 'student-a-account'`))
        .rejects.toThrow('Student.userId must reference a STUDENT account');

      executeSql(url, `
        BEGIN;
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('solo', 'Solo', 'identity-tenant-solo', 'Solo Coach', 'solo@example.test', 'SOLO');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('solo-coach-account', 'Solo Coach', 'solo-coach@example.test', 'hash', 'COACH'),
          ('student-b-account', 'Student B', 'student-b@example.test', 'hash', 'STUDENT'),
          ('solo-student-account', 'Solo Student', 'solo-student@example.test', 'hash', 'STUDENT');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials")
          VALUES ('solo-coach', 'solo', 'Solo Coach', 'SC');
        INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId")
          VALUES ('solo-membership', 'solo-coach-account', 'solo', 'solo-coach');
        INSERT INTO "Student" ("id", "businessId", "userId", "name", "email", "initials") VALUES
          ('student-b', 'club-b', 'student-b-account', 'Student B', 'student-b@example.test', 'SB'),
          ('solo-student', 'solo', 'solo-student-account', 'Solo Student', 'solo-student@example.test', 'SS');
        INSERT INTO "Location" ("id", "businessId", "name") VALUES
          ('club-a-court', 'club-a', 'Club A Court'),
          ('solo-court', 'solo', 'Solo Court');
        INSERT INTO "Service" ("id", "businessId", "name") VALUES
          ('club-a-service', 'club-a', 'Club A Lesson'),
          ('solo-service', 'solo', 'Solo Lesson');
        INSERT INTO "Booking" ("id", "businessId", "serviceId", "instructorId", "locationId", "startAt", "endAt", "duration", "type", "capacity", "price", "paymentRoute") VALUES
          ('club-route-booking', 'club-a', 'club-a-service', 'coach-a', 'club-a-court', CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '1 day 1 hour', 60, 'PRIVATE', 1, 1000, 'CLUB'),
          ('direct-route-booking', 'club-a', 'club-a-service', 'coach-a', 'club-a-court', CURRENT_TIMESTAMP + INTERVAL '2 days', CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour', 60, 'PRIVATE', 1, 1000, 'DIRECT'),
          ('solo-route-booking', 'solo', 'solo-service', 'solo-coach', 'solo-court', CURRENT_TIMESTAMP + INTERVAL '3 days', CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour', 60, 'PRIVATE', 1, 1000, 'DIRECT');
        INSERT INTO "LessonPackage" ("id", "businessId", "studentId", "name", "totalCredits", "price", "expiresAt") VALUES
          ('club-package', 'club-a', 'student-a', 'Club Package', 5, 5000, CURRENT_TIMESTAMP + INTERVAL '30 days'),
          ('solo-package', 'solo', 'solo-student', 'Solo Package', 5, 5000, CURRENT_TIMESTAMP + INTERVAL '30 days');
        COMMIT;
      `);

      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "packageId", "amount", "kind") VALUES ('valid-receipt', 'club-a', 'student-a', 'club-package', 1000, 'STUDENT_TO_CLUB')`);
      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "amount", "kind") VALUES ('valid-payout', 'club-a', NULL, 'coach-a', 500, 'CLUB_TO_COACH')`);
      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "bookingId", "amount", "kind") VALUES ('valid-booking-payout', 'club-a', NULL, 'coach-a', 'club-route-booking', 500, 'CLUB_TO_COACH')`);
      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "bookingId", "amount", "kind") VALUES ('valid-direct-contract', 'club-a', 'student-a', 'direct-route-booking', 1000, 'STUDENT_TO_COACH')`);
      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "packageId", "amount", "kind") VALUES ('valid-solo-receipt', 'solo', 'solo-student', 'solo-package', 1000, 'STUDENT_TO_COACH')`);
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "amount", "kind") VALUES ('cross-tenant-receipt', 'club-b', 'student-a', 1000, 'STUDENT_TO_CLUB')`))
        .rejects.toThrow();
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "amount", "kind") VALUES ('cross-tenant-payout', 'club-b', NULL, 'coach-a', 500, 'CLUB_TO_COACH')`))
        .rejects.toThrow();
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "amount", "kind") VALUES ('wrong-club-kind', 'club-a', 'student-a', 1000, 'STUDENT_TO_COACH')`))
        .rejects.toThrow('Unbound student payment kind must match Business.kind');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "amount", "kind") VALUES ('wrong-solo-kind', 'solo', 'solo-student', 1000, 'STUDENT_TO_CLUB')`))
        .rejects.toThrow('Unbound student payment kind must match Business.kind');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "amount", "kind") VALUES ('wrong-solo-payout', 'solo', NULL, 'solo-coach', 500, 'CLUB_TO_COACH')`))
        .rejects.toThrow('CLUB_TO_COACH payments require a CLUB business');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "bookingId", "amount", "kind") VALUES ('wrong-payout-route', 'club-a', NULL, 'coach-a', 'direct-route-booking', 500, 'CLUB_TO_COACH')`))
        .rejects.toThrow('CLUB_TO_COACH payment booking must use CLUB paymentRoute');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "bookingId", "amount", "kind") VALUES ('wrong-booking-route', 'club-a', 'student-a', 'club-route-booking', 1000, 'STUDENT_TO_COACH')`))
        .rejects.toThrow('Student payment kind must match Booking.paymentRoute');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "bookingId", "amount", "kind") VALUES ('wrong-booking-tenant', 'club-b', 'student-b', 'club-route-booking', 1000, 'STUDENT_TO_CLUB')`))
        .rejects.toThrow('Payment booking must belong to the payment business');
      await expect(db.$executeRawUnsafe(`INSERT INTO "LessonPackage" ("id", "businessId", "studentId", "name", "totalCredits", "price", "expiresAt") VALUES ('wrong-student-package', 'club-b', 'student-a', 'Wrong Student', 1, 1000, CURRENT_TIMESTAMP + INTERVAL '30 days')`))
        .rejects.toThrow();
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "packageId", "amount", "kind") VALUES ('wrong-package-tenant', 'club-b', 'student-b', 'club-package', 1000, 'STUDENT_TO_CLUB')`))
        .rejects.toThrow();
      await expect(db.$executeRawUnsafe(`UPDATE "Payment" SET "kind" = 'STUDENT_TO_COACH' WHERE "id" = 'valid-receipt'`))
        .rejects.toThrow('Unbound student payment kind must match Business.kind');
      await expect(db.$executeRawUnsafe(`UPDATE "Booking" SET "paymentRoute" = 'CLUB' WHERE "id" = 'direct-route-booking'`))
        .rejects.toThrow('Booking.paymentRoute is immutable after creation');
      await expect(db.$executeRawUnsafe(`DELETE FROM "Booking" WHERE "id" = 'direct-route-booking'`))
        .rejects.toThrow();

      expect(await db.$queryRawUnsafe(`SELECT "id" FROM "Payment" ORDER BY "id"`)).toEqual([
        { id: 'valid-booking-payout' },
        { id: 'valid-direct-contract' },
        { id: 'valid-payout' },
        { id: 'valid-receipt' },
        { id: 'valid-solo-receipt' },
      ]);

      // The RESTRICT relations preserve individual ledger evidence, while the
      // application's explicit deep-delete order remains valid.
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "businessId" = 'solo'`);
        await tx.$executeRawUnsafe(`DELETE FROM "Booking" WHERE "businessId" = 'solo'`);
        await tx.$executeRawUnsafe(`DELETE FROM "LessonPackage" WHERE "businessId" = 'solo'`);
        await tx.$executeRawUnsafe(`DELETE FROM "Student" WHERE "businessId" = 'solo'`);
        await tx.$executeRawUnsafe(`DELETE FROM "Business" WHERE "id" = 'solo'`);
      });
      expect(await db.$queryRawUnsafe(`SELECT id FROM "Business" WHERE id = 'solo'`)).toEqual([]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it('rejects an incompatible linked account before changing the database', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `
        BEGIN;
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('club', 'Club', 'invalid-student-link-club', 'Club', 'club@example.test', 'CLUB');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('club-account', 'Club', 'club-account@example.test', 'hash', 'CLUB'),
          ('coach-account', 'Coach', 'coach@example.test', 'hash', 'COACH');
        INSERT INTO "Membership" ("id", "userId", "businessId")
          VALUES ('club-membership', 'club-account', 'club');
        INSERT INTO "Student" ("id", "businessId", "userId", "name", "email", "initials")
          VALUES ('mislinked-student', 'club', 'coach-account', 'Coach', 'coach@example.test', 'CO');
        COMMIT;
      `);

      const result = runSqlFile(url, identityBoundaryMigration);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('Student.userId points to a non-STUDENT account');
      expect(await db.$queryRawUnsafe(`SELECT "userId" FROM "Student" WHERE "id" = 'mislinked-student'`))
        .toEqual([{ userId: 'coach-account' }]);
      expect(await db.$queryRawUnsafe(`SELECT to_regclass(current_schema() || '."Student_id_businessId_key"')::text AS index`))
        .toEqual([{ index: null }]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it.each([
    {
      party: 'student',
      expected: 'a payment names a student from another business',
      payment: `INSERT INTO "Payment" ("id", "businessId", "studentId", "amount", "kind") VALUES ('bad-payment', 'club-b', 'student-a', 1000, 'STUDENT_TO_CLUB')`,
    },
    {
      party: 'instructor',
      expected: 'a payment names an instructor from another business',
      payment: `INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "amount", "kind") VALUES ('bad-payment', 'club-b', NULL, 'coach-a', 500, 'CLUB_TO_COACH')`,
    },
  ])('rejects a historical cross-tenant $party payment before changing the database', async ({ expected, payment }) => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `${twoClubFixture} ${payment};`);

      const result = runSqlFile(url, identityBoundaryMigration);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
      expect(await db.$queryRawUnsafe(`SELECT "businessId", "studentId", "instructorId" FROM "Payment" WHERE "id" = 'bad-payment'`))
        .toHaveLength(1);
      expect(await db.$queryRawUnsafe(`SELECT to_regclass(current_schema() || '."Student_id_businessId_key"')::text AS index`))
        .toEqual([{ index: null }]);
      expect(await db.$queryRawUnsafe<Array<{ present: bigint }>>(`
        SELECT count(*) AS present
        FROM pg_constraint AS constraint_record
        JOIN pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = current_schema()
          AND constraint_record.conname = 'Payment_studentId_fkey'
      `))
        .toEqual([{ present: 1n }]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it.each([
    {
      relation: 'package student',
      expected: 'a package names a student from another business',
      fixture: `
        INSERT INTO "LessonPackage" ("id", "businessId", "studentId", "name", "totalCredits", "price", "expiresAt")
          VALUES ('bad-package', 'club-b', 'student-a', 'Bad Package', 1, 1000, CURRENT_TIMESTAMP + INTERVAL '30 days');
      `,
    },
    {
      relation: 'payment package',
      expected: 'a payment names a package from another business',
      fixture: `
        INSERT INTO "LessonPackage" ("id", "businessId", "studentId", "name", "totalCredits", "price", "expiresAt")
          VALUES ('club-a-package', 'club-a', 'student-a', 'Club A Package', 1, 1000, CURRENT_TIMESTAMP + INTERVAL '30 days');
        INSERT INTO "Student" ("id", "businessId", "name", "email", "initials")
          VALUES ('student-b', 'club-b', 'Student B', 'package-student-b@example.test', 'SB');
        INSERT INTO "Payment" ("id", "businessId", "studentId", "packageId", "amount", "kind")
          VALUES ('bad-payment', 'club-b', 'student-b', 'club-a-package', 1000, 'STUDENT_TO_CLUB');
      `,
    },
  ])('rejects a historical cross-tenant $relation before adding composite keys', async ({ expected, fixture }) => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `${twoClubFixture} ${fixture}`);

      const result = runSqlFile(url, identityBoundaryMigration);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
      expect(await db.$queryRawUnsafe(`SELECT to_regclass(current_schema() || '."LessonPackage_id_businessId_key"')::text AS index`))
        .toEqual([{ index: null }]);
      expect(await db.$queryRawUnsafe<Array<{ present: bigint }>>(`
        SELECT count(*) AS present
        FROM pg_constraint AS constraint_record
        JOIN pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = current_schema()
          AND constraint_record.conname = 'LessonPackage_studentId_fkey'
      `)).toEqual([{ present: 1n }]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it('repairs historical student payment kinds from the booking contract or business kind', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      const paymentBoundaryIndex = migrationFiles.indexOf(paymentBoundaryMigration);
      for (const file of migrationFiles.slice(0, paymentBoundaryIndex)) applyMigration(url, file);
      executeSql(url, `
        BEGIN;
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('club', 'Club', 'route-repair-club', 'Club', 'club@example.test', 'CLUB'),
          ('solo', 'Solo', 'route-repair-solo', 'Solo', 'solo@example.test', 'SOLO');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('club-account', 'Club', 'route-club@example.test', 'hash', 'CLUB'),
          ('solo-account', 'Solo', 'route-solo@example.test', 'hash', 'COACH');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES
          ('club-coach', 'club', 'Club Coach', 'CC'),
          ('solo-coach', 'solo', 'Solo Coach', 'SC');
        INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId") VALUES
          ('club-membership', 'club-account', 'club', NULL),
          ('solo-membership', 'solo-account', 'solo', 'solo-coach');
        INSERT INTO "Student" ("id", "businessId", "name", "email", "initials") VALUES
          ('club-student', 'club', 'Club Student', 'club-student@example.test', 'CS'),
          ('solo-student', 'solo', 'Solo Student', 'solo-student@example.test', 'SS');
        INSERT INTO "Location" ("id", "businessId", "name") VALUES
          ('club-court', 'club', 'Club Court'), ('solo-court', 'solo', 'Solo Court');
        INSERT INTO "Service" ("id", "businessId", "name") VALUES
          ('club-service', 'club', 'Club Lesson'), ('solo-service', 'solo', 'Solo Lesson');
        INSERT INTO "Booking" ("id", "businessId", "serviceId", "instructorId", "locationId", "startAt", "endAt", "duration", "type", "capacity", "price", "paymentRoute") VALUES
          ('legacy-direct-contract', 'club', 'club-service', 'club-coach', 'club-court', CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '1 day 1 hour', 60, 'PRIVATE', 1, 1000, 'DIRECT'),
          ('solo-booking', 'solo', 'solo-service', 'solo-coach', 'solo-court', CURRENT_TIMESTAMP + INTERVAL '2 days', CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour', 60, 'PRIVATE', 1, 1000, 'DIRECT');
        INSERT INTO "Payment" ("id", "businessId", "studentId", "bookingId", "amount", "kind", "reversedAt") VALUES
          ('contractual', 'club', 'club-student', 'legacy-direct-contract', 1000, 'STUDENT_TO_CLUB', NULL),
          ('unbound-club', 'club', 'club-student', NULL, 1000, 'STUDENT_TO_COACH', CURRENT_TIMESTAMP),
          ('unbound-solo', 'solo', 'solo-student', NULL, 1000, 'STUDENT_TO_CLUB', NULL);
        COMMIT;
      `);

      applyMigration(url, paymentBoundaryMigration);

      expect(await db.$queryRawUnsafe(`SELECT id, kind, "reversedAt" IS NOT NULL AS reversed FROM "Payment" ORDER BY id`)).toEqual([
        { id: 'contractual', kind: 'STUDENT_TO_COACH', reversed: false },
        { id: 'unbound-club', kind: 'STUDENT_TO_CLUB', reversed: true },
        { id: 'unbound-solo', kind: 'STUDENT_TO_COACH', reversed: false },
      ]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it('rejects a historical SOLO payout before changing payment data or schema', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      const paymentBoundaryIndex = migrationFiles.indexOf(paymentBoundaryMigration);
      for (const file of migrationFiles.slice(0, paymentBoundaryIndex)) applyMigration(url, file);
      executeSql(url, `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('solo', 'Solo', 'invalid-route-solo', 'Solo', 'solo@example.test', 'SOLO');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials")
          VALUES ('solo-coach', 'solo', 'Solo Coach', 'SC');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType")
          VALUES ('solo-account', 'Solo Coach', 'solo-account@example.test', 'hash', 'COACH');
        INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId")
          VALUES ('solo-membership', 'solo-account', 'solo', 'solo-coach');
        INSERT INTO "Student" ("id", "businessId", "name", "email", "initials")
          VALUES ('solo-student', 'solo', 'Solo Student', 'solo-student@example.test', 'SS');
        INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "amount", "kind")
          VALUES ('bad-payout', 'solo', 'solo-student', 'solo-coach', 500, 'CLUB_TO_COACH');
      `);

      const result = runSqlFile(url, paymentBoundaryMigration);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('a SOLO business has a CLUB_TO_COACH payout');
      expect(await db.$queryRawUnsafe(`SELECT "studentId", "instructorId", kind FROM "Payment" WHERE id = 'bad-payout'`))
        .toEqual([{ studentId: 'solo-student', instructorId: 'solo-coach', kind: 'CLUB_TO_COACH' }]);
      expect(await db.$queryRawUnsafe(`SELECT to_regprocedure(current_schema() || '._courtly_payment_route_constraint()')::text AS function`))
        .toEqual([{ function: null }]);
      expect(await db.$queryRawUnsafe(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Payment' AND column_name = 'studentId'`))
        .toEqual([{ is_nullable: 'NO' }]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it('rejects a historical club payout tied to a DIRECT booking before changing payment data or schema', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      const paymentBoundaryIndex = migrationFiles.indexOf(paymentBoundaryMigration);
      for (const file of migrationFiles.slice(0, paymentBoundaryIndex)) applyMigration(url, file);
      executeSql(url, `
        BEGIN;
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('club', 'Club', 'invalid-payout-contract-club', 'Club', 'club@example.test', 'CLUB');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('club-account', 'Club', 'club-account@example.test', 'hash', 'CLUB'),
          ('coach-account', 'Coach', 'coach-account@example.test', 'hash', 'COACH');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials")
          VALUES ('club-coach', 'club', 'Club Coach', 'CC');
        INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId") VALUES
          ('club-membership', 'club-account', 'club', NULL),
          ('coach-membership', 'coach-account', 'club', 'club-coach');
        INSERT INTO "Student" ("id", "businessId", "name", "email", "initials")
          VALUES ('club-student', 'club', 'Club Student', 'club-student@example.test', 'CS');
        INSERT INTO "Location" ("id", "businessId", "name")
          VALUES ('club-court', 'club', 'Club Court');
        INSERT INTO "Service" ("id", "businessId", "name")
          VALUES ('club-service', 'club', 'Club Lesson');
        INSERT INTO "Booking" ("id", "businessId", "serviceId", "instructorId", "locationId", "startAt", "endAt", "duration", "type", "capacity", "price", "paymentRoute")
          VALUES ('direct-booking', 'club', 'club-service', 'club-coach', 'club-court', CURRENT_TIMESTAMP + INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '1 day 1 hour', 60, 'PRIVATE', 1, 1000, 'DIRECT');
        INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "bookingId", "amount", "kind")
          VALUES ('bad-payout', 'club', 'club-student', 'club-coach', 'direct-booking', 500, 'CLUB_TO_COACH');
        COMMIT;
      `);

      const result = runSqlFile(url, paymentBoundaryMigration);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('a CLUB_TO_COACH payout names a DIRECT booking');
      expect(await db.$queryRawUnsafe(`SELECT "studentId", "instructorId", "bookingId", kind FROM "Payment" WHERE id = 'bad-payout'`))
        .toEqual([{ studentId: 'club-student', instructorId: 'club-coach', bookingId: 'direct-booking', kind: 'CLUB_TO_COACH' }]);
      expect(await db.$queryRawUnsafe(`SELECT to_regprocedure(current_schema() || '._courtly_payment_route_constraint()')::text AS function`))
        .toEqual([{ function: null }]);
      expect(await db.$queryRawUnsafe(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Payment' AND column_name = 'studentId'`))
        .toEqual([{ is_nullable: 'NO' }]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);
});
