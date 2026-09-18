# AGENTS.md — Courtly

**Version 2.2.0** · Last updated 2026-09-18

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
    account-notifications.ts  Student alert copy + /api/account/*
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

### Rescheduling is a negotiation, not an edit

Either side proposes; the other accepts. Nothing moves until then.

- Student proposes: `POST /api/account/bookings/:participantId/reschedule-requests`
- Student answers: `POST /api/account/reschedule-requests/:id/accept|decline`
- Provider proposes: `POST /api/bookings/:id/reschedule-requests`
- Provider answers: `POST /api/reschedule-requests/:id/accept|decline|withdraw`

One live request per booking. The window is
`max(instructor.rescheduleNoticeHours, business.cancellationHours)` — the
coach's own protection, floored by the club's policy. `rescheduleNoticeHours()`
in `reschedule.ts` is the one definition.

`POST /api/bookings/:id/reschedule` (one-sided) still exists but **refuses any
booking with a registered student**. Do not reach for it.

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
  on a schedule. Financial writes take a per-student advisory lock.
- Tenancy: every query filters by `businessId`. There is no global read.
- Frontend API calls go in `src/lib/api.ts`, typed against `src/lib/types.ts`.
- New UI must work at 390px wide; the Playwright suite runs three viewports.

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
npm run build --prefix frontend
npx playwright test --prefix frontend # needs both servers running
```

**Two traps when running e2e locally:**

1. Next.js bakes `BACKEND_URL` into the build at `next build` time. Run the API
   on **port 4000** (the default), or rebuild the frontend with the port you
   want.
2. Registration and failed-login attempts each have their own 30-request,
   15-minute limit. Successful logins do not consume the failed-login budget.
   Repeated local suite runs can still exhaust registration; restart the API
   to reset its in-memory limiter.

### Migrations that audit before they enforce

`20260917210000_account_shape_invariants` and the two after it install their
triggers only over a database that already satisfies them, and abort the whole
transaction otherwise. That is deliberate: enforcement added around invalid
data would either fail later or quietly permit the exception forever.

The consequence is that a deploy fails fast (`P3009`) rather than half-applying.
`20260917205000_single_club_account_per_club` exists to make the audit pass on
real data, because the old model allowed an `OWNER` *and* one or more `ADMIN`s
per club, and both become `CLUB` accounts. It keeps the earliest institutional
login, hands any displaced administrator their login back as a coach account,
and gives a club that has lost its login a dormant, sign-in-disabled one rather
than deleting the business.

If an environment already failed on the invariants migration, the failed
attempt rolled itself back and is safe to clear before redeploying:

```bash
npx prisma migrate resolve --rolled-back 20260917210000_account_shape_invariants
npx prisma migrate deploy
```

Before changing account or affiliation shapes, check the invariants still hold:
apply the chain to a scratch database *and* to a copy with real data, since only
the second exercises the repair.

---

## 9. Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | backend | PostgreSQL connection (Railway provides it) |
| `APP_ORIGIN` | backend | Comma-separated allowed browser origins |
| `DEMO_ENABLED` | backend | `false` in production to stop demo workspaces |
| `ADMIN_PASSWORD` | backend | Unlocks `/admin`; unset disables it entirely |
| `GOOGLE_MAPS_API_KEY` | backend | **Optional.** Enables Places venue search |
| `BACKEND_URL` | frontend | Server-side rewrite target; build-time |

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
