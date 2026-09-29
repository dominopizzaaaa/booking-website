import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import bcrypt from 'bcryptjs';
import { createBookings } from '../src/scheduling.js';
import {
  createAccount, createSession, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type Person = { id: string; name: string; username: string; email: string; cookie: string };

describe.sequential('Chat safeguarding', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => {
    await tenants.cleanup();
  });

  async function person(
    name: string,
    accountType: 'STUDENT' | 'COACH' = 'STUDENT',
    passwordHash = 'not-used-by-this-test',
  ): Promise<Person> {
    const account = await createAccount(club, { name, accountType, passwordHash });
    const { cookie } = await createSession(club, account.id);
    return { id: account.id, name, username: account.username, email: account.email, cookie };
  }

  async function accountThread(first: Person, second: Person) {
    const opened = await request(app).post('/api/chats/accounts').set('Cookie', first.cookie)
      .send({ username: second.username }).expect(200);
    return opened.body.threadId as string;
  }

  async function send(threadId: string, author: Person | { cookie: string }, body: string) {
    return request(app).post(`/api/chats/${threadId}/messages`).set('Cookie', author.cookie)
      .send({ body }).expect(201);
  }

  function report(
    threadId: string, reporter: Person,
    input: { category: string; description?: string; messageId?: string },
  ) {
    return request(app).post(`/api/chats/${threadId}/reports`).set('Cookie', reporter.cookie).send(input);
  }

  async function sessionFor(student: Person, starts = club.starts) {
    const result = await createBookings(club.business.id, inputFor(club, {
      startAt: starts.toISO()!, student: { name: student.name, email: student.email },
    }), { studentUserId: student.id });
    const booking = result.bookings[0];
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { bookingId: booking.id } });
    return { booking, thread };
  }

  async function staffCookie(permissions: string[]) {
    const staff = await person(`Safety staff ${permissions.join('-') || 'none'}`);
    const access = await prisma.clubStaffAccess.create({
      data: {
        businessId: club.business.id, userId: staff.id, accessLevel: 'CUSTOM', permissions,
        invitedByUserId: club.user.id,
      },
    });
    const session = await createSession(club, staff.id);
    await prisma.authSession.update({
      where: { id: session.session.id },
      data: { activeMembershipId: null, activeStaffAccessId: access.id },
    });
    return { ...staff, cookie: session.cookie, accessId: access.id };
  }

  async function adminCookie() {
    const operator = config.adminOperators[0];
    if (!operator) throw new Error('Named test operator is not configured');
    const login = await request(app).post('/api/admin/login')
      .send({ email: operator.email, password: config.adminPassword }).expect(200);
    return login.headers['set-cookie'];
  }

  async function waitUntilBlockedBy(blockingPid: number) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE ${blockingPid} = ANY(pg_blocking_pids(pid))
            AND query LIKE '%ClubStaffAccess%'
        ) AS "waiting"
      `;
      if (state?.waiting) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Safeguarding update did not wait for the staff-access lock');
  }

  it('authorizes reports narrowly, snapshots evidence, and enforces immutable report and audit history', async () => {
    const reporter = await person('Teen Safety Reporter');
    const subject = await person('Reported Account');
    const outsider = await person('Safety Outsider');
    const other = await person('Other Conversation Member');
    const threadId = await accountThread(reporter, subject);
    const message = (await send(threadId, subject, 'A message that must remain preserved.')).body.message;
    const otherThreadId = await accountThread(outsider, other);
    const otherMessage = (await send(otherThreadId, other, 'Different thread')).body.message;
    await report(threadId, outsider, { category: 'HARASSMENT', messageId: message.id }).expect(404);
    await report(threadId, subject, { category: 'HARASSMENT', messageId: message.id }).expect(400);
    // Use a fresh participant so the focused authorization matrix cannot
    // accidentally spend one account's report-rate budget before success.
    const systemReporter = await person('System Message Reporter');
    const systemThreadId = await accountThread(systemReporter, subject);
    const ownSystemMessage = await prisma.chatMessage.findFirstOrThrow({
      where: { threadId: systemThreadId, kind: 'SYSTEM' }, select: { id: true },
    });
    await report(systemThreadId, systemReporter, {
      category: 'HARASSMENT', messageId: ownSystemMessage.id,
    }).expect(400);
    await report(threadId, reporter, { category: 'HARASSMENT', messageId: otherMessage.id }).expect(400);
    await report(threadId, reporter, {
      category: 'HARASSMENT', messageId: message.id, unexpected: 'not accepted',
    } as never).expect(400);
    const teenDob = '2011-10-01';
    await prisma.user.update({
      where: { id: subject.id },
      data: { dateOfBirth: new Date(`${teenDob}T00:00:00.000Z`), profileVisibility: 'PRIVATE' },
    });
    const beforeReport = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
      .set('Cookie', reporter.cookie).expect(200);
    expect(beforeReport.body.messages.find((item: { id: string }) => item.id === message.id)).toMatchObject({
      canReport: true, reportedByViewer: false,
    });

    const created = await report(threadId, reporter, {
      category: 'SPAM_OTHER', messageId: message.id, description: 'Please review this contact.',
    }).expect(201);
    expect(created.body.report).toMatchObject({
      id: expect.any(String), category: 'SPAM_OTHER', status: 'OPEN', childInvolved: true,
      createdAt: expect.any(String),
    });
    expect(created.body.report.severity).not.toBe('LOW');

    const duplicates = await Promise.all(Array.from({ length: 4 }, () => report(threadId, reporter, {
      category: 'SPAM_OTHER', messageId: message.id, description: 'Please review this contact.',
    })));
    for (const duplicate of duplicates) {
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.report.id).toBe(created.body.report.id);
    }

    const stored = await prisma.chatSafetyReport.findUniqueOrThrow({
      where: { id: created.body.report.id }, include: { auditEvents: true },
    });
    expect(stored).toMatchObject({
      threadId, messageId: message.id, reporterUserId: reporter.id, subjectUserId: subject.id,
      category: 'SPAM_OTHER', status: 'OPEN', childInvolved: true, description: 'Please review this contact.',
    });
    expect(stored.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    const evidenceText = JSON.stringify(stored.evidence);
    expect(evidenceText).toContain('A message that must remain preserved.');
    expect(evidenceText).not.toContain(teenDob);
    expect(stored.auditEvents).toHaveLength(1);
    expect(stored.auditEvents[0]).toMatchObject({ action: 'REPORT_CREATED', actorUserId: reporter.id });
    expect(await prisma.chatSafetyReport.count({
      where: { reporterUserId: reporter.id, threadId, messageId: message.id, category: 'SPAM_OTHER' },
    })).toBe(1);
    const afterReport = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
      .set('Cookie', reporter.cookie).expect(200);
    expect(afterReport.body.messages.find((item: { id: string }) => item.id === message.id)).toMatchObject({
      canReport: true, reportedByViewer: true,
    });

    await expect(prisma.chatSafetyReport.update({
      where: { id: stored.id }, data: { description: 'rewritten evidence' },
    })).rejects.toThrow();
    await expect(prisma.chatSafetyReport.delete({ where: { id: stored.id } })).rejects.toThrow();
    await expect(prisma.chatSafetyAuditEvent.update({
      where: { id: stored.auditEvents[0]!.id }, data: { note: 'rewritten audit' },
    })).rejects.toThrow();
    await expect(prisma.chatSafetyAuditEvent.delete({
      where: { id: stored.auditEvents[0]!.id },
    })).rejects.toThrow();
  });

  it('blocks both directions of an ACCOUNT chat and its proposals without changing SESSION chat', async () => {
    const student = await person('Blocking Student');
    const threadId = (await request(app).post('/api/chats/accounts').set('Cookie', student.cookie)
      .send({ username: club.user.username }).expect(200)).body.threadId as string;
    await request(app).post(`/api/chats/${threadId}/coach`).set('Cookie', club.cookie)
      .send({ membershipId: club.coachMembership.id }).expect(200);
    await send(threadId, student, 'Before the block');

    const blocked = await request(app).post(`/api/chats/${threadId}/block`).set('Cookie', student.cookie)
      .send({}).expect(200);
    expect(blocked.body.thread).toMatchObject({
      id: threadId, messaging: { blocked: true, blockedByViewer: true, canBlock: false, canUnblock: true },
      blockTarget: { name: club.user.name, username: club.user.username },
    });
    const targetView = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
      .set('Cookie', club.cookie).expect(200);
    expect(targetView.body).toMatchObject({
      safety: { messagingBlocked: true, blockedByViewer: false, reason: 'ACCOUNT_CHAT_RESTRICTED' },
    });
    expect(await prisma.chatAccountBlock.count()).toBe(1);

    for (const actor of [student, { cookie: club.cookie }]) {
      const denied = await request(app).post(`/api/chats/${threadId}/messages`).set('Cookie', actor.cookie)
        .send({ body: 'Blocked direct message' }).expect(403);
      expect(denied.body.reason).toBe(actor === student ? 'BLOCKED' : 'ACCOUNT_CHAT_RESTRICTED');
    }
    await request(app).post(`/api/chats/${threadId}/coach`).set('Cookie', club.cookie)
      .send({ membershipId: club.coachMembership.id }).expect(403);
    await request(app).post(`/api/chats/${threadId}/proposals`).set('Cookie', student.cookie).send({
      businessSlug: club.business.slug, serviceId: club.service.id, locationId: club.location.id,
      startAt: club.starts.plus({ days: 1 }).toISO(), message: '',
    }).expect(403);

    const { thread: sessionThread } = await sessionFor(student, club.starts.plus({ days: 2 }));
    await request(app).post(`/api/chats/${sessionThread.id}/messages`).set('Cookie', student.cookie)
      .send({ body: 'Session chat remains available.' }).expect(201);
    await request(app).post(`/api/chats/${sessionThread.id}/messages`).set('Cookie', club.cookie)
      .send({ body: 'The club can still reply in session.' }).expect(201);
    await request(app).post(`/api/chats/${sessionThread.id}/block`).set('Cookie', student.cookie)
      .send({}).expect(400);

    await request(app).delete(`/api/chats/${threadId}/block`).set('Cookie', club.cookie)
      .send({}).expect(403);
    const unblocked = await request(app).delete(`/api/chats/${threadId}/block`).set('Cookie', student.cookie)
      .send({}).expect(200);
    expect(unblocked.body.thread.messaging).toMatchObject({ blocked: false, canBlock: true, canUnblock: false });
    await send(threadId, club, 'Direct chat restored');
  });

  it('prevents a club-assigned coach from bypassing a person-to-person block', async () => {
    const student = await person('Assigned Coach Block Student');
    const coach: Person = {
      id: club.coachUser.id, name: club.coachUser.name, username: club.coachUser.username,
      email: club.coachUser.email, cookie: club.coachCookie,
    };
    const directThreadId = await accountThread(student, coach);
    await request(app).post(`/api/chats/${directThreadId}/block`).set('Cookie', student.cookie)
      .send({}).expect(200);

    const clubThreadId = (await request(app).post('/api/chats/accounts').set('Cookie', student.cookie)
      .send({ username: club.user.username }).expect(200)).body.threadId as string;
    await request(app).post(`/api/chats/${clubThreadId}/coach`).set('Cookie', club.cookie)
      .send({ membershipId: club.coachMembership.id }).expect(403);

    await request(app).delete(`/api/chats/${directThreadId}/block`).set('Cookie', student.cookie)
      .send({}).expect(200);
    await request(app).post(`/api/chats/${clubThreadId}/coach`).set('Cookie', club.cookie)
      .send({ membershipId: club.coachMembership.id }).expect(200);
    await request(app).post(`/api/chats/${directThreadId}/block`).set('Cookie', student.cookie)
      .send({}).expect(200);
    const denied = await request(app).post(`/api/chats/${clubThreadId}/messages`).set('Cookie', coach.cookie)
      .send({ body: 'This assigned-coach bypass must fail.' }).expect(403);
    expect(denied.body.reason).toBe('ACCOUNT_CHAT_RESTRICTED');
    const studentView = await request(app).get(`/api/chats/${clubThreadId}`).query({ contract: 'accounts' })
      .set('Cookie', student.cookie).expect(200);
    expect(studentView.body.safety).toMatchObject({
      messagingBlocked: true, blockedByViewer: true, reason: 'BLOCKED',
    });
  });

  it('gives clubs tenant-scoped, redacted SESSION triage with separate view and review authority', async () => {
    const student = await person('Confidential Reporter');
    const { thread } = await sessionFor(student);
    const coachMessage = (await request(app).post(`/api/chats/${thread.id}/messages`)
      .set('Cookie', club.coachCookie).send({ body: 'Session evidence visible to the club.' }).expect(201)).body.message;
    await report(thread.id, student, { category: 'HARASSMENT' }).expect(400);
    const created = await report(thread.id, student, {
      category: 'HARASSMENT', messageId: coachMessage.id, description: 'Private reporter narrative',
    }).expect(201);
    const reportId = created.body.report.id as string;

    const otherClub = await tenants.fixture();
    const viewer = await staffCookie(['SAFEGUARDING_VIEW']);
    const reviewer = await staffCookie(['SAFEGUARDING_REVIEW']);

    const list = await request(app).get('/api/safeguarding/reports').set('Cookie', viewer.cookie).expect(200);
    expect(list.body.reports.map((item: { id: string }) => item.id)).toContain(reportId);
    const detail = await request(app).get(`/api/safeguarding/reports/${reportId}`)
      .set('Cookie', viewer.cookie).expect(200);
    const clubPayload = JSON.stringify(detail.body);
    expect(clubPayload).toContain('Session evidence visible to the club.');
    for (const secret of [student.name, student.username, student.email, 'Private reporter narrative']) {
      expect(clubPayload).not.toContain(secret);
    }
    expect(detail.body.report).not.toHaveProperty('reporter');
    expect(detail.body.report).not.toHaveProperty('description');
    expect(detail.body.report).not.toHaveProperty('evidenceHash');

    await request(app).patch(`/api/safeguarding/reports/${reportId}`).set('Cookie', viewer.cookie)
      .send({ status: 'IN_REVIEW', assignment: 'SELF', note: 'View-only staff must not mutate.' }).expect(403);
    await request(app).patch(`/api/safeguarding/reports/${reportId}`).set('Cookie', reviewer.cookie)
      .send({ status: 'IN_REVIEW' }).expect(400);
    await request(app).patch(`/api/safeguarding/reports/${reportId}`).set('Cookie', reviewer.cookie)
      .send({ status: 'IN_REVIEW', note: '   ' }).expect(400);
    await request(app).patch(`/api/safeguarding/reports/${reportId}`).set('Cookie', reviewer.cookie)
      .send({ note: 'A note without a material change must not create an audit.' }).expect(400);
    const reviewed = await request(app).patch(`/api/safeguarding/reports/${reportId}`)
      .set('Cookie', reviewer.cookie).send({
        status: 'IN_REVIEW', assignment: 'SELF', note: 'Review started.',
      }).expect(200);
    expect(reviewed.body.report).toMatchObject({ id: reportId, status: 'IN_REVIEW' });
    const stored = await prisma.chatSafetyReport.findUniqueOrThrow({
      where: { id: reportId }, include: { auditEvents: { orderBy: { createdAt: 'asc' } } },
    });
    expect(stored.assignedTo).toBe(reviewer.name);
    expect(stored.assignedClubUserId).toBe(reviewer.id);
    expect(stored.auditEvents.at(-1)).toMatchObject({
      actorKind: 'CLUB_STAFF', actorUserId: reviewer.id, action: 'REPORT_REVIEW_UPDATED',
      fromStatus: 'OPEN', toStatus: 'IN_REVIEW', note: 'Review started.',
    });

    let releaseDowngrade!: () => void;
    const downgradeMayCommit = new Promise<void>(resolve => { releaseDowngrade = resolve; });
    let markGrantLocked!: (pid: number) => void;
    const grantLocked = new Promise<number>(resolve => { markGrantLocked = resolve; });
    const downgrade = prisma.$transaction(async tx => {
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS "pid"`;
      await tx.clubStaffAccess.update({
        where: { id: reviewer.accessId }, data: { permissions: ['SAFEGUARDING_VIEW'] },
      });
      markGrantLocked(connection!.pid);
      await downgradeMayCommit;
    });
    const blockingPid = await grantLocked;
    const staleMutation = request(app).patch(`/api/safeguarding/reports/${reportId}`)
      .set('Cookie', reviewer.cookie).send({
        status: 'REFERRED_TO_PLATFORM', note: 'Must not commit with stale permission.',
      }).then(response => response);
    try {
      await waitUntilBlockedBy(blockingPid);
    } finally {
      releaseDowngrade();
    }
    await downgrade;
    expect((await staleMutation).status).toBe(403);
    const afterDowngrade = await prisma.chatSafetyReport.findUniqueOrThrow({
      where: { id: reportId }, include: { auditEvents: true },
    });
    expect(afterDowngrade.status).toBe('IN_REVIEW');
    expect(afterDowngrade.auditEvents).toHaveLength(stored.auditEvents.length);
    expect(afterDowngrade.assignedClubUserId).toBe(reviewer.id);

    await prisma.clubStaffAccess.update({
      where: { id: reviewer.accessId }, data: { permissions: ['SAFEGUARDING_REVIEW'] },
    });
    await request(app).patch(`/api/staff-access/${reviewer.accessId}`).set('Cookie', club.cookie)
      .send({ accessLevel: 'CUSTOM', permissions: ['SAFEGUARDING_VIEW'] }).expect(200);
    const clearedAfterDowngrade = await prisma.chatSafetyReport.findUniqueOrThrow({
      where: { id: reportId }, include: { auditEvents: { orderBy: { createdAt: 'asc' } } },
    });
    expect(clearedAfterDowngrade).toMatchObject({ assignedClubUserId: null, assignedTo: null });
    expect(clearedAfterDowngrade.auditEvents.at(-1)).toMatchObject({
      action: 'ASSIGNMENT_CLEARED_PERMISSION_REMOVED', actorUserId: club.user.id,
    });
    await expect(prisma.chatSafetyReport.update({
      where: { id: reportId }, data: { assignedClubUserId: reviewer.id, assignedTo: reviewer.name },
    })).rejects.toThrow();
    await expect(prisma.chatSafetyReport.update({
      where: { id: reportId }, data: { status: 'ACTION_TAKEN' },
    })).rejects.toThrow(/same-transaction audit event/);

    const reassigned = await request(app).patch(`/api/safeguarding/reports/${reportId}`)
      .set('Cookie', club.cookie).send({
        status: 'IN_REVIEW', assignment: 'SELF', note: 'Institutional club accepted ownership.',
      }).expect(200);
    expect(reassigned.body.report.assignedTo).toBe(club.user.name);
    const stableAssignment = await prisma.chatSafetyReport.findUniqueOrThrow({ where: { id: reportId } });
    expect(stableAssignment.assignedClubUserId).toBe(club.user.id);
    expect(JSON.stringify(reassigned.body)).not.toContain('assignedClubUserId');
    await expect(prisma.chatSafetyReport.update({
      where: { id: reportId },
      data: { assignedClubUserId: otherClub.user.id, assignedTo: otherClub.user.name },
    })).rejects.toThrow();

    const originalAdminPassword = config.adminPassword;
    const originalAdminOperators = config.adminOperators;
    config.adminPassword = 'club-assignment-admin-test';
    config.adminOperators = [{ id: 'safety_ops_1', name: 'Safety Operator', email: 'safety@example.test', passwordHash: await bcrypt.hash(config.adminPassword, 12) }];
    try {
      const admin = await adminCookie();
      await request(app).patch(`/api/admin/safeguarding/reports/${reportId}`).set('Cookie', admin)
        .send({ severity: 'HIGH', note: 'Preserve the accepted club owner.' }).expect(200);
      expect((await prisma.chatSafetyReport.findUniqueOrThrow({ where: { id: reportId } })).assignedClubUserId)
        .toBe(club.user.id);
      await request(app).patch(`/api/admin/safeguarding/reports/${reportId}`).set('Cookie', admin)
        .send({ assignedTo: 'platform-safety', note: 'Platform accepted ownership.' }).expect(200);
      expect(await prisma.chatSafetyReport.findUniqueOrThrow({ where: { id: reportId } })).toMatchObject({
        assignedClubUserId: null, assignedTo: 'platform-safety',
      });
    } finally {
      config.adminPassword = originalAdminPassword;
      config.adminOperators = originalAdminOperators;
    }

    const revokedReviewer = await staffCookie(['SAFEGUARDING_REVIEW']);
    expect(revokedReviewer.name).toBe(reviewer.name);
    expect(revokedReviewer.id).not.toBe(reviewer.id);
    await request(app).patch(`/api/safeguarding/reports/${reportId}`).set('Cookie', revokedReviewer.cookie)
      .send({ assignment: 'SELF', note: 'A same-named reviewer accepted this case.' }).expect(200);
    const sameNamedAssignment = await prisma.chatSafetyReport.findUniqueOrThrow({ where: { id: reportId } });
    expect(sameNamedAssignment).toMatchObject({
      assignedClubUserId: revokedReviewer.id, assignedTo: revokedReviewer.name,
    });
    await prisma.user.update({ where: { id: revokedReviewer.id }, data: { name: 'Renamed safety reviewer' } });
    expect(await prisma.chatSafetyReport.findUniqueOrThrow({ where: { id: reportId } })).toMatchObject({
      assignedClubUserId: revokedReviewer.id, assignedTo: revokedReviewer.name,
    });
    await request(app).delete(`/api/staff-access/${revokedReviewer.accessId}`).set('Cookie', club.cookie).expect(200);
    const clearedAfterRevoke = await prisma.chatSafetyReport.findUniqueOrThrow({
      where: { id: reportId }, include: { auditEvents: { orderBy: { createdAt: 'asc' } } },
    });
    expect(clearedAfterRevoke).toMatchObject({ assignedClubUserId: null, assignedTo: null });
    expect(clearedAfterRevoke.auditEvents.at(-1)).toMatchObject({
      action: 'ASSIGNMENT_CLEARED_ACCESS_REVOKED', actorUserId: club.user.id,
    });
    await prisma.clubStaffAccess.update({
      where: { id: revokedReviewer.accessId },
      data: { active: true, revokedAt: null, revokedByUserId: null },
    });
    expect(await prisma.chatSafetyReport.findUniqueOrThrow({ where: { id: reportId } })).toMatchObject({
      assignedClubUserId: null, assignedTo: null,
    });

    const foreignList = await request(app).get('/api/safeguarding/reports').set('Cookie', otherClub.cookie).expect(200);
    expect(foreignList.body.reports.map((item: { id: string }) => item.id)).not.toContain(reportId);
    await request(app).get(`/api/safeguarding/reports/${reportId}`).set('Cookie', otherClub.cookie).expect(404);

    const accountThreadId = await accountThread(student, club.coachUser as unknown as Person);
    const accountMessage = (await send(accountThreadId, { cookie: club.coachCookie }, 'Account-only evidence')).body.message;
    const accountReport = await report(accountThreadId, student, {
      category: 'SPAM_OTHER', messageId: accountMessage.id,
    }).expect(201);
    const afterAccountReport = await request(app).get('/api/safeguarding/reports').set('Cookie', viewer.cookie).expect(200);
    expect(afterAccountReport.body.reports.map((item: { id: string }) => item.id))
      .not.toContain(accountReport.body.report.id);
  });

  it('lets platform triage restrict ACCOUNT chat while preserving SESSION chat', async () => {
    const originalAdminPassword = config.adminPassword;
    const originalAdminOperators = config.adminOperators;
    config.adminPassword = 'chat-safeguarding-admin-test';
    const namedOperator = { id: 'safety_ops_2', name: 'Morgan Safety', email: 'morgan.safety@example.test', passwordHash: await bcrypt.hash(config.adminPassword, 12) };
    config.adminOperators = [namedOperator];
    try {
      const student = await person('Platform Safety Reporter');
      const coach: Person = {
        id: club.coachUser.id, name: club.coachUser.name, username: club.coachUser.username,
        email: club.coachUser.email, cookie: club.coachCookie,
      };
      const threadId = await accountThread(student, coach);
      const message = (await send(threadId, coach, 'Admin evidence and subject message.')).body.message;
      const created = await report(threadId, student, {
        category: 'GROOMING_SEXUAL', messageId: message.id, description: 'Platform-only report detail.',
      }).expect(201);
      const reportId = created.body.report.id as string;
      const admin = await adminCookie();
      await request(app).patch(`/api/admin/safeguarding/reports/${reportId}`)
        .set('Cookie', admin).send({ status: 'IN_REVIEW' }).expect(400);
      await request(app).patch(`/api/admin/safeguarding/reports/${reportId}`)
        .set('Cookie', admin).send({ status: 'IN_REVIEW', note: '   ' }).expect(400);

      const list = await request(app).get('/api/admin/safeguarding/reports').set('Cookie', admin).expect(200);
      expect(list.body.reports.map((item: { id: string }) => item.id)).toContain(reportId);
      const detail = await request(app).get(`/api/admin/safeguarding/reports/${reportId}`)
        .set('Cookie', admin).expect(200);
      expect(detail.body.report).toMatchObject({
        id: reportId, description: 'Platform-only report detail.',
        reporter: { name: student.name, username: student.username },
      });
      expect(JSON.stringify(detail.body.report.evidence)).toContain('Admin evidence and subject message.');

      await prisma.chatSafetyAuditEvent.createMany({ data: Array.from({ length: 505 }, (_, index) => ({
        reportId, actorKind: 'PLATFORM_ADMIN', actorName: 'History test operator',
        action: 'REPORT_REVIEW_UPDATED', note: `History event ${index}`,
        fromStatus: 'OPEN', toStatus: 'OPEN', fromSeverity: 'CRITICAL', toSeverity: 'CRITICAL',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      })) });
      const boundedHistory = await request(app).get(`/api/admin/safeguarding/reports/${reportId}`)
        .set('Cookie', admin).expect(200);
      expect(boundedHistory.body.report.auditHistoryHasEarlier).toBe(true);
      expect(boundedHistory.body.report.audits).toHaveLength(500);
      expect(boundedHistory.body.report.audits.some((event: { note: string | null }) => event.note === 'History event 504')).toBe(true);
      expect(boundedHistory.body.report.audits.some((event: { note: string | null }) => event.note === 'History event 0')).toBe(false);

      const triaged = await request(app).patch(`/api/admin/safeguarding/reports/${reportId}`)
        .set('Cookie', admin).send({
          status: 'IN_REVIEW', severity: 'CRITICAL', assignedTo: 'trust-and-safety', note: 'Escalated review.',
        }).expect(200);
      expect(triaged.body.report).toMatchObject({
        status: 'IN_REVIEW', severity: 'CRITICAL', assignedTo: 'trust-and-safety',
      });
      expect(triaged.body.report.audits.at(-1)).toMatchObject({
        actorKind: 'PLATFORM_ADMIN', actorName: `${namedOperator.name} <${namedOperator.email}> [${namedOperator.id}]`,
      });
      expect(triaged.body.report.auditHistoryHasEarlier).toBe(true);
      expect(triaged.body.report.audits).toHaveLength(500);
      expect(triaged.body.report.audits.at(-1).note).toBe('Escalated review.');

      await request(app).post(`/api/admin/safeguarding/reports/${reportId}/account-action`)
        .set('Cookie', admin).send({ action: 'RESTRICT_ACCOUNT_CHAT', note: 'Temporary contact restriction.' })
        .expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: coach.id } })).safetyStatus)
        .toBe('ACCOUNT_CHAT_RESTRICTED');
      expect(await prisma.chatSafetyAuditEvent.findFirst({
        where: { reportId, action: 'RESTRICT_ACCOUNT_CHAT' },
        select: { actorKind: true, actorName: true },
      })).toEqual({
        actorKind: 'PLATFORM_ADMIN', actorName: `${namedOperator.name} <${namedOperator.email}> [${namedOperator.id}]`,
      });
      await request(app).post(`/api/chats/${threadId}/messages`).set('Cookie', coach.cookie)
        .send({ body: 'Restricted account message' }).expect(403);
      await request(app).post(`/api/chats/${threadId}/messages`).set('Cookie', student.cookie)
        .send({ body: 'Contact with a restricted account' }).expect(403);
      await request(app).post('/api/chats/accounts').set('Cookie', coach.cookie)
        .send({ username: student.username }).expect(403);

      const { thread: sessionThread } = await sessionFor(student, club.starts.plus({ days: 2 }));
      await request(app).post(`/api/chats/${sessionThread.id}/messages`).set('Cookie', coach.cookie)
        .send({ body: 'Restricted coach retains session safeguarding contact.' }).expect(201);

      const restored = await request(app).post(`/api/admin/safeguarding/reports/${reportId}/account-action`)
        .set('Cookie', admin).send({ action: 'RESTORE_ACCOUNT_CHAT', note: 'Review completed; restore direct chat.' })
        .expect(200);
      expect(restored.body.report.targetSafetyStatus).toBe('ACTIVE');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: coach.id } })).safetyStatus).toBe('ACTIVE');
      expect(await prisma.chatSafetyAuditEvent.count({
        where: { reportId, action: 'RESTORE_ACCOUNT_CHAT' },
      })).toBe(1);
      await request(app).post(`/api/admin/safeguarding/reports/${reportId}/account-action`)
        .set('Cookie', admin).send({ action: 'RESTORE_ACCOUNT_CHAT', note: 'Idempotent repeat.' }).expect(200);
      expect(await prisma.chatSafetyAuditEvent.count({
        where: { reportId, action: 'RESTORE_ACCOUNT_CHAT' },
      })).toBe(1);
      await request(app).post(`/api/chats/${threadId}/messages`).set('Cookie', coach.cookie)
        .send({ body: 'Chat restored after audited review.' }).expect(201);

    } finally {
      config.adminPassword = originalAdminPassword;
      config.adminOperators = originalAdminOperators;
    }
  });

});
