BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Training-companion release: public club and coach profiles, coach feedback,
-- group-Class waitlists, an append-only package credit ledger, club-local
-- training groups, saved clubs, and person-free club funnel counters.

-- Public club profile ------------------------------------------------------
ALTER TABLE "Business"
  ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "publicPhone" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "websiteUrl" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Business"
  ADD CONSTRAINT "Business_public_profile_check" CHECK (
    char_length("description") <= 1200
    AND char_length("publicPhone") <= 40
    AND char_length("websiteUrl") <= 200
    AND ("websiteUrl" = '' OR "websiteUrl" ~ '^https://[^[:space:]]+$')
  );

ALTER TABLE "Location" ADD COLUMN "area" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Location"
  ADD CONSTRAINT "Location_area_check" CHECK (char_length("area") <= 60);

-- Portable coach profile. Only coach accounts may carry these values.
ALTER TABLE "User"
  ADD COLUMN "bio" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "coachingLevels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "coachingAgeGroups" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "qualifications" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "coachingSince" INTEGER;

ALTER TABLE "User"
  ADD CONSTRAINT "User_coach_profile_check" CHECK (
    char_length("bio") <= 600
    AND cardinality("languages") <= 8
    AND "coachingLevels" <@ ARRAY['BEGINNER','INTERMEDIATE','ADVANCED','COMPETITIVE']::TEXT[]
    AND "coachingAgeGroups" <@ ARRAY['JUNIOR','TEEN','ADULT','SENIOR']::TEXT[]
    AND cardinality("qualifications") <= 10
    AND ("coachingSince" IS NULL OR "coachingSince" BETWEEN 1950 AND 2100)
    AND (
      "accountType" = 'COACH'
      OR (
        "bio" = '' AND cardinality("languages") = 0 AND cardinality("coachingLevels") = 0
        AND cardinality("coachingAgeGroups") = 0 AND cardinality("qualifications") = 0
        AND "coachingSince" IS NULL
      )
    )
  );

-- Attendance vocabulary gains LATE (attended) and EXCUSED (not attended).
ALTER TABLE "Participant"
  ADD CONSTRAINT "Participant_attendance_check" CHECK (
    "attendance" IN ('UNMARKED', 'PRESENT', 'LATE', 'ABSENT', 'EXCUSED')
  );

-- Package reminders are deduplicated per package and alert type.
ALTER TABLE "AccountNotification" ADD COLUMN "packageId" TEXT;
CREATE INDEX "AccountNotification_packageId_type_idx" ON "AccountNotification"("packageId", "type");
ALTER TABLE "AccountNotification" ADD CONSTRAINT "AccountNotification_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "LessonPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Coach feedback -----------------------------------------------------------
CREATE TABLE "SessionFeedback" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "authorUserId" TEXT,
  "authorName" TEXT NOT NULL,
  "authorRole" TEXT NOT NULL,
  "editedByName" TEXT,
  "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
  "summary" TEXT NOT NULL DEFAULT '',
  "strengths" TEXT NOT NULL DEFAULT '',
  "focusAreas" TEXT NOT NULL DEFAULT '',
  "nextGoal" TEXT NOT NULL DEFAULT '',
  "clubNote" TEXT NOT NULL DEFAULT '',
  "sharedAt" TIMESTAMP(3),
  "firstViewedAt" TIMESTAMP(3),
  "editedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SessionFeedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SessionFeedback_shape_check" CHECK (
    "visibility" IN ('SHARED', 'PRIVATE')
    AND "authorRole" IN ('COACH', 'CLUB', 'STAFF')
    AND char_length("authorName") BETWEEN 1 AND 160
    AND char_length("summary") <= 2000
    AND char_length("strengths") <= 600
    AND char_length("focusAreas") <= 600
    AND char_length("nextGoal") <= 300
    AND char_length("clubNote") <= 1000
    AND ("visibility" = 'PRIVATE' OR "sharedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "SessionFeedback_participantId_key" ON "SessionFeedback"("participantId");
CREATE INDEX "SessionFeedback_businessId_sharedAt_idx" ON "SessionFeedback"("businessId", "sharedAt");
CREATE INDEX "SessionFeedback_bookingId_idx" ON "SessionFeedback"("bookingId");

ALTER TABLE "SessionFeedback" ADD CONSTRAINT "SessionFeedback_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionFeedback" ADD CONSTRAINT "SessionFeedback_bookingId_businessId_fkey"
  FOREIGN KEY ("bookingId", "businessId") REFERENCES "Booking"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SessionFeedback" ADD CONSTRAINT "SessionFeedback_participantId_fkey"
  FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionFeedback" ADD CONSTRAINT "SessionFeedback_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Feedback is pinned to one place in one booking, and that tenant link never
-- moves after creation.
CREATE FUNCTION "_courtly_session_feedback_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."businessId" IS DISTINCT FROM OLD."businessId"
    OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
    OR NEW."participantId" IS DISTINCT FROM OLD."participantId"
    OR NEW."authorName" IS DISTINCT FROM OLD."authorName"
    OR NEW."authorRole" IS DISTINCT FROM OLD."authorRole"
    OR (OLD."sharedAt" IS NOT NULL AND NEW."sharedAt" IS DISTINCT FROM OLD."sharedAt")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Session feedback identity and first-shared time are immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Participant"
    WHERE "id" = NEW."participantId" AND "bookingId" = NEW."bookingId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23503',
      MESSAGE = 'Session feedback must name a participant of its booking';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SessionFeedback_identity_guard"
  BEFORE INSERT OR UPDATE ON "SessionFeedback" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_session_feedback_identity"();

-- Waitlists ----------------------------------------------------------------
CREATE TABLE "WaitlistEntry" (
  "id" TEXT NOT NULL,
  "sequence" SERIAL NOT NULL,
  "businessId" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WAITING',
  "offeredAt" TIMESTAMP(3),
  "offerExpiresAt" TIMESTAMP(3),
  "respondedAt" TIMESTAMP(3),
  "closedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WaitlistEntry_status_check" CHECK (
    "status" IN ('WAITING', 'OFFERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN', 'REMOVED', 'CLOSED')
  ),
  CONSTRAINT "WaitlistEntry_offer_shape_check" CHECK (
    "status" <> 'OFFERED' OR ("offeredAt" IS NOT NULL AND "offerExpiresAt" IS NOT NULL)
  ),
  CONSTRAINT "WaitlistEntry_closed_reason_check" CHECK (
    "closedReason" IS NULL OR char_length("closedReason") <= 200
  )
);

CREATE UNIQUE INDEX "WaitlistEntry_sequence_key" ON "WaitlistEntry"("sequence");
CREATE INDEX "WaitlistEntry_bookingId_status_sequence_idx" ON "WaitlistEntry"("bookingId", "status", "sequence");
CREATE INDEX "WaitlistEntry_studentId_status_idx" ON "WaitlistEntry"("studentId", "status");
CREATE INDEX "WaitlistEntry_status_offerExpiresAt_idx" ON "WaitlistEntry"("status", "offerExpiresAt");
-- One live queue place per student and Class occurrence.
CREATE UNIQUE INDEX "WaitlistEntry_one_live_per_student"
  ON "WaitlistEntry"("bookingId", "studentId")
  WHERE "status" IN ('WAITING', 'OFFERED');

ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_bookingId_businessId_fkey"
  FOREIGN KEY ("bookingId", "businessId") REFERENCES "Booking"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_studentId_businessId_fkey"
  FOREIGN KEY ("studentId", "businessId") REFERENCES "Student"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- A terminal waitlist decision is final; a new request creates a new row.
CREATE FUNCTION "_courtly_waitlist_entry_lifecycle"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."businessId" IS DISTINCT FROM OLD."businessId"
    OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
    OR NEW."studentId" IS DISTINCT FROM OLD."studentId"
    OR NEW."sequence" IS DISTINCT FROM OLD."sequence" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A waitlist entry cannot move to another Class or student';
  END IF;
  IF OLD."status" NOT IN ('WAITING', 'OFFERED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A closed waitlist entry cannot reopen';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "WaitlistEntry_lifecycle_guard"
  BEFORE UPDATE ON "WaitlistEntry" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_waitlist_entry_lifecycle"();

-- Package credit ledger ----------------------------------------------------
CREATE TABLE "PackageCreditEvent" (
  "id" TEXT NOT NULL,
  "sequence" SERIAL NOT NULL,
  "businessId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "totalAfter" INTEGER NOT NULL,
  "usedAfter" INTEGER NOT NULL,
  "bookingId" TEXT,
  "participantId" TEXT,
  "reservationId" TEXT,
  "actorUserId" TEXT,
  "note" TEXT NOT NULL DEFAULT '',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PackageCreditEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PackageCreditEvent_kind_check" CHECK (
    "kind" IN ('OPENING_BALANCE', 'GRANTED', 'BOOKED', 'RESTORED', 'RENTAL_RESERVED', 'RENTAL_RESTORED', 'ADJUSTED', 'USED')
  ),
  CONSTRAINT "PackageCreditEvent_note_check" CHECK (char_length("note") <= 300)
);

CREATE UNIQUE INDEX "PackageCreditEvent_sequence_key" ON "PackageCreditEvent"("sequence");
CREATE INDEX "PackageCreditEvent_packageId_sequence_idx" ON "PackageCreditEvent"("packageId", "sequence");
CREATE INDEX "PackageCreditEvent_businessId_createdAt_idx" ON "PackageCreditEvent"("businessId", "createdAt");

ALTER TABLE "PackageCreditEvent" ADD CONSTRAINT "PackageCreditEvent_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PackageCreditEvent" ADD CONSTRAINT "PackageCreditEvent_packageId_businessId_fkey"
  FOREIGN KEY ("packageId", "businessId") REFERENCES "LessonPackage"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- Existing packages start from a single opening-balance row; activity before
-- this migration is summarized rather than reconstructed.
INSERT INTO "PackageCreditEvent" (
  "id", "businessId", "packageId", "studentId", "kind", "delta", "totalAfter", "usedAfter", "note", "createdAt"
)
SELECT
  'pce_' || replace(gen_random_uuid()::text, '-', ''),
  package."businessId", package."id", package."studentId", 'OPENING_BALANCE',
  package."totalCredits" - package."usedCredits", package."totalCredits", package."usedCredits",
  'Balance when credit activity tracking began',
  (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
FROM "LessonPackage" AS package
ORDER BY package."id";

-- Every balance change is recorded here, whichever code path made it. Callers
-- label a change with the transaction-local courtly.credit_context JSON
-- setting; an unlabelled change is still recorded as USED/RESTORED/ADJUSTED.
CREATE FUNCTION "_courtly_record_package_credit_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  raw_context TEXT;
  context JSONB;
  label TEXT;
  note_text TEXT;
  occurred TIMESTAMP(3) := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
BEGIN
  raw_context := current_setting('courtly.credit_context', true);
  IF raw_context IS NOT NULL AND raw_context <> '' THEN
    BEGIN
      context := raw_context::jsonb;
    EXCEPTION WHEN others THEN
      context := NULL;
    END;
  END IF;
  note_text := left(COALESCE(context->>'note', ''), 300);

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "PackageCreditEvent" (
      "id", "businessId", "packageId", "studentId", "kind", "delta", "totalAfter", "usedAfter",
      "actorUserId", "note", "createdAt"
    ) VALUES (
      'pce_' || replace(gen_random_uuid()::text, '-', ''), NEW."businessId", NEW."id", NEW."studentId",
      'GRANTED', NEW."totalCredits", NEW."totalCredits", 0,
      context->>'actorUserId', left(COALESCE(NULLIF(note_text, ''), NEW."name"), 300), occurred
    );
    IF NEW."usedCredits" > 0 THEN
      INSERT INTO "PackageCreditEvent" (
        "id", "businessId", "packageId", "studentId", "kind", "delta", "totalAfter", "usedAfter",
        "actorUserId", "note", "createdAt"
      ) VALUES (
        'pce_' || replace(gen_random_uuid()::text, '-', ''), NEW."businessId", NEW."id", NEW."studentId",
        'USED', -NEW."usedCredits", NEW."totalCredits", NEW."usedCredits",
        context->>'actorUserId', 'Credits used when the package was created', occurred
      );
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."totalCredits" IS DISTINCT FROM OLD."totalCredits" THEN
    INSERT INTO "PackageCreditEvent" (
      "id", "businessId", "packageId", "studentId", "kind", "delta", "totalAfter", "usedAfter",
      "actorUserId", "note", "createdAt"
    ) VALUES (
      'pce_' || replace(gen_random_uuid()::text, '-', ''), NEW."businessId", NEW."id", NEW."studentId",
      'ADJUSTED', NEW."totalCredits" - OLD."totalCredits", NEW."totalCredits", OLD."usedCredits",
      context->>'actorUserId', COALESCE(NULLIF(note_text, ''), 'Package size changed'), occurred
    );
  END IF;

  IF NEW."usedCredits" IS DISTINCT FROM OLD."usedCredits" THEN
    label := context->>'kind';
    IF label IS NULL OR label NOT IN ('BOOKED', 'RESTORED', 'RENTAL_RESERVED', 'RENTAL_RESTORED', 'ADJUSTED', 'USED') THEN
      label := CASE WHEN NEW."usedCredits" > OLD."usedCredits" THEN 'USED' ELSE 'RESTORED' END;
    END IF;
    INSERT INTO "PackageCreditEvent" (
      "id", "businessId", "packageId", "studentId", "kind", "delta", "totalAfter", "usedAfter",
      "bookingId", "participantId", "reservationId", "actorUserId", "note", "createdAt"
    ) VALUES (
      'pce_' || replace(gen_random_uuid()::text, '-', ''), NEW."businessId", NEW."id", NEW."studentId",
      label, OLD."usedCredits" - NEW."usedCredits", NEW."totalCredits", NEW."usedCredits",
      context->>'bookingId', context->>'participantId', context->>'reservationId',
      context->>'actorUserId', note_text, occurred
    );
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LessonPackage_credit_ledger"
  AFTER INSERT OR UPDATE OF "totalCredits", "usedCredits" ON "LessonPackage"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_record_package_credit_event"();

-- Ledger rows are append-only. They disappear only with their package or
-- business, for example in an explicit whole-business teardown.
CREATE FUNCTION "_courtly_protect_package_credit_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Package credit history is append-only';
  END IF;
  IF EXISTS (SELECT 1 FROM "LessonPackage" WHERE "id" = OLD."packageId")
    AND EXISTS (SELECT 1 FROM "Business" WHERE "id" = OLD."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Package credit history is append-only';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "PackageCreditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "PackageCreditEvent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_protect_package_credit_event"();

-- Training groups ----------------------------------------------------------
CREATE TABLE "TrainingGroup" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sport" TEXT NOT NULL DEFAULT '',
  "level" TEXT NOT NULL DEFAULT '',
  "ageBand" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "scheduleNote" TEXT NOT NULL DEFAULT '',
  "capacity" INTEGER,
  "serviceId" TEXT,
  "locationId" TEXT,
  "instructorId" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TrainingGroup_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingGroup_shape_check" CHECK (
    char_length("name") BETWEEN 1 AND 80
    AND char_length("sport") <= 40
    AND char_length("level") <= 40
    AND char_length("ageBand") <= 40
    AND char_length("description") <= 600
    AND char_length("scheduleNote") <= 120
    AND ("capacity" IS NULL OR "capacity" BETWEEN 1 AND 500)
  )
);

CREATE UNIQUE INDEX "TrainingGroup_id_businessId_key" ON "TrainingGroup"("id", "businessId");
CREATE INDEX "TrainingGroup_businessId_active_idx" ON "TrainingGroup"("businessId", "active");

CREATE TABLE "TrainingGroupMember" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMP(3),

  CONSTRAINT "TrainingGroupMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingGroupMember_active_shape_check" CHECK ("active" = ("leftAt" IS NULL))
);

CREATE UNIQUE INDEX "TrainingGroupMember_groupId_studentId_key" ON "TrainingGroupMember"("groupId", "studentId");
CREATE INDEX "TrainingGroupMember_businessId_studentId_idx" ON "TrainingGroupMember"("businessId", "studentId");

ALTER TABLE "TrainingGroup" ADD CONSTRAINT "TrainingGroup_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrainingGroupMember" ADD CONSTRAINT "TrainingGroupMember_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrainingGroupMember" ADD CONSTRAINT "TrainingGroupMember_groupId_businessId_fkey"
  FOREIGN KEY ("groupId", "businessId") REFERENCES "TrainingGroup"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "TrainingGroupMember" ADD CONSTRAINT "TrainingGroupMember_studentId_businessId_fkey"
  FOREIGN KEY ("studentId", "businessId") REFERENCES "Student"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- Saved clubs --------------------------------------------------------------
CREATE TABLE "FavoriteClub" (
  "userId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FavoriteClub_pkey" PRIMARY KEY ("userId", "businessId")
);

CREATE INDEX "FavoriteClub_businessId_idx" ON "FavoriteClub"("businessId");
ALTER TABLE "FavoriteClub" ADD CONSTRAINT "FavoriteClub_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FavoriteClub" ADD CONSTRAINT "FavoriteClub_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Person-free funnel counters ---------------------------------------------
CREATE TABLE "ClubFunnelCounter" (
  "businessId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "metric" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "ClubFunnelCounter_pkey" PRIMARY KEY ("businessId", "day", "metric"),
  CONSTRAINT "ClubFunnelCounter_shape_check" CHECK (
    "count" >= 0
    AND "metric" IN (
      'PAGE_VIEW', 'AVAILABILITY_CHECK', 'BOOKING_CREATED', 'REBOOK_CREATED',
      'WAITLIST_JOINED', 'WAITLIST_ACCEPTED', 'SEARCH_IMPRESSION'
    )
  )
);

ALTER TABLE "ClubFunnelCounter" ADD CONSTRAINT "ClubFunnelCounter_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
