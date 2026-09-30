import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, adminBusinesses, adminLogin, adminSession, api, applyAdminSafeguardingAccountAction, assignChatCoach, beginGoogleCalendarConnection, blockChatAccount, cancelAccountBooking, cancelPrivacyRequest,
  counterChatProposal, createAccountChat, createPrivacyRequest, disconnectGoogleCalendar,
  loadAccountBookings, loadAccountClubs, loadAdminPrivacyRequestEvents, loadAdminPrivacyRequests, loadAdminSafeguardingReport, loadAdminSafeguardingReports, loadCalendarConnection, loadChatThread, loadChatThreads, loadClubSafeguardingReport, loadPrivacyRequests, loadSlots, loadWorkspace,
  normalizeCalendarConnection, proposeChatSession, removeChatCoach, reportChatMessage, respondToRescheduleRequest, reversePayment, searchVenues,
  syncGoogleCalendar, unblockChatAccount, updateAdminSafeguardingReport, updateCalendarConnection, updateClubSafeguardingReport,
  completeMfaLogin, confirmAccountEmailChange, confirmTotpEnrollment, disableAccountMfa, isMfaLoginChallenge,
  loadAccountSecurity, loginAccount, reauthenticateAccount, regenerateMfaRecoveryCodes, requestAccountEmailChange,
  requestPasswordReset, resetAccountPassword, revokeAccountSecuritySession, revokeOtherAccountSecuritySessions, startTotpEnrollment,
  resendAccountEmailVerification, updateAdminPrivacyRequest, verifyAccountEmail,
} from '../src/lib/api';
import { registerRecentAuthHandler } from '../src/lib/recent-auth-coordinator';
import { isCoachClubWorkspace, isManagerWorkspace, type WorkspaceResponse, type WorkspaceWireResponse } from '../src/lib/types';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function respond(body: unknown, init: { status?: number; contentType?: string | null } = {}) {
  const contentType = init.contentType === undefined ? 'application/json' : init.contentType;
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, requestInit: RequestInit = {}) => {
    calls.push({ url, init: requestInit });
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => body,
    };
  }));
}

function respondSequence(bodies: unknown[]) {
  let index = 0;
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, requestInit: RequestInit = {}) => {
    calls.push({ url, init: requestInit });
    const body = bodies[index++];
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => body,
    };
  }));
}

function respondResults(results: Array<{ body: unknown; status?: number }>) {
  let index = 0;
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, requestInit: RequestInit = {}) => {
    calls.push({ url, init: requestInit });
    const result = results[index++];
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => result.body,
    };
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('api', () => {
  it('sends JSON with credentials to the /api prefix', async () => {
    respond({ ok: true });
    await api('/health');
    expect(calls[0].url).toBe('/api/health');
    expect(calls[0].init.credentials).toBe('include');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('surfaces the server sentence and status for a rejected request', async () => {
    respond({ error: 'Cancellation requires 24 hours notice.' }, { status: 400 });
    await expect(api('/bookings')).rejects.toMatchObject({
      message: 'Cancellation requires 24 hours notice.',
      status: 400,
    });
  });

  it('carries conflict details through so the caller can list the clashes', async () => {
    respond({ error: 'Unavailable', conflicts: [{ date: '2026-03-01', reason: 'Coach is booked elsewhere' }] }, { status: 409 });
    const failure = await api('/bookings').catch(error => error as ApiError);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).details).toMatchObject({ conflicts: [{ reason: 'Coach is booked elsewhere' }] });
  });

  // A proxy or gateway that returns HTML must not reach `response.json()` and
  // surface a parser error to the person booking a lesson.
  it('turns a non-JSON response into a service-unavailable sentence', async () => {
    respond('<html>502</html>', { status: 502, contentType: 'text/html' });
    await expect(api('/workspace')).rejects.toMatchObject({
      message: 'The booking service is temporarily unavailable. Please try again.',
      status: 502,
    });
  });

  it('falls back to a generic sentence when an error body carries no message', async () => {
    respond({}, { status: 500 });
    await expect(api('/workspace')).rejects.toMatchObject({ message: 'Something went wrong. Please try again.' });
  });

  it('prompts once and retries a recent-auth-protected request once', async () => {
    respondResults([
      { body: { error: 'Confirm your identity to continue', code: 'RECENT_AUTH_REQUIRED' }, status: 428 },
      { body: { ok: true }, status: 200 },
    ]);
    const prompt = vi.fn(async () => undefined);
    const unregister = registerRecentAuthHandler(prompt);
    await expect(api('/protected', { method: 'POST', body: '{}' })).resolves.toEqual({ ok: true });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    unregister();
  });
});

describe('verifyAccountEmail', () => {
  it('posts the verification bearer in the JSON body rather than the URL', async () => {
    respond({ ok: true, verifiedAt: '2026-09-29T00:00:00.000Z' });
    await verifyAccountEmail('verification_bearer');
    expect(calls[0].url).toBe('/api/auth/verify-email');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: 'verification_bearer' });
  });

  it('requests a replacement verification email for the signed-in account', async () => {
    respond({ ok: true, emailQueued: true, alreadyVerified: false });
    await resendAccountEmailVerification();
    expect(calls[0].url).toBe('/api/auth/email-verification/resend');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({});
  });
});

describe('account security helpers', () => {
  it('preserves a successful MFA challenge instead of treating it as an auth session', async () => {
    const challenge = { mfaRequired: true, challengeId: 'challenge-1', methods: ['TOTP'], expiresAt: '2099-01-01T00:00:00.000Z' };
    respond(challenge);
    const result = await loginAccount({ email: 'player@example.test', password: 'secret' });
    expect(isMfaLoginChallenge(result)).toBe(true);
    expect(result).toEqual(challenge);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'player@example.test', password: 'secret' });
  });

  it('keeps reset and email-change bearers in JSON request bodies', async () => {
    respond({ ok: true });
    await requestPasswordReset('player@example.test');
    expect(calls[0]).toMatchObject({ url: '/api/auth/password-reset/request', init: { method: 'POST', body: '{"email":"player@example.test"}' } });

    respond({ ok: true });
    await resetAccountPassword('reset/bearer', 'a-new-secure-password');
    expect(calls[0]).toMatchObject({ url: '/api/auth/password-reset/confirm', init: { method: 'POST' } });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: 'reset/bearer', password: 'a-new-secure-password' });

    respond({ ok: true, email: 'new@example.test' });
    await confirmAccountEmailChange('email-change-bearer');
    expect(calls[0].url).toBe('/api/auth/email-change/confirm');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: 'email-change-bearer' });
  });

  it('uses the typed MFA enrollment and challenge endpoints', async () => {
    respond({ secret: 'SECRET', otpauthUri: 'otpauth://totp/Courtly', expiresAt: '2099-01-01T00:00:00.000Z' });
    await startTotpEnrollment();
    expect(calls[0]).toMatchObject({ url: '/api/account/security/mfa/enrollment', init: { method: 'POST', body: '{}' } });

    respond({ ok: true, recoveryCodes: ['one'] });
    await confirmTotpEnrollment('enrollment-1', '123456');
    expect(calls[0].url).toBe('/api/account/security/mfa/enable');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ enrollmentId: 'enrollment-1', code: '123456' });

    respond({
      user: { id: 'u1', name: 'Player One', email: 'player@example.test', accountType: 'STUDENT' },
      membership: null, business: null, memberships: [],
    });
    await completeMfaLogin('challenge-1', 'RECOVERY_CODE', 'recovery-code');
    expect(calls[0].url).toBe('/api/auth/mfa/challenge');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ challengeId: 'challenge-1', method: 'RECOVERY_CODE', code: 'recovery-code' });
  });

  it('uses recent auth, email change, MFA recovery, and session revocation contracts', async () => {
    respondSequence([{ email: 'old@example.test', emailVerified: true, mfa: { enabled: false, enabledAt: null, recoveryCodesRemaining: 0 }, sessions: 1, recentAuthUntil: null }, { sessions: [] }]);
    await loadAccountSecurity();
    expect(calls.map(call => call.url)).toEqual(['/api/account/security', '/api/account/security/sessions']);

    respond({ ok: true });
    await requestAccountEmailChange('new@example.test');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ email: 'new@example.test' });

    respond({ ok: true });
    await reauthenticateAccount({ password: 'password', method: 'TOTP', code: '123456' });
    expect(calls[0].url).toBe('/api/account/security/recent-auth');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ password: 'password', method: 'TOTP', code: '123456' });

    respond({ recoveryCodes: [] });
    await regenerateMfaRecoveryCodes();
    expect(calls[0]).toMatchObject({ url: '/api/account/security/mfa/recovery-codes', init: { method: 'POST' } });

    respond({ ok: true });
    await disableAccountMfa();
    expect(calls[0]).toMatchObject({ url: '/api/account/security/mfa', init: { method: 'DELETE', body: '{}' } });

    respond({ ok: true });
    await revokeAccountSecuritySession('session/1');
    expect(calls[0].url).toBe('/api/account/security/sessions/session%2F1');

    respond({ ok: true });
    await revokeOtherAccountSecuritySessions();
    expect(calls[0]).toMatchObject({ url: '/api/account/security/sessions/revoke-others', init: { method: 'POST', body: '{}' } });
  });
});

describe('privacy request helpers', () => {
  it('lists, creates, and cancels requests through authenticated subject routes', async () => {
    respond({ requests: [] });
    await loadPrivacyRequests();
    expect(calls[0].url).toBe('/api/privacy/requests');
    expect(calls[0].init.method).toBeUndefined();

    respond({ requests: [], nextCursor: null });
    await loadPrivacyRequests({ cursor: 'next page', limit: 25 });
    expect(calls[0].url).toBe('/api/privacy/requests?cursor=next+page&limit=25');

    const input = {
      type: 'CORRECTION' as const,
      details: 'My phone number is outdated.',
      correctionFields: { phone: '+65 6123 4567' },
    };
    respond({ request: { id: 'privacy-1' } });
    await createPrivacyRequest(input);
    expect(calls[0]).toMatchObject({
      url: '/api/privacy/requests',
      init: { method: 'POST', body: JSON.stringify(input) },
    });

    respond({ request: { id: 'privacy-1', status: 'CANCELLED' } });
    await cancelPrivacyRequest('privacy/1');
    expect(calls[0]).toMatchObject({
      url: '/api/privacy/requests/privacy%2F1/cancel',
      init: { method: 'POST', body: '{}' },
    });
  });

  it('adds the explicit operator acknowledgement and bounded admin filters', async () => {
    respond({ requests: [] });
    await loadAdminPrivacyRequests({ status: 'ACTIVE', overdue: true, limit: 25, cursor: 'next page' });
    expect(calls[0].url).toBe('/api/admin/privacy-requests?status=ACTIVE&overdue=true&limit=25&cursor=next+page');
    expect(calls[0].init.headers).toMatchObject({ 'X-Courtly-Privacy-Operator': '1' });

    const update = {
      status: 'IN_REVIEW' as const, note: 'Identity checked against the signed-in account.',
      externalAuditReference: 'CASE-2026-001',
      identityVerified: true,
    };
    respond({ request: { id: 'privacy-1', status: 'IN_REVIEW' } });
    await updateAdminPrivacyRequest('privacy/1', update);
    expect(calls[0]).toMatchObject({
      url: '/api/admin/privacy-requests/privacy%2F1',
      init: {
        method: 'PATCH',
        headers: expect.objectContaining({ 'X-Courtly-Privacy-Operator': '1' }),
        body: JSON.stringify(update),
      },
    });

    respond({ events: [], nextCursor: null });
    await loadAdminPrivacyRequestEvents('privacy/1', { limit: 100, cursor: 'older page' });
    expect(calls[0]).toMatchObject({
      url: '/api/admin/privacy-requests/privacy%2F1/events?limit=100&cursor=older+page',
      init: { headers: expect.objectContaining({ 'X-Courtly-Privacy-Operator': '1' }) },
    });
  });
});

const baseWorkspace = {
  business: { id: 'b1', kind: 'CLUB' },
  user: { accountType: 'CLUB' },
  membership: {}, memberships: [], clubAccount: true,
  instructors: [], locations: [], services: [], availability: [], exceptions: [],
  students: [], packages: [], bookings: [], payments: [],
} as unknown as WorkspaceResponse;

describe('loadWorkspace', () => {
  // The browser and the API deploy separately, so for a few seconds new code
  // can read an older payload. A missing collection must not blank the page.
  it('normalises collections an older API did not send', async () => {
    respond(baseWorkspace);
    const workspace = await loadWorkspace();
    expect(workspace.rescheduleRequests).toEqual([]);
    expect(workspace.notifications).toEqual([]);
    expect(workspace.integrityFlags).toEqual([]);
  });

  it('gives an untyped notification row a neutral type instead of dropping it', async () => {
    respond({ ...baseWorkspace, notifications: [{ id: 'n1', title: 'Something happened' }] });
    const workspace = await loadWorkspace();
    expect(workspace.notifications[0]).toMatchObject({ type: 'NOTICE', actionNeeded: false, bookingId: null, integrityFlagId: null });
  });

  it('preserves a typed notification exactly as sent', async () => {
    respond({ ...baseWorkspace, notifications: [{ id: 'n1', type: 'INTEGRITY', actionNeeded: true, bookingId: 'bk1', integrityFlagId: 'flag-1' }] });
    const workspace = await loadWorkspace();
    expect(workspace.notifications[0]).toMatchObject({ type: 'INTEGRITY', actionNeeded: true, bookingId: 'bk1', integrityFlagId: 'flag-1' });
  });

  // A coach inside a club sees their own schedule and none of the club's
  // money. The client must not invent those collections either.
  it('empties the club-only collections for a coach working in a club', async () => {
    respond({
      ...baseWorkspace,
      business: { id: 'b1', kind: 'CLUB' },
      user: { accountType: 'COACH' },
      clubAccount: true,
      packages: [{ id: 'p1' }], payments: [{ id: 'pay1' }], integrityFlags: [{ id: 'f1' }],
    });
    const workspace = await loadWorkspace();
    expect(workspace.packages).toEqual([]);
    expect(workspace.payments).toEqual([]);
    expect(workspace.integrityFlags).toEqual([]);
    expect(workspace.clubAccount).toBe(false);
  });

  it('keeps the club account financial collections intact', async () => {
    respond({ ...baseWorkspace, packages: [{ id: 'p1' }], payments: [{ id: 'pay1' }], integrityFlags: [{ id: 'f1' }] });
    const workspace = await loadWorkspace();
    expect(workspace.packages).toHaveLength(1);
    expect(workspace.payments).toHaveLength(1);
    expect(workspace.integrityFlags).toHaveLength(1);
  });

  it('rejects a legacy solo workspace so the shell returns the coach to their account', async () => {
    respond({
      ...baseWorkspace,
      business: { id: 'solo-1', kind: 'SOLO', legacyReadOnly: true },
      user: { accountType: 'COACH' },
      clubAccount: false,
    });
    await expect(loadWorkspace()).rejects.toMatchObject({ status: 403 });
  });
});

describe('workspace role guards', () => {
  const workspace = (accountType: string, kind: string) =>
    ({ user: { accountType }, business: { kind } }) as unknown as WorkspaceWireResponse;

  it('treats only a coach inside a club as coach-scoped', () => {
    expect(isCoachClubWorkspace(workspace('COACH', 'CLUB'))).toBe(true);
    expect(isCoachClubWorkspace(workspace('COACH', 'SOLO'))).toBe(false);
    expect(isCoachClubWorkspace(workspace('CLUB', 'CLUB'))).toBe(false);
  });

  it('treats only a usable club account as a manager', () => {
    expect(isManagerWorkspace(workspace('CLUB', 'CLUB'))).toBe(true);
    expect(isManagerWorkspace(workspace('COACH', 'SOLO'))).toBe(false);
    expect(isManagerWorkspace(workspace('COACH', 'CLUB'))).toBe(false);
    expect(isManagerWorkspace({
      ...workspace('CLUB', 'CLUB'),
      business: { kind: 'CLUB', legacyReadOnly: true },
    } as WorkspaceResponse)).toBe(false);
  });
});

describe('loadAccountBookings', () => {
  it('accepts the current envelope', async () => {
    respond({ bookings: [{ booking: { id: 'b1' } }] });
    expect((await loadAccountBookings()).bookings).toHaveLength(1);
    expect(calls[0].url).toBe('/api/account/bookings');
  });

  it('still accepts a bare array from an older API', async () => {
    respond([{ booking: { id: 'b1' } }]);
    expect((await loadAccountBookings()).bookings).toHaveLength(1);
  });

  it('filters by business slug when one is given', async () => {
    respond({ bookings: [] });
    await loadAccountBookings('marcus-tan-tennis');
    expect(calls[0].url).toBe('/api/account/bookings?businessSlug=marcus-tan-tennis');
  });
});

describe('loadAccountClubs', () => {
  it('accepts the one-page response used during a rolling deployment', async () => {
    respond({
      clubs: [{
        business: { name: 'Centre Court', slug: 'centre-court', kind: 'CLUB' },
        sports: ['Tennis'],
        serviceCount: 3,
        coachCount: 2,
        locationCount: 1,
        priceFrom: 4500,
      }],
    });

    const result = await loadAccountClubs();

    expect(result.clubs).toHaveLength(1);
    expect(result.clubs[0]).toMatchObject({
      business: { slug: 'centre-court', kind: 'CLUB' },
      sports: ['Tennis'],
      priceFrom: 4500,
    });
    expect(calls[0].url).toBe('/api/account/clubs?limit=50');
  });

  it('loads every page and returns the complete directory in display order', async () => {
    respondSequence([
      {
        clubs: [{
          business: { name: 'Zulu Club', slug: 'zulu-club', kind: 'CLUB' },
          sports: ['Tennis'], serviceCount: 1, coachCount: 1, locationCount: 1, priceFrom: 5000,
        }],
        nextCursor: 'zulu club/first',
      },
      {
        clubs: [{
          business: { name: 'Alpha Club', slug: 'alpha-club', kind: 'CLUB' },
          sports: ['Badminton'], serviceCount: 1, coachCount: 1, locationCount: 1, priceFrom: 4000,
        }],
        nextCursor: null,
      },
    ]);

    const result = await loadAccountClubs();

    expect(result.clubs.map((club) => club.business.name)).toEqual(['Alpha Club', 'Zulu Club']);
    expect(calls.map((call) => call.url)).toEqual([
      '/api/account/clubs?limit=50',
      '/api/account/clubs?cursor=zulu+club%2Ffirst&limit=50',
    ]);
  });

  it('rejects a repeated page cursor instead of looping forever', async () => {
    respondSequence([
      { clubs: [], nextCursor: 'same-cursor' },
      { clubs: [], nextCursor: 'same-cursor' },
    ]);

    await expect(loadAccountClubs()).rejects.toMatchObject({
      message: 'The club directory returned an invalid page. Please try again.',
      status: 502,
    });
    expect(calls).toHaveLength(2);
  });
});

describe('calendar connection', () => {
  it('normalises an absent connection and preference fields', async () => {
    expect(normalizeCalendarConnection(undefined)).toEqual({
      configured: false, eligible: false, provider: null, state: 'DISCONNECTED', connected: false,
      email: null, calendarName: null, syncEnabled: false, busyCheckEnabled: false, connectedAt: null,
      lastSyncedAt: null, lastBusyAt: null, busyCacheExpiresAt: null, error: null,
    });

    respond(null);
    expect(await loadCalendarConnection()).toEqual({
      configured: false, eligible: false, provider: null, state: 'DISCONNECTED', connected: false,
      email: null, calendarName: null, syncEnabled: false, busyCheckEnabled: false, connectedAt: null,
      lastSyncedAt: null, lastBusyAt: null, busyCacheExpiresAt: null, error: null,
    });

    respond({ configured: true, eligible: true, provider: 'GOOGLE', state: 'ACTIVE', connected: true, syncEnabled: true });
    expect(await loadCalendarConnection()).toEqual({
      configured: true, eligible: true, provider: 'GOOGLE', state: 'ACTIVE', connected: true,
      email: null, calendarName: null, syncEnabled: true, busyCheckEnabled: false, connectedAt: null,
      lastSyncedAt: null, lastBusyAt: null, busyCacheExpiresAt: null, error: null,
    });
  });

  it('constructs connect and preference requests', async () => {
    respond({ authorizationUrl: 'https://accounts.google.com/o/oauth2/auth' });
    await beginGoogleCalendarConnection('/?tab=profile');
    expect(calls[0]).toMatchObject({
      url: '/api/calendar/google/connect',
      init: { method: 'POST', body: JSON.stringify({ returnTo: '/?tab=profile' }) },
    });

    respond({ state: 'ACTIVE', syncEnabled: false, busyCheckEnabled: true });
    const status = await updateCalendarConnection({ syncEnabled: false });
    expect(calls[0]).toMatchObject({
      url: '/api/calendar/connection',
      init: { method: 'PATCH', body: JSON.stringify({ syncEnabled: false }) },
    });
    expect(status).toMatchObject({ syncEnabled: false, busyCheckEnabled: true });
  });

  it('sends explicit empty sync and disconnect bodies and accepts an ok disconnect envelope', async () => {
    respond({ provider: 'GOOGLE', state: 'ACTIVE', connected: true });
    await syncGoogleCalendar();
    expect(calls[0]).toMatchObject({
      url: '/api/calendar/sync', init: { method: 'POST', body: '{}' },
    });

    respond({ ok: true, status: { state: 'DISCONNECTED', provider: null, email: null } });
    const status = await disconnectGoogleCalendar();
    expect(calls[0]).toMatchObject({
      url: '/api/calendar/connection', init: { method: 'DELETE', body: '{}' },
    });
    expect(status).toMatchObject({ provider: null, state: 'DISCONNECTED', email: null });

    respond({ provider: null, state: 'DISCONNECTED', email: null });
    expect(await disconnectGoogleCalendar()).toMatchObject({ provider: null, state: 'DISCONNECTED', email: null });

    respond({ ok: true });
    expect(await disconnectGoogleCalendar()).toBeNull();
  });
});

describe('generalized chat requests', () => {
  const session = {
    bookingId: 'booking-1', serviceId: 'service-1', instructorId: 'instructor-1', locationId: 'location-1',
    serviceName: 'Private Tennis', type: 'PRIVATE', status: 'CONFIRMED',
    startAt: '2026-10-21T02:00:00.000Z', endAt: '2026-10-21T03:00:00.000Z',
    locationName: 'Kallang', instructorName: 'Marcus Tan', businessName: 'Kallang Racket Club',
    businessSlug: 'kallang-racket-club', timezone: 'Asia/Singapore',
  };
  const legacyProposal = {
    id: 'proposal-1', status: 'OPEN', startAt: '2026-10-28T02:00:00.000Z', endAt: '2026-10-28T03:00:00.000Z',
    timezone: 'Asia/Singapore', serviceName: 'Private Tennis', locationName: 'Kallang', instructorName: 'Marcus Tan',
    proposedByRole: 'COACH', proposedByName: 'Marcus Tan', proposedByYou: false, forName: 'Amelia Wong', forYou: true,
    isCounter: false, message: 'Same time next week?', createdAt: '2026-10-14T01:00:00.000Z',
    awaiting: ['Amelia Wong'], responses: [],
    actions: { accept: true, decline: true, counter: true, withdraw: false },
  };
  const proposalMessage = {
    id: 'message-1', kind: 'PROPOSAL', event: null, senderRole: 'COACH', senderName: 'Marcus Tan',
    body: 'Marcus Tan proposed the next session.', createdAt: '2026-10-14T01:00:00.000Z', mine: false,
    proposalId: 'proposal-1', proposal: legacyProposal,
  };
  const legacyMembers = [
    { role: 'COACH', name: 'Marcus Tan', isYou: false },
    { role: 'STUDENT', name: 'Amelia Wong', isYou: true },
    { role: 'CLUB', name: 'Kallang Racket Club', isYou: false },
  ];
  const accountDetail = {
    id: 'account-thread', kind: 'ACCOUNT', bookingId: null, session: null, lastMessageAt: '2026-10-14T01:00:00.000Z',
    members: [
      { role: 'STUDENT', name: 'Amelia Wong', username: 'amelia', isYou: true, assigned: false },
      { role: 'COACH', name: 'Marcus Tan', username: 'marcus_tan', isYou: false, assigned: false },
    ],
    conversation: {
      title: 'Marcus Tan', subtitle: 'Coach', timezone: 'Asia/Singapore', business: null, assignedCoach: null,
      schedulingOptions: [],
    },
    viewer: { role: 'STUDENT', canPost: true, canPropose: true, canAssignCoach: false },
    messages: [], hasEarlier: false,
  };

  it('normalises the pre-generalization SESSION list shape at the API boundary', async () => {
    respond({
      threads: [{
        id: 'thread-1', bookingId: 'booking-1', lastMessageAt: proposalMessage.createdAt, session,
        members: legacyMembers, lastMessage: proposalMessage, unreadCount: 1,
      }],
      nextCursor: null, unreadThreads: 1,
    });

    const result = await loadChatThreads();
    const thread = result.threads[0];
    expect(calls[0].url).toBe('/api/chats?contract=accounts');
    expect(thread).toMatchObject({
      kind: 'SESSION', bookingId: 'booking-1',
      members: [
        { role: 'COACH', username: '', assigned: false },
        { role: 'STUDENT', username: '', assigned: false },
        { role: 'CLUB', username: '', assigned: false },
      ],
      conversation: {
        title: 'Private Tennis', subtitle: 'Marcus Tan · Kallang Racket Club', timezone: 'Asia/Singapore',
        business: { name: 'Kallang Racket Club', slug: 'kallang-racket-club' },
      },
    });
    if (thread.kind !== 'SESSION') throw new Error('Expected a session thread');
    expect(thread.conversation.schedulingOptions[0]).toMatchObject({
      businessSlug: 'kallang-racket-club', serviceId: 'service-1', instructorId: 'instructor-1', locationId: 'location-1',
    });
    expect(thread.lastMessage?.proposal).toMatchObject({
      businessSlug: 'kallang-racket-club', serviceId: 'service-1', instructorId: 'instructor-1', locationId: 'location-1',
    });
    expect(thread.lastMessage?.proposal).not.toHaveProperty('price');
    expect(thread.lastMessage?.proposal).not.toHaveProperty('currency');
    expect(result.accountChatAvailable).toBe(false);
  });

  it('falls back to the SESSION-only list when an older API rejects the account contract', async () => {
    respondResults([
      { body: { error: 'Invalid query' }, status: 400 },
      { body: { threads: [], nextCursor: null, unreadThreads: 0 } },
    ]);
    const result = await loadChatThreads({ q: 'amelia' });
    expect(calls.map(call => call.url)).toEqual([
      '/api/chats?q=amelia&contract=accounts',
      '/api/chats?q=amelia',
    ]);
    expect(result).toMatchObject({ threads: [], accountChatAvailable: false });
  });

  it('normalises the pre-generalization SESSION detail shape at the API boundary', async () => {
    respond({
      id: 'thread-1', bookingId: 'booking-1', lastMessageAt: proposalMessage.createdAt, session,
      members: legacyMembers, viewer: { role: 'STUDENT', canPost: true, canPropose: true },
      messages: [proposalMessage], hasEarlier: false,
    });

    const detail = await loadChatThread('thread/1');
    expect(calls[0].url).toBe('/api/chats/thread%2F1?contract=accounts');
    expect(detail).toMatchObject({
      kind: 'SESSION', bookingId: 'booking-1',
      viewer: { role: 'STUDENT', canPost: true, canPropose: true, canAssignCoach: false },
      members: [
        { role: 'COACH', username: '', assigned: false },
        { role: 'STUDENT', username: '', assigned: false },
        { role: 'CLUB', username: '', assigned: false },
      ],
      conversation: { title: 'Private Tennis', timezone: 'Asia/Singapore' },
    });
    expect(detail.messages[0].proposal).toMatchObject({
      businessSlug: 'kallang-racket-club', serviceId: 'service-1', instructorId: 'instructor-1', locationId: 'location-1',
    });
    expect(detail.messages[0].proposal).not.toHaveProperty('price');
    expect(detail.messages[0].proposal).not.toHaveProperty('currency');
    expect(detail.messages[0]).toMatchObject({ canReport: false, reportedByViewer: false });
    expect(detail.safety).toEqual({
      canReport: false, blockTarget: null, blockedByViewer: false, messagingBlocked: false,
      canBlock: false, canUnblock: false, reason: null,
    });
  });

  it('opens an account conversation by username', async () => {
    respond({ threadId: 'thread-1' });
    await expect(createAccountChat('marcus_tan')).resolves.toEqual({ threadId: 'thread-1' });
    expect(calls[0]).toMatchObject({
      url: '/api/chats/accounts',
      init: { method: 'POST', body: JSON.stringify({ username: 'marcus_tan' }) },
    });
  });

  it('keeps intentionally redacted prices optional in an ACCOUNT detail', async () => {
    const pricedProposal = { ...proposalMessage.proposal, price: 9_500, currency: 'SGD' };
    const { price: _price, currency: _currency, ...redactedProposal } = pricedProposal;
    respond({
      ...accountDetail,
      messages: [{ ...proposalMessage, proposal: redactedProposal }],
    });
    const detail = await loadChatThread('account-thread');
    expect(detail.kind).toBe('ACCOUNT');
    expect(detail.messages[0].proposal).not.toHaveProperty('price');
    expect(detail.messages[0].proposal).not.toHaveProperty('currency');
  });

  it('does not infer block authority when an older payload only names a target', async () => {
    respond({ ...accountDetail, blockTarget: { name: 'Marcus Tan', username: 'marcus_tan' } });
    const detail = await loadChatThread('account-thread');
    expect(detail.safety).toMatchObject({
      blockTarget: { name: 'Marcus Tan', username: 'marcus_tan' },
      canBlock: false, canUnblock: false,
    });
  });

  it('uses the server-authored block target and capabilities from messaging', async () => {
    respond({
      ...accountDetail,
      messaging: {
        blocked: false, blockedByViewer: false, canBlock: true, canUnblock: false, reason: null,
        blockTarget: { name: 'Marcus Tan', username: 'marcus_tan' },
      },
    });
    const detail = await loadChatThread('account-thread');
    expect(detail.safety).toMatchObject({
      blockTarget: { name: 'Marcus Tan', username: 'marcus_tan' },
      canBlock: true, canUnblock: false, messagingBlocked: false,
    });
  });

  it('assigns and removes a roster coach with escaped thread identifiers', async () => {
    respond({ thread: accountDetail });
    await assignChatCoach('thread/1', 'membership-1');
    expect(calls[0]).toMatchObject({
      url: '/api/chats/thread%2F1/coach',
      init: { method: 'POST', body: JSON.stringify({ membershipId: 'membership-1' }) },
    });

    respond({ thread: accountDetail });
    await removeChatCoach('thread/1');
    expect(calls[0]).toMatchObject({
      url: '/api/chats/thread%2F1/coach',
      init: { method: 'DELETE', body: '{}' },
    });
  });

  it('adds an optional scheduling choice to account proposals and counters', async () => {
    const scheduling = { businessSlug: 'kallang-club', serviceId: 'service-1', locationId: 'location-1' };
    respond({ thread: accountDetail });
    await proposeChatSession('thread-1', '2026-10-21T02:00:00.000Z', 'Same time next week?', scheduling);
    expect(calls[0]).toMatchObject({
      url: '/api/chats/thread-1/proposals',
      init: { method: 'POST', body: JSON.stringify({
        startAt: '2026-10-21T02:00:00.000Z', message: 'Same time next week?', ...scheduling,
      }) },
    });

    respond({ thread: accountDetail, proposalId: 'counter-1' });
    await counterChatProposal('proposal/1', '2026-10-22T02:00:00.000Z', '', scheduling);
    expect(calls[0]).toMatchObject({
      url: '/api/chats/proposals/proposal%2F1/counter',
      init: { method: 'POST', body: JSON.stringify({
        startAt: '2026-10-22T02:00:00.000Z', message: '', ...scheduling,
      }) },
    });
  });

  it('preserves the existing session proposal and counter bodies when no choice is needed', async () => {
    respond({ thread: accountDetail });
    await proposeChatSession('thread-1', '2026-10-21T02:00:00.000Z', 'Same time next week?');
    expect(calls[0].init.body).toBe(JSON.stringify({
      startAt: '2026-10-21T02:00:00.000Z', message: 'Same time next week?',
    }));

    respond({ thread: accountDetail, proposalId: 'counter-1' });
    await counterChatProposal('proposal-1', '2026-10-22T02:00:00.000Z');
    expect(calls[0].init.body).toBe(JSON.stringify({ startAt: '2026-10-22T02:00:00.000Z', message: '' }));
  });

  it('reports an anchored message with the exact report envelope', async () => {
    const receipt = {
      id: 'report-1', category: 'HARASSMENT', status: 'OPEN', severity: 'HIGH',
      childInvolved: false, createdAt: '2026-10-14T03:00:00.000Z',
    };
    respond({ report: receipt });
    await expect(reportChatMessage('thread/1', {
      category: 'HARASSMENT', description: 'A direct threat', messageId: 'message/1',
    })).resolves.toEqual({ report: receipt });
    expect(calls[0]).toMatchObject({
      url: '/api/chats/thread%2F1/reports',
      init: { method: 'POST', body: JSON.stringify({ category: 'HARASSMENT', description: 'A direct threat', messageId: 'message/1' }) },
    });
  });

  it('blocks and unblocks with empty bodies and normalises returned threads', async () => {
    respond({ thread: { ...accountDetail, messaging: { blocked: true, blockedByViewer: true, canBlock: false, canUnblock: true, reason: 'BLOCKED' } } });
    const blocked = await blockChatAccount('thread/1');
    expect(calls[0]).toMatchObject({ url: '/api/chats/thread%2F1/block', init: { method: 'POST', body: '{}' } });
    expect(blocked.safety).toMatchObject({ blockedByViewer: true, messagingBlocked: true });

    respond({ thread: accountDetail });
    const unblocked = await unblockChatAccount('thread/1');
    expect(calls[0]).toMatchObject({ url: '/api/chats/thread%2F1/block', init: { method: 'DELETE', body: '{}' } });
    expect(unblocked.safety).toMatchObject({ blockedByViewer: false, messagingBlocked: false });
  });
});

describe('safeguarding report requests', () => {
  const summary = {
    id: 'report-1', category: 'HARASSMENT', status: 'OPEN', severity: 'HIGH', childInvolved: false,
    assignedTo: null, threadKind: 'ACCOUNT', subject: { name: 'Marcus Tan', username: 'marcus', accountType: 'COACH' },
    business: null, session: null, reportedMessage: null, createdAt: '2026-10-14T03:00:00.000Z', updatedAt: '2026-10-14T03:00:00.000Z',
  };
  const detail = { ...summary, description: 'Threatening language', reporter: null, evidence: {}, evidenceHash: 'hash', audits: [], auditHistoryHasEarlier: true };

  it('builds bounded admin filters in a stable order', async () => {
    respond({ reports: [summary], nextCursor: 'next/1' });
    await expect(loadAdminSafeguardingReports({ status: 'IN_REVIEW', severity: 'HIGH', cursor: 'next/1', q: ' marcus ' }))
      .resolves.toMatchObject({ reports: [summary], nextCursor: 'next/1' });
    expect(calls[0].url).toBe('/api/admin/safeguarding/reports?status=IN_REVIEW&severity=HIGH&cursor=next%2F1&q=marcus');
  });

  it('unwraps detail and sends exact admin review and account-action bodies', async () => {
    respond({ report: detail });
    await expect(loadAdminSafeguardingReport('report/1')).resolves.toEqual(detail);
    expect(calls[0].url).toBe('/api/admin/safeguarding/reports/report%2F1');

    respond({ report: detail });
    await updateAdminSafeguardingReport('report/1', { status: 'IN_REVIEW', severity: 'CRITICAL', assignedTo: 'Safety lead', note: '  Escalated  \n' });
    expect(calls[0]).toMatchObject({
      url: '/api/admin/safeguarding/reports/report%2F1',
      init: { method: 'PATCH', body: JSON.stringify({ status: 'IN_REVIEW', severity: 'CRITICAL', assignedTo: 'Safety lead', note: 'Escalated' }) },
    });

    respond({ report: detail });
    await applyAdminSafeguardingAccountAction('report/1', 'RESTRICT_ACCOUNT_CHAT', 'Prevent further contact');
    expect(calls[0]).toMatchObject({
      url: '/api/admin/safeguarding/reports/report%2F1/account-action',
      init: { method: 'POST', body: JSON.stringify({ action: 'RESTRICT_ACCOUNT_CHAT', note: 'Prevent further contact' }) },
    });
  });

  it('uses redacted club routes and self-assignment vocabulary', async () => {
    respond({ report: detail });
    await loadClubSafeguardingReport('report/1');
    expect(calls[0].url).toBe('/api/safeguarding/reports/report%2F1');

    respond({ report: detail });
    await updateClubSafeguardingReport('report/1', { status: 'REFERRED_TO_PLATFORM', severity: 'CRITICAL', assignment: 'SELF', note: '\n Needs platform review \t' });
    expect(calls[0]).toMatchObject({
      url: '/api/safeguarding/reports/report%2F1',
      init: { method: 'PATCH', body: JSON.stringify({ status: 'REFERRED_TO_PLATFORM', severity: 'CRITICAL', assignment: 'SELF', note: 'Needs platform review' }) },
    });
  });
});

// Slugs and identifiers reach these helpers from URLs and API payloads, so
// each one is escaped rather than concatenated.
describe('request construction', () => {
  it('escapes a slug and query values when loading slots', async () => {
    respond({ slots: [] });
    await loadSlots('a b/c', { serviceId: 's 1', instructorId: 'i&1', locationId: 'l1', date: '2026-03-01' });
    expect(calls[0].url).toBe('/api/public/a%20b%2Fc/slots?serviceId=s+1&instructorId=i%261&locationId=l1&date=2026-03-01');
  });

  it('escapes path identifiers on student self-service', async () => {
    respond({});
    await cancelAccountBooking('p/1');
    expect(calls[0].url).toBe('/api/account/bookings/p%2F1/cancel');
    expect(calls[0].init.method).toBe('POST');
  });

  it('sends a withdraw with no message and the other decisions with one', async () => {
    respond({});
    await respondToRescheduleRequest('r1', 'withdraw', 'ignored');
    expect(calls[0].url).toBe('/api/reschedule-requests/r1/withdraw');
    expect(calls[0].init.body).toBe('{}');

    respond({});
    await respondToRescheduleRequest('r1', 'decline', 'Not that week');
    expect(calls[0].init.body).toBe(JSON.stringify({ message: 'Not that week' }));
  });

  // Reversal keeps the ledger row, so it carries a reason and is a DELETE
  // against the payment rather than a new compensating record.
  it('reverses a payment with a reason', async () => {
    respond({ ok: true, payment: {} });
    await reversePayment('pay 1', 'Recorded twice');
    expect(calls[0].url).toBe('/api/payments/pay%201');
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBe(JSON.stringify({ reason: 'Recorded twice' }));
  });

  it('encodes a venue search query', async () => {
    respond({ results: [] });
    await searchVenues('Kallang Tennis & Squash');
    expect(calls[0].url).toBe('/api/venues/search?q=Kallang+Tennis+%26+Squash');
  });

  it('always sends an explicit admin filter and omits an empty search', async () => {
    respond({ businesses: [] });
    await adminBusinesses();
    expect(calls[0].url).toBe('/api/admin/businesses?filter=all');

    respond({ businesses: [] });
    await adminBusinesses({ search: 'tan', filter: 'demo' });
    expect(calls[0].url).toBe('/api/admin/businesses?search=tan&filter=demo');
  });

  it('preserves the server-authored admin deletion policy', async () => {
    respond({
      configured: true, authenticated: true, authMode: 'named', sensitiveAccess: true,
      operator: { id: 'ops_1', name: 'Ada Operator', email: 'ada@example.test' },
      businessDeletionMode: 'demo-only',
    });
    await expect(adminSession()).resolves.toEqual({
      configured: true, authenticated: true, authMode: 'named', sensitiveAccess: true,
      operator: { id: 'ops_1', name: 'Ada Operator', email: 'ada@example.test' },
      businessDeletionMode: 'demo-only',
    });
    expect(calls[0].url).toBe('/api/admin/session');
  });

  it('sends the exact credential shape for named and legacy admin login', async () => {
    respond({ ok: true, authMode: 'named', operator: { id: 'ops_1', name: 'Ada', email: 'ada@example.test' } });
    await adminLogin({ email: 'ada@example.test', password: 'named-secret', totpCode: '123456' });
    expect(calls[0]).toMatchObject({
      url: '/api/admin/login', init: { method: 'POST', body: JSON.stringify({ email: 'ada@example.test', password: 'named-secret', totpCode: '123456' }) },
    });

    respond({ ok: true, authMode: 'legacy', operator: null });
    await adminLogin({ password: 'legacy-secret' });
    expect(calls[0]).toMatchObject({
      url: '/api/admin/login', init: { method: 'POST', body: JSON.stringify({ password: 'legacy-secret' }) },
    });
  });
});
