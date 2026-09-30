-- Shared fixed-window counters for API abuse protection. The application
-- stores only a namespaced HMAC-SHA-256 digest, never an IP or account ID.
CREATE TABLE "RateLimitCounter" (
  "namespace" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "hits" BIGINT NOT NULL,
  "resetAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL,

  CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("namespace", "keyHash"),
  CONSTRAINT "RateLimitCounter_namespace_length_check" CHECK (char_length("namespace") BETWEEN 1 AND 96),
  CONSTRAINT "RateLimitCounter_key_hash_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RateLimitCounter_hits_check" CHECK ("hits" BETWEEN 0 AND 9007199254740991)
);

CREATE INDEX "RateLimitCounter_resetAt_idx" ON "RateLimitCounter"("resetAt");
