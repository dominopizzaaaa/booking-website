-- Three kinds of account, and nothing else.
--
-- Courtly had two overlapping role vocabularies: User.accountType
-- (CUSTOMER/COACH/OWNER) and Membership.role (OWNER/ADMIN/COACH). They
-- disagreed about what an account even was. This collapses both into one:
-- STUDENT, COACH, or CLUB, stored once on the user. Membership becomes a
-- plain affiliation link.
--
-- A CLUB account is the club, not a person, and therefore never teaches. A
-- founder who also coaches uses a separate COACH account on the club roster.
BEGIN;

SET LOCAL lock_timeout = '10s';
LOCK TABLE
  "Business", "User", "Membership", "AuthSession", "Instructor",
  "Customer", "Participant", "LessonPackage", "Booking", "Payment",
  "RescheduleRequest", "IntegrityFlag"
  IN SHARE ROW EXCLUSIVE MODE;

-- Reject legacy shapes that cannot be represented without guessing who owns a
-- business or silently discarding an affiliation. Stop before changing data so
-- every failure leaves the complete old model in place.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Business" WHERE "kind" NOT IN ('CLUB', 'SOLO')) THEN
    RAISE EXCEPTION 'Cannot classify accounts: unsupported Business.kind exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Customer" AS customer
    JOIN "User" AS account ON account."id" = customer."userId"
    WHERE customer."userId" IS NOT NULL
      AND account."accountType" <> 'CUSTOMER'
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate linked student identities: a legacy Customer.userId points to a provider account';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Customer" AS customer ON customer."id" = payment."customerId"
    WHERE payment."businessId" <> customer."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate payment tenancy: a legacy payment names a customer from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Instructor" AS instructor ON instructor."id" = payment."instructorId"
    WHERE payment."instructorId" IS NOT NULL
      AND payment."businessId" <> instructor."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate payment tenancy: a legacy payment names an instructor from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Booking" AS booking ON booking."id" = payment."bookingId"
    WHERE payment."businessId" <> booking."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate payment tenancy: a legacy payment names a booking from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "LessonPackage" AS package
    JOIN "Customer" AS customer ON customer."id" = package."customerId"
    WHERE package."businessId" <> customer."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate package tenancy: a legacy package names a customer from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "LessonPackage" AS package ON package."id" = payment."packageId"
    WHERE payment."businessId" <> package."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate payment tenancy: a legacy payment names a package from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment"
    WHERE "kind" = 'CLUB_TO_COACH'
      AND "instructorId" IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate payment parties: CLUB_TO_COACH payment without instructor exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Business" AS business ON business."id" = payment."businessId"
    WHERE payment."kind" = 'CLUB_TO_COACH'
      AND business."kind" <> 'CLUB'
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate payment routes: a SOLO business has a CLUB_TO_COACH payout';
  END IF;

  IF EXISTS (
    SELECT business."id"
    FROM "Business" AS business
    LEFT JOIN "Membership" AS membership
      ON membership."businessId" = business."id"
      AND membership."role" = 'OWNER'
    WHERE business."kind" = 'SOLO'
    GROUP BY business."id"
    HAVING count(membership."id") <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot classify SOLO practices: each must have exactly one OWNER';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Membership" AS membership
    JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE business."kind" = 'SOLO'
      AND membership."role" <> 'OWNER'
  ) THEN
    RAISE EXCEPTION 'Cannot classify SOLO practices: non-OWNER affiliations exist';
  END IF;

  IF EXISTS (
    SELECT membership."userId"
    FROM "Membership" AS membership
    JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE business."kind" = 'SOLO'
      AND membership."role" = 'OWNER'
    GROUP BY membership."userId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot classify SOLO practices: a legacy user owns more than one SOLO business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Membership" AS solo_membership
    JOIN "Business" AS solo_business
      ON solo_business."id" = solo_membership."businessId"
      AND solo_business."kind" = 'SOLO'
    JOIN "Membership" AS club_membership
      ON club_membership."userId" = solo_membership."userId"
      AND club_membership."role" = 'OWNER'
    JOIN "Business" AS club_business
      ON club_business."id" = club_membership."businessId"
      AND club_business."kind" = 'CLUB'
    WHERE solo_membership."role" = 'OWNER'
  ) THEN
    RAISE EXCEPTION 'Cannot classify accounts: a legacy user both manages a CLUB and owns a SOLO business';
  END IF;

  IF EXISTS (
    SELECT business."id"
    FROM "Business" AS business
    LEFT JOIN "Membership" AS membership
      ON membership."businessId" = business."id"
      AND membership."role" = 'OWNER'
    WHERE business."kind" = 'CLUB'
    GROUP BY business."id"
    HAVING count(membership."id") <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot classify CLUB accounts: each CLUB business must have exactly one OWNER';
  END IF;

  IF EXISTS (
    SELECT membership."userId"
    FROM "Membership" AS membership
    JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE membership."role" = 'OWNER'
      AND business."kind" = 'CLUB'
    GROUP BY membership."userId"
    HAVING count(DISTINCT membership."businessId") > 1
  ) THEN
    RAISE EXCEPTION 'Cannot classify CLUB accounts: a legacy user manages more than one CLUB business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Membership" AS management
    JOIN "Business" AS managed_business
      ON managed_business."id" = management."businessId"
      AND managed_business."kind" = 'CLUB'
    JOIN "Membership" AS extra
      ON extra."userId" = management."userId"
      AND extra."id" <> management."id"
    WHERE management."role" = 'OWNER'
      AND extra."instructorId" IS NULL
      AND extra."role" <> 'ADMIN'
  ) THEN
    RAISE EXCEPTION 'Cannot split CLUB accounts: an extra legacy affiliation has no instructor identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Membership" AS membership
    JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE business."kind" = 'SOLO'
      AND membership."role" = 'OWNER'
      AND membership."instructorId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot classify SOLO practices: the OWNER affiliation must have an instructor identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Membership" AS membership
    JOIN "Instructor" AS collision
      ON collision."id" = 'legacy-admin-instructor-' || membership."id"
    WHERE membership."role" = 'ADMIN'
      AND membership."instructorId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot preserve legacy ADMIN staff: deterministic instructor collision exists';
  END IF;
END $$;

-- The old vocabularies are pinned by check constraints. Drop them inside this
-- transaction so rows can be rewritten, then pin the new vocabulary below.
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_accountType_check";
ALTER TABLE "Membership" DROP CONSTRAINT IF EXISTS "Membership_role_check";

-- Customer becomes Student in every table, foreign key, constraint, and index.
ALTER TABLE "Customer" RENAME TO "Student";
ALTER TABLE "Student" RENAME CONSTRAINT "Customer_pkey" TO "Student_pkey";
ALTER TABLE "Student" RENAME CONSTRAINT "Customer_businessId_fkey" TO "Student_businessId_fkey";
ALTER TABLE "Student" RENAME CONSTRAINT "Customer_userId_fkey" TO "Student_userId_fkey";
ALTER TABLE "Student" RENAME CONSTRAINT "Customer_email_canonical_check" TO "Student_email_canonical_check";
ALTER INDEX "Customer_businessId_email_key" RENAME TO "Student_businessId_email_key";
ALTER INDEX "Customer_businessId_userId_key" RENAME TO "Student_businessId_userId_key";
ALTER INDEX "Customer_userId_idx" RENAME TO "Student_userId_idx";

ALTER TABLE "Participant" RENAME COLUMN "customerId" TO "studentId";
ALTER TABLE "Participant" RENAME CONSTRAINT "Participant_customerId_fkey" TO "Participant_studentId_fkey";
ALTER INDEX "Participant_bookingId_customerId_key" RENAME TO "Participant_bookingId_studentId_key";

ALTER TABLE "LessonPackage" RENAME COLUMN "customerId" TO "studentId";
ALTER TABLE "LessonPackage" RENAME CONSTRAINT "LessonPackage_customerId_fkey" TO "LessonPackage_studentId_fkey";

ALTER TABLE "Payment" RENAME COLUMN "customerId" TO "studentId";
ALTER TABLE "Payment" RENAME CONSTRAINT "Payment_customerId_fkey" TO "Payment_studentId_fkey";

ALTER TABLE "IntegrityFlag" RENAME COLUMN "customerUserId" TO "studentUserId";
ALTER TABLE "IntegrityFlag" RENAME COLUMN "customerName" TO "studentName";
ALTER INDEX "IntegrityFlag_businessId_coachUserId_customerUserId_type_key"
  RENAME TO "IntegrityFlag_businessId_coachUserId_studentUserId_type_key";

-- Translate persisted role vocabulary as well as table and column names.
UPDATE "Booking"
SET "createdByRole" = 'STUDENT'
WHERE "createdByRole" = 'CUSTOMER';
ALTER TABLE "Booking" ALTER COLUMN "createdByRole" SET DEFAULT 'STUDENT';

UPDATE "RescheduleRequest"
SET "requestedByRole" = 'STUDENT'
WHERE "requestedByRole" = 'CUSTOMER';

-- A booking's snapshotted route is contractual and wins over an inconsistent
-- legacy label. Payments without a booking use the immutable business kind.
-- Payouts are a separate leg and retain their identity exactly.
UPDATE "Payment" AS payment
SET "kind" = CASE
  WHEN payment."kind" = 'CLUB_TO_COACH' THEN 'CLUB_TO_COACH'
  WHEN payment."bookingId" IS NOT NULL THEN CASE (
    SELECT booking."paymentRoute"
    FROM "Booking" AS booking
    WHERE booking."id" = payment."bookingId"
  )
    WHEN 'CLUB' THEN 'STUDENT_TO_CLUB'
    WHEN 'DIRECT' THEN 'STUDENT_TO_COACH'
    ELSE payment."kind"
  END
  WHEN business."kind" = 'CLUB' THEN 'STUDENT_TO_CLUB'
  WHEN business."kind" = 'SOLO' THEN 'STUDENT_TO_COACH'
  ELSE payment."kind"
END
FROM "Business" AS business
WHERE business."id" = payment."businessId";
ALTER TABLE "Payment" ALTER COLUMN "kind" SET DEFAULT 'STUDENT_TO_CLUB';

-- A management role denotes a CLUB account only when the business is itself a
-- club. An OWNER of a SOLO practice remains the coach who teaches there.
UPDATE "User" AS account
SET "accountType" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "Membership" AS membership
    JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE membership."userId" = account."id"
      AND membership."role" = 'OWNER'
      AND business."kind" = 'CLUB'
  ) THEN 'CLUB'
  WHEN account."accountType" = 'CUSTOMER' THEN 'STUDENT'
  ELSE 'COACH'
END;

-- Remember each CLUB account's one management membership while role still
-- exists. All of its sessions are redirected there before extra affiliations
-- are removed, making the account single-club without logging browsers out.
CREATE TEMPORARY TABLE "_club_management_memberships" ON COMMIT DROP AS
SELECT
  membership."userId",
  membership."id" AS "membershipId",
  membership."businessId"
FROM "Membership" AS membership
JOIN "Business" AS business ON business."id" = membership."businessId"
JOIN "User" AS account ON account."id" = membership."userId"
WHERE account."accountType" = 'CLUB'
  AND membership."role" = 'OWNER'
  AND business."kind" = 'CLUB';

-- ADMIN was a workspace permission, not a durable account identity. Preserve
-- the human account, credentials, affiliation, active state, and session, but
-- migrate it to COACH scope so obsolete management authority cannot survive.
-- An admin without a roster gets an inactive synthetic Instructor: this keeps
-- the affiliation representable without making administrative staff bookable.
INSERT INTO "Instructor" (
  "id", "businessId", "name", "initials", "email", "active"
)
SELECT
  'legacy-admin-instructor-' || membership."id",
  membership."businessId",
  account."name",
  COALESCE(NULLIF(upper(left(btrim(account."name"), 2)), ''), '?'),
  account."email",
  false
FROM "Membership" AS membership
JOIN "User" AS account ON account."id" = membership."userId"
WHERE membership."role" = 'ADMIN'
  AND membership."instructorId" IS NULL;

UPDATE "Membership" AS membership
SET "instructorId" = 'legacy-admin-instructor-' || membership."id"
WHERE membership."role" = 'ADMIN'
  AND membership."instructorId" IS NULL;

-- The institutional identity is the club itself. Keep the migrated account
-- name aligned with the retained club, while Business.ownerName continues to
-- preserve the human contact recorded by the legacy model.
UPDATE "User" AS account
SET "name" = business."name"
FROM "_club_management_memberships" AS retained
JOIN "Business" AS business ON business."id" = retained."businessId"
WHERE account."id" = retained."userId";

-- Splitting a human teaching identity from the institutional CLUB login must
-- not make its roster history unclaimable. Snapshot every teaching
-- affiliation before detaching it, including one carried by the retained
-- management membership itself.
CREATE TEMPORARY TABLE "_club_teaching_affiliations" ON COMMIT DROP AS
SELECT
  membership."id" AS "sourceMembershipId",
  membership."businessId",
  membership."instructorId",
  membership."createdAt",
  instructor."name" AS "instructorName",
  membership."active" AS "membershipActive"
FROM "Membership" AS membership
JOIN "User" AS account ON account."id" = membership."userId"
JOIN "Instructor" AS instructor ON instructor."id" = membership."instructorId"
WHERE account."accountType" = 'CLUB';

-- staff.ts only claims this exact deterministic, credentialless identity. A
-- collision is ambiguous, so fail rather than overwrite or invent a different
-- convention that the application could never claim.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_club_teaching_affiliations" AS teaching
    JOIN "User" AS collision
      ON collision."id" = 'legacy-instructor-' || teaching."instructorId"
      OR collision."email" = 'legacy-instructor-' || md5(teaching."instructorId") || '@unclaimed.courtly.invalid'
  ) THEN
    RAISE EXCEPTION 'Cannot split CLUB teaching identities: deterministic placeholder account collision exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_club_teaching_affiliations" AS teaching
    JOIN "Membership" AS collision
      ON collision."id" = 'legacy-membership-' || teaching."instructorId"
  ) THEN
    RAISE EXCEPTION 'Cannot split CLUB teaching identities: deterministic placeholder membership collision exists';
  END IF;

  IF EXISTS (
    SELECT md5(teaching."instructorId")
    FROM "_club_teaching_affiliations" AS teaching
    GROUP BY md5(teaching."instructorId")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot split CLUB teaching identities: deterministic placeholder email collision exists';
  END IF;
END $$;

INSERT INTO "User" (
  "id", "name", "email", "passwordHash", "accountType",
  "phone", "parentName", "createdAt"
)
SELECT
  'legacy-instructor-' || teaching."instructorId",
  teaching."instructorName",
  'legacy-instructor-' || md5(teaching."instructorId") || '@unclaimed.courtly.invalid',
  NULL,
  'COACH',
  '',
  '',
  teaching."createdAt"
FROM "_club_teaching_affiliations" AS teaching;

UPDATE "Membership" AS membership
SET "instructorId" = NULL
FROM "User" AS account
WHERE account."id" = membership."userId"
  AND account."accountType" = 'CLUB';

INSERT INTO "Membership" (
  "id", "userId", "businessId", "role", "instructorId",
  "active", "createdAt"
)
SELECT
  'legacy-membership-' || teaching."instructorId",
  'legacy-instructor-' || teaching."instructorId",
  teaching."businessId",
  'COACH',
  teaching."instructorId",
  teaching."membershipActive",
  teaching."createdAt"
FROM "_club_teaching_affiliations" AS teaching;

UPDATE "AuthSession" AS session
SET "activeMembershipId" = retained."membershipId"
FROM "_club_management_memberships" AS retained
WHERE session."userId" = retained."userId"
  AND session."activeMembershipId" IS DISTINCT FROM retained."membershipId";

DELETE FROM "Membership" AS membership
USING "_club_management_memberships" AS retained
WHERE membership."userId" = retained."userId"
  AND membership."id" <> retained."membershipId";

UPDATE "Membership" AS membership
SET "active" = true
FROM "_club_management_memberships" AS retained
WHERE membership."id" = retained."membershipId";

-- Fail rather than commit an account shape the application cannot interpret.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User" AS account
    WHERE account."accountType" = 'CLUB'
      AND (
        SELECT count(*)
        FROM "Membership"
        WHERE "userId" = account."id"
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot finalize CLUB accounts: each must retain exactly one membership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "User" AS account
    JOIN "Membership" AS membership ON membership."userId" = account."id"
    JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE account."accountType" = 'CLUB'
      AND (business."kind" <> 'CLUB'
        OR membership."role" <> 'OWNER'
        OR membership."active" = false
        OR membership."instructorId" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Cannot finalize CLUB accounts: retained membership is not an active non-teaching CLUB management membership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "User" AS account
    JOIN "Membership" AS membership ON membership."userId" = account."id"
    WHERE account."accountType" = 'STUDENT'
  ) THEN
    RAISE EXCEPTION 'Cannot finalize STUDENT accounts: business affiliations exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "User" AS account
    JOIN "Membership" AS membership ON membership."userId" = account."id"
    WHERE account."accountType" = 'COACH'
      AND membership."instructorId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot finalize COACH accounts: an affiliation has no instructor identity';
  END IF;

  IF EXISTS (
    SELECT account."id"
    FROM "User" AS account
    JOIN "Membership" AS membership ON membership."userId" = account."id"
    JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE account."accountType" = 'COACH'
      AND business."kind" = 'SOLO'
    GROUP BY account."id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot finalize COACH accounts: an account owns more than one SOLO practice';
  END IF;

  IF EXISTS (
    SELECT business."id"
    FROM "Business" AS business
    LEFT JOIN "Membership" AS membership ON membership."businessId" = business."id"
    LEFT JOIN "User" AS account ON account."id" = membership."userId"
    WHERE business."kind" = 'SOLO'
    GROUP BY business."id"
    HAVING count(membership."id") <> 1
      OR count(membership."id") FILTER (
        WHERE account."accountType" = 'COACH'
          AND membership."instructorId" IS NOT NULL
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot finalize SOLO practices: each must have exactly one teaching COACH affiliation';
  END IF;

  IF EXISTS (
    SELECT business."id"
    FROM "Business" AS business
    LEFT JOIN "Membership" AS membership ON membership."businessId" = business."id"
    LEFT JOIN "User" AS account ON account."id" = membership."userId"
    WHERE business."kind" = 'CLUB'
    GROUP BY business."id"
    HAVING count(membership."id") FILTER (
      WHERE account."accountType" = 'CLUB'
        AND membership."active"
        AND membership."instructorId" IS NULL
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot finalize CLUB businesses: each must have exactly one active institutional affiliation';
  END IF;
END $$;

-- Membership is now only an affiliation. Permission derives from account type
-- plus business kind, so keeping role would recreate the ambiguity just removed.
ALTER TABLE "Membership" DROP COLUMN "role";

-- Pin the final vocabularies at the database boundary. These checks cover
-- fields whose valid values are closed sets and therefore safe to constrain.
ALTER TABLE "User" ALTER COLUMN "accountType" SET DEFAULT 'STUDENT';
ALTER TABLE "User"
  ADD CONSTRAINT "User_accountType_check"
    CHECK ("accountType" IN ('STUDENT', 'COACH', 'CLUB'));
ALTER TABLE "Business"
  ADD CONSTRAINT "Business_kind_check"
    CHECK ("kind" IN ('CLUB', 'SOLO'));
ALTER TABLE "Booking"
  ADD CONSTRAINT "Booking_paymentRoute_check"
    CHECK ("paymentRoute" IN ('CLUB', 'DIRECT')),
  ADD CONSTRAINT "Booking_createdByRole_check"
    CHECK ("createdByRole" IN ('STUDENT', 'COACH', 'CLUB'));
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_kind_check"
    CHECK ("kind" IN ('STUDENT_TO_CLUB', 'STUDENT_TO_COACH', 'CLUB_TO_COACH'));
ALTER TABLE "RescheduleRequest"
  ADD CONSTRAINT "RescheduleRequest_requestedByRole_check"
    CHECK ("requestedByRole" IN ('STUDENT', 'COACH', 'CLUB'));

COMMIT;
