-- Session chat: one conversation per booked Class, next-session proposals
-- raised from it, and per-person read positions. Every table is new, so no
-- existing row needs auditing; the constraints below apply from the start.
BEGIN;

-- Foreign keys below briefly lock Booking, Service, Location, Instructor,
-- Business and User. Fail fast rather than queue behind live traffic.
SET LOCAL lock_timeout = '10s';

CREATE TABLE "ChatThread" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reminderStartAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatThread_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TEXT',
    "event" TEXT NOT NULL DEFAULT '',
    "senderUserId" TEXT,
    "senderRole" TEXT NOT NULL,
    "senderName" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "proposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChatMessage_kind_check" CHECK ("kind" IN ('TEXT', 'SYSTEM', 'PROPOSAL')),
    CONSTRAINT "ChatMessage_sender_role_check" CHECK ("senderRole" IN ('STUDENT', 'COACH', 'CLUB', 'SYSTEM')),
    -- People write TEXT and PROPOSAL rows; only the platform writes SYSTEM
    -- rows, and only SYSTEM rows name a lifecycle event.
    CONSTRAINT "ChatMessage_kind_role_check" CHECK (("kind" = 'SYSTEM') = ("senderRole" = 'SYSTEM')),
    CONSTRAINT "ChatMessage_event_check" CHECK (("kind" = 'SYSTEM') = ("event" <> '')),
    CONSTRAINT "ChatMessage_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000)
);

CREATE TABLE "ChatReadState" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatReadState_pkey" PRIMARY KEY ("threadId","userId")
);

CREATE TABLE "SessionProposal" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "instructorId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "proposedByRole" TEXT NOT NULL,
    "proposedByUserId" TEXT,
    "proposedByName" TEXT NOT NULL,
    "targetStudentUserId" TEXT,
    "targetStudentName" TEXT NOT NULL DEFAULT '',
    "counterOfId" TEXT,
    "message" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionProposal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SessionProposal_role_check" CHECK ("proposedByRole" IN ('STUDENT', 'COACH')),
    CONSTRAINT "SessionProposal_status_check"
      CHECK ("status" IN ('OPEN', 'ACCEPTED', 'DECLINED', 'COUNTERED', 'WITHDRAWN', 'CLOSED')),
    CONSTRAINT "SessionProposal_closed_check" CHECK (("status" = 'OPEN') = ("closedAt" IS NULL)),
    CONSTRAINT "SessionProposal_interval_check" CHECK ("endAt" > "startAt"),
    -- A student can only ever propose a session for themselves.
    CONSTRAINT "SessionProposal_student_target_check"
      CHECK ("proposedByRole" <> 'STUDENT' OR "targetStudentUserId" IS NOT NULL),
    CONSTRAINT "SessionProposal_message_check" CHECK (char_length("message") <= 500)
);

CREATE TABLE "SessionProposalResponse" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "studentUserId" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "responderUserId" TEXT,
    "status" TEXT NOT NULL,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionProposalResponse_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SessionProposalResponse_status_check" CHECK ("status" IN ('ACCEPTED', 'DECLINED', 'COUNTERED'))
);

CREATE UNIQUE INDEX "ChatThread_bookingId_key" ON "ChatThread"("bookingId");
CREATE INDEX "ChatThread_businessId_lastMessageAt_idx" ON "ChatThread"("businessId", "lastMessageAt");
CREATE INDEX "ChatThread_lastMessageAt_idx" ON "ChatThread"("lastMessageAt");
CREATE UNIQUE INDEX "ChatThread_id_businessId_key" ON "ChatThread"("id", "businessId");
CREATE UNIQUE INDEX "ChatThread_bookingId_businessId_key" ON "ChatThread"("bookingId", "businessId");
CREATE INDEX "ChatMessage_threadId_createdAt_idx" ON "ChatMessage"("threadId", "createdAt");
CREATE INDEX "ChatMessage_proposalId_idx" ON "ChatMessage"("proposalId");
CREATE INDEX "ChatReadState_userId_idx" ON "ChatReadState"("userId");
CREATE INDEX "SessionProposal_threadId_status_idx" ON "SessionProposal"("threadId", "status");
CREATE INDEX "SessionProposal_businessId_idx" ON "SessionProposal"("businessId");
CREATE INDEX "SessionProposal_counterOfId_idx" ON "SessionProposal"("counterOfId");
CREATE INDEX "SessionProposalResponse_bookingId_idx" ON "SessionProposalResponse"("bookingId");
CREATE UNIQUE INDEX "SessionProposalResponse_proposalId_studentUserId_key"
  ON "SessionProposalResponse"("proposalId", "studentUserId");

-- A thread belongs to its booking's business; deleting the booking (only
-- possible in an explicit business teardown) removes its conversation.
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatThread" ADD CONSTRAINT "ChatThread_bookingId_businessId_fkey"
  FOREIGN KEY ("bookingId", "businessId") REFERENCES "Booking"("id", "businessId") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_proposalId_fkey"
  FOREIGN KEY ("proposalId") REFERENCES "SessionProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderUserId_fkey"
  FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatReadState" ADD CONSTRAINT "ChatReadState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The proposal's thread, Class, coach and venue must all share its business.
ALTER TABLE "SessionProposal" ADD CONSTRAINT "SessionProposal_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionProposal" ADD CONSTRAINT "SessionProposal_threadId_businessId_fkey"
  FOREIGN KEY ("threadId", "businessId") REFERENCES "ChatThread"("id", "businessId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "SessionProposal" ADD CONSTRAINT "SessionProposal_serviceId_businessId_fkey"
  FOREIGN KEY ("serviceId", "businessId") REFERENCES "Service"("id", "businessId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "SessionProposal" ADD CONSTRAINT "SessionProposal_instructorId_businessId_fkey"
  FOREIGN KEY ("instructorId", "businessId") REFERENCES "Instructor"("id", "businessId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "SessionProposal" ADD CONSTRAINT "SessionProposal_locationId_businessId_fkey"
  FOREIGN KEY ("locationId", "businessId") REFERENCES "Location"("id", "businessId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "SessionProposal" ADD CONSTRAINT "SessionProposal_counterOfId_fkey"
  FOREIGN KEY ("counterOfId") REFERENCES "SessionProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SessionProposal" ADD CONSTRAINT "SessionProposal_proposedByUserId_fkey"
  FOREIGN KEY ("proposedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- A proposal for one student is meaningless without them. Removing the
-- account removes the proposal rather than widening it to a whole group.
ALTER TABLE "SessionProposal" ADD CONSTRAINT "SessionProposal_targetStudentUserId_fkey"
  FOREIGN KEY ("targetStudentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SessionProposalResponse" ADD CONSTRAINT "SessionProposalResponse_proposalId_fkey"
  FOREIGN KEY ("proposalId") REFERENCES "SessionProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionProposalResponse" ADD CONSTRAINT "SessionProposalResponse_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SessionProposalResponse" ADD CONSTRAINT "SessionProposalResponse_studentUserId_fkey"
  FOREIGN KEY ("studentUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionProposalResponse" ADD CONSTRAINT "SessionProposalResponse_responderUserId_fkey"
  FOREIGN KEY ("responderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Direct tenant parents introduced here cannot move between businesses. This
-- reuses the trigger function installed by the core-tenancy migration.
CREATE TRIGGER "ChatThread_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "ChatThread"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();
CREATE TRIGGER "SessionProposal_businessId_immutable"
  BEFORE UPDATE OF "businessId" ON "SessionProposal"
  FOR EACH ROW EXECUTE FUNCTION "_courtly_reject_business_id_change"();

-- Retained SOLO and read-only history stays closed: a conversation can only
-- open around a booking made under an active club's money path.
CREATE FUNCTION "_courtly_reject_inactive_chat_thread_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Booking" AS booking
    JOIN "Business" AS business ON business."id" = booking."businessId"
    WHERE booking."id" = NEW."bookingId"
      AND booking."businessId" = NEW."businessId"
      AND booking."paymentRoute" = 'CLUB'
      AND business."kind" = 'CLUB'
      AND business."legacyReadOnly" = false
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A session chat requires a booking made through an active CLUB business';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatThread_active_club_insert"
  BEFORE INSERT ON "ChatThread" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_inactive_chat_thread_insert"();

COMMIT;
