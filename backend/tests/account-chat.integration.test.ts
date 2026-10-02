import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import {
  createAccount, createSession, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type Person = { id: string; name: string; username: string; email: string; cookie: string };

describe.sequential('Account chat', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function person(name: string, accountType: 'STUDENT' | 'COACH' = 'STUDENT'): Promise<Person> {
    const account = await createAccount(club, { name, accountType });
    const { cookie } = await createSession(club, account.id);
    return { id: account.id, name, username: account.username, email: account.email, cookie };
  }

  function openConversation(cookie: string, username: string) {
    return request(app).post('/api/chats/accounts').set('Cookie', cookie).send({ username });
  }

  function assignFixtureCoach(threadId: string) {
    return request(app).post(`/api/chats/${threadId}/coach`).set('Cookie', club.cookie)
      .send({ membershipId: club.coachMembership.id });
  }

  function proposalBody(startAt = club.starts.toISO()!) {
    return {
      businessSlug: club.business.slug, serviceId: club.service.id, locationId: club.location.id,
      startAt, message: 'Could we train then?',
    };
  }

  async function expectNormalClubBooking(bookingId: string, studentUserId: string, startAt: string) {
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId }, include: { participants: { include: { student: true } } },
    });
    expect(booking).toMatchObject({
      businessId: club.business.id, serviceId: club.service.id, instructorId: club.instructor.id,
      locationId: club.location.id, status: 'CONFIRMED', coachAcceptance: 'NOT_REQUIRED',
      paymentRoute: 'CLUB', createdByRole: 'STUDENT', createdByUserId: studentUserId,
    });
    expect(booking.startAt.toISOString()).toBe(new Date(startAt).toISOString());
    expect(booking.participants.map(participant => participant.student.userId)).toEqual([studentUserId]);
    const sessionThread = await prisma.chatThread.findUniqueOrThrow({ where: { bookingId } });
    expect(sessionThread).toMatchObject({ kind: 'SESSION', businessId: club.business.id, directKey: null });
    expect(await prisma.accountNotification.count({
      where: { userId: studentUserId, bookingId, type: 'BOOKING_CREATED' },
    })).toBe(1);
  }

  it('opens the canonical student-club conversation by exact username and rejects self-chat', async () => {
    const student = await person('Account Chat Student');

    const opened = await openConversation(student.cookie, club.user.username).expect(200);
    expect(opened.body).toEqual({ threadId: expect.any(String), thread: expect.any(Object) });
    const threadId = opened.body.threadId as string;
    // The opened conversation arrives inline so the client needs no second request.
    expect(opened.body.thread).toMatchObject({
      id: threadId, kind: 'ACCOUNT', conversation: { timezone: 'Asia/Singapore' },
      viewer: { role: 'STUDENT', canPost: true },
    });
    const thread = await prisma.chatThread.findUniqueOrThrow({
      where: { id: threadId }, include: { members: { orderBy: { source: 'asc' } } },
    });
    expect(thread).toMatchObject({
      kind: 'ACCOUNT', businessId: club.business.id, bookingId: null,
      directKey: [student.id, club.user.id].sort().join(':'),
    });
    expect(thread.members.map(member => ({ userId: member.userId, source: member.source }))).toEqual(expect.arrayContaining([
      { userId: student.id, source: 'INITIATOR' },
      { userId: club.user.id, source: 'TARGET' },
    ]));

    const repeated = await openConversation(student.cookie, club.user.username).expect(200);
    const reverse = await openConversation(club.cookie, student.username).expect(200);
    expect(repeated.body.threadId).toBe(threadId);
    expect(reverse.body.threadId).toBe(threadId);
    expect(await prisma.chatThread.count({ where: { directKey: thread.directKey } })).toBe(1);

    await request(app).get(`/api/chats/${threadId}`).set('Cookie', student.cookie).expect(404);
    const detail = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
      .set('Cookie', student.cookie).expect(200);
    expect(detail.body).toMatchObject({
      id: threadId, kind: 'ACCOUNT', bookingId: null, session: null,
      conversation: {
        title: club.user.name, business: { name: club.business.name, slug: club.business.slug },
        assignedCoach: null,
      },
      viewer: { role: 'STUDENT', canPost: true, canPropose: false, canAssignCoach: false },
    });
    expect(detail.body.members).toEqual(expect.arrayContaining([
      { role: 'STUDENT', name: student.name, username: student.username, isYou: true, assigned: false },
      { role: 'CLUB', name: club.user.name, username: club.user.username, isYou: false, assigned: false },
    ]));

    await openConversation(student.cookie, student.username).expect(400);
    await openConversation(student.cookie, `missing_${student.id.slice(-12)}`).expect(404);
    await request(app).post('/api/chats/accounts').set('Cookie', student.cookie)
      .send({ username: club.user.username, email: club.user.email }).expect(400);
  });

  it('rejects DOB-known self-managed child targets but keeps DOB-null legacy targets discoverable', async () => {
    const viewer = await person('Policy Chat Viewer');
    const hiddenChild = await person('Policy Chat Child');
    await prisma.user.update({
      where: { id: hiddenChild.id },
      data: { dateOfBirth: new Date('2020-01-01T00:00:00.000Z') },
    });
    const legacy = await person('Policy Chat Legacy');

    await openConversation(viewer.cookie, hiddenChild.username).expect(404);
    const opened = await openConversation(viewer.cookie, legacy.username).expect(200);
    expect(opened.body).toEqual({ threadId: expect.any(String), thread: expect.objectContaining({ id: opened.body.threadId }) });
    // No club stands behind this pair, so times follow Courtly's Singapore clock rather than UTC.
    expect(opened.body.thread.conversation.timezone).toBe('Asia/Singapore');
    expect(await prisma.chatThread.findUniqueOrThrow({ where: { id: opened.body.threadId } }))
      .toMatchObject({ directKey: [viewer.id, legacy.id].sort().join(':') });
  });

  it('keeps account messages, lists and unread state private while granting one active roster coach access', async () => {
    const student = await person('Private Conversation Student');
    const outsider = await person('Account Chat Outsider');
    const otherClub = await tenants.fixture();
    const threadId = (await openConversation(student.cookie, club.user.username).expect(200)).body.threadId as string;

    expect((await request(app).get('/api/chats/unread').query({ contract: 'accounts' }).set('Cookie', student.cookie).expect(200)).body.unreadThreads).toBe(0);
    expect((await request(app).get('/api/chats/unread').query({ contract: 'accounts' }).set('Cookie', club.cookie).expect(200)).body.unreadThreads).toBe(0);

    const sent = await request(app).post(`/api/chats/${threadId}/messages`).set('Cookie', student.cookie)
      .send({ body: '  I would like help with my backhand.  ' }).expect(201);
    expect(sent.body.message).toMatchObject({
      body: 'I would like help with my backhand.', senderRole: 'STUDENT',
      senderName: student.name, mine: true,
    });
    expect((await request(app).get('/api/chats/unread').query({ contract: 'accounts' }).set('Cookie', student.cookie).expect(200)).body.unreadThreads).toBe(0);
    expect((await request(app).get('/api/chats/unread').query({ contract: 'accounts' }).set('Cookie', club.cookie).expect(200)).body.unreadThreads).toBe(1);
    expect((await request(app).get('/api/chats/unread').set('Cookie', club.cookie).expect(200)).body.unreadThreads).toBe(0);

    const legacyList = await request(app).get('/api/chats').query({ q: student.username }).set('Cookie', club.cookie).expect(200);
    expect(legacyList.body).toMatchObject({ threads: [], accountChatAvailable: false });
    const clubList = await request(app).get('/api/chats').query({ q: student.username, contract: 'accounts' }).set('Cookie', club.cookie).expect(200);
    expect(clubList.body.threads).toHaveLength(1);
    expect(clubList.body.threads[0]).toMatchObject({
      id: threadId, kind: 'ACCOUNT', bookingId: null, session: null, unreadCount: 1,
      lastMessage: { body: 'I would like help with my backhand.', mine: false },
    });
    expect((await request(app).post(`/api/chats/${threadId}/read`).query({ contract: 'accounts' })
      .set('Cookie', club.cookie).send({}).expect(200)).body)
      .toEqual({ ok: true, unreadThreads: 0 });
    const clubDetail = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
      .set('Cookie', club.cookie).expect(200);
    expect(clubDetail.body.conversation.assignableCoaches).toEqual(expect.arrayContaining([expect.objectContaining({
      membershipId: club.coachMembership.id, name: club.coachUser.name, username: club.coachUser.username,
    })]));
    expect(clubDetail.body.conversation.assignableCoaches).not.toEqual(expect.arrayContaining([expect.objectContaining({
      membershipId: otherClub.coachMembership.id,
    })]));

    for (const cookie of [outsider.cookie, otherClub.cookie, otherClub.coachCookie]) {
      await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' }).set('Cookie', cookie).expect(404);
      await request(app).post(`/api/chats/${threadId}/messages`).set('Cookie', cookie).send({ body: 'Let me in' }).expect(404);
      const list = await request(app).get('/api/chats').query({ q: student.username, contract: 'accounts' }).set('Cookie', cookie).expect(200);
      expect(list.body.threads.map((item: { id: string }) => item.id)).not.toContain(threadId);
      expect(list.body.unreadThreads).toBe(0);
    }

    await request(app).post(`/api/chats/${threadId}/coach`).set('Cookie', club.cookie)
      .send({ membershipId: otherClub.coachMembership.id }).expect(404);
    await request(app).post(`/api/chats/${threadId}/coach`).set('Cookie', student.cookie)
      .send({ membershipId: club.coachMembership.id }).expect(404);
    await prisma.membership.update({ where: { id: club.coachMembership.id }, data: { active: false } });
    await assignFixtureCoach(threadId).expect(404);
    await prisma.membership.update({ where: { id: club.coachMembership.id }, data: { active: true } });

    const assigned = await assignFixtureCoach(threadId).expect(200);
    expect(assigned.body.thread).toMatchObject({
      id: threadId,
      conversation: {
        assignedCoach: {
          role: 'COACH', name: club.coachUser.name, username: club.coachUser.username, assigned: true,
        },
      },
    });
    expect(assigned.body.thread.messages.at(-1)).toMatchObject({ kind: 'SYSTEM', event: 'COACH_ASSIGNED' });

    const coachDetail = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
      .set('Cookie', club.coachCookie).expect(200);
    expect(coachDetail.body.messages.some((message: { body: string }) => message.body === 'I would like help with my backhand.')).toBe(true);
    expect(coachDetail.body.viewer).toMatchObject({ role: 'COACH', canPost: true, canPropose: true, canAssignCoach: false });
    expect((await request(app).get('/api/chats/unread').query({ contract: 'accounts' }).set('Cookie', club.coachCookie).expect(200)).body.unreadThreads).toBe(1);
    const coachList = await request(app).get('/api/chats').query({ contract: 'accounts' }).set('Cookie', club.coachCookie).expect(200);
    expect(coachList.body.threads.map((item: { id: string }) => item.id)).toContain(threadId);

    const studentDetail = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
      .set('Cookie', student.cookie).expect(200);
    expect(studentDetail.body.conversation).not.toHaveProperty('assignableCoaches');
    expect(studentDetail.body.members.every((member: object) =>
      JSON.stringify(Object.keys(member).sort()) === JSON.stringify(['assigned', 'isYou', 'name', 'role', 'username']))).toBe(true);
    expect(studentDetail.body).not.toHaveProperty('businessId');
    expect(studentDetail.body).not.toHaveProperty('directKey');
    const publicPayload = JSON.stringify({ student: studentDetail.body, coach: coachDetail.body });
    for (const secret of [student.id, club.user.id, club.coachUser.id, student.email, club.user.email,
      club.coachUser.email, club.coachMembership.id]) {
      expect(publicPayload).not.toContain(secret);
    }

    await request(app).delete(`/api/chats/${threadId}/coach`).set('Cookie', student.cookie).send({}).expect(404);
    const removed = await request(app).delete(`/api/chats/${threadId}/coach`).set('Cookie', club.cookie).send({}).expect(200);
    expect(removed.body.thread.conversation.assignedCoach).toBeNull();
    expect(removed.body.thread.messages.at(-1)).toMatchObject({ kind: 'SYSTEM', event: 'COACH_REMOVED' });
    await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' }).set('Cookie', club.coachCookie).expect(404);
    expect((await request(app).get('/api/chats/unread').query({ contract: 'accounts' }).set('Cookie', club.coachCookie).expect(200)).body.unreadThreads).toBe(0);
  });

  it('turns an accepted student-club account proposal into a normal club booking and a separate session chat', async () => {
    const student = await person('Assigned Proposal Student');
    const threadId = (await openConversation(student.cookie, club.user.username).expect(200)).body.threadId as string;
    await assignFixtureCoach(threadId).expect(200);
    const startAt = club.starts.plus({ days: 1 }).toISO()!;

    const proposed = await request(app).post(`/api/chats/${threadId}/proposals`).set('Cookie', student.cookie)
      .send(proposalBody(startAt)).expect(201);
    const proposal = proposed.body.thread.messages.at(-1).proposal;
    expect(proposal).toMatchObject({
      status: 'OPEN', businessSlug: club.business.slug, serviceId: club.service.id,
      instructorId: club.instructor.id, locationId: club.location.id, proposedByRole: 'STUDENT',
      price: club.service.price, currency: club.business.currency,
      proposedByYou: true, forName: student.name, forYou: true, awaiting: [club.coachUser.name],
      actions: { accept: false, decline: false, counter: false, withdraw: true },
    });
    expect(proposal).not.toHaveProperty('businessId');

    const coachView = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
      .set('Cookie', club.coachCookie).expect(200);
    expect(coachView.body.messages.at(-1).proposal).toMatchObject({
      proposedByYou: false, forYou: false,
      actions: { accept: true, decline: true, counter: true, withdraw: false },
    });
    expect(coachView.body.messages.at(-1).proposal).not.toHaveProperty('price');
    expect(coachView.body.messages.at(-1).proposal).not.toHaveProperty('currency');
    await request(app).post(`/api/chats/proposals/${proposal.id}/accept`).set('Cookie', club.cookie).send({}).expect(403);

    const accepted = await request(app).post(`/api/chats/proposals/${proposal.id}/accept`)
      .set('Cookie', club.coachCookie).send({}).expect(200);
    expect(accepted.body.thread).toMatchObject({ id: threadId, kind: 'ACCOUNT', bookingId: null, session: null });
    await expectNormalClubBooking(accepted.body.bookingId, student.id, startAt);
    expect(await prisma.sessionProposalResponse.count({
      where: { proposalId: proposal.id, studentUserId: student.id, bookingId: accepted.body.bookingId },
    })).toBe(1);
  });

  it('lets a student and coach schedule through a club they share without scoping their direct conversation to it', async () => {
    const student = await person('Direct Coach Student');
    const threadId = (await openConversation(student.cookie, club.coachUser.username).expect(200)).body.threadId as string;
    const stored = await prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(stored).toMatchObject({ kind: 'ACCOUNT', businessId: null, bookingId: null });

    for (const [cookie, role] of [[student.cookie, 'STUDENT'], [club.coachCookie, 'COACH']] as const) {
      const detail = await request(app).get(`/api/chats/${threadId}`).query({ contract: 'accounts' })
        .set('Cookie', cookie).expect(200);
      expect(detail.body.viewer).toMatchObject({ role, canPost: true, canPropose: true, canAssignCoach: false });
      expect(detail.body.conversation).toMatchObject({ business: null, assignedCoach: null });
      expect(detail.body.conversation.schedulingOptions).toEqual(expect.arrayContaining([expect.objectContaining({
        businessName: club.business.name, businessSlug: club.business.slug, timezone: club.business.timezone,
        instructorId: club.instructor.id, instructorName: club.instructor.name, serviceId: club.service.id,
        serviceName: club.service.name, locationId: club.location.id, locationName: club.location.name,
      })]));
      expect(detail.body.conversation.schedulingOptions[0]).not.toHaveProperty('businessId');
      if (role === 'STUDENT') {
        expect(detail.body.conversation.schedulingOptions[0]).toMatchObject({
          price: club.service.price, currency: club.business.currency,
        });
      } else {
        expect(detail.body.conversation.schedulingOptions[0]).not.toHaveProperty('price');
        expect(detail.body.conversation.schedulingOptions[0]).not.toHaveProperty('currency');
      }
    }

    const startAt = club.starts.plus({ days: 2 }).toISO()!;
    const proposed = await request(app).post(`/api/chats/${threadId}/proposals`).set('Cookie', club.coachCookie)
      .send(proposalBody(startAt)).expect(201);
    const proposal = proposed.body.thread.messages.at(-1).proposal;
    expect(proposal).toMatchObject({
      proposedByRole: 'COACH', forName: student.name, awaiting: [student.name],
      businessSlug: club.business.slug, serviceId: club.service.id, instructorId: club.instructor.id,
    });
    expect(proposal).not.toHaveProperty('price');
    expect(proposal).not.toHaveProperty('currency');

    const editedStartAt = club.starts.plus({ days: 3 }).toISO()!;
    const countered = await request(app).post(`/api/chats/proposals/${proposal.id}/counter`)
      .set('Cookie', student.cookie).send(proposalBody(editedStartAt)).expect(201);
    const counter = countered.body.thread.messages.at(-1).proposal;
    expect(counter).toMatchObject({
      isCounter: true, proposedByRole: 'STUDENT', forName: student.name, awaiting: [club.coachUser.name],
      businessSlug: club.business.slug, serviceId: club.service.id, instructorId: club.instructor.id,
      price: club.service.price, currency: club.business.currency,
    });
    const accepted = await request(app).post(`/api/chats/proposals/${counter.id}/accept`)
      .set('Cookie', club.coachCookie).send({}).expect(200);
    await expectNormalClubBooking(accepted.body.bookingId, student.id, editedStartAt);
    expect((await prisma.chatThread.findUniqueOrThrow({ where: { id: threadId } })).kind).toBe('ACCOUNT');
  });

  it('includes account conversations in the read-only admin console without leaking account identifiers', async () => {
    const original = config.adminPassword;
    const originalOperators = config.adminOperators;
    config.adminPassword = 'test-admin-password-account-chat';
    config.adminOperators = [{ id: 'account_chat_operator', name: 'Account Chat Operator', email: 'account.chat@example.test', passwordHash: await bcrypt.hash(config.adminPassword, 12) }];
    try {
      const student = await person('Admin Account Chat');
      const threadId = (await openConversation(student.cookie, club.user.username).expect(200)).body.threadId as string;
      await request(app).post(`/api/chats/${threadId}/messages`).set('Cookie', student.cookie)
        .send({ body: 'Admin-visible account message' }).expect(201);
      const login = await request(app).post('/api/admin/login').send({ email: 'account.chat@example.test', password: config.adminPassword }).expect(200);
      const admin = login.headers['set-cookie'];
      expect((await request(app).get('/api/admin/chats').query({ q: student.username }).set('Cookie', admin).expect(200)).body)
        .toMatchObject({ threads: [], accountChatAvailable: false });
      await request(app).get(`/api/admin/chats/${threadId}`).set('Cookie', admin).expect(404);
      const list = await request(app).get('/api/admin/chats').query({ q: student.username, contract: 'accounts' }).set('Cookie', admin).expect(200);
      expect(list.body.threads).toEqual([expect.objectContaining({
        id: threadId, kind: 'ACCOUNT', bookingId: null, session: null, messageCount: 1,
      })]);
      const detail = await request(app).get(`/api/admin/chats/${threadId}`).query({ contract: 'accounts' })
        .set('Cookie', admin).expect(200);
      expect(detail.body.viewer).toEqual({ role: 'ADMIN', canPost: false, canPropose: false, canAssignCoach: false });
      expect(detail.body.messages.at(-1)).toMatchObject({ body: 'Admin-visible account message', mine: false });
      const payload = JSON.stringify(detail.body);
      for (const privateValue of [student.id, student.email, club.user.id, club.user.email]) {
        expect(payload).not.toContain(privateValue);
      }
    } finally {
      config.adminPassword = original;
      config.adminOperators = originalOperators;
    }
  });
});
