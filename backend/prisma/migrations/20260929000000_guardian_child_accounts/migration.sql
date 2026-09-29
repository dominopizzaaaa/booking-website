BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Identity and family authority change together. Blocking concurrent writes
-- makes the legacy backfill and the cross-account validation atomic.
LOCK TABLE "User", "Student" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "User"
  ADD COLUMN "legalName" TEXT,
  ADD COLUMN "dateOfBirth" DATE,
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "accountControl" TEXT NOT NULL DEFAULT 'SELF',
  ADD COLUMN "accountStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "profileVisibility" TEXT NOT NULL DEFAULT 'PUBLIC';

-- Existing accounts remain self-controlled, active, and publicly discoverable.
UPDATE "User"
SET "legalName" = "name"
WHERE "legalName" IS NULL;

-- Keep inserts from the previous application release valid while replicas
-- roll. The trigger copies the legacy required name only when legalName is
-- omitted; explicit blank legal names still fail the check below.
CREATE FUNCTION "_courtly_default_user_legal_name"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."legalName" IS NULL THEN NEW."legalName" := NEW."name"; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "User_legalName_compatibility_default"
  BEFORE INSERT ON "User" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_default_user_legal_name"();

-- User already has several deferred graph checks. Flush the backfill before
-- altering it again; PostgreSQL rejects DDL with pending trigger events.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

ALTER TABLE "User" ALTER COLUMN "legalName" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "Student" ALTER COLUMN "email" DROP NOT NULL;

-- Nullable emails are intentional for guardian-managed children; present
-- addresses retain the existing canonical lowercase representation.
ALTER TABLE "User" DROP CONSTRAINT "User_email_canonical_check";
ALTER TABLE "User" ADD CONSTRAINT "User_email_canonical_check" CHECK (
  "email" IS NULL OR ("email" <> '' AND "email" = lower(btrim("email")))
);
ALTER TABLE "Student" DROP CONSTRAINT "Student_email_canonical_check";
ALTER TABLE "Student" ADD CONSTRAINT "Student_email_canonical_check" CHECK (
  "email" IS NULL OR ("email" <> '' AND "email" = lower(btrim("email")))
);

ALTER TABLE "User" ADD CONSTRAINT "User_legal_name_check"
  CHECK (btrim("legalName") <> '' AND length("legalName") <= 120);
ALTER TABLE "User" ADD CONSTRAINT "User_date_of_birth_check"
  CHECK ("dateOfBirth" IS NULL OR (
    "dateOfBirth" >= DATE '1900-01-01'
    AND "dateOfBirth" <= (("createdAt" AT TIME ZONE 'UTC')
      AT TIME ZONE 'Asia/Singapore')::date
  ));
ALTER TABLE "User" ADD CONSTRAINT "User_account_control_check"
  CHECK ("accountControl" IN ('SELF', 'GUARDIAN_MANAGED'));
ALTER TABLE "User" ADD CONSTRAINT "User_account_status_check"
  CHECK ("accountStatus" IN ('ACTIVE', 'CONSENT_REQUIRED', 'DELETION_REQUESTED'));
ALTER TABLE "User" ADD CONSTRAINT "User_profile_visibility_check"
  CHECK ("profileVisibility" IN ('PRIVATE', 'CLUBS_ONLY', 'PUBLIC'));
ALTER TABLE "User" ADD CONSTRAINT "User_email_verification_shape_check" CHECK (
  "emailVerifiedAt" IS NULL OR "email" IS NOT NULL
);
ALTER TABLE "User" ADD CONSTRAINT "User_guardian_managed_shape_check" CHECK (
  "accountControl" <> 'GUARDIAN_MANAGED' OR (
    "accountType" = 'STUDENT'
    AND "dateOfBirth" IS NOT NULL
    AND "email" IS NULL
    AND "emailVerifiedAt" IS NULL
    AND "passwordHash" IS NULL
    AND btrim("phone") = ''
    AND "profileVisibility" IN ('PRIVATE', 'CLUBS_ONLY')
  )
);
ALTER TABLE "User" ADD CONSTRAINT "User_self_control_shape_check" CHECK (
  "accountControl" <> 'SELF'
  OR "email" IS NOT NULL
);

CREATE TABLE "GuardianChildLink" (
  "id" TEXT NOT NULL,
  "guardianUserId" TEXT NOT NULL,
  "childUserId" TEXT NOT NULL,
  "relationshipType" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[
    'PROFILE_MANAGE', 'BOOKINGS_MANAGE', 'CREDENTIAL_RESET', 'PRIVACY_MANAGE',
    'DATA_EXPORT', 'CONSENT_MANAGE', 'DELETION_REQUEST', 'HANDOVER_MANAGE'
  ]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "withdrawnAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GuardianChildLink_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChildConsentRecord" (
  "id" TEXT NOT NULL,
  "linkId" TEXT NOT NULL,
  "guardianUserId" TEXT NOT NULL,
  "childUserId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "eventType" TEXT NOT NULL,
  "relationshipType" TEXT NOT NULL,
  "privacyPolicyVersion" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChildConsentRecord_pkey" PRIMARY KEY ("id")
);
CREATE SEQUENCE "ChildConsentRecord_sequence_seq" AS INTEGER;
ALTER SEQUENCE "ChildConsentRecord_sequence_seq"
  OWNED BY "ChildConsentRecord"."sequence";

CREATE TABLE "ChildAccountHandover" (
  "id" TEXT NOT NULL,
  "childUserId" TEXT NOT NULL,
  "initiatedByGuardianUserId" TEXT NOT NULL,
  "destinationEmail" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),

  CONSTRAINT "ChildAccountHandover_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GuardianChildLink_guardianUserId_childUserId_key"
  ON "GuardianChildLink"("guardianUserId", "childUserId");
CREATE UNIQUE INDEX "GuardianChildLink_identity_key"
  ON "GuardianChildLink"("id", "guardianUserId", "childUserId");
CREATE INDEX "GuardianChildLink_guardianUserId_status_idx"
  ON "GuardianChildLink"("guardianUserId", "status");
CREATE INDEX "GuardianChildLink_childUserId_status_idx"
  ON "GuardianChildLink"("childUserId", "status");

CREATE INDEX "ChildConsentRecord_childUserId_createdAt_idx"
  ON "ChildConsentRecord"("childUserId", "createdAt");
CREATE INDEX "ChildConsentRecord_guardianUserId_createdAt_idx"
  ON "ChildConsentRecord"("guardianUserId", "createdAt");
CREATE INDEX "ChildConsentRecord_linkId_createdAt_idx"
  ON "ChildConsentRecord"("linkId", "createdAt");
CREATE UNIQUE INDEX "ChildConsentRecord_linkId_sequence_key"
  ON "ChildConsentRecord"("linkId", "sequence");

CREATE UNIQUE INDEX "ChildAccountHandover_tokenHash_key"
  ON "ChildAccountHandover"("tokenHash");
CREATE UNIQUE INDEX "ChildAccountHandover_one_pending_per_child"
  ON "ChildAccountHandover"("childUserId") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "ChildAccountHandover_one_pending_per_destination"
  ON "ChildAccountHandover"("destinationEmail") WHERE "status" = 'PENDING';
CREATE INDEX "ChildAccountHandover_childUserId_status_idx"
  ON "ChildAccountHandover"("childUserId", "status");
CREATE INDEX "ChildHandover_initiator_initiatedAt_idx"
  ON "ChildAccountHandover"("initiatedByGuardianUserId", "initiatedAt");
CREATE INDEX "ChildAccountHandover_destinationEmail_status_idx"
  ON "ChildAccountHandover"("destinationEmail", "status");

CREATE FUNCTION "_courtly_family_permissions_valid"(value TEXT[], allow_empty BOOLEAN)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (allow_empty OR cardinality(value) > 0)
    AND value <@ ARRAY[
      'PROFILE_MANAGE', 'BOOKINGS_MANAGE', 'CREDENTIAL_RESET', 'PRIVACY_MANAGE',
      'DATA_EXPORT', 'CONSENT_MANAGE', 'DELETION_REQUEST', 'HANDOVER_MANAGE'
    ]::TEXT[]
    AND cardinality(value) = (
      SELECT count(DISTINCT permission)::INTEGER FROM unnest(value) AS permission
    )
$$;

ALTER TABLE "GuardianChildLink" ADD CONSTRAINT "GuardianChildLink_shape_check" CHECK (
  "guardianUserId" <> "childUserId"
  AND "relationshipType" = upper(btrim("relationshipType"))
  AND "relationshipType" <> ''
  AND length("relationshipType") <= 80
  AND "status" IN ('ACTIVE', 'WITHDRAWN', 'ENDED')
  AND "_courtly_family_permissions_valid"("permissions", false)
  AND "activatedAt" >= "createdAt"
  AND (
    ("status" = 'ACTIVE' AND "withdrawnAt" IS NULL AND "endedAt" IS NULL)
    OR ("status" = 'WITHDRAWN' AND "withdrawnAt" >= "activatedAt" AND "endedAt" IS NULL)
    OR ("status" = 'ENDED' AND "endedAt" >= "activatedAt"
      AND ("withdrawnAt" IS NULL OR "withdrawnAt" >= "activatedAt"))
  )
);
ALTER TABLE "ChildConsentRecord" ADD CONSTRAINT "ChildConsentRecord_shape_check" CHECK (
  "guardianUserId" <> "childUserId"
  AND "sequence" > 0
  AND "eventType" IN (
    'GRANTED', 'RENEWED', 'WITHDRAWN', 'HANDOVER_STARTED',
    'HANDOVER_CANCELLED', 'HANDOVER_COMPLETED', 'DELETION_REQUESTED'
  )
  AND "relationshipType" = upper(btrim("relationshipType"))
  AND "relationshipType" <> ''
  AND length("relationshipType") <= 80
  AND btrim("privacyPolicyVersion") <> ''
  AND length("privacyPolicyVersion") <= 120
  AND "_courtly_family_permissions_valid"("permissions", true)
);
ALTER TABLE "ChildAccountHandover" ADD CONSTRAINT "ChildAccountHandover_shape_check" CHECK (
  "childUserId" <> "initiatedByGuardianUserId"
  AND "destinationEmail" <> ''
  AND "destinationEmail" = lower(btrim("destinationEmail"))
  AND length("destinationEmail") <= 254
  AND "tokenHash" ~ '^[a-f0-9]{64}$'
  AND "status" IN ('PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED')
  AND "expiresAt" > "initiatedAt"
  AND "lastSentAt" BETWEEN "initiatedAt" AND "expiresAt"
  AND (
    ("status" = 'PENDING' AND "completedAt" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'COMPLETED' AND "completedAt" BETWEEN "initiatedAt" AND "expiresAt"
      AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "completedAt" IS NULL AND "cancelledAt" >= "initiatedAt")
    OR ("status" = 'EXPIRED' AND "completedAt" IS NULL AND "cancelledAt" IS NULL)
  )
);

ALTER TABLE "GuardianChildLink" ADD CONSTRAINT "GuardianChildLink_guardianUserId_fkey"
  FOREIGN KEY ("guardianUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GuardianChildLink" ADD CONSTRAINT "GuardianChildLink_childUserId_fkey"
  FOREIGN KEY ("childUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChildConsentRecord" ADD CONSTRAINT "ChildConsentRecord_linkId_guardianUserId_childUserId_fkey"
  FOREIGN KEY ("linkId", "guardianUserId", "childUserId")
  REFERENCES "GuardianChildLink"("id", "guardianUserId", "childUserId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ChildConsentRecord" ADD CONSTRAINT "ChildConsentRecord_guardianUserId_fkey"
  FOREIGN KEY ("guardianUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChildConsentRecord" ADD CONSTRAINT "ChildConsentRecord_childUserId_fkey"
  FOREIGN KEY ("childUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChildAccountHandover" ADD CONSTRAINT "ChildAccountHandover_childUserId_fkey"
  FOREIGN KEY ("childUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChildAccountHandover" ADD CONSTRAINT "ChildAccountHandover_initiatedByGuardianUserId_fkey"
  FOREIGN KEY ("initiatedByGuardianUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "_courtly_user_date_of_birth_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."dateOfBirth" IS NOT NULL
    AND OLD."dateOfBirth" IS DISTINCT FROM NEW."dateOfBirth" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'User.dateOfBirth cannot change after it has been set';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "User_dateOfBirth_immutable"
  BEFORE UPDATE OF "dateOfBirth" ON "User" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_user_date_of_birth_immutable"();

-- Consent state cannot use transaction timestamps as an ordering primitive:
-- CURRENT_TIMESTAMP is fixed when a transaction starts, so a transaction that
-- waits and commits later can otherwise appear older. A statement-level lock
-- serializes every writer (including raw SQL and older clients), after which a
-- database sequence provides the order. Family writes already hold their
-- shared child lock before INSERT, so their sequence is assigned after it. The
-- trigger deliberately replaces any caller-provided value.
CREATE FUNCTION "_courtly_assign_child_consent_sequence"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('session_replication_role') = 'replica' THEN
    RETURN NEW;
  END IF;
  NEW."sequence" := nextval('"ChildConsentRecord_sequence_seq"');
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChildConsentRecord_sequence_assign"
  BEFORE INSERT ON "ChildConsentRecord" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_assign_child_consent_sequence"();

CREATE FUNCTION "_courtly_reject_child_consent_record_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Child consent records are append-only';
  RETURN NULL;
END;
$$;
CREATE TRIGGER "ChildConsentRecord_append_only"
  BEFORE UPDATE OR DELETE ON "ChildConsentRecord" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_child_consent_record_mutation"();
CREATE TRIGGER "ChildConsentRecord_append_only_truncate"
  BEFORE TRUNCATE ON "ChildConsentRecord" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_reject_child_consent_record_mutation"();

CREATE FUNCTION "_courtly_reject_child_handover_history_deletion"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Child handover history cannot be deleted';
  RETURN NULL;
END;
$$;
CREATE TRIGGER "ChildAccountHandover_history_delete_guard"
  BEFORE DELETE OR TRUNCATE ON "ChildAccountHandover" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_reject_child_handover_history_deletion"();

CREATE FUNCTION "_courtly_protect_child_handover_contract"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."id", OLD."childUserId", OLD."initiatedByGuardianUserId",
      OLD."destinationEmail", OLD."tokenHash", OLD."expiresAt", OLD."initiatedAt")
    IS DISTINCT FROM
    ROW(NEW."id", NEW."childUserId", NEW."initiatedByGuardianUserId",
      NEW."destinationEmail", NEW."tokenHash", NEW."expiresAt", NEW."initiatedAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Child handover identity, recipient, token, and expiry are immutable';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Terminal child handover history is immutable';
  END IF;
  IF NEW."lastSentAt" < OLD."lastSentAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Child handover delivery time cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ChildAccountHandover_contract_guard"
  BEFORE UPDATE ON "ChildAccountHandover" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_child_handover_contract"();

CREATE FUNCTION "_courtly_assert_family_account_shapes"()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "GuardianChildLink" AS link
    JOIN "User" AS guardian ON guardian."id" = link."guardianUserId"
    JOIN "User" AS child ON child."id" = link."childUserId"
    WHERE guardian."accountType" = 'CLUB'
      OR guardian."dateOfBirth" IS NULL
      OR guardian."dateOfBirth" > (
        (((link."activatedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Singapore')::date
          - INTERVAL '18 years')::date
      )
      OR child."accountType" <> 'STUDENT'
      OR child."dateOfBirth" IS NULL
      OR (link."status" = 'ACTIVE' AND (
        guardian."accountControl" <> 'SELF'
        OR guardian."accountStatus" <> 'ACTIVE'
        OR child."accountControl" <> 'GUARDIAN_MANAGED'
      ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Guardian-child links require an adult personal guardian and a managed student child';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ChildConsentRecord" AS consent
    JOIN "User" AS guardian ON guardian."id" = consent."guardianUserId"
    JOIN "User" AS child ON child."id" = consent."childUserId"
    WHERE guardian."accountType" = 'CLUB'
      OR child."accountType" <> 'STUDENT'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Child consent evidence requires a personal guardian and student child';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "User" AS child
    WHERE child."accountControl" = 'GUARDIAN_MANAGED'
      AND (
        NOT EXISTS (
          SELECT 1 FROM "GuardianChildLink" AS link
          WHERE link."childUserId" = child."id"
        )
        OR (child."accountStatus" = 'ACTIVE' AND NOT EXISTS (
          SELECT 1
          FROM "GuardianChildLink" AS link
          WHERE link."childUserId" = child."id"
            AND link."status" = 'ACTIVE'
            AND (
              SELECT consent."eventType" IN ('GRANTED', 'RENEWED')
                AND consent."privacyPolicyVersion" = '2026-09-29'
              FROM "ChildConsentRecord" AS consent
              WHERE consent."linkId" = link."id"
                AND consent."eventType" IN ('GRANTED', 'RENEWED', 'WITHDRAWN')
              ORDER BY consent."sequence" DESC
              LIMIT 1
            ) IS TRUE
        ))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An active guardian-managed child requires active authority with current consent';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ChildAccountHandover" AS handover
    JOIN "User" AS child ON child."id" = handover."childUserId"
    WHERE handover."status" = 'PENDING'
      AND (
        child."accountType" <> 'STUDENT'
        OR child."accountControl" <> 'GUARDIAN_MANAGED'
        OR NOT EXISTS (
          SELECT 1
          FROM "GuardianChildLink" AS link
          JOIN "User" AS guardian ON guardian."id" = link."guardianUserId"
          WHERE link."childUserId" = handover."childUserId"
            AND link."guardianUserId" = handover."initiatedByGuardianUserId"
            AND link."status" = 'ACTIVE'
            AND 'HANDOVER_MANAGE' = ANY(link."permissions")
            AND guardian."accountControl" = 'SELF'
            AND guardian."accountStatus" = 'ACTIVE'
        )
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A child handover requires active guardian handover authority';
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_family_account_shape_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_assert_family_account_shapes"();
  RETURN NULL;
END;
$$;

-- User writes already take this advisory lock through the account-shape
-- migration. Family graph writes join that domain to prevent write skew.
CREATE TRIGGER "GuardianChildLink_account_shape_write_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "GuardianChildLink" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();
CREATE TRIGGER "ChildAccountHandover_account_shape_write_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "ChildAccountHandover" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();
CREATE TRIGGER "ChildConsentRecord_account_shape_write_lock"
  BEFORE INSERT OR UPDATE OR DELETE ON "ChildConsentRecord" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();
CREATE CONSTRAINT TRIGGER "GuardianChildLink_account_shape_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "GuardianChildLink"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_family_account_shape_constraint"();
CREATE CONSTRAINT TRIGGER "ChildAccountHandover_account_shape_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "ChildAccountHandover"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_family_account_shape_constraint"();
CREATE CONSTRAINT TRIGGER "ChildConsentRecord_account_shape_invariant"
  AFTER INSERT ON "ChildConsentRecord"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_family_account_shape_constraint"();
CREATE CONSTRAINT TRIGGER "User_family_account_shape_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "User"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_family_account_shape_constraint"();

SELECT "_courtly_assert_family_account_shapes"();

COMMIT;
