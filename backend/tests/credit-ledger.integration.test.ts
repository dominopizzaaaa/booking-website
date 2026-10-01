import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import {
  createAccount, createPackage, createSession, createStudent, prisma, publicInputFor, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type CheckoutPolicyKind = 'TERMS' | 'CANCELLATION_REFUNDS' | 'PACKAGE_TERMS';
type CheckoutReviewWire = { reviewHash: string; policies: Array<{ kind: CheckoutPolicyKind; version: string }> };
type CreditEventWire = {
  id: string; kind: string; delta: number; balanceAfter: number; totalAfter: number; note: string; createdAt: string;
  bookingId: string | null; reservationId: string | null;
  session: { serviceName: string; startAt: string; timezone: string } | null;
};

async function packageCheckoutAcceptance(cookie: string, targetId: string) {
  const response = await request(app).get('/api/payments/checkout-review')
    .set('Cookie', cookie).query({ kind: 'PACKAGE', targetId }).expect(200);
  const review = response.body.review as CheckoutReviewWire;
  const policyVersion = (kind: CheckoutPolicyKind) => {
    const policy = review.policies.find(candidate => candidate.kind === kind);
    if (!policy) throw new Error(`Checkout review omitted ${kind}`);
    return policy.version;
  };
  return {
    accepted: true as const, reviewHash: review.reviewHash, termsVersion: policyVersion('TERMS'),
    cancellationRefundPolicyVersion: policyVersion('CANCELLATION_REFUNDS'),
    packageTermsVersion: policyVersion('PACKAGE_TERMS'),
  };
}

const rentalConfig = {
  sport: 'Tennis', rules: '', amenities: [], unitLabel: 'Court', price: 2_400, startInterval: 30, minDuration: 60,
  durationIncrement: 30, maxDuration: 120, noticeHours: 0, advanceDays: 60, cancellationHours: 24,
  units: [{ name: 'Court 1' }],
  openingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, startTime: '08:00', endTime: '20:00' })),
};

describe.sequential('package credit activity', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function learner(fixture = club) {
    const account = await createAccount(fixture);
    const student = await createStudent(fixture, { userId: account.id, name: account.name, email: account.email });
    const session = await createSession(fixture, account.id);
    return { account, student, ...session };
  }

  async function staffCookie(permissions: string[]) {
    const suffix = randomUUID().replaceAll('-', '');
    const user = await prisma.user.create({ data: {
      name: 'Finance Staff', legalName: 'Finance Staff', username: `fin_${suffix.slice(0, 18)}`, email: `fin-${suffix}@example.test`,
      passwordHash: 'not-used', accountType: 'STUDENT',
    } });
    tenants.ownUser(user.id);
    const access = await prisma.clubStaffAccess.create({ data: {
      businessId: club.business.id, userId: user.id, invitedByUserId: club.user.id, accessLevel: 'CUSTOM', permissions,
    } });
    const token = randomBytes(32).toString('base64url');
    await prisma.authSession.create({ data: {
      id: createHash('sha256').update(token).digest('hex'), userId: user.id, activeStaffAccessId: access.id,
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    return `${config.sessionCookie}=${token}`;
  }

  const accountActivity = (cookie: string, packageId: string) =>
    request(app).get(`/api/account/packages/${packageId}/activity`).set('Cookie', cookie);
  const clubActivity = (cookie: string, packageId: string) =>
    request(app).get(`/api/packages/${packageId}/activity`).set('Cookie', cookie);

  it('labels a self-booked package credit and its restoration after the learner cancels', async () => {
    const seat = await learner();
    const pkg = await createPackage(club, seat.student.id, { totalCredits: 4 });
    const booked = await request(app).post(`/api/public/${club.business.slug}/bookings`).set('Cookie', seat.cookie)
      .send({ ...publicInputFor(club), packageId: pkg.id }).expect(201);
    const booking = booked.body.bookings[0];
    const participantId = booking.participants[0].id as string;

    const afterBooking = await accountActivity(seat.cookie, pkg.id).expect(200);
    expect(afterBooking.body.package).toEqual({
      id: pkg.id, name: 'Five lessons', totalCredits: 4, usedCredits: 1, remainingCredits: 3,
      expiresAt: pkg.expiresAt.toISOString(),
      business: { name: club.business.name, slug: club.business.slug, currency: 'SGD' },
    });
    const events = afterBooking.body.events as CreditEventWire[];
    expect(events.map(event => [event.kind, event.delta, event.balanceAfter, event.totalAfter])).toEqual([
      ['GRANTED', 4, 4, 4], ['BOOKED', -1, 3, 4],
    ]);
    expect(events[1]!.note).toContain(club.service.name);
    expect(events.every(event => typeof event.createdAt === 'string' && event.reservationId === null)).toBe(true);
    // The booking actor is recorded server-side; the wire never exposes it.
    expect(events[1]).not.toHaveProperty('actorUserId');
    expect(await prisma.packageCreditEvent.findFirstOrThrow({ where: { packageId: pkg.id, kind: 'BOOKED' } }))
      .toMatchObject({ actorUserId: seat.account.id, studentId: seat.student.id });

    await request(app).post(`/api/account/bookings/${participantId}/cancel`).set('Cookie', seat.cookie).send({}).expect(200);
    const afterCancel = await accountActivity(seat.cookie, pkg.id).expect(200);
    const restored = (afterCancel.body.events as CreditEventWire[]).at(-1)!;
    expect(restored).toMatchObject({
      kind: 'RESTORED', delta: 1, balanceAfter: 4, totalAfter: 4, bookingId: booking.id, reservationId: null,
      session: { serviceName: club.service.name, startAt: booking.startAt, timezone: 'Asia/Singapore' },
    });
    expect(restored.note).toContain('cancelled');
    expect(afterCancel.body.package).toMatchObject({ usedCredits: 0, remainingCredits: 4 });

    // The club sees exactly the same projection of its own package.
    const workspace = await clubActivity(club.cookie, pkg.id).expect(200);
    expect(workspace.body).toEqual(afterCancel.body);
  });

  it('records a package-funded court reservation and its cancellation', async () => {
    const configured = await request(app).post('/api/rentals').set('Cookie', club.cookie)
      .send({ locationId: club.location.id, ...rentalConfig }).expect(201);
    const unitId = configured.body.rental.units[0].id as string;
    const seat = await learner();
    const pkg = await prisma.lessonPackage.create({ data: {
      businessId: club.business.id, studentId: seat.student.id, name: 'Court pack', totalCredits: 3, price: 6_000, paid: true,
      expiresAt: DateTime.now().plus({ days: 90 }).toJSDate(), rentalLocations: { create: { locationId: club.location.id } },
    } });
    const startAt = DateTime.now().setZone('Asia/Singapore').plus({ days: 7 }).startOf('day').set({ hour: 10 }).toUTC().toISO();
    const reserved = await request(app).post(`/api/rentals/${club.location.id}/reservations`).set('Cookie', seat.cookie).send({
      unitId, startAt, duration: 60, packageId: pkg.id, idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED',
    }).expect(201);
    const reservationId = reserved.body.reservation.id as string;
    await request(app).post(`/api/rentals/reservations/${reservationId}/cancel`).set('Cookie', seat.cookie).send({}).expect(200);

    const activity = await accountActivity(seat.cookie, pkg.id).expect(200);
    const events = activity.body.events as CreditEventWire[];
    expect(events.map(event => [event.kind, event.delta, event.balanceAfter])).toEqual([
      ['GRANTED', 3, 3], ['RENTAL_RESERVED', -1, 2], ['RENTAL_RESTORED', 1, 3],
    ]);
    expect(events[1]!.note).toContain('Court 1');
    expect(events[2]).toMatchObject({ reservationId, bookingId: null, session: null, note: 'Court reservation cancelled' });
  });

  it('records a club edit as an attributed adjustment and an online purchase as a grant', async () => {
    const seat = await learner();
    const pkg = await createPackage(club, seat.student.id, { totalCredits: 5, paid: false });
    await request(app).patch(`/api/packages/${pkg.id}`).set('Cookie', club.cookie).send({ totalCredits: 8 }).expect(200);
    const adjusted = await clubActivity(club.cookie, pkg.id).expect(200);
    expect((adjusted.body.events as CreditEventWire[]).at(-1)).toMatchObject({
      kind: 'ADJUSTED', delta: 3, balanceAfter: 8, totalAfter: 8, note: 'Package edited by the club',
    });
    expect(await prisma.packageCreditEvent.findFirstOrThrow({ where: { packageId: pkg.id, kind: 'ADJUSTED' } }))
      .toMatchObject({ actorUserId: club.user.id });
    // A non-credit edit adds nothing to the ledger.
    await request(app).patch(`/api/packages/${pkg.id}`).set('Cookie', club.cookie).send({ name: 'Eight lessons' }).expect(200);
    expect(await prisma.packageCreditEvent.count({ where: { packageId: pkg.id } })).toBe(2);

    const offer = await request(app).post('/api/package-offers').set('Cookie', club.cookie).send({
      name: 'Six lesson pass', description: '', price: 42_000, totalCredits: 6, validityDays: 120,
      serviceIds: [club.service.id], rentalLocationIds: [],
    }).expect(201);
    const acceptance = await packageCheckoutAcceptance(seat.cookie, offer.body.id);
    const checkout = await request(app).post(`/api/account/package-offers/${offer.body.id}/checkout`).set('Cookie', seat.cookie)
      .send({ idempotencyKey: randomUUID(), simulatedOutcome: 'SUCCEEDED', acceptance }).expect(201);
    const purchased = await accountActivity(seat.cookie, checkout.body.package.id).expect(200);
    expect(purchased.body.package).toMatchObject({ name: 'Six lesson pass', totalCredits: 6, usedCredits: 0, remainingCredits: 6 });
    expect(purchased.body.events).toEqual([expect.objectContaining({
      kind: 'GRANTED', delta: 6, balanceAfter: 6, totalAfter: 6, note: 'Six lesson pass', bookingId: null, session: null,
    })]);
  });

  it('appends one synthetic expiry for unused credits only after the package has expired', async () => {
    const seat = await learner();
    const expired = await createPackage(club, seat.student.id, {
      totalCredits: 5, usedCredits: 2, expiresAt: new Date(Date.now() - 86_400_000),
    });
    const activity = await accountActivity(seat.cookie, expired.id).expect(200);
    const events = activity.body.events as CreditEventWire[];
    expect(events.map(event => event.kind)).toEqual(['GRANTED', 'USED', 'EXPIRED']);
    expect(events.at(-1)).toEqual({
      id: `expiry:${expired.id}`, kind: 'EXPIRED', delta: -3, balanceAfter: 0, totalAfter: 5,
      note: '3 unused credits expired', createdAt: expired.expiresAt.toISOString(),
      bookingId: null, reservationId: null, session: null,
    });
    // The synthetic line is a projection, not a ledger row.
    expect(await prisma.packageCreditEvent.count({ where: { packageId: expired.id } })).toBe(2);

    const usedUp = await createPackage(club, seat.student.id, {
      totalCredits: 2, usedCredits: 2, expiresAt: new Date(Date.now() - 86_400_000),
    });
    expect((await accountActivity(seat.cookie, usedUp.id).expect(200)).body.events.map((event: CreditEventWire) => event.kind))
      .toEqual(['GRANTED', 'USED']);
    const live = await createPackage(club, seat.student.id, { totalCredits: 2 });
    expect((await clubActivity(club.cookie, live.id).expect(200)).body.events.map((event: CreditEventWire) => event.kind))
      .toEqual(['GRANTED']);
  });

  it('limits learner activity to the package owner and workspace activity to permitted club staff of that tenant', async () => {
    const owner = await learner();
    const pkg = await createPackage(club, owner.student.id);
    await request(app).get(`/api/account/packages/${pkg.id}/activity`).expect(401);
    await accountActivity(owner.cookie, pkg.id).expect(200);

    const stranger = await learner();
    expect((await accountActivity(stranger.cookie, pkg.id).expect(404)).body).toEqual({ error: 'Package not found' });
    await accountActivity(owner.cookie, `missing-${randomUUID()}`).expect(404);
    // An unlinked historical record has no account owner at all.
    const unlinked = await createStudent(club, { userId: null, name: 'Walk-in Student' });
    await accountActivity(owner.cookie, (await createPackage(club, unlinked.id)).id).expect(404);

    // Learner activity is a student commerce surface.
    await accountActivity(club.coachCookie, pkg.id).expect(403);
    await accountActivity(club.cookie, pkg.id).expect(403);
    const teen = await createAccount(club, {
      name: 'Teen Learner',
    });
    await prisma.user.update({ where: { id: teen.id }, data: {
      dateOfBirth: new Date(`${DateTime.now().setZone('Asia/Singapore').minus({ years: 15 }).toISODate()}T00:00:00.000Z`),
    } });
    const teenStudent = await createStudent(club, { userId: teen.id, name: teen.name, email: teen.email });
    const teenPackage = await createPackage(club, teenStudent.id);
    const teenSession = await createSession(club, teen.id);
    const denied = await accountActivity(teenSession.cookie, teenPackage.id).expect(403);
    expect(denied.body).toMatchObject({ code: 'CAPABILITY_REQUIRED', capability: 'commerce' });

    // Workspace activity: club account and PACKAGES_VIEW staff, never a coach
    // or another club.
    await clubActivity(club.cookie, pkg.id).expect(200);
    await clubActivity(club.coachCookie, pkg.id).expect(403);
    await clubActivity(await staffCookie(['PACKAGES_VIEW']), pkg.id).expect(200);
    await clubActivity(await staffCookie(['PACKAGES_MANAGE']), pkg.id).expect(200);
    await clubActivity(await staffCookie(['BOOKINGS_VIEW', 'STUDENTS_VIEW']), pkg.id).expect(403);
    const other = await tenants.fixture();
    expect((await clubActivity(other.cookie, pkg.id).expect(404)).body).toEqual({ error: 'Package not found' });
  });

  it('fills session details only for bookings in the package business', async () => {
    const seat = await learner();
    const pkg = await createPackage(club, seat.student.id, { totalCredits: 3 });
    const other = await tenants.fixture();
    const otherSeat = await learner(other);
    const foreign = await request(app).post(`/api/public/${other.business.slug}/bookings`).set('Cookie', otherSeat.cookie)
      .send(publicInputFor(other)).expect(201);
    // A forged label naming another club's booking never leaks its details.
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('courtly.credit_context', ${JSON.stringify({ kind: 'BOOKED', bookingId: foreign.body.bookings[0].id })}, true)`;
      await tx.lessonPackage.update({ where: { id: pkg.id }, data: { usedCredits: 1 } });
    });
    const events = (await accountActivity(seat.cookie, pkg.id).expect(200)).body.events as CreditEventWire[];
    expect(events.at(-1)).toMatchObject({ kind: 'BOOKED', bookingId: foreign.body.bookings[0].id, session: null });
  });
});
