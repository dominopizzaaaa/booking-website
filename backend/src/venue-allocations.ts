import { Prisma } from '@prisma/client';
import { HttpError } from './http.js';

type Tx = Prisma.TransactionClient;

type AllocationTarget = {
  businessId: string;
  locationId: string;
  unitId: string;
  unitName: string;
  startAt: Date;
  endAt: Date;
};

export async function lockVenueUnits(tx: Tx, unitIds: string[]) {
  for (const unitId of [...new Set(unitIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`venue-unit:${unitId}`}, 0))`;
  }
}

export async function availableClassUnit(
  tx: Tx,
  location: { id: string; businessId: string; classUnitSchedulingEnabled: boolean },
  startAt: Date,
  endAt: Date,
  excludeBookingId?: string,
) {
  if (!location.classUnitSchedulingEnabled) return null;
  const units = await tx.venueUnit.findMany({
    where: { businessId: location.businessId, locationId: location.id, active: true },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  if (!units.length) throw new HttpError(409, 'This venue has no active court or resource available for classes');
  await lockVenueUnits(tx, units.map(unit => unit.id));
  const occupied = await tx.venueUnitAllocation.findMany({
    where: {
      businessId: location.businessId, unitId: { in: units.map(unit => unit.id) }, status: 'ACTIVE',
      startAt: { lt: endAt }, endAt: { gt: startAt },
      ...(excludeBookingId ? { OR: [{ bookingId: null }, { bookingId: { not: excludeBookingId } }] } : {}),
    },
    select: { unitId: true },
  });
  const occupiedIds = new Set(occupied.map(allocation => allocation.unitId));
  return units.find(unit => !occupiedIds.has(unit.id)) ?? undefined;
}

export async function reserveBookingUnit(tx: Tx, target: AllocationTarget & { bookingId: string }) {
  await tx.venueUnitAllocation.create({ data: {
    businessId: target.businessId, locationId: target.locationId, unitId: target.unitId,
    bookingId: target.bookingId, startAt: target.startAt, endAt: target.endAt,
    source: 'BOOKING', unitName: target.unitName,
  } });
}

export async function replaceBookingUnit(
  tx: Tx,
  target: AllocationTarget & { bookingId: string },
) {
  const now = new Date();
  await tx.venueUnitAllocation.updateMany({
    where: { bookingId: target.bookingId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: now },
  });
  await reserveBookingUnit(tx, target);
}

export async function releaseBookingUnit(tx: Tx, bookingId: string) {
  await tx.venueUnitAllocation.updateMany({
    where: { bookingId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });
}

export async function reserveRentalUnit(
  tx: Tx,
  target: AllocationTarget & { reservationId: string },
) {
  await tx.venueUnitAllocation.create({ data: {
    businessId: target.businessId, locationId: target.locationId, unitId: target.unitId,
    reservationId: target.reservationId, startAt: target.startAt, endAt: target.endAt,
    source: 'RENTAL', unitName: target.unitName,
  } });
}

export async function releaseRentalUnit(tx: Tx, reservationId: string) {
  await tx.venueUnitAllocation.updateMany({
    where: { reservationId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: new Date() },
  });
}

export function isVenueAllocationConflict(error: unknown) {
  const detail = error instanceof Prisma.PrismaClientKnownRequestError
    ? `${error.message} ${JSON.stringify(error.meta ?? {})}`
    : error instanceof Error ? error.message : '';
  return /VenueUnitAllocation_active_unit_overlap|23P01|exclusion constraint/u.test(detail);
}
