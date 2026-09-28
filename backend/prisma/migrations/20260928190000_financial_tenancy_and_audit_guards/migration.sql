BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- Close the write window while existing refund links are audited and the
-- tenant-bound foreign key is installed.
LOCK TABLE "Business", "BusinessAuditEvent", "Payment", "PaymentIntent", "PaymentRefund"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PaymentRefund" AS refund
    JOIN "Payment" AS payment ON payment."id" = refund."paymentId"
    WHERE refund."paymentId" IS NOT NULL
      AND payment."businessId" <> refund."businessId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'PaymentRefund.paymentId contains a cross-business reference';
  END IF;
END
$$;

CREATE UNIQUE INDEX "Payment_id_businessId_key" ON "Payment"("id", "businessId");
ALTER TABLE "PaymentRefund" DROP CONSTRAINT "PaymentRefund_paymentId_fkey";
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_businessId_fkey"
  FOREIGN KEY ("paymentId", "businessId") REFERENCES "Payment"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Stripe keeps a failed PaymentIntent reusable. Simulated attempts do not have
-- that provider lifecycle and remain terminal evidence.
CREATE OR REPLACE FUNCTION "_courtly_protect_terminal_payment_intent"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "_courtly_lock_commercial_business"(OLD."businessId");
  IF OLD."status" IN ('SUCCEEDED', 'REFUNDED', 'FAILED') AND TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'FAILED' AND OLD."provider" = 'STRIPE'
      AND NEW."status" = 'SUCCEEDED' THEN
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

-- Audit snapshots are append-only while their business exists. The deferred
-- delete check still permits the existing explicit whole-business teardown: a
-- cascading delete is valid only when the parent is absent at commit time.
CREATE FUNCTION "_courtly_reject_business_audit_event_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'Business audit event history is immutable';
END;
$$;

CREATE FUNCTION "_courtly_reject_business_audit_event_delete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Business" WHERE "id" = OLD."businessId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Business audit event history is immutable';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "BusinessAuditEvent_history_update_guard"
  BEFORE UPDATE ON "BusinessAuditEvent" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_business_audit_event_update"();
CREATE CONSTRAINT TRIGGER "BusinessAuditEvent_history_delete_guard"
  AFTER DELETE ON "BusinessAuditEvent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "_courtly_reject_business_audit_event_delete"();

COMMIT;
