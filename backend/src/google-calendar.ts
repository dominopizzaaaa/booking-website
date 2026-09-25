import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { config } from './config.js';

const authorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const revokeEndpoint = 'https://oauth2.googleapis.com/revoke';
const userInfoEndpoint = 'https://openidconnect.googleapis.com/v1/userinfo';
const calendarApi = 'https://www.googleapis.com/calendar/v3';

// calendar.events is the narrowest Google scope that permits both Courtly's
// authoritative event writes and the event listing needed to omit Courtly's
// own projections from the optional busy cache.
export const googleCalendarScopes = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
] as const;
const requiredCalendarScope = 'https://www.googleapis.com/auth/calendar.events';

type ErrorOptions = {
  status?: number; transient?: boolean; reauth?: boolean; providerCode?: string;
};

export class GoogleCalendarError extends Error {
  readonly status: number | undefined;
  readonly transient: boolean;
  readonly reauth: boolean;
  readonly providerCode: string | undefined;

  constructor(public readonly code: string, options: ErrorOptions = {}) {
    super(code);
    this.name = 'GoogleCalendarError';
    this.status = options.status;
    this.transient = options.transient ?? false;
    this.reauth = options.reauth ?? false;
    this.providerCode = options.providerCode;
  }
}

function providerError(status: number, body: unknown) {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === 'object'
    ? record.error as Record<string, unknown>
    : record;
  const providerCode = typeof record.error === 'string' ? record.error
    : typeof nested.status === 'string' ? nested.status
      : typeof nested.code === 'string' ? nested.code
        : '';
  const message = typeof nested.message === 'string' ? nested.message.toLowerCase() : '';
  const reauth = status === 401 || providerCode === 'invalid_grant'
    || providerCode === 'invalid_token' || providerCode === 'UNAUTHENTICATED';
  const scopeMissing = status === 403 && (providerCode === 'PERMISSION_DENIED'
    || message.includes('insufficient') || message.includes('permission'));
  const transient = status === 408 || status === 429 || status >= 500;
  return new GoogleCalendarError(reauth || scopeMissing ? 'REAUTH_REQUIRED' : transient ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED', {
    status, transient, reauth: reauth || scopeMissing, providerCode,
  });
}

async function googleRequest<T>(url: string, init: RequestInit, accepted: number[] = [200]) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.googleCalendar.requestTimeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (!accepted.includes(response.status)) throw providerError(response.status, body);
    return body as T;
  } catch (error) {
    if (error instanceof GoogleCalendarError) throw error;
    if (controller.signal.aborted) {
      throw new GoogleCalendarError('PROVIDER_TIMEOUT', { status: 504, transient: true });
    }
    throw new GoogleCalendarError('PROVIDER_UNAVAILABLE', { status: 502, transient: true });
  } finally {
    clearTimeout(timeout);
  }
}

export function googleAuthorizationUrl(input: { state: string; codeChallenge: string }) {
  const query = new URLSearchParams({
    client_id: config.googleCalendar.clientId,
    redirect_uri: config.googleCalendar.redirectUri,
    response_type: 'code',
    scope: googleCalendarScopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    state: input.state,
  });
  return `${authorizationEndpoint}?${query.toString()}`;
}

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
};

function tokenResult(body: TokenResponse) {
  if (typeof body.access_token !== 'string' || !body.access_token
    || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new GoogleCalendarError('PROVIDER_RESPONSE_INVALID');
  }
  const grantedScopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [...googleCalendarScopes];
  if (!grantedScopes.includes(requiredCalendarScope)) {
    throw new GoogleCalendarError('CALENDAR_SCOPE_MISSING');
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
    grantedScopes,
    expiresAt: new Date(Date.now() + Math.max(60, Math.floor(body.expires_in)) * 1000),
  };
}

export function validateGoogleCalendarGrant(grantedScopes: readonly string[]) {
  if (!grantedScopes.includes(requiredCalendarScope)) {
    throw new GoogleCalendarError('CALENDAR_SCOPE_MISSING');
  }
}

export async function exchangeGoogleAuthorizationCode(code: string, codeVerifier: string) {
  const body = await googleRequest<TokenResponse>(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, code_verifier: codeVerifier, grant_type: 'authorization_code',
      client_id: config.googleCalendar.clientId,
      client_secret: config.googleCalendar.clientSecret,
      redirect_uri: config.googleCalendar.redirectUri,
    }),
  });
  return tokenResult(body);
}

export async function refreshGoogleAccessToken(refreshToken: string) {
  const body = await googleRequest<TokenResponse>(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken, grant_type: 'refresh_token',
      client_id: config.googleCalendar.clientId, client_secret: config.googleCalendar.clientSecret,
    }),
  });
  return tokenResult(body);
}

export async function revokeGoogleToken(token: string) {
  try {
    await googleRequest<unknown>(revokeEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }, [200]);
  } catch (error) {
    // invalid_token means there is no live grant left to revoke. Treat that as
    // the desired disconnected outcome instead of retaining credentials.
    if (error instanceof GoogleCalendarError && error.status === 400
      && error.providerCode === 'invalid_token') return;
    throw error;
  }
}

export async function getGoogleIdentity(accessToken: string) {
  const identity = await googleRequest<{ sub?: unknown; email?: unknown }>(userInfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (typeof identity.sub !== 'string' || !identity.sub
    || typeof identity.email !== 'string' || !identity.email) {
    throw new GoogleCalendarError('PROVIDER_RESPONSE_INVALID');
  }
  return {
    accountId: identity.sub,
    email: identity.email.trim().toLowerCase(),
    // Events.list supplies the calendar timezone used for all-day events. No
    // broader calendar-metadata scope is needed during OAuth.
    timeZone: 'UTC',
  };
}

export function googleProviderEventId(connectionId: string, bookingId: string) {
  // Hex is within Google's base32hex-compatible event-ID alphabet and the
  // connection component prevents two Courtly users from sharing an event.
  return `court${createHash('sha256').update(`${connectionId}:${bookingId}`).digest('hex')}`;
}

export type GoogleCourtlyEvent = {
  bookingId: string;
  revision: number;
  summary: string;
  location: string;
  startAt: Date;
  endAt: Date;
  timeZone: string;
};

function googleEventBody(eventId: string, event: GoogleCourtlyEvent) {
  return {
    id: eventId,
    summary: event.summary,
    location: event.location,
    description: 'Managed by Courtly. Changes made in Google Calendar may be replaced.',
    start: { dateTime: event.startAt.toISOString(), timeZone: event.timeZone },
    end: { dateTime: event.endAt.toISOString(), timeZone: event.timeZone },
    visibility: 'private',
    transparency: 'opaque',
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    guestsCanSeeOtherGuests: false,
    extendedProperties: { private: {
      courtlyBookingId: event.bookingId,
      courtlyRevision: String(event.revision),
    } },
  };
}

export async function writeGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
  event: GoogleCourtlyEvent,
  knownToExist: boolean,
) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const payload = JSON.stringify(googleEventBody(eventId, event));
  let body: { etag?: unknown };
  if (knownToExist) {
    try {
      body = await googleRequest<{ etag?: unknown }>(
        `${calendarApi}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: 'PUT', headers, body: payload },
      );
    } catch (error) {
      if (!(error instanceof GoogleCalendarError) || error.status !== 404) throw error;
      body = await googleRequest<{ etag?: unknown }>(
        `${calendarApi}/calendars/primary/events?sendUpdates=none`,
        { method: 'POST', headers, body: payload },
      );
    }
  } else {
    try {
      body = await googleRequest<{ etag?: unknown }>(
        `${calendarApi}/calendars/primary/events?sendUpdates=none`,
        { method: 'POST', headers, body: payload },
      );
    } catch (error) {
      // A timed-out insert may have succeeded. The deterministic ID makes the
      // conflict path safe: update exactly that event rather than duplicating.
      if (!(error instanceof GoogleCalendarError) || error.status !== 409) throw error;
      body = await googleRequest<{ etag?: unknown }>(
        `${calendarApi}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
        { method: 'PUT', headers, body: payload },
      );
    }
  }
  return { etag: typeof body.etag === 'string' ? body.etag : null };
}

export async function deleteGoogleCalendarEvent(accessToken: string, eventId: string) {
  await googleRequest<unknown>(
    `${calendarApi}/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    [200, 204, 404, 410],
  );
}

type GoogleEventBoundary = { dateTime?: unknown; date?: unknown; timeZone?: unknown };
type GoogleEventList = {
  nextPageToken?: unknown;
  timeZone?: unknown;
  items?: Array<{
    start?: GoogleEventBoundary;
    end?: GoogleEventBoundary;
    transparency?: unknown;
    extendedProperties?: { private?: Record<string, unknown> };
  }>;
};

function eventBoundary(value: GoogleEventBoundary | undefined, defaultZone: string) {
  if (typeof value?.dateTime === 'string') {
    const parsed = DateTime.fromISO(value.dateTime, {
      setZone: true,
      zone: typeof value.timeZone === 'string' ? value.timeZone : defaultZone,
    });
    return parsed.isValid ? parsed.toUTC().toJSDate() : null;
  }
  if (typeof value?.date === 'string') {
    const zone = typeof value.timeZone === 'string' ? value.timeZone : defaultZone;
    const parsed = DateTime.fromISO(value.date, { zone }).startOf('day');
    return parsed.isValid ? parsed.toUTC().toJSDate() : null;
  }
  return null;
}

export async function listGoogleBusyIntervals(
  accessToken: string,
  input: { timeMin: Date; timeMax: Date; timeZone: string },
) {
  const intervals: Array<{ startAt: Date; endAt: Date }> = [];
  let pageToken = '';
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({
      timeMin: input.timeMin.toISOString(),
      timeMax: input.timeMax.toISOString(),
      singleEvents: 'true',
      showDeleted: 'false',
      orderBy: 'startTime',
      maxResults: '2500',
      fields: 'nextPageToken,timeZone,items(start,end,transparency,extendedProperties/private)',
    });
    if (pageToken) query.set('pageToken', pageToken);
    const body = await googleRequest<GoogleEventList>(
      `${calendarApi}/calendars/primary/events?${query.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const calendarTimeZone = typeof body.timeZone === 'string' && body.timeZone ? body.timeZone : input.timeZone;
    for (const event of Array.isArray(body.items) ? body.items : []) {
      if (event.transparency === 'transparent'
        || event.extendedProperties?.private?.courtlyBookingId !== undefined) continue;
      const startAt = eventBoundary(event.start, calendarTimeZone);
      const endAt = eventBoundary(event.end, calendarTimeZone);
      if (startAt && endAt && endAt > startAt) intervals.push({ startAt, endAt });
    }
    if (typeof body.nextPageToken !== 'string' || !body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return intervals;
}
