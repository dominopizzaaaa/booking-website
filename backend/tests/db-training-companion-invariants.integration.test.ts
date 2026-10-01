import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withCreditContext } from '../src/credit-ledger.js';
import { createBookings } from '../src/scheduling.js';
import {
  createPackage, createStudent, linkedInputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

// These scenarios exercise the training-companion migration's SQL directly.
// Violating writes use raw SQL so the asserted outcome is the database's own
// SQLSTATE rather than an application-layer validation.
type RawDatabaseError = { code?: string; meta?: { code?: string; message?: string }; message?: string };
async function expectSqlState(operation: () => Promise<unknown>, sqlState: string, message?: string) {
  try {
    await operation();
  } catch (error) {
    const databaseError = error as RawDatabaseError;
    expect(databaseError.code).toBe('P2010');
    expect(databaseError.meta?.code).toBe(sqlState);
    if (message) expect(String(databaseError.meta?.message ?? databaseError.message)).toContain(message);
    return;
  }
  throw new Error(`Expected SQLSTATE ${sqlState}`);
}

const ledger = (packageId: string) => prisma.packageCreditEvent.findMany({ where: { packageId }, orderBy: { sequence: 'asc' } });

describe.sequential('training companion database invariants', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function bookedPlace(hourOffset = 0) {
    const input = await linkedInputFor(f, { startAt: f.starts.plus({ hours: hourOffset }).toISO()! });
    const { bookings } = await createBookings(f.business.id, input);
    const booking = bookings[0]!;
    return { bookingId: booking.id, participantId: booking.participants[0]!.id, studentId: booking.participants[0]!.studentId };
  }

  describe('package credit ledger', () => {
    it('records a grant on insert and the credits already used at creation', async () => {
      const student = await createStudent(f);
      const fresh = await createPackage(f, student.id, { totalCredits: 6 });
      expect(await ledger(fresh.id)).toEqual([expect.objectContaining({
        businessId: f.business.id, studentId: student.id, kind: 'GRANTED', delta: 6, totalAfter: 6, usedAfter: 0,
        note: 'Five lessons', actorUserId: null, bookingId: null,
      })]);

      const used = await createPackage(f, student.id, { totalCredits: 8, usedCredits: 3 });
      expect((await ledger(used.id)).map(event => [event.kind, event.delta, event.totalAfter, event.usedAfter, event.note])).toEqual([
        ['GRANTED', 8, 8, 0, 'Five lessons'],
        ['USED', -3, 8, 3, 'Credits used when the package was created'],
      ]);

      // A labelled insert keeps the actor and its note on the grant.
      const labelled = await prisma.$transaction(tx => withCreditContext(tx, { actorUserId: f.user.id, note: 'Welcome pack' },
        () => tx.lessonPackage.create({ data: {
          businessId: f.business.id, studentId: student.id, name: 'Welcome', totalCredits: 2, price: 0,
          expiresAt: f.starts.plus({ months: 1 }).toJSDate(),
        } })));
      expect(await ledger(labelled.id)).toEqual([expect.objectContaining({ kind: 'GRANTED', actorUserId: f.user.id, note: 'Welcome pack' })]);
    });

    it('labels consumption, restoration and adjustment with the transaction context', async () => {
      const { bookingId, participantId, studentId } = await bookedPlace();
      const pkg = await createPackage(f, studentId, { totalCredits: 5 });
      const reservationId = `reservation-${randomUUID()}`;
      await prisma.$transaction(async tx => {
        await withCreditContext(tx, { kind: 'BOOKED', bookingId, participantId, actorUserId: f.user.id, note: 'Private tennis · Tue' },
          () => tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: { increment: 2 } } }));
        await withCreditContext(tx, { kind: 'RESTORED', bookingId, participantId, note: 'Private tennis · Tue cancelled' },
          () => tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: { decrement: 1 } } }));
        await withCreditContext(tx, { kind: 'RENTAL_RESERVED', reservationId, actorUserId: f.user.id, note: 'Court 1' },
          () => tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: { increment: 1 } } }));
        await withCreditContext(tx, { kind: 'RENTAL_RESTORED', reservationId, note: 'Court reservation cancelled' },
          () => tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: { decrement: 1 } } }));
        await withCreditContext(tx, { kind: 'ADJUSTED', actorUserId: f.user.id, note: 'Goodwill credit' },
          () => tx.lessonPackage.update({ where: { id: pkg.id }, data: { totalCredits: 7 } }));
        // One statement changing both counters records the size change first,
        // then the balance change under the supplied label.
        await withCreditContext(tx, { kind: 'ADJUSTED', actorUserId: f.user.id, note: 'Corrected by the club' },
          () => tx.lessonPackage.update({ where: { id: pkg.id }, data: { totalCredits: 6, usedCredits: 0 } }));
      });
      const events = await ledger(pkg.id);
      expect(events.map(event => ({
        kind: event.kind, delta: event.delta, totalAfter: event.totalAfter, usedAfter: event.usedAfter,
        bookingId: event.bookingId, participantId: event.participantId, reservationId: event.reservationId,
        actorUserId: event.actorUserId, note: event.note,
      }))).toEqual([
        { kind: 'GRANTED', delta: 5, totalAfter: 5, usedAfter: 0, bookingId: null, participantId: null, reservationId: null, actorUserId: null, note: 'Five lessons' },
        { kind: 'BOOKED', delta: -2, totalAfter: 5, usedAfter: 2, bookingId, participantId, reservationId: null, actorUserId: f.user.id, note: 'Private tennis · Tue' },
        { kind: 'RESTORED', delta: 1, totalAfter: 5, usedAfter: 1, bookingId, participantId, reservationId: null, actorUserId: null, note: 'Private tennis · Tue cancelled' },
        { kind: 'RENTAL_RESERVED', delta: -1, totalAfter: 5, usedAfter: 2, bookingId: null, participantId: null, reservationId, actorUserId: f.user.id, note: 'Court 1' },
        { kind: 'RENTAL_RESTORED', delta: 1, totalAfter: 5, usedAfter: 1, bookingId: null, participantId: null, reservationId, actorUserId: null, note: 'Court reservation cancelled' },
        { kind: 'ADJUSTED', delta: 2, totalAfter: 7, usedAfter: 1, bookingId: null, participantId: null, reservationId: null, actorUserId: f.user.id, note: 'Goodwill credit' },
        { kind: 'ADJUSTED', delta: -1, totalAfter: 6, usedAfter: 1, bookingId: null, participantId: null, reservationId: null, actorUserId: f.user.id, note: 'Corrected by the club' },
        { kind: 'ADJUSTED', delta: 1, totalAfter: 6, usedAfter: 0, bookingId: null, participantId: null, reservationId: null, actorUserId: f.user.id, note: 'Corrected by the club' },
      ]);
      // Sequence is the authoritative order and is strictly increasing.
      expect(events.map(event => event.sequence)).toEqual([...events.map(event => event.sequence)].sort((a, b) => a - b));
    });

    it('still records unlabelled, mislabelled and malformed-context changes, and nothing for other columns', async () => {
      const student = await createStudent(f);
      const pkg = await createPackage(f, student.id, { totalCredits: 5 });
      await prisma.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: 2 } });
      await prisma.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: 1 } });
      await prisma.lessonPackage.update({ where: { id: pkg.id }, data: { totalCredits: 4 } });
      await prisma.lessonPackage.update({ where: { id: pkg.id }, data: { name: 'Renamed pass', paid: true } });
      await prisma.$transaction(async tx => {
        // Labels the trigger does not accept for a balance change fall back to
        // the direction of the change.
        await tx.$executeRaw`SELECT set_config('courtly.credit_context', ${JSON.stringify({ kind: 'GRANTED', note: 'forged' })}, true)`;
        await tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: 2 } });
        await tx.$executeRaw`SELECT set_config('courtly.credit_context', 'not json at all', true)`;
        await tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: 1 } });
        // The helper clears its label afterwards, so a later write in the same
        // transaction is never mislabelled.
        await withCreditContext(tx, { kind: 'BOOKED', note: 'Scoped label' },
          () => tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: 2 } }));
        await tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: 3 } });
      });
      expect((await ledger(pkg.id)).map(event => [event.kind, event.delta, event.note])).toEqual([
        ['GRANTED', 5, 'Five lessons'],
        ['USED', -2, ''],
        ['RESTORED', 1, ''],
        ['ADJUSTED', -1, 'Package size changed'],
        ['USED', -1, 'forged'],
        ['RESTORED', 1, ''],
        ['BOOKED', -1, 'Scoped label'],
        ['USED', -1, ''],
      ]);
    });

    it('rejects ledger updates and independent deletes but cascades with its package or business', async () => {
      const student = await createStudent(f);
      const pkg = await createPackage(f, student.id);
      const [event] = await ledger(pkg.id);
      await expectSqlState(() => prisma.$executeRaw`UPDATE "PackageCreditEvent" SET "note" = 'rewritten' WHERE "id" = ${event!.id}`,
        '23514', 'Package credit history is append-only');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "PackageCreditEvent" SET "delta" = 99 WHERE "id" = ${event!.id}`,
        '23514', 'Package credit history is append-only');
      await expectSqlState(() => prisma.$executeRaw`DELETE FROM "PackageCreditEvent" WHERE "id" = ${event!.id}`,
        '23514', 'Package credit history is append-only');
      expect(await ledger(pkg.id)).toHaveLength(1);

      await prisma.lessonPackage.delete({ where: { id: pkg.id } });
      expect(await prisma.packageCreditEvent.count({ where: { packageId: pkg.id } })).toBe(0);

      const kept = await createPackage(f, student.id, { usedCredits: 1 });
      expect(await prisma.packageCreditEvent.count({ where: { packageId: kept.id } })).toBe(2);
      const rollback = new Error('Roll back the whole-business teardown');
      await expect(prisma.$transaction(async tx => {
        // A complete business teardown takes the ledger with it even while the
        // package row is removed by the same cascade.
        await tx.business.delete({ where: { id: f.business.id } });
        await tx.user.delete({ where: { id: f.user.id } });
        expect(await tx.packageCreditEvent.count({ where: { businessId: f.business.id } })).toBe(0);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await prisma.packageCreditEvent.count({ where: { packageId: kept.id } })).toBe(2);
    });
  });

  it('accepts the attendance vocabulary and nothing else', async () => {
    const { participantId } = await bookedPlace();
    for (const attendance of ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'UNMARKED']) {
      await prisma.$executeRaw`UPDATE "Participant" SET "attendance" = ${attendance} WHERE "id" = ${participantId}`;
    }
    await expectSqlState(() => prisma.$executeRaw`UPDATE "Participant" SET "attendance" = 'MAYBE' WHERE "id" = ${participantId}`, '23514');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "Participant" SET "attendance" = 'present' WHERE "id" = ${participantId}`, '23514');
  });

  it('lets only coach accounts carry a bounded coach profile', async () => {
    const coachId = f.coachUser.id;
    await prisma.$executeRaw`UPDATE "User" SET
      "bio" = ${'Patient technical coach.'}, "languages" = ARRAY['English','Mandarin']::TEXT[],
      "coachingLevels" = ARRAY['BEGINNER','COMPETITIVE']::TEXT[], "coachingAgeGroups" = ARRAY['JUNIOR','SENIOR']::TEXT[],
      "qualifications" = ARRAY['Level 2 coach']::TEXT[], "coachingSince" = 2012
      WHERE "id" = ${coachId}`;
    await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "coachingLevels" = ARRAY['PRO']::TEXT[] WHERE "id" = ${coachId}`, '23514');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "coachingAgeGroups" = ARRAY['TODDLER']::TEXT[] WHERE "id" = ${coachId}`, '23514');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "coachingSince" = 1949 WHERE "id" = ${coachId}`, '23514');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "bio" = ${'x'.repeat(601)} WHERE "id" = ${coachId}`, '23514');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "languages" = ${Array.from({ length: 9 }, (_, index) => `Language ${index}`)} WHERE "id" = ${coachId}`, '23514');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "qualifications" = ${Array.from({ length: 11 }, (_, index) => `Course ${index}`)} WHERE "id" = ${coachId}`, '23514');

    // Students and club accounts cannot carry any coach-profile value.
    const student = await createStudent(f);
    for (const userId of [student.userId!, f.user.id]) {
      await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "bio" = 'I coach too' WHERE "id" = ${userId}`, '23514');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "languages" = ARRAY['English']::TEXT[] WHERE "id" = ${userId}`, '23514');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "coachingSince" = 2015 WHERE "id" = ${userId}`, '23514');
    }
    // A coach whose type would change while keeping profile values is rejected.
    await expectSqlState(() => prisma.$executeRaw`UPDATE "User" SET "accountType" = 'STUDENT' WHERE "id" = ${coachId}`, '23514');
  });

  it('bounds the public club profile and venue area', async () => {
    const businessId = f.business.id;
    await prisma.$executeRaw`UPDATE "Business" SET "websiteUrl" = 'https://club.example/about', "description" = ${'d'.repeat(1200)}, "publicPhone" = '+65 6123 4567' WHERE "id" = ${businessId}`;
    await prisma.$executeRaw`UPDATE "Business" SET "websiteUrl" = '' WHERE "id" = ${businessId}`;
    for (const website of ['http://club.example', 'club.example', 'https://club example', 'https://', `https://${'a'.repeat(200)}`]) {
      await expectSqlState(() => prisma.$executeRaw`UPDATE "Business" SET "websiteUrl" = ${website} WHERE "id" = ${businessId}`, '23514');
    }
    await expectSqlState(() => prisma.$executeRaw`UPDATE "Business" SET "description" = ${'d'.repeat(1201)} WHERE "id" = ${businessId}`, '23514');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "Business" SET "publicPhone" = ${'6'.repeat(41)} WHERE "id" = ${businessId}`, '23514');
    await prisma.$executeRaw`UPDATE "Location" SET "area" = 'Kallang · Central' WHERE "id" = ${f.location.id}`;
    await expectSqlState(() => prisma.$executeRaw`UPDATE "Location" SET "area" = ${'a'.repeat(61)} WHERE "id" = ${f.location.id}`, '23514');
  });

  describe('session feedback', () => {
    async function insertFeedback(values: { bookingId: string; participantId: string; visibility?: string; sharedAt?: Date | null }) {
      const id = `feedback-${randomUUID()}`;
      await prisma.$executeRaw`INSERT INTO "SessionFeedback" (
        "id", "businessId", "bookingId", "participantId", "authorUserId", "authorName", "authorRole",
        "visibility", "summary", "sharedAt", "updatedAt"
      ) VALUES (
        ${id}, ${f.business.id}, ${values.bookingId}, ${values.participantId}, ${f.coachUser.id}, 'Test Coach', 'COACH',
        ${values.visibility ?? 'PRIVATE'}, 'Good session', ${values.sharedAt ?? null}::timestamptz AT TIME ZONE 'UTC', CURRENT_TIMESTAMP
      )`;
      return id;
    }

    it('pins feedback to a participant of its own booking', async () => {
      const first = await bookedPlace();
      const second = await bookedPlace(2);
      await expectSqlState(() => insertFeedback({ bookingId: second.bookingId, participantId: first.participantId }),
        '23503', 'Session feedback must name a participant of its booking');
      const id = await insertFeedback(first);
      // One feedback row per place.
      await expectSqlState(() => insertFeedback(first), '23505');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "SessionFeedback" SET "participantId" = ${second.participantId} WHERE "id" = ${id}`,
        '23514', 'immutable');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "SessionFeedback" SET "bookingId" = ${second.bookingId} WHERE "id" = ${id}`,
        '23514', 'immutable');
    });

    it('keeps the author snapshot and first-shared time immutable while content stays editable', async () => {
      const place = await bookedPlace();
      await expectSqlState(() => insertFeedback({ ...place, visibility: 'SHARED', sharedAt: null }), '23514');
      await expectSqlState(() => insertFeedback({ ...place, visibility: 'PUBLIC' }), '23514');
      const id = await insertFeedback(place);
      await expectSqlState(() => prisma.$executeRaw`UPDATE "SessionFeedback" SET "visibility" = 'SHARED' WHERE "id" = ${id}`, '23514');
      const sharedAt = new Date('2026-09-30T02:00:00.000Z');
      await prisma.$executeRaw`UPDATE "SessionFeedback" SET "visibility" = 'SHARED', "sharedAt" = (${sharedAt}::timestamptz AT TIME ZONE 'UTC') WHERE "id" = ${id}`;
      await prisma.$executeRaw`UPDATE "SessionFeedback" SET "summary" = 'Edited summary', "editedByName" = 'Club', "visibility" = 'PRIVATE' WHERE "id" = ${id}`;
      await expectSqlState(() => prisma.$executeRaw`UPDATE "SessionFeedback" SET "sharedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}`,
        '23514', 'first-shared time');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "SessionFeedback" SET "sharedAt" = NULL WHERE "id" = ${id}`, '23514');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "SessionFeedback" SET "authorName" = 'Someone else' WHERE "id" = ${id}`, '23514');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "SessionFeedback" SET "authorRole" = 'CLUB' WHERE "id" = ${id}`, '23514');
      expect(await prisma.sessionFeedback.findUniqueOrThrow({ where: { id } })).toMatchObject({
        summary: 'Edited summary', sharedAt, authorName: 'Test Coach', authorRole: 'COACH',
      });
    });
  });

  describe('waitlist entries', () => {
    async function insertEntry(bookingId: string, studentId: string, status = 'WAITING') {
      const id = `waitlist-${randomUUID()}`;
      await prisma.$executeRaw`INSERT INTO "WaitlistEntry" ("id", "businessId", "bookingId", "studentId", "status", "updatedAt")
        VALUES (${id}, ${f.business.id}, ${bookingId}, ${studentId}, ${status}, CURRENT_TIMESTAMP)`;
      return id;
    }

    it('allows one live entry per student and Class and never reopens a terminal decision', async () => {
      const { bookingId } = await bookedPlace();
      const student = await createStudent(f, { name: 'Queued Student' });
      const id = await insertEntry(bookingId, student.id);
      await expectSqlState(() => insertEntry(bookingId, student.id), '23505');
      await expectSqlState(() => insertEntry(bookingId, student.id, 'PENDING'), '23514');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "WaitlistEntry" SET "status" = 'OFFERED' WHERE "id" = ${id}`, '23514');
      await prisma.$executeRaw`UPDATE "WaitlistEntry" SET "status" = 'OFFERED', "offeredAt" = CURRENT_TIMESTAMP,
        "offerExpiresAt" = CURRENT_TIMESTAMP + interval '1 hour' WHERE "id" = ${id}`;
      await expectSqlState(() => insertEntry(bookingId, student.id), '23505');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "WaitlistEntry" SET "closedReason" = ${'r'.repeat(201)} WHERE "id" = ${id}`, '23514');
      await prisma.$executeRaw`UPDATE "WaitlistEntry" SET "status" = 'DECLINED', "respondedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}`;
      for (const status of ['WAITING', 'OFFERED', 'ACCEPTED']) {
        await expectSqlState(() => prisma.$executeRaw`UPDATE "WaitlistEntry" SET "status" = ${status}, "offeredAt" = CURRENT_TIMESTAMP,
          "offerExpiresAt" = CURRENT_TIMESTAMP WHERE "id" = ${id}`, '23514', 'cannot reopen');
      }
      // A new request after a terminal decision is a new row.
      const again = await insertEntry(bookingId, student.id);
      const other = await createStudent(f, { name: 'Other Queued Student' });
      await expectSqlState(() => prisma.$executeRaw`UPDATE "WaitlistEntry" SET "studentId" = ${other.id} WHERE "id" = ${again}`,
        '23514', 'cannot move');
      await expectSqlState(() => prisma.$executeRaw`UPDATE "WaitlistEntry" SET "sequence" = "sequence" + 100000 WHERE "id" = ${again}`,
        '23514', 'cannot move');
      const entries = await prisma.waitlistEntry.findMany({ where: { bookingId }, orderBy: { sequence: 'asc' } });
      expect(entries.map(entry => entry.status)).toEqual(['DECLINED', 'WAITING']);
    });
  });

  it('keeps training-group membership shape and tenancy', async () => {
    const group = await prisma.trainingGroup.create({ data: { businessId: f.business.id, name: 'Junior squad' } });
    const student = await createStudent(f);
    await expectSqlState(() => prisma.$executeRaw`INSERT INTO "TrainingGroupMember" ("id", "businessId", "groupId", "studentId", "active", "leftAt")
      VALUES (${randomUUID()}, ${f.business.id}, ${group.id}, ${student.id}, false, NULL)`, '23514');
    await expectSqlState(() => prisma.$executeRaw`INSERT INTO "TrainingGroupMember" ("id", "businessId", "groupId", "studentId", "active", "leftAt")
      VALUES (${randomUUID()}, ${f.business.id}, ${group.id}, ${student.id}, true, CURRENT_TIMESTAMP)`, '23514');
    const memberId = randomUUID();
    await prisma.$executeRaw`INSERT INTO "TrainingGroupMember" ("id", "businessId", "groupId", "studentId")
      VALUES (${memberId}, ${f.business.id}, ${group.id}, ${student.id})`;
    await expectSqlState(() => prisma.$executeRaw`UPDATE "TrainingGroupMember" SET "active" = false WHERE "id" = ${memberId}`, '23514');
    await prisma.$executeRaw`UPDATE "TrainingGroupMember" SET "active" = false, "leftAt" = CURRENT_TIMESTAMP WHERE "id" = ${memberId}`;
    await expectSqlState(() => prisma.$executeRaw`INSERT INTO "TrainingGroupMember" ("id", "businessId", "groupId", "studentId")
      VALUES (${randomUUID()}, ${f.business.id}, ${group.id}, ${student.id})`, '23505');

    const other = await tenants.fixture();
    const outsider = await createStudent(other);
    await expectSqlState(() => prisma.$executeRaw`INSERT INTO "TrainingGroupMember" ("id", "businessId", "groupId", "studentId")
      VALUES (${randomUUID()}, ${f.business.id}, ${group.id}, ${outsider.id})`, '23503');
    await expectSqlState(() => prisma.$executeRaw`INSERT INTO "TrainingGroupMember" ("id", "businessId", "groupId", "studentId")
      VALUES (${randomUUID()}, ${other.business.id}, ${group.id}, ${outsider.id})`, '23503');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "TrainingGroup" SET "capacity" = 0 WHERE "id" = ${group.id}`, '23514');
    await expectSqlState(() => prisma.$executeRaw`UPDATE "TrainingGroup" SET "name" = '' WHERE "id" = ${group.id}`, '23514');
  });

  it('stores only the funnel metric vocabulary with non-negative counts', async () => {
    await prisma.$executeRaw`INSERT INTO "ClubFunnelCounter" ("businessId", "day", "metric", "count")
      VALUES (${f.business.id}, DATE '2026-09-30', 'PAGE_VIEW', 3)`;
    await expectSqlState(() => prisma.$executeRaw`INSERT INTO "ClubFunnelCounter" ("businessId", "day", "metric", "count")
      VALUES (${f.business.id}, DATE '2026-09-30', 'VISITOR_ID', 1)`, '23514');
    await expectSqlState(() => prisma.$executeRaw`INSERT INTO "ClubFunnelCounter" ("businessId", "day", "metric", "count")
      VALUES (${f.business.id}, DATE '2026-09-30', 'BOOKING_CREATED', -1)`, '23514');
    await expectSqlState(() => prisma.$executeRaw`INSERT INTO "ClubFunnelCounter" ("businessId", "day", "metric", "count")
      VALUES (${f.business.id}, DATE '2026-09-30', 'PAGE_VIEW', 1)`, '23505');
  });
});
