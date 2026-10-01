import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { lockInstructors } from '../src/scheduling.js';
import { offerWaitlistPlaces, sweepWaitlists } from '../src/waitlist.js';
import {
  TestTenants, createAccount, createPackage, createSession, prisma, verifyTestDatabase, type Fixture,
} from './fixtures.js';

// Waitlists share the booking tables and instructor locks, so every scenario
// owns its tenants and runs sequentially; concurrency is introduced only by
// the explicit race tests below.
beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type Person = { id: string; name: string; cookie: string };
type Placed = Person & { participantId: string };

describe.sequential('Waitlists for full group Classes', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 2 } });
  });
  afterEach(async () => { await tenants.cleanup(); });

  const tuple = (fx: Fixture = f) => ({
    serviceId: fx.service.id, instructorId: fx.instructor.id, locationId: fx.location.id, startAt: fx.starts.toISO()!,
  });

  async function person(name: string, fx: Fixture = f): Promise<Person> {
    const account = await createAccount(fx, { name });
    const { cookie } = await createSession(fx, account.id);
    return { id: account.id, name, cookie };
  }

  const publicBooking = (p: Person, fx: Fixture = f) =>
    request(app).post(`/api/public/${fx.business.slug}/bookings`).set('Cookie', p.cookie).send(tuple(fx));

  async function book(p: Person, fx: Fixture = f) {
    const response = await publicBooking(p, fx);
    expect(response.status).toBe(201);
    return {
      bookingId: response.body.bookings[0].id as string,
      participantId: response.body.bookings[0].participants[0].id as string,
    };
  }

  /** A two-place group Class with both places taken through the public booking path. */
  async function fullClass(fx: Fixture = f) {
    const first = await person('First Place', fx);
    const second = await person('Second Place', fx);
    const a = await book(first, fx);
    const b = await book(second, fx);
    return {
      bookingId: a.bookingId,
      first: { ...first, participantId: a.participantId } as Placed,
      second: { ...second, participantId: b.participantId } as Placed,
    };
  }

  const join = (p: Person, fx: Fixture = f, body: Record<string, unknown> = tuple(fx)) =>
    request(app).post(`/api/public/${fx.business.slug}/waitlist`).set('Cookie', p.cookie).send(body);
  async function queued(p: Person, fx: Fixture = f) {
    const response = await join(p, fx);
    expect(response.status).toBe(201);
    return response.body.entry.id as string;
  }
  const cancelPlace = (p: Placed) =>
    request(app).post(`/api/account/bookings/${p.participantId}/cancel`).set('Cookie', p.cookie).send({});
  const accept = (p: Person, entryId: string, body: Record<string, unknown> = {}) =>
    request(app).post(`/api/account/waitlist/${entryId}/accept`).set('Cookie', p.cookie).send(body);
  const decline = (p: Person, entryId: string) =>
    request(app).post(`/api/account/waitlist/${entryId}/decline`).set('Cookie', p.cookie).send({});
  const leave = (p: Person, entryId: string) =>
    request(app).delete(`/api/account/waitlist/${entryId}`).set('Cookie', p.cookie);
  const accountList = (p: Person) => request(app).get('/api/account/waitlist').set('Cookie', p.cookie);
  const providerList = (bookingId: string, cookie = f.cookie) =>
    request(app).get(`/api/bookings/${bookingId}/waitlist`).set('Cookie', cookie);
  const entry = (id: string) => prisma.waitlistEntry.findUniqueOrThrow({ where: { id } });
  const alerts = (userId: string, type: string) => prisma.accountNotification.findMany({ where: { userId, type } });
  const metric = async (name: string, fx: Fixture = f) =>
    (await prisma.clubFunnelCounter.findMany({ where: { businessId: fx.business.id, metric: name } }))
      .reduce((sum, row) => sum + row.count, 0);
  const studentOf = (userId: string, fx: Fixture = f) =>
    prisma.student.findFirstOrThrow({ where: { businessId: fx.business.id, userId } });

  describe('joining', () => {
    it('requires a signed-in, self-managed student account', async () => {
      await fullClass();
      expect((await request(app).post(`/api/public/${f.business.slug}/waitlist`).send(tuple())).status).toBe(401);
      const coach = await request(app).post(`/api/public/${f.business.slug}/waitlist`)
        .set('Cookie', f.coachCookie).send(tuple());
      expect(coach.status).toBe(403);
      expect((await request(app).get('/api/account/waitlist').set('Cookie', f.cookie)).status).toBe(403);
      const waiter = await person('Strict Waiter');
      expect((await join(waiter, f, { ...tuple(), unexpected: true })).status).toBe(400);
    });

    it('refuses a Class that still has places, a missing Class, or a private service', async () => {
      const booker = await person('Only Booker');
      await book(booker);
      const waiter = await person('Eager Waiter');

      const open = await join(waiter);
      expect(open.status).toBe(409);
      expect(open.body.error).toBe('This Class still has places. Book it directly.');

      const missing = await join(waiter, f, { ...tuple(), startAt: f.starts.plus({ hours: 2 }).toISO()! });
      expect(missing.status).toBe(404);

      await prisma.service.update({ where: { id: f.service.id }, data: { type: 'PRIVATE', capacity: 1 } });
      expect((await join(waiter)).status).toBe(400);

      expect(await prisma.waitlistEntry.count({ where: { businessId: f.business.id } })).toBe(0);
      // A refused join leaves no club-local identity behind.
      expect(await prisma.student.count({ where: { businessId: f.business.id, userId: waiter.id } })).toBe(0);
    });

    it('queues in order, re-joins idempotently, creates the club student and counts the funnel', async () => {
      const { bookingId } = await fullClass();
      const a = await person('Waiter A');
      const b = await person('Waiter B');

      const first = await join(a);
      expect(first.status).toBe(201);
      expect(first.body.entry).toMatchObject({
        status: 'WAITING', aheadCount: 0, offeredAt: null, offerExpiresAt: null, closedReason: null,
        business: { slug: f.business.slug, name: f.business.name },
        booking: {
          id: bookingId, serviceId: f.service.id, serviceName: f.service.name,
          instructorId: f.instructor.id, instructorName: f.instructor.name,
          locationId: f.location.id, locationName: f.location.name,
          startAt: f.starts.toJSDate().toISOString(), capacity: 2, price: 8000,
        },
      });
      const second = await join(b);
      expect(second.status).toBe(201);
      expect(second.body.entry.aheadCount).toBe(1);

      const again = await join(a);
      expect(again.status).toBe(200);
      expect(again.body.entry.id).toBe(first.body.entry.id);

      const rows = await prisma.waitlistEntry.findMany({ where: { bookingId }, orderBy: { sequence: 'asc' } });
      expect(rows.map(row => row.id)).toEqual([first.body.entry.id, second.body.entry.id]);
      expect(rows[0]!.studentId).toBe((await studentOf(a.id)).id);
      expect(await metric('WAITLIST_JOINED')).toBe(2);

      const list = await accountList(b);
      expect(list.status).toBe(200);
      expect(list.body.entries).toHaveLength(1);
      expect(list.body.entries[0]).toMatchObject({ id: second.body.entry.id, status: 'WAITING', aheadCount: 1 });
    });

    it('refuses a student who already holds a place or another session at that time', async () => {
      const { first } = await fullClass();
      const enrolled = await join(first);
      expect(enrolled.status).toBe(409);
      expect(enrolled.body.error).toBe('You already have a place in this Class.');

      const other = await tenants.fixture();
      const busy = await person('Busy Student');
      expect((await publicBooking(busy, other)).status).toBe(201);
      const conflict = await join(busy);
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toBe('Student already has a session at this time');
    });
  });

  describe('offers', () => {
    it('offers a freed place to the first waiter and holds it from public booking and the slot grid', async () => {
      const { bookingId, first } = await fullClass();
      const a = await person('Waiter A');
      const b = await person('Waiter B');
      const ea = await queued(a);
      const eb = await queued(b);

      const before = Date.now();
      expect((await cancelPlace(first)).status).toBe(200);
      const offered = await entry(ea);
      expect(offered.status).toBe('OFFERED');
      expect(offered.offeredAt).not.toBeNull();
      expect(offered.offerExpiresAt!.getTime()).toBeGreaterThanOrEqual(before + 12 * 3_600_000 - 1_000);
      expect(offered.offerExpiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 12 * 3_600_000);
      expect((await entry(eb)).status).toBe('WAITING');
      expect(await alerts(a.id, 'WAITLIST_OFFERED')).toHaveLength(1);
      expect(await alerts(b.id, 'WAITLIST_OFFERED')).toHaveLength(0);

      const walkIn = await person('Walk In');
      expect((await publicBooking(walkIn)).status).toBe(409);
      const slots = await request(app).get(`/api/public/${f.business.slug}/slots`).query({
        serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id, date: f.starts.toISODate()!,
      });
      const slot = (slots.body.slots as Array<{ startAt: string }>)
        .find(candidate => new Date(candidate.startAt).getTime() === f.starts.toMillis());
      expect(slot).toMatchObject({ available: false, placesRemaining: 0, reason: 'This group is full' });

      // An offer ahead of B is still a live place in the queue.
      expect((await accountList(b)).body.entries[0]).toMatchObject({ id: eb, aheadCount: 1 });
      expect((await accountList(a)).body.entries[0]).toMatchObject({
        id: ea, status: 'OFFERED', aheadCount: null, offerExpiresAt: offered.offerExpiresAt!.toISOString(),
      });

      const provider = await providerList(bookingId);
      expect(provider.status).toBe(200);
      expect(provider.body).toMatchObject({ placesFree: 0, canManage: true });
      expect(provider.body.entries).toEqual([
        expect.objectContaining({ id: ea, status: 'OFFERED', position: null, studentName: 'Waiter A' }),
        expect.objectContaining({ id: eb, status: 'WAITING', position: 1, studentName: 'Waiter B' }),
      ]);
    });

    it('stops an offer at the notice period and closes the queue when too little time is left', async () => {
      const { bookingId, first, second } = await fullClass();
      const a = await person('Waiter A');
      const b = await person('Waiter B');
      const ea = await queued(a);
      const eb = await queued(b);
      const startAt = f.starts.toJSDate();
      const offerAt = async (now: Date) => prisma.$transaction(async tx => {
        await lockInstructors(tx, [f.instructor.id]);
        await offerWaitlistPlaces(tx, bookingId, { now });
      });

      // Free places directly so only the explicit clock below makes offers.
      await prisma.participant.update({ where: { id: first.participantId }, data: { cancelledAt: new Date() } });
      await offerAt(new Date(startAt.getTime() - 5 * 3_600_000));
      // With no notice period, bookings close at the start: the deadline is
      // the start, not twelve hours later.
      expect((await entry(ea))).toMatchObject({ status: 'OFFERED', offerExpiresAt: startAt });

      await prisma.participant.update({ where: { id: second.participantId }, data: { cancelledAt: new Date() } });
      await offerAt(new Date(startAt.getTime() - 5 * 60_000));
      expect((await entry(eb))).toMatchObject({
        status: 'CLOSED', closedReason: 'There is not enough time left to offer a place before bookings close.',
      });
      expect((await entry(ea)).status).toBe('OFFERED');
      expect(await alerts(b.id, 'WAITLIST_CLOSED')).toHaveLength(1);
    });
  });

  describe('student decisions', () => {
    it('accepts through the normal booking path, spending a package credit', async () => {
      const { bookingId, first } = await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      await cancelPlace(first);
      const student = await studentOf(a.id);
      const pkg = await createPackage(f, student.id);

      const accepted = await accept(a, ea, { packageId: pkg.id });
      expect(accepted.status).toBe(200);
      expect(accepted.body.entry).toMatchObject({ id: ea, status: 'ACCEPTED', aheadCount: null });
      expect(accepted.body.bookings).toHaveLength(1);
      expect(accepted.body.bookings[0]).toMatchObject({ id: bookingId, paymentRoute: 'CLUB', type: 'GROUP' });
      // Other students in the group stay private.
      expect(accepted.body.bookings[0].participants).toEqual([
        expect.objectContaining({ studentId: student.id, packageId: pkg.id }),
      ]);
      expect(await prisma.participant.findFirstOrThrow({ where: { bookingId, studentId: student.id } }))
        .toMatchObject({ packageId: pkg.id, creditConsumed: true, cancelledAt: null, paid: true });
      expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).usedCredits).toBe(1);
      expect((await entry(ea)).respondedAt).not.toBeNull();
      expect(await metric('WAITLIST_ACCEPTED')).toBe(1);
      expect(await prisma.notification.findFirst({
        where: { bookingId, type: 'BOOKING', title: 'Waitlist place taken · Waiter A' },
      })).not.toBeNull();
      expect(await alerts(a.id, 'BOOKING_CREATED')).toHaveLength(1);

      const repeated = await accept(a, ea);
      expect(repeated.status).toBe(409);
      expect((await prisma.lessonPackage.findUniqueOrThrow({ where: { id: pkg.id } })).usedCredits).toBe(1);
    });

    it('keeps the offer open when the chosen package cannot be used', async () => {
      const { first } = await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      await cancelPlace(first);
      const pkg = await createPackage(f, (await studentOf(a.id)).id, { totalCredits: 1, usedCredits: 1 });
      const refused = await accept(a, ea, { packageId: pkg.id });
      expect(refused.status).toBe(409);
      expect((await entry(ea)).status).toBe('OFFERED');
      expect((await accept(a, ea)).status).toBe(200);
    });

    it('refuses an expired offer, records it as EXPIRED and offers the next student', async () => {
      const { first } = await fullClass();
      const a = await person('Waiter A');
      const b = await person('Waiter B');
      const ea = await queued(a);
      const eb = await queued(b);
      await cancelPlace(first);
      await prisma.waitlistEntry.update({ where: { id: ea }, data: { offerExpiresAt: new Date(Date.now() - 60_000) } });

      const late = await accept(a, ea);
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('WAITLIST_OFFER_EXPIRED');
      expect((await entry(ea)).status).toBe('EXPIRED');
      expect((await entry(eb)).status).toBe('OFFERED');
      expect(await alerts(b.id, 'WAITLIST_OFFERED')).toHaveLength(1);
      expect(await prisma.participant.count({ where: { student: { userId: a.id }, cancelledAt: null } })).toBe(0);
    });

    it('passes the place on when an offer is declined or abandoned, but not when a waiter leaves', async () => {
      const { bookingId, first } = await fullClass();
      const a = await person('Waiter A');
      const b = await person('Waiter B');
      const c = await person('Waiter C');
      const ea = await queued(a);
      const eb = await queued(b);
      const ec = await queued(c);
      await cancelPlace(first);
      expect((await entry(ea)).status).toBe('OFFERED');

      const declined = await decline(a, ea);
      expect(declined.status).toBe(200);
      expect(declined.body.entry).toMatchObject({ id: ea, status: 'DECLINED' });
      expect((await entry(eb)).status).toBe('OFFERED');
      expect((await decline(a, ea)).status).toBe(200);
      expect((await leave(a, ea)).status).toBe(409);

      const left = await leave(c, ec);
      expect(left.status).toBe(200);
      expect(left.body.entry).toMatchObject({ id: ec, status: 'WITHDRAWN' });
      expect((await entry(eb)).status).toBe('OFFERED');
      expect((await decline(c, ec)).status).toBe(409);

      expect((await leave(b, eb)).body.entry.status).toBe('WITHDRAWN');
      // Nobody is left waiting, so the place returns to public booking.
      expect((await providerList(bookingId)).body.placesFree).toBe(1);
      expect((await publicBooking(await person('Walk In'))).status).toBe(201);
    });

    it('ends a queue place when the student takes a free place directly', async () => {
      const { bookingId, first, second } = await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      await cancelPlace(first);
      expect((await entry(ea)).status).toBe('OFFERED');
      // A second place frees without running the automatic offer.
      await prisma.participant.update({ where: { id: second.participantId }, data: { cancelledAt: new Date() } });
      expect((await publicBooking(a)).status).toBe(201);
      expect(await entry(ea)).toMatchObject({ status: 'CLOSED', closedReason: 'You already have a place in this Class.' });
      expect((await providerList(bookingId)).body.placesFree).toBe(1);
    });
  });

  describe('the club side', () => {
    it('offers a free place out of order and removes a student', async () => {
      const { bookingId, first } = await fullClass();
      const a = await person('Waiter A');
      const b = await person('Waiter B');
      const ea = await queued(a);
      const eb = await queued(b);

      const none = await request(app).post(`/api/waitlist/${eb}/offer`).set('Cookie', f.cookie).send({});
      expect(none.status).toBe(409);

      await prisma.participant.update({ where: { id: first.participantId }, data: { cancelledAt: new Date() } });
      const manual = await request(app).post(`/api/waitlist/${eb}/offer`).set('Cookie', f.cookie).send({});
      expect(manual.status).toBe(200);
      expect(manual.body.entry).toMatchObject({ id: eb, status: 'OFFERED', position: null, studentName: 'Waiter B' });
      expect((await entry(ea)).status).toBe('WAITING');
      expect(await alerts(b.id, 'WAITLIST_OFFERED')).toHaveLength(1);
      expect((await request(app).post(`/api/waitlist/${ea}/offer`).set('Cookie', f.cookie).send({})).status).toBe(409);
      expect((await request(app).post(`/api/waitlist/${eb}/offer`).set('Cookie', f.cookie).send({})).status).toBe(409);

      const removed = await request(app).delete(`/api/waitlist/${ea}`).set('Cookie', f.cookie);
      expect(removed.status).toBe(200);
      expect(removed.body.entry).toMatchObject({ id: ea, status: 'REMOVED', position: null });
      expect(await alerts(a.id, 'WAITLIST_CLOSED')).toHaveLength(1);
      expect((await request(app).delete(`/api/waitlist/${ea}`).set('Cookie', f.cookie)).status).toBe(200);

      const list = await providerList(bookingId);
      expect(list.body.entries.map((row: { status: string }) => row.status)).toEqual(['REMOVED', 'OFFERED']);
    });

    it('keeps a coach to their own Classes', async () => {
      const { bookingId } = await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);

      const own = await providerList(bookingId, f.coachCookie);
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ canManage: true, entries: [expect.objectContaining({ id: ea, position: 1 })] });

      const otherInstructor = await prisma.instructor.create({
        data: { businessId: f.business.id, name: 'Other Coach', initials: 'OC' },
      });
      const otherBooking = await prisma.booking.create({
        data: {
          businessId: f.business.id, serviceId: f.service.id, instructorId: otherInstructor.id,
          locationId: f.location.id, startAt: f.starts.plus({ hours: 3 }).toJSDate(),
          endAt: f.starts.plus({ hours: 4 }).toJSDate(), duration: 60, bufferMinutes: 0, status: 'CONFIRMED',
          type: 'GROUP', capacity: 1, price: 8000, paymentRoute: 'CLUB', coachAcceptance: 'NOT_REQUIRED',
          createdByRole: 'CLUB',
        },
      });
      const otherEntry = await prisma.waitlistEntry.create({
        data: { businessId: f.business.id, bookingId: otherBooking.id, studentId: (await studentOf(a.id)).id },
      });
      expect((await providerList(otherBooking.id, f.coachCookie)).status).toBe(403);
      expect((await request(app).post(`/api/waitlist/${otherEntry.id}/offer`).set('Cookie', f.coachCookie).send({})).status).toBe(403);
      expect((await request(app).delete(`/api/waitlist/${otherEntry.id}`).set('Cookie', f.coachCookie)).status).toBe(403);
      expect((await entry(otherEntry.id)).status).toBe('WAITING');
    });

    it('isolates tenants and students', async () => {
      const { bookingId } = await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      const other = await tenants.fixture();

      expect((await providerList(bookingId, other.cookie)).status).toBe(404);
      expect((await request(app).post(`/api/waitlist/${ea}/offer`).set('Cookie', other.cookie).send({})).status).toBe(404);
      expect((await request(app).delete(`/api/waitlist/${ea}`).set('Cookie', other.cookie)).status).toBe(404);

      const stranger = await person('Stranger');
      expect((await accept(stranger, ea)).status).toBe(404);
      expect((await decline(stranger, ea)).status).toBe(404);
      expect((await leave(stranger, ea)).status).toBe(404);
      expect((await accountList(stranger)).body.entries).toEqual([]);
      expect((await entry(ea)).status).toBe('WAITING');
    });
  });

  describe('closing', () => {
    it('closes the queue with an alert when the Class is cancelled', async () => {
      const { bookingId, first } = await fullClass();
      const a = await person('Waiter A');
      const b = await person('Waiter B');
      const ea = await queued(a);
      const eb = await queued(b);
      await cancelPlace(first);

      const cancelled = await request(app).patch(`/api/bookings/${bookingId}`)
        .set('Cookie', f.cookie).send({ status: 'CANCELLED' });
      expect(cancelled.status).toBe(200);
      for (const id of [ea, eb]) {
        expect(await entry(id)).toMatchObject({ status: 'CLOSED', closedReason: 'The Class was cancelled.' });
      }
      expect(await alerts(a.id, 'WAITLIST_CLOSED')).toHaveLength(1);
      expect(await alerts(b.id, 'WAITLIST_CLOSED')).toHaveLength(1);
      expect((await accountList(a)).body.entries[0]).toMatchObject({
        id: ea, status: 'CLOSED', closedReason: 'The Class was cancelled.', aheadCount: null,
      });
      expect((await accept(a, ea)).status).toBe(409);
    });

    it('closes queues inside the notice period through a tenant-scoped sweep', async () => {
      await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      const other = await tenants.fixture();
      await prisma.service.update({ where: { id: other.service.id }, data: { type: 'GROUP', capacity: 2 } });
      await fullClass(other);
      const c = await person('Other Waiter', other);
      const ec = await queued(c, other);
      await prisma.service.updateMany({
        where: { id: { in: [f.service.id, other.service.id] } }, data: { noticeHours: 24 * 30 },
      });

      expect(await sweepWaitlists({ businessIds: [f.business.id] })).toBe(1);
      expect(await entry(ea)).toMatchObject({
        status: 'CLOSED', closedReason: 'The Class is now inside its booking notice period.',
      });
      expect(await alerts(a.id, 'WAITLIST_CLOSED')).toHaveLength(1);
      // Another tenant's queue is untouched by a scoped sweep.
      expect((await entry(ec)).status).toBe('WAITING');

      expect(await sweepWaitlists({ businessIds: [other.business.id] })).toBe(1);
      expect((await entry(ec)).status).toBe('CLOSED');
      // Nothing left to do: a closed queue is not selected again.
      expect(await sweepWaitlists({ businessIds: [f.business.id, other.business.id] })).toBe(0);
      expect((await join(await person('Late Waiter'))).status).toBe(409);
    });

    it('expires stale offers and offers the next student in a sweep', async () => {
      const { first } = await fullClass();
      const a = await person('Waiter A');
      const b = await person('Waiter B');
      const ea = await queued(a);
      const eb = await queued(b);
      await cancelPlace(first);
      // A fresh offer is left alone.
      expect(await sweepWaitlists({ businessIds: [f.business.id] })).toBe(0);

      await prisma.waitlistEntry.update({ where: { id: ea }, data: { offerExpiresAt: new Date(Date.now() - 1_000) } });
      expect(await sweepWaitlists({ businessIds: [f.business.id] })).toBe(1);
      expect((await entry(ea)).status).toBe('EXPIRED');
      expect((await entry(eb)).status).toBe('OFFERED');
      expect(await alerts(b.id, 'WAITLIST_OFFERED')).toHaveLength(1);
    });
  });

  describe('concurrency and database invariants', () => {
    it('admits exactly one of several concurrent accepts of the same offer', async () => {
      const { bookingId, first } = await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      await cancelPlace(first);

      const results = await Promise.all(Array.from({ length: 5 }, () => accept(a, ea)));
      expect(results.filter(result => result.status === 200)).toHaveLength(1);
      expect(results.filter(result => result.status === 409)).toHaveLength(4);
      expect(await prisma.participant.count({ where: { bookingId, cancelledAt: null } })).toBe(2);
      expect(await metric('WAITLIST_ACCEPTED')).toBe(1);
    }, 30_000);

    it('lets a held offer win against a concurrent public booking', async () => {
      const { bookingId, first } = await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      await cancelPlace(first);
      const walkIn = await person('Walk In');

      const [accepted, walkedIn] = await Promise.all([accept(a, ea), publicBooking(walkIn)]);
      expect(accepted.status).toBe(200);
      expect(walkedIn.status).toBe(409);
      expect(await prisma.participant.count({ where: { bookingId, cancelledAt: null } })).toBe(2);
    }, 30_000);

    it('never reopens a terminal entry and keeps one live entry per student and Class', async () => {
      const { bookingId } = await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      const studentId = (await studentOf(a.id)).id;

      await expect(prisma.waitlistEntry.create({ data: { businessId: f.business.id, bookingId, studentId } }))
        .rejects.toMatchObject({ code: 'P2002' });

      expect((await leave(a, ea)).status).toBe(200);
      await expect(prisma.waitlistEntry.update({ where: { id: ea }, data: { status: 'WAITING' } }))
        .rejects.toThrow(/cannot reopen/);
      await expect(prisma.waitlistEntry.update({ where: { id: ea }, data: { status: 'OFFERED', offeredAt: new Date(), offerExpiresAt: new Date() } }))
        .rejects.toThrow(/cannot reopen/);

      // A terminal row frees the slot in the partial unique index for a new request.
      const rejoined = await join(a);
      expect(rejoined.status).toBe(201);
      expect(rejoined.body.entry.id).not.toBe(ea);
      expect((await entry(ea)).status).toBe('WITHDRAWN');
    });

    it('lists live entries and only recently closed ones', async () => {
      await fullClass();
      const a = await person('Waiter A');
      const ea = await queued(a);
      expect((await leave(a, ea)).status).toBe(200);
      expect((await accountList(a)).body.entries.map((row: { id: string }) => row.id)).toEqual([ea]);

      await prisma.waitlistEntry.update({
        where: { id: ea }, data: { updatedAt: new Date(Date.now() - 15 * 86_400_000) },
      });
      expect((await accountList(a)).body.entries).toEqual([]);
    });
  });
});
