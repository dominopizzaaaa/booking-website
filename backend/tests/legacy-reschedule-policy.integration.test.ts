import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import {
  createAccount, createSession, prisma, publicInputFor, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Legacy booking reschedule policy', () => {
  let tenants: TestTenants;
  let fixture: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function createLegacyBooking() {
    const account = await createAccount(fixture, { name: 'Legacy policy player' });
    const { cookie } = await createSession(fixture, account.id);
    const created = await request(app).post(`/api/public/${fixture.business.slug}/bookings`)
      .set('Cookie', cookie).send(publicInputFor(fixture)).expect(201);
    const bookingId = created.body.bookings[0].id as string;
    const participantId = created.body.bookings[0].participants[0].id as string;
    const token = randomBytes(32).toString('base64url');
    await prisma.participant.update({
      where: { id: participantId },
      data: {
        managementTokenHash: createHash('sha256').update(token).digest('hex'),
        managementTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000),
        managementTokenRevokedAt: null,
      },
    });
    return { bookingId, participantId, token };
  }

  it('uses the stricter coach notice window for legacy reads and writes', async () => {
    await prisma.business.update({ where: { id: fixture.business.id }, data: { cancellationHours: 24 } });
    await prisma.instructor.update({ where: { id: fixture.instructor.id }, data: { rescheduleNoticeHours: 72 } });
    const legacy = await createLegacyBooking();
    const startAt = new Date(Date.now() + 48 * 3_600_000);
    await prisma.booking.update({
      where: { id: legacy.bookingId },
      data: { startAt, endAt: new Date(startAt.getTime() + 3_600_000) },
    });

    const managed = await request(app).get(`/api/manage/${legacy.token}`).expect(200);
    expect(managed.body).toMatchObject({
      canCancel: true,
      canReschedule: false,
      management: { cancellationHours: 24, rescheduleNoticeHours: 72 },
    });

    await request(app).post(`/api/manage/${legacy.token}/reschedule`)
      .send({ startAt: fixture.starts.plus({ days: 1 }).toISO() }).expect(400)
      .expect(({ body }) => {
        expect(body.error).toBe('Reschedule requests close 72 hours before the session starts. Please contact the coach directly.');
      });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: legacy.bookingId } })).startAt).toEqual(startAt);
  });

  it('does not let a legacy link reschedule a lesson awaiting coach acceptance', async () => {
    const legacy = await createLegacyBooking();
    await prisma.booking.update({
      where: { id: legacy.bookingId },
      data: { status: 'PENDING', coachAcceptance: 'PENDING', createdByRole: 'CLUB' },
    });

    const managed = await request(app).get(`/api/manage/${legacy.token}`).expect(200);
    expect(managed.body).toMatchObject({ canCancel: true, canReschedule: false });

    const proposedStart = fixture.starts.plus({ days: 1 });
    const rejected = await request(app).post(`/api/manage/${legacy.token}/reschedule`)
      .send({ startAt: proposedStart.toISO() }).expect(400);
    expect(rejected.body.error).toBe(
      'This lesson is still waiting for the coach to accept it. Reschedule it once it is confirmed.',
    );
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: legacy.bookingId } }))
      .toMatchObject({
        status: 'PENDING', coachAcceptance: 'PENDING', startAt: fixture.starts.toJSDate(),
      });
    expect(await prisma.notification.count({ where: { bookingId: legacy.bookingId, type: 'RESCHEDULE' } }))
      .toBe(0);
  });

  it('keeps the legacy mutation body strict and rejects invalid credentials', async () => {
    const legacy = await createLegacyBooking();
    const startAt = fixture.starts.plus({ days: 1 }).toISO()!;

    await request(app).post(`/api/manage/${legacy.token}/reschedule`)
      .send({ startAt, unexpected: true }).expect(400);
    await request(app).get('/api/manage/not-a-token').expect(400);
    await request(app).post('/api/manage/not-a-token/reschedule').send({ startAt }).expect(400);

    const unknownToken = randomBytes(32).toString('base64url');
    await request(app).get(`/api/manage/${unknownToken}`).expect(404);
    await request(app).post(`/api/manage/${unknownToken}/reschedule`).send({ startAt }).expect(404);

    await prisma.participant.update({
      where: { id: legacy.participantId },
      data: { managementTokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    await request(app).get(`/api/manage/${legacy.token}`).expect(410);
    await request(app).post(`/api/manage/${legacy.token}/reschedule`).send({ startAt }).expect(410);

    await prisma.participant.update({
      where: { id: legacy.participantId },
      data: {
        managementTokenExpiresAt: new Date(Date.now() + 86_400_000),
        managementTokenRevokedAt: new Date(),
      },
    });
    await request(app).get(`/api/manage/${legacy.token}`).expect(410);
    await request(app).post(`/api/manage/${legacy.token}/reschedule`).send({ startAt }).expect(410);

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: legacy.bookingId } })).startAt)
      .toEqual(fixture.starts.toJSDate());
  });
});
