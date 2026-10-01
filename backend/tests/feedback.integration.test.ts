import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { CURRENT_PRIVACY_POLICY_VERSION, DEFAULT_GUARDIAN_PERMISSIONS } from '../src/children-policy.js';
import { createBookings } from '../src/scheduling.js';
import {
  createAccount, createSession, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('coach feedback on a learner place', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => { tenants = new TestTenants(); f = await tenants.fixture(); });
  afterEach(async () => { await tenants.cleanup(); });

  const feedbackPath = (bookingId: string, participantId: string) =>
    `/api/bookings/${bookingId}/participants/${participantId}/feedback`;

  /** A lesson that started ten minutes ago, with its learner marked present. */
  async function startedLesson(options: { fixture?: Fixture; hoursFromStart?: number; attendance?: string } = {}) {
    const fixture = options.fixture ?? f;
    const student = await createStudent(fixture, { name: 'Feedback Learner' });
    const created = await createBookings(fixture.business.id, inputFor(fixture, {
      studentId: student.id, student: undefined,
      startAt: fixture.starts.plus({ hours: options.hoursFromStart ?? 0 }).toISO()!,
    }));
    const booking = created.bookings[0]!;
    const startAt = new Date(Date.now() - 10 * 60_000);
    await prisma.booking.update({
      where: { id: booking.id },
      data: { startAt, endAt: new Date(startAt.getTime() + 3_600_000), status: 'CONFIRMED', coachAcceptance: 'NOT_REQUIRED' },
    });
    const participantId = booking.participants[0]!.id;
    await prisma.participant.update({ where: { id: participantId }, data: { attendance: options.attendance ?? 'PRESENT' } });
    return { bookingId: booking.id, participantId, student };
  }

  async function staffCookie(permissions: string[], name = 'Desk Staff') {
    const suffix = randomUUID().replaceAll('-', '');
    const user = await prisma.user.create({ data: {
      name, legalName: name, username: `staff_${suffix.slice(0, 18)}`, email: `staff-${suffix}@example.test`,
      passwordHash: 'not-used', accountType: 'STUDENT',
    } });
    tenants.ownUser(user.id);
    const access = await prisma.clubStaffAccess.create({ data: {
      businessId: f.business.id, userId: user.id, invitedByUserId: f.user.id, accessLevel: 'CUSTOM', permissions,
    } });
    const token = randomBytes(32).toString('base64url');
    await prisma.authSession.create({ data: {
      id: createHash('sha256').update(token).digest('hex'), userId: user.id, activeStaffAccessId: access.id,
      recentAuthAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
    } });
    return `${config.sessionCookie}=${token}`;
  }

  const feedbackAlerts = (userId: string) =>
    prisma.accountNotification.findMany({ where: { userId, type: 'FEEDBACK_SHARED' } });

  it('lets the coach draft, the club share once, and alerts the self-managed learner exactly once', async () => {
    const lesson = await startedLesson();

    const draft = await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'PRIVATE', summary: '  Great footwork today.  ', clubNote: 'Parent asked about squads' }).expect(200);
    expect(draft.body).toMatchObject({
      bookingId: lesson.bookingId, participantId: lesson.participantId, studentId: lesson.student.id,
      studentName: 'Feedback Learner', authorName: 'Test Coach', authorRole: 'COACH', editedByName: null,
      visibility: 'PRIVATE', summary: 'Great footwork today.', strengths: '', focusAreas: '', nextGoal: '',
      clubNote: 'Parent asked about squads', sharedAt: null, editedAt: null, viewedAt: null,
    });
    expect(Object.keys(draft.body).sort()).toEqual([
      'authorName', 'authorRole', 'bookingId', 'clubNote', 'createdAt', 'editedAt', 'editedByName', 'focusAreas',
      'id', 'nextGoal', 'participantId', 'sharedAt', 'strengths', 'studentId', 'studentName', 'summary', 'viewedAt',
      'visibility',
    ]);
    expect(await feedbackAlerts(lesson.student.userId!)).toHaveLength(0);

    const list = await request(app).get(`/api/bookings/${lesson.bookingId}/feedback`).set('Cookie', f.cookie).expect(200);
    expect(list.body).toEqual({ feedback: [draft.body], canWrite: true });

    const shared = await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', f.cookie)
      .send({ visibility: 'SHARED', nextGoal: 'Split step before every return' }).expect(200);
    expect(shared.body).toMatchObject({
      id: draft.body.id, authorName: 'Test Coach', authorRole: 'COACH', editedByName: f.business.name,
      visibility: 'SHARED', summary: 'Great footwork today.', nextGoal: 'Split step before every return',
      clubNote: 'Parent asked about squads',
    });
    expect(shared.body.sharedAt).toEqual(expect.any(String));
    expect(shared.body.editedAt).toEqual(expect.any(String));
    const alerts = await feedbackAlerts(lesson.student.userId!);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      businessId: f.business.id, bookingId: lesson.bookingId, title: 'New coach feedback', actionNeeded: false,
    });
    expect(alerts[0]!.message).toContain(f.business.name);
    expect(alerts[0]!.message).not.toContain('Parent asked');

    // Withdrawing and re-sharing keeps the first-share instant and does not alert again.
    await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'PRIVATE' }).expect(200);
    const again = await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'SHARED', strengths: 'Volleys' }).expect(200);
    expect(again.body).toMatchObject({ sharedAt: shared.body.sharedAt, editedByName: 'Test Coach', strengths: 'Volleys' });
    expect(await feedbackAlerts(lesson.student.userId!)).toHaveLength(1);
    expect(await prisma.sessionFeedback.findUniqueOrThrow({ where: { id: draft.body.id } }))
      .toMatchObject({ authorUserId: f.coachUser.id, businessId: f.business.id });
  });

  it('names the coach in the first-share alert when the coach shares it', async () => {
    const lesson = await startedLesson();
    await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'SHARED', summary: 'Good session' }).expect(200);
    const [alert] = await feedbackAlerts(lesson.student.userId!);
    expect(alert!.message).toMatch(/^Test Coach shared feedback on your Private tennis session on /);
  });

  it('enforces the lesson, attendance and content write rules', async () => {
    const future = await startedLesson();
    await prisma.booking.update({
      where: { id: future.bookingId },
      data: { startAt: new Date(Date.now() + 3_600_000), endAt: new Date(Date.now() + 7_200_000) },
    });
    const early = await request(app).put(feedbackPath(future.bookingId, future.participantId)).set('Cookie', f.cookie)
      .send({ visibility: 'PRIVATE', summary: 'Too soon' }).expect(400);
    expect(early.body.error).toBe('Feedback can only be written once the lesson has started');
    expect((await request(app).get(`/api/bookings/${future.bookingId}/feedback`).set('Cookie', f.cookie).expect(200)).body)
      .toEqual({ feedback: [], canWrite: false });

    const lesson = await startedLesson({ hoursFromStart: 2 });
    const put = (body: object, cookie = f.cookie) =>
      request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', cookie).send(body);

    for (const attendance of ['UNMARKED', 'ABSENT', 'EXCUSED']) {
      await prisma.participant.update({ where: { id: lesson.participantId }, data: { attendance } });
      const response = await put({ visibility: 'PRIVATE', summary: 'Absent learner' }).expect(400);
      expect(response.body.error).toBe('Mark this learner present or late before writing feedback');
    }
    await prisma.participant.update({ where: { id: lesson.participantId }, data: { attendance: 'LATE' } });

    // Sharing needs learner-facing content; an internal note alone is not enough.
    const empty = await put({ visibility: 'SHARED', clubNote: 'Internal only', summary: '   ' }).expect(400);
    expect(empty.body.error).toBe('Add a summary, strengths, focus areas or a next goal before sharing feedback');

    for (const [field, limit] of [['summary', 2000], ['strengths', 600], ['focusAreas', 600], ['nextGoal', 300], ['clubNote', 1000]] as const) {
      await put({ visibility: 'PRIVATE', [field]: 'x'.repeat(limit + 1) }).expect(400);
      await put({ visibility: 'PRIVATE', [field]: 'x'.repeat(limit) }).expect(200);
    }
    for (const body of [
      { visibility: 'SHARED', summary: 'ok', rating: 5 },
      { summary: 'Missing visibility' },
      { visibility: 'PUBLIC', summary: 'Unknown visibility' },
      { visibility: 'PRIVATE', summary: 42 },
    ]) await put(body).expect(400);
    await put({ visibility: 'SHARED', focusAreas: 'Backhand' }).expect(200);
    expect(await prisma.sessionFeedback.count({ where: { participantId: lesson.participantId } })).toBe(1);

    await prisma.booking.update({ where: { id: lesson.bookingId }, data: { status: 'PENDING', coachAcceptance: 'PENDING' } });
    const pending = await put({ visibility: 'PRIVATE', summary: 'Pending' }).expect(400);
    expect(pending.body.error).toBe('Feedback can only be written for a confirmed or completed lesson');
    await prisma.booking.update({ where: { id: lesson.bookingId }, data: { status: 'CANCELLED', coachAcceptance: 'NOT_REQUIRED' } });
    await put({ visibility: 'PRIVATE', summary: 'Cancelled' }).expect(400);
    const listCancelled = await request(app).get(`/api/bookings/${lesson.bookingId}/feedback`).set('Cookie', f.cookie).expect(200);
    expect(listCancelled.body.canWrite).toBe(false);
    await prisma.booking.update({ where: { id: lesson.bookingId }, data: { status: 'COMPLETED' } });
    await put({ visibility: 'PRIVATE', summary: 'Completed is fine' }).expect(200);

    // A cancelled place, or a place from another booking, is not this lesson's learner.
    const other = await startedLesson({ hoursFromStart: 4 });
    await request(app).put(feedbackPath(lesson.bookingId, other.participantId)).set('Cookie', f.cookie)
      .send({ visibility: 'PRIVATE', summary: 'Wrong booking' }).expect(404);
    await prisma.participant.update({ where: { id: other.participantId }, data: { cancelledAt: new Date() } });
    await request(app).put(feedbackPath(other.bookingId, other.participantId)).set('Cookie', f.cookie)
      .send({ visibility: 'PRIVATE', summary: 'Cancelled place' }).expect(404);
  });

  it('keeps feedback inside the coach lane, the named permission and the tenant', async () => {
    const lesson = await startedLesson();
    const body = { visibility: 'PRIVATE', summary: 'Scoped', clubNote: 'Staff only' };

    const otherCoach = await createAccount(f, { name: 'Other Coach', accountType: 'COACH' });
    const otherInstructor = await prisma.instructor.create({
      data: { businessId: f.business.id, name: otherCoach.name, email: otherCoach.email, initials: 'OC' },
    });
    const otherMembership = await prisma.membership.create({
      data: { businessId: f.business.id, userId: otherCoach.id, instructorId: otherInstructor.id },
    });
    const otherCoachCookie = (await createSession(f, otherCoach.id, otherMembership.id)).cookie;
    await request(app).get(`/api/bookings/${lesson.bookingId}/feedback`).set('Cookie', otherCoachCookie).expect(403);
    await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', otherCoachCookie)
      .send(body).expect(403);

    const foreign = await tenants.fixture();
    for (const cookie of [foreign.cookie, foreign.coachCookie]) {
      await request(app).get(`/api/bookings/${lesson.bookingId}/feedback`).set('Cookie', cookie).expect(404);
      await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', cookie).send(body).expect(404);
    }

    const noBookings = await staffCookie(['STUDENTS_VIEW']);
    await request(app).get(`/api/bookings/${lesson.bookingId}/feedback`).set('Cookie', noBookings).expect(403);
    const viewer = await staffCookie(['BOOKINGS_VIEW']);
    await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', viewer).send(body).expect(403);
    expect((await request(app).get(`/api/bookings/${lesson.bookingId}/feedback`).set('Cookie', viewer).expect(200)).body)
      .toEqual({ feedback: [], canWrite: false });

    const manager = await staffCookie(['BOOKINGS_MANAGE'], 'Front Desk Manager');
    const written = await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', manager)
      .send(body).expect(200);
    expect(written.body).toMatchObject({ authorRole: 'STAFF', authorName: 'Front Desk Manager', clubNote: 'Staff only' });
    const coachView = await request(app).get(`/api/bookings/${lesson.bookingId}/feedback`).set('Cookie', f.coachCookie).expect(200);
    expect(coachView.body).toEqual({ feedback: [written.body], canWrite: true });
    expect(await prisma.sessionFeedback.count({ where: { businessId: foreign.business.id } })).toBe(0);
  });

  it('lists feedback only for active places, never another booking', async () => {
    const student = await createStudent(f, { name: 'Group Ada' });
    const second = await createStudent(f, { name: 'Group Ben' });
    const group = await prisma.service.create({ data: {
      businessId: f.business.id, name: 'Group drills', type: 'GROUP', capacity: 4, duration: 60, price: 3000,
      noticeHours: 0, locations: { create: {
        locationId: f.location.id, price: 3000, duration: 60, instructors: { create: { instructorId: f.instructor.id } },
      } },
    } });
    for (const person of [student, second]) {
      await createBookings(f.business.id, inputFor(f, { serviceId: group.id, studentId: person.id, student: undefined }));
    }
    const booking = await prisma.booking.findFirstOrThrow({ where: { serviceId: group.id }, include: { participants: { include: { student: true } } } });
    const startAt = new Date(Date.now() - 5 * 60_000);
    await prisma.booking.update({ where: { id: booking.id }, data: { startAt, endAt: new Date(startAt.getTime() + 3_600_000) } });
    await prisma.participant.updateMany({ where: { bookingId: booking.id }, data: { attendance: 'PRESENT' } });
    const [ada, ben] = ['Group Ada', 'Group Ben'].map(name => booking.participants.find(p => p.student.name === name)!);
    for (const participant of [ada!, ben!]) {
      await request(app).put(feedbackPath(booking.id, participant.id)).set('Cookie', f.coachCookie)
        .send({ visibility: 'PRIVATE', summary: `Notes for ${participant.student.name}` }).expect(200);
    }
    await prisma.participant.update({ where: { id: ben!.id }, data: { cancelledAt: new Date() } });
    const list = await request(app).get(`/api/bookings/${booking.id}/feedback`).set('Cookie', f.coachCookie).expect(200);
    expect(list.body.feedback.map((item: { studentName: string }) => item.studentName)).toEqual(['Group Ada']);
  });

  it('alerts each consenting guardian with booking authority, and never for a private draft', async () => {
    const adult = async (name: string) => {
      const user = await createAccount(f, { name });
      await prisma.user.update({
        where: { id: user.id }, data: { dateOfBirth: new Date('1985-03-01T00:00:00.000Z'), emailVerifiedAt: new Date() },
      });
      return { user, ...(await createSession(f, user.id)) };
    };
    const [primary, coParent, noBookings, staleConsent] = await Promise.all([
      adult('Primary Guardian'), adult('Co Guardian'), adult('Profile Only Guardian'), adult('Stale Guardian'),
    ]);
    // The database requires a managed child to hold consenting authority, so
    // the child and every link are created as one aggregate.
    const identity = randomUUID().replaceAll('-', '');
    const child = await prisma.$transaction(async tx => {
      const created = await tx.user.create({ data: {
        name: 'Kid Rally', legalName: 'Kid Rally Legal', username: `kid_${identity.slice(0, 18)}`,
        dateOfBirth: new Date('2016-04-04T00:00:00.000Z'), email: null, passwordHash: null,
        accountType: 'STUDENT', accountControl: 'GUARDIAN_MANAGED', accountStatus: 'ACTIVE',
        profileVisibility: 'PRIVATE', phone: '', parentName: '',
      } });
      const links: Array<[string, readonly string[], string]> = [
        [primary.user.id, DEFAULT_GUARDIAN_PERMISSIONS, CURRENT_PRIVACY_POLICY_VERSION],
        [coParent.user.id, DEFAULT_GUARDIAN_PERMISSIONS, CURRENT_PRIVACY_POLICY_VERSION],
        [noBookings.user.id, DEFAULT_GUARDIAN_PERMISSIONS.filter(permission => permission !== 'BOOKINGS_MANAGE'), CURRENT_PRIVACY_POLICY_VERSION],
        [staleConsent.user.id, DEFAULT_GUARDIAN_PERMISSIONS, '2025-01-01'],
      ];
      for (const [guardianUserId, permissions, policyVersion] of links) {
        const link = await tx.guardianChildLink.create({ data: {
          guardianUserId, childUserId: created.id, relationshipType: 'PARENT', permissions: [...permissions],
        } });
        await tx.childConsentRecord.create({ data: {
          linkId: link.id, guardianUserId, childUserId: created.id, eventType: 'GRANTED',
          relationshipType: 'PARENT', permissions: link.permissions, privacyPolicyVersion: policyVersion,
        } });
      }
      return created;
    });
    tenants.ownUser(child.id);

    const booked = await request(app).post(`/api/family/children/${child.id}/bookings`).set('Cookie', primary.cookie).send({
      businessSlug: f.business.slug, serviceId: f.service.id, instructorId: f.instructor.id,
      locationId: f.location.id, startAt: f.starts.toISO(),
    }).expect(201);
    const bookingId = booked.body.bookings[0].id as string;
    const participantId = booked.body.bookings[0].participants[0].id as string;
    const startAt = new Date(Date.now() - 15 * 60_000);
    await prisma.booking.update({ where: { id: bookingId }, data: { startAt, endAt: new Date(startAt.getTime() + 3_600_000) } });
    await request(app).patch(`/api/bookings/${bookingId}/participants/${participantId}`).set('Cookie', f.coachCookie)
      .send({ attendance: 'PRESENT' }).expect(200);

    await request(app).put(feedbackPath(bookingId, participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'PRIVATE', summary: 'Draft for Kid' }).expect(200);
    const everyone = [primary, coParent, noBookings, staleConsent].map(guardian => guardian.user.id);
    expect(await prisma.accountNotification.count({ where: { userId: { in: [...everyone, child.id] }, type: 'FEEDBACK_SHARED' } })).toBe(0);

    await request(app).put(feedbackPath(bookingId, participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'SHARED' }).expect(200);
    const alerts = await prisma.accountNotification.findMany({
      where: { userId: { in: [...everyone, child.id] }, type: 'FEEDBACK_SHARED' }, orderBy: { userId: 'asc' },
    });
    expect(alerts.map(alert => alert.userId).sort()).toEqual([primary.user.id, coParent.user.id].sort());
    for (const alert of alerts) {
      expect(alert).toMatchObject({ title: 'New coach feedback for Kid Rally', bookingId, businessId: f.business.id });
      expect(alert.message).toContain("Kid Rally's Private tennis session");
    }

    // A later re-share is not a first share.
    await request(app).put(feedbackPath(bookingId, participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'PRIVATE' }).expect(200);
    await request(app).put(feedbackPath(bookingId, participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'SHARED' }).expect(200);
    expect(await prisma.accountNotification.count({ where: { userId: { in: everyone }, type: 'FEEDBACK_SHARED' } })).toBe(2);
  });

  it('shares feedback for an unlinked historical student without inventing an alert recipient', async () => {
    const lesson = await startedLesson();
    await prisma.student.update({ where: { id: lesson.student.id }, data: { userId: null } });
    const shared = await request(app).put(feedbackPath(lesson.bookingId, lesson.participantId)).set('Cookie', f.coachCookie)
      .send({ visibility: 'SHARED', summary: 'Shared' }).expect(200);
    expect(shared.body).toMatchObject({ studentName: 'Feedback Learner', visibility: 'SHARED' });
    expect(await prisma.accountNotification.count({ where: { bookingId: lesson.bookingId, type: 'FEEDBACK_SHARED' } })).toBe(0);
  });
});
