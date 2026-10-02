import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import { app } from '../src/app.js';
import { chatWhen } from '../src/chat-events.js';
import { createAccount, createSession, prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type Person = { id: string; cookie: string };

describe('chat clock', () => {
  it('writes every chat time line in Singapore time', () => {
    expect(chatWhen(new Date('2026-10-21T02:00:00.000Z'))).toBe('Wed, 21 Oct at 10:00 AM');
    expect(chatWhen(new Date('2026-10-21T17:30:00.000Z'))).toBe('Thu, 22 Oct at 1:30 AM');
  });
});

describe.sequential('Chat read receipts, clock and capability gates', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function person(name: string): Promise<Person> {
    const account = await createAccount(club, { name });
    const { cookie } = await createSession(club, account.id);
    return { id: account.id, cookie };
  }

  async function conversationWithCoach(student: Person) {
    const opened = await request(app).post('/api/chats/accounts').set('Cookie', student.cookie)
      .send({ username: club.coachUser.username }).expect(200);
    return opened.body.threadId as string;
  }

  const detail = async (threadId: string, cookie: string) => (await request(app).get(`/api/chats/${threadId}`)
    .query({ contract: 'accounts' }).set('Cookie', cookie).expect(200)).body;
  const send = async (threadId: string, cookie: string, body: string) => (await request(app)
    .post(`/api/chats/${threadId}/messages`).set('Cookie', cookie).send({ body }).expect(201)).body.message;
  const markRead = (threadId: string, cookie: string) => request(app).post(`/api/chats/${threadId}/read`)
    .query({ contract: 'accounts' }).set('Cookie', cookie).send({}).expect(200);

  it('reports how far the other side has read, never counting the reader themself', async () => {
    const student = await person('Receipt Student');
    const threadId = await conversationWithCoach(student);

    const first = await send(threadId, student.cookie, 'Are you free this week?');
    // Sending moves only the sender's own read position: one tick.
    expect((await detail(threadId, student.cookie)).othersReadAt).toBeNull();

    await markRead(threadId, club.coachCookie);
    const read = await detail(threadId, student.cookie);
    expect(Date.parse(read.othersReadAt)).toBeGreaterThanOrEqual(Date.parse(first.createdAt));

    // A newer message stays unread until the coach reads again.
    const second = await send(threadId, student.cookie, 'Thursday works for me.');
    const pending = await detail(threadId, student.cookie);
    expect(Date.parse(pending.othersReadAt)).toBeLessThan(Date.parse(second.createdAt));

    // Replying marks the coach's position too, so the student sees both read.
    const reply = await send(threadId, club.coachCookie, 'Thursday is good.');
    const replied = await detail(threadId, student.cookie);
    expect(Date.parse(replied.othersReadAt)).toBeGreaterThanOrEqual(Date.parse(second.createdAt));
    expect(Date.parse(replied.othersReadAt)).toBeGreaterThanOrEqual(Date.parse(reply.createdAt));

    // The coach's own receipt follows the student, not the coach's own reads.
    const coachView = await detail(threadId, club.coachCookie);
    expect(Date.parse(coachView.othersReadAt)).toBeLessThan(Date.parse(reply.createdAt));
  });

  it('reads and shows a conversation in Singapore time even when the club keeps another clock', async () => {
    await prisma.business.update({ where: { id: club.business.id }, data: { timezone: 'Europe/London' } });
    const student = await person('Clock Student');
    const threadId = await conversationWithCoach(student);
    const day = DateTime.now().setZone('Asia/Singapore').plus({ days: 3 }).startOf('day');

    await send(threadId, student.cookie, `Can we train on ${day.toFormat('d LLL').toLowerCase()} at 5pm?`);
    const view = await detail(threadId, student.cookie);
    expect(view.conversation.timezone).toBe('Asia/Singapore');
    expect(view.scheduleSuggestion).toMatchObject({
      timezone: 'Asia/Singapore',
      startAt: day.set({ hour: 17 }).toUTC().toISO(),
    });
  });

  it('lets a teen account use Chat while commercial routes stay closed to it', async () => {
    const teen = await person('Teen Chat Student');
    await prisma.user.update({
      where: { id: teen.id },
      data: { dateOfBirth: new Date(`${DateTime.now().minus({ years: 15 }).toISODate()}T00:00:00.000Z`) },
    });

    expect((await request(app).get('/api/chats').query({ contract: 'accounts' }).set('Cookie', teen.cookie).expect(200))
      .body.threads).toEqual([]);
    await request(app).get('/api/chats/unread').query({ contract: 'accounts' }).set('Cookie', teen.cookie).expect(200);
    await request(app).get('/api/account/notifications').set('Cookie', teen.cookie).expect(200);
    for (const [path, capability] of [['/api/payments/capabilities', 'payments'], ['/api/account/package-offers', 'commerce']]) {
      expect((await request(app).get(path).set('Cookie', teen.cookie).expect(403)).body)
        .toMatchObject({ code: 'CAPABILITY_REQUIRED', capability });
    }
  });
});
