# PostgreSQL backup and restore verification

Status: OPEN until a named infrastructure owner records a successful exercise
against the production provider and approves the targets below.

This runbook creates an application-level PostgreSQL custom archive and proves
that it can be restored into an isolated database. It supplements, rather than
replaces, the managed provider's encrypted backups, point-in-time recovery,
retention, regional resilience, and access controls. Courtly does not yet have
evidence that those provider controls are configured in production.

## Safety invariants

- Both scripts inspect first and print a SHA-256 fingerprint derived from the
  connected server, database OID, database name, user, port, and server version.
- The backup phase requires the fingerprint, --confirm-backup, and an operator
  assertion that the destination storage is encrypted. It never changes the
  source database, never overwrites an archive, and omits ownership/privileges.
- The restore verifier accepts only a loopback PostgreSQL host and a pre-created,
  empty database named courtly_restore_verify_*. It requires the target
  fingerprint and exact database name. It never creates, drops, cleans, or
  overwrites a database and retains the target for human review.
- Database URLs come from named environment variables so credentials do not
  appear in command arguments or evidence. Output paths must be outside the
  repository, on encrypted restricted storage. A dump contains production
  personal, child, message, and financial data: do not upload it as CI evidence.

## Prerequisites and pre-flight

1. Assign one operator and one reviewer. Open a change or exercise record.
2. Confirm the provider's current PostgreSQL major version and install matching
   or newer psql, pg_dump, and pg_restore clients. Archive metadata records the
   dump and restore versions.
3. Confirm no incident, migration, bulk import, or destructive maintenance is
   in progress. For an exercise, normal application writes may continue while
   pg_dump takes a consistent snapshot. For incident recovery, follow the
   incident commander's containment decision.
4. Export the production database URL only in the operator's shell or approved
   secret-injection system. Do not paste it into tickets, shell history, or chat.
5. Confirm the archive location has encryption at rest, access logging, enough
   space, and the retention/deletion policy approved for this exercise.

## Create and validate an archive

Inspect without writing:

    npm run db:backup -- --inspect

Check the printed database, server address, inRecovery, table count, and size.
Copy the exact fingerprint only after those fields identify the intended source.
Then create a new timestamped archive path:

    npm run db:backup -- \
      --output /approved-encrypted-volume/courtly-YYYYMMDDTHHMMSSZ.dump \
      --expect-source-fingerprint COPY_FROM_INSPECTION \
      --confirm-backup \
      --confirm-encrypted-storage

Retain the .dump, .dump.sha256, and .dump.metadata.json together. The script
confirms that pg_restore can read the archive, that it includes public tables,
calculates SHA-256, and uses mode 0600. That is not restore proof; complete the
isolated exercise below.

## Verify an isolated restore

Create an empty local database using an approved local PostgreSQL instance.
Choose a unique name. These commands are illustrative; the operator remains
responsible for the exact local role and host:

    createdb --host 127.0.0.1 --username postgres courtly_restore_verify_YYYYMMDD
    export RESTORE_VERIFY_DATABASE_URL='postgresql://postgres:LOCAL_SECRET@127.0.0.1:5432/courtly_restore_verify_YYYYMMDD?schema=public'
    npm run db:restore-verify -- --inspect-target

The inspection must show zero public tables. Copy its fingerprint and run:

    npm run db:restore-verify -- \
      --archive /approved-encrypted-volume/courtly-YYYYMMDDTHHMMSSZ.dump \
      --expect-target-fingerprint COPY_FROM_TARGET_INSPECTION \
      --confirm-restore courtly_restore_verify_YYYYMMDD \
      --evidence /approved-evidence/courtly-restore-YYYYMMDD.json

The verifier checks the archive checksum against its metadata, stops restore on
the first error, compares the archive/restored table manifests, counts every table,
rejects invalid constraints or failed migrations, requires Prisma to report the
schema up to date, and runs Courtly's runtime schema-health probe. A successful
JSON evidence file records only database metadata and row counts, not row data.

After the reviewer signs the evidence, explicitly destroy the isolated database
and archive copies under the approved retention procedure. The script does not
do this because implicit cleanup would turn a verification tool into a
destructive utility. Record who removed each copy and when.

## RPO/RTO evidence record

Targets must be approved from business impact analysis; this template does not
invent them. Store the completed record outside the public repository.

| Field | Evidence |
| --- | --- |
| Exercise/change ID | TBD |
| Operator / independent reviewer | TBD / TBD |
| Approved RPO target | TBD |
| Backup snapshot createdAt | from archive metadata |
| Recovery incident/cutover time | TBD |
| Observed data-loss window | TBD; explain calculation and timezone |
| RPO result | PASS / FAIL / NOT MEASURED |
| Approved RTO target | TBD |
| Recovery clock start/end | TBD / from evidence completedAt |
| Observed recovery duration | from evidence plus application validation |
| RTO result | PASS / FAIL / NOT MEASURED |
| Archive checksum and metadata | restricted evidence references |
| Restore evidence JSON | restricted evidence reference |
| Application smoke checks | login, health, representative read-only journeys |
| Provider backup/PITR settings | console export or provider evidence reference |
| Gaps, owner, remediation due date | TBD |
| Target database and archive deletion | actor, timestamp, evidence reference |

Do not claim the RTO solely from the script duration: include incident
declaration, infrastructure provisioning, credential recovery, restore,
application deployment, validation, and traffic restoration as applicable.

## Failure and incident boundary

Stop on any fingerprint, checksum, manifest, constraint, migration, or schema
health mismatch. Preserve command output without credentials or row data, tell
the exercise owner, and investigate before retrying with a new empty target. A
failed restore can leave partial objects in its isolated target; do not retry or
promote that target. Record and explicitly remove it after investigation.
Never direct this verifier at production or work around its loopback/name/empty
checks. A real production restoration requires a separate approved incident
plan, provider controls, named decision-maker, write freeze/failover decision,
privacy deletion reconciliation, and explicit traffic cutover.
