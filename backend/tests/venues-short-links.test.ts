import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/http.js';
import {
  expandGoogleMapsShortLink,
  isGoogleMapsShortLink,
  parseMapsLink,
} from '../src/venues.js';

const shortLink = 'https://maps.app.goo.gl/AbCdEf123';
const fullLink = 'https://www.google.com/maps/place/Kallang+Tennis+Centre/@1.3045,103.8745,17z/data=!4m2';

function redirect(location?: string, status = 302) {
  return new Response(null, { status, headers: location ? { location } : undefined });
}

describe('Google Maps shortened links', () => {
  it('recognizes only opaque HTTPS links on the exact short-link host', () => {
    expect(isGoogleMapsShortLink(shortLink)).toBe(true);
    expect(isGoogleMapsShortLink('http://maps.app.goo.gl/AbCdEf123')).toBe(false);
    expect(isGoogleMapsShortLink('https://maps.app.goo.gl.evil.test/AbCdEf123')).toBe(false);
    expect(isGoogleMapsShortLink('https://maps.app.goo.gl@evil.test/AbCdEf123')).toBe(false);
    expect(isGoogleMapsShortLink('https://maps.app.goo.gl/')).toBe(false);
  });

  it('keeps parsing a full Maps link without making a request', () => {
    expect(parseMapsLink(fullLink)).toMatchObject({
      name: 'Kallang Tennis Centre',
      latitude: 1.3045,
      longitude: 103.8745,
      mapsUrl: fullLink,
      source: 'GOOGLE_MAPS',
    });
    expect(parseMapsLink(shortLink)).toBeNull();
  });

  it('follows trusted redirects manually and returns the parsed destination', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(redirect('/next'))
      .mockResolvedValueOnce(redirect(fullLink, 307));

    await expect(expandGoogleMapsShortLink(shortLink, { fetchImpl })).resolves.toMatchObject({
      name: 'Kallang Tennis Centre',
      latitude: 1.3045,
      longitude: 103.8745,
      mapsUrl: fullLink,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      shortLink,
      'https://maps.app.goo.gl/next',
    ]);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, shortLink, expect.objectContaining({
      method: 'GET',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ['another host', 'https://evil.test/private'],
    ['a lookalike host', 'https://www.google.com.evil.test/maps/place/Stolen/@1,2'],
    ['plain HTTP', 'http://www.google.com/maps/place/Stolen/@1,2'],
    ['credentials', 'https://www.google.com@evil.test/maps/place/Stolen/@1,2'],
    ['a custom port', 'https://www.google.com:8443/maps/place/Stolen/@1,2'],
  ])('rejects a redirect to %s without requesting it', async (_label, location) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect(location));

    await expect(expandGoogleMapsShortLink(shortLink, { fetchImpl })).rejects.toMatchObject<HttpError>({
      status: 400,
      message: 'That shortened link redirected outside Google Maps and was rejected.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a non-redirect response', new Response(null, { status: 200 })],
    ['a redirect without a destination', redirect()],
    ['an invalid destination', redirect('https://[invalid')],
  ])('reports %s as an unusable destination', async (_label, response) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(expandGoogleMapsShortLink(shortLink, { fetchImpl })).rejects.toMatchObject({ status: 502 });
  });

  it('stops after the bounded number of trusted redirects', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(redirect('/another-hop'));

    await expect(expandGoogleMapsShortLink(shortLink, { fetchImpl, maxRedirects: 2 })).rejects.toMatchObject<HttpError>({
      status: 502,
      message: 'Google Maps redirected too many times. Paste the full Maps link instead.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('turns a bounded request timeout into a user-facing gateway timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));

    await expect(expandGoogleMapsShortLink(shortLink, { fetchImpl, timeoutMs: 5 })).rejects.toMatchObject<HttpError>({
      status: 504,
      message: 'Google Maps took too long to expand that link. Paste the full Maps link instead.',
    });
  });
});
