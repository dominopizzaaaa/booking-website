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

describe.sequential('20260916040000 global accounts migration', () => {
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
      for (const file of migrationFiles) applyMigration(url, file);
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
});
