import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import {
  createAccount, createSession, createStudent, prisma, publicInputFor, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Public API security regressions', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function accountSession(overrides: Parameters<typeof createAccount>[1] = {}) {
    const account = await createAccount(f, overrides);
    const session = await createSession(f, account.id);
    return { account, ...session };
  }

  async function attachLegacyToken(participantId: string, overrides: { expiresAt?: Date; revokedAt?: Date } = {}) {
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    await prisma.participant.update({
      where: { id: participantId },
      data: {
        managementTokenHash: hash,
        managementTokenExpiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
        managementTokenRevokedAt: overrides.revokedAt ?? null,
      },
    });
    return { token, hash };
  }

  async function attachMigratedLegacyToken(participantId: string) {
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('md5').update(`${token}${participantId}`).digest('hex');
    await prisma.participant.update({
      where: { id: participantId },
      data: {
        managementTokenHash: hash,
        managementTokenExpiresAt: new Date(Date.now() + 7 * 86_400_000),
        managementTokenRevokedAt: null,
      },
    });
    return { token, hash };
  }

  it('redacts tenant identifiers, instructor email and internal location notes from the public catalog', async () => {
    const privateInstructorEmail = `coach-private-${randomUUID()}@example.test`;
    const privateLocationNotes = `staff-only access code ${randomUUID()}`;
    await prisma.instructor.update({
      where: { id: f.instructor.id },
      data: { email: privateInstructorEmail },
    });
    await prisma.location.update({
      where: { id: f.location.id },
      data: { notes: privateLocationNotes },
    });

    const response = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    const instructor = response.body.instructors.find((item: { id: string }) => item.id === f.instructor.id);
    const location = response.body.locations.find((item: { id: string }) => item.id === f.location.id);
    const service = response.body.services.find((item: { id: string }) => item.id === f.service.id);

    expect(instructor).toMatchObject({ id: f.instructor.id, name: f.instructor.name });
    expect(instructor).not.toHaveProperty('email');
    expect(instructor).not.toHaveProperty('businessId');
    expect(location).toMatchObject({ id: f.location.id, name: f.location.name });
    expect(location).not.toHaveProperty('notes');
    expect(location).not.toHaveProperty('businessId');
    expect(service).not.toHaveProperty('businessId');
    expect(JSON.stringify(response.body)).not.toContain('\"businessId\"');
    expect(response.body.business).not.toHaveProperty('id');
    expect(response.body.business).not.toHaveProperty('email');
    expect(response.body.business).not.toHaveProperty('isDemo');
    expect(JSON.stringify(response.body)).not.toContain(privateInstructorEmail);
    expect(JSON.stringify(response.body)).not.toContain(privateLocationNotes);
  });

  it('returns only locations referenced by a filtered bookable service', async () => {
    const unusedLocation = await prisma.location.create({
      data: { businessId: f.business.id, name: 'Private operations office', active: true },
    });
    const unavailableLocation = await prisma.location.create({
      data: { businessId: f.business.id, name: 'Unavailable roster court', active: true },
    });
    const unclaimedInstructor = await prisma.instructor.create({
      data: { businessId: f.business.id, name: 'Unclaimed Coach', initials: 'UC', active: true },
    });
    const unclaimedUser = await prisma.user.create({
      data: {
        name: 'Unclaimed Coach', username: `unclaimed_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        email: `${randomUUID()}@unclaimed.courtly.invalid`, accountType: 'COACH',
      },
    });
    f.tracker.ownUser(unclaimedUser.id);
    await prisma.membership.create({
      data: { userId: unclaimedUser.id, businessId: f.business.id, instructorId: unclaimedInstructor.id },
    });
    await prisma.service.create({
      data: {
        businessId: f.business.id, name: 'Unavailable service', active: true,
        locations: { create: {
          locationId: unavailableLocation.id, price: 9000, duration: 60,
          instructors: { create: { instructorId: unclaimedInstructor.id } },
        } },
      },
    });

    const response = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(response.body.locations.map((location: { id: string }) => location.id)).toEqual([f.location.id]);
    expect(JSON.stringify(response.body)).not.toContain(unusedLocation.id);
    expect(JSON.stringify(response.body)).not.toContain(unavailableLocation.id);
  });

  it('hides active unclaimed instructors and rejects their slots and account bookings', async () => {
    // Model a migrated roster entry: both instructor and membership remain active,
    // but the coach's account behind it has never been claimed with a password.
    await prisma.user.update({ where: { id: f.coachUser.id }, data: { passwordHash: null } });
    const { cookie } = await accountSession({ name: 'Registered Player' });

    const catalog = await request(app).get(`/api/public/${f.business.slug}`).expect(200);
    expect(catalog.body.instructors.map((instructor: { id: string }) => instructor.id)).not.toContain(f.instructor.id);
    for (const service of catalog.body.services as { locations: { instructorIds: string[] }[] }[]) {
      for (const location of service.locations) expect(location.instructorIds).not.toContain(f.instructor.id);
    }

    await request(app).get(`/api/public/${f.business.slug}/slots`).query({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      date: f.starts.toISODate(),
    }).expect(404);
    await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', cookie).send(publicInputFor(f)).expect(404);

    expect(await prisma.booking.count({ where: { businessId: f.business.id } })).toBe(0);
    expect(await prisma.student.count({ where: { businessId: f.business.id } })).toBe(0);
  });

  it('requires an authenticated account to book and stores no management credential', async () => {
    const input = publicInputFor(f, { notes: 'Private account note' });
    await request(app).post(`/api/public/${f.business.slug}/bookings`).send(input).expect(401);

    const { account, cookie } = await accountSession({
      name: 'Account Player', email: `${randomUUID()}@example.test`,
    });
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', cookie).send(input).expect(201);
    const participant = created.body.bookings[0].participants[0];

    expect(created.body).not.toHaveProperty('managementToken');
    expect(JSON.stringify(created.body)).not.toContain('managementToken');
    expect(participant).toMatchObject({ email: account.email, notes: 'Private account note' });
    const persisted = await prisma.participant.findUniqueOrThrow({ where: { id: participant.id } });
    expect(persisted).toMatchObject({
      managementTokenHash: null, managementTokenExpiresAt: null, managementTokenRevokedAt: null,
    });
  });

  it('saves booking contact edits to the account and every linked student profile atomically', async () => {
    const otherClub = await tenants.fixture();
    const { account, cookie } = await accountSession({
      name: 'Canonical Player', phone: '+65 6000 0000', parentName: 'Original Guardian',
    });
    const bookingProfile = await createStudent(f, {
      userId: account.id, name: account.name, email: account.email,
      phone: account.phone, parentName: account.parentName,
    });
    const otherClubProfile = await createStudent(otherClub, {
      userId: account.id, name: account.name, email: account.email,
      phone: account.phone, parentName: account.parentName,
    });
    const unrelatedAccount = await createAccount(otherClub, {
      name: 'Unrelated Player', phone: '+65 6111 1111', parentName: 'Unrelated Guardian',
    });
    const unrelatedProfile = await createStudent(otherClub, {
      userId: unrelatedAccount.id, name: unrelatedAccount.name, email: unrelatedAccount.email,
      phone: unrelatedAccount.phone, parentName: unrelatedAccount.parentName,
    });

    await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', cookie).send(publicInputFor(f, {
        student: { phone: '+65 6999 9999', parentName: '' },
      })).expect(201);

    expect(await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
      phone: '+65 6999 9999', parentName: '',
    });
    for (const profileId of [bookingProfile.id, otherClubProfile.id]) {
      expect(await prisma.student.findUniqueOrThrow({ where: { id: profileId } })).toMatchObject({
        phone: '+65 6999 9999', parentName: '',
      });
    }
    expect(await prisma.student.findUniqueOrThrow({ where: { id: unrelatedProfile.id } })).toMatchObject({
      phone: '+65 6111 1111', parentName: 'Unrelated Guardian',
    });

    await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', cookie).send(publicInputFor(f, {
        student: { phone: '+65 6888 8888', parentName: 'Must Roll Back' },
      })).expect(409);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
      phone: '+65 6999 9999', parentName: '',
    });
    expect(await prisma.student.findUniqueOrThrow({ where: { id: otherClubProfile.id } })).toMatchObject({
      phone: '+65 6999 9999', parentName: '',
    });
  });

  it('exposes only the signed-in participant in group receipts and account history', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 3 } });
    const first = await accountSession({ name: 'First Player', email: `first-${randomUUID()}@example.test` });
    const second = await accountSession({ name: 'Second Player', email: `second-${randomUUID()}@example.test` });
    const firstNote = `first private note ${randomUUID()}`;
    const secondNote = `second private note ${randomUUID()}`;

    const firstCreated = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', first.cookie).send(publicInputFor(f, { notes: firstNote })).expect(201);
    const secondCreated = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', second.cookie).send(publicInputFor(f, { notes: secondNote })).expect(201);

    expect(secondCreated.body.bookings[0].id).toBe(firstCreated.body.bookings[0].id);
    expect(firstCreated.body.bookings[0].participants).toEqual([
      expect.objectContaining({ email: first.account.email, notes: firstNote }),
    ]);
    expect(secondCreated.body.bookings[0].participants).toEqual([
      expect.objectContaining({ email: second.account.email, notes: secondNote }),
    ]);
    expect(JSON.stringify(firstCreated.body)).not.toContain(second.account.email);
    expect(JSON.stringify(firstCreated.body)).not.toContain(secondNote);
    expect(JSON.stringify(secondCreated.body)).not.toContain(first.account.email);
    expect(JSON.stringify(secondCreated.body)).not.toContain(firstNote);

    const firstHistory = await request(app).get('/api/account/bookings').set('Cookie', first.cookie).expect(200);
    const secondHistory = await request(app).get('/api/account/bookings').set('Cookie', second.cookie).expect(200);
    expect(firstHistory.body.bookings).toHaveLength(1);
    expect(secondHistory.body.bookings).toHaveLength(1);
    expect(firstHistory.body.bookings[0].booking.participants).toEqual([
      expect.objectContaining({ email: first.account.email, notes: firstNote }),
    ]);
    expect(secondHistory.body.bookings[0].booking.participants).toEqual([
      expect.objectContaining({ email: second.account.email, notes: secondNote }),
    ]);
    expect(JSON.stringify(firstHistory.body)).not.toContain(second.account.email);
    expect(JSON.stringify(firstHistory.body)).not.toContain(secondNote);
    expect(JSON.stringify(secondHistory.body)).not.toContain(first.account.email);
    expect(JSON.stringify(secondHistory.body)).not.toContain(firstNote);
  });

  it('upgrades a management link migrated from the original plaintext-token schema for an active club', async () => {
    const account = await accountSession({ name: 'Migrated Link Player' });
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', account.cookie).send(publicInputFor(f)).expect(201);
    const participantId = created.body.bookings[0].participants[0].id as string;
    const credential = await attachMigratedLegacyToken(participantId);

    const managed = await request(app).get(`/api/manage/${credential.token}`).expect(200);
    expect(managed.headers['cache-control']).toBe('no-store');
    expect(managed.body.participant).toMatchObject({ name: account.account.name, paid: false });
    expect(managed.body.booking).not.toHaveProperty('participants');
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participantId } })).toMatchObject({
      managementTokenHash: createHash('sha256').update(credential.token).digest('hex'),
    });
    await request(app).get(`/api/manage/${credential.token}`).expect(200);
    const serialized = JSON.stringify(managed.body);
    expect(serialized).not.toContain(credential.token);
    expect(serialized).not.toContain(credential.hash);
    expect(serialized).not.toContain('managementToken');
  });

  it('honors an existing legacy link for a group participant without exposing another participant or credential', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 3 } });
    const first = await accountSession({ name: 'Legacy Link Player', email: `legacy-${randomUUID()}@example.test` });
    const second = await accountSession({ name: 'Private Group Player', email: `private-${randomUUID()}@example.test` });
    const firstNote = `legacy participant note ${randomUUID()}`;
    const secondNote = `other participant note ${randomUUID()}`;
    const firstCreated = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', first.cookie).send(publicInputFor(f, { notes: firstNote })).expect(201);
    const secondCreated = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', second.cookie).send(publicInputFor(f, { notes: secondNote })).expect(201);
    const participantId = firstCreated.body.bookings[0].participants[0].id as string;
    const otherParticipantId = secondCreated.body.bookings[0].participants[0].id as string;
    const credential = await attachLegacyToken(participantId);

    const assertPrivateLegacyResponse = (body: unknown) => {
      const serialized = JSON.stringify(body);
      expect(serialized).toContain(first.account.name);
      expect(serialized).not.toContain(first.account.email);
      expect(serialized).not.toContain(firstNote);
      expect(serialized).not.toContain(second.account.email);
      expect(serialized).not.toContain(secondNote);
      expect(serialized).not.toContain(otherParticipantId);
      expect(serialized).not.toContain(credential.token);
      expect(serialized).not.toContain(credential.hash);
      expect(serialized).not.toContain('managementToken');
    };

    const managed = await request(app).get(`/api/manage/${credential.token}`).expect(200);
    expect(managed.body.booking).not.toHaveProperty('participants');
    expect(managed.body.participant).toMatchObject({ name: first.account.name });
    assertPrivateLegacyResponse(managed.body);

    const cancelled = await request(app).post(`/api/manage/${credential.token}/cancel`).send({}).expect(200);
    expect(cancelled.body.participant).toMatchObject({ name: first.account.name, cancelled: true });
    assertPrivateLegacyResponse(cancelled.body);
    expect(await prisma.participant.findUniqueOrThrow({ where: { id: otherParticipantId } })).toMatchObject({ cancelledAt: null });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: firstCreated.body.bookings[0].id } })).toMatchObject({ status: 'CONFIRMED' });
  });

  it('reschedules through a valid legacy link and rejects invalid, expired and revoked credentials', async () => {
    const validAccount = await accountSession({ name: 'Legacy Reschedule Player' });
    const validCreated = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', validAccount.cookie).send(publicInputFor(f)).expect(201);
    const validParticipantId = validCreated.body.bookings[0].participants[0].id as string;
    const validCredential = await attachLegacyToken(validParticipantId);
    const movedStart = f.starts.plus({ days: 1 }).toISO()!;

    const moved = await request(app).post(`/api/manage/${validCredential.token}/reschedule`)
      .send({ startAt: movedStart }).expect(200);
    expect(moved.body.booking).toMatchObject({
      id: validCreated.body.bookings[0].id, startAt: f.starts.plus({ days: 1 }).toJSDate().toISOString(),
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
    });
    const movedJson = JSON.stringify(moved.body);
    expect(movedJson).not.toContain(validCredential.token);
    expect(movedJson).not.toContain(validCredential.hash);
    expect(movedJson).not.toContain('managementToken');

    await request(app).get(`/api/manage/${randomBytes(32).toString('base64url')}`).expect(404);

    const expiredAccount = await accountSession({ name: 'Expired Link Player' });
    const expiredCreated = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', expiredAccount.cookie)
      .send(publicInputFor(f, { startAt: f.starts.plus({ days: 2 }).toISO()! })).expect(201);
    const expiredCredential = await attachLegacyToken(expiredCreated.body.bookings[0].participants[0].id, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const revokedAccount = await accountSession({ name: 'Revoked Link Player' });
    const revokedCreated = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', revokedAccount.cookie)
      .send(publicInputFor(f, { startAt: f.starts.plus({ days: 3 }).toISO()! })).expect(201);
    const revokedCredential = await attachLegacyToken(revokedCreated.body.bookings[0].participants[0].id, {
      revokedAt: new Date(),
    });

    for (const token of [expiredCredential.token, revokedCredential.token]) {
      await request(app).get(`/api/manage/${token}`).expect(410);
      await request(app).post(`/api/manage/${token}/cancel`).send({}).expect(410);
      await request(app).post(`/api/manage/${token}/reschedule`)
        .send({ startAt: f.starts.plus({ days: 4 }).toISO()! }).expect(410);
    }
  });

  it('denies another account access to history, cancellation and rescheduling', async () => {
    const owner = await accountSession({ name: 'Booking Owner' });
    const stranger = await accountSession({ name: 'Other Account' });
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', owner.cookie).send(publicInputFor(f)).expect(201);
    const participantId = created.body.bookings[0].participants[0].id as string;

    const strangerHistory = await request(app).get('/api/account/bookings')
      .set('Cookie', stranger.cookie).expect(200);
    expect(strangerHistory.body).toEqual({ bookings: [] });
    await request(app).post(`/api/account/bookings/${participantId}/cancel`)
      .set('Cookie', stranger.cookie).send({}).expect(404);
    await request(app).post(`/api/account/bookings/${participantId}/reschedule-requests`)
      .set('Cookie', stranger.cookie).send({ startAt: f.starts.plus({ days: 1 }).toISO()! }).expect(404);

    // A stranger must not be able to answer a proposal on someone else's
    // booking either, now that rescheduling is a two-sided negotiation.
    const proposal = await request(app).post(`/api/bookings/${created.body.bookings[0].id}/reschedule-requests`)
      .set('Cookie', f.cookie).send({ startAt: f.starts.plus({ days: 1 }).toISO()! }).expect(201);
    await request(app).post(`/api/account/reschedule-requests/${proposal.body.id}/accept`)
      .set('Cookie', stranger.cookie).send({}).expect(404);
    await request(app).post(`/api/account/reschedule-requests/${proposal.body.id}/decline`)
      .set('Cookie', stranger.cookie).send({}).expect(404);
    expect(await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: proposal.body.id } }))
      .toMatchObject({ status: 'PENDING' });

    expect(await prisma.participant.findUniqueOrThrow({ where: { id: participantId } })).toMatchObject({ cancelledAt: null });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: created.body.bookings[0].id } })).toMatchObject({
      startAt: f.starts.toJSDate(), status: 'CONFIRMED',
    });
  });

  it('accepts only startAt and a message when an account proposes a new time, and moves nothing until the provider accepts', async () => {
    const { cookie } = await accountSession();
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .set('Cookie', cookie).send(publicInputFor(f)).expect(201);
    const bookingId = created.body.bookings[0].id as string;
    const participantId = created.body.bookings[0].participants[0].id as string;
    const movedStart = f.starts.plus({ days: 1 }).toISO()!;
    const forbiddenFields = [
      ['instructorId', f.instructor.id],
      ['locationId', f.location.id],
      ['serviceId', f.service.id],
    ] as const;

    for (const [field, value] of forbiddenFields) {
      await request(app).post(`/api/account/bookings/${participantId}/reschedule-requests`)
        .set('Cookie', cookie).send({ startAt: movedStart, [field]: value }).expect(400);
    }
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.toJSDate(),
    });

    // Raising a request records the proposal and leaves the session alone.
    const requested = await request(app).post(`/api/account/bookings/${participantId}/reschedule-requests`)
      .set('Cookie', cookie).send({ startAt: movedStart }).expect(201);
    expect(requested.body.rescheduleRequest).toMatchObject({
      status: 'PENDING', requestedByRole: 'STUDENT', proposedStartAt: f.starts.plus({ days: 1 }).toUTC().toISO(),
    });
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }))
      .toMatchObject({ startAt: f.starts.toJSDate() });

    // The student cannot accept their own request; the provider side does.
    const requestId = requested.body.rescheduleRequest.id as string;
    await request(app).post(`/api/account/reschedule-requests/${requestId}/accept`)
      .set('Cookie', cookie).send({}).expect(403);
    const accepted = await request(app).post(`/api/reschedule-requests/${requestId}/accept`)
      .set('Cookie', f.cookie).send({}).expect(200);
    expect(accepted.body.booking).toMatchObject({
      id: bookingId, serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.plus({ days: 1 }).toJSDate().toISOString(),
    });
  });
});
