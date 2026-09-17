# AGENTS.md — Courtly

**Version 1.0.0** · Last updated 2026-09-17

Orientation for coding agents working on this repository. Read this before
exploring; it exists so you do not start cold. **Update it in the same commit
as any change it describes, and raise the version number** (patch for a
correction, minor for new behaviour, major for a reshaped model).

---

## 1. What Courtly is

A booking platform for racket-sport coaching. Three kinds of people use it:

| Who | Signs up as | Gets |
| --- | --- | --- |
| **Player / student** | `CUSTOMER` | One global account, books with any club |
| **Coach** | `COACH` | One portable account; clubs add them to a roster |
| **Club or academy owner** | `OWNER` | Creates a workspace at sign-up |

A **club admin** never signs up. The club creates that login from its own
workspace (Team → Staff access), and it belongs to that club alone.

### The two money paths — the single most important rule

`Business.kind` decides how a lesson is paid for, and it is **snapshotted onto
every booking as `Booking.paymentRoute`** at creation time.

- `CLUB` → `paymentRoute: 'CLUB'`. The student pays the club; the club later
  records a payout to the coach (`Payment.kind: 'CLUB_TO_COACH'`). Money never
  goes student → coach for a club lesson.
- `SOLO` → `paymentRoute: 'DIRECT'`. A coach's own practice; the student pays
  the coach (`Payment.kind: 'CUSTOMER_TO_COACH'`).

Never re-derive the route from the business at read time — a business can
change kind, and old bookings must keep the terms they were booked under.

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
    http.ts        HttpError, asyncRoute, adminOnly, coachScope, initials()
    serializers.ts authState, bookingJson, membershipJson, isClubAccount
    scheduling.ts  Slot evaluation, conflict/travel rules, booking creation
    reschedule.ts  Two-sided reschedule requests
    integrity.ts   Club safeguard: detection + review routes
    notifications.ts  Typed workspace alerts (notifyWorkspace)
    account-notifications.ts  Customer alert copy + /api/account/*
    bookings.ts    Bookings, coach acceptance, payments, payouts, reversal
    crud.ts        Services, instructors, locations, customers, packages, …
    staff.ts       Club staff memberships (owner-only)
    venues.ts      Google Maps venue lookup
    workspace.ts   The single GET /api/workspace payload
    public.ts      Public booking page + customer self-service
    admin.ts       Platform-owner console (ADMIN_PASSWORD gated)
  tests/           Vitest; integration tests need a local PostgreSQL

frontend/          Next.js App Router (TypeScript, Tailwind)
  src/app/         Routes: / (workspace), /manage (customer), /book/[slug],
                   /login, /signup, /account, /admin, /manage/[token]
  src/lib/
    types.ts       Shared API contract types — change with the backend
    api.ts         Every API call lives here, typed
    alerts.ts      Alert icon/tone vocabulary shared by both apps
    utils.ts       cn, money, dates, initials()
  src/components/
    customer-app.tsx        The customer app (/manage) — five-tab shell
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
| Change customer booking UI | `frontend/src/components/customer-app.tsx` |
| Change provider UI | `frontend/src/components/workspace/` |
| Change slot / conflict rules | `backend/src/scheduling.ts` |
| Change alert icons or ordering | `frontend/src/lib/alerts.ts` |
| Add an env var | `backend/src/config.ts` + `backend/.env.example` + README |

---

## 4. Data model notes that are easy to get wrong

- **Money is integer minor units (cents) everywhere.** Never a float.
- **`Business` ≠ account.** A person's `User` joins businesses through
  `Membership`, which carries the workspace `role` (`OWNER` / `ADMIN` /
  `COACH`). `Customer` is a *club-specific* record linked to a global `User`.
- **An instructor row is not bookable on its own.** `bookableInstructorWhere()`
  in `scheduling.ts` is the shared predicate: active roster row + active
  membership + registered provider account. Use it, do not re-implement it.
- **`Participant` is the customer's place in a booking**, and is what customer
  self-service acts on — not the booking.
- A **club-admin account is single-club**, enforced in `staff.ts` in both
  directions (cannot be added elsewhere, cannot be promoted if already
  elsewhere). `isClubAccount()` in `serializers.ts` is the one definition;
  the workspace payload exposes it as `clubAccount`.

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
reassign.

### Rescheduling is a negotiation, not an edit

Either side proposes; the other accepts. Nothing moves until then.

- Customer proposes: `POST /api/account/bookings/:participantId/reschedule-requests`
- Customer answers: `POST /api/account/reschedule-requests/:id/accept|decline`
- Provider proposes: `POST /api/bookings/:id/reschedule-requests`
- Provider answers: `POST /api/reschedule-requests/:id/accept|decline|withdraw`

One live request per booking. The window is
`max(instructor.rescheduleNoticeHours, business.cancellationHours)` — the
coach's own protection, floored by the club's policy. `rescheduleNoticeHours()`
in `reschedule.ts` is the one definition.

`POST /api/bookings/:id/reschedule` (one-sided) still exists but **refuses any
booking with a registered customer**. Do not reach for it.

### Payments are reversible, never deleted

`DELETE /api/payments/:id` sets `reversedAt` and recomputes `participant.paid` /
`package.paid`. Every balance query must filter `reversedAt: null`. Coach
payouts are `POST /api/payouts` (`kind: 'CLUB_TO_COACH'`, club businesses only)
and are excluded from "collected from students" totals.

---

## 5. The club safeguard (`integrity.ts`)

Fires when a booking is created with `paymentRoute: 'DIRECT'` and the same
coach *account* and student *account* already share a non-cancelled booking
with `paymentRoute: 'CLUB'` at a different business.

It **reports, and does not block**. One `IntegrityFlag` per
club + coach + student pair; repeats raise `occurrences`. A `DISMISSED` flag
stays dismissed. Only owners/admins can read or resolve flags — never coaches.

---

## 6. Alerts

Two stores, one vocabulary (`backend/src/notifications.ts`):

- `Notification` — provider workspace. Always write through `notifyWorkspace()`.
- `AccountNotification` — customer. Always write through
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
  `adminOnly` for owner/admin, `coachScope()` to keep a coach in their lane.
- Concurrency: `lockInstructors()` (advisory lock) before any read-then-write
  on a schedule. Financial writes take a per-customer advisory lock.
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
2. `/api/auth/*` is rate-limited to 30 requests per 15 minutes. Repeated local
   suite runs will start failing sign-up tests; restart the API to reset it.

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
link is parsed server-side by `parseMapsLink()`. Never put the key in the
browser. `/api/health` reports `capabilities.venueSearch` as `google-places` or
`maps-link`, which is the quickest way to tell which mode a deployment is in.

---

## 10. Known rough edges

- `CustomerBookings` in `public-booking.tsx` is a **superseded** customer
  booking list that nothing renders (`/manage` uses `customer-app.tsx`). It is
  kept compiling but should not gain features. Delete it when convenient.
- `legacy-booking.tsx` and `/manage/[token]` serve management links issued
  before account-only booking. No new tokens are minted.
- Lesson payments, confirmations, and reminders are recorded in-app only. No
  gateway, email, or SMS is connected.
- Courtly reserves *coach time*, never an external court. A venue needing
  approval leaves the booking `PENDING` for a human to secure.

---

## Changelog

### 1.0.0 — 2026-09-17

First version, written alongside the club/coach platform release:
two-sided reschedule requests, coach acceptance of club assignments,
club-versus-direct payment routing with coach payouts, reversible payments,
the club safeguard, Google Maps venue lookup, typed alerts, the club-account
profile, and the punctuation fix in `initials()`.
