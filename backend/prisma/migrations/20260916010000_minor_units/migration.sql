-- Prices use integer minor units (cents) throughout the public API.
ALTER TABLE "Service" ALTER COLUMN "price" SET DEFAULT 8000;
