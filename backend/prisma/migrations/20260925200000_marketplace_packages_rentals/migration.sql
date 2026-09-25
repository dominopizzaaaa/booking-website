-- Add global marketplace identities, immutable package scope snapshots and
-- tenant-pinned venue rentals without rewriting any historical money route.
BEGIN;

SET LOCAL lock_timeout = '10s';
LOCK TABLE
  "Business", "User", "Location", "Service", "Student",
  "LessonPackage", "Booking", "Participant", "Payment",
  "Notification", "IntegrityFlag"
  IN SHARE ROW EXCLUSIVE MODE;

-- Older releases did not constrain package counters. Fail with a repairable
-- diagnostic before changing the schema instead of letting ADD CONSTRAINT
-- surface an opaque violation after substantial migration work.
DO $$
DECLARE
  invalid_count BIGINT;
  invalid_ids TEXT;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM "LessonPackage"
  WHERE "totalCredits" <= 0
    OR "usedCredits" < 0
    OR "usedCredits" > "totalCredits";

  IF invalid_count > 0 THEN
    SELECT string_agg(invalid_package."id", ', ' ORDER BY invalid_package."id")
    INTO invalid_ids
    FROM (
      SELECT "id"
      FROM "LessonPackage"
      WHERE "totalCredits" <= 0
        OR "usedCredits" < 0
        OR "usedCredits" > "totalCredits"
      ORDER BY "id"
      LIMIT 10
    ) AS invalid_package;

    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Cannot enforce LessonPackage credit balances: totalCredits must be positive and usedCredits must be between zero and totalCredits',
      DETAIL = format('%s invalid row(s); LessonPackage ids (up to 10): %s', invalid_count, invalid_ids);
  END IF;
END $$;

-- Existing accounts predate public handles. Derive a readable canonical base
-- from the email local-part, then suffix collisions with stable account data.
-- The audit makes even an extraordinarily unlikely truncated-md5 collision
-- fail atomically instead of silently assigning a duplicate identity.
ALTER TABLE "User"
  ADD COLUMN "username" TEXT,
  ADD COLUMN "sports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TEMPORARY TABLE "_courtly_username_backfill" ON COMMIT DROP AS
WITH normalized AS (
  SELECT
    "id",
    btrim(
      regexp_replace(lower(split_part("email", '@', 1)), '[^a-z0-9_]+', '_', 'g'),
      '_'
    ) AS local_part
  FROM "User"
), based AS (
  SELECT
    "id",
    CASE
      WHEN length(local_part) >= 3 THEN left(local_part, 30)
      ELSE 'user_' || substr(md5("id"), 1, 8)
    END AS base
  FROM normalized
), ranked AS (
  SELECT
    "id", base,
    row_number() OVER (PARTITION BY base ORDER BY "id") AS collision_rank
  FROM based
)
SELECT
  "id",
  CASE
    WHEN collision_rank = 1 THEN base
    ELSE left(base, 21) || '_' || substr(md5("id"), 1, 8)
  END AS username
FROM ranked;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "_courtly_username_backfill"
    GROUP BY username
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot backfill User.username: deterministic username collision exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_courtly_username_backfill"
    WHERE username !~ '^[a-z0-9_]{3,30}$'
  ) THEN
    RAISE EXCEPTION
      'Cannot backfill User.username: generated username is not canonical';
  END IF;
END $$;

UPDATE "User" AS account
SET "username" = backfill.username
FROM "_courtly_username_backfill" AS backfill
WHERE backfill."id" = account."id";

-- User already has deferred account-shape constraint triggers. Flush the
-- deterministic backfill through them before the next ALTER TABLE, because
-- PostgreSQL refuses to alter a table while its trigger events are pending.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

ALTER TABLE "User"
  ALTER COLUMN "username" SET NOT NULL,
  ADD CONSTRAINT "User_username_canonical_check"
    CHECK ("username" ~ '^[a-z0-9_]{3,30}$');
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- SOLO practices are historical after this release. Their immutable kind and
-- every Booking.paymentRoute snapshot remain untouched.
ALTER TABLE "Business"
  ADD COLUMN "legacyReadOnly" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Business" SET "legacyReadOnly" = true WHERE "kind" = 'SOLO';
ALTER TABLE "Business" ADD CONSTRAINT "Business_solo_legacy_read_only_check"
  CHECK ("kind" <> 'SOLO' OR "legacyReadOnly");

-- All new commerce belongs to a club. Changing the column default affects only
-- future inserts that omit paymentRoute; historical DIRECT snapshots remain.
ALTER TABLE "Booking" ALTER COLUMN "paymentRoute" SET DEFAULT 'CLUB';

-- Rental settings live on the existing Location catalog item. Reservations
-- copy price and duration, so later configuration changes affect only new use.
ALTER TABLE "Location"
  ADD COLUMN "sport" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "rentalEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rentalUnitLabel" TEXT NOT NULL DEFAULT 'Court',
  ADD COLUMN "rentalPrice" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rentalStartInterval" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "rentalMinDuration" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "rentalBookingIncrement" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "rentalMaxDuration" INTEGER NOT NULL DEFAULT 180,
  ADD COLUMN "rentalNoticeHours" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "rentalAdvanceDays" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "rentalCancellationHours" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "rules" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "amenities" TEXT NOT NULL DEFAULT '',
  ADD CONSTRAINT "Location_rental_price_check" CHECK ("rentalPrice" >= 0),
  ADD CONSTRAINT "Location_rental_start_interval_check"
    CHECK ("rentalStartInterval" IN (15, 30, 60)),
  ADD CONSTRAINT "Location_rental_booking_increment_check"
    CHECK ("rentalBookingIncrement" IN (15, 30, 60)),
  ADD CONSTRAINT "Location_rental_duration_check" CHECK (
    "rentalMinDuration" >= "rentalBookingIncrement"
    AND "rentalMinDuration" <= "rentalMaxDuration"
    AND "rentalMaxDuration" <= 1440
    AND "rentalMinDuration" % "rentalBookingIncrement" = 0
    AND "rentalMaxDuration" % "rentalBookingIncrement" = 0
  ),
  ADD CONSTRAINT "Location_rental_notice_check"
    CHECK ("rentalNoticeHours" BETWEEN 0 AND 8760),
  ADD CONSTRAINT "Location_rental_advance_check"
    CHECK ("rentalAdvanceDays" BETWEEN 1 AND 365),
  ADD CONSTRAINT "Location_rental_cancellation_check"
    CHECK ("rentalCancellationHours" BETWEEN 0 AND 8760),
  ADD CONSTRAINT "Location_rentable_shape_check" CHECK (
    NOT "rentalEnabled"
    OR ("active" AND "type" = 'FACILITY'
      AND btrim("sport") <> '' AND btrim("rentalUnitLabel") <> '')
  );

CREATE TABLE "VenueUnit" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VenueUnit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VenueUnit_name_check" CHECK (btrim("name") <> '')
);
CREATE UNIQUE INDEX "VenueUnit_id_businessId_key"
  ON "VenueUnit"("id", "businessId");
CREATE UNIQUE INDEX "VenueUnit_id_locationId_businessId_key"
  ON "VenueUnit"("id", "locationId", "businessId");
CREATE UNIQUE INDEX "VenueUnit_locationId_name_key"
  ON "VenueUnit"("locationId", "name");
CREATE INDEX "VenueUnit_businessId_idx" ON "VenueUnit"("businessId");
CREATE INDEX "VenueUnit_locationId_idx" ON "VenueUnit"("locationId");
ALTER TABLE "VenueUnit" ADD CONSTRAINT "VenueUnit_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VenueUnit" ADD CONSTRAINT "VenueUnit_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId")
  REFERENCES "Location"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "VenueOpeningHour" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "dayOfWeek" INTEGER NOT NULL,
  "startTime" TEXT NOT NULL,
  "endTime" TEXT NOT NULL,

  CONSTRAINT "VenueOpeningHour_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VenueOpeningHour_day_check" CHECK ("dayOfWeek" BETWEEN 0 AND 6),
  CONSTRAINT "VenueOpeningHour_time_check" CHECK (
    "startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "endTime" > "startTime"
  )
);
CREATE UNIQUE INDEX "VenueOpeningHour_locationId_dayOfWeek_startTime_key"
  ON "VenueOpeningHour"("locationId", "dayOfWeek", "startTime");
CREATE INDEX "VenueOpeningHour_businessId_idx"
  ON "VenueOpeningHour"("businessId");
CREATE INDEX "VenueOpeningHour_locationId_idx"
  ON "VenueOpeningHour"("locationId");
ALTER TABLE "VenueOpeningHour" ADD CONSTRAINT "VenueOpeningHour_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VenueOpeningHour" ADD CONSTRAINT "VenueOpeningHour_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId")
  REFERENCES "Location"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "PackageOffer" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "price" INTEGER NOT NULL,
  "totalCredits" INTEGER NOT NULL,
  "validityDays" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PackageOffer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PackageOffer_name_check" CHECK (btrim("name") <> ''),
  CONSTRAINT "PackageOffer_price_check" CHECK ("price" > 0),
  CONSTRAINT "PackageOffer_credit_check" CHECK ("totalCredits" > 0),
  CONSTRAINT "PackageOffer_validity_check" CHECK ("validityDays" BETWEEN 1 AND 3650)
);
CREATE UNIQUE INDEX "PackageOffer_id_businessId_key"
  ON "PackageOffer"("id", "businessId");
CREATE INDEX "PackageOffer_businessId_active_idx"
  ON "PackageOffer"("businessId", "active");
ALTER TABLE "PackageOffer" ADD CONSTRAINT "PackageOffer_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PackageOfferService" (
  "offerId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  CONSTRAINT "PackageOfferService_pkey" PRIMARY KEY ("offerId", "serviceId")
);
CREATE INDEX "PackageOfferService_serviceId_businessId_idx"
  ON "PackageOfferService"("serviceId", "businessId");
ALTER TABLE "PackageOfferService" ADD CONSTRAINT "PackageOfferService_offerId_businessId_fkey"
  FOREIGN KEY ("offerId", "businessId")
  REFERENCES "PackageOffer"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PackageOfferService" ADD CONSTRAINT "PackageOfferService_serviceId_businessId_fkey"
  FOREIGN KEY ("serviceId", "businessId")
  REFERENCES "Service"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "PackageOfferLocation" (
  "offerId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  CONSTRAINT "PackageOfferLocation_pkey" PRIMARY KEY ("offerId", "locationId")
);
CREATE INDEX "PackageOfferLocation_locationId_businessId_idx"
  ON "PackageOfferLocation"("locationId", "businessId");
ALTER TABLE "PackageOfferLocation" ADD CONSTRAINT "PackageOfferLocation_offerId_businessId_fkey"
  FOREIGN KEY ("offerId", "businessId")
  REFERENCES "PackageOffer"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PackageOfferLocation" ADD CONSTRAINT "PackageOfferLocation_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId")
  REFERENCES "Location"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- A purchased LessonPackage keeps its current serviceId compatibility field,
-- gains optional offer provenance, and snapshots every scoped product below.
ALTER TABLE "LessonPackage"
  ADD COLUMN "offerId" TEXT,
  ADD COLUMN "scopeSnapshotSealed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LessonPackage" ADD CONSTRAINT "LessonPackage_credit_balance_check" CHECK (
  "totalCredits" > 0 AND "usedCredits" BETWEEN 0 AND "totalCredits" AND "price" >= 0
);
ALTER TABLE "LessonPackage" ADD CONSTRAINT "LessonPackage_scope_seal_shape_check" CHECK (
  "offerId" IS NOT NULL OR NOT "scopeSnapshotSealed"
);
CREATE INDEX "LessonPackage_offerId_businessId_idx"
  ON "LessonPackage"("offerId", "businessId");
ALTER TABLE "LessonPackage" ADD CONSTRAINT "LessonPackage_offerId_businessId_fkey"
  FOREIGN KEY ("offerId", "businessId")
  REFERENCES "PackageOffer"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "LessonPackageService" (
  "packageId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "serviceId" TEXT NOT NULL,
  CONSTRAINT "LessonPackageService_pkey" PRIMARY KEY ("packageId", "serviceId")
);
CREATE INDEX "LessonPackageService_serviceId_businessId_idx"
  ON "LessonPackageService"("serviceId", "businessId");
ALTER TABLE "LessonPackageService" ADD CONSTRAINT "LessonPackageService_packageId_businessId_fkey"
  FOREIGN KEY ("packageId", "businessId")
  REFERENCES "LessonPackage"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LessonPackageService" ADD CONSTRAINT "LessonPackageService_serviceId_businessId_fkey"
  FOREIGN KEY ("serviceId", "businessId")
  REFERENCES "Service"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Preserve the explicit scope of legacy single-service packages. A null old
-- serviceId continues to mean any lesson and therefore has no finite snapshot.
INSERT INTO "LessonPackageService" ("packageId", "businessId", "serviceId")
SELECT "id", "businessId", "serviceId"
FROM "LessonPackage"
WHERE "serviceId" IS NOT NULL;

CREATE TABLE "LessonPackageLocation" (
  "packageId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  CONSTRAINT "LessonPackageLocation_pkey" PRIMARY KEY ("packageId", "locationId")
);
CREATE INDEX "LessonPackageLocation_locationId_businessId_idx"
  ON "LessonPackageLocation"("locationId", "businessId");
ALTER TABLE "LessonPackageLocation" ADD CONSTRAINT "LessonPackageLocation_packageId_businessId_fkey"
  FOREIGN KEY ("packageId", "businessId")
  REFERENCES "LessonPackage"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "LessonPackageLocation" ADD CONSTRAINT "LessonPackageLocation_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId")
  REFERENCES "Location"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "VenueReservation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "duration" INTEGER NOT NULL,
  "price" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
  "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
  "packageId" TEXT,
  "creditConsumed" BOOLEAN NOT NULL DEFAULT false,
  "notes" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledAt" TIMESTAMP(3),

  CONSTRAINT "VenueReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VenueReservation_status_check"
    CHECK ("status" IN ('CONFIRMED', 'PENDING', 'CANCELLED')),
  CONSTRAINT "VenueReservation_payment_status_check"
    CHECK ("paymentStatus" IN ('PAID', 'PACKAGE', 'UNPAID', 'REFUNDED')),
  CONSTRAINT "VenueReservation_time_check" CHECK (
    "endAt" > "startAt"
    AND "duration" > 0
    AND "endAt" = "startAt" + make_interval(mins => "duration")
  ),
  CONSTRAINT "VenueReservation_price_check" CHECK ("price" >= 0),
  CONSTRAINT "VenueReservation_cancelled_shape_check" CHECK (
    ("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL)
  ),
  CONSTRAINT "VenueReservation_payment_shape_check" CHECK (
    ("paymentStatus" = 'PACKAGE' AND "packageId" IS NOT NULL AND "creditConsumed")
    OR ("paymentStatus" IN ('PAID', 'UNPAID') AND "packageId" IS NULL AND NOT "creditConsumed")
    OR ("paymentStatus" = 'REFUNDED' AND NOT "creditConsumed")
  )
);
CREATE UNIQUE INDEX "VenueReservation_id_businessId_key"
  ON "VenueReservation"("id", "businessId");
CREATE INDEX "VenueReservation_businessId_startAt_idx"
  ON "VenueReservation"("businessId", "startAt");
CREATE INDEX "VenueReservation_locationId_startAt_idx"
  ON "VenueReservation"("locationId", "startAt");
CREATE INDEX "VenueReservation_unitId_startAt_endAt_idx"
  ON "VenueReservation"("unitId", "startAt", "endAt");
CREATE INDEX "VenueReservation_userId_startAt_idx"
  ON "VenueReservation"("userId", "startAt");
CREATE INDEX "VenueReservation_packageId_idx"
  ON "VenueReservation"("packageId");
ALTER TABLE "VenueReservation" ADD CONSTRAINT "VenueReservation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VenueReservation" ADD CONSTRAINT "VenueReservation_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId")
  REFERENCES "Location"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "VenueReservation" ADD CONSTRAINT "VenueReservation_unitId_locationId_businessId_fkey"
  FOREIGN KEY ("unitId", "locationId", "businessId")
  REFERENCES "VenueUnit"("id", "locationId", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "VenueReservation" ADD CONSTRAINT "VenueReservation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VenueReservation" ADD CONSTRAINT "VenueReservation_packageId_businessId_fkey"
  FOREIGN KEY ("packageId", "businessId")
  REFERENCES "LessonPackage"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- PostgreSQL's half-open range allows adjacent reservations while preventing
-- two live rows from claiming any shared instant for the same tenant unit. The
-- btree_gist operator classes are installed by the prerequisite migration.
ALTER TABLE "VenueReservation" ADD CONSTRAINT "VenueReservation_active_unit_overlap"
  EXCLUDE USING gist (
    "businessId" WITH =,
    "unitId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" IN ('PENDING', 'CONFIRMED'))
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "PaymentIntent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "packageOfferId" TEXT,
  "participantId" TEXT,
  "reservationId" TEXT,
  "packageId" TEXT,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'SGD',
  "status" TEXT NOT NULL DEFAULT 'REQUIRES_CONFIRMATION',
  "provider" TEXT NOT NULL DEFAULT 'SIMULATED_STRIPE',
  "providerReference" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),

  CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentIntent_kind_check" CHECK ("kind" IN ('PACKAGE', 'BOOKING', 'RENTAL')),
  CONSTRAINT "PaymentIntent_status_check" CHECK (
    "status" IN ('REQUIRES_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED')
  ),
  CONSTRAINT "PaymentIntent_provider_check" CHECK ("provider" = 'SIMULATED_STRIPE'),
  CONSTRAINT "PaymentIntent_amount_check" CHECK ("amount" >= 0),
  CONSTRAINT "PaymentIntent_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "PaymentIntent_reference_check" CHECK (
    btrim("providerReference") <> '' AND btrim("idempotencyKey") <> ''
  ),
  CONSTRAINT "PaymentIntent_target_shape_check" CHECK (
    ("kind" = 'PACKAGE'
      AND "packageOfferId" IS NOT NULL
      AND "participantId" IS NULL
      AND "reservationId" IS NULL)
    OR ("kind" = 'BOOKING'
      AND "packageOfferId" IS NULL
      AND "participantId" IS NOT NULL
      AND "reservationId" IS NULL)
    OR ("kind" = 'RENTAL'
      AND "packageOfferId" IS NULL
      AND "participantId" IS NULL
      AND ("reservationId" IS NOT NULL
        OR "status" IN ('REQUIRES_CONFIRMATION', 'FAILED', 'CANCELLED')))
  ),
  CONSTRAINT "PaymentIntent_package_result_check" CHECK (
    ("kind" = 'PACKAGE'
      AND (("status" IN ('SUCCEEDED', 'REFUNDED') AND "packageId" IS NOT NULL)
        OR ("status" IN ('REQUIRES_CONFIRMATION', 'FAILED', 'CANCELLED') AND "packageId" IS NULL)))
    OR ("kind" <> 'PACKAGE' AND "packageId" IS NULL)
  ),
  CONSTRAINT "PaymentIntent_terminal_time_check" CHECK (
    ("status" IN ('SUCCEEDED', 'REFUNDED') AND "confirmedAt" IS NOT NULL AND "failedAt" IS NULL)
    OR ("status" = 'FAILED' AND "confirmedAt" IS NULL AND "failedAt" IS NOT NULL)
    OR ("status" IN ('REQUIRES_CONFIRMATION', 'CANCELLED') AND "confirmedAt" IS NULL AND "failedAt" IS NULL)
  )
);
CREATE UNIQUE INDEX "PaymentIntent_id_businessId_key"
  ON "PaymentIntent"("id", "businessId");
CREATE UNIQUE INDEX "PaymentIntent_providerReference_key"
  ON "PaymentIntent"("providerReference");
CREATE UNIQUE INDEX "PaymentIntent_userId_idempotencyKey_key"
  ON "PaymentIntent"("userId", "idempotencyKey");
CREATE INDEX "PaymentIntent_businessId_status_createdAt_idx"
  ON "PaymentIntent"("businessId", "status", "createdAt");
CREATE INDEX "PaymentIntent_packageOfferId_idx" ON "PaymentIntent"("packageOfferId");
CREATE INDEX "PaymentIntent_participantId_idx" ON "PaymentIntent"("participantId");
CREATE INDEX "PaymentIntent_reservationId_idx" ON "PaymentIntent"("reservationId");
CREATE INDEX "PaymentIntent_packageId_idx" ON "PaymentIntent"("packageId");

ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_packageOfferId_businessId_fkey"
  FOREIGN KEY ("packageOfferId", "businessId")
  REFERENCES "PackageOffer"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_participantId_fkey"
  FOREIGN KEY ("participantId") REFERENCES "Participant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_reservationId_businessId_fkey"
  FOREIGN KEY ("reservationId", "businessId")
  REFERENCES "VenueReservation"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_packageId_businessId_fkey"
  FOREIGN KEY ("packageId", "businessId")
  REFERENCES "LessonPackage"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Online checkout augments the existing ledger. It neither replaces offline
-- methods nor permits an intent from another tenant to own the payment row.
ALTER TABLE "Payment" ADD COLUMN "paymentIntentId" TEXT;
CREATE UNIQUE INDEX "Payment_paymentIntentId_key" ON "Payment"("paymentIntentId");
CREATE UNIQUE INDEX "Payment_paymentIntentId_businessId_key"
  ON "Payment"("paymentIntentId", "businessId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paymentIntentId_businessId_fkey"
  FOREIGN KEY ("paymentIntentId", "businessId")
  REFERENCES "PaymentIntent"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Workspace integrity alerts now point at the exact review record. Deleting a
-- flag retains the notification copy but clears its action target.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "integrityFlagId" TEXT;
CREATE INDEX IF NOT EXISTS "Notification_integrityFlagId_idx"
  ON "Notification"("integrityFlagId");
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"Notification"'::regclass
      AND conname = 'Notification_integrityFlagId_fkey'
  ) THEN
    ALTER TABLE "Notification" ADD CONSTRAINT "Notification_integrityFlagId_fkey"
      FOREIGN KEY ("integrityFlagId") REFERENCES "IntegrityFlag"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Direct tenant parents introduced here cannot move between businesses. This
-- reuses the trigger function installed by the core-tenancy migration.
CREATE TRIGGER "VenueUnit_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "VenueUnit"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "VenueOpeningHour_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "VenueOpeningHour"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "VenueReservation_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "VenueReservation"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "PackageOffer_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "PackageOffer"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "PaymentIntent_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "PaymentIntent"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();

-- A reservation is the sell-time contract for a specific unit and interval.
-- The application creates that contract in its final paid/package state; its
-- only later mutation is an atomic cancellation that releases any package
-- credit and records the refund. Keep this guard immediate so a transaction
-- cannot temporarily disguise a reservation before rewriting its snapshot.
CREATE FUNCTION "_courtly_protect_venue_reservation_contract"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    OLD."id", OLD."businessId", OLD."locationId", OLD."unitId",
    OLD."userId", OLD."startAt", OLD."endAt", OLD."duration",
    OLD."price", OLD."packageId", OLD."notes", OLD."createdAt"
  ) IS DISTINCT FROM ROW(
    NEW."id", NEW."businessId", NEW."locationId", NEW."unitId",
    NEW."userId", NEW."startAt", NEW."endAt", NEW."duration",
    NEW."price", NEW."packageId", NEW."notes", NEW."createdAt"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A venue reservation contract snapshot is immutable';
  END IF;

  IF ROW(OLD."status", OLD."paymentStatus", OLD."creditConsumed", OLD."cancelledAt")
    IS NOT DISTINCT FROM
    ROW(NEW."status", NEW."paymentStatus", NEW."creditConsumed", NEW."cancelledAt") THEN
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('CONFIRMED', 'PENDING')
    AND OLD."paymentStatus" IN ('PAID', 'PACKAGE', 'UNPAID')
    AND OLD."cancelledAt" IS NULL
    AND NEW."status" = 'CANCELLED'
    AND NEW."paymentStatus" = 'REFUNDED'
    AND NOT NEW."creditConsumed"
    AND NEW."cancelledAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'A venue reservation may only transition atomically to cancelled and refunded';
END;
$$;
CREATE TRIGGER "VenueReservation_contract_snapshot_immutable"
  BEFORE UPDATE ON "VenueReservation" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_venue_reservation_contract"();

-- Row checks cannot prove that a booking participant or rental package belongs
-- to the intent's global account. Enforce those identity joins at commit time
-- while allowing a transaction to construct its related rows in either order.
CREATE FUNCTION "_courtly_assert_payment_intent_owner"(intent_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentIntent" AS intent
    JOIN "Participant" AS participant ON participant."id" = intent."participantId"
    JOIN "Booking" AS booking ON booking."id" = participant."bookingId"
    JOIN "Student" AS student ON student."id" = participant."studentId"
    WHERE intent."id" = intent_id
      AND (booking."businessId" <> intent."businessId"
        OR student."userId" IS DISTINCT FROM intent."userId")
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Booking payment intent must belong to its participant account and business'; END IF;

  IF EXISTS (
    SELECT 1
    FROM "PaymentIntent" AS intent
    JOIN "LessonPackage" AS package ON package."id" = intent."packageId"
    JOIN "PackageOffer" AS offer ON offer."id" = intent."packageOfferId"
    JOIN "Student" AS student ON student."id" = package."studentId"
    WHERE intent."id" = intent_id
      AND (student."userId" IS DISTINCT FROM intent."userId"
        OR package."offerId" IS DISTINCT FROM intent."packageOfferId"
        OR package."price" <> intent."amount"
        OR offer."price" <> intent."amount")
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Package payment intent result must belong to its account and offer'; END IF;

  IF EXISTS (
    SELECT 1
    FROM "PaymentIntent" AS intent
    JOIN "VenueReservation" AS reservation ON reservation."id" = intent."reservationId"
    WHERE intent."id" = intent_id
      AND (reservation."userId" <> intent."userId"
        OR (reservation."packageId" IS NULL AND intent."amount" <> reservation."price")
        OR (reservation."packageId" IS NOT NULL AND intent."amount" <> 0))
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Rental payment intent must belong to its reservation account'; END IF;
END;
$$;

CREATE FUNCTION "_courtly_payment_intent_owner_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_assert_payment_intent_owner"(NEW."id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "PaymentIntent_owner_invariant"
  AFTER INSERT OR UPDATE OF "userId", "businessId", "participantId", "reservationId", "packageId"
  ON "PaymentIntent"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_payment_intent_owner_constraint"();

-- A completed package checkout records the amount charged. Other offer copy
-- and future entitlement settings may evolve, but changing the sold price
-- would make the live offer contradict that immutable checkout evidence.
CREATE FUNCTION "_courtly_lock_package_offer_sale"(offer_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF offer_id IS NOT NULL THEN
    -- Price is not part of the row's key, so KEY SHARE would still allow a
    -- concurrent price update. UPDATE serializes both checkout and repricing.
    PERFORM 1 FROM "PackageOffer" WHERE "id" = offer_id FOR UPDATE;
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_reject_sold_package_offer_price_change"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_lock_package_offer_sale"(OLD."id");
  IF OLD."price" IS DISTINCT FROM NEW."price" AND (
    EXISTS (
      SELECT 1 FROM "PaymentIntent" AS intent
      WHERE intent."businessId" = OLD."businessId"
        AND intent."packageOfferId" = OLD."id"
        AND intent."kind" = 'PACKAGE'
        AND intent."status" IN ('SUCCEEDED', 'REFUNDED')
    )
    OR EXISTS (
      SELECT 1 FROM "LessonPackage" AS package
      WHERE package."businessId" = OLD."businessId"
        AND package."offerId" = OLD."id"
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A sold package offer price is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PackageOffer_sold_price_immutable"
  BEFORE UPDATE OF "price" ON "PackageOffer" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_sold_package_offer_price_change"();

CREATE FUNCTION "_courtly_lock_package_intent_offer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'PACKAGE' THEN
    PERFORM "_courtly_lock_package_offer_sale"(NEW."packageOfferId");
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentIntent_package_offer_sale_lock"
  BEFORE INSERT OR UPDATE OF "kind", "status", "amount", "packageOfferId", "businessId"
  ON "PaymentIntent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_lock_package_intent_offer"();

CREATE FUNCTION "_courtly_recheck_sold_package_offer_price"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'PACKAGE' AND NEW."status" IN ('SUCCEEDED', 'REFUNDED')
    AND EXISTS (
      SELECT 1 FROM "PackageOffer" AS offer
      WHERE offer."id" = NEW."packageOfferId"
        AND offer."businessId" = NEW."businessId"
        AND offer."price" <> NEW."amount"
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A sold package offer price must match its checkout amount';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "PaymentIntent_sold_offer_price_invariant"
  AFTER INSERT OR UPDATE OF "kind", "status", "amount", "packageOfferId", "businessId"
  ON "PaymentIntent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_recheck_sold_package_offer_price"();

CREATE FUNCTION "_courtly_lock_commercial_business"(business_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('commercial-business:' || business_id, 0));
END;
$$;

-- Successful, refunded and failed intents are durable checkout evidence. Once
-- an attempt is terminal, its only valid mutation is SUCCEEDED -> REFUNDED with
-- the exact same contract; FAILED rows reject every update. This immediate
-- guard prevents a caller from disguising or rewriting an attempt and deleting
-- it later in the same transaction. Every write takes the business's
-- commercial lock so terminalization cannot race retirement or teardown; its
-- name sorts before the package-offer lock trigger, preserving commercial ->
-- offer lock order for both checkout and refund writes.
CREATE FUNCTION "_courtly_protect_terminal_payment_intent"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_lock_commercial_business"(OLD."businessId");

  IF OLD."status" IN ('SUCCEEDED', 'REFUNDED', 'FAILED') THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD."status" = 'FAILED'
        OR NOT (NEW."status" = OLD."status"
          OR (OLD."status" = 'SUCCEEDED' AND NEW."status" = 'REFUNDED'))
        OR ROW(
          OLD."id", OLD."userId", OLD."businessId", OLD."kind",
          OLD."packageOfferId", OLD."participantId", OLD."reservationId",
          OLD."packageId", OLD."amount", OLD."currency", OLD."provider",
          OLD."providerReference", OLD."idempotencyKey", OLD."createdAt",
          OLD."confirmedAt", OLD."failedAt"
        ) IS DISTINCT FROM ROW(
          NEW."id", NEW."userId", NEW."businessId", NEW."kind",
          NEW."packageOfferId", NEW."participantId", NEW."reservationId",
          NEW."packageId", NEW."amount", NEW."currency", NEW."provider",
          NEW."providerReference", NEW."idempotencyKey", NEW."createdAt",
          NEW."confirmedAt", NEW."failedAt"
        ) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Terminal checkout intent history is immutable except for successful refunds';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentIntent_commercial_terminal_history_guard"
  BEFORE UPDATE OR DELETE ON "PaymentIntent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_terminal_payment_intent"();

-- Deletion remains deferred because explicit platform teardown removes intent
-- rows before their owning Business. A terminal intent can disappear only
-- when that Business is also absent from the transaction's final state.
CREATE FUNCTION "_courtly_reject_terminal_payment_intent_delete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('SUCCEEDED', 'REFUNDED', 'FAILED') AND EXISTS (
    SELECT 1 FROM "Business" WHERE "id" = OLD."businessId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Terminal checkout intent history is immutable';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "PaymentIntent_terminal_history_immutable"
  AFTER DELETE ON "PaymentIntent"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_terminal_payment_intent_delete"();

-- SOLO is retained only as historical evidence, and a club explicitly marked
-- read-only cannot receive a new contract. Existing rows remain unchanged;
-- the deferred guards below also protect them from later mutation.
CREATE FUNCTION "_courtly_reject_read_only_commercial_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  business_kind TEXT;
  business_read_only BOOLEAN;
BEGIN
  PERFORM "_courtly_lock_commercial_business"(NEW."businessId");
  SELECT "kind", "legacyReadOnly" INTO business_kind, business_read_only
  FROM "Business" WHERE "id" = NEW."businessId";

  IF business_kind IS DISTINCT FROM 'CLUB' OR business_read_only IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = TG_TABLE_NAME || ' cannot create new commercial records for a SOLO or read-only business';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION "_courtly_reject_non_club_booking_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  business_kind TEXT;
  business_read_only BOOLEAN;
BEGIN
  PERFORM "_courtly_lock_commercial_business"(NEW."businessId");
  SELECT "kind", "legacyReadOnly" INTO business_kind, business_read_only
  FROM "Business" WHERE "id" = NEW."businessId";
  IF business_kind IS DISTINCT FROM 'CLUB' OR business_read_only IS DISTINCT FROM false
    OR NEW."paymentRoute" IS DISTINCT FROM 'CLUB' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'New bookings require an active CLUB business and CLUB payment route';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Booking_active_club_insert"
  BEFORE INSERT ON "Booking" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_non_club_booking_insert"();
CREATE TRIGGER "PackageOffer_active_club_insert"
  BEFORE INSERT ON "PackageOffer" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();
CREATE TRIGGER "PaymentIntent_active_club_insert"
  BEFORE INSERT ON "PaymentIntent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();
CREATE TRIGGER "VenueReservation_active_club_insert"
  BEFORE INSERT ON "VenueReservation" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();
CREATE TRIGGER "LessonPackage_active_club_insert"
  BEFORE INSERT ON "LessonPackage" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();
CREATE TRIGGER "Payment_active_club_insert"
  BEFORE INSERT ON "Payment" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();

-- Participant has no businessId column; derive its commercial tenant from
-- the immutable booking parent before accepting a new enrollment.
CREATE FUNCTION "_courtly_reject_read_only_participant_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  booking_business_id TEXT;
  business_kind TEXT;
  business_read_only BOOLEAN;
BEGIN
  SELECT "businessId" INTO booking_business_id
  FROM "Booking" WHERE "id" = NEW."bookingId";
  PERFORM "_courtly_lock_commercial_business"(booking_business_id);
  SELECT "kind", "legacyReadOnly" INTO business_kind, business_read_only
  FROM "Business" WHERE "id" = booking_business_id;
  IF business_kind IS DISTINCT FROM 'CLUB' OR business_read_only IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Participant cannot create new commercial records for a SOLO or read-only business';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Participant_active_club_insert"
  BEFORE INSERT ON "Participant" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_participant_insert"();

CREATE FUNCTION "_courtly_lock_commercial_business_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_lock_commercial_business"(NEW."id");
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Business_commercial_write_lock"
  BEFORE UPDATE OF "kind", "legacyReadOnly", "currency" ON "Business" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_lock_commercial_business_update"();

CREATE FUNCTION "_courtly_reject_legacy_read_only_reactivation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."legacyReadOnly" AND NOT NEW."legacyReadOnly" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A legacy read-only business cannot be reactivated';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Business_legacy_read_only_immutable"
  BEFORE UPDATE OF "legacyReadOnly" ON "Business" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_legacy_read_only_reactivation"();

-- Existing SOLO and explicitly retired club rows are contractual history. A
-- deferred final-state check rejects direct row edits and deletes while still
-- allowing the platform's explicit deep teardown, where the owning Business
-- is absent by commit. It also closes the same-transaction gap where a caller
-- inserts commerce and marks its business read-only before committing.
CREATE FUNCTION "_courtly_assert_commercial_history_writable"(business_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF business_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Business" AS business
    WHERE business."id" = business_id
      AND (business."kind" <> 'CLUB' OR business."legacyReadOnly")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Legacy or read-only commercial history is immutable';
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_commercial_history_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "_courtly_assert_commercial_history_writable"(OLD."businessId");
  ELSE
    PERFORM "_courtly_assert_commercial_history_writable"(NEW."businessId");
    IF TG_OP = 'UPDATE' AND OLD."businessId" IS DISTINCT FROM NEW."businessId" THEN
      PERFORM "_courtly_assert_commercial_history_writable"(OLD."businessId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION "_courtly_participant_history_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_business_id TEXT;
  new_business_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT "businessId" INTO old_business_id FROM "Booking" WHERE "id" = OLD."bookingId";
    PERFORM "_courtly_assert_commercial_history_writable"(old_business_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "businessId" INTO new_business_id FROM "Booking" WHERE "id" = NEW."bookingId";
    PERFORM "_courtly_assert_commercial_history_writable"(new_business_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Booking_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "Booking" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "Payment_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "LessonPackage_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "LessonPackage" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "PackageOffer_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOffer" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "PackageOfferService_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOfferService" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "PackageOfferLocation_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOfferLocation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "LessonPackageService_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "LessonPackageService" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "LessonPackageLocation_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "LessonPackageLocation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "PaymentIntent_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "PaymentIntent" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "VenueReservation_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "VenueReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "RescheduleRequest_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "RescheduleRequest" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
CREATE CONSTRAINT TRIGGER "Participant_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "Participant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_participant_history_constraint"();

-- One serialized catalog-write domain prevents two transactions from each
-- removing the last different scope while both still observe the other. The
-- final-state check remains deferred so an offer and its scopes can be built
-- or retired in any order inside one transaction.
CREATE FUNCTION "_courtly_lock_package_offer_scopes"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200001);
  RETURN NULL;
END;
$$;

CREATE FUNCTION "_courtly_assert_active_package_offer_scopes"()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PackageOffer" AS offer
    WHERE offer."active"
      AND NOT EXISTS (
        SELECT 1
        FROM "PackageOfferService" AS scope
        JOIN "Service" AS service
          ON service."id" = scope."serviceId"
         AND service."businessId" = scope."businessId"
        WHERE scope."offerId" = offer."id"
          AND scope."businessId" = offer."businessId"
          AND service."active"
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "PackageOfferLocation" AS scope
        JOIN "Location" AS location
          ON location."id" = scope."locationId"
         AND location."businessId" = scope."businessId"
        WHERE scope."offerId" = offer."id"
          AND scope."businessId" = offer."businessId"
          AND location."active" AND location."rentalEnabled"
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An active package offer must have at least one active class or rental venue';
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_active_package_offer_scope_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_assert_active_package_offer_scopes"();
  RETURN NULL;
END;
$$;

CREATE TRIGGER "PackageOffer_scope_write_lock" BEFORE INSERT OR UPDATE OR DELETE ON "PackageOffer"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();
CREATE TRIGGER "PackageOfferService_scope_write_lock" BEFORE INSERT OR UPDATE OR DELETE ON "PackageOfferService"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();
CREATE TRIGGER "PackageOfferLocation_scope_write_lock" BEFORE INSERT OR UPDATE OR DELETE ON "PackageOfferLocation"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();
CREATE TRIGGER "Service_offer_scope_write_lock" BEFORE UPDATE OR DELETE ON "Service"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();
CREATE TRIGGER "Location_offer_scope_write_lock" BEFORE UPDATE OR DELETE ON "Location"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();

CREATE CONSTRAINT TRIGGER "PackageOffer_active_scope_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOffer" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();
CREATE CONSTRAINT TRIGGER "PackageOfferService_active_scope_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOfferService" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();
CREATE CONSTRAINT TRIGGER "PackageOfferLocation_active_scope_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOfferLocation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();
CREATE CONSTRAINT TRIGGER "Service_active_offer_scope_invariant"
  AFTER UPDATE OR DELETE ON "Service" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();
CREATE CONSTRAINT TRIGGER "Location_active_offer_scope_invariant"
  AFTER UPDATE OR DELETE ON "Location" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();

-- Offer-backed packages snapshot their sell-time scopes. The parent is created
-- before its nested join rows, so sealing is deferred until commit. The final
-- state must exactly match the offer; after that, immediate child guards make
-- either scope collection immutable while still allowing a parent cascade.
CREATE FUNCTION "_courtly_reject_sealed_package_scope_write"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_sealed BOOLEAN;
  new_sealed BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT "scopeSnapshotSealed" INTO old_sealed
    FROM "LessonPackage" WHERE "id" = OLD."packageId";
    IF old_sealed AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A purchased package scope snapshot is immutable';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT "scopeSnapshotSealed" INTO new_sealed
    FROM "LessonPackage" WHERE "id" = NEW."packageId";
    IF new_sealed THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A purchased package scope snapshot is immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LessonPackageService_scope_snapshot_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "LessonPackageService" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_sealed_package_scope_write"();
CREATE TRIGGER "LessonPackageLocation_scope_snapshot_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "LessonPackageLocation" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_sealed_package_scope_write"();

CREATE FUNCTION "_courtly_reject_package_scope_unseal"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."offerId" IS DISTINCT FROM NEW."offerId"
    OR (OLD."scopeSnapshotSealed" AND NOT NEW."scopeSnapshotSealed") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A purchased package scope snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LessonPackage_scope_snapshot_immutable"
  BEFORE UPDATE OF "offerId", "scopeSnapshotSealed" ON "LessonPackage" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_package_scope_unseal"();

-- An offer-backed package is the contract bought at checkout. Runtime credit
-- use and refund state still move, but its descriptive entitlement snapshot
-- cannot be rewritten later by a manager or a direct database client.
CREATE FUNCTION "_courtly_reject_purchased_package_contract_change"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."offerId" IS NOT NULL AND (
    OLD."studentId" IS DISTINCT FROM NEW."studentId"
    OR OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."serviceId" IS DISTINCT FROM NEW."serviceId"
    OR OLD."totalCredits" IS DISTINCT FROM NEW."totalCredits"
    OR OLD."price" IS DISTINCT FROM NEW."price"
    OR OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A purchased package contract snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LessonPackage_contract_snapshot_immutable"
  BEFORE UPDATE OF "studentId", "name", "serviceId", "totalCredits", "price", "expiresAt"
  ON "LessonPackage" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_purchased_package_contract_change"();

CREATE FUNCTION "_courtly_assert_and_seal_package_scope"(package_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  package_offer_id TEXT;
  package_business_id TEXT;
  package_sealed BOOLEAN;
BEGIN
  SELECT "offerId", "businessId", "scopeSnapshotSealed"
  INTO package_offer_id, package_business_id, package_sealed
  FROM "LessonPackage" WHERE "id" = package_id;
  IF NOT FOUND OR package_offer_id IS NULL THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "LessonPackageService"
    WHERE "packageId" = package_id AND "businessId" = package_business_id
  ) AND NOT EXISTS (
    SELECT 1 FROM "LessonPackageLocation"
    WHERE "packageId" = package_id AND "businessId" = package_business_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A purchased package must snapshot at least one offer scope';
  END IF;

  IF EXISTS (
    (SELECT "serviceId" FROM "PackageOfferService"
      WHERE "offerId" = package_offer_id AND "businessId" = package_business_id
     EXCEPT
     SELECT "serviceId" FROM "LessonPackageService"
      WHERE "packageId" = package_id AND "businessId" = package_business_id)
    UNION ALL
    (SELECT "serviceId" FROM "LessonPackageService"
      WHERE "packageId" = package_id AND "businessId" = package_business_id
     EXCEPT
     SELECT "serviceId" FROM "PackageOfferService"
      WHERE "offerId" = package_offer_id AND "businessId" = package_business_id)
  ) OR EXISTS (
    (SELECT "locationId" FROM "PackageOfferLocation"
      WHERE "offerId" = package_offer_id AND "businessId" = package_business_id
     EXCEPT
     SELECT "locationId" FROM "LessonPackageLocation"
      WHERE "packageId" = package_id AND "businessId" = package_business_id)
    UNION ALL
    (SELECT "locationId" FROM "LessonPackageLocation"
      WHERE "packageId" = package_id AND "businessId" = package_business_id
     EXCEPT
     SELECT "locationId" FROM "PackageOfferLocation"
      WHERE "offerId" = package_offer_id AND "businessId" = package_business_id)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A purchased package must snapshot the exact offer scopes';
  END IF;

  IF NOT package_sealed THEN
    UPDATE "LessonPackage" SET "scopeSnapshotSealed" = true
    WHERE "id" = package_id AND NOT "scopeSnapshotSealed";
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_package_scope_seal_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200001);
  PERFORM "_courtly_assert_and_seal_package_scope"(NEW."id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "LessonPackage_scope_snapshot_seal"
  AFTER INSERT ON "LessonPackage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_package_scope_seal_constraint"();

-- A rental package belongs to the global student account behind its Student
-- row. This cannot be expressed by a simple FK without duplicating mutable
-- account identity onto LessonPackage, so enforce the final joined state.
CREATE FUNCTION "_courtly_assert_rental_package_owners"()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "VenueReservation" AS reservation
    JOIN "LessonPackage" AS package ON package."id" = reservation."packageId"
    JOIN "Student" AS student ON student."id" = package."studentId"
    WHERE reservation."packageId" IS NOT NULL
      AND (package."businessId" <> reservation."businessId"
        OR student."userId" IS DISTINCT FROM reservation."userId"
        OR NOT EXISTS (
          SELECT 1 FROM "LessonPackageLocation" AS scope
          WHERE scope."packageId" = package."id"
            AND scope."businessId" = reservation."businessId"
            AND scope."locationId" = reservation."locationId"
        ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Rental package must belong to the reservation account';
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_rental_package_owner_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200002);
  PERFORM "_courtly_assert_rental_package_owners"();
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "VenueReservation_package_owner_invariant"
  AFTER INSERT OR UPDATE ON "VenueReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_rental_package_owner_constraint"();
CREATE CONSTRAINT TRIGGER "LessonPackage_reservation_owner_invariant"
  AFTER UPDATE OF "studentId", "businessId" ON "LessonPackage" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_rental_package_owner_constraint"();
CREATE CONSTRAINT TRIGGER "Student_reservation_package_owner_invariant"
  AFTER UPDATE OF "userId", "businessId" ON "Student" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_rental_package_owner_constraint"();
CREATE CONSTRAINT TRIGGER "LessonPackageLocation_reservation_owner_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "LessonPackageLocation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_rental_package_owner_constraint"();

-- A linked ledger row is the result of exactly that simulated checkout, not
-- merely an arbitrary row from the same tenant. Deferred checking permits the
-- intent and payment to be created or refunded in either order in one atomic
-- transaction.
CREATE FUNCTION "_courtly_assert_checkout_payment_correspondence"()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentIntent" AS intent
    JOIN "Business" AS business ON business."id" = intent."businessId"
    WHERE intent."status" IN ('SUCCEEDED', 'REFUNDED')
      AND intent."currency" <> business."currency"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Business currency must match completed checkout intent history';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PaymentIntent" AS intent
    JOIN "User" AS account ON account."id" = intent."userId"
    LEFT JOIN "VenueReservation" AS reservation ON reservation."id" = intent."reservationId"
    WHERE intent."status" IN ('SUCCEEDED', 'REFUNDED')
      AND (
        (intent."kind" IN ('PACKAGE', 'BOOKING')
          AND (SELECT count(*) FROM "Payment" AS payment
            WHERE payment."paymentIntentId" = intent."id") <> 1)
        OR (intent."kind" = 'RENTAL'
          AND account."accountType" = 'STUDENT'
          AND intent."amount" > 0
          AND reservation."packageId" IS NULL
          AND (SELECT count(*) FROM "Payment" AS payment
            WHERE payment."paymentIntentId" = intent."id") <> 1)
        OR (intent."kind" = 'RENTAL'
          AND (account."accountType" <> 'STUDENT'
            OR intent."amount" = 0 OR reservation."packageId" IS NOT NULL)
          AND EXISTS (SELECT 1 FROM "Payment" AS payment
            WHERE payment."paymentIntentId" = intent."id"))
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A successful checkout intent must have the required payment result';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Payment" AS payment
    JOIN "PaymentIntent" AS intent ON intent."id" = payment."paymentIntentId"
    JOIN "Business" AS business ON business."id" = payment."businessId"
    LEFT JOIN "Student" AS student ON student."id" = payment."studentId"
    LEFT JOIN "Participant" AS participant ON participant."id" = intent."participantId"
    LEFT JOIN "Booking" AS booking ON booking."id" = participant."bookingId"
    LEFT JOIN "LessonPackage" AS package ON package."id" = intent."packageId"
    LEFT JOIN "VenueReservation" AS reservation ON reservation."id" = intent."reservationId"
    WHERE payment."paymentIntentId" IS NOT NULL
      AND (intent."businessId" <> payment."businessId"
        OR intent."provider" <> 'SIMULATED_STRIPE'
        OR payment."method" <> 'SIMULATED_STRIPE'
        OR intent."amount" <> payment."amount"
        OR intent."currency" <> business."currency"
        OR student."userId" IS DISTINCT FROM intent."userId"
        OR NOT ((intent."status" = 'SUCCEEDED' AND payment."reversedAt" IS NULL)
          OR (intent."status" = 'REFUNDED' AND payment."reversedAt" IS NOT NULL))
        OR CASE intent."kind"
          WHEN 'PACKAGE' THEN NOT (
            intent."packageId" IS NOT NULL
            AND package."offerId" = intent."packageOfferId"
            AND package."price" = intent."amount"
            AND payment."packageId" = intent."packageId"
            AND payment."studentId" = package."studentId"
            AND payment."bookingId" IS NULL
            AND payment."kind" = 'STUDENT_TO_CLUB')
          WHEN 'BOOKING' THEN NOT (
            intent."participantId" IS NOT NULL
            AND payment."bookingId" = participant."bookingId"
            AND payment."studentId" = participant."studentId"
            AND payment."packageId" IS NULL
            AND payment."kind" = CASE booking."paymentRoute"
              WHEN 'CLUB' THEN 'STUDENT_TO_CLUB' ELSE 'STUDENT_TO_COACH' END)
          WHEN 'RENTAL' THEN NOT (
            intent."reservationId" IS NOT NULL
            AND reservation."userId" = intent."userId"
            AND intent."amount" = CASE WHEN reservation."packageId" IS NULL
              THEN reservation."price" ELSE 0 END
            AND payment."bookingId" IS NULL
            AND payment."packageId" IS NULL
            AND payment."kind" = 'STUDENT_TO_CLUB')
          ELSE true
        END)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payment must exactly match its successful simulated checkout intent';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PaymentIntent" AS intent
    JOIN "LessonPackage" AS package ON package."id" = intent."packageId"
    WHERE intent."kind" = 'PACKAGE'
      AND intent."status" IN ('SUCCEEDED', 'REFUNDED')
      AND package."paid" IS DISTINCT FROM (intent."status" = 'SUCCEEDED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A purchased package paid state must match its checkout state';
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_checkout_payment_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200003);
  PERFORM "_courtly_assert_checkout_payment_correspondence"();
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Payment_checkout_intent_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
CREATE CONSTRAINT TRIGGER "PaymentIntent_checkout_payment_invariant"
  AFTER INSERT OR UPDATE ON "PaymentIntent" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
CREATE CONSTRAINT TRIGGER "Participant_checkout_payment_invariant"
  AFTER UPDATE ON "Participant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
CREATE CONSTRAINT TRIGGER "LessonPackage_checkout_payment_invariant"
  AFTER UPDATE ON "LessonPackage" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
CREATE CONSTRAINT TRIGGER "Student_checkout_payment_invariant"
  AFTER UPDATE ON "Student" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
CREATE CONSTRAINT TRIGGER "Booking_checkout_payment_invariant"
  AFTER UPDATE ON "Booking" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
CREATE CONSTRAINT TRIGGER "Business_checkout_payment_invariant"
  AFTER UPDATE ON "Business" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
CREATE CONSTRAINT TRIGGER "VenueReservation_checkout_payment_invariant"
  AFTER UPDATE ON "VenueReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();

-- Reverse-side identity changes must re-evaluate the intent they can detach
-- from its account even when the PaymentIntent row itself is untouched.
CREATE FUNCTION "_courtly_recheck_reservation_intent_owners"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent_record RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200004);
  FOR intent_record IN SELECT "id" FROM "PaymentIntent" WHERE "reservationId" = NEW."id" LOOP
    PERFORM "_courtly_assert_payment_intent_owner"(intent_record."id");
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "_courtly_recheck_participant_intent_owners"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent_record RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200004);
  FOR intent_record IN SELECT "id" FROM "PaymentIntent" WHERE "participantId" = NEW."id" LOOP
    PERFORM "_courtly_assert_payment_intent_owner"(intent_record."id");
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE FUNCTION "_courtly_recheck_student_intent_owners"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent_record RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200004);
  FOR intent_record IN
    SELECT intent."id"
    FROM "PaymentIntent" AS intent
    LEFT JOIN "Participant" AS participant ON participant."id" = intent."participantId"
    LEFT JOIN "LessonPackage" AS package ON package."id" = intent."packageId"
    WHERE participant."studentId" = NEW."id" OR package."studentId" = NEW."id"
  LOOP
    PERFORM "_courtly_assert_payment_intent_owner"(intent_record."id");
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "VenueReservation_intent_owner_invariant"
  AFTER UPDATE OF "userId", "businessId" ON "VenueReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_recheck_reservation_intent_owners"();
CREATE CONSTRAINT TRIGGER "Participant_intent_owner_invariant"
  AFTER UPDATE OF "studentId" ON "Participant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_recheck_participant_intent_owners"();
CREATE CONSTRAINT TRIGGER "Student_intent_owner_invariant"
  AFTER UPDATE OF "userId" ON "Student" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_recheck_student_intent_owners"();

-- Personal calendar grants belong only to global people. This correction is
-- installed here rather than rewriting the already-released Calendar migration.
-- Lock both sides before auditing so enforcement cannot be installed around a
-- concurrently-created invalid link; User has remained locked since BEGIN.
LOCK TABLE "CalendarConnection" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "CalendarConnection" AS connection
    JOIN "User" AS account ON account."id" = connection."userId"
    WHERE account."accountType" NOT IN ('STUDENT', 'COACH')
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce calendar connection identities: a CalendarConnection.userId points to an account other than STUDENT or COACH';
  END IF;
END $$;

CREATE FUNCTION "_courtly_assert_calendar_connection_account_types"()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "CalendarConnection" AS connection
    JOIN "User" AS account ON account."id" = connection."userId"
    WHERE account."accountType" NOT IN ('STUDENT', 'COACH')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'CalendarConnection.userId must reference a STUDENT or COACH account';
  END IF;
END;
$$;

CREATE FUNCTION "_courtly_calendar_connection_account_type_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_assert_calendar_connection_account_types"();
  RETURN NULL;
END;
$$;

-- User writes already take this lock through User_account_shape_write_lock.
-- CalendarConnection joins that domain so a relink cannot race an account-type
-- change and leave either transaction observing only the other's old state.
CREATE TRIGGER "CalendarConnection_account_shape_write_lock"
  BEFORE INSERT OR UPDATE OF "userId" ON "CalendarConnection"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();

CREATE CONSTRAINT TRIGGER "CalendarConnection_user_account_type_invariant"
  AFTER INSERT OR UPDATE OF "userId" ON "CalendarConnection"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_calendar_connection_account_type_constraint"();
CREATE CONSTRAINT TRIGGER "User_calendar_connection_account_type_invariant"
  AFTER UPDATE OF "accountType" ON "User"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_calendar_connection_account_type_constraint"();

COMMIT;
