import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DateTime } from 'luxon';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { buildProgressSummary } from '../src/feedback.js';
import { createBookings } from '../src/scheduling.js';
import {
  createAccount, createSession, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

const sg = (iso: string) => DateTime.fromISO(iso, { zone: 'Asia/Singapore' }).toJSDate();

describe.sequential('learner progress summary', () => {
  let tenants: TestTenants;
  let clubA: Fixture;
  let clubB: Fixture;
  let learner: Awaited<ReturnType<typeof createAccount>>;
  let learnerCookie: string;
  let slot = 0;

  beforeEach(async () => {
    tenants = new TestTenants();
    clubA = await tenants.fixture();
    clubB = await tenants.fixture();
    await prisma.service.update({ where: { id: clubB.service.id }, data: { category: 'Badminton' } });
    learner = await createAccount(clubA, { name: 'Progress Learner' });
    learnerCookie = (await createSession(clubA, learner.id)).cookie;
    slot = 0;
  });
  afterEach(async () => { await tenants.cleanup(); });

  const studentFor = async (club: Fixture, user = learner) => {
    const existing = await prisma.student.findFirst({ where: { businessId: club.business.id, userId: user.id } });
    return existing ?? createStudent(club, { userId: user.id, name: user.name, email: user.email! });
  };

  /** Book a free future slot, then move it to the instant the scenario needs. */
  async function place(club: Fixture, startIso: string, attendance: string, options: {
    bookingStatus?: string; cancelledPlace?: boolean; user?: typeof learner;
  } = {}) {
    const student = await studentFor(club, options.user);
    slot += 1;
    const created = await createBookings(club.business.id, inputFor(club, {
      studentId: student.id, student: undefined, startAt: club.starts.plus({ days: slot }).toISO()!,
    }));
    const startAt = sg(startIso);
    const bookingId = created.bookings[0]!.id;
    await prisma.booking.update({
      where: { id: bookingId },
      data: { startAt, endAt: new Date(startAt.getTime() + 3_600_000), status: options.bookingStatus ?? 'CONFIRMED' },
    });
    const participantId = created.bookings[0]!.participants[0]!.id;
    await prisma.participant.update({
      where: { id: participantId },
      data: { attendance, ...(options.cancelledPlace ? { cancelledAt: new Date() } : {}) },
    });
    return { bookingId, participantId, businessId: club.business.id };
  }

  async function feedback(target: { bookingId: string; participantId: string; businessId: string }, values: {
    visibility?: string; sharedAt?: string | null; nextGoal?: string; summary?: string; clubNote?: string;
  }) {
    const visibility = values.visibility ?? 'SHARED';
    return prisma.sessionFeedback.create({ data: {
      businessId: target.businessId, bookingId: target.bookingId, participantId: target.participantId,
      authorName: 'Secret Author Name', authorRole: 'COACH', visibility,
      summary: values.summary ?? 'Session notes', nextGoal: values.nextGoal ?? '',
      clubNote: values.clubNote ?? 'INTERNAL-CLUB-NOTE',
      sharedAt: values.sharedAt === null || visibility === 'PRIVATE' ? null : sg(values.sharedAt ?? '2026-10-01T12:00'),
    } });
  }

  async function scenario() {
    const p13 = await place(clubA, '2026-10-13T10:00', 'PRESENT');
    const p06 = await place(clubA, '2026-10-06T10:00', 'LATE');
    const p29 = await place(clubA, '2026-09-29T10:00', 'PRESENT');
    await place(clubA, '2026-09-22T10:00', 'EXCUSED');
    await place(clubA, '2026-09-15T10:00', 'ABSENT');
    for (const day of ['03', '10', '17', '24']) await place(clubA, `2026-08-${day}T10:00`, 'PRESENT');
    const cancelledBooking = await place(clubA, '2026-09-08T10:00', 'PRESENT', { bookingStatus: 'CANCELLED' });
    const cancelledPlace = await place(clubA, '2026-09-01T10:00', 'PRESENT', { cancelledPlace: true });
    await place(clubA, '2026-10-20T10:00', 'UNMARKED');
    const badminton = await place(clubB, '2026-10-07T18:00', 'PRESENT');

    const goal = await feedback(p29, { sharedAt: '2026-09-29T13:00', nextGoal: 'Hold the continental grip', clubNote: 'INTERNAL-NOTE-ONE' });
    const noGoal = await feedback(p06, { sharedAt: '2026-10-06T13:00', summary: 'Good recovery' });
    const draft = await feedback(p13, { visibility: 'PRIVATE', nextGoal: 'Private goal' });
    const hiddenCancelled = await feedback(cancelledBooking, { sharedAt: '2026-10-10T13:00', nextGoal: 'Cancelled goal' });
    const hiddenPlace = await feedback(cancelledPlace, { sharedAt: '2026-10-11T13:00', nextGoal: 'Left goal' });
    const other = await feedback(badminton, { sharedAt: '2026-10-07T20:00', nextGoal: 'Badminton goal' });
    return { goal, noGoal, draft, hiddenCancelled, hiddenPlace, other };
  }

  it('derives attendance, streak, monthly, goal and feedback from the learner’s own places', async () => {
    const rows = await scenario();
    const summary = await buildProgressSummary(learner.id, {}, sg('2026-10-14T12:00'));

    expect(summary.stats).toEqual({
      attended: 8, booked: 11, upcoming: 1, hoursOnCourt: 8,
      currentStreakWeeks: 3, longestStreakWeeks: 4, clubs: 2, coaches: 2,
      lastAttendedAt: sg('2026-10-13T10:00').toISOString(), attendanceRate: 8 / 9,
    });
    expect(summary.monthly).toEqual([
      { month: '2026-05', attended: 0 }, { month: '2026-06', attended: 0 }, { month: '2026-07', attended: 0 },
      { month: '2026-08', attended: 4 }, { month: '2026-09', attended: 1 }, { month: '2026-10', attended: 3 },
    ]);
    expect(summary.currentGoal).toEqual({
      text: 'Badminton goal', setAt: sg('2026-10-07T20:00').toISOString(),
      coachName: 'Test Coach', businessName: clubB.business.name,
    });
    expect(summary.feedback.map(item => item.id)).toEqual([rows.other.id, rows.noGoal.id, rows.goal.id]);
    expect(summary.feedback[2]).toEqual({
      id: rows.goal.id, bookingId: rows.goal.bookingId, participantId: rows.goal.participantId,
      business: { name: clubA.business.name, slug: clubA.business.slug }, serviceName: 'Private tennis', sport: 'Tennis',
      coachName: 'Test Coach', authorRole: 'COACH', sessionStartAt: sg('2026-09-29T10:00').toISOString(),
      timezone: 'Asia/Singapore', summary: 'Session notes', strengths: '', focusAreas: '',
      nextGoal: 'Hold the continental grip', sharedAt: sg('2026-09-29T13:00').toISOString(), editedAt: null, viewed: false,
    });
    expect(summary.filters.clubs).toHaveLength(2);
    expect(summary.filters.clubs).toEqual(expect.arrayContaining([
      { slug: clubA.business.slug, name: clubA.business.name }, { slug: clubB.business.slug, name: clubB.business.name },
    ]));
    expect(summary.filters.coaches).toEqual(['Test Coach']);
    expect(summary.filters.sports).toEqual(['Badminton', 'Tennis']);

    const serialized = JSON.stringify(summary);
    for (const hidden of ['INTERNAL', 'clubNote', 'Secret Author Name', 'Private goal', 'Cancelled goal', 'Left goal']) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it('keeps a streak alive through the current week and ends it after an empty week', async () => {
    await scenario();
    const at = async (iso: string) => (await buildProgressSummary(learner.id, {}, sg(iso))).stats;
    expect(await at('2026-10-21T12:00')).toMatchObject({ currentStreakWeeks: 3, longestStreakWeeks: 4, upcoming: 0 });
    expect(await at('2026-10-14T12:00')).toMatchObject({ upcoming: 1 });
    // Monday 26 October starts a new ISO week: the last attended week is now two weeks back.
    expect(await at('2026-10-26T00:30')).toMatchObject({ currentStreakWeeks: 0, longestStreakWeeks: 4, upcoming: 0 });
    // Sunday 18 October 23:30 in Singapore is still the week of the 13th.
    expect(await at('2026-10-18T23:30')).toMatchObject({ currentStreakWeeks: 3 });
  });

  it('applies club, coach and sport filters to every figure while listing every filter option', async () => {
    const rows = await scenario();
    const now = sg('2026-10-14T12:00');

    const clubOnly = await buildProgressSummary(learner.id, { businessSlug: clubA.business.slug }, now);
    expect(clubOnly.stats).toMatchObject({ attended: 7, booked: 10, clubs: 1, coaches: 1, attendanceRate: 7 / 8, currentStreakWeeks: 3 });
    expect(clubOnly.currentGoal?.text).toBe('Hold the continental grip');
    expect(clubOnly.feedback.map(item => item.id)).toEqual([rows.noGoal.id, rows.goal.id]);
    expect(clubOnly.filters.clubs).toHaveLength(2);

    const sport = await buildProgressSummary(learner.id, { sport: 'BADMINTON' }, now);
    expect(sport.stats).toMatchObject({ attended: 1, booked: 1, clubs: 1, upcoming: 0 });
    expect(sport.feedback.map(item => item.id)).toEqual([rows.other.id]);

    const coach = await buildProgressSummary(learner.id, { coach: 'test coach' }, now);
    expect(coach.stats.attended).toBe(8);

    const none = await buildProgressSummary(learner.id, { businessSlug: 'no-such-club' }, now);
    expect(none.stats).toEqual({
      attended: 0, booked: 0, upcoming: 0, hoursOnCourt: 0, currentStreakWeeks: 0, longestStreakWeeks: 0,
      clubs: 0, coaches: 0, lastAttendedAt: null, attendanceRate: null,
    });
    expect(none.currentGoal).toBeNull();
    expect(none.feedback).toEqual([]);
    expect(none.filters.sports).toEqual(['Badminton', 'Tennis']);
  });

  it('serves only the student’s own progress through a strict account route', async () => {
    await scenario();
    const intruder = await createAccount(clubA, { name: 'Other Learner' });
    await place(clubA, '2026-09-30T10:00', 'PRESENT', { user: intruder });

    const response = await request(app).get('/api/account/progress').set('Cookie', learnerCookie).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['currentGoal', 'feedback', 'filters', 'monthly', 'stats']);
    expect(response.body.stats).toMatchObject({ attended: 8, booked: 11, hoursOnCourt: 8, clubs: 2 });
    expect(response.body.monthly).toHaveLength(6);
    expect(JSON.stringify(response.body)).not.toContain('INTERNAL');

    const filtered = await request(app).get('/api/account/progress')
      .query({ businessSlug: clubB.business.slug }).set('Cookie', learnerCookie).expect(200);
    expect(filtered.body.stats.attended).toBe(1);
    await request(app).get('/api/account/progress').query({ club: 'x' }).set('Cookie', learnerCookie).expect(400);
    await request(app).get('/api/account/progress').query({ sport: ['a', 'b'] }).set('Cookie', learnerCookie).expect(400);

    await request(app).get('/api/account/progress').expect(401);
    await request(app).get('/api/account/progress').set('Cookie', clubA.coachCookie).expect(403);
    await request(app).get('/api/account/progress').set('Cookie', clubA.cookie).expect(403);
    const intruderCookie = (await createSession(clubA, intruder.id)).cookie;
    const theirs = await request(app).get('/api/account/progress').set('Cookie', intruderCookie).expect(200);
    expect(theirs.body.stats).toMatchObject({ attended: 1, booked: 1 });
    expect(theirs.body.feedback).toEqual([]);
  });

  it('records the first view only of the caller’s own shared feedback', async () => {
    const rows = await scenario();
    const viewed = (id: string, cookie = learnerCookie, body: object = {}) =>
      request(app).post(`/api/account/feedback/${id}/viewed`).set('Cookie', cookie).send(body);

    await viewed(rows.goal.id).expect(200, { ok: true });
    const first = await prisma.sessionFeedback.findUniqueOrThrow({ where: { id: rows.goal.id } });
    expect(first.firstViewedAt).toBeInstanceOf(Date);
    await viewed(rows.goal.id).expect(200, { ok: true });
    expect((await prisma.sessionFeedback.findUniqueOrThrow({ where: { id: rows.goal.id } })).firstViewedAt)
      .toEqual(first.firstViewedAt);

    for (const hidden of [rows.draft.id, rows.hiddenCancelled.id, rows.hiddenPlace.id, randomUUID()]) {
      await viewed(hidden).expect(404);
    }
    await viewed(rows.noGoal.id, learnerCookie, { at: 'now' }).expect(400);

    const other = await createAccount(clubA, { name: 'Nosy Learner' });
    const otherCookie = (await createSession(clubA, other.id)).cookie;
    await viewed(rows.noGoal.id, otherCookie).expect(404);
    await viewed(rows.noGoal.id, clubA.coachCookie).expect(403);
    expect((await prisma.sessionFeedback.findUniqueOrThrow({ where: { id: rows.noGoal.id } })).firstViewedAt).toBeNull();

    const summary = await request(app).get('/api/account/progress').set('Cookie', learnerCookie).expect(200);
    const byId = new Map(summary.body.feedback.map((item: { id: string; viewed: boolean }) => [item.id, item.viewed]));
    expect(byId.get(rows.goal.id)).toBe(true);
    expect(byId.get(rows.noGoal.id)).toBe(false);
  });
});
