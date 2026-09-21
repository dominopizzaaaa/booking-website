import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const provisioner = readFileSync(
  new URL('../prisma/provision-elever-showcase.ts', import.meta.url),
  'utf8',
);

describe('Elever showcase provisioner safeguards', () => {
  it('requires an explicit destructive reset confirmation', () => {
    expect(provisioner).toContain(
      "const requiredConfirmation = 'DELETE ALL COURTLY APPLICATION DATA AND PROVISION ELEVER'",
    );
    expect(provisioner).toContain('process.env.ELEVER_RESET_CONFIRMATION !== requiredConfirmation');
    expect(provisioner).toContain('ELEVER_EXPECTED_DATABASE_SHA256');
    expect(provisioner).toContain("createHash('sha256').update(databaseUrl).digest()");
    expect(provisioner).toContain('timingSafeEqual(actualDatabaseFingerprint');
  });

  it('preserves migration history and validates the successful chain against the checkout', () => {
    expect(provisioner).toContain("readdirSync(new URL('./migrations/', import.meta.url)");
    expect(provisioner).toContain('const migrationsBefore = await tx.$queryRaw');
    expect(provisioner).toContain('TRUNCATE TABLE');
    expect(provisioner).not.toContain(`public."_prisma_migrations"`);
    expect(provisioner).toContain('migration.finished_at !== null && migration.rolled_back_at === null');
    expect(provisioner).toContain('unresolved failed migration');
    expect(provisioner).toContain('if (JSON.stringify(migrationsAfter) !== JSON.stringify(migrationsBefore))');
  });

  it('keeps fixture audit timestamps in chronological order', () => {
    expect(provisioner).toContain("const createdAt = DateTime.min(session.start.minus({ days: 14 }), now.minus({ hours: 3 }))");
    expect(provisioner).toContain("DateTime.min(session.start.minus({ days: 3 }), now.minus({ hours: 2 }))");
    expect(provisioner).toContain('p."paidAt" < b."createdAt"');
    expect(provisioner).toContain("address: 'Singapore Badminton Hall, 1 Lorong 23 Geylang, Singapore 388352'");
  });

  it('models the two contractual money routes explicitly', () => {
    expect(provisioner).toContain("kind: 'CLUB'");
    expect(provisioner).toContain("kind: 'SOLO'");
    expect(provisioner).toContain("paymentRoute: 'CLUB'");
    expect(provisioner).toContain("paymentRoute: 'DIRECT'");
    expect(provisioner).toContain("'STUDENT_TO_CLUB' : 'STUDENT_TO_COACH'");
    expect(provisioner).toContain("kind: 'CLUB_TO_COACH'");
  });

  it('contains the exact requested Elever people and relationships', () => {
    for (const name of [
      'Elever Badminton Academy', 'Loh Kean Hean', 'Eng Chin An',
      'James', 'Julian', 'Sean', 'Lauren', 'Aaron', 'Benjamin', 'Carol', 'Dominic',
    ]) expect(provisioner).toContain(name);
    expect(provisioner).toContain("notes: 'Kean Hean private student.'");
    expect(provisioner).toContain("notes: 'Chin An private student.'");
    expect(provisioner).toContain('dominicCompletedBookingId');
    expect(provisioner).toContain("type: 'BOOKING_CONFIRMED'");
  });
});
