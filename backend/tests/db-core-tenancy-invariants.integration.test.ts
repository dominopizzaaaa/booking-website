import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../src/config.js';

const databaseUrl = process.env.DATABASE_URL!;
const migrationNames = [
  '20260916000000_initial', '20260916010000_minor_units',
  '20260916020000_integer_minor_units', '20260916030000_private_management_tokens',
  '20260916040000_global_accounts', '20260916050000_membership_instructor_business_invariant',
  '20260917000000_account_notifications', '20260917100000_club_coach_platform',
  '20260917200000_student_coach_club', '20260917205000_single_club_account_per_club',
  '20260917210000_account_shape_invariants', '20260917220000_payment_party_invariants',
  '20260917230000_identity_tenancy_invariants', '20260917240000_financial_target_invariants',
  '20260917250000_core_tenancy_invariants',
] as const;
const migrationFiles = migrationNames.map(name =>
  fileURLToPath(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)));
const coreMigration = migrationFiles.at(-1)!;
const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

function isolatedUrl(schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function run(url: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, ...args], {
    encoding: 'utf8', env: process.env, input,
  });
}

function applyMigration(url: string, file: string) {
  const result = run(url, ['--file', file]);
  if (result.status !== 0) {
    throw new Error(`Failed to apply ${file}:\n${result.stdout}\n${result.stderr}`);
  }
}

function executeSql(url: string, statement: string) {
  const result = run(url, ['--stdin'], statement);
  if (result.status !== 0) {
    throw new Error(`Failed fixture SQL:\n${result.stdout}\n${result.stderr}`);
  }
}

type RawDatabaseError = { code?: string; meta?: { code?: string } };

function expectSqlState(error: unknown, sqlState: string) {
  const databaseError = error as RawDatabaseError;
  expect(databaseError.code).toBe('P2010');
  expect(databaseError.meta?.code).toBe(sqlState);
}

async function expectSqlState23514(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    expectSqlState(error, '23514');
    return;
  }
  throw new Error('Expected the database write to fail with SQLSTATE 23514');
}

const fixture = `
BEGIN;
INSERT INTO "Business" ("id","name","slug","ownerName","email","kind") VALUES
  ('club-a','Club A','core-tenant-club-a','Club A','club-a@example.test','CLUB'),
  ('club-b','Club B','core-tenant-club-b','Club B','club-b@example.test','CLUB');
INSERT INTO "User" ("id","name","email","passwordHash","accountType") VALUES
  ('club-a-account','Club A','club-a-account@example.test','hash','CLUB'),
  ('club-b-account','Club B','club-b-account@example.test','hash','CLUB'),
  ('coach-a-account','Coach A','coach-a@example.test','hash','COACH'),
  ('coach-b-account','Coach B','coach-b@example.test','hash','COACH'),
  ('student-a-account','Student A','student-a@example.test','hash','STUDENT'),
  ('student-a2-account','Student A2','student-a2@example.test','hash','STUDENT'),
  ('student-b-account','Student B','student-b@example.test','hash','STUDENT');
INSERT INTO "Instructor" ("id","businessId","name","initials") VALUES
  ('coach-a','club-a','Coach A','CA'), ('coach-b','club-b','Coach B','CB');
INSERT INTO "Membership" ("id","userId","businessId","instructorId") VALUES
  ('club-a-membership','club-a-account','club-a',NULL),
  ('club-b-membership','club-b-account','club-b',NULL),
  ('coach-a-membership','coach-a-account','club-a','coach-a'),
  ('coach-b-membership','coach-b-account','club-b','coach-b');
INSERT INTO "Student" ("id","businessId","userId","name","email","initials") VALUES
  ('student-a','club-a','student-a-account','Student A','student-a@example.test','SA'),
  ('student-a2','club-a','student-a2-account','Student A2','student-a2@example.test','S2'),
  ('student-b','club-b','student-b-account','Student B','student-b@example.test','SB');
INSERT INTO "Location" ("id","businessId","name") VALUES
  ('court-a','club-a','Court A'), ('court-b','club-b','Court B');
INSERT INTO "Service" ("id","businessId","name") VALUES
  ('service-a','club-a','Lesson A'), ('package-service-a','club-a','Package Lesson A'),
  ('deletable-package-service-a','club-a','Deletable Package Lesson A'),
  ('service-b','club-b','Lesson B');
INSERT INTO "ServiceLocation" ("id","serviceId","locationId","price","duration") VALUES
  ('service-location-a','service-a','court-a',1000,60),
  ('service-location-b','service-b','court-b',1000,60);
INSERT INTO "ServiceInstructor" ("serviceLocationId","instructorId") VALUES
  ('service-location-a','coach-a'), ('service-location-b','coach-b');
INSERT INTO "Availability" ("id","businessId","instructorId","locationId","dayOfWeek","startTime","endTime") VALUES
  ('availability-a','club-a','coach-a','court-a',1,'08:00','20:00'),
  ('availability-b','club-b','coach-b','court-b',1,'08:00','20:00');
INSERT INTO "AvailabilityException" ("id","businessId","instructorId","date") VALUES
  ('exception-a','club-a','coach-a','2030-01-01'),
  ('exception-b','club-b','coach-b','2030-01-01');
INSERT INTO "Booking" ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute") VALUES
  ('booking-a','club-a','service-a','coach-a','court-a',CURRENT_TIMESTAMP + INTERVAL '1 day',CURRENT_TIMESTAMP + INTERVAL '1 day 1 hour',60,'PRIVATE',1,1000,'CLUB'),
  ('booking-a2','club-a','service-a','coach-a','court-a',CURRENT_TIMESTAMP + INTERVAL '2 days',CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour',60,'PRIVATE',1,1000,'CLUB'),
  ('booking-b','club-b','service-b','coach-b','court-b',CURRENT_TIMESTAMP + INTERVAL '3 days',CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour',60,'PRIVATE',1,1000,'CLUB');
INSERT INTO "LessonPackage" ("id","businessId","studentId","serviceId","name","totalCredits","price","expiresAt") VALUES
  ('package-a','club-a','student-a','package-service-a','Package A',5,5000,CURRENT_TIMESTAMP + INTERVAL '30 days'),
  ('package-a2','club-a','student-a2',NULL,'Package A2',5,5000,CURRENT_TIMESTAMP + INTERVAL '30 days'),
  ('deletable-package','club-a','student-a2','deletable-package-service-a','Deletable Package',5,5000,CURRENT_TIMESTAMP + INTERVAL '30 days'),
  ('package-b','club-b','student-b','service-b','Package B',5,5000,CURRENT_TIMESTAMP + INTERVAL '30 days');
INSERT INTO "Participant" ("id","bookingId","studentId","price","packageId") VALUES
  ('participant-a','booking-a','student-a',1000,'package-a'),
  ('participant-a2','booking-a2','student-a2',1000,NULL),
  ('participant-b','booking-b','student-b',1000,'package-b');
INSERT INTO "Payment" ("id","businessId","studentId","bookingId","kind","instructorId","amount") VALUES
  ('receipt-a','club-a','student-a','booking-a','STUDENT_TO_CLUB',NULL,1000),
  ('payout-a','club-a',NULL,'booking-a','CLUB_TO_COACH','coach-a',500);
COMMIT;`;

const requestValues = (id: string, businessId: string, bookingId: string, role: string,
  requester: string | null, participant: string | null) => `
  INSERT INTO "RescheduleRequest"
    ("id","businessId","bookingId","requestedByRole","requestedByUserId","participantId","proposedStartAt","proposedEndAt","originalStartAt")
  VALUES (${[id, businessId, bookingId, role, requester, participant].map(value => value === null ? 'NULL' : `'${value}'`).join(',')},
    CURRENT_TIMESTAMP + INTERVAL '10 days', CURRENT_TIMESTAMP + INTERVAL '10 days 1 hour', CURRENT_TIMESTAMP + INTERVAL '1 day')`;

describe.sequential('database core tenancy invariants', () => {
  let admin: PrismaClient;
  const schemas = new Set<string>();

  async function createSchema() {
    const schema = `core_tenancy_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemas.add(schema);
    return schema;
  }

  async function dropSchema(schema: string) {
    if (!/^core_tenancy_[a-f0-9_]+$/.test(schema)) throw new Error(`Refusing to drop ${schema}`);
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    schemas.delete(schema);
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Migration tests require local PostgreSQL');
    }
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    await admin.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    if (!admin) return;
    for (const schema of schemas) await dropSchema(schema);
    await admin.$disconnect();
  });

  it('applies the fresh chain and enforces every core relationship', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);
      executeSql(url, fixture);

      await db.$executeRawUnsafe(requestValues(
        'valid-student-request', 'club-a', 'booking-a', 'STUDENT', 'student-a-account', 'participant-a',
      ));
      await db.$executeRawUnsafe(requestValues(
        'valid-coach-request', 'club-a', 'booking-a', 'COACH', 'coach-a-account', null,
      ));
      await db.$executeRawUnsafe(requestValues(
        'valid-club-request', 'club-a', 'booking-a', 'CLUB', 'club-a-account', null,
      ));
      await db.$executeRawUnsafe(requestValues(
        'valid-cancellable-request', 'club-a', 'booking-a2', 'STUDENT', 'student-a2-account', 'participant-a2',
      ));

      // A final valid graph may be repaired within one transaction because the
      // cross-table assertions run at commit rather than after each statement.
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "Booking" SET "serviceId"='service-b' WHERE id='booking-a2'`);
        await tx.$executeRawUnsafe(`UPDATE "Booking" SET "serviceId"='service-a' WHERE id='booking-a2'`);
      });
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(requestValues(
          'transactional-student-request', 'club-a', 'booking-a2', 'STUDENT', 'student-a-account', 'transactional-participant',
        ));
        await tx.$executeRawUnsafe(`
          INSERT INTO "Participant" (id,"bookingId","studentId",price)
          VALUES ('transactional-participant','booking-a2','student-a',1000)
        `);
      });
      // Tenant identity is immutable on every reusable catalog/booking parent,
      // while harmless assignments of the existing value remain valid.
      for (const [table, id] of [
        ['Service', 'service-a'], ['Location', 'court-a'], ['Instructor', 'coach-a'],
        ['Booking', 'booking-a'], ['Student', 'student-a'],
      ] as const) {
        await db.$executeRawUnsafe(
          `UPDATE "${table}" SET "businessId"="businessId" WHERE id='${id}'`,
        );
      }

      const parentMutations = [
        ['Service', `UPDATE "Service" SET "businessId"='club-b' WHERE id='service-a'`, `
          SELECT 'Booking' AS kind, id, "businessId" FROM "Booking"
          WHERE "serviceId"='service-a' ORDER BY kind, id
        `],
        ['Location', `UPDATE "Location" SET "businessId"='club-b' WHERE id='court-a'`, `
          SELECT 'Availability' AS kind, id, "businessId" FROM "Availability"
          WHERE "locationId"='court-a'
          UNION ALL
          SELECT 'Booking' AS kind, id, "businessId" FROM "Booking"
          WHERE "locationId"='court-a' ORDER BY kind, id
        `],
        ['Instructor', `UPDATE "Instructor" SET "businessId"='club-b' WHERE id='coach-a'`, `
          SELECT 'Availability' AS kind, id, "businessId" FROM "Availability"
          WHERE "instructorId"='coach-a'
          UNION ALL
          SELECT 'AvailabilityException' AS kind, id, "businessId" FROM "AvailabilityException"
          WHERE "instructorId"='coach-a'
          UNION ALL
          SELECT 'Booking' AS kind, id, "businessId" FROM "Booking"
          WHERE "instructorId"='coach-a'
          UNION ALL
          SELECT 'Membership' AS kind, id, "businessId" FROM "Membership"
          WHERE "instructorId"='coach-a'
          UNION ALL
          SELECT 'Payment' AS kind, id, "businessId" FROM "Payment"
          WHERE "instructorId"='coach-a' ORDER BY kind, id
        `],
        ['Booking', `UPDATE "Booking" SET "businessId"='club-b' WHERE id='booking-a'`, `
          SELECT 'Payment' AS kind, id, "businessId" FROM "Payment"
          WHERE "bookingId"='booking-a'
          UNION ALL
          SELECT 'RescheduleRequest' AS kind, id, "businessId" FROM "RescheduleRequest"
          WHERE "bookingId"='booking-a' ORDER BY kind, id
        `],
        ['Student', `UPDATE "Student" SET "businessId"='club-b' WHERE id='student-a'`, `
          SELECT 'LessonPackage' AS kind, id, "businessId" FROM "LessonPackage"
          WHERE "studentId"='student-a'
          UNION ALL
          SELECT 'Payment' AS kind, id, "businessId" FROM "Payment"
          WHERE "studentId"='student-a' ORDER BY kind, id
        `],
      ] as const;
      for (const [parent, update, dependentQuery] of parentMutations) {
        const before = await db.$queryRawUnsafe<Array<{ kind: string; id: string; businessId: string }>>(
          dependentQuery,
        );
        expect(before.length, `${parent} fixture must exercise a tenant-bearing child`).toBeGreaterThan(0);
        expect(before.every(row => row.businessId === 'club-a')).toBe(true);
        await expectSqlState23514(() => db.$executeRawUnsafe(update));
        expect(await db.$queryRawUnsafe(dependentQuery), `${parent} must not cascade into its children`)
          .toEqual(before);
      }

      await expect(db.$executeRawUnsafe(`UPDATE "LessonPackage" SET "serviceId"='service-b' WHERE id='package-a'`))
        .rejects.toThrow('LessonPackage_serviceId_businessId_fkey');
      await expectSqlState23514(() => db.$executeRawUnsafe(
        `UPDATE "Service" SET "businessId"='club-b' WHERE id='package-service-a'`,
      ));
      expect(await db.lessonPackage.findUniqueOrThrow({
        where: { id: 'package-a' },
        select: { businessId: true, serviceId: true },
      }))
        .toMatchObject({ businessId: 'club-a', serviceId: 'package-service-a' });
      await db.$executeRawUnsafe(`DELETE FROM "Service" WHERE id='deletable-package-service-a'`);
      expect(await db.lessonPackage.findUniqueOrThrow({
        where: { id: 'deletable-package' },
        select: { businessId: true, serviceId: true },
      }))
        .toMatchObject({ businessId: 'club-a', serviceId: null });

      const invalidWrites = [
        ['booking service', 'Booking_serviceId_businessId_fkey',
          `UPDATE "Booking" SET "serviceId"='service-b' WHERE id='booking-a'`],
        ['booking instructor', 'Booking_instructorId_businessId_fkey',
          `UPDATE "Booking" SET "instructorId"='coach-b' WHERE id='booking-a'`],
        ['booking location', 'Booking_locationId_businessId_fkey',
          `UPDATE "Booking" SET "locationId"='court-b' WHERE id='booking-a'`],
        ['participant student', 'Participant student must belong to the booking business',
          `UPDATE "Participant" SET "studentId"='student-b' WHERE id='participant-a2'`],
        ['service location', 'Service location must belong to the service business',
          `INSERT INTO "ServiceLocation" (id,"serviceId","locationId",price,duration) VALUES ('bad-service-location','service-a','court-b',1000,60)`],
        ['service instructor', 'Service instructor must belong to the service business',
          `INSERT INTO "ServiceInstructor" ("serviceLocationId","instructorId") VALUES ('service-location-a','coach-b')`],
        ['availability instructor', 'Availability_instructorId_businessId_fkey',
          `INSERT INTO "Availability" (id,"businessId","instructorId","locationId","dayOfWeek","startTime","endTime") VALUES ('bad-availability-instructor','club-a','coach-b','court-a',2,'09:00','10:00')`],
        ['availability location', 'Availability_locationId_businessId_fkey',
          `INSERT INTO "Availability" (id,"businessId","instructorId","locationId","dayOfWeek","startTime","endTime") VALUES ('bad-availability-location','club-a','coach-a','court-b',2,'09:00','10:00')`],
        ['availability exception', 'AvailabilityException_instructorId_businessId_fkey',
          `INSERT INTO "AvailabilityException" (id,"businessId","instructorId",date) VALUES ('bad-exception','club-b','coach-a','2030-01-02')`],
        ['request business', 'RescheduleRequest_bookingId_businessId_fkey',
          requestValues('bad-request-business', 'club-b', 'booking-a', 'CLUB', null, null)],
        ['student request shape', 'RescheduleRequest_requester_shape_check',
          requestValues('bad-student-shape', 'club-a', 'booking-a', 'STUDENT', null, null)],
        ['provider request shape', 'RescheduleRequest_requester_shape_check',
          requestValues('bad-provider-shape', 'club-a', 'booking-a', 'CLUB', null, 'participant-a')],
        ['null student requester', 'New or retargeted reschedule requests require a requester account',
          requestValues('bad-null-student', 'club-a', 'booking-a', 'STUDENT', null, 'participant-a')],
        ['null coach requester', 'New or retargeted reschedule requests require a requester account',
          requestValues('bad-null-coach', 'club-a', 'booking-a', 'COACH', null, null)],
        ['null club requester', 'New or retargeted reschedule requests require a requester account',
          requestValues('bad-null-club', 'club-a', 'booking-a', 'CLUB', null, null)],
        ['request participant', 'Student reschedule requester must own an active participant in the named booking',
          requestValues('bad-request-participant', 'club-a', 'booking-a2', 'STUDENT', 'student-a-account', 'participant-a')],
        ['student requester', 'Student reschedule requester must own an active participant in the named booking',
          requestValues('bad-student-requester', 'club-a', 'booking-a', 'STUDENT', 'student-b-account', 'participant-a')],
        ['coach requester', 'Coach reschedule requester must be the active booking instructor account',
          requestValues('bad-coach-requester', 'club-a', 'booking-a', 'COACH', 'coach-b-account', null)],
        ['club requester', 'Club reschedule requester must be the active booking business account',
          requestValues('bad-club-requester', 'club-a', 'booking-a', 'CLUB', 'club-b-account', null)],
      ] as const;
      for (const [name, expected, statement] of invalidWrites) {
        await expect(db.$executeRawUnsafe(statement), name).rejects.toThrow(expected);
      }
      await db.$executeRawUnsafe(`UPDATE "Participant" SET "cancelledAt"=CURRENT_TIMESTAMP WHERE id='participant-a2'`);
      await expect(db.$executeRawUnsafe(requestValues(
        'bad-cancelled-participant', 'club-a', 'booking-a2', 'STUDENT', 'student-a2-account', 'participant-a2',
      ))).rejects.toThrow('Student reschedule requester must own an active participant in the named booking');
      // The earlier request remains valid historical provenance after the
      // participant later cancels; only raising or retargeting a request checks
      // the participant's current active state.
      expect(await db.rescheduleRequest.findUnique({ where: { id: 'valid-cancellable-request' } })).not.toBeNull();

      // Live authority is checked only when identity is established. A later
      // roster departure preserves the historical request and ordinary edits,
      // while the departed coach cannot create another request.
      await db.$executeRawUnsafe(`UPDATE "Membership" SET active=false WHERE id='coach-a-membership'`);
      await db.$executeRawUnsafe(`UPDATE "RescheduleRequest" SET message='retained after departure' WHERE id='valid-coach-request'`);
      await expect(db.$executeRawUnsafe(requestValues(
        'bad-inactive-coach', 'club-a', 'booking-a', 'COACH', 'coach-a-account', null,
      ))).rejects.toThrow('Coach reschedule requester must be the active booking instructor account');
      expect(await db.rescheduleRequest.findUniqueOrThrow({ where: { id: 'valid-coach-request' } }))
        .toMatchObject({ message: 'retained after departure', requestedByUserId: 'coach-a-account' });

      // The older account-shape invariant forbids committing an inactive club
      // account. Force this request constraint before rollback to isolate its
      // active-affiliation guarantee.
      await expect(db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "Membership" SET active=false WHERE id='club-a-membership'`);
        await tx.$executeRawUnsafe(requestValues(
          'bad-inactive-club', 'club-a', 'booking-a', 'CLUB', 'club-a-account', null,
        ));
        await tx.$executeRawUnsafe(`SET CONSTRAINTS "RescheduleRequest_live_actor_on_insert" IMMEDIATE`);
      })).rejects.toThrow('Club reschedule requester must be the active booking business account');

      const tenantForeignKeys = await db.$queryRawUnsafe<Array<{ name: string; updateAction: string }>>(`
        SELECT constraint_row.conname AS name, constraint_row.confupdtype::text AS "updateAction"
        FROM pg_constraint AS constraint_row
        JOIN pg_class AS source_table ON source_table.oid = constraint_row.conrelid
        JOIN pg_class AS target_table ON target_table.oid = constraint_row.confrelid
        WHERE constraint_row.connamespace = current_schema()::regnamespace
          AND constraint_row.contype = 'f'
          AND cardinality(constraint_row.conkey) > 1
          AND EXISTS (
            SELECT 1 FROM unnest(constraint_row.conkey) AS source_key(attnum)
            JOIN pg_attribute AS source_attribute
              ON source_attribute.attrelid = source_table.oid
             AND source_attribute.attnum = source_key.attnum
            WHERE source_attribute.attname = 'businessId'
          )
          AND EXISTS (
            SELECT 1 FROM unnest(constraint_row.confkey) AS target_key(attnum)
            JOIN pg_attribute AS target_attribute
              ON target_attribute.attrelid = target_table.oid
             AND target_attribute.attnum = target_key.attnum
            WHERE target_attribute.attname = 'businessId'
          )
      `);
      expect(tenantForeignKeys.map(constraint => constraint.name).sort()).toEqual([
        'AvailabilityException_instructorId_businessId_fkey',
        'Availability_instructorId_businessId_fkey',
        'Availability_locationId_businessId_fkey',
        'Booking_instructorId_businessId_fkey',
        'Booking_locationId_businessId_fkey',
        'Booking_serviceId_businessId_fkey',
        'LessonPackage_serviceId_businessId_fkey',
        'LessonPackage_studentId_businessId_fkey',
        'Membership_instructorId_businessId_fkey',
        'Payment_bookingId_businessId_fkey',
        'Payment_instructorId_businessId_fkey',
        'Payment_packageId_businessId_fkey',
        'Payment_studentId_businessId_fkey',
        'RescheduleRequest_bookingId_businessId_fkey',
      ].sort());
      expect(tenantForeignKeys.every(constraint => constraint.updateAction === 'a')).toBe(true);

      const immutableTriggers = await db.$queryRawUnsafe<Array<{
        name: string; tableName: string; functionName: string; before: boolean; row: boolean; update: boolean;
      }>>(`
        SELECT trigger.tgname AS name, trigger_table.relname AS "tableName",
          trigger_function.proname AS "functionName",
          (trigger.tgtype & 2) <> 0 AS before, (trigger.tgtype & 1) <> 0 AS row,
          (trigger.tgtype & 16) <> 0 AS update
        FROM pg_trigger AS trigger
        JOIN pg_class AS trigger_table ON trigger_table.oid = trigger.tgrelid
        JOIN pg_proc AS trigger_function ON trigger_function.oid = trigger.tgfoid
        WHERE trigger_table.relnamespace = current_schema()::regnamespace
          AND trigger.tgname IN (
            'Service_businessId_immutable', 'Location_businessId_immutable',
            'Instructor_businessId_immutable', 'Booking_businessId_immutable',
            'Student_businessId_immutable'
          )
        ORDER BY trigger.tgname
      `);
      expect(immutableTriggers).toEqual([
        { name: 'Booking_businessId_immutable', tableName: 'Booking', functionName: '_courtly_reject_business_id_change', before: true, row: true, update: true },
        { name: 'Instructor_businessId_immutable', tableName: 'Instructor', functionName: '_courtly_reject_business_id_change', before: true, row: true, update: true },
        { name: 'Location_businessId_immutable', tableName: 'Location', functionName: '_courtly_reject_business_id_change', before: true, row: true, update: true },
        { name: 'Service_businessId_immutable', tableName: 'Service', functionName: '_courtly_reject_business_id_change', before: true, row: true, update: true },
        { name: 'Student_businessId_immutable', tableName: 'Student', functionName: '_courtly_reject_business_id_change', before: true, row: true, update: true },
      ]);
      expect(await db.$queryRawUnsafe(`
        SELECT count(*) AS count FROM pg_proc
        WHERE pronamespace = current_schema()::regnamespace
          AND proname = '_courtly_reject_business_id_change'
          AND prorettype = 'trigger'::regtype
      `)).toEqual([{ count: 1n }]);
      expect(await db.$queryRawUnsafe(`
        SELECT tgname AS name FROM pg_trigger
        WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace)
          AND tgname IN (
            'Service_catalog_link_tenant_invariant', 'Location_catalog_link_tenant_invariant',
            'Instructor_catalog_link_tenant_invariant', 'Booking_participant_tenant_invariant',
            'Student_participant_tenant_invariant'
          )
      `)).toEqual([]);

      const triggers = await db.$queryRawUnsafe<Array<{ name: string; deferred: boolean }>>(`
        SELECT trigger.tgname AS name, constraint_row.condeferred AS deferred
        FROM pg_trigger AS trigger
        JOIN pg_constraint AS constraint_row ON constraint_row.oid = trigger.tgconstraint
        JOIN pg_class AS trigger_table ON trigger_table.oid = trigger.tgrelid
        WHERE (trigger.tgname LIKE '%tenant_invariant'
          OR trigger.tgname LIKE 'RescheduleRequest_live_actor_%')
          AND trigger_table.relnamespace = current_schema()::regnamespace
        ORDER BY trigger.tgname
      `);
      expect(triggers).toEqual([
        { name: 'Participant_tenant_invariant', deferred: true },
        { name: 'RescheduleRequest_live_actor_on_insert', deferred: true },
        { name: 'RescheduleRequest_live_actor_on_retarget', deferred: true },
        { name: 'ServiceInstructor_tenant_invariant', deferred: true },
        { name: 'ServiceLocation_tenant_invariant', deferred: true },
      ]);
      expect(await db.rescheduleRequest.count()).toBe(5);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 120_000);

  it('preserves historical null requesters but rejects identity retargeting without an actor', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `${fixture} ${requestValues(
        'historical-null-requester', 'club-a', 'booking-a', 'STUDENT', null, 'participant-a',
      )};`);

      applyMigration(url, coreMigration);
      await db.$executeRawUnsafe(`
        UPDATE "RescheduleRequest"
        SET status='WITHDRAWN', message='legacy history retained'
        WHERE id='historical-null-requester'
      `);
      expect(await db.rescheduleRequest.findUniqueOrThrow({ where: { id: 'historical-null-requester' } }))
        .toMatchObject({ requestedByUserId: null, status: 'WITHDRAWN', message: 'legacy history retained' });
      await expect(db.$executeRawUnsafe(`
        UPDATE "RescheduleRequest" SET "requestedByUserId"=NULL, "participantId"='participant-a2'
        WHERE id='historical-null-requester'
      `)).rejects.toThrow('New or retargeted reschedule requests require a requester account');
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 120_000);

  it('serializes request authorization with participant cancellation and coach deactivation', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const requester = new PrismaClient({ datasourceUrl: url });
    const canceller = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);
      executeSql(url, fixture);

      let actorChecked!: () => void;
      const actorCheck = new Promise<void>(resolve => { actorChecked = resolve; });
      const inserted = requester.$transaction(async tx => {
        await tx.$executeRawUnsafe(requestValues(
          'racing-request', 'club-a', 'booking-a', 'STUDENT', 'student-a-account', 'participant-a',
        ));
        // Force the deferred trigger while the transaction remains open. The
        // trigger's FOR SHARE lock must hold cancellation until this commits.
        await tx.$executeRawUnsafe(`SET CONSTRAINTS "RescheduleRequest_live_actor_on_insert" IMMEDIATE`);
        actorChecked();
        await new Promise(resolve => setTimeout(resolve, 400));
      }, { timeout: 10_000 });
      await actorCheck;

      let cancellationFinished = false;
      const cancelled = canceller.$executeRawUnsafe(`
        UPDATE "Participant" SET "cancelledAt"=CURRENT_TIMESTAMP WHERE id='participant-a'
      `).then(() => { cancellationFinished = true; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(cancellationFinished).toBe(false);
      await inserted;
      await cancelled;
      expect(await requester.rescheduleRequest.findUnique({ where: { id: 'racing-request' } })).not.toBeNull();

      let coachChecked!: () => void;
      const coachCheck = new Promise<void>(resolve => { coachChecked = resolve; });
      const coachInserted = requester.$transaction(async tx => {
        await tx.$executeRawUnsafe(requestValues(
          'racing-coach-request', 'club-a', 'booking-a', 'COACH', 'coach-a-account', null,
        ));
        await tx.$executeRawUnsafe(`SET CONSTRAINTS "RescheduleRequest_live_actor_on_insert" IMMEDIATE`);
        coachChecked();
        await new Promise(resolve => setTimeout(resolve, 400));
      }, { timeout: 10_000 });
      await coachCheck;

      let deactivationFinished = false;
      const deactivated = canceller.$executeRawUnsafe(`
        UPDATE "Membership" SET active=false WHERE id='coach-a-membership'
      `).then(() => { deactivationFinished = true; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(deactivationFinished).toBe(false);
      await coachInserted;
      await deactivated;
      expect(await requester.rescheduleRequest.findUnique({ where: { id: 'racing-coach-request' } })).not.toBeNull();
    } finally {
      await requester.$disconnect();
      await canceller.$disconnect();
      await dropSchema(schema);
    }
  }, 120_000);

  it('rejects concurrent connected parent tenant moves without deadlocking', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const serviceWriter = new PrismaClient({ datasourceUrl: url });
    const bookingWriter = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);
      executeSql(url, fixture);

      const results = await Promise.allSettled([
        serviceWriter.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='2s'`);
          return tx.$executeRawUnsafe(
            `UPDATE "Service" SET "businessId"='club-b' WHERE id='service-a'`,
          );
        }),
        bookingWriter.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout='2s'`);
          return tx.$executeRawUnsafe(
            `UPDATE "Booking" SET "businessId"='club-b' WHERE id='booking-a'`,
          );
        }),
      ]);
      expect(results.every(result => result.status === 'rejected')).toBe(true);
      for (const result of results) {
        if (result.status === 'rejected') expectSqlState(result.reason, '23514');
      }
      expect(await serviceWriter.$queryRawUnsafe(`
        SELECT 'Booking' AS kind, id, "businessId" FROM "Booking" WHERE id='booking-a'
        UNION ALL
        SELECT 'Service' AS kind, id, "businessId" FROM "Service" WHERE id='service-a'
        ORDER BY kind
      `)).toEqual([
        { kind: 'Booking', id: 'booking-a', businessId: 'club-a' },
        { kind: 'Service', id: 'service-a', businessId: 'club-a' },
      ]);
    } finally {
      await serviceWriter.$disconnect();
      await bookingWriter.$disconnect();
      await dropSchema(schema);
    }
  }, 120_000);

  it.each([
    ['booking catalog edge', 'Booking service must belong to the booking business',
      `UPDATE "Booking" SET "serviceId"='service-b' WHERE id='booking-a'`,
      `SELECT "serviceId" AS value FROM "Booking" WHERE id='booking-a'`, 'service-b'],
    ['participant edge', 'Participant student must belong to the booking business',
      `UPDATE "Participant" SET "studentId"='student-b' WHERE id='participant-a2'`,
      `SELECT "studentId" AS value FROM "Participant" WHERE id='participant-a2'`, 'student-b'],
    ['package service edge', 'Lesson package service must belong to the package business',
      `UPDATE "LessonPackage" SET "serviceId"='service-b' WHERE id='package-a'`,
      `SELECT "serviceId" AS value FROM "LessonPackage" WHERE id='package-a'`, 'service-b'],
    ['service-location edge', 'Service location must belong to the service business',
      `INSERT INTO "ServiceLocation" (id,"serviceId","locationId",price,duration) VALUES ('historical-bad','service-a','court-b',1000,60)`,
      `SELECT "locationId" AS value FROM "ServiceLocation" WHERE id='historical-bad'`, 'court-b'],
    ['service-instructor edge', 'Service instructor must belong to the service business',
      `INSERT INTO "ServiceInstructor" ("serviceLocationId","instructorId") VALUES ('service-location-a','coach-b')`,
      `SELECT "instructorId" AS value FROM "ServiceInstructor" WHERE "serviceLocationId"='service-location-a' AND "instructorId"='coach-b'`, 'coach-b'],
    ['availability edge', 'Availability location must belong to the availability business',
      `INSERT INTO "Availability" (id,"businessId","instructorId","locationId","dayOfWeek","startTime","endTime") VALUES ('historical-bad','club-a','coach-a','court-b',2,'09:00','10:00')`,
      `SELECT "locationId" AS value FROM "Availability" WHERE id='historical-bad'`, 'court-b'],
    ['availability-exception edge', 'Availability exception instructor must belong to the exception business',
      `INSERT INTO "AvailabilityException" (id,"businessId","instructorId",date) VALUES ('historical-bad','club-b','coach-a','2030-01-02')`,
      `SELECT "instructorId" AS value FROM "AvailabilityException" WHERE id='historical-bad'`, 'coach-a'],
    ['reschedule provenance', 'Student reschedule requester must own the named participant',
      requestValues('historical-bad', 'club-a', 'booking-a', 'STUDENT', 'student-b-account', 'participant-a'),
      `SELECT "requestedByUserId" AS value FROM "RescheduleRequest" WHERE id='historical-bad'`, 'student-b-account'],
  ])('rejects historical %s atomically', async (_name, expected, corruptSql, retainedSql, retainedValue) => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `${fixture} ${corruptSql};`);

      const result = run(url, ['--file', coreMigration]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
      expect(await db.$queryRawUnsafe(retainedSql)).toEqual([{ value: retainedValue }]);
      expect(await db.$queryRawUnsafe(`
        SELECT count(*) AS count FROM pg_proc
        WHERE pronamespace=current_schema()::regnamespace
          AND proname IN (
            '_courtly_reject_business_id_change',
            '_courtly_assert_catalog_link_tenancy', '_courtly_catalog_link_tenancy_constraint',
            '_courtly_assert_participant_tenancy', '_courtly_participant_tenancy_constraint',
            '_courtly_assert_live_reschedule_request_actor'
          )
      `)).toEqual([{ count: 0n }]);
      expect(await db.$queryRawUnsafe(`
        SELECT count(*) AS count FROM pg_constraint
        WHERE conname='RescheduleRequest_requester_shape_check'
          AND connamespace=current_schema()::regnamespace
      `)).toEqual([{ count: 0n }]);
      expect(await db.$queryRawUnsafe(`
        SELECT to_regclass(current_schema() || '."Service_id_businessId_key"')::text AS index
      `)).toEqual([{ index: null }]);
      expect(await db.$queryRawUnsafe(`
        SELECT count(*) AS count FROM pg_constraint
        WHERE connamespace=current_schema()::regnamespace
          AND conname IN (
            'Booking_serviceId_businessId_fkey', 'Booking_instructorId_businessId_fkey',
            'Booking_locationId_businessId_fkey', 'LessonPackage_serviceId_businessId_fkey',
            'Availability_instructorId_businessId_fkey', 'Availability_locationId_businessId_fkey',
            'AvailabilityException_instructorId_businessId_fkey',
            'RescheduleRequest_bookingId_businessId_fkey'
          )
      `)).toEqual([{ count: 0n }]);
      expect(await db.$queryRawUnsafe(`
        SELECT count(*) AS count FROM pg_trigger
        WHERE (tgname LIKE '%tenant_invariant' OR tgname LIKE 'RescheduleRequest_live_actor_%'
          OR tgname LIKE '%_businessId_immutable')
          AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace=current_schema()::regnamespace)
      `)).toEqual([{ count: 0n }]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 120_000);
});
