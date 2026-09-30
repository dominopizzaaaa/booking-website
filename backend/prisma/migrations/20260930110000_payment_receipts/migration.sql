BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

LOCK TABLE "Business", "Payment", "PaymentIntent", "User"
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "PaymentReceipt" (
  "id" TEXT NOT NULL,
  "receiptNumber" TEXT NOT NULL,
  "documentVersion" INTEGER NOT NULL DEFAULT 1,
  "userId" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "paymentIntentId" TEXT NOT NULL,
  "paymentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "paymentProvider" TEXT NOT NULL,
  "checkoutReviewHash" TEXT NOT NULL,
  "merchantSnapshot" JSONB NOT NULL,
  "purchaserSnapshot" JSONB NOT NULL,
  "itemSnapshot" JSONB NOT NULL,
  "platformSnapshot" JSONB NOT NULL,
  "cancellationSnapshot" JSONB NOT NULL,
  "policiesSnapshot" JSONB NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentReceipt_shape_check" CHECK (
    "receiptNumber" ~ '^RCT-[0-9]{8}-[A-F0-9]{20}$'
    AND "documentVersion" = 1
    AND "kind" IN ('PACKAGE', 'BOOKING')
    AND "amount" > 0
    AND "currency" ~ '^[A-Z]{3}$'
    AND "paymentProvider" = 'STRIPE'
    AND "checkoutReviewHash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("merchantSnapshot") = 'object'
    AND jsonb_typeof("purchaserSnapshot") = 'object'
    AND jsonb_typeof("itemSnapshot") = 'object'
    AND jsonb_typeof("platformSnapshot") = 'object'
    AND jsonb_typeof("cancellationSnapshot") = 'object'
    AND jsonb_typeof("policiesSnapshot") = 'array'
  )
);

CREATE UNIQUE INDEX "PaymentReceipt_receiptNumber_key" ON "PaymentReceipt"("receiptNumber");
CREATE UNIQUE INDEX "PaymentReceipt_paymentIntentId_key" ON "PaymentReceipt"("paymentIntentId");
CREATE UNIQUE INDEX "PaymentReceipt_paymentId_key" ON "PaymentReceipt"("paymentId");
CREATE UNIQUE INDEX "PaymentReceipt_id_businessId_key" ON "PaymentReceipt"("id", "businessId");
CREATE UNIQUE INDEX "PaymentReceipt_paymentIntentId_businessId_key" ON "PaymentReceipt"("paymentIntentId", "businessId");
CREATE UNIQUE INDEX "PaymentReceipt_paymentId_businessId_key" ON "PaymentReceipt"("paymentId", "businessId");
CREATE INDEX "PaymentReceipt_userId_issuedAt_idx" ON "PaymentReceipt"("userId", "issuedAt");
CREATE INDEX "PaymentReceipt_businessId_issuedAt_idx" ON "PaymentReceipt"("businessId", "issuedAt");

ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_paymentIntentId_businessId_fkey"
  FOREIGN KEY ("paymentIntentId", "businessId") REFERENCES "PaymentIntent"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "PaymentReceipt" ADD CONSTRAINT "PaymentReceipt_paymentId_businessId_fkey"
  FOREIGN KEY ("paymentId", "businessId") REFERENCES "Payment"("id", "businessId")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- A receipt is the immutable document that was issued at payment success.
-- Refund/reversal state is intentionally read from Payment and PaymentRefund.
CREATE FUNCTION "_courtly_payment_receipt_immutable"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Payment receipts are immutable';
END;
$$;
CREATE TRIGGER "PaymentReceipt_immutable"
  BEFORE UPDATE OR DELETE ON "PaymentReceipt" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_payment_receipt_immutable"();

COMMIT;
