BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Rental operations are independently grantable: being allowed to edit the
-- teaching catalogue does not imply access to renter identities or bookings.
CREATE OR REPLACE FUNCTION "_courtly_staff_permissions_valid"(value TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(value) > 0
    AND value <@ ARRAY[
      'BOOKINGS_VIEW','BOOKINGS_MANAGE','STUDENTS_VIEW','STUDENTS_MANAGE',
      'CATALOG_VIEW','CATALOG_MANAGE','AVAILABILITY_MANAGE','ROSTER_VIEW',
      'ROSTER_MANAGE','PACKAGES_VIEW','PACKAGES_MANAGE','PAYMENTS_VIEW',
      'PAYMENTS_RECORD','PAYMENTS_REVERSE','PAYOUTS_RECORD','INTEGRITY_VIEW',
      'INTEGRITY_REVIEW','RENTALS_VIEW','RENTALS_MANAGE','SETTINGS_MANAGE',
      'STAFF_MANAGE','AUDIT_VIEW'
    ]::TEXT[]
    AND cardinality(value) = (SELECT count(DISTINCT permission)::INTEGER FROM unnest(value) AS permission)
$$;

-- A named operator acts for the club side of a reschedule negotiation. The
-- request still records their exact User id; the database validates that the
-- grant is active and includes booking-management authority at insertion.
CREATE OR REPLACE FUNCTION "_courtly_assert_live_reschedule_request_actor"()
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
    FROM "User" AS account
    WHERE account."id" = request_row."requestedByUserId"
      AND (EXISTS (
        SELECT 1 FROM "Membership" AS membership
        WHERE membership."userId" = account."id"
          AND account."accountType" = 'CLUB'
          AND membership."businessId" = request_row."businessId"
          AND membership."instructorId" IS NULL AND membership."active"
      ) OR EXISTS (
        SELECT 1 FROM "ClubStaffAccess" AS access
        WHERE access."userId" = account."id"
          AND access."businessId" = request_row."businessId"
          AND access."active" AND access."revokedAt" IS NULL
          AND 'BOOKINGS_MANAGE' = ANY(access."permissions")
      ));
    IF authority_found IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Club reschedule requester must have active authority for the booking business'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
