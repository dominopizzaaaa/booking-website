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
  '20260917205000_single_club_account_per_club',
  '20260917210000_account_shape_invariants',
  '20260917220000_payment_party_invariants',
  '20260917230000_identity_tenancy_invariants',
  '20260917240000_financial_target_invariants',
] as const;
const migrationFiles = migrationNames.map(name =>
  fileURLToPath(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)));
const financialMigration = migrationFiles.at(-1)!;
const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

function isolatedUrl(schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function runSql(url: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, ...args], {
    encoding: 'utf8',
    env: process.env,
    input,
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
    throw new Error(`Failed to execute fixture SQL:\n${result.stdout}\n${result.stderr}`);
  }
}

const fixture = `
BEGIN;
INSERT INTO "Business" ("id","name","slug","ownerName","email","kind")
  VALUES ('club','Club','financial-club','Club','club@example.test','CLUB');
INSERT INTO "User" ("id","name","email","passwordHash","accountType") VALUES
  ('club-account','Club','club-account@example.test','hash','CLUB'),
  ('coach-account','Coach','coach@example.test','hash','COACH'),
  ('student-a-account','Student A','student-a@example.test','hash','STUDENT'),
  ('student-b-account','Student B','student-b@example.test','hash','STUDENT');
INSERT INTO "Instructor" ("id","businessId","name","initials")
  VALUES ('coach','club','Coach','CO');
INSERT INTO "Membership" ("id","userId","businessId","instructorId") VALUES
  ('club-membership','club-account','club',NULL),
  ('coach-membership','coach-account','club','coach');
INSERT INTO "Student" ("id","businessId","userId","name","email","initials") VALUES
  ('student-a','club','student-a-account','Student A','student-a@example.test','SA'),
  ('student-b','club','student-b-account','Student B','student-b@example.test','SB');
INSERT INTO "Location" ("id","businessId","name") VALUES ('court','club','Court');
INSERT INTO "Service" ("id","businessId","name") VALUES ('service','club','Lesson');
INSERT INTO "Booking" ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute") VALUES
  ('booking','club','service','coach','court',CURRENT_TIMESTAMP + INTERVAL '1 day',CURRENT_TIMESTAMP + INTERVAL '1 day 1 hour',60,'PRIVATE',1,1000,'CLUB'),
  ('booking-b','club','service','coach','court',CURRENT_TIMESTAMP + INTERVAL '2 days',CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour',60,'PRIVATE',1,1000,'CLUB'),
  ('booking-deferred','club','service','coach','court',CURRENT_TIMESTAMP + INTERVAL '3 days',CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour',60,'PRIVATE',1,1000,'CLUB');
INSERT INTO "LessonPackage" ("id","businessId","studentId","name","totalCredits","price","expiresAt") VALUES
  ('package-a','club','student-a','Package A',5,5000,CURRENT_TIMESTAMP + INTERVAL '30 days'),
  ('package-b','club','student-b','Package B',5,5000,CURRENT_TIMESTAMP + INTERVAL '30 days');
INSERT INTO "Participant" ("id","bookingId","studentId","price") VALUES
  ('participant-a','booking','student-a',1000),
  ('participant-b','booking-b','student-b',1000);
COMMIT;`;

type ForeignKeyCatalogRow = {
  name: string;
  type: string;
  sourceTable: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
  matchType: string;
  deleteAction: string;
  updateAction: string;
  targetTable: string;
  columns: string[];
  targetColumns: string[];
};

type CheckCatalogRow = {
  name: string;
  type: string;
  sourceTable: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
  validated: boolean;
  definition: string;
};

type IndexCatalogRow = {
  name: string;
  sourceTable: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  unpredicated: boolean;
  notExpression: boolean;
  columns: string[];
};

describe.sequential('database financial party and target invariants', () => {
  let admin: PrismaClient;
  const schemas = new Set<string>();

  async function createSchema() {
    const schema = `financial_target_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemas.add(schema);
    return schema;
  }

  async function dropSchema(schema: string) {
    if (!/^financial_target_[a-f0-9_]+$/.test(schema)) {
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

  it('installs row checks and deferred composite foreign keys without runtime financial triggers', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);
      executeSql(url, fixture);

      const foreignKeys = await db.$queryRawUnsafe<ForeignKeyCatalogRow[]>(`
        SELECT
          constraint_record.conname AS name,
          constraint_record.contype::text AS type,
          source_table.relname AS "sourceTable",
          constraint_record.condeferrable AS deferrable,
          constraint_record.condeferred AS "initiallyDeferred",
          constraint_record.convalidated AS validated,
          constraint_record.confmatchtype::text AS "matchType",
          constraint_record.confdeltype::text AS "deleteAction",
          constraint_record.confupdtype::text AS "updateAction",
          target_table.relname AS "targetTable",
          ARRAY(
            SELECT attribute.attname
            FROM unnest(constraint_record.conkey) WITH ORDINALITY AS key_column(attnum, position)
            JOIN pg_attribute AS attribute
              ON attribute.attrelid = constraint_record.conrelid
             AND attribute.attnum = key_column.attnum
            ORDER BY key_column.position
          ) AS columns,
          ARRAY(
            SELECT attribute.attname
            FROM unnest(constraint_record.confkey) WITH ORDINALITY AS key_column(attnum, position)
            JOIN pg_attribute AS attribute
              ON attribute.attrelid = constraint_record.confrelid
             AND attribute.attnum = key_column.attnum
            ORDER BY key_column.position
          ) AS "targetColumns"
        FROM pg_constraint AS constraint_record
        JOIN pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
        JOIN pg_class AS source_table ON source_table.oid = constraint_record.conrelid
        JOIN pg_class AS target_table ON target_table.oid = constraint_record.confrelid
        WHERE namespace.nspname = current_schema()
          AND constraint_record.conname IN (
            'Participant_packageId_fkey',
            'Participant_packageId_studentId_fkey',
            'Payment_bookingId_studentId_fkey',
            'Payment_packageId_studentId_fkey'
          )
        ORDER BY constraint_record.conname
      `);
      expect(foreignKeys).toEqual([
        {
          name: 'Participant_packageId_studentId_fkey',
          type: 'f',
          sourceTable: 'Participant',
          validated: true, matchType: 's',
          deferrable: true, initiallyDeferred: true, deleteAction: 'a', updateAction: 'a',
          targetTable: 'LessonPackage', columns: ['packageId', 'studentId'], targetColumns: ['id', 'studentId'],
        },
        {
          name: 'Payment_bookingId_studentId_fkey',
          type: 'f',
          sourceTable: 'Payment',
          validated: true, matchType: 's',
          deferrable: true, initiallyDeferred: true, deleteAction: 'a', updateAction: 'a',
          targetTable: 'Participant', columns: ['bookingId', 'studentId'], targetColumns: ['bookingId', 'studentId'],
        },
        {
          name: 'Payment_packageId_studentId_fkey',
          type: 'f',
          sourceTable: 'Payment',
          validated: true, matchType: 's',
          deferrable: true, initiallyDeferred: true, deleteAction: 'a', updateAction: 'a',
          targetTable: 'LessonPackage', columns: ['packageId', 'studentId'], targetColumns: ['id', 'studentId'],
        },
      ]);

      const checks = await db.$queryRawUnsafe<CheckCatalogRow[]>(`
        SELECT
          constraint_record.conname AS name,
          constraint_record.contype::text AS type,
          source_table.relname AS "sourceTable",
          constraint_record.condeferrable AS deferrable,
          constraint_record.condeferred AS "initiallyDeferred",
          constraint_record.convalidated AS validated,
          pg_get_constraintdef(constraint_record.oid) AS definition
        FROM pg_constraint AS constraint_record
        JOIN pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
        JOIN pg_class AS source_table ON source_table.oid = constraint_record.conrelid
        WHERE namespace.nspname = current_schema()
          AND constraint_record.contype = 'c'
          AND constraint_record.conname IN (
            'Payment_single_target_check',
            'Payment_payout_without_package_check'
          )
        ORDER BY constraint_record.conname
      `);
      expect(checks).toEqual([
        {
          name: 'Payment_payout_without_package_check', type: 'c', sourceTable: 'Payment',
          deferrable: false, initiallyDeferred: false, validated: true,
          definition: expect.stringMatching(/kind.*<>.*CLUB_TO_COACH[\s\S]*packageId.*IS NULL/),
        },
        {
          name: 'Payment_single_target_check', type: 'c', sourceTable: 'Payment',
          deferrable: false, initiallyDeferred: false, validated: true,
          definition: expect.stringMatching(/bookingId.*IS NOT NULL[\s\S]*packageId.*IS NOT NULL/),
        },
      ]);

      const indexes = await db.$queryRawUnsafe<IndexCatalogRow[]>(`
        SELECT
          index_table.relname AS name,
          source_table.relname AS "sourceTable",
          index_record.indisunique AS "unique",
          index_record.indisvalid AS valid,
          index_record.indisready AS ready,
          index_record.indpred IS NULL AS unpredicated,
          index_record.indexprs IS NULL AS "notExpression",
          ARRAY(
            SELECT attribute.attname
            FROM unnest(index_record.indkey) WITH ORDINALITY AS key_column(attnum, position)
            JOIN pg_attribute AS attribute
              ON attribute.attrelid = index_record.indrelid
             AND attribute.attnum = key_column.attnum
            ORDER BY key_column.position
          ) AS columns
        FROM pg_index AS index_record
        JOIN pg_class AS index_table ON index_table.oid = index_record.indexrelid
        JOIN pg_class AS source_table ON source_table.oid = index_record.indrelid
        JOIN pg_namespace AS namespace ON namespace.oid = index_table.relnamespace
        WHERE namespace.nspname = current_schema()
          AND index_table.relname IN (
            'LessonPackage_id_studentId_key',
            'Participant_packageId_studentId_idx',
            'Payment_bookingId_studentId_idx',
            'Payment_packageId_studentId_idx'
          )
        ORDER BY index_table.relname
      `);
      expect(indexes).toEqual([
        { name: 'LessonPackage_id_studentId_key', sourceTable: 'LessonPackage', unique: true, valid: true, ready: true, unpredicated: true, notExpression: true, columns: ['id', 'studentId'] },
        { name: 'Participant_packageId_studentId_idx', sourceTable: 'Participant', unique: false, valid: true, ready: true, unpredicated: true, notExpression: true, columns: ['packageId', 'studentId'] },
        { name: 'Payment_bookingId_studentId_idx', sourceTable: 'Payment', unique: false, valid: true, ready: true, unpredicated: true, notExpression: true, columns: ['bookingId', 'studentId'] },
        { name: 'Payment_packageId_studentId_idx', sourceTable: 'Payment', unique: false, valid: true, ready: true, unpredicated: true, notExpression: true, columns: ['packageId', 'studentId'] },
      ]);

      expect(await db.$queryRawUnsafe<Array<{ name: string }>>(`
        SELECT procedure_record.proname AS name
        FROM pg_proc AS procedure_record
        JOIN pg_namespace AS namespace ON namespace.oid = procedure_record.pronamespace
        WHERE namespace.nspname = current_schema()
          AND procedure_record.proname IN (
            '_courtly_assert_financial_targets',
            '_courtly_financial_target_constraint',
            '_courtly_lock_financial_target_writes'
          )
      `)).toEqual([]);
      expect(await db.$queryRawUnsafe<Array<{ name: string; sourceTable: string; function: string }>>(`
        SELECT
          trigger_record.tgname AS name,
          source_table.relname AS "sourceTable",
          procedure_record.proname AS function
        FROM pg_trigger AS trigger_record
        JOIN pg_class AS source_table ON source_table.oid = trigger_record.tgrelid
        JOIN pg_namespace AS namespace ON namespace.oid = source_table.relnamespace
        JOIN pg_proc AS procedure_record ON procedure_record.oid = trigger_record.tgfoid
        WHERE namespace.nspname = current_schema()
          AND NOT trigger_record.tgisinternal
          AND source_table.relname IN ('Payment', 'Participant', 'LessonPackage')
        ORDER BY source_table.relname, trigger_record.tgname
      `)).toEqual([
        { name: 'Payment_route_invariant', sourceTable: 'Payment', function: '_courtly_payment_route_constraint' },
      ]);

      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","bookingId","amount","kind") VALUES ('booking-receipt','club','student-a','booking',1000,'STUDENT_TO_CLUB')`);
      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","packageId","amount","kind") VALUES ('package-receipt','club','student-a','package-a',1000,'STUDENT_TO_CLUB')`);
      await db.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","instructorId","bookingId","amount","kind") VALUES ('payout','club',NULL,'coach','booking',500,'CLUB_TO_COACH')`);
      await db.$executeRawUnsafe(`UPDATE "Participant" SET "packageId"='package-a' WHERE "id"='participant-a'`);

      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","bookingId","packageId","amount","kind") VALUES ('dual','club','student-a','booking','package-a',1000,'STUDENT_TO_CLUB')`))
        .rejects.toThrow('Payment_single_target_check');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","instructorId","packageId","amount","kind") VALUES ('payout-package','club',NULL,'coach','package-a',500,'CLUB_TO_COACH')`))
        .rejects.toThrow('Payment_payout_without_package_check');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","bookingId","amount","kind") VALUES ('wrong-booking','club','student-b','booking',1000,'STUDENT_TO_CLUB')`))
        .rejects.toThrow('Payment_bookingId_studentId_fkey');
      await expect(db.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","packageId","amount","kind") VALUES ('wrong-package','club','student-b','package-a',1000,'STUDENT_TO_CLUB')`))
        .rejects.toThrow('Payment_packageId_studentId_fkey');
      await expect(db.$executeRawUnsafe(`UPDATE "Participant" SET "packageId"='package-b' WHERE "id"='participant-a'`))
        .rejects.toThrow('Participant_packageId_studentId_fkey');
      expect(await db.payment.count()).toBe(3);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it('checks the final transaction state for graph creation and ownership changes', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);
      executeSql(url, fixture);

      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","bookingId","amount","kind") VALUES ('deferred-receipt','club','student-b','booking-deferred',1000,'STUDENT_TO_CLUB')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Participant" ("id","bookingId","studentId","price") VALUES ('deferred-participant','booking-deferred','student-b',1000)`);
      });
      expect(await db.payment.findUnique({
        where: { id: 'deferred-receipt' },
        select: { id: true },
      })).not.toBeNull();

      let insertCompleted = false;
      await expect(db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","bookingId","amount","kind") VALUES ('missing-participant','club','student-b','booking',1000,'STUDENT_TO_CLUB')`);
        insertCompleted = true;
      })).rejects.toThrow('Payment_bookingId_studentId_fkey');
      expect(insertCompleted).toBe(true);
      expect(await db.payment.findUnique({
        where: { id: 'missing-participant' },
        select: { id: true },
      })).toBeNull();

      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "Participant" SET "packageId"='package-a' WHERE "id"='participant-a'`);
        await tx.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","bookingId","amount","kind") VALUES ('repair-booking-receipt','club','student-a','booking',1000,'STUDENT_TO_CLUB')`);
        await tx.$executeRawUnsafe(`INSERT INTO "Payment" ("id","businessId","studentId","packageId","amount","kind") VALUES ('repair-package-receipt','club','student-a','package-a',1000,'STUDENT_TO_CLUB')`);
      });
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "LessonPackage" SET "studentId"='student-b' WHERE "id"='package-a'`);
        await tx.$executeRawUnsafe(`UPDATE "Payment" SET "studentId"='student-b' WHERE "id"='repair-package-receipt'`);
        await tx.$executeRawUnsafe(`UPDATE "Participant" SET "studentId"='student-b' WHERE "id"='participant-a'`);
        await tx.$executeRawUnsafe(`UPDATE "Payment" SET "studentId"='student-b' WHERE "id"='repair-booking-receipt'`);
      });
      expect(await db.$queryRawUnsafe(`
        SELECT 'package' AS kind, "studentId" FROM "LessonPackage" WHERE "id"='package-a'
        UNION ALL
        SELECT 'participant' AS kind, "studentId" FROM "Participant" WHERE "id"='participant-a'
        UNION ALL
        SELECT "id" AS kind, "studentId" FROM "Payment" WHERE "id" IN ('repair-booking-receipt','repair-package-receipt')
        ORDER BY kind
      `)).toEqual([
        { kind: 'package', studentId: 'student-b' },
        { kind: 'participant', studentId: 'student-b' },
        { kind: 'repair-booking-receipt', studentId: 'student-b' },
        { kind: 'repair-package-receipt', studentId: 'student-b' },
      ]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it('does not serialize updates to unrelated participants', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);
      executeSql(url, fixture);

      let signalHeld!: () => void;
      let releaseHolder!: () => void;
      const held = new Promise<void>(resolve => { signalHeld = resolve; });
      const release = new Promise<void>(resolve => { releaseHolder = resolve; });
      const holder = db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "Participant" SET "notes"='held row' WHERE "id"='participant-a'`);
        signalHeld();
        await release;
      }, { timeout: 15_000 });
      void holder.catch(() => {});
      const holderFailed = new Promise<never>((_resolve, reject) => {
        void holder.catch(reject);
      });
      await Promise.race([
        held,
        holderFailed,
      ]);

      let unrelatedError: unknown;
      try {
        await db.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '500ms'`);
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '1500ms'`);
          await tx.$executeRawUnsafe(`UPDATE "Participant" SET "attendance"='PRESENT' WHERE "id"='participant-b'`);
        }, { timeout: 5_000 });
      } catch (error) {
        unrelatedError = error;
      } finally {
        releaseHolder();
      }
      await holder;
      if (unrelatedError) throw unrelatedError;
      expect(await db.participant.findUnique({ where: { id: 'participant-b' }, select: { attendance: true } }))
        .toEqual({ attendance: 'PRESENT' });
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it.each([
    {
      corruption: 'dual target',
      expected: 'Payment cannot target both a booking and a package',
      invalidSql: `INSERT INTO "Payment" ("id","businessId","studentId","bookingId","packageId","amount","kind") VALUES ('invalid','club','student-a','booking','package-a',1000,'STUDENT_TO_CLUB')`,
      persistedSql: `SELECT "id" AS value FROM "Payment" WHERE "id"='invalid'`,
      persisted: [{ value: 'invalid' }],
    },
    {
      corruption: 'payout with package',
      expected: 'Package payment student must own the named package',
      invalidSql: `INSERT INTO "Payment" ("id","businessId","studentId","instructorId","packageId","amount","kind") VALUES ('invalid','club',NULL,'coach','package-a',500,'CLUB_TO_COACH')`,
      persistedSql: `SELECT "id" AS value FROM "Payment" WHERE "id"='invalid'`,
      persisted: [{ value: 'invalid' }],
    },
    {
      corruption: 'non-participant booking receipt',
      expected: 'Booking payment student must participate in the named booking',
      invalidSql: `INSERT INTO "Payment" ("id","businessId","studentId","bookingId","amount","kind") VALUES ('invalid','club','student-b','booking',1000,'STUDENT_TO_CLUB')`,
      persistedSql: `SELECT "id" AS value FROM "Payment" WHERE "id"='invalid'`,
      persisted: [{ value: 'invalid' }],
    },
    {
      corruption: 'wrong package owner',
      expected: 'Package payment student must own the named package',
      invalidSql: `INSERT INTO "Payment" ("id","businessId","studentId","packageId","amount","kind") VALUES ('invalid','club','student-b','package-a',1000,'STUDENT_TO_CLUB')`,
      persistedSql: `SELECT "id" AS value FROM "Payment" WHERE "id"='invalid'`,
      persisted: [{ value: 'invalid' }],
    },
    {
      corruption: 'wrong participant package',
      expected: 'Participant package must belong to the participant student',
      invalidSql: `UPDATE "Participant" SET "packageId"='package-b' WHERE "id"='participant-a'`,
      persistedSql: `SELECT "packageId" AS value FROM "Participant" WHERE "id"='participant-a'`,
      persisted: [{ value: 'package-b' }],
    },
  ])('rejects historical $corruption atomically', async ({ expected, invalidSql, persistedSql, persisted }) => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `${fixture} ${invalidSql};`);

      const result = runSql(url, ['--file', financialMigration]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expected);
      expect(await db.$queryRawUnsafe(persistedSql)).toEqual(persisted);
      expect(await db.$queryRawUnsafe<Array<{ name: string }>>(`
        SELECT constraint_record.conname AS name
        FROM pg_constraint AS constraint_record
        JOIN pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = current_schema()
          AND constraint_record.conname IN (
            'Participant_packageId_fkey',
            'Participant_packageId_studentId_fkey',
            'Payment_bookingId_studentId_fkey',
            'Payment_packageId_studentId_fkey',
            'Payment_single_target_check',
            'Payment_payout_without_package_check'
          )
        ORDER BY constraint_record.conname
      `)).toEqual([{ name: 'Participant_packageId_fkey' }]);
      expect(await db.$queryRawUnsafe<Array<{ name: string }>>(`
        SELECT index_table.relname AS name
        FROM pg_class AS index_table
        JOIN pg_namespace AS namespace ON namespace.oid = index_table.relnamespace
        WHERE namespace.nspname = current_schema()
          AND index_table.relname IN (
            'LessonPackage_id_studentId_key',
            'Participant_packageId_studentId_idx',
            'Payment_bookingId_studentId_idx',
            'Payment_packageId_studentId_idx'
          )
      `)).toEqual([]);
      expect(await db.$queryRawUnsafe<Array<{ name: string }>>(`
        SELECT procedure_record.proname AS name
        FROM pg_proc AS procedure_record
        JOIN pg_namespace AS namespace ON namespace.oid = procedure_record.pronamespace
        WHERE namespace.nspname = current_schema()
          AND procedure_record.proname LIKE '%financial_target%'
      `)).toEqual([]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);
});
