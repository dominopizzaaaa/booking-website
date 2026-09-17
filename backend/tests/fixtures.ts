import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { bookingInput, publicBookingInput, type BookingInput, type PublicBookingInput } from '../src/scheduling.js';

export { prisma };

// Never reset, truncate or seed the shared development database. Each test owns
// only the business IDs registered here and removes restrictive children first.
export class TestTenants {
  private readonly businessIds = new Set<string>();
  private readonly userIds = new Set<string>();

  own(businessId: string) {
    this.businessIds.add(businessId);
  }

  ownUser(userId: string) {
    this.userIds.add(userId);
  }

  async fixture() {
    const id = `courtly-test-${randomUUID()}`;
    this.own(id);
    // A CLUB business and its institutional account are one aggregate. The
    // deferred database invariant deliberately rejects either half on its own.
    const { business, user, membership } = await prisma.$transaction(async tx => {
      const createdBusiness = await tx.business.create({
        data: {
          id, slug: id, name: `Test business ${id}`, ownerName: 'Test Owner',
          email: `${id}@example.test`, timezone: 'Asia/Singapore',
        },
      });
      const createdUser = await tx.user.create({
        data: {
          name: `Test business ${id}`, email: `${id}-club@example.test`,
          passwordHash: 'not-used-by-this-test', accountType: 'CLUB',
        },
      });
      const createdMembership = await tx.membership.create({
        data: { userId: createdUser.id, businessId: id },
      });
      return { business: createdBusiness, user: createdUser, membership: createdMembership };
    });
    this.ownUser(user.id);
    const instructor = await prisma.instructor.create({
      data: { businessId: id, name: 'Test Coach', initials: 'TC' },
    });
    const location = await prisma.location.create({
      data: { businessId: id, name: 'Test Court', travelMinutes: 20 },
    });
    const service = await prisma.service.create({
      data: {
        businessId: id, name: 'Private tennis', type: 'PRIVATE', capacity: 1,
        duration: 60, price: 8000, noticeHours: 0, bufferMinutes: 0,
        locations: {
          create: {
            locationId: location.id, price: 8000, duration: 60,
            instructors: { create: { instructorId: instructor.id } },
          },
        },
      },
    });
    await prisma.availability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        businessId: id, instructorId: instructor.id, locationId: location.id,
        dayOfWeek, startTime: '08:00', endTime: '20:00',
      })),
    });
    // The coach who actually teaches, with their own portable account.
    const coachUser = await prisma.user.create({
      data: {
        name: 'Test Coach', email: `${id}-coach@example.test`,
        passwordHash: 'not-used-by-this-test', accountType: 'COACH',
      },
    });
    this.ownUser(coachUser.id);
    const coachMembership = await prisma.membership.create({
      data: { userId: coachUser.id, businessId: id, instructorId: instructor.id },
    });
    const sessionToken = randomBytes(32).toString('base64url');
    const session = await prisma.authSession.create({
      data: {
        id: createHash('sha256').update(sessionToken).digest('hex'), userId: user.id,
        activeMembershipId: membership.id, expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const coachSessionToken = randomBytes(32).toString('base64url');
    await prisma.authSession.create({
      data: {
        id: createHash('sha256').update(coachSessionToken).digest('hex'), userId: coachUser.id,
        activeMembershipId: coachMembership.id, expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    // Dynamic dates remain in the future and represent a fixed Singapore clock
    // time, independently of the host timezone and when the suite is run.
    const starts = DateTime.now().setZone('Asia/Singapore').plus({ days: 14 }).startOf('day').set({ hour: 10 });
    return {
      business, instructor, location, service, starts, user, membership, session, sessionToken,
      coachUser, coachMembership, coachCookie: `${config.sessionCookie}=${coachSessionToken}`,
      cookie: `${config.sessionCookie}=${sessionToken}`, tracker: this,
    };
  }

  async cleanup() {
    for (const businessId of [...this.businessIds]) {
      await prisma.$transaction(async tx => {
        const institutionalAccountIds = (await tx.membership.findMany({
          where: { businessId, user: { accountType: 'CLUB' } },
          select: { userId: true },
        })).map(membership => membership.userId);
        await tx.payment.deleteMany({ where: { businessId } });
        await tx.participant.deleteMany({ where: { booking: { businessId } } });
        await tx.booking.deleteMany({ where: { businessId } });
        await tx.lessonPackage.deleteMany({ where: { businessId } });
        await tx.student.deleteMany({ where: { businessId } });
        // Memberships, availability, assignment joins, instructors, locations,
        // services, exceptions and notifications cascade from the business.
        // Global users deliberately do not.
        await tx.business.deleteMany({ where: { id: businessId } });
        if (institutionalAccountIds.length) {
          await tx.user.deleteMany({ where: { id: { in: institutionalAccountIds } } });
        }
      });
      this.businessIds.delete(businessId);
    }
    // Delete only global accounts explicitly created by this test fixture. This
    // also cascades their sessions and cannot affect a pre-existing account that
    // was merely granted membership in one of the disposable businesses.
    if (this.userIds.size) {
      await prisma.user.deleteMany({ where: { id: { in: [...this.userIds] } } });
      this.userIds.clear();
    }
  }
}

export type Fixture = Awaited<ReturnType<TestTenants['fixture']>>;

export function inputFor(f: Fixture, overrides: Partial<BookingInput> = {}): BookingInput {
  return bookingInput.parse({
    serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
    startAt: f.starts.toISO(),
    student: { name: 'Test Student', email: `${randomUUID()}@example.test` },
    ...overrides,
  });
}

export function publicInputFor(f: Fixture, overrides: Partial<PublicBookingInput> = {}): PublicBookingInput {
  return publicBookingInput.parse({
    serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
    startAt: f.starts.toISO(),
    ...overrides,
  });
}

export async function createAccount(
  f: Fixture,
  overrides: Partial<{ name: string; email: string; passwordHash: string | null; accountType: string; phone: string; parentName: string }> = {},
) {
  const user = await prisma.user.create({
    data: {
      name: 'Test Student', email: `${randomUUID()}@example.test`, passwordHash: 'not-used-by-this-test',
      accountType: 'STUDENT', phone: '', parentName: '', ...overrides,
    },
  });
  f.tracker.ownUser(user.id);
  return user;
}

export async function createStudent(
  f: Fixture,
  overrides: Partial<{ name: string; email: string; phone: string; parentName: string; notes: string }> & { userId?: string | null } = {},
) {
  const name = overrides.name ?? 'Package Student';
  const email = overrides.email ?? `${randomUUID()}@example.test`;
  const userId = Object.prototype.hasOwnProperty.call(overrides, 'userId')
    ? overrides.userId
    : (await createAccount(f, {
      name, email,
    })).id;
  const { userId: _userId, ...profile } = overrides;
  return prisma.student.create({
    data: {
      businessId: f.business.id, userId, name, initials: 'PC', email, ...profile,
    },
  });
}

export async function linkedInputFor(f: Fixture, overrides: Partial<BookingInput> = {}): Promise<BookingInput> {
  if (overrides.studentId) return inputFor(f, { ...overrides, student: undefined });
  const supplied = overrides.student;
  const student = await createStudent(f, {
    name: supplied?.name ?? 'Test Student',
    email: supplied?.email ?? `${randomUUID()}@example.test`,
    phone: supplied?.phone ?? '',
    parentName: supplied?.parentName ?? '',
  });
  return inputFor(f, { ...overrides, studentId: student.id, student: undefined });
}

export async function createSession(
  f: Fixture, userId: string, activeMembershipId: string | null = null,
) {
  const token = randomBytes(32).toString('base64url');
  const session = await prisma.authSession.create({
    data: {
      id: createHash('sha256').update(token).digest('hex'), userId, activeMembershipId,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { session, token, cookie: `${config.sessionCookie}=${token}` };
}

export function createPackage(
  f: Fixture, studentId: string,
  overrides: Partial<Pick<Prisma.LessonPackageUncheckedCreateInput, 'serviceId' | 'totalCredits' | 'usedCredits' | 'expiresAt' | 'paid'>> = {},
) {
  return prisma.lessonPackage.create({
    data: {
      businessId: f.business.id, studentId, name: 'Five lessons', serviceId: f.service.id,
      totalCredits: 5, usedCredits: 0, price: 40000,
      expiresAt: f.starts.plus({ months: 6 }).toJSDate(), paid: true, ...overrides,
    },
  });
}

export async function tenantCounts(businessId: string) {
  const [bookings, participants, students, notifications, packages, payments] = await Promise.all([
    prisma.booking.count({ where: { businessId } }),
    prisma.participant.count({ where: { booking: { businessId } } }),
    prisma.student.count({ where: { businessId } }),
    prisma.notification.count({ where: { businessId } }),
    prisma.lessonPackage.count({ where: { businessId } }),
    prisma.payment.count({ where: { businessId } }),
  ]);
  return { bookings, participants, students, notifications, packages, payments };
}

export async function verifyTestDatabase() {
  if (process.env.NODE_ENV === 'production') throw new Error('Integration tests must not run in production');
  const url = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Integration tests require a local PostgreSQL DATABASE_URL; the default is 127.0.0.1:55432/courtly');
  }
  // This is a real connection check, not a mock or a skip-on-failure fallback.
  const result = await prisma.$queryRaw<{ name: string; version: string }[]>`SELECT current_database() AS name, version() AS version`;
  if (!result[0]?.version.includes('PostgreSQL')) throw new Error('Integration tests require PostgreSQL');
}
