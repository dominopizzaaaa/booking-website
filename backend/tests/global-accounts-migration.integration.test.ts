import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../src/config.js';

// Importing the application config applies the same backend/.env lookup and
// local-development fallback as the running API. Do not require callers to
// export DATABASE_URL separately when the app itself has already resolved it.
const databaseUrl = process.env.DATABASE_URL!;

const migrationFiles = [
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
].map(name => fileURLToPath(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)));
const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

function isolatedUrl(schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function runMigration(url: string, file: string) {
  return spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, '--file', file], {
    encoding: 'utf8', env: process.env,
  });
}

function executeSql(url: string, sql: string) {
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, '--stdin'], {
    encoding: 'utf8', env: process.env, input: sql,
  });
  if (result.status !== 0) throw new Error(`Failed to execute migration fixture SQL:\n${result.stdout}\n${result.stderr}`);
}

function applyMigration(url: string, file: string) {
  const result = runMigration(url, file);
  if (result.status !== 0) throw new Error(`Failed to apply ${file}:\n${result.stdout}\n${result.stderr}`);
}

async function createIsolatedSchema(admin: PrismaClient) {
  const schema = `migration_test_${randomUUID().replaceAll('-', '_')}`;
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  return schema;
}

async function dropIsolatedSchema(admin: PrismaClient, schema: string) {
  if (!/^migration_test_[a-f0-9_]+$/.test(schema)) throw new Error(`Refusing to drop unexpected schema ${schema}`);
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

describe.sequential('account model migrations', () => {
  let admin: PrismaClient;
  const schemas = new Set<string>();

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
    for (const schema of schemas) await dropIsolatedSchema(admin, schema);
    await admin.$disconnect();
  });

  it('preserves legacy staff sessions and booking data and creates an orphan-coach placeholder', async () => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 3)) applyMigration(url, file);
      executeSql(url, `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email") VALUES
          ('club', 'Legacy Club', 'legacy-club', 'Legacy Owner', 'owner@example.test');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials", "email") VALUES
          ('owner-roster', 'club', 'Legacy Owner', 'LO', 'owner@example.test'),
          ('coach-roster', 'club', 'Legacy Coach', 'LC', 'coach@example.test'),
          ('orphan-roster', 'club', 'Roster Only', 'RO', 'roster@example.test');
        INSERT INTO "User" ("id", "businessId", "name", "email", "passwordHash", "role", "instructorId") VALUES
          ('owner-user', 'club', 'Legacy Owner', 'Owner@Example.Test', 'owner-hash', 'OWNER', 'owner-roster'),
          ('coach-user', 'club', 'Legacy Coach', 'coach@example.test', 'coach-hash', 'COACH', 'coach-roster');
        INSERT INTO "AuthSession" ("id", "userId", "expiresAt") VALUES
          ('owner-session', 'owner-user', CURRENT_TIMESTAMP + INTERVAL '1 day'),
          ('coach-session', 'coach-user', CURRENT_TIMESTAMP + INTERVAL '1 day');
        INSERT INTO "Location" ("id", "businessId", "name") VALUES ('court', 'club', 'Legacy Court');
        INSERT INTO "Service" ("id", "businessId", "name") VALUES ('lesson', 'club', 'Legacy Lesson');
        INSERT INTO "Customer" ("id", "businessId", "name", "email", "initials")
          VALUES ('customer', 'club', 'Legacy Customer', 'Customer@Example.Test', 'LC');
        INSERT INTO "Booking" ("id", "businessId", "serviceId", "instructorId", "locationId", "startAt", "endAt", "duration", "type", "capacity", "price")
          VALUES ('booking', 'club', 'lesson', 'coach-roster', 'court', CURRENT_TIMESTAMP + INTERVAL '2 days', CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour', 60, 'PRIVATE', 1, 8000);
        INSERT INTO "Participant" ("id", "bookingId", "customerId", "price", "managementToken")
          VALUES ('participant', 'booking', 'customer', 8000, 'legacy-private-token');
      `);
      applyMigration(url, migrationFiles[3]!);
      const before = await db.$queryRawUnsafe<Array<{ hash: string; expires: Date }>>(`SELECT "managementTokenHash" AS hash, "managementTokenExpiresAt" AS expires FROM "Participant" WHERE id = 'participant'`);
      expect(before[0]?.hash).toBe(createHash('md5').update('legacy-private-tokenparticipant').digest('hex'));
      expect(before[0]?.expires).toBeInstanceOf(Date);
      const originalTokenMatch = await db.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT id FROM "Participant"
        WHERE "managementTokenHash" = md5('legacy-private-token' || id)
      `);
      expect(originalTokenMatch).toEqual([{ id: 'participant' }]);

      applyMigration(url, migrationFiles[4]!);

      const users = await db.$queryRawUnsafe<Array<{ id: string; email: string; accountType: string; passwordHash: string | null }>>(`SELECT id, email, "accountType", "passwordHash" FROM "User" ORDER BY id`);
      expect(users).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'owner-user', email: 'owner@example.test', accountType: 'OWNER', passwordHash: 'owner-hash' }),
        expect.objectContaining({ id: 'coach-user', email: 'coach@example.test', accountType: 'COACH', passwordHash: 'coach-hash' }),
        expect.objectContaining({ id: 'legacy-instructor-orphan-roster', accountType: 'COACH', passwordHash: null }),
      ]));

      const memberships = await db.$queryRawUnsafe<Array<{ id: string; userId: string; businessId: string; role: string; instructorId: string; active: boolean }>>(`SELECT id, "userId", "businessId", role, "instructorId", active FROM "Membership" ORDER BY id`);
      expect(memberships).toEqual(expect.arrayContaining([
        { id: 'owner-user', userId: 'owner-user', businessId: 'club', role: 'OWNER', instructorId: 'owner-roster', active: true },
        { id: 'coach-user', userId: 'coach-user', businessId: 'club', role: 'COACH', instructorId: 'coach-roster', active: true },
        { id: 'legacy-membership-orphan-roster', userId: 'legacy-instructor-orphan-roster', businessId: 'club', role: 'COACH', instructorId: 'orphan-roster', active: true },
      ]));

      const sessions = await db.$queryRawUnsafe<Array<{ id: string; activeMembershipId: string }>>(`SELECT id, "activeMembershipId" FROM "AuthSession" ORDER BY id`);
      expect(sessions).toEqual([
        { id: 'coach-session', activeMembershipId: 'coach-user' },
        { id: 'owner-session', activeMembershipId: 'owner-user' },
      ]);

      const preserved = await db.$queryRawUnsafe<Array<{ customerEmail: string; userId: string | null; participantId: string; tokenHash: string | null }>>(`
        SELECT customer.email AS "customerEmail", customer."userId", participant.id AS "participantId", participant."managementTokenHash" AS "tokenHash"
        FROM "Customer" AS customer JOIN "Participant" AS participant ON participant."customerId" = customer.id
        WHERE customer.id = 'customer'
      `);
      expect(preserved).toEqual([{ customerEmail: 'customer@example.test', userId: null, participantId: 'participant', tokenHash: before[0]!.hash }]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it('rejects canonical duplicate users and rolls the migration back atomically', async () => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 4)) applyMigration(url, file);
      executeSql(url, `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email") VALUES
          ('first-club', 'First Club', 'first-club', 'First Owner', 'first@example.test'),
          ('second-club', 'Second Club', 'second-club', 'Second Owner', 'second@example.test');
        INSERT INTO "User" ("id", "businessId", "name", "email", "passwordHash", "role") VALUES
          ('first-user', 'first-club', 'First', 'Duplicate@Example.Test', 'hash', 'OWNER'),
          ('second-user', 'second-club', 'Second', ' duplicate@example.test ', 'hash', 'OWNER');
      `);

      const result = runMigration(url, migrationFiles[4]!);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('duplicate canonical email addresses exist');

      const columns = await db.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'User' ORDER BY column_name`);
      expect(columns.map(column => column.column_name)).toContain('businessId');
      expect(columns.map(column => column.column_name)).not.toContain('accountType');
      const membershipTable = await db.$queryRawUnsafe<Array<{ name: string | null }>>(`SELECT to_regclass(current_schema() || '."Membership"')::text AS name`);
      expect(membershipTable[0]?.name).toBeNull();
      const emails = await db.$queryRawUnsafe<Array<{ email: string }>>(`SELECT email FROM "User" ORDER BY id`);
      expect(emails).toEqual([{ email: 'Duplicate@Example.Test' }, { email: ' duplicate@example.test ' }]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it('rejects cross-business instructor links while preserving instructor delete semantics', async () => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 6)) applyMigration(url, file);
      executeSql(url, `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email") VALUES
          ('first-club', 'First Club', 'first-club', 'First Owner', 'first@example.test'),
          ('second-club', 'Second Club', 'second-club', 'Second Owner', 'second@example.test');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials")
          VALUES ('first-coach', 'first-club', 'First Coach', 'FC');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType")
          VALUES ('provider', 'Provider', 'provider@example.test', 'hash', 'COACH');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role")
          VALUES ('membership', 'provider', 'second-club', 'COACH');
      `);

      await expect(db.$executeRawUnsafe(`UPDATE "Membership" SET "instructorId" = 'first-coach' WHERE id = 'membership'`))
        .rejects.toMatchObject({ code: 'P2010' });
      expect(await db.$queryRawUnsafe(`SELECT "instructorId" FROM "Membership" WHERE id = 'membership'`))
        .toEqual([{ instructorId: null }]);

      await db.$executeRawUnsafe(`UPDATE "Membership" SET "businessId" = 'first-club', "instructorId" = 'first-coach' WHERE id = 'membership'`);
      await db.$executeRawUnsafe(`DELETE FROM "Instructor" WHERE id = 'first-coach'`);
      expect(await db.$queryRawUnsafe(`SELECT "businessId", "instructorId" FROM "Membership" WHERE id = 'membership'`))
        .toEqual([{ businessId: 'first-club', instructorId: null }]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it('migrates the full chain to STUDENT, COACH, and single-club CLUB accounts', async () => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 8)) applyMigration(url, file);
      executeSql(url, `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('club', 'Legacy Club', 'legacy-club-final', 'Club Founder', 'club@example.test', 'CLUB'),
          ('solo', 'Solo Practice', 'solo-practice-final', 'Solo Coach', 'solo@example.test', 'SOLO'),
          ('other-club', 'Other Club', 'other-club-final', 'Other Owner', 'other@example.test', 'CLUB');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials", "email") VALUES
          ('club-founder-roster', 'club', 'Club Founder', 'CF', 'club@example.test'),
          ('solo-roster', 'solo', 'Solo Coach', 'SC', 'solo@example.test'),
          ('other-roster', 'other-club', 'Other Coach', 'OC', 'other-coach@example.test');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('club-account', 'Club Founder', 'club-account@example.test', 'hash', 'OWNER'),
          ('solo-account', 'Solo Coach', 'solo-account@example.test', 'hash', 'OWNER'),
          ('student-account', 'Student Account', 'student-account@example.test', 'hash', 'CUSTOMER'),
          ('other-club-account', 'Other Owner', 'other-owner@example.test', 'hash', 'OWNER');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role", "instructorId", "active") VALUES
          ('club-management', 'club-account', 'club', 'OWNER', 'club-founder-roster', false),
          ('club-extra-coach', 'club-account', 'other-club', 'COACH', 'other-roster', true),
          ('other-management', 'other-club-account', 'other-club', 'OWNER', NULL, true),
          ('solo-management', 'solo-account', 'solo', 'OWNER', 'solo-roster', true);
        INSERT INTO "AuthSession" ("id", "userId", "activeMembershipId", "expiresAt") VALUES
          ('club-session-on-extra', 'club-account', 'club-extra-coach', CURRENT_TIMESTAMP + INTERVAL '1 day'),
          ('club-session-empty', 'club-account', NULL, CURRENT_TIMESTAMP + INTERVAL '1 day'),
          ('solo-session', 'solo-account', 'solo-management', CURRENT_TIMESTAMP + INTERVAL '1 day');
        INSERT INTO "Customer" ("id", "businessId", "userId", "name", "email", "initials") VALUES
          ('customer', 'club', 'student-account', 'Legacy Customer', 'legacy-customer@example.test', 'LC'),
          ('solo-customer', 'solo', 'student-account', 'Legacy Customer', 'legacy-customer@example.test', 'LC');
        INSERT INTO "Location" ("id", "businessId", "name") VALUES
          ('court', 'club', 'Legacy Court'),
          ('solo-court', 'solo', 'Solo Court');
        INSERT INTO "Service" ("id", "businessId", "name") VALUES
          ('lesson', 'club', 'Legacy Lesson'),
          ('solo-lesson', 'solo', 'Solo Lesson');
        INSERT INTO "Booking" ("id", "businessId", "serviceId", "instructorId", "locationId", "startAt", "endAt", "duration", "type", "capacity", "price", "createdByRole", "paymentRoute") VALUES
          ('booking', 'club', 'lesson', 'club-founder-roster', 'court', CURRENT_TIMESTAMP + INTERVAL '2 days', CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour', 60, 'PRIVATE', 1, 8000, 'CUSTOMER', 'CLUB'),
          ('solo-booking', 'solo', 'solo-lesson', 'solo-roster', 'solo-court', CURRENT_TIMESTAMP + INTERVAL '4 days', CURRENT_TIMESTAMP + INTERVAL '4 days 1 hour', 60, 'PRIVATE', 1, 7000, 'CUSTOMER', 'DIRECT');
        INSERT INTO "Participant" ("id", "bookingId", "customerId", "price") VALUES
          ('participant', 'booking', 'customer', 8000);
        INSERT INTO "Payment" ("id", "businessId", "customerId", "bookingId", "instructorId", "amount", "kind") VALUES
          ('club-payment', 'club', 'customer', 'booking', NULL, 4000, 'CUSTOMER_TO_CLUB'),
          ('coach-payment', 'club', 'customer', 'booking', NULL, 4000, 'CUSTOMER_TO_COACH'),
          ('unbound-club-payment', 'club', 'customer', NULL, NULL, 1000, 'CUSTOMER_TO_COACH'),
          ('club-payout', 'club', 'customer', NULL, 'club-founder-roster', 500, 'CLUB_TO_COACH'),
          ('direct-payment', 'solo', 'solo-customer', 'solo-booking', NULL, 7000, 'CUSTOMER_TO_CLUB'),
          ('unbound-direct-payment', 'solo', 'solo-customer', NULL, NULL, 1000, 'CUSTOMER_TO_CLUB');
        INSERT INTO "RescheduleRequest" ("id", "businessId", "bookingId", "requestedByRole", "participantId", "proposedStartAt", "proposedEndAt", "originalStartAt") VALUES
          ('request', 'club', 'booking', 'CUSTOMER', 'participant', CURRENT_TIMESTAMP + INTERVAL '3 days', CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour', CURRENT_TIMESTAMP + INTERVAL '2 days');
        INSERT INTO "IntegrityFlag" ("id", "businessId", "instructorId", "coachUserId", "customerUserId", "coachName", "customerName", "bookingId") VALUES
          ('flag', 'club', 'club-founder-roster', 'solo-account', 'student-account', 'Solo Coach', 'Legacy Customer', 'booking');
      `);

      applyMigration(url, migrationFiles[8]!);
      applyMigration(url, migrationFiles[9]!);
      applyMigration(url, migrationFiles[10]!);

      expect(await db.$queryRawUnsafe(`SELECT id, name, "accountType" FROM "User" WHERE id IN ('club-account', 'solo-account', 'student-account') ORDER BY id`)).toEqual([
        { id: 'club-account', name: 'Legacy Club', accountType: 'CLUB' },
        { id: 'solo-account', name: 'Solo Coach', accountType: 'COACH' },
        { id: 'student-account', name: 'Student Account', accountType: 'STUDENT' },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, "userId", "businessId", "instructorId", active FROM "Membership" WHERE "userId" IN ('club-account', 'solo-account') ORDER BY id`)).toEqual([
        { id: 'club-management', userId: 'club-account', businessId: 'club', instructorId: null, active: true },
        { id: 'solo-management', userId: 'solo-account', businessId: 'solo', instructorId: 'solo-roster', active: true },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, name, email, "passwordHash", "accountType" FROM "User" WHERE id LIKE 'legacy-instructor-%' ORDER BY id`)).toEqual([
        {
          id: 'legacy-instructor-club-founder-roster',
          name: 'Club Founder',
          email: `legacy-instructor-${createHash('md5').update('club-founder-roster').digest('hex')}@unclaimed.courtly.invalid`,
          passwordHash: null,
          accountType: 'COACH',
        },
        {
          id: 'legacy-instructor-other-roster',
          name: 'Other Coach',
          email: `legacy-instructor-${createHash('md5').update('other-roster').digest('hex')}@unclaimed.courtly.invalid`,
          passwordHash: null,
          accountType: 'COACH',
        },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, "userId", "businessId", "instructorId", active FROM "Membership" WHERE id LIKE 'legacy-membership-%' ORDER BY id`)).toEqual([
        { id: 'legacy-membership-club-founder-roster', userId: 'legacy-instructor-club-founder-roster', businessId: 'club', instructorId: 'club-founder-roster', active: false },
        { id: 'legacy-membership-other-roster', userId: 'legacy-instructor-other-roster', businessId: 'other-club', instructorId: 'other-roster', active: true },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, "activeMembershipId" FROM "AuthSession" ORDER BY id`)).toEqual([
        { id: 'club-session-empty', activeMembershipId: 'club-management' },
        { id: 'club-session-on-extra', activeMembershipId: 'club-management' },
        { id: 'solo-session', activeMembershipId: 'solo-management' },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, active FROM "Instructor" WHERE id IN ('club-founder-roster', 'other-roster', 'solo-roster') ORDER BY id`)).toEqual([
        { id: 'club-founder-roster', active: true },
        { id: 'other-roster', active: true },
        { id: 'solo-roster', active: true },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT "createdByRole" FROM "Booking" WHERE id = 'booking'`)).toEqual([{ createdByRole: 'STUDENT' }]);
      expect(await db.$queryRawUnsafe(`SELECT "requestedByRole" FROM "RescheduleRequest" WHERE id = 'request'`)).toEqual([{ requestedByRole: 'STUDENT' }]);
      expect(await db.$queryRawUnsafe(`SELECT id, kind, "studentId", "instructorId" FROM "Payment" ORDER BY id`)).toEqual([
        { id: 'club-payment', kind: 'STUDENT_TO_CLUB', studentId: 'customer', instructorId: null },
        { id: 'club-payout', kind: 'CLUB_TO_COACH', studentId: null, instructorId: 'club-founder-roster' },
        { id: 'coach-payment', kind: 'STUDENT_TO_CLUB', studentId: 'customer', instructorId: null },
        { id: 'direct-payment', kind: 'STUDENT_TO_COACH', studentId: 'solo-customer', instructorId: null },
        { id: 'unbound-club-payment', kind: 'STUDENT_TO_CLUB', studentId: 'customer', instructorId: null },
        { id: 'unbound-direct-payment', kind: 'STUDENT_TO_COACH', studentId: 'solo-customer', instructorId: null },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT "studentUserId", "studentName", "instructorId" FROM "IntegrityFlag" WHERE id = 'flag'`)).toEqual([
        { studentUserId: 'student-account', studentName: 'Legacy Customer', instructorId: 'club-founder-roster' },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT student.id, participant."studentId", payment."studentId" FROM "Student" AS student JOIN "Participant" AS participant ON participant."studentId" = student.id JOIN "Payment" AS payment ON payment."studentId" = student.id WHERE student.id = 'customer' ORDER BY payment.id`)).toEqual([
        { id: 'customer', studentId: 'customer' },
        { id: 'customer', studentId: 'customer' },
        { id: 'customer', studentId: 'customer' },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, "studentId" FROM "Payment" WHERE "businessId" = 'solo' ORDER BY id`)).toEqual([
        { id: 'direct-payment', studentId: 'solo-customer' },
        { id: 'unbound-direct-payment', studentId: 'solo-customer' },
      ]);

      const legacyNames = await db.$queryRawUnsafe<Array<{ name: string | null }>>(`
        SELECT to_regclass(current_schema() || '."Customer"')::text AS name
        UNION ALL
        SELECT to_regclass(current_schema() || '."Student"')::text AS name
      `);
      expect(legacyNames).toEqual([{ name: null }, { name: '"Student"' }]);
      const membershipColumns = await db.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Membership' ORDER BY column_name`);
      expect(membershipColumns.map(column => column.column_name)).not.toContain('role');
      const renamedColumns = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name, column_name) IN (
            ('Participant', 'studentId'), ('Participant', 'customerId'),
            ('LessonPackage', 'studentId'), ('LessonPackage', 'customerId'),
            ('Payment', 'studentId'), ('Payment', 'customerId'),
            ('IntegrityFlag', 'studentUserId'), ('IntegrityFlag', 'customerUserId'),
            ('IntegrityFlag', 'studentName'), ('IntegrityFlag', 'customerName')
          )
        ORDER BY table_name, column_name
      `);
      expect(renamedColumns).toEqual([
        { table_name: 'IntegrityFlag', column_name: 'studentName' },
        { table_name: 'IntegrityFlag', column_name: 'studentUserId' },
        { table_name: 'LessonPackage', column_name: 'studentId' },
        { table_name: 'Participant', column_name: 'studentId' },
        { table_name: 'Payment', column_name: 'studentId' },
      ]);
      const indexes = await db.$queryRawUnsafe<Array<{ indexname: string }>>(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() ORDER BY indexname`);
      expect(indexes.map(index => index.indexname)).toEqual(expect.arrayContaining([
        'Student_businessId_email_key',
        'Student_businessId_userId_key',
        'Student_userId_idx',
        'Participant_bookingId_studentId_key',
        'IntegrityFlag_businessId_coachUserId_studentUserId_type_key',
      ]));
      for (const legacyIndex of [
        'Customer_businessId_email_key',
        'Participant_bookingId_customerId_key',
        'IntegrityFlag_businessId_coachUserId_customerUserId_type_key',
      ]) expect(indexes.map(index => index.indexname)).not.toContain(legacyIndex);
      const defaults = await db.$queryRawUnsafe<Array<{ table_name: string; column_name: string; column_default: string | null }>>(`
        SELECT table_name, column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name, column_name) IN (('User', 'accountType'), ('Booking', 'createdByRole'), ('Payment', 'kind'))
        ORDER BY table_name
      `);
      expect(defaults).toEqual([
        { table_name: 'Booking', column_name: 'createdByRole', column_default: "'STUDENT'::text" },
        { table_name: 'Payment', column_name: 'kind', column_default: "'STUDENT_TO_CLUB'::text" },
        { table_name: 'User', column_name: 'accountType', column_default: "'STUDENT'::text" },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Payment' AND column_name = 'studentId'`))
        .toEqual([{ is_nullable: 'YES' }]);
      const constraints = await db.$queryRawUnsafe<Array<{ conname: string }>>(`SELECT conname FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY conname`);
      expect(constraints.map(constraint => constraint.conname)).toEqual(expect.arrayContaining([
        'Student_pkey',
        'Student_businessId_fkey',
        'Student_userId_fkey',
        'Student_email_canonical_check',
        'Participant_studentId_fkey',
        'LessonPackage_studentId_fkey',
        'Payment_studentId_fkey',
        'User_accountType_check',
        'Business_kind_check',
        'Booking_paymentRoute_check',
        'Booking_createdByRole_check',
        'Payment_kind_check',
        'Payment_party_shape_check',
        'RescheduleRequest_requestedByRole_check',
      ]));
      const triggers = await db.$queryRawUnsafe<Array<{ tgname: string; deferred: boolean }>>(`
        SELECT trigger.tgname, constraint_row.condeferred AS deferred
        FROM pg_trigger AS trigger
        LEFT JOIN pg_constraint AS constraint_row ON constraint_row.oid = trigger.tgconstraint
        WHERE trigger.tgrelid IN ('"User"'::regclass, '"Membership"'::regclass, '"Business"'::regclass)
          AND NOT trigger.tgisinternal
        ORDER BY trigger.tgname
      `);
      expect(triggers).toEqual(expect.arrayContaining([
        { tgname: 'Business_account_shape_invariants', deferred: true },
        { tgname: 'Business_kind_immutable', deferred: null },
        { tgname: 'Membership_account_shape_invariants', deferred: true },
        { tgname: 'User_account_shape_invariants', deferred: true },
      ]));
      for (const legacyConstraint of [
        'Customer_pkey',
        'Customer_businessId_fkey',
        'Customer_userId_fkey',
        'Customer_email_canonical_check',
        'Participant_customerId_fkey',
        'LessonPackage_customerId_fkey',
        'Payment_customerId_fkey',
      ]) expect(constraints.map(constraint => constraint.conname)).not.toContain(legacyConstraint);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it('preserves legacy ADMIN people and sessions without retaining management authority', async () => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 8)) applyMigration(url, file);
      executeSql(url, `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('club', 'Legacy Club', 'legacy-club-admin-preservation', 'Owner Person', 'club@example.test', 'CLUB');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials", "email", "active") VALUES
          ('owner-roster', 'club', 'Owner Person', 'OP', 'owner@example.test', true),
          ('existing-admin-roster', 'club', 'Roster Admin', 'RA', 'roster-admin@example.test', false);
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType", "phone") VALUES
          ('owner', 'Owner Person', 'owner@example.test', 'owner-hash', 'OWNER', '100'),
          ('admin-no-roster', 'Desk Admin', 'desk-admin@example.test', 'desk-hash', 'COACH', '200'),
          ('admin-with-roster', 'Roster Admin', 'roster-admin@example.test', 'roster-hash', 'COACH', '300');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role", "instructorId", "active") VALUES
          ('owner-membership', 'owner', 'club', 'OWNER', 'owner-roster', true),
          ('admin-membership', 'admin-no-roster', 'club', 'ADMIN', NULL, false),
          ('roster-admin-membership', 'admin-with-roster', 'club', 'ADMIN', 'existing-admin-roster', true);
        INSERT INTO "AuthSession" ("id", "userId", "activeMembershipId", "expiresAt") VALUES
          ('owner-session', 'owner', 'owner-membership', CURRENT_TIMESTAMP + INTERVAL '1 day'),
          ('admin-session', 'admin-no-roster', 'admin-membership', CURRENT_TIMESTAMP + INTERVAL '1 day'),
          ('roster-admin-session', 'admin-with-roster', 'roster-admin-membership', CURRENT_TIMESTAMP + INTERVAL '1 day');
      `);

      for (const file of migrationFiles.slice(8)) applyMigration(url, file);

      expect(await db.$queryRawUnsafe(`SELECT id, name, email, "passwordHash", "accountType", phone FROM "User" WHERE id IN ('owner', 'admin-no-roster', 'admin-with-roster') ORDER BY id`)).toEqual([
        { id: 'admin-no-roster', name: 'Desk Admin', email: 'desk-admin@example.test', passwordHash: 'desk-hash', accountType: 'COACH', phone: '200' },
        { id: 'admin-with-roster', name: 'Roster Admin', email: 'roster-admin@example.test', passwordHash: 'roster-hash', accountType: 'COACH', phone: '300' },
        { id: 'owner', name: 'Legacy Club', email: 'owner@example.test', passwordHash: 'owner-hash', accountType: 'CLUB', phone: '100' },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, "userId", "instructorId", active FROM "Membership" WHERE id IN ('owner-membership', 'admin-membership', 'roster-admin-membership') ORDER BY id`)).toEqual([
        { id: 'admin-membership', userId: 'admin-no-roster', instructorId: 'legacy-admin-instructor-admin-membership', active: false },
        { id: 'owner-membership', userId: 'owner', instructorId: null, active: true },
        { id: 'roster-admin-membership', userId: 'admin-with-roster', instructorId: 'existing-admin-roster', active: true },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, name, email, active FROM "Instructor" WHERE id IN ('legacy-admin-instructor-admin-membership', 'existing-admin-roster') ORDER BY id`)).toEqual([
        { id: 'existing-admin-roster', name: 'Roster Admin', email: 'roster-admin@example.test', active: false },
        { id: 'legacy-admin-instructor-admin-membership', name: 'Desk Admin', email: 'desk-admin@example.test', active: false },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id, "activeMembershipId" FROM "AuthSession" ORDER BY id`)).toEqual([
        { id: 'admin-session', activeMembershipId: 'admin-membership' },
        { id: 'owner-session', activeMembershipId: 'owner-membership' },
        { id: 'roster-admin-session', activeMembershipId: 'roster-admin-membership' },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT count(*) AS count FROM "User" WHERE "accountType" = 'CLUB'`)).toEqual([{ count: 1n }]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it('rejects a legacy manager of multiple clubs and rolls the final migration back atomically', async () => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 8)) applyMigration(url, file);
      executeSql(url, `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('first-club', 'First Club', 'first-club-final-failure', 'Manager', 'first@example.test', 'CLUB'),
          ('second-club', 'Second Club', 'second-club-final-failure', 'Manager', 'second@example.test', 'CLUB');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('multi-manager', 'Manager', 'manager@example.test', 'hash', 'OWNER');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role") VALUES
          ('first-management', 'multi-manager', 'first-club', 'OWNER'),
          ('second-management', 'multi-manager', 'second-club', 'OWNER');
      `);

      const result = runMigration(url, migrationFiles[8]!);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('a legacy user manages more than one CLUB business');

      expect(await db.$queryRawUnsafe(`SELECT "accountType" FROM "User" WHERE id = 'multi-manager'`)).toEqual([{ accountType: 'OWNER' }]);
      expect(await db.$queryRawUnsafe(`SELECT id, role FROM "Membership" WHERE "userId" = 'multi-manager' ORDER BY id`)).toEqual([
        { id: 'first-management', role: 'OWNER' },
        { id: 'second-management', role: 'OWNER' },
      ]);
      expect(await db.$queryRawUnsafe<Array<{ customer: string | null; student: string | null }>>(`SELECT to_regclass(current_schema() || '."Customer"')::text AS customer, to_regclass(current_schema() || '."Student"')::text AS student`)).toEqual([
        { customer: '"Customer"', student: null },
      ]);
      const bookingDefault = await db.$queryRawUnsafe<Array<{ column_default: string | null }>>(`SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Booking' AND column_name = 'createdByRole'`);
      expect(bookingDefault).toEqual([{ column_default: "'CUSTOMER'::text" }]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it.each([
    {
      name: 'a linked provider account',
      expected: 'legacy Customer.userId points to a provider account',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('club', 'Club', 'legacy-preflight-provider', 'Owner', 'club@example.test', 'CLUB');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('owner', 'Owner', 'owner@example.test', 'hash', 'OWNER'),
          ('provider', 'Provider', 'provider@example.test', 'hash', 'COACH');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role")
          VALUES ('owner-membership', 'owner', 'club', 'OWNER');
        INSERT INTO "Customer" ("id", "businessId", "userId", "name", "email", "initials")
          VALUES ('customer', 'club', 'provider', 'Provider', 'provider-customer@example.test', 'PR');
      `,
    },
    {
      name: 'a cross-tenant student payment',
      expected: 'legacy payment names a customer from another business',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('club-a', 'Club A', 'legacy-preflight-club-a', 'Owner A', 'a@example.test', 'CLUB'),
          ('club-b', 'Club B', 'legacy-preflight-club-b', 'Owner B', 'b@example.test', 'CLUB');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('owner-a', 'Owner A', 'owner-a@example.test', 'hash', 'OWNER'),
          ('owner-b', 'Owner B', 'owner-b@example.test', 'hash', 'OWNER');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role") VALUES
          ('owner-a-membership', 'owner-a', 'club-a', 'OWNER'),
          ('owner-b-membership', 'owner-b', 'club-b', 'OWNER');
        INSERT INTO "Customer" ("id", "businessId", "name", "email", "initials")
          VALUES ('customer-a', 'club-a', 'Student', 'student@example.test', 'ST');
        INSERT INTO "Payment" ("id", "businessId", "customerId", "amount", "kind")
          VALUES ('bad-payment', 'club-b', 'customer-a', 1000, 'CUSTOMER_TO_CLUB');
      `,
    },
    {
      name: 'a cross-tenant package student',
      expected: 'legacy package names a customer from another business',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('club-a', 'Club A', 'legacy-package-club-a', 'Owner A', 'a@example.test', 'CLUB'),
          ('club-b', 'Club B', 'legacy-package-club-b', 'Owner B', 'b@example.test', 'CLUB');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('owner-a', 'Owner A', 'package-owner-a@example.test', 'hash', 'OWNER'),
          ('owner-b', 'Owner B', 'package-owner-b@example.test', 'hash', 'OWNER');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role") VALUES
          ('owner-a-membership', 'owner-a', 'club-a', 'OWNER'),
          ('owner-b-membership', 'owner-b', 'club-b', 'OWNER');
        INSERT INTO "Customer" ("id", "businessId", "name", "email", "initials")
          VALUES ('customer-a', 'club-a', 'Student', 'package-student@example.test', 'ST');
        INSERT INTO "LessonPackage" ("id", "businessId", "customerId", "name", "totalCredits", "price", "expiresAt")
          VALUES ('bad-package', 'club-b', 'customer-a', 'Bad Package', 1, 1000, CURRENT_TIMESTAMP + INTERVAL '30 days');
      `,
    },
    {
      name: 'a cross-tenant payment package',
      expected: 'legacy payment names a package from another business',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('club-a', 'Club A', 'legacy-payment-package-a', 'Owner A', 'a@example.test', 'CLUB'),
          ('club-b', 'Club B', 'legacy-payment-package-b', 'Owner B', 'b@example.test', 'CLUB');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('owner-a', 'Owner A', 'payment-package-owner-a@example.test', 'hash', 'OWNER'),
          ('owner-b', 'Owner B', 'payment-package-owner-b@example.test', 'hash', 'OWNER');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role") VALUES
          ('owner-a-membership', 'owner-a', 'club-a', 'OWNER'),
          ('owner-b-membership', 'owner-b', 'club-b', 'OWNER');
        INSERT INTO "Customer" ("id", "businessId", "name", "email", "initials") VALUES
          ('customer-a', 'club-a', 'Student A', 'payment-package-a@example.test', 'SA'),
          ('customer-b', 'club-b', 'Student B', 'payment-package-b@example.test', 'SB');
        INSERT INTO "LessonPackage" ("id", "businessId", "customerId", "name", "totalCredits", "price", "expiresAt")
          VALUES ('package-a', 'club-a', 'customer-a', 'Package A', 1, 1000, CURRENT_TIMESTAMP + INTERVAL '30 days');
        INSERT INTO "Payment" ("id", "businessId", "customerId", "packageId", "amount", "kind")
          VALUES ('bad-payment', 'club-b', 'customer-b', 'package-a', 1000, 'CUSTOMER_TO_CLUB');
      `,
    },
  ])('rejects $name before renaming Customer or changing roles', async ({ expected, fixture }) => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 8)) applyMigration(url, file);
      executeSql(url, fixture);

      const result = runMigration(url, migrationFiles[8]!);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
      expect(await db.$queryRawUnsafe(`SELECT to_regclass(current_schema() || '."Customer"')::text AS customer, to_regclass(current_schema() || '."Student"')::text AS student`))
        .toEqual([{ customer: '"Customer"', student: null }]);
      expect(await db.$queryRawUnsafe(`SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Booking' AND column_name = 'createdByRole'`))
        .toEqual([{ column_default: "'CUSTOMER'::text" }]);
      expect(await db.$queryRawUnsafe(`SELECT count(*) AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Membership' AND column_name = 'role'`))
        .toEqual([{ count: 1n }]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it.each([
    {
      name: 'a CLUB business without a manager',
      expected: 'each CLUB business must have exactly one OWNER',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('club', 'Club', 'invalid-club-without-manager', 'Nobody', 'club@example.test', 'CLUB');
      `,
    },
    {
      name: 'a SOLO business without exactly one OWNER',
      expected: 'each must have exactly one OWNER',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('solo', 'Solo', 'invalid-solo-owner-count', 'Coach', 'solo@example.test', 'SOLO');
      `,
    },
    {
      name: 'a non-OWNER SOLO affiliation',
      expected: 'non-OWNER affiliations exist',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('solo', 'Solo', 'invalid-solo-non-owner', 'Coach', 'solo@example.test', 'SOLO');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials")
          VALUES ('solo-owner-roster', 'solo', 'Owner', 'OW'), ('solo-coach-roster', 'solo', 'Coach', 'CO');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('owner', 'Owner', 'owner@example.test', 'hash', 'OWNER'),
          ('coach', 'Coach', 'coach@example.test', 'hash', 'COACH');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role", "instructorId") VALUES
          ('owner-membership', 'owner', 'solo', 'OWNER', 'solo-owner-roster'),
          ('coach-membership', 'coach', 'solo', 'COACH', 'solo-coach-roster');
      `,
    },
    {
      name: 'one user owning more than one SOLO business',
      expected: 'a legacy user owns more than one SOLO business',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('solo-one', 'Solo One', 'invalid-solo-one', 'Coach', 'one@example.test', 'SOLO'),
          ('solo-two', 'Solo Two', 'invalid-solo-two', 'Coach', 'two@example.test', 'SOLO');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES
          ('roster-one', 'solo-one', 'Coach', 'CO'), ('roster-two', 'solo-two', 'Coach', 'CO');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType")
          VALUES ('coach', 'Coach', 'coach@example.test', 'hash', 'OWNER');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role", "instructorId") VALUES
          ('membership-one', 'coach', 'solo-one', 'OWNER', 'roster-one'),
          ('membership-two', 'coach', 'solo-two', 'OWNER', 'roster-two');
      `,
    },
    {
      name: 'one user managing a CLUB and owning a SOLO',
      expected: 'both manages a CLUB and owns a SOLO business',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('club', 'Club', 'invalid-mixed-club', 'Manager', 'club@example.test', 'CLUB'),
          ('solo', 'Solo', 'invalid-mixed-solo', 'Manager', 'solo@example.test', 'SOLO');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES
          ('club-roster', 'club', 'Manager', 'MA'), ('solo-roster', 'solo', 'Manager', 'MA');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType")
          VALUES ('manager', 'Manager', 'manager@example.test', 'hash', 'OWNER');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role", "instructorId") VALUES
          ('club-membership', 'manager', 'club', 'OWNER', 'club-roster'),
          ('solo-membership', 'manager', 'solo', 'OWNER', 'solo-roster');
      `,
    },
    {
      name: 'an extra CLUB-manager affiliation without an instructor',
      expected: 'an extra legacy affiliation has no instructor identity',
      fixture: `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES
          ('managed', 'Managed Club', 'invalid-managed-club', 'Manager', 'managed@example.test', 'CLUB'),
          ('extra', 'Extra Club', 'invalid-extra-club', 'Other', 'extra@example.test', 'CLUB');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('manager', 'Manager', 'manager@example.test', 'hash', 'OWNER'),
          ('extra-owner', 'Extra Owner', 'extra-owner@example.test', 'hash', 'OWNER');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role") VALUES
          ('management', 'manager', 'managed', 'OWNER'),
          ('extra-affiliation', 'manager', 'extra', 'COACH'),
          ('extra-management', 'extra-owner', 'extra', 'OWNER');
      `,
    },
  ])('rejects $name and rolls the final migration back atomically', async ({ expected, fixture }) => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 8)) applyMigration(url, file);
      executeSql(url, fixture);

      const result = runMigration(url, migrationFiles[8]!);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
      expect(await db.$queryRawUnsafe<Array<{ customer: string | null; student: string | null }>>(`SELECT to_regclass(current_schema() || '."Customer"')::text AS customer, to_regclass(current_schema() || '."Student"')::text AS student`)).toEqual([
        { customer: '"Customer"', student: null },
      ]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it('rejects deterministic CLUB teaching placeholder collisions atomically', async () => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, 8)) applyMigration(url, file);
      executeSql(url, `
        INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
          VALUES ('club', 'Club', 'placeholder-collision-club', 'Owner', 'club@example.test', 'CLUB');
        INSERT INTO "Instructor" ("id", "businessId", "name", "initials")
          VALUES ('founder-roster', 'club', 'Founder', 'FO');
        INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES
          ('owner', 'Owner', 'owner@example.test', 'hash', 'OWNER'),
          ('legacy-instructor-founder-roster', 'Collision', 'collision@example.test', 'hash', 'COACH');
        INSERT INTO "Membership" ("id", "userId", "businessId", "role", "instructorId")
          VALUES ('management', 'owner', 'club', 'OWNER', 'founder-roster');
      `);

      const result = runMigration(url, migrationFiles[8]!);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('deterministic placeholder account collision exists');
      expect(await db.$queryRawUnsafe(`SELECT "accountType" FROM "User" WHERE id = 'owner'`)).toEqual([{ accountType: 'OWNER' }]);
      expect(await db.$queryRawUnsafe(`SELECT "instructorId", active FROM "Membership" WHERE id = 'management'`)).toEqual([{ instructorId: 'founder-roster', active: true }]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);

  it('enforces final account shapes while permitting complete creation and deletion transactions', async () => {
    const schema = await createIsolatedSchema(admin);
    schemas.add(schema);
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);

      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES ('valid-club', 'Valid Club', 'valid-club-shape', 'Founder', 'club@example.test', 'CLUB')`);
        await tx.$executeRawUnsafe(`INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES ('valid-club-account', 'Valid Club', 'club-account@example.test', 'hash', 'CLUB')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId") VALUES ('valid-club-membership', 'valid-club-account', 'valid-club')`);
      });

      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES ('valid-coach', 'Valid Coach', 'valid-coach@example.test', 'hash', 'COACH')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES ('valid-club-roster', 'valid-club', 'Valid Coach', 'VC')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId") VALUES ('valid-club-coach', 'valid-coach', 'valid-club', 'valid-club-roster')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES ('valid-solo', 'Valid Solo', 'valid-solo-shape', 'Valid Coach', 'valid-coach@example.test', 'SOLO')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES ('valid-solo-roster', 'valid-solo', 'Valid Coach', 'VC')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId") VALUES ('valid-solo-coach', 'valid-coach', 'valid-solo', 'valid-solo-roster')`);
      });

      expect(await db.$queryRawUnsafe(`SELECT "userId", "businessId", "instructorId" FROM "Membership" ORDER BY "businessId", "userId"`)).toEqual([
        { userId: 'valid-club-account', businessId: 'valid-club', instructorId: null },
        { userId: 'valid-coach', businessId: 'valid-club', instructorId: 'valid-club-roster' },
        { userId: 'valid-coach', businessId: 'valid-solo', instructorId: 'valid-solo-roster' },
      ]);

      await expect(db.$executeRawUnsafe(`UPDATE "Business" SET "kind" = 'SOLO' WHERE id = 'valid-club'`))
        .rejects.toThrow('Business.kind is immutable after creation');
      await db.$executeRawUnsafe(`INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES ('valid-student', 'Student', 'student@example.test', 'hash', 'STUDENT')`);
      await expect(db.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId") VALUES ('student-membership', 'valid-student', 'valid-club')`))
        .rejects.toThrow('STUDENT accounts cannot have business affiliations');
      await expect(db.$executeRawUnsafe(`UPDATE "User" SET "accountType" = 'STUDENT' WHERE id = 'valid-coach'`))
        .rejects.toThrow('STUDENT accounts cannot have business affiliations');
      await expect(db.$executeRawUnsafe(`UPDATE "User" SET "accountType" = 'CLUB' WHERE id = 'valid-student'`))
        .rejects.toThrow('Each CLUB account must have exactly one active non-teaching CLUB affiliation');
      await expect(db.$executeRawUnsafe(`UPDATE "Membership" SET "active" = false WHERE id = 'valid-club-membership'`))
        .rejects.toThrow('Each CLUB account must have exactly one active non-teaching CLUB affiliation');
      await expect(db.$executeRawUnsafe(`DELETE FROM "Membership" WHERE id = 'valid-club-membership'`))
        .rejects.toThrow('Each CLUB account must have exactly one active non-teaching CLUB affiliation');
      await expect(db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES ('mislinked-club-account', 'Wrong Club', 'wrong-club@example.test', 'hash', 'CLUB')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId") VALUES ('mislinked-club-membership', 'mislinked-club-account', 'valid-solo')`);
      })).rejects.toThrow('Each CLUB account must have exactly one active non-teaching CLUB affiliation');

      await db.$executeRawUnsafe(`INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES ('unaffiliated-coach', 'Coach Two', 'coach-two@example.test', 'hash', 'COACH')`);
      await expect(db.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId") VALUES ('coach-without-roster', 'unaffiliated-coach', 'valid-club')`))
        .rejects.toThrow('Every COACH affiliation must have an instructor identity');
      await expect(db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES ('missing-roster-solo', 'Missing Roster', 'missing-roster-solo', 'Coach Two', 'coach-two@example.test', 'SOLO')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId") VALUES ('missing-roster-solo-membership', 'unaffiliated-coach', 'missing-roster-solo')`);
      })).rejects.toThrow('Every COACH affiliation must have an instructor identity');

      await db.$executeRawUnsafe(`INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES ('spare-club-roster', 'valid-club', 'Spare Coach', 'SC')`);
      await expect(db.$executeRawUnsafe(`UPDATE "Membership" SET "instructorId" = 'spare-club-roster' WHERE id = 'valid-club-membership'`))
        .rejects.toThrow('Each CLUB account must have exactly one active non-teaching CLUB affiliation');

      await db.$executeRawUnsafe(`INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType") VALUES ('second-solo-coach', 'Solo Coach Two', 'solo-coach-two@example.test', 'hash', 'COACH')`);
      await db.$executeRawUnsafe(`INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES ('second-valid-solo-roster', 'valid-solo', 'Solo Coach Two', 'ST')`);
      await expect(db.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId") VALUES ('second-valid-solo-membership', 'second-solo-coach', 'valid-solo', 'second-valid-solo-roster')`))
        .rejects.toThrow('Each SOLO business must have exactly one teaching COACH affiliation');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES ('orphan-club', 'Orphan Club', 'orphan-club-shape', 'Nobody', 'orphan@example.test', 'CLUB')`))
        .rejects.toThrow('Each CLUB business must have exactly one active institutional affiliation');

      await expect(db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind") VALUES ('second-solo', 'Second Solo', 'second-solo-shape', 'Valid Coach', 'valid-coach@example.test', 'SOLO')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Instructor" ("id", "businessId", "name", "initials") VALUES ('second-solo-roster', 'second-solo', 'Valid Coach', 'VC')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId") VALUES ('second-solo-coach', 'valid-coach', 'second-solo', 'second-solo-roster')`);
      })).rejects.toThrow('A COACH account can own at most one SOLO practice');

      await db.$executeRawUnsafe(`INSERT INTO "Student" ("id", "businessId", "name", "email", "initials") VALUES ('valid-payment-student', 'valid-club', 'Payment Student', 'payment-student@example.test', 'PS')`);
      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "amount", "kind") VALUES ('valid-student-payment', 'valid-club', 'valid-payment-student', 1000, 'STUDENT_TO_CLUB')`);
      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "amount", "kind") VALUES ('valid-payout', 'valid-club', NULL, 'valid-club-roster', 500, 'CLUB_TO_COACH')`);
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "amount", "kind") VALUES ('student-payment-without-student', 'valid-club', NULL, 1000, 'STUDENT_TO_CLUB')`))
        .rejects.toThrow();
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "instructorId", "amount", "kind") VALUES ('payout-with-student', 'valid-club', 'valid-payment-student', 'valid-club-roster', 500, 'CLUB_TO_COACH')`))
        .rejects.toThrow();
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id", "businessId", "studentId", "amount", "kind") VALUES ('payout-without-coach', 'valid-club', NULL, 500, 'CLUB_TO_COACH')`))
        .rejects.toThrow();

      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "businessId" = 'valid-club'`);
        await tx.$executeRawUnsafe(`DELETE FROM "Business" WHERE id = 'valid-club'`);
        await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id = 'valid-club-account'`);
      });
      expect(await db.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = 'valid-coach'`)).toEqual([{ id: 'valid-coach' }]);
    } finally {
      await db.$disconnect();
      await dropIsolatedSchema(admin, schema);
      schemas.delete(schema);
    }
  }, 60_000);
});
