-- A guest note belongs to that participant, never to a shared group session.
ALTER TABLE "Participant" ADD COLUMN "notes" TEXT NOT NULL DEFAULT '';

-- Management credentials are stored as one-way digests and expire 30 days
-- after the session. Pre-release demo links are intentionally invalidated.
ALTER TABLE "Participant" ADD COLUMN "managementTokenHash" TEXT;
ALTER TABLE "Participant" ADD COLUMN "managementTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "Participant" ADD COLUMN "managementTokenRevokedAt" TIMESTAMP(3);
UPDATE "Participant" AS participant
SET "managementTokenHash" = md5(participant."managementToken" || participant."id"),
    "managementTokenExpiresAt" = booking."endAt" + INTERVAL '30 days'
FROM "Booking" AS booking
WHERE booking."id" = participant."bookingId";
ALTER TABLE "Participant" ALTER COLUMN "managementTokenHash" SET NOT NULL;
ALTER TABLE "Participant" ALTER COLUMN "managementTokenExpiresAt" SET NOT NULL;
DROP INDEX "Participant_managementToken_key";
ALTER TABLE "Participant" DROP COLUMN "managementToken";
CREATE UNIQUE INDEX "Participant_managementTokenHash_key" ON "Participant"("managementTokenHash");
