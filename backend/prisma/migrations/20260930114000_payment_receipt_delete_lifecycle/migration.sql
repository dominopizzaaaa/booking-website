BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE "PaymentReceipt" IN ACCESS EXCLUSIVE MODE;

-- Updates remain forbidden. Deletes are governed separately so a receipt can
-- disappear only as part of deleting its owning commercial graph.
DROP TRIGGER "PaymentReceipt_immutable" ON "PaymentReceipt";
CREATE TRIGGER "PaymentReceipt_immutable"
  BEFORE UPDATE ON "PaymentReceipt" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_payment_receipt_immutable"();

ALTER TABLE "PaymentReceipt"
  DROP CONSTRAINT "PaymentReceipt_businessId_fkey",
  DROP CONSTRAINT "PaymentReceipt_paymentIntentId_businessId_fkey",
  DROP CONSTRAINT "PaymentReceipt_paymentId_businessId_fkey";

ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_paymentIntentId_businessId_fkey"
  FOREIGN KEY ("paymentIntentId", "businessId") REFERENCES "PaymentIntent"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_paymentId_businessId_fkey"
  FOREIGN KEY ("paymentId", "businessId") REFERENCES "Payment"("id", "businessId")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
