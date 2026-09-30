import { afterEach, describe, expect, it, vi } from 'vitest';

const environmentKeys = [
  'NODE_ENV', 'DATABASE_URL', 'PAYMENTS_MODE', 'EMAIL_PROVIDER',
  'ADMIN_OPERATORS_JSON', 'ADMIN_SESSION_SECRET', 'ADMIN_PASSWORD',
  'RATE_LIMIT_HASH_KEY',
] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
const passwordHash = '$2b$12$iqhVwv9QRpq.hKuJLYeuHOuO5.J3oBTOj5BSn5lUbyZp1KiVkRfsC';
const totpSecret = 'JBSWY3DPEHPK3PXP';

async function loadConfig(overrides: Record<string, string | undefined> = {}) {
  for (const key of environmentKeys) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
    PAYMENTS_MODE: 'disabled', EMAIL_PROVIDER: 'disabled',
    RATE_LIMIT_HASH_KEY: Buffer.alloc(32, 31).toString('base64'),
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  return import('../src/config.js');
}

afterEach(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe('named admin operator configuration', () => {
  it('normalizes a strict named operator list and accepts a dedicated session key', async () => {
    const operators = [{ id: 'ops_alice', name: 'Alice Operator', email: ' Alice@Example.COM ', passwordHash, totpSecret }];
    const { config } = await loadConfig({
      ADMIN_OPERATORS_JSON: JSON.stringify(operators),
      ADMIN_SESSION_SECRET: Buffer.alloc(32, 9).toString('base64'),
    });
    expect(config.adminOperators).toEqual([{ ...operators[0], email: 'alice@example.com' }]);
    expect(config.adminSessionSecretConfigured).toBe(true);
    expect(config.adminSessionSecret).toHaveLength(32);
  });

  it.each([
    ['unknown properties', [{ id: 'ops_one', name: 'One', email: 'one@example.com', passwordHash, totpSecret, role: 'owner' }]],
    ['duplicate ids', [
      { id: 'ops_one', name: 'One', email: 'one@example.com', passwordHash, totpSecret },
      { id: 'ops_one', name: 'Two', email: 'two@example.com', passwordHash, totpSecret },
    ]],
    ['duplicate normalized emails', [
      { id: 'ops_one', name: 'One', email: 'same@example.com', passwordHash, totpSecret },
      { id: 'ops_two', name: 'Two', email: 'SAME@example.com', passwordHash, totpSecret },
    ]],
    ['plaintext passwords', [{ id: 'ops_one', name: 'One', email: 'one@example.com', passwordHash: 'plaintext', totpSecret }]],
  ])('fails admin closed for production %s without taking down application config', async (_label, operators) => {
    const { config } = await loadConfig({ ADMIN_OPERATORS_JSON: JSON.stringify(operators) });
    expect(config.adminOperators).toEqual([]);
    expect(config.adminConfigurationValid).toBe(false);
  });

  it('rejects invalid operator configuration outside production for prompt local feedback', async () => {
    await expect(loadConfig({
      NODE_ENV: 'test',
      ADMIN_OPERATORS_JSON: JSON.stringify([{ id: 'ops_one', name: 'One', email: 'one@example.com', passwordHash: 'plaintext' }]),
    })).rejects.toThrow();
  });

  it('keeps the application bootable but admin unconfigured when production has no named operators', async () => {
    const { config } = await loadConfig({ ADMIN_PASSWORD: 'ignored-shared-secret' });
    expect(config.adminOperators).toEqual([]);
    expect(config.adminPassword).toBe('');
  });

  it('keeps the API bootable but leaves admin invalid for a malformed production session secret', async () => {
    const { config } = await loadConfig({
      ADMIN_OPERATORS_JSON: JSON.stringify([{ id: 'ops_one', name: 'One', email: 'one@example.com', passwordHash, totpSecret }]),
      ADMIN_SESSION_SECRET: Buffer.alloc(31).toString('base64'),
    });
    expect(config.adminConfigurationValid).toBe(false);
    expect(config.adminSessionSecretConfigured).toBe(true);
  });
});
