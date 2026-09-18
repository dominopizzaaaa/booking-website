-- Reconcile account shapes before the invariants that follow are installed.
--
-- The old model let a club be run by an OWNER *and* one or more ADMINs. The
-- previous migration turns each of those into a CLUB account, which leaves a
-- club with several institutional logins — a shape the new model does not
-- allow and the next migration refuses to enforce over. A deploy against real
-- data would stop there, so the reconciliation happens here instead.
--
-- Nothing is deleted that cannot be restored through the product: a displaced
-- administrator keeps their login and becomes a coach account, which the club
-- can add back to its roster.

-- 1. A club account belongs to one club. Where an old owner ran several
-- businesses, keep the earliest affiliation and release the others; step 4
-- gives any club left without a login a dormant one.
DELETE FROM "Membership" surplus
USING (
  SELECT membership."id",
         row_number() OVER (
           PARTITION BY membership."userId"
           ORDER BY membership."createdAt", membership."id"
         ) AS rank
  FROM "Membership" AS membership
  JOIN "User" AS account ON account."id" = membership."userId"
  WHERE account."accountType" = 'CLUB'
) AS ranked
WHERE surplus."id" = ranked."id" AND ranked.rank > 1;

-- 2. A club has one institutional login. Keep the earliest and release the
-- rest, which is where an old OWNER + ADMIN pair is resolved.
DELETE FROM "Membership" surplus
USING (
  SELECT membership."id",
         row_number() OVER (
           PARTITION BY membership."businessId"
           ORDER BY membership."createdAt", membership."id"
         ) AS rank
  FROM "Membership" AS membership
  JOIN "User" AS account ON account."id" = membership."userId"
  JOIN "Business" AS business ON business."id" = membership."businessId"
  WHERE account."accountType" = 'CLUB' AND business."kind" = 'CLUB'
) AS ranked
WHERE surplus."id" = ranked."id" AND ranked.rank > 1;

-- 3. The surviving institutional affiliation must be active and must not
-- teach, which is what the club account means.
UPDATE "Membership" AS membership
SET "active" = true, "instructorId" = NULL
FROM "User" AS account, "Business" AS business
WHERE account."id" = membership."userId"
  AND business."id" = membership."businessId"
  AND account."accountType" = 'CLUB'
  AND business."kind" = 'CLUB'
  AND (membership."active" = false OR membership."instructorId" IS NOT NULL);

-- 4. A club with no institutional login keeps its data and its history. It
-- gets a dormant account: a real row for referential integrity that cannot be
-- signed into, because no password can be invented for someone.
WITH "orphaned" AS (
  SELECT business."id"
  FROM "Business" AS business
  WHERE business."kind" = 'CLUB'
    AND NOT EXISTS (
      SELECT 1
      FROM "Membership" AS membership
      JOIN "User" AS account ON account."id" = membership."userId"
      WHERE membership."businessId" = business."id"
        AND account."accountType" = 'CLUB'
    )
), "created" AS (
  INSERT INTO "User" ("id", "name", "email", "passwordHash", "accountType", "phone", "parentName", "createdAt")
  SELECT
    'club-' || business."id",
    business."name",
    'club-' || business."id" || '@unclaimed.courtly.invalid',
    NULL,
    'CLUB',
    '',
    '',
    CURRENT_TIMESTAMP
  FROM "Business" AS business
  JOIN "orphaned" ON "orphaned"."id" = business."id"
  RETURNING "id"
)
INSERT INTO "Membership" ("id", "userId", "businessId", "instructorId", "active", "createdAt")
SELECT
  'club-membership-' || substr("created"."id", 6),
  "created"."id",
  substr("created"."id", 6),
  NULL,
  true,
  CURRENT_TIMESTAMP
FROM "created";

-- 5. A released administrator is still a person. Their login survives as a
-- coach account with no affiliation, ready for a club to add to its roster.
UPDATE "User" AS account
SET "accountType" = 'COACH'
WHERE account."accountType" = 'CLUB'
  AND NOT EXISTS (
    SELECT 1 FROM "Membership" AS membership WHERE membership."userId" = account."id"
  );

-- 6. A coach affiliation must name the coach's roster entry. Release any that
-- lost one, rather than leaving an affiliation that cannot be scheduled.
DELETE FROM "Membership" AS membership
USING "User" AS account, "Business" AS business
WHERE account."id" = membership."userId"
  AND business."id" = membership."businessId"
  AND account."accountType" = 'COACH'
  AND business."kind" IN ('CLUB', 'SOLO')
  AND membership."instructorId" IS NULL;

-- 7. A student books lessons and belongs to no business.
DELETE FROM "Membership" AS membership
USING "User" AS account
WHERE account."id" = membership."userId"
  AND account."accountType" = 'STUDENT';
