import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../src/config.js';

const databaseUrl = process.env.DATABASE_URL!;
const migrationNames = readdirSync(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const migrationFiles = migrationNames
  .map(name => fileURLToPath(new URL('../prisma/migrations/' + name + '/migration.sql', import.meta.url)));
const generalizedChatMigrationIndex = migrationNames.indexOf('20260928000000_generalized_chat_conversations');
if (generalizedChatMigrationIndex < 0) throw new Error('Generalized chat migration is missing');
const generalizedChatMigration = migrationFiles[generalizedChatMigrationIndex];
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
  if (result.status !== 0) throw new Error('Migration failed: ' + file + '\n' + result.stdout + '\n' + result.stderr);
}

function executeSql(url: string, sql: string) {
  const result = spawnSync(process.execPath, [prismaCli, 'db', 'execute', '--url', url, '--stdin'], {
    encoding: 'utf8', env: process.env, input: sql,
  });
  if (result.status !== 0) throw new Error('Fixture SQL failed:\n' + result.stdout + '\n' + result.stderr);
}

type RawDatabaseError = { code?: string; meta?: { code?: string; message?: string } };
async function expectCheck(operation: () => Promise<unknown>, message?: string) {
  try {
    await operation();
  } catch (error) {
    const databaseError = error as RawDatabaseError;
    expect(databaseError.code).toBe('P2010');
    expect(databaseError.meta?.code).toBe('23514');
    if (message) expect(String(databaseError.meta?.message ?? error)).toContain(message);
    return;
  }
  throw new Error('Expected SQLSTATE 23514');
}

async function expectConstraint(operation: () => Promise<unknown>, sqlState: string) {
  try {
    await operation();
  } catch (error) {
    const databaseError = error as RawDatabaseError;
    expect(databaseError.code).toBe('P2010');
    expect(databaseError.meta?.code).toBe(sqlState);
    return;
  }
  throw new Error('Expected SQLSTATE ' + sqlState);
}

const fixture = `
BEGIN;
INSERT INTO "Business" ("id","name","slug","ownerName","email","kind","legacyReadOnly") VALUES
 ('club','Club','chat-club','Club','club@example.test','CLUB',false),
 ('other-club','Other Club','chat-other-club','Other Club','other-club@example.test','CLUB',false);
INSERT INTO "User" ("id","name","email","username","passwordHash","accountType") VALUES
 ('club-user','Club','club-user@example.test','chat_club','hash','CLUB'),
 ('other-club-user','Other Club','other-club-user@example.test','chat_other_club','hash','CLUB'),
 ('coach-user','Coach','coach-user@example.test','chat_coach','hash','COACH'),
 ('alternate-coach-user','Alternate Coach','alternate-coach-user@example.test','chat_alternate_coach','hash','COACH'),
 ('other-coach-user','Other Coach','other-coach-user@example.test','chat_other_coach','hash','COACH'),
 ('student-user','Student','student-user@example.test','chat_student','hash','STUDENT'),
 ('other-student-user','Other Student','other-student-user@example.test','chat_other_student','hash','STUDENT');
INSERT INTO "Instructor" ("id","businessId","name","initials") VALUES
 ('coach','club','Coach','CO'),
 ('alternate-coach','club','Alternate Coach','AC'),
 ('other-coach','other-club','Other Coach','OC');
INSERT INTO "Membership" ("id","userId","businessId","instructorId") VALUES
 ('club-membership','club-user','club',NULL),
 ('other-club-membership','other-club-user','other-club',NULL),
 ('coach-membership','coach-user','club','coach'),
 ('alternate-coach-membership','alternate-coach-user','club','alternate-coach'),
 ('other-coach-membership','other-coach-user','other-club','other-coach');
INSERT INTO "Location" ("id","businessId","name","active") VALUES
 ('court','club','Court',true),
 ('inactive-court','club','Inactive Court',false),
 ('other-court','other-club','Other Court',true);
INSERT INTO "Service" ("id","businessId","name","type","active") VALUES
 ('service','club','Lesson','PRIVATE',true),
 ('group-service','club','Group Lesson','GROUP',true),
 ('inactive-service','club','Inactive Lesson','PRIVATE',false),
 ('unassigned-service','club','Unassigned Lesson','PRIVATE',true),
 ('other-service','other-club','Other Lesson','PRIVATE',true);
INSERT INTO "ServiceLocation" ("id","serviceId","locationId","price","duration") VALUES
 ('service-location','service','court',8000,60),
 ('service-inactive-location','service','inactive-court',8000,60),
 ('group-service-location','group-service','court',7000,60),
 ('inactive-service-location','inactive-service','court',7000,60),
 ('unassigned-service-location','unassigned-service','court',7000,60),
 ('other-service-location','other-service','other-court',9000,60);
INSERT INTO "ServiceInstructor" ("serviceLocationId","instructorId") VALUES
 ('service-location','coach'),
 ('service-location','alternate-coach'),
 ('service-inactive-location','coach'),
 ('group-service-location','coach'),
 ('inactive-service-location','coach'),
 ('other-service-location','other-coach');
INSERT INTO "Booking"
 ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute") VALUES
 ('booking','club','service','coach','court',CURRENT_TIMESTAMP + INTERVAL '2 days',CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour',60,'PRIVATE',1,5000,'CLUB');
COMMIT;`;

async function createAccountThread(
  db: PrismaClient, id: string, first: string, second: string, businessId: string | null = null,
) {
  const directKey = [first, second].sort().join(':');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(
      `INSERT INTO "ChatThread" ("id","kind","businessId","directKey") VALUES ($1,'ACCOUNT',$2,$3)`,
      id, businessId, directKey,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "ChatThreadMember" ("threadId","userId","source") VALUES ($1,$2,'INITIATOR'),($1,$3,'TARGET')`,
      id, first, second,
    );
  });
}

type ProposalOverrides = Partial<{
  businessId: string; threadId: string; serviceId: string; instructorId: string; locationId: string;
  proposedByRole: 'STUDENT' | 'COACH'; proposedByUserId: string | null; targetStudentUserId: string | null;
  price: number; currency: string;
}>;

async function insertProposal(db: PrismaClient, id: string, overrides: ProposalOverrides = {}) {
  const proposal = {
    businessId: 'club', threadId: 'global-student-coach', serviceId: 'service', instructorId: 'coach',
    locationId: 'court', proposedByRole: 'COACH' as const, proposedByUserId: 'coach-user',
    targetStudentUserId: 'student-user', price: 8000, currency: 'SGD', ...overrides,
  };
  await db.$executeRawUnsafe(`
    INSERT INTO "SessionProposal"
      ("id","businessId","threadId","serviceId","instructorId","locationId","price","currency",
       "startAt","endAt","proposedByRole","proposedByUserId","proposedByName",
       "targetStudentUserId","targetStudentName")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP + INTERVAL '3 days',
      CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour',$9,$10,'Proposal author',$11,'Student')
  `, id, proposal.businessId, proposal.threadId, proposal.serviceId, proposal.instructorId,
  proposal.locationId, proposal.price, proposal.currency, proposal.proposedByRole,
  proposal.proposedByUserId, proposal.targetStudentUserId);
}

describe.sequential('generalized chat conversation database invariants', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let schema = '';

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      throw new Error('Migration integration tests require a local PostgreSQL DATABASE_URL');
    }
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    schema = 'chat_conversation_' + randomUUID().replaceAll('-', '_');
    await admin.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    const url = isolatedUrl(schema);
    for (const file of migrationFiles.slice(0, generalizedChatMigrationIndex)) applyMigration(url, file);
    executeSql(url, fixture);
    executeSql(url, `
      BEGIN;
      INSERT INTO "ChatThread" ("id","businessId","bookingId") VALUES ('session','club','booking');
      INSERT INTO "ChatMessage"
        ("id","threadId","kind","event","senderRole","body")
        VALUES ('old-message','session','SYSTEM','OPENED','SYSTEM','Session chat opened.');
      INSERT INTO "ChatReadState" ("threadId","userId") VALUES ('session','student-user');
      INSERT INTO "SessionProposal"
        ("id","businessId","threadId","serviceId","instructorId","locationId","startAt","endAt",
         "proposedByRole","proposedByUserId","proposedByName","targetStudentUserId","targetStudentName")
        VALUES ('old-proposal','club','session','service','coach','court',
          CURRENT_TIMESTAMP + INTERVAL '3 days',CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour',
          'COACH','coach-user','Coach','student-user','Student');
      COMMIT;
    `);
    applyMigration(url, generalizedChatMigration);
    db = new PrismaClient({ datasourceUrl: url });
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (admin && /^chat_conversation_[a-f0-9_]+$/.test(schema)) {
      await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    }
    await admin?.$disconnect();
  });

  it('upgrades existing SESSION chat rows without rewriting their identity', async () => {
    expect(await db.$queryRawUnsafe(`SELECT "kind","businessId","bookingId","directKey" FROM "ChatThread" WHERE id='session'`))
      .toEqual([{ kind: 'SESSION', businessId: 'club', bookingId: 'booking', directKey: null }]);
    expect(await db.$queryRawUnsafe(`
      SELECT message.id AS "messageId", read_state."userId", proposal.id AS "proposalId",
             proposal."price", proposal."currency"
      FROM "ChatThread" AS thread
      JOIN "ChatMessage" AS message ON message."threadId"=thread.id
      JOIN "ChatReadState" AS read_state ON read_state."threadId"=thread.id
      JOIN "SessionProposal" AS proposal ON proposal."threadId"=thread.id
      WHERE thread.id='session'
    `)).toEqual([{ messageId: 'old-message', userId: 'student-user', proposalId: 'old-proposal', price: 8000, currency: 'SGD' }]);
    await expectCheck(() => db.$executeRawUnsafe(`UPDATE "ChatThread" SET "kind"='ACCOUNT' WHERE id='session'`), 'immutable');
    await expectCheck(() => db.$executeRawUnsafe(`INSERT INTO "ChatThreadMember" ("threadId","userId","source") VALUES ('session','student-user','TARGET')`), 'only to ACCOUNT');
  });

  it('accepts canonical global pairs and rejects invalid ACCOUNT shapes', async () => {
    await createAccountThread(db, 'global-student-coach', 'student-user', 'coach-user');
    await createAccountThread(db, 'global-clubs', 'club-user', 'other-club-user');
    expect(await db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM "ChatThread" WHERE "kind"='ACCOUNT'`))
      .toEqual([{ count: 2 }]);
    await expectCheck(() => db.$executeRawUnsafe(`INSERT INTO "ChatThread" ("id","kind","directKey") VALUES ('missing-booking','SESSION','x:y')`));
    await expect(async () => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`INSERT INTO "ChatThread" ("id","kind","directKey") VALUES ('bad-key','ACCOUNT','wrong:key')`);
      await tx.$executeRawUnsafe(`INSERT INTO "ChatThreadMember" ("threadId","userId","source") VALUES
        ('bad-key','student-user','INITIATOR'), ('bad-key','other-student-user','TARGET')`);
    })).rejects.toThrow('sorted direct account pair');
    await expect(async () => createAccountThread(db, 'bad-scope', 'student-user', 'other-coach-user', 'club'))
      .rejects.toThrow('one CLUB member');
  });

  it('allows one active club assignment and revokes it with the roster', async () => {
    await createAccountThread(db, 'club-student', 'club-user', 'student-user', 'club');
    await db.$executeRawUnsafe(`
      INSERT INTO "ChatThreadMember"
        ("threadId","userId","source","membershipId","addedByUserId")
      VALUES ('club-student','coach-user','CLUB_ASSIGNED','coach-membership','club-user')
    `);
    await expectConstraint(() => db.$executeRawUnsafe(`
      INSERT INTO "ChatThreadMember"
        ("threadId","userId","source","membershipId","addedByUserId")
      VALUES ('club-student','other-coach-user','CLUB_ASSIGNED','other-coach-membership','club-user')
    `), '23505');
    await db.$executeRawUnsafe(`UPDATE "Membership" SET "active"=false WHERE id='coach-membership'`);
    expect(await db.$queryRawUnsafe(`
      SELECT "removedAt" IS NOT NULL AS removed FROM "ChatThreadMember"
      WHERE "threadId"='club-student' AND "source"='CLUB_ASSIGNED'
    `)).toEqual([{ removed: true }]);

    await db.$executeRawUnsafe(`UPDATE "Membership" SET "active"=true WHERE id='coach-membership'`);
    await db.$executeRawUnsafe(`
      UPDATE "ChatThreadMember" SET "removedAt"=NULL, "joinedAt"=CURRENT_TIMESTAMP
      WHERE "threadId"='club-student' AND "source"='CLUB_ASSIGNED'
    `);
    await db.$executeRawUnsafe(`UPDATE "Instructor" SET "active"=false WHERE id='coach'`);
    expect(await db.$queryRawUnsafe(`
      SELECT "removedAt" IS NOT NULL AS removed FROM "ChatThreadMember"
      WHERE "threadId"='club-student' AND "source"='CLUB_ASSIGNED'
    `)).toEqual([{ removed: true }]);
    await db.$executeRawUnsafe(`UPDATE "Instructor" SET "active"=true WHERE id='coach'`);
  });

  it('authorizes ACCOUNT proposals against their members and exact bookable class graph', async () => {
    await db.$executeRawUnsafe(`
      UPDATE "ChatThreadMember" SET "removedAt"=NULL, "joinedAt"=CURRENT_TIMESTAMP
      WHERE "threadId"='club-student' AND "source"='CLUB_ASSIGNED'
    `);
    await insertProposal(db, 'global-proposal');
    await insertProposal(db, 'scoped-proposal', {
      threadId: 'club-student', proposedByRole: 'STUDENT', proposedByUserId: 'student-user',
    });
    await db.$executeRawUnsafe(`
      INSERT INTO "SessionProposal"
        ("id","businessId","threadId","serviceId","instructorId","locationId","startAt","endAt",
         "proposedByRole","proposedByUserId","proposedByName","targetStudentUserId","targetStudentName")
      VALUES ('legacy-writer-proposal','club','session','service','coach','court',
        CURRENT_TIMESTAMP + INTERVAL '3 days',CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour',
        'COACH','coach-user','Coach','student-user','Student')
    `);
    expect(await db.$queryRawUnsafe(`
      SELECT "price", "currency" FROM "SessionProposal" WHERE "id"='legacy-writer-proposal'
    `)).toEqual([{ price: 8000, currency: 'SGD' }]);

    await expectCheck(() => db.$executeRawUnsafe(`
      INSERT INTO "SessionProposal"
        ("id","businessId","threadId","serviceId","instructorId","locationId","price","currency","startAt","endAt",
         "proposedByRole","proposedByUserId","proposedByName","targetStudentUserId","targetStudentName")
      VALUES ('wrong-session-proposal','other-club','session','other-service','other-coach','other-court',9000,'SGD',
        CURRENT_TIMESTAMP + INTERVAL '3 days',CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour',
        'COACH','other-coach-user','Other Coach','student-user','Student')
    `), 'SESSION proposal');
    await expectCheck(() => insertProposal(db, 'wrong-business', {
      businessId: 'other-club', serviceId: 'other-service', instructorId: 'other-coach', locationId: 'other-court',
      price: 9000,
    }), 'direct coach');
    await expectCheck(() => insertProposal(db, 'wrong-coach', { instructorId: 'alternate-coach' }), 'direct coach');
    await expectCheck(() => insertProposal(db, 'wrong-target', { targetStudentUserId: 'other-student-user' }), 'conversation student');
    await expectCheck(() => insertProposal(db, 'wrong-proposer', { proposedByUserId: 'other-coach-user' }), 'active member');
    await expectCheck(() => insertProposal(db, 'wrong-role', { proposedByRole: 'STUDENT' }), 'matching role');
    await expectCheck(() => insertProposal(db, 'unassigned-class', { serviceId: 'unassigned-service', price: 7000 }), 'bookable private class');
    await expectCheck(() => insertProposal(db, 'group-class', { serviceId: 'group-service', price: 7000 }), 'bookable private class');
    await expectCheck(() => insertProposal(db, 'inactive-class', { serviceId: 'inactive-service', price: 7000 }), 'bookable private class');
    await expectCheck(() => insertProposal(db, 'inactive-venue', { locationId: 'inactive-court' }), 'bookable private class');
    await expectCheck(() => insertProposal(db, 'wrong-price', { price: 7_999 }), 'current class price');
    await expectCheck(() => insertProposal(db, 'wrong-currency', { currency: 'USD' }), 'business currency');
    await expectCheck(() => insertProposal(db, 'scoped-wrong-coach', {
      threadId: 'club-student', instructorId: 'alternate-coach',
    }), 'assigned coach');
  });

  it('keeps proposal identity, participants, times, copy and commercial snapshots immutable', async () => {
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "proposedByUserId"='other-coach-user' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "proposedByRole"='STUDENT' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "targetStudentUserId"='other-student-user' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "instructorId"='alternate-coach' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "serviceId"='unassigned-service' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "locationId"='inactive-court' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "businessId"='other-club', "serviceId"='other-service',
        "instructorId"='other-coach', "locationId"='other-court' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "startAt"="startAt" + INTERVAL '1 hour',
        "endAt"="endAt" + INTERVAL '1 hour', "address"='Changed',
        "message"='Changed' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "price"=8100 WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "currency"='USD' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
    expect(await db.$queryRawUnsafe(`
      SELECT "price","currency" FROM "SessionProposal" WHERE id='global-proposal'
    `)).toEqual([{ price: 8000, currency: 'SGD' }]);
  });

  it('keeps proposal cards in their proposal thread and prevents proposal moves', async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "ChatMessage" ("id","threadId","kind","senderRole","body","proposalId")
      VALUES ('global-proposal-message','global-student-coach','PROPOSAL','COACH','Next session','global-proposal')
    `);
    await expectCheck(() => db.$executeRawUnsafe(`
      INSERT INTO "ChatMessage" ("id","threadId","kind","senderRole","body","proposalId")
      VALUES ('cross-thread-message','session','PROPOSAL','COACH','Wrong thread','global-proposal')
    `), 'proposal thread');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "ChatMessage" SET "threadId"='session' WHERE id='global-proposal-message'
    `), 'proposal thread');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "ChatMessage" SET "proposalId"='old-proposal' WHERE id='global-proposal-message'
    `), 'proposal thread');
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "threadId"='session' WHERE id='global-proposal'
    `), 'contractual terms are immutable');
  });

  it('allows only lifecycle state to change after a proposal is created', async () => {
    await db.$executeRawUnsafe(`
      UPDATE "SessionProposal" SET "status"='WITHDRAWN', "closedAt"=CURRENT_TIMESTAMP
      WHERE id='global-proposal'
    `);
    expect(await db.$queryRawUnsafe(`
      SELECT "status", "closedAt" IS NOT NULL AS closed FROM "SessionProposal"
      WHERE id='global-proposal'
    `)).toEqual([{ status: 'WITHDRAWN', closed: true }]);
  });

  it('lets an instructor delete proceed and retires its active assignment', async () => {
    await createAccountThread(db, 'club-student-delete', 'club-user', 'other-student-user', 'club');
    await db.$executeRawUnsafe(`
      INSERT INTO "ChatThreadMember"
        ("threadId","userId","source","membershipId","addedByUserId")
      VALUES ('club-student-delete','alternate-coach-user','CLUB_ASSIGNED',
        'alternate-coach-membership','club-user')
    `);
    // Keep the older account-shape invariant valid at commit: the affiliation
    // is repointed to a replacement instructor after the original is deleted.
    // If the new BEFORE DELETE trigger incorrectly returned NEW (NULL), the
    // original row would survive and the assertion below would catch it.
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "Instructor" ("id","businessId","name","initials")
        VALUES ('alternate-coach-replacement','club','Alternate Coach Replacement','AR')
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "Membership" SET "instructorId"='alternate-coach-replacement'
        WHERE id='alternate-coach-membership'
      `);
      await tx.$executeRawUnsafe(`DELETE FROM "Instructor" WHERE id='alternate-coach'`);
    });
    expect(await db.$queryRawUnsafe(`SELECT id FROM "Instructor" WHERE id='alternate-coach'`)).toEqual([]);
    expect(await db.$queryRawUnsafe(`
      SELECT "removedAt" IS NOT NULL AS removed FROM "ChatThreadMember"
      WHERE "threadId"='club-student-delete' AND "source"='CLUB_ASSIGNED'
    `)).toEqual([{ removed: true }]);
    expect(await db.$queryRawUnsafe(`
      SELECT "instructorId" FROM "Membership" WHERE id='alternate-coach-membership'
    `)).toEqual([{ instructorId: 'alternate-coach-replacement' }]);
  });

  it('deletes an ACCOUNT conversation when a base account deletion leaves it one-sided', async () => {
    await createAccountThread(db, 'orphaned', 'other-student-user', 'other-coach-user');
    await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id='other-student-user'`);
    expect(await db.$queryRawUnsafe(`SELECT id FROM "ChatThread" WHERE id='orphaned'`)).toEqual([]);
  });

  it('audits invalid historical SESSION rows before changing the old table shape', async () => {
    const auditSchema = 'chat_conversation_' + randomUUID().replaceAll('-', '_');
    await admin.$executeRawUnsafe('CREATE SCHEMA "' + auditSchema + '"');
    const url = isolatedUrl(auditSchema);
    const auditDb = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, generalizedChatMigrationIndex)) applyMigration(url, file);
      executeSql(url, fixture);
      executeSql(url, `
        INSERT INTO "ChatThread" ("id","businessId","bookingId") VALUES ('historical','club','booking');
      `);
      executeSql(url, `ALTER TABLE "Business" DISABLE TRIGGER USER`);
      executeSql(url, `UPDATE "Business" SET "kind"='SOLO', "legacyReadOnly"=true WHERE id='club'`);
      executeSql(url, `ALTER TABLE "Business" ENABLE TRIGGER USER`);
      const result = runSqlFile(url, generalizedChatMigration);
      expect(result.status).not.toBe(0);
      expect(result.stdout + '\n' + result.stderr).toContain('Cannot generalize invalid historical SESSION chat threads');
      expect(await auditDb.$queryRawUnsafe(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='ChatThread' AND column_name='kind'
      `)).toEqual([]);
    } finally {
      await auditDb.$disconnect();
      if (/^chat_conversation_[a-f0-9_]+$/.test(auditSchema)) {
        await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + auditSchema + '" CASCADE');
      }
    }
  }, 120_000);
});
