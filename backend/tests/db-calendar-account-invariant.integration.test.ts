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
  '20260917250000_core_tenancy_invariants', '20260925000000_club_directory_index',
  '20260925100000_google_calendar_integration', '20260925150000_enable_btree_gist',
  '20260925200000_marketplace_packages_rentals',
] as const;
const migrationFiles = migrationNames.map(name =>
  fileURLToPath(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)));
const calendarAccountMigration = migrationFiles.at(-1)!;
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

function applyMigration(url: string, file: string) {
  const result = runMigration(url, file);
  if (result.status !== 0) throw new Error(`Failed to apply ${file}:\n${result.stdout}\n${result.stderr}`);
}

function executeSql(url: string, sql: string) {
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, '--stdin'], {
    encoding: 'utf8', env: process.env, input: sql,
  });
  if (result.status !== 0) throw new Error(`Failed fixture SQL:\n${result.stdout}\n${result.stderr}`);
}

type RawDatabaseError = { code?: string; meta?: { code?: string; message?: string } };
async function expectCalendarCheck(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    const databaseError = error as RawDatabaseError;
    expect(databaseError.code).toBe('P2010');
    expect(databaseError.meta?.code).toBe('23514');
    expect(`${databaseError.meta?.message ?? ''}\n${String(error)}`)
      .toContain('CalendarConnection.userId must reference a STUDENT or COACH account');
    return;
  }
  throw new Error('Expected the calendar account constraint to reject the write');
}

describe.sequential('calendar connection account database invariant', () => {
  let admin: PrismaClient;
  const schemas = new Set<string>();

  async function createSchema() {
    const schema = `calendar_account_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemas.add(schema);
    return schema;
  }

  async function dropSchema(schema: string) {
    if (!/^calendar_account_[a-f0-9_]+$/.test(schema)) {
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

  it('accepts personal accounts and rejects club links from either side', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles) applyMigration(url, file);
      executeSql(url, `
        BEGIN;
        INSERT INTO "Business" ("id","name","slug","ownerName","email","kind")
          VALUES ('club','Calendar Club','calendar-account-club','Calendar Club','club@example.test','CLUB');
        INSERT INTO "User" ("id","name","email","username","passwordHash","accountType") VALUES
          ('club-user','Calendar Club','club-user@example.test','calendar_club','hash','CLUB'),
          ('coach-user','Calendar Coach','coach-user@example.test','calendar_coach','hash','COACH'),
          ('student-user','Calendar Student','student-user@example.test','calendar_student','hash','STUDENT');
        INSERT INTO "Membership" ("id","userId","businessId")
          VALUES ('club-membership','club-user','club');
        COMMIT;
      `);

      await db.$executeRawUnsafe(`
        INSERT INTO "CalendarConnection"
          ("id","userId","providerAccountId","providerEmail","accessTokenCiphertext","accessTokenExpiresAt") VALUES
          ('student-connection','student-user','google-student','student@gmail.test','encrypted',CURRENT_TIMESTAMP + INTERVAL '1 hour'),
          ('coach-connection','coach-user','google-coach','coach@gmail.test','encrypted',CURRENT_TIMESTAMP + INTERVAL '1 hour')
      `);
      await expectCalendarCheck(() => db.$executeRawUnsafe(`
        INSERT INTO "CalendarConnection"
          ("id","userId","providerAccountId","providerEmail","accessTokenCiphertext","accessTokenExpiresAt")
          VALUES ('club-connection','club-user','google-club','club@gmail.test','encrypted',CURRENT_TIMESTAMP + INTERVAL '1 hour')
      `));
      await expectCalendarCheck(() => db.$executeRawUnsafe(`
        UPDATE "CalendarConnection" SET "userId"='club-user' WHERE "id"='student-connection'
      `));
      await expectCalendarCheck(() => db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "User" SET "accountType"='CLUB' WHERE "id"='student-user'`);
        await tx.$executeRawUnsafe(`SET CONSTRAINTS "User_calendar_connection_account_type_invariant" IMMEDIATE`);
      }));

      // Deferred evaluation permits a transaction to repair its temporary state.
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "CalendarConnection" SET "userId"='club-user' WHERE "id"='student-connection'`);
        await tx.$executeRawUnsafe(`UPDATE "CalendarConnection" SET "userId"='student-user' WHERE "id"='student-connection'`);
      });
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);

  it('audits an existing club connection before installing enforcement', async () => {
    const schema = await createSchema();
    const url = isolatedUrl(schema);
    const db = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `
        BEGIN;
        INSERT INTO "Business" ("id","name","slug","ownerName","email","kind")
          VALUES ('club','Calendar Club','calendar-preflight-club','Calendar Club','club@example.test','CLUB');
        INSERT INTO "User" ("id","name","email","passwordHash","accountType")
          VALUES ('club-user','Calendar Club','club-user@example.test','hash','CLUB');
        INSERT INTO "Membership" ("id","userId","businessId")
          VALUES ('club-membership','club-user','club');
        INSERT INTO "CalendarConnection"
          ("id","userId","providerAccountId","providerEmail","accessTokenCiphertext","accessTokenExpiresAt")
          VALUES ('club-connection','club-user','google-club','club@gmail.test','encrypted',CURRENT_TIMESTAMP + INTERVAL '1 hour');
        COMMIT;
      `);

      const result = runMigration(url, calendarAccountMigration);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        'CalendarConnection.userId points to an account other than STUDENT or COACH',
      );
      expect(await db.$queryRawUnsafe(`SELECT "userId" FROM "CalendarConnection"`))
        .toEqual([{ userId: 'club-user' }]);
      expect(await db.$queryRawUnsafe(`
        SELECT "column_name" FROM "information_schema"."columns"
        WHERE "table_schema"=current_schema() AND "table_name"='User' AND "column_name"='username'
      `)).toEqual([]);
    } finally {
      await db.$disconnect();
      await dropSchema(schema);
    }
  }, 90_000);
});
