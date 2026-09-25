import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const testEnvironment = [
  'DATABASE_URL',
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'GOOGLE_CALENDAR_REDIRECT_URI',
  'CALENDAR_TOKEN_ENCRYPTION_KEYS',
  'CALENDAR_TOKEN_ACTIVE_KEY_ID',
] as const;

const originalEnvironment = Object.fromEntries(
  testEnvironment.map(name => [name, process.env[name]]),
) as Record<(typeof testEnvironment)[number], string | undefined>;

const validCalendarEnvironment = {
  GOOGLE_CALENDAR_CLIENT_ID: 'calendar-client-id',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'calendar-client-secret',
  GOOGLE_CALENDAR_REDIRECT_URI: 'https://courtly.example.com/api/calendar/google/callback',
  CALENDAR_TOKEN_ENCRYPTION_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64')}`,
  CALENDAR_TOKEN_ACTIVE_KEY_ID: 'v1',
};

async function loadCalendarConfig(overrides: Partial<Record<(typeof testEnvironment)[number], string>> = {}) {
  for (const name of testEnvironment) delete process.env[name];
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
  Object.assign(process.env, validCalendarEnvironment, overrides);
  vi.resetModules();
  return import('../src/config.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of testEnvironment) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  vi.resetModules();
});

describe('Google Calendar configuration', () => {
  it('enables the capability only for a complete OAuth client and valid active 32-byte key', async () => {
    const { config } = await loadCalendarConfig();

    expect(config.googleCalendar.enabled).toBe(true);
    expect(config.googleCalendar.activeKeyId).toBe('v1');
    expect(config.googleCalendar.keys.get('v1')).toHaveLength(32);
  });

  it.each([
    ['configured', validCalendarEnvironment],
    ['disabled', { ...validCalendarEnvironment, GOOGLE_CALENDAR_CLIENT_SECRET: '' }],
  ] as const)('reports only the public %s capability through health', async (capability, environment) => {
    for (const name of testEnvironment) delete process.env[name];
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    Object.assign(process.env, environment);
    vi.resetModules();
    const [{ app }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/db.js')]);
    const query = vi.spyOn(prisma, '$queryRaw').mockResolvedValueOnce([{ '?column?': 1 }]);

    const response = await request(app).get('/api/health').expect(200);

    expect(response.body.capabilities.googleCalendar).toBe(capability);
    expect(JSON.stringify(response.body)).not.toContain('calendar-client-secret');
    expect(JSON.stringify(response.body)).not.toContain(validCalendarEnvironment.CALENDAR_TOKEN_ENCRYPTION_KEYS);
    query.mockRestore();
  });

  it.each([
    ['a missing OAuth value', { GOOGLE_CALENDAR_CLIENT_SECRET: '' }],
    ['an invalid redirect URI', { GOOGLE_CALENDAR_REDIRECT_URI: 'javascript:alert(1)' }],
    ['a non-loopback HTTP redirect', { GOOGLE_CALENDAR_REDIRECT_URI: 'http://courtly.example.com/callback' }],
    ['a malformed keyring entry', { CALENDAR_TOKEN_ENCRYPTION_KEYS: 'v1:not-base64' }],
    ['a key with the wrong decoded length', { CALENDAR_TOKEN_ENCRYPTION_KEYS: `v1:${Buffer.alloc(31).toString('base64')}` }],
    ['an active key absent from the keyring', { CALENDAR_TOKEN_ACTIVE_KEY_ID: 'v2' }],
  ])('keeps the capability disabled for %s', async (_label, overrides) => {
    const { config } = await loadCalendarConfig(overrides);

    expect(config.googleCalendar.enabled).toBe(false);
  });
});
