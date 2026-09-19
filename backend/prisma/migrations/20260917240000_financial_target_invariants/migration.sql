-- Keep each receipt attached to exactly one real financial obligation. Audit
-- historical rows atomically, then let row checks and deferred foreign keys
-- enforce final transaction state without serializing unrelated writes.
BEGIN;

SET LOCAL lock_timeout = '10s';
LOCK TABLE "Payment", "Participant", "LessonPackage"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION "_courtly_assert_financial_targets"()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Payment"
    WHERE "bookingId" IS NOT NULL AND "packageId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Payment cannot target both a booking and a package';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    WHERE payment."bookingId" IS NOT NULL
      AND payment."kind" <> 'CLUB_TO_COACH'
      AND NOT EXISTS (
        SELECT 1
        FROM "Participant" AS participant
        WHERE participant."bookingId" = payment."bookingId"
          AND participant."studentId" = payment."studentId"
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Booking payment student must participate in the named booking';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "LessonPackage" AS package ON package."id" = payment."packageId"
    WHERE payment."packageId" IS NOT NULL
      AND (payment."kind" = 'CLUB_TO_COACH'
        OR payment."studentId" IS DISTINCT FROM package."studentId")
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Package payment student must own the named package';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Participant" AS participant
    JOIN "LessonPackage" AS package ON package."id" = participant."packageId"
    WHERE participant."packageId" IS NOT NULL
      AND participant."studentId" <> package."studentId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Participant package must belong to the participant student';
  END IF;
END;
$$;

-- Abort before installing enforcement if historical rows cannot be interpreted
-- without inventing a payer or obligation. The surrounding transaction makes
-- the audit itself disappear if any historical row fails.
SELECT "_courtly_assert_financial_targets"();

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_single_target_check" CHECK (
  NOT ("bookingId" IS NOT NULL AND "packageId" IS NOT NULL)
);

-- Composite foreign keys use MATCH SIMPLE, so the null student on a payout
-- would otherwise allow a package target to escape ownership validation.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_payout_without_package_check" CHECK (
  "kind" <> 'CLUB_TO_COACH' OR "packageId" IS NULL
);

CREATE UNIQUE INDEX "LessonPackage_id_studentId_key"
  ON "LessonPackage"("id", "studentId");

ALTER TABLE "Participant" DROP CONSTRAINT "Participant_packageId_fkey";
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_packageId_studentId_fkey"
  FOREIGN KEY ("packageId", "studentId")
  REFERENCES "LessonPackage"("id", "studentId")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_studentId_fkey"
  FOREIGN KEY ("bookingId", "studentId")
  REFERENCES "Participant"("bookingId", "studentId")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_packageId_studentId_fkey"
  FOREIGN KEY ("packageId", "studentId")
  REFERENCES "LessonPackage"("id", "studentId")
  ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

-- PostgreSQL does not add indexes on the referencing side of a foreign key.
-- These keep parent validation and the existing balance lookups bounded.
CREATE INDEX "Payment_bookingId_studentId_idx"
  ON "Payment"("bookingId", "studentId");
CREATE INDEX "Payment_packageId_studentId_idx"
  ON "Payment"("packageId", "studentId");
CREATE INDEX "Participant_packageId_studentId_idx"
  ON "Participant"("packageId", "studentId");

DROP FUNCTION "_courtly_assert_financial_targets"();

COMMIT;
