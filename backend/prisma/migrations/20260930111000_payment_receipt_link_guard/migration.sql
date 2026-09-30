BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION "_courtly_validate_payment_receipt"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "PaymentIntent" AS intent
    JOIN "Payment" AS payment
      ON payment."id" = NEW."paymentId"
     AND payment."paymentIntentId" = intent."id"
     AND payment."businessId" = intent."businessId"
    WHERE intent."id" = NEW."paymentIntentId"
      AND intent."businessId" = NEW."businessId"
      AND intent."userId" = NEW."userId"
      AND intent."kind" = NEW."kind"
      AND intent."amount" = NEW."amount"
      AND payment."amount" = NEW."amount"
      AND intent."currency" = NEW."currency"
      AND intent."provider" = NEW."paymentProvider"
      AND intent."status" IN ('SUCCEEDED', 'REFUNDED')
      AND payment."kind" = 'STUDENT_TO_CLUB'
      AND intent."acceptedReviewHash" = NEW."checkoutReviewHash"
      AND intent."checkoutSnapshot" #>> '{review,reviewHash}' = NEW."checkoutReviewHash"
      AND intent."checkoutSnapshot" #> '{review,merchant}' = NEW."merchantSnapshot"
      AND intent."checkoutSnapshot" #> '{review,purchaser}' = NEW."purchaserSnapshot"
      AND intent."checkoutSnapshot" #> '{review,item}' = NEW."itemSnapshot"
      AND intent."checkoutSnapshot" #> '{review,platform}' = NEW."platformSnapshot"
      AND intent."checkoutSnapshot" #> '{review,cancellation}' = NEW."cancellationSnapshot"
      AND intent."checkoutSnapshot" #> '{review,policies}' = NEW."policiesSnapshot"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Payment receipt must exactly match its successful checkout and ledger record';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "PaymentReceipt_linked_snapshot_invariant"
  AFTER INSERT ON "PaymentReceipt" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "_courtly_validate_payment_receipt"();

COMMIT;
