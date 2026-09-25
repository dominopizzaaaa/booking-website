import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { createBookings } from '../src/scheduling.js';
import {
  createAccount, createSession, createStudent, inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Calendar-aware scheduling', () => {
  let tenants: TestTenants;
  let first: Fixture;
  const initiallyEnabled = config.googleCalendar.enabled;

  beforeEach(async () => {
    config.googleCalendar.enabled = true;
    tenants = new TestTenants();
    first = await tenants.fixture();
  });
  afterEach(async () => {
    config.googleCalendar.enabled = initiallyEnabled;
    await tenants.cleanup();
  });

  async function calendarConnection(userId: string, busyCheckEnabled = true) {
    return prisma.calendarConnection.create({
      data: {
        userId, providerAccountId: randomUUID(), providerEmail: `${randomUUID()}@example.test`,
        accessTokenCiphertext: 'encrypted-for-test', accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
        busyCheckEnabled,
      },
    });
  }

  it('serializes and blocks concurrent overlaps for a portable coach across workspaces', async () => {
    const second = await tenants.fixture();
    await prisma.membership.update({
      where: { id: first.coachMembership.id },
      data: { userId: second.coachUser.id },
    });

    const [firstStudent, secondStudent] = await Promise.all([createStudent(first), createStudent(second)]);
    const startAt = second.starts.plus({ days: 2 }).toISO()!;
    const results = await Promise.allSettled([
      createBookings(first.business.id, inputFor(first, {
        studentId: firstStudent.id, student: undefined, startAt,
      })),
      createBookings(second.business.id, inputFor(second, {
        studentId: secondStudent.id, student: undefined, startAt,
      })),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    expect(await prisma.booking.count({
      where: { businessId: { in: [first.business.id, second.business.id] } },
    })).toBe(1);
  });

  it('serializes and blocks concurrent overlaps for a student across businesses', async () => {
    const second = await tenants.fixture();
    const studentAccount = await createAccount(first, { name: 'Portable Student' });
    const [firstStudent, secondStudent] = await Promise.all([
      createStudent(first, {
        userId: studentAccount.id, name: studentAccount.name, email: studentAccount.email,
      }),
      createStudent(second, {
        userId: studentAccount.id, name: studentAccount.name, email: studentAccount.email,
      }),
    ]);
    const startAt = first.starts.plus({ days: 3 }).toISO()!;
    const results = await Promise.allSettled([
      createBookings(first.business.id, inputFor(first, {
        studentId: firstStudent.id, student: undefined, startAt,
      })),
      createBookings(second.business.id, inputFor(second, {
        studentId: secondStudent.id, student: undefined, startAt,
      })),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({
      reason: {
        status: 409,
        details: { conflicts: [{ reason: 'Student already has a session at this time' }] },
      },
    });
    expect(await prisma.booking.count({
      where: { businessId: { in: [first.business.id, second.business.id] } },
    })).toBe(1);
  });

  it('allows a student to join a group without treating that target booking as a conflict', async () => {
    await prisma.service.update({ where: { id: first.service.id }, data: { type: 'GROUP', capacity: 3 } });
    const enrolled = await createStudent(first);
    const group = await createBookings(first.business.id, inputFor(first, {
      studentId: enrolled.id, student: undefined,
    }));
    const joining = await createStudent(first);
    const joined = await createBookings(first.business.id, inputFor(first, {
      studentId: joining.id, student: undefined,
    }));
    expect(joined.bookings[0]).toMatchObject({ id: group.bookings[0]!.id, type: 'GROUP' });
  });

  it('blocks a group join when the student has a different simultaneous booking', async () => {
    await prisma.service.update({ where: { id: first.service.id }, data: { type: 'GROUP', capacity: 3 } });
    await createBookings(first.business.id, inputFor(first, {
      studentId: (await createStudent(first)).id, student: undefined,
    }));
    const joining = await createStudent(first);
    const second = await tenants.fixture();
    const linkedElsewhere = await prisma.student.create({ data: {
      businessId: second.business.id, userId: joining.userId, name: joining.name,
      email: joining.email, initials: joining.initials,
    } });
    await prisma.booking.create({ data: {
      businessId: second.business.id, serviceId: second.service.id, instructorId: second.instructor.id,
      locationId: second.location.id, startAt: first.starts.toJSDate(), endAt: first.starts.plus({ hours: 1 }).toJSDate(),
      duration: 60, bufferMinutes: 0, status: 'CONFIRMED', type: 'PRIVATE', capacity: 1, price: 8_000,
      paymentRoute: 'CLUB', coachAcceptance: 'NOT_REQUIRED', createdByRole: 'CLUB',
      participants: { create: { studentId: linkedElsewhere.id, price: 8_000 } },
    } });
    await expect(createBookings(first.business.id, inputFor(first, {
      studentId: joining.id, student: undefined,
    }))).rejects.toMatchObject({
      status: 409,
      details: { conflicts: [{ reason: 'Student already has a session at this time' }] },
    });
  });

  it('uses only fresh enabled cached intervals and preserves half-open boundaries', async () => {
    const connection = await calendarConnection(first.coachUser.id);
    await prisma.calendarBusyInterval.createMany({ data: [
      {
        connectionId: connection.id, startAt: first.starts.toJSDate(),
        endAt: first.starts.plus({ hours: 1 }).toJSDate(), expiresAt: new Date(Date.now() + 60_000),
      },
    ] });
    const blockedStudent = await createStudent(first);
    await expect(createBookings(first.business.id, inputFor(first, {
      studentId: blockedStudent.id, student: undefined,
    }))).rejects.toMatchObject({
      status: 409,
      details: { conflicts: [{ reason: 'Coach has a conflict in their connected calendar' }] },
    });

    const boundaryStudent = await createStudent(first);
    await expect(createBookings(first.business.id, inputFor(first, {
      studentId: boundaryStudent.id, student: undefined, startAt: first.starts.plus({ hours: 1 }).toISO()!,
    }))).resolves.toBeDefined();

    await prisma.calendarBusyInterval.updateMany({
      where: { connectionId: connection.id }, data: { expiresAt: new Date(Date.now() - 1) },
    });
    const staleStudent = await createStudent(first);
    await expect(createBookings(first.business.id, inputFor(first, {
      studentId: staleStudent.id, student: undefined,
    }))).resolves.toBeDefined();
  });

  it('fails open when the calendar integration is not configured', async () => {
    const connection = await calendarConnection(first.coachUser.id);
    await prisma.calendarBusyInterval.create({ data: {
      connectionId: connection.id, startAt: first.starts.toJSDate(),
      endAt: first.starts.plus({ hours: 1 }).toJSDate(), expiresAt: new Date(Date.now() + 60_000),
    } });
    config.googleCalendar.enabled = false;
    const student = await createStudent(first);
    const result = await createBookings(first.business.id, inputFor(first, {
      studentId: student.id, student: undefined,
    }));
    expect(await prisma.calendarSyncJob.findUnique({ where: { bookingId: result.bookings[0]!.id } })).toBeNull();
  });

  it('does not queue bookings when no participant or coach has a calendar connection', async () => {
    const student = await createStudent(first);
    const result = await createBookings(first.business.id, inputFor(first, {
      studentId: student.id, student: undefined,
    }));
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: result.bookings[0]!.id } });

    expect(booking.calendarRevision).toBe(0);
    expect(await prisma.calendarSyncJob.findUnique({ where: { bookingId: booking.id } })).toBeNull();
  });

  it('checks the resolved student account and queues a coalesced booking sync', async () => {
    const student = await createStudent(first);
    const connection = await calendarConnection(student.userId!);
    await prisma.calendarBusyInterval.create({ data: {
      connectionId: connection.id, startAt: first.starts.plus({ minutes: 15 }).toJSDate(),
      endAt: first.starts.plus({ minutes: 30 }).toJSDate(), expiresAt: new Date(Date.now() + 60_000),
    } });
    await expect(createBookings(first.business.id, inputFor(first, {
      studentId: student.id, student: undefined,
    }))).rejects.toMatchObject({
      status: 409,
      details: { conflicts: [{ reason: 'Student has a conflict in their connected calendar' }] },
    });

    await prisma.calendarConnection.update({ where: { id: connection.id }, data: { busyCheckEnabled: false } });
    const result = await createBookings(first.business.id, inputFor(first, {
      studentId: student.id, student: undefined,
    }));
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: result.bookings[0]!.id } });
    const job = await prisma.calendarSyncJob.findUniqueOrThrow({ where: { bookingId: booking.id } });
    expect(booking.calendarRevision).toBe(1);
    expect(job.requestedRevision).toBe(1);
  });

  it('coalesces group joins and participant cancellation into one booking job', async () => {
    await prisma.service.update({ where: { id: first.service.id }, data: { type: 'GROUP', capacity: 3 } });
    await calendarConnection(first.coachUser.id, false);
    const firstStudent = await createStudent(first);
    const secondAccount = await createAccount(first, { name: 'Calendar Group Student' });
    const secondSession = await createSession(first, secondAccount.id);
    const initial = await createBookings(first.business.id, inputFor(first, {
      studentId: firstStudent.id, student: undefined,
    }));
    const bookingId = initial.bookings[0]!.id;
    const joined = await createBookings(first.business.id, inputFor(first, {
      student: { name: secondAccount.name, email: secondAccount.email },
    }), { studentUserId: secondAccount.id });
    const participantId = joined.bookings[0]!.participants.find(
      participant => participant.studentId !== firstStudent.id,
    )!.id;
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ calendarRevision: 2, status: 'CONFIRMED' });

    await request(app).post(`/api/account/bookings/${participantId}/cancel`)
      .set('Cookie', secondSession.cookie).send({}).expect(200);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ calendarRevision: 3, status: 'CONFIRMED' });
    expect(await prisma.calendarSyncJob.findUniqueOrThrow({ where: { bookingId } }))
      .toMatchObject({ requestedRevision: 3 });
  });
});
