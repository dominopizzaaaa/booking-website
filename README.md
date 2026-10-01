# Courtly

Courtly is a full-stack booking platform for coaching businesses. This repository is a small monorepo: the Express and Prisma API lives in `backend/`, the Next.js application lives in `frontend/`, and PostgreSQL stores application data.

[![CI](https://github.com/dominopizzaaaa/booking-website/actions/workflows/ci.yml/badge.svg)](https://github.com/dominopizzaaaa/booking-website/actions/workflows/ci.yml)

Courtly includes global student and coach accounts, guardian-managed child profiles with bounded guardian-authorized Class booking, dedicated club accounts, portable coach affiliations, named least-privilege club staff, multi-location and coach-aware availability, travel and preparation buffers, private and capacity-limited Classes, atomic finite booking series, shared class/rental court allocation, an operational inbox and bounded booking export, pending venue approval, account-backed student booking and self-service, direct account conversations and booking-bound session chat with scheduling proposals, personal Google Calendar sync, package offers, owned-venue court rentals, live Stripe checkout for packages and Classes, simulated rental checkout, transactional email, password recovery, authenticator-app MFA, active-session controls, manual payment records, attendance, student/parent details, coach rosters, and responsive business workspaces. Defaults are SGD and Asia/Singapore.

It also covers how a club and its coaches actually work together: a club assigns a student to a coach and the coach accepts before the class is confirmed; either side proposes a new time and the other agrees before a session moves; classes, package purchases, and venue rentals are paid to the club, which then records what it pays each coach; and a club is told when historical records show that a coach and a student it introduced trained privately outside it.

Agents working on this repository should read [AGENTS.md](AGENTS.md) first.

Internal Singapore launch decisions and operating evidence are tracked under
[`docs/compliance/`](docs/compliance/README.md). Those registers are release
gates and templates, not legal advice or a claim of certification. In
particular, live commerce remains blocked until the operator identity,
seller/agent/GST treatment, final price display, responsible contacts, and
vendor facts are approved and evidenced.

## Accounts, clubs, and bookings

Courtly has exactly three account types: `STUDENT`, `COACH`, and `CLUB`. Students and coaches are people with portable global identities. A club account represents the organisation itself, belongs to its one club workspace, and is never a teaching profile.

- **Students** create or sign in to a student account from a club's booking page. Signing in is required before a booking can be submitted. The resulting club-specific student record is linked to the global account, so the student can return to view receipts and booking history, buy package offers, reserve club-owned courts, then cancel or propose a reschedule for eligible sessions. An eligible adult instead uses their own signed-in account to create the bounded booking described below for a linked managed child; that does not give the guardian the child's self-service access. New guest bookings and private management links are not supported; already-issued legacy links remain available only for their existing bookings.
- **Coaches** register their own coach account. A club can find the account by public username, name, or email, or create a seven-day email-bound invitation and share its one-time signup link. Accepting an invitation creates the same roster affiliation and selects that workspace. Coaches carry the same identity across clubs and switch between those affiliations. Creating new independent practices is no longer supported.
- **Clubs** choose the club account type at sign-up, which creates their one club workspace. The business name becomes the club account's identity, while the person's name supplied at sign-up is kept as the club contact. The club account manages Classes, locations, coach affiliations, schedules, bookings, students, package offers, rentals, payments, and settings. It has no coach profile and cannot teach a class; even a founder who coaches uses a separate `COACH` account and joins the roster like every other coach.

Each account has one immutable internal ID, one globally unique lowercase username (`a-z`, `0-9`, and `_`, 3–30 characters), and up to 20 chosen sports. A self-managed account signs in with its unique normalized email and password. A guardian-managed child deliberately has no email, phone, password, or direct login; its username remains a unique identity key but is not publicly discoverable.

Memberships are affiliations only: they connect an account to a business and, for a club coach, to that coach's roster profile. They do not contain workspace roles. Authority comes from the account type and active club affiliation: the `CLUB` account manages its club, while a coach inside a club is scoped to their own work. Each account-backed student record separately holds that student's club-specific booking, package, attendance, and payment context. Historical `SOLO` businesses and `DIRECT` payment routes remain immutable records, marked `legacyReadOnly` and excluded from login and workspace selection; no new direct commerce is created.

A club can also invite an existing student or coach account as a **named staff member**. This is a separate workspace grant, not a membership, account type, or teaching role. The club chooses an Administrator, Operations, Front desk, Finance, Safeguarding, Read only, or custom permission set; the exact permissions are snapshotted onto the grant. Accepting selects staff mode for that session without changing the person's global identity or coach affiliations. Staff may switch explicitly between their own coach memberships and staff grants. Revocation disables the grant and clears selected sessions, while retained audit rows preserve who invited, accepted, changed, or revoked access. The institutional `CLUB` account retains implicit full club authority.

## Family and child accounts

Family is a parent-first account flow for Singapore. Its routes default to
enabled outside production and disabled in production until
`FAMILY_FEATURE_ENABLED=true` is explicitly set after the coordinated rollout.
When enabled, it does not add a fourth account type: each managed child is a
distinct `STUDENT` user with `accountControl: GUARDIAN_MANAGED`, linked to one
or more adult personal accounts through `GuardianChildLink`. One guardian can
therefore manage several separately identified children without re-registering,
and the model can represent several guardians for one child even though
co-guardian invitation and management UI is deferred.

Age is derived on the server from a full date of birth using the Singapore civil date: under 13 is a child, 13–17 is a teen, and 18 or older is an adult. Date of birth is stored as a date rather than a timestamp and cannot be changed after it is set. Existing personal accounts without a date of birth remain usable but are flagged for a one-time age review; no production account backfill or bulk transition is run automatically. A self-managed user found to be under 13 is restricted to remediation, while guardian-managed profiles have no direct session or account capabilities.

There is no separate parent account type. A parent or guardian creates their own adult `STUDENT` account—or uses their `COACH` account—and Family records their authority over each separate child profile. One adult account may manage multiple children. An eligible adult opens **Family**, chooses **Add child** for each child, supplies separate legal and display names, date of birth, globally unique username, sports, relationship, and a conservative `PRIVATE` or `CLUBS_ONLY` visibility, then confirms guardianship and the current child privacy policy. Ordinary child operations require that authenticated guardian's active link and exact permission. The dashboard exposes full child details only through an active `PROFILE_MANAGE` link; a withdrawn `CONSENT_MANAGE` link receives only the minimum identity and consent state needed to renew. Explicitly cancelling a handover requires current active `HANDOVER_MANAGE` authority. Consent grants, renewals, withdrawals, deletion requests, and handover events are retained as append-only evidence. PostgreSQL assigns every event a monotonic sequence, and effective per-link consent follows that sequence rather than timestamps or client order. A withdrawing guardian cancels their own pending handover; cancelling another guardian's pending request additionally requires `HANDOVER_MANAGE`. Date of birth and exact age are private, and managed children are excluded from public account discovery.

The safe subset manages identity, privacy, consent renewal/withdrawal, a bounded guardian-authorized Class flow, data export, deletion requests, and eventual verified handover. On a public club booking page, an eligible adult chooses one linked managed child and books an ordinary `CLUB`-route Class; siblings require separate booking submissions so each child receives an independently checked place. The server atomically rechecks that guardian's exact active link, `BOOKINGS_MANAGE`, current consent for that same link, and the child's active guardian-managed `STUDENT` state and under-18 age. It creates or reuses a club-local `Student` projection linked to the child's immutable user ID without inventing an email or copying the guardian's contact details. The booking records the authenticated guardian's user ID and real `STUDENT` or `COACH` account type as its creation provenance. It is unpaid and package-free; Courtly collects no money and the guardian arranges payment with the club.

This narrow action does not let the guardian buy a package, make a payment, reserve a rental, connect Calendar, use child directory features, or participate in account or session chat as the child. The guardian is not added to the booking's session chat and gains no child self-service cancellation or reschedule authority. A deletion request restricts the profile but still requires an approved operational erasure process. See [the child-account architecture](docs/CHILD_ACCOUNTS.md) and [release gates and deferred work](TODO.md).

Handover preserves the same user ID, username, history, and relationships. From age 13, an authorized guardian may start it for a unique destination email; the Family UI offers the same action for a still-managed adult. At 18 the server also places that identity in the `HANDOVER_REQUIRED` remediation state, but automatic transition, notification, and escalation are not implemented. The handover row stores only a digest of its one-use token. The outbox stores only the handover ID, expiry, and non-secret key ID; the worker derives the bearer token from a dedicated versioned HMAC key and builds the claim URL only in memory immediately before sending. The profile remains guardian-managed until the recipient follows the link and creates a new password. Completion changes control to `SELF`, marks the destination email verified through possession of the claim link, ends active guardian links, records the event, and revokes old sessions. Handover is unavailable unless both transactional email and the dedicated token keyring are configured—Courtly does not display or pretend to send the token. The adulthood journey and its operational escalation remain production review items in [TODO.md](TODO.md).

These controls are an engineering policy, not a guarantee of legal compliance. The age rules, consent wording, retention/deletion procedure, visibility model, and handover policy require review by qualified Singapore privacy counsel before production use.

## Account security

Self-managed accounts can request a generic, non-enumerating password-reset
email and change their sign-in email only after a fresh credential check. Both
flows use single-use 30-minute claims whose bearer values are derived only for
delivery, placed in a URL fragment, and removed by the browser before the API
request. Completing either change revokes all active sessions and pending
credential claims.

Authenticator-app TOTP with one-use recovery codes is available from **Account
security**. Password sign-in creates a short-lived MFA challenge when enabled.
Passkeys are not implemented. User sessions have a 14-day absolute lifetime, a
12-hour idle timeout, and opaque public IDs for per-device revocation. Sensitive
credential, staff, ledger, checkout, cancellation/refund, guardian, merchant,
Calendar, and export actions require authentication within the last 15 minutes;
the application prompts once and retries the original request once. Creating a
privacy-rights request remains deliberately accessible to a signed-in, verified
person, while cancelling a live request requires the recent-auth check.

`/api/health` reports `accountSecurity: "configured"` only when the account
security keyring and transactional email are both usable.
`"recovery-disabled"` means local MFA/session protection is configured but
password recovery and email change cannot operate; `"disabled"` means the
account-security keyring itself is unavailable.

## Classes, packages, rentals, and payments

All new commercial activity belongs to a `CLUB` workspace. Every class booking snapshots `paymentRoute: 'CLUB'`, so the student pays the club and the club can later record a `CLUB_TO_COACH` payout. Legacy `SOLO`, `DIRECT`, and `STUDENT_TO_COACH` values are retained only so existing contractual history stays readable.

The public booking page also lets an eligible adult guardian select a managed child returned by `GET /api/family/booking-children`. Submission uses `POST /api/family/children/:id/bookings`; the server repeats every link, permission, consent, child-state, identity, and scheduling check in the booking transaction. Guardian bookings are created unpaid, without a package or checkout intent, and payment is arranged with the club outside this flow.

- Clubs publish **Package offers** scoped to any non-empty combination of Classes and rentable locations. A purchase creates an immutable `LessonPackage` snapshot shown to the student under **My Packages**, including copied scope, credit count, price, and expiry.
- A club can make an owned facility rentable by configuring its sport, courts or other units, opening hours, hourly price, duration rules, notice and cancellation windows, rules, and amenities. Every account can browse and reserve a specific unit and time: students choose **Explore → Venue rentals** in the five-tab player app, while coaches and clubs choose **Explore → Rent a court** in the grouped workspace hub.
- Package and Class checkout uses Stripe Elements and PaymentIntents when `PAYMENTS_MODE=stripe`; the server derives price, currency, payer, connected club account, and target, while signed, idempotent webhooks finalize the Courtly entitlement, ledger, and immutable customer payment receipt. Each club's Stripe connected account must already exist and be provisioned into `BusinessPaymentAccount` outside Courtly—there is no Connect onboarding UI or provisioning API. `PAYMENTS_MODE=simulated` is a non-production mode that keeps the explicit simulated package/Class UI and does not issue a real-payment receipt. Rental checkout remains simulated in every mode. Package-funded reservations consume one credit and create no cash payment. See [`docs/PAYMENT_RECEIPTS.md`](docs/PAYMENT_RECEIPTS.md).

Club staff can create an explicit **series** of 2–24 Classes with editable occurrence dates and one initial roster. The entire series is validated and written atomically: if any coach, student, package, or venue allocation conflicts, no occurrence or credit is committed. After creation, each booking and participant remains independently authoritative, so cancelling or rescheduling one Class does not mutate the rest of the series; there is no open-ended recurrence engine or bulk series-edit API.

When a facility enables Class unit scheduling, Classes and rentals share `VenueUnitAllocation`. A Class takes one available active court/resource, database constraints reject overlapping active allocations, and cancellation releases that allocation while retaining history. This is opt-in per location and applies only to Courtly-managed units; third-party or approval-required venues still need external confirmation.

A recorded payment can be reversed. The record stays in the ledger marked as reversed, and the class or package returns to unpaid, so a correction is visible rather than silent. An eligible rental cancellation restores its package credit exactly once, or marks a paid reservation refunded and reverses the linked student payment.

Because a club invests in introducing its coaches to its students, Courtly flags it to the club when a coach and a student who train together through that club also book privately outside it. Courtly reports; it does not block the booking, and it does not tell the coach or the student. The club records what it found and closes the flag.

## Training companion

Courtly stays a multi-club marketplace, and it also helps players and families
with the weekly routine of training. See
[`docs/TRAINING_COMPANION.md`](docs/TRAINING_COMPANION.md) for the full contract.

- **Calendar and re-booking.** Students switch My bookings between a list and a
  month calendar, filter by club, coach, or sport, and use **Book again** to
  reopen a club's booking page with the same Class, coach, and venue
  preselected and the next available times one tap away.
- **Find a time and saved clubs.** Explore searches live availability across
  clubs by day, sport, time of day, Class type, and area, and students can save
  clubs they like.
- **Coach feedback and progress.** Coaches run a Class from their phone: take
  the roll at the start (Present, Late, Absent, Excused), then share feedback
  per learner with strengths, focus areas, and a next goal, plus an internal
  note only the club sees. Learners get a Progress view with attendance
  streaks, monthly activity, their current goal, and a feedback timeline.
- **Families.** A guardian can switch the student app to a managed child's view
  and read that child's schedule and shared coach feedback; booking stays the
  bounded guardian flow, and cancellation or payment is still arranged with the
  club.
- **Waitlists.** A full group Class offers a waitlist. When a place frees up,
  the next student is offered it and the place is held for a limited time so a
  public booking cannot take it first.
- **Package credits.** Every credit change is recorded by the database in an
  append-only history that students and clubs can open, and students are
  reminded when a package is nearly used or about to expire.
- **Public profiles.** Club booking pages lead with a description, sports,
  starting price, areas, cancellation notice, contact options, and what happens
  after booking. Coaches publish a portable profile with bio, languages, levels,
  age groups, and self-reported qualifications.
- **Club tools.** Clubs keep training groups (club-local cohorts that prefill a
  booking series), manage waitlists, and see Growth insights: an anonymous
  daily funnel from page views to bookings, re-booking and waitlist conversion,
  returning students, and feedback coverage. Funnel counters store no visitor,
  account, or device identifiers.
- **Installable.** The web manifest lets players add Courtly to a home screen;
  there is deliberately no offline cache for signed-in data.

## Account conversations and session chat

Chat combines direct account conversations with the conversation attached to every booked Class. Signed-in students, coaches, and clubs can start a conversation with another registered account by searching its public name or username, or by entering its exact email. This uses the same bounded, authenticated account search as roster discovery: partial email addresses are never exposed, results contain only public profile fields, and opening the same pair again returns their existing conversation. In both apps Chat takes the tab-bar slot Alerts used to hold; Alerts live under the bell at the top right.

- **Club handoff.** In a conversation between a student and a club, only that club can add, replace, or remove one active coach from its roster. Courtly confirms that the coach will see the full existing history before granting access. Removing the coach — or deactivating their roster affiliation — ends that access without deleting the conversation.
- **Planning from an account conversation.** A student and coach can press **+** and choose a private Class, venue, date, and available time from any active club where that coach is currently bookable. In a student–club conversation, only the student and its assigned active roster coach can propose, and every option stays inside that club. Other account pairings remain messaging-only.
- **Session conversations stay separate.** Every booked Class still has its own chat, whether it is a 1-1 lesson or a group. Its members come from the booking itself: the coach, every student who holds a place, and the club account. Accepting a proposal in an account conversation creates a normal club booking and that booking's separate session chat; it does not turn the original account conversation into the session thread.
- **Proposals.** A student proposes for themselves and the coach answers with **Accept**, **Decline**, or **Edit**. Edit sends a different time back for the first proposer to accept. In a group session chat, a coach's proposal goes to every student and each answers for themselves. The club reads along and messages, but does not propose or answer.
- **Reminders.** A day before each confirmed session, Courtly posts a reminder into its session chat. A session that moves is reminded again for its new time. The reminder worker runs inside the backend process alongside the Calendar worker.
- **Booking and Calendar.** Acceptance re-checks live availability, then books an ordinary `CLUB`-route Class for the student. It appears in the student's bookings and the club and coach calendars immediately and, like every confirmed Class, is projected to connected Google Calendars. A venue that needs approval keeps it pending until the club secures it.
- **Privacy.** Messages are visible only to the conversation's active participants and to the platform admin console. An assigned coach can read earlier messages; each chat discloses who can see it. The API does not send internal account IDs to the browser and computes which messages, members, and proposal actions belong to the reader.

Chat updates by polling while the page is visible; there is no push delivery, email, or SMS.

## Google Calendar

Google Calendar is a personal, user-owned integration. A `STUDENT` can connect one Google account for classes across every club, and a `COACH` can connect one for classes across every club affiliation. Connect it from the account's Profile (or the provider account page). An institutional `CLUB` account cannot connect a calendar or manage a coach's connection.

Courtly remains the source of truth:

- Only confirmed Classes are published to Google. Pending assignments and Classes awaiting venue approval are not added.
- Confirmed reschedules update the existing Google event and cancellations remove it asynchronously. Booking and reschedule requests commit in Courtly without waiting for Google, so a short delay or a retry after a provider outage is expected.
- Editing or deleting a Google event never changes, reschedules, confirms, or cancels the Courtly booking. Make every booking change in Courtly.
- The sync worker runs inside the backend process; there is no separate worker service or cron job to deploy.

Connected students and coaches may also enable external-conflict checks. Courtly reads Google free/busy data and caches only bounded busy time intervals; it never retains external event titles, descriptions, attendees, locations, or other event details. The cache is advisory: when it is stale or Google is unavailable, scheduling fails open and Courtly's own availability and conflict rules continue to apply.

OAuth tokens are encrypted at rest with deployment-managed keys and are never returned to the browser. Disconnecting first queues removal of Courtly's projected events, then revokes and deletes the stored grant; this is asynchronous, and events may need manual removal if Google stays unavailable. If the integration is disabled after someone has connected, disconnect still removes Courtly's local credentials and projections, but the user must remove any remaining Courtly events or grant from Google. If Google consent is revoked, the refresh grant expires, or required permissions change, Courtly marks the connection for reconnection; existing Courtly bookings are unaffected.

## Club operations and production readiness

The institutional `CLUB` account always has full authority. Clubs can delegate day-to-day work to named people without sharing that login or pretending office staff are coaches:

- A staff invitation is bound to an email address, expires after seven days, and stores only a SHA-256 digest of the one-time token. A signed-in `STUDENT` or `COACH` accepts it with the same personal account; a `CLUB` account cannot accept another club's staff grant. Courtly returns the invitation link to the club for manual delivery—it does not email staff invitations.
- Administrator, Operations, Front desk, Finance, Safeguarding, and Read only are permission snapshots, not mutable role definitions. Custom grants select individual booking, student, catalogue, availability, roster, rental, package, payment, payout, integrity, settings, staff-administration, and audit capabilities. Route middleware rechecks the selected grant, while `/api/workspace` omits collections the staff member cannot view. Revocation clears every session currently using that grant.
- Staff grants are independent of memberships and the coach roster. A coach may switch between a scoped teaching affiliation and a broader or narrower office grant; accepting or revoking staff access never changes their account type, roster identity, or other club affiliations. Staff invitation/acceptance/update/revocation events have immutable actor snapshots. Users with `AUDIT_VIEW` can review that redacted, cursor-paginated history in Insights; the audit scope currently covers those staff-access events only.

The provider workspace also has operational tools for larger clubs:

- `GET /api/operations/inbox` derives a paginated queue of coach acceptance, venue approval, attendance, reschedule, unpaid participant, and rental issues. It is a live database view, not a task-assignment or workflow engine. The workspace Home screen shows only categories the selected coach or staff grant may view and links each item to the relevant operational surface.
- Bookings have paginated filtering by date, status, coach, location, Class, and free-text identity. CSV export requires both dates, allows at most a 366-day window, and refuses results over 10,000 rows.
- A club-side user with `BOOKINGS_MANAGE` can create a finite series of 2–24 explicitly dated Classes with one initial roster. All dates, students, package credits, coach conflicts, and venue resources are checked atomically; one conflict rolls back the whole series. Afterwards, each booking retains its own status, attendance, payment, chat, Calendar projection, cancellation, and reschedule lifecycle. There is no infinite recurrence rule, bulk series-edit/cancel endpoint, or later roster-management endpoint.
- A facility can opt into Class unit scheduling. New Classes then auto-select one available active `VenueUnit`, sharing the same `VenueUnitAllocation` ledger and database overlap exclusion used by rentals. Cancellation releases the allocation and rescheduling replaces it. This does not reserve third-party courts, does not offer manual unit selection, and does not backfill older Classes when the flag is enabled later.

### Stripe configuration and limits

`PAYMENTS_MODE` defaults to `disabled`. Set it to `stripe` with `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` to enable the provider-backed checkout API for package purchases and outstanding Class participants. Test and live key prefixes must match; production rejects `PAYMENTS_MODE=simulated`. The Stripe webhook is `POST /api/payments/webhooks/stripe` and must receive connected-account `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, and `account.updated` events through the public frontend `/api` proxy. Signature verification uses the untouched raw request body, and the event inbox de-duplicates provider event IDs and payloads.

Configuration readiness is not commercial or tax approval. Before accepting
live customer funds, complete and approve the
[`seller/agent/GST decision record`](docs/compliance/SELLER_AGENT_GST_DECISION.md)
for every enabled flow and club type. The schema stores club-supplied merchant
identity and GST declarations for checkout gating, but does not independently
verify them, decide the contracting seller, or calculate a tax rate or tax
amount. Do not infer an approved legal or tax position from those declarations,
a club account, UEN, Stripe connected account, or `paymentRoute`.
Production also requires `PAYMENT_COMMERCIAL_APPROVED_VERSION` to equal the
current checkout-policy version (`2026-09-29`). This is an independent
fail-closed switch: legal-document publication does not approve the commercial
or tax model, and setting the switch is not evidence that the review occurred.

Every accepting club also needs a `BusinessPaymentAccount` row containing its existing Stripe connected-account ID and settlement currency, with `chargesEnabled=true`. Courtly consumes account status but does not create connected accounts, generate onboarding links, or expose an account-provisioning admin API; provision and validate those rows through an approved external operational process. For a selected club workspace, `GET /api/payments/account-status?businessId=...` reports the stored readiness state to accounts with payment-view access, and `/api/health` reports the configured payment mode.

In Stripe mode, the student package and outstanding-Class surfaces create or resume server-priced PaymentIntents, initialize Stripe Elements in the club's connected-account context, and wait for verified fulfillment. Stripe-backed reversals create a durable refund request before the provider call and update the local ledger, entitlement, and reservation state only after confirmed success; refund webhooks converge pending results. Rental checkout itself remains simulated regardless of `PAYMENTS_MODE`. Automated settlement/payout reconciliation and business subscription billing are not connected.

Production marks the exact current legal-policy set approved only when
`LEGAL_DOCUMENTS_APPROVED_VERSION` and `LEGAL_DOCUMENTS_APPROVED_HASH` match the
constants in `backend/src/legal-policy.ts`. Set them only after the accountable
approval record is complete. In production, that approval is required before
new registration, online checkout, or Family consent writes. A missing or
different value means the set is reported unapproved; the environment values
are a technical gate, not evidence that the documents or commercial position
were legally approved.

### Transactional email configuration and limits

`EMAIL_PROVIDER` defaults to `disabled`. Use `capture` only for local/tests; production rejects it. For production set `EMAIL_PROVIDER=resend`, `EMAIL_API_KEY`, and a verified `EMAIL_FROM_ADDRESS`; `EMAIL_FROM_NAME` and `EMAIL_REPLY_TO` are optional. Set `PUBLIC_APP_ORIGIN` to the canonical HTTPS frontend origin used in message links; production email rejects a missing, loopback, non-HTTPS, credential-bearing, or path-bearing origin. Production registration additionally requires `EMAIL_VERIFICATION_TOKEN_KEYS` (comma-separated `keyId:base64` 32-byte HMAC keys) and `EMAIL_VERIFICATION_TOKEN_ACTIVE_KEY_ID`. Family handover uses a separate `FAMILY_HANDOVER_TOKEN_KEYS` keyring and active ID. Keep retired keys available for at least the relevant claim lifetime plus the maximum worker retry window.

When email is enabled, registration creates a hashed, single-use, expiring verification claim and queues security mail in the same transaction; no raw bearer is stored. Production registration stays unavailable unless email and the active verification key are usable. Verification links place the bearer in a URL fragment, and the browser scrubs it before making the verification request. Booking-related student account alerts use the same durable, deduplicated outbox. Child-account handover uses that outbox only when its separate keyring is valid. Handover creation and its `HANDOVER_STARTED` evidence commit only when an `OutboundDelivery` is created as `QUEUED` in the same transaction; unavailable configuration or a non-queueable recipient leaves no handover behind. The success response and UI therefore mean **queued**, never sent or delivered. The API process leases rows as `SENDING`, marks provider acceptance as `ACCEPTED`, retries transient failures by returning them to `QUEUED`, and eventually marks terminal failures `FAILED`. No provider webhook currently advances `ACCEPTED` to `DELIVERED`.

The `ChildAccountHandover` table retains only the token digest, and `OutboundDelivery.payload` contains only the handover ID, expiry, and non-secret key ID. Immediately before provider dispatch, the worker rechecks the live handover state, expiry, and destination, derives the bearer URL in memory, and verifies it against the stored digest. Explicit cancellation, deletion, an observed expiry, and a consent withdrawal authorized for that particular handover directly mark matching `QUEUED` or `SENDING` work `SUPPRESSED`; consent-only withdrawal cannot suppress another guardian's request. The worker also suppresses a handover that fails its pre-dispatch recheck. A provider request already in flight or `ACCEPTED` cannot be recalled, but its claim fails after invalidation. Security mail bypasses optional notification preferences. The live Family route uses an unbound destination (`recipientUserId: null`), so it cannot consult an existing account's hard-suppression record; provider bounce/complaint handling is a release gate. There is a 60-second per-child creation cooldown, but no dedicated resend/destination-change endpoint or guardian-facing failure recovery yet. Password reset and verified email change use their own digest-only, single-use, 30-minute claims and the same durable outbox; completing either revokes all sessions. Live Stripe Package/Class payment-receipt email is also wired through that outbox. Rental receipts, chat, staff/coach invitation links, and reminder email delivery are not connected. There is no suppression-management console or SMS/push/WhatsApp channel.

## Requirements

- Node.js 22
- npm 10 or newer
- PostgreSQL 16 or newer, with the trusted `btree_gist` extension available,
  or the included local PostgreSQL helper. The committed prerequisite migration
  installs the extension when the deployment role is allowed to do so.

## Run locally

1. Install all three sets of dependencies:

   ```bash
   npm ci
   npm ci --prefix backend
   npm ci --prefix frontend
   ```

2. Copy the example environments:

   ```bash
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env.local
   ```

3. In one terminal, start the included local PostgreSQL instance:

   ```bash
   npm run db:local
   ```

   It listens on `127.0.0.1:55432` and persists its files under the ignored `.data/` directory. You can instead set `backend/.env` to any PostgreSQL `DATABASE_URL`.

4. Apply the database migrations:

   ```bash
   npm run db:migrate --prefix backend
   ```

5. Start the API and web application:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000). The Next.js server rewrites same-origin `/api/*` requests to the API at `http://127.0.0.1:4000`. Local development also allows the standard fallback origins on port 3001 for both `localhost` and `127.0.0.1`; list any additional browser origins in `APP_ORIGIN`.

To create a persistent sample club and club account instead of using the demo workspace, optionally set `SEED_CLUB_EMAIL`, `SEED_CLUB_PASSWORD`, `SEED_BUSINESS_NAME`, and `SEED_BUSINESS_SLUG` in `backend/.env`, then run `npm run seed --prefix backend`. If `SEED_CLUB_PASSWORD` is omitted, the command prints a generated password once.

For a temporary investor showcase on an already deployed account-aware environment, run `npm run demo:investors` with an explicit `INVESTOR_DEMO_BASE_URL` plus distinct `INVESTOR_DEMO_CLUB_PASSWORD`, `INVESTOR_DEMO_COACH_PASSWORD`, `INVESTOR_DEMO_STUDENT_PASSWORD`, and undisclosed `INVESTOR_DEMO_BACKGROUND_PASSWORD` values in the invoking shell. First-time provisioning also requires `INVESTOR_DEMO_ALLOW_CREATE=true`; later runs require the exact `INVESTOR_DEMO_EXPECTED_BUSINESS_ID` and `INVESTOR_DEMO_EXPECTED_BUSINESS_SLUG` printed by the first run. The builder uses normal authenticated APIs and fixed, mutually distinct `investor_demo_*` usernames to create one `CLUB` account, portable `COACH` accounts, `STUDENT` accounts, and a `Courtly Investor Showcase` workspace with representative schedules, hosted court sessions, group classes, packages, payments, cancellations, coach acceptances, and venue approvals. It never stores supplied passwords in the repository, never retries mutations automatically, requires HTTPS outside loopback development, and anchors dates to workspace creation so reconciliation does not append a new schedule each day. Normal club registration creates a non-demo workspace, whose deletion is hard-disabled in production. Run a temporary showcase in a disposable environment when removal is required, or delete the exact printed workspace ID from the platform admin console before promoting that environment to production; the bulk demo purge action does not apply.

`npm run demo:elever` is a destructive, database-level replacement intended only for the approved Elever investor environment. It deletes every application row while preserving migrations and schema objects, then creates one club-only Elever marketplace in one transaction. The fixed October 2026 Asia/Singapore dataset contains the two affiliated coaches, the eight named investor students plus Student 1 through Student 12, exactly nine group Classes and 30 1:1 Classes whose combined schedule covers every local date from October 1 through October 31, three Package offers, two purchased packages, simulated Stripe successes and a failure, an owned four-court badminton rental venue, four reservations, payouts, and a linked historical safeguard alert. Reprovisioning replaces the prior dataset rather than updating it in place; integration coverage verifies unchanged migration history, documented row counts, regenerated core and relationship IDs, and the full October class schedule on a second run. It creates no active `SOLO` practice or new `DIRECT` session. Take a verified backup and stop application writes first. Supply `ELEVER_RESET_CONFIRMATION`, all five `ELEVER_*_PASSWORD` variables, and `ELEVER_EXPECTED_DATABASE_SHA256`, which must equal the lowercase SHA-256 of `DATABASE_URL` (for example, `printf %s "$DATABASE_URL" | shasum -a 256` on macOS or `printf %s "$DATABASE_URL" | sha256sum` on Linux). The fingerprint binds the confirmation to the exact connection string without storing or printing it. The command also refuses an unresolved migration or a migration name/checksum mismatch. Afterwards, run `npm run verify:elever` with `ELEVER_BASE_URL` and the four featured passwords. Keep every secret in the invoking shell or secret manager, never in a committed file.

## Checks

With PostgreSQL running and the migrations applied:

```bash
npm test                              # backend Vitest, against local PostgreSQL
npm test --prefix frontend            # frontend unit tests; no server needed
npm run build
```

There are three suites, each covering what it is best placed to cover:

| Suite | Where | Covers |
| --- | --- | --- |
| Backend Vitest | `backend/tests` | Scheduling, money, tenancy, database invariants, and every API route |
| Frontend Vitest | `frontend/tests` | The pure helpers under the UI: money and date formatting, avatar initials, the shared alert vocabulary, and the API client |
| Playwright | `frontend/e2e` | Real journeys for each role, at three viewports, including accessibility and keyboard operation |

The backend integration suite deliberately requires a local PostgreSQL URL. GitHub Actions provisions an isolated PostgreSQL 16 service, migrates it, runs the tests, type-checks the frontend, runs the frontend unit tests, and builds both applications.

The backend stores namespaced, HMAC-hashed fixed-window rate-limit counters in PostgreSQL, so quotas are shared across all API replicas without Redis and raw IP/account identifiers are not persisted. Sensitive authentication and mutation limits fail closed if that store is unavailable; only the broad global traffic ceiling fails open so health checks and ordinary API availability retain their existing database-outage behavior. Deploy migrations and configure the same `RATE_LIMIT_HASH_KEY` on every production replica before starting the matching backend. The full Playwright suite deliberately creates many isolated accounts and workspaces from one loopback address. When running that suite, start the backend with `E2E_DISABLE_RATE_LIMITS=true` to bypass all API rate limiters for that process. The flag is opt-in, is unnecessary for normal development, and is ignored whenever `NODE_ENV=production`, even if it is accidentally set. Never configure it on a deployed service.

## Deploy from GitHub

Deploy the backend to Railway first, then point the Vercel frontend at the Railway public domain. Both hosts must import the same GitHub repository but use different Root Directories. Do not add `backend/.env` or `frontend/.env.local` to Git; configure production values in the hosting dashboards.

### 1. Railway: PostgreSQL and Express API

1. Create a Railway project and add a **PostgreSQL** database service. Railway generates its connection variables; no schema needs to be created manually. The generated database owner can install the trusted `btree_gist` extension through the committed prerequisite migration. On another managed PostgreSQL provider, ask an administrator to enable `btree_gist` before the first marketplace deployment if the application migration role cannot install extensions.
2. Add a service from this GitHub repository for the Express API.
3. In the API service settings, set **Root Directory** to `/backend`.
4. Set the service's **Config File Path** to `/backend/railway.toml`. Railway does not resolve that path relative to the Root Directory.
5. Add these API service variables for the initial deployment:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (choose the generated PostgreSQL reference variable; replace `Postgres` if the database service has another name) |
   | `NODE_ENV` | `production` |
   | `RATE_LIMIT_HASH_KEY` | Dedicated random 32-byte base64 HMAC key, identical on every API replica. Generate with `openssl rand -base64 32`. |
   | `DEMO_ENABLED` | `false` (recommended) to prevent public demo-data growth; use `true` only for a monitored showcase |
   | `LEGAL_DOCUMENTS_APPROVED_VERSION` | Exact reviewed policy-set version. Leave unset while the public documents are draft. |
   | `LEGAL_DOCUMENTS_APPROVED_HASH` | Exact reviewed policy-set hash from `backend/src/legal-policy.ts`. Both this and the version must match before production signup, checkout, or Family consent writes open. |
   | `ADMIN_OPERATORS_JSON` | Required to enable `/admin` in production. Compact JSON array of stable operator ID, name, normalized email, and bcrypt cost-12 password hash. |
   | `ADMIN_SESSION_SECRET` | Dedicated random 32-byte base64 HMAC key for named-admin cookies. Generate separately from every operator password. |
   | `PUBLIC_APP_ORIGIN` | Canonical frontend HTTPS origin used in transactional-email links, with no trailing slash. |
   | `PAYMENTS_MODE` | `disabled` or `stripe` in production. `simulated` is rejected in production. |
   | `PAYMENT_COMMERCIAL_APPROVED_VERSION` | Independent approval of the current seller/payment-recipient/refund/GST decision. Leave unset until the decision register is completed and approved; legal-publication approval does not open live Stripe. |
   | `STRIPE_SECRET_KEY` | Required in Stripe mode. Secret API key; its test/live mode must match the publishable key. |
   | `STRIPE_PUBLISHABLE_KEY` | Required in Stripe mode. Returned only by the authenticated payment-capabilities endpoint. |
   | `STRIPE_WEBHOOK_SECRET` | Required in Stripe mode. Signing secret for `/api/payments/webhooks/stripe`. |
   | `EMAIL_PROVIDER` | `disabled` or `resend` in production. `capture` is local/test-only. |
   | `EMAIL_API_KEY` | Resend API key, required when `EMAIL_PROVIDER=resend`. |
   | `EMAIL_FROM_ADDRESS` | Verified sender address, required whenever email is enabled. |
   | `EMAIL_FROM_NAME` | Optional sender display name; defaults to `Courtly`. |
   | `EMAIL_REPLY_TO` | Optional reply-to address. |
   | `EMAIL_VERIFICATION_TOKEN_KEYS` | Comma-separated `keyId:base64` HMAC keys for email-verification claims; each key must decode to 32 bytes. Required with transactional email for production registration. |
   | `EMAIL_VERIFICATION_TOKEN_ACTIVE_KEY_ID` | Key ID used for newly issued verification claims. Retain retired keys through the claim lifetime and maximum delivery retry window. |
   | `FAMILY_FEATURE_ENABLED` | Production defaults to `false`. Keep it `false` through the coordinated Family migration and backend verification; set it to `true` only when Family routes should open. |
   | `FAMILY_HANDOVER_TOKEN_KEYS` | Comma-separated `keyId:base64` handover-token keys; each key must decode to exactly 32 bytes. Required, with email, to enable verified handover. |
   | `FAMILY_HANDOVER_TOKEN_ACTIVE_KEY_ID` | Key ID used for new handovers. Keep retired keys configured for at least the seven-day claim lifetime plus the maximum email retry window. |
   | `GOOGLE_MAPS_API_KEY` | Optional. A Google Places API key enabling venue search. Leave unset to keep the paste-a-Maps-link fallback, which needs no key. |
   | `GOOGLE_CALENDAR_CLIENT_ID` | OAuth 2.0 web client ID from Google Cloud. Leave the Calendar variables unset to disable the integration. |
   | `GOOGLE_CALENDAR_CLIENT_SECRET` | OAuth 2.0 web client secret from Google Cloud. |
   | `GOOGLE_CALENDAR_REDIRECT_URI` | Exact public callback URI registered in Google Cloud, normally `https://YOUR-VERCEL-DOMAIN/api/calendar/google/callback`. |
   | `CALENDAR_TOKEN_ENCRYPTION_KEYS` | Comma-separated `keyId:base64` token-encryption keys; each key must decode to exactly 32 bytes. |
   | `CALENDAR_TOKEN_ACTIVE_KEY_ID` | ID from the key list used for new token encryption. |

   Do not set `PORT`; Railway injects it.
   `APP_ORIGIN` is added after Vercel assigns the frontend URL. It can remain unset for this initial health-only deployment because no browser will use the API yet.
6. Deploy once. The checked-in Railway config installs dependencies (including the build and migration tools) and builds the TypeScript API. Before each release starts, `npm run db:migrate` applies committed Prisma migrations; the service then starts with `npm start`. A failed migration prevents the new release from starting.
   The guardian-child migration adds nullable credentials for managed children, immutable date-of-birth and append-only consent-history protections, database-assigned monotonic consent ordering, and family relationship/handover tables. It backfills existing users' `legalName` from `name` but deliberately leaves their email-verification state and date of birth unknown. Treat this as a coordinated cutover, not an ordinary mixed-version rolling release: deploy with `FAMILY_FEATURE_ENABLED=false`, pause personal registration and Family writes, take a verified backup, apply the migration, replace and drain every old API replica, and verify the new backend reports `schema: "ready"` plus `capabilities.family: "disabled"`. Only after the matching frontend and operational checks are ready should you set `FAMILY_FEATURE_ENABLED=true`, redeploy, verify `capabilities.family: "enabled"`, and expose Family. While disabled, public handover claims return 404 and authenticated Family endpoints return 503. The migration's compatibility trigger lets an old writer omit `legalName`, but an old API does not enforce the new age/capability policy and old/new personal-registration payloads are incompatible. Keep that trigger until no old writer can run. The migration does not classify, lock, contact, or otherwise transition existing production users; any production audit or backfill requires a separately reviewed plan, dry run, rollback/support procedure, and explicit approval.
7. Generate a public domain in **Settings → Networking** and copy the resulting HTTPS origin. The production service currently uses `https://booking-website-production-42b1.up.railway.app`. Verify `https://YOUR-RAILWAY-DOMAIN/api/health` returns JSON with `"ok": true`, `"schema": "ready"`, and the expected capability values for `namedClubStaff`, `bookingSeries`, `operationalInbox`, `payments`, `transactionalEmail`, `family`, `familyHandover`, and `googleCalendar`. A healthy process with an unexpected capability value is the wrong configuration or release. `family` reports the route rollout gate independently. `familyHandover` reports dependency readiness and is `"configured"` when transactional email and the dedicated handover-token keyring are enabled, even while `family` is `"disabled"`; claims remain inaccessible until the Family gate opens.
   Railway probes `/api/live` for process liveness; that endpoint deliberately
   does not query PostgreSQL. Keep `/api/health` as the separate deployment
   readiness and release verification gate.

`APP_ORIGIN` is still required for the backend's explicit browser-origin checks. The browser itself talks only to the Vercel origin: Next.js proxies `/api/*` server-side to Railway, so the secure `__Host-courtly_session` cookie remains a same-origin frontend cookie rather than a third-party cross-site cookie.

### 2. Vercel: Next.js frontend

1. Import the same GitHub repository as a new Vercel project.
2. Set **Root Directory** to `frontend`. Vercel should detect the Next.js framework; `frontend/vercel.json` supplies the install and build commands.
3. Add `BACKEND_URL` for **Production** (and Preview if preview deployments should use this API). Set it to the Railway public HTTPS origin from step 1, with no trailing slash (`https://booking-website-production-42b1.up.railway.app` for the current production service). This is a server-side rewrite target and is not a public browser variable.
4. Deploy the project and note its canonical production URL.
5. Return to the Railway API variables, add `APP_ORIGIN` with that exact Vercel origin (for example `https://courtly.example.com`, with no trailing slash), and redeploy the API. If a custom frontend domain is added later, update `APP_ORIGIN` to the domain users actually visit. For more than one allowed origin, use a comma-separated list.
6. Redeploy Vercel whenever `BACKEND_URL` changes because Next.js resolves the rewrite configuration during the build.
7. Open `https://YOUR-VERCEL-DOMAIN/api/health` and confirm it matches the direct Railway response, including the operational and provider capability values from step 7 above. If it does not, rebuild Vercel with the intended `BACKEND_URL`; the rewrite target is fixed at build time. Then register or sign in with a student account and complete a booking. Confirm that it appears in the student's self-service history. In browser developer tools, `/api/*` requests should target the Vercel hostname, not the Railway hostname.

Finish the Railway rollout before deploying the matching Vercel build. The
generalized chat migration and backend are a coordinated release: Railway's
pre-deploy migration must complete before the new process starts, and old API
instances must drain before account conversations are used. This also ensures
no ACCOUNT conversation exists while an old API still assumes every thread has
a booking.

Preview deployments have a different origin on every build. If previews need authenticated mutations, add the desired preview origins to Railway's `APP_ORIGIN`; otherwise keep previews connected only for read-only checks or omit the Preview `BACKEND_URL`.

### 3. Google Cloud: optional Calendar integration

Google Calendar uses an OAuth web client and the public Vercel origin. The callback still reaches Railway through the existing same-origin `/api/*` rewrite. Configure it as follows:

1. In a Google Cloud project, enable the **Google Calendar API**, configure the OAuth consent screen, and add the users who may connect while the application remains in testing mode. Courtly requests `openid`, `email`, and `https://www.googleapis.com/auth/calendar.events`: identity ties the grant to the signed-in Courtly user, while the Calendar scope writes Courtly events and reads only the fields needed to derive private busy intervals. Complete Google's publishing and verification requirements before offering the integration beyond those test users.
2. Create an **OAuth 2.0 Client ID** with application type **Web application**.
3. Add the exact production redirect URI `https://YOUR-VERCEL-DOMAIN/api/calendar/google/callback` under **Authorized redirect URIs**. Replace the placeholder with the canonical Vercel or custom frontend domain; do not use the Railway domain and do not add a trailing slash. For local development, separately register `http://localhost:3000/api/calendar/google/callback`. Google requires an exact match.
4. Generate a 32-byte token-encryption key:

   ```bash
   openssl rand -base64 32
   ```

   Copy the output directly into the Railway secret manager, for example as `CALENDAR_TOKEN_ENCRYPTION_KEYS=v1:OUTPUT_FROM_OPENSSL`, and set `CALENDAR_TOKEN_ACTIVE_KEY_ID=v1`. Do not commit the output, paste it into tickets or chat, or leave it in a checked-in `.env` file.
5. Set all five Calendar variables on the Railway API service: `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI`, `CALENDAR_TOKEN_ENCRYPTION_KEYS`, and `CALENDAR_TOKEN_ACTIVE_KEY_ID`. The redirect variable must be the same Vercel callback registered in step 3. Redeploy the backend.
6. Check `https://YOUR-RAILWAY-DOMAIN/api/health`. Its `capabilities.googleCalendar` value is `"configured"` only when the complete server-side configuration is usable; otherwise it is `"disabled"`. A configured capability says the OAuth feature is available, not that any particular user is connected.

The API process also runs the durable Calendar sync, event-cleanup, OAuth-revocation, and free/busy refresh worker, so a normal Railway backend deployment needs no second service. Calendar outages do not roll back Courtly changes; relevant work is coalesced in the outbox and retries asynchronously. A grant returned by Google is recorded as an encrypted revocation job until the callback has durably saved the connection, so a database failure after token exchange does not silently strand access. Disabled deployments and users without a relevant connection or projection do not accumulate booking-sync jobs. Monitor reconnect-required states and provider errors after releases.

For encryption-key rotation, add the new `keyId:base64` entry to `CALENDAR_TOKEN_ENCRYPTION_KEYS`, switch `CALENDAR_TOKEN_ACTIVE_KEY_ID`, and redeploy. Keep every old key in the list until no stored token uses it; removing a key prematurely makes those connections unreadable and forces users to reconnect. Rotate the Google client secret independently in Google Cloud and Railway. Preview domains need individually registered callback URIs and matching backend configuration; Google does not accept a wildcard Vercel callback.

## Production operations

- Commit a new Prisma migration for every schema change. Railway runs `prisma migrate deploy` through `npm run db:migrate`; it does not run destructive development migrations or seed production automatically.
- Backend startup checks the small set of schema contracts required by the
  running release and refuses to serve traffic when they are missing.
  `/api/health` returns `schema: "ready"` on success or HTTP 503 with
  `schema: "out-of-date"`; apply pending migrations before restarting.
- Marketplace migrations deliberately wait at most ten seconds for their
  application-table locks. A `55P03` or `lock timeout` failure means concurrent
  traffic prevented a safe migration start: stop writes or use a quiet release
  window, mark only the exact failed migration as rolled back with
  `prisma migrate resolve --rolled-back <migration_name>`, then redeploy. Do not
  disable the timeout as the first response. An extension permission or missing
  control-file error is different: have the database administrator enable
  `btree_gist`, resolve the failed prerequisite migration, and retry.
- Set `DEMO_ENABLED=false` when public demo creation is not wanted. Global student, coach, and club account registration and sign-in remain available.
- Keep at least one backend instance running: the day-before chat reminders, Calendar worker, and transactional-email worker all run in the API process. Several instances are safe; chat reminders use locks, while outbound email uses database leases and a unique delivery key. A user-visible Calendar or email delay does not mean the Courtly mutation failed; inspect the corresponding worker state before replaying a mutation.
- Treat `/api/health` as a release gate, not full end-to-end monitoring. It checks PostgreSQL reachability, required schema objects, and configuration-derived capabilities. It does not make a live Stripe, Resend, Google, or browser request. `accountSecurity: "configured"` confirms the keyring and transactional-email configuration, not successful provider delivery; `"recovery-disabled"` means MFA/session controls remain configured while recovery email is unavailable. `family: "enabled"` confirms that the server route gate is open. `transactionalEmail: "configured"` alone does not establish handover readiness; `familyHandover: "configured"` confirms that email and the dedicated keyring passed configuration but remains independent of the Family route gate and does not prove provider delivery or a successful claim journey. Require both `family: "enabled"` and `familyHandover: "configured"` before testing claims. Likewise, `payments: "stripe-live"` does not prove webhook routing, connected-account readiness, or a successful payment journey.
- Monitor stale `QUEUED`, expired-lease `SENDING`, terminal `FAILED`, and aging `ACCEPTED` `OutboundDelivery` rows. `ACCEPTED` means only that the provider accepted the request; `DELIVERED` is schema-supported but is not currently populated. Also monitor Stripe `PaymentProviderEvent` rows with a stale `availableAt`, no `processedAt`, or a `lastErrorCode`. The current API retries email jobs, but Stripe webhook processing has no background replay worker; a failed webhook needs Stripe redelivery or an explicit operational replay after the cause is fixed.
- Before enabling live Stripe, complete and approve the seller/agent/GST decision, set the exact current `PAYMENT_COMMERCIAL_APPROVED_VERSION`, verify the webhook through the public Vercel `/api` route, ensure its raw request body is preserved, externally provision one connected account row per accepting club, and confirm both `/api/payments/account-status` and a test-mode package/Class checkout. The backend rechecks commercial approval immediately before a provider create/retrieve call; legal-document approval alone does not authorize money collection. Do not treat `payoutsEnabled` as proof that Courtly automates coach payouts: `CLUB_TO_COACH` entries remain manually recorded ledger events.
- To create an initial known club deliberately, run the Railway service's `npm run seed` command once with strong `SEED_CLUB_PASSWORD`, `SEED_CLUB_EMAIL`, `SEED_BUSINESS_NAME`, and `SEED_BUSINESS_SLUG` variables. The seed is idempotent for an existing slug and is not part of deployment.
- Check the Railway health endpoint after releases. It returns `503` if PostgreSQL cannot be reached.
- Treat Railway and Vercel environment changes as production changes. Never copy the generated `DATABASE_URL` into GitHub, Vercel, or committed files; only the backend needs database access.

## Platform admin console

Courtly ships a platform admin console at `/admin`, separate from `STUDENT`, `COACH`, and `CLUB` accounts and their affiliations. Production access uses configured named operators; this remains an operations credential system, not an `ADMIN` product account type (there is no such account type).

- Configure `ADMIN_OPERATORS_JSON` with separately managed bcrypt cost-12 hashes and `ADMIN_SESSION_SECRET` with an independent 32-byte base64 key, then redeploy. Missing or malformed production configuration leaves `/admin` unavailable without taking down ordinary product routes. `ADMIN_PASSWORD` is a non-production compatibility path only.
- Visit `https://YOUR-FRONTEND-DOMAIN/admin`, enter an operator email and password, and the console shows the attributable operator identity alongside the platform overview and searchable workspace directory.
- The console can permanently delete an individual demo business or purge every demo workspace in any environment. Individual non-demo business deletion is available only outside production; production hard-disables it with no normal environment override. A permitted deletion cascades to all of the business's students, bookings, packages, payments, session chats, and club-scoped account conversations, and is irreversible.
- The **Chats** section lists every account conversation and session chat on the platform, searchable by account, club, class, coach, or student, and opens any conversation read-only for safety review. The console cannot post, manage assigned coaches, or answer proposals.
- Privacy, safeguarding, platform-chat, deletion, and purge routes require a named operator. Their append-only events snapshot that operator's stable ID, name, and email where applicable. Every privacy mutation also requires an `externalAuditReference` to the controlled case or work record; the confirmation header is not a second authentication factor.
- The admin session is a stateless HMAC-signed cookie keyed by `ADMIN_SESSION_SECRET` and bound to the operator's current credential hash. Rotating the session key invalidates every admin session; changing/removing one operator invalidates that operator's sessions. The page carries `noindex`.

## MVP boundaries

- Class bookings always reserve coach time. When Class unit scheduling is enabled for a club-owned facility, they also reserve one Courtly-managed unit from the same allocation ledger as rentals. A third-party or approval-required venue still stays pending until the club secures it outside Courtly.
- Venues can be looked up on Google Maps. Set `GOOGLE_MAPS_API_KEY` on the backend for live Places search; without it, pasting a Google Maps link still fills in the venue. The key stays server-side and never reaches the browser.
- Stripe-backed package and Class checkout is available in the student UI, but clubs and connected-account IDs are provisioned externally. Rentals remain simulated. Stripe-backed payment reversals are provider-confirmed; automated coach payouts/settlement reconciliation and business subscription billing are not connected.
- Booking lifecycle emails can be sent through Resend when configured. Successful live Stripe Package/Class payments queue payment-receipt email through the same transactional outbox; rental receipts, chat, staff and coach invitations, and reminder email are not yet connected. SMS, push notifications, and automated WhatsApp delivery are also absent. Session reminders continue to post in chat.
- Marketing is globally hard-disabled in backend code: every outbound item categorised `MARKETING` is suppressed, even if a stored account preference is true. There is no environment switch or campaign sender; enabling marketing requires a reviewed code, consent, unsubscribe, DNC, and operational change.
- When the production Family feature gate is explicitly enabled, Family manages child identity, privacy, consent, bounded public club Class booking, read-only child schedule and coach-feedback progress, export, deletion requests, and verified handover. Guardian bookings are unpaid and package-free, and the guardian arranges payment with the club. Guardian payment or package purchase, rentals, Calendar, staff/directory actions, chat membership, and child booking cancellation/reschedule self-service are not implemented; co-guardian invitations and automated deletion processing are also deferred. Handover additionally requires transactional email and the dedicated token keyring.
- Google Calendar is a one-way projection of confirmed Courtly Classes, not a two-way calendar editor. External edits never alter Courtly, and cached free/busy checks deliberately fail open when fresh data is unavailable.
- Route-based travel calculations are intentionally left for later integrations. Waitlists cover self-managed students only; a guardian cannot yet waitlist a child, and confirming a waitlist offer books the place unpaid like any other Class.
