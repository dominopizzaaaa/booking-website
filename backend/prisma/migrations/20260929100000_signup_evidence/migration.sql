BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE "User"
  ADD COLUMN "termsAcceptedVersion" TEXT,
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "privacyNoticeAcceptedVersion" TEXT,
  ADD COLUMN "privacyNoticeAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "signupPolicySetHash" TEXT;

ALTER TABLE "User" ADD CONSTRAINT "User_signup_evidence_shape_check" CHECK (
  ("termsAcceptedVersion" IS NULL) = ("termsAcceptedAt" IS NULL)
  AND ("privacyNoticeAcceptedVersion" IS NULL) = ("privacyNoticeAcceptedAt" IS NULL)
  AND ("termsAcceptedVersion" IS NULL OR (
    btrim("termsAcceptedVersion") <> '' AND length("termsAcceptedVersion") <= 120
  ))
  AND ("privacyNoticeAcceptedVersion" IS NULL OR (
    btrim("privacyNoticeAcceptedVersion") <> '' AND length("privacyNoticeAcceptedVersion") <= 120
  ))
  AND ("signupPolicySetHash" IS NULL OR "signupPolicySetHash" ~ '^[0-9a-f]{64}$')
  AND (("termsAcceptedVersion" IS NULL) = ("signupPolicySetHash" IS NULL))
  AND (("termsAcceptedVersion" IS NULL) = ("privacyNoticeAcceptedVersion" IS NULL))
  AND ("termsAcceptedAt" IS NULL OR "termsAcceptedAt" = "privacyNoticeAcceptedAt")
);

CREATE FUNCTION "_courtly_protect_user_signup_evidence"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."termsAcceptedVersion", OLD."termsAcceptedAt",
      OLD."privacyNoticeAcceptedVersion", OLD."privacyNoticeAcceptedAt",
      OLD."signupPolicySetHash")
    IS DISTINCT FROM
    ROW(NEW."termsAcceptedVersion", NEW."termsAcceptedAt",
      NEW."privacyNoticeAcceptedVersion", NEW."privacyNoticeAcceptedAt",
      NEW."signupPolicySetHash") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'User signup acceptance evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "User_signup_evidence_immutable"
  BEFORE UPDATE ON "User" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_user_signup_evidence"();

CREATE TABLE "SignupAcceptanceEvidence" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "termsVersion" TEXT NOT NULL,
  "privacyNoticeVersion" TEXT NOT NULL,
  "policySetHash" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SignupAcceptanceEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignupAcceptanceEvidence_shape_check" CHECK (
    btrim("termsVersion") <> '' AND length("termsVersion") <= 120
    AND btrim("privacyNoticeVersion") <> '' AND length("privacyNoticeVersion") <= 120
    AND "policySetHash" ~ '^[0-9a-f]{64}$'
    AND "acceptedAt" <= "createdAt"
  )
);
CREATE UNIQUE INDEX "SignupAcceptanceEvidence_userId_key"
  ON "SignupAcceptanceEvidence"("userId");
ALTER TABLE "SignupAcceptanceEvidence"
  ADD CONSTRAINT "SignupAcceptanceEvidence_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "_courtly_protect_signup_acceptance_evidence"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Signup acceptance evidence is append-only';
END;
$$;
CREATE TRIGGER "SignupAcceptanceEvidence_append_only"
  BEFORE UPDATE ON "SignupAcceptanceEvidence" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_signup_acceptance_evidence"();
CREATE TRIGGER "SignupAcceptanceEvidence_append_only_truncate"
  BEFORE TRUNCATE ON "SignupAcceptanceEvidence" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_protect_signup_acceptance_evidence"();

CREATE FUNCTION "_courtly_reject_signup_acceptance_evidence_delete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A cascaded User deletion is allowed. If the parent remains, this was an
  -- independent attempt to erase legal evidence and must fail.
  IF EXISTS (SELECT 1 FROM "User" WHERE "id" = OLD."userId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Signup acceptance evidence is append-only';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "SignupAcceptanceEvidence_delete_guard"
  AFTER DELETE ON "SignupAcceptanceEvidence" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_signup_acceptance_evidence_delete"();

CREATE TABLE "EmailVerificationClaim" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenKeyId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailVerificationClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailVerificationClaim_shape_check" CHECK (
    "email" <> ''
    AND "email" = lower(btrim("email"))
    AND length("email") <= 254
    AND "tokenHash" ~ '^[0-9a-f]{64}$'
    AND "tokenKeyId" ~ '^[A-Za-z0-9_-]{1,64}$'
    AND "expiresAt" > "createdAt"
    AND NOT ("consumedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    AND ("consumedAt" IS NULL OR "consumedAt" >= "createdAt")
    AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
  )
);

CREATE UNIQUE INDEX "EmailVerificationClaim_tokenHash_key"
  ON "EmailVerificationClaim"("tokenHash");
CREATE INDEX "EmailVerificationClaim_userId_createdAt_idx"
  ON "EmailVerificationClaim"("userId", "createdAt");
CREATE INDEX "EmailVerificationClaim_expiresAt_idx"
  ON "EmailVerificationClaim"("expiresAt");
CREATE UNIQUE INDEX "EmailVerificationClaim_one_live_per_user"
  ON "EmailVerificationClaim"("userId")
  WHERE "consumedAt" IS NULL AND "revokedAt" IS NULL;
ALTER TABLE "EmailVerificationClaim"
  ADD CONSTRAINT "EmailVerificationClaim_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
