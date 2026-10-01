import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { recordClubMetric, type ClubMetric } from '../src/club-metrics.js';
import { createStudent, prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type GrowthWire = {
  days: number;
  funnel: Record<string, number>;
  daily: Array<{ day: string; pageViews: number; availabilityChecks: number; bookings: number }>;
  retention: { activeStudents: number; returningStudents: number; repeatRate: number | null };
  feedback: { attendedPlaces: number; withSharedFeedback: number; coverage: number | null; viewed: number; viewRate: number | null };
  waitlist: { waiting: number; offered: number };
};

describe.sequential('club growth insights', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  const growth = (cookie = club.cookie, query: Record<string, string | number> = {}) =>
    request(app).get('/api/insights/growth').set('Cookie', cookie).query(query);

  async function staffCookie(permissions: string[]) {
    const suffix = randomUUID().replaceAll('-', '');
    const user = await prisma.user.create({ data: {
      name: 'Insight Staff', legalName: 'Insight Staff', username: `ins_${suffix.slice(0, 18)}`, email: `ins-${suffix}@example.test`,
      passwordHash: 'not-used', accountType: 'STUDENT',
    } });
    tenants.ownUser(user.id);
    const access = await prisma.clubStaffAccess.create({ data: {
      businessId: club.business.id, userId: user.id, invitedByUserId: club.user.id, accessLevel: 'CUSTOM', permissions,
    } });
    const token = randomBytes(32).toString('base64url');
    await prisma.authSession.create({ data: {
      id: createHash('sha256').update(token).digest('hex'), userId: user.id, activeStaffAccessId: access.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    return `${config.sessionCookie}=${token}`;
  }

  // Past sessions cannot be booked through the live slot rules, so the
  // reporting fixture writes historical rows directly.
  async function session(startAt: DateTime, places: Array<{ studentId: string; attendance?: string; cancelled?: boolean }>, status = 'COMPLETED') {
    const booking = await prisma.booking.create({ data: {
      businessId: club.business.id, serviceId: club.service.id, instructorId: club.instructor.id, locationId: club.location.id,
      startAt: startAt.toJSDate(), endAt: startAt.plus({ hours: 1 }).toJSDate(), duration: 60, type: 'GROUP', capacity: 8,
      price: 4000, status, paymentRoute: 'CLUB',
    } });
    const participants = [];
    for (const place of places) {
      participants.push(await prisma.participant.create({ data: {
        bookingId: booking.id, studentId: place.studentId, price: 4000, attendance: place.attendance ?? 'UNMARKED',
        cancelledAt: place.cancelled ? new Date() : null,
      } }));
    }
    return { booking, participants };
  }

  async function feedback(bookingId: string, participantId: string, shared: boolean, viewed = false) {
    return prisma.sessionFeedback.create({ data: {
      businessId: club.business.id, bookingId, participantId, authorUserId: club.coachUser.id, authorName: 'Test Coach',
      authorRole: 'COACH', visibility: shared ? 'SHARED' : 'PRIVATE', summary: 'Worked on footwork.',
      sharedAt: shared ? new Date() : null, firstViewedAt: viewed ? new Date() : null,
    } });
  }

  it('aggregates funnel counters per club-local day with a zero-filled daily series', async () => {
    const zone = club.business.timezone;
    const today = DateTime.now().setZone(zone).startOf('day');
    const at = (daysAgo: number) => today.minus({ days: daysAgo }).plus({ hours: 12 }).toJSDate();
    const record = (metric: ClubMetric, daysAgo: number, amount: number, businessId = club.business.id) =>
      recordClubMetric(prisma, businessId, metric, { timezone: zone, amount, now: at(daysAgo) });
    await record('PAGE_VIEW', 0, 5);
    await record('PAGE_VIEW', 3, 2);
    await record('AVAILABILITY_CHECK', 3, 4);
    await record('BOOKING_CREATED', 6, 2);
    await record('REBOOK_CREATED', 6, 1);
    await record('WAITLIST_JOINED', 1, 3);
    await record('WAITLIST_ACCEPTED', 1, 1);
    await record('SEARCH_IMPRESSION', 2, 7);
    // Outside a seven-day window, and another club's traffic.
    await record('PAGE_VIEW', 7, 100);
    const other = await tenants.fixture();
    await record('PAGE_VIEW', 0, 50, other.business.id);

    const week = (await growth(club.cookie, { days: 7 }).expect(200)).body as GrowthWire;
    expect(week.days).toBe(7);
    expect(week.funnel).toEqual({
      pageViews: 7, availabilityChecks: 4, bookings: 2, rebooks: 1, waitlistJoined: 3, waitlistAccepted: 1, searchImpressions: 7,
    });
    expect(week.daily).toHaveLength(7);
    expect(week.daily[0]!.day).toBe(today.minus({ days: 6 }).toISODate());
    expect(week.daily.at(-1)).toEqual({ day: today.toISODate(), pageViews: 5, availabilityChecks: 0, bookings: 0 });
    expect(week.daily.find(entry => entry.day === today.minus({ days: 3 }).toISODate()))
      .toEqual({ day: today.minus({ days: 3 }).toISODate(), pageViews: 2, availabilityChecks: 4, bookings: 0 });
    expect(week.daily[0]).toEqual({ day: today.minus({ days: 6 }).toISODate(), pageViews: 0, availabilityChecks: 0, bookings: 2 });
    expect(week.daily.map(entry => entry.day)).toEqual([...new Set(week.daily.map(entry => entry.day))].sort());

    const month = (await growth().expect(200)).body as GrowthWire;
    expect(month.days).toBe(30);
    expect(month.daily).toHaveLength(30);
    expect(month.funnel.pageViews).toBe(107);
  });

  it('uses the club time zone for day boundaries', async () => {
    await prisma.business.update({ where: { id: club.business.id }, data: { timezone: 'Pacific/Honolulu' } });
    const body = (await growth(club.cookie, { days: 7 }).expect(200)).body as GrowthWire;
    const today = DateTime.now().setZone('Pacific/Honolulu');
    expect(body.daily.at(-1)!.day).toBe(today.toISODate());
    expect(body.daily[0]!.day).toBe(today.minus({ days: 6 }).toISODate());
  });

  it('reports retention, feedback coverage and live waitlist counts without naming anyone', async () => {
    const zone = club.business.timezone;
    const today = DateTime.now().setZone(zone).startOf('day');
    const [amelia, ben, chloe, dan] = await Promise.all(['Amelia', 'Ben', 'Chloe', 'Dan'].map(name => createStudent(club, { name: `${name} Learner` })));

    const first = await session(today.minus({ days: 5 }).set({ hour: 9 }), [
      { studentId: amelia!.id, attendance: 'PRESENT' }, { studentId: ben!.id, attendance: 'LATE' },
      { studentId: chloe!.id, attendance: 'ABSENT' }, { studentId: dan!.id, attendance: 'PRESENT', cancelled: true },
    ]);
    const second = await session(today.minus({ days: 2 }).set({ hour: 9 }), [{ studentId: amelia!.id, attendance: 'PRESENT' }]);
    // Cancelled bookings, cancelled places, sessions outside the window and
    // sessions that have not ended do not count as attended.
    await session(today.minus({ days: 3 }).set({ hour: 9 }), [{ studentId: ben!.id, attendance: 'PRESENT' }], 'CANCELLED');
    await session(today.minus({ days: 40 }).set({ hour: 9 }), [{ studentId: chloe!.id, attendance: 'PRESENT' }, { studentId: ben!.id, attendance: 'PRESENT' }]);
    const upcoming = await session(DateTime.now().plus({ days: 3 }), [{ studentId: chloe!.id }], 'CONFIRMED');

    await feedback(first.booking.id, first.participants[0]!.id, true, true);
    await feedback(first.booking.id, first.participants[1]!.id, true, false);
    await feedback(first.booking.id, first.participants[2]!.id, true, true);
    await feedback(second.booking.id, second.participants[0]!.id, false);

    const waiting = await createStudent(club, { name: 'Queued Learner' });
    const offered = await createStudent(club, { name: 'Offered Learner' });
    const closed = await createStudent(club, { name: 'Closed Learner' });
    await prisma.waitlistEntry.createMany({ data: [
      { businessId: club.business.id, bookingId: upcoming.booking.id, studentId: waiting.id, status: 'WAITING' },
      { businessId: club.business.id, bookingId: upcoming.booking.id, studentId: offered.id, status: 'OFFERED', offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 3_600_000) },
      { businessId: club.business.id, bookingId: upcoming.booking.id, studentId: closed.id, status: 'DECLINED' },
    ] });

    const body = (await growth().expect(200)).body as GrowthWire;
    // Amelia twice; Ben and Chloe once each (the ABSENT place is still an
    // active place). Dan's cancelled place, the cancelled booking, the session
    // 40 days ago and Chloe's session after today are outside the measure.
    expect(body.retention).toEqual({ activeStudents: 3, returningStudents: 1, repeatRate: 0.3333 });
    // Attended: Amelia (first), Ben (LATE), Amelia (second). Shared: 2 of them;
    // the ABSENT learner's shared note is not an attended place.
    expect(body.feedback).toEqual({ attendedPlaces: 3, withSharedFeedback: 2, coverage: 0.6667, viewed: 1, viewRate: 0.5 });
    expect(body.waitlist).toEqual({ waiting: 1, offered: 1 });
    expect(JSON.stringify(body)).not.toMatch(/Learner|@example\.test/u);

    const week = (await growth(club.cookie, { days: 7 }).expect(200)).body as GrowthWire;
    expect(week.retention.activeStudents).toBe(3);

    const other = await tenants.fixture();
    const empty = (await growth(other.cookie).expect(200)).body as GrowthWire;
    expect(empty.retention).toEqual({ activeStudents: 0, returningStudents: 0, repeatRate: null });
    expect(empty.feedback).toEqual({ attendedPlaces: 0, withSharedFeedback: 0, coverage: null, viewed: 0, viewRate: null });
    expect(empty.waitlist).toEqual({ waiting: 0, offered: 0 });
    expect(Object.values(empty.funnel).every(value => value === 0)).toBe(true);
  });

  it('is club-side only and validates the reporting window', async () => {
    await growth(club.coachCookie).expect(403);
    await growth(await staffCookie(['BOOKINGS_VIEW'])).expect(200);
    await growth(await staffCookie(['BOOKINGS_MANAGE'])).expect(200);
    await growth(await staffCookie(['PACKAGES_VIEW', 'STUDENTS_VIEW'])).expect(403);
    await request(app).get('/api/insights/growth').expect(401);
    for (const days of ['6', '91', 'abc', '7.5', '']) await growth(club.cookie, { days }).expect(400);
    await growth(club.cookie, { days: 30, extra: 'x' }).expect(400);
    expect((await growth(club.cookie, { days: '90' }).expect(200)).body.daily).toHaveLength(90);
  });
});
