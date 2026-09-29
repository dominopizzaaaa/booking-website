import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectSchema } from '../src/schema-health.js';
import { prisma, verifyTestDatabase } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

const protections = [
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
});
