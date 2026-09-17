-- Club / coach platform model.
--
-- Adds the club-versus-solo money path, coach acceptance of club-assigned
-- lessons, two-sided reschedule requests, reversible payment records, Google
-- Maps venue provenance, typed workspace notifications, and the club
-- safeguard that surfaces a coach and student training privately after they
-- met through a club.
--
-- Every column is added with a default so existing rows stay valid, then the
-- derived columns are backfilled from the data already present.

-- 1. Business: how money flows for lessons booked here.
ALTER TABLE "Business" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'CLUB';

-- 2. Instructor: the coach's own reschedule protection window.
ALTER TABLE "Instructor" ADD COLUMN "rescheduleNoticeHours" INTEGER NOT NULL DEFAULT 24;

-- 3. Location: venue provenance for Google Maps lookups.
ALTER TABLE "Location" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Location" ADD COLUMN "placeId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Location" ADD COLUMN "mapsUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Location" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Location" ADD COLUMN "longitude" DOUBLE PRECISION;

-- 4. Booking: payment route snapshot and coach acceptance.
ALTER TABLE "Booking" ADD COLUMN "paymentRoute" TEXT NOT NULL DEFAULT 'DIRECT';
ALTER TABLE "Booking" ADD COLUMN "coachAcceptance" TEXT NOT NULL DEFAULT 'NOT_REQUIRED';
ALTER TABLE "Booking" ADD COLUMN "coachRespondedAt" TIMESTAMP(3);
ALTER TABLE "Booking" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "Booking" ADD COLUMN "createdByRole" TEXT NOT NULL DEFAULT 'CUSTOMER';
CREATE INDEX "Booking_businessId_coachAcceptance_idx" ON "Booking"("businessId", "coachAcceptance");

-- Existing bookings belong to businesses that are clubs by default, so their
-- money already ran through the club. Mark them accordingly and treat them as
-- already accepted; nobody should be asked to re-accept a past lesson.
UPDATE "Booking" SET "paymentRoute" = 'CLUB';

-- 5. Payment: which leg of the money path, and reversible corrections.
ALTER TABLE "Payment" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'CUSTOMER_TO_CLUB';
ALTER TABLE "Payment" ADD COLUMN "instructorId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "reversedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "reversedByUserId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "reversedReason" TEXT NOT NULL DEFAULT '';
CREATE INDEX "Payment_instructorId_idx" ON "Payment"("instructorId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_instructorId_fkey"
  FOREIGN KEY ("instructorId") REFERENCES "Instructor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 6. Notification: typed workspace alerts.
ALTER TABLE "Notification" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'NOTICE';
ALTER TABLE "Notification" ADD COLUMN "bookingId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "actionNeeded" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Notification_businessId_read_idx" ON "Notification"("businessId", "read");

-- Give already-stored alerts a type from their wording so the new icons are
-- meaningful for history as well as for new activity.
UPDATE "Notification" SET "type" = CASE
  WHEN "title" ILIKE '%payment%' THEN 'PAYMENT'
  WHEN "title" ILIKE '%reschedul%' THEN 'RESCHEDULE'
  WHEN "title" ILIKE '%cancel%' THEN 'CANCELLATION'
  WHEN "title" ILIKE '%booking%' THEN 'BOOKING'
  ELSE 'NOTICE'
END;

-- 7. Reschedule requests.
CREATE TABLE "RescheduleRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "requestedByUserId" TEXT,
    "participantId" TEXT,
    "proposedStartAt" TIMESTAMP(3) NOT NULL,
    "proposedEndAt" TIMESTAMP(3) NOT NULL,
    "originalStartAt" TIMESTAMP(3) NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "respondedByUserId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "responseMessage" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RescheduleRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RescheduleRequest_businessId_status_idx" ON "RescheduleRequest"("businessId", "status");
CREATE INDEX "RescheduleRequest_bookingId_status_idx" ON "RescheduleRequest"("bookingId", "status");
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RescheduleRequest" ADD CONSTRAINT "RescheduleRequest_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 8. Club safeguard flags.
CREATE TABLE "IntegrityFlag" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "instructorId" TEXT,
    "coachUserId" TEXT NOT NULL,
    "customerUserId" TEXT NOT NULL,
    "coachName" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "bookingId" TEXT,
    "outsideBusinessId" TEXT,
    "outsideBusinessName" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'PRIVATE_SESSION_AFTER_CLUB',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "detail" TEXT NOT NULL DEFAULT '',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionNote" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "IntegrityFlag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrityFlag_businessId_coachUserId_customerUserId_type_key"
  ON "IntegrityFlag"("businessId", "coachUserId", "customerUserId", "type");
CREATE INDEX "IntegrityFlag_businessId_status_idx" ON "IntegrityFlag"("businessId", "status");
ALTER TABLE "IntegrityFlag" ADD CONSTRAINT "IntegrityFlag_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrityFlag" ADD CONSTRAINT "IntegrityFlag_instructorId_fkey"
  FOREIGN KEY ("instructorId") REFERENCES "Instructor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "IntegrityFlag" ADD CONSTRAINT "IntegrityFlag_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
