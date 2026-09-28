BEGIN;

-- A Stripe PaymentIntent can emit payment_failed and later succeed after the
-- customer retries it. Preserve the immutable checkout contract while allowing
-- that provider-authored recovery and its fulfillment references.
CREATE OR REPLACE FUNCTION "_courtly_protect_terminal_payment_intent"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_lock_commercial_business"(OLD."businessId");
  IF OLD."status" IN ('SUCCEEDED', 'REFUNDED', 'FAILED') AND TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'FAILED' AND NEW."status" = 'SUCCEEDED' THEN
      IF ROW(OLD."id", OLD."userId", OLD."businessId", OLD."kind",
        OLD."packageOfferId", OLD."participantId", OLD."reservationId",
        OLD."amount", OLD."currency", OLD."provider", OLD."providerAccountReference",
        OLD."providerReference", OLD."checkoutSnapshot", OLD."idempotencyKey",
        OLD."expiresAt", OLD."createdAt")
        IS DISTINCT FROM
        ROW(NEW."id", NEW."userId", NEW."businessId", NEW."kind",
        NEW."packageOfferId", NEW."participantId", NEW."reservationId",
        NEW."amount", NEW."currency", NEW."provider", NEW."providerAccountReference",
        NEW."providerReference", NEW."checkoutSnapshot", NEW."idempotencyKey",
        NEW."expiresAt", NEW."createdAt")
      THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Recovered checkout intent contract is immutable';
      END IF;
    ELSIF NOT (NEW."status" = OLD."status"
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
        MESSAGE = 'Terminal checkout intent history is immutable except for successful retries and refunds';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
