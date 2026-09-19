import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import {
  createPackage, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Elapsed provider booking lifecycle', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => { tenants = new TestTenants(); f = await tenants.fixture(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await tenants.cleanup();
  });

  async function assignedPackageBooking(day: number) {
    const student = await createStudent(f, { name: `Elapsed Student ${day}` });
    const pkg = await createPackage(f, student.id);
    const created = await request(app).post('/api/bookings').set('Cookie', f.cookie).send(inputFor(f, {
      studentId: student.id, student: undefined, packageId: pkg.id,
      startAt: f.starts.plus({ days: day }).toISO()!,
    })).expect(201);
    return { bookingId: created.body.bookings[0].id as string, packageId: pkg.id };
  }

  async function setEndAtBoundary(bookingId: string) {
    const boundary = new Date();
    vi.spyOn(Date, 'now').mockReturnValue(boundary.getTime());
    await prisma.booking.update({
      where: { id: bookingId },
      data: {
        startAt: new Date(boundary.getTime() - 60 * 60_000),
        endAt: boundary,
      },
    });
  }

  async function effectCounts(bookingId: string) {
    const [workspace, account] = await Promise.all([
      prisma.notification.count({ where: { bookingId } }),
      prisma.accountNotification.count({ where: { bookingId } }),
    ]);
    return { workspace, account };
  }

  it('rejects confirmed cancellation at endAt for the club and coach without refunding credit', async () => {
    const { bookingId, packageId } = await assignedPackageBooking(1);
    await request(app).post(`/api/bookings/${bookingId}/accept`)
      .set('Cookie', f.coachCookie).send({}).expect(200);
    await setEndAtBoundary(bookingId);
    const before = await effectCounts(bookingId);

    for (const cookie of [f.cookie, f.coachCookie]) {
      const response = await request(app).patch(`/api/bookings/${bookingId}`)
        .set('Cookie', cookie).send({ status: 'CANCELLED' }).expect(400);
      expect(response.body.error).toBe('A lesson cannot be cancelled after it has ended.');
    }

    const [booking, pkg, participant] = await Promise.all([
      prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
      prisma.lessonPackage.findUniqueOrThrow({ where: { id: packageId } }),
      prisma.participant.findFirstOrThrow({ where: { bookingId } }),
    ]);
    expect(booking.status).toBe('CONFIRMED');
    expect(pkg.usedCredits).toBe(1);
    expect(participant).toMatchObject({ creditConsumed: true, cancelledAt: null });
    expect(await effectCounts(bookingId)).toEqual(before);

    const noted = await request(app).patch(`/api/bookings/${bookingId}`)
      .set('Cookie', f.coachCookie).send({ notes: 'Lesson finished as planned' }).expect(200);
    expect(noted.body).toMatchObject({ status: 'CONFIRMED', notes: 'Lesson finished as planned' });
    const completed = await request(app).patch(`/api/bookings/${bookingId}`)
      .set('Cookie', f.cookie).send({ status: 'COMPLETED' }).expect(200);
    expect(completed.body.status).toBe('COMPLETED');
    const corrected = await request(app).patch(`/api/bookings/${bookingId}`)
      .set('Cookie', f.coachCookie).send({ notes: 'Corrected lesson notes' }).expect(200);
    expect(corrected.body).toMatchObject({ status: 'COMPLETED', notes: 'Corrected lesson notes' });
  });

  it('rejects pending cancellation and coach decisions at endAt without refunding credit', async () => {
    const { bookingId, packageId } = await assignedPackageBooking(2);
    await setEndAtBoundary(bookingId);
    const before = await effectCounts(bookingId);

    const cancelled = await request(app).patch(`/api/bookings/${bookingId}`)
      .set('Cookie', f.cookie).send({ status: 'CANCELLED' }).expect(400);
    expect(cancelled.body.error).toBe('A lesson cannot be cancelled after it has ended.');

    await request(app).post(`/api/bookings/${bookingId}/accept`)
      .set('Cookie', f.cookie).send({}).expect(403);
    await request(app).post(`/api/bookings/${bookingId}/decline`)
      .set('Cookie', f.cookie).send({}).expect(403);
    for (const decision of ['accept', 'decline'] as const) {
      const response = await request(app).post(`/api/bookings/${bookingId}/${decision}`)
        .set('Cookie', f.coachCookie).send({}).expect(400);
      expect(response.body.error).toBe('A lesson cannot be accepted or declined after it has ended.');
    }

    const [booking, pkg, participant] = await Promise.all([
      prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
      prisma.lessonPackage.findUniqueOrThrow({ where: { id: packageId } }),
      prisma.participant.findFirstOrThrow({ where: { bookingId } }),
    ]);
    expect(booking).toMatchObject({
      status: 'PENDING', coachAcceptance: 'PENDING', coachRespondedAt: null,
    });
    expect(pkg.usedCredits).toBe(1);
    expect(participant).toMatchObject({ creditConsumed: true, cancelledAt: null });
    expect(await effectCounts(bookingId)).toEqual(before);
  });
});
