import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, adminBusinesses, api, cancelAccountBooking, loadAccountBookings,
  loadSlots, loadWorkspace, respondToRescheduleRequest, reversePayment, searchVenues,
} from '../src/lib/api';
import { isCoachClubWorkspace, isManagerWorkspace, type WorkspaceResponse } from '../src/lib/types';

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
    expect(workspace.notifications[0]).toMatchObject({ type: 'NOTICE', actionNeeded: false, bookingId: null });
  });

  it('preserves a typed notification exactly as sent', async () => {
    respond({ ...baseWorkspace, notifications: [{ id: 'n1', type: 'INTEGRITY', actionNeeded: true, bookingId: 'bk1' }] });
    const workspace = await loadWorkspace();
    expect(workspace.notifications[0]).toMatchObject({ type: 'INTEGRITY', actionNeeded: true, bookingId: 'bk1' });
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
});

describe('workspace role guards', () => {
  const workspace = (accountType: string, kind: string) =>
    ({ user: { accountType }, business: { kind } }) as unknown as WorkspaceResponse;

  it('treats only a coach inside a club as coach-scoped', () => {
    expect(isCoachClubWorkspace(workspace('COACH', 'CLUB'))).toBe(true);
    expect(isCoachClubWorkspace(workspace('COACH', 'SOLO'))).toBe(false);
    expect(isCoachClubWorkspace(workspace('CLUB', 'CLUB'))).toBe(false);
  });

  it('treats a club account and a coach running their own practice as managers', () => {
    expect(isManagerWorkspace(workspace('CLUB', 'CLUB'))).toBe(true);
    expect(isManagerWorkspace(workspace('COACH', 'SOLO'))).toBe(true);
    expect(isManagerWorkspace(workspace('COACH', 'CLUB'))).toBe(false);
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
});
