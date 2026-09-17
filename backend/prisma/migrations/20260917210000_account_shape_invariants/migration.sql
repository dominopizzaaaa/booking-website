-- Enforce the account/business shapes that cannot be represented as ordinary
-- row-local CHECK constraints. The assertions are deferred so the application
-- can create or remove a business, account, and affiliation in one transaction.
BEGIN;

SET LOCAL lock_timeout = '10s';
LOCK TABLE "Business", "User", "Membership"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION "_courtly_assert_account_shapes"()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User" AS account
    JOIN "Membership" AS membership ON membership."userId" = account."id"
    WHERE account."accountType" = 'STUDENT'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'STUDENT accounts cannot have business affiliations';
  END IF;

  IF EXISTS (
    SELECT account."id"
    FROM "User" AS account
    LEFT JOIN "Membership" AS membership ON membership."userId" = account."id"
    LEFT JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE account."accountType" = 'CLUB'
    GROUP BY account."id"
    HAVING count(membership."id") <> 1
      OR count(membership."id") FILTER (
        WHERE business."kind" = 'CLUB'
          AND membership."active"
          AND membership."instructorId" IS NULL
      ) <> 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Each CLUB account must have exactly one active non-teaching CLUB affiliation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Membership" AS membership
    JOIN "User" AS account ON account."id" = membership."userId"
    JOIN "Business" AS business ON business."id" = membership."businessId"
    WHERE account."accountType" = 'COACH'
      AND business."kind" IN ('CLUB', 'SOLO')
      AND membership."instructorId" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Every COACH affiliation must have an instructor identity';
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
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A COACH account can own at most one SOLO practice';
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
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Each CLUB business must have exactly one active institutional affiliation';
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
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Each SOLO business must have exactly one teaching COACH affiliation';
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_account_shape_constraint"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "_courtly_assert_account_shapes"();
  RETURN NULL;
END;
$$;

CREATE FUNCTION "_courtly_lock_account_shape_writes"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Cross-table assertions otherwise permit write skew between concurrent
  -- transactions. These writes are rare, so one transaction-scoped lock is a
  -- small cost for a complete database guarantee.
  PERFORM pg_advisory_xact_lock(20260917, 210000);
  RETURN NULL;
END;
$$;

CREATE FUNCTION "_courtly_business_kind_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."kind" IS DISTINCT FROM NEW."kind" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Business.kind is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

-- Do not install enforcement around an already-invalid database. This also
-- makes applying the migration to an existing environment an atomic audit.
SELECT "_courtly_assert_account_shapes"();

CREATE TRIGGER "Business_kind_immutable"
BEFORE UPDATE OF "kind" ON "Business"
FOR EACH ROW
EXECUTE FUNCTION "_courtly_business_kind_immutable"();

CREATE TRIGGER "User_account_shape_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "User"
FOR EACH STATEMENT
EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();

CREATE TRIGGER "Membership_account_shape_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "Membership"
FOR EACH STATEMENT
EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();

CREATE TRIGGER "Business_account_shape_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "Business"
FOR EACH STATEMENT
EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();

CREATE CONSTRAINT TRIGGER "User_account_shape_invariants"
AFTER INSERT OR UPDATE OR DELETE ON "User"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "_courtly_account_shape_constraint"();

CREATE CONSTRAINT TRIGGER "Membership_account_shape_invariants"
AFTER INSERT OR UPDATE OR DELETE ON "Membership"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "_courtly_account_shape_constraint"();

CREATE CONSTRAINT TRIGGER "Business_account_shape_invariants"
AFTER INSERT OR UPDATE OR DELETE ON "Business"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "_courtly_account_shape_constraint"();

COMMIT;
