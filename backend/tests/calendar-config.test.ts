import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const testEnvironment = [
  'NODE_ENV',
  'DATABASE_URL',
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'GOOGLE_CALENDAR_REDIRECT_URI',
  'CALENDAR_TOKEN_ENCRYPTION_KEYS',
  'CALENDAR_TOKEN_ACTIVE_KEY_ID',
  'FAMILY_HANDOVER_TOKEN_KEYS',
  'FAMILY_HANDOVER_TOKEN_ACTIVE_KEY_ID',
  'FAMILY_FEATURE_ENABLED',
  'EMAIL_VERIFICATION_TOKEN_KEYS',
  'EMAIL_VERIFICATION_TOKEN_ACTIVE_KEY_ID',
  'EMAIL_PROVIDER',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_API_KEY',
  'RATE_LIMIT_HASH_KEY',
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
const validFamilyHandoverEnvironment = {
  FAMILY_HANDOVER_TOKEN_KEYS: `v1:${Buffer.alloc(32, 9).toString('base64')}`,
  FAMILY_HANDOVER_TOKEN_ACTIVE_KEY_ID: 'v1',
};
const validEmailVerificationEnvironment = {
  EMAIL_VERIFICATION_TOKEN_KEYS: `v1:${Buffer.alloc(32, 11).toString('base64')}`,
  EMAIL_VERIFICATION_TOKEN_ACTIVE_KEY_ID: 'v1',
};
const validTransactionalEmailEnvironment = {
  EMAIL_PROVIDER: 'capture',
  EMAIL_FROM_ADDRESS: 'security@example.test',
};

async function loadCalendarConfig(overrides: Partial<Record<(typeof testEnvironment)[number], string>> = {}) {
  for (const name of testEnvironment) delete process.env[name];
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
  process.env.RATE_LIMIT_HASH_KEY = Buffer.alloc(32, 31).toString('base64');
  Object.assign(process.env, validCalendarEnvironment, validFamilyHandoverEnvironment,
    validEmailVerificationEnvironment, overrides);
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
  it.each([
    ['development', true, true],
    ['test', true, true],
    ['production', false, false],
  ] as const)('uses safe Family and business-deletion defaults in %s', async (nodeEnv, familyEnabled, deletionEnabled) => {
    const { config } = await loadCalendarConfig({ NODE_ENV: nodeEnv });

    expect(config.familyFeatureEnabled).toBe(familyEnabled);
    expect(config.realBusinessDeletionEnabled).toBe(deletionEnabled);
  });

  it.each([
    ['production', 'true', true],
    ['development', 'false', false],
    ['development', ' true ', true],
    ['test', 'invalid', false],
  ] as const)('honors an explicit Family flag in %s (%s)', async (nodeEnv, value, enabled) => {
    const { config } = await loadCalendarConfig({ NODE_ENV: nodeEnv, FAMILY_FEATURE_ENABLED: value });

    expect(config.familyFeatureEnabled).toBe(enabled);
  });

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
    Object.assign(process.env, validFamilyHandoverEnvironment, environment);
    vi.resetModules();
    const [{ app }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/db.js')]);
    const query = vi.spyOn(prisma, '$queryRawUnsafe').mockResolvedValueOnce([{
      coachInvitations: true,
      packageScopeColumn: true,
      packageScopeTrigger: true,
      venueUnitIdentity: true,
      namedClubStaff: true,
      bookingSeries: true,
      venueAllocation: true,
      paymentProviderEvents: true,
      outboundDelivery: true,
      accountSecurity: true,
      activeStripeBookingCheckoutGuard: true,
      paymentCompliance: true,
      paymentReceipts: true,
      guardianChildAccounts: true,
      childConsentAppendOnly: true,
      onePendingChildHandover: true,
      signupEvidence: true,
      privacyRequests: true,
      chatSafeguardingTables: true,
      chatSafeguardingPermissions: true,
      chatSafeguardingIndexes: true,
      chatSafeguardingTriggers: true,
      chatSafeguardingAssigneeIdentity: true,
      distributedRateLimits: true,
      trainingCompanion: true,
    }]);

    const response = await request(app).get('/api/health').expect(200);

    expect(response.body.capabilities.googleCalendar).toBe(capability);
    expect(response.body.capabilities.family).toBe('enabled');
    expect(response.body.capabilities.familyHandover).toBe('disabled');
    expect(response.body.schema).toBe('ready');
    expect(JSON.stringify(response.body)).not.toContain('calendar-client-secret');
    expect(JSON.stringify(response.body)).not.toContain(validCalendarEnvironment.CALENDAR_TOKEN_ENCRYPTION_KEYS);
    query.mockRestore();
  });

  it.each([
    ['configured', validTransactionalEmailEnvironment],
    ['recovery-disabled', {}],
  ] as const)('reports account security as %s only when its recovery dependency is usable', async (capability, emailEnvironment) => {
    for (const name of testEnvironment) delete process.env[name];
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    process.env.RATE_LIMIT_HASH_KEY = Buffer.alloc(32, 31).toString('base64');
    Object.assign(process.env, validEmailVerificationEnvironment, emailEnvironment);
    vi.resetModules();
    const [{ app }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/db.js')]);
    const query = vi.spyOn(prisma, '$queryRawUnsafe').mockResolvedValueOnce([{
      coachInvitations: true, packageScopeColumn: true, packageScopeTrigger: true, venueUnitIdentity: true,
      namedClubStaff: true, bookingSeries: true, venueAllocation: true, paymentProviderEvents: true,
      outboundDelivery: true, accountSecurity: true, activeStripeBookingCheckoutGuard: true,
      paymentCompliance: true, paymentReceipts: true, guardianChildAccounts: true,
      childConsentAppendOnly: true, onePendingChildHandover: true, signupEvidence: true,
      privacyRequests: true, chatSafeguardingTables: true, chatSafeguardingPermissions: true,
      chatSafeguardingIndexes: true, chatSafeguardingTriggers: true, chatSafeguardingAssigneeIdentity: true,
      distributedRateLimits: true,
      trainingCompanion: true,
    }]);

    const response = await request(app).get('/api/health').expect(200);

    expect(response.body.capabilities.accountSecurity).toBe(capability);
    query.mockRestore();
  });

  it('reports schema drift as a service-unavailable health response', async () => {
    for (const name of testEnvironment) delete process.env[name];
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    Object.assign(process.env, validCalendarEnvironment, validFamilyHandoverEnvironment);
    vi.resetModules();
    const [{ app }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/db.js')]);
    const query = vi.spyOn(prisma, '$queryRawUnsafe').mockResolvedValueOnce([{
      coachInvitations: true,
      packageScopeColumn: true,
      packageScopeTrigger: true,
      venueUnitIdentity: true,
      namedClubStaff: true,
      bookingSeries: true,
      venueAllocation: true,
      paymentProviderEvents: true,
      outboundDelivery: true,
      accountSecurity: true,
      activeStripeBookingCheckoutGuard: true,
      paymentCompliance: false,
      paymentReceipts: true,
      guardianChildAccounts: true,
      childConsentAppendOnly: true,
      onePendingChildHandover: true,
      signupEvidence: true,
      privacyRequests: true,
      chatSafeguardingTables: true,
      chatSafeguardingPermissions: true,
      chatSafeguardingIndexes: true,
      chatSafeguardingTriggers: true,
      chatSafeguardingAssigneeIdentity: true,
      distributedRateLimits: true,
      trainingCompanion: true,
    }]);

    const response = await request(app).get('/api/health').expect(503);

    expect(response.body).toEqual({
      error: 'Database schema is out of date. Run pending migrations.',
      schema: 'out-of-date',
    });
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

  it('enables family handovers only for a complete dedicated 32-byte keyring', async () => {
    const valid = await loadCalendarConfig();
    expect(valid.config.familyHandoverTokens.enabled).toBe(true);
    expect(valid.config.familyHandoverTokens.keys.get('v1')).toHaveLength(32);

    const missingActive = await loadCalendarConfig({ FAMILY_HANDOVER_TOKEN_ACTIVE_KEY_ID: 'v2' });
    expect(missingActive.config.familyHandoverTokens.enabled).toBe(false);
    const malformed = await loadCalendarConfig({ FAMILY_HANDOVER_TOKEN_KEYS: 'v1:not-base64' });
    expect(malformed.config.familyHandoverTokens.enabled).toBe(false);
  });

  it.each([
    ['complete configuration', 'configured', {
      ...validFamilyHandoverEnvironment,
      EMAIL_PROVIDER: 'capture',
      EMAIL_FROM_ADDRESS: 'security@courtly.example.test',
    }],
    ['missing email', 'disabled', validFamilyHandoverEnvironment],
    ['missing keyring', 'disabled', {
      EMAIL_PROVIDER: 'capture',
      EMAIL_FROM_ADDRESS: 'security@courtly.example.test',
      FAMILY_HANDOVER_TOKEN_KEYS: '',
      FAMILY_HANDOVER_TOKEN_ACTIVE_KEY_ID: '',
    }],
    ['invalid keyring', 'disabled', {
      EMAIL_PROVIDER: 'capture',
      EMAIL_FROM_ADDRESS: 'security@courtly.example.test',
      FAMILY_HANDOVER_TOKEN_KEYS: 'v1:not-base64',
      FAMILY_HANDOVER_TOKEN_ACTIVE_KEY_ID: 'v1',
    }],
  ] as const)('reports Family handover readiness for %s', async (_case, capability, environment) => {
    for (const name of testEnvironment) delete process.env[name];
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_FROM_ADDRESS;
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    Object.assign(process.env, validCalendarEnvironment, environment);
    vi.resetModules();
    const [{ app }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/db.js')]);
    const query = vi.spyOn(prisma, '$queryRawUnsafe').mockResolvedValueOnce([{
      coachInvitations: true,
      packageScopeColumn: true,
      packageScopeTrigger: true,
      venueUnitIdentity: true,
      namedClubStaff: true,
      bookingSeries: true,
      venueAllocation: true,
      paymentProviderEvents: true,
      outboundDelivery: true,
      accountSecurity: true,
      activeStripeBookingCheckoutGuard: true,
      paymentCompliance: true,
      paymentReceipts: true,
      guardianChildAccounts: true,
      childConsentAppendOnly: true,
      onePendingChildHandover: true,
      signupEvidence: true,
      privacyRequests: true,
      chatSafeguardingTables: true,
      chatSafeguardingPermissions: true,
      chatSafeguardingIndexes: true,
      chatSafeguardingTriggers: true,
      chatSafeguardingAssigneeIdentity: true,
      distributedRateLimits: true,
      trainingCompanion: true,
    }]);

    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.capabilities.familyHandover).toBe(capability);
    query.mockRestore();
  });

  it('reports the Family rollout gate separately from configured handover dependencies', async () => {
    for (const name of testEnvironment) delete process.env[name];
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    Object.assign(process.env, validCalendarEnvironment, validFamilyHandoverEnvironment, {
      FAMILY_FEATURE_ENABLED: 'false',
      EMAIL_PROVIDER: 'capture',
      EMAIL_FROM_ADDRESS: 'security@courtly.example.test',
    });
    vi.resetModules();
    const [{ app }, { prisma }] = await Promise.all([import('../src/app.js'), import('../src/db.js')]);
    const query = vi.spyOn(prisma, '$queryRawUnsafe').mockResolvedValueOnce([{
      coachInvitations: true,
      packageScopeColumn: true,
      packageScopeTrigger: true,
      venueUnitIdentity: true,
      namedClubStaff: true,
      bookingSeries: true,
      venueAllocation: true,
      paymentProviderEvents: true,
      outboundDelivery: true,
      accountSecurity: true,
      activeStripeBookingCheckoutGuard: true,
      paymentCompliance: true,
      paymentReceipts: true,
      guardianChildAccounts: true,
      childConsentAppendOnly: true,
      onePendingChildHandover: true,
      signupEvidence: true,
      privacyRequests: true,
      chatSafeguardingTables: true,
      chatSafeguardingPermissions: true,
      chatSafeguardingIndexes: true,
      chatSafeguardingTriggers: true,
      chatSafeguardingAssigneeIdentity: true,
      distributedRateLimits: true,
      trainingCompanion: true,
    }]);

    const response = await request(app).get('/api/health').expect(200);
    expect(response.body.capabilities.family).toBe('disabled');
    expect(response.body.capabilities.familyHandover).toBe('configured');
    query.mockRestore();
  });

  it('hides public claims and closes authenticated Family routes while the rollout gate is off', async () => {
    for (const name of testEnvironment) delete process.env[name];
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    Object.assign(process.env, validCalendarEnvironment, validFamilyHandoverEnvironment, {
      FAMILY_FEATURE_ENABLED: 'false',
    });
    vi.resetModules();
    const { app } = await import('../src/app.js');

    const claim = await request(app).get('/api/family/handovers/redacted-token').expect(404);
    expect(claim.body).toEqual({ error: 'Route not found' });
    const completion = await request(app).post('/api/family/handovers/redacted-token/complete')
      .send({ password: 'not-used' }).expect(404);
    expect(completion.body).toEqual({ error: 'Route not found' });

    const gatedRequests = [
      ['family dashboard', () => request(app).get('/api/family')],
      ['booking child chooser', () => request(app).get('/api/family/booking-children')],
      ['child booking', () => request(app).post('/api/family/children/child-id/bookings').send({})],
      ['date of birth', () => request(app).post('/api/family/date-of-birth').send({})],
      ['child creation', () => request(app).post('/api/family/children').send({})],
      ['child update', () => request(app).patch('/api/family/children/child-id').send({})],
      ['consent withdrawal', () => request(app).post('/api/family/children/child-id/consent/withdraw').send({})],
      ['consent renewal', () => request(app).post('/api/family/children/child-id/consent/renew').send({})],
      ['deletion request', () => request(app).post('/api/family/children/child-id/deletion-request').send({})],
      ['handover creation', () => request(app).post('/api/family/children/child-id/handovers').send({})],
      ['handover cancellation', () => request(app).delete('/api/family/children/child-id/handovers/handover-id')],
      ['child export', () => request(app).get('/api/family/children/child-id/export')],
    ] as const;
    for (const [_surface, gatedRequest] of gatedRequests) {
      const response = await gatedRequest().expect(503);
      expect(response.body).toEqual({ error: 'Family features are temporarily unavailable' });
    }
  });
});
