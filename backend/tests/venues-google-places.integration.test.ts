import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

const tenants = new TestTenants();
const originalGoogleMapsApiKey = config.googleMapsApiKey;

describe.sequential('Venue search route with Google Places configured', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    await verifyTestDatabase();
    fixture = await tenants.fixture();
  });

  beforeEach(() => {
    config.googleMapsApiKey = 'configured-google-places-test-key';
  });

  afterEach(() => {
    config.googleMapsApiKey = originalGoogleMapsApiKey;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    config.googleMapsApiKey = originalGoogleMapsApiKey;
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  it('parses and narrows a successful Text Search response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      places: [
        {
          id: 'place-kallang',
          displayName: { text: '  Kallang Tennis Centre  ' },
          formattedAddress: '52 Stadium Road, Singapore',
          location: { latitude: 1.3045, longitude: 103.8745 },
          googleMapsUri: 'https://maps.google.com/?cid=123',
        },
        {
          id: 'place-bishan',
          displayName: { text: 'Bishan Courts' },
          formattedAddress: 'Bishan, Singapore',
          location: { latitude: 1.3526 },
        },
        { id: 'place-without-a-name', formattedAddress: 'Ignored result' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: 'tennis courts singapore' })
      .expect(200);

    expect(response.body).toEqual({
      configured: true,
      results: [
        {
          placeId: 'place-kallang',
          name: 'Kallang Tennis Centre',
          address: '52 Stadium Road, Singapore',
          mapsUrl: 'https://maps.google.com/?cid=123',
          latitude: 1.3045,
          longitude: 103.8745,
          source: 'GOOGLE_MAPS',
        },
        {
          placeId: 'place-bishan',
          name: 'Bishan Courts',
          address: 'Bishan, Singapore',
          mapsUrl: 'https://www.google.com/maps/place/?q=place_id:place-bishan',
          latitude: 1.3526,
          longitude: null,
          source: 'GOOGLE_MAPS',
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://places.googleapis.com/v1/places:searchText',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': 'configured-google-places-test-key',
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri',
        },
        body: JSON.stringify({ textQuery: 'tennis courts singapore', maxResultCount: 8 }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('returns a safe error when Google Places sends malformed error JSON', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{not-json', { status: 503, headers: { 'Content-Type': 'application/json' } }),
    );

    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: 'Kallang Tennis Centre' })
      .expect(502);

    expect(response.body).toEqual({
      error: 'Google Maps could not be reached. Try again, or paste a Maps link instead.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves a Google Places quota error and its public message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Google Places quota is exhausted.' },
    }), { status: 429, headers: { 'Content-Type': 'application/json' } }));

    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: 'Kallang Tennis Centre' })
      .expect(429);

    expect(response.body).toEqual({ error: 'Google Places quota is exhausted.' });
  });

  it('aborts a timed-out Text Search request and returns a gateway timeout', async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler, delay, ...args) => {
      return nativeSetTimeout(handler, delay === 8_000 ? 0 : delay, ...args);
    }) as typeof setTimeout);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => (
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    ));

    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: 'Kallang Tennis Centre' })
      .expect(504);

    expect(response.body).toEqual({
      error: 'Google Maps took too long to respond. Try again, or paste a Maps link instead.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('requires an authenticated workspace before contacting Google Places', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    const response = await request(app)
      .get('/api/venues/search')
      .query({ q: 'Kallang Tennis Centre' })
      .expect(401);

    expect(response.body).toEqual({ error: 'Please sign in to continue' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
