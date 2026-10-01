import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  completeFamilyHandover,
  createFamilyChild,
  createFamilyHandover,
  loadFamily,
  loadFamilyChildProgress,
  loadFamilyChildSchedule,
  renewFamilyChildConsent,
  updateFamilyChild,
} from '../src/lib/api';
import { isFamilyConsentRenewalChild, type AuthSession, type Business, type ChildScheduleItem, type FamilyChild, type Membership } from '../src/lib/types';
import {
  attendanceLabel,
  canStartFamilyHandover,
  canViewFamilyTraining,
  classWhenLabel,
  clubTimeZoneNote,
  familyBookingTargets,
  familySports,
  familyUsernamePattern,
  requiredActionCopy,
  safeExternalUrl,
  scheduleStatusLabel,
  singaporeCivilDate,
  splitChildSchedule,
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

describe('Family schedule and progress entry points', () => {
  const withPermissions = (permissions: FamilyChild['link']['permissions'], overrides: Partial<FamilyChild> = {}) => managedChild({
    ...overrides,
    link: { ...managedChild().link, permissions, ...(overrides.link ?? {}) },
  });

  it('offers the read-only projections only where the server would authorize them', () => {
    expect(canViewFamilyTraining(withPermissions(['BOOKINGS_MANAGE']), '2026-09-29')).toBe(true);
    expect(canViewFamilyTraining(withPermissions(['PROFILE_MANAGE', 'CONSENT_MANAGE']), '2026-09-29')).toBe(false);
    // Stale policy, withdrawn link, restricted child, or a completed handover all fail closed.
    expect(canViewFamilyTraining(withPermissions(['BOOKINGS_MANAGE']), '2027-01-01')).toBe(false);
    expect(canViewFamilyTraining(withPermissions(['BOOKINGS_MANAGE'], { link: { ...managedChild().link, status: 'WITHDRAWN', permissions: ['BOOKINGS_MANAGE'] } }), '2026-09-29')).toBe(false);
    expect(canViewFamilyTraining(withPermissions(['BOOKINGS_MANAGE'], { accountStatus: 'DELETION_REQUESTED' }), '2026-09-29')).toBe(false);
    expect(canViewFamilyTraining(withPermissions(['BOOKINGS_MANAGE'], { accountControl: 'SELF' }), '2026-09-29')).toBe(false);
  });

  type MembershipFixture = { active?: boolean; business: Partial<Business> };
  function session(accountType: AuthSession['user']['accountType'], memberships: MembershipFixture[] = []): Pick<AuthSession, 'user' | 'memberships'> {
    return {
      user: { id: 'guardian', name: 'Avery', email: 'avery@example.test', accountType },
      memberships: memberships.map((membership, index): Membership => ({
        id: `membership-${index}`, userId: 'guardian', businessId: `business-${index}`, instructorId: null,
        active: membership.active ?? true, createdAt: '2026-01-01T00:00:00.000Z',
        business: {
          id: `business-${index}`, name: `Club ${index}`, slug: `club-${index}`, ownerName: 'Owner', email: 'club@example.test',
          timezone: 'Asia/Singapore', currency: 'SGD', color: '#214e3e', tagline: '', cancellationHours: 24,
          kind: 'CLUB', isDemo: false, legacyReadOnly: false, ...membership.business,
        },
      })),
    };
  }

  it('sends a student guardian to the club directory and a coach guardian to their own clubs', () => {
    expect(familyBookingTargets(session('STUDENT'))).toEqual([{ href: '/manage?tab=explore', clubName: null }]);
    expect(familyBookingTargets(session('COACH', [
      { business: { slug: 'elever badminton', name: 'Elever' } },
      { active: false, business: { slug: 'inactive', name: 'Old club' } },
      { business: { slug: 'legacy', name: 'Legacy', legacyReadOnly: true } },
      { business: { slug: 'solo', name: 'Solo', kind: 'SOLO' } },
      { business: { slug: 'elever badminton', name: 'Elever duplicate' } },
    ]))).toEqual([{ href: '/book/elever%20badminton', clubName: 'Elever' }]);
    expect(familyBookingTargets(session('COACH'))).toEqual([]);
    expect(familyBookingTargets(session('CLUB', [{ business: {} }]))).toEqual([]);
    expect(familyBookingTargets(null)).toEqual([]);
  });

  function item(overrides: Partial<ChildScheduleItem>): ChildScheduleItem {
    return {
      participantId: 'participant', bookingId: 'booking',
      business: { name: 'Elever', slug: 'elever', timezone: 'Asia/Singapore' },
      serviceName: 'Junior squad', sport: 'Badminton', type: 'GROUP', coachName: 'Dominic Loh',
      location: { name: 'Court 1', address: '1 Sports Way', area: 'Tampines · East', mapsUrl: 'https://maps.google.com/?q=1' },
      startAt: '2026-10-04T01:00:00.000Z', endAt: '2026-10-04T02:00:00.000Z',
      status: 'CONFIRMED', attendance: 'UNMARKED', hasFeedback: false,
      ...overrides,
    };
  }

  it('splits upcoming (including in progress) from recent and orders each for reading', () => {
    const now = new Date('2026-10-01T10:30:00.000Z').getTime();
    const items = [
      item({ participantId: 'past-old', startAt: '2026-09-01T10:00:00.000Z', endAt: '2026-09-01T11:00:00.000Z' }),
      item({ participantId: 'later', startAt: '2026-10-08T10:00:00.000Z', endAt: '2026-10-08T11:00:00.000Z' }),
      item({ participantId: 'now', startAt: '2026-10-01T10:00:00.000Z', endAt: '2026-10-01T11:00:00.000Z' }),
      item({ participantId: 'past-new', startAt: '2026-09-28T10:00:00.000Z', endAt: '2026-09-28T11:00:00.000Z' }),
    ];
    const { upcoming, recent } = splitChildSchedule(items, now);
    expect(upcoming.map(entry => entry.participantId)).toEqual(['now', 'later']);
    expect(recent.map(entry => entry.participantId)).toEqual(['past-new', 'past-old']);
  });

  it('formats Class times in the club timezone, not the viewer’s', () => {
    expect(classWhenLabel(item({}))).toEqual({ date: 'Sun, 4 Oct 2026', time: '9:00 AM – 10:00 AM' });
    expect(classWhenLabel(item({ business: { name: 'London', slug: 'london', timezone: 'Europe/London' } })))
      .toEqual({ date: 'Sun, 4 Oct 2026', time: '2:00 AM – 3:00 AM' });
    expect(clubTimeZoneNote([item({})], 'Asia/Singapore')).toBeNull();
    expect(clubTimeZoneNote([item({})], 'Europe/London')).toBe('Times are shown in the club’s time zone (Asia/Singapore).');
    expect(clubTimeZoneNote([item({}), item({ business: { name: 'L', slug: 'l', timezone: 'Europe/London' } })], 'UTC'))
      .toBe('Times are shown in each club’s own time zone.');
  });

  it('labels status and attendance without implying attendance before a Class starts', () => {
    expect(scheduleStatusLabel('PENDING')).toBe('Awaiting confirmation');
    expect(scheduleStatusLabel('COMPLETED')).toBe('Completed');
    expect(attendanceLabel('UNMARKED', false, 'CONFIRMED')).toBeNull();
    expect(attendanceLabel('UNMARKED', true, 'CONFIRMED')).toBe('Attendance not marked yet');
    expect(attendanceLabel('LATE', true, 'COMPLETED')).toBe('Attended · arrived late');
    expect(attendanceLabel('PRESENT', true, 'COMPLETED')).toBe('Attended');
    expect(attendanceLabel('ABSENT', true, 'CANCELLED')).toBeNull();
  });

  it('links to Maps only for absolute https URLs', () => {
    expect(safeExternalUrl('https://maps.google.com/?q=Court%201')).toBe('https://maps.google.com/?q=Court%201');
    for (const value of ['', null, undefined, 'javascript:alert(1)', 'http://maps.example.test', '/relative']) {
      expect(safeExternalUrl(value), String(value)).toBeNull();
    }
  });

  it('requests the child projections with an encoded child id and surfaces the privacy-safe 404', async () => {
    const calls: Call[] = [];
    mockJson({ child: { id: 'child/1', name: 'River', username: 'river_tan' }, bookings: [] }, calls);
    await loadFamilyChildSchedule('child/1');
    mockJson({ child: { id: 'child/1', name: 'River', username: 'river_tan' } }, calls);
    await loadFamilyChildProgress('child/1');
    expect(calls.map(call => call.url)).toEqual([
      '/api/family/children/child%2F1/schedule',
      '/api/family/children/child%2F1/progress',
    ]);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Child profile not found', code: 'CHILD_NOT_FOUND' }),
    })));
    const failure = await loadFamilyChildSchedule('someone-else').catch(error => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 404, message: 'Child profile not found' });
  });
});
