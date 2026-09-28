-- Generalize booking-derived session chat with direct account conversations.
-- Existing SESSION rows retain their booking and tenant identity; only ACCOUNT
-- rows persist explicit membership.
BEGIN;

SET LOCAL lock_timeout = '10s';

ALTER TABLE "ChatThread"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'SESSION',
  ADD COLUMN "directKey" TEXT;

ALTER TABLE "SessionProposal"
  ADD COLUMN "price" INTEGER,
  ADD COLUMN "currency" TEXT;

-- Older proposals predate the explicit commercial snapshot. Reconstruct it
-- from their immutable service/location assignment and business currency.
UPDATE "SessionProposal" AS proposal
SET "price" = assignment."price",
    "currency" = business."currency"
FROM "ServiceLocation" AS assignment, "Business" AS business
WHERE assignment."serviceId" = proposal."serviceId"
  AND assignment."locationId" = proposal."locationId"
  AND business."id" = proposal."businessId";

DO $$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg("id", ', ' ORDER BY "id") INTO invalid_ids
  FROM "SessionProposal"
  WHERE "price" IS NULL OR "price" < 0 OR "currency" IS NULL OR btrim("currency") = '';
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Cannot snapshot historical SessionProposal prices: ' || invalid_ids;
  END IF;
END;
$$;

ALTER TABLE "SessionProposal"
  ALTER COLUMN "price" SET NOT NULL,
  ALTER COLUMN "currency" SET NOT NULL,
  ADD CONSTRAINT "SessionProposal_price_check" CHECK ("price" >= 0),
  ADD CONSTRAINT "SessionProposal_currency_check" CHECK (btrim("currency") <> '');

-- The previous migration admitted only active CLUB booking threads. Audit that
-- history before relaxing the nullable columns used by ACCOUNT conversations.
DO $$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg(thread."id", ', ' ORDER BY thread."id")
    INTO invalid_ids
  FROM "ChatThread" AS thread
  LEFT JOIN "Booking" AS booking
    ON booking."id" = thread."bookingId"
   AND booking."businessId" = thread."businessId"
  LEFT JOIN "Business" AS business ON business."id" = thread."businessId"
  WHERE booking."id" IS NULL
     OR booking."paymentRoute" <> 'CLUB'
     OR business."kind" <> 'CLUB'
     OR business."legacyReadOnly";

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot generalize invalid historical SESSION chat threads: ' || invalid_ids;
  END IF;
END;
$$;

ALTER TABLE "SessionProposal"
  DROP CONSTRAINT "SessionProposal_threadId_businessId_fkey";
ALTER TABLE "SessionProposal"
  ADD CONSTRAINT "SessionProposal_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatThread"
  ALTER COLUMN "businessId" DROP NOT NULL,
  ALTER COLUMN "bookingId" DROP NOT NULL,
  ADD CONSTRAINT "ChatThread_kind_check"
    CHECK ("kind" IN ('SESSION', 'ACCOUNT')),
  ADD CONSTRAINT "ChatThread_shape_check" CHECK (
    ("kind" = 'SESSION'
      AND "bookingId" IS NOT NULL
      AND "businessId" IS NOT NULL
      AND "directKey" IS NULL)
    OR
    ("kind" = 'ACCOUNT'
      AND "bookingId" IS NULL
      AND "directKey" IS NOT NULL)
  );

CREATE UNIQUE INDEX "ChatThread_directKey_key" ON "ChatThread"("directKey");

CREATE TABLE "ChatThreadMember" (
  "threadId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "membershipId" TEXT,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMP(3),
  "addedByUserId" TEXT,

  CONSTRAINT "ChatThreadMember_pkey" PRIMARY KEY ("threadId", "userId"),
  CONSTRAINT "ChatThreadMember_source_check"
    CHECK ("source" IN ('INITIATOR', 'TARGET', 'CLUB_ASSIGNED')),
  CONSTRAINT "ChatThreadMember_membership_shape_check"
    CHECK (("source" = 'CLUB_ASSIGNED') = ("membershipId" IS NOT NULL)),
  CONSTRAINT "ChatThreadMember_removed_check"
    CHECK ("removedAt" IS NULL OR "removedAt" >= "joinedAt")
);

CREATE INDEX "ChatThreadMember_userId_removedAt_idx"
  ON "ChatThreadMember"("userId", "removedAt");
CREATE INDEX "ChatThreadMember_membershipId_idx"
  ON "ChatThreadMember"("membershipId");
CREATE INDEX "ChatThreadMember_addedByUserId_idx"
  ON "ChatThreadMember"("addedByUserId");
CREATE UNIQUE INDEX "ChatThreadMember_one_initiator"
  ON "ChatThreadMember"("threadId") WHERE "source" = 'INITIATOR';
CREATE UNIQUE INDEX "ChatThreadMember_one_target"
  ON "ChatThreadMember"("threadId") WHERE "source" = 'TARGET';
CREATE UNIQUE INDEX "ChatThreadMember_one_active_club_assigned"
  ON "ChatThreadMember"("threadId")
  WHERE "source" = 'CLUB_ASSIGNED' AND "removedAt" IS NULL;

ALTER TABLE "ChatThreadMember" ADD CONSTRAINT "ChatThreadMember_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatThreadMember" ADD CONSTRAINT "ChatThreadMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatThreadMember" ADD CONSTRAINT "ChatThreadMember_membershipId_fkey"
  FOREIGN KEY ("membershipId") REFERENCES "Membership"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatThreadMember" ADD CONSTRAINT "ChatThreadMember_addedByUserId_fkey"
  FOREIGN KEY ("addedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- All four values define what a conversation is. Rewriting any of them would
-- make its messages and direct member history describe a different subject.
DROP TRIGGER "ChatThread_businessId_immutable" ON "ChatThread";

CREATE FUNCTION "_courtly_chat_thread_identity_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."kind" IS DISTINCT FROM NEW."kind"
    OR OLD."bookingId" IS DISTINCT FROM NEW."bookingId"
    OR OLD."businessId" IS DISTINCT FROM NEW."businessId"
    OR OLD."directKey" IS DISTINCT FROM NEW."directKey" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ChatThread identity is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatThread_identity_immutable"
  BEFORE UPDATE OF "kind", "bookingId", "businessId", "directKey"
  ON "ChatThread" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_chat_thread_identity_immutable"();

-- A proposal is an immutable offer plus mutable lifecycle state. Foreign-key
-- cleanup may clear the optional author/counter references, but callers may
-- never rewrite the conversation, scheduling graph, people, time, copy, or
-- commercial terms after the offer is created.
DROP TRIGGER "SessionProposal_businessId_immutable" ON "SessionProposal";

CREATE FUNCTION "_courtly_session_proposal_contract_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."businessId" IS DISTINCT FROM NEW."businessId"
    OR OLD."threadId" IS DISTINCT FROM NEW."threadId"
    OR OLD."serviceId" IS DISTINCT FROM NEW."serviceId"
    OR OLD."instructorId" IS DISTINCT FROM NEW."instructorId"
    OR OLD."locationId" IS DISTINCT FROM NEW."locationId"
    OR OLD."address" IS DISTINCT FROM NEW."address"
    OR OLD."price" IS DISTINCT FROM NEW."price"
    OR OLD."currency" IS DISTINCT FROM NEW."currency"
    OR OLD."startAt" IS DISTINCT FROM NEW."startAt"
    OR OLD."endAt" IS DISTINCT FROM NEW."endAt"
    OR OLD."proposedByRole" IS DISTINCT FROM NEW."proposedByRole"
    OR (OLD."proposedByUserId" IS DISTINCT FROM NEW."proposedByUserId"
      AND NOT (OLD."proposedByUserId" IS NOT NULL AND NEW."proposedByUserId" IS NULL))
    OR OLD."proposedByName" IS DISTINCT FROM NEW."proposedByName"
    OR OLD."targetStudentUserId" IS DISTINCT FROM NEW."targetStudentUserId"
    OR OLD."targetStudentName" IS DISTINCT FROM NEW."targetStudentName"
    OR (OLD."counterOfId" IS DISTINCT FROM NEW."counterOfId"
      AND NOT (OLD."counterOfId" IS NOT NULL AND NEW."counterOfId" IS NULL))
    OR OLD."message" IS DISTINCT FROM NEW."message"
    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'SessionProposal contractual terms are immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SessionProposal_contract_immutable"
  BEFORE UPDATE ON "SessionProposal"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_session_proposal_contract_immutable"();

-- Keep the original trigger name so deployed databases replace its behavior
-- without editing the already-applied session-chat migration.
CREATE OR REPLACE FUNCTION "_courtly_reject_inactive_chat_thread_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'SESSION' AND NOT EXISTS (
    SELECT 1
    FROM "Booking" AS booking
    JOIN "Business" AS business ON business."id" = booking."businessId"
    WHERE booking."id" = NEW."bookingId"
      AND booking."businessId" = NEW."businessId"
      AND booking."paymentRoute" = 'CLUB'
      AND business."kind" = 'CLUB'
      AND business."legacyReadOnly" = false
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A SESSION chat requires a booking made through an active CLUB business';
  END IF;

  IF NEW."kind" = 'ACCOUNT' AND NEW."businessId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Business" AS business
    WHERE business."id" = NEW."businessId"
      AND business."kind" = 'CLUB'
      AND business."legacyReadOnly" = false
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A scoped ACCOUNT chat requires an active CLUB business';
  END IF;
  RETURN NEW;
END;
$$;

-- Member rows are never a cache for booking-derived SESSION access.
CREATE FUNCTION "_courtly_reject_session_chat_member"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ChatThread"
    WHERE "id" = NEW."threadId" AND "kind" <> 'ACCOUNT'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ChatThreadMember rows belong only to ACCOUNT chats';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatThreadMember_account_only"
  BEFORE INSERT OR UPDATE OF "threadId" ON "ChatThreadMember"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_session_chat_member"();

-- Validate the complete ACCOUNT graph at commit so its thread and two base
-- members may be inserted in either order within one transaction.
CREATE FUNCTION "_courtly_assert_chat_thread"(checked_thread_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  checked_thread "ChatThread"%ROWTYPE;
  base_total BIGINT;
  active_base_total BIGINT;
  initiator_total BIGINT;
  target_total BIGINT;
  expected_direct_key TEXT;
  club_total BIGINT;
  club_user_id TEXT;
  assigned RECORD;
BEGIN
  SELECT * INTO checked_thread FROM "ChatThread" WHERE "id" = checked_thread_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF checked_thread."kind" = 'SESSION' THEN
    IF EXISTS (SELECT 1 FROM "ChatThreadMember" WHERE "threadId" = checked_thread_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'SESSION chat membership must remain booking-derived';
    END IF;
    RETURN;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE member."removedAt" IS NULL),
         count(*) FILTER (WHERE member."source" = 'INITIATOR'),
         count(*) FILTER (WHERE member."source" = 'TARGET'),
         min(member."userId"),
         max(member."userId")
    INTO base_total, active_base_total, initiator_total, target_total,
         expected_direct_key, club_user_id
  FROM "ChatThreadMember" AS member
  WHERE member."threadId" = checked_thread_id
    AND member."source" IN ('INITIATOR', 'TARGET');

  IF base_total <> 2 OR active_base_total <> 2
    OR initiator_total <> 1 OR target_total <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An ACCOUNT chat requires one active INITIATOR and one active TARGET';
  END IF;

  expected_direct_key := expected_direct_key || ':' || club_user_id;
  IF checked_thread."directKey" IS DISTINCT FROM expected_direct_key THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'ChatThread.directKey must be the sorted direct account pair';
  END IF;

  SELECT count(*) FILTER (WHERE account."accountType" = 'CLUB'),
         min(member."userId") FILTER (WHERE account."accountType" = 'CLUB')
    INTO club_total, club_user_id
  FROM "ChatThreadMember" AS member
  JOIN "User" AS account ON account."id" = member."userId"
  WHERE member."threadId" = checked_thread_id
    AND member."source" IN ('INITIATOR', 'TARGET')
    AND member."removedAt" IS NULL;

  IF checked_thread."businessId" IS NOT NULL THEN
    IF club_total <> 1 OR NOT EXISTS (
      SELECT 1
      FROM "Membership" AS club_membership
      WHERE club_membership."userId" = club_user_id
        AND club_membership."businessId" = checked_thread."businessId"
        AND club_membership."active"
        AND club_membership."instructorId" IS NULL
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'An ACCOUNT chat with one CLUB member must use that club business';
    END IF;
  END IF;

  -- Serialize assignment validation with roster and instructor edits. This
  -- closes the write-skew window where both transactions could otherwise read
  -- the other's pre-change state and commit an invalid active assignment.
  PERFORM 1
  FROM "ChatThreadMember" AS member
  JOIN "Membership" AS membership ON membership."id" = member."membershipId"
  WHERE member."threadId" = checked_thread_id
    AND member."source" = 'CLUB_ASSIGNED'
    AND member."removedAt" IS NULL
  FOR SHARE OF membership;

  PERFORM 1
  FROM "ChatThreadMember" AS member
  JOIN "Membership" AS membership ON membership."id" = member."membershipId"
  JOIN "Instructor" AS instructor ON instructor."id" = membership."instructorId"
  WHERE member."threadId" = checked_thread_id
    AND member."source" = 'CLUB_ASSIGNED'
    AND member."removedAt" IS NULL
  FOR SHARE OF instructor;

  FOR assigned IN
    SELECT member."userId", member."removedAt", member."addedByUserId",
           membership."userId" AS membership_user_id,
           membership."businessId" AS membership_business_id,
           membership."instructorId", membership."active",
           instructor."active" AS instructor_active, account."accountType"
    FROM "ChatThreadMember" AS member
    JOIN "Membership" AS membership ON membership."id" = member."membershipId"
    LEFT JOIN "Instructor" AS instructor ON instructor."id" = membership."instructorId"
    JOIN "User" AS account ON account."id" = member."userId"
    WHERE member."threadId" = checked_thread_id
      AND member."source" = 'CLUB_ASSIGNED'
      AND member."removedAt" IS NULL
  LOOP
    IF checked_thread."businessId" IS NULL
      OR assigned.membership_user_id <> assigned."userId"
      OR assigned.membership_business_id <> checked_thread."businessId"
      OR assigned."instructorId" IS NULL
      OR assigned."accountType" <> 'COACH'
      OR NOT assigned."active"
      OR NOT COALESCE(assigned.instructor_active, false) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'An active CLUB_ASSIGNED member must be a rostered coach in the chat business';
    END IF;

    IF club_total <> 1
      OR NOT EXISTS (
        SELECT 1
        FROM "ChatThreadMember" AS student_member
        JOIN "User" AS student_account ON student_account."id" = student_member."userId"
        WHERE student_member."threadId" = checked_thread_id
          AND student_member."source" IN ('INITIATOR', 'TARGET')
          AND student_member."removedAt" IS NULL
          AND student_account."accountType" = 'STUDENT'
      )
      OR assigned."addedByUserId" IS DISTINCT FROM club_user_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'An active CLUB_ASSIGNED coach requires the club and student direct pair';
    END IF;
  END LOOP;
END;
$$;

-- Roster deactivation is already the canonical access revocation path. Close
-- its active assignment atomically so existing staff removal need not know
-- about every conversation that coach once joined.
CREATE FUNCTION "_courtly_remove_invalid_chat_assignments"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Membership' THEN
    IF NOT NEW."active" OR NEW."instructorId" IS NULL
      OR NEW."instructorId" IS DISTINCT FROM OLD."instructorId"
      OR NEW."userId" IS DISTINCT FROM OLD."userId"
      OR NEW."businessId" IS DISTINCT FROM OLD."businessId" THEN
      UPDATE "ChatThreadMember"
      SET "removedAt" = COALESCE("removedAt", CURRENT_TIMESTAMP)
      WHERE "membershipId" = OLD."id"
        AND "source" = 'CLUB_ASSIGNED'
        AND "removedAt" IS NULL;
    END IF;
  ELSIF TG_OP = 'DELETE' OR NOT NEW."active" THEN
    UPDATE "ChatThreadMember" AS member
    SET "removedAt" = COALESCE(member."removedAt", CURRENT_TIMESTAMP)
    FROM "Membership" AS membership
    WHERE membership."id" = member."membershipId"
      AND membership."instructorId" = OLD."id"
      AND member."source" = 'CLUB_ASSIGNED'
      AND member."removedAt" IS NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Membership_remove_invalid_chat_assignments"
  BEFORE UPDATE OF "active", "instructorId", "userId", "businessId" ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_remove_invalid_chat_assignments"();
CREATE TRIGGER "Instructor_remove_invalid_chat_assignments"
  BEFORE UPDATE OF "active" OR DELETE ON "Instructor"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_remove_invalid_chat_assignments"();

CREATE FUNCTION "_courtly_chat_thread_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ChatThread' THEN
    PERFORM "_courtly_assert_chat_thread"(CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END);
  ELSE
    PERFORM "_courtly_assert_chat_thread"(CASE WHEN TG_OP = 'DELETE' THEN OLD."threadId" ELSE NEW."threadId" END);
    IF TG_OP = 'UPDATE' AND OLD."threadId" IS DISTINCT FROM NEW."threadId" THEN
      PERFORM "_courtly_assert_chat_thread"(OLD."threadId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ChatThread_membership_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "ChatThread"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_chat_thread_constraint"();
CREATE CONSTRAINT TRIGGER "ChatThreadMember_thread_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "ChatThreadMember"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_chat_thread_constraint"();

-- A roster or account-type edit must not silently invalidate an active coach
-- assignment or change the business-scoping meaning of a direct pair.
CREATE FUNCTION "_courtly_chat_member_dependency_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected RECORD;
BEGIN
  IF TG_TABLE_NAME = 'Membership' THEN
    FOR affected IN
      SELECT DISTINCT member."threadId" AS thread_id
      FROM "ChatThreadMember" AS member
      WHERE member."membershipId" IN (OLD."id", NEW."id")
         OR (member."source" IN ('INITIATOR', 'TARGET')
             AND member."userId" IN (OLD."userId", NEW."userId"))
    LOOP
      PERFORM "_courtly_assert_chat_thread"(affected.thread_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'Instructor' THEN
    FOR affected IN
      SELECT DISTINCT member."threadId" AS thread_id
      FROM "ChatThreadMember" AS member
      JOIN "Membership" AS membership ON membership."id" = member."membershipId"
      WHERE membership."instructorId" = OLD."id"
    LOOP
      PERFORM "_courtly_assert_chat_thread"(affected.thread_id);
    END LOOP;
  ELSE
    FOR affected IN
      SELECT DISTINCT member."threadId" AS thread_id
      FROM "ChatThreadMember" AS member
      WHERE member."userId" IN (OLD."id", NEW."id")
         OR member."addedByUserId" IN (OLD."id", NEW."id")
    LOOP
      PERFORM "_courtly_assert_chat_thread"(affected.thread_id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Membership_chat_thread_invariant"
  AFTER UPDATE ON "Membership"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_chat_member_dependency_constraint"();
CREATE CONSTRAINT TRIGGER "Instructor_chat_thread_invariant"
  AFTER UPDATE OR DELETE ON "Instructor"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_chat_member_dependency_constraint"();
CREATE CONSTRAINT TRIGGER "User_chat_thread_invariant"
  AFTER UPDATE ON "User"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_chat_member_dependency_constraint"();

-- Removing either direct account deletes the now-one-sided conversation. When
-- the thread itself cascades its members the parent is already invisible to
-- this statement, so the nested delete is a no-op.
CREATE FUNCTION "_courtly_cleanup_orphaned_account_chat_thread"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."source" IN ('INITIATOR', 'TARGET') THEN
    DELETE FROM "ChatThread" AS thread
    WHERE thread."id" = OLD."threadId"
      AND thread."kind" = 'ACCOUNT'
      AND (
        SELECT count(*)
        FROM "ChatThreadMember" AS member
        WHERE member."threadId" = thread."id"
          AND member."source" IN ('INITIATOR', 'TARGET')
          AND member."removedAt" IS NULL
      ) < 2;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "ChatThreadMember_cleanup_orphaned_account"
  AFTER DELETE ON "ChatThreadMember" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_cleanup_orphaned_account_chat_thread"();

-- Proposal cards must remain in the same thread as their proposal. Audit the
-- old single-column relation before installing the cross-column trigger.
DO $$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg(message."id", ', ' ORDER BY message."id") INTO invalid_ids
  FROM "ChatMessage" AS message
  JOIN "SessionProposal" AS proposal ON proposal."id" = message."proposalId"
  WHERE message."threadId" <> proposal."threadId";
  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Cannot enforce ChatMessage proposal thread ownership: ' || invalid_ids;
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_assert_chat_message_proposal_thread"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."proposalId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "SessionProposal" AS proposal
    WHERE proposal."id" = NEW."proposalId"
      AND proposal."threadId" = NEW."threadId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A proposal message must belong to the proposal thread';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatMessage_proposal_thread_invariant"
  BEFORE INSERT OR UPDATE OF "proposalId", "threadId" ON "ChatMessage"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_assert_chat_message_proposal_thread"();

-- Proposals retain their own business-scoped scheduling graph. SESSION and
-- scoped ACCOUNT threads stay with their thread business. A global ACCOUNT
-- pair may choose a club only when its direct coach is actively bookable there.
CREATE FUNCTION "_courtly_assert_session_proposal_thread_business"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  thread_kind TEXT;
  thread_business_id TEXT;
  direct_coach_user_id TEXT;
  direct_student_user_id TEXT;
  assigned_coach_user_id TEXT;
  expected_coach_user_id TEXT;
  proposer_account_type TEXT;
  live_price INTEGER;
  live_currency TEXT;
BEGIN
  SELECT "kind", "businessId" INTO thread_kind, thread_business_id
  FROM "ChatThread" WHERE "id" = NEW."threadId";
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF thread_kind = 'SESSION'
    AND NEW."businessId" IS DISTINCT FROM thread_business_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A SESSION proposal must belong to its thread business';
  END IF;
  IF thread_kind = 'ACCOUNT' AND thread_business_id IS NOT NULL
    AND NEW."businessId" IS DISTINCT FROM thread_business_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A scoped ACCOUNT proposal must belong to its thread business';
  END IF;

  -- Retain the same commercial rows and lock order as API creation. The
  -- trigger therefore protects direct database writers under concurrency too.
  SELECT "currency" INTO live_currency FROM "Business"
  WHERE "id" = NEW."businessId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A proposal snapshot must match the current class price and business currency';
  END IF;

  SELECT "price" INTO live_price FROM "ServiceLocation"
  WHERE "serviceId" = NEW."serviceId"
    AND "locationId" = NEW."locationId"
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A proposal snapshot must match the current class price and business currency';
  END IF;

  -- During a migration-first rolling deploy, an older API process still
  -- writes the pre-snapshot SESSION shape. Fill those omitted values at the
  -- database boundary while rejecting every supplied stale or forged term.
  NEW."price" := COALESCE(NEW."price", live_price);
  NEW."currency" := COALESCE(NEW."currency", live_currency);
  IF NEW."price" IS DISTINCT FROM live_price OR NEW."currency" IS DISTINCT FROM live_currency THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A proposal snapshot must match the current class price and business currency';
  END IF;

  IF thread_kind <> 'ACCOUNT' THEN RETURN NEW; END IF;

  SELECT min(member."userId") FILTER (WHERE account."accountType" = 'COACH'),
         min(member."userId") FILTER (WHERE account."accountType" = 'STUDENT')
    INTO direct_coach_user_id, direct_student_user_id
  FROM "ChatThreadMember" AS member
  JOIN "User" AS account ON account."id" = member."userId"
  WHERE member."threadId" = NEW."threadId"
    AND member."source" IN ('INITIATOR', 'TARGET')
    AND member."removedAt" IS NULL;

  SELECT member."userId" INTO assigned_coach_user_id
  FROM "ChatThreadMember" AS member
  WHERE member."threadId" = NEW."threadId"
    AND member."source" = 'CLUB_ASSIGNED'
    AND member."removedAt" IS NULL;

  SELECT "accountType" INTO proposer_account_type
  FROM "User" WHERE "id" = NEW."proposedByUserId";

  IF direct_student_user_id IS NULL
    OR NEW."targetStudentUserId" IS DISTINCT FROM direct_student_user_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An ACCOUNT proposal target must be the conversation student';
  END IF;

  IF NEW."proposedByUserId" IS NULL
    OR proposer_account_type IS DISTINCT FROM NEW."proposedByRole"
    OR NOT EXISTS (
      SELECT 1 FROM "ChatThreadMember" AS member
      WHERE member."threadId" = NEW."threadId"
        AND member."userId" = NEW."proposedByUserId"
        AND member."removedAt" IS NULL
        AND (member."source" IN ('INITIATOR', 'TARGET')
          OR member."source" = 'CLUB_ASSIGNED')
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An ACCOUNT proposal must be made by an active member with the matching role';
  END IF;

  expected_coach_user_id := CASE
    WHEN thread_business_id IS NULL THEN direct_coach_user_id
    ELSE assigned_coach_user_id
  END;

  -- Match schedulingOptionsFor(): the expected coach must have a live roster
  -- account, and the exact private Class/venue pair must still be assigned to
  -- that instructor. The proposal's tenant FKs additionally pin every parent
  -- in this graph to NEW.businessId.
  IF expected_coach_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM "Membership" AS membership
    JOIN "User" AS coach
      ON coach."id" = membership."userId"
    JOIN "Instructor" AS instructor
      ON instructor."id" = membership."instructorId"
     AND instructor."businessId" = membership."businessId"
    JOIN "Business" AS business
      ON business."id" = membership."businessId"
    JOIN "Service" AS service
      ON service."id" = NEW."serviceId"
     AND service."businessId" = membership."businessId"
    JOIN "Location" AS location
      ON location."id" = NEW."locationId"
     AND location."businessId" = membership."businessId"
    JOIN "ServiceLocation" AS service_location
      ON service_location."serviceId" = service."id"
     AND service_location."locationId" = location."id"
    JOIN "ServiceInstructor" AS service_instructor
      ON service_instructor."serviceLocationId" = service_location."id"
     AND service_instructor."instructorId" = instructor."id"
    WHERE membership."userId" = expected_coach_user_id
      AND membership."businessId" = NEW."businessId"
      AND membership."instructorId" = NEW."instructorId"
      AND membership."active"
      AND instructor."active"
      AND coach."accountType" = 'COACH'
      AND coach."passwordHash" IS NOT NULL
      AND business."kind" = 'CLUB'
      AND business."legacyReadOnly" = false
      AND service."active"
      AND service."type" = 'PRIVATE'
      AND location."active"
  ) THEN
    IF thread_business_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A global ACCOUNT proposal requires its direct coach and an actively bookable private class';
    END IF;
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A scoped ACCOUNT proposal requires its assigned coach and an actively bookable private class';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SessionProposal_thread_business_invariant"
  BEFORE INSERT ON "SessionProposal"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_assert_session_proposal_thread_business"();

COMMIT;
