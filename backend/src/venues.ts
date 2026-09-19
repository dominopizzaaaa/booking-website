import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config, skipRateLimits } from './config.js';
import { asyncRoute, HttpError } from './http.js';

export const venuesRouter = Router();

export type VenueCandidate = {
  placeId: string;
  name: string;
  address: string;
  mapsUrl: string;
  latitude: number | null;
  longitude: number | null;
  source: 'GOOGLE_MAPS' | 'MANUAL';
};

const searchLimit = rateLimit({
  windowMs: 5 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  message: { error: 'Too many venue searches. Please wait a moment.' },
});

const mapsUrlFor = (placeId: string, query: string) => placeId
  ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

const redirectGoogleMapsHosts = new Set([
  'google.com',
  'www.google.com',
  'maps.google.com',
  'maps.app.goo.gl',
  'goo.gl',
]);
const shortMapsHost = 'maps.app.goo.gl';
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const shortLinkTimeoutMs = 5_000;
const shortLinkMaxRedirects = 5;
const maxRedirectUrlLength = 8_192;

function parsedUrl(raw: string | URL): URL | null {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw.trim());
  } catch {
    return null;
  }
  return url;
}

function safeRedirectUrl(raw: string | URL): URL | null {
  const url = parsedUrl(raw);
  if (!url || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
  if (!redirectGoogleMapsHosts.has(url.hostname.toLowerCase())) return null;
  return url;
}

export function isGoogleMapsShortLink(raw: string) {
  const url = safeRedirectUrl(raw);
  return url?.hostname.toLowerCase() === shortMapsHost && url.pathname.length > 1;
}

/**
 * Read a venue out of a pasted Google Maps link.
 *
 * This is the path that always works: no API key, no quota, and no outbound
 * request. People already share venues as links, and every common Maps URL
 * shape carries either coordinates in the path or a query parameter naming
 * the place. Anything it cannot read is reported honestly rather than guessed.
 */
export function parseMapsLink(raw: string): VenueCandidate | null {
  const url = parsedUrl(raw);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const googleHost = host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'maps.google.com'
    || host === 'google.com' || host.startsWith('google.') || host.endsWith('.google.com');
  if (!googleHost) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // /maps/place/Some+Tennis+Centre/@1.2345,103.8,17z/...
  const placeName = decodedPath.match(/\/maps\/place\/([^/@]+)/)?.[1]?.replace(/\+/g, ' ').trim();
  const at = decodedPath.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const queryParam = url.searchParams.get('q') || url.searchParams.get('query') || '';
  const coordinateQuery = queryParam.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  const placeId = url.searchParams.get('query_place_id')
    || queryParam.match(/^place_id:(.+)$/)?.[1]
    || '';

  const latitude = at ? Number(at[1]) : coordinateQuery ? Number(coordinateQuery[1]) : null;
  const longitude = at ? Number(at[2]) : coordinateQuery ? Number(coordinateQuery[2]) : null;
  const name = placeName || (coordinateQuery ? '' : queryParam.trim());
  // A shortened maps.app.goo.gl link carries nothing readable without
  // following a redirect, so it is only useful if it still names a place.
  if (!name && latitude === null) return null;

  return {
    placeId,
    name: name || `${latitude}, ${longitude}`,
    address: name && latitude !== null ? `${name}` : name || '',
    mapsUrl: url.toString(),
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    source: 'GOOGLE_MAPS',
  };
}

type ShortLinkExpansionOptions = {
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  timeoutMs?: number;
};

/**
 * Expand the Maps app's opaque share URL without ever following a redirect
 * automatically. Each hop is checked before the next request, which prevents
 * a Google-hosted short link (or open redirect) from turning this endpoint
 * into a server-side request primitive. Response bodies are never consumed.
 */
export async function expandGoogleMapsShortLink(
  raw: string,
  options: ShortLinkExpansionOptions = {},
): Promise<VenueCandidate> {
  let current = safeRedirectUrl(raw);
  if (!current || current.hostname.toLowerCase() !== shortMapsHost || current.pathname.length <= 1) {
    throw new HttpError(400, 'Paste a valid HTTPS Google Maps shortened link.');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? shortLinkMaxRedirects;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? shortLinkTimeoutMs);
  try {
    for (let hop = 0; hop < maxRedirects; hop += 1) {
      let response: Response;
      try {
        response = await fetchImpl(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml',
            Range: 'bytes=0-0',
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new HttpError(504, 'Google Maps took too long to expand that link. Paste the full Maps link instead.');
        }
        throw new HttpError(502, 'Google Maps could not expand that link. Paste the full Maps link instead.');
      }

      // Redirect expansion needs only the Location header. Cancelling avoids
      // downloading a Maps page (or any unexpectedly large upstream body).
      await response.body?.cancel().catch(() => undefined);
      if (!redirectStatuses.has(response.status)) {
        throw new HttpError(502, 'Google Maps did not return a usable destination for that link. Paste the full Maps link instead.');
      }
      const location = response.headers.get('location');
      if (!location || location.length > maxRedirectUrlLength) {
        throw new HttpError(502, 'Google Maps did not return a usable destination for that link. Paste the full Maps link instead.');
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new HttpError(502, 'Google Maps returned an invalid destination for that link. Paste the full Maps link instead.');
      }
      const trustedNext = safeRedirectUrl(next);
      if (!trustedNext) {
        throw new HttpError(400, 'That shortened link redirected outside Google Maps and was rejected.');
      }
      const candidate = parseMapsLink(trustedNext.toString());
      if (candidate) return candidate;
      current = trustedNext;
    }
    throw new HttpError(502, 'Google Maps redirected too many times. Paste the full Maps link instead.');
  } finally {
    clearTimeout(timeout);
  }
}

type PlacesResponse = {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    googleMapsUri?: string;
  }>;
  error?: { message?: string };
};

/**
 * Look a venue up through the Google Places Text Search API. The key lives
 * only on the server: the browser never sees it, and the response is narrowed
 * to the fields a venue record actually stores.
 */
export async function searchGooglePlaces(query: string, signal?: AbortSignal): Promise<VenueCandidate[]> {
  if (!config.googleMapsApiKey) {
    throw new HttpError(503, 'Google Maps venue search is not configured on this server. Paste a Google Maps link for the venue instead.');
  }
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.googleMapsApiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri',
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 8 }),
    signal,
  });
  const data = await response.json().catch(() => null) as PlacesResponse | null;
  if (!response.ok) {
    throw new HttpError(response.status === 429 ? 429 : 502,
      data?.error?.message || 'Google Maps could not be reached. Try again, or paste a Maps link instead.');
  }
  return (data?.places ?? []).flatMap(place => {
    const name = place.displayName?.text?.trim();
    if (!name) return [];
    return [{
      placeId: place.id ?? '',
      name,
      address: place.formattedAddress ?? '',
      mapsUrl: place.googleMapsUri || mapsUrlFor(place.id ?? '', `${name} ${place.formattedAddress ?? ''}`),
      latitude: typeof place.location?.latitude === 'number' ? place.location.latitude : null,
      longitude: typeof place.location?.longitude === 'number' ? place.location.longitude : null,
      source: 'GOOGLE_MAPS' as const,
    }];
  });
}

const searchQuery = z.object({
  q: z.string().trim().min(2).max(200),
}).strict();

venuesRouter.get('/venues/search', searchLimit, asyncRoute(async (req, res) => {
  const { q } = searchQuery.parse(req.query);
  // A pasted link is answered locally, whether or not a key is configured.
  const pasted = parseMapsLink(q);
  if (pasted) {
    res.json({ configured: !!config.googleMapsApiKey, results: [pasted] });
    return;
  }
  if (isGoogleMapsShortLink(q)) {
    const expanded = await expandGoogleMapsShortLink(q);
    res.json({ configured: !!config.googleMapsApiKey, results: [expanded] });
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const results = await searchGooglePlaces(q, controller.signal);
    res.json({ configured: true, results });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) throw new HttpError(504, 'Google Maps took too long to respond. Try again, or paste a Maps link instead.');
    throw new HttpError(502, 'Google Maps could not be reached. Try again, or paste a Maps link instead.');
  } finally {
    clearTimeout(timeout);
  }
}));
