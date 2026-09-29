# Child accounts and guardian consent

This document describes Courtly's Singapore-only child-account policy and the
safe subset implemented in this repository. It is an engineering description,
not legal advice or a claim of compliance. The policy, consent copy, retention
schedule, deletion process, and age thresholds require review by qualified
Singapore privacy counsel before production use.

## Scope and account architecture

Courtly still has exactly three account types: `STUDENT`, `COACH`, and `CLUB`.
A guardian is an adult, self-managed `STUDENT` or `COACH`; it is not another
role. A managed child is a distinct `User` with `accountType: STUDENT` and
`accountControl: GUARDIAN_MANAGED`. `accountType` describes the product role,
while `accountControl` says who can operate the identity.

The ordinary account-creation path is email/password registration. A coach
invitation may lead an unregistered recipient through that same registration
path; a staff invitation must be accepted by an existing personal account.
Neither invitation itself creates a parallel identity. Public booking requires
an account, the platform admin can delete but not create accounts, and Google
OAuth connects Calendar only rather than acting as login. Seed/showcase scripts
are trusted development or operational provisioners. The Family API is the only
path that creates a credential-free, guardian-managed child.

The implemented subset is identity-first with one bounded on-behalf action.
Family supports creating and listing children, editing permitted profile
fields, privacy choices, consent renewal and withdrawal, data export, deletion
requests, secure account handover, and guardian-authorized public club Class
booking. A guardian still cannot buy a package, make a payment, reserve a
court, connect Calendar, use child directory features, or join account/session
chat as the child. No other permission name makes a deferred operation
available.

## Identity and data model

### `User`

Every child has its own immutable database `User.id`, globally unique
`username`, private `legalName`, public/operational display `name`, date-only
`dateOfBirth`, sports, status, visibility, and application history. Names and
birth dates are not identity keys: siblings may share both. Username conflicts
are rejected by the same database uniqueness constraint used for every other
account; the caller must choose another canonical lowercase username.

A guardian-managed child has:

- `accountType = STUDENT`;
- `accountControl = GUARDIAN_MANAGED`;
- `email = NULL`, `emailVerifiedAt = NULL`, and `passwordHash = NULL`;
- no phone number and no direct login session;
- `profileVisibility` limited to `PRIVATE` or `CLUBS_ONLY`; and
- a date of birth, which cannot be edited after it is first set.

The guardian's email is never copied into the child's login identity. One
normalized guardian email can therefore manage any number of child users.
PostgreSQL continues to enforce uniqueness for every non-null user email. A
club-local `Student` row remains separate from the global child `User`; its
email is nullable so it can refer to a managed child without inventing contact
details.

### `GuardianChildLink`

This is the authorization edge between an adult and a child, not a
`Membership`, coach affiliation, or `ClubStaffAccess`. It records the guardian,
child, stated relationship, lifecycle status, timestamps, and a snapshotted
permission set. The `(guardianUserId, childUserId)` pair is unique. One
guardian can have many links and the model permits several guardians to link
to one child; inviting and managing co-guardians is deferred.

Link status is `ACTIVE`, `WITHDRAWN`, or `ENDED`. Ordinary child reads and
mutations select the child through an active link belonging to the authenticated
guardian and check the exact permission. A withdrawn `CONSENT_MANAGE` link has
one narrow lifecycle path: the dashboard returns a minimal renewal projection
and the guardian may renew current-policy consent. Explicit handover
cancellation still requires an active `HANDOVER_MANAGE` link.
Possession of a browser-supplied child ID, the legacy `parentName` field, account
type, membership, or staff access is never guardian authority.

The permission vocabulary is `PROFILE_MANAGE`, `BOOKINGS_MANAGE`,
`CREDENTIAL_RESET`, `PRIVACY_MANAGE`, `DATA_EXPORT`, `CONSENT_MANAGE`,
`DELETION_REQUEST`, and `HANDOVER_MANAGE`. `BOOKINGS_MANAGE` authorizes only the
bounded Class flow described below. `CREDENTIAL_RESET` remains reserved, and no
permission bypasses the current subset boundary.

### `ChildConsentRecord`

Consent and family lifecycle evidence is append-only. Each row snapshots the
guardian, child, optional link, stated relationship, privacy-policy version,
permissions, event type, metadata, evidence timestamp, and a database-assigned
monotonic `sequence`. Events are `GRANTED`,
`RENEWED`, `WITHDRAWN`, `HANDOVER_STARTED`, `HANDOVER_CANCELLED`,
`HANDOVER_COMPLETED`, and `DELETION_REQUESTED`. Rows are not edited to express a
new decision; a new event is appended.

Current consent is derived from database state. For each active link, Courtly
reads the grant/renew/withdraw decision with the greatest sequence; the child
has current consent when at least one active link's greatest-sequence decision
is a grant or renewal for the current privacy-policy version. PostgreSQL
serializes assignment and overwrites any caller-provided sequence, so a
transaction's start time or `createdAt` cannot reorder concurrent decisions.
The timestamp remains evidence, not the state-ordering primitive. Courtly never
accepts a client-supplied `hasConsent` flag or ordering value.

### `ChildAccountHandover`

A handover records the child, initiating guardian, normalized destination email,
SHA-256 token digest, status, expiry, and lifecycle timestamps. The raw token is
never persisted. `OutboundDelivery.payload` contains only the handover ID,
expiry, and a non-secret HMAC key ID. Immediately before dispatch, the
worker reloads the live handover, checks its status, expiry, destination and
digest, derives the token from the dedicated server keyring, and renders the URL
in memory. Partial unique indexes permit at most one `PENDING` handover per child
and destination email. Status is `PENDING`, `COMPLETED`, `CANCELLED`, or `EXPIRED`.

## Singapore date boundary and age policy

The backend policy module is the single definition of age and direct-account
capabilities. It parses `YYYY-MM-DD` as a calendar date without host-timezone
reinterpretation and calculates age against today's civil date in
`Asia/Singapore`:

- `CHILD`: younger than 13;
- `TEEN`: 13 through 17;
- `ADULT`: 18 or older; and
- `UNKNOWN`: a legacy personal account with no recorded date of birth.

The birthday boundary is 00:00 in Singapore. A 29 February birthday advances
on 1 March in a non-leap year. The thresholds are centralized parameters so a
reviewed future policy can change them without scattering age math through
routes or React. The client may format dates and guide input, but it must not
author an age band or authorization decision.

Date of birth is a PostgreSQL `date`, not a timestamp. The database permits a
one-time transition from unknown to known and rejects later changes. This
prevents an ordinary profile edit from crossing an age boundary to evade a
gate; correcting a wrong date requires a separately designed, reviewed
administrative process.

## Capabilities and the required-account gate

Policy is recalculated from the current user, session, active guardian links,
and append-only consent records on authenticated requests. It is returned to
the frontend for presentation, but backend middleware remains authoritative.
Normal role, tenant, ownership, and staff checks still apply after a capability
check; a capability never grants access by itself.

The direct-account policy is:

| Subject | Direct capabilities |
| --- | --- |
| Adult self-managed personal account | Normal account capabilities, including Family |
| Institutional `CLUB` account | Normal club capabilities; no Family or personal Calendar |
| Self-managed teen | Profile, ordinary non-commercial access, directory, chat, and Calendar |
| Self-managed child | Profile remediation only; `PARENT_ACCOUNT_REQUIRED` |
| Guardian-managed child | No direct capabilities or direct session |
| Consent/deletion/handover remediation state | Only narrowly allowlisted remediation operations |

The server uses stable error code `ACCOUNT_ACTION_REQUIRED` and a reason. If
damaged or legacy data triggers several rules, precedence is:

1. `DELETION_REQUESTED`
2. `GUARDIAN_SESSION_STALE`
3. `HANDOVER_REQUIRED`
4. `CONSENT_REQUIRED`
5. `PARENT_ACCOUNT_REQUIRED`

The web app routes such a session to `/account/action-required`. The gate is
computed from live database state rather than trusted token claims. Any direct
session found for a managed child is stale and must not become an escape hatch.

Profile visibility and permission to use account search are separate. Only a
self-managed, policy-ready account with `PUBLIC` visibility is eligible for
authenticated public-profile discovery. Managed children are never public
directory results; dates of birth, exact ages, contact details, presence, and
guardian details are not public profile fields.

## Parent-first creation and consent lifecycle

1. A self-managed adult `STUDENT` or `COACH` signs in and opens `/family`. A
   legacy account with unknown DOB completes the one-time age review first.
2. **Add child** collects separate legal and display names, a canonical
   username, full date of birth, optional sports, relationship, and `PRIVATE`
   or `CLUBS_ONLY` visibility. It does not collect child email, phone, or a
   password.
3. The guardian explicitly confirms legal guardianship and accepts the current
   child privacy-policy version.
4. One transaction creates the child identity, active link, and `GRANTED`
   consent record. Database uniqueness resolves concurrent username races.
5. The Family page lists full child records reached through an active
   `PROFILE_MANAGE` link. A withdrawn `CONSENT_MANAGE` link yields only the
   minimum display/relationship/consent state needed to renew. Every other
   operation, including handover cancellation, requires current active authority.
6. Editing changes only legal/display name, sports, and permitted visibility.
   Username, date of birth, and relationship are not ordinary editable fields.
7. Withdrawal appends `WITHDRAWN`, withdraws that guardian's link, and revokes
   child sessions. It cancels a pending handover initiated by that guardian. A
   pending request initiated by another guardian is cancelled only when the
   withdrawing link also carries `HANDOVER_MANAGE`; `CONSENT_MANAGE` alone does
   not reveal, cancel, or suppress the other request. Withdrawal changes the
   account to `CONSENT_REQUIRED` only when no other active link retains current
   consent. Renewal appends `RENEWED` for the current policy version and
   reactivates the withdrawn link.
8. A deletion request immediately sets `DELETION_REQUESTED`, restricts the
   account, revokes sessions, and appends evidence. Physical deletion is
   deferred to a human-reviewed retention and erasure workflow.

The authenticated guardian path is the consent proof in this subset. It does
not claim that a guardian's mailbox was independently verified. Parent-email
verification and email-based guardian invitations remain deferred.

## Guardian-authorized Class booking

An eligible signed-in adult can book a public club Class for a linked managed
child from the same `/book/:slug` page used for ordinary student booking. The
child remains the student and participant; the guardian is the authorized
actor, not a replacement identity. The browser first loads a privacy-minimal
chooser from `GET /api/family/booking-children`, containing only each currently
eligible child's ID, display name, and username. A chooser response is a UI
convenience, never an authorization grant.

Submission uses `POST /api/family/children/:id/bookings`. In the same
transaction that creates the booking, the server reloads and requires all of
the following:

- the authenticated actor is an eligible adult personal account;
- the exact `(guardianUserId, childUserId)` `GuardianChildLink` is `ACTIVE` and
  includes `BOOKINGS_MANAGE`;
- that exact link's greatest-sequence consent decision is a current-policy
  `GRANTED` or `RENEWED` record; consent held by another guardian cannot
  substitute;
- the child is still an active `STUDENT` with
  `accountControl: GUARDIAN_MANAGED`, remains under 18 on the Singapore civil
  date, and has no child credentials or guardian contact fields; and
- the selected public club, Class, coach, venue, slot, capacity, conflict,
  notice, and optional finite-series inputs still satisfy ordinary scheduling
  rules.

The scheduler creates or reuses a business-local `Student` linked by the
child's immutable `User.id`. Its email stays null and its phone and legacy
`parentName` remain empty; the guardian's identity is never copied into the
child. A client cannot select another `Student` row or send child contact
fields. The resulting booking snapshots `paymentRoute: CLUB`, starts unpaid,
and has no package or checkout intent. Courtly collects no payment in this
flow; the guardian contacts the club to arrange payment. `Booking.createdByUserId`
records the authenticated guardian, while `Booking.createdByRole` records that
guardian's actual account type (`STUDENT` or `COACH`), rather than treating all
guardian-created bookings as student-created.

This authority ends at creation. It does not make the guardian a participant,
child proxy session, or member of the booking's session chat, and it does not
grant access to the child's booking history, notifications, cancellation,
rescheduling, attendance, package, payment, rental, Calendar, directory, or
chat surfaces. The child still has no direct session. The club and coach see
the normal child-linked participant through their existing tenant-scoped
operational views. Any future guardian self-service or commerce needs its own
attribution, safeguarding, payment, notification, and authorization design.

## API surface

The authenticated endpoints are `GET /api/family`, one-time
`POST /api/family/date-of-birth`, `GET /api/family/booking-children`,
`POST /api/family/children/:id/bookings`, child create/update/export, consent
withdraw/renew, deletion request, and handover create/cancel under
`/api/family/children/:id`. Only handover preview and completion at
`/api/family/handovers/:token` are public, and both are rate-limited. Request
bodies are strict. Public claim responses mask the destination and never return
the token or its digest.

## Handover lifecycle

A managed child becomes eligible for handover at 13. If the profile remains
managed at 18, live account policy places it in the `HANDOVER_REQUIRED`
remediation state. The Family UI exposes **Start handover** for eligible `TEEN`
and `ADULT` profiles, but the system does not automatically transfer the
identity or notify or escalate the case. The adulthood journey therefore needs
explicit release validation and an approved operational escalation policy. The
initiating party is an authenticated guardian with an active link and
`HANDOVER_MANAGE`; the young person approves and completes the transition by
controlling the destination mailbox and claim link. No additional guardian
approval occurs after initiation.

1. The server confirms the child is at least 13, remains guardian-managed, is
   not pending deletion, and has no other pending handover. An active link with
   handover authority must remain valid through completion.
2. The guardian supplies the young person's future login email. The server
   normalizes it and rejects a collision without changing the child.
3. Courtly creates the handover ID, derives a one-use token with the active
   dedicated HMAC key, stores only its SHA-256 digest in
   `ChildAccountHandover`, records a seven-day expiry, appends
   `HANDOVER_STARTED`, and creates a `QUEUED` security delivery in the same
   transaction. The delivery carries only non-secret derivation metadata. If
   email or the keyring is disabled, or delivery cannot be queued, the entire
   initiation rolls back. The profile remains guardian-managed.
4. The recipient opens the one-use link and chooses a new 12–72 character
   password. Completion locks and reloads the handover, then rechecks token,
   pending status, expiry, child state, age, and email uniqueness.
5. The same `User` receives the verified destination email and password, moves
   to `accountControl: SELF` and `accountStatus: ACTIVE`, and keeps its ID,
   username, profile, history, ratings, and relationships. Active guardian
   links end, `HANDOVER_COMPLETED` is appended, the handover becomes
   `COMPLETED`, and all existing sessions are revoked.
6. A guardian with a current active `HANDOVER_MANAGE` link may explicitly
   cancel a pending request, which invalidates the token and marks matching
   `QUEUED` or `SENDING` delivery work `SUPPRESSED`, and appends
   `HANDOVER_CANCELLED`. Deletion does
   the same. Consent withdrawal cancels the withdrawing guardian's own pending
   request, but requires `HANDOVER_MANAGE` to cancel a request initiated by a
   different guardian. Expiry suppression occurs when expiry is observed. The
   worker also reloads the handover before dispatch and
   suppresses work that is no longer valid. A provider request already in flight
   or marked `ACCEPTED` cannot be recalled, but its link no longer completes.
   Expired, cancelled, completed, replayed, and simultaneously submitted tokens
   cannot complete.

There is no raw-token display or insecure manual fallback. Unless both
transactional email and a valid `FAMILY_HANDOVER_TOKEN_KEYS` /
`FAMILY_HANDOVER_TOKEN_ACTIVE_KEY_ID` configuration are present, handover
initiation is unavailable and no handover or delivery is created. Retired keys
must remain configured for at least the seven-day claim lifetime plus the
maximum delivery-retry window. `/api/health` reports
`capabilities.familyHandover: "configured"` only when email and this keyring are
both enabled; the signal is a deployment gate, not proof of provider delivery
or a successful claim. A successful API response means only that the delivery
was durably `QUEUED`; the worker later leases it as `SENDING`, records
provider acceptance as `ACCEPTED`, retries transient failures through `QUEUED`,
or marks a terminal failure `FAILED`. `DELIVERED` exists in the schema, but no
provider webhook currently sets it. Security mail bypasses optional preferences.
The creation endpoint enforces a 60-second per-child cooldown and returns
`retryAfterSeconds` in the 429 JSON body, but it has no HTTP `Retry-After` header.
Dedicated resend/destination change, mailbox recovery, provider delivery/bounce
processing, and guardian-facing delivery remediation are tracked in
[TODO.md](../TODO.md).

## Security invariants

- Family requests use strict request schemas and never authorize by child ID
  alone. Ordinary operations require the authenticated guardian's active link
  and exact permission. A withdrawn link with `CONSENT_MANAGE` receives only a
  minimal renewal projection; explicit handover cancellation always requires
  an active link with `HANDOVER_MANAGE`.
- Consent decisions are ordered only by their database-assigned monotonic
  sequence, never timestamps or client input. Consent withdrawal cannot cancel
  another guardian's pending handover unless the withdrawing active link also
  includes `HANDOVER_MANAGE`.
- Booking-child enumeration is privacy-minimal. Booking creation repeats the
  exact active-link, `BOOKINGS_MANAGE`, current per-link consent, child status,
  account-control, role, and Singapore-age checks inside the write transaction;
  another guardian's consent and a stale browser response cannot authorize it.
- A guardian booking resolves the club `Student` only through the child
  `User.id`, keeps email nullable, refuses client-selected student identity and
  package input, and creates an unpaid `CLUB`-route booking. It does not add the
  guardian to participant, chat, Calendar, notification, payment, cancellation,
  or reschedule authority. Booking provenance stores the authenticated guardian
  ID and their actual `STUDENT` or `COACH` account type.
- Managed-child credential, role, visibility, and relationship shapes are
  constrained in PostgreSQL as well as application code. Cross-row family
  checks are deferred to transaction commit to avoid partially valid graphs.
- Usernames, active-link pairs, token digests, and pending handovers have
  database uniqueness constraints. Multi-row creation and lifecycle changes
  are transactional; handover decisions serialize competing attempts.
- Raw handover tokens, claim URLs, passwords, dates of birth, provider bodies,
  and arbitrary child data must not enter the outbox, logs, or public errors.
  The delivery row necessarily stores the normalized recipient address in its
  dedicated email fields, but not in the Family payload. Public APIs and exports
  never return the token digest, and token failures reveal no extra child or
  guardian data.
- Security handover mail bypasses optional marketing/transactional preferences.
  The live Family route addresses a not-yet-owned destination and therefore
  queues with `recipientUserId: null`; it validates deliverability syntax but
  cannot consult an existing account's `emailSuppressedAt` record. Provider
  availability is still required. A queue or provider-acceptance state is not
  proof of final delivery; bounce/complaint suppression is a release gate in
  [TODO.md](../TODO.md).
- Consent withdrawal, password or ownership change, and deletion request revoke
  affected sessions. Withdrawal suppresses a pending handover only within the
  actor's authority described above. Handover preserves audit history rather
  than rewriting it.
- Physical deletion must retain only evidence justified by an approved legal
  and operational retention policy; the current request state is not an
  automated purge.

## Migration and production rollout

The committed migration requires a coordinated schema/API/UI release. It
adds the family columns and tables, makes login and club-local student emails
nullable for managed identities, keeps non-null emails canonical and unique,
adds lifecycle indexes and foreign keys, and installs checks/triggers for child
shape, adult guardian authority, immutable DOB, append-only consent, and
database-assigned monotonic consent ordering. It
backfills `legalName` from the existing display name. It deliberately does not
mark legacy email addresses verified, infer a date of birth, or classify an
account from names, activity, or `parentName`.

No production migration, age backfill, account lock, anonymization, deletion,
or bulk email is run as part of development. This is not an ordinary
mixed-version rolling deployment: the migration's compatibility trigger lets an
old writer omit `legalName`, but old API replicas do not enforce the new
age/capability policy, and old/new personal-registration payloads are
incompatible. A production rollout must:

1. obtain product, privacy, security, and Singapore counsel approval for the
   policy and retention decisions;
2. inventory account-creation paths and take a verified database backup;
3. test the full migration chain and its audits on a production-shaped copy;
4. measure legacy users with unknown DOB without guessing who is a child;
5. pause personal registration and Family writes, apply the migration, replace
   and drain every old API replica, verify the new backend reports
   `schema: ready`, and only then expose the matching frontend; keep the
   compatibility trigger until no old writer can run;
6. collect DOB through a reviewed one-time account flow, with communications
   and support prepared, rather than a blind SQL update; and
7. transition any identified under-13 account only through a separately
   approved plan that preserves identity/history, establishes verified guardian
   authority and consent, revokes sessions, and provides appeal/support paths.

Any production backfill or bulk communication requires separate, explicit
authorization. The migration must never be mistaken for approval to operate on
production data.

## Current limitations and required review

- Guardian authority covers only initial public club Class creation. Payment,
  package use or purchase, rental, Calendar, staff, directory, account/session
  chat, booking-history access, cancellation, and rescheduling remain
  unavailable on behalf of a managed child. Payment for a guardian booking is
  arranged with the club.
- Managed children have no direct login, credential reset, email, or phone.
- Co-guardian invitation, acceptance, permission editing, and removal are not
  exposed even though multiple guardian links are representable.
- There is no handover resend or destination-change endpoint, HTTP
  `Retry-After` header, account-recovery flow, delivery/bounce webhook, or
  guardian-facing failed-delivery recovery. Creation does enforce a 60-second
  per-child cooldown.
- A deletion request restricts access but does not physically erase data. The
  retention schedule, identity verification, audit minimization, and operator
  workflow remain to be designed and approved.
- Legacy accounts with unknown DOB are flagged for review but remain usable; no
  production identification or transition campaign has been authorized.
- The policy does not collect or verify evidence of the claimed family
  relationship beyond the authenticated guardian's attestation.
- Product and counsel must decide whether handover at 13 should be prompted, how
  the existing `HANDOVER_REQUIRED` state at 18 is operationally escalated, when
  consent must be renewed, what `CLUBS_ONLY` discloses in each club workflow,
  and what child/audit data may be retained after deletion.

See [TODO.md](../TODO.md) for the work that must remain visibly deferred rather
than being simulated in the UI.
