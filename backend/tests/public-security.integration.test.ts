import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { inputFor, prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function ownerCookie(f: Fixture) {
  const user = await prisma.user.create({
    data: {
      businessId: f.business.id,
      name: 'Security Test Owner',
      email: `${randomUUID()}@example.test`,
      passwordHash: 'not-used-by-this-test',
      role: 'OWNER',
      instructorId: f.instructor.id,
    },
  });
  const token = randomBytes(32).toString('base64url');
  await prisma.authSession.create({
    data: { id: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  return `${config.sessionCookie}=${token}`;
}

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
    expect(JSON.stringify(response.body)).not.toContain('"businessId"');
    expect(response.body.business).not.toHaveProperty('id');
    expect(response.body.business).not.toHaveProperty('email');
    expect(response.body.business).not.toHaveProperty('isDemo');
    expect(JSON.stringify(response.body)).not.toContain(privateInstructorEmail);
    expect(JSON.stringify(response.body)).not.toContain(privateLocationNotes);
  });

  it('keeps each group guest participant note private in booking receipts and management views', async () => {
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 3 } });
    const firstEmail = `first-${randomUUID()}@example.test`;
    const secondEmail = `second-${randomUUID()}@example.test`;
    const firstNote = `first participant private note ${randomUUID()}`;
    const secondNote = `second participant private note ${randomUUID()}`;

    const first = await request(app).post(`/api/public/${f.business.slug}/bookings`).send(inputFor(f, {
      customer: { name: 'First Guest', email: firstEmail },
      notes: firstNote,
    })).expect(201);
    const second = await request(app).post(`/api/public/${f.business.slug}/bookings`).send(inputFor(f, {
      customer: { name: 'Second Guest', email: secondEmail },
      notes: secondNote,
    })).expect(201);

    expect(second.body.bookings[0].id).toBe(first.body.bookings[0].id);
    expect(second.body.bookings[0].participants).toEqual([expect.objectContaining({
      email: secondEmail, notes: secondNote,
    })]);
    expect(second.body.bookings[0]).not.toHaveProperty('notes');
    expect(JSON.stringify(second.body)).not.toContain(firstEmail);
    expect(JSON.stringify(second.body)).not.toContain(firstNote);
    expect(JSON.stringify(second.body)).not.toContain(first.body.managementToken);
    const storedGroup = await prisma.booking.findUniqueOrThrow({
      where: { id: first.body.bookings[0].id },
      include: { participants: { include: { customer: true } } },
    });
    expect(storedGroup.notes).toBe('');
    expect(Object.fromEntries(storedGroup.participants.map(participant => [
      participant.customer.email, participant.notes,
    ]))).toEqual({ [firstEmail]: firstNote, [secondEmail]: secondNote });

    const firstManaged = await request(app).get(`/api/manage/${first.body.managementToken}`).expect(200);
    const secondManaged = await request(app).get(`/api/manage/${second.body.managementToken}`).expect(200);
    expect(firstManaged.body.booking.participants).toEqual([expect.objectContaining({
      email: firstEmail, notes: firstNote,
    })]);
    expect(firstManaged.body.booking).not.toHaveProperty('notes');
    expect(firstManaged.body.participant).toMatchObject({ email: firstEmail, notes: firstNote });
    expect(JSON.stringify(firstManaged.body)).not.toContain(secondEmail);
    expect(JSON.stringify(firstManaged.body)).not.toContain(secondNote);
    expect(secondManaged.body.booking.participants).toEqual([expect.objectContaining({
      email: secondEmail, notes: secondNote,
    })]);
    expect(secondManaged.body.booking).not.toHaveProperty('notes');
    expect(secondManaged.body.participant).toMatchObject({ email: secondEmail, notes: secondNote });
    expect(JSON.stringify(secondManaged.body)).not.toContain(firstEmail);
    expect(JSON.stringify(secondManaged.body)).not.toContain(firstNote);
  });

  it('returns a usable management token once while persisting and serializing only its digest', async () => {
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .send(inputFor(f))
      .expect(201);
    const token = created.body.managementToken as string;
    const booking = created.body.bookings[0];
    const participant = booking.participants[0];
    const digest = sha256(token);

    expect(token).toMatch(/^[\w-]{43}$/);
    expect(participant.managementToken).toBe(token);
    const persisted = await prisma.participant.findUniqueOrThrow({ where: { id: participant.id } });
    expect(persisted.managementTokenHash).toBe(digest);
    expect(persisted.managementTokenHash).not.toBe(token);
    expect(persisted.managementTokenExpiresAt.getTime()).toBe(
      new Date(booking.endAt).getTime() + 30 * 86_400_000,
    );
    expect(Object.prototype.hasOwnProperty.call(persisted, 'managementToken')).toBe(false);
    expect(JSON.stringify(persisted)).not.toContain(token);
    expect(await prisma.participant.findUnique({ where: { managementTokenHash: digest } })).toMatchObject({
      id: participant.id, bookingId: booking.id,
    });

    const columns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Participant'
    `;
    expect(columns.map(column => column.column_name)).toContain('managementTokenHash');
    expect(columns.map(column => column.column_name)).not.toContain('managementToken');

    const managed = await request(app).get(`/api/manage/${token}`).expect(200);
    expect(managed.headers['cache-control']).toContain('no-store');
    expect(managed.body.participant.id).toBe(participant.id);
    expect(JSON.stringify(managed.body)).not.toContain(token);
    expect(JSON.stringify(managed.body)).not.toContain(digest);
    await request(app).get(`/api/manage/${digest}`).expect(404);
    const mutated = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await request(app).get(`/api/manage/${mutated}`).expect(404);

    const workspace = await request(app).get('/api/workspace')
      .set('Cookie', await ownerCookie(f))
      .expect(200);
    const serializedWorkspace = JSON.stringify(workspace.body);
    expect(serializedWorkspace).not.toContain(token);
    expect(serializedWorkspace).not.toContain(digest);
    expect(serializedWorkspace).not.toContain('managementToken');
  });

  it('rejects expired and revoked management tokens for reads and mutations', async () => {
    const expired = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .send(inputFor(f))
      .expect(201);
    const revoked = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .send(inputFor(f, { startAt: f.starts.plus({ days: 1 }).toISO()! }))
      .expect(201);

    await prisma.participant.update({
      where: { managementTokenHash: sha256(expired.body.managementToken) },
      data: { managementTokenExpiresAt: new Date(Date.now() - 60_000) },
    });
    await prisma.participant.update({
      where: { managementTokenHash: sha256(revoked.body.managementToken) },
      data: { managementTokenRevokedAt: new Date() },
    });

    for (const token of [expired.body.managementToken, revoked.body.managementToken]) {
      const responses = [
        await request(app).get(`/api/manage/${token}`).expect(410),
        await request(app).post(`/api/manage/${token}/cancel`).send({}).expect(410),
        await request(app).post(`/api/manage/${token}/reschedule`)
          .send({ startAt: f.starts.plus({ days: 2 }).toISO()! })
          .expect(410),
      ];
      for (const response of responses) {
        expect(response.body).toEqual({
          error: 'This management link has expired. Please contact your coach.',
        });
      }
    }
    const bookings = await prisma.booking.findMany({ where: { businessId: f.business.id } });
    expect(bookings).toHaveLength(2);
    expect(bookings.every(booking => booking.status === 'CONFIRMED')).toBe(true);
  });

  it('allows startAt-only public and provider reschedules but rejects catalog identity fields', async () => {
    const created = await request(app).post(`/api/public/${f.business.slug}/bookings`)
      .send(inputFor(f))
      .expect(201);
    const bookingId = created.body.bookings[0].id as string;
    const token = created.body.managementToken as string;
    const alternateInstructor = await prisma.instructor.create({
      data: { businessId: f.business.id, name: 'Alternate Coach', initials: 'AC' },
    });
    const originalAssignment = await prisma.serviceLocation.findUniqueOrThrow({
      where: { serviceId_locationId: { serviceId: f.service.id, locationId: f.location.id } },
    });
    await prisma.serviceInstructor.create({
      data: { serviceLocationId: originalAssignment.id, instructorId: alternateInstructor.id },
    });
    await prisma.availability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: f.business.id, instructorId: alternateInstructor.id, locationId: f.location.id,
        dayOfWeek, startTime: '08:00', endTime: '20:00',
      })),
    });
    const alternateLocation = await prisma.location.create({
      data: { businessId: f.business.id, name: 'Alternate Court' },
    });
    await prisma.serviceLocation.create({
      data: {
        serviceId: f.service.id, locationId: alternateLocation.id, price: 8000, duration: 60,
        instructors: { create: { instructorId: f.instructor.id } },
      },
    });
    await prisma.availability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: f.business.id, instructorId: f.instructor.id, locationId: alternateLocation.id,
        dayOfWeek, startTime: '08:00', endTime: '20:00',
      })),
    });
    const alternateService = await prisma.service.create({
      data: {
        businessId: f.business.id, name: 'Alternate Service', type: 'PRIVATE', capacity: 1, noticeHours: 0,
        locations: { create: {
          locationId: f.location.id, price: 8000, duration: 60,
          instructors: { create: { instructorId: f.instructor.id } },
        } },
      },
    });
    const forbiddenFields = [
      ['instructorId', alternateInstructor.id],
      ['locationId', alternateLocation.id],
      ['serviceId', alternateService.id],
    ] as const;

    const publicStartAt = f.starts.plus({ days: 1 }).toISO()!;
    for (const [field, value] of forbiddenFields) {
      await request(app).post(`/api/manage/${token}/reschedule`)
        .send({ startAt: publicStartAt, [field]: value })
        .expect(400);
    }
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.toJSDate(),
    });
    const publicMove = await request(app).post(`/api/manage/${token}/reschedule`)
      .send({ startAt: publicStartAt })
      .expect(200);
    expect(publicMove.body.booking).toMatchObject({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.plus({ days: 1 }).toJSDate().toISOString(),
    });

    const cookie = await ownerCookie(f);
    const providerStartAt = f.starts.plus({ days: 2 }).toISO()!;
    for (const [field, value] of forbiddenFields) {
      await request(app).post(`/api/bookings/${bookingId}/reschedule`)
        .set('Cookie', cookie)
        .send({ startAt: providerStartAt, [field]: value })
        .expect(400);
    }
    expect(await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).toMatchObject({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.plus({ days: 1 }).toJSDate(),
    });
    const providerMove = await request(app).post(`/api/bookings/${bookingId}/reschedule`)
      .set('Cookie', cookie)
      .send({ startAt: providerStartAt })
      .expect(200);
    expect(providerMove.body).toMatchObject({
      serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
      startAt: f.starts.plus({ days: 2 }).toJSDate().toISOString(),
    });
  });
});
