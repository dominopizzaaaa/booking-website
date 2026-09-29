# Courtly TODO

This file separates release gates for the guardian-managed child safe subset
from later product work that must not be implied by the current UI. An unchecked
item under **Production release gates** blocks exposing Family in production; it
is not an optional future enhancement. Courtly already has capture and Resend
providers plus a durable email worker, so extend that pipeline rather than
building a second mail system.

## Child accounts: production release gates

- [ ] Obtain product, privacy, security, and qualified Singapore privacy-counsel
  approval for the age policy, guardian attestation and consent copy,
  `CLUBS_ONLY` disclosures, handover ownership proof, export scope, deletion
  procedure, and retention of identity, consent, handover, and delivery records.
  The implementation is not itself evidence of legal compliance.
- [ ] Rehearse and approve the coordinated database/API/UI cutover on a
  production-shaped copy. Do not run this as an ordinary mixed-version rolling
  release: the migration's compatibility trigger keeps an old writer's omitted
  `legalName` valid, but old API replicas do not enforce the new age/capability
  policy, and old and new personal-registration payloads require different
  fields. Pause personal registration and Family writes, take and verify a
  backup, apply the migration, replace and drain every old API replica, confirm
  the new backend reports `schema: ready`, and only then expose the matching
  frontend. Keep the compatibility trigger until no old writer can run.
- [ ] Decide, document, and rehearse the legacy-account transition. The schema
  deliberately leaves existing DOB and email-verification state unknown. Do not
  infer age, classify, lock, contact, delete, or otherwise alter production
  accounts without separate explicit approval, measured inventory, support and
  appeal paths, a dry run, and a rollback plan.
- [ ] Review and rehearse handover-key rotation. `ChildAccountHandover` stores
  only the SHA-256 token digest and `OutboundDelivery.payload` stores only a
  handover ID, expiry, and non-secret key ID; the worker derives the claim URL in
  memory. Retain old `FAMILY_HANDOVER_TOKEN_KEYS` for the seven-day claim
  lifetime plus the maximum delivery-retry window, restrict secret-manager
  access, rehearse rotation and emergency revocation, and verify no raw token or
  claim URL enters the database, backup, API, export, analytics, support tools,
  or logs.
- [ ] Verify the existing Family-specific readiness signal in every release
  environment. `/api/health` must report
  `capabilities.familyHandover: "configured"`; it reports that state only when
  transactional email and the dedicated token keyring are both enabled. Do not
  infer handover readiness from
  `transactionalEmail`, and do not treat configuration readiness as proof of
  provider delivery or a successful claim journey.
- [ ] Validate and operationalize the age-18 remediation path before release.
  The backend returns `HANDOVER_REQUIRED`, and the Family dashboard now offers
  **Start handover** to an authorized guardian for eligible `ADULT` as well as
  `TEEN` profiles. Add browser coverage for that adult path and approve a
  notification, escalation, and support policy; there is no automatic transfer
  or escalation, and the managed person's own stale session cannot perform the
  handover.
- [ ] Complete and pass every item under **Required release validation** below,
  including a real Resend test-domain handover when production email will be
  enabled. Queue creation or provider acceptance is not proof of delivery.

## Child accounts: email identity and recovery

- [ ] Add parent/guardian email verification. Use the existing durable outbound
  pipeline and a security-specific template; require normalized unique email, a
  cryptographically random single-use token, SHA-256 digest-only storage, a
  bounded expiry, atomic consumption, rate limits, generic non-enumerating
  responses, and session rotation after verification-sensitive changes. Decide
  how existing accounts whose verification state remains unknown are reviewed;
  the guardian-child migration does not mark legacy email addresses verified.
- [ ] If consent can be requested from a guardian who is not already signed in
  and linked, add a separate email consent flow with single-use, digest-only,
  expiring consent links. Bind each link to the intended normalized guardian
  email, child, permission snapshot, and privacy-policy version; rate-limit both
  issuance and consumption and never treat delivery as consent.
- [ ] Add password/account recovery for self-managed guardians and handed-over
  young people. Recovery must not reveal whether an email exists, must use
  hashed single-use expiring tokens, must serialize concurrent/replayed claims,
  and must revoke all sessions after a credential change. Do not add recovery
  credentials to a guardian-managed child.
- [ ] Add a dedicated handover resend/replacement flow. Today a guardian can
  cancel and then create a new request, subject to the existing 60-second
  server-side issuance cooldown and Family mutation rate limit; there is no
  resend endpoint or HTTP `Retry-After` header. A replacement must rotate and
  invalidate the earlier token atomically, retain one pending handover per
  child, keep the current seven-day expiry (or explicitly migrate and document
  a newly reviewed value), append audit events, and suppress any still-queued
  prior delivery. Keep only the digest in `ChildAccountHandover`; the outbox must
  retain only non-secret derivation metadata and never a raw or encrypted bearer token.
- [ ] Add delivery/bounce/complaint handling for security mail. Consume verified
  provider webhooks idempotently, hard-suppress unsafe recipients, distinguish
  queued/provider-accepted/delivered/failed states, alert the initiating
  guardian without exposing the destination, and provide a reviewed retry,
  cancel, or address-correction path. Today initiation commits only when the
  outbox row is `QUEUED`. Explicit cancellation, deletion, an observed expiry,
  and a consent withdrawal authorized for that particular handover directly
  mark matching `QUEUED` or `SENDING` work `SUPPRESSED`; consent-only withdrawal
  cannot suppress another guardian's request, and the UI says queued.
  The worker also rechecks the live handover before dispatch. A
  provider request already in flight or provider-`ACCEPTED` cannot be recalled,
  although its cancelled or expired claim fails; do not describe any of those
  states as delivered.
- [ ] Add operational monitoring and support runbooks for stuck/failed handover
  deliveries, expired claims, suppressed destinations, email collisions, and
  provider outages. Define escalation and retention for delivery metadata and
  ensure support tooling never derives or logs a one-use claim URL.

Production email remains `EMAIL_PROVIDER=resend` with `EMAIL_API_KEY`, a
verified `EMAIL_FROM_ADDRESS`, optional `EMAIL_FROM_NAME`/`EMAIL_REPLY_TO`, and
the canonical HTTPS `PUBLIC_APP_ORIGIN`. Handover also requires a dedicated
versioned `FAMILY_HANDOVER_TOKEN_KEYS` keyring and active key ID. `capture` is
local/test-only, and disabled or incomplete configuration must keep handover
unavailable without displaying a raw-token fallback. Secrets and real addresses
belong only in the deployment secret manager.

## Child accounts: family lifecycle

- [ ] Add co-guardian invitation and management. Support an adult inviting a
  normalized email, verified acceptance by the intended self-managed adult,
  least-privilege permission snapshots, duplicate/conflict handling, expiry,
  resend cooldown, withdrawal/removal, session effects, and append-only audit
  events. Preserve independent consent decisions for multiple active guardians
  and define which actions require one guardian versus all guardians.
- [ ] Design child-specific credential reset only if product policy later lets a
  minor sign in. Managed children currently have no password or direct session,
  so `CREDENTIAL_RESET` is reserved and must not manufacture credentials.
- [ ] Design any expansion beyond the bounded guardian Class-creation flow.
  `BOOKINGS_MANAGE` now permits an eligible adult to create an unpaid,
  package-free public club Class for a linked managed child, but it deliberately
  grants no booking-history, cancellation, reschedule, notification, session-
  chat, package, payment, or rental authority. Define attribution, consent,
  safeguarding, refunds, payment authentication, transcript membership,
  notifications, and club-visible identity before enabling any of those
  operations.
- [ ] Build the reviewed deletion processor. Verify the requester, define legal
  hold and retention rules with Singapore counsel, minimize retained consent
  evidence, erase unnecessary child data and provider projections, handle club
  records that must remain, make retries idempotent, and record completion. A
  current deletion request only restricts the account and revokes sessions.
- [ ] Add a reviewed production age-transition program. Inventory unknown-DOB
  legacy users without guessing, design one-time collection/support/appeal,
  identify under-13 self-managed users, establish guardian authority and current
  consent, and define escalation for guardian-managed users who reach 18 without
  completing handover. Do not run a backfill, lock, deletion, or bulk message
  without separate explicit approval, backup, dry run, and rollback plan.
- [ ] Decide with product and Singapore privacy counsel: policy wording and
  versioning, proof of guardianship, consent renewal cadence, optional handover
  prompts from 13, mandatory handover handling at 18, `CLUBS_ONLY` disclosure,
  export scope, and data/audit retention after withdrawal or deletion. Do not
  describe the implementation as guaranteeing legal compliance.

## Child accounts: required release validation

These checks are release gates, not deferred product ideas. The checked items
below describe automated coverage present in the current tree; they do not mean
this documentation pass ran the suites or that production readiness is approved.

- [x] Retain focused policy and registration coverage for strict DOB parsing,
  invalid/future dates, exact 13th and 18th birthdays, leap day, Singapore
  midnight, unknown-DOB legacy accounts, adult and teen capabilities, under-13
  registration rejection, required-action precedence, and stale managed
  sessions.
- [x] Retain the isolated migration/invariant test for legacy-name backfill,
  nullable managed-child credentials, immutable DOB, managed-child and adult
  guardian shapes, multiple guardians, append-only consent with database-assigned
  monotonic ordering, composite link provenance, one pending handover per child
  and destination, destination reuse after cancellation, and terminal handover
  immutability.
- [x] Retain current Family API integration coverage for adult eligibility,
  one-time DOB review, strict child creation and editing, duplicate usernames,
  profile/privacy permission separation, multiple guardians' independent
  consent, concurrent decision sequencing independent of transaction timestamps,
  consent-only versus `HANDOVER_MANAGE` cross-guardian withdrawal behavior, the
  minimal withdrawn-link projection, export privacy and IDOR,
  deletion restriction, session revocation, and handover initiation, completion,
  cancellation, expiry, replay, concurrency, email collision, and token secrecy.
- [x] Retain focused guardian-booking coverage for privacy-minimal eligible-child
  enumeration, exact active-link `BOOKINGS_MANAGE`, current consent on that same
  link, cross-family IDOR, under-18 managed-child state, nullable-email club
  `Student` projection, ordinary scheduling conflicts, unpaid/package-free
  `CLUB` routing, actual guardian `STUDENT`/`COACH` creation provenance, and no
  guardian participant or session-chat access.
- [x] Retain current live account-gate coverage across account/session chat,
  Calendar, workspace/staff, packages, payments, rentals, student booking and
  notification routes. These tests mutate persisted account state behind an
  existing session and assert stable `ACCOUNT_ACTION_REQUIRED` responses;
  directory and payment tests also reject managed or underage identities.
- [x] Retain unit coverage for the handover keyring and deterministic HMAC token
  derivation, non-secret outbox payload, in-memory claim-URL reconstruction,
  live-state suppression, expired lease reclamation, provider acceptance,
  and transient retry behavior.
- [ ] Close residual backend gaps: exercise a guardian managing several child
  profiles whose identities have no copied guardian email; every Family
  permission independently; broader cross-family IDOR routes; exact cooldown
  and `retryAfterSeconds` boundaries; disabled/missing active handover keys at
  the Family endpoint; cancellation while provider I/O is already in flight;
  terminal outbound failure after the retry limit; and all legacy or indirect
  account-creation paths.
- [ ] Before enabling resend/recovery/co-guardian email flows, test rate-limit
  boundaries, old-link invalidation, generic non-enumerating responses, hard
  suppression, provider outage behavior, and verified webhook replay/signature
  handling for the eventual delivered/bounce/complaint implementation.
- [ ] Add and pass frontend unit and Playwright coverage at all supported viewports for
  adult registration, under-13 redirection, one-time guardian DOB review, Family
  empty/multi-child states, add/edit validation, consent review/withdraw/renew,
  visibility choices, export, deletion confirmation, handover disabled/enabled/
  expired/replayed states, required-action routing, focus restoration, keyboard
  operation, accessible status/error announcements, eligible-child selection on
  public club pages, package/payment suppression, and guardian-booking failures.
- [ ] Run a coordinated pre-production rehearsal: apply migrations to a
  production-shaped copy, run backend/frontend focused suites and builds, verify
  `/api/health`, exercise capture-mode handover end to end, then validate a
  Resend test-domain delivery and failure without using real child data.
