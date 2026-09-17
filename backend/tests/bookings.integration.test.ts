import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { HttpError } from '../src/http.js';
import { cancelBooking, createBookings, type BookingInput } from '../src/scheduling.js';
import { createAccount, createCustomer, createPackage, createSession, inputFor, linkedInputFor, prisma, tenantCounts, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

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
    const accounts = await Promise.all(Array.from({ length: 8 }, (_, index) => createAccount(f, {
      name: `Concurrent Customer ${index}`, email: `concurrent-${index}-${randomUUID()}@example.test`,
    })));
    const attempts = accounts.map(account => inputFor(f, { customer: { name: account.name, email: account.email } }));
    const results = await Promise.allSettled(attempts.map((input, index) =>
      createBookings(f.business.id, input, { customerUserId: accounts[index]!.id }),
    ));
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
    expect(response).not.toHaveProperty('managementToken');
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
    const accounts = await Promise.all(Array.from({ length: 9 }, (_, index) => createAccount(f, {
      name: `Group Customer ${index}`, email: `group-${index}-${randomUUID()}@example.test`,
    })));
    const results = await Promise.allSettled(
      accounts.map(account => createBookings(
        f.business.id,
        inputFor(f, { customer: { name: account.name, email: account.email } }),
        { customerUserId: account.id },
      )),
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
    await createBookings(f.business.id, await linkedInputFor(f));
    const input = await linkedInputFor(f, { serviceId: secondService.id, locationId: secondLocation.id });
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
    const account = await createAccount(f);
    const input = inputFor(f, {
      repeatWeeks: 3, customer: { name: account.name, email: account.email },
    });
    await expect(createBookings(f.business.id, input, { customerUserId: account.id })).rejects.toMatchObject({
      status: 409,
      details: { conflicts: [{ date: blocked.toJSDate().toISOString(), reason: 'Coach is unavailable on this date' }] },
    });
    expect(await tenantCounts(f.business.id)).toMatchObject({ bookings: 0, participants: 0, customers: 0, notifications: 0 });
    expect(await prisma.customer.findFirst({ where: { businessId: f.business.id, userId: account.id } })).toBeNull();
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
    const localCustomer = await createCustomer(f);
    const otherCustomer = await createCustomer(other);
    const otherPackage = await createPackage(other, otherCustomer.id);
    const foreignIds = {
      serviceId: other.service.id, instructorId: other.instructor.id, locationId: other.location.id,
      customerId: otherCustomer.id, packageId: otherPackage.id,
    };
    const overrides: Partial<BookingInput> = {
      customerId: localCustomer.id, customer: undefined, [field]: foreignIds[field],
    };
    const before = await tenantCounts(f.business.id);
    const otherBefore = await tenantCounts(other.business.id);
    await expect(createBookings(f.business.id, inputFor(f, overrides))).rejects.toMatchObject({ status });
    expect(await tenantCounts(f.business.id)).toEqual(before);
    expect(await tenantCounts(other.business.id)).toEqual(otherBefore);
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: otherPackage.id } })).toMatchObject({ usedCredits: 0 });
  });

  it('rejects a complete foreign scheduling tuple even when those foreign assignments are valid', async () => {
    const other = await tenants.fixture();
    const account = await createAccount(other);
    await expect(createBookings(f.business.id, inputFor(other, {
      customer: { name: account.name, email: account.email },
    }), { customerUserId: account.id })).rejects.toMatchObject({ status: 404 });
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

describe.sequential('Account bookings and exact participant payments', () => {
  let tenants: TestTenants;
  let f: Fixture;
  beforeEach(async () => { tenants = new TestTenants(); f = await tenants.fixture(); });
  afterEach(async () => { await tenants.cleanup(); });

  it('records payment for exactly one group participant and never charges cancelled sessions', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 3 } });
    const first = await createBookings(f.business.id, await linkedInputFor(f));
    const second = await createBookings(f.business.id, await linkedInputFor(f));
    const participant = first.bookings[0].participants[0];
    const other = second.bookings[0].participants.find(p => p.id !== participant.id)!;
    const payment = { customerId: participant.customerId, bookingId: first.bookings[0].id, amount: participant.price, method: 'CASH' };
    await request(app).post('/api/payments').set('Cookie', f.cookie).send(payment).expect(201);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participant.id } })).toMatchObject({ paid: true });
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ paid: false });
    await request(app).post('/api/payments').set('Cookie', f.cookie).send(payment).expect(409);
    await request(app).patch(`/api/bookings/${first.bookings[0].id}`).set('Cookie', f.cookie).send({ status: 'CANCELLED' }).expect(200);
    await request(app).post('/api/payments').set('Cookie', f.cookie).send({ ...payment, customerId: other.customerId }).expect(400);
    expect(await prisma.payment.count({ where: { businessId: f.business.id } })).toBe(1);
  });
});

describe.sequential('Global account authentication and workspace memberships', () => {
  let tenants: TestTenants;
  const password = 'Courtly-test-password-123';

  beforeEach(() => { tenants = new TestTenants(); });
  afterEach(async () => { await tenants.cleanup(); });

  async function loginFixture(role: 'OWNER' | 'COACH' = 'OWNER') {
    const fixture = await tenants.fixture();
    await prisma.user.update({ where: { id: fixture.user.id }, data: { passwordHash: await bcrypt.hash(password, 4) } });
    if (role === 'COACH') {
      await prisma.membership.update({ where: { id: fixture.membership.id }, data: { role } });
      await prisma.user.update({ where: { id: fixture.user.id }, data: { accountType: 'COACH' } });
    }
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/login').send({ email: fixture.user.email, password }).expect(200);
    return { ...fixture, user: await prisma.user.findUniqueOrThrow({ where: { id: fixture.user.id } }), agent, login: response };
  }

  async function trackRegistration(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return null;
    tenants.ownUser(user.id);
    const memberships = await prisma.membership.findMany({ where: { userId: user.id } });
    for (const membership of memberships) tenants.own(membership.businessId);
    return { user, memberships };
  }

  it('requires clients to choose an account type explicitly', async () => {
    const email = randomUUID() + '@example.test';
    const response = await request(app).post('/api/auth/register').send({
      name: 'Unspecified Account', email, password,
    });
    expect(response.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('registers an owner with a selected membership and returns the workspace contract', async () => {
    const email = `${randomUUID()}@example.test`;
    const agent = request.agent(app);
    const response = await agent.post('/api/auth/register').send({
      accountType: 'OWNER', businessName: 'Test New Academy', name: 'New Owner',
      email: email.toUpperCase(), password,
    });
    const registered = await trackRegistration(email);
    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ name: 'New Owner', email, accountType: 'OWNER' });
    expect(response.body.user).not.toHaveProperty('passwordHash');
    expect(response.body.membership).toMatchObject({ role: 'OWNER', active: true });
    expect(response.body.memberships).toHaveLength(1);
    expect(response.body.business).toMatchObject({ name: 'Test New Academy', isDemo: false });
    expect(registered).not.toBeNull();
    expect(registered!.memberships[0]!.businessId).toBe(response.body.business.id);
    expect(await bcrypt.compare(password, registered!.user.passwordHash!)).toBe(true);
    const cookie = response.get('set-cookie')![0]!;
    expect(cookie).toContain(`${config.sessionCookie}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    expect((await agent.get('/api/auth/me').expect(200)).body).toEqual(response.body);
    const workspace = await agent.get('/api/workspace').expect(200);
    expect(workspace.body).toMatchObject({
      business: { id: response.body.business.id },
      user: { id: registered!.user.id, accountType: 'OWNER', role: 'OWNER' },
      membership: { id: response.body.membership.id, businessId: response.body.business.id },
    });
    expect(workspace.body.instructors).toHaveLength(1);
    await request(app).get('/api/workspace').expect(401);
  });

  it.each(['COACH', 'CUSTOMER'] as const)(
    'registers a standalone %s account but denies workspace access without a membership', async accountType => {
      const email = `${accountType.toLowerCase()}-${randomUUID()}@example.test`;
      const agent = request.agent(app);
      const response = await agent.post('/api/auth/register').send({
        accountType, name: `${accountType} Account`, email, password,
      }).expect(201);
      await trackRegistration(email);
      expect(response.body).toMatchObject({
        user: { email, accountType }, membership: null, business: null, memberships: [],
      });
      await agent.get('/api/auth/me').expect(200);
      await agent.get('/api/workspace').expect(403);
      await agent.get('/api/bookings').expect(403);
    },
  );

  it('updates only the authenticated global profile and synchronizes every linked customer row', async () => {
    const first = await tenants.fixture();
    const second = await tenants.fixture();
    const account = await createAccount(first, {
      name: 'Original Customer', phone: '+65 6000 0000', parentName: 'Original Parent',
    });
    const firstProfile = await createCustomer(first, {
      userId: account.id, name: account.name, email: account.email, phone: account.phone, parentName: account.parentName,
    });
    const secondProfile = await createCustomer(second, {
      userId: account.id, name: account.name, email: account.email, phone: account.phone, parentName: account.parentName,
    });
    const stranger = await createAccount(first, { name: 'Unrelated Customer' });
    const unrelated = await createCustomer(first, {
      userId: stranger.id, name: stranger.name, email: stranger.email, phone: '+65 6111 1111', parentName: 'Other Parent',
    });
    const { cookie } = await createSession(first, account.id);

    const updated = await request(app).patch('/api/account/profile').set('Cookie', cookie).send({
      name: 'Ada Lovelace Byron', phone: '+65 6999 9999', parentName: 'Annabella Byron',
    }).expect(200);
    expect(updated.body).toMatchObject({
      user: {
        id: account.id, name: 'Ada Lovelace Byron', email: account.email, accountType: 'CUSTOMER',
        phone: '+65 6999 9999', parentName: 'Annabella Byron',
      },
      membership: null, business: null, memberships: [],
    });
    const linked = await prisma.customer.findMany({
      where: { id: { in: [firstProfile.id, secondProfile.id] } }, orderBy: { id: 'asc' },
    });
    expect(linked).toHaveLength(2);
    for (const profile of linked) {
      expect(profile).toMatchObject({
        name: 'Ada Lovelace Byron', initials: 'AL', phone: '+65 6999 9999',
        parentName: 'Annabella Byron', email: account.email,
      });
    }
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: unrelated.id } })).toMatchObject({
      name: 'Unrelated Customer', phone: '+65 6111 1111', parentName: 'Other Parent',
    });
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200)).body.user)
      .toMatchObject({ phone: '+65 6999 9999', parentName: 'Annabella Byron' });

    await request(app).patch('/api/account/profile').set('Cookie', cookie)
      .send({ email: 'attacker@example.test' }).expect(400);
    await request(app).patch('/api/account/profile').set('Cookie', cookie).send({}).expect(400);
    await request(app).patch('/api/account/profile').send({ name: 'No Session' }).expect(401);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ email: account.email });
  });

  it('synchronizes a provider name across every membership-linked instructor only', async () => {
    const first = await loginFixture();
    const second = await tenants.fixture();
    const secondInstructor = await prisma.instructor.create({
      data: { businessId: second.business.id, name: 'Old Provider Name', initials: 'OP' },
    });
    await prisma.membership.create({
      data: {
        userId: first.user.id, businessId: second.business.id, role: 'COACH',
        instructorId: secondInstructor.id,
      },
    });
    const unrelated = await prisma.instructor.create({
      data: { businessId: first.business.id, name: 'Unaffiliated Coach', initials: 'UC' },
    });
    const linkedCustomer = await createCustomer(first, {
      userId: first.user.id, name: first.user.name, email: first.user.email,
    });

    const response = await first.agent.patch('/api/auth/me')
      .send({ name: 'Renamed Global Provider' }).expect(200);
    expect(response.body.user).toMatchObject({ id: first.user.id, name: 'Renamed Global Provider' });
    const linkedInstructors = await prisma.instructor.findMany({
      where: { id: { in: [first.instructor.id, secondInstructor.id] } },
    });
    expect(linkedInstructors).toHaveLength(2);
    for (const instructor of linkedInstructors) {
      expect(instructor).toMatchObject({ name: 'Renamed Global Provider', initials: 'RG' });
    }
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: unrelated.id } }))
      .toMatchObject({ name: 'Unaffiliated Coach', initials: 'UC' });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: linkedCustomer.id } }))
      .toMatchObject({ name: 'Renamed Global Provider', initials: 'RG' });
  });

  it('stores a session digest and selected membership, rejects expiry, and revokes on logout', async () => {
    const f = await loginFixture();
    const cookie = f.login.get('set-cookie')![0]!.split(';')[0]!;
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const digest = createHash('sha256').update(token).digest('hex');
    const stored = await prisma.authSession.findUniqueOrThrow({ where: { id: digest } });
    expect(stored).toMatchObject({ userId: f.user.id, activeMembershipId: f.membership.id });
    expect(stored.id).not.toBe(token);
    await request(app).post('/api/auth/login').send({ email: f.user.email, password: 'wrong-password' }).expect(401);
    await prisma.authSession.update({ where: { id: digest }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);

    const secondLogin = await f.agent.post('/api/auth/login').send({ email: f.user.email, password }).expect(200);
    const secondCookie = secondLogin.get('set-cookie')![0]!.split(';')[0]!;
    expect(secondCookie).not.toBe(cookie);
    await f.agent.post('/api/auth/logout').send({}).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', secondCookie).expect(401);
    expect(await prisma.authSession.count({ where: { userId: f.user.id } })).toBe(0);
  });

  it('switches one global provider between memberships and isolates each workspace', async () => {
    const first = await loginFixture();
    const second = await tenants.fixture();
    const secondMembership = await prisma.membership.create({
      data: { userId: first.user.id, businessId: second.business.id, role: 'ADMIN' },
    });
    const foreignUser = await createAccount(second, { accountType: 'COACH' });
    const foreignMembership = await prisma.membership.create({
      data: { userId: foreignUser.id, businessId: second.business.id, role: 'COACH' },
    });
    const ownCustomer = await createCustomer(first);
    const foreignCustomer = await createCustomer(second);
    const own = await createBookings(first.business.id, inputFor(first, { customerId: ownCustomer.id, customer: undefined }));
    const foreign = await createBookings(second.business.id, inputFor(second, { customerId: foreignCustomer.id, customer: undefined }));

    expect((await first.agent.get('/api/workspace').expect(200)).body.business.id).toBe(first.business.id);
    const switched = await first.agent.post('/api/auth/switch-workspace')
      .send({ membershipId: secondMembership.id }).expect(200);
    expect(switched.body).toMatchObject({
      membership: { id: secondMembership.id, businessId: second.business.id },
      business: { id: second.business.id },
    });
    const workspace = await first.agent.get('/api/workspace').expect(200);
    expect(workspace.body.business.id).toBe(second.business.id);
    expect(workspace.body.bookings.map((booking: { id: string }) => booking.id)).toEqual([foreign.bookings[0]!.id]);
    expect(JSON.stringify(workspace.body)).not.toContain(own.bookings[0]!.id);
    await first.agent.patch(`/api/bookings/${own.bookings[0]!.id}`).send({ status: 'CANCELLED' }).expect(404);
    await first.agent.post('/api/auth/switch-workspace').send({ membershipId: foreignMembership.id }).expect(403);
    await prisma.membership.update({ where: { id: secondMembership.id }, data: { active: false } });
    await first.agent.post('/api/auth/switch-workspace').send({ membershipId: secondMembership.id }).expect(403);
  });

  it('links only pre-registered staff and removes membership while preserving the global user and history', async () => {
    const owner = await loginFixture();
    const otherTenant = await tenants.fixture();
    const staffEmail = `${randomUUID()}@example.test`;
    const staff = await createAccount(owner, {
      name: 'Assistant Coach', email: staffEmail, accountType: 'COACH',
      passwordHash: await bcrypt.hash(password, 4),
    });
    // A coach keeps one portable personal account across the clubs that add
    // them, so an existing coach membership elsewhere is no obstacle here.
    const otherMembership = await prisma.membership.create({
      data: { userId: staff.id, businessId: otherTenant.business.id, role: 'COACH' },
    });
    await owner.agent.post('/api/staff').send({
      email: `${randomUUID()}@example.test`, role: 'ADMIN', instructorId: null,
    }).expect(404);
    // A club-admin login belongs to one club alone, so an account that
    // already works somewhere else cannot be made this club's admin.
    await owner.agent.post('/api/staff').send({
      email: staffEmail, role: 'ADMIN', instructorId: null,
    }).expect(409);
    const created = await owner.agent.post('/api/staff').send({
      email: staffEmail, role: 'COACH', instructorId: null,
    }).expect(201);
    expect(created.body).toMatchObject({
      userId: staff.id, name: 'Assistant Coach', email: staffEmail, accountType: 'COACH',
      role: 'COACH', active: true,
    });
    expect(created.body.instructorId).toEqual(expect.any(String));
    expect(created.body).not.toHaveProperty('passwordHash');
    const linkedCustomer = await createCustomer(owner);
    await prisma.serviceInstructor.create({
      data: {
        serviceLocationId: (await prisma.serviceLocation.findUniqueOrThrow({
          where: { serviceId_locationId: { serviceId: owner.service.id, locationId: owner.location.id } },
        })).id,
        instructorId: created.body.instructorId,
      },
    });
    await prisma.availability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId: owner.business.id, instructorId: created.body.instructorId, locationId: owner.location.id,
      dayOfWeek, startTime: '08:00', endTime: '20:00',
    })) });
    const lesson = await createBookings(owner.business.id, inputFor(owner, {
      customerId: linkedCustomer.id, customer: undefined, instructorId: created.body.instructorId,
    }));

    const listing = await owner.agent.get('/api/staff').expect(200);
    expect(listing.body.map((membership: { id: string }) => membership.id)).toEqual(
      expect.arrayContaining([owner.membership.id, created.body.id]),
    );
    expect(JSON.stringify(listing.body)).not.toContain(otherMembership.id);
    await request(app).delete(`/api/staff/${created.body.id}`).set('Cookie', otherTenant.cookie).expect(404);

    const coach = request.agent(app);
    await coach.post('/api/auth/login').send({ email: staffEmail, password }).expect(200);
    await coach.get('/api/staff').expect(403);
    await coach.post('/api/auth/switch-workspace').send({ membershipId: created.body.id }).expect(200);
    // The same single-club rule applies to a promotion, not only to a new
    // membership: this account still belongs to another club. The other club's
    // membership is untouched by the refusal.
    await owner.agent.patch(`/api/staff/${created.body.id}`).send({ role: 'ADMIN', instructorId: null }).expect(409);
    expect(await prisma.membership.findUniqueOrThrow({ where: { id: otherMembership.id } }))
      .toMatchObject({ role: 'COACH', businessId: otherTenant.business.id });
    // Detaching the roster link is still allowed for a coach membership.
    await owner.agent.patch(`/api/staff/${created.body.id}`).send({ role: 'COACH', instructorId: null }).expect(200);
    await owner.agent.delete(`/api/staff/${created.body.id}`).expect(200);
    await coach.get('/api/workspace').expect(403);
    expect(await prisma.membership.findUnique({ where: { id: created.body.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: staff.id } })).toMatchObject({ email: staffEmail });
    expect(await prisma.membership.findUnique({ where: { id: otherMembership.id } })).not.toBeNull();
    expect(await prisma.instructor.findUnique({ where: { id: created.body.instructorId } })).toMatchObject({ active: false });
    expect(await prisma.booking.findUnique({ where: { id: lesson.bookings[0]!.id } })).not.toBeNull();
  });

  it('allows provider bookings only for existing account-linked customers', async () => {
    const owner = await loginFixture();
    const linked = await createCustomer(owner);
    const legacy = await createCustomer(owner, { userId: null });
    await owner.agent.post('/api/bookings').send(inputFor(owner)).expect(400);
    await owner.agent.post('/api/bookings').send(inputFor(owner, {
      customerId: legacy.id, customer: undefined,
    })).expect(400);
    const created = await owner.agent.post('/api/bookings').send(inputFor(owner, {
      customerId: linked.id, customer: undefined,
    })).expect(201);
    expect(created.body).not.toHaveProperty('managementToken');
    expect(created.body.bookings[0].participants[0].customerId).toBe(linked.id);
    const persisted = await prisma.participant.findUniqueOrThrow({
      where: { id: created.body.bookings[0].participants[0].id },
    });
    expect(persisted).toMatchObject({ managementTokenHash: null, managementTokenExpiresAt: null });
  });

  it('limits a coach membership to its schedule and denies other-coach or administrative writes', async () => {
    const f = await loginFixture('COACH');
    const other = await prisma.instructor.create({ data: { businessId: f.business.id, name: 'Other Coach', initials: 'OC' } });
    const otherCoachAccount = await createAccount(f, {
      name: 'Other Coach', email: `${randomUUID()}@example.test`,
      accountType: 'COACH', passwordHash: 'registered-provider-account',
    });
    await prisma.membership.create({
      data: {
        userId: otherCoachAccount.id, businessId: f.business.id, role: 'COACH', instructorId: other.id,
      },
    });
    const assignment = await prisma.serviceLocation.findUniqueOrThrow({
      where: { serviceId_locationId: { serviceId: f.service.id, locationId: f.location.id } },
    });
    await prisma.serviceInstructor.create({ data: { serviceLocationId: assignment.id, instructorId: other.id } });
    const unassignedLocation = await prisma.location.create({
      data: { businessId: f.business.id, name: 'Other coach court' },
    });
    const unassignedService = await prisma.service.create({
      data: {
        businessId: f.business.id, name: 'Other coach clinic',
        locations: { create: {
          locationId: unassignedLocation.id, price: 9500, duration: 75,
          instructors: { create: { instructorId: other.id } },
        } },
      },
    });
    await prisma.serviceLocation.create({
      data: {
        serviceId: f.service.id, locationId: unassignedLocation.id, price: 8500, duration: 60,
        instructors: { create: { instructorId: other.id } },
      },
    });
    await prisma.availability.createMany({ data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId: f.business.id, instructorId: other.id, locationId: f.location.id,
      dayOfWeek, startTime: '08:00', endTime: '20:00',
    })) });
    const ownCustomer = await createCustomer(f);
    const otherCustomer = await createCustomer(f);
    const own = await createBookings(f.business.id, inputFor(f, { customerId: ownCustomer.id, customer: undefined }));
    const others = await createBookings(f.business.id, inputFor(f, {
      customerId: otherCustomer.id, customer: undefined, instructorId: other.id,
    }));

    const workspace = await f.agent.get('/api/workspace').expect(200);
    expect(workspace.body).toMatchObject({
      user: { role: 'COACH' }, membership: { id: f.membership.id, role: 'COACH' },
    });
    expect(workspace.body.bookings.map((booking: { id: string }) => booking.id)).toEqual([own.bookings[0]!.id]);
    expect(workspace.body.customers.map((customer: { id: string }) => customer.id)).toEqual([ownCustomer.id]);
    expect(workspace.body.instructors.map((instructor: { id: string }) => instructor.id)).toEqual([f.instructor.id]);
    expect(workspace.body.locations.map((location: { id: string }) => location.id)).toEqual([f.location.id]);
    expect(workspace.body.services).toEqual([expect.objectContaining({
      id: f.service.id,
      locations: [{
        locationId: f.location.id, duration: 60, instructorIds: [f.instructor.id],
      }],
    })]);
    expect(workspace.body.services[0]).not.toHaveProperty('price');
    expect(workspace.body.services[0].locations[0]).not.toHaveProperty('price');
    expect(workspace.body.bookings[0]).not.toHaveProperty('price');
    expect(workspace.body.bookings[0].participants[0]).not.toHaveProperty('paid');
    expect(workspace.body.bookings[0].participants[0]).not.toHaveProperty('price');
    expect(workspace.body.bookings[0].participants[0]).not.toHaveProperty('packageId');
    expect(JSON.stringify(workspace.body)).not.toContain(unassignedService.id);
    expect(JSON.stringify(workspace.body)).not.toContain(unassignedLocation.id);

    const coachServices = await f.agent.get('/api/services').expect(200);
    expect(coachServices.body).toEqual([expect.objectContaining({
      id: f.service.id,
      locations: [{
        locationId: f.location.id, duration: 60, instructorIds: [f.instructor.id],
      }],
    })]);
    expect(coachServices.body[0]).not.toHaveProperty('price');
    expect(coachServices.body[0].locations[0]).not.toHaveProperty('price');
    expect(JSON.stringify(coachServices.body)).not.toContain(unassignedService.id);
    expect(JSON.stringify(coachServices.body)).not.toContain(unassignedLocation.id);

    const coachBookings = await f.agent.get('/api/bookings').expect(200);
    expect(coachBookings.body.map((booking: { id: string }) => booking.id)).toEqual([own.bookings[0]!.id]);
    expect(coachBookings.body[0]).not.toHaveProperty('price');
    expect(coachBookings.body[0].participants[0]).not.toHaveProperty('paid');
    expect(coachBookings.body[0].participants[0]).not.toHaveProperty('price');
    expect(coachBookings.body[0].participants[0]).not.toHaveProperty('packageId');
    const packageForOwnCustomer = await createPackage(f, ownCustomer.id);
    await f.agent.post('/api/bookings').send(inputFor(f, {
      customerId: ownCustomer.id, customer: undefined, packageId: packageForOwnCustomer.id,
      startAt: f.starts.plus({ days: 1 }).toISO()!,
    })).expect(403);
    const createdWithoutPackage = await f.agent.post('/api/bookings').send(inputFor(f, {
      customerId: ownCustomer.id, customer: undefined,
      startAt: f.starts.plus({ days: 1 }).toISO()!,
    })).expect(201);
    expect(createdWithoutPackage.body.bookings[0]).not.toHaveProperty('price');
    expect(createdWithoutPackage.body.bookings[0].participants[0]).not.toHaveProperty('paid');
    expect(createdWithoutPackage.body.bookings[0].participants[0]).not.toHaveProperty('price');
    expect(createdWithoutPackage.body.bookings[0].participants[0]).not.toHaveProperty('packageId');
    await f.agent.patch(`/api/bookings/${others.bookings[0]!.id}`).send({ notes: 'Unauthorized edit' }).expect(403);
    await f.agent.post('/api/bookings').send(inputFor(f, {
      customerId: otherCustomer.id, customer: undefined, instructorId: other.id,
      startAt: f.starts.plus({ days: 1 }).toISO()!,
    })).expect(403);
    await f.agent.post('/api/payments').send({ customerId: ownCustomer.id, amount: 100, method: 'CASH' }).expect(403);
  });
});

describe.sequential('Customer account notifications', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => { tenants = new TestTenants(); f = await tenants.fixture(); });
  afterEach(async () => { await tenants.cleanup(); });

  it('returns only the signed-in customer inbox and enforces ownership when marking alerts read', async () => {
    const account = await createAccount(f, { name: 'Alert Owner' });
    const session = await createSession(f, account.id);
    const created = await createBookings(f.business.id, inputFor(f, {
      customer: { name: account.name, email: account.email },
    }), { customerUserId: account.id });
    const own = await prisma.accountNotification.findFirstOrThrow({ where: { userId: account.id } });
    const readableWhen = f.starts.setLocale('en-SG').toFormat("ccc, d LLL yyyy 'at' h:mm a");
    const stranger = await createAccount(f, { name: 'Alert Stranger' });
    const foreign = await prisma.accountNotification.create({ data: {
      userId: stranger.id, businessId: f.business.id, bookingId: created.bookings[0]!.id,
      type: 'BOOKING_CREATED', title: 'Foreign alert', message: 'Must stay private',
    } });

    const inbox = await request(app).get('/api/account/notifications').set('Cookie', session.cookie).expect(200);
    expect(inbox.body).toEqual({ notifications: [{
      id: own.id, userId: account.id, businessId: f.business.id, bookingId: created.bookings[0]!.id,
      type: 'BOOKING_CREATED', title: 'Booking confirmed', message: expect.any(String),
      read: false, actionNeeded: false, createdAt: own.createdAt.toISOString(),
      business: { name: f.business.name, slug: f.business.slug },
    }] });
    expect(inbox.body.notifications[0].message).toContain(readableWhen);
    expect(inbox.body.notifications[0].message).not.toContain(f.starts.toJSDate().toISOString());
    expect(JSON.stringify(inbox.body)).not.toContain(foreign.id);
    expect(JSON.stringify(inbox.body)).not.toContain('Must stay private');

    await request(app).patch('/api/account/notifications/read').set('Cookie', session.cookie)
      .send({ ids: [foreign.id] }).expect(404);
    expect(await prisma.accountNotification.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ read: false });
    expect(await prisma.accountNotification.findUniqueOrThrow({ where: { id: foreign.id } })).toMatchObject({ read: false });

    const selected = await request(app).patch('/api/account/notifications/read').set('Cookie', session.cookie)
      .send({ ids: [own.id, own.id] }).expect(200);
    expect(selected.body).toEqual({ ok: true, count: 1 });
    await prisma.accountNotification.create({ data: {
      userId: account.id, type: 'ACCOUNT_INFO', title: 'Second alert', message: 'Read all test',
    } });
    const all = await request(app).patch('/api/account/notifications/read').set('Cookie', session.cookie)
      .send({}).expect(200);
    expect(all.body).toEqual({ ok: true, count: 1 });
    expect(await prisma.accountNotification.count({ where: { userId: account.id, read: false } })).toBe(0);

    await request(app).get('/api/account/notifications').expect(401);
    await request(app).get('/api/account/notifications').set('Cookie', f.cookie).expect(403);
  });

  it('creates isolated customer alerts for booking lifecycle transitions and skips no-op transitions', async () => {
    const account = await createAccount(f, { name: 'Lifecycle Customer' });
    const session = await createSession(f, account.id);
    await prisma.location.update({ where: { id: f.location.id }, data: { requiresApproval: true } });

    const requested = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', session.cookie).send({
        serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
        startAt: f.starts.toISO(),
      }).expect(201);
    const providerBookingId = requested.body.bookings[0].id as string;
    expect(requested.body.bookings[0].status).toBe('PENDING');
    await request(app).patch(`/api/bookings/${providerBookingId}`).set('Cookie', f.cookie)
      .send({ status: 'PENDING' }).expect(200);
    expect(await prisma.accountNotification.count({ where: { userId: account.id } })).toBe(1);
    await request(app).patch(`/api/bookings/${providerBookingId}`).set('Cookie', f.cookie)
      .send({ status: 'CONFIRMED' }).expect(200);
    await request(app).patch(`/api/bookings/${providerBookingId}`).set('Cookie', f.cookie)
      .send({ status: 'CONFIRMED' }).expect(200);
    expect(await prisma.accountNotification.count({ where: { userId: account.id } })).toBe(2);
    await request(app).patch(`/api/bookings/${providerBookingId}`).set('Cookie', f.cookie)
      .send({ status: 'PENDING' }).expect(200);
    await request(app).patch(`/api/bookings/${providerBookingId}`).set('Cookie', f.cookie)
      .send({ status: 'CONFIRMED' }).expect(200);
    await prisma.location.update({ where: { id: f.location.id }, data: { requiresApproval: false } });
    // Rescheduling is a two-sided negotiation: the club proposes, the customer
    // accepts, and only then does the session actually move.
    const movedStart = f.starts.plus({ days: 1 });
    const proposal = await request(app).post(`/api/bookings/${providerBookingId}/reschedule-requests`)
      .set('Cookie', f.cookie).send({ startAt: movedStart.toISO() }).expect(201);
    await request(app).post(`/api/account/reschedule-requests/${proposal.body.id}/accept`)
      .set('Cookie', session.cookie).send({}).expect(200);
    const beforeNoOp = await Promise.all([
      prisma.accountNotification.count({ where: { userId: account.id } }),
      prisma.notification.count({ where: { businessId: f.business.id } }),
    ]);
    // Proposing the time the session already holds is refused outright, so it
    // cannot produce a second, meaningless round of alerts.
    await request(app).post(`/api/bookings/${providerBookingId}/reschedule-requests`)
      .set('Cookie', f.cookie).send({ startAt: movedStart.toUTC().toISO() }).expect(400);
    expect(await Promise.all([
      prisma.accountNotification.count({ where: { userId: account.id } }),
      prisma.notification.count({ where: { businessId: f.business.id } }),
    ])).toEqual(beforeNoOp);
    await request(app).patch(`/api/bookings/${providerBookingId}`).set('Cookie', f.cookie)
      .send({ status: 'COMPLETED' }).expect(200);
    await request(app).patch(`/api/bookings/${providerBookingId}`).set('Cookie', f.cookie)
      .send({ status: 'COMPLETED' }).expect(200);

    const cancelledBooking = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', session.cookie).send({
        serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
        startAt: f.starts.plus({ days: 2 }).toISO(),
      }).expect(201);
    const providerCancelledId = cancelledBooking.body.bookings[0].id as string;
    await request(app).patch(`/api/bookings/${providerBookingId}`).set('Cookie', f.cookie)
      .send({ status: 'CANCELLED' }).expect(400);
    await request(app).patch(`/api/bookings/${providerCancelledId}`).set('Cookie', f.cookie)
      .send({ status: 'CANCELLED' }).expect(200);

    const customerBooking = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', session.cookie).send({
        serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
        startAt: f.starts.plus({ days: 3 }).toISO(),
      }).expect(201);
    const customerParticipantId = customerBooking.body.bookings[0].participants[0].id as string;
    const customerBookingId = customerBooking.body.bookings[0].id as string;
    await request(app).post(`/api/account/bookings/${customerParticipantId}/cancel`)
      .set('Cookie', session.cookie).send({}).expect(200);

    const alerts = await prisma.accountNotification.findMany({ where: { userId: account.id } });
    expect(alerts).toHaveLength(11);
    expect(alerts.map(alert => alert.type)).toEqual(expect.arrayContaining([
      'BOOKING_REQUESTED', 'BOOKING_CONFIRMED', 'BOOKING_PENDING', 'BOOKING_CONFIRMED',
      'RESCHEDULE_REQUESTED', 'BOOKING_RESCHEDULED', 'BOOKING_COMPLETED', 'BOOKING_CREATED',
      'BOOKING_CANCELLED', 'BOOKING_CREATED', 'BOOKING_CANCELLED',
    ]));
    for (const alert of alerts) expect(alert.message).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(alerts.find(alert => alert.type === 'BOOKING_REQUESTED')?.message)
      .toContain(f.starts.setLocale('en-SG').toFormat("ccc, d LLL yyyy 'at' h:mm a"));
    expect(alerts.find(alert => alert.type === 'BOOKING_RESCHEDULED')?.message)
      .toContain(f.starts.plus({ days: 1 }).setLocale('en-SG').toFormat("ccc, d LLL yyyy 'at' h:mm a"));
    expect(alerts.filter(alert => alert.bookingId === providerBookingId)).toHaveLength(7);
    const pending = alerts.find(alert => alert.bookingId === providerBookingId && alert.type === 'BOOKING_PENDING')!;
    expect(pending).toMatchObject({ title: 'Booking awaiting confirmation', actionNeeded: false });
    expect(pending.message).toContain('pending confirmation');
    const completed = alerts.find(alert => alert.bookingId === providerBookingId && alert.type === 'BOOKING_COMPLETED')!;
    expect(completed).toMatchObject({ title: 'Session completed', actionNeeded: false });
    const rescheduled = alerts.find(alert => alert.bookingId === providerBookingId && alert.type === 'BOOKING_RESCHEDULED')!;
    expect(rescheduled).toMatchObject({ title: 'Booking rescheduled', actionNeeded: true });
    expect(rescheduled.message).toContain('Please review the updated time');
    const providerCancellation = alerts.find(alert => alert.bookingId === providerCancelledId && alert.type === 'BOOKING_CANCELLED')!;
    expect(providerCancellation).toMatchObject({ actionNeeded: true, read: false });
    expect(providerCancellation.message).toContain(`${f.business.name} cancelled`);
    const customerCancellation = alerts.find(alert => alert.bookingId === customerBookingId && alert.type === 'BOOKING_CANCELLED')!;
    expect(customerCancellation).toMatchObject({ actionNeeded: false, read: false });
    expect(customerCancellation.message).toContain('You cancelled');
    // The separate provider workspace stream is retained alongside account alerts.
    expect(await prisma.notification.count({ where: { businessId: f.business.id } })).toBe(7);
  });

  it('marks a reschedule pending when venue confirmation is required without claiming customer action is needed', async () => {
    const account = await createAccount(f, { name: 'Pending Reschedule Customer' });
    const session = await createSession(f, account.id);
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', session.cookie).send({
        serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
        startAt: f.starts.toISO(),
      }).expect(201);
    const bookingId = created.body.bookings[0].id as string;
    await prisma.location.update({ where: { id: f.location.id }, data: { requiresApproval: true } });

    const proposal = await request(app).post(`/api/bookings/${bookingId}/reschedule-requests`)
      .set('Cookie', f.cookie).send({ startAt: f.starts.plus({ days: 1 }).toISO() }).expect(201);
    const moved = await request(app).post(`/api/reschedule-requests/${proposal.body.id}/accept`)
      .set('Cookie', f.cookie).send({}).expect(403);
    // Only the customer can accept a proposal the provider side raised.
    const accepted = await request(app).post(`/api/account/reschedule-requests/${proposal.body.id}/accept`)
      .set('Cookie', session.cookie).send({}).expect(200);
    expect(accepted.body.booking.status).toBe('PENDING');
    void moved;
    const alert = await prisma.accountNotification.findFirstOrThrow({
      where: { userId: account.id, bookingId, type: 'BOOKING_RESCHEDULED' },
    });
    expect(alert).toMatchObject({
      title: 'Booking rescheduled · confirmation pending', actionNeeded: false,
    });
    expect(alert.message).toContain('awaiting venue confirmation');
    expect(alert.message).toContain('No action is needed from you');
  });
});
