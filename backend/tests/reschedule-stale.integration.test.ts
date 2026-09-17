import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  createAccount, createSession, prisma, publicInputFor, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Stale reschedule requests', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function studentBooking(day: number, name: string) {
    const account = await createAccount(f, { name });
    const session = await createSession(f, account.id);
    const response = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', session.cookie).send(publicInputFor(f, {
        startAt: f.starts.plus({ days: day }).toISO()!,
      })).expect(201);
    return { account, cookie: session.cookie, booking: response.body.bookings[0] };
  }

  it('commits EXPIRED before returning 409 when the provider accepts a stale student proposal', async () => {
    const original = await studentBooking(0, 'Provider Response Student');
    const proposedStart = f.starts.plus({ days: 1 });
    const proposed = await request(app)
      .post(`/api/account/bookings/${original.booking.participants[0].id}/reschedule-requests`)
      .set('Cookie', original.cookie).send({ startAt: proposedStart.toISO() }).expect(201);
    const requestId = proposed.body.rescheduleRequest.id as string;

    await studentBooking(1, 'Competing Student');
    const response = await request(app).post(`/api/reschedule-requests/${requestId}/accept`)
      .set('Cookie', f.cookie).send({}).expect(409);

    expect(response.body).toEqual({
      error: 'That time is no longer available. Ask for another time.',
      conflicts: [{
        date: proposedStart.toJSDate().toISOString(),
        reason: 'Coach already has a session or preparation buffer',
      }],
    });
    const persisted = await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(persisted).toMatchObject({
      status: 'EXPIRED',
      respondedByUserId: f.user.id,
      responseMessage: 'Coach already has a session or preparation buffer',
    });
    expect(persisted.respondedAt).toBeInstanceOf(Date);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: original.booking.id } }))
      .toMatchObject({ startAt: f.starts.toJSDate(), status: 'CONFIRMED' });
  });

  it('commits EXPIRED before returning 409 when the student accepts a stale provider proposal', async () => {
    const original = await studentBooking(0, 'Student Response Student');
    const proposedStart = f.starts.plus({ days: 1 });
    const proposed = await request(app).post(`/api/bookings/${original.booking.id}/reschedule-requests`)
      .set('Cookie', f.cookie).send({ startAt: proposedStart.toISO() }).expect(201);
    const requestId = proposed.body.id as string;

    await studentBooking(1, 'Other Competing Student');
    const response = await request(app).post(`/api/account/reschedule-requests/${requestId}/accept`)
      .set('Cookie', original.cookie).send({}).expect(409);

    expect(response.body).toEqual({
      error: 'That time is no longer available. Ask for another time.',
      conflicts: [{
        date: proposedStart.toJSDate().toISOString(),
        reason: 'Coach already has a session or preparation buffer',
      }],
    });
    const persisted = await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(persisted).toMatchObject({
      status: 'EXPIRED',
      respondedByUserId: original.account.id,
      responseMessage: 'Coach already has a session or preparation buffer',
    });
    expect(persisted.respondedAt).toBeInstanceOf(Date);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: original.booking.id } }))
      .toMatchObject({ startAt: f.starts.toJSDate(), status: 'CONFIRMED' });
  });
});
