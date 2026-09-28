BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE "Payment", "PaymentIntent", "PaymentRefund" IN SHARE ROW EXCLUSIVE MODE;

-- A refund may omit paymentId for a valid rental without a legacy ledger row.
-- When one is present, it must be the unique payment produced by that exact
-- PaymentIntent, not merely another payment in the same tenant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentRefund" AS refund
    JOIN "Payment" AS payment
      ON payment."id" = refund."paymentId"
      AND payment."businessId" = refund."businessId"
    WHERE refund."paymentId" IS NOT NULL
      AND payment."paymentIntentId" IS DISTINCT FROM refund."paymentIntentId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PaymentRefund.paymentId does not belong to its payment intent';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "_courtly_assert_refund_payment_identity"()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentRefund" AS refund
    JOIN "Payment" AS payment
      ON payment."id" = refund."paymentId"
      AND payment."businessId" = refund."businessId"
    WHERE refund."paymentId" IS NOT NULL
      AND payment."paymentIntentId" IS DISTINCT FROM refund."paymentIntentId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payment refund must name the payment produced by its payment intent';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "_courtly_refund_payment_identity_constraint"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20260928, 193000);
  PERFORM "_courtly_assert_refund_payment_identity"();
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "PaymentRefund_payment_identity_invariant"
  AFTER INSERT OR UPDATE ON "PaymentRefund" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_refund_payment_identity_constraint"();
CREATE CONSTRAINT TRIGGER "Payment_refund_identity_invariant"
  AFTER UPDATE OF "businessId", "paymentIntentId" ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_refund_payment_identity_constraint"();

-- A declined Stripe PaymentIntent is reusable. Reopening it exposes the same
-- provider intent and client secret; no second charge attempt is created.
CREATE OR REPLACE FUNCTION "_courtly_protect_terminal_payment_intent"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_lock_commercial_business"(OLD."businessId");
  IF OLD."status" IN ('SUCCEEDED', 'REFUNDED', 'FAILED') AND TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'FAILED' AND OLD."provider" = 'STRIPE'
      AND NEW."status" IN ('REQUIRES_CONFIRMATION', 'SUCCEEDED') THEN
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
        MESSAGE = 'Terminal checkout intent history is immutable except for Stripe retries and successful refunds';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
