-- A coach payout belongs to the coach, not to an arbitrary student. Normalize
-- valid historical payouts and pin both payment legs to exactly one party.
BEGIN;

SET LOCAL lock_timeout = '10s';
LOCK TABLE "Business", "Booking", "Payment" IN SHARE ROW EXCLUSIVE MODE;

-- The application has always supplied the coach on real payout writes. Stop
-- atomically if hand-written legacy data cannot be migrated without guessing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Payment"
    WHERE "kind" = 'CLUB_TO_COACH' AND "instructorId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot detach payout students: CLUB_TO_COACH payment without instructor exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Booking" AS booking ON booking."id" = payment."bookingId"
    WHERE payment."businessId" <> booking."businessId"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce payment routes: a payment names a booking from another business';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Business" AS business ON business."id" = payment."businessId"
    WHERE payment."kind" = 'CLUB_TO_COACH'
      AND business."kind" <> 'CLUB'
  ) THEN
    RAISE EXCEPTION 'Cannot enforce payment routes: a SOLO business has a CLUB_TO_COACH payout';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "Booking" AS booking ON booking."id" = payment."bookingId"
    WHERE payment."kind" = 'CLUB_TO_COACH'
      AND booking."paymentRoute" <> 'CLUB'
  ) THEN
    RAISE EXCEPTION 'Cannot enforce payment routes: a CLUB_TO_COACH payout names a DIRECT booking';
  END IF;
END $$;

-- Student receipts follow the contractual booking snapshot when they are tied
-- to a lesson. Unbound receipts use the immutable business kind. Both repairs
-- are deterministic; a payout on a SOLO business was rejected above because
-- changing its party and meaning would require guessing.
UPDATE "Payment" AS payment
SET "kind" = CASE booking."paymentRoute"
  WHEN 'CLUB' THEN 'STUDENT_TO_CLUB'
  WHEN 'DIRECT' THEN 'STUDENT_TO_COACH'
END
FROM "Booking" AS booking
WHERE booking."id" = payment."bookingId"
  AND payment."kind" <> 'CLUB_TO_COACH'
  AND payment."kind" IS DISTINCT FROM CASE booking."paymentRoute"
    WHEN 'CLUB' THEN 'STUDENT_TO_CLUB'
    WHEN 'DIRECT' THEN 'STUDENT_TO_COACH'
  END;

UPDATE "Payment" AS payment
SET "kind" = CASE business."kind"
  WHEN 'CLUB' THEN 'STUDENT_TO_CLUB'
  WHEN 'SOLO' THEN 'STUDENT_TO_COACH'
END
FROM "Business" AS business
WHERE business."id" = payment."businessId"
  AND payment."bookingId" IS NULL
  AND payment."kind" <> 'CLUB_TO_COACH'
  AND payment."kind" IS DISTINCT FROM CASE business."kind"
    WHEN 'CLUB' THEN 'STUDENT_TO_CLUB'
    WHEN 'SOLO' THEN 'STUDENT_TO_COACH'
  END;

ALTER TABLE "Payment" ALTER COLUMN "studentId" DROP NOT NULL;

-- Old payout writes used an unrelated student solely to satisfy NOT NULL. The
-- payout and its real coach relation stay intact; only that false link is cut.
UPDATE "Payment"
SET "studentId" = NULL
WHERE "kind" = 'CLUB_TO_COACH';

-- Student-originated money has no coach payee. Clear any stale optional link
-- before enforcing the exclusive party shape.
UPDATE "Payment"
SET "instructorId" = NULL
WHERE "kind" IN ('STUDENT_TO_CLUB', 'STUDENT_TO_COACH');

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_instructorId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_instructorId_fkey"
  FOREIGN KEY ("instructorId") REFERENCES "Instructor"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_party_shape_check" CHECK (
  (
    "kind" IN ('STUDENT_TO_CLUB', 'STUDENT_TO_COACH')
    AND "studentId" IS NOT NULL
    AND "instructorId" IS NULL
  )
  OR
  (
    "kind" = 'CLUB_TO_COACH'
    AND "studentId" IS NULL
    AND "instructorId" IS NOT NULL
  )
);

-- Keep the booking link inside the same tenant and retain its contractual
-- payment-route evidence. Individual bookings with ledger history cannot be
-- deleted; deleting the whole business still removes both rows by cascade.
CREATE UNIQUE INDEX "Booking_id_businessId_key"
  ON "Booking"("id", "businessId");

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_bookingId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_businessId_fkey"
  FOREIGN KEY ("bookingId", "businessId")
  REFERENCES "Booking"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "_courtly_payment_route_constraint"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  business_kind TEXT;
  booking_business_id TEXT;
  booking_payment_route TEXT;
BEGIN
  SELECT "kind" INTO business_kind
  FROM "Business"
  WHERE "id" = NEW."businessId";

  IF NEW."bookingId" IS NOT NULL THEN
    SELECT "businessId", "paymentRoute"
    INTO booking_business_id, booking_payment_route
    FROM "Booking"
    WHERE "id" = NEW."bookingId";

    IF booking_business_id IS DISTINCT FROM NEW."businessId" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Payment booking must belong to the payment business';
    END IF;
  END IF;

  IF NEW."kind" = 'CLUB_TO_COACH' THEN
    IF business_kind IS DISTINCT FROM 'CLUB' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'CLUB_TO_COACH payments require a CLUB business';
    END IF;
    IF NEW."bookingId" IS NOT NULL AND booking_payment_route IS DISTINCT FROM 'CLUB' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'CLUB_TO_COACH payment booking must use CLUB paymentRoute';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."bookingId" IS NOT NULL THEN
    IF (booking_payment_route = 'CLUB' AND NEW."kind" <> 'STUDENT_TO_CLUB')
      OR (booking_payment_route = 'DIRECT' AND NEW."kind" <> 'STUDENT_TO_COACH') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Student payment kind must match Booking.paymentRoute';
    END IF;
  ELSIF (business_kind = 'CLUB' AND NEW."kind" <> 'STUDENT_TO_CLUB')
    OR (business_kind = 'SOLO' AND NEW."kind" <> 'STUDENT_TO_COACH') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Unbound student payment kind must match Business.kind';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Payment_route_invariant"
BEFORE INSERT OR UPDATE OF "businessId", "bookingId", "kind" ON "Payment"
FOR EACH ROW
EXECUTE FUNCTION "_courtly_payment_route_constraint"();

CREATE FUNCTION "_courtly_booking_payment_route_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."paymentRoute" IS DISTINCT FROM NEW."paymentRoute" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Booking.paymentRoute is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Booking_payment_route_immutable"
BEFORE UPDATE OF "paymentRoute" ON "Booking"
FOR EACH ROW
EXECUTE FUNCTION "_courtly_booking_payment_route_immutable"();

CREATE FUNCTION "_courtly_booking_payment_route_constraint"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    WHERE payment."bookingId" = NEW."id"
      AND (
        (NEW."paymentRoute" = 'CLUB' AND payment."kind" = 'STUDENT_TO_COACH')
        OR (NEW."paymentRoute" = 'DIRECT' AND payment."kind" = 'STUDENT_TO_CLUB')
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Existing student payment kind must match Booking.paymentRoute';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Booking_payment_route_invariant"
BEFORE UPDATE OF "businessId", "paymentRoute" ON "Booking"
FOR EACH ROW
EXECUTE FUNCTION "_courtly_booking_payment_route_constraint"();

COMMIT;
