import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRateLimitStore } from '../src/rate-limit.js';
import { prisma, verifyTestDatabase } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe('PostgresRateLimitStore integration', () => {
  it('atomically shares a counter across independent store instances', async () => {
    const namespace = `test-${randomUUID()}`;
    const key = `client-${randomUUID()}`;
    const first = new PostgresRateLimitStore(namespace);
    const second = new PostgresRateLimitStore(namespace);
    first.init({ windowMs: 60_000 } as never);
    second.init({ windowMs: 60_000 } as never);

    try {
      const results = await Promise.all(Array.from(
        { length: 20 }, (_, index) => (index % 2 ? first : second).increment(key),
      ));
      expect(results.map(result => result.totalHits).sort((left, right) => left - right))
        .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(new Set(results.map(result => result.resetTime.toISOString())).size).toBe(1);
    } finally {
      await first.resetKey(key);
    }
  });

  it('starts a fresh window after expiry and resetKey removes the shared row', async () => {
    const namespace = `test-${randomUUID()}`;
    const key = `client-${randomUUID()}`;
    const store = new PostgresRateLimitStore(namespace);
    store.init({ windowMs: 60_000 } as never);

    await store.increment(key);
    await prisma.$executeRawUnsafe(
      "UPDATE \"RateLimitCounter\" SET \"resetAt\" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE \"namespace\" = $1",
      namespace,
    );
    await expect(store.increment(key)).resolves.toMatchObject({ totalHits: 1 });
    await store.resetKey(key);
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT count(*)::BIGINT AS count FROM "RateLimitCounter" WHERE "namespace" = $1',
      namespace,
    );
    expect(rows[0]?.count).toBe(0n);
  });
});
