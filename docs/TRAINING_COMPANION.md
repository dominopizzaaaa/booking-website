# Training companion: contract and design

Courtly remains a multi-club marketplace and operating platform. This release
adds the everyday "training companion" layer on top of it: a calendar of your
Classes, coach feedback and progress, waitlists for full group Classes, an
auditable package-credit history, faster re-booking and availability-first
search, richer club and coach profiles, club-local training groups, a
court-side "Run this Class" workflow for coaches, and person-free funnel and
retention insights for clubs.

The schema is `backend/prisma/migrations/20261001100000_training_companion`.
Wire types live in `frontend/src/lib/types.ts` (section "Training companion")
and every client call in `frontend/src/lib/api.ts`. All responses are JSON,
including deletions (`{ "ok": true }` or the changed record); there are no 204s.
Request bodies use Zod `.strict()`. Errors are `HttpError(status, sentence)`.

## Principles that must not regress

- No new account type. Guardians, training-group members and waitlisted
  students are relationships, not roles.
- Money and credits: integer minor units; package credits change only through
  existing transactions. Every credit change is recorded by the database.
- Tenancy: every query filters by `businessId`; new club-local rows use
  composite `(id, businessId)` foreign keys.
- A booking's `paymentRoute` snapshot is untouched; every new booking path is an
  ordinary `CLUB` booking made through `createBookingsInTransaction`.
- Learners never see another participant, staff-only notes, prices hidden from
  coaches, or internal club remarks. Coaches never receive club prices.
- Analytics are aggregate counters only: no visitor, account, session, device,
  IP or free text is stored for funnel reporting.

## 1. Club and coach public profiles

Data: `Business.description` (≤1200), `Business.publicPhone` (≤40),
`Business.websiteUrl` (`''` or `https://…`, ≤200), `Location.area` (≤60 free
text, e.g. "Tampines · East"). Coach profile on `User` (COACH accounts only, SQL
enforced): `bio` (≤600), `languages` (≤8, each ≤40), `coachingLevels` ⊆
BEGINNER|INTERMEDIATE|ADVANCED|COMPETITIVE, `coachingAgeGroups` ⊆
JUNIOR|TEEN|ADULT|SENIOR, `qualifications` (≤10, each ≤80, self-reported and
labelled as such in the UI), `coachingSince` (year 1950..current year or null).

- `PATCH /api/business` (SETTINGS_MANAGE, recent auth) also accepts
  `description`, `publicPhone`, `websiteUrl`. `businessJson`/`publicBusiness`
  return them.
- `POST/PATCH /api/locations` accept `area`; location JSON returns it.
- `PATCH /api/auth/me` accepts `coachProfile: CoachProfileInput` (partial,
  strict, de-duplicated case-insensitively, trimmed, empties dropped). 400 for
  non-COACH accounts. `userJson` returns `coachProfile` for COACH accounts and
  `null` otherwise.
- `publicBookingBusiness` adds `description`, `publicPhone`, `websiteUrl`,
  `supportEmail`. `publicLocation` adds `area`. `publicInstructor` adds
  `profile: CoachPublicProfile | null` read from the instructor's active COACH
  account (never email or phone). `profile` is null when every field is empty
  and the account has no sports.
- `GET /api/public/:slug` adds `summary: ClubPublicSummary` computed from the
  bookable catalogue it already returns (sports from service categories,
  `priceFrom` = lowest bookable venue price or null, distinct areas).
- `GET /api/account/clubs` entries add `areas: string[]` and `favorite: boolean`.

## 2. Discovery: saved clubs, availability-first search, next available

All account routes: `requireAccountCapability('directory')` and
`requireStudent` applied **per route** (the router is mounted on `/api` right
after authentication; never mount a capability guard on the bare prefix).

- `GET /api/account/favorites` → `{ favorites: FavoriteClub[] }` newest first.
- `PUT /api/account/favorites/:slug` → `FavoriteClub` (idempotent). 404 unless
  the slug is a non-legacy `CLUB`. At most 200 saved clubs (409 beyond).
- `DELETE /api/account/favorites/:slug` → `{ ok: true }` (idempotent).
- `GET /api/account/sessions/search?date&sport&timeOfDay&type&area&q` →
  `SessionSearchResponse`. `date` is required (`YYYY-MM-DD`, today..+60 days in
  the club's zone). `timeOfDay`: morning 05:00–12:00, afternoon 12:00–17:00,
  evening 17:00–23:00 local start time. `sport` matches service category
  case-insensitively; `area` and `q` are case-insensitive substrings over
  location area/address and club name. Only non-demo, non-legacy CLUBs with
  bookable combinations (`bookableInstructorWhere`). Bounded: at most 40
  service/venue/coach combinations and 600 slot evaluations per request; at
  most 40 results sorted by start time then price; `truncated` reports when a
  bound was hit. Every slot comes from `evaluateSlot` (so group places,
  conflicts and notice are authoritative). Shared rate limit, 30 requests per
  5 minutes per account. Each club that appears in results records one
  `SEARCH_IMPRESSION`.
- `GET /api/public/:slug/next-available?serviceId&instructorId&locationId&limit`
  (public, slot rate limit) → `{ slots: Slot[] }`: the next `limit` (1–10,
  default 5) available slots within 28 days, at most 400 evaluations, using the
  same 30-minute grid and `evaluateSlot` as `/slots`.

## 3. Coach feedback and progress

`SessionFeedback` is one row per participant place. `visibility` is `PRIVATE`
(draft, club only) or `SHARED` (learner/guardian can read). `clubNote` is an
internal remark that is never serialized to learners or guardians. `sharedAt`
is set the first time it becomes SHARED and is immutable afterwards.

Provider (mounted in the workspace chain, `coachScope` keeps a coach to their
own bookings; club-side staff need the named permission):

- `GET /api/bookings/:id/feedback` (BOOKINGS_VIEW) → `ProviderFeedbackList`
  for active participants. `canWrite` follows the write rules below.
- `PUT /api/bookings/:id/participants/:participantId/feedback`
  (BOOKINGS_MANAGE) body `FeedbackInput` → `ProviderFeedback`. Upsert. Rules:
  writable CLUB booking; status CONFIRMED or COMPLETED; coach acceptance not
  PENDING; the lesson has started; participant active; attendance PRESENT or
  LATE. SHARED requires at least one of summary/strengths/focusAreas/nextGoal.
  Lengths: summary 2000, strengths 600, focusAreas 600, nextGoal 300,
  clubNote 1000. The first writer is snapshotted as author (`COACH`, `CLUB`, or
  `STAFF`); later edits set `editedAt` and `editedByName`. On first share,
  `createAccountAlert('FEEDBACK_SHARED')` goes to a self-managed learner, or to
  each guardian of a managed child who holds an ACTIVE link with
  BOOKINGS_MANAGE and current consent (`subjectName` = child's name).

`GET /bookings/:id/feedback` lists only places that already have a feedback
row; the roster itself comes from the booking. The PUT answers 200 for both
create and update. The share alert names the coach when a coach shares, and the
club otherwise.

Attendance (bookings.ts): values `UNMARKED | PRESENT | LATE | ABSENT |
EXCUSED`; LATE counts as attended. Attendance opens once the lesson **has
started** (court-side roll call) instead of after it ends; all other rules are
unchanged. New bulk route `PATCH /api/bookings/:id/participants` body
`{ attendance, participantIds? }` (BOOKINGS_MANAGE) applies one value to the
named (or all active) participants atomically → `{ participants: [{id, attendance}] }`.

Learner:

- `GET /api/account/progress?businessSlug&coach&sport` (requireStudent) →
  `ProgressSummary`. Attended = active participant, booking not CANCELLED,
  attendance PRESENT or LATE. `booked` counts active places in non-cancelled
  bookings; `upcoming` those starting in the future. Streaks count consecutive
  ISO weeks (Asia/Singapore) with ≥1 attended session, ending this week or
  last week. `monthly` covers the last 6 months including the current one.
  `attendanceRate` = attended ÷ (attended + ABSENT), null when the divisor is 0.
  `currentGoal` is the newest shared feedback's non-empty `nextGoal`. `feedback`
  lists shared feedback newest first (max 50). `filters` lists the learner's
  own clubs, coach names and sports.
- `stats.clubs` and `stats.coaches` count attended sessions; a portable coach
  counts once across clubs. `filters` always come from the learner's whole
  history, not the filtered view. Cancelled bookings and places are ignored.
- `POST /api/account/feedback/:id/viewed` → `{ ok: true }`; sets
  `firstViewedAt` once, only for the caller's own shared feedback (404
  otherwise).

Guardian projections (`/api/family`, behind the Family feature flag): an
ACTIVE link from the authenticated adult to the child with BOOKINGS_MANAGE,
current-policy consent on that same link, and an active GUARDIAN_MANAGED
STUDENT child are required; otherwise 404 `Child profile not found` (never
reveal whether another family's child exists). Read-only.

- `GET /api/family/children/:id/schedule` → `ChildSchedule`: the child's
  places from 90 days ago onward, no other participants, notes, or prices.
- `GET /api/family/children/:id/progress` → `ChildProgress` (same rules as the
  learner summary, for the child).

## 4. Waitlists for full group Classes

`WaitlistEntry` statuses: WAITING → OFFERED → ACCEPTED, or DECLINED, EXPIRED,
WITHDRAWN, REMOVED (by club), CLOSED (Class cancelled, started, or no longer
bookable). Terminal rows never reopen (SQL). One live (WAITING/OFFERED) entry
per student and booking (SQL partial unique index). Order is `sequence`.

Held places: an OFFERED entry whose `offerExpiresAt` is in the future holds a
place. `evaluateSlot` computes a joinable group's remaining places as
`capacity − active participants − live offers` (excluding the accepting entry),
so a public booking cannot take a held place.

`offerWaitlistPlaces(tx, bookingId)` (caller holds the instructor lock): if the
booking is PENDING/CONFIRMED and starts more than the service notice period
from now, offer free places to WAITING entries in sequence. Offer window: until
`min(now + 12h, startAt − noticeHours)`; if that is under 10 minutes, close
instead. Each offer sends `createAccountAlert('WAITLIST_OFFERED')`. Otherwise
it closes live entries with a reason. `closeWaitlistForBooking` closes live
entries and sends `WAITLIST_CLOSED` to entries that were WAITING or OFFERED.
`cancelBooking` closes the waitlist. A background worker
(`startWaitlistWorker`, every 60 s, bounded batches, safe across replicas via
row locks, accepts `businessIds` in tests) expires stale offers, re-offers, and
closes waitlists for Classes inside their notice period.

Account routes (`requireAccountCapability('commerce')`, `requireStudent`,
self-managed accounts only — guardians cannot waitlist a child):

- `POST /api/public/:slug/waitlist` body `WaitlistJoinInput` → 201
  `{ entry }` (200 with the existing live entry when already queued). The
  matching GROUP booking must exist, be PENDING/CONFIRMED, start beyond the
  notice period, and be full (otherwise 409 "This Class still has places. Book
  it directly."). 409 when the student already holds a place or another booking
  at that time. Creates/reuses the club-local `Student` like booking does.
  Records `WAITLIST_JOINED`.
- `GET /api/account/waitlist` → `{ entries }`: live entries plus entries closed
  in the last 14 days. `aheadCount` = live entries with a lower sequence.
- `POST /api/account/waitlist/:id/accept` body `{ packageId? }` → `{ entry,
  bookings }`. Rechecks inside one transaction (instructor lock first): entry
  OFFERED and unexpired, booking still joinable, no student conflict, eligible
  package. Books through `createBookingsInTransaction(..., { studentUserId,
  waitlistEntryId })`. Records `WAITLIST_ACCEPTED`. An expired offer → 409 and
  the entry becomes EXPIRED.
- `POST /api/account/waitlist/:id/decline` → `{ entry }` (DECLINED, next
  person offered).
- `DELETE /api/account/waitlist/:id` → `{ entry }` (WITHDRAWN; an offered
  place passes on).

Workspace routes (`coachScope` applies):

- `GET /api/bookings/:id/waitlist` (BOOKINGS_VIEW) → `ProviderWaitlist`;
  `position` is 1-based among WAITING entries; `placesFree` excludes held offers.
- `POST /api/waitlist/:id/offer` (BOOKINGS_MANAGE) → manual out-of-order offer
  of a free place; 409 when no place is free.
- `DELETE /api/waitlist/:id` (BOOKINGS_MANAGE) → REMOVED, with a
  `WAITLIST_CLOSED` alert to the student.

Implementation notes:

- Closing logic lives in `scheduling.ts` (`closeLiveWaitlistEntries`) so
  `cancelBooking` can close a queue without importing `waitlist.ts`, which
  imports scheduling. `GROUP_FULL_REASON` ("This group is full") is the shared
  reason the booking page uses to recognise a full group slot.
- Repeating a decline, withdraw or remove that already happened returns 200;
  acting on an entry closed some other way returns 409. Accept errors carry
  `code: 'WAITLIST_OFFER_EXPIRED'` or `'WAITLIST_CLOSED'`.
- A student who gets a place in the group by any other route has their live
  entry closed ("You already have a place in this Class."); a freed hold is
  re-offered by the next sweep.
- Expired offers send no alert. When fewer than 10 minutes remain to make an
  offer, waiting entries close while live offers keep their deadlines. If the
  Class's service, venue or coach is no longer bookable, the queue closes.
- When a waitlisted student takes a place, the ordinary booking notice is
  retitled "Waitlist place taken · <name>" instead of adding a second notice.

## 5. Package credit activity

`PackageCreditEvent` is written by the `LessonPackage_credit_ledger` trigger on
every insert and every change of `totalCredits`/`usedCredits`; SQL rejects
UPDATE and independent DELETE. Writers label changes with
`withCreditContext(tx, { kind, bookingId, participantId, reservationId,
actorUserId, note }, fn)` from `credit-ledger.ts`; unlabelled changes are still
recorded. Kinds: OPENING_BALANCE (migration backfill), GRANTED, BOOKED,
RESTORED, RENTAL_RESERVED, RENTAL_RESTORED, ADJUSTED, USED. `balanceAfter` =
`totalAfter − usedAfter`.

- `GET /api/account/packages/:id/activity` (requireStudent; caller must own
  the package through their linked `Student`, else 404) → `PackageActivity`.
- `GET /api/packages/:id/activity` (PACKAGES_VIEW, tenant-scoped) → same.
- Events are oldest first. A synthetic final `EXPIRED` event (id
  `expiry:<packageId>`, `delta = −remaining`) is appended when the package has
  expired with credits left. `session` is filled when `bookingId` resolves to a
  booking in the same business.

Reminders: `startPackageAlertWorker` (every 15 min; exported
`sendPackageAlerts({ now, businessIds })` for tests) sends, at most once per
package and type (deduplicated by `AccountNotification.packageId` + `type`),
`PACKAGE_LOW` when a paid, unexpired package of a self-managed STUDENT has 0 or
1 credits remaining after use (`usedCredits > 0`), and `PACKAGE_EXPIRING` when
it expires within 14 days with credits remaining.

## 6. Training groups (club-local cohorts)

Club-side only: `requireClubPermission('STUDENTS_VIEW')` to read,
`STUDENTS_MANAGE` to change. Coaches never manage groups.

- `GET /api/training-groups?includeArchived=true|false` → `{ groups }` with
  active members (name/initials from the club `Student`).
- `POST /api/training-groups` body `TrainingGroupInput` → `TrainingGroup`.
  Optional `serviceId`/`locationId`/`instructorId` must belong to the business
  (instructor must be bookable), else 400.
- `PATCH /api/training-groups/:id` partial input plus `active`.
- `PUT /api/training-groups/:id/members` body `{ studentIds }` (≤ 200, all in
  the business, must respect `capacity`) replaces the active member set:
  removed members get `active=false, leftAt=now`; returning members are
  reactivated.
- `DELETE /api/training-groups/:id` archives (`active=false`) and returns it.

The workspace schedules a group by prefilling the existing booking-series
dialog with the group's defaults and members.

## 7. Club growth insights

Counters (`club-metrics.ts`, aggregate per club and local day): PAGE_VIEW
(`GET /api/public/:slug`), AVAILABILITY_CHECK (`/slots` and `/next-available`),
BOOKING_CREATED and REBOOK_CREATED (`POST /api/public/:slug/bookings`; `source:
'REBOOK'` counts as both), WAITLIST_JOINED, WAITLIST_ACCEPTED,
SEARCH_IMPRESSION.

- `GET /api/insights/growth?days=7..90` (club-side, `BOOKINGS_VIEW`; coaches
  get 403) → `GrowthInsights`. Retention counts distinct students with an
  active place in a non-cancelled booking starting in the window
  (`activeStudents`) and those with ≥2 (`returningStudents`). Feedback coverage
  = attended places in ended bookings with SHARED feedback ÷ attended places.

## 8. Frontend experience

Student app (`/manage`):

- Home gains a List/Calendar toggle (preference remembered per account in
  `localStorage`, guarded by try/catch) with month and agenda views, status
  dots, Today, and club/coach/sport filters; both views open the same booking
  dialog. A waitlist panel shows offers (confirm with optional package, or
  decline before the deadline) and waiting places ("N ahead of you"). A
  progress card shows streak, sessions attended, current goal and the latest
  coach note, linking to the `?tab=progress` view (a route-only tab, like
  alerts). Package cards show low-balance and expiry warnings, "View activity",
  and "Buy another package".
- Booking details offer **Book again**, linking to
  `/book/<slug>?service=&coach=&venue=&rebook=1`.
- Explore gains saved clubs (heart toggle, Saved filter) and **Find a time**:
  date, sport, time of day, Class type, area; results link to
  `/book/<slug>?service=&coach=&venue=&date=&start=&source=search`. Recent
  searches are remembered in `localStorage`.
- Guardians with managed children get a **Viewing as** player switcher in the
  header. Choosing a child (URL `?player=<childId>`) shows that child's
  schedule and coach feedback, a "Book a Class for <name>" action, and a link
  to Family for profile and consent. It never impersonates the child.
- Empty states always offer a concrete next action (Explore clubs, Find a time).

Public booking page (`/book/[slug]`): a decision header (description, sports,
price from, coaches, areas, cancellation notice, contact, "What happens after
booking"); rich coach cards; query-parameter preselection with a "Next
available" strip for re-booking; full group slots offer "Join the waitlist" to
signed-in students; `source` is sent with the booking.

Workspace: "Run this Class" (roster, Present/Late/Absent/Excused, Mark all
present, per-learner feedback with share toggle and internal club note,
message the Class, complete the Class); waitlist panel on group bookings;
Training groups under Students with "Schedule series"; coach profile editor;
club description/phone/website and venue area fields; Growth insights in
Insights; package credit activity in finance.

Family: each child card links to its schedule and progress projections.

The app ships a web manifest (installable, `start_url` `/`, which routes each
account type to its own app), but no service worker or offline cache:
authenticated booking data must never be served stale.

Credits are consumed one place at a time, after each place exists, so every
`BOOKED` and `RENTAL_RESERVED` ledger row names its exact booking, participant
or reservation. The package row lock taken during eligibility keeps the
up-front balance check valid until the last place consumes its credit.

## Deliberately out of scope

Guardian waitlisting, cancellation, rescheduling, payment, and chat for a
child; automatic waitlist charging; verified coach qualifications; referral
links, A/B experimentation, and localization. These need separate product,
safeguarding, and commercial decisions.
