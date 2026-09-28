import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBookingSeries, type BookingSeriesInput } from '../src/booking-series.js';
import { createPackage, createStudent, prisma, TestTenants, verifyTestDatabase, type Fixture } from './fixtures.js';

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('finite booking series transactions', () => {
  let tenants: TestTenants;
  let f: Fixture;

  beforeEach(async () => {
    tenants = new TestTenants();
    f = await tenants.fixture();
    await prisma.service.update({ where: { id: f.service.id }, data: { type: 'GROUP', capacity: 4 } });
  });
  afterEach(async () => { await tenants.cleanup(); });

  const actor = () => ({ userId: f.user.id, accountType: 'CLUB' as const, instructorId: null });
  const input = (participants: BookingSeriesInput['participants'], starts = [
    f.starts, f.starts.plus({ weeks: 1 }), f.starts.plus({ weeks: 3 }),
  ]): BookingSeriesInput => ({
    serviceId: f.service.id, instructorId: f.instructor.id, locationId: f.location.id,
    name: 'Tuesday beginners', occurrenceStartAts: starts.map(start => start.toISO()!),
    participants, notes: 'Bring racquets', address: '',
  });

  it('creates an irregular finite group series with a durable roster and per-occurrence participants', async () => {
    const students = await Promise.all([
      createStudent(f, { name: 'First Series Student' }),
      createStudent(f, { name: 'Second Series Student' }),
    ]);

    const result = await createBookingSeries(
      f.business.id, input(students.map(student => ({ studentId: student.id }))), actor(),
    );

    expect(result.series).toMatchObject({ name: 'Tuesday beginners', occurrenceCount: 3, memberCount: 2 });
    expect(result.bookings.map(booking => booking.startAt)).toEqual([
      f.starts.toJSDate().toISOString(),
      f.starts.plus({ weeks: 1 }).toJSDate().toISOString(),
      f.starts.plus({ weeks: 3 }).toJSDate().toISOString(),
    ]);
    expect(result.bookings.every(booking => booking.status === 'PENDING'
      && booking.coachAcceptance === 'PENDING')).toBe(true);

    const series = await prisma.bookingSeries.findUniqueOrThrow({
      where: { id: result.series.id },
      include: { members: true, bookings: { include: { participants: true }, orderBy: { seriesPosition: 'asc' } } },
    });
    expect(series).toMatchObject({ businessId: f.business.id, createdByRole: 'CLUB', createdByUserId: f.user.id });
    expect(series.members.map(member => member.studentId).sort()).toEqual(students.map(student => student.id).sort());
    expect(series.bookings.map(booking => booking.seriesPosition)).toEqual([0, 1, 2]);
    expect(series.bookings.every(booking => booking.recurringId === series.id)).toBe(true);
    expect(series.bookings.every(booking => booking.participants.length === 2)).toBe(true);
    // Calendar projection is deliberately gated. The default integration
    // environment has no provider configuration or connected participant, so
    // creating a series must not accumulate dead outbox work.
    expect(await prisma.calendarSyncJob.count({ where: { booking: { seriesId: series.id } } })).toBe(0);
    expect(await prisma.accountNotification.count({ where: { booking: { seriesId: series.id } } })).toBe(6);
  });

  it('consumes each selected student package once per occurrence', async () => {
    const first = await createStudent(f, { name: 'Packaged One' });
    const second = await createStudent(f, { name: 'Packaged Two' });
    const [firstPackage, secondPackage] = await Promise.all([
      createPackage(f, first.id, { totalCredits: 4 }),
      createPackage(f, second.id, { totalCredits: 5 }),
    ]);

    const result = await createBookingSeries(f.business.id, input([
      { studentId: first.id, packageId: firstPackage.id },
      { studentId: second.id, packageId: secondPackage.id },
    ]), actor());

    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: firstPackage.id } }))
      .toMatchObject({ usedCredits: 3 });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: secondPackage.id } }))
      .toMatchObject({ usedCredits: 3 });
    const participants = await prisma.participant.findMany({ where: { booking: { seriesId: result.series.id } } });
    expect(participants).toHaveLength(6);
    expect(participants.every(participant => participant.creditConsumed && participant.paid)).toBe(true);
  });

  it('rolls back the series, roster and every package when one student lacks credits', async () => {
    const first = await createStudent(f, { name: 'Enough Credits' });
    const second = await createStudent(f, { name: 'Too Few Credits' });
    const [firstPackage, secondPackage] = await Promise.all([
      createPackage(f, first.id, { totalCredits: 3 }),
      createPackage(f, second.id, { totalCredits: 2 }),
    ]);

    await expect(createBookingSeries(f.business.id, input([
      { studentId: first.id, packageId: firstPackage.id },
      { studentId: second.id, packageId: secondPackage.id },
    ]), actor())).rejects.toMatchObject({ status: 409, message: 'Not enough package credits for Too Few Credits' });

    expect(await prisma.bookingSeries.count({ where: { businessId: f.business.id } })).toBe(0);
    expect(await prisma.booking.count({ where: { businessId: f.business.id } })).toBe(0);
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: firstPackage.id } })).toMatchObject({ usedCredits: 0 });
    expect(await prisma.lessonPackage.findUniqueOrThrow({ where: { id: secondPackage.id } })).toMatchObject({ usedCredits: 0 });
  });

  it('rolls back all dates when a later occurrence is unavailable', async () => {
    const student = await createStudent(f);
    const blocked = f.starts.plus({ weeks: 3 });
    await prisma.availabilityException.create({
      data: { businessId: f.business.id, instructorId: f.instructor.id, date: blocked.toISODate()! },
    });

    await expect(createBookingSeries(f.business.id, input([{ studentId: student.id }]), actor()))
      .rejects.toMatchObject({
        status: 409,
        details: { conflicts: [{ startAt: blocked.toJSDate().toISOString(), reason: 'Coach is unavailable on this date' }] },
      });
    expect(await prisma.bookingSeries.count({ where: { businessId: f.business.id } })).toBe(0);
    expect(await prisma.booking.count({ where: { businessId: f.business.id } })).toBe(0);
  });

  it('rejects duplicate roster members and a roster above capacity before writing', async () => {
    const students = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      createStudent(f, { name: `Capacity Student ${index}` })));
    await expect(createBookingSeries(f.business.id, input([
      { studentId: students[0]!.id }, { studentId: students[0]!.id },
    ]), actor())).rejects.toMatchObject({ status: 400 });
    await expect(createBookingSeries(f.business.id, input(
      students.map(student => ({ studentId: student.id })),
    ), actor())).rejects.toMatchObject({ status: 409, message: 'The roster exceeds this group capacity' });
    expect(await prisma.bookingSeries.count({ where: { businessId: f.business.id } })).toBe(0);
  });
});
