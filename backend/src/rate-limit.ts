import { createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { rateLimit, type Options, type Store } from 'express-rate-limit';
import { prisma } from './db.js';
import { config, skipRateLimits } from './config.js';
import { HttpError } from './http.js';

type RateLimitDatabase = Pick<PrismaClient, '$executeRaw' | '$queryRaw'>;

export type SharedRateLimitOptions = Omit<Partial<Options>, 'store' | 'passOnStoreError'> & {
  /** Stable, deployment-wide namespace. Never reuse it for a different quota. */
  name: string;
  /** Protected operations fail closed by default when PostgreSQL is unavailable. */
  failureMode?: 'closed' | 'open';
  /** Injectable only for focused tests; application callers use the shared client. */
  database?: RateLimitDatabase;
};

type CounterRow = { hits: number | bigint; resetAt: Date };

const RATE_LIMIT_NAME = /^[a-z0-9][a-z0-9:_-]{0,95}$/;

/**
 * Fixed-window counter shared by every API replica through the primary
 * PostgreSQL database. Raw IP addresses, account IDs and claim values are
 * never stored: each policy gets only an HMAC-SHA-256 digest of its key.
 */
export class PostgresRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;
  private operationsUntilCleanup = 256;

  constructor(
    readonly name: string,
    private readonly database: RateLimitDatabase = prisma,
  ) {
    if (!RATE_LIMIT_NAME.test(name)) {
      throw new TypeError('Rate-limit names must use 1-96 lowercase letters, numbers, colons, underscores, or hyphens');
    }
    this.prefix = `courtly:${name}:`;
  }

  init(options: Options) {
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new TypeError('Rate-limit windows must be positive whole milliseconds');
    }
    this.windowMs = options.windowMs;
  }

  private digest(key: string) {
    return createHmac('sha256', config.rateLimitHashKey)
      .update(`${this.prefix}${key}`, 'utf8').digest('hex');
  }

  async increment(key: string) {
    let row: CounterRow | undefined;
    try {
      [row] = await this.database.$queryRaw<CounterRow[]>(Prisma.sql`
        INSERT INTO "RateLimitCounter" ("namespace", "keyHash", "hits", "resetAt")
        VALUES (
          ${this.name}, ${this.digest(key)}, 1,
          CURRENT_TIMESTAMP + (${this.windowMs}::BIGINT * INTERVAL '1 millisecond')
        )
        ON CONFLICT ("namespace", "keyHash") DO UPDATE SET
          "hits" = CASE
            WHEN "RateLimitCounter"."resetAt" <= CURRENT_TIMESTAMP THEN 1
            ELSE LEAST("RateLimitCounter"."hits" + 1, 9007199254740991)
          END,
          "resetAt" = CASE
            WHEN "RateLimitCounter"."resetAt" <= CURRENT_TIMESTAMP
              THEN CURRENT_TIMESTAMP + (${this.windowMs}::BIGINT * INTERVAL '1 millisecond')
            ELSE "RateLimitCounter"."resetAt"
          END
        RETURNING "hits", "resetAt"
      `);
    } catch (cause) {
      throw new RateLimitStoreUnavailableError(cause);
    }
    if (!row) throw new RateLimitStoreUnavailableError(
      new Error('Rate-limit counter increment returned no row'),
    );

    // Once per 256 requests per process, remove a bounded batch
    // of stale counters. Correctness never depends on cleanup winning a race.
    this.operationsUntilCleanup -= 1;
    if (this.operationsUntilCleanup === 0) {
      this.operationsUntilCleanup = 256;
      void this.cleanup().catch(error => {
        console.error('Rate-limit counter cleanup failed', error);
      });
    }

    return { totalHits: Number(row.hits), resetTime: row.resetAt };
  }

  async decrement(key: string) {
    try {
      await this.database.$executeRaw(Prisma.sql`
        UPDATE "RateLimitCounter"
        SET "hits" = GREATEST("hits" - 1, 0)
        WHERE "namespace" = ${this.name}
          AND "keyHash" = ${this.digest(key)}
          AND "resetAt" > CURRENT_TIMESTAMP
      `);
    } catch (error) {
      // express-rate-limit decrements after the response has completed. A
      // rejected promise there would be unhandled; keeping the hit is the safe
      // conservative outcome until its short window expires.
      console.error('Rate-limit counter decrement failed', error);
    }
  }

  async resetKey(key: string) {
    try {
      await this.database.$executeRaw(Prisma.sql`
        DELETE FROM "RateLimitCounter"
        WHERE "namespace" = ${this.name} AND "keyHash" = ${this.digest(key)}
      `);
    } catch (cause) {
      throw new RateLimitStoreUnavailableError(cause);
    }
  }

  private async cleanup() {
    const retentionBoundary = new Date(Date.now() - 24 * 60 * 60_000);
    await this.database.$executeRaw(Prisma.sql`
      DELETE FROM "RateLimitCounter"
      WHERE ctid IN (
        SELECT ctid FROM "RateLimitCounter"
        WHERE "resetAt" < ${retentionBoundary}
        ORDER BY "resetAt" ASC
        LIMIT 500
      )
    `);
  }
}

/** Courtly's common express-rate-limit policy with a distributed store. */
export class RateLimitStoreUnavailableError extends HttpError {
  constructor(cause: unknown) {
    super(503, 'Request protection is temporarily unavailable', {
      code: 'RATE_LIMIT_STORE_UNAVAILABLE',
    });
    this.name = 'RateLimitStoreUnavailableError';
    this.cause = cause;
  }
}

export function sharedRateLimit({
  name, failureMode = 'closed', database, ...options
}: SharedRateLimitOptions) {
  const policySkip = options.skip;
  return rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: name,
    ...options,
    // The test-only bypass remains authoritative even for a policy with a
    // narrower custom skip predicate. Production config always disables it.
    skip: async (request, response) => skipRateLimits()
      || Boolean(await policySkip?.(request, response)),
    store: new PostgresRateLimitStore(name, database),
    passOnStoreError: failureMode === 'open',
  });
}
