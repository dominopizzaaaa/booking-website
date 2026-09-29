import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../src/config.js';

const databaseUrl = process.env.DATABASE_URL!;
const migrationsDirectory = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const guardianMigrationName = '20260929000000_guardian_child_accounts';
const migrationFiles = readdirSync(migrationsDirectory, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => ({
    name: entry.name,
    file: join(migrationsDirectory, entry.name, 'migration.sql'),
  }))
  .filter(migration => existsSync(migration.file))
  .sort((left, right) => left.name.localeCompare(right.name));
const guardianMigrationIndex = migrationFiles.findIndex(
  migration => migration.name === guardianMigrationName,
);
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
    throw new Error(`Failed fixture SQL:\n${result.stdout}\n${result.stderr}`);
  }
}

type RawDatabaseError = {
  code?: string;
  message?: string;
  meta?: { code?: string; message?: string };
};

async function expectSqlState(
  operation: () => Promise<unknown>,
  sqlState: string,
  message?: string,
) {
  try {
    await operation();
  } catch (error) {
    const databaseError = error as RawDatabaseError;
    expect(databaseError.code).toBe('P2010');
    expect(databaseError.meta?.code).toBe(sqlState);
    if (message) {
      expect(databaseError.meta?.message ?? databaseError.message).toContain(message);
    }
    return;
  }
  throw new Error(`Expected the database write to fail with SQLSTATE ${sqlState}`);
}

const previousReleaseFixture = `
BEGIN;
INSERT INTO "Business" ("id", "name", "slug", "ownerName", "email", "kind")
  VALUES ('legacy-club', 'Legacy Club', 'guardian-migration-club', 'Legacy Club',
    'legacy-club@example.test', 'CLUB');
INSERT INTO "User" ("id", "name", "username", "email", "passwordHash", "accountType") VALUES
  ('legacy-club-account', 'Legacy Club', 'legacy_club_account',
    'legacy-club-account@example.test', 'hash', 'CLUB'),
  ('legacy-user', 'Legacy Student', 'legacy_student',
    'legacy-student@example.test', NULL, 'STUDENT');
INSERT INTO "Membership" ("id", "userId", "businessId")
  VALUES ('legacy-club-membership', 'legacy-club-account', 'legacy-club');
INSERT INTO "Student" ("id", "businessId", "userId", "name", "email", "initials")
  VALUES ('legacy-student-row', 'legacy-club', 'legacy-user', 'Legacy Student',
    'legacy-student@example.test', 'LS');
COMMIT;`;

describe.sequential('guardian-managed child migration', () => {
  let admin: PrismaClient;
  const schemas = new Set<string>();

  async function createSchema() {
    const schema = `guardian_migration_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemas.add(schema);
    return schema;
  }

  async function dropSchema(schema: string) {
    if (!/^guardian_migration_[a-f0-9_]+$/.test(schema)) {
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
    if (guardianMigrationIndex < 0) {
      throw new Error(`Missing migration ${guardianMigrationName}`);
    }
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    await admin.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    if (!admin) return;
    for (const schema of schemas) await dropSchema(schema);
    await admin.$disconnect();
  });

  it('upgrades legacy identities and enforces the complete family-account contract', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });

    try {
      for (const migration of migrationFiles.slice(0, guardianMigrationIndex)) {
        applyMigration(url, migration.file);
      }
      executeSql(url, previousReleaseFixture);
      for (const migration of migrationFiles.slice(guardianMigrationIndex)) {
        applyMigration(url, migration.file);
      }

      expect(await db.$queryRawUnsafe(`
        SELECT "legalName", "dateOfBirth", "emailVerifiedAt",
          "accountControl", "accountStatus", "profileVisibility"
        FROM "User" WHERE id = 'legacy-user'
      `)).toEqual([{
        legalName: 'Legacy Student',
        dateOfBirth: null,
        emailVerifiedAt: null,
        accountControl: 'SELF',
        accountStatus: 'ACTIVE',
        profileVisibility: 'PUBLIC',
      }]);

      const emailColumns = await db.$queryRawUnsafe<Array<{
        tableName: string;
        isNullable: string;
      }>>(`
        SELECT table_name AS "tableName", is_nullable AS "isNullable"
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = 'email'
          AND table_name IN ('User', 'Student')
        ORDER BY table_name
      `);
      expect(emailColumns).toEqual(expect.arrayContaining([
        { tableName: 'User', isNullable: 'YES' },
        { tableName: 'Student', isNullable: 'YES' },
      ]));
      await db.$executeRawUnsafe(`
        UPDATE "Student" SET email = NULL WHERE id = 'legacy-student-row'
      `);
      expect(await db.$queryRawUnsafe(`
        SELECT email FROM "Student" WHERE id = 'legacy-student-row'
      `)).toEqual([{ email: null }]);

      await db.$executeRawUnsafe(`
        INSERT INTO "User"
          ("id", "name", "username", "email", "passwordHash", "accountType")
        VALUES
          ('old-writer', 'Previous Release Writer', 'previous_release_writer',
            'previous-release-writer@example.test', NULL, 'COACH')
      `);
      expect(await db.$queryRawUnsafe(`
        SELECT "name", "legalName", "passwordHash", "accountControl"
        FROM "User" WHERE id = 'old-writer'
      `)).toEqual([{
        name: 'Previous Release Writer',
        legalName: 'Previous Release Writer',
        passwordHash: null,
        accountControl: 'SELF',
      }]);

      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "User" ("id", "name", "username", "accountType")
        VALUES ('self-without-email', 'No Email', 'self_without_email', 'STUDENT')
      `), '23514');

      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "User"
          ("id", "name", "username", "email", "dateOfBirth", "accountType")
        VALUES ('before-dob-floor', 'Before DOB Floor', 'before_dob_floor',
          'before-dob-floor@example.test', DATE '1899-12-31', 'STUDENT')
      `), '23514');
      await db.$executeRawUnsafe(`
        UPDATE "User" SET "dateOfBirth" = DATE '1900-01-01' WHERE id = 'legacy-user'
      `);
      expect(await db.$queryRawUnsafe(`
        SELECT "dateOfBirth"::text AS "dateOfBirth" FROM "User" WHERE id = 'legacy-user'
      `)).toEqual([{ dateOfBirth: '1900-01-01' }]);
      await expectSqlState(() => db.$executeRawUnsafe(`
        UPDATE "User" SET "dateOfBirth" = DATE '1900-01-02' WHERE id = 'legacy-user'
      `), '23514', 'User.dateOfBirth cannot change after it has been set');
      await expectSqlState(() => db.$executeRawUnsafe(`
        UPDATE "User" SET "dateOfBirth" = NULL WHERE id = 'legacy-user'
      `), '23514', 'User.dateOfBirth cannot change after it has been set');

      const invalidManagedUsers = [
        `INSERT INTO "User"
          ("id", "name", "username", "dateOfBirth", "accountType",
            "accountControl", "profileVisibility")
          VALUES ('managed-coach', 'Managed Coach', 'managed_coach',
            (CURRENT_DATE - INTERVAL '10 years')::date, 'COACH',
            'GUARDIAN_MANAGED', 'PRIVATE')`,
        `INSERT INTO "User"
          ("id", "name", "username", "accountType", "accountControl",
            "profileVisibility")
          VALUES ('managed-without-dob', 'Managed Without DOB', 'managed_without_dob',
            'STUDENT', 'GUARDIAN_MANAGED', 'PRIVATE')`,
        `INSERT INTO "User"
          ("id", "name", "username", "email", "dateOfBirth", "accountType",
            "accountControl", "profileVisibility")
          VALUES ('managed-with-email', 'Managed With Email', 'managed_with_email',
            'managed@example.test', (CURRENT_DATE - INTERVAL '10 years')::date,
            'STUDENT', 'GUARDIAN_MANAGED', 'PRIVATE')`,
        `INSERT INTO "User"
          ("id", "name", "username", "dateOfBirth", "emailVerifiedAt",
            "accountType", "accountControl", "profileVisibility")
          VALUES ('managed-with-verification', 'Managed With Verification',
            'managed_with_verification', (CURRENT_DATE - INTERVAL '10 years')::date,
            CURRENT_TIMESTAMP, 'STUDENT', 'GUARDIAN_MANAGED', 'PRIVATE')`,
        `INSERT INTO "User"
          ("id", "name", "username", "dateOfBirth", "passwordHash",
            "accountType", "accountControl", "profileVisibility")
          VALUES ('managed-with-password', 'Managed With Password', 'managed_with_password',
            (CURRENT_DATE - INTERVAL '10 years')::date, 'hash',
            'STUDENT', 'GUARDIAN_MANAGED', 'PRIVATE')`,
        `INSERT INTO "User"
          ("id", "name", "username", "dateOfBirth", "phone",
            "accountType", "accountControl", "profileVisibility")
          VALUES ('managed-with-phone', 'Managed With Phone', 'managed_with_phone',
            (CURRENT_DATE - INTERVAL '10 years')::date, '+65 6000 0000',
            'STUDENT', 'GUARDIAN_MANAGED', 'PRIVATE')`,
        `INSERT INTO "User"
          ("id", "name", "username", "dateOfBirth", "accountType",
            "accountControl", "profileVisibility")
          VALUES ('managed-public', 'Managed Public', 'managed_public',
            (CURRENT_DATE - INTERVAL '10 years')::date, 'STUDENT',
            'GUARDIAN_MANAGED', 'PUBLIC')`,
      ];
      for (const statement of invalidManagedUsers) {
        await expectSqlState(() => db.$executeRawUnsafe(statement), '23514');
      }

      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`
          INSERT INTO "User"
            ("id", "name", "username", "email", "passwordHash",
              "dateOfBirth", "accountType") VALUES
            ('guardian-one', 'Guardian One', 'guardian_one', 'guardian-one@example.test',
              NULL, (CURRENT_DATE - INTERVAL '30 years')::date, 'STUDENT'),
            ('guardian-two', 'Guardian Two', 'guardian_two', 'guardian-two@example.test',
              NULL, (CURRENT_DATE - INTERVAL '35 years')::date, 'COACH')
        `);
        await tx.$executeRawUnsafe(`
          INSERT INTO "User"
            ("id", "name", "username", "dateOfBirth", "accountType",
              "accountControl", "profileVisibility")
          VALUES
            ('managed-child', 'Managed Child', 'managed_child',
              (CURRENT_DATE - INTERVAL '10 years')::date, 'STUDENT',
              'GUARDIAN_MANAGED', 'PRIVATE'),
            ('managed-child-two', 'Managed Child Two', 'managed_child_two',
              (CURRENT_DATE - INTERVAL '12 years')::date, 'STUDENT',
              'GUARDIAN_MANAGED', 'PRIVATE')
        `);
        await tx.$executeRawUnsafe(`
          INSERT INTO "GuardianChildLink"
            ("id", "guardianUserId", "childUserId", "relationshipType", "updatedAt")
          VALUES
            ('link-one', 'guardian-one', 'managed-child', 'PARENT', CURRENT_TIMESTAMP),
            ('link-two', 'guardian-two', 'managed-child', 'PARENT', CURRENT_TIMESTAMP),
            ('link-three', 'guardian-one', 'managed-child-two', 'PARENT', CURRENT_TIMESTAMP)
        `);
        await tx.$executeRawUnsafe(`
          INSERT INTO "ChildConsentRecord"
            ("id", "linkId", "guardianUserId", "childUserId", "eventType",
              "relationshipType", "privacyPolicyVersion", "permissions", "createdAt")
          VALUES
            ('initial-current-consent-one', 'link-one', 'guardian-one', 'managed-child',
              'GRANTED', 'PARENT', '2026-09-29',
              ARRAY['PROFILE_MANAGE', 'HANDOVER_MANAGE']::TEXT[],
              CURRENT_TIMESTAMP - INTERVAL '2 seconds'),
            ('initial-stale-consent-two', 'link-two', 'guardian-two', 'managed-child',
              'GRANTED', 'PARENT', '2026-09-28', ARRAY['PROFILE_MANAGE']::TEXT[],
              CURRENT_TIMESTAMP - INTERVAL '1 second'),
            ('initial-current-consent-three', 'link-three', 'guardian-one',
              'managed-child-two', 'GRANTED', 'PARENT', '2026-09-29',
              ARRAY['PROFILE_MANAGE', 'HANDOVER_MANAGE']::TEXT[], CURRENT_TIMESTAMP)
        `);
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      });
      expect(await db.$queryRawUnsafe(`
        SELECT "accountType", "accountControl", "profileVisibility", email,
          "passwordHash", phone
        FROM "User" WHERE id = 'managed-child'
      `)).toEqual([{
        accountType: 'STUDENT',
        accountControl: 'GUARDIAN_MANAGED',
        profileVisibility: 'PRIVATE',
        email: null,
        passwordHash: null,
        phone: '',
      }]);
      expect(await db.$queryRawUnsafe(`
        SELECT "guardianUserId" FROM "GuardianChildLink"
        WHERE "childUserId" = 'managed-child' ORDER BY "guardianUserId"
      `)).toEqual([
        { guardianUserId: 'guardian-one' },
        { guardianUserId: 'guardian-two' },
      ]);
      expect(await db.$queryRawUnsafe(`
        SELECT consent."guardianUserId", consent."privacyPolicyVersion",
          consent."sequence"::int AS "sequence"
        FROM "ChildConsentRecord" AS consent
        WHERE consent."childUserId" = 'managed-child'
          AND consent."eventType" IN ('GRANTED', 'RENEWED', 'WITHDRAWN')
        ORDER BY consent."guardianUserId"
      `)).toEqual([
        { guardianUserId: 'guardian-one', privacyPolicyVersion: '2026-09-29', sequence: 1 },
        { guardianUserId: 'guardian-two', privacyPolicyVersion: '2026-09-28', sequence: 2 },
      ]);
      await db.$executeRawUnsafe(`
        INSERT INTO "ChildConsentRecord"
          ("id", "linkId", "guardianUserId", "childUserId", "sequence", "eventType",
            "relationshipType", "privacyPolicyVersion", "permissions", "createdAt")
        VALUES ('sequence-overrides-client-value', 'link-one', 'guardian-one', 'managed-child',
          999, 'HANDOVER_STARTED', 'PARENT', '2026-09-29', ARRAY[]::TEXT[],
          CURRENT_TIMESTAMP - INTERVAL '1 year')
      `);
      expect(await db.$queryRawUnsafe(`
        SELECT "sequence"::int AS "sequence" FROM "ChildConsentRecord"
        WHERE id = 'sequence-overrides-client-value'
      `)).toEqual([{ sequence: 4 }]);

      const invalidActiveConsentGraphs = [
        {
          suffix: 'missing',
          consentSql: '',
        },
        {
          suffix: 'stale',
          consentSql: `
            INSERT INTO "ChildConsentRecord"
              ("id", "linkId", "guardianUserId", "childUserId", "eventType",
                "relationshipType", "privacyPolicyVersion", "permissions")
            VALUES ('invalid-consent-stale', 'invalid-link-stale', 'guardian-one',
              'invalid-child-stale', 'GRANTED', 'PARENT', '2026-09-28',
              ARRAY['PROFILE_MANAGE']::TEXT[])
          `,
        },
        {
          suffix: 'withdrawn',
          consentSql: `
            INSERT INTO "ChildConsentRecord"
              ("id", "linkId", "guardianUserId", "childUserId", "eventType",
                "relationshipType", "privacyPolicyVersion", "permissions", "createdAt")
            VALUES
              ('invalid-consent-withdrawn-grant', 'invalid-link-withdrawn', 'guardian-one',
                'invalid-child-withdrawn', 'GRANTED', 'PARENT', '2026-09-29',
                ARRAY['PROFILE_MANAGE']::TEXT[], CURRENT_TIMESTAMP - INTERVAL '1 second'),
              ('invalid-consent-withdrawn-latest', 'invalid-link-withdrawn', 'guardian-one',
                'invalid-child-withdrawn', 'WITHDRAWN', 'PARENT', '2026-09-29',
                ARRAY['PROFILE_MANAGE']::TEXT[], CURRENT_TIMESTAMP)
          `,
        },
      ];
      for (const fixture of invalidActiveConsentGraphs) {
        await expectSqlState(() => db.$transaction(async tx => {
          await tx.$executeRawUnsafe(`
            INSERT INTO "User"
              ("id", "name", "username", "dateOfBirth", "accountType",
                "accountControl", "accountStatus", "profileVisibility")
            VALUES ('invalid-child-${fixture.suffix}', 'Invalid Child ${fixture.suffix}',
              'invalid_child_${fixture.suffix}', (CURRENT_DATE - INTERVAL '10 years')::date,
              'STUDENT', 'GUARDIAN_MANAGED', 'ACTIVE', 'PRIVATE')
          `);
          await tx.$executeRawUnsafe(`
            INSERT INTO "GuardianChildLink"
              ("id", "guardianUserId", "childUserId", "relationshipType", "updatedAt")
            VALUES ('invalid-link-${fixture.suffix}', 'guardian-one',
              'invalid-child-${fixture.suffix}', 'PARENT', CURRENT_TIMESTAMP)
          `);
          if (fixture.consentSql) await tx.$executeRawUnsafe(fixture.consentSql);
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        }), '23514', 'An active guardian-managed child requires active authority with current consent');
      }

      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "GuardianChildLink"
          ("id", "guardianUserId", "childUserId", "relationshipType", "updatedAt")
        VALUES ('duplicate-link', 'guardian-one', 'managed-child', 'PARENT', CURRENT_TIMESTAMP)
      `), '23505');
      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "GuardianChildLink"
          ("id", "guardianUserId", "childUserId", "relationshipType", "updatedAt")
        VALUES ('self-link', 'guardian-one', 'guardian-one', 'PARENT', CURRENT_TIMESTAMP)
      `), '23514');

      await db.$executeRawUnsafe(`
        INSERT INTO "User"
          ("id", "name", "username", "email", "dateOfBirth", "accountType")
        VALUES ('minor-guardian', 'Minor Guardian', 'minor_guardian',
          'minor-guardian@example.test', (CURRENT_DATE - INTERVAL '10 years')::date,
          'STUDENT')
      `);
      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "GuardianChildLink"
          ("id", "guardianUserId", "childUserId", "relationshipType", "updatedAt")
        VALUES ('minor-link', 'minor-guardian', 'managed-child', 'PARENT', CURRENT_TIMESTAMP)
      `), '23514', 'Guardian-child links require an adult personal guardian');

      await db.$executeRawUnsafe(`
        UPDATE "User" SET "dateOfBirth" = DATE '1980-01-01'
        WHERE id = 'legacy-club-account'
      `);
      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "GuardianChildLink"
          ("id", "guardianUserId", "childUserId", "relationshipType", "updatedAt")
        VALUES ('club-link', 'legacy-club-account', 'managed-child', 'PARENT', CURRENT_TIMESTAMP)
      `), '23514', 'Guardian-child links require an adult personal guardian');

      await db.$executeRawUnsafe(`
        INSERT INTO "ChildConsentRecord"
          ("id", "linkId", "guardianUserId", "childUserId", "eventType",
            "relationshipType", "privacyPolicyVersion", "permissions")
        VALUES ('consent-one', 'link-one', 'guardian-one', 'managed-child', 'HANDOVER_STARTED',
          'PARENT', '2026-09-29', ARRAY['PROFILE_MANAGE', 'HANDOVER_MANAGE']::TEXT[])
      `);
      await expectSqlState(() => db.$executeRawUnsafe(`
        UPDATE "ChildConsentRecord" SET metadata = '{"changed":true}'::jsonb
        WHERE id = 'consent-one'
      `), '23514', 'Child consent records are append-only');
      await expectSqlState(() => db.$executeRawUnsafe(`
        DELETE FROM "ChildConsentRecord" WHERE id = 'consent-one'
      `), '23514', 'Child consent records are append-only');
      await expectSqlState(() => db.$executeRawUnsafe(`
        TRUNCATE TABLE "ChildConsentRecord"
      `), '23514', 'Child consent records are append-only');
      expect(await db.$queryRawUnsafe(`
        SELECT id FROM "ChildConsentRecord" WHERE id = 'consent-one'
      `)).toEqual([{ id: 'consent-one' }]);

      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "ChildConsentRecord"
          ("id", "linkId", "guardianUserId", "childUserId", "eventType",
            "relationshipType", "privacyPolicyVersion", "permissions")
        VALUES ('mismatched-consent', 'link-one', 'guardian-two', 'managed-child', 'GRANTED',
          'PARENT', 'child-privacy-v1', ARRAY[]::TEXT[])
      `), '23503');

      await db.$executeRawUnsafe(`
        INSERT INTO "ChildAccountHandover"
          ("id", "childUserId", "initiatedByGuardianUserId", "destinationEmail",
            "tokenHash", "expiresAt")
        VALUES ('handover-one', 'managed-child', 'guardian-one', 'future-child@example.test',
          repeat('a', 64), CURRENT_TIMESTAMP + INTERVAL '7 days')
      `);
      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "ChildAccountHandover"
          ("id", "childUserId", "initiatedByGuardianUserId", "destinationEmail",
            "tokenHash", "expiresAt")
        VALUES ('handover-two', 'managed-child', 'guardian-two', 'other-child@example.test',
          repeat('b', 64), CURRENT_TIMESTAMP + INTERVAL '7 days')
      `), '23505');
      await expectSqlState(() => db.$executeRawUnsafe(`
        INSERT INTO "ChildAccountHandover"
          ("id", "childUserId", "initiatedByGuardianUserId", "destinationEmail",
            "tokenHash", "expiresAt")
        VALUES ('handover-duplicate-destination', 'managed-child-two', 'guardian-one',
          'future-child@example.test', repeat('c', 64),
          CURRENT_TIMESTAMP + INTERVAL '7 days')
      `), '23505');
      await expectSqlState(() => db.$executeRawUnsafe(`
        UPDATE "ChildAccountHandover"
        SET "destinationEmail" = 'changed-child@example.test'
        WHERE id = 'handover-one'
      `), '23514', 'Child handover identity, recipient, token, and expiry are immutable');

      await db.$executeRawUnsafe(`
        UPDATE "ChildAccountHandover"
        SET status = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP
        WHERE id = 'handover-one'
      `);
      await expectSqlState(() => db.$executeRawUnsafe(`
        DELETE FROM "ChildAccountHandover" WHERE id = 'handover-one'
      `), '23514', 'Child handover history cannot be deleted');
      await db.$executeRawUnsafe(`
        INSERT INTO "ChildAccountHandover"
          ("id", "childUserId", "initiatedByGuardianUserId", "destinationEmail",
            "tokenHash", "expiresAt")
        VALUES ('handover-reused-destination', 'managed-child-two', 'guardian-one',
          'future-child@example.test', repeat('c', 64),
          CURRENT_TIMESTAMP + INTERVAL '7 days')
      `);
      expect(await db.$queryRawUnsafe(`
        SELECT id, "childUserId", "destinationEmail", status,
          "cancelledAt" IS NOT NULL AS cancelled
        FROM "ChildAccountHandover"
        WHERE id IN ('handover-one', 'handover-reused-destination')
        ORDER BY id
      `)).toEqual([
        {
          id: 'handover-one',
          childUserId: 'managed-child',
          destinationEmail: 'future-child@example.test',
          status: 'CANCELLED',
          cancelled: true,
        },
        {
          id: 'handover-reused-destination',
          childUserId: 'managed-child-two',
          destinationEmail: 'future-child@example.test',
          status: 'PENDING',
          cancelled: false,
        },
      ]);
      await expectSqlState(() => db.$executeRawUnsafe(`
        UPDATE "ChildAccountHandover"
        SET status = 'EXPIRED', "cancelledAt" = NULL
        WHERE id = 'handover-one'
      `), '23514', 'Terminal child handover history is immutable');
      expect(await db.$queryRawUnsafe(`
        SELECT status FROM "ChildAccountHandover" WHERE id = 'handover-one'
      `)).toEqual([{ status: 'CANCELLED' }]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 240_000);
});
