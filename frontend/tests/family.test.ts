import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeFamilyHandover,
  createFamilyChild,
  createFamilyHandover,
  loadFamily,
  renewFamilyChildConsent,
  updateFamilyChild,
} from '../src/lib/api';
import { isFamilyConsentRenewalChild, type FamilyChild } from '../src/lib/types';
import {
  canStartFamilyHandover,
  familySports,
  familyUsernamePattern,
  requiredActionCopy,
  singaporeCivilDate,
  validPastDate,
} from '../src/components/family/family-helpers';

type Call = { url: string; init: RequestInit };

function mockJson(body: unknown, calls: Call[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
    };
  }));
}

function managedChild(overrides: Partial<FamilyChild> = {}): FamilyChild {
  return {
    id: 'child-1',
    legalName: 'River Tan',
    displayName: 'River',
    username: 'river_tan',
    dateOfBirth: '2012-09-29',
    sports: ['Tennis'],
    profileVisibility: 'CLUBS_ONLY',
    accountControl: 'GUARDIAN_MANAGED',
    accountStatus: 'ACTIVE',
    ageBand: 'TEEN',
    requiredAction: null,
    link: {
      id: 'link-1',
      status: 'ACTIVE',
      relationshipType: 'Parent',
      permissions: ['PROFILE_MANAGE', 'CONSENT_MANAGE', 'HANDOVER_MANAGE'],
      createdAt: '2026-09-01T00:00:00.000Z',
      endedAt: null,
    },
    consent: {
      status: 'GRANTED',
      policyVersion: '2026-09-29',
      consentedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: null,
      withdrawnAt: null,
    },
    handover: null,
    deletionRequestedAt: null,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Family civil-date and form validation', () => {
  it('uses the Singapore civil day at the UTC boundary', () => {
    expect(singaporeCivilDate(new Date('2026-09-29T16:30:00.000Z'))).toBe('2026-09-30');
  });

  it('accepts only real dates from 1900 through the current Singapore day', () => {
    const now = new Date('2026-09-29T16:30:00.000Z');
    expect(validPastDate('2026-09-30', now)).toBe(true);
    for (const value of ['29-09-2026', '1899-12-31', '2026-02-29', '2026-10-01', '']) {
      expect(validPastDate(value, now), value).toBe(false);
    }
  });

  it('normalises sports and enforces the canonical username shape', () => {
    expect(familySports(' Tennis, badminton, tennis ')).toEqual(['Tennis', 'badminton']);
    expect(familySports('Tennis,,Padel')).toBeNull();
    expect(familyUsernamePattern.test('child_123')).toBe(true);
    expect(familyUsernamePattern.test('Child-123')).toBe(false);
  });
});

describe('Family policy helpers', () => {
  it('treats the privacy-minimal serializer as a distinct renewal entry', () => {
    expect(isFamilyConsentRenewalChild({
      id: 'child-1',
      displayName: 'River',
      access: 'CONSENT_RENEWAL',
      link: { id: 'link-1', status: 'WITHDRAWN', relationshipType: 'Parent' },
      consent: {
        status: 'WITHDRAWN', policyVersion: '2026-09-29',
        consentedAt: '2026-09-01T00:00:00.000Z', expiresAt: null,
        withdrawnAt: '2026-09-20T00:00:00.000Z',
      },
    })).toBe(true);
    expect(isFamilyConsentRenewalChild(managedChild())).toBe(false);
  });

  it('allows server-reported teen and adult handover, but not child or stale consent', () => {
    expect(canStartFamilyHandover(managedChild({ ageBand: 'TEEN' }), '2026-09-29')).toBe(true);
    expect(canStartFamilyHandover(managedChild({ ageBand: 'ADULT' }), '2026-09-29')).toBe(true);
    expect(canStartFamilyHandover(managedChild({ ageBand: 'CHILD' }), '2026-09-29')).toBe(false);
    expect(canStartFamilyHandover(managedChild(), '2027-01-01')).toBe(false);
    expect(canStartFamilyHandover(managedChild({ handover: {
      id: 'handover-1', status: 'PENDING', maskedDestinationEmail: 'r***@example.test',
      createdAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-09-30T00:00:00.000Z',
      completedAt: null, cancelledAt: null, emailQueued: true,
    } }), '2026-09-29')).toBe(false);
  });

  it('describes deletion as immediate restriction followed by human review', () => {
    expect(requiredActionCopy('DELETION_REQUESTED')).toEqual({
      title: 'Deletion request pending',
      detail: 'This account is restricted immediately while the deletion request awaits separate human review.',
    });
  });
});

describe('Family API contract', () => {
  it('preserves reduced renewal rows and the dedicated handover capability', async () => {
    const calls: Call[] = [];
    mockJson({
      guardian: { eligible: true, reason: null },
      children: [{
        id: 'child-1', displayName: 'River', access: 'CONSENT_RENEWAL',
        link: { id: 'link-1', status: 'WITHDRAWN', relationshipType: 'Parent' },
        consent: null,
      }],
      privacyPolicyVersion: '2026-09-29',
      handoverAvailable: true,
    }, calls);

    const family = await loadFamily();
    expect(family.handoverAvailable).toBe(true);
    expect(isFamilyConsentRenewalChild(family.children[0])).toBe(true);
    expect(calls[0].url).toBe('/api/family');
  });

  it('sends explicit guardian and policy evidence when renewing consent', async () => {
    const calls: Call[] = [];
    mockJson({ child: managedChild() }, calls);
    await renewFamilyChildConsent('child / one', '2026-09-29');
    expect(calls[0].url).toBe('/api/family/children/child%20%2F%20one/consent/renew');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      legalGuardianConfirmed: true,
      privacyPolicyVersion: '2026-09-29',
    });
  });

  it('sends the exact child-creation allowlist', async () => {
    const calls: Call[] = [];
    const child = managedChild();
    mockJson({ child }, calls);
    const input = {
      legalName: child.legalName, displayName: child.displayName, username: child.username,
      dateOfBirth: child.dateOfBirth, sports: child.sports, relationship: 'Parent',
      profileVisibility: 'CLUBS_ONLY' as const, legalGuardianConfirmed: true as const,
      privacyPolicyVersion: '2026-09-29',
    };
    await createFamilyChild(input);
    expect(JSON.parse(String(calls[0].init.body))).toEqual(input);
  });

  it('sends only editable profile fields when updating a child', async () => {
    const calls: Call[] = [];
    mockJson({ child: managedChild() }, calls);
    const update = {
      legalName: 'River Lee', displayName: 'River', sports: ['Padel'],
      profileVisibility: 'PRIVATE' as const,
    };
    await updateFamilyChild('child-1', update);
    expect(calls[0].init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(update);
  });

  it('queues handover with an email and completes it with only the password', async () => {
    const calls: Call[] = [];
    mockJson({ handover: managedChild().handover, emailQueued: true }, calls);
    await createFamilyHandover('child-1', 'river@example.test');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ destinationEmail: 'river@example.test' });

    calls.length = 0;
    mockJson({ ok: true }, calls);
    await completeFamilyHandover('secret/token', 'A secure password');
    expect(calls[0].url).toBe('/api/family/handovers/secret%2Ftoken/complete');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ password: 'A secure password' });
  });
});
