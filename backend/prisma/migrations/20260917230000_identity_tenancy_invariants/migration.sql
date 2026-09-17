-- Pin portable account identity and financial parties at the database boundary.
-- Existing rows are audited first: neither a non-student account link nor a
-- cross-tenant ledger party can be repaired without inventing user intent.
BEGIN;

SET LOCAL lock_timeout = '10s';
LOCK TABLE "User", "Student", "Instructor", "LessonPackage", "Payment"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Student" AS student
    JOIN "User" AS account ON account."id" = student."userId"
    WHERE student."userId" IS NOT NULL
      AND account."accountType" <> 'STUDENT'
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce linked student identities: a Student.userId points to a non-STUDENT account';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Student" AS student ON student."id" = payment."studentId"
    WHERE payment."studentId" IS NOT NULL
      AND payment."businessId" <> student."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce payment tenancy: a payment names a student from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Instructor" AS instructor ON instructor."id" = payment."instructorId"
    WHERE payment."instructorId" IS NOT NULL
      AND payment."businessId" <> instructor."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce payment tenancy: a payment names an instructor from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "LessonPackage" AS package
    JOIN "Student" AS student ON student."id" = package."studentId"
    WHERE package."businessId" <> student."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce package tenancy: a package names a student from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "LessonPackage" AS package ON package."id" = payment."packageId"
    WHERE payment."packageId" IS NOT NULL
      AND payment."businessId" <> package."businessId"
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce payment tenancy: a payment names a package from another business';
  END IF;
END $$;

-- Composite targets let PostgreSQL enforce tenant ownership without trusting
-- every caller to repeat a businessId predicate. Instructor already has its
-- matching unique index from the membership tenant-boundary migration.
CREATE UNIQUE INDEX "Student_id_businessId_key"
  ON "Student"("id", "businessId");
CREATE UNIQUE INDEX "LessonPackage_id_businessId_key"
  ON "LessonPackage"("id", "businessId");

ALTER TABLE "LessonPackage" DROP CONSTRAINT "LessonPackage_studentId_fkey";
ALTER TABLE "LessonPackage" ADD CONSTRAINT "LessonPackage_studentId_businessId_fkey"
  FOREIGN KEY ("studentId", "businessId")
  REFERENCES "Student"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_studentId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_studentId_businessId_fkey"
  FOREIGN KEY ("studentId", "businessId")
  REFERENCES "Student"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_instructorId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_instructorId_businessId_fkey"
  FOREIGN KEY ("instructorId", "businessId")
  REFERENCES "Instructor"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_packageId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_packageId_businessId_fkey"
  FOREIGN KEY ("packageId", "businessId")
  REFERENCES "LessonPackage"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "_courtly_assert_student_account_links"()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Student" AS student
    JOIN "User" AS account ON account."id" = student."userId"
    WHERE student."userId" IS NOT NULL
      AND account."accountType" <> 'STUDENT'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Student.userId must reference a STUDENT account';
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_student_account_constraint"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "_courtly_assert_student_account_links"();
  RETURN NULL;
END;
$$;

-- User writes already take this transaction-scoped lock through the account
-- shape migration. Student writes join the same lock domain so concurrent
-- relinking and account-type changes cannot commit a write-skew violation.
CREATE TRIGGER "Student_account_shape_write_lock"
BEFORE INSERT OR UPDATE OR DELETE ON "Student"
FOR EACH STATEMENT
EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();

CREATE CONSTRAINT TRIGGER "Student_user_account_type_invariant"
AFTER INSERT OR UPDATE ON "Student"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "_courtly_student_account_constraint"();

CREATE CONSTRAINT TRIGGER "User_student_account_type_invariant"
AFTER UPDATE ON "User"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "_courtly_student_account_constraint"();

COMMIT;
