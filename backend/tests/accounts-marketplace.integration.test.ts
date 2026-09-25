import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import {
  createAccount, createSession, prisma, TestTenants, verifyTestDatabase, type Fixture,
} from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('Marketplace account identities', () => {
  let tenants: TestTenants;
  let club: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    club = await tenants.fixture();
  });
  afterEach(async () => { await tenants.cleanup(); });

  const suffix = () => randomUUID().replace(/-/g, '').slice(0, 12);

  async function registerStudent(overrides: Record<string, unknown> = {}) {
    const identity = suffix();
    const response = await request(app).post('/api/auth/register').send({
      accountType: 'STUDENT',
      name: 'Marketplace Student',
      username: `student_${identity}`,
      email: `${identity}@example.test`,
      password: 'Courtly-marketplace-123',
      ...overrides,
    });
    if (response.body?.user?.id) tenants.ownUser(response.body.user.id);
    return response;
  }

  it('requires and canonicalizes a globally unique username and validates sports', async () => {
    const identity = suffix();
    const registered = await registerStudent({
      username: `  PLAYER_${identity}  `,
      sports: [' Tennis ', 'tennis', 'Padel'],
    });
    expect(registered.status).toBe(201);
    expect(registered.body.user).toMatchObject({
      username: `player_${identity}`,
      sports: ['Tennis', 'Padel'],
    });

    for (const username of ['ab', 'not-valid', 'a'.repeat(31)]) {
      const rejected = await registerStudent({ username });
      expect(rejected.status, username).toBe(400);
    }
    expect((await registerStudent({ username: `valid_${suffix()}`, sports: ['   '] })).status).toBe(400);
    expect((await registerStudent({ username: `valid_${suffix()}`, sports: ['x'.repeat(41)] })).status).toBe(400);

    const duplicate = await registerStudent({ username: `PLAYER_${identity}` });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain('email or username');
  });

  it('updates usernames and sports for people while limiting club account identity fields', async () => {
    const student = await createAccount(club, { accountType: 'STUDENT' });
    const studentSession = await createSession(club, student.id);
    const studentUsername = `student_profile_${suffix()}`;
    const studentUpdate = await request(app).patch('/api/auth/me')
      .set('Cookie', studentSession.cookie)
      .send({ username: studentUsername.toUpperCase(), sports: ['Padel', 'PADEL'] })
      .expect(200);
    expect(studentUpdate.body.user).toMatchObject({ username: studentUsername, sports: ['Padel'] });

    const coachUsername = `coach_profile_${suffix()}`;
    const coachUpdate = await request(app).patch('/api/auth/me')
      .set('Cookie', club.coachCookie)
      .send({
        name: 'Updated Coach', username: coachUsername.toUpperCase(),
        sports: [' Badminton ', 'badminton', 'Tennis'], phone: '+65 6000 0000',
      })
      .expect(200);
    expect(coachUpdate.body.user).toMatchObject({
      name: 'Updated Coach', username: coachUsername,
      sports: ['Badminton', 'Tennis'], phone: '+65 6000 0000',
    });
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: club.instructor.id } }))
      .toMatchObject({ name: 'Updated Coach', initials: 'UC' });

    const clubUsername = `club_profile_${suffix()}`;
    const clubUpdate = await request(app).patch('/api/auth/me')
      .set('Cookie', club.cookie)
      .send({ username: clubUsername.toUpperCase(), sports: ['Squash', 'squash'] })
      .expect(200);
    expect(clubUpdate.body.user).toMatchObject({ username: clubUsername, sports: ['Squash'] });
    await request(app).patch('/api/auth/me')
      .set('Cookie', club.cookie).send({ name: 'Not the business editor' }).expect(400);

    const collision = await request(app).patch('/api/auth/me')
      .set('Cookie', club.cookie).send({ username: coachUsername.toUpperCase() }).expect(409);
    expect(collision.body.error).toContain('email or username');
  });

  it('atomically updates the club and its account profile', async () => {
    const oldAccountEmail = club.user.email;
    const username = `atomic_club_${suffix()}`;
    const updated = await request(app).patch('/api/auth/club-profile')
      .set('Cookie', club.cookie)
      .send({
        name: 'Marketplace Racquets', ownerName: 'Alex Owner',
        email: ' BOOKINGS@MARKETPLACE.EXAMPLE ', tagline: 'Play together.', color: '#446655',
        cancellationHours: 36, username: username.toUpperCase(), sports: ['Tennis', 'tennis', 'Padel'],
      })
      .expect(200);
    expect(updated.body).toMatchObject({
      user: { name: 'Marketplace Racquets', username, email: oldAccountEmail, sports: ['Tennis', 'Padel'] },
      business: {
        name: 'Marketplace Racquets', ownerName: 'Alex Owner', email: 'bookings@marketplace.example',
        tagline: 'Play together.', color: '#446655', cancellationHours: 36, legacyReadOnly: false,
      },
    });
    const beforeConflict = await prisma.business.findUniqueOrThrow({ where: { id: club.business.id } });
    const conflict = await request(app).patch('/api/auth/club-profile')
      .set('Cookie', club.cookie)
      .send({
        name: 'Must Roll Back', ownerName: 'Changed Owner', email: 'changed@example.test',
        tagline: 'Changed', color: '#000000', cancellationHours: 1,
        username: club.coachUser.username, sports: ['Squash'],
      }).expect(409);
    expect(conflict.body.error).toContain('email or username');
    expect(await prisma.business.findUniqueOrThrow({ where: { id: club.business.id } }))
      .toMatchObject({
        name: beforeConflict.name, ownerName: beforeConflict.ownerName, email: beforeConflict.email,
        tagline: beforeConflict.tagline, color: beforeConflict.color, cancellationHours: beforeConflict.cancellationHours,
      });

    await request(app).patch('/api/auth/club-profile')
      .set('Cookie', club.coachCookie).send({
        name: 'No', ownerName: 'No', email: 'no@example.test', tagline: '', color: 'sage',
        cancellationHours: 24, username: `denied_${suffix()}`, sports: [],
      }).expect(403);
  });

  it('removes practice creation and hides or rejects retained legacy workspaces', async () => {
    const { solo, soloMembership } = await prisma.$transaction(async tx => {
      const createdBusiness = await tx.business.create({
        data: {
          name: 'Retained Solo Practice', slug: `retained-solo-${suffix()}`, ownerName: club.coachUser.name,
          email: club.coachUser.email, kind: 'SOLO', legacyReadOnly: true,
        },
      });
      const soloInstructor = await tx.instructor.create({
        data: {
          businessId: createdBusiness.id, name: club.coachUser.name, initials: 'TC',
          email: club.coachUser.email,
        },
      });
      const membership = await tx.membership.create({
        data: { userId: club.coachUser.id, businessId: createdBusiness.id, instructorId: soloInstructor.id },
      });
      return { solo: createdBusiness, soloMembership: membership };
    });
    tenants.own(solo.id);
    const legacySession = await createSession(club, club.coachUser.id, soloMembership.id);

    const account = await request(app).get('/api/auth/me')
      .set('Cookie', legacySession.cookie).expect(200);
    expect(account.body.membership).toBeNull();
    expect(account.body.memberships.map((item: { id: string }) => item.id)).not.toContain(soloMembership.id);
    expect(await prisma.authSession.findUniqueOrThrow({ where: { id: legacySession.session.id } }))
      .toMatchObject({ activeMembershipId: null });

    await request(app).post('/api/auth/switch-workspace')
      .set('Cookie', legacySession.cookie).send({ membershipId: soloMembership.id }).expect(403);
    await request(app).get('/api/workspace').set('Cookie', legacySession.cookie).expect(403);
    await request(app).post('/api/auth/practice')
      .set('Cookie', club.cookie).send({ name: 'New Practice' }).expect(404);

    const password = 'Marketplace-login-123';
    await prisma.user.update({
      where: { id: club.coachUser.id }, data: { passwordHash: await bcrypt.hash(password, 4) },
    });
    await prisma.membership.update({ where: { id: club.coachMembership.id }, data: { active: false } });
    const login = await request(app).post('/api/auth/login')
      .send({ email: club.coachUser.email.toUpperCase(), password }).expect(200);
    expect(login.body.membership).toBeNull();
    expect(login.body.memberships.map((item: { id: string }) => item.id)).not.toContain(soloMembership.id);

    const legacyClub = await tenants.fixture();
    await prisma.business.update({
      where: { id: legacyClub.business.id }, data: { legacyReadOnly: true },
    });
    const legacyClubAccount = await request(app).get('/api/auth/me')
      .set('Cookie', legacyClub.cookie).expect(200);
    expect(legacyClubAccount.body.membership).toBeNull();
    expect(legacyClubAccount.body.memberships).toEqual([]);
    await request(app).get('/api/workspace').set('Cookie', legacyClub.cookie).expect(403);
  });

  it('requires authentication and returns only bounded public account search results', async () => {
    const marker = suffix();
    const emailMarker = suffix();
    const matching = await createAccount(club, {
      name: `Directory ${marker}`, username: `directory_${marker}`,
      email: `directory-${marker}@example.test`, accountType: 'COACH',
      sports: ['Badminton'],
    });
    const emailOnly = await createAccount(club, {
      name: `Email Target ${suffix()}`, username: `email_target_${suffix()}`,
      email: `find-${emailMarker}@example.test`, accountType: 'STUDENT', sports: ['Tennis'],
    });
    for (let index = 0; index < 20; index += 1) {
      await createAccount(club, {
        name: `Load ${marker} ${index.toString().padStart(2, '0')}`,
        username: `load_${index}_${marker}`, email: `load-${index}-${marker}@example.test`,
      });
    }

    await request(app).get('/api/accounts/search').query({ q: marker }).expect(401);
    await request(app).get('/api/accounts/search').query({ q: 'x' }).set('Cookie', club.cookie).expect(400);
    await request(app).get('/api/accounts/search').query({ q: 'xy' }).set('Cookie', club.cookie).expect(400);
    await request(app).get('/api/accounts/search').query({ q: '@xy' }).set('Cookie', club.cookie).expect(400);
    await request(app).get('/api/accounts/search').query({ q: marker, extra: 'nope' })
      .set('Cookie', club.cookie).expect(400);

    const result = await request(app).get('/api/accounts/search')
      .query({ q: marker.toUpperCase() }).set('Cookie', club.cookie).expect(200);
    expect(result.body).toHaveLength(20);
    expect(result.body).toEqual(expect.arrayContaining([expect.objectContaining({
      name: `Directory ${marker}`, username: `directory_${marker}`,
      accountType: 'COACH', sports: ['Badminton'],
    })]));
    for (const account of result.body) {
      expect(Object.keys(account).sort()).toEqual(['accountType', 'name', 'sports', 'username']);
    }

    const partialEmail = await request(app).get('/api/accounts/search')
      .query({ q: emailMarker }).set('Cookie', club.cookie).expect(200);
    expect(partialEmail.body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ username: emailOnly.username }),
    ]));

    const exactEmail = await request(app).get('/api/accounts/search')
      .query({ q: `  ${emailOnly.email.toUpperCase()}  ` }).set('Cookie', club.cookie).expect(200);
    expect(exactEmail.body).toEqual([{
      name: emailOnly.name, username: emailOnly.username,
      accountType: emailOnly.accountType, sports: emailOnly.sports,
    }]);
    expect(JSON.stringify(exactEmail.body)).not.toContain(emailOnly.email);
    expect(JSON.stringify(exactEmail.body)).not.toContain(emailOnly.id);
  });

  it('rate-limits account-directory searches per authenticated account', async () => {
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      const response = await request(app).get('/api/accounts/search')
        .query({ q: `missing-${attempt}` }).set('Cookie', club.cookie);
      expect(response.status, `directory search ${attempt} should remain inside the quota`).toBe(200);
    }
    const limited = await request(app).get('/api/accounts/search')
      .query({ q: 'one-more-search' }).set('Cookie', club.cookie).expect(429);
    expect(limited.body).toEqual({ error: 'Too many account searches. Please wait a moment.' });

    const otherUser = await createAccount(club, { accountType: 'STUDENT' });
    const otherSession = await createSession(club, otherUser.id);
    await request(app).get('/api/accounts/search')
      .query({ q: 'independent-user' }).set('Cookie', otherSession.cookie).expect(200);
  });

  it('adds coaches by exact username, email, or a uniquely matching name without guessing', async () => {
    const sharedName = `Shared Coach ${suffix()}`;
    const first = await createAccount(club, {
      name: sharedName, username: `first_${suffix()}`, email: `${suffix()}@example.test`,
      passwordHash: await bcrypt.hash('Marketplace-coach-123', 4), accountType: 'COACH', sports: ['Tennis'],
    });
    const second = await createAccount(club, {
      name: sharedName, username: `second_${suffix()}`, email: `${suffix()}@example.test`,
      passwordHash: await bcrypt.hash('Marketplace-coach-123', 4), accountType: 'COACH',
    });
    const unique = await createAccount(club, {
      name: `Unique Coach ${suffix()}`, username: `unique_${suffix()}`, email: `${suffix()}@example.test`,
      passwordHash: await bcrypt.hash('Marketplace-coach-123', 4), accountType: 'COACH',
    });
    const claimable = await createAccount(club, {
      name: `Claimable Coach ${suffix()}`, username: `claimable_${suffix()}`, email: `${suffix()}@example.test`,
      passwordHash: await bcrypt.hash('Marketplace-coach-123', 4), accountType: 'COACH',
    });
    const unclaimedInstructor = await prisma.instructor.create({
      data: {
        businessId: club.business.id, name: 'Unclaimed roster profile', initials: 'UR',
        rescheduleNoticeHours: 6,
      },
    });

    for (const rescheduleNoticeHours of [-1, 721, 1.5]) {
      await request(app).post('/api/staff').set('Cookie', club.cookie)
        .send({ query: unique.username, instructorId: null, rescheduleNoticeHours }).expect(400);
    }

    const byUsername = await request(app).post('/api/staff').set('Cookie', club.cookie)
      .send({
        query: `@${first.username.toUpperCase()}`, instructorId: null, rescheduleNoticeHours: 36,
      }).expect(201);
    expect(byUsername.body).toMatchObject({
      userId: first.id, username: first.username, sports: ['Tennis'], accountType: 'COACH',
    });
    expect(byUsername.body).not.toHaveProperty('passwordHash');
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: byUsername.body.instructorId } }))
      .toMatchObject({ rescheduleNoticeHours: 36 });

    const ambiguous = await request(app).post('/api/staff').set('Cookie', club.cookie)
      .send({ query: sharedName, instructorId: null }).expect(409);
    expect(ambiguous.body.error).toContain('exact username or email');

    const byLegacyEmail = await request(app).post('/api/staff').set('Cookie', club.cookie)
      .send({
        email: second.email.toUpperCase(), instructorId: null, rescheduleNoticeHours: 720,
      }).expect(201);
    expect(byLegacyEmail.body.userId).toBe(second.id);
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: byLegacyEmail.body.instructorId } }))
      .toMatchObject({ rescheduleNoticeHours: 720 });

    const claimed = await request(app).post('/api/staff').set('Cookie', club.cookie)
      .send({
        query: claimable.username, instructorId: unclaimedInstructor.id, rescheduleNoticeHours: 48,
      }).expect(201);
    expect(claimed.body).toMatchObject({ userId: claimable.id, instructorId: unclaimedInstructor.id });
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: unclaimedInstructor.id } }))
      .toMatchObject({ rescheduleNoticeHours: 48 });

    await request(app).delete(`/api/staff/${byUsername.body.id}`).set('Cookie', club.cookie).expect(200);
    const restored = await request(app).post('/api/staff').set('Cookie', club.cookie)
      .send({ query: first.username, instructorId: null, rescheduleNoticeHours: 72 }).expect(200);
    expect(restored.body).toMatchObject({
      id: byUsername.body.id, userId: first.id, instructorId: byUsername.body.instructorId, active: true,
    });
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: byUsername.body.instructorId } }))
      .toMatchObject({ active: true, rescheduleNoticeHours: 72 });

    const byUniqueName = await request(app).post('/api/staff').set('Cookie', club.cookie)
      .send({ query: unique.name, instructorId: null, rescheduleNoticeHours: 0 }).expect(201);
    expect(byUniqueName.body.userId).toBe(unique.id);
    expect(await prisma.instructor.findUniqueOrThrow({ where: { id: byUniqueName.body.instructorId } }))
      .toMatchObject({ rescheduleNoticeHours: 0 });
    await request(app).post('/api/staff').set('Cookie', club.cookie)
      .send({ query: unique.username, email: unique.email, instructorId: null }).expect(400);
  });
});
