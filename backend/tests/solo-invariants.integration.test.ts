import { randomUUID } from 'node:crypto';
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

  async function createSoloPractice(name: string) {
    const coach = await createAccount(club, {
      name: `${name} Coach`, email: `${randomUUID()}@example.test`,
      accountType: 'COACH', passwordHash: 'not-used-by-this-test',
    });
    const session = await createSession(club, coach.id);
    const response = await request(app).post('/api/auth/practice')
      .set('Cookie', session.cookie).send({ name }).expect(201);
    tenants.own(response.body.business.id);
    return { coach, session, businessId: response.body.business.id as string };
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

    const solo = await createSoloPractice('Package Practice');
    const studentAccount = await createAccount(club, {
      name: 'Solo Package Student', email: `${randomUUID()}@example.test`, accountType: 'STUDENT',
    });
    const soloStudent = await prisma.student.create({
      data: {
        businessId: solo.businessId, userId: studentAccount.id, name: studentAccount.name,
        initials: 'SP', email: studentAccount.email,
      },
    });
    const soloPackage = await request(app).post('/api/packages').set('Cookie', solo.session.cookie)
      .send(packageInput(soloStudent.id, 'Solo package')).expect(201);
    expect(await prisma.payment.findFirstOrThrow({ where: { packageId: soloPackage.body.id } }))
      .toMatchObject({ kind: 'STUDENT_TO_COACH' });
  });

  it('allows a club to add a roster coach but keeps a solo practice to its founding coach', async () => {
    const rosterCoach = await createAccount(club, {
      name: 'Portable Coach', email: `${randomUUID()}@example.test`,
      accountType: 'COACH', passwordHash: 'not-used-by-this-test',
    });
    await request(app).post('/api/instructors').set('Cookie', club.cookie)
      .send({ name: rosterCoach.name, email: rosterCoach.email }).expect(201);

    const solo = await createSoloPractice('Single Coach Practice');
    const rejected = await request(app).post('/api/instructors').set('Cookie', solo.session.cookie)
      .send({ name: rosterCoach.name, email: rosterCoach.email }).expect(403);
    expect(rejected.body.error).toBe('Only the club account can manage its coaches');
    expect(await prisma.instructor.count({ where: { businessId: solo.businessId } })).toBe(1);
    expect(await prisma.membership.count({ where: { businessId: solo.businessId } })).toBe(1);
  });

  it('serializes concurrent attempts to create a coach own practice', async () => {
    const coach = await createAccount(club, {
      name: 'Concurrent Coach', email: `${randomUUID()}@example.test`,
      accountType: 'COACH', passwordHash: 'not-used-by-this-test',
    });
    const session = await createSession(club, coach.id);
    const responses = await Promise.all([
      request(app).post('/api/auth/practice').set('Cookie', session.cookie).send({ name: 'First Practice' }),
      request(app).post('/api/auth/practice').set('Cookie', session.cookie).send({ name: 'Second Practice' }),
    ]);
    const memberships = await prisma.membership.findMany({
      where: { userId: coach.id, business: { kind: 'SOLO' } },
      select: { businessId: true },
    });
    memberships.forEach(membership => tenants.own(membership.businessId));
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    const rejected = responses.find(response => response.status === 409)!;
    expect(rejected.body.error).toMatch(/^You already run .+ as your own practice\.$/);
    expect(memberships).toHaveLength(1);
    expect(await prisma.business.count({
      where: { kind: 'SOLO', memberships: { some: { userId: coach.id } } },
    })).toBe(1);
  });
});
