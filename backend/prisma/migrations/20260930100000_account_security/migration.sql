BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE "AuthSession"
  ADD COLUMN "publicId" TEXT,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3),
  ADD COLUMN "recentAuthAt" TIMESTAMP(3),
  ADD COLUMN "userAgent" TEXT;

UPDATE "AuthSession" SET
  "publicId" = md5(random()::TEXT || clock_timestamp()::TEXT || "id"),
  "lastSeenAt" = "createdAt";

ALTER TABLE "AuthSession"
  ALTER COLUMN "publicId" SET NOT NULL,
  ALTER COLUMN "publicId" SET DEFAULT (gen_random_uuid())::TEXT,
  ALTER COLUMN "lastSeenAt" SET NOT NULL,
  ALTER COLUMN "lastSeenAt" SET DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "AuthSession_activity_check" CHECK (
    "userAgent" IS NULL OR length("userAgent") <= 500
  );
CREATE UNIQUE INDEX "AuthSession_publicId_key" ON "AuthSession"("publicId");
CREATE INDEX "AuthSession_userId_lastSeenAt_idx" ON "AuthSession"("userId", "lastSeenAt");

CREATE TABLE "PasswordResetClaim" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL,
  "tokenKeyId" TEXT NOT NULL, "email" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PasswordResetClaim_shape_check" CHECK (
    "email" = lower(btrim("email")) AND length("email") BETWEEN 3 AND 254
    AND "tokenHash" ~ '^[0-9a-f]{64}$' AND "tokenKeyId" ~ '^[A-Za-z0-9_-]{1,64}$'
    AND "expiresAt" > "createdAt"
    AND NOT ("consumedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "PasswordResetClaim_tokenHash_key" ON "PasswordResetClaim"("tokenHash");
CREATE INDEX "PasswordResetClaim_userId_createdAt_idx" ON "PasswordResetClaim"("userId", "createdAt");
CREATE INDEX "PasswordResetClaim_expiresAt_idx" ON "PasswordResetClaim"("expiresAt");
CREATE UNIQUE INDEX "PasswordResetClaim_one_live_per_user" ON "PasswordResetClaim"("userId")
  WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;
ALTER TABLE "PasswordResetClaim" ADD CONSTRAINT "PasswordResetClaim_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EmailChangeClaim" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL,
  "tokenKeyId" TEXT NOT NULL, "oldEmail" TEXT NOT NULL, "newEmail" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailChangeClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailChangeClaim_shape_check" CHECK (
    "oldEmail" = lower(btrim("oldEmail")) AND length("oldEmail") BETWEEN 3 AND 254
    AND "newEmail" = lower(btrim("newEmail")) AND length("newEmail") BETWEEN 3 AND 254
    AND "oldEmail" <> "newEmail"
    AND "tokenHash" ~ '^[0-9a-f]{64}$' AND "tokenKeyId" ~ '^[A-Za-z0-9_-]{1,64}$'
    AND "expiresAt" > "createdAt"
    AND NOT ("consumedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "EmailChangeClaim_tokenHash_key" ON "EmailChangeClaim"("tokenHash");
CREATE INDEX "EmailChangeClaim_userId_createdAt_idx" ON "EmailChangeClaim"("userId", "createdAt");
CREATE INDEX "EmailChangeClaim_newEmail_expiresAt_idx" ON "EmailChangeClaim"("newEmail", "expiresAt");
CREATE INDEX "EmailChangeClaim_expiresAt_idx" ON "EmailChangeClaim"("expiresAt");
CREATE UNIQUE INDEX "EmailChangeClaim_one_live_per_user" ON "EmailChangeClaim"("userId")
  WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;
CREATE UNIQUE INDEX "EmailChangeClaim_one_live_per_destination" ON "EmailChangeClaim"("newEmail")
  WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;
ALTER TABLE "EmailChangeClaim" ADD CONSTRAINT "EmailChangeClaim_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AccountMfaCredential" (
  "userId" TEXT NOT NULL, "secretCiphertext" TEXT NOT NULL, "enabledAt" TIMESTAMP(3),
  "lastUsedStep" BIGINT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountMfaCredential_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "AccountMfaCredential_shape_check" CHECK (
    length("secretCiphertext") BETWEEN 20 AND 1000
    AND ("lastUsedStep" IS NULL OR "lastUsedStep" >= 0)
  )
);
ALTER TABLE "AccountMfaCredential" ADD CONSTRAINT "AccountMfaCredential_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AccountMfaEnrollment" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "secretCiphertext" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0, "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountMfaEnrollment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountMfaEnrollment_shape_check" CHECK (
    length("secretCiphertext") BETWEEN 20 AND 1000
    AND "attempts" BETWEEN 0 AND 5
    AND "expiresAt" > "createdAt"
    AND NOT ("consumedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
  )
);
CREATE INDEX "AccountMfaEnrollment_userId_createdAt_idx" ON "AccountMfaEnrollment"("userId", "createdAt");
CREATE INDEX "AccountMfaEnrollment_expiresAt_idx" ON "AccountMfaEnrollment"("expiresAt");
CREATE UNIQUE INDEX "AccountMfaEnrollment_one_live_per_user" ON "AccountMfaEnrollment"("userId")
  WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;
ALTER TABLE "AccountMfaEnrollment" ADD CONSTRAINT "AccountMfaEnrollment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AccountMfaRecoveryCode" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "codeHash" TEXT NOT NULL,
  "keyId" TEXT NOT NULL, "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountMfaRecoveryCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountMfaRecoveryCode_shape_check" CHECK (
    "codeHash" ~ '^[0-9a-f]{64}$' AND "keyId" ~ '^[A-Za-z0-9_-]{1,64}$'
    AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
  )
);
CREATE UNIQUE INDEX "AccountMfaRecoveryCode_codeHash_key" ON "AccountMfaRecoveryCode"("codeHash");
CREATE INDEX "AccountMfaRecoveryCode_userId_consumedAt_idx" ON "AccountMfaRecoveryCode"("userId", "consumedAt");
ALTER TABLE "AccountMfaRecoveryCode" ADD CONSTRAINT "AccountMfaRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MfaLoginChallenge" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "tokenHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0, "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3), "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MfaLoginChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MfaLoginChallenge_shape_check" CHECK (
    "tokenHash" ~ '^[0-9a-f]{64}$' AND "attempts" BETWEEN 0 AND 5
    AND "expiresAt" > "createdAt"
    AND NOT ("consumedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "MfaLoginChallenge_tokenHash_key" ON "MfaLoginChallenge"("tokenHash");
CREATE INDEX "MfaLoginChallenge_userId_createdAt_idx" ON "MfaLoginChallenge"("userId", "createdAt");
CREATE INDEX "MfaLoginChallenge_expiresAt_idx" ON "MfaLoginChallenge"("expiresAt");
CREATE UNIQUE INDEX "MfaLoginChallenge_one_live_per_user" ON "MfaLoginChallenge"("userId")
  WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;
ALTER TABLE "MfaLoginChallenge" ADD CONSTRAINT "MfaLoginChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AccountSecurityEvent" (
  "id" TEXT NOT NULL, "userId" TEXT, "subjectUserIdSnapshot" TEXT NOT NULL,
  "eventType" TEXT NOT NULL, "sessionPublicId" TEXT, "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountSecurityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountSecurityEvent_shape_check" CHECK (
    btrim("subjectUserIdSnapshot") <> ''
    AND "eventType" IN ('PASSWORD_RESET_COMPLETED', 'EMAIL_CHANGE_STARTED', 'EMAIL_CHANGE_COMPLETED',
      'MFA_ENABLED', 'MFA_DISABLED', 'MFA_RECOVERY_CODES_REPLACED', 'MFA_RECOVERY_CODE_USED',
      'SESSION_REVOKED', 'OTHER_SESSIONS_REVOKED', 'RECENT_AUTH_SUCCEEDED')
    AND jsonb_typeof("metadata") = 'object'
  )
);
CREATE INDEX "AccountSecurityEvent_userId_createdAt_idx" ON "AccountSecurityEvent"("userId", "createdAt");
CREATE INDEX "AccountSecurityEvent_subjectUserIdSnapshot_createdAt_idx" ON "AccountSecurityEvent"("subjectUserIdSnapshot", "createdAt");
CREATE INDEX "AccountSecurityEvent_eventType_createdAt_idx" ON "AccountSecurityEvent"("eventType", "createdAt");
ALTER TABLE "AccountSecurityEvent" ADD CONSTRAINT "AccountSecurityEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "_courtly_account_security_event_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The optional subject relation is deliberately SET NULL when PostgreSQL
  -- deletes the referenced account. Permit only that nested FK action while
  -- keeping the retained event snapshot and every other field immutable.
  IF TG_OP = 'UPDATE'
    AND OLD."userId" IS NOT NULL
    AND NEW."userId" IS NULL
    AND (to_jsonb(NEW) - 'userId') = (to_jsonb(OLD) - 'userId')
    AND NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Account security events are immutable';
END;
$$;
CREATE TRIGGER "AccountSecurityEvent_immutable"
  BEFORE UPDATE OR DELETE ON "AccountSecurityEvent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_account_security_event_immutable"();
CREATE TRIGGER "AccountSecurityEvent_truncate_guard"
  BEFORE TRUNCATE ON "AccountSecurityEvent" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_account_security_event_immutable"();

COMMIT;
