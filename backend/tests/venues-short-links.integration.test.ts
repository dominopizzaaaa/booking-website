import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

const tenants = new TestTenants();
const shortLink = 'https://maps.app.goo.gl/AbCdEf123';
const fullLink = 'https://www.google.com/maps/place/Kallang+Tennis+Centre/@1.3045,103.8745,17z/data=!4m2';

describe.sequential('Google Maps shortened-link route', () => {
  let fixture: Fixture;
  let originalGoogleMapsApiKey: string;

  beforeAll(async () => {
    await verifyTestDatabase();
    originalGoogleMapsApiKey = config.googleMapsApiKey;
    config.googleMapsApiKey = '';
    fixture = await tenants.fixture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    config.googleMapsApiKey = originalGoogleMapsApiKey;
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  it('expands a standard short link without a Places API key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: fullLink } }),
    );

    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: shortLink })
      .expect(200);

    expect(response.body).toEqual({
      configured: false,
      results: [{
        placeId: '',
        name: 'Kallang Tennis Centre',
        address: 'Kallang Tennis Centre',
        mapsUrl: fullLink,
        latitude: 1.3045,
        longitude: 103.8745,
        source: 'GOOGLE_MAPS',
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(shortLink, expect.objectContaining({ redirect: 'manual' }));
  });

  it('rejects an off-allowlist redirect before making a second request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );

    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: shortLink })
      .expect(400);

    expect(response.body).toEqual({
      error: 'That shortened link redirected outside Google Maps and was rejected.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns an upstream expansion failure into a safe error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network details'));

    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: shortLink })
      .expect(502);

    expect(response.body).toEqual({
      error: 'Google Maps could not expand that link. Paste the full Maps link instead.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
