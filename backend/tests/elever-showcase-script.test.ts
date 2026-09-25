import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const provisioner = readFileSync(
  new URL('../prisma/provision-elever-showcase.ts', import.meta.url),
  'utf8',
);
const verifier = readFileSync(
  new URL('../../scripts/verify-elever-showcase.mjs', import.meta.url),
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
    expect(provisioner).toContain("const createdAt = DateTime.min(session.start.minus({ days: 14 }), showcaseNow.minus({ hours: 3 }))");
    expect(provisioner).toContain("DateTime.min(createdAt.plus({ days: 2 }), showcaseNow.minus({ hours: 2 }))");
    expect(provisioner).toContain('p."paidAt" < b."createdAt"');
    expect(provisioner).toContain("address: 'Singapore Badminton Hall, 1 Lorong 23 Geylang, Singapore 388352'");
  });

  it('models only the active club money route while retaining the historical vocabulary', () => {
    expect(provisioner).toContain("kind: 'CLUB'");
    expect(provisioner).toContain("paymentRoute: 'CLUB'");
    expect(provisioner).not.toContain("kind: 'SOLO'");
    expect(provisioner).not.toContain("paymentRoute: 'DIRECT'");
    expect(provisioner).not.toContain("kind: 'STUDENT_TO_COACH'");
    expect(provisioner).toContain("kind: 'CLUB_TO_COACH'");
  });

  it('contains the October 2026 people, classes, packages, rentals, and linked integrity alert', () => {
    for (const name of [
      'Elever Badminton Academy', 'Loh Kean Hean', 'Eng Chin An',
      'James', 'Julian', 'Sean', 'Lauren', 'Aaron', 'Benjamin', 'Carol', 'Dominic',
    ]) expect(provisioner).toContain(name);
    expect(provisioner).toContain('Array.from({ length: 12 }');
    expect(provisioner).toContain("year: 2026, month: 10");
    expect(provisioner).toContain("name: 'Junior Performance Class'");
    expect(provisioner).toContain("name: '1:1 Badminton Coaching'");
    expect(provisioner).toContain("name: 'Elever Play Pass'");
    expect(provisioner).toContain("name: 'Elever Kallang Courts'");
    expect(provisioner).toContain("provider: 'SIMULATED_STRIPE'");
    expect(provisioner).toContain('integrityFlagId: integrityFlag.id');
  });

  it('makes production verification prove every student and October class date', () => {
    expect(verifier).toContain('const expectedStudentNames = [');
    expect(verifier).toContain('...Array.from({ length: 12 }');
    expect(verifier).toContain('const expectedOctoberDates = Array.from(');
    expect(verifier).toContain("timeZone: 'Asia/Singapore'");
    expect(verifier).toContain('groupClasses.length !== 9 || privateClasses.length !== 30');
    expect(verifier).toContain("booking.serviceName !== 'Junior Performance Class'");
    expect(verifier).toContain("booking.serviceName !== '1:1 Badminton Coaching'");
  });
});
