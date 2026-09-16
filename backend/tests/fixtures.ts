import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/db.js';
import { bookingInput, type BookingInput } from '../src/scheduling.js';

export { prisma };

// Never reset, truncate or seed the shared development database. Each test owns
// only the business IDs registered here and removes restrictive children first.
export class TestTenants {
  private readonly businessIds = new Set<string>();

  own(businessId: string) {
    this.businessIds.add(businessId);
  }

  async fixture() {
    const id = `courtly-test-${randomUUID()}`;
    this.own(id);
    const business = await prisma.business.create({
      data: {
        id, slug: id, name: `Test business ${id}`, ownerName: 'Test Owner',
        email: `${id}@example.test`, timezone: 'Asia/Singapore',
      },
    });
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
    // Dynamic dates remain in the future and represent a fixed Singapore clock
    // time, independently of the host timezone and when the suite is run.
    const starts = DateTime.now().setZone('Asia/Singapore').plus({ days: 14 }).startOf('day').set({ hour: 10 });
    return { business, instructor, location, service, starts };
  }

  async cleanup() {
    for (const businessId of this.businessIds) {
      await prisma.$transaction(async tx => {
        await tx.payment.deleteMany({ where: { businessId } });
        await tx.participant.deleteMany({ where: { booking: { businessId } } });
        await tx.booking.deleteMany({ where: { businessId } });
        await tx.lessonPackage.deleteMany({ where: { businessId } });
        await tx.customer.deleteMany({ where: { businessId } });
        // Cascades now safely remove users/sessions, availability, assignment
        // joins, instructors, locations, services, exceptions and notifications.
        await tx.business.deleteMany({ where: { id: businessId } });
      });
      this.businessIds.delete(businessId);
    }
  }
}

export type Fixture = Awaited<ReturnType<TestTenants['fixture']>>;

export function inputFor(f: Fixture, overrides: Partial<BookingInput> = {}): BookingInput {
  return bookingInput.parse({
    serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
    startAt: f.starts.toISO(),
    customer: { name: 'Test Customer', email: `${randomUUID()}@example.test` },
    ...overrides,
  });
}

export function createCustomer(f: Fixture) {
  return prisma.customer.create({
    data: { businessId: f.business.id, name: 'Package Customer', initials: 'PC', email: `${randomUUID()}@example.test` },
  });
}

export function createPackage(
  f: Fixture, customerId: string,
  overrides: Partial<Pick<Prisma.LessonPackageUncheckedCreateInput, 'serviceId' | 'totalCredits' | 'usedCredits' | 'expiresAt' | 'paid'>> = {},
) {
  return prisma.lessonPackage.create({
    data: {
      businessId: f.business.id, customerId, name: 'Five lessons', serviceId: f.service.id,
      totalCredits: 5, usedCredits: 0, price: 40000,
      expiresAt: f.starts.plus({ months: 6 }).toJSDate(), paid: true, ...overrides,
    },
  });
}

export async function tenantCounts(businessId: string) {
  const [bookings, participants, customers, notifications, packages, payments] = await Promise.all([
    prisma.booking.count({ where: { businessId } }),
    prisma.participant.count({ where: { booking: { businessId } } }),
    prisma.customer.count({ where: { businessId } }),
    prisma.notification.count({ where: { businessId } }),
    prisma.lessonPackage.count({ where: { businessId } }),
    prisma.payment.count({ where: { businessId } }),
  ]);
  return { bookings, participants, customers, notifications, packages, payments };
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
