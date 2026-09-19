-- Keep the booking, scheduling and reschedule graphs inside one business.
-- Direct tenant edges become deferrable composite foreign keys; join rows that
-- do not carry businessId use narrowly keyed deferred assertions.
BEGIN;

SET LOCAL lock_timeout = '10s';
LOCK TABLE
  "User", "Membership", "Service", "Instructor", "Location",
  "ServiceLocation", "ServiceInstructor", "Availability",
  "AvailabilityException", "Student", "LessonPackage", "Booking",
  "Participant", "Payment", "RescheduleRequest"
  IN SHARE ROW EXCLUSIVE MODE;

-- Audit history before adding any database object. Null requester IDs are
-- legacy provenance and remain valid, but a recorded identity must agree with
-- the request. Active state is intentionally not historical provenance.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Booking" AS booking
    JOIN "Service" AS service ON service."id" = booking."serviceId"
    WHERE service."businessId" <> booking."businessId"
  ) THEN RAISE EXCEPTION 'Booking service must belong to the booking business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "Booking" AS booking
    JOIN "Instructor" AS instructor ON instructor."id" = booking."instructorId"
    WHERE instructor."businessId" <> booking."businessId"
  ) THEN RAISE EXCEPTION 'Booking instructor must belong to the booking business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "Booking" AS booking
    JOIN "Location" AS location ON location."id" = booking."locationId"
    WHERE location."businessId" <> booking."businessId"
  ) THEN RAISE EXCEPTION 'Booking location must belong to the booking business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "LessonPackage" AS package
    JOIN "Service" AS service ON service."id" = package."serviceId"
    WHERE package."serviceId" IS NOT NULL
      AND service."businessId" <> package."businessId"
  ) THEN RAISE EXCEPTION 'Lesson package service must belong to the package business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "Participant" AS participant
    JOIN "Booking" AS booking ON booking."id" = participant."bookingId"
    JOIN "Student" AS student ON student."id" = participant."studentId"
    WHERE student."businessId" <> booking."businessId"
  ) THEN RAISE EXCEPTION 'Participant student must belong to the booking business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "ServiceLocation" AS service_location
    JOIN "Service" AS service ON service."id" = service_location."serviceId"
    JOIN "Location" AS location ON location."id" = service_location."locationId"
    WHERE service."businessId" <> location."businessId"
  ) THEN RAISE EXCEPTION 'Service location must belong to the service business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "ServiceInstructor" AS assignment
    JOIN "ServiceLocation" AS service_location
      ON service_location."id" = assignment."serviceLocationId"
    JOIN "Service" AS service ON service."id" = service_location."serviceId"
    JOIN "Instructor" AS instructor ON instructor."id" = assignment."instructorId"
    WHERE instructor."businessId" <> service."businessId"
  ) THEN RAISE EXCEPTION 'Service instructor must belong to the service business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "Availability" AS availability
    JOIN "Instructor" AS instructor ON instructor."id" = availability."instructorId"
    WHERE instructor."businessId" <> availability."businessId"
  ) THEN RAISE EXCEPTION 'Availability instructor must belong to the availability business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "Availability" AS availability
    JOIN "Location" AS location ON location."id" = availability."locationId"
    WHERE location."businessId" <> availability."businessId"
  ) THEN RAISE EXCEPTION 'Availability location must belong to the availability business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "AvailabilityException" AS exception
    JOIN "Instructor" AS instructor ON instructor."id" = exception."instructorId"
    WHERE instructor."businessId" <> exception."businessId"
  ) THEN RAISE EXCEPTION 'Availability exception instructor must belong to the exception business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "RescheduleRequest" AS request
    JOIN "Booking" AS booking ON booking."id" = request."bookingId"
    WHERE request."businessId" <> booking."businessId"
  ) THEN RAISE EXCEPTION 'Reschedule request must belong to the booking business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "RescheduleRequest" AS request
    WHERE (request."requestedByRole" = 'STUDENT' AND request."participantId" IS NULL)
       OR (request."requestedByRole" IN ('COACH', 'CLUB') AND request."participantId" IS NOT NULL)
  ) THEN RAISE EXCEPTION 'Reschedule request participant is required only for a STUDENT requester'; END IF;

  IF EXISTS (
    SELECT 1 FROM "RescheduleRequest" AS request
    WHERE request."requestedByRole" = 'STUDENT'
      AND NOT EXISTS (
        SELECT 1 FROM "Participant" AS participant
        WHERE participant."id" = request."participantId"
          AND participant."bookingId" = request."bookingId"
      )
  ) THEN RAISE EXCEPTION 'Student reschedule participant must belong to the named booking'; END IF;

  IF EXISTS (
    SELECT 1 FROM "RescheduleRequest" AS request
    WHERE request."requestedByRole" = 'STUDENT'
      AND request."requestedByUserId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "Participant" AS participant
        JOIN "Student" AS student ON student."id" = participant."studentId"
        WHERE participant."id" = request."participantId"
          AND participant."bookingId" = request."bookingId"
          AND student."userId" = request."requestedByUserId"
      )
  ) THEN RAISE EXCEPTION 'Student reschedule requester must own the named participant'; END IF;

  IF EXISTS (
    SELECT 1 FROM "RescheduleRequest" AS request
    JOIN "Booking" AS booking ON booking."id" = request."bookingId"
    WHERE request."requestedByRole" = 'COACH'
      AND request."requestedByUserId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "User" AS account
        JOIN "Membership" AS membership ON membership."userId" = account."id"
        WHERE account."id" = request."requestedByUserId"
          AND account."accountType" = 'COACH'
          AND membership."businessId" = request."businessId"
          AND membership."instructorId" = booking."instructorId"
      )
  ) THEN RAISE EXCEPTION 'Coach reschedule requester must be the booking instructor account'; END IF;

  IF EXISTS (
    SELECT 1 FROM "RescheduleRequest" AS request
    WHERE request."requestedByRole" = 'CLUB'
      AND request."requestedByUserId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "User" AS account
        JOIN "Membership" AS membership ON membership."userId" = account."id"
        WHERE account."id" = request."requestedByUserId"
          AND account."accountType" = 'CLUB'
          AND membership."businessId" = request."businessId"
          AND membership."instructorId" IS NULL
      )
  ) THEN RAISE EXCEPTION 'Club reschedule requester must be the booking business account'; END IF;
END $$;

-- Tenant ownership is part of each core entity's identity. Reject a move at
-- the parent before foreign-key actions or deferred graph checks can turn it
-- into an implicit move of dependent rows.
CREATE FUNCTION "_courtly_reject_business_id_change"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."businessId" IS DISTINCT FROM NEW."businessId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('%s.businessId is immutable after creation', TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Service_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "Service"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "Location_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "Location"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "Instructor_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "Instructor"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "Booking_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "Booking"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "Student_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "Student"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();

-- Earlier migrations introduced these tenant-bearing composite keys with
-- cascading updates. Preserve their delete semantics while making a parent
-- tenant identifier incapable of silently rewriting a child tenant.
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_instructorId_businessId_fkey";
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_instructorId_businessId_fkey"
  FOREIGN KEY ("instructorId", "businessId") REFERENCES "Instructor"("id", "businessId")
  ON DELETE SET NULL ("instructorId") ON UPDATE NO ACTION;

ALTER TABLE "LessonPackage" DROP CONSTRAINT "LessonPackage_studentId_businessId_fkey";
ALTER TABLE "LessonPackage" ADD CONSTRAINT "LessonPackage_studentId_businessId_fkey"
  FOREIGN KEY ("studentId", "businessId") REFERENCES "Student"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_studentId_businessId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_studentId_businessId_fkey"
  FOREIGN KEY ("studentId", "businessId") REFERENCES "Student"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_instructorId_businessId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_instructorId_businessId_fkey"
  FOREIGN KEY ("instructorId", "businessId") REFERENCES "Instructor"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_packageId_businessId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_packageId_businessId_fkey"
  FOREIGN KEY ("packageId", "businessId") REFERENCES "LessonPackage"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_bookingId_businessId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_businessId_fkey"
  FOREIGN KEY ("bookingId", "businessId") REFERENCES "Booking"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Composite keys let PostgreSQL enforce tenant ownership without global scans.
CREATE UNIQUE INDEX "Service_id_businessId_key" ON "Service"("id", "businessId");
CREATE UNIQUE INDEX "Location_id_businessId_key" ON "Location"("id", "businessId");

ALTER TABLE "Booking" DROP CONSTRAINT "Booking_serviceId_fkey";
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceId_businessId_fkey"
  FOREIGN KEY ("serviceId", "businessId") REFERENCES "Service"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_instructorId_fkey";
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_instructorId_businessId_fkey"
  FOREIGN KEY ("instructorId", "businessId") REFERENCES "Instructor"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_locationId_fkey";
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId") REFERENCES "Location"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "LessonPackage" ADD CONSTRAINT "LessonPackage_serviceId_businessId_fkey"
  FOREIGN KEY ("serviceId", "businessId") REFERENCES "Service"("id", "businessId")
  ON DELETE SET NULL ("serviceId") ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "Availability" DROP CONSTRAINT "Availability_instructorId_fkey";
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_instructorId_businessId_fkey"
  FOREIGN KEY ("instructorId", "businessId") REFERENCES "Instructor"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "Availability" DROP CONSTRAINT "Availability_locationId_fkey";
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId") REFERENCES "Location"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "AvailabilityException" DROP CONSTRAINT "AvailabilityException_instructorId_fkey";
ALTER TABLE "AvailabilityException" ADD CONSTRAINT "AvailabilityException_instructorId_businessId_fkey"
  FOREIGN KEY ("instructorId", "businessId") REFERENCES "Instructor"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "RescheduleRequest" DROP CONSTRAINT "RescheduleRequest_bookingId_fkey";
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_bookingId_businessId_fkey"
  FOREIGN KEY ("bookingId", "businessId") REFERENCES "Booking"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_requester_shape_check" CHECK (
  ("requestedByRole" = 'STUDENT' AND "participantId" IS NOT NULL)
  OR ("requestedByRole" IN ('COACH', 'CLUB') AND "participantId" IS NULL)
);

CREATE FUNCTION "_courtly_assert_catalog_link_tenancy"(
  service_location_id TEXT, instructor_id TEXT
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ServiceLocation" AS service_location
    JOIN "Service" AS service ON service."id" = service_location."serviceId"
    JOIN "Location" AS location ON location."id" = service_location."locationId"
    WHERE service."businessId" <> location."businessId"
      AND service_location."id" = service_location_id
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Service location must belong to the service business'; END IF;

  IF EXISTS (
    SELECT 1 FROM "ServiceInstructor" AS assignment
    JOIN "ServiceLocation" AS service_location
      ON service_location."id" = assignment."serviceLocationId"
    JOIN "Service" AS service ON service."id" = service_location."serviceId"
    JOIN "Instructor" AS instructor ON instructor."id" = assignment."instructorId"
    WHERE instructor."businessId" <> service."businessId"
      AND assignment."serviceLocationId" = service_location_id
      AND (instructor_id IS NULL OR assignment."instructorId" = instructor_id)
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Service instructor must belong to the service business'; END IF;
END;
$$;

CREATE FUNCTION "_courtly_catalog_link_tenancy_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'ServiceLocation' THEN
    PERFORM 1 FROM "Service" WHERE "id" = NEW."serviceId" FOR SHARE;
    PERFORM 1 FROM "Location" WHERE "id" = NEW."locationId" FOR SHARE;
    PERFORM "_courtly_assert_catalog_link_tenancy"(NEW."id", NULL);
  ELSIF TG_TABLE_NAME = 'ServiceInstructor' THEN
    PERFORM 1 FROM "ServiceLocation" WHERE "id" = NEW."serviceLocationId" FOR SHARE;
    PERFORM 1 FROM "Service"
      WHERE "id" = (SELECT "serviceId" FROM "ServiceLocation" WHERE "id" = NEW."serviceLocationId")
      FOR SHARE;
    PERFORM 1 FROM "Instructor" WHERE "id" = NEW."instructorId" FOR SHARE;
    PERFORM "_courtly_assert_catalog_link_tenancy"(NEW."serviceLocationId", NEW."instructorId");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ServiceLocation_tenant_invariant"
  AFTER INSERT OR UPDATE OF "serviceId", "locationId" ON "ServiceLocation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "_courtly_catalog_link_tenancy_constraint"();
CREATE CONSTRAINT TRIGGER "ServiceInstructor_tenant_invariant"
  AFTER INSERT OR UPDATE OF "serviceLocationId", "instructorId" ON "ServiceInstructor"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "_courtly_catalog_link_tenancy_constraint"();

CREATE FUNCTION "_courtly_assert_participant_tenancy"(
  participant_id TEXT
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Participant" AS participant
    JOIN "Booking" AS booking ON booking."id" = participant."bookingId"
    JOIN "Student" AS student ON student."id" = participant."studentId"
    WHERE student."businessId" <> booking."businessId"
      AND participant."id" = participant_id
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Participant student must belong to the booking business'; END IF;

END;
$$;

CREATE FUNCTION "_courtly_participant_tenancy_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'Participant' THEN
    PERFORM 1 FROM "Booking" WHERE "id" = NEW."bookingId" FOR SHARE;
    PERFORM 1 FROM "Student" WHERE "id" = NEW."studentId" FOR SHARE;
    PERFORM "_courtly_assert_participant_tenancy"(NEW."id");
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "Participant_tenant_invariant"
  AFTER INSERT OR UPDATE OF "bookingId", "studentId", "packageId" ON "Participant"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "_courtly_participant_tenancy_constraint"();
CREATE FUNCTION "_courtly_assert_live_reschedule_request_actor"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  request_row "RescheduleRequest"%ROWTYPE;
  booking_instructor_id TEXT;
  authority_found BOOLEAN;
BEGIN
  SELECT * INTO request_row FROM "RescheduleRequest" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF request_row."requestedByUserId" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'New or retargeted reschedule requests require a requester account';
  END IF;

  IF request_row."requestedByRole" = 'STUDENT' THEN
    SELECT true INTO authority_found
    FROM "Participant" AS participant
    JOIN "Student" AS student ON student."id" = participant."studentId"
    JOIN "User" AS account ON account."id" = student."userId"
    WHERE participant."id" = request_row."participantId"
      AND participant."bookingId" = request_row."bookingId"
      AND participant."cancelledAt" IS NULL
      AND student."userId" = request_row."requestedByUserId"
      AND account."accountType" = 'STUDENT'
    FOR SHARE OF participant, student, account;
    IF authority_found IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Student reschedule requester must own an active participant in the named booking'; END IF;
  ELSIF request_row."requestedByRole" = 'COACH' THEN
    SELECT "instructorId" INTO booking_instructor_id
    FROM "Booking" WHERE "id" = request_row."bookingId" FOR SHARE;
    SELECT true INTO authority_found
    FROM "Membership" AS membership
    JOIN "User" AS account ON account."id" = membership."userId"
    WHERE account."id" = request_row."requestedByUserId"
      AND account."accountType" = 'COACH'
      AND membership."businessId" = request_row."businessId"
      AND membership."instructorId" = booking_instructor_id
      AND membership."active"
    FOR SHARE OF membership, account;
    IF authority_found IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Coach reschedule requester must be the active booking instructor account'; END IF;
  ELSIF request_row."requestedByRole" = 'CLUB' THEN
    SELECT true INTO authority_found
    FROM "Membership" AS membership
    JOIN "User" AS account ON account."id" = membership."userId"
    WHERE account."id" = request_row."requestedByUserId"
      AND account."accountType" = 'CLUB'
      AND membership."businessId" = request_row."businessId"
      AND membership."instructorId" IS NULL
      AND membership."active"
    FOR SHARE OF membership, account;
    IF authority_found IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Club reschedule requester must be the active booking business account'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "RescheduleRequest_live_actor_on_insert" AFTER INSERT ON "RescheduleRequest"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_assert_live_reschedule_request_actor"();
CREATE CONSTRAINT TRIGGER "RescheduleRequest_live_actor_on_retarget"
  AFTER UPDATE OF "businessId", "bookingId", "requestedByRole", "requestedByUserId", "participantId"
  ON "RescheduleRequest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD."businessId" IS DISTINCT FROM NEW."businessId"
    OR OLD."bookingId" IS DISTINCT FROM NEW."bookingId"
    OR OLD."requestedByRole" IS DISTINCT FROM NEW."requestedByRole"
    OR OLD."requestedByUserId" IS DISTINCT FROM NEW."requestedByUserId"
    OR OLD."participantId" IS DISTINCT FROM NEW."participantId")
  EXECUTE FUNCTION "_courtly_assert_live_reschedule_request_actor"();

COMMIT;
