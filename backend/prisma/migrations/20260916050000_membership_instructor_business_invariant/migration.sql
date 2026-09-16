-- Membership access and its optional instructor identity must belong to the
-- same business. The existing single-column foreign key remains in place for
-- Prisma's relation metadata; this composite key enforces the tenant boundary.
-- PostgreSQL's column-specific SET NULL preserves the existing delete behavior
-- without attempting to clear Membership.businessId.
BEGIN;

CREATE UNIQUE INDEX "Instructor_id_businessId_key"
  ON "Instructor"("id", "businessId");

ALTER TABLE "Membership"
  ADD CONSTRAINT "Membership_instructorId_businessId_fkey"
  FOREIGN KEY ("instructorId", "businessId")
  REFERENCES "Instructor"("id", "businessId")
  ON DELETE SET NULL ("instructorId")
  ON UPDATE CASCADE;

COMMIT;
