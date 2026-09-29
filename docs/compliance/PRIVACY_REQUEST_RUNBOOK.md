# Privacy request operating runbook

Status: operational control draft, not legal advice

DPO public contact: `domksj23@gmail.com`

Appointment evidence, named individual, alternate, and monitoring coverage: not recorded in this repository
Last reviewed: 2026-09-29

Courtly's API records access, correction, deletion, consent-withdrawal,
restriction, and objection cases. It does not decide legal entitlement or
automatically claim that a request is fulfilled. Every case requires identity
verification, scope review, a documented decision, and evidence of work done.

## Intake and clocks

1. Authenticated subjects submit `POST /api/privacy/requests`. The account email
   must be verified. Never ask for passwords, full payment card data, or copies
   of identity documents in the free-text field. Route unauthenticated requests
   received at the public privacy mailbox into the same register only after a proportionate
   identity-verification procedure.
2. The service records an immutable submission time and a 30-calendar-day
   response-tracking date. Under Singapore's Personal Data Protection
   Regulations 2021, if Courtly cannot provide access or complete a correction
   within 30 days, it must tell the applicant in writing within that period when
   it expects to respond. Courtly uses that point as its operational tracking
   benchmark; it is a written delay-notice point, not a statutory outer boundary,
   grace period, or entitlement to wait. Act as soon as reasonably
   possible/practicable and record any different rule that applies to the actual
   request.
3. An operator opens the case, verifies identity and authority, sets the status,
   and records every material action. If delayed, set `delayReason` and
   `estimatedResponseAt`; the API records `delayNoticeAt`. Sending the written
   notice and retaining delivery evidence remain operator responsibilities.
4. Consider statutory exceptions and third-party data before disclosure. Export
   only records within scope, redact other individuals' data, encrypt the
   package in transit, share the key separately, and record what was disclosed.
5. For correction, validate the asserted fact and propagate an accepted
   correction to downstream recipients where required. Do not rewrite immutable
   transaction/audit history; append a correction or update mutable identity
   projections and record the outcome.

## Deletion, anonymisation, and retention

A deletion request first becomes a case. Account restriction or child
`DELETION_REQUESTED` status is a safety measure, not proof of erasure. Before
closing the case, inventory the subject's rows and classify each one under
[`RETENTION_SCHEDULE.md`](RETENTION_SCHEDULE.md):

- delete credentials, sessions, OAuth grants, preferences, unnecessary contact
  data, and operational notifications when no retention ground remains;
- anonymise or sever identity links in club-local records where history can be
  preserved without identifying the person;
- preserve the minimum financial, fraud, safety, dispute, consent, and audit
  evidence required by an approved retention ground; do not preserve the live
  profile merely because deletion is technically difficult;
- set a legal hold only for a specific documented dispute, investigation, or
  legal obligation, with owner, scope, review date, and release criteria; and
- do not mark `COMPLETED` unless the live-system actions were verified. Use
  `PARTIALLY_COMPLETED` or `REFUSED` with a plain-language reason when data is
  retained.

The current release supplies request tracking but no general destructive
account-erasure executor. Production also hard-disables the platform admin
endpoint for deleting an individual non-demo business; that endpoint is not a
privacy-request fulfilment mechanism. Operators must use an approved,
peer-reviewed, database-specific procedure and attach row counts/checksums
without copying personal data into the case note. Payment and append-only audit
evidence must not be mutated to simulate deletion; minimise identifiers around
those records under an approved plan.

## Consent withdrawal consequences

Before accepting a general withdrawal request, explain which purposes are being
withdrawn and the likely consequences. Withdrawal does not invalidate prior
lawful processing or override mandatory retention. It may require disabling
affected features, ending optional communications, restricting the account, or
closing the service. Child guardian consent follows the separate append-only
Family workflow and authority rules in `docs/CHILD_ACCOUNTS.md`.

## Operator API

An authenticated named platform-operator session is required for
`/api/admin/privacy-requests`. A
second explicit `X-Courtly-Privacy-Operator: 1` header is required to reduce
accidental operations from generic admin tooling; it is a confirmation signal,
not a second authentication factor. The database snapshots the operator's
stable ID, name, and email on every event. Every mutation also requires
`externalAuditReference`, linking the action to a separately controlled case or
work record. Production access must be least-privilege, monitored, and
exercised by trained personnel; the application identity does not replace
independent review or operational evidence.

- `GET /api/admin/privacy-requests?status=...&overdue=true` lists the queue.
- `PATCH /api/admin/privacy-requests/:id` records verification, delay notice,
  legal hold, status, and decision. It rejects a missing external audit
  reference. Event history is append-only in PostgreSQL.
- Subjects use `GET /api/privacy/requests` and may cancel an active case with
  `POST /api/privacy/requests/:id/cancel`.

Never place identity documents, secrets, raw exports, or detailed legal advice
in notes. Restrict notes to decisions, evidence references, and action summaries.

## Backup treatment

Deletion from the live database does not immediately remove immutable backup
copies. The production owner must document the actual backup provider, regions,
encryption, access, retention window, restore testing, and expiry/deletion
behaviour in the vendor register. Deleted data must not be restored into live
service use; after a disaster restore, rerun a deletion-suppression ledger or
equivalent approved reconciliation before opening writes. Courtly currently has
no implemented tombstone/replay automation, so this is a production release
gate rather than an automated guarantee.

## Sources

- Singapore Statutes Online, [Personal Data Protection Regulations 2021](https://sso.agc.gov.sg/SL-Supp/S63-2021/Published?ProvIds=P12-)
- PDPC, [Access and Correction Obligations](https://www.pdpc.gov.sg/-/media/Files/PDPC/PDF-Files/Advisory-Guidelines/AG-on-Key-Concepts/Chapter-15-9-Oct-2019.pdf)
- PDPC, [Data protection obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations)
