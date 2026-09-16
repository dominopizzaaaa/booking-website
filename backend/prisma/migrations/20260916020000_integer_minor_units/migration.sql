-- Currency is represented as integer minor units throughout Courtly. Convert
-- the initial floating-point columns before production data is introduced so
-- totals and payment comparisons stay exact.
ALTER TABLE "Service" ALTER COLUMN "price" DROP DEFAULT;
ALTER TABLE "Service" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price")::INTEGER;
ALTER TABLE "Service" ALTER COLUMN "price" SET DEFAULT 8000;
ALTER TABLE "ServiceLocation" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price")::INTEGER;
ALTER TABLE "LessonPackage" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price")::INTEGER;
ALTER TABLE "Booking" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price")::INTEGER;
ALTER TABLE "Participant" ALTER COLUMN "price" TYPE INTEGER USING ROUND("price")::INTEGER;
ALTER TABLE "Payment" ALTER COLUMN "amount" TYPE INTEGER USING ROUND("amount")::INTEGER;

ALTER TABLE "Service" ADD CONSTRAINT "Service_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "ServiceLocation" ADD CONSTRAINT "ServiceLocation_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "LessonPackage" ADD CONSTRAINT "LessonPackage_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_price_nonnegative" CHECK ("price" >= 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_positive" CHECK ("amount" > 0);
