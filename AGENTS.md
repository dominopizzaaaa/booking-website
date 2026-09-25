# AGENTS.md — Courtly

**Version 2.6.0** · Last updated 2026-09-25

Orientation for coding agents working on this repository. Read this before
exploring; it exists so you do not start cold. **Update it in the same commit
as any change it describes, and raise the version number** (patch for a
correction, minor for new behaviour, major for a reshaped model).

---

## 1. What Courtly is

A booking platform for racket-sport coaching. There are exactly three account
types; this is the complete role vocabulary:

| Who | Signs up as | Gets |
| --- | --- | --- |
| **Player / student** | `STUDENT` | One global account, books with any club |
| **Coach** | `COACH` | One portable account; clubs add them to a roster |
| **Club or academy** | `CLUB` | One institutional account that runs one club |

There is no owner or club-admin account type. A `CLUB` account *is the club*,
not a person, and never teaches. A founder who also coaches uses a separate
`COACH` account which the club adds to its roster.

`Membership` is only an affiliation link. It has no role: a club has one
membership to its own business; a coach has one per club that added them and
optionally one to their own `SOLO` practice; a student has none. Permissions
come from `User.accountType` plus `Business.kind`.

### The two money paths — the single most important rule

`Business.kind` decides how a lesson is paid for, and it is **snapshotted onto
every booking as `Booking.paymentRoute`** at creation time.

- `CLUB` → `paymentRoute: 'CLUB'`. The student pays the club; the club later
  records a payout to the coach (`Payment.kind: 'CLUB_TO_COACH'`). Money never
  goes student → coach for a club lesson.
- `SOLO` → `paymentRoute: 'DIRECT'`. A coach's own practice; the student pays
  the coach (`Payment.kind: 'STUDENT_TO_COACH'`).

Never re-derive the route from the business at read time. `Business.kind` is
immutable after creation, and the booking snapshot remains the contractual
record of the terms under which that lesson was booked.

### The club safeguard

If a coach and a student who met through a club later book privately outside
it, the club is told. See §5.

---

## 2. Repository layout

```
backend/           Express + Prisma API (TypeScript, ESM)
  prisma/
    schema.prisma  Single source of truth for the data model
    migrations/    Committed SQL; Railway runs `prisma migrate deploy`
    seed.ts        Demo workspace generator
  src/
    app.ts         Express wiring, middleware order, /api/health capabilities
    config.ts      Environment reading; every env var enters here
    auth.ts        Sessions, register/login, workspace switching, /auth/practice
    http.ts        Errors, manager/club guards, coachScope, initials()
    serializers.ts authState, bookingJson, membershipJson, isClubAccount
    scheduling.ts  Slot evaluation, conflict/travel rules, booking creation
    reschedule.ts  Two-sided reschedule requests
    integrity.ts   Club safeguard: detection + review routes
    notifications.ts  Typed workspace alerts (notifyWorkspace)
    account-notifications.ts  Student profile, alerts, and /api/account/*
    bookings.ts    Bookings, coach acceptance, payments, payouts, reversal
    crud.ts        Services, instructors, locations, students, packages, …
    staff.ts       Club-created coach affiliations
    venues.ts      Google Maps venue lookup
    workspace.ts   The single GET /api/workspace payload
    public.ts      Public booking page + student self-service
    admin.ts       Platform console (ADMIN_PASSWORD gated; not an account type)
  tests/           Vitest; integration tests need a local PostgreSQL

frontend/          Next.js App Router (TypeScript, Tailwind)
  src/app/         Routes: / (workspace), /manage (student), /book/[slug],
                   /login, /signup, /account, /admin, /manage/[token]
  src/lib/
    types.ts       Shared API contract types — change with the backend
    api.ts         Every API call lives here, typed
    alerts.ts      Alert icon/tone vocabulary shared by both apps
    utils.ts       cn, money, dates, initials()
  src/components/
    student-app.tsx         The student app (/manage) — five-tab shell
    workspace/              The provider workspace (/)
    public-booking.tsx      Public booking page for /book/[slug]
    legacy-booking.tsx      Pre-account management links (/manage/[token])
    auth-form.tsx           Login and sign-up
  tests/           Vitest; the pure helpers under the UI, no DOM or server
  e2e/             Playwright; runs in CI against production bundles

scripts/           Local PostgreSQL helper, investor-showcase builder
```

---

## 3. Where to look for a given task

| Task | Start here |
| --- | --- |
| Change the data model | `backend/prisma/schema.prisma`, then a migration |
| Add an API route | The matching `backend/src/*.ts` router, then `app.ts` |
| Change what the workspace shows | `backend/src/workspace.ts` **and** `frontend/src/lib/types.ts` |
| Change student booking UI | `frontend/src/components/student-app.tsx` |
| Change student club discovery | `backend/src/public.ts`, then `frontend/src/components/student-app.tsx` |
| Change provider UI | `frontend/src/components/workspace/` |
| Change slot / conflict rules | `backend/src/scheduling.ts` |
| Change alert icons or ordering | `frontend/src/lib/alerts.ts` |
| Add an env var | `backend/src/config.ts` + `backend/.env.example` + README |

---

## 4. Data model notes that are easy to get wrong

- **Money is integer minor units (cents) everywhere.** Never a float.
- **`Business` ≠ account.** A `CLUB` account has one business; a `COACH`
  account can be affiliated with several. `Membership` stores that link, not
  a role. `Student` is a *business-specific* record linked to a global `User`.
- **A linked student's identity belongs to `User`.** When `Student.userId` is
  set, managers may edit only business-local fields such as `Student.notes`;
  `name`, `email`, `phone`, and `parentName` come from the student's account.
  Connecting a student accepts an account email plus local notes and copies
  the canonical profile. Unlinked historical rows retain local profile edits.
  The database only permits a linked `User` whose account type is `STUDENT`.
- **Permission derivation has one definition.** `managesBusiness()` and
  `coachScoped()` in `http.ts` distinguish a club, a coach running their own
  `SOLO` practice, and a coach working inside a club. Do not recreate these
  checks from membership counts or instructor presence.
- **An instructor row is not bookable on its own.** `bookableInstructorWhere()`
  in `scheduling.ts` is the shared predicate: active roster row + active
  membership + registered provider account. Use it, do not re-implement it.
- **Tenant ownership is immutable for the core scheduling graph.** A `Service`,
  `Location`, `Instructor`, `Booking`, or `Student` never changes
  `businessId` after creation. Direct tenant relations use non-cascading
  composite `(id, businessId)` foreign keys; join rows use deferred keyed
  constraints. Never move a record between businesses: create or explicitly
  relink the correct tenant-owned record instead.
- **`Participant` is the student's place in a booking**, and is what student
  self-service acts on — not the booking.
- A **`CLUB` account is single-club and has no instructor**. `staff.ts` only
  adds registered `COACH` accounts; coaches may appear on several rosters.
  `isClubAccount()` in `serializers.ts` is the shared identity check.
- Removing a coach from a club is a soft deactivation, not a deleted
  affiliation. Keep the membership and instructor IDs so historical lessons
  still identify the coach for the club safeguard; re-adding the same account
  restores those retained records.
- A coach working in a club may create a teaching venue, including through the
  Google Maps finder, and sees the club's active venues so a new one remains
  visible after saving. Editing, archiving, and service assignment remain with
  the club; the coach still receives no service prices or financial records.
- Student Explore is a directory of every currently bookable non-demo `CLUB`,
  not only businesses found in that student's booking history. Bounded
  directory pages use the immutable public slug as their cursor. A result must
  have an active service connected through an active venue to a bookable coach;
  sport labels come from those services' `category` values. Keep the directory
  response public-safe and use booking history only to distinguish "Your clubs"
  from clubs the student has not booked with yet.

### Booking lifecycle

```
created ──► coachAcceptance PENDING?   (club assigned it to a coach)
              │ yes → status PENDING until the coach accepts
              │ no  → venue needs approval? PENDING : CONFIRMED
              ▼
          CONFIRMED ──► COMPLETED
              │
              └──► CANCELLED (credits refunded)
```

A student never accepts an assignment; the coach does (`POST
/api/bookings/:id/accept` | `/decline`). Declining cancels and asks the club to
reassign. The generic booking patch cannot bypass that decision: `PENDING` may
only become `CONFIRMED` after coach acceptance, and `COMPLETED` may only follow
`CONFIRMED` after the lesson ends. `CANCELLED` and `COMPLETED` are terminal,
although internal notes may still be corrected.
Cancellation and coach accept/decline also close once `endAt` is reached.
Attendance may be marked only after `endAt`, only on `CONFIRMED` or `COMPLETED`
lessons, and only after any required coach acceptance.

### Rescheduling is a negotiation, not an edit

Either side proposes; the other accepts. Nothing moves until then.

- Student proposes: `POST /api/account/bookings/:participantId/reschedule-requests`
- Student answers: `POST /api/account/reschedule-requests/:id/accept|decline`
- Provider proposes: `POST /api/bookings/:id/reschedule-requests`
- Provider answers: `POST /api/reschedule-requests/:id/accept|decline|withdraw`

One live request per booking. The window is
`max(instructor.rescheduleNoticeHours, business.cancellationHours)` — the
coach's own protection, floored by the club's policy. `rescheduleNoticeHours()`
in `reschedule.ts` is the one definition, including legacy `/manage/:token`
rescheduling. A booking still waiting for coach acceptance cannot be
rescheduled. Accept, decline, and withdraw are serialized terminal decisions,
so exactly one concurrent response wins; scheduling state is reloaded after
the instructor lock is acquired.

Requester provenance is enforced at the database boundary when a request is
inserted or retargeted: a student must own its active participant, and a coach
or club must have matching live authority. Historical requests remain valid
after a later participant cancellation or affiliation deactivation.

`POST /api/bookings/:id/reschedule` (one-sided) still exists but **refuses any
booking with a registered student or pending coach acceptance**. Do not reach
for it.

### Payments are reversible, never deleted

`DELETE /api/payments/:id` sets `reversedAt` and recomputes `participant.paid` /
`package.paid`. Every balance query must filter `reversedAt: null`. Coach
payouts are `POST /api/payouts` (`kind: 'CLUB_TO_COACH'`, club businesses only)
and are excluded from "collected from students" totals. Student-originated
payments have a `studentId` and no `instructorId`; coach payouts have an
`instructorId` and no `studentId`. The database enforces this exclusive shape
and requires the named student, coach, and optional booking to belong to the
payment's business. Packages are likewise pinned to a student in their own
business, and payments can only name packages from that same business. A
booking-linked student receipt follows the booking's snapshotted
`paymentRoute`; an unbound receipt follows immutable `Business.kind`, and a
coach payout is valid only for a `CLUB`. A booking with payment history cannot
be deleted independently because that would erase the contractual route; the
explicit business teardown deletes payments before bookings.
The student on a booking receipt must be a participant in that booking; the
relationship remains valid when that participant later cancels. A package
receipt and a participant's package must name the package owner. A
payment may target a booking or a package, never both, and a coach payout cannot
target a package. Reversal is serialized per financial party: only one
concurrent request reverses the row, recomputes balances, and emits alerts.

---

## 5. The club safeguard (`integrity.ts`)

Fires when a booking is created with `paymentRoute: 'DIRECT'` and the same
coach *account* and student *account* already share a non-cancelled booking
with `paymentRoute: 'CLUB'` at a different business.

It **reports, and does not block**. One `IntegrityFlag` per
club + coach + student pair; repeats raise `occurrences`. A `DISMISSED` flag
stays dismissed. Only the `CLUB` account can read or resolve flags — never a
coach working in that club.

---

## 6. Alerts

Two stores, one vocabulary (`backend/src/notifications.ts`):

- `Notification` — provider workspace. Always write through `notifyWorkspace()`.
- `AccountNotification` — student. Always write through
  `createBookingAccountAlerts()`, which owns all the copy.

`frontend/src/lib/alerts.ts` maps a type to an icon and tone, falling back to
wording and then to a neutral bell, so old untyped rows still render. Both apps
sort unread-first, cap the list at `alertPageSize`, shade unread rows, and open
a detail dialog that links through to the subject.

---

## 7. Conventions that reviewers enforce

- **Comments explain *why*, not *what*.** Match the density already present.
- Errors are user-facing sentences, thrown as `HttpError(status, message)`.
- Zod `.strict()` on every request body; unknown fields are a 400.
- Provider routes are mounted behind `requireAuth` + `requireWorkspace`;
  use `requireBusinessManager` for a club or own-practice manager,
  `requireClubAccount` for club-only actions, and `coachScope()` to keep a
  coach working in a club in their lane.
- Concurrency: `lockInstructors()` (advisory lock) before any read-then-write
  on a schedule, then reload state after waiting. Reschedule decisions also
  lock the request. Financial writes and reversals take the party advisory lock
  and reload state after waiting.
- Tenancy: every query filters by `businessId`. There is no global read. Core
  tenant parents are immutable and relations use the database constraints
  described in §4.
- Frontend API calls go in `src/lib/api.ts`, typed against `src/lib/types.ts`.
- New UI must meet WCAG AA contrast, expose keyboard-complete semantics and
  predictable focus behavior, and work at 390px wide. The Playwright suite runs
  three viewports. A control that carries a number must say what the number
  counts; a bare badge reads as "Alerts 5" to a screen reader.
- **Put a test where it belongs.** A rule about scheduling, money, tenancy or
  an API contract belongs in `backend/tests`. A pure helper — formatting, the
  alert vocabulary, the API client's own behaviour — belongs in
  `frontend/tests`, which needs neither a DOM nor a server and runs in a
  second. Anything a person does with a rendered page belongs in
  `frontend/e2e`, where it runs at all three viewports. Do not reach for a
  browser to test a function, and do not assert layout or focus from Vitest.
- The two alert stores share one vocabulary. A new alert type added in
  `notifications.ts` or `account-notifications.ts` needs a matching entry in
  `frontend/src/lib/alerts.ts`; `frontend/tests/alerts.test.ts` reads both
  backend files and fails when one is added without the other.

---

## 8. Running things

```bash
npm ci && npm ci --prefix backend && npm ci --prefix frontend
cp backend/.env.example backend/.env
npm run db:local                      # PostgreSQL on 127.0.0.1:55432
npm run db:migrate --prefix backend
npm run dev                           # API :4000, web :3000
```

Checks, in the order CI runs them:

```bash
npm test                              # backend Vitest (needs local PostgreSQL)
npm run build --prefix backend
npm run typecheck --prefix frontend
npm test --prefix frontend            # frontend Vitest (no server, no DOM)
npm run build --prefix frontend
(cd frontend && npx playwright test)  # needs both servers running
```

Backend Vitest must remain file-serial: `npm test` invokes
`--no-file-parallelism` because integration and configuration tests share
mutable process and database state. Do not run its files concurrently. Run the
Playwright projects in one command from `frontend/`; they share test artifacts.

**Three traps when running e2e locally:**

1. Next.js bakes `BACKEND_URL` into the build at `next build` time. Run the API
   on **port 4000** (the default), or rebuild the frontend with the port you
   want.
2. Registration and failed-login attempts each have their own 30-request,
   15-minute limit. Successful logins do not consume the failed-login budget.
   Start the suite's backend with `E2E_DISABLE_RATE_LIMITS=true`; this explicit
   opt-in is ignored in production and must never be configured on a deployment.
3. The browser suite creates a demo workspace per test, in whatever database
   the API is pointed at. Point it at the same local database the backend
   Vitest suite uses and those workspaces accumulate there, until
   `POST /api/admin/purge-demos` — one bounded transaction over every demo on
   the platform — no longer finishes inside its test's five-second budget, and
   `tests/admin.integration.test.ts` times out on work the suite itself left
   behind. Purge the demos, or give the browser suite its own database, before
   reading a backend failure as a regression.

### Migrations that audit before they enforce

`20260917210000_account_shape_invariants` and the migrations through
`20260917250000_core_tenancy_invariants` audit existing rows inside their
transactions before installing checks, foreign keys, or triggers, and abort
the whole transaction otherwise. This includes
`20260917240000_financial_target_invariants` and the final core-tenancy audit.
That is deliberate: enforcement added around invalid data would either fail
later or quietly permit the exception forever.

The consequence is that a deploy fails fast (`P3009`) rather than half-applying.
`20260917205000_single_club_account_per_club` exists to make the audit pass on
real data, because the old model allowed an `OWNER` *and* one or more `ADMIN`s
per club, and both become `CLUB` accounts. It keeps the earliest institutional
login, hands any displaced administrator their login back as a coach account,
and gives a club that has lost its login a dormant, sign-in-disabled one rather
than deleting the business.

If an environment already failed on an audit migration, the failed attempt
rolled itself back and is safe to clear before redeploying. Resolve the exact
migration name reported as failed, then deploy again. For example:

```bash
npx prisma migrate resolve --rolled-back 20260917210000_account_shape_invariants
npx prisma migrate resolve --rolled-back 20260917240000_financial_target_invariants
npx prisma migrate resolve --rolled-back 20260917250000_core_tenancy_invariants
npx prisma migrate deploy
```

Run only the `migrate resolve` line for the migration that actually failed;
the three commands above are examples, not a sequence to apply blindly.

Before changing account, affiliation, financial, or tenant shapes, check the
invariants still hold: apply the chain to a scratch database *and* to a copy
with real data, since only the second exercises repair and historical audits.

---

## 9. Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | backend | PostgreSQL connection (Railway provides it) |
| `APP_ORIGIN` | backend | Comma-separated allowed browser origins |
| `DEMO_ENABLED` | backend | `false` in production to stop demo workspaces |
| `E2E_DISABLE_RATE_LIMITS` | backend | Explicit non-production-only bypass for the full browser suite; never deploy |
| `ADMIN_PASSWORD` | backend | Unlocks `/admin`; unset disables it entirely |
| `GOOGLE_MAPS_API_KEY` | backend | **Optional.** Enables Places venue search |
| `BACKEND_URL` | frontend | Server-side rewrite target; build-time |
| `ELEVER_RESET_CONFIRMATION` | one-off CLI | Exact destructive-operation phrase required by `demo:elever` |
| `ELEVER_EXPECTED_DATABASE_SHA256` | one-off CLI | SHA-256 fingerprint of the exact `DATABASE_URL` targeted by `demo:elever` |
| `ELEVER_CLUB_PASSWORD`, `ELEVER_LOH_PASSWORD`, `ELEVER_ENG_PASSWORD`, `ELEVER_DOMINIC_PASSWORD`, `ELEVER_STUDENT_PASSWORD` | one-off CLI | Distinct 12–72-byte passwords used only while provisioning/verifying the Elever fixture |

Without `GOOGLE_MAPS_API_KEY`, venue lookup still works: a pasted Google Maps
link is parsed server-side by `parseMapsLink()`. Opaque `maps.app.goo.gl` share
links are expanded through bounded, manually validated Google-only redirects.
Never put the key in the browser. `/api/health` reports
`capabilities.venueSearch` as `google-places` or `maps-link`, which is the
quickest way to tell which mode a deployment is in.

---

## 10. Known rough edges

- `StudentBookings` in `public-booking.tsx` is a **superseded** student
  booking list that nothing renders (`/manage` uses `student-app.tsx`). It is
  kept compiling but should not gain features. Delete it when convenient.
- `legacy-booking.tsx` and `/manage/[token]` serve management links issued
  before account-only booking. No new tokens are minted.
- Lesson payments, confirmations, and reminders are recorded in-app only. No
  gateway, email, or SMS is connected.
- Courtly reserves *coach time*, never an external court. A venue needing
  approval leaves the booking `PENDING` for a human to secure.

---

## Changelog

### 2.6.0 — 2026-09-25

Expanded the student Explore tab from booking-history-only cards into the
bookable club directory. Students can browse known and new clubs in separate
categories, search by name, and filter by sport, exact club, or relationship;
directory summaries expose only public booking metadata, exclude private demo
workspaces, load through bounded cursor pages, and are derived from active
services with a registered, active coach and venue.

### 2.5.0 — 2026-09-21

Added the guarded `demo:elever` production fixture command. It requires an
explicit destructive-reset confirmation plus an exact database-URL fingerprint,
preserves `_prisma_migrations`, validates the applied migration names and
checksums against the checkout, and
atomically replaces application data with the Elever Badminton Academy
investor dataset: two affiliated coaches with their own SOLO practices, eight
student accounts, lifecycle-consistent past and future sessions, and both club
and direct payment routes. The README documents the backup-first run sequence
and every required one-off environment variable.

### 2.4.1 — 2026-09-21

Fixed the investor-showcase builder so it respects immutable business kinds
after registration, with a regression test covering the provisioning payload.

### 2.4.0 — 2026-09-20

Added a third test suite and closed two reporting defects it found. Frontend
Vitest (`frontend/tests`) now covers the pure helpers under the UI — money and
date formatting, avatar initials, the shared alert vocabulary, and the API
client's error mapping and workspace normalisation — including a check that
reads both backend alert sources so a new alert type cannot ship without a
frontend mapping. Backend coverage gained the public slot grid and its date
boundaries, the HTTP request envelope, the management catalog's input
boundaries, instalment and reversal arithmetic across bookings and packages,
the platform business directory, and one narrative that follows a single lesson
from the club, coach and student seats at once. Playwright gained workspace
alert triage and a responsive sweep of every route. An oversized request body
now answers 413 with a sentence instead of a 500 that alerted on the caller's
mistake, and the desktop sidebar's unread badge announces what its number
counts.

### 2.3.0 — 2026-09-19

Hardened Courtly's release boundary with audit-first financial and core-tenancy
migrations: booking, package, participant, payment, scheduling, and reschedule
links are now tenant- and party-pinned, core tenant ownership is immutable, and
concurrent payment reversals and reschedule decisions have one winner. Tightened
elapsed-lesson, attendance, coach-acceptance, and legacy rescheduling rules.
Added broad backend and three-viewport Playwright coverage, WCAG/keyboard/mobile
UI remediation, a production-disabled E2E rate-limit bypass, and deterministic
serial backend test execution. Demo purges now run as one bounded atomic
transaction instead of committing each workspace independently.

### 2.2.0 — 2026-09-18

Added `20260917205000_single_club_account_per_club` so the account-shape
invariants can be installed over real data. A club created under the old model
could have an `OWNER` and one or more `ADMIN`s, all of which became `CLUB`
accounts; the audit in the next migration then refused to run and a deploy
stopped at `P3009`. The repair keeps one institutional login per club, returns
a displaced administrator's login to them as a coach account, and gives a club
with no login a dormant one instead of deleting it. Documented the recovery
path for an environment that already failed.


### 2.1.11 — 2026-09-18

Marked which roster profiles may accept a new coach account so the club UI
cannot offer a departed coach's history-bearing identity for reassignment.

### 2.1.10 — 2026-09-18

Pinned any booking-linked club-to-coach payout to a booking whose contractual
payment route is `CLUB`.

### 2.1.9 — 2026-09-18

Bound package ownership and package payments to one tenant, and retained the
booking contract behind every booking-linked payment by restricting deletion.

### 2.1.8 — 2026-09-18

Made the final account migration preserve legacy admin people as coach-scoped
affiliations while selecting only the owner as the club identity, and pinned
payment kinds to their booking contract or immutable business money path.

### 2.1.7 — 2026-09-17

Separated registration throttling from failed-login protection so legitimate
successful sign-ins do not consume the brute-force budget.

### 2.1.6 — 2026-09-17

Exposed the add-only venue workflow to club coaches while retaining club-only
venue management, service assignment, and financial controls.

### 2.1.5 — 2026-09-17

Added keyless support for shortened Google Maps share links, with bounded
server-side expansion and strict redirect validation.

### 2.1.4 — 2026-09-17

Pinned linked students to `STUDENT` accounts and payment parties to their own
business at the database boundary, including data-preserving migration audits.

### 2.1.3 — 2026-09-17

Made avatar initials ignore parenthesized role qualifiers, including unfinished
ones, consistently in the API and browser.

### 2.1.2 — 2026-09-17

Clarified the enforced booking lifecycle: coach acceptance cannot be bypassed,
completion waits until the lesson has ended, and terminal bookings may receive
notes but cannot change status.

### 2.1.1 — 2026-09-17

Made the payment party match the money path: student receipts belong only to a
student, while club-to-coach payouts belong only to the coach.

### 2.1.0 — 2026-09-17

Made booking status changes follow the documented lifecycle: coach acceptance
cannot be bypassed, completion waits until the lesson has ended, and cancelled
or completed bookings cannot be reopened.

### 2.0.1 — 2026-09-17

Made the global student account canonical for linked identity and contact
details; business managers now edit only their own notes on linked students.

### 2.0.0 — 2026-09-17

Replaced the overlapping account and membership-role systems with exactly
three account types: `STUDENT`, `COACH`, and `CLUB`. Membership is now an
affiliation only; a club account never teaches, coaches remain portable across
clubs and may run one solo practice, and the data/API vocabulary is `Student`
and `studentId` throughout.

### 1.0.0 — 2026-09-17

First version, written alongside the club/coach platform release:
two-sided reschedule requests, coach acceptance of club assignments,
club-versus-direct payment routing with coach payouts, reversible payments,
the club safeguard, Google Maps venue lookup, typed alerts, the club-account
profile, and the punctuation fix in `initials()`.
