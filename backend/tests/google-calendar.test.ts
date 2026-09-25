import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  googleAuthorizationUrl,
  googleProviderEventId,
  listGoogleBusyIntervals,
  writeGoogleCalendarEvent,
  exchangeGoogleAuthorizationCode,
  revokeGoogleToken,
} from '../src/google-calendar.js';

const original = { ...config.googleCalendar };

beforeEach(() => {
  Object.assign(config.googleCalendar, {
    enabled: true, clientId: 'client-id', clientSecret: 'client-secret',
    redirectUri: 'https://courtly.example/api/calendar/google/callback', requestTimeoutMs: 10_000,
  });
});

afterEach(() => {
  Object.assign(config.googleCalendar, original);
  vi.restoreAllMocks();
});

describe('Google Calendar provider client', () => {
  it('builds a PKCE authorization request with only the intended scopes', () => {
    const url = new URL(googleAuthorizationUrl({ state: 'random-state', codeChallenge: 'challenge' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('state')).toBe('random-state');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid', 'email', 'https://www.googleapis.com/auth/calendar.events',
    ]);
  });

  it('rejects a token response that omits calendar event permission', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'token', expires_in: 3600, scope: 'openid email',
    }), { status: 200 }));
    await expect(exchangeGoogleAuthorizationCode('code', 'verifier')).rejects.toMatchObject({
      code: 'CALENDAR_SCOPE_MISSING',
    });
  });

  it('posts revocation tokens in the form body rather than the URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    await revokeGoogleToken('sensitive-refresh-token');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://oauth2.googleapis.com/revoke');
    expect(String(init?.body)).toBe('token=sensitive-refresh-token');
  });

  it('accepts only an explicit invalid_token revocation response as already revoked', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 }));

    await expect(revokeGoogleToken('already-revoked')).resolves.toBeUndefined();
    await expect(revokeGoogleToken('still-live')).rejects.toMatchObject({
      code: 'PROVIDER_REJECTED', status: 400, providerCode: 'invalid_request',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('inserts a new private opaque event with no attendees or Courtly-private content', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ etag: 'etag-1' }), { status: 200 },
    ));
    const eventId = googleProviderEventId('connection-a', 'booking-a');
    const result = await writeGoogleCalendarEvent('access-token', eventId, {
      bookingId: 'booking-a', revision: 2, summary: 'Tennis lesson at Courtly Club',
      location: 'Court One', startAt: new Date('2026-10-01T01:00:00.000Z'),
      endAt: new Date('2026-10-01T02:00:00.000Z'), timeZone: 'Asia/Singapore',
    }, false);

    expect(result).toEqual({ etag: 'etag-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ id: eventId, visibility: 'private', transparency: 'opaque' });
    expect(body.attendees).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/student|payment|notes/i);
  });

  it('updates an existing event and recreates it when the remote copy is gone', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ etag: 'recreated' }), { status: 200 }));
    await writeGoogleCalendarEvent('access-token', 'court1234', {
      bookingId: 'booking-a', revision: 3, summary: 'Lesson', location: 'Court',
      startAt: new Date('2026-10-01T01:00:00.000Z'), endAt: new Date('2026-10-01T02:00:00.000Z'),
      timeZone: 'UTC',
    }, true);
    expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(['PUT', 'POST']);
  });

  it('keeps only opaque external time ranges and interprets all-day dates in the calendar zone', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ timeZone: 'Asia/Singapore', items: [
      { start: { dateTime: '2026-10-01T01:00:00Z' }, end: { dateTime: '2026-10-01T02:00:00Z' } },
      { transparency: 'transparent', start: { dateTime: '2026-10-01T03:00:00Z' }, end: { dateTime: '2026-10-01T04:00:00Z' } },
      { extendedProperties: { private: { courtlyBookingId: 'booking-a' } }, start: { dateTime: '2026-10-01T05:00:00Z' }, end: { dateTime: '2026-10-01T06:00:00Z' } },
      { start: { date: '2026-10-02' }, end: { date: '2026-10-03' } },
    ] }), { status: 200 }));
    const result = await listGoogleBusyIntervals('access-token', {
      timeMin: new Date('2026-09-30T00:00:00Z'), timeMax: new Date('2027-10-01T00:00:00Z'),
      timeZone: 'Asia/Singapore',
    });
    expect(result).toEqual([
      { startAt: new Date('2026-10-01T01:00:00Z'), endAt: new Date('2026-10-01T02:00:00Z') },
      { startAt: new Date('2026-10-01T16:00:00Z'), endAt: new Date('2026-10-02T16:00:00Z') },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('fields=nextPageToken%2CtimeZone%2Citems%28start%2Cend%2Ctransparency%2CextendedProperties%2Fprivate%29');
  });
});
