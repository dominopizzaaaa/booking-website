import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectSchema } from '../src/schema-health.js';
import { prisma, verifyTestDatabase } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

const trainingCompanion = 'training companion feedback, waitlist, credit ledger and discovery tables';
const protections = [
  { table: 'AccountSecurityEvent', trigger: 'AccountSecurityEvent_immutable', missing: 'account security' },
  { table: 'AccountSecurityEvent', trigger: 'AccountSecurityEvent_truncate_guard', missing: 'account security' },
  { table: 'PaymentReceipt', trigger: 'PaymentReceipt_immutable', missing: 'payment receipts' },
  { table: 'PaymentReceipt', trigger: 'PaymentReceipt_linked_snapshot_invariant', missing: 'payment receipts' },
  { table: 'PaymentReceipt', trigger: 'PaymentReceipt_delete_guard', missing: 'payment receipts' },
  { table: 'PaymentReceipt', trigger: 'PaymentReceipt_truncate_guard', missing: 'payment receipts' },
  {
    table: 'User',
    trigger: 'User_signup_evidence_immutable',
    missing: 'signup acceptance and email verification evidence',
  },
  {
    table: 'SignupAcceptanceEvidence',
    trigger: 'SignupAcceptanceEvidence_append_only',
    missing: 'signup acceptance and email verification evidence',
  },
  {
    table: 'SignupAcceptanceEvidence',
    trigger: 'SignupAcceptanceEvidence_delete_guard',
    missing: 'signup acceptance and email verification evidence',
  },
  {
    table: 'SignupAcceptanceEvidence',
    trigger: 'SignupAcceptanceEvidence_append_only_truncate',
    missing: 'signup acceptance and email verification evidence',
  },
  {
    table: 'PrivacyRequest',
    trigger: 'PrivacyRequest_contract_guard',
    missing: 'privacy request workflow',
  },
  {
    table: 'PrivacyRequestEvent',
    trigger: 'PrivacyRequestEvent_append_only',
    missing: 'privacy request workflow',
  },
  {
    table: 'PrivacyRequestEvent',
    trigger: 'PrivacyRequestEvent_append_only_truncate',
    missing: 'privacy request workflow',
  },
  {
    table: 'ChatSafetyReport',
    trigger: 'ChatSafetyReport_contract_guard',
    missing: 'chat safeguarding retention triggers',
  },
  {
    table: 'ChatSafetyReport',
    trigger: 'ChatSafetyReport_decision_audit_guard',
    missing: 'chat safeguarding retention triggers',
  },
  {
    table: 'ChatSafetyReport',
    trigger: 'ChatSafetyReport_retained_truncate',
    missing: 'chat safeguarding retention triggers',
  },
  {
    table: 'ChatSafetyAuditEvent',
    trigger: 'ChatSafetyAuditEvent_append_only',
    missing: 'chat safeguarding retention triggers',
  },
  {
    table: 'ChatSafetyAuditEvent',
    trigger: 'ChatSafetyAuditEvent_append_only_truncate',
    missing: 'chat safeguarding retention triggers',
  },
  { table: 'LessonPackage', trigger: 'LessonPackage_credit_ledger', missing: trainingCompanion },
  { table: 'PackageCreditEvent', trigger: 'PackageCreditEvent_append_only', missing: trainingCompanion },
  { table: 'SessionFeedback', trigger: 'SessionFeedback_identity_guard', missing: trainingCompanion },
  { table: 'WaitlistEntry', trigger: 'WaitlistEntry_lifecycle_guard', missing: trainingCompanion },
] as const;

describe.sequential('schema protection readiness', () => {
  it('reports the fully protected schema as ready', async () => {
    expect(await inspectSchema(prisma)).toEqual({ ready: true, missing: [] });
  });

  it.each(protections)('fails closed while $trigger is disabled', async ({ table, trigger, missing }) => {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    try {
      const health = await inspectSchema(prisma);
      expect(health.ready).toBe(false);
      expect(health.missing).toContain(missing);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
    }
    expect((await inspectSchema(prisma)).missing).not.toContain(missing);
  });

  it('fails closed when the package credit ledger trigger has been dropped', async () => {
    const rollback = new Error('Restore the dropped ledger trigger');
    // DDL is transactional in PostgreSQL, so the drop never escapes this probe.
    await expect(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('DROP TRIGGER "LessonPackage_credit_ledger" ON "LessonPackage"');
      const health = await inspectSchema(tx as unknown as PrismaClient);
      expect(health).toEqual({ ready: false, missing: [trainingCompanion] });
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await inspectSchema(prisma)).toEqual({ ready: true, missing: [] });
  });
});
