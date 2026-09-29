BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Safeguarding is independently grantable to named club staff. Keep the
-- database allow-list aligned with the application permission vocabulary so
-- malformed grants still fail closed at the storage boundary.
CREATE OR REPLACE FUNCTION "_courtly_staff_permissions_valid"(value TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(value) > 0
    AND value <@ ARRAY[
      'BOOKINGS_VIEW','BOOKINGS_MANAGE','STUDENTS_VIEW','STUDENTS_MANAGE',
      'CATALOG_VIEW','CATALOG_MANAGE','AVAILABILITY_MANAGE','ROSTER_VIEW',
      'ROSTER_MANAGE','PACKAGES_VIEW','PACKAGES_MANAGE','PAYMENTS_VIEW',
      'PAYMENTS_RECORD','PAYMENTS_REVERSE','PAYOUTS_RECORD','INTEGRITY_VIEW',
      'INTEGRITY_REVIEW','RENTALS_VIEW','RENTALS_MANAGE','SETTINGS_MANAGE',
      'STAFF_MANAGE','AUDIT_VIEW','SAFEGUARDING_VIEW','SAFEGUARDING_REVIEW'
    ]::TEXT[]
    AND cardinality(value) = (SELECT count(DISTINCT permission)::INTEGER FROM unnest(value) AS permission)
$$;

ALTER TABLE "User"
  ADD COLUMN "safetyStatus" TEXT NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "User"
  ADD CONSTRAINT "User_safety_status_check" CHECK (
    "safetyStatus" IN ('ACTIVE', 'ACCOUNT_CHAT_RESTRICTED')
  );

CREATE TABLE "ChatAccountBlock" (
  "blockerUserId" TEXT NOT NULL,
  "blockedUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChatAccountBlock_pkey" PRIMARY KEY ("blockerUserId", "blockedUserId"),
  CONSTRAINT "ChatAccountBlock_no_self_check" CHECK ("blockerUserId" <> "blockedUserId")
);

CREATE INDEX "ChatAccountBlock_blockedUserId_idx"
  ON "ChatAccountBlock"("blockedUserId");

CREATE TABLE "ChatSafetyReport" (
  "id" TEXT NOT NULL,
  "threadId" TEXT,
  "messageId" TEXT,
  "businessId" TEXT,
  "bookingId" TEXT,
  "reporterUserId" TEXT,
  "subjectUserId" TEXT,
  "category" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "severity" TEXT NOT NULL,
  "childInvolved" BOOLEAN NOT NULL DEFAULT false,
  "description" TEXT NOT NULL DEFAULT '',
  "evidence" JSONB NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "assignedClubUserId" TEXT,
  "assignedTo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChatSafetyReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatSafetyReport_shape_check" CHECK (
    "category" IN (
      'GROOMING_SEXUAL', 'HARASSMENT',
      'SELF_HARM_IMMEDIATE_DANGER', 'SPAM_OTHER'
    )
    AND "status" IN (
      'OPEN', 'IN_REVIEW', 'REFERRED_TO_PLATFORM',
      'ACTION_TAKEN', 'CLOSED_NO_ACTION'
    )
    AND "severity" IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')
    AND length("description") <= 4000
    AND jsonb_typeof("evidence") = 'object'
    AND "evidenceHash" ~ '^[0-9a-f]{64}$'
    AND ("assignedTo" IS NULL OR (
      btrim("assignedTo") <> '' AND length("assignedTo") <= 120
    ))
    AND ("assignedClubUserId" IS NULL OR (
      "businessId" IS NOT NULL
      AND "assignedTo" IS NOT NULL
      AND btrim("assignedTo") <> ''
    ))
  )
);

CREATE INDEX "ChatSafetyReport_status_severity_createdAt_idx"
  ON "ChatSafetyReport"("status", "severity", "createdAt");
CREATE INDEX "ChatSafetyReport_businessId_status_createdAt_idx"
  ON "ChatSafetyReport"("businessId", "status", "createdAt");
CREATE INDEX "ChatSafetyReport_reporterUserId_createdAt_idx"
  ON "ChatSafetyReport"("reporterUserId", "createdAt");
CREATE INDEX "ChatSafetyReport_subjectUserId_createdAt_idx"
  ON "ChatSafetyReport"("subjectUserId", "createdAt");
CREATE INDEX "ChatSafetyReport_threadId_createdAt_idx"
  ON "ChatSafetyReport"("threadId", "createdAt");
CREATE INDEX "ChatSafetyReport_messageId_idx"
  ON "ChatSafetyReport"("messageId");
CREATE INDEX "ChatSafetyReport_bookingId_idx"
  ON "ChatSafetyReport"("bookingId");
CREATE INDEX "ChatSafetyReport_assignee_status_createdAt_idx"
  ON "ChatSafetyReport"("businessId", "assignedClubUserId", "status", "createdAt");

CREATE TABLE "ChatSafetyAuditEvent" (
  "id" TEXT NOT NULL,
  "reportId" TEXT NOT NULL,
  "actorKind" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorName" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "note" TEXT,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "fromSeverity" TEXT,
  "toSeverity" TEXT,
  "assignedTo" TEXT,
  "assignedClubUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChatSafetyAuditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatSafetyAuditEvent_shape_check" CHECK (
    "actorKind" = upper(btrim("actorKind"))
    AND "actorKind" <> '' AND length("actorKind") <= 80
    AND btrim("actorName") <> '' AND length("actorName") <= 120
    AND "action" = upper(btrim("action"))
    AND "action" <> '' AND length("action") <= 120
    AND ("note" IS NULL OR length("note") <= 2000)
    AND ("fromStatus" IS NULL OR "fromStatus" IN (
      'OPEN', 'IN_REVIEW', 'REFERRED_TO_PLATFORM',
      'ACTION_TAKEN', 'CLOSED_NO_ACTION'
    ))
    AND ("toStatus" IS NULL OR "toStatus" IN (
      'OPEN', 'IN_REVIEW', 'REFERRED_TO_PLATFORM',
      'ACTION_TAKEN', 'CLOSED_NO_ACTION'
    ))
    AND ("fromSeverity" IS NULL OR "fromSeverity" IN (
      'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'
    ))
    AND ("toSeverity" IS NULL OR "toSeverity" IN (
      'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'
    ))
    AND ("assignedTo" IS NULL OR length("assignedTo") <= 120)
    AND ("assignedClubUserId" IS NULL OR (
      btrim("assignedClubUserId") <> '' AND length("assignedClubUserId") <= 200
    ))
  )
);

CREATE INDEX "ChatSafetyAuditEvent_reportId_createdAt_idx"
  ON "ChatSafetyAuditEvent"("reportId", "createdAt");
CREATE INDEX "ChatSafetyAuditEvent_actorUserId_createdAt_idx"
  ON "ChatSafetyAuditEvent"("actorUserId", "createdAt");

ALTER TABLE "ChatAccountBlock"
  ADD CONSTRAINT "ChatAccountBlock_blockerUserId_fkey"
  FOREIGN KEY ("blockerUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatAccountBlock"
  ADD CONSTRAINT "ChatAccountBlock_blockedUserId_fkey"
  FOREIGN KEY ("blockedUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatSafetyReport"
  ADD CONSTRAINT "ChatSafetyReport_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatSafetyReport"
  ADD CONSTRAINT "ChatSafetyReport_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatSafetyReport"
  ADD CONSTRAINT "ChatSafetyReport_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatSafetyReport"
  ADD CONSTRAINT "ChatSafetyReport_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatSafetyReport"
  ADD CONSTRAINT "ChatSafetyReport_reporterUserId_fkey"
  FOREIGN KEY ("reporterUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatSafetyReport"
  ADD CONSTRAINT "ChatSafetyReport_subjectUserId_fkey"
  FOREIGN KEY ("subjectUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatSafetyReport"
  ADD CONSTRAINT "ChatSafetyReport_assignedClubUserId_fkey"
  FOREIGN KEY ("assignedClubUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChatSafetyAuditEvent"
  ADD CONSTRAINT "ChatSafetyAuditEvent_reportId_fkey"
  FOREIGN KEY ("reportId") REFERENCES "ChatSafetyReport"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatSafetyAuditEvent"
  ADD CONSTRAINT "ChatSafetyAuditEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- A club-side assignee is an authorization identity, not the operator-facing
-- assignedTo snapshot. Lock the authority rows while accepting an assignment
-- so a concurrent membership/grant or business update cannot race the check.
-- SAFEGUARDING_REVIEW is checked directly because no current club permission
-- implies it; keep this predicate aligned if that implication graph expands.
CREATE FUNCTION "_courtly_validate_chat_safety_assignee"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."assignedClubUserId" IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "Business" AS business
  JOIN "Membership" AS membership
    ON membership."businessId" = business."id"
  JOIN "User" AS account
    ON account."id" = membership."userId"
  WHERE business."id" = NEW."businessId"
    AND business."kind" = 'CLUB'
    AND business."legacyReadOnly" = false
    AND account."id" = NEW."assignedClubUserId"
    AND account."accountType" = 'CLUB'
    AND membership."active"
    AND membership."instructorId" IS NULL
  FOR SHARE OF business, membership, account;
  IF FOUND THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM "Business" AS business
  JOIN "ClubStaffAccess" AS access
    ON access."businessId" = business."id"
  JOIN "User" AS account
    ON account."id" = access."userId"
  WHERE business."id" = NEW."businessId"
    AND business."kind" = 'CLUB'
    AND business."legacyReadOnly" = false
    AND account."id" = NEW."assignedClubUserId"
    AND access."active"
    AND access."revokedAt" IS NULL
    AND 'SAFEGUARDING_REVIEW' = ANY(access."permissions")
  FOR SHARE OF business, access, account;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Chat safety report club assignee must have active safeguarding review authority';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION "_courtly_protect_chat_safety_report"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Chat safety reports are retained records';
  END IF;

  -- A deleted business is retained only as the intake snapshot. Its SET NULL
  -- action must also release the live club assignee identity while preserving
  -- assignedTo as the operator-facing historical display snapshot.
  IF OLD."businessId" IS NOT NULL AND NEW."businessId" IS NULL THEN
    NEW."assignedClubUserId" := NULL;
  END IF;

  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."category" IS DISTINCT FROM NEW."category"
    OR OLD."childInvolved" IS DISTINCT FROM NEW."childInvolved"
    OR OLD."description" IS DISTINCT FROM NEW."description"
    OR OLD."evidence" IS DISTINCT FROM NEW."evidence"
    OR OLD."evidenceHash" IS DISTINCT FROM NEW."evidenceHash"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR (OLD."threadId" IS DISTINCT FROM NEW."threadId"
      AND NOT (OLD."threadId" IS NOT NULL AND NEW."threadId" IS NULL))
    OR (OLD."messageId" IS DISTINCT FROM NEW."messageId"
      AND NOT (OLD."messageId" IS NOT NULL AND NEW."messageId" IS NULL))
    OR (OLD."businessId" IS DISTINCT FROM NEW."businessId"
      AND NOT (OLD."businessId" IS NOT NULL AND NEW."businessId" IS NULL))
    OR (OLD."bookingId" IS DISTINCT FROM NEW."bookingId"
      AND NOT (OLD."bookingId" IS NOT NULL AND NEW."bookingId" IS NULL))
    OR (OLD."reporterUserId" IS DISTINCT FROM NEW."reporterUserId"
      AND NOT (OLD."reporterUserId" IS NOT NULL AND NEW."reporterUserId" IS NULL))
    OR (OLD."subjectUserId" IS DISTINCT FROM NEW."subjectUserId"
      AND NOT (OLD."subjectUserId" IS NOT NULL AND NEW."subjectUserId" IS NULL)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Chat safety report intake evidence is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatSafetyReport_contract_guard"
  BEFORE UPDATE OR DELETE ON "ChatSafetyReport" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_chat_safety_report"();
-- PostgreSQL runs same-kind triggers alphabetically, so the contract guard
-- performs the retained-business cleanup before this validation trigger.
CREATE TRIGGER "ChatSafetyReport_validate_assignee"
  BEFORE INSERT OR UPDATE OF "assignedClubUserId", "businessId"
  ON "ChatSafetyReport" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_validate_chat_safety_assignee"();
CREATE TRIGGER "ChatSafetyReport_retained_truncate"
  BEFORE TRUNCATE ON "ChatSafetyReport" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_protect_chat_safety_report"();

CREATE FUNCTION "_courtly_require_chat_safety_decision_audit"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_report "ChatSafetyReport"%ROWTYPE;
BEGIN
  -- Referential SET NULL after business deletion is mechanical cleanup, not a
  -- reviewer decision. Every other mutable decision must be explicitly marked
  -- by application code and have a matching immutable event by commit time.
  IF OLD."businessId" IS NOT NULL AND NEW."businessId" IS NULL
    AND NEW."assignedClubUserId" IS NULL
    AND OLD."status" IS NOT DISTINCT FROM NEW."status"
    AND OLD."severity" IS NOT DISTINCT FROM NEW."severity"
    AND OLD."assignedTo" IS NOT DISTINCT FROM NEW."assignedTo" THEN
    RETURN NULL;
  END IF;

  SELECT * INTO current_report FROM "ChatSafetyReport" WHERE "id" = NEW."id";
  IF NEW."id" <> ALL(string_to_array(
      current_setting('courtly.safeguarding_audited_reports', true), ','
    )) OR NOT EXISTS (
      SELECT 1 FROM "ChatSafetyAuditEvent" AS event
      WHERE event."reportId" = NEW."id"
        AND event."toStatus" IS NOT DISTINCT FROM current_report."status"
        AND event."toSeverity" IS NOT DISTINCT FROM current_report."severity"
        AND event."assignedTo" IS NOT DISTINCT FROM current_report."assignedTo"
        AND event."assignedClubUserId" IS NOT DISTINCT FROM current_report."assignedClubUserId"
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Chat safety report decision changes require a same-transaction audit event';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ChatSafetyReport_decision_audit_guard"
  AFTER UPDATE OF "status", "severity", "assignedClubUserId", "assignedTo"
  ON "ChatSafetyReport" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_require_chat_safety_decision_audit"();

CREATE FUNCTION "_courtly_protect_chat_safety_audit_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."actorUserId" IS NOT NULL
    AND NEW."actorUserId" IS NULL
    AND ROW(OLD."id", OLD."reportId", OLD."actorKind", OLD."actorName",
      OLD."action", OLD."note", OLD."fromStatus", OLD."toStatus",
      OLD."fromSeverity", OLD."toSeverity", OLD."assignedTo", OLD."assignedClubUserId", OLD."createdAt")
      IS NOT DISTINCT FROM
      ROW(NEW."id", NEW."reportId", NEW."actorKind", NEW."actorName",
      NEW."action", NEW."note", NEW."fromStatus", NEW."toStatus",
      NEW."fromSeverity", NEW."toSeverity", NEW."assignedTo", NEW."assignedClubUserId", NEW."createdAt") THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Chat safety audit history is append-only';
END;
$$;

CREATE TRIGGER "ChatSafetyAuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ChatSafetyAuditEvent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_chat_safety_audit_event"();
CREATE TRIGGER "ChatSafetyAuditEvent_append_only_truncate"
  BEFORE TRUNCATE ON "ChatSafetyAuditEvent" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_protect_chat_safety_audit_event"();

COMMIT;
