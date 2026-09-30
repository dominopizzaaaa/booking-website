BEGIN;

CREATE FUNCTION "_courtly_guard_payment_receipt_delete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1
    OR NOT EXISTS (SELECT 1 FROM "Business" WHERE "id" = OLD."businessId")
    OR NOT EXISTS (SELECT 1 FROM "PaymentIntent" WHERE "id" = OLD."paymentIntentId")
    OR NOT EXISTS (SELECT 1 FROM "Payment" WHERE "id" = OLD."paymentId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Payment receipts cannot be deleted independently';
END;
$$;

CREATE TRIGGER "PaymentReceipt_delete_guard"
  BEFORE DELETE ON "PaymentReceipt" FOR EACH ROW
  EXECUTE FUNCTION "_courtly_guard_payment_receipt_delete"();

CREATE FUNCTION "_courtly_guard_payment_receipt_truncate"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Payment receipt history cannot be truncated';
END;
$$;

CREATE TRIGGER "PaymentReceipt_truncate_guard"
  BEFORE TRUNCATE ON "PaymentReceipt" FOR EACH STATEMENT
  EXECUTE FUNCTION "_courtly_guard_payment_receipt_truncate"();

COMMIT;
