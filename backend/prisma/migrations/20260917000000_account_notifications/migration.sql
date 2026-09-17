-- Keep customer-facing alerts isolated from the existing provider workspace
-- Notification table. Business and booking links are optional historical
-- context; deleting either record must not delete an account's alert history.
BEGIN;

CREATE TABLE "AccountNotification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "businessId" TEXT,
  "bookingId" TEXT,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "actionNeeded" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AccountNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountNotification_userId_createdAt_idx"
  ON "AccountNotification"("userId", "createdAt");
CREATE INDEX "AccountNotification_businessId_idx"
  ON "AccountNotification"("businessId");
CREATE INDEX "AccountNotification_bookingId_idx"
  ON "AccountNotification"("bookingId");

ALTER TABLE "AccountNotification" ADD CONSTRAINT "AccountNotification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountNotification" ADD CONSTRAINT "AccountNotification_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccountNotification" ADD CONSTRAINT "AccountNotification_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
