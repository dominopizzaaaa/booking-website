import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { config } from '../src/config.js';
import { createStudent, prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

type GroupWire = {
  id: string; name: string; capacity: number | null; active: boolean; createdAt: string; updatedAt: string;
  serviceId: string | null; locationId: string | null; instructorId: string | null;
  members: Array<{ studentId: string; name: string; initials: string; joinedAt: string }>;
};

describe.sequential('club training groups', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  async function staffCookie(permissions: string[]) {
    const suffix = randomUUID().replaceAll('-', '');
    const user = await prisma.user.create({ data: {
      name: 'Desk Staff', legalName: 'Desk Staff', username: `desk_${suffix.slice(0, 18)}`, email: `desk-${suffix}@example.test`,
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

  const create = (body: Record<string, unknown>, cookie = club.cookie) =>
    request(app).post('/api/training-groups').set('Cookie', cookie).send(body);
  const setMembers = (groupId: string, studentIds: string[], cookie = club.cookie) =>
    request(app).put(`/api/training-groups/${groupId}/members`).set('Cookie', cookie).send({ studentIds });
  const list = (cookie = club.cookie, query: Record<string, string> = {}) =>
    request(app).get('/api/training-groups').set('Cookie', cookie).query(query);

  it('creates a club-local group with validated scheduling defaults', async () => {
    const created = await create({
      name: ' Junior squad ', sport: 'Tennis', level: 'Beginner', ageBand: '8–12', description: 'Saturday cohort',
      scheduleNote: 'Saturdays 9am', capacity: 6, serviceId: club.service.id, locationId: club.location.id,
      instructorId: club.instructor.id,
    }).expect(201);
    expect(created.body).toEqual({
      id: expect.any(String), name: 'Junior squad', sport: 'Tennis', level: 'Beginner', ageBand: '8–12',
      description: 'Saturday cohort', scheduleNote: 'Saturdays 9am', capacity: 6, serviceId: club.service.id,
      locationId: club.location.id, instructorId: club.instructor.id, active: true,
      createdAt: expect.any(String), updatedAt: expect.any(String), members: [],
    });
    const minimal = await create({ name: 'Adults' }).expect(201);
    expect(minimal.body).toMatchObject({
      sport: '', level: '', ageBand: '', description: '', scheduleNote: '', capacity: null,
      serviceId: null, locationId: null, instructorId: null,
    });

    const other = await tenants.fixture();
    const archivedService = await prisma.service.create({ data: { businessId: club.business.id, name: 'Old Class', active: false } });
    const unrostered = await prisma.instructor.create({ data: { businessId: club.business.id, name: 'Former Coach', initials: 'FC' } });
    for (const [body, error] of [
      [{ name: 'Bad', serviceId: other.service.id }, 'Choose an active Class from this club'],
      [{ name: 'Bad', serviceId: archivedService.id }, 'Choose an active Class from this club'],
      [{ name: 'Bad', locationId: other.location.id }, 'Choose an active venue from this club'],
      [{ name: 'Bad', instructorId: other.instructor.id }, 'Choose a bookable coach from this club'],
      [{ name: 'Bad', instructorId: unrostered.id }, 'Choose a bookable coach from this club'],
    ] as const) {
      expect((await create(body).expect(400)).body.error).toBe(error);
    }
    for (const body of [
      { name: '' }, { name: 'x'.repeat(81) }, { name: 'Bad', capacity: 0 }, { name: 'Bad', capacity: 501 },
      { name: 'Bad', capacity: 2.5 }, { name: 'Bad', scheduleNote: 'x'.repeat(121) }, { name: 'Bad', businessId: other.business.id },
      { sport: 'Tennis' },
    ]) {
      await create(body).expect(400);
    }
    expect(await prisma.trainingGroup.count({ where: { businessId: club.business.id } })).toBe(2);
  });

  it('keeps groups club-side: coaches are refused and staff need the named student permission', async () => {
    const group = (await create({ name: 'Squad' }).expect(201)).body as GroupWire;
    const coach = club.coachCookie;
    await list(coach).expect(403);
    await create({ name: 'Coach squad' }, coach).expect(403);
    await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', coach).send({ name: 'Mine' }).expect(403);
    await setMembers(group.id, [], coach).expect(403);
    await request(app).delete(`/api/training-groups/${group.id}`).set('Cookie', coach).expect(403);

    const viewer = await staffCookie(['STUDENTS_VIEW']);
    expect((await list(viewer).expect(200)).body.groups.map((item: GroupWire) => item.id)).toEqual([group.id]);
    await create({ name: 'Viewer squad' }, viewer).expect(403);
    await setMembers(group.id, [], viewer).expect(403);
    await list(await staffCookie(['BOOKINGS_VIEW'])).expect(403);

    const manager = await staffCookie(['STUDENTS_MANAGE']);
    await create({ name: 'Manager squad' }, manager).expect(201);
    await list(manager).expect(200);
  });

  it('replaces the active member set, reactivates returning members and enforces capacity and tenancy', async () => {
    const group = (await create({ name: 'Squad', capacity: 3 }).expect(201)).body as GroupWire;
    const [amelia, ben, chloe, dan] = await Promise.all(['Amelia Wong', 'Ben Tan', 'Chloe Lim', 'Dan Ong']
      .map(name => createStudent(club, { name })));

    const first = await setMembers(group.id, [ben!.id, amelia!.id, amelia!.id]).expect(200);
    expect(first.body.members.map((member: GroupWire['members'][number]) => [member.studentId, member.name, member.initials]))
      .toEqual([[amelia!.id, 'Amelia Wong', 'PC'], [ben!.id, 'Ben Tan', 'PC']]);
    const benRow = await prisma.trainingGroupMember.findUniqueOrThrow({ where: { groupId_studentId: { groupId: group.id, studentId: ben!.id } } });

    const second = await setMembers(group.id, [amelia!.id, chloe!.id]).expect(200);
    expect(second.body.members.map((member: GroupWire['members'][number]) => member.studentId)).toEqual([amelia!.id, chloe!.id]);
    expect(await prisma.trainingGroupMember.findUniqueOrThrow({ where: { id: benRow.id } }))
      .toMatchObject({ active: false, leftAt: expect.any(Date) });

    const third = await setMembers(group.id, [amelia!.id, chloe!.id, ben!.id]).expect(200);
    expect(third.body.members).toHaveLength(3);
    const returned = await prisma.trainingGroupMember.findUniqueOrThrow({ where: { id: benRow.id } });
    expect(returned).toMatchObject({ active: true, leftAt: null });
    expect(returned.joinedAt.getTime()).toBeGreaterThan(benRow.joinedAt.getTime());
    expect(await prisma.trainingGroupMember.count({ where: { groupId: group.id } })).toBe(3);

    expect((await setMembers(group.id, [amelia!.id, ben!.id, chloe!.id, dan!.id]).expect(409)).body.error)
      .toBe('This group has room for 3 members');
    const other = await tenants.fixture();
    const outsider = await createStudent(other, { name: 'Outside Student' });
    expect((await setMembers(group.id, [amelia!.id, outsider.id]).expect(400)).body.error)
      .toBe('Every member must be a student of this club');
    await setMembers(group.id, [`missing-${randomUUID()}`]).expect(400);
    await setMembers(group.id, Array.from({ length: 201 }, () => randomUUID())).expect(400);
    await request(app).put(`/api/training-groups/${group.id}/members`).set('Cookie', club.cookie)
      .send({ studentIds: [], extra: true }).expect(400);
    expect((await list().expect(200)).body.groups[0].members).toHaveLength(3);

    // Lowering capacity below the active roster is refused.
    expect((await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', club.cookie)
      .send({ capacity: 2 }).expect(409)).body.error).toContain('already has 3 members');
    const cleared = await setMembers(group.id, []).expect(200);
    expect(cleared.body.members).toEqual([]);
    expect(await prisma.trainingGroupMember.count({ where: { groupId: group.id, active: true } })).toBe(0);
  });

  it('edits, archives and restores only the selected club’s groups', async () => {
    const group = (await create({ name: 'Squad', serviceId: club.service.id }).expect(201)).body as GroupWire;
    const patched = await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', club.cookie)
      .send({ name: 'Weekend squad', capacity: null, level: 'Intermediate', serviceId: null }).expect(200);
    expect(patched.body).toMatchObject({ id: group.id, name: 'Weekend squad', capacity: null, level: 'Intermediate', serviceId: null });
    await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', club.cookie).send({}).expect(400);
    await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', club.cookie).send({ unknown: 1 }).expect(400);

    // A default archived after it was chosen is kept when the client resends it.
    const service = await prisma.service.create({ data: {
      businessId: club.business.id, name: 'Squad Class', type: 'GROUP', capacity: 8,
    } });
    await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', club.cookie).send({ serviceId: service.id }).expect(200);
    await prisma.service.update({ where: { id: service.id }, data: { active: false } });
    await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', club.cookie)
      .send({ serviceId: service.id, description: 'Same defaults' }).expect(200);

    const other = await tenants.fixture();
    await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', other.cookie).send({ name: 'Stolen' }).expect(404);
    await setMembers(group.id, [], other.cookie).expect(404);
    await request(app).delete(`/api/training-groups/${group.id}`).set('Cookie', other.cookie).expect(404);
    expect((await list(other.cookie).expect(200)).body.groups).toEqual([]);

    const member = await createStudent(club, { name: 'Kept Member' });
    await setMembers(group.id, [member.id]).expect(200);
    const archived = await request(app).delete(`/api/training-groups/${group.id}`).set('Cookie', club.cookie).expect(200);
    expect(archived.body).toMatchObject({ id: group.id, active: false, members: [{ studentId: member.id, name: 'Kept Member' }] });
    expect((await list().expect(200)).body.groups).toEqual([]);
    expect((await list(club.cookie, { includeArchived: 'true' }).expect(200)).body.groups.map((item: GroupWire) => [item.id, item.active]))
      .toEqual([[group.id, false]]);
    await list(club.cookie, { includeArchived: 'yes' }).expect(400);
    expect((await setMembers(group.id, []).expect(409)).body.error).toBe('Restore this training group before changing its members');

    const restored = await request(app).patch(`/api/training-groups/${group.id}`).set('Cookie', club.cookie)
      .send({ active: true }).expect(200);
    expect(restored.body).toMatchObject({ active: true, members: [{ studentId: member.id }] });
    expect((await list().expect(200)).body.groups.map((item: GroupWire) => item.id)).toEqual([group.id]);
  });
});
