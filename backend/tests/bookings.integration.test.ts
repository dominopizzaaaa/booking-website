import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { cancelBooking, createBookings, type BookingInput } from '../src/scheduling.js';
import { createCustomer, createPackage, inputFor, prisma, tenantCounts, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

// Keep every PostgreSQL/HTTP integration suite in this file and sequential;
// concurrency is introduced only by the explicit transaction race tests.
beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('PostgreSQL booking transactions', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  it('admits exactly one concurrent private booking and rolls back losing customers', async () => {
    const attempts = Array.from({ length: 8 }, () => inputFor(f));
    const results = await Promise.allSettled(attempts.map(input => createBookings(f.business.id, input)));
    const successful = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const result of rejected) {
      expect(result.reason).toBeInstanceOf(HttpError);
      expect(result.reason).toMatchObject({ status: 409 });
    }
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 1, participants: 1, customers: 1, notifications: 1 });
    const persisted = await prisma.booking.findFirstOrThrow({ where: { businessId: f.business.id }, include: { participants: true } });
    expect(persisted.capacity).toBe(1);
    expect(persisted.participants).toHaveLength(1);
    const response = successful[0]!.value;
    expect(response.managementToken).toMatch(/^[\w-]{43}$/);
    expect(response.bookings[0]).toMatchObject({
      id: persisted.id, serviceId: f.service.id, serviceName: f.service.name,
      instructorId: f.instructor.id, instructorName: f.instructor.name,
      locationId: f.location.id, locationName: f.location.name,
      startAt: f.starts.toJSDate().toISOString(),
      endAt: f.starts.plus({ hours: 1 }).toJSDate().toISOString(),
      type: 'PRIVATE', status: 'CONFIRMED', capacity: 1, price: 8000,
      participants: [{ price: 8000, packageId: null, paid: false, attendance: 'UNMARKED' }],
    });
  }, 30_000);

  it('admits exactly group capacity under concurrent enrollment without duplicate sessions', async () => {
    const capacity = 3;
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity } });
    const results = await Promise.allSettled(
      Array.from({ length: 9 }, () => createBookings(f.business.id, inputFor(f))),
    );
    const successful = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(successful).toHaveLength(capacity);
    expect(rejected).toHaveLength(9 - capacity);
    for (const result of rejected) expect(result.reason).toMatchObject({ status: 409 });
    expect(new Set(successful.map(result => result.value.bookings[0]!.id)).size).toBe(1);
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 1, participants: capacity, customers: capacity, notifications: capacity });
    const group = await prisma.booking.findFirstOrThrow({ where: { businessId: f.business.id }, include: { participants: true } });
    expect(group).toMatchObject({ type: 'GROUP', capacity });
    expect(group.participants.filter(p => !p.cancelledAt)).toHaveLength(capacity);
    expect(new Set(group.participants.map(p => p.customerId)).size).toBe(capacity);
  }, 30_000);

  it('does not enroll the same customer twice in a group', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 3 } });
    const customer = await createCustomer(f);
    const input = inputFor(f, { customerId: customer.id, customer: undefined });
    await createBookings(f.business.id, input);
    await expect(createBookings(f.business.id, input)).rejects.toMatchObject({
      status: 409, details: { conflicts: [{ reason: 'Customer is already enrolled in this group' }] },
    });
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 1, participants: 1, customers: 1 });
  });

  it('enforces the coach schedule globally across service and location assignments', async () => {
    const secondLocation = await prisma.location.create({
      data: { businessId: f.business.id, name: 'Second court', travelMinutes: 35 },
    });
    const secondService = await prisma.service.create({
      data: {
        businessId: f.business.id, name: 'Private badminton', bufferMinutes: 15, noticeHours: 0,
        locations: { create: {
          locationId: secondLocation.id, price: 9000, duration: 60,
          instructors: { create: { instructorId: f.instructor.id } },
        } },
      },
    });
    await prisma.availability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId: f.business.id, instructorId: f.instructor.id, locationId: secondLocation.id,
      dayOfWeek, startTime: '08:00', endTime: '20:00',
    })) });
    await createBookings(f.business.id, inputFor(f));
    const input = inputFor(f, { serviceId: secondService.id, locationId: secondLocation.id });
    await expect(createBookings(f.business.id, input)).rejects.toMatchObject({ status: 409 });
    await expect(createBookings(f.business.id, {
      ...input, startAt: f.starts.plus({ minutes: 109 }).toISO()!,
    })).rejects.toMatchObject({ status: 409 });
    const result = await createBookings(f.business.id, {
      ...input, startAt: f.starts.plus({ minutes: 110 }).toISO()!,
    });
    expect(result.bookings[0]).toMatchObject({ locationId: secondLocation.id, serviceId: secondService.id, price: 9000 });
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 2, participants: 2, customers: 2 });
  });

  it('rejects a weekly series atomically when one occurrence has a Singapore-date exception', async () => {
    const blocked = f.starts.plus({ weeks: 1 });
    await prisma.availabilityException.create({ data: {
      businessId: f.business.id, instructorId: f.instructor.id, date: blocked.toISODate()!, reason: 'Away',
    } });
    const input = inputFor(f, { repeatWeeks: 3 });
    await expect(createBookings(f.business.id, input)).rejects.toMatchObject({
      status: 409,
      details: { conflicts: [{ date: blocked.toJSDate().toISOString(), reason: 'Coach is unavailable on this date' }] },
    });
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 0, participants: 0, customers: 0, notifications: 0 });
    expect(await prisma.customer.findUnique({
      where: { businessId_email: { businessId: f.business.id, email: input.customer!.email } },
    })).toBeNull();
  });

  it('leaves existing package credits unchanged when a later recurring occurrence is blocked', async () => {
    const customer = await createCustomer(f);
    const pkg = await createPackage(f, customer.id, { usedCredits: 1 });
    await prisma.availabilityException.create({ data: {
      businessId: f.business.id, instructorId: f.instructor.id,
      date: f.starts.plus({ weeks: 2 }).toISODate()!, reason: 'Away',
    } });
    const before = await tenantCounts(f.business.id);
    await expect(createBookings(f.business.id, inputFor(f, {
      customerId: customer.id, customer: undefined, repeatWeeks: 3, packageId: pkg.id,
    }))).rejects.toMatchObject({ status: 409 });
    expect(await tenantCounts(f.business.id)).toEqual(before);
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 1 });
  });

  it('books all weekly occurrences with one shared recurrence ID and one credit per occurrence', async () => {
    const customer = await createCustomer(f);
    const pkg = await createPackage(f, customer.id);
    const result = await createBookings(f.business.id, inputFor(f, {
      customerId: customer.id, customer: undefined, repeatWeeks: 3, packageId: pkg.id,
    }));
    expect(result.bookings).toHaveLength(3);
    expect(new Set(result.bookings.map(b => b.recurringId)).size).toBe(1);
    expect(result.bookings[0]!.recurringId).toEqual(expect.any(String));
    expect(result.bookings.map(b => b.startAt)).toEqual(
      [0, 1, 2].map(weeks => f.starts.plus({ weeks }).toJSDate().toISOString()),
    );
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 3 });
    const participants = await prisma.participant.findMany({ where: { packageId: pkg.id } });
    expect(participants).toHaveLength(3);
    expect(participants.every(p => p.creditConsumed && p.paid)).toBe(true);
  });

  it('rolls back a whole recurrence when the package cannot cover every occurrence', async () => {
    const customer = await createCustomer(f);
    const pkg = await createPackage(f, customer.id, { totalCredits: 3, usedCredits: 1 });
    const before = await tenantCounts(f.business.id);
    await expect(createBookings(f.business.id, inputFor(f, {
      customerId: customer.id, customer: undefined, repeatWeeks: 3, packageId: pkg.id,
    }))).rejects.toMatchObject({ status: 409, message: 'Not enough package credits for all sessions' });
    expect(await tenantCounts(f.business.id)).toEqual(before);
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 1 });
  });

  it('debits a package and refunds exactly once even for concurrent or repeated cancellation', async () => {
    const customer = await createCustomer(f);
    const pkg = await createPackage(f, customer.id);
    const { bookings } = await createBookings(f.business.id, inputFor(f, {
      customerId: customer.id, customer: undefined, packageId: pkg.id,
    }));
    const bookingId = bookings[0]!.id;
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 1 });
    expect(await prisma.participant.findFirstOrThrow({ where: { bookingId } })).toMatchObject({
      packageId: pkg.id, creditConsumed: true, paid: true,
    });
    // Exercise cleanup with all restrictive dependencies, including a payment
    // linked to both the customer and package rather than deleting the database.
    await prisma.payment.create({ data: {
      businessId: f.business.id, customerId: customer.id, packageId: pkg.id, amount: 40000,
    } });
    await Promise.all([
      prisma.$transaction(tx => cancelBooking(tx, f.business.id, bookingId)),
      prisma.$transaction(tx => cancelBooking(tx, f.business.id, bookingId)),
    ]);
    await prisma.$transaction(tx => cancelBooking(tx, f.business.id, bookingId));
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({ status: 'CANCELLED' });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 0 });
    expect(await prisma.participant.findFirstOrThrow({ where: { bookingId } })).toMatchObject({ creditConsumed: false });
    expect(await prisma.notification.count({ where: { businessId: f.business.id, title: 'Session cancelled' } })).toBe(1);
  });

  it('cannot overspend the last package credit in concurrent non-overlapping bookings', async () => {
    const customer = await createCustomer(f);
    const pkg = await createPackage(f, customer.id, { totalCredits: 1 });
    const results = await Promise.allSettled([0, 1].map(days => createBookings(f.business.id, inputFor(f, {
      customerId: customer.id, customer: undefined, packageId: pkg.id,
      startAt: f.starts.plus({ days }).toISO()!,
    }))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected')!;
    expect(failed.reason).toMatchObject({ status: 409, message: 'Not enough package credits for all sessions' });
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 1, participants: 1, customers: 1 });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 1 });
  });

  it.each(['already expired', 'expires before first session', 'expires before later recurrence'] as const)(
    'rejects a package that %s without debit or partial bookings', async kind => {
      const customer = await createCustomer(f);
      const expiresAt = kind === 'already expired' ? new Date(Date.now() - 86_400_000)
        : kind === 'expires before first session' ? f.starts.minus({ minutes: 1 }).toJSDate()
          : f.starts.plus({ days: 3 }).toJSDate();
      const pkg = await createPackage(f, customer.id, { expiresAt });
      const before = await tenantCounts(f.business.id);
      await expect(createBookings(f.business.id, inputFor(f, {
        customerId: customer.id, customer: undefined, packageId: pkg.id, repeatWeeks: 2,
      }))).rejects.toMatchObject({ status: 400, message: 'Package expires before one or more sessions' });
      expect(await tenantCounts(f.business.id)).toEqual(before);
      expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 0 });
    },
  );

  it('rejects another customer’s package within the same tenant', async () => {
    const owner = await createCustomer(f);
    const customer = await createCustomer(f);
    const pkg = await createPackage(f, owner.id);
    await expect(createBookings(f.business.id, inputFor(f, {
      customerId: customer.id, customer: undefined, packageId: pkg.id,
    }))).rejects.toMatchObject({ status: 400, message: 'Package does not belong to this customer or service' });
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 0, participants: 0, customers: 2, notifications: 0 });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 0 });
  });

  it('rejects a service-restricted package for a different service', async () => {
    const customer = await createCustomer(f);
    const differentService = await prisma.service.create({ data: { businessId: f.business.id, name: 'Different lessons' } });
    const pkg = await createPackage(f, customer.id, { serviceId: differentService.id });
    await expect(createBookings(f.business.id, inputFor(f, {
      customerId: customer.id, customer: undefined, packageId: pkg.id,
    }))).rejects.toMatchObject({ status: 400, message: 'Package does not belong to this customer or service' });
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 0, participants: 0, customers: 1, notifications: 0 });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 0 });
  });

  it('accepts a customer package with no service restriction', async () => {
    const customer = await createCustomer(f);
    const pkg = await createPackage(f, customer.id, { serviceId: null, paid: false });
    const result = await createBookings(f.business.id, inputFor(f, {
      customerId: customer.id, customer: undefined, packageId: pkg.id,
    }));
    expect(result.bookings[0]!.participants[0]).toMatchObject({ packageId: pkg.id, paid: false });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).toMatchObject({ usedCredits: 1 });
  });

  it.each([
    ['serviceId', 404], ['instructorId', 404], ['locationId', 404], ['customerId', 404], ['packageId', 400],
  ] as const)('rejects another tenant’s %s without modifying either tenant', async (field, status) => {
    const other = await tenants.fixture();
    const otherCustomer = await createCustomer(other);
    const otherPackage = await createPackage(other, otherCustomer.id);
    const foreignIds = {
      serviceId: other.service.id, instructorId: other.instructor.id, locationId: other.location.id,
      customerId: otherCustomer.id, packageId: otherPackage.id,
    };
    const overrides: Partial<BookingInput> = { [field]: foreignIds[field] };
    if (field === 'customerId') overrides.customer = undefined;
    const before = await tenantCounts(f.business.id);
    const otherBefore = await tenantCounts(other.business.id);
    await expect(createBookings(f.business.id, inputFor(f, overrides))).rejects.toMatchObject({ status });
    expect(await tenantCounts(f.business.id)).toEqual(before);
    expect(await tenantCounts(other.business.id)).toEqual(otherBefore);
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: otherPackage.id } })).toMatchObject({ usedCredits: 0 });
  });

  it('rejects a complete foreign scheduling tuple even when those foreign assignments are valid', async () => {
    const other = await tenants.fixture();
    await expect(createBookings(f.business.id, inputFor(other))).rejects.toMatchObject({ status: 404 });
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 0, participants: 0, customers: 0 });
    expect(await tenantCounts(other.business.id)).toMatchObject({ bookings: 0, participants: 0, customers: 0 });
  });

  it('cleans up only its registered tenant and preserves an unrelated tenant with restrictive children', async () => {
    const other = await tenants.fixture();
    const customer = await createCustomer(other);
    const pkg = await createPackage(other, customer.id);
    await createBookings(other.business.id, inputFor(other, { customerId: customer.id, customer: undefined, packageId: pkg.id }));
    const preserved = await tenantCounts(other.business.id);
    const isolated = new TestTenants();
    try {
      const disposable = await isolated.fixture();
      const disposableCustomer = await createCustomer(disposable);
      const disposablePackage = await createPackage(disposable, disposableCustomer.id);
      await createBookings(disposable.business.id, inputFor(disposable, {
        customerId: disposableCustomer.id, customer: undefined, packageId: disposablePackage.id,
      }));
      await prisma.payment.create({ data: {
        businessId: disposable.business.id, customerId: disposableCustomer.id,
        packageId: disposablePackage.id, amount: 40000,
      } });
      await isolated.cleanup();
      expect(await prisma.business.findUnique({ where: { id: disposable.business.id } })).toBeNull();
      expect(await tenantCounts(disposable.business.id)).toEqual({ bookings: 0, participants: 0, customers: 0, notifications: 0, packages: 0, payments: 0 });
      expect(await tenantCounts(other.business.id)).toEqual(preserved);
    } finally {
      await isolated.cleanup();
    }
  });
});

describe.sequential('Guest management and exact participant payments', () => {
  let tenants: TestTenants;
  let f: Fixture;
  beforeEach(async () => { tenants = new TestTenants(); f = await tenants.fixture(); });
  afterEach(async () => { await tenants.cleanup(); });

  it('keeps group guest identities private and cancels only the token holder', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 3 } });
    const first = await request(app).post(`/api/public/${f.business.slug}/bookings`).send(inputFor(f)).expect(201);
    const second = await request(app).post(`/api/public/${f.business.slug}/bookings`).send(inputFor(f)).expect(201);
    expect(second.body.bookings[0].participants).toHaveLength(1);
    expect(second.body.bookings[0].participants[0].managementToken).not.toBe(first.body.managementToken);
    const managed = await request(app).get(`/api/manage/${first.body.managementToken}`).expect(200);
    expect(managed.body.booking.participants).toHaveLength(1);
    expect(managed.body.canCancel).toBe(true);
    expect(managed.body.canReschedule).toBe(false);
    const cancelled = await request(app).post(`/api/manage/${first.body.managementToken}/cancel`).send({}).expect(200);
    expect(cancelled.body.booking.status).toBe('CANCELLED');
    await request(app).post(`/api/manage/${first.body.managementToken}/cancel`).send({}).expect(200);
    const remaining = await request(app).get(`/api/manage/${second.body.managementToken}`).expect(200);
    expect(remaining.body.booking.status).toBe('CONFIRMED');
    expect(await prisma.participant.count({ where: { bookingId: first.body.bookings[0].id, cancelledAt: null } })).toBe(1);
  });

  it('reschedules a private guest booking and enforces cancellation notice', async () => {
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`).send(inputFor(f)).expect(201);
    const path = `/api/manage/${created.body.managementToken}`;
    const startAt = f.starts.plus({ days: 1 }).toISO();
    const moved = await request(app).post(`${path}/reschedule`).send({ startAt }).expect(200);
    expect(moved.body.booking.startAt).toBe(f.starts.plus({ days: 1 }).toJSDate().toISOString());
    await prisma.business.update({ where: { id: f.business.id }, data: { cancellationHours: 720 } });
    const view = await request(app).get(path).expect(200);
    expect(view.body.canCancel).toBe(false);
    await request(app).post(`${path}/cancel`).send({}).expect(400);
  });

  it('records payment for exactly one group participant and never charges cancelled sessions', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 3 } });
    const first = await createBookings(f.business.id, inputFor(f));
    const second = await createBookings(f.business.id, inputFor(f));
    const participant = first.bookings[0].participants[0];
    const other = second.bookings[0].participants.find(p => p.id !== participant.id)!;
    const user = await prisma.user.create({ data: { businessId: f.business.id, name: 'Owner', email: `${randomUUID()}@example.test`, passwordHash: 'not-a-login-hash', role: 'OWNER', instructorId: f.instructor.id } });
    const token = randomUUID();
    await prisma.authSession.create({ data: { id: createHash('sha256').update(token).digest('hex'), userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } });
    const cookie = `${config.sessionCookie}=${token}`;
    const payment = { customerId: participant.customerId, bookingId: first.bookings[0].id, amount: participant.price, method: 'CASH' };
    await request(app).post('/api/payments').set('Cookie', cookie).send(payment).expect(201);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participant.id } })).toMatchObject({ paid: true });
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ paid: false });
    await request(app).post('/api/payments').set('Cookie', cookie).send(payment).expect(409);
    await request(app).patch(`/api/bookings/${first.bookings[0].id}`).set('Cookie', cookie).send({ status: 'CANCELLED' }).expect(200);
    await request(app).post('/api/payments').set('Cookie', cookie).send({ ...payment, customerId: other.customerId }).expect(400);
    expect(await prisma.payment.count({ where: { businessId: f.business.id } })).toBe(1);
  });
});

describe.sequential('HTTP authentication and tenant contract', () => {
  let tenants: TestTenants;
  const password = 'Courtly-test-password-123';

  beforeEach(() => { tenants = new TestTenants(); });
  afterEach(async () => { await tenants.cleanup(); });

  async function authenticatedFixture(role: 'OWNER' | 'COACH' = 'OWNER') {
    const fixture = await tenants.fixture();
    const user = await prisma.user.create({ data: {
      businessId: fixture.business.id, name: 'Test User', email: `${randomUUID()}@example.test`,
      passwordHash: await bcrypt.hash(password, 4), role, instructorId: fixture.instructor.id,
    } });
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/login').send({ email: user.email, password });
    expect(response.status).toBe(200);
    return { ...fixture, user, agent, login: response };
  }

  it('registers an isolated owner, establishes a safe session and returns the frontend workspace contract', async () => {
    const email = `${randomUUID()}@example.test`;
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/register').send({
      businessName: 'Test New Academy', name: 'New Owner', email: email.toUpperCase(), password,
    });
    // Capture the tenant before assertions, including a registration that created
    // a user but failed later while issuing the session.
    const owner = await prisma.user.findUnique({ where: { email } });
    if (owner) tenants.own(owner.businessId);
    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ name: 'New Owner', email, role: 'OWNER' });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.business).toMatchObject({ name: 'Test New Academy', timezone: 'Asia/Singapore', currency: 'SGD', isDemo: false });
    expect(owner).not.toBeNull();
    expect(owner!.passwordHash).not.toBe(password);
    expect(await bcrypt.compare(password, owner!.passwordHash)).toBe(true);
    const cookie = response.get('set-cookie')![0]!;
    expect(cookie).toContain(`${config.sessionCookie}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body).toEqual(response.body);
    const workspace = await agent.get('/api/workspace').expect(200);
    expect(workspace.body.business.id).toBe(owner!.businessId);
    expect(workspace.body.user.id).toBe(owner!.id);
    expect(workspace.body.instructors).toHaveLength(1);
    for (const key of ['locations', 'services', 'availability', 'exceptions', 'customers', 'packages', 'bookings', 'payments', 'notifications']) {
      expect(workspace.body[key], key).toEqual([]);
    }
    await request(app).get('/api/workspace').expect(401);
    await request(app).get('/api/auth/me').expect(401);
  });

  it('authenticates credentials, stores a digest, rejects expired sessions and revokes on logout', async () => {
    const f = await authenticatedFixture();
    const cookie = f.login.get('set-cookie')![0]!.split(';')[0]!;
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const digest = createHash('sha256').update(token).digest('hex');
    const stored = await prisma.authSession.findUniqueOrThrow({ where: { id: digest } });
    expect(stored.userId).toBe(f.user.id);
    expect(stored.id).not.toBe(token);
    await request(app).post('/api/auth/login').send({ email: f.user.email, password: 'wrong-password' }).expect(401);
    await request(app).get('/api/auth/me').set('Cookie', `${config.sessionCookie}=unrecognized-token`).expect(401);
    await prisma.authSession.update({ where: { id: digest }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);

    const secondLogin = await f.agent.post('/api/auth/login').send({ email: f.user.email, password }).expect(200);
    const secondCookie = secondLogin.get('set-cookie')![0]!.split(';')[0]!;
    expect(secondCookie).not.toBe(cookie);
    expect(await prisma.authSession.findUnique({ where: { id: digest } })).toBeNull();
    await f.agent.get('/api/auth/me').expect(200);
    await f.agent.post('/api/auth/logout').send({}).expect(200);
    await f.agent.get('/api/workspace').expect(401);
    await request(app).get('/api/auth/me').set('Cookie', secondCookie).expect(401);
    expect(await prisma.authSession.count({ where: { userId: f.user.id } })).toBe(0);
  });

  it('lets only owners create and remove tenant-scoped staff access without exposing password hashes', async () => {
    const owner = await authenticatedFixture();
    const otherTenant = await authenticatedFixture();
    const staffInstructor = await prisma.instructor.create({
      data: { businessId: owner.business.id, name: 'Assistant Coach', initials: 'AC' },
    });
    const staffEmail = `${randomUUID()}@example.test`;
    const created = await owner.agent.post('/api/staff').send({
      name: 'Assistant Coach', email: staffEmail, password, role: 'COACH',
      instructorId: staffInstructor.id,
    }).expect(201);
    expect(created.body).toMatchObject({
      name: 'Assistant Coach', email: staffEmail, role: 'COACH', instructorId: staffInstructor.id,
    });
    expect(created.body).not.toHaveProperty('passwordHash');
    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(persisted.businessId).toBe(owner.business.id);
    expect(await bcrypt.compare(password, persisted.passwordHash)).toBe(true);

    const listing = await owner.agent.get('/api/staff').expect(200);
    expect(listing.body.map((user: { id: string }) => user.id)).toEqual(expect.arrayContaining([owner.user.id, created.body.id]));
    expect(JSON.stringify(listing.body)).not.toContain('passwordHash');
    expect(JSON.stringify(listing.body)).not.toContain(otherTenant.user.id);

    await otherTenant.agent.patch(`/api/staff/${created.body.id}`).send({ name: 'Cross-tenant edit' }).expect(404);
    await otherTenant.agent.delete(`/api/staff/${created.body.id}`).expect(404);

    const coach = request.agent(app);
    await coach.post('/api/auth/login').send({ email: staffEmail, password }).expect(200);
    await coach.get('/api/staff').expect(403);
    await coach.post('/api/staff').send({
      name: 'Unauthorized admin', email: `${randomUUID()}@example.test`, password, role: 'ADMIN',
    }).expect(403);

    await owner.agent.patch(`/api/staff/${created.body.id}`).send({ role: 'ADMIN', instructorId: null }).expect(200);
    await owner.agent.delete(`/api/staff/${created.body.id}`).expect(200);
    await coach.get('/api/workspace').expect(401);
    expect(await prisma.user.findUnique({ where: { id: created.body.id } })).toBeNull();
    expect(await prisma.instructor.findUnique({ where: { id: staffInstructor.id } })).not.toBeNull();
  });

  it('scopes workspace and booking reads to the session tenant and rejects foreign booking mutations', async () => {
    const first = await authenticatedFixture();
    const second = await authenticatedFixture();
    const customer = { name: 'Same Email', email: 'shared-customer@example.test' };
    const own = await first.agent.post('/api/bookings').send(inputFor(first, { customer })).expect(201);
    const foreign = await second.agent.post('/api/bookings').send(inputFor(second, { customer })).expect(201);
    const ownBooking = own.body.bookings[0];
    const foreignBooking = foreign.body.bookings[0];
    expect(ownBooking.participants[0].customerId).not.toBe(foreignBooking.participants[0].customerId);
    expect(own.body.managementToken).toEqual(expect.any(String));
    expect(ownBooking).toMatchObject({
      serviceName: first.service.name, instructorName: first.instructor.name,
      locationName: first.location.name, status: 'CONFIRMED', price: 8000,
      startAt: first.starts.toJSDate().toISOString(),
    });
    const bookings = await first.agent.get('/api/bookings').expect(200);
    expect(bookings.body.map((b: { id: string }) => b.id)).toEqual([ownBooking.id]);
    const workspace = await first.agent.get('/api/workspace').expect(200);
    expect(workspace.body.business.id).toBe(first.business.id);
    expect(workspace.body.customers.map((c: { id: string }) => c.id)).toEqual([ownBooking.participants[0].customerId]);
    expect(workspace.body.services[0]).toMatchObject({ locations: [{
      locationId: first.location.id, price: 8000, duration: 60, instructorIds: [first.instructor.id],
    }] });
    expect(JSON.stringify(workspace.body)).not.toContain(second.business.id);
    expect(JSON.stringify(workspace.body)).not.toContain(foreignBooking.id);
    await first.agent.patch(`/api/bookings/${foreignBooking.id}`).send({ status: 'CANCELLED' }).expect(404);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: foreignBooking.id } })).toMatchObject({ status: 'CONFIRMED' });
  });

  it('limits COACH reads to their schedule/customers and denies other-coach or administrative writes', async () => {
    const f = await authenticatedFixture('COACH');
    const other = await prisma.instructor.create({ data: { businessId: f.business.id, name: 'Other Coach', initials: 'OC' } });
    const assignment = await prisma.serviceLocation.findUniqueOrThrow({
      where: { serviceId_locationId: { serviceId: f.service.id, locationId: f.location.id } },
    });
    await prisma.serviceInstructor.create({ data: { serviceLocationId: assignment.id, instructorId: other.id } });
    await prisma.availability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId: f.business.id, instructorId: other.id, locationId: f.location.id,
      dayOfWeek, startTime: '08:00', endTime: '20:00',
    })) });
    const ownCustomer = await createCustomer(f);
    const pkg = await createPackage(f, ownCustomer.id);
    const own = await createBookings(f.business.id, inputFor(f, { customerId: ownCustomer.id, customer: undefined, packageId: pkg.id }));
    const others = await createBookings(f.business.id, inputFor(f, { instructorId: other.id }));
    await prisma.payment.create({ data: { businessId: f.business.id, customerId: ownCustomer.id, packageId: pkg.id, amount: 40000 } });

    const response = await f.agent.get('/api/workspace').expect(200);
    expect(response.body.user.role).toBe('COACH');
    expect(response.body.instructors.map((i: { id: string }) => i.id)).toEqual([f.instructor.id]);
    expect(response.body.bookings.map((b: { id: string }) => b.id)).toEqual([own.bookings[0]!.id]);
    expect(response.body.customers.map((c: { id: string }) => c.id)).toEqual([ownCustomer.id]);
    expect(response.body.availability).toHaveLength(7);
    expect(response.body.availability.every((a: { instructorId: string }) => a.instructorId === f.instructor.id)).toBe(true);
    expect(response.body.services[0].locations[0].instructorIds).toEqual([f.instructor.id]);
    expect(response.body.packages).toEqual([]);
    expect(response.body.payments).toEqual([]);
    expect(response.body.notifications).toHaveLength(1);
    const bookings = await f.agent.get('/api/bookings').expect(200);
    expect(bookings.body.map((b: { id: string }) => b.id)).toEqual([own.bookings[0]!.id]);
    await f.agent.patch(`/api/bookings/${others.bookings[0]!.id}`).send({ notes: 'Unauthorized edit' }).expect(403);
    await f.agent.post('/api/bookings').send(inputFor(f, {
      instructorId: other.id, startAt: f.starts.plus({ days: 1 }).toISO()!,
    })).expect(403);
    await f.agent.post('/api/payments').send({ customerId: ownCustomer.id, amount: 100, method: 'CASH' }).expect(403);
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: others.bookings[0]!.id } })).toMatchObject({ notes: '' });
  });
});
