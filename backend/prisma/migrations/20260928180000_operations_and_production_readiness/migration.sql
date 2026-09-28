BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- These tables supply contractual or authorization state being extended by
-- this migration. Taking one bounded lock prevents an in-flight write from
-- passing the audits and then violating a newly installed invariant.
LOCK TABLE "AuthSession", "Booking", "Business", "Location", "Payment",
  "PaymentIntent", "User", "VenueReservation", "VenueUnit"
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "AuthSession" ADD COLUMN "activeStaffAccessId" TEXT;
ALTER TABLE "Booking"
  ADD COLUMN "seriesId" TEXT,
  ADD COLUMN "seriesPosition" INTEGER,
  ADD COLUMN "venueApproval" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "venueRequirement" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Location"
  ADD COLUMN "classUnitSchedulingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN "recordedByUserId" TEXT;
ALTER TABLE "PaymentIntent"
  ADD COLUMN "checkoutSnapshot" JSONB,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "lastProviderEventAt" TIMESTAMP(3),
  ADD COLUMN "providerAccountReference" TEXT NOT NULL DEFAULT '',
  ALTER COLUMN "providerReference" DROP NOT NULL;

CREATE TABLE "ClubStaffAccess" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "accessLevel" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "invitedByUserId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClubStaffAccess_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClubStaffInvitation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "accessLevel" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL,
  "invitedByUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptedByUserId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClubStaffInvitation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessAuditEvent" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorName" TEXT NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "actorAccountType" TEXT NOT NULL,
  "actorAccessKind" TEXT NOT NULL,
  "actorStaffAccessId" TEXT,
  "actorAccessLevel" TEXT,
  "actorPermissionsSnapshot" TEXT[] NOT NULL,
  "action" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT,
  "summary" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "requestId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookingSeries" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '',
  "createdByRole" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingSeries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BookingSeriesMember" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "seriesId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removedAt" TIMESTAMP(3),
  CONSTRAINT "BookingSeriesMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VenueUnitAllocation" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "bookingId" TEXT,
  "reservationId" TEXT,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "source" TEXT NOT NULL,
  "unitName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "VenueUnitAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BusinessPaymentAccount" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'STRIPE',
  "providerAccountId" TEXT NOT NULL,
  "onboardingState" TEXT NOT NULL DEFAULT 'PENDING',
  "chargesEnabled" BOOLEAN NOT NULL DEFAULT false,
  "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "detailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
  "settlementCurrency" TEXT NOT NULL,
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessPaymentAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentProviderEvent" (
  "id" TEXT NOT NULL,
  "businessId" TEXT,
  "provider" TEXT NOT NULL,
  "providerAccountReference" TEXT NOT NULL DEFAULT '',
  "providerEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "providerCreatedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leasedUntil" TIMESTAMP(3),
  "leaseToken" TEXT,
  "lastErrorCode" TEXT,
  CONSTRAINT "PaymentProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentRefund" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "paymentIntentId" TEXT NOT NULL,
  "paymentId" TEXT,
  "amount" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "providerRefundId" TEXT,
  "requestedByUserId" TEXT,
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "succeededAt" TIMESTAMP(3),
  CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentSettlement" (
  "id" TEXT NOT NULL,
  "paymentIntentId" TEXT NOT NULL,
  "providerChargeId" TEXT,
  "balanceTransactionId" TEXT,
  "gross" INTEGER NOT NULL,
  "fee" INTEGER NOT NULL,
  "net" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "availableOn" TIMESTAMP(3),
  "payoutId" TEXT,
  "payoutStatus" TEXT,
  "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "lastCheckedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentSettlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationPreference" (
  "userId" TEXT NOT NULL,
  "emailTransactionalEnabled" BOOLEAN NOT NULL DEFAULT true,
  "emailReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
  "emailActionNeededEnabled" BOOLEAN NOT NULL DEFAULT true,
  "emailMarketingEnabled" BOOLEAN NOT NULL DEFAULT false,
  "emailSuppressedAt" TIMESTAMP(3),
  "emailSuppressionReason" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "OutboundDelivery" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'EMAIL',
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "dedupeKey" TEXT NOT NULL,
  "recipientKey" TEXT NOT NULL,
  "recipientUserId" TEXT,
  "recipientEmail" TEXT NOT NULL,
  "recipientName" TEXT NOT NULL,
  "businessId" TEXT,
  "bookingId" TEXT,
  "notificationId" TEXT,
  "accountNotificationId" TEXT,
  "template" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leasedUntil" TIMESTAMP(3),
  "leaseToken" TEXT,
  "providerMessageId" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboundDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClubStaffAccess_userId_active_idx" ON "ClubStaffAccess"("userId", "active");
CREATE INDEX "ClubStaffAccess_businessId_active_idx" ON "ClubStaffAccess"("businessId", "active");
CREATE UNIQUE INDEX "ClubStaffAccess_businessId_userId_key" ON "ClubStaffAccess"("businessId", "userId");
CREATE UNIQUE INDEX "ClubStaffInvitation_tokenHash_key" ON "ClubStaffInvitation"("tokenHash");
CREATE INDEX "ClubStaffInvitation_businessId_email_idx" ON "ClubStaffInvitation"("businessId", "email");
CREATE INDEX "ClubStaffInvitation_email_expiresAt_idx" ON "ClubStaffInvitation"("email", "expiresAt");
CREATE INDEX "BusinessAuditEvent_businessId_createdAt_idx" ON "BusinessAuditEvent"("businessId", "createdAt");
CREATE INDEX "BusinessAuditEvent_businessId_resourceType_resourceId_idx" ON "BusinessAuditEvent"("businessId", "resourceType", "resourceId");
CREATE INDEX "BusinessAuditEvent_actorUserId_createdAt_idx" ON "BusinessAuditEvent"("actorUserId", "createdAt");
CREATE INDEX "BookingSeries_businessId_createdAt_idx" ON "BookingSeries"("businessId", "createdAt");
CREATE UNIQUE INDEX "BookingSeries_id_businessId_key" ON "BookingSeries"("id", "businessId");
CREATE INDEX "BookingSeriesMember_businessId_studentId_idx" ON "BookingSeriesMember"("businessId", "studentId");
CREATE UNIQUE INDEX "BookingSeriesMember_seriesId_studentId_key" ON "BookingSeriesMember"("seriesId", "studentId");
CREATE INDEX "VenueUnitAllocation_unitId_startAt_endAt_idx" ON "VenueUnitAllocation"("unitId", "startAt", "endAt");
CREATE INDEX "VenueUnitAllocation_bookingId_idx" ON "VenueUnitAllocation"("bookingId");
CREATE INDEX "VenueUnitAllocation_reservationId_idx" ON "VenueUnitAllocation"("reservationId");
CREATE UNIQUE INDEX "BusinessPaymentAccount_businessId_key" ON "BusinessPaymentAccount"("businessId");
CREATE UNIQUE INDEX "BusinessPaymentAccount_providerAccountId_key" ON "BusinessPaymentAccount"("providerAccountId");
CREATE INDEX "PaymentProviderEvent_processedAt_availableAt_leasedUntil_idx" ON "PaymentProviderEvent"("processedAt", "availableAt", "leasedUntil");
CREATE UNIQUE INDEX "PaymentProviderEvent_provider_providerAccountReference_prov_key" ON "PaymentProviderEvent"("provider", "providerAccountReference", "providerEventId");
CREATE UNIQUE INDEX "PaymentRefund_providerRefundId_key" ON "PaymentRefund"("providerRefundId");
CREATE INDEX "PaymentRefund_businessId_status_createdAt_idx" ON "PaymentRefund"("businessId", "status", "createdAt");
CREATE INDEX "PaymentRefund_paymentIntentId_idx" ON "PaymentRefund"("paymentIntentId");
CREATE UNIQUE INDEX "PaymentSettlement_paymentIntentId_key" ON "PaymentSettlement"("paymentIntentId");
CREATE UNIQUE INDEX "PaymentSettlement_providerChargeId_key" ON "PaymentSettlement"("providerChargeId");
CREATE UNIQUE INDEX "PaymentSettlement_balanceTransactionId_key" ON "PaymentSettlement"("balanceTransactionId");
CREATE INDEX "OutboundDelivery_status_availableAt_leasedUntil_idx" ON "OutboundDelivery"("status", "availableAt", "leasedUntil");
CREATE INDEX "OutboundDelivery_recipientUserId_createdAt_idx" ON "OutboundDelivery"("recipientUserId", "createdAt");
CREATE INDEX "OutboundDelivery_businessId_createdAt_idx" ON "OutboundDelivery"("businessId", "createdAt");
CREATE INDEX "OutboundDelivery_bookingId_idx" ON "OutboundDelivery"("bookingId");
CREATE UNIQUE INDEX "OutboundDelivery_channel_dedupeKey_recipientKey_key" ON "OutboundDelivery"("channel", "dedupeKey", "recipientKey");
CREATE INDEX "AuthSession_activeStaffAccessId_idx" ON "AuthSession"("activeStaffAccessId");
CREATE INDEX "Booking_businessId_seriesId_startAt_idx" ON "Booking"("businessId", "seriesId", "startAt");
CREATE UNIQUE INDEX "Booking_seriesId_seriesPosition_key" ON "Booking"("seriesId", "seriesPosition");

DROP INDEX "PaymentIntent_providerReference_key";
CREATE UNIQUE INDEX "PaymentIntent_provider_providerAccountReference_providerRef_key"
  ON "PaymentIntent"("provider", "providerAccountReference", "providerReference");

ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_active_workspace_xor_check"
  CHECK (num_nonnulls("activeMembershipId", "activeStaffAccessId") <= 1);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_series_shape_check"
  CHECK (("seriesId" IS NULL AND "seriesPosition" IS NULL)
    OR ("seriesId" IS NOT NULL AND "seriesPosition" >= 0));
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_venue_requirement_check"
  CHECK ("venueRequirement" IN ('NONE', 'UNIT'));
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_venue_approval_check"
  CHECK ("venueApproval" IN ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'DECLINED'));
ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_creator_check"
  CHECK ("createdByRole" = 'CLUB');
ALTER TABLE "BookingSeriesMember" ADD CONSTRAINT "BookingSeriesMember_active_shape_check"
  CHECK (("active" AND "removedAt" IS NULL) OR (NOT "active" AND "removedAt" IS NOT NULL));
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_owner_check"
  CHECK (num_nonnulls("bookingId", "reservationId") = 1);
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_time_check"
  CHECK ("endAt" > "startAt");
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_source_check"
  CHECK (("source" = 'BOOKING' AND "bookingId" IS NOT NULL)
    OR ("source" = 'RENTAL' AND "reservationId" IS NOT NULL));
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_status_check"
  CHECK (("status" = 'ACTIVE' AND "releasedAt" IS NULL)
    OR ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL));
ALTER TABLE "BusinessPaymentAccount" ADD CONSTRAINT "BusinessPaymentAccount_shape_check"
  CHECK ("provider" = 'STRIPE'
    AND btrim("providerAccountId") <> ''
    AND "onboardingState" IN ('PENDING', 'RESTRICTED', 'ACTIVE', 'DISABLED')
    AND "settlementCurrency" ~ '^[A-Z]{3}$');
ALTER TABLE "PaymentProviderEvent" ADD CONSTRAINT "PaymentProviderEvent_shape_check"
  CHECK ("provider" = 'STRIPE' AND btrim("providerEventId") <> ''
    AND "payloadHash" ~ '^[a-f0-9]{64}$' AND "attempts" >= 0
    AND (("leaseToken" IS NULL AND "leasedUntil" IS NULL)
      OR ("leaseToken" IS NOT NULL AND "leasedUntil" IS NOT NULL)));
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_shape_check"
  CHECK ("amount" > 0 AND "status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
    AND (("status" = 'SUCCEEDED' AND "providerRefundId" IS NOT NULL AND "succeededAt" IS NOT NULL)
      OR ("status" <> 'SUCCEEDED' AND "succeededAt" IS NULL)));
ALTER TABLE "PaymentSettlement" ADD CONSTRAINT "PaymentSettlement_shape_check"
  CHECK ("gross" >= 0 AND "fee" >= 0 AND "net" = "gross" - "fee"
    AND "currency" ~ '^[A-Z]{3}$'
    AND "reconciliationStatus" IN ('PENDING', 'RECONCILED', 'MISMATCH', 'UNAVAILABLE'));
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_suppression_shape_check"
  CHECK (("emailSuppressedAt" IS NULL AND "emailSuppressionReason" IS NULL)
    OR ("emailSuppressedAt" IS NOT NULL AND btrim(COALESCE("emailSuppressionReason", '')) <> ''));
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_shape_check"
  CHECK ("channel" = 'EMAIL' AND "eventVersion" > 0 AND "attempts" >= 0
    AND "status" IN ('QUEUED', 'SENDING', 'ACCEPTED', 'DELIVERED', 'FAILED', 'SUPPRESSED')
    AND (("leaseToken" IS NULL AND "leasedUntil" IS NULL)
      OR ("leaseToken" IS NOT NULL AND "leasedUntil" IS NOT NULL)));

ALTER TABLE "PaymentIntent" DROP CONSTRAINT "PaymentIntent_provider_check";
ALTER TABLE "PaymentIntent" DROP CONSTRAINT "PaymentIntent_reference_check";
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_provider_check"
  CHECK ("provider" IN ('SIMULATED_STRIPE', 'STRIPE'));
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_reference_check" CHECK (
  btrim("idempotencyKey") <> ''
  AND (("provider" = 'SIMULATED_STRIPE'
      AND "providerAccountReference" = ''
      AND btrim(COALESCE("providerReference", '')) <> '')
    OR ("provider" = 'STRIPE'
      AND btrim("providerAccountReference") <> ''
      AND (btrim(COALESCE("providerReference", '')) <> ''
        OR "status" = 'REQUIRES_CONFIRMATION')))
);

ALTER TABLE "ClubStaffAccess" ADD CONSTRAINT "ClubStaffAccess_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClubStaffAccess" ADD CONSTRAINT "ClubStaffAccess_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClubStaffInvitation" ADD CONSTRAINT "ClubStaffInvitation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClubStaffInvitation" ADD CONSTRAINT "ClubStaffInvitation_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BusinessAuditEvent" ADD CONSTRAINT "BusinessAuditEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BookingSeries" ADD CONSTRAINT "BookingSeries_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_seriesId_businessId_fkey"
  FOREIGN KEY ("seriesId", "businessId") REFERENCES "BookingSeries"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "BookingSeriesMember" ADD CONSTRAINT "BookingSeriesMember_seriesId_businessId_fkey"
  FOREIGN KEY ("seriesId", "businessId") REFERENCES "BookingSeries"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "BookingSeriesMember" ADD CONSTRAINT "BookingSeriesMember_studentId_businessId_fkey"
  FOREIGN KEY ("studentId", "businessId") REFERENCES "Student"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId") REFERENCES "Location"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_unitId_locationId_businessId_fkey"
  FOREIGN KEY ("unitId", "locationId", "businessId") REFERENCES "VenueUnit"("id", "locationId", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_bookingId_businessId_fkey"
  FOREIGN KEY ("bookingId", "businessId") REFERENCES "Booking"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_reservationId_businessId_fkey"
  FOREIGN KEY ("reservationId", "businessId") REFERENCES "VenueReservation"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "BusinessPaymentAccount" ADD CONSTRAINT "BusinessPaymentAccount_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentProviderEvent" ADD CONSTRAINT "PaymentProviderEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentIntentId_businessId_fkey"
  FOREIGN KEY ("paymentIntentId", "businessId") REFERENCES "PaymentIntent"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentSettlement" ADD CONSTRAINT "PaymentSettlement_paymentIntentId_fkey"
  FOREIGN KEY ("paymentIntentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_recipientUserId_fkey"
  FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_accountNotificationId_fkey"
  FOREIGN KEY ("accountNotificationId") REFERENCES "AccountNotification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_activeStaffAccessId_fkey"
  FOREIGN KEY ("activeStaffAccessId") REFERENCES "ClubStaffAccess"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "_courtly_staff_permissions_valid"(value TEXT[])
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(value) > 0
    AND value <@ ARRAY[
      'BOOKINGS_VIEW','BOOKINGS_MANAGE','STUDENTS_VIEW','STUDENTS_MANAGE',
      'CATALOG_VIEW','CATALOG_MANAGE','AVAILABILITY_MANAGE','ROSTER_VIEW',
      'ROSTER_MANAGE','PACKAGES_VIEW','PACKAGES_MANAGE','PAYMENTS_VIEW',
      'PAYMENTS_RECORD','PAYMENTS_REVERSE','PAYOUTS_RECORD','INTEGRITY_VIEW',
      'INTEGRITY_REVIEW','SETTINGS_MANAGE','STAFF_MANAGE','AUDIT_VIEW'
    ]::TEXT[]
    AND cardinality(value) = (SELECT count(DISTINCT permission)::INTEGER FROM unnest(value) AS permission)
$$;

ALTER TABLE "ClubStaffAccess" ADD CONSTRAINT "ClubStaffAccess_access_check"
  CHECK ("accessLevel" IN ('ADMINISTRATOR','OPERATIONS','FRONT_DESK','FINANCE','SAFEGUARDING','READ_ONLY','CUSTOM')
    AND "_courtly_staff_permissions_valid"("permissions")
    AND (("active" AND "revokedAt" IS NULL) OR (NOT "active" AND "revokedAt" IS NOT NULL)));
ALTER TABLE "ClubStaffInvitation" ADD CONSTRAINT "ClubStaffInvitation_access_check"
  CHECK ("accessLevel" IN ('ADMINISTRATOR','OPERATIONS','FRONT_DESK','FINANCE','SAFEGUARDING','READ_ONLY','CUSTOM')
    AND "_courtly_staff_permissions_valid"("permissions")
    AND lower("email") = "email" AND btrim("email") <> ''
    AND "expiresAt" > "createdAt" AND num_nonnulls("acceptedAt", "revokedAt") <= 1);

CREATE OR REPLACE FUNCTION "_courtly_validate_named_staff"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_type TEXT;
  business_kind TEXT;
  business_read_only BOOLEAN;
BEGIN
  SELECT "accountType" INTO account_type FROM "User" WHERE "id" = NEW."userId";
  SELECT "kind", "legacyReadOnly" INTO business_kind, business_read_only
    FROM "Business" WHERE "id" = NEW."businessId";
  IF account_type = 'CLUB' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Club accounts cannot hold named staff access';
  END IF;
  IF business_kind <> 'CLUB' OR business_read_only THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Named staff access requires an active club';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ClubStaffAccess_identity_guard"
  BEFORE INSERT OR UPDATE ON "ClubStaffAccess" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_validate_named_staff"();

CREATE OR REPLACE FUNCTION "_courtly_validate_active_staff_session"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."activeStaffAccessId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ClubStaffAccess" AS access
    WHERE access."id" = NEW."activeStaffAccessId"
      AND access."userId" = NEW."userId" AND access."active"
      AND access."revokedAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Selected staff access must belong to the active user';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AuthSession_staff_access_guard"
  BEFORE INSERT OR UPDATE ON "AuthSession" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_validate_active_staff_session"();

-- The shared allocation ledger starts with every historical rental. Cancelled
-- reservations remain as released evidence; live reservations participate in
-- the overlap exclusion below.
INSERT INTO "VenueUnitAllocation" (
  "id", "businessId", "locationId", "unitId", "reservationId",
  "startAt", "endAt", "status", "source", "unitName", "createdAt", "releasedAt"
)
SELECT 'rental_' || md5(reservation."id"), reservation."businessId",
  reservation."locationId", reservation."unitId", reservation."id",
  reservation."startAt", reservation."endAt",
  CASE WHEN reservation."status" = 'CANCELLED' THEN 'RELEASED' ELSE 'ACTIVE' END,
  'RENTAL', unit."name", reservation."createdAt", reservation."cancelledAt"
FROM "VenueReservation" AS reservation
JOIN "VenueUnit" AS unit ON unit."id" = reservation."unitId";

CREATE UNIQUE INDEX "VenueUnitAllocation_active_booking_key"
  ON "VenueUnitAllocation"("bookingId") WHERE "status" = 'ACTIVE' AND "bookingId" IS NOT NULL;
CREATE UNIQUE INDEX "VenueUnitAllocation_active_reservation_key"
  ON "VenueUnitAllocation"("reservationId") WHERE "status" = 'ACTIVE' AND "reservationId" IS NOT NULL;
ALTER TABLE "VenueUnitAllocation" ADD CONSTRAINT "VenueUnitAllocation_active_unit_overlap"
  EXCLUDE USING gist (
    "businessId" WITH =,
    "unitId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  ) WHERE ("status" = 'ACTIVE') DEFERRABLE INITIALLY DEFERRED;

-- Existing checkout triggers compared every linked ledger row to the legacy
-- simulation provider. Keep the same deferred invariant while allowing a
-- Stripe result to use its matching STRIPE payment method.
CREATE OR REPLACE FUNCTION "_courtly_assert_checkout_payment_correspondence"()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "PaymentIntent" AS intent
    JOIN "Business" AS business ON business."id" = intent."businessId"
    WHERE intent."status" IN ('SUCCEEDED', 'REFUNDED')
      AND intent."currency" <> business."currency"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Business currency must match completed checkout intent history';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PaymentIntent" AS intent
    JOIN "User" AS account ON account."id" = intent."userId"
    LEFT JOIN "VenueReservation" AS reservation ON reservation."id" = intent."reservationId"
    WHERE intent."status" IN ('SUCCEEDED', 'REFUNDED') AND (
      (intent."kind" IN ('PACKAGE', 'BOOKING') AND
        (SELECT count(*) FROM "Payment" AS payment WHERE payment."paymentIntentId" = intent."id") <> 1)
      OR (intent."kind" = 'RENTAL' AND account."accountType" = 'STUDENT'
        AND intent."amount" > 0 AND reservation."packageId" IS NULL AND
        (SELECT count(*) FROM "Payment" AS payment WHERE payment."paymentIntentId" = intent."id") <> 1)
      OR (intent."kind" = 'RENTAL' AND (account."accountType" <> 'STUDENT'
        OR intent."amount" = 0 OR reservation."packageId" IS NOT NULL) AND
        EXISTS (SELECT 1 FROM "Payment" AS payment WHERE payment."paymentIntentId" = intent."id"))
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A successful checkout intent must have the required payment result';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Payment" AS payment
    JOIN "PaymentIntent" AS intent ON intent."id" = payment."paymentIntentId"
    JOIN "Business" AS business ON business."id" = payment."businessId"
    LEFT JOIN "Student" AS student ON student."id" = payment."studentId"
    LEFT JOIN "Participant" AS participant ON participant."id" = intent."participantId"
    LEFT JOIN "Booking" AS booking ON booking."id" = participant."bookingId"
    LEFT JOIN "LessonPackage" AS package ON package."id" = intent."packageId"
    LEFT JOIN "VenueReservation" AS reservation ON reservation."id" = intent."reservationId"
    WHERE payment."paymentIntentId" IS NOT NULL AND (
      intent."businessId" <> payment."businessId"
      OR payment."method" <> intent."provider"
      OR intent."amount" <> payment."amount"
      OR intent."currency" <> business."currency"
      OR student."userId" IS DISTINCT FROM intent."userId"
      OR NOT ((intent."status" = 'SUCCEEDED' AND payment."reversedAt" IS NULL)
        OR (intent."status" = 'REFUNDED' AND payment."reversedAt" IS NOT NULL))
      OR CASE intent."kind"
        WHEN 'PACKAGE' THEN NOT (intent."packageId" IS NOT NULL
          AND package."offerId" = intent."packageOfferId" AND package."price" = intent."amount"
          AND payment."packageId" = intent."packageId" AND payment."studentId" = package."studentId"
          AND payment."bookingId" IS NULL AND payment."kind" = 'STUDENT_TO_CLUB')
        WHEN 'BOOKING' THEN NOT (intent."participantId" IS NOT NULL
          AND payment."bookingId" = participant."bookingId" AND payment."studentId" = participant."studentId"
          AND payment."packageId" IS NULL AND payment."kind" = CASE booking."paymentRoute"
            WHEN 'CLUB' THEN 'STUDENT_TO_CLUB' ELSE 'STUDENT_TO_COACH' END)
        WHEN 'RENTAL' THEN NOT (intent."reservationId" IS NOT NULL
          AND reservation."userId" = intent."userId"
          AND intent."amount" = CASE WHEN reservation."packageId" IS NULL THEN reservation."price" ELSE 0 END
          AND payment."bookingId" IS NULL AND payment."packageId" IS NULL
          AND payment."kind" = 'STUDENT_TO_CLUB')
        ELSE true
      END
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payment must exactly match its successful checkout intent';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PaymentIntent" AS intent
    JOIN "LessonPackage" AS package ON package."id" = intent."packageId"
    WHERE intent."kind" = 'PACKAGE' AND intent."status" IN ('SUCCEEDED', 'REFUNDED')
      AND package."paid" IS DISTINCT FROM (intent."status" = 'SUCCEEDED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A purchased package paid state must match its checkout state';
  END IF;
END;
$$;

-- Protect the newly added provider account and checkout snapshot once an
-- intent becomes terminal. Provider event timestamps and failure codes may be
-- reconciled without altering contractual fields.
CREATE OR REPLACE FUNCTION "_courtly_protect_terminal_payment_intent"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_lock_commercial_business"(OLD."businessId");
  IF OLD."status" IN ('SUCCEEDED', 'REFUNDED', 'FAILED') AND TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'FAILED'
      OR NOT (NEW."status" = OLD."status"
        OR (OLD."status" = 'SUCCEEDED' AND NEW."status" = 'REFUNDED'))
      OR ROW(OLD."id", OLD."userId", OLD."businessId", OLD."kind",
        OLD."packageOfferId", OLD."participantId", OLD."reservationId", OLD."packageId",
        OLD."amount", OLD."currency", OLD."provider", OLD."providerAccountReference",
        OLD."providerReference", OLD."checkoutSnapshot", OLD."idempotencyKey",
        OLD."expiresAt", OLD."createdAt", OLD."confirmedAt", OLD."failedAt")
        IS DISTINCT FROM
        ROW(NEW."id", NEW."userId", NEW."businessId", NEW."kind",
        NEW."packageOfferId", NEW."participantId", NEW."reservationId", NEW."packageId",
        NEW."amount", NEW."currency", NEW."provider", NEW."providerAccountReference",
        NEW."providerReference", NEW."checkoutSnapshot", NEW."idempotencyKey",
        NEW."expiresAt", NEW."createdAt", NEW."confirmedAt", NEW."failedAt")
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Terminal checkout intent history is immutable except for successful refunds';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
