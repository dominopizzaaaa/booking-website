import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../src/config.js';

const databaseUrl = process.env.DATABASE_URL!;
const precedingMigrationNames = [
  '20260916000000_initial',
  '20260916010000_minor_units',
  '20260916020000_integer_minor_units',
  '20260916030000_private_management_tokens',
  '20260916040000_global_accounts',
  '20260916050000_membership_instructor_business_invariant',
  '20260917000000_account_notifications',
  '20260917100000_club_coach_platform',
  '20260917200000_student_coach_club',
  '20260917205000_single_club_account_per_club',
  '20260917210000_account_shape_invariants',
  '20260917220000_payment_party_invariants',
  '20260917230000_identity_tenancy_invariants',
  '20260917240000_financial_target_invariants',
  '20260917250000_core_tenancy_invariants',
  '20260925000000_club_directory_index',
] as const;
const precedingMigrationFiles = precedingMigrationNames.map(name =>
  fileURLToPath(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)));
const calendarMigration = fileURLToPath(new URL(
  '../prisma/migrations/20260925100000_google_calendar_integration/migration.sql',
  import.meta.url,
));
const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

function isolatedUrl(schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function runSql(url: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, ...args], {
    encoding: 'utf8', env: process.env, input,
  });
}

function applyMigration(url: string, file: string) {
  const result = runSql(url, ['--file', file]);
  if (result.status !== 0) {
    throw new Error(`Failed to apply ${file}:\n${result.stdout}\n${result.stderr}`);
  }
}

function executeSql(url: string, statement: string) {
  const result = runSql(url, ['--stdin'], statement);
  if (result.status !== 0) {
    throw new Error(`Failed fixture SQL:\n${result.stdout}\n${result.stderr}`);
  }
}

type RawDatabaseError = { code?: string; meta?: { code?: string } };

async function expectSqlState(operation: () => Promise<unknown>, sqlState: string) {
  try {
    await operation();
  } catch (error) {
    const databaseError = error as RawDatabaseError;
    expect(databaseError.code).toBe('P2010');
    expect(databaseError.meta?.code).toBe(sqlState);
    return;
  }
  throw new Error(`Expected the database write to fail with SQLSTATE ${sqlState}`);
}

const preUpgradeFixture = `
BEGIN;
INSERT INTO "Business" ("id","name","slug","ownerName","email","kind")
  VALUES ('club','Migration Club','calendar-migration-club','Migration Club','club@example.test','CLUB');
INSERT INTO "User" ("id","name","email","passwordHash","accountType") VALUES
  ('club-account','Migration Club','club-account@example.test','hash','CLUB'),
  ('coach-account','Migration Coach','coach@example.test','hash','COACH'),
  ('student-account','Migration Student','student@example.test','hash','STUDENT');
INSERT INTO "Instructor" ("id","businessId","name","initials")
  VALUES ('coach','club','Migration Coach','MC');
INSERT INTO "Membership" ("id","userId","businessId","instructorId") VALUES
  ('club-membership','club-account','club',NULL),
  ('coach-membership','coach-account','club','coach');
INSERT INTO "Student" ("id","businessId","userId","name","email","initials")
  VALUES ('student','club','student-account','Migration Student','student@example.test','MS');
INSERT INTO "AuthSession" ("id","userId","expiresAt")
  VALUES ('student-session','student-account',CURRENT_TIMESTAMP + INTERVAL '1 day');
INSERT INTO "Location" ("id","businessId","name")
  VALUES ('court','club','Migration Court');
INSERT INTO "Service" ("id","businessId","name")
  VALUES ('lesson','club','Migration Lesson');
INSERT INTO "Booking"
  ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute")
  VALUES ('booking-before-upgrade','club','lesson','coach','court',CURRENT_TIMESTAMP + INTERVAL '1 day',CURRENT_TIMESTAMP + INTERVAL '1 day 1 hour',60,'PRIVATE',1,1200,'CLUB');
INSERT INTO "Participant" ("id","bookingId","studentId","price")
  VALUES ('participant','booking-before-upgrade','student',1200);
COMMIT;`;

describe.sequential('Google Calendar migration', () => {
  let admin: PrismaClient;
  const schemas = new Set<string>();

  async function createSchema() {
    const schema = `calendar_migration_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemas.add(schema);
    return schema;
  }

  async function dropSchema(schema: string) {
    if (!/^calendar_migration_[a-f0-9_]+$/.test(schema)) {
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

  it('upgrades populated data and installs the calendar defaults, constraints, and orphan projection path', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of precedingMigrationFiles) applyMigration(url, file);
      executeSql(url, preUpgradeFixture);

      applyMigration(url, calendarMigration);

      expect(await db.$queryRawUnsafe(`
        SELECT booking.id, booking."calendarRevision", participant.id AS "participantId",
          student."userId", session.id AS "sessionId"
        FROM "Booking" AS booking
        JOIN "Participant" AS participant ON participant."bookingId"=booking.id
        JOIN "Student" AS student ON student.id=participant."studentId"
        JOIN "AuthSession" AS session ON session."userId"=student."userId"
        WHERE booking.id='booking-before-upgrade'
      `)).toEqual([{
        id: 'booking-before-upgrade', calendarRevision: 0, participantId: 'participant',
        userId: 'student-account', sessionId: 'student-session',
      }]);

      executeSql(url, `
        BEGIN;
        INSERT INTO "Booking"
          ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute")
          VALUES ('booking-after-upgrade','club','lesson','coach','court',CURRENT_TIMESTAMP + INTERVAL '2 days',CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour',60,'PRIVATE',1,1200,'CLUB');
        INSERT INTO "CalendarConnection"
          ("id","userId","providerAccountId","providerEmail","accessTokenCiphertext","accessTokenExpiresAt") VALUES
          ('student-connection','student-account','google-student','student@gmail.test','encrypted-access',CURRENT_TIMESTAMP + INTERVAL '1 hour'),
          ('coach-connection','coach-account','google-coach','coach@gmail.test','encrypted-access',CURRENT_TIMESTAMP + INTERVAL '1 hour');
        INSERT INTO "CalendarOAuthAttempt"
          ("id","userId","authSessionId","stateDigest","codeVerifierCiphertext","returnTo","expiresAt")
          VALUES ('oauth-attempt','student-account','student-session','state-digest','encrypted-verifier','/account',CURRENT_TIMESTAMP + INTERVAL '15 minutes');
        INSERT INTO "CalendarEventProjection"
          ("id","connectionId","bookingId","providerEventId","syncedRevision") VALUES
          ('student-projection','student-connection','booking-before-upgrade','student-event',0),
          ('coach-projection','coach-connection','booking-before-upgrade','coach-event',0);
        INSERT INTO "CalendarSyncJob" ("id","bookingId","requestedRevision")
          VALUES ('sync-job','booking-before-upgrade',0);
        INSERT INTO "CalendarBusyInterval" ("id","connectionId","startAt","endAt","expiresAt")
          VALUES ('busy-interval','coach-connection',CURRENT_TIMESTAMP + INTERVAL '3 hours',CURRENT_TIMESTAMP + INTERVAL '4 hours',CURRENT_TIMESTAMP + INTERVAL '1 day');
        COMMIT;
      `);

      expect(await db.$queryRawUnsafe(`
        SELECT id, "calendarRevision" FROM "Booking" ORDER BY id
      `)).toEqual([
        { id: 'booking-after-upgrade', calendarRevision: 0 },
        { id: 'booking-before-upgrade', calendarRevision: 0 },
      ]);
      expect(await db.$queryRawUnsafe(`
        SELECT id, provider, status, "calendarTimeZone", "syncEnabled",
          "busyCheckEnabled", "busyRefreshFailures"
        FROM "CalendarConnection" ORDER BY id
      `)).toEqual([
        {
          id: 'coach-connection', provider: 'GOOGLE', status: 'ACTIVE', calendarTimeZone: 'UTC',
          syncEnabled: true, busyCheckEnabled: false, busyRefreshFailures: 0,
        },
        {
          id: 'student-connection', provider: 'GOOGLE', status: 'ACTIVE', calendarTimeZone: 'UTC',
          syncEnabled: true, busyCheckEnabled: false, busyRefreshFailures: 0,
        },
      ]);

      const checks = await db.$queryRawUnsafe<Array<{ name: string }>>(`
        SELECT constraint_record.conname AS name
        FROM pg_constraint AS constraint_record
        JOIN pg_class AS source_table ON source_table.oid=constraint_record.conrelid
        WHERE source_table.relnamespace=current_schema()::regnamespace
          AND source_table.relname LIKE 'Calendar%'
          AND constraint_record.contype='c'
        ORDER BY constraint_record.conname
      `);
      expect(checks).toEqual([
        { name: 'CalendarBusyInterval_order_check' },
        { name: 'CalendarConnection_busyRefreshFailures_check' },
        { name: 'CalendarConnection_disconnect_shape_check' },
        { name: 'CalendarConnection_provider_check' },
        { name: 'CalendarConnection_status_check' },
        { name: 'CalendarEventProjection_cleanupAttempts_check' },
        { name: 'CalendarEventProjection_cleanup_lease_shape_check' },
        { name: 'CalendarEventProjection_syncedRevision_check' },
        { name: 'CalendarOAuthAttempt_expiry_check' },
        { name: 'CalendarRevocationJob_attempts_check' },
        { name: 'CalendarRevocationJob_lease_shape_check' },
        { name: 'CalendarRevocationJob_provider_check' },
        { name: 'CalendarSyncJob_attempts_check' },
        { name: 'CalendarSyncJob_lease_shape_check' },
        { name: 'CalendarSyncJob_requestedRevision_check' },
      ]);

      const foreignKeys = await db.$queryRawUnsafe<Array<{ name: string; deleteAction: string }>>(`
        SELECT constraint_record.conname AS name, constraint_record.confdeltype::text AS "deleteAction"
        FROM pg_constraint AS constraint_record
        JOIN pg_class AS source_table ON source_table.oid=constraint_record.conrelid
        WHERE source_table.relnamespace=current_schema()::regnamespace
          AND source_table.relname LIKE 'Calendar%'
          AND constraint_record.contype='f'
        ORDER BY constraint_record.conname
      `);
      expect(foreignKeys).toEqual([
        { name: 'CalendarBusyInterval_connectionId_fkey', deleteAction: 'c' },
        { name: 'CalendarConnection_userId_fkey', deleteAction: 'c' },
        { name: 'CalendarEventProjection_bookingId_fkey', deleteAction: 'n' },
        { name: 'CalendarEventProjection_connectionId_fkey', deleteAction: 'c' },
        { name: 'CalendarOAuthAttempt_authSessionId_fkey', deleteAction: 'c' },
        { name: 'CalendarOAuthAttempt_userId_fkey', deleteAction: 'c' },
        { name: 'CalendarSyncJob_bookingId_fkey', deleteAction: 'c' },
      ]);

      const uniqueIndexes = await db.$queryRawUnsafe<Array<{ name: string }>>(`
        SELECT indexname AS name FROM pg_indexes
        WHERE schemaname=current_schema()
          AND indexname IN (
            'CalendarConnection_userId_key',
            'CalendarConnection_provider_providerAccountId_key',
            'CalendarOAuthAttempt_stateDigest_key',
            'CalendarEventProjection_connectionId_bookingId_key',
            'CalendarEventProjection_connectionId_providerEventId_key',
            'CalendarSyncJob_bookingId_key'
          )
        ORDER BY indexname
      `);
      expect(uniqueIndexes).toEqual([
        { name: 'CalendarConnection_provider_providerAccountId_key' },
        { name: 'CalendarConnection_userId_key' },
        { name: 'CalendarEventProjection_connectionId_bookingId_key' },
        { name: 'CalendarEventProjection_connectionId_providerEventId_key' },
        { name: 'CalendarOAuthAttempt_stateDigest_key' },
        { name: 'CalendarSyncJob_bookingId_key' },
      ]);

      const invalidChecks = [
        `UPDATE "CalendarConnection" SET provider='OUTLOOK' WHERE id='student-connection'`,
        `UPDATE "CalendarConnection" SET status='BROKEN' WHERE id='student-connection'`,
        `UPDATE "CalendarConnection" SET "busyRefreshFailures"=-1 WHERE id='student-connection'`,
        `UPDATE "CalendarConnection" SET status='DISCONNECTING' WHERE id='student-connection'`,
        `INSERT INTO "CalendarOAuthAttempt" (id,"userId","authSessionId","stateDigest","codeVerifierCiphertext","returnTo","createdAt","expiresAt") VALUES ('invalid-oauth','student-account','student-session','invalid-state','encrypted','/account',TIMESTAMP '2030-01-01',TIMESTAMP '2030-01-01')`,
        `INSERT INTO "CalendarRevocationJob" (id,"tokenCiphertext",attempts) VALUES ('invalid-revocation-attempts','encrypted',-1)`,
        `INSERT INTO "CalendarRevocationJob" (id,"tokenCiphertext","leasedUntil") VALUES ('invalid-revocation-lease','encrypted',CURRENT_TIMESTAMP + INTERVAL '1 minute')`,
        `INSERT INTO "CalendarEventProjection" (id,"connectionId","providerEventId","syncedRevision") VALUES ('invalid-projection','student-connection','invalid-revision-event',-1)`,
        `INSERT INTO "CalendarSyncJob" (id,"bookingId","requestedRevision") VALUES ('invalid-revision-job','booking-after-upgrade',-1)`,
        `INSERT INTO "CalendarSyncJob" (id,"bookingId","requestedRevision",attempts) VALUES ('invalid-attempt-job','booking-after-upgrade',0,-1)`,
        `INSERT INTO "CalendarSyncJob" (id,"bookingId","requestedRevision","leasedUntil") VALUES ('invalid-lease-job','booking-after-upgrade',0,CURRENT_TIMESTAMP + INTERVAL '1 minute')`,
        `INSERT INTO "CalendarBusyInterval" (id,"connectionId","startAt","endAt","expiresAt") VALUES ('invalid-busy','coach-connection',TIMESTAMP '2030-01-01 10:00',TIMESTAMP '2030-01-01 10:00',TIMESTAMP '2030-01-02')`,
      ];
      for (const statement of invalidChecks) {
        await expectSqlState(() => db.$executeRawUnsafe(statement), '23514');
      }

      await db.$executeRawUnsafe(`DELETE FROM "Booking" WHERE id='booking-before-upgrade'`);
      expect(await db.$queryRawUnsafe(`
        SELECT id, "bookingId", "providerEventId"
        FROM "CalendarEventProjection" ORDER BY id
      `)).toEqual([
        { id: 'coach-projection', bookingId: null, providerEventId: 'coach-event' },
        { id: 'student-projection', bookingId: null, providerEventId: 'student-event' },
      ]);
      expect(await db.$queryRawUnsafe(`SELECT id FROM "CalendarSyncJob"`)).toEqual([]);
      expect(await db.$queryRawUnsafe(`SELECT id FROM "CalendarConnection" ORDER BY id`)).toEqual([
        { id: 'coach-connection' }, { id: 'student-connection' },
      ]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 120_000);
});
