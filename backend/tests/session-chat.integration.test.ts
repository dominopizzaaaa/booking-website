import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { createBookings, cancelBooking } from '../src/scheduling.js';
import { sendDueSessionReminders } from '../src/chat.js';
import {
  createAccount, createSession, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type Person = { userId: string; name: string; cookie: string };

describe.sequential('Session chat', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function student(name = 'Chat Student'): Promise<Person> {
    const record = await createStudent(f, { name });
    const { cookie } = await createSession(f, record.userId!);
    return { userId: record.userId!, name, cookie };
  }

  // A student booking the fixture's private class for themselves.
  async function bookFor(person: Person, startAt = f.starts) {
    const account = await prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
    const result = await createBookings(f.business.id, inputFor(f, {
      startAt: startAt.toISO()!, student: { name: account.name, email: account.email },
    }), { studentUserId: person.userId });
    return result.bookings[0].id;
  }

  async function threadFor(bookingId: string) {
    return prisma.chatThread.findUniqueOrThrow({ where: { bookingId } });
  }

  const clubCookie = () => f.cookie;
  const coachCookie = () => f.coachCookie;

  it('opens a chat for a new booking that only its coach, students and club can read', async () => {
    const amelia = await student('Amelia Chat');
    const bookingId = await bookFor(amelia);
    const thread = await threadFor(bookingId);

    for (const cookie of [amelia.cookie, coachCookie(), clubCookie()]) {
      const detail = await request(app).get(`/api/chats/${thread.id}`).set('Cookie', cookie);
      expect(detail.status).toBe(200);
      expect(detail.body.session.bookingId).toBe(bookingId);
      expect(detail.body.messages[0]).toMatchObject({ kind: 'SYSTEM', event: 'OPENED' });
      expect(detail.body.members.map((member: { role: string }) => member.role)).toEqual(['COACH', 'STUDENT', 'CLUB']);
      // Account IDs never leave the server.
      expect(JSON.stringify(detail.body)).not.toContain(amelia.userId);
    }

    const outsider = await student('Outside Student');
    const otherClub = await tenants.fixture();
    for (const cookie of [outsider.cookie, otherClub.cookie, otherClub.coachCookie]) {
      const denied = await request(app).get(`/api/chats/${thread.id}`).set('Cookie', cookie);
      expect(denied.status).toBe(404);
      const list = await request(app).get('/api/chats').set('Cookie', cookie);
      expect(list.body.threads.map((item: { id: string }) => item.id)).not.toContain(thread.id);
    }

    // The opening line introduces the chat; it does not raise a badge.
    const unread = await request(app).get('/api/chats/unread').set('Cookie', coachCookie());
    expect(unread.body.unreadThreads).toBe(0);
  });

  it('counts messages from others as unread until the reader opens the thread', async () => {
    const amelia = await student('Amelia Unread');
    const thread = await threadFor(await bookFor(amelia));

    const sent = await request(app).post(`/api/chats/${thread.id}/messages`).set('Cookie', amelia.cookie)
      .send({ body: '  See you Tuesday!  ' });
    expect(sent.status).toBe(201);
    expect(sent.body.message).toMatchObject({ body: 'See you Tuesday!', mine: true, senderRole: 'STUDENT', senderName: 'Amelia Unread' });

    expect((await request(app).get('/api/chats/unread').set('Cookie', amelia.cookie)).body.unreadThreads).toBe(0);
    expect((await request(app).get('/api/chats/unread').set('Cookie', coachCookie())).body.unreadThreads).toBe(1);
    const clubList = await request(app).get('/api/chats').set('Cookie', clubCookie());
    expect(clubList.body.threads.find((item: { id: string }) => item.id === thread.id)).toMatchObject({
      unreadCount: 1, lastMessage: { body: 'See you Tuesday!', mine: false },
    });

    const read = await request(app).post(`/api/chats/${thread.id}/read`).set('Cookie', coachCookie()).send({});
    expect(read.body).toEqual({ ok: true, unreadThreads: 0 });
    const reply = await request(app).post(`/api/chats/${thread.id}/messages`).set('Cookie', clubCookie())
      .send({ body: 'Court 2 is ready for you.' });
    expect(reply.body.message).toMatchObject({ senderRole: 'CLUB', mine: true });
    expect((await request(app).get('/api/chats/unread').set('Cookie', coachCookie())).body.unreadThreads).toBe(1);

    const empty = await request(app).post(`/api/chats/${thread.id}/messages`).set('Cookie', amelia.cookie).send({ body: '   ' });
    expect(empty.status).toBe(400);
    const extra = await request(app).post(`/api/chats/${thread.id}/messages`).set('Cookie', amelia.cookie)
      .send({ body: 'Hi', senderRole: 'COACH' });
    expect(extra.status).toBe(400);
  });

  it('books the next session when the student accepts the coach’s proposal', async () => {
    const amelia = await student('Amelia Accepts');
    const sourceId = await bookFor(amelia);
    const thread = await threadFor(sourceId);
    const nextAt = f.starts.plus({ weeks: 1 });

    const proposed = await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', coachCookie())
      .send({ startAt: nextAt.toISO(), message: 'Same time next week?' });
    expect(proposed.status).toBe(201);
    const card = proposed.body.thread.messages.at(-1);
    expect(card).toMatchObject({ kind: 'PROPOSAL', mine: true });
    expect(card.proposal).toMatchObject({
      status: 'OPEN', proposedByRole: 'COACH', proposedByYou: true, forName: 'Amelia Accepts',
      message: 'Same time next week?', awaiting: ['Amelia Accepts'],
      actions: { accept: false, decline: false, counter: false, withdraw: true },
    });

    const studentView = await request(app).get(`/api/chats/${thread.id}`).set('Cookie', amelia.cookie);
    const proposal = studentView.body.messages.at(-1).proposal;
    expect(proposal).toMatchObject({ forYou: true, actions: { accept: true, decline: true, counter: true, withdraw: false } });
    // The club reads along but neither proposes nor answers.
    const clubView = await request(app).get(`/api/chats/${thread.id}`).set('Cookie', clubCookie());
    expect(clubView.body.viewer).toMatchObject({ role: 'CLUB', canPost: true, canPropose: false });
    expect(clubView.body.messages.at(-1).proposal.actions).toEqual({ accept: false, decline: false, counter: false, withdraw: false });
    expect((await request(app).post(`/api/chats/proposals/${proposal.id}/accept`).set('Cookie', clubCookie()).send({})).status).toBe(403);
    expect((await request(app).post(`/api/chats/proposals/${proposal.id}/accept`).set('Cookie', coachCookie()).send({})).status).toBe(403);

    const accepted = await request(app).post(`/api/chats/proposals/${proposal.id}/accept`).set('Cookie', amelia.cookie).send({});
    expect(accepted.status).toBe(200);
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: accepted.body.bookingId }, include: { participants: { include: { student: true } } },
    });
    expect(booking).toMatchObject({
      businessId: f.business.id, instructorId: f.instructor.id, serviceId: f.service.id, status: 'CONFIRMED',
      coachAcceptance: 'NOT_REQUIRED', paymentRoute: 'CLUB', createdByRole: 'STUDENT',
    });
    expect(booking.startAt.getTime()).toBe(nextAt.toMillis());
    expect(booking.participants.map(participant => participant.student.userId)).toEqual([amelia.userId]);
    // The confirmed session gets its own chat, and the account alert that
    // puts it on the student's list of bookings.
    await threadFor(booking.id);
    expect(await prisma.accountNotification.count({ where: { userId: amelia.userId, bookingId: booking.id, type: 'BOOKING_CREATED' } })).toBe(1);

    const settled = accepted.body.thread.messages;
    expect(settled.at(-1)).toMatchObject({ kind: 'SYSTEM', event: 'PROPOSAL_ACCEPTED' });
    expect(settled.at(-1).body).toContain('added to the calendar');
    expect(settled.find((message: { id: string }) => message.id === card.id).proposal).toMatchObject({
      status: 'ACCEPTED', responses: [{ status: 'ACCEPTED', forYou: true, bookingId: booking.id }],
      actions: { accept: false, withdraw: false },
    });
    const again = await request(app).post(`/api/chats/proposals/${proposal.id}/accept`).set('Cookie', amelia.cookie).send({});
    expect(again.status).toBe(409);
  });

  it('sends an edited time back so the person who asked first confirms it', async () => {
    const ben = await student('Ben Counters');
    const thread = await threadFor(await bookFor(ben));
    const asked = f.starts.plus({ weeks: 1 });
    const edited = asked.plus({ hours: 2 });

    const proposed = await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', ben.cookie)
      .send({ startAt: asked.toISO() });
    expect(proposed.status).toBe(201);
    const original = proposed.body.thread.messages.at(-1).proposal;
    expect(original).toMatchObject({ proposedByRole: 'STUDENT', forYou: true, awaiting: ['Test Coach'] });

    // The coach answers with a different time rather than accepting.
    expect((await request(app).post(`/api/chats/proposals/${original.id}/counter`).set('Cookie', coachCookie())
      .send({ startAt: asked.toISO() })).status).toBe(400);
    const countered = await request(app).post(`/api/chats/proposals/${original.id}/counter`).set('Cookie', coachCookie())
      .send({ startAt: edited.toISO(), message: 'Could we do 12pm instead?' });
    expect(countered.status).toBe(201);
    const messages = countered.body.thread.messages;
    expect(messages.find((message: { proposalId: string | null }) => message.proposalId === original.id).proposal)
      .toMatchObject({ status: 'COUNTERED', responses: [{ status: 'COUNTERED', byYou: true }] });
    const counter = messages.at(-1).proposal;
    expect(counter).toMatchObject({
      status: 'OPEN', isCounter: true, proposedByRole: 'COACH', forName: 'Ben Counters', awaiting: ['Ben Counters'],
      message: 'Could we do 12pm instead?',
    });
    expect(await prisma.booking.count({ where: { businessId: f.business.id } })).toBe(1);

    // The coach cannot confirm their own edit; Ben, who asked first, does.
    expect((await request(app).post(`/api/chats/proposals/${counter.id}/accept`).set('Cookie', coachCookie()).send({})).status).toBe(403);
    const accepted = await request(app).post(`/api/chats/proposals/${counter.id}/accept`).set('Cookie', ben.cookie).send({});
    expect(accepted.status).toBe(200);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: accepted.body.bookingId } });
    expect(booking.startAt.getTime()).toBe(edited.toMillis());
    expect(booking.status).toBe('CONFIRMED');
  });

  it('lets the other side decline and the proposer withdraw', async () => {
    const cara = await student('Cara Declines');
    const thread = await threadFor(await bookFor(cara));
    const first = await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', coachCookie())
      .send({ startAt: f.starts.plus({ weeks: 1 }).toISO() });
    const firstId = first.body.thread.messages.at(-1).proposal.id;
    expect((await request(app).post(`/api/chats/proposals/${firstId}/decline`).set('Cookie', coachCookie()).send({})).status).toBe(403);
    const declined = await request(app).post(`/api/chats/proposals/${firstId}/decline`).set('Cookie', cara.cookie)
      .send({ message: 'Away that week' });
    expect(declined.status).toBe(200);
    expect(declined.body.thread.messages.at(-1)).toMatchObject({ kind: 'SYSTEM', event: 'PROPOSAL_DECLINED' });
    expect(declined.body.thread.messages.at(-1).body).toContain('Away that week');
    expect((await prisma.sessionProposal.findUniqueOrThrow({ where: { id: firstId } })).status).toBe('DECLINED');

    const second = await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', coachCookie())
      .send({ startAt: f.starts.plus({ weeks: 2 }).toISO() });
    const secondId = second.body.thread.messages.at(-1).proposal.id;
    expect((await request(app).post(`/api/chats/proposals/${secondId}/withdraw`).set('Cookie', cara.cookie).send({})).status).toBe(403);
    const withdrawn = await request(app).post(`/api/chats/proposals/${secondId}/withdraw`).set('Cookie', coachCookie()).send({});
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.thread.messages.at(-1)).toMatchObject({ event: 'PROPOSAL_WITHDRAWN' });
    expect((await request(app).post(`/api/chats/proposals/${secondId}/accept`).set('Cookie', cara.cookie).send({})).status).toBe(409);
    expect(await prisma.booking.count({ where: { businessId: f.business.id } })).toBe(1);
  });

  it('refuses a proposed time the coach cannot teach and a club proposal', async () => {
    const dan = await student('Dan Conflict');
    const bookingId = await bookFor(dan);
    const thread = await threadFor(bookingId);
    const clash = await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', dan.cookie)
      .send({ startAt: f.starts.toISO() });
    expect(clash.status).toBe(409);
    expect(clash.body.conflicts[0].reason).toMatch(/already has a session|Student already has a session/);
    const night = await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', dan.cookie)
      .send({ startAt: f.starts.plus({ days: 7 }).set({ hour: 23 }).toISO() });
    expect(night.status).toBe(409);
    expect((await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', clubCookie())
      .send({ startAt: f.starts.plus({ weeks: 1 }).toISO() })).status).toBe(403);
    expect((await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', dan.cookie)
      .send({ startAt: f.starts.minus({ days: 30 }).toISO() })).status).toBe(400);
  });

  it('lets every student in a group answer a coach’s proposal for themselves', async () => {
    const group = await prisma.service.create({
      data: {
        businessId: f.business.id, name: 'Group tennis', type: 'GROUP', capacity: 4, duration: 60, price: 3000,
        noticeHours: 0, locations: { create: {
          locationId: f.location.id, price: 3000, duration: 60, instructors: { create: { instructorId: f.instructor.id } },
        } },
      },
    });
    const [eve, finn] = [await student('Eve Group'), await student('Finn Group')];
    for (const person of [eve, finn]) {
      const account = await prisma.user.findUniqueOrThrow({ where: { id: person.userId } });
      await createBookings(f.business.id, inputFor(f, {
        serviceId: group.id, student: { name: account.name, email: account.email },
      }), { studentUserId: person.userId });
    }
    const source = await prisma.booking.findFirstOrThrow({ where: { serviceId: group.id } });
    const thread = await threadFor(source.id);
    const joined = await prisma.chatMessage.findMany({ where: { threadId: thread.id, event: 'JOINED' } });
    expect(joined.map(message => message.body)).toEqual(['Finn Group joined this session.']);

    const proposed = await request(app).post(`/api/chats/${thread.id}/proposals`).set('Cookie', coachCookie())
      .send({ startAt: f.starts.plus({ weeks: 1 }).toISO() });
    expect(proposed.status).toBe(201);
    const proposal = proposed.body.thread.messages.at(-1).proposal;
    expect(proposal).toMatchObject({ forName: null, awaiting: ['Eve Group', 'Finn Group'] });

    const accepted = await request(app).post(`/api/chats/proposals/${proposal.id}/accept`).set('Cookie', eve.cookie).send({});
    expect(accepted.status).toBe(200);
    expect(accepted.body.thread.messages.find((message: { proposalId: string | null }) => message.proposalId === proposal.id).proposal)
      .toMatchObject({ status: 'OPEN', awaiting: ['Finn Group'] });
    expect((await request(app).post(`/api/chats/proposals/${proposal.id}/accept`).set('Cookie', eve.cookie).send({})).status).toBe(409);

    const declined = await request(app).post(`/api/chats/proposals/${proposal.id}/decline`).set('Cookie', finn.cookie).send({});
    expect(declined.status).toBe(200);
    expect((await prisma.sessionProposal.findUniqueOrThrow({ where: { id: proposal.id } })).status).toBe('CLOSED');
    const next = await prisma.booking.findUniqueOrThrow({
      where: { id: accepted.body.bookingId }, include: { participants: { include: { student: true } } },
    });
    expect(next.participants.map(participant => participant.student.userId)).toEqual([eve.userId]);
  });

  it('posts one day-before reminder per start time, and again after a move', async () => {
    const gia = await student('Gia Reminder');
    const bookingId = await bookFor(gia);
    const thread = await threadFor(bookingId);
    const scope = { businessIds: [f.business.id] };

    expect(await sendDueSessionReminders({ ...scope, now: f.starts.minus({ hours: 30 }).toJSDate() })).toBe(0);
    const dayBefore = f.starts.minus({ hours: 20 }).toJSDate();
    expect(await sendDueSessionReminders({ ...scope, now: dayBefore })).toBe(1);
    expect(await sendDueSessionReminders({ ...scope, now: dayBefore })).toBe(0);
    const reminders = await prisma.chatMessage.findMany({ where: { threadId: thread.id, event: 'REMINDER' } });
    expect(reminders).toHaveLength(1);
    expect(reminders[0].body).toMatch(/^Reminder: Private tennis is tomorrow, .* at 10:00 AM, with Test Coach at Test Court\.$/);

    // Reminders are for the people attending; the club is not badged.
    expect((await request(app).get('/api/chats/unread').set('Cookie', gia.cookie)).body.unreadThreads).toBe(1);
    expect((await request(app).get('/api/chats/unread').set('Cookie', coachCookie())).body.unreadThreads).toBe(1);
    expect((await request(app).get('/api/chats/unread').set('Cookie', clubCookie())).body.unreadThreads).toBe(0);

    const moved = f.starts.plus({ hours: 3 });
    await prisma.booking.update({ where: { id: bookingId }, data: { startAt: moved.toJSDate(), endAt: moved.plus({ hours: 1 }).toJSDate() } });
    expect(await sendDueSessionReminders({ ...scope, now: moved.minus({ hours: 2 }).toJSDate() })).toBe(1);
    expect(await prisma.chatMessage.count({ where: { threadId: thread.id, event: 'REMINDER' } })).toBe(2);

    await prisma.$transaction(tx => cancelBooking(tx, f.business.id, bookingId));
    expect(await prisma.chatMessage.count({ where: { threadId: thread.id, event: 'CANCELLED' } })).toBe(1);
  });

  it('reminds a session booked before chat existed by opening its thread', async () => {
    const hal = await student('Hal Legacy');
    const bookingId = await bookFor(hal);
    await prisma.chatThread.delete({ where: { bookingId } });
    expect(await sendDueSessionReminders({ businessIds: [f.business.id], now: f.starts.minus({ hours: 1 }).toJSDate() })).toBe(1);
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { bookingId }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    expect(thread.messages.map(message => message.event)).toEqual(['OPENED', 'REMINDER']);
    expect(thread.messages[1].body).toContain('today');

    // Opening a chat from a booking is idempotent.
    const opened = await request(app).post(`/api/chats/bookings/${bookingId}`).set('Cookie', hal.cookie).send({});
    expect(opened.body).toEqual({ threadId: thread.id });
    const outsider = await createAccount(f, { name: 'Nosy Student' });
    const { cookie } = await createSession(f, outsider.id);
    expect((await request(app).post(`/api/chats/bookings/${bookingId}`).set('Cookie', cookie).send({})).status).toBe(404);
  });

  it('lets a platform admin read every chat without posting', async () => {
    const original = config.adminPassword;
    config.adminPassword = 'test-admin-password-chat';
    try {
      const ivy = await student('Ivy Admin View');
      const thread = await threadFor(await bookFor(ivy));
      await request(app).post(`/api/chats/${thread.id}/messages`).set('Cookie', ivy.cookie).send({ body: 'Hello coach' });

      expect((await request(app).get('/api/admin/chats')).status).toBe(401);
      const login = await request(app).post('/api/admin/login').send({ password: 'test-admin-password-chat' });
      const admin = login.headers['set-cookie'];
      const list = await request(app).get('/api/admin/chats').query({ q: 'Ivy Admin' }).set('Cookie', admin);
      expect(list.status).toBe(200);
      expect(list.body.threads).toHaveLength(1);
      expect(list.body.threads[0]).toMatchObject({ id: thread.id, messageCount: 1, lastMessage: { body: 'Hello coach', mine: false } });
      const detail = await request(app).get(`/api/admin/chats/${thread.id}`).set('Cookie', admin);
      expect(detail.body.viewer).toMatchObject({ role: 'ADMIN', canPost: false, canPropose: false });
      expect(detail.body.messages.map((message: { body: string }) => message.body)).toContain('Hello coach');
    } finally {
      config.adminPassword = original;
    }
  });
});
