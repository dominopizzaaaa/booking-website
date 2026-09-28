-- Repair databases that applied an early marketplace migration, then add
-- first-class, email-bound coach invitations. All changes are forward-only.
BEGIN;

SET LOCAL lock_timeout = '10s';
LOCK TABLE
  "Business", "User", "Membership", "Instructor", "Location",
  "Service", "Student", "LessonPackage", "LessonPackageService",
  "LessonPackageLocation", "PackageOffer", "PackageOfferService",
  "PackageOfferLocation", "VenueUnit", "VenueReservation",
  "PaymentIntent", "Payment", "Booking", "Participant",
  "RescheduleRequest", "CalendarConnection"
  IN SHARE ROW EXCLUSIVE MODE;

UPDATE "Business" SET "legacyReadOnly" = true WHERE "kind" = 'SOLO';

-- Business already has deferred account-shape and commercial-integrity
-- triggers. Flush this backfill before altering the table; PostgreSQL refuses
-- ALTER TABLE while those trigger events are pending.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname='Business_solo_legacy_read_only_check') THEN
    ALTER TABLE "Business" ADD CONSTRAINT "Business_solo_legacy_read_only_check"
      CHECK ("kind" <> 'SOLO' OR "legacyReadOnly");
  END IF;
END $$;

ALTER TABLE "LessonPackage"
  ADD COLUMN IF NOT EXISTS "scopeSnapshotSealed" BOOLEAN NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname='LessonPackage_scope_seal_shape_check') THEN
    ALTER TABLE "LessonPackage" ADD CONSTRAINT "LessonPackage_scope_seal_shape_check" CHECK ("offerId" IS NOT NULL OR NOT "scopeSnapshotSealed");
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "VenueUnit_id_locationId_businessId_key"
  ON "VenueUnit"("id", "locationId", "businessId");
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "VenueReservation" AS reservation
    LEFT JOIN "VenueUnit" AS unit
      ON unit."id"=reservation."unitId"
      AND unit."locationId"=reservation."locationId"
      AND unit."businessId"=reservation."businessId"
    WHERE unit."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot repair venue reservation identity: a reservation points to a unit at another location';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname='VenueReservation_unitId_businessId_fkey') THEN
    ALTER TABLE "VenueReservation" DROP CONSTRAINT "VenueReservation_unitId_businessId_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace=current_schema()::regnamespace AND conname='VenueReservation_unitId_locationId_businessId_fkey') THEN
    ALTER TABLE "VenueReservation" ADD CONSTRAINT "VenueReservation_unitId_locationId_businessId_fkey"
      FOREIGN KEY ("unitId", "locationId", "businessId")
      REFERENCES "VenueUnit"("id", "locationId", "businessId")
      ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- A reservation is the sell-time contract for a specific unit and interval.
-- The application creates that contract in its final paid/package state; its
-- only later mutation is an atomic cancellation that releases any package
-- credit and records the refund. Keep this guard immediate so a transaction
-- cannot temporarily disguise a reservation before rewriting its snapshot.
CREATE OR REPLACE FUNCTION "_courtly_protect_venue_reservation_contract"()
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
DROP TRIGGER IF EXISTS "VenueReservation_contract_snapshot_immutable" ON "VenueReservation";
CREATE TRIGGER "VenueReservation_contract_snapshot_immutable"
  BEFORE UPDATE ON "VenueReservation" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_venue_reservation_contract"();
-- A completed package checkout records the amount charged. Other offer copy
-- and future entitlement settings may evolve, but changing the sold price
-- would make the live offer contradict that immutable checkout evidence.
CREATE OR REPLACE FUNCTION "_courtly_lock_package_offer_sale"(offer_id TEXT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF offer_id IS NOT NULL THEN
    -- Price is not part of the row's key, so KEY SHARE would still allow a
    -- concurrent price update. UPDATE serializes both checkout and repricing.
    PERFORM 1 FROM "PackageOffer" WHERE "id" = offer_id FOR UPDATE;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "_courtly_reject_sold_package_offer_price_change"()
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
DROP TRIGGER IF EXISTS "PackageOffer_sold_price_immutable" ON "PackageOffer";
CREATE TRIGGER "PackageOffer_sold_price_immutable"
  BEFORE UPDATE OF "price" ON "PackageOffer" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_sold_package_offer_price_change"();

CREATE OR REPLACE FUNCTION "_courtly_lock_package_intent_offer"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'PACKAGE' THEN
    PERFORM "_courtly_lock_package_offer_sale"(NEW."packageOfferId");
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "PaymentIntent_package_offer_sale_lock" ON "PaymentIntent";
CREATE TRIGGER "PaymentIntent_package_offer_sale_lock"
  BEFORE INSERT OR UPDATE OF "kind", "status", "amount", "packageOfferId", "businessId"
  ON "PaymentIntent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_lock_package_intent_offer"();

CREATE OR REPLACE FUNCTION "_courtly_recheck_sold_package_offer_price"()
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
DROP TRIGGER IF EXISTS "PaymentIntent_sold_offer_price_invariant" ON "PaymentIntent";
CREATE CONSTRAINT TRIGGER "PaymentIntent_sold_offer_price_invariant"
  AFTER INSERT OR UPDATE OF "kind", "status", "amount", "packageOfferId", "businessId"
  ON "PaymentIntent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_recheck_sold_package_offer_price"();

CREATE OR REPLACE FUNCTION "_courtly_lock_commercial_business"(business_id TEXT)
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
CREATE OR REPLACE FUNCTION "_courtly_protect_terminal_payment_intent"()
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
DROP TRIGGER IF EXISTS "PaymentIntent_commercial_terminal_history_guard" ON "PaymentIntent";
CREATE TRIGGER "PaymentIntent_commercial_terminal_history_guard"
  BEFORE UPDATE OR DELETE ON "PaymentIntent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_terminal_payment_intent"();

-- Deletion remains deferred because explicit platform teardown removes intent
-- rows before their owning Business. A terminal intent can disappear only
-- when that Business is also absent from the transaction's final state.
CREATE OR REPLACE FUNCTION "_courtly_reject_terminal_payment_intent_delete"()
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
DROP TRIGGER IF EXISTS "PaymentIntent_terminal_history_immutable" ON "PaymentIntent";
CREATE CONSTRAINT TRIGGER "PaymentIntent_terminal_history_immutable"
  AFTER DELETE ON "PaymentIntent"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_terminal_payment_intent_delete"();

-- SOLO is retained only as historical evidence, and a club explicitly marked
-- read-only cannot receive a new contract. Existing rows remain unchanged;
-- the deferred guards below also protect them from later mutation.
CREATE OR REPLACE FUNCTION "_courtly_reject_read_only_commercial_insert"()
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

CREATE OR REPLACE FUNCTION "_courtly_reject_non_club_booking_insert"()
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

DROP TRIGGER IF EXISTS "Booking_active_club_insert" ON "Booking";
CREATE TRIGGER "Booking_active_club_insert"
  BEFORE INSERT ON "Booking" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_non_club_booking_insert"();
DROP TRIGGER IF EXISTS "PackageOffer_active_club_insert" ON "PackageOffer";
CREATE TRIGGER "PackageOffer_active_club_insert"
  BEFORE INSERT ON "PackageOffer" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();
DROP TRIGGER IF EXISTS "PaymentIntent_active_club_insert" ON "PaymentIntent";
CREATE TRIGGER "PaymentIntent_active_club_insert"
  BEFORE INSERT ON "PaymentIntent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();
DROP TRIGGER IF EXISTS "VenueReservation_active_club_insert" ON "VenueReservation";
CREATE TRIGGER "VenueReservation_active_club_insert"
  BEFORE INSERT ON "VenueReservation" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();
DROP TRIGGER IF EXISTS "LessonPackage_active_club_insert" ON "LessonPackage";
CREATE TRIGGER "LessonPackage_active_club_insert"
  BEFORE INSERT ON "LessonPackage" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();
DROP TRIGGER IF EXISTS "Payment_active_club_insert" ON "Payment";
CREATE TRIGGER "Payment_active_club_insert"
  BEFORE INSERT ON "Payment" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_commercial_insert"();

-- Participant has no businessId column; derive its commercial tenant from
-- the immutable booking parent before accepting a new enrollment.
CREATE OR REPLACE FUNCTION "_courtly_reject_read_only_participant_insert"()
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
DROP TRIGGER IF EXISTS "Participant_active_club_insert" ON "Participant";
CREATE TRIGGER "Participant_active_club_insert"
  BEFORE INSERT ON "Participant" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_read_only_participant_insert"();

CREATE OR REPLACE FUNCTION "_courtly_lock_commercial_business_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_lock_commercial_business"(NEW."id");
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Business_commercial_write_lock" ON "Business";
CREATE TRIGGER "Business_commercial_write_lock"
  BEFORE UPDATE OF "kind", "legacyReadOnly", "currency" ON "Business" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_lock_commercial_business_update"();

CREATE OR REPLACE FUNCTION "_courtly_reject_legacy_read_only_reactivation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."legacyReadOnly" AND NOT NEW."legacyReadOnly" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A legacy read-only business cannot be reactivated';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "Business_legacy_read_only_immutable" ON "Business";
CREATE TRIGGER "Business_legacy_read_only_immutable"
  BEFORE UPDATE OF "legacyReadOnly" ON "Business" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_legacy_read_only_reactivation"();

-- Existing SOLO and explicitly retired club rows are contractual history. A
-- deferred final-state check rejects direct row edits and deletes while still
-- allowing the platform's explicit deep teardown, where the owning Business
-- is absent by commit. It also closes the same-transaction gap where a caller
-- inserts commerce and marks its business read-only before committing.
CREATE OR REPLACE FUNCTION "_courtly_assert_commercial_history_writable"(business_id TEXT)
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

CREATE OR REPLACE FUNCTION "_courtly_commercial_history_constraint"()
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

CREATE OR REPLACE FUNCTION "_courtly_participant_history_constraint"()
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

DROP TRIGGER IF EXISTS "Booking_read_only_history_immutable" ON "Booking";
CREATE CONSTRAINT TRIGGER "Booking_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "Booking" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "Payment_read_only_history_immutable" ON "Payment";
CREATE CONSTRAINT TRIGGER "Payment_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "LessonPackage_read_only_history_immutable" ON "LessonPackage";
CREATE CONSTRAINT TRIGGER "LessonPackage_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "LessonPackage" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "PackageOffer_read_only_history_immutable" ON "PackageOffer";
CREATE CONSTRAINT TRIGGER "PackageOffer_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOffer" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "PackageOfferService_read_only_history_immutable" ON "PackageOfferService";
CREATE CONSTRAINT TRIGGER "PackageOfferService_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOfferService" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "PackageOfferLocation_read_only_history_immutable" ON "PackageOfferLocation";
CREATE CONSTRAINT TRIGGER "PackageOfferLocation_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOfferLocation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "LessonPackageService_read_only_history_immutable" ON "LessonPackageService";
CREATE CONSTRAINT TRIGGER "LessonPackageService_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "LessonPackageService" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "LessonPackageLocation_read_only_history_immutable" ON "LessonPackageLocation";
CREATE CONSTRAINT TRIGGER "LessonPackageLocation_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "LessonPackageLocation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "PaymentIntent_read_only_history_immutable" ON "PaymentIntent";
CREATE CONSTRAINT TRIGGER "PaymentIntent_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "PaymentIntent" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "VenueReservation_read_only_history_immutable" ON "VenueReservation";
CREATE CONSTRAINT TRIGGER "VenueReservation_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "VenueReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "RescheduleRequest_read_only_history_immutable" ON "RescheduleRequest";
CREATE CONSTRAINT TRIGGER "RescheduleRequest_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "RescheduleRequest" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_commercial_history_constraint"();
DROP TRIGGER IF EXISTS "Participant_read_only_history_immutable" ON "Participant";
CREATE CONSTRAINT TRIGGER "Participant_read_only_history_immutable"
  AFTER INSERT OR UPDATE OR DELETE ON "Participant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_participant_history_constraint"();

-- One serialized catalog-write domain prevents two transactions from each
-- removing the last different scope while both still observe the other. The
-- final-state check remains deferred so an offer and its scopes can be built
-- or retired in any order inside one transaction.
CREATE OR REPLACE FUNCTION "_courtly_lock_package_offer_scopes"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200001);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION "_courtly_assert_active_package_offer_scopes"()
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

CREATE OR REPLACE FUNCTION "_courtly_active_package_offer_scope_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_assert_active_package_offer_scopes"();
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "PackageOffer_scope_write_lock" ON "PackageOffer";
CREATE TRIGGER "PackageOffer_scope_write_lock" BEFORE INSERT OR UPDATE OR DELETE ON "PackageOffer"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();
DROP TRIGGER IF EXISTS "PackageOfferService_scope_write_lock" ON "PackageOfferService";
CREATE TRIGGER "PackageOfferService_scope_write_lock" BEFORE INSERT OR UPDATE OR DELETE ON "PackageOfferService"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();
DROP TRIGGER IF EXISTS "PackageOfferLocation_scope_write_lock" ON "PackageOfferLocation";
CREATE TRIGGER "PackageOfferLocation_scope_write_lock" BEFORE INSERT OR UPDATE OR DELETE ON "PackageOfferLocation"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();
DROP TRIGGER IF EXISTS "Service_offer_scope_write_lock" ON "Service";
CREATE TRIGGER "Service_offer_scope_write_lock" BEFORE UPDATE OR DELETE ON "Service"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();
DROP TRIGGER IF EXISTS "Location_offer_scope_write_lock" ON "Location";
CREATE TRIGGER "Location_offer_scope_write_lock" BEFORE UPDATE OR DELETE ON "Location"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_package_offer_scopes"();

DROP TRIGGER IF EXISTS "PackageOffer_active_scope_invariant" ON "PackageOffer";
CREATE CONSTRAINT TRIGGER "PackageOffer_active_scope_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOffer" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();
DROP TRIGGER IF EXISTS "PackageOfferService_active_scope_invariant" ON "PackageOfferService";
CREATE CONSTRAINT TRIGGER "PackageOfferService_active_scope_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOfferService" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();
DROP TRIGGER IF EXISTS "PackageOfferLocation_active_scope_invariant" ON "PackageOfferLocation";
CREATE CONSTRAINT TRIGGER "PackageOfferLocation_active_scope_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "PackageOfferLocation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();
DROP TRIGGER IF EXISTS "Service_active_offer_scope_invariant" ON "Service";
CREATE CONSTRAINT TRIGGER "Service_active_offer_scope_invariant"
  AFTER UPDATE OR DELETE ON "Service" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();
DROP TRIGGER IF EXISTS "Location_active_offer_scope_invariant" ON "Location";
CREATE CONSTRAINT TRIGGER "Location_active_offer_scope_invariant"
  AFTER UPDATE OR DELETE ON "Location" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_active_package_offer_scope_constraint"();

-- Offer-backed packages snapshot their sell-time scopes. The parent is created
-- before its nested join rows, so sealing is deferred until commit. The final
-- state must exactly match the offer; after that, immediate child guards make
-- either scope collection immutable while still allowing a parent cascade.
CREATE OR REPLACE FUNCTION "_courtly_reject_sealed_package_scope_write"()
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
DROP TRIGGER IF EXISTS "LessonPackageService_scope_snapshot_immutable" ON "LessonPackageService";
CREATE TRIGGER "LessonPackageService_scope_snapshot_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "LessonPackageService" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_sealed_package_scope_write"();
DROP TRIGGER IF EXISTS "LessonPackageLocation_scope_snapshot_immutable" ON "LessonPackageLocation";
CREATE TRIGGER "LessonPackageLocation_scope_snapshot_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "LessonPackageLocation" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_sealed_package_scope_write"();

CREATE OR REPLACE FUNCTION "_courtly_reject_package_scope_unseal"()
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
DROP TRIGGER IF EXISTS "LessonPackage_scope_snapshot_immutable" ON "LessonPackage";
CREATE TRIGGER "LessonPackage_scope_snapshot_immutable"
  BEFORE UPDATE OF "offerId", "scopeSnapshotSealed" ON "LessonPackage" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_package_scope_unseal"();

-- An offer-backed package is the contract bought at checkout. Runtime credit
-- use and refund state still move, but its descriptive entitlement snapshot
-- cannot be rewritten later by a manager or a direct database client.
CREATE OR REPLACE FUNCTION "_courtly_reject_purchased_package_contract_change"()
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
DROP TRIGGER IF EXISTS "LessonPackage_contract_snapshot_immutable" ON "LessonPackage";
CREATE TRIGGER "LessonPackage_contract_snapshot_immutable"
  BEFORE UPDATE OF "studentId", "name", "serviceId", "totalCredits", "price", "expiresAt"
  ON "LessonPackage" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_purchased_package_contract_change"();

CREATE OR REPLACE FUNCTION "_courtly_assert_and_seal_package_scope"(package_id TEXT)
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

CREATE OR REPLACE FUNCTION "_courtly_package_scope_seal_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200001);
  PERFORM "_courtly_assert_and_seal_package_scope"(NEW."id");
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "LessonPackage_scope_snapshot_seal" ON "LessonPackage";
CREATE CONSTRAINT TRIGGER "LessonPackage_scope_snapshot_seal"
  AFTER INSERT ON "LessonPackage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_package_scope_seal_constraint"();

-- A rental package belongs to the global student account behind its Student
-- row. This cannot be expressed by a simple FK without duplicating mutable
-- account identity onto LessonPackage, so enforce the final joined state.
CREATE OR REPLACE FUNCTION "_courtly_assert_rental_package_owners"()
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

CREATE OR REPLACE FUNCTION "_courtly_rental_package_owner_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200002);
  PERFORM "_courtly_assert_rental_package_owners"();
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "VenueReservation_package_owner_invariant" ON "VenueReservation";
CREATE CONSTRAINT TRIGGER "VenueReservation_package_owner_invariant"
  AFTER INSERT OR UPDATE ON "VenueReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_rental_package_owner_constraint"();
DROP TRIGGER IF EXISTS "LessonPackage_reservation_owner_invariant" ON "LessonPackage";
CREATE CONSTRAINT TRIGGER "LessonPackage_reservation_owner_invariant"
  AFTER UPDATE OF "studentId", "businessId" ON "LessonPackage" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_rental_package_owner_constraint"();
DROP TRIGGER IF EXISTS "Student_reservation_package_owner_invariant" ON "Student";
CREATE CONSTRAINT TRIGGER "Student_reservation_package_owner_invariant"
  AFTER UPDATE OF "userId", "businessId" ON "Student" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_rental_package_owner_constraint"();
DROP TRIGGER IF EXISTS "LessonPackageLocation_reservation_owner_invariant" ON "LessonPackageLocation";
CREATE CONSTRAINT TRIGGER "LessonPackageLocation_reservation_owner_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "LessonPackageLocation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_rental_package_owner_constraint"();

-- A linked ledger row is the result of exactly that simulated checkout, not
-- merely an arbitrary row from the same tenant. Deferred checking permits the
-- intent and payment to be created or refunded in either order in one atomic
-- transaction.
CREATE OR REPLACE FUNCTION "_courtly_assert_checkout_payment_correspondence"()
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

CREATE OR REPLACE FUNCTION "_courtly_checkout_payment_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260925, 200003);
  PERFORM "_courtly_assert_checkout_payment_correspondence"();
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS "Payment_checkout_intent_invariant" ON "Payment";
CREATE CONSTRAINT TRIGGER "Payment_checkout_intent_invariant"
  AFTER INSERT OR UPDATE OR DELETE ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
DROP TRIGGER IF EXISTS "PaymentIntent_checkout_payment_invariant" ON "PaymentIntent";
CREATE CONSTRAINT TRIGGER "PaymentIntent_checkout_payment_invariant"
  AFTER INSERT OR UPDATE ON "PaymentIntent" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
DROP TRIGGER IF EXISTS "Participant_checkout_payment_invariant" ON "Participant";
CREATE CONSTRAINT TRIGGER "Participant_checkout_payment_invariant"
  AFTER UPDATE ON "Participant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
DROP TRIGGER IF EXISTS "LessonPackage_checkout_payment_invariant" ON "LessonPackage";
CREATE CONSTRAINT TRIGGER "LessonPackage_checkout_payment_invariant"
  AFTER UPDATE ON "LessonPackage" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
DROP TRIGGER IF EXISTS "Student_checkout_payment_invariant" ON "Student";
CREATE CONSTRAINT TRIGGER "Student_checkout_payment_invariant"
  AFTER UPDATE ON "Student" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
DROP TRIGGER IF EXISTS "Booking_checkout_payment_invariant" ON "Booking";
CREATE CONSTRAINT TRIGGER "Booking_checkout_payment_invariant"
  AFTER UPDATE ON "Booking" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
DROP TRIGGER IF EXISTS "Business_checkout_payment_invariant" ON "Business";
CREATE CONSTRAINT TRIGGER "Business_checkout_payment_invariant"
  AFTER UPDATE ON "Business" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();
DROP TRIGGER IF EXISTS "VenueReservation_checkout_payment_invariant" ON "VenueReservation";
CREATE CONSTRAINT TRIGGER "VenueReservation_checkout_payment_invariant"
  AFTER UPDATE ON "VenueReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_checkout_payment_constraint"();

-- Reverse-side identity changes must re-evaluate the intent they can detach
-- from its account even when the PaymentIntent row itself is untouched.
CREATE OR REPLACE FUNCTION "_courtly_recheck_reservation_intent_owners"()
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
CREATE OR REPLACE FUNCTION "_courtly_recheck_participant_intent_owners"()
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
CREATE OR REPLACE FUNCTION "_courtly_recheck_student_intent_owners"()
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
DROP TRIGGER IF EXISTS "VenueReservation_intent_owner_invariant" ON "VenueReservation";
CREATE CONSTRAINT TRIGGER "VenueReservation_intent_owner_invariant"
  AFTER UPDATE OF "userId", "businessId" ON "VenueReservation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_recheck_reservation_intent_owners"();
DROP TRIGGER IF EXISTS "Participant_intent_owner_invariant" ON "Participant";
CREATE CONSTRAINT TRIGGER "Participant_intent_owner_invariant"
  AFTER UPDATE OF "studentId" ON "Participant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_recheck_participant_intent_owners"();
DROP TRIGGER IF EXISTS "Student_intent_owner_invariant" ON "Student";
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

CREATE OR REPLACE FUNCTION "_courtly_assert_calendar_connection_account_types"()
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

CREATE OR REPLACE FUNCTION "_courtly_calendar_connection_account_type_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_assert_calendar_connection_account_types"();
  RETURN NULL;
END;
$$;

-- User writes already take this lock through User_account_shape_write_lock.
-- CalendarConnection joins that domain so a relink cannot race an account-type
-- change and leave either transaction observing only the other's old state.
DROP TRIGGER IF EXISTS "CalendarConnection_account_shape_write_lock" ON "CalendarConnection";
CREATE TRIGGER "CalendarConnection_account_shape_write_lock"
  BEFORE INSERT OR UPDATE OF "userId" ON "CalendarConnection"
  FOR EACH STATEMENT EXECUTE FUNCTION "_courtly_lock_account_shape_writes"();

DROP TRIGGER IF EXISTS "CalendarConnection_user_account_type_invariant" ON "CalendarConnection";
CREATE CONSTRAINT TRIGGER "CalendarConnection_user_account_type_invariant"
  AFTER INSERT OR UPDATE OF "userId" ON "CalendarConnection"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_calendar_connection_account_type_constraint"();
DROP TRIGGER IF EXISTS "User_calendar_connection_account_type_invariant" ON "User";
CREATE CONSTRAINT TRIGGER "User_calendar_connection_account_type_invariant"
  AFTER UPDATE OF "accountType" ON "User"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_calendar_connection_account_type_constraint"();

-- Validate and seal any offer-backed packages created while the old migration
-- shape was active. This aborts instead of inventing contractual scope.
DO $$
DECLARE package_record RECORD;
BEGIN
  FOR package_record IN SELECT "id" FROM "LessonPackage" WHERE "offerId" IS NOT NULL LOOP
    PERFORM "_courtly_assert_and_seal_package_scope"(package_record."id");
  END LOOP;
END $$;

CREATE TABLE "CoachInvitation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "rescheduleNoticeHours" INTEGER NOT NULL DEFAULT 24,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptedByUserId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CoachInvitation_email_check" CHECK (btrim("email") = lower(btrim("email")) AND btrim("email") <> ''),
  CONSTRAINT "CoachInvitation_notice_check" CHECK ("rescheduleNoticeHours" BETWEEN 0 AND 720),
  CONSTRAINT "CoachInvitation_terminal_shape_check" CHECK (
    NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
    AND (("acceptedAt" IS NULL AND "acceptedByUserId" IS NULL) OR ("acceptedAt" IS NOT NULL AND "acceptedByUserId" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "CoachInvitation_tokenHash_key" ON "CoachInvitation"("tokenHash");
CREATE INDEX "CoachInvitation_businessId_createdAt_idx" ON "CoachInvitation"("businessId", "createdAt");
CREATE INDEX "CoachInvitation_email_expiresAt_idx" ON "CoachInvitation"("email", "expiresAt");
ALTER TABLE "CoachInvitation" ADD CONSTRAINT "CoachInvitation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachInvitation" ADD CONSTRAINT "CoachInvitation_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
