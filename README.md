# Courtly

Courtly is a full-stack booking platform for coaching businesses. This repository is a small monorepo: the Express and Prisma API lives in `backend/`, the Next.js application lives in `frontend/`, and PostgreSQL stores application data.

[![CI](https://github.com/dominopizzaaaa/booking-website/actions/workflows/ci.yml/badge.svg)](https://github.com/dominopizzaaaa/booking-website/actions/workflows/ci.yml)

The working MVP includes multi-location and instructor-aware availability, travel and preparation buffers, private and capacity-limited group lessons, atomic recurring bookings, pending venue approval, customer self-booking and private management links, packages, manual payment records, attendance, customer/parent details, staff roles, and a responsive provider workspace. Defaults are SGD and Asia/Singapore.

## Requirements

- Node.js 22
- npm 10 or newer
- PostgreSQL 16 or newer, or the included local PostgreSQL helper

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

To create a persistent sample owner instead of using the visitor demo, optionally set `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`, `SEED_BUSINESS_NAME`, and `SEED_BUSINESS_SLUG` in `backend/.env`, then run `npm run seed --prefix backend`. If `SEED_OWNER_PASSWORD` is omitted, the command prints a generated password once.

## Checks

With PostgreSQL running and the migrations applied:

```bash
npm test
npm run build
```

The backend integration suite deliberately requires a local PostgreSQL URL. GitHub Actions provisions an isolated PostgreSQL 16 service, migrates it, runs the tests, type-checks the frontend, and builds both applications.

## Deploy from GitHub

Deploy the backend to Railway first, then point the Vercel frontend at the Railway public domain. Both hosts must import the same GitHub repository but use different Root Directories. Do not add `backend/.env` or `frontend/.env.local` to Git; configure production values in the hosting dashboards.

### 1. Railway: PostgreSQL and Express API

1. Create a Railway project and add a **PostgreSQL** database service. Railway generates its connection variables; no schema needs to be created manually.
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
7. Open the Vercel application and exercise registration or the demo. In browser developer tools, `/api/*` requests should target the Vercel hostname, not the Railway hostname.

Preview deployments have a different origin on every build. If previews need authenticated mutations, add the desired preview origins to Railway's `APP_ORIGIN`; otherwise keep previews connected only for read-only checks or omit the Preview `BACKEND_URL`.

## Production operations

- Commit a new Prisma migration for every schema change. Railway runs `prisma migrate deploy` through `npm run db:migrate`; it does not run destructive development migrations or seed production automatically.
- Set `DEMO_ENABLED=false` when public demo creation is not wanted. Registration and normal sign-in remain available.
- To create an initial known business deliberately, run the Railway service's `npm run seed` command once with strong `SEED_OWNER_PASSWORD`, `SEED_OWNER_EMAIL`, `SEED_BUSINESS_NAME`, and `SEED_BUSINESS_SLUG` variables. The seed is idempotent for an existing slug and is not part of deployment.
- Check the Railway health endpoint after releases. It returns `503` if PostgreSQL cannot be reached.
- Treat Railway and Vercel environment changes as production changes. Never copy the generated `DATABASE_URL` into GitHub, Vercel, or committed files; only the backend needs database access.

## Platform admin console

Courtly ships a platform-owner console at `/admin`, separate from provider (business) logins. It is gated by a single `ADMIN_PASSWORD` environment variable on the backend, not by a database account.

- Set `ADMIN_PASSWORD` in the Railway API service to a long, random secret, then redeploy. Leaving it unset disables `/admin` (the page shows a "not configured" notice and every admin API returns `401`/`503`).
- Visit `https://YOUR-FRONTEND-DOMAIN/admin`, enter the password, and you get a platform overview (businesses, customers, bookings, payments) plus a searchable, filterable list of every workspace.
- From the console you can permanently delete any business (cascading to all of its customers, bookings, packages, and payments) or purge every demo workspace at once. These actions are irreversible.
- The admin session is a stateless, HMAC-signed cookie keyed by the password itself, so rotating `ADMIN_PASSWORD` immediately invalidates all existing admin sessions. The page carries `noindex` so it stays out of search results.

## MVP boundaries

- Courtly reserves instructor time; it does not reserve an external court or room. Rented or approval-required venues stay pending until the provider secures them separately.
- Lesson payments are tracked manually. No customer payment gateway or provider subscription checkout is connected.
- Confirmations and reminders are queued as in-app records. Email, SMS, and automated WhatsApp delivery are not connected.
- External calendar sync, route-based travel calculations, waitlists, and marketplace discovery are intentionally left for later integrations.
