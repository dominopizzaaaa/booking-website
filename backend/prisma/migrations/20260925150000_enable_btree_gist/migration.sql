-- VenueReservation uses a GiST exclusion constraint to prevent overlapping
-- reservations. Install its trusted PostgreSQL operator-class dependency in a
-- small prerequisite migration, before the marketplace migration takes broad
-- application-table locks. Database roles that cannot install trusted
-- extensions must have an administrator enable btree_gist before deployment.
CREATE EXTENSION IF NOT EXISTS btree_gist;
