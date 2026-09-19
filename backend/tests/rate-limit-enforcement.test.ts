import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const validPassword = 'correct-password';
const invalidPassword = 'incorrect-password';
const loginEmail = 'rate-limit-user@example.test';
const validPasswordHash = '$2b$12$QrsSSNoV/kdmGVRTVVmoIOKhMlSeSPFjGtV8.iKB7MHYFUPprZWyK';
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'E2E_DISABLE_RATE_LIMITS'] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

function setEnv(key: typeof envKeys[number], value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv() {
  for (const key of envKeys) setEnv(key, originalEnv[key]);
}

async function loadConfig(nodeEnv: string, bypass: string | undefined) {
  setEnv('NODE_ENV', nodeEnv);
  setEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:5432/rate_limit_test');
  setEnv('E2E_DISABLE_RATE_LIMITS', bypass);
  vi.resetModules();
  return import('../src/config.js');
}

async function loadAuthHarness() {
  setEnv('NODE_ENV', 'test');
  setEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:5432/rate_limit_test');
  setEnv('E2E_DISABLE_RATE_LIMITS', undefined);
  vi.resetModules();

  const compare = vi.fn(async (candidate: string) => candidate === validPassword);
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'rate-limit-user',
        name: 'Rate Limit User',
        email: loginEmail,
        phone: '',
        parentName: '',
        accountType: 'STUDENT',
        passwordHash: validPasswordHash,
        memberships: [],
      })),
    },
    authSession: {
      findUnique: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => ({})),
    },
  };

  vi.doMock('bcryptjs', () => ({
    default: {
      compare,
      hash: vi.fn(async () => validPasswordHash),
    },
  }));
  vi.doMock('../src/db.js', () => ({ prisma }));
  vi.doMock('../src/seed.js', () => ({ seedBusiness: vi.fn() }));
  vi.doMock('../src/serializers.js', () => ({
    authState: vi.fn(async () => ({
      user: {
        id: 'rate-limit-user',
        name: 'Rate Limit User',
        email: loginEmail,
        phone: '',
        parentName: '',
        accountType: 'STUDENT',
      },
      membership: null,
      business: null,
      memberships: [],
    })),
  }));

  const { authRouter } = await import('../src/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(typeof error?.status === 'number' ? error.status : 500).json({
      error: error instanceof Error ? error.message : 'Unexpected test error',
    });
  };
  app.use(errorHandler);
  return { app, compare };
}

function login(app: express.Express, password: string) {
  return request(app).post('/api/auth/login').send({ email: loginEmail, password });
}

afterEach(() => {
  vi.doUnmock('bcryptjs');
  vi.doUnmock('../src/db.js');
  vi.doUnmock('../src/seed.js');
  vi.doUnmock('../src/serializers.js');
  vi.clearAllMocks();
  restoreEnv();
  vi.resetModules();
});

describe.sequential('rate-limit enforcement', () => {
  it('keeps the non-production bypass off unless it is explicitly enabled', async () => {
    const defaults = await loadConfig('development', undefined);
    expect(defaults.config.e2eRateLimitBypass).toBe(false);
    expect(defaults.skipRateLimits()).toBe(false);

    const optedIn = await loadConfig('development', 'true');
    expect(optedIn.config.e2eRateLimitBypass).toBe(true);
    expect(optedIn.skipRateLimits()).toBe(true);
  });

  it('ignores the bypass opt-in in production', async () => {
    const { config, skipRateLimits } = await loadConfig('production', 'true');
    expect(config.e2eRateLimitBypass).toBe(false);
    expect(skipRateLimits()).toBe(false);
  });

  it('returns 429 after the configured failed-login quota is exhausted', async () => {
    const { app, compare } = await loadAuthHarness();

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await login(app, invalidPassword);
      expect(response.status, `failed login ${attempt} should remain inside the quota`).toBe(401);
    }

    const limited = await login(app, invalidPassword);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Too many attempts. Please try again later.' });
    expect(compare).toHaveBeenCalledTimes(30);
  });

  it('does not spend the failed-login quota on successful logins', async () => {
    const { app, compare } = await loadAuthHarness();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await login(app, validPassword);
      expect(response.status, `successful login ${attempt}`).toBe(200);
    }
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const response = await login(app, invalidPassword);
      expect(response.status, `failed login ${attempt} should retain its full quota`).toBe(401);
    }

    const limited = await login(app, invalidPassword);
    expect(limited.status).toBe(429);
    expect(compare).toHaveBeenCalledTimes(33);
  });
});
