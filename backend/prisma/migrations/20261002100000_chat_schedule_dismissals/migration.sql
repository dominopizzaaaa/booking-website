-- A person's dismissal of the session their chat detected. One row per
-- person and conversation; the key names the suggestion they hid.
CREATE TABLE "ChatScheduleDismissal" (
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "suggestionKey" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatScheduleDismissal_pkey" PRIMARY KEY ("threadId","userId"),
    CONSTRAINT "ChatScheduleDismissal_suggestionKey_check" CHECK ("suggestionKey" ~ '^[0-9a-f]{32}$')
);

CREATE INDEX "ChatScheduleDismissal_userId_idx" ON "ChatScheduleDismissal"("userId");

ALTER TABLE "ChatScheduleDismissal" ADD CONSTRAINT "ChatScheduleDismissal_threadId_fkey"
  FOREIGN KEY ("threadId") REFERENCES "ChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChatScheduleDismissal" ADD CONSTRAINT "ChatScheduleDismissal_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
