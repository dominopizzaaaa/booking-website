BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE "PaymentIntent" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT "participantId"
    FROM "PaymentIntent"
    WHERE "participantId" IS NOT NULL
      AND "provider" = 'STRIPE'
      AND "status" IN ('REQUIRES_CONFIRMATION', 'FAILED')
    GROUP BY "participantId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A booking participant has more than one active Stripe checkout intent';
  END IF;
END
$$;

CREATE UNIQUE INDEX "PaymentIntent_one_active_stripe_booking_checkout"
  ON "PaymentIntent" ("participantId")
  WHERE "participantId" IS NOT NULL
    AND "provider" = 'STRIPE'
    AND "status" IN ('REQUIRES_CONFIRMATION', 'FAILED');

COMMIT;
