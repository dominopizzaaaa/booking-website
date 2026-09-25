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
const marketplaceMigration = migrationFiles.at(-1)!;
const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));

function isolatedUrl(schema: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function applyMigration(url: string, file: string) {
  const result = runMigration(url, file);
  if (result.status !== 0) throw new Error(`Failed to apply ${file}:\n${result.stdout}\n${result.stderr}`);
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
  if (result.status !== 0) throw new Error(`Failed fixture SQL:\n${result.stdout}\n${result.stderr}`);
}

type RawDatabaseError = { code?: string; meta?: { code?: string } };
async function expectCheck(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    const databaseError = error as RawDatabaseError;
    expect(databaseError.code).toBe('P2010');
    expect(databaseError.meta?.code).toBe('23514');
    return;
  }
  throw new Error('Expected SQLSTATE 23514');
}

async function expectConstraintFailure(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/23514|constraint|checkout intent|exactly match|required payment|scope/u);
    return;
  }
  throw new Error('Expected a database constraint failure');
}

const fixture = `
BEGIN;
INSERT INTO "Business" ("id","name","slug","ownerName","email","kind","legacyReadOnly") VALUES
 ('club','Club','hardening-club','Club','club@example.test','CLUB',false),
 ('solo','Solo','hardening-solo','Coach','solo@example.test','SOLO',true);
INSERT INTO "User" ("id","name","email","username","passwordHash","accountType") VALUES
 ('club-user','Club','club-user@example.test','hardening_club','hash','CLUB'),
 ('coach-user','Coach','coach-user@example.test','hardening_coach','hash','COACH'),
 ('student-user','Student','student@example.test','hardening_student','hash','STUDENT'),
 ('student-two-user','Student Two','student-two@example.test','hardening_student_two','hash','STUDENT');
INSERT INTO "Instructor" ("id","businessId","name","initials") VALUES
 ('coach','club','Coach','CO'), ('solo-coach','solo','Coach','CO');
INSERT INTO "Membership" ("id","userId","businessId","instructorId") VALUES
 ('club-membership','club-user','club',NULL), ('coach-membership','coach-user','club','coach'),
 ('solo-membership','coach-user','solo','solo-coach');
INSERT INTO "Student" ("id","businessId","userId","name","email","initials") VALUES
 ('student','club','student-user','Student','student@example.test','ST'),
 ('student-two','club','student-two-user','Student Two','student-two@example.test','S2');
INSERT INTO "Location" ("id","businessId","name","type","sport","rentalEnabled") VALUES
 ('court-a','club','Court A','FACILITY','Tennis',true), ('court-b','club','Court B','FACILITY','Tennis',true),
 ('solo-court','solo','Solo Court','FACILITY','Tennis',false);
INSERT INTO "VenueUnit" ("id","businessId","locationId","name") VALUES
 ('unit-a','club','court-a','Court 1'), ('unit-b','club','court-b','Court 2');
INSERT INTO "Service" ("id","businessId","name","active") VALUES
 ('service','club','Lesson',true), ('solo-service','solo','Old lesson',true);
INSERT INTO "PackageOffer" ("id","businessId","name","price","totalCredits","validityDays","active") VALUES
 ('offer','club','Pass',5000,5,90,true), ('other-offer','club','Other Pass',5000,5,90,true);
INSERT INTO "PackageOfferService" ("offerId","businessId","serviceId") VALUES
 ('offer','club','service'), ('other-offer','club','service');
INSERT INTO "PackageOfferLocation" ("offerId","businessId","locationId") VALUES
 ('offer','club','court-a');
INSERT INTO "LessonPackage" ("id","businessId","studentId","offerId","name","totalCredits","price","expiresAt","paid") VALUES
 ('package','club','student','offer','Pass',5,5000,CURRENT_TIMESTAMP + INTERVAL '90 days',true),
 ('other-package','club','student-two',NULL,'Other Pass',5,5000,CURRENT_TIMESTAMP + INTERVAL '90 days',true);
INSERT INTO "LessonPackageService" ("packageId","businessId","serviceId") VALUES
 ('package','club','service');
INSERT INTO "LessonPackageLocation" ("packageId","businessId","locationId") VALUES
 ('package','club','court-a'), ('other-package','club','court-a');
INSERT INTO "Booking" ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute") VALUES
 ('booking','club','service','coach','court-a',CURRENT_TIMESTAMP + INTERVAL '2 days',CURRENT_TIMESTAMP + INTERVAL '2 days 1 hour',60,'PRIVATE',1,5000,'CLUB');
INSERT INTO "Participant" ("id","bookingId","studentId","price") VALUES ('participant','booking','student',5000);
COMMIT;`;

describe.sequential('marketplace and rental database invariants', () => {
  let admin: PrismaClient;
  let schema: string;
  let db: PrismaClient;
  const extraSchemas = new Set<string>();

  async function createSchema(prefix = 'marketplace_migration') {
    const created = `${prefix}_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${created}"`);
    extraSchemas.add(created);
    return created;
  }

  async function dropSchema(created: string) {
    if (!/^(marketplace_migration|marketplace_credit)_[a-f0-9_]+$/.test(created)) {
      throw new Error(`Refusing to drop unexpected schema ${created}`);
    }
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${created}" CASCADE`);
    extraSchemas.delete(created);
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Migration tests require local PostgreSQL');
    admin = new PrismaClient({ datasourceUrl: databaseUrl });
    schema = `marketplace_hardening_${randomUUID().replaceAll('-', '_')}`;
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const urlForSchema = isolatedUrl(schema);
    for (const file of migrationFiles) applyMigration(urlForSchema, file);
    db = new PrismaClient({ datasourceUrl: urlForSchema });
    executeSql(urlForSchema, fixture);
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    for (const created of extraSchemas) await dropSchema(created);
    if (admin && /^marketplace_hardening_[a-f0-9_]+$/.test(schema)) {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await admin?.$disconnect();
  });

  it('installs the rental prerequisite and defaults new bookings to CLUB', async () => {
    expect(await db.$queryRawUnsafe(`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='Booking' AND column_name='paymentRoute'
    `)).toEqual([{ column_default: "'CLUB'::text" }]);
    expect(await db.$queryRawUnsafe(`SELECT extname FROM pg_extension WHERE extname='btree_gist'`))
      .toEqual([{ extname: 'btree_gist' }]);
    expect(await db.$queryRawUnsafe(`
      SELECT contype FROM pg_constraint
      WHERE connamespace=current_schema()::regnamespace
        AND conname='VenueReservation_active_unit_overlap'
    `)).toEqual([{ contype: 'x' }]);

    await db.$executeRawUnsafe(`
      INSERT INTO "Booking" ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price")
      VALUES ('default-route-booking','club','service','coach','court-a',CURRENT_TIMESTAMP + INTERVAL '3 days',CURRENT_TIMESTAMP + INTERVAL '3 days 1 hour',60,'PRIVATE',1,5000)
    `);
    expect(await db.$queryRawUnsafe(`SELECT "paymentRoute" FROM "Booking" WHERE id='default-route-booking'`))
      .toEqual([{ paymentRoute: 'CLUB' }]);
  });

  it('preserves historical DIRECT bookings while changing the database default', async () => {
    const migrationSchema = await createSchema();
    const url = isolatedUrl(migrationSchema);
    const migrationDb = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `
        BEGIN;
        INSERT INTO "Business" ("id","name","slug","ownerName","email","kind")
          VALUES ('legacy-club','Legacy Club','legacy-direct-club','Legacy Club','legacy-club@example.test','CLUB');
        INSERT INTO "User" ("id","name","email","passwordHash","accountType") VALUES
          ('legacy-club-user','Legacy Club','legacy-club-user@example.test','hash','CLUB'),
          ('legacy-coach-user','Legacy Coach','legacy-coach@example.test','hash','COACH');
        INSERT INTO "Instructor" ("id","businessId","name","initials")
          VALUES ('legacy-coach','legacy-club','Legacy Coach','LC');
        INSERT INTO "Membership" ("id","userId","businessId","instructorId") VALUES
          ('legacy-club-membership','legacy-club-user','legacy-club',NULL),
          ('legacy-coach-membership','legacy-coach-user','legacy-club','legacy-coach');
        INSERT INTO "Location" ("id","businessId","name")
          VALUES ('legacy-court','legacy-club','Legacy Court');
        INSERT INTO "Service" ("id","businessId","name")
          VALUES ('legacy-service','legacy-club','Legacy Lesson');
        INSERT INTO "Booking"
          ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute")
          VALUES ('legacy-direct-booking','legacy-club','legacy-service','legacy-coach','legacy-court',CURRENT_TIMESTAMP + INTERVAL '1 day',CURRENT_TIMESTAMP + INTERVAL '1 day 1 hour',60,'PRIVATE',1,1000,'DIRECT');
        COMMIT;
      `);

      applyMigration(url, marketplaceMigration);
      expect(await migrationDb.$queryRawUnsafe(`
        SELECT "paymentRoute" FROM "Booking" WHERE id='legacy-direct-booking'
      `)).toEqual([{ paymentRoute: 'DIRECT' }]);
      expect(await migrationDb.$queryRawUnsafe(`
        SELECT column_default FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='Booking' AND column_name='paymentRoute'
      `)).toEqual([{ column_default: "'CLUB'::text" }]);
    } finally {
      await migrationDb.$disconnect();
      await dropSchema(migrationSchema);
    }
  }, 120_000);

  it('audits invalid historical package credit counters before changing the schema', async () => {
    const migrationSchema = await createSchema('marketplace_credit');
    const url = isolatedUrl(migrationSchema);
    const migrationDb = new PrismaClient({ datasourceUrl: url });
    try {
      for (const file of migrationFiles.slice(0, -1)) applyMigration(url, file);
      executeSql(url, `
        BEGIN;
        INSERT INTO "Business" ("id","name","slug","ownerName","email","kind")
          VALUES ('credit-club','Credit Club','credit-audit-club','Credit Club','credit-club@example.test','CLUB');
        INSERT INTO "User" ("id","name","email","passwordHash","accountType") VALUES
          ('credit-club-user','Credit Club','credit-club-user@example.test','hash','CLUB'),
          ('credit-student-user','Credit Student','credit-student@example.test','hash','STUDENT');
        INSERT INTO "Membership" ("id","userId","businessId")
          VALUES ('credit-club-membership','credit-club-user','credit-club');
        INSERT INTO "Student" ("id","businessId","userId","name","email","initials")
          VALUES ('credit-student','credit-club','credit-student-user','Credit Student','credit-student@example.test','CS');
        INSERT INTO "LessonPackage"
          ("id","businessId","studentId","name","totalCredits","usedCredits","price","expiresAt") VALUES
          ('invalid-empty','credit-club','credit-student','Empty',0,0,100,CURRENT_TIMESTAMP + INTERVAL '30 days'),
          ('invalid-negative-used','credit-club','credit-student','Negative used',5,-1,100,CURRENT_TIMESTAMP + INTERVAL '30 days'),
          ('invalid-overused','credit-club','credit-student','Overused',5,6,100,CURRENT_TIMESTAMP + INTERVAL '30 days');
        COMMIT;
      `);

      const result = runMigration(url, marketplaceMigration);
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('Cannot enforce LessonPackage credit balances');
      expect(output).toContain('invalid-empty');
      expect(output).toContain('invalid-negative-used');
      expect(output).toContain('invalid-overused');
      expect(await migrationDb.$queryRawUnsafe(`
        SELECT column_default FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='Booking' AND column_name='paymentRoute'
      `)).toEqual([{ column_default: "'DIRECT'::text" }]);
      expect(await migrationDb.$queryRawUnsafe(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='User' AND column_name='username'
      `)).toEqual([]);
    } finally {
      await migrationDb.$disconnect();
      await dropSchema(migrationSchema);
    }
  }, 120_000);

  it('enforces valid package credit counters after migration', async () => {
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET "usedCredits"=-1 WHERE id='other-package'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET "usedCredits"=6 WHERE id='other-package'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET "totalCredits"=0 WHERE id='other-package'
    `));
  });

  it('rejects scope loss and new commerce on legacy businesses', async () => {
    // `offer` also has a rental scope, so removing only its class is a valid
    // edit. `other-offer` is intentionally class-only and exercises removal
    // of the final usable scope.
    await expectCheck(() => db.$executeRawUnsafe(`DELETE FROM "PackageOfferService" WHERE "offerId"='other-offer'`));
    await expectCheck(() => db.$executeRawUnsafe(`UPDATE "Service" SET "active"=false WHERE id='service'`));
    await expectCheck(() => db.$executeRawUnsafe(`UPDATE "Business" SET "legacyReadOnly"=false WHERE id='solo'`));
    await expectCheck(() => db.$executeRawUnsafe(`
      INSERT INTO "Booking" ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute")
      VALUES ('new-solo-booking','solo','solo-service','solo-coach','solo-court',CURRENT_TIMESTAMP + INTERVAL '1 day',CURRENT_TIMESTAMP + INTERVAL '1 day 1 hour',60,'PRIVATE',1,1000,'DIRECT')
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      INSERT INTO "Payment" ("id","businessId","studentId","kind","amount")
      VALUES ('new-solo-payment','solo',NULL,'CLUB_TO_COACH',1000)
    `));
  });

  it('seals an offer-backed package scope and rejects an incomplete snapshot', async () => {
    expect(await db.$queryRawUnsafe(`
      SELECT "scopeSnapshotSealed" FROM "LessonPackage" WHERE id='package'
    `)).toEqual([{ scopeSnapshotSealed: true }]);
    await expectCheck(() => db.$executeRawUnsafe(`
      DELETE FROM "LessonPackageService" WHERE "packageId"='package' AND "serviceId"='service'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      INSERT INTO "LessonPackageLocation" ("packageId","businessId","locationId")
      VALUES ('package','club','court-b')
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET "scopeSnapshotSealed"=false WHERE id='package'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET name='Rewritten pass' WHERE id='package'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET "studentId"='student-two' WHERE id='package'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET "serviceId"='service' WHERE id='package'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET price=6000 WHERE id='package'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET "totalCredits"=50 WHERE id='package'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET "expiresAt"=CURRENT_TIMESTAMP + INTERVAL '1 day' WHERE id='package'
    `));
    await db.$executeRawUnsafe(`
      UPDATE "LessonPackage" SET name='Editable legacy pass', "totalCredits"=6,
        "expiresAt"=CURRENT_TIMESTAMP + INTERVAL '120 days' WHERE id='other-package'
    `);
    await expectConstraintFailure(() => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "LessonPackage" ("id","businessId","studentId","offerId","name","totalCredits","price","expiresAt","paid")
        VALUES ('incomplete-package','club','student','offer','Incomplete',5,5000,CURRENT_TIMESTAMP + INTERVAL '90 days',true)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "LessonPackageLocation" ("packageId","businessId","locationId")
        VALUES ('incomplete-package','club','court-a')
      `);
    }));
  });

  it('locks currency after ledgerless coach and club rental checkout history', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "Business" ("id","name","slug","ownerName","email","kind") VALUES
          ('coach-rental-currency','Coach Rental Currency','coach-rental-currency','Club','coach-rental-currency@example.test','CLUB'),
          ('club-rental-currency','Club Rental Currency','club-rental-currency','Club','club-rental-currency@example.test','CLUB')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "User" ("id","name","email","username","passwordHash","accountType") VALUES
          ('coach-rental-owner','Coach Rental Currency','coach-rental-owner@example.test','coach_rental_owner','hash','CLUB'),
          ('club-rental-owner','Club Rental Currency','club-rental-owner@example.test','club_rental_owner','hash','CLUB')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Membership" ("id","userId","businessId") VALUES
          ('coach-rental-owner-membership','coach-rental-owner','coach-rental-currency'),
          ('club-rental-owner-membership','club-rental-owner','club-rental-currency')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Location" ("id","businessId","name","type","sport","rentalEnabled") VALUES
          ('coach-rental-location','coach-rental-currency','Coach Rental Courts','FACILITY','Tennis',true),
          ('club-rental-location','club-rental-currency','Club Rental Courts','FACILITY','Tennis',true)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "VenueUnit" ("id","businessId","locationId","name") VALUES
          ('coach-rental-unit','coach-rental-currency','coach-rental-location','Court 1'),
          ('club-rental-unit','club-rental-currency','club-rental-location','Court 1')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "VenueReservation"
          ("id","businessId","locationId","unitId","userId","startAt","endAt","duration","price","status","paymentStatus","cancelledAt") VALUES
          ('coach-rental-reservation','coach-rental-currency','coach-rental-location','coach-rental-unit','coach-user',CURRENT_TIMESTAMP + INTERVAL '60 days',CURRENT_TIMESTAMP + INTERVAL '60 days 1 hour',60,1800,'CONFIRMED','PAID',NULL),
          ('club-rental-reservation','club-rental-currency','club-rental-location','club-rental-unit','club-rental-owner',CURRENT_TIMESTAMP + INTERVAL '61 days',CURRENT_TIMESTAMP + INTERVAL '61 days 1 hour',60,2200,'CANCELLED','REFUNDED',CURRENT_TIMESTAMP)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent"
          ("id","userId","businessId","kind","reservationId","amount","status","providerReference","idempotencyKey","confirmedAt") VALUES
          ('coach-rental-intent','coach-user','coach-rental-currency','RENTAL','coach-rental-reservation',1800,'SUCCEEDED','sim_coach_rental_currency','coach-rental-currency',CURRENT_TIMESTAMP),
          ('club-rental-intent','club-rental-owner','club-rental-currency','RENTAL','club-rental-reservation',2200,'REFUNDED','sim_club_rental_currency','club-rental-currency',CURRENT_TIMESTAMP)
      `);
    });

    expect(await db.$queryRawUnsafe(`
      SELECT count(*)::int AS count FROM "Payment"
      WHERE "paymentIntentId" IN ('coach-rental-intent','club-rental-intent')
    `)).toEqual([{ count: 0 }]);

    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "Business" SET currency='USD' WHERE id='coach-rental-currency'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "Business" SET currency='EUR' WHERE id='club-rental-currency'
    `));
    await db.$executeRawUnsafe(`
      UPDATE "Business" SET currency='SGD'
      WHERE id IN ('coach-rental-currency','club-rental-currency')
    `);
    expect(await db.$queryRawUnsafe(`
      SELECT id, currency FROM "Business"
      WHERE id IN ('coach-rental-currency','club-rental-currency') ORDER BY id
    `)).toEqual([
      { id: 'club-rental-currency', currency: 'SGD' },
      { id: 'coach-rental-currency', currency: 'SGD' },
    ]);
  });

  it('prevents a sold offer price rewrite but permits non-price edits', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","packageOfferId","packageId","amount","status","providerReference","idempotencyKey","confirmedAt")
        VALUES ('sold-intent','student-user','club','PACKAGE','offer','package',5000,'SUCCEEDED','sim_sold','sold-offer',CURRENT_TIMESTAMP)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Payment" ("id","businessId","studentId","packageId","kind","amount","method","paymentIntentId")
        VALUES ('sold-payment','club','student','package','STUDENT_TO_CLUB',5000,'SIMULATED_STRIPE','sold-intent')
      `);
    });
    await expectCheck(() => db.$executeRawUnsafe(`UPDATE "LessonPackage" SET paid=false WHERE id='package'`));
    await expectConstraintFailure(() => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`DELETE FROM "Payment" WHERE id='sold-payment'`);
      await tx.$executeRawUnsafe(`
        UPDATE "PaymentIntent"
        SET status='FAILED', "packageId"=NULL, "confirmedAt"=NULL, "failedAt"=CURRENT_TIMESTAMP
        WHERE id='sold-intent'
      `);
      await tx.$executeRawUnsafe(`DELETE FROM "LessonPackage" WHERE id='package'`);
      await tx.$executeRawUnsafe(`DELETE FROM "PaymentIntent" WHERE id='sold-intent'`);
    }));
    await expectCheck(() => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`UPDATE "Payment" SET "reversedAt"=CURRENT_TIMESTAMP WHERE id='sold-payment'`);
      await tx.$executeRawUnsafe(`
        UPDATE "PaymentIntent" SET status='REFUNDED', amount=5001
        WHERE id='sold-intent'
      `);
      await tx.$executeRawUnsafe(`UPDATE "LessonPackage" SET paid=false WHERE id='package'`);
    }));
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`UPDATE "Payment" SET "reversedAt"=CURRENT_TIMESTAMP WHERE id='sold-payment'`);
      await tx.$executeRawUnsafe(`UPDATE "PaymentIntent" SET status='REFUNDED' WHERE id='sold-intent'`);
      await tx.$executeRawUnsafe(`UPDATE "LessonPackage" SET paid=false WHERE id='package'`);
    });
    await expectCheck(() => db.$executeRawUnsafe(`UPDATE "LessonPackage" SET paid=true WHERE id='package'`));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "PaymentIntent" SET status='SUCCEEDED' WHERE id='sold-intent'
    `));
    for (const terminalRewrite of [
      `status='FAILED', "packageId"=NULL, "confirmedAt"=NULL, "failedAt"=CURRENT_TIMESTAMP`,
      `status='CANCELLED', "packageId"=NULL, "confirmedAt"=NULL`,
      `status='REQUIRES_CONFIRMATION', "packageId"=NULL, "confirmedAt"=NULL`,
    ]) {
      await expectCheck(() => db.$executeRawUnsafe(`
        UPDATE "PaymentIntent" SET ${terminalRewrite} WHERE id='sold-intent'
      `));
    }
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "PaymentIntent"
      SET "providerReference"='sim_rewritten', "idempotencyKey"='rewritten-key'
      WHERE id='sold-intent'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "PaymentIntent" SET "confirmedAt"=CURRENT_TIMESTAMP + INTERVAL '1 second'
      WHERE id='sold-intent'
    `));
    expect(await db.$queryRawUnsafe(`
      SELECT status, amount, "providerReference", "idempotencyKey"
      FROM "PaymentIntent" WHERE id='sold-intent'
    `)).toEqual([{
      status: 'REFUNDED', amount: 5000, providerReference: 'sim_sold', idempotencyKey: 'sold-offer',
    }]);
    await expectCheck(() => db.$executeRawUnsafe(`UPDATE "PackageOffer" SET price=6000 WHERE id='offer'`));
    await expectCheck(() => db.$executeRawUnsafe(`UPDATE "LessonPackage" SET price=6000 WHERE id='package'`));
    await expectConstraintFailure(() => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`DELETE FROM "Payment" WHERE id='sold-payment'`);
      await tx.$executeRawUnsafe(`DELETE FROM "PaymentIntent" WHERE id='sold-intent'`);
    }));
    await db.$executeRawUnsafe(`UPDATE "PackageOffer" SET description='New copy', "validityDays"=120 WHERE id='offer'`);
    expect(await db.$queryRawUnsafe(`SELECT price, description, "validityDays" FROM "PackageOffer" WHERE id='offer'`))
      .toEqual([{ price: 5000, description: 'New copy', validityDays: 120 }]);
  });

  it('serializes intent completion and refund against business teardown', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "VenueReservation" ("id","businessId","locationId","unitId","userId","startAt","endAt","duration","price","status","paymentStatus")
        VALUES ('lock-reservation','club','court-a','unit-a','club-user',CURRENT_TIMESTAMP + INTERVAL '40 days',CURRENT_TIMESTAMP + INTERVAL '40 days 1 hour',60,1000,'CONFIRMED','PAID')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","reservationId","amount","status","providerReference","idempotencyKey")
        VALUES ('lock-intent','club-user','club','RENTAL','lock-reservation',1000,'REQUIRES_CONFIRMATION','sim_lock','lock-sale')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","amount","status","providerReference","idempotencyKey")
        VALUES ('teardown-probe-intent','club-user','club','RENTAL',0,'REQUIRES_CONFIRMATION','sim_teardown_probe','teardown-probe')
      `);
    });

    const contender = new PrismaClient({ datasourceUrl: isolatedUrl(schema) });
    const expectTeardownBlocked = async () => {
      try {
        await contender.$transaction(async tx => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`);
          await tx.$executeRawUnsafe(`DELETE FROM "PaymentIntent" WHERE id='teardown-probe-intent'`);
          throw new Error('Teardown unexpectedly bypassed the commercial lock');
        });
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/55P03|lock timeout/u);
        return;
      }
      throw new Error('Expected teardown to wait for the commercial lock');
    };

    try {
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`
          UPDATE "PaymentIntent" SET status='SUCCEEDED', "confirmedAt"=CURRENT_TIMESTAMP
          WHERE id='lock-intent'
        `);
        await expectTeardownBlocked();
      });
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`UPDATE "PaymentIntent" SET status='REFUNDED' WHERE id='lock-intent'`);
        await tx.$executeRawUnsafe(`
          UPDATE "VenueReservation"
          SET status='CANCELLED', "paymentStatus"='REFUNDED', "cancelledAt"=CURRENT_TIMESTAMP
          WHERE id='lock-reservation'
        `);
        await expectTeardownBlocked();
      });
    } finally {
      await contender.$disconnect();
    }
  });

  it('keeps failed payment attempts immutable and undeletable', async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","amount","status","providerReference","idempotencyKey","failedAt")
      VALUES ('failed-intent','club-user','club','RENTAL',1200,'FAILED','sim_failed','failed-sale',CURRENT_TIMESTAMP)
    `);
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "PaymentIntent"
      SET status='CANCELLED', "failedAt"=NULL WHERE id='failed-intent'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "PaymentIntent" SET amount=1300 WHERE id='failed-intent'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "PaymentIntent" SET "failedAt"="failedAt" + INTERVAL '1 second'
      WHERE id='failed-intent'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`DELETE FROM "PaymentIntent" WHERE id='failed-intent'`));
    await expectConstraintFailure(() => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        UPDATE "PaymentIntent"
        SET status='REQUIRES_CONFIRMATION', "failedAt"=NULL WHERE id='failed-intent'
      `);
      await tx.$executeRawUnsafe(`DELETE FROM "PaymentIntent" WHERE id='failed-intent'`);
    }));
    expect(await db.$queryRawUnsafe(`
      SELECT status, amount, "providerReference", "idempotencyKey", "failedAt" IS NOT NULL AS failed
      FROM "PaymentIntent" WHERE id='failed-intent'
    `)).toEqual([{
      status: 'FAILED', amount: 1200, providerReference: 'sim_failed', idempotencyKey: 'failed-sale', failed: true,
    }]);
  });

  it('seals reservation contracts while allowing only atomic cancellation', async () => {
    await db.$executeRawUnsafe(`
      INSERT INTO "VenueReservation"
        ("id","businessId","locationId","unitId","userId","startAt","endAt","duration","price","status","paymentStatus","notes")
      VALUES
        ('sealed-reservation','club','court-a','unit-a','student-user',CURRENT_TIMESTAMP + INTERVAL '70 days',CURRENT_TIMESTAMP + INTERVAL '70 days 1 hour',60,2400,'CONFIRMED','PAID','{"cancellationHours":24,"unitName":"Court 1"}')
    `);

    // Each rewrite remains valid under the table checks and foreign keys, so
    // this test reaches the reservation contract guard itself.
    for (const rewrite of [
      `"id"='rewritten-reservation'`,
      `"locationId"='court-b', "unitId"='unit-b'`,
      `"userId"='student-two-user'`,
      `"startAt"="startAt" + INTERVAL '1 hour', "endAt"="endAt" + INTERVAL '1 hour'`,
      `"endAt"="endAt" + INTERVAL '30 minutes', "duration"="duration" + 30`,
      `"price"="price" + 100`,
      `"packageId"='package', "paymentStatus"='PACKAGE', "creditConsumed"=true`,
      `"notes"='rewritten cancellation terms'`,
      `"createdAt"="createdAt" + INTERVAL '1 second'`,
    ]) {
      await expectCheck(() => db.$executeRawUnsafe(`
        UPDATE "VenueReservation" SET ${rewrite} WHERE id='sealed-reservation'
      `));
    }

    for (const invalidTransition of [
      `status='PENDING'`,
      `"paymentStatus"='UNPAID'`,
      `status='CANCELLED', "paymentStatus"='PAID', "cancelledAt"=CURRENT_TIMESTAMP`,
      `status='CANCELLED', "paymentStatus"='REFUNDED', "cancelledAt"=CURRENT_TIMESTAMP, "price"=2500`,
    ]) {
      await expectCheck(() => db.$executeRawUnsafe(`
        UPDATE "VenueReservation" SET ${invalidTransition} WHERE id='sealed-reservation'
      `));
    }

    await db.$executeRawUnsafe(`
      UPDATE "VenueReservation"
      SET "notes"="notes", status=status, "paymentStatus"="paymentStatus",
        "creditConsumed"="creditConsumed", "cancelledAt"="cancelledAt"
      WHERE id='sealed-reservation'
    `);
    await db.$executeRawUnsafe(`
      UPDATE "VenueReservation"
      SET status='CANCELLED', "paymentStatus"='REFUNDED',
        "creditConsumed"=false, "cancelledAt"=CURRENT_TIMESTAMP
      WHERE id='sealed-reservation'
    `);
    expect(await db.$queryRawUnsafe(`
      SELECT id, "locationId", "unitId", "userId", duration, price, status,
        "paymentStatus", "packageId", "creditConsumed", notes, "cancelledAt" IS NOT NULL AS cancelled
      FROM "VenueReservation" WHERE id='sealed-reservation'
    `)).toEqual([{
      id: 'sealed-reservation', locationId: 'court-a', unitId: 'unit-a', userId: 'student-user',
      duration: 60, price: 2400, status: 'CANCELLED', paymentStatus: 'REFUNDED', packageId: null,
      creditConsumed: false, notes: '{"cancellationHours":24,"unitName":"Court 1"}', cancelled: true,
    }]);

    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "VenueReservation"
      SET status='CONFIRMED', "paymentStatus"='PAID', "cancelledAt"=NULL
      WHERE id='sealed-reservation'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "VenueReservation" SET "cancelledAt"="cancelledAt" + INTERVAL '1 second'
      WHERE id='sealed-reservation'
    `));
    await expectCheck(() => db.$executeRawUnsafe(`
      UPDATE "VenueReservation" SET notes='cancelled rewrite' WHERE id='sealed-reservation'
    `));
    await db.$executeRawUnsafe(`UPDATE "VenueReservation" SET status=status WHERE id='sealed-reservation'`);

    await db.$executeRawUnsafe(`
      INSERT INTO "VenueReservation"
        ("id","businessId","locationId","unitId","userId","startAt","endAt","duration","price","status","paymentStatus")
      VALUES
        ('pending-reservation','club','court-a','unit-a','student-user',CURRENT_TIMESTAMP + INTERVAL '71 days',CURRENT_TIMESTAMP + INTERVAL '71 days 1 hour',60,2400,'PENDING','UNPAID')
    `);
    await db.$executeRawUnsafe(`
      UPDATE "VenueReservation"
      SET status='CANCELLED', "paymentStatus"='REFUNDED',
        "creditConsumed"=false, "cancelledAt"=CURRENT_TIMESTAMP
      WHERE id='pending-reservation'
    `);
    expect(await db.$queryRawUnsafe(`
      SELECT status, "paymentStatus" FROM "VenueReservation" WHERE id='pending-reservation'
    `)).toEqual([{ status: 'CANCELLED', paymentStatus: 'REFUNDED' }]);

    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "LessonPackage"
          ("id","businessId","studentId","name","totalCredits","usedCredits","price","expiresAt","paid")
        VALUES
          ('reservation-package','club','student','Rental package',2,1,4800,CURRENT_TIMESTAMP + INTERVAL '120 days',true)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "LessonPackageLocation" ("packageId","businessId","locationId")
        VALUES ('reservation-package','club','court-a')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "VenueReservation"
          ("id","businessId","locationId","unitId","userId","startAt","endAt","duration","price","status","paymentStatus","packageId","creditConsumed")
        VALUES
          ('package-reservation','club','court-a','unit-a','student-user',CURRENT_TIMESTAMP + INTERVAL '72 days',CURRENT_TIMESTAMP + INTERVAL '72 days 1 hour',60,2400,'CONFIRMED','PACKAGE','reservation-package',true)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent"
          ("id","userId","businessId","kind","reservationId","amount","status","providerReference","idempotencyKey","confirmedAt")
        VALUES
          ('package-reservation-intent','student-user','club','RENTAL','package-reservation',0,'SUCCEEDED','sim_package_reservation','package-reservation',CURRENT_TIMESTAMP)
      `);
    });
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        UPDATE "LessonPackage" SET "usedCredits"="usedCredits" - 1
        WHERE id='reservation-package'
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "PaymentIntent" SET status='REFUNDED' WHERE id='package-reservation-intent'
      `);
      await tx.$executeRawUnsafe(`
        UPDATE "VenueReservation"
        SET status='CANCELLED', "paymentStatus"='REFUNDED',
          "creditConsumed"=false, "cancelledAt"=CURRENT_TIMESTAMP
        WHERE id='package-reservation'
      `);
    });
    expect(await db.$queryRawUnsafe(`
      SELECT reservation.status, reservation."paymentStatus", reservation."packageId",
        reservation."creditConsumed", package."usedCredits", intent.status AS "intentStatus"
      FROM "VenueReservation" AS reservation
      JOIN "LessonPackage" AS package ON package.id = reservation."packageId"
      JOIN "PaymentIntent" AS intent ON intent."reservationId" = reservation.id
      WHERE reservation.id='package-reservation'
    `)).toEqual([{
      status: 'CANCELLED', paymentStatus: 'REFUNDED', packageId: 'reservation-package',
      creditConsumed: false, usedCredits: 0, intentStatus: 'REFUNDED',
    }]);
  });

  it('permits completed intent deletion only with its full business teardown', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "Business" ("id","name","slug","ownerName","email","kind")
        VALUES ('teardown-club','Teardown Club','teardown-club','Club','teardown-club@example.test','CLUB')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "User" ("id","name","email","username","passwordHash","accountType")
        VALUES ('teardown-club-user','Teardown Club','teardown-user@example.test','teardown_club','hash','CLUB')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Membership" ("id","userId","businessId")
        VALUES ('teardown-membership','teardown-club-user','teardown-club')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Student" ("id","businessId","userId","name","email","initials")
        VALUES ('teardown-student','teardown-club','student-user','Student','student@example.test','ST')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Service" ("id","businessId","name","active")
        VALUES ('teardown-service','teardown-club','Teardown class',true)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "PackageOffer" ("id","businessId","name","price","totalCredits","validityDays","active")
        VALUES ('teardown-offer','teardown-club','Teardown pass',4000,4,30,true)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "PackageOfferService" ("offerId","businessId","serviceId")
        VALUES ('teardown-offer','teardown-club','teardown-service')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "LessonPackage" ("id","businessId","studentId","offerId","name","totalCredits","price","expiresAt","paid")
        VALUES ('teardown-package','teardown-club','teardown-student','teardown-offer','Teardown pass',4,4000,CURRENT_TIMESTAMP + INTERVAL '30 days',true)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "LessonPackageService" ("packageId","businessId","serviceId")
        VALUES ('teardown-package','teardown-club','teardown-service')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","packageOfferId","packageId","amount","status","providerReference","idempotencyKey","confirmedAt")
        VALUES ('teardown-intent','student-user','teardown-club','PACKAGE','teardown-offer','teardown-package',4000,'SUCCEEDED','sim_teardown','teardown-sale',CURRENT_TIMESTAMP)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","amount","status","providerReference","idempotencyKey","failedAt")
        VALUES ('teardown-failed-intent','student-user','teardown-club','RENTAL',4000,'FAILED','sim_teardown_failed','teardown-failed-sale',CURRENT_TIMESTAMP)
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Payment" ("id","businessId","studentId","packageId","kind","amount","method","paymentIntentId")
        VALUES ('teardown-payment','teardown-club','teardown-student','teardown-package','STUDENT_TO_CLUB',4000,'SIMULATED_STRIPE','teardown-intent')
      `);
    });

    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "businessId"='teardown-club'`);
      await tx.$executeRawUnsafe(`DELETE FROM "PaymentIntent" WHERE "businessId"='teardown-club'`);
      await tx.$executeRawUnsafe(`DELETE FROM "LessonPackage" WHERE "businessId"='teardown-club'`);
      await tx.$executeRawUnsafe(`DELETE FROM "Student" WHERE "businessId"='teardown-club'`);
      await tx.$executeRawUnsafe(`DELETE FROM "Business" WHERE id='teardown-club'`);
      await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id='teardown-club-user'`);
    });
    expect(await db.$queryRawUnsafe(`SELECT id FROM "Business" WHERE id='teardown-club'`)).toEqual([]);
    expect(await db.$queryRawUnsafe(`
      SELECT id FROM "PaymentIntent" WHERE id IN ('teardown-intent','teardown-failed-intent')
    `)).toEqual([]);
  });

  it('requires a positive package offer price at the database boundary', async () => {
    await expectCheck(() => db.$executeRawUnsafe(`
      INSERT INTO "PackageOffer" ("id","businessId","name","price","totalCredits","validityDays","active")
      VALUES ('free-offer','club','Invalid free pass',0,1,30,false)
    `));
  });

  it('makes read-only commercial history immutable but permits whole-business teardown', async () => {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Booking" ("id","businessId","serviceId","instructorId","locationId","startAt","endAt","duration","type","capacity","price","paymentRoute")
        VALUES ('old-solo-booking','solo','solo-service','solo-coach','solo-court',CURRENT_TIMESTAMP - INTERVAL '30 days',CURRENT_TIMESTAMP - INTERVAL '30 days' + INTERVAL '1 hour',60,'PRIVATE',1,1000,'DIRECT')
      `);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Payment" ("id","businessId","instructorId","kind","amount")
        VALUES ('old-solo-payment','solo','solo-coach','CLUB_TO_COACH',1000)
      `);
    });
    await expectCheck(() => db.$executeRawUnsafe(`UPDATE "Booking" SET notes='rewrite' WHERE id='old-solo-booking'`));
    await expectCheck(() => db.$executeRawUnsafe(`DELETE FROM "Payment" WHERE id='old-solo-payment'`));
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`DELETE FROM "Payment" WHERE "businessId"='solo'`);
      await tx.$executeRawUnsafe(`DELETE FROM "Booking" WHERE "businessId"='solo'`);
      await tx.$executeRawUnsafe(`DELETE FROM "Student" WHERE "businessId"='solo'`);
      await tx.$executeRawUnsafe(`DELETE FROM "Business" WHERE id='solo'`);
    });
    expect(await db.$queryRawUnsafe(`SELECT id FROM "Business" WHERE id='solo'`)).toEqual([]);
  });

  it('pins a reservation to its unit location, package owner, and package location scope', async () => {
    const values = (id: string, unitId: string, userId: string, packageId: string) => `
      INSERT INTO "VenueReservation" ("id","businessId","locationId","unitId","userId","startAt","endAt","duration","price","status","paymentStatus","packageId","creditConsumed")
      VALUES ('${id}','club','court-a','${unitId}','${userId}',CURRENT_TIMESTAMP + INTERVAL '10 days',CURRENT_TIMESTAMP + INTERVAL '10 days 1 hour',60,0,'CONFIRMED','PACKAGE','${packageId}',true)`;
    await expect(db.$executeRawUnsafe(values('wrong-unit', 'unit-b', 'student-user', 'package'))).rejects.toThrow('VenueReservation_unitId_locationId_businessId_fkey');
    await expectCheck(() => db.$executeRawUnsafe(values('wrong-owner', 'unit-a', 'student-user', 'other-package')));
    await db.$executeRawUnsafe(`DELETE FROM "LessonPackageLocation" WHERE "packageId"='other-package'`);
    await db.$executeRawUnsafe(`INSERT INTO "LessonPackageLocation" ("packageId","businessId","locationId") VALUES ('other-package','club','court-b')`);
    await expectCheck(() => db.$executeRawUnsafe(values('wrong-scope', 'unit-a', 'student-two-user', 'other-package')));
  });

  it('requires one exact payment for successful package and booking intents', async () => {
    await expectCheck(() => db.$executeRawUnsafe(`
      INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","packageOfferId","packageId","amount","status","providerReference","idempotencyKey","confirmedAt")
      VALUES ('orphan-package-intent','student-user','club','PACKAGE','offer','package',5000,'SUCCEEDED','sim_orphan','orphan-package',CURRENT_TIMESTAMP)
    `));
    await expectConstraintFailure(() => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","participantId","amount","status","providerReference","idempotencyKey","confirmedAt")
        VALUES ('bad-booking-intent','student-user','club','BOOKING','participant',5000,'SUCCEEDED','sim_bad_booking','bad-booking',CURRENT_TIMESTAMP)`);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Payment" ("id","businessId","studentId","bookingId","kind","amount","method","paymentIntentId")
        VALUES ('bad-booking-payment','club','student','booking','STUDENT_TO_CLUB',4000,'SIMULATED_STRIPE','bad-booking-intent')`);
    }));
    await expectConstraintFailure(() => db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "PaymentIntent" ("id","userId","businessId","kind","packageOfferId","packageId","amount","status","providerReference","idempotencyKey","confirmedAt")
        VALUES ('wrong-offer-intent','student-user','club','PACKAGE','other-offer','package',5000,'SUCCEEDED','sim_wrong_offer','wrong-offer',CURRENT_TIMESTAMP)`);
      await tx.$executeRawUnsafe(`
        INSERT INTO "Payment" ("id","businessId","studentId","packageId","kind","amount","method","paymentIntentId")
        VALUES ('wrong-offer-payment','club','student','package','STUDENT_TO_CLUB',5000,'SIMULATED_STRIPE','wrong-offer-intent')`);
    }));
  });
});
