import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

const tenants = new TestTenants();
const mapsLink = 'https://www.google.com/maps/place/Kallang+Tennis+Centre/@1.3045,103.8745,17z/data=!4m2';

describe.sequential('Venue search route without Google Places configuration', () => {
  let fixture: Fixture;
  let originalGoogleMapsApiKey: string;

  beforeAll(async () => {
    await verifyTestDatabase();
    originalGoogleMapsApiKey = config.googleMapsApiKey;
    config.googleMapsApiKey = '';
    fixture = await tenants.fixture();
  });

  afterAll(async () => {
    config.googleMapsApiKey = originalGoogleMapsApiKey;
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  it('parses a pasted Google Maps link locally for an authenticated workspace', async () => {
    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: mapsLink })
      .expect(200);

    expect(response.body).toEqual({
      configured: false,
      results: [{
        placeId: '',
        name: 'Kallang Tennis Centre',
        address: 'Kallang Tennis Centre',
        mapsUrl: mapsLink,
        latitude: 1.3045,
        longitude: 103.8745,
        source: 'GOOGLE_MAPS',
      }],
    });
  });

  it('returns the link-paste fallback when ordinary text cannot use Google Places', async () => {
    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query({ q: 'Kallang Tennis Centre' })
      .expect(503);

    expect(response.body).toEqual({
      error: 'Google Maps venue search is not configured on this server. Paste a Google Maps link for the venue instead.',
    });
  });

  it.each([
    ['a missing query', {}],
    ['an unknown field', { q: mapsLink, unexpected: 'true' }],
    ['a query that is too short', { q: 'x' }],
    ['a query that is too long', { q: 'x'.repeat(201) }],
    ['a repeated query field', { q: ['Kallang Tennis Centre', 'another venue'] }],
  ])('rejects %s before attempting a venue lookup', async (_label, query) => {
    const response = await request(app)
      .get('/api/venues/search')
      .set('Cookie', fixture.cookie)
      .query(query)
      .expect(400);

    expect(response.body).toEqual({
      error: expect.any(String),
      issues: expect.any(Object),
    });
  });

  it('requires authentication before parsing a venue query', async () => {
    const response = await request(app)
      .get('/api/venues/search')
      .query({ q: mapsLink })
      .expect(401);

    expect(response.body).toEqual({ error: 'Please sign in to continue' });
  });
});
