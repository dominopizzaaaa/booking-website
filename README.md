# Courtly

Courtly is a full-stack booking platform for coaching businesses. This repository is a small monorepo: the Express and Prisma API lives in `backend/`, the Next.js application lives in `frontend/`, and PostgreSQL stores application data.

[![CI](https://github.com/dominopizzaaaa/booking-website/actions/workflows/ci.yml/badge.svg)](https://github.com/dominopizzaaaa/booking-website/actions/workflows/ci.yml)

Courtly includes global student and coach accounts with public usernames and sport profiles, dedicated club accounts, portable coach affiliations, multi-location and coach-aware availability, travel and preparation buffers, private and capacity-limited Classes, atomic recurring bookings, pending venue approval, account-backed student booking and self-service, session chat with next-session proposals, personal Google Calendar sync, package offers, owned-venue court rentals, simulated Stripe checkout, manual payment records, attendance, student/parent details, coach rosters, and responsive business workspaces. Defaults are SGD and Asia/Singapore.

It also covers how a club and its coaches actually work together: a club assigns a student to a coach and the coach accepts before the class is confirmed; either side proposes a new time and the other agrees before a session moves; classes, package purchases, and venue rentals are paid to the club, which then records what it pays each coach; and a club is told when historical records show that a coach and a student it introduced trained privately outside it.

Agents working on this repository should read [AGENTS.md](AGENTS.md) first.

## Accounts, clubs, and bookings

Courtly has exactly three account types: `STUDENT`, `COACH`, and `CLUB`. Students and coaches are people with portable global identities. A club account represents the organisation itself, belongs to its one club workspace, and is never a teaching profile.

- **Students** create or sign in to a student account from a club's booking page. Signing in is required before a booking can be submitted. The resulting club-specific student record is linked to the global account, so the student can return to view receipts and booking history, buy package offers, reserve club-owned courts, then cancel or propose a reschedule for eligible sessions. New guest bookings and private management links are not supported; already-issued legacy links remain available only for their existing bookings.
- **Coaches** register their own coach account. A club finds the account by public username, name, or email and adds it to its roster with the coach's reschedule-notice window. Coaches carry the same identity across clubs and switch between those affiliations. Creating new independent practices is no longer supported.
- **Clubs** choose the club account type at sign-up, which creates their one club workspace. The business name becomes the club account's identity, while the person's name supplied at sign-up is kept as the club contact. The club account manages Classes, locations, coach affiliations, schedules, bookings, students, package offers, rentals, payments, and settings. It has no coach profile and cannot teach a class; even a founder who coaches uses a separate `COACH` account and joins the roster like every other coach.

Each account has one globally unique lowercase username (`a-z`, `0-9`, and `_`, 3–30 characters) and up to 20 chosen sports. Email and password remain the sign-in credentials; the username is the public/search handle used to find accounts.

Memberships are affiliations only: they connect an account to a business and, for a club coach, to that coach's roster profile. They do not contain workspace roles. Authority comes from the account type and active club affiliation: the `CLUB` account manages its club, while a coach inside a club is scoped to their own work. Each account-backed student record separately holds that student's club-specific booking, package, attendance, and payment context. Historical `SOLO` businesses and `DIRECT` payment routes remain immutable records, marked `legacyReadOnly` and excluded from login and workspace selection; no new direct commerce is created.

## Classes, packages, rentals, and payments

All new commercial activity belongs to a `CLUB` workspace. Every class booking snapshots `paymentRoute: 'CLUB'`, so the student pays the club and the club can later record a `CLUB_TO_COACH` payout. Legacy `SOLO`, `DIRECT`, and `STUDENT_TO_COACH` values are retained only so existing contractual history stays readable.

- Clubs publish **Package offers** scoped to any non-empty combination of Classes and rentable locations. A purchase creates an immutable `LessonPackage` snapshot shown to the student under **My Packages**, including copied scope, credit count, price, and expiry.
- A club can make an owned facility rentable by configuring its sport, courts or other units, opening hours, hourly price, duration rules, notice and cancellation windows, rules, and amenities. Every account can browse and reserve a specific unit and time from the in-app **Explore** destination: students choose **Explore → Venue rentals** in the five-tab player app, while coaches and clubs open **Explore** in their workspace.
- Online checkout is deliberately simulated Stripe: the server derives price, currency, payer, and the club route; a successful `PaymentIntent` records the corresponding package, class, or rental payment atomically, while a simulated failure records only the failed intent. Package-funded reservations consume one credit and create no cash payment.

A recorded payment can be reversed. The record stays in the ledger marked as reversed, and the class or package returns to unpaid, so a correction is visible rather than silent. An eligible rental cancellation restores its package credit exactly once, or marks a paid reservation refunded and reverses the linked student payment.

Because a club invests in introducing its coaches to its students, Courtly flags it to the club when a coach and a student who train together through that club also book privately outside it. Courtly reports; it does not block the booking, and it does not tell the coach or the student. The club records what it found and closes the flag.

## Session chat

Every booked Class has its own chat, whether it is a 1-1 lesson or a group. Its members come from the booking itself: the coach, every student who holds a place, and the club account, because every Class belongs to a club. In both apps Chat takes the tab-bar slot Alerts used to hold; Alerts moved to the bell at the top right, the way a notifications heart sits above a feed.

- **Reminders.** A day before each confirmed session, Courtly posts a reminder into its chat. A session that moves is reminded again for its new time. The reminder worker runs inside the backend process alongside the Calendar worker.
- **Planning the next session.** In any chat, a coach or a student presses **+**, picks a date and one of the coach's available times, and sends a proposal card. The other side answers with **Accept**, **Decline**, or **Edit**. Edit answers with a new time that travels back the other way, so the person who asked first presses Accept to confirm it. In a group, a coach's proposal goes to every student and each answers for themselves; a student's proposal is answered by the coach. The club reads along and messages, but does not propose or answer.
- **Calendar.** Accepting books a normal Class for that student under the club, re-checking availability at that moment. It appears in the student's bookings and the club and coach calendars immediately, and — like every confirmed Class — is projected to any connected Google Calendar. A venue that needs approval keeps it pending until the club secures it.
- **Privacy.** Messages are visible to the session's members and to the platform admin console, and each chat says so. The API never sends account IDs to the browser; it tells each reader which messages and proposals are their own.

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

   Open [http://localhost:3000](http://localhost:3000). The Next.js server rewrites same-origin `/api/*` requests to the API at `http://127.0.0.1:4000`.

To create a persistent sample club and club account instead of using the demo workspace, optionally set `SEED_CLUB_EMAIL`, `SEED_CLUB_PASSWORD`, `SEED_BUSINESS_NAME`, and `SEED_BUSINESS_SLUG` in `backend/.env`, then run `npm run seed --prefix backend`. If `SEED_CLUB_PASSWORD` is omitted, the command prints a generated password once.

For a temporary investor showcase on an already deployed account-aware environment, run `npm run demo:investors` with an explicit `INVESTOR_DEMO_BASE_URL` plus distinct `INVESTOR_DEMO_CLUB_PASSWORD`, `INVESTOR_DEMO_COACH_PASSWORD`, `INVESTOR_DEMO_STUDENT_PASSWORD`, and undisclosed `INVESTOR_DEMO_BACKGROUND_PASSWORD` values in the invoking shell. First-time provisioning also requires `INVESTOR_DEMO_ALLOW_CREATE=true`; later runs require the exact `INVESTOR_DEMO_EXPECTED_BUSINESS_ID` and `INVESTOR_DEMO_EXPECTED_BUSINESS_SLUG` printed by the first run. The builder uses normal authenticated APIs and fixed, mutually distinct `investor_demo_*` usernames to create one `CLUB` account, portable `COACH` accounts, `STUDENT` accounts, and a `Courtly Investor Showcase` workspace with representative schedules, hosted court sessions, group classes, packages, payments, cancellations, coach acceptances, and venue approvals. It never stores supplied passwords in the repository, never retries mutations automatically, requires HTTPS outside loopback development, and anchors dates to workspace creation so reconciliation does not append a new schedule each day. Because normal club registration creates a non-demo workspace, delete the exact printed workspace ID from the platform admin console when the showcase is no longer needed; do not use the bulk demo purge action.

`npm run demo:elever` is a destructive, database-level replacement intended only for the approved Elever investor environment. It deletes every application row while preserving migrations and schema objects, then creates one club-only Elever marketplace in one transaction. The fixed October 2026 Asia/Singapore dataset contains the two affiliated coaches, the eight named investor students plus Student 1 through Student 12, weekly group Classes and varied 1:1 Classes, three Package offers, two purchased packages, simulated Stripe successes and a failure, an owned four-court badminton rental venue, four reservations, payouts, and a linked historical safeguard alert. It creates no active `SOLO` practice or new `DIRECT` session. Take a verified backup and stop application writes first. Supply `ELEVER_RESET_CONFIRMATION`, all five `ELEVER_*_PASSWORD` variables, and `ELEVER_EXPECTED_DATABASE_SHA256`, which must equal the lowercase SHA-256 of `DATABASE_URL` (for example, `printf %s "$DATABASE_URL" | shasum -a 256` on macOS or `printf %s "$DATABASE_URL" | sha256sum` on Linux). The fingerprint binds the confirmation to the exact connection string without storing or printing it. The command also refuses an unresolved migration or a migration name/checksum mismatch. Afterwards, run `npm run verify:elever` with `ELEVER_BASE_URL` and the four featured passwords. Keep every secret in the invoking shell or secret manager, never in a committed file.

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

The full Playwright suite deliberately creates many isolated accounts and workspaces from one loopback address. When running that suite, start the backend with `E2E_DISABLE_RATE_LIMITS=true` to bypass all API rate limiters for that process. The flag is opt-in, is unnecessary for normal development, and is ignored whenever `NODE_ENV=production`, even if it is accidentally set. Never configure it on a deployed service.

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
   | `DEMO_ENABLED` | `false` (recommended) to prevent public demo-data growth; use `true` only for a monitored showcase |
   | `ADMIN_PASSWORD` | A long, random secret to unlock the platform admin console at `/admin`. Leave unset to disable the admin console entirely. |
   | `GOOGLE_MAPS_API_KEY` | Optional. A Google Places API key enabling venue search. Leave unset to keep the paste-a-Maps-link fallback, which needs no key. |
   | `GOOGLE_CALENDAR_CLIENT_ID` | OAuth 2.0 web client ID from Google Cloud. Leave the Calendar variables unset to disable the integration. |
   | `GOOGLE_CALENDAR_CLIENT_SECRET` | OAuth 2.0 web client secret from Google Cloud. |
   | `GOOGLE_CALENDAR_REDIRECT_URI` | Exact public callback URI registered in Google Cloud, normally `https://YOUR-VERCEL-DOMAIN/api/calendar/google/callback`. |
   | `CALENDAR_TOKEN_ENCRYPTION_KEYS` | Comma-separated `keyId:base64` token-encryption keys; each key must decode to exactly 32 bytes. |
   | `CALENDAR_TOKEN_ACTIVE_KEY_ID` | ID from the key list used for new token encryption. |

   Do not set `PORT`; Railway injects it.
   `APP_ORIGIN` is added after Vercel assigns the frontend URL. It can remain unset for this initial health-only deployment because no browser will use the API yet.
6. Deploy once. The checked-in Railway config installs dependencies (including the build and migration tools) and builds the TypeScript API. Before each release starts, `npm run db:migrate` applies committed Prisma migrations; the service then starts with `npm start`. A failed migration prevents the new release from starting.
7. Generate a public domain in **Settings → Networking** and copy the resulting HTTPS origin, such as `https://courtly-api-production.up.railway.app`. Verify `https://YOUR-RAILWAY-DOMAIN/api/health` returns JSON with `"ok": true`.

`APP_ORIGIN` is still required for the backend's explicit browser-origin checks. The browser itself talks only to the Vercel origin: Next.js proxies `/api/*` server-side to Railway, so the secure `__Host-courtly_session` cookie remains a same-origin frontend cookie rather than a third-party cross-site cookie.

### 2. Vercel: Next.js frontend

1. Import the same GitHub repository as a new Vercel project.
2. Set **Root Directory** to `frontend`. Vercel should detect the Next.js framework; `frontend/vercel.json` supplies the install and build commands.
3. Add `BACKEND_URL` for **Production** (and Preview if preview deployments should use this API). Set it to the Railway public HTTPS origin from step 1, with no trailing slash, for example `https://courtly-api-production.up.railway.app`. This is a server-side rewrite target and is not a public browser variable.
4. Deploy the project and note its canonical production URL.
5. Return to the Railway API variables, add `APP_ORIGIN` with that exact Vercel origin (for example `https://courtly.example.com`, with no trailing slash), and redeploy the API. If a custom frontend domain is added later, update `APP_ORIGIN` to the domain users actually visit. For more than one allowed origin, use a comma-separated list.
6. Redeploy Vercel whenever `BACKEND_URL` changes because Next.js resolves the rewrite configuration during the build.
7. Open the Vercel application, register or sign in with a student account, and complete a booking. Confirm that it appears in the student's self-service history. In browser developer tools, `/api/*` requests should target the Vercel hostname, not the Railway hostname.

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
- Marketplace migrations deliberately wait at most ten seconds for their
  application-table locks. A `55P03` or `lock timeout` failure means concurrent
  traffic prevented a safe migration start: stop writes or use a quiet release
  window, mark only the exact failed migration as rolled back with
  `prisma migrate resolve --rolled-back <migration_name>`, then redeploy. Do not
  disable the timeout as the first response. An extension permission or missing
  control-file error is different: have the database administrator enable
  `btree_gist`, resolve the failed prerequisite migration, and retry.
- Set `DEMO_ENABLED=false` when public demo creation is not wanted. Global student, coach, and club account registration and sign-in remain available.
- Keep at least one backend instance running: the day-before chat reminders and, when Calendar is enabled, the Calendar worker both run in the API process. Several instances are safe; each reminder is a single locked decision. A user-visible Calendar delay does not mean the Courtly booking failed; inspect worker/provider state before replaying a booking mutation.
- To create an initial known club deliberately, run the Railway service's `npm run seed` command once with strong `SEED_CLUB_PASSWORD`, `SEED_CLUB_EMAIL`, `SEED_BUSINESS_NAME`, and `SEED_BUSINESS_SLUG` variables. The seed is idempotent for an existing slug and is not part of deployment.
- Check the Railway health endpoint after releases. It returns `503` if PostgreSQL cannot be reached.
- Treat Railway and Vercel environment changes as production changes. Never copy the generated `DATABASE_URL` into GitHub, Vercel, or committed files; only the backend needs database access.

## Platform admin console

Courtly ships a platform admin console at `/admin`, separate from `STUDENT`, `COACH`, and `CLUB` accounts and their affiliations. It is gated by a single `ADMIN_PASSWORD` environment variable on the backend, not by an `ADMIN` account type (there is no such account type).

- Set `ADMIN_PASSWORD` in the Railway API service to a long, random secret, then redeploy. Leaving it unset disables `/admin` (the page shows a "not configured" notice and every admin API returns `401`/`503`).
- Visit `https://YOUR-FRONTEND-DOMAIN/admin`, enter the password, and you get a platform overview (businesses, students, bookings, payments) plus a searchable, filterable list of every workspace.
- From the console you can permanently delete any business (cascading to all of its students, bookings, packages, payments, and session chats) or purge every demo workspace at once. These actions are irreversible.
- The **Chats** section lists every session chat on the platform, searchable by club, class, coach, or student, and opens any conversation read-only for safety review. The console cannot post or answer proposals.
- The admin session is a stateless, HMAC-signed cookie keyed by the password itself, so rotating `ADMIN_PASSWORD` immediately invalidates all existing admin sessions. The page carries `noindex` so it stays out of search results.

## MVP boundaries

- Class bookings reserve coach time. Separately, a club may publish its own facility inventory through Rentals; a confirmed rental reserves one specific Courtly-managed unit. A third-party or approval-required class venue still stays pending until the club secures it outside Courtly.
- Venues can be looked up on Google Maps. Set `GOOGLE_MAPS_API_KEY` on the backend for live Places search; without it, pasting a Google Maps link still fills in the venue. The key stays server-side and never reaches the browser.
- Checkout uses a deterministic simulated Stripe provider for product demonstration and testable payment intent state. No live card network, fund movement, refunds, or business subscription billing is connected.
- Confirmations and reminders are queued as in-app records, and session reminders are posted into each session's chat. Email, SMS, push notifications, and automated WhatsApp delivery are not connected.
- Google Calendar is a one-way projection of confirmed Courtly Classes, not a two-way calendar editor. External edits never alter Courtly, and cached free/busy checks deliberately fail open when fresh data is unavailable.
- Route-based travel calculations and waitlists are intentionally left for later integrations.
