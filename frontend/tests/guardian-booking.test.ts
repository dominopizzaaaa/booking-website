import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isFamilyBookingAuthorityError } from '../src/components/family/family-booking-errors';
import { ApiError, createFamilyChildBooking, loadFamilyBookingChildren } from '../src/lib/api';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function respond(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
      json: async () => body,
    };
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('guardian-authorized child booking requests', () => {
  it('classifies only privacy-safe stale-authority failures as Family errors', () => {
    expect(isFamilyBookingAuthorityError(new ApiError('Forbidden', 403))).toBe(true);
    expect(isFamilyBookingAuthorityError(new ApiError('Child profile not found', 404, {
      code: 'CHILD_NOT_FOUND',
    }))).toBe(true);

    expect(isFamilyBookingAuthorityError(new ApiError('Booking page not found', 404))).toBe(false);
    expect(isFamilyBookingAuthorityError(new ApiError('Other resource missing', 404, {
      code: 'BOOKING_NOT_FOUND',
    }))).toBe(false);
  });

  it('loads only the privacy-minimal eligible child list', async () => {
    const children = [{ id: 'child/1', displayName: 'Riley', username: 'riley_player' }];
    respond({ children });

    await expect(loadFamilyBookingChildren()).resolves.toEqual({ children });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/api/family/booking-children',
      init: { credentials: 'include' },
    });
  });

  it('encodes the child id and sends only the bounded class-booking contract', async () => {
    const bookedFor = { id: 'child/1', displayName: 'Riley', username: 'riley_player' };
    respond({ bookedFor, bookings: [] });
    const values = {
      businessSlug: 'ace club',
      serviceId: 'service-1',
      instructorId: 'coach-1',
      locationId: 'court-1',
      startAt: '2026-10-20T02:00:00.000Z',
      repeatWeeks: 4,
      notes: 'First class',
      address: '10 Example Road',
    };

    await expect(createFamilyChildBooking('child/1', values)).resolves.toEqual({ bookedFor, bookings: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: '/api/family/children/child%2F1/bookings',
      init: { method: 'POST', body: JSON.stringify(values), credentials: 'include' },
    });
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('packageId');
    expect(body).not.toHaveProperty('student');
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('parentName');
  });
});
