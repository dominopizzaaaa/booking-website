import { afterEach, describe, expect, it, vi } from 'vitest';

const originalNodeEnv = process.env.NODE_ENV;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBypass = process.env.E2E_DISABLE_RATE_LIMITS;

async function loadRateLimitConfig(nodeEnv: string, bypass?: string) {
  process.env.NODE_ENV = nodeEnv;
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
  if (bypass === undefined) delete process.env.E2E_DISABLE_RATE_LIMITS;
  else process.env.E2E_DISABLE_RATE_LIMITS = bypass;
  vi.resetModules();
  return import('../src/config.js');
}

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalBypass === undefined) delete process.env.E2E_DISABLE_RATE_LIMITS;
  else process.env.E2E_DISABLE_RATE_LIMITS = originalBypass;
  vi.resetModules();
});

describe('E2E rate-limit bypass configuration', () => {
  it('is off by default during development', async () => {
    const { config, skipRateLimits } = await loadRateLimitConfig('development');
    expect(config.e2eRateLimitBypass).toBe(false);
    expect(skipRateLimits()).toBe(false);
  });

  it('is enabled only by an explicit non-production opt-in', async () => {
    const { config, skipRateLimits } = await loadRateLimitConfig('development', 'true');
    expect(config.e2eRateLimitBypass).toBe(true);
    expect(skipRateLimits()).toBe(true);
  });

  it('ignores the opt-in in production', async () => {
    const { config, skipRateLimits } = await loadRateLimitConfig('production', 'true');
    expect(config.e2eRateLimitBypass).toBe(false);
    expect(skipRateLimits()).toBe(false);
  });
});
