-- User-owned Google Calendar connections, privacy-minimized busy caches, and
-- a transactional booking outbox. OAuth tokens and PKCE verifiers are always
-- application-encrypted before they reach these tables.
BEGIN;

ALTER TABLE "Booking" ADD COLUMN "calendarRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CalendarConnection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'GOOGLE',
  "providerAccountId" TEXT NOT NULL,
  "providerEmail" TEXT NOT NULL,
  "calendarTimeZone" TEXT NOT NULL DEFAULT 'UTC',
  "accessTokenCiphertext" TEXT NOT NULL,
  "refreshTokenCiphertext" TEXT,
  "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
  "busyCheckEnabled" BOOLEAN NOT NULL DEFAULT false,
  "lastErrorCode" TEXT,
  "lastSyncedAt" TIMESTAMP(3),
  "busyLastRefreshedAt" TIMESTAMP(3),
  "busyRefreshAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "busyRefreshFailures" INTEGER NOT NULL DEFAULT 0,
  "busyRefreshLeaseUntil" TIMESTAMP(3),
  "busyRefreshLeaseToken" TEXT,
  "disconnectRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalendarConnection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarConnection_provider_check" CHECK ("provider" = 'GOOGLE'),
  CONSTRAINT "CalendarConnection_status_check" CHECK ("status" IN ('ACTIVE', 'REAUTH_REQUIRED', 'DISCONNECTING')),
  CONSTRAINT "CalendarConnection_busyRefreshFailures_check" CHECK ("busyRefreshFailures" >= 0),
  CONSTRAINT "CalendarConnection_disconnect_shape_check" CHECK (
    ("status" = 'DISCONNECTING') = ("disconnectRequestedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "CalendarConnection_userId_key" ON "CalendarConnection"("userId");
CREATE UNIQUE INDEX "CalendarConnection_provider_providerAccountId_key"
  ON "CalendarConnection"("provider", "providerAccountId");
CREATE INDEX "CalendarConnection_busy_refresh_idx"
  ON "CalendarConnection"("status", "busyCheckEnabled", "busyRefreshAfter", "busyRefreshLeaseUntil");

ALTER TABLE "CalendarConnection" ADD CONSTRAINT "CalendarConnection_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CalendarOAuthAttempt" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authSessionId" TEXT NOT NULL,
  "stateDigest" TEXT NOT NULL,
  "codeVerifierCiphertext" TEXT NOT NULL,
  "returnTo" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalendarOAuthAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarOAuthAttempt_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "CalendarOAuthAttempt_stateDigest_key" ON "CalendarOAuthAttempt"("stateDigest");
CREATE INDEX "CalendarOAuthAttempt_userId_expiresAt_idx" ON "CalendarOAuthAttempt"("userId", "expiresAt");
CREATE INDEX "CalendarOAuthAttempt_authSessionId_expiresAt_idx"
  ON "CalendarOAuthAttempt"("authSessionId", "expiresAt");
ALTER TABLE "CalendarOAuthAttempt" ADD CONSTRAINT "CalendarOAuthAttempt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarOAuthAttempt" ADD CONSTRAINT "CalendarOAuthAttempt_authSessionId_fkey"
  FOREIGN KEY ("authSessionId") REFERENCES "AuthSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CalendarRevocationJob" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'GOOGLE',
  "tokenCiphertext" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leasedUntil" TIMESTAMP(3),
  "leaseToken" TEXT,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalendarRevocationJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarRevocationJob_provider_check" CHECK ("provider" = 'GOOGLE'),
  CONSTRAINT "CalendarRevocationJob_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "CalendarRevocationJob_lease_shape_check" CHECK (
    ("leasedUntil" IS NULL AND "leaseToken" IS NULL)
    OR ("leasedUntil" IS NOT NULL AND "leaseToken" IS NOT NULL)
  )
);

CREATE INDEX "CalendarRevocationJob_available_idx"
  ON "CalendarRevocationJob"("availableAt", "leasedUntil");

CREATE TABLE "CalendarEventProjection" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "bookingId" TEXT,
  "providerEventId" TEXT NOT NULL,
  "providerEtag" TEXT,
  "syncedRevision" INTEGER NOT NULL,
  "cleanupAttempts" INTEGER NOT NULL DEFAULT 0,
  "cleanupAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cleanupLeaseUntil" TIMESTAMP(3),
  "cleanupLeaseToken" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalendarEventProjection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarEventProjection_syncedRevision_check" CHECK ("syncedRevision" >= 0),
  CONSTRAINT "CalendarEventProjection_cleanupAttempts_check" CHECK ("cleanupAttempts" >= 0),
  CONSTRAINT "CalendarEventProjection_cleanup_lease_shape_check" CHECK (
    ("cleanupLeaseUntil" IS NULL AND "cleanupLeaseToken" IS NULL)
    OR ("cleanupLeaseUntil" IS NOT NULL AND "cleanupLeaseToken" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "CalendarEventProjection_connectionId_bookingId_key"
  ON "CalendarEventProjection"("connectionId", "bookingId");
CREATE UNIQUE INDEX "CalendarEventProjection_connectionId_providerEventId_key"
  ON "CalendarEventProjection"("connectionId", "providerEventId");
CREATE INDEX "CalendarEventProjection_bookingId_idx" ON "CalendarEventProjection"("bookingId");
CREATE INDEX "CalendarEventProjection_cleanup_idx"
  ON "CalendarEventProjection"("bookingId", "cleanupAfter", "cleanupLeaseUntil");
ALTER TABLE "CalendarEventProjection" ADD CONSTRAINT "CalendarEventProjection_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "CalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarEventProjection" ADD CONSTRAINT "CalendarEventProjection_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CalendarSyncJob" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "requestedRevision" INTEGER NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leasedUntil" TIMESTAMP(3),
  "leaseToken" TEXT,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalendarSyncJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarSyncJob_requestedRevision_check" CHECK ("requestedRevision" >= 0),
  CONSTRAINT "CalendarSyncJob_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "CalendarSyncJob_lease_shape_check" CHECK (
    ("leasedUntil" IS NULL AND "leaseToken" IS NULL)
    OR ("leasedUntil" IS NOT NULL AND "leaseToken" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "CalendarSyncJob_bookingId_key" ON "CalendarSyncJob"("bookingId");
CREATE INDEX "CalendarSyncJob_availableAt_leasedUntil_idx"
  ON "CalendarSyncJob"("availableAt", "leasedUntil");
ALTER TABLE "CalendarSyncJob" ADD CONSTRAINT "CalendarSyncJob_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CalendarBusyInterval" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CalendarBusyInterval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarBusyInterval_order_check" CHECK ("endAt" > "startAt")
);

CREATE INDEX "CalendarBusyInterval_connectionId_startAt_endAt_idx"
  ON "CalendarBusyInterval"("connectionId", "startAt", "endAt");
CREATE INDEX "CalendarBusyInterval_expiresAt_idx" ON "CalendarBusyInterval"("expiresAt");
ALTER TABLE "CalendarBusyInterval" ADD CONSTRAINT "CalendarBusyInterval_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "CalendarConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
