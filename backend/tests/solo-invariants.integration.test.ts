import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  TestTenants, createAccount, createSession, createStudent, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

const tenants = new TestTenants();

describe.sequential('Solo practice invariants', () => {
  let club: Fixture;

  beforeAll(async () => {
    await verifyTestDatabase();
    club = await tenants.fixture();
  });

  afterAll(async () => {
    await tenants.cleanup();
    await prisma.$disconnect();
  });

  async function createLegacySoloPractice(name: string) {
    const coach = await createAccount(club, {
      name: `${name} Coach`, email: `${randomUUID()}@example.test`,
      accountType: 'COACH', passwordHash: 'not-used-by-this-test',
    });
    const historical = await prisma.$transaction(async tx => {
      const business = await tx.business.create({
        data: {
          name, slug: `legacy-solo-${randomUUID()}`, ownerName: coach.name, email: coach.email,
          kind: 'SOLO', legacyReadOnly: true,
        },
      });
      const instructor = await tx.instructor.create({
        data: {
          businessId: business.id, name: coach.name, initials: 'LC', email: coach.email,
        },
      });
      const location = await tx.location.create({
        data: { businessId: business.id, name: `${name} Court`, travelMinutes: 20 },
      });
      const service = await tx.service.create({
        data: {
          businessId: business.id, name: 'Historical private lesson', type: 'PRIVATE',
          capacity: 1, duration: 60, price: 8000, noticeHours: 0,
          locations: { create: {
            locationId: location.id, price: 8000, duration: 60,
            instructors: { create: { instructorId: instructor.id } },
          } },
        },
      });
      const membership = await tx.membership.create({
        data: { businessId: business.id, userId: coach.id, instructorId: instructor.id },
      });
      await tx.availability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: business.id, instructorId: instructor.id, locationId: location.id,
        dayOfWeek, startTime: '08:00', endTime: '20:00',
      })) });
      return { business, instructor, location, service, membership };
    });
    tenants.own(historical.business.id);
    const session = await createSession(club, coach.id);
    return { coach, session, ...historical };
  }

  async function createHistoricalBooking(options: {
    businessId?: string;
    paymentRoute?: 'CLUB' | 'DIRECT';
    userId?: string;
    day?: number;
    managementTokenScheme?: 'sha256' | 'md5';
  } = {}) {
    const businessId = options.businessId ?? club.business.id;
    const [business, service, instructor, location] = await Promise.all([
      prisma.business.findUniqueOrThrow({ where: { id: businessId } }),
      prisma.service.findFirstOrThrow({ where: { businessId } }),
      prisma.instructor.findFirstOrThrow({ where: { businessId } }),
      prisma.location.findFirstOrThrow({ where: { businessId } }),
    ]);
    const account = options.userId
      ? await prisma.user.findUniqueOrThrow({ where: { id: options.userId } })
      : await createAccount(club, { name: `Historical Student ${randomUUID()}` });
    const student = await prisma.student.create({
      data: {
        businessId, userId: account.id, name: account.name, initials: 'HS', email: account.email,
      },
    });
    const startAt = club.starts.plus({ days: options.day ?? 20 });
    const token = randomBytes(32).toString('base64url');
    const participantId = randomUUID();
    const managementTokenHash = options.managementTokenScheme === 'md5'
      ? createHash('md5').update(`${token}${participantId}`).digest('hex')
      : createHash('sha256').update(token).digest('hex');
    const booking = await prisma.$transaction(async tx => {
      // A clean database rejects new SOLO/DIRECT commerce. Disable triggers
      // only on this test transaction to model a row retained by the migration.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      return tx.booking.create({
        data: {
          businessId, serviceId: service.id, instructorId: instructor.id, locationId: location.id,
          startAt: startAt.toJSDate(), endAt: startAt.plus({ hours: 1 }).toJSDate(),
          duration: 60, type: 'PRIVATE', capacity: 1, price: 8000,
          paymentRoute: options.paymentRoute ?? 'CLUB',
          participants: { create: {
            id: participantId, studentId: student.id, price: 8000, managementTokenHash,
            managementTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000),
          } },
        },
        include: { participants: true },
      });
    });
    return { business, account, student, booking, participantId, token, managementTokenHash };
  }

  const packageInput = (studentId: string, name: string) => ({
    studentId, name, serviceId: null, totalCredits: 4, price: 24_000,
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), paid: true,
  });

  it('records an already-paid package with the payment kind dictated by the business kind', async () => {
    const clubStudent = await createStudent(club, { name: 'Club Package Student' });
    const clubPackage = await request(app).post('/api/packages').set('Cookie', club.cookie)
      .send(packageInput(clubStudent.id, 'Club package')).expect(201);
    expect(await prisma.payment.findFirstOrThrow({ where: { packageId: clubPackage.body.id } }))
      .toMatchObject({ kind: 'STUDENT_TO_CLUB' });

    const solo = await createLegacySoloPractice('Package Practice');
    const studentAccount = await createAccount(club, {
      name: 'Solo Package Student', email: `${randomUUID()}@example.test`, accountType: 'STUDENT',
    });
    const soloStudent = await prisma.student.create({
      data: {
        businessId: solo.business.id, userId: studentAccount.id, name: studentAccount.name,
        initials: 'SP', email: studentAccount.email,
      },
    });
    // Retained records are inserted directly because legacy practices cannot
    // re-enter a workspace to make new commercial writes. Their original
    // money route must still remain auditable.
    const { soloPackage, historicalPayment } = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      const soloPackage = await tx.lessonPackage.create({
        data: {
          businessId: solo.business.id, studentId: soloStudent.id, name: 'Solo package',
          totalCredits: 4, price: 24_000,
          expiresAt: new Date(Date.now() + 90 * 86_400_000), paid: true,
        },
      });
      const historicalPayment = await tx.payment.create({
        data: {
          businessId: solo.business.id, studentId: soloStudent.id, packageId: soloPackage.id,
          amount: 24_000, method: 'CASH', kind: 'STUDENT_TO_COACH',
        },
      });
      return { soloPackage, historicalPayment };
    });
    expect(historicalPayment).toMatchObject({ kind: 'STUDENT_TO_COACH', packageId: soloPackage.id });
  });

  it('allows a club to add a roster coach but keeps a legacy solo practice inaccessible', async () => {
    const rosterCoach = await createAccount(club, {
      name: 'Portable Coach', email: `${randomUUID()}@example.test`,
      accountType: 'COACH', passwordHash: 'not-used-by-this-test',
    });
    const roster = await request(app).post('/api/instructors').set('Cookie', club.cookie)
      .send({ name: rosterCoach.name, email: rosterCoach.email, rescheduleNoticeHours: 48 }).expect(201);
    expect(roster.body).toMatchObject({ email: rosterCoach.email, rescheduleNoticeHours: 48 });

    const solo = await createLegacySoloPractice('Single Coach Practice');
    const account = await request(app).get('/api/auth/me').set('Cookie', solo.session.cookie).expect(200);
    expect(account.body.membership).toBeNull();
    expect(account.body.memberships.map((membership: { id: string }) => membership.id))
      .not.toContain(solo.membership.id);

    const rejected = await request(app).post('/api/auth/switch-workspace')
      .set('Cookie', solo.session.cookie).send({ membershipId: solo.membership.id }).expect(403);
    expect(rejected.body.error).toBe('Workspace membership is not available to this account');
    expect(await prisma.instructor.count({ where: { businessId: solo.business.id } })).toBe(1);
    expect(await prisma.membership.count({ where: { businessId: solo.business.id } })).toBe(1);
  });

  it('does not expose coach own-practice creation', async () => {
    const coach = await createAccount(club, {
      name: 'Concurrent Coach', email: `${randomUUID()}@example.test`,
      accountType: 'COACH', passwordHash: 'not-used-by-this-test',
    });
    const session = await createSession(club, coach.id);
    const response = await request(app).post('/api/auth/practice')
      .set('Cookie', session.cookie).send({ name: 'New Practice' }).expect(403);
    expect(response.body.error).toBe('Select a business workspace to continue');
    expect(await prisma.membership.count({
      where: { userId: coach.id, business: { kind: 'SOLO' } },
    })).toBe(0);
  });

  it('reads retained SOLO MD5 management links without changing their hash or booking', async () => {
    const solo = await createLegacySoloPractice('Immutable Solo Practice');
    const historical = await createHistoricalBooking({
      businessId: solo.business.id, paymentRoute: 'DIRECT', day: 22, managementTokenScheme: 'md5',
    });
    const studentSession = await createSession(club, historical.account.id);
    const originalStart = historical.booking.startAt;
    const proposedStartAt = club.starts.plus({ days: 23 }).toISO()!;
    const readOnly = 'This historical booking is read-only and cannot be changed';

    const accountHistory = await request(app).get('/api/account/bookings')
      .set('Cookie', studentSession.cookie).expect(200);
    expect(accountHistory.body.bookings[0]).toMatchObject({ canCancel: false, canReschedule: false });
    const legacyHistory = await request(app).get(`/api/manage/${historical.token}`).expect(200);
    expect(legacyHistory.body).toMatchObject({ canCancel: false, canReschedule: false });
    await request(app).get(`/api/manage/${historical.token}`).expect(200);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: historical.participantId } }))
      .toMatchObject({ managementTokenHash: historical.managementTokenHash });

    for (const makeAttempt of [
      () => request(app).post(`/api/account/bookings/${historical.participantId}/cancel`)
        .set('Cookie', studentSession.cookie).send({}),
      () => request(app).post(`/api/account/bookings/${historical.participantId}/reschedule-requests`)
        .set('Cookie', studentSession.cookie).send({ startAt: proposedStartAt }),
      () => request(app).post(`/api/account/bookings/${historical.participantId}/checkout`)
        .set('Cookie', studentSession.cookie).send({
          idempotencyKey: `historical-checkout-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED',
        }),
      () => request(app).post(`/api/manage/${historical.token}/cancel`).send({}),
      () => request(app).post(`/api/manage/${historical.token}/reschedule`).send({ startAt: proposedStartAt }),
    ]) {
      const response = await makeAttempt();
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/^This historical booking is read-only/);
    }

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: historical.booking.id } }))
      .toMatchObject({ status: 'CONFIRMED', startAt: originalStart });
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: historical.participantId } }))
      .toMatchObject({ cancelledAt: null });
    expect(await prisma.rescheduleRequest.count({ where: { bookingId: historical.booking.id } })).toBe(0);
    expect(await prisma.paymentIntent.count({ where: { businessId: solo.business.id } })).toBe(0);
  });

  it('keeps retained DIRECT bookings immutable through club lifecycle, reschedule, and ledger routes', async () => {
    const historical = await createHistoricalBooking({ paymentRoute: 'DIRECT', day: 25 });
    const payment = await prisma.payment.create({
      data: {
        businessId: club.business.id, studentId: historical.student.id, bookingId: historical.booking.id,
        amount: 1000, method: 'CASH', kind: 'STUDENT_TO_COACH',
      },
    });
    const originalStart = historical.booking.startAt;
    const readOnly = 'This historical booking is read-only and cannot be changed';

    const attempts = [
      ['booking patch', () => request(app).patch(`/api/bookings/${historical.booking.id}`).set('Cookie', club.cookie).send({ notes: 'rewrite' })],
      ['attendance', () => request(app).patch(`/api/bookings/${historical.booking.id}/participants/${historical.participantId}`)
        .set('Cookie', club.cookie).send({ attendance: 'PRESENT' })],
      ['coach accept', () => request(app).post(`/api/bookings/${historical.booking.id}/accept`).set('Cookie', club.coachCookie).send({})],
      ['coach decline', () => request(app).post(`/api/bookings/${historical.booking.id}/decline`).set('Cookie', club.coachCookie).send({})],
      ['reschedule request', () => request(app).post(`/api/bookings/${historical.booking.id}/reschedule-requests`).set('Cookie', club.cookie)
        .send({ startAt: club.starts.plus({ days: 26 }).toISO() })],
      ['direct reschedule', () => request(app).post(`/api/bookings/${historical.booking.id}/reschedule`).set('Cookie', club.cookie)
        .send({ startAt: club.starts.plus({ days: 27 }).toISO() })],
      ['new payment', () => request(app).post('/api/payments').set('Cookie', club.cookie).send({
        studentId: historical.student.id, bookingId: historical.booking.id, amount: 1000, method: 'CASH',
      })],
      ['payment reversal', () => request(app).delete(`/api/payments/${payment.id}`).set('Cookie', club.cookie).send({ reason: 'rewrite history' })],
    ] as const;
    for (const [label, makeAttempt] of attempts) {
      const response = await makeAttempt();
      expect(response.status, label).toBe(409);
      expect(response.body.error, label).toBe(readOnly);
    }

    expect(await prisma.booking.findUniqueOrThrow({ where: { id: historical.booking.id } }))
      .toMatchObject({ notes: '', startAt: originalStart });
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: historical.participantId } }))
      .toMatchObject({ attendance: 'UNMARKED', paid: false });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
      .toMatchObject({ reversedAt: null });
    expect(await prisma.payment.count({ where: { bookingId: historical.booking.id } })).toBe(1);
    expect(await prisma.rescheduleRequest.count({ where: { bookingId: historical.booking.id } })).toBe(0);
  });

  it('does not let historical reschedule decisions mutate retained records', async () => {
    const historical = await createHistoricalBooking({ paymentRoute: 'DIRECT', day: 28 });
    const studentSession = await createSession(club, historical.account.id);
    const readOnly = 'This historical booking is read-only and cannot be changed';
    const requestRow = await prisma.rescheduleRequest.create({
      data: {
        businessId: club.business.id, bookingId: historical.booking.id, requestedByRole: 'CLUB',
        requestedByUserId: club.user.id, proposedStartAt: club.starts.plus({ days: 29 }).toJSDate(),
        proposedEndAt: club.starts.plus({ days: 29, hours: 1 }).toJSDate(),
        originalStartAt: historical.booking.startAt,
      },
    });

    for (const action of ['accept', 'decline'] as const) {
      const response = await request(app).post(`/api/account/reschedule-requests/${requestRow.id}/${action}`)
        .set('Cookie', studentSession.cookie).send({});
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(readOnly);
      expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestRow.id } }))
        .toMatchObject({ status: 'PENDING', respondedAt: null });
    }
    for (const action of ['accept', 'decline'] as const) {
      const response = await request(app).post(`/api/reschedule-requests/${requestRow.id}/${action}`)
        .set('Cookie', club.cookie).send({});
      expect(response.status).toBe(403);
    }

    await prisma.rescheduleRequest.update({
      where: { id: requestRow.id },
      data: { requestedByRole: 'CLUB', requestedByUserId: club.user.id },
    });
    const withdrawn = await request(app).post(`/api/reschedule-requests/${requestRow.id}/withdraw`)
      .set('Cookie', club.cookie).send({});
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.error).toBe(readOnly);
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestRow.id } }))
      .toMatchObject({ status: 'PENDING', respondedAt: null });

    const studentRequest = await prisma.rescheduleRequest.create({
      data: {
        businessId: club.business.id, bookingId: historical.booking.id, requestedByRole: 'STUDENT',
        requestedByUserId: historical.account.id, participantId: historical.participantId,
        proposedStartAt: club.starts.plus({ days: 30 }).toJSDate(),
        proposedEndAt: club.starts.plus({ days: 30, hours: 1 }).toJSDate(),
        originalStartAt: historical.booking.startAt,
      },
    });
    for (const action of ['accept', 'decline'] as const) {
      const response = await request(app).post(`/api/reschedule-requests/${studentRequest.id}/${action}`)
        .set('Cookie', club.cookie).send({});
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(readOnly);
    }
    const studentWithdraw = await request(app).post(`/api/account/reschedule-requests/${studentRequest.id}/decline`)
      .set('Cookie', studentSession.cookie).send({});
    expect(studentWithdraw.status).toBe(409);
    expect(studentWithdraw.body.error).toBe(readOnly);
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: studentRequest.id } }))
      .toMatchObject({ status: 'PENDING', respondedAt: null });
  });

  it('keeps a CLUB booking immutable after its business becomes legacy read-only', async () => {
    const isolated = await tenants.fixture();
    const account = await createAccount(club, { name: 'Legacy Club Student' });
    const student = await createStudent(isolated, {
      userId: account.id, name: account.name, email: account.email,
    });
    const created = await request(app).post('/api/bookings').set('Cookie', isolated.cookie).send({
      serviceId: isolated.service.id, instructorId: isolated.instructor.id, locationId: isolated.location.id,
      startAt: isolated.starts.plus({ days: 31 }).toISO(), studentId: student.id,
    }).expect(201);
    const participantId = created.body.bookings[0].participants[0].id as string;
    const bookingId = created.body.bookings[0].id as string;
    const studentSession = await createSession(club, account.id);
    await prisma.business.update({ where: { id: isolated.business.id }, data: { legacyReadOnly: true } });

    const history = await request(app).get('/api/account/bookings').set('Cookie', studentSession.cookie).expect(200);
    expect(history.body.bookings.find((booking: { booking: { id: string } }) => booking.booking.id === bookingId))
      .toMatchObject({ canCancel: false, canReschedule: false });
    const cancellation = await request(app).post(`/api/account/bookings/${participantId}/cancel`)
      .set('Cookie', studentSession.cookie).send({}).expect(409);
    expect(cancellation.body.error).toBe('This historical booking is read-only and cannot be changed');
    const checkout = await request(app).post(`/api/account/bookings/${participantId}/checkout`)
      .set('Cookie', studentSession.cookie).send({
        idempotencyKey: `legacy-club-${randomUUID()}`, simulatedOutcome: 'SUCCEEDED',
      }).expect(409);
    expect(checkout.body.error).toMatch(/^This historical booking is read-only/);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participantId } }))
      .toMatchObject({ cancelledAt: null, paid: false });
    expect(await prisma.paymentIntent.count({ where: { businessId: isolated.business.id } })).toBe(0);
  });
});
