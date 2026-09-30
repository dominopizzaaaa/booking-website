import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresRateLimitStore, sharedRateLimit } from '../src/rate-limit.js';

function databaseReturning(rows: Array<{ hits: number; resetAt: Date }>) {
  return {
    $queryRaw: vi.fn(async () => rows),
    $executeRaw: vi.fn(async () => 1),
  };
}

describe('PostgresRateLimitStore', () => {
  beforeEach(() => {
    delete process.env.E2E_DISABLE_RATE_LIMITS;
  });

  it('uses an atomic upsert with a namespaced hash instead of persisting the raw key', async () => {
    const resetAt = new Date(Date.now() + 60_000);
    const database = databaseReturning([{ hits: 7, resetAt }]);
    const store = new PostgresRateLimitStore('test-policy', database as never);
    store.init({ windowMs: 60_000 } as never);

    await expect(store.increment('203.0.113.4')).resolves.toEqual({ totalHits: 7, resetTime: resetAt });

    const query = database.$queryRaw.mock.calls[0]?.[0] as { strings: readonly string[]; values: unknown[] };
    expect(query.strings.join('')).toContain('ON CONFLICT ("namespace", "keyHash") DO UPDATE');
    expect(query.values).toContain('test-policy');
    expect(query.values).toContain(60_000);
    expect(query.values).not.toContain('203.0.113.4');
    expect(query.values.some(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))).toBe(true);
  });

  it('keeps policy namespaces independent for the same client key', async () => {
    const first = databaseReturning([{ hits: 1, resetAt: new Date() }]);
    const second = databaseReturning([{ hits: 1, resetAt: new Date() }]);
    await new PostgresRateLimitStore('first-policy', first as never).increment('same-user');
    await new PostgresRateLimitStore('second-policy', second as never).increment('same-user');

    const firstValues = (first.$queryRaw.mock.calls[0]?.[0] as { values: unknown[] }).values;
    const secondValues = (second.$queryRaw.mock.calls[0]?.[0] as { values: unknown[] }).values;
    expect(firstValues[1]).not.toBe(secondValues[1]);
  });

  it('rejects unsafe or unstable namespace names', () => {
    expect(() => new PostgresRateLimitStore('Unsafe Policy')).toThrow(/Rate-limit names/);
  });
});

describe('sharedRateLimit failure policy', () => {
  it('fails closed by default when PostgreSQL cannot count the request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const database = databaseReturning([]);
    database.$queryRaw.mockRejectedValue(new Error('database unavailable'));
    const app = express();
    app.use(sharedRateLimit({
      name: 'closed-test', windowMs: 60_000, limit: 1, database: database as never,
    }));
    app.get('/', (_req, res) => res.json({ ok: true }));
    const handler: ErrorRequestHandler = (_error, _req, res, _next) => {
      res.status(503).json({ error: 'unavailable' });
    };
    app.use(handler);

    const response = await request(app).get('/');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'unavailable' });
    error.mockRestore();
  });

  it('supports an explicit fail-open policy for broad availability limits', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const database = databaseReturning([]);
    database.$queryRaw.mockRejectedValue(new Error('database unavailable'));
    const app = express();
    app.use(sharedRateLimit({
      name: 'open-test', windowMs: 60_000, limit: 1, failureMode: 'open', database: database as never,
    }));
    app.get('/', (_req, res) => res.json({ ok: true }));

    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    error.mockRestore();
  });
});
