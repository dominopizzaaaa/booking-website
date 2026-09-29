BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Merchant identity is mutable setup data, while checkout acceptance is
-- transaction evidence. Close the write window while the latter is extended
-- and its post-insert immutability guard is installed.
LOCK TABLE "Business", "PaymentIntent" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "Business"
  ADD COLUMN "legalName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "registrationNumber" TEXT,
  ADD COLUMN "supportEmail" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "supportAddress" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "gstRegistrationStatus" TEXT NOT NULL DEFAULT 'NOT_DECLARED',
  ADD COLUMN "gstRegistrationNumber" TEXT,
  ADD COLUMN "pricesIncludeGst" BOOLEAN;

ALTER TABLE "Business" ADD CONSTRAINT "Business_merchant_identity_shape_check" CHECK (
  "legalName" = btrim("legalName")
  AND length("legalName") <= 200
  AND ("registrationNumber" IS NULL OR (
    "registrationNumber" = btrim("registrationNumber")
    AND "registrationNumber" <> ''
    AND length("registrationNumber") <= 120
  ))
  AND "supportEmail" = lower(btrim("supportEmail"))
  AND length("supportEmail") <= 254
  AND ("supportEmail" = ''
    OR "supportEmail" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
  AND "supportAddress" = btrim("supportAddress")
  AND length("supportAddress") <= 1000
  AND "gstRegistrationStatus" IN ('NOT_DECLARED', 'NOT_REGISTERED', 'REGISTERED')
  AND (
    ("gstRegistrationStatus" = 'REGISTERED'
      AND "gstRegistrationNumber" IS NOT NULL
      AND "gstRegistrationNumber" = btrim("gstRegistrationNumber")
      AND "gstRegistrationNumber" <> ''
      AND length("gstRegistrationNumber") <= 120
      AND "pricesIncludeGst" IS NOT NULL)
    OR ("gstRegistrationStatus" <> 'REGISTERED'
      AND "gstRegistrationNumber" IS NULL
      AND "pricesIncludeGst" IS NULL)
  )
);

ALTER TABLE "PaymentIntent"
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "acceptedTermsVersion" TEXT,
  ADD COLUMN "acceptedTermsHash" TEXT,
  ADD COLUMN "acceptedCancellationPolicyVersion" TEXT,
  ADD COLUMN "acceptedCancellationPolicyHash" TEXT,
  ADD COLUMN "acceptedPackageTermsVersion" TEXT,
  ADD COLUMN "acceptedPackageTermsHash" TEXT,
  ADD COLUMN "acceptedReviewHash" TEXT,
  ADD COLUMN "acceptanceSessionFingerprint" TEXT,
  ADD COLUMN "acceptanceRequestFingerprint" TEXT,
  ADD COLUMN "acceptanceEvidenceVersion" INTEGER,
  ADD COLUMN "providerChargeReference" TEXT,
  ADD COLUMN "authenticationEvidence" JSONB;

-- Legacy and rental attempts may have no acceptance bundle. When evidence is
-- present it is complete, digest-shaped, and tied to the retained review in
-- checkoutSnapshot. Package terms apply only to package purchases.
ALTER TABLE "PaymentIntent"
  ADD CONSTRAINT "PaymentIntent_checkout_evidence_shape_check" CHECK (
    ("checkoutSnapshot" IS NULL OR jsonb_typeof("checkoutSnapshot") = 'object')
    AND ("providerChargeReference" IS NULL OR (
      "provider" = 'STRIPE'
      AND btrim(COALESCE("providerReference", '')) <> ''
      AND "providerChargeReference" = btrim("providerChargeReference")
      AND "providerChargeReference" <> ''
      AND length("providerChargeReference") <= 255
    ))
    AND ("authenticationEvidence" IS NULL OR (
      "provider" = 'STRIPE'
      AND jsonb_typeof("authenticationEvidence") = 'object'
      AND octet_length("authenticationEvidence"::TEXT) <= 16384
    ))
    AND (
      num_nonnulls(
        "acceptedAt",
        "acceptedTermsVersion", "acceptedTermsHash",
        "acceptedCancellationPolicyVersion", "acceptedCancellationPolicyHash",
        "acceptedPackageTermsVersion", "acceptedPackageTermsHash",
        "acceptedReviewHash",
        "acceptanceSessionFingerprint", "acceptanceRequestFingerprint",
        "acceptanceEvidenceVersion"
      ) = 0
      OR (
        num_nonnulls(
          "acceptedAt",
          "acceptedTermsVersion", "acceptedTermsHash",
          "acceptedCancellationPolicyVersion", "acceptedCancellationPolicyHash",
          "acceptedReviewHash",
          "acceptanceSessionFingerprint", "acceptanceRequestFingerprint",
          "acceptanceEvidenceVersion"
        ) = 9
        AND "acceptedTermsVersion" = btrim("acceptedTermsVersion")
        AND "acceptedTermsVersion" <> ''
        AND length("acceptedTermsVersion") <= 120
        AND "acceptedTermsHash" ~ '^[a-f0-9]{64}$'
        AND "acceptedCancellationPolicyVersion" = btrim("acceptedCancellationPolicyVersion")
        AND "acceptedCancellationPolicyVersion" <> ''
        AND length("acceptedCancellationPolicyVersion") <= 120
        AND "acceptedCancellationPolicyHash" ~ '^[a-f0-9]{64}$'
        AND "acceptedReviewHash" ~ '^[a-f0-9]{64}$'
        AND "acceptanceSessionFingerprint" ~ '^[a-f0-9]{64}$'
        AND "acceptanceRequestFingerprint" ~ '^[a-f0-9]{64}$'
        AND "acceptanceEvidenceVersion" > 0
        AND (
          ("kind" = 'PACKAGE'
            AND "acceptedPackageTermsVersion" IS NOT NULL
            AND "acceptedPackageTermsVersion" = btrim("acceptedPackageTermsVersion")
            AND "acceptedPackageTermsVersion" <> ''
            AND length("acceptedPackageTermsVersion") <= 120
            AND "acceptedPackageTermsHash" ~ '^[a-f0-9]{64}$')
          OR ("kind" <> 'PACKAGE'
            AND "acceptedPackageTermsVersion" IS NULL
            AND "acceptedPackageTermsHash" IS NULL)
        )
        AND COALESCE(jsonb_typeof("checkoutSnapshot") = 'object', false)
        AND COALESCE(jsonb_typeof("checkoutSnapshot" -> 'review') = 'object', false)
        AND COALESCE("checkoutSnapshot" #>> '{review,reviewHash}' = "acceptedReviewHash", false)
      )
    )
  );

-- A provider charge identifies one local checkout within its connected
-- account. PostgreSQL's ordinary nullable uniqueness leaves legacy rows alone.
CREATE UNIQUE INDEX "PaymentIntent_provider_providerAccountReference_providerCha_key"
  ON "PaymentIntent"("provider", "providerAccountReference", "providerChargeReference");

-- Contract and acceptance evidence is write-once even while status, provider
-- references, authentication results, failures, and reconciliation timestamps
-- continue to follow the payment provider lifecycle.
CREATE FUNCTION "_courtly_protect_payment_intent_checkout_evidence"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
      OLD."checkoutSnapshot", OLD."acceptedAt",
      OLD."acceptedTermsVersion", OLD."acceptedTermsHash",
      OLD."acceptedCancellationPolicyVersion", OLD."acceptedCancellationPolicyHash",
      OLD."acceptedPackageTermsVersion", OLD."acceptedPackageTermsHash",
      OLD."acceptedReviewHash", OLD."acceptanceSessionFingerprint",
      OLD."acceptanceRequestFingerprint", OLD."acceptanceEvidenceVersion"
    ) IS DISTINCT FROM ROW(
      NEW."checkoutSnapshot", NEW."acceptedAt",
      NEW."acceptedTermsVersion", NEW."acceptedTermsHash",
      NEW."acceptedCancellationPolicyVersion", NEW."acceptedCancellationPolicyHash",
      NEW."acceptedPackageTermsVersion", NEW."acceptedPackageTermsHash",
      NEW."acceptedReviewHash", NEW."acceptanceSessionFingerprint",
      NEW."acceptanceRequestFingerprint", NEW."acceptanceEvidenceVersion"
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payment intent checkout snapshot and acceptance evidence are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentIntent_checkout_evidence_immutability"
  BEFORE UPDATE OF
    "checkoutSnapshot", "acceptedAt",
    "acceptedTermsVersion", "acceptedTermsHash",
    "acceptedCancellationPolicyVersion", "acceptedCancellationPolicyHash",
    "acceptedPackageTermsVersion", "acceptedPackageTermsHash",
    "acceptedReviewHash", "acceptanceSessionFingerprint",
    "acceptanceRequestFingerprint", "acceptanceEvidenceVersion"
  ON "PaymentIntent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_payment_intent_checkout_evidence"();

CREATE TABLE "PaymentRiskCase" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "paymentIntentId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'STRIPE',
  "providerAccountReference" TEXT NOT NULL,
  "providerCaseId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT NOT NULL DEFAULT '',
  "amount" INTEGER,
  "currency" TEXT,
  "responseDueAt" TIMESTAMP(3),
  "ownerUserId" TEXT,
  "providerCreatedAt" TIMESTAMP(3),
  "lastProviderEventAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentRiskCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentRiskCase_shape_check" CHECK (
    "provider" = 'STRIPE'
    AND "providerAccountReference" = btrim("providerAccountReference")
    AND "providerAccountReference" <> ''
    AND length("providerAccountReference") <= 255
    AND "providerCaseId" = btrim("providerCaseId")
    AND "providerCaseId" <> ''
    AND length("providerCaseId") <= 255
    AND "kind" IN ('DISPUTE', 'INQUIRY', 'EARLY_FRAUD_WARNING')
    AND "status" IN (
      'NEEDS_RESPONSE', 'UNDER_REVIEW', 'WON', 'LOST', 'PREVENTED',
      'WARNING_NEEDS_RESPONSE', 'WARNING_UNDER_REVIEW', 'WARNING_CLOSED',
      'ACTIONABLE', 'NOT_ACTIONABLE'
    )
    AND (("kind" = 'DISPUTE' AND "status" IN (
      'NEEDS_RESPONSE', 'UNDER_REVIEW', 'WON', 'LOST', 'PREVENTED'
    )) OR ("kind" = 'INQUIRY' AND "status" IN (
      'WARNING_NEEDS_RESPONSE', 'WARNING_UNDER_REVIEW', 'WARNING_CLOSED'
    )) OR ("kind" = 'EARLY_FRAUD_WARNING' AND "status" IN (
      'ACTIONABLE', 'NOT_ACTIONABLE'
    )))
    AND length("reason") <= 1000
    AND (("amount" IS NULL AND "currency" IS NULL) OR (
      "amount" IS NOT NULL AND "amount" >= 0
      AND "currency" ~ '^[A-Z]{3}$'
    ))
    AND ("providerCreatedAt" IS NULL OR "lastProviderEventAt" >= "providerCreatedAt")
    AND ("responseDueAt" IS NULL OR "providerCreatedAt" IS NULL
      OR "responseDueAt" >= "providerCreatedAt")
    AND ("resolvedAt" IS NULL OR (
      "providerCreatedAt" IS NULL OR "resolvedAt" >= "providerCreatedAt"
    ))
  )
);

CREATE INDEX "PaymentRiskCase_businessId_status_responseDueAt_idx"
  ON "PaymentRiskCase"("businessId", "status", "responseDueAt");
CREATE INDEX "PaymentRiskCase_paymentIntentId_idx"
  ON "PaymentRiskCase"("paymentIntentId");
CREATE INDEX "PaymentRiskCase_ownerUserId_status_idx"
  ON "PaymentRiskCase"("ownerUserId", "status");
CREATE UNIQUE INDEX "PaymentRiskCase_provider_providerAccountReference_providerC_key"
  ON "PaymentRiskCase"("provider", "providerAccountReference", "providerCaseId");

ALTER TABLE "PaymentRiskCase"
  ADD CONSTRAINT "PaymentRiskCase_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentRiskCase"
  ADD CONSTRAINT "PaymentRiskCase_paymentIntentId_businessId_fkey"
  FOREIGN KEY ("paymentIntentId", "businessId")
  REFERENCES "PaymentIntent"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "PaymentRiskCase"
  ADD CONSTRAINT "PaymentRiskCase_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
