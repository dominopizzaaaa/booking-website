import { afterEach, describe, expect, it, vi } from 'vitest';

const environmentKeys = [
  'NODE_ENV',
  'DATABASE_URL',
  'PAYMENTS_MODE',
  'EMAIL_PROVIDER',
  'EMAIL_API_KEY',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_VERIFICATION_TOKEN_KEYS',
  'EMAIL_VERIFICATION_TOKEN_ACTIVE_KEY_ID',
  'PUBLIC_APP_ORIGIN',
  'LEGAL_DOCUMENTS_APPROVED_VERSION',
  'LEGAL_DOCUMENTS_APPROVED_HASH',
  'PAYMENT_COMMERCIAL_APPROVED_VERSION',
  'ADMIN_OPERATORS_JSON',
  'ADMIN_SESSION_SECRET',
  'RATE_LIMIT_HASH_KEY',
] as const;

const originalEnvironment = Object.fromEntries(
  environmentKeys.map(name => [name, process.env[name]]),
) as Record<(typeof environmentKeys)[number], string | undefined>;

async function loadProductionConfig(overrides: Partial<Record<(typeof environmentKeys)[number], string | undefined>> = {}) {
  for (const name of environmentKeys) delete process.env[name];
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    PAYMENTS_MODE: 'disabled',
    EMAIL_PROVIDER: 'resend',
    EMAIL_API_KEY: 're_test_key',
    EMAIL_FROM_ADDRESS: 'security@courtly.example',
    EMAIL_VERIFICATION_TOKEN_KEYS: `v1:${Buffer.alloc(32, 23).toString('base64')}`,
    EMAIL_VERIFICATION_TOKEN_ACTIVE_KEY_ID: 'v1',
    ADMIN_OPERATORS_JSON: JSON.stringify([{
      id: 'legal-config-test', name: 'Legal Config Test', email: 'legal-config@example.test',
      passwordHash: '$2b$12$QrsSSNoV/kdmGVRTVVmoIOKhMlSeSPFjGtV8.iKB7MHYFUPprZWyK',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    }]),
    ADMIN_SESSION_SECRET: Buffer.alloc(32, 24).toString('base64'),
    RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 31).toString('base64'),
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
  return import('../src/config.js');
}

afterEach(() => {
  for (const name of environmentKeys) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

describe('production transactional-email origin', () => {
  it('requires an explicit PUBLIC_APP_ORIGIN when production email is enabled', async () => {
    await expect(loadProductionConfig()).rejects.toThrow(
      'PUBLIC_APP_ORIGIN is required when production email is enabled',
    );
  });

  it.each([
    ['plain HTTP', 'http://courtly.example.com'],
    ['localhost', 'https://localhost'],
    ['IPv4 loopback', 'https://127.0.0.1'],
    ['IPv6 loopback', 'https://[::1]'],
    ['a path', 'https://courtly.example.com/account'],
    ['a query', 'https://courtly.example.com?source=email'],
    ['a fragment', 'https://courtly.example.com#verification'],
    ['credentials', 'https://sender:secret@courtly.example.com'],
  ])('rejects %s', async (_description, publicAppOrigin) => {
    await expect(loadProductionConfig({ PUBLIC_APP_ORIGIN: publicAppOrigin })).rejects.toThrow(
      'PUBLIC_APP_ORIGIN must be a canonical non-loopback HTTPS origin',
    );
  });

  it('accepts a canonical non-loopback HTTPS origin', async () => {
    const { config } = await loadProductionConfig({
      PUBLIC_APP_ORIGIN: 'https://courtly.example.com',
    });

    expect(config.publicAppOrigin).toBe('https://courtly.example.com');
    expect(config.emailVerificationTokens.enabled).toBe(true);
    expect(config.emailVerificationTokens.activeKeyId).toBe('v1');
    expect(config.emailVerificationTokens.keys.get('v1')).toEqual(Buffer.alloc(32, 23));
  });

  it('keeps the API bootable but registration closed when the production verification keyring is absent', async () => {
    const { config } = await loadProductionConfig({
      PUBLIC_APP_ORIGIN: 'https://courtly.example.com',
      EMAIL_VERIFICATION_TOKEN_KEYS: undefined,
      EMAIL_VERIFICATION_TOKEN_ACTIVE_KEY_ID: undefined,
    });
    expect(config.emailVerificationTokens).toMatchObject({ enabled: false, activeKeyId: '' });
    const { assertSignupEmailVerificationAvailable } = await import('../src/auth.js');
    expect(() => assertSignupEmailVerificationAvailable()).toThrowError(expect.objectContaining({
      status: 503, details: { code: 'SIGNUP_EMAIL_VERIFICATION_UNAVAILABLE' },
    }));
  });

  it('does not treat legal approval as commercial approval', async () => {
    const { config } = await loadProductionConfig({
      PUBLIC_APP_ORIGIN: 'https://courtly.example.com',
      LEGAL_DOCUMENTS_APPROVED_VERSION: '2026-09-29',
      LEGAL_DOCUMENTS_APPROVED_HASH: 'a'.repeat(64),
      PAYMENT_COMMERCIAL_APPROVED_VERSION: ' 2026-09-29 ',
    });
    expect(config.paymentCommercialApprovedVersion).toBe('2026-09-29');
  });

  it('keeps legal-document approval separate and never enables marketing', async () => {
    const { config } = await loadProductionConfig({
      PUBLIC_APP_ORIGIN: 'https://courtly.example.com',
      LEGAL_DOCUMENTS_APPROVED_VERSION: '2026-09-29',
      LEGAL_DOCUMENTS_APPROVED_HASH: 'A'.repeat(64),
    });

    expect(config.legalDocumentsApprovedVersion).toBe('2026-09-29');
    expect(config.legalDocumentsApprovedHash).toBe('a'.repeat(64));
    expect(config.marketingEnabled).toBe(false);
  });

  it('opens production legal acceptance only for the exact version and policy-set hash', async () => {
    await loadProductionConfig({
      PUBLIC_APP_ORIGIN: 'https://courtly.example.com',
      LEGAL_DOCUMENTS_APPROVED_VERSION: '2026-09-29',
    });
    const unapproved = await import('../src/legal-policy.js');
    const unapprovedGate = await import('../src/legal-policy-gate.js');
    expect(unapproved.LEGAL_DOCUMENTS_APPROVED).toBe(false);
    expect(() => unapprovedGate.assertLegalAcceptanceEnabled()).toThrowError(expect.objectContaining({
      status: 503, details: { code: 'LEGAL_DOCUMENTS_NOT_APPROVED' },
    }));

    const approvedHash = unapproved.CURRENT_LEGAL_POLICY_SET_HASH;
    await loadProductionConfig({
      PUBLIC_APP_ORIGIN: 'https://courtly.example.com',
      LEGAL_DOCUMENTS_APPROVED_VERSION: '2026-09-29',
      LEGAL_DOCUMENTS_APPROVED_HASH: approvedHash,
    });
    const approved = await import('../src/legal-policy.js');
    const approvedGate = await import('../src/legal-policy-gate.js');
    expect(approved.LEGAL_DOCUMENTS_APPROVED).toBe(true);
    expect(() => approvedGate.assertLegalAcceptanceEnabled()).not.toThrow();
  });
});
