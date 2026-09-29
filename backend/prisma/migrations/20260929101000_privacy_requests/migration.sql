BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL,
  "subjectUserId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "details" TEXT NOT NULL DEFAULT '',
  "correctionFields" JSONB,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgementDueAt" TIMESTAMP(3) NOT NULL,
  "responseDueAt" TIMESTAMP(3) NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  "identityVerifiedAt" TIMESTAMP(3),
  "delayNoticeAt" TIMESTAMP(3),
  "delayReason" TEXT,
  "estimatedResponseAt" TIMESTAMP(3),
  "legalHold" BOOLEAN NOT NULL DEFAULT false,
  "legalHoldReason" TEXT,
  "decision" TEXT,
  "decisionReason" TEXT,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivacyRequest_shape_check" CHECK (
    "type" IN ('ACCESS', 'CORRECTION', 'DELETION', 'CONSENT_WITHDRAWAL', 'RESTRICTION', 'OBJECTION')
    AND "status" IN ('RECEIVED', 'IDENTITY_VERIFICATION', 'IN_REVIEW', 'WAITING_FOR_SUBJECT', 'COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED', 'CANCELLED')
    AND length("details") <= 4000
    AND "acknowledgementDueAt" >= "submittedAt"
    AND "responseDueAt" >= "submittedAt"
    AND ("acknowledgedAt" IS NULL OR "acknowledgedAt" >= "submittedAt")
    AND ("identityVerifiedAt" IS NULL OR "identityVerifiedAt" >= "submittedAt")
    AND ("status" NOT IN ('IN_REVIEW', 'COMPLETED', 'PARTIALLY_COMPLETED') OR "identityVerifiedAt" IS NOT NULL)
    AND (("delayNoticeAt" IS NULL AND "delayReason" IS NULL AND "estimatedResponseAt" IS NULL) OR (
      "delayNoticeAt" IS NOT NULL
      AND "delayReason" IS NOT NULL AND btrim("delayReason") <> '' AND length("delayReason") <= 2000
      AND "estimatedResponseAt" IS NOT NULL AND "estimatedResponseAt" > "delayNoticeAt"
    ))
    AND ((NOT "legalHold" AND "legalHoldReason" IS NULL) OR (
      "legalHold" AND "legalHoldReason" IS NOT NULL
      AND btrim("legalHoldReason") <> '' AND length("legalHoldReason") <= 2000
    ))
    AND ("decisionReason" IS NULL OR (btrim("decisionReason") <> '' AND length("decisionReason") <= 4000))
    AND (
      ("status" = 'COMPLETED' AND "decision" = 'FULFILLED'
        AND "decisionReason" IS NOT NULL AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'PARTIALLY_COMPLETED' AND "decision" = 'PARTIALLY_FULFILLED'
        AND "decisionReason" IS NOT NULL AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'REFUSED' AND "decision" = 'REFUSED'
        AND "decisionReason" IS NOT NULL AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL)
      OR ("status" = 'CANCELLED' AND "decision" = 'WITHDRAWN_BY_SUBJECT'
        AND "decisionReason" IS NOT NULL AND "cancelledAt" IS NOT NULL AND "completedAt" IS NULL)
      OR ("status" NOT IN ('COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED', 'CANCELLED')
        AND "decision" IS NULL AND "completedAt" IS NULL AND "cancelledAt" IS NULL)
    )
  )
);

CREATE TABLE "PrivacyRequestEvent" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorNameSnapshot" TEXT NOT NULL,
  "actorEmailSnapshot" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PrivacyRequestEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivacyRequestEvent_shape_check" CHECK (
    "actorKind" IN ('SUBJECT', 'GUARDIAN', 'OPERATOR', 'SYSTEM')
    AND btrim("action") <> '' AND length("action") <= 120
    AND length("actorNameSnapshot") <= 120
    AND length("actorEmailSnapshot") <= 254
    AND length("note") <= 4000
  )
);

CREATE INDEX "PrivacyRequest_subjectUserId_submittedAt_idx"
  ON "PrivacyRequest"("subjectUserId", "submittedAt");
CREATE INDEX "PrivacyRequest_status_responseDueAt_idx"
  ON "PrivacyRequest"("status", "responseDueAt");
CREATE UNIQUE INDEX "PrivacyRequest_one_open_type_per_subject"
  ON "PrivacyRequest"("subjectUserId", "type")
  WHERE "status" NOT IN ('COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED', 'CANCELLED');
CREATE INDEX "PrivacyRequestEvent_requestId_createdAt_idx"
  ON "PrivacyRequestEvent"("requestId", "createdAt");

ALTER TABLE "PrivacyRequest"
  ADD CONSTRAINT "PrivacyRequest_subjectUserId_fkey"
  FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivacyRequestEvent"
  ADD CONSTRAINT "PrivacyRequestEvent_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "PrivacyRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "_courtly_reject_privacy_request_event_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Privacy request event history is append-only';
END;
$$;
CREATE TRIGGER "PrivacyRequestEvent_append_only"
  BEFORE UPDATE OR DELETE ON "PrivacyRequestEvent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_privacy_request_event_mutation"();
CREATE TRIGGER "PrivacyRequestEvent_append_only_truncate"
  BEFORE TRUNCATE ON "PrivacyRequestEvent" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_reject_privacy_request_event_mutation"();

CREATE FUNCTION "_courtly_protect_privacy_request_contract"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."id", OLD."subjectUserId", OLD."type", OLD."details",
      OLD."correctionFields", OLD."submittedAt", OLD."acknowledgementDueAt",
      OLD."responseDueAt")
    IS DISTINCT FROM
    ROW(NEW."id", NEW."subjectUserId", NEW."type", NEW."details",
      NEW."correctionFields", NEW."submittedAt", NEW."acknowledgementDueAt",
      NEW."responseDueAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Privacy request subject, scope, and original response clock are immutable';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED', 'CANCELLED') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Terminal privacy request decisions are immutable';
  END IF;
  IF NOT (
    NEW."status" = OLD."status"
    OR (OLD."status" = 'RECEIVED' AND NEW."status" IN (
      'IDENTITY_VERIFICATION', 'IN_REVIEW', 'CANCELLED'
    ))
    OR (OLD."status" = 'IDENTITY_VERIFICATION' AND NEW."status" IN (
      'IN_REVIEW', 'WAITING_FOR_SUBJECT', 'CANCELLED', 'REFUSED'
    ))
    OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN (
      'WAITING_FOR_SUBJECT', 'COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED', 'CANCELLED'
    ))
    OR (OLD."status" = 'WAITING_FOR_SUBJECT' AND NEW."status" IN (
      'IDENTITY_VERIFICATION', 'IN_REVIEW', 'CANCELLED', 'REFUSED'
    ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Invalid privacy request status transition';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PrivacyRequest_contract_guard"
  BEFORE UPDATE ON "PrivacyRequest" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_privacy_request_contract"();

COMMIT;
