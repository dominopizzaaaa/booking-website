import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ACTION_REQUIRED,
  ADULT_AGE,
  CHILD_ACCOUNT_HANDOVER_STATUSES,
  CHILD_AGE,
  CHILD_CONSENT_EVENT_TYPES,
  CURRENT_PRIVACY_POLICY_VERSION,
  DEFAULT_GUARDIAN_PERMISSIONS,
  DateOfBirthValidationError,
  GUARDIAN_CHILD_LINK_STATUSES,
  GUARDIAN_PERMISSIONS,
  ageBand,
  ageOnSingaporeDate,
  evaluateAccountPolicy,
  isCurrentPrivacyPolicyVersion,
  parseDateOfBirth,
  type AccountPolicyInput,
} from '../src/children-policy.js';

const singaporeNow = (localDateTime: string) => new Date(`${localDateTime}+08:00`);

const policyInput = (overrides: Partial<AccountPolicyInput> = {}): AccountPolicyInput => ({
  accountType: 'STUDENT',
  dateOfBirth: '2000-01-01',
  accountControl: 'SELF',
  accountStatus: 'ACTIVE',
  profileVisibility: 'PUBLIC',
  hasCurrentConsent: false,
  now: singaporeNow('2026-09-29T12:00:00'),
  ...overrides,
});

const enabledCapabilities = (capabilities: Record<string, boolean>) =>
  Object.entries(capabilities).filter(([, enabled]) => enabled).map(([name]) => name).sort();

describe('parseDateOfBirth', () => {
  it('returns a UTC-midnight Date that is safe for a PostgreSQL date column', () => {
    const parsed = parseDateOfBirth('2013-09-29');
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.toISOString()).toBe('2013-09-29T00:00:00.000Z');
  });

  it.each([
    '',
    '2013-9-29',
    ' 2013-09-29',
    '2013-09-29 ',
    '2013-09-29T00:00:00Z',
    '0000-01-01',
    '2013-00-10',
    '2013-13-10',
    '2013-04-31',
    '2013-02-29',
  ])('rejects a malformed or impossible date: %s', value => {
    expect(() => parseDateOfBirth(value)).toThrow(DateOfBirthValidationError);
  });

  it('accepts Gregorian leap days, including a year below 100', () => {
    expect(parseDateOfBirth('2008-02-29').toISOString()).toBe('2008-02-29T00:00:00.000Z');
    expect(parseDateOfBirth('2004-02-29').toISOString()).toBe('2004-02-29T00:00:00.000Z');
    expect(() => parseDateOfBirth('1899-12-31')).toThrow(DateOfBirthValidationError);
    expect(() => parseDateOfBirth('1900-02-29')).toThrow(DateOfBirthValidationError);
    expect(parseDateOfBirth('2000-02-29').toISOString()).toBe('2000-02-29T00:00:00.000Z');
  });
});

describe('Singapore age boundaries', () => {
  it('changes age at midnight in Singapore, not at UTC midnight', () => {
    const dob = parseDateOfBirth('2013-09-30');
    expect(ageOnSingaporeDate(dob, new Date('2026-09-29T15:59:59.999Z'))).toBe(12);
    expect(ageOnSingaporeDate(dob, new Date('2026-09-29T16:00:00.000Z'))).toBe(13);
  });

  it('uses the day before and exact birthday for the child and adult boundaries', () => {
    expect(ageOnSingaporeDate('2013-09-30', singaporeNow('2026-09-29T23:59:59'))).toBe(12);
    expect(ageOnSingaporeDate('2013-09-30', singaporeNow('2026-09-30T00:00:00'))).toBe(CHILD_AGE);
    expect(ageOnSingaporeDate('2008-09-30', singaporeNow('2026-09-29T23:59:59'))).toBe(17);
    expect(ageOnSingaporeDate('2008-09-30', singaporeNow('2026-09-30T00:00:00'))).toBe(ADULT_AGE);
  });

  it('advances a leap-day birthday on 1 March in a non-leap year', () => {
    expect(ageOnSingaporeDate('2008-02-29', singaporeNow('2026-02-28T23:59:59'))).toBe(17);
    expect(ageOnSingaporeDate('2008-02-29', singaporeNow('2026-03-01T00:00:00'))).toBe(18);
  });

  it('returns null for an unknown legacy DOB and rejects a future DOB', () => {
    expect(ageOnSingaporeDate(null, singaporeNow('2026-09-29T12:00:00'))).toBeNull();
    expect(() => ageOnSingaporeDate('2026-09-30', singaporeNow('2026-09-29T23:59:59')))
      .toThrow('Date of birth cannot be in the future');
  });
});

describe('ageBand', () => {
  it.each([
    [null, 'UNKNOWN'],
    [0, 'CHILD'],
    [12, 'CHILD'],
    [13, 'TEEN'],
    [17, 'TEEN'],
    [18, 'ADULT'],
  ] as const)('maps %s to %s', (age, expected) => {
    expect(ageBand(age)).toBe(expected);
  });

  it('supports explicit policy boundaries without changing the exported defaults', () => {
    expect(ageBand(15, { childAge: 16, adultAge: 21 })).toBe('CHILD');
    expect(ageBand(16, { childAge: 16, adultAge: 21 })).toBe('TEEN');
    expect(ageBand(21, { childAge: 16, adultAge: 21 })).toBe('ADULT');
    expect(CHILD_AGE).toBe(13);
    expect(ADULT_AGE).toBe(18);
  });

  it('rejects invalid ages and boundary configurations', () => {
    expect(() => ageBand(-1)).toThrow(RangeError);
    expect(() => ageBand(12.5)).toThrow(RangeError);
    expect(() => ageBand(18, { childAge: 18, adultAge: 18 })).toThrow(RangeError);
  });
});

describe('evaluateAccountPolicy', () => {
  it('keeps an unknown-DOB legacy personal account usable while requiring age review', () => {
    const decision = evaluateAccountPolicy(policyInput({ dateOfBirth: null }));
    expect(decision).toMatchObject({
      age: null,
      ageBand: 'UNKNOWN',
      needsAgeReview: true,
      accountActionRequired: false,
      reason: null,
      publiclyDiscoverable: true,
    });
    expect(Object.values(decision.capabilities).every(Boolean)).toBe(true);
  });

  it('does not require institutional club accounts to provide a DOB', () => {
    const decision = evaluateAccountPolicy(policyInput({ accountType: 'CLUB', dateOfBirth: null }));
    expect(decision.needsAgeReview).toBe(false);
    expect(enabledCapabilities(decision.capabilities)).toEqual([
      'chat', 'commerce', 'directory', 'ordinaryAccess', 'payments', 'profileEdit',
      'rentals', 'staffAccess', 'workspace',
    ]);
  });

  it('gates a self-controlled child and leaves only profile remediation available', () => {
    const decision = evaluateAccountPolicy(policyInput({ dateOfBirth: '2014-09-29' }));
    expect(decision).toMatchObject({
      age: 12,
      ageBand: 'CHILD',
      accountActionRequired: true,
      reason: 'PARENT_ACCOUNT_REQUIRED',
      publiclyDiscoverable: false,
    });
    expect(enabledCapabilities(decision.capabilities)).toEqual(['profileEdit']);
  });

  it('allows a self-controlled teen ordinary non-commercial account features', () => {
    const decision = evaluateAccountPolicy(policyInput({ dateOfBirth: '2013-09-29' }));
    expect(decision).toMatchObject({
      age: 13,
      ageBand: 'TEEN',
      accountActionRequired: false,
      reason: null,
      publiclyDiscoverable: true,
    });
    expect(enabledCapabilities(decision.capabilities)).toEqual([
      'calendar', 'chat', 'directory', 'ordinaryAccess', 'profileEdit',
    ]);
  });

  it('allows adult SELF personal accounts all account-level capabilities', () => {
    for (const accountType of ['STUDENT', 'COACH'] as const) {
      const decision = evaluateAccountPolicy(policyInput({ accountType }));
      expect(decision.ageBand).toBe('ADULT');
      expect(Object.values(decision.capabilities).every(Boolean)).toBe(true);
    }
  });

  it('keeps public discoverability separate from the ability to use the directory', () => {
    for (const profileVisibility of ['PRIVATE', 'CLUBS_ONLY'] as const) {
      const decision = evaluateAccountPolicy(policyInput({
        dateOfBirth: '2013-09-29',
        profileVisibility,
      }));
      expect(decision.capabilities.directory).toBe(true);
      expect(decision.publiclyDiscoverable).toBe(false);
    }
  });

  it('gives a valid guardian-managed child no direct-account capabilities', () => {
    const decision = evaluateAccountPolicy(policyInput({
      dateOfBirth: '2016-09-29',
      accountControl: 'GUARDIAN_MANAGED',
      profileVisibility: 'PUBLIC',
      hasCurrentConsent: true,
    }));
    expect(decision).toMatchObject({
      ageBand: 'CHILD',
      accountActionRequired: false,
      reason: null,
      sessionStale: false,
      publiclyDiscoverable: false,
    });
    expect(Object.values(decision.capabilities).some(Boolean)).toBe(false);
  });

  it('requires current consent for every guardian-managed minor', () => {
    for (const dateOfBirth of ['2016-09-29', '2010-09-29', null] as const) {
      const decision = evaluateAccountPolicy(policyInput({
        dateOfBirth,
        accountControl: 'GUARDIAN_MANAGED',
        hasCurrentConsent: false,
      }));
      expect(decision).toMatchObject({
        accountActionRequired: true,
        reason: 'CONSENT_REQUIRED',
      });
    }
  });

  it('requires handover once a guardian-managed child reaches adulthood', () => {
    const before = evaluateAccountPolicy(policyInput({
      dateOfBirth: '2008-09-30',
      accountControl: 'GUARDIAN_MANAGED',
      hasCurrentConsent: true,
      now: singaporeNow('2026-09-29T23:59:59'),
    }));
    const onBirthday = evaluateAccountPolicy(policyInput({
      dateOfBirth: '2008-09-30',
      accountControl: 'GUARDIAN_MANAGED',
      hasCurrentConsent: true,
      now: singaporeNow('2026-09-30T00:00:00'),
    }));
    expect(before.accountActionRequired).toBe(false);
    expect(onBirthday).toMatchObject({
      age: 18,
      needsHandover: true,
      accountActionRequired: true,
      reason: 'HANDOVER_REQUIRED',
    });
  });

  it('treats every direct guardian-managed session as stale', () => {
    const decision = evaluateAccountPolicy(policyInput({
      dateOfBirth: '2010-09-29',
      accountControl: 'GUARDIAN_MANAGED',
      hasCurrentConsent: true,
      sessionCreatedAt: new Date('2026-09-29T00:00:00Z'),
    }));
    expect(decision).toMatchObject({
      sessionStale: true,
      accountActionRequired: true,
      reason: 'GUARDIAN_SESSION_STALE',
    });
    expect(Object.values(decision.capabilities).some(Boolean)).toBe(false);
  });

  it('uses the stable remediation-reason precedence for inconsistent legacy rows', () => {
    const deletion = evaluateAccountPolicy(policyInput({
      dateOfBirth: '2000-01-01',
      accountControl: 'GUARDIAN_MANAGED',
      accountStatus: 'DELETION_REQUESTED',
      hasCurrentConsent: false,
      sessionCreatedAt: new Date('2026-09-29T00:00:00Z'),
    }));
    const stale = evaluateAccountPolicy(policyInput({
      dateOfBirth: '2000-01-01',
      accountControl: 'GUARDIAN_MANAGED',
      accountStatus: 'CONSENT_REQUIRED',
      hasCurrentConsent: false,
      sessionCreatedAt: new Date('2026-09-29T00:00:00Z'),
    }));
    const handover = evaluateAccountPolicy(policyInput({
      dateOfBirth: '2000-01-01',
      accountControl: 'GUARDIAN_MANAGED',
      accountStatus: 'CONSENT_REQUIRED',
      hasCurrentConsent: false,
    }));
    const consent = evaluateAccountPolicy(policyInput({
      dateOfBirth: '2014-09-29',
      accountStatus: 'CONSENT_REQUIRED',
    }));

    expect(deletion.reason).toBe('DELETION_REQUESTED');
    expect(stale.reason).toBe('GUARDIAN_SESSION_STALE');
    expect(handover.reason).toBe('HANDOVER_REQUIRED');
    expect(consent.reason).toBe('CONSENT_REQUIRED');
  });

  it('keeps the action code and current privacy policy version stable', () => {
    expect(ACCOUNT_ACTION_REQUIRED).toBe('ACCOUNT_ACTION_REQUIRED');
    expect(CURRENT_PRIVACY_POLICY_VERSION).toBe('2026-09-29');
    expect(isCurrentPrivacyPolicyVersion('2026-09-29')).toBe(true);
    expect(isCurrentPrivacyPolicyVersion('2026-09-28')).toBe(false);
    expect(isCurrentPrivacyPolicyVersion(null)).toBe(false);
  });

  it('exports one immutable vocabulary for guardian authority and lifecycle records', () => {
    expect(GUARDIAN_CHILD_LINK_STATUSES).toEqual(['ACTIVE', 'WITHDRAWN', 'ENDED']);
    expect(GUARDIAN_PERMISSIONS).toEqual([
      'PROFILE_MANAGE',
      'BOOKINGS_MANAGE',
      'CREDENTIAL_RESET',
      'PRIVACY_MANAGE',
      'DATA_EXPORT',
      'CONSENT_MANAGE',
      'DELETION_REQUEST',
      'HANDOVER_MANAGE',
    ]);
    expect(DEFAULT_GUARDIAN_PERMISSIONS).toEqual(GUARDIAN_PERMISSIONS);
    expect(CHILD_CONSENT_EVENT_TYPES).toEqual([
      'GRANTED',
      'RENEWED',
      'WITHDRAWN',
      'HANDOVER_STARTED',
      'HANDOVER_CANCELLED',
      'HANDOVER_COMPLETED',
      'DELETION_REQUESTED',
    ]);
    expect(CHILD_ACCOUNT_HANDOVER_STATUSES).toEqual([
      'PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED',
    ]);
    expect(Object.isFrozen(GUARDIAN_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GUARDIAN_PERMISSIONS)).toBe(true);
  });
});
