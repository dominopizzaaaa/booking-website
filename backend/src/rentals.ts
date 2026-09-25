import { createHash } from 'node:crypto';
import { Router, type NextFunction, type RequestHandler, type Response } from 'express';
import { DateTime } from 'luxon';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { HttpError, initials, type AccountRequest } from './http.js';

export const rentalsRouter = Router();

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

// This router is mounted after requireAuth but deliberately not after
// requireWorkspace: rentals belong to a global account, while only venue
// configuration requires a selected club workspace.
const accountRoute = (fn: (req: AccountRequest, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    const account = req as AccountRequest;
    if (!account.auth?.user?.passwordHash) return next(new HttpError(401, 'Please sign in to continue'));
    Promise.resolve(fn(account, res, next)).catch(next);
  };

const idSchema = z.string().trim().min(1).max(200);
const createLocationIdSchema = z.string().trim().min(32).max(100)
  .regex(/^rental_loc_[A-Za-z0-9_-]+$/u, 'Use a valid opaque location save key');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a valid time in HH:mm format');
const amenitiesSchema = z.array(z.string().trim().min(1).max(80)).max(40)
  .transform(values => [...new Map(values.map(value => [value.toLocaleLowerCase(), value])).values()]);
const unitSchema = z.object({
  id: idSchema.optional(), name: z.string().trim().min(1).max(120), active: z.boolean().default(true),
}).strict();
const openingHourSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6), startTime: timeSchema, endTime: timeSchema,
}).strict().refine(value => value.startTime < value.endTime, {
  path: ['endTime'], message: 'Opening time must end after it starts on the same day',
});

const rentalFields = {
  sport: z.string().trim().min(1).max(100),
  rules: z.string().trim().max(5000),
  amenities: amenitiesSchema,
  unitLabel: z.string().trim().min(1).max(80),
  price: z.number().int().nonnegative().max(100_000_000),
  startInterval: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  minDuration: z.number().int().min(5).max(1440),
  durationIncrement: z.union([z.literal(15), z.literal(30), z.literal(60)]),
  maxDuration: z.number().int().min(5).max(1440),
  noticeHours: z.number().int().min(0).max(8760),
  advanceDays: z.number().int().min(1).max(365),
  cancellationHours: z.number().int().min(0).max(8760),
  units: z.array(unitSchema).min(1).max(100),
  openingHours: z.array(openingHourSchema).min(1).max(100),
};
const locationFields = {
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500).default(''),
  type: z.enum(['FACILITY', 'RENTED', 'HOME', 'ONLINE']).default('FACILITY'),
  color: z.string().trim().min(1).max(40).default('sage'),
  requiresApproval: z.boolean().default(false),
  travelMinutes: z.number().int().min(0).max(240).default(20),
  notes: z.string().trim().max(2000).default(''),
  source: z.enum(['MANUAL', 'GOOGLE_MAPS']).default('MANUAL'),
  placeId: z.string().trim().max(300).default(''),
  mapsUrl: z.string().trim().max(2000)
    .refine(value => !value || /^https?:\/\//iu.test(value), 'Use a full https link').default(''),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  active: z.boolean().default(true),
};
const compositeRentalInput = z.object({
  mode: z.enum(['CREATE', 'UPDATE']),
  location: z.object(locationFields).strict(),
  rental: z.discriminatedUnion('enabled', [
    z.object({ enabled: z.literal(false) }).strict(),
    z.object({ enabled: z.literal(true), ...rentalFields }).strict(),
  ]),
}).strict();
const createRentalInput = z.object({ locationId: idSchema, ...rentalFields }).strict();
const updateRentalInput = z.object({
  sport: rentalFields.sport.optional(), rules: rentalFields.rules.optional(), amenities: amenitiesSchema.optional(),
  unitLabel: rentalFields.unitLabel.optional(), price: rentalFields.price.optional(),
  startInterval: rentalFields.startInterval.optional(), minDuration: rentalFields.minDuration.optional(),
  durationIncrement: rentalFields.durationIncrement.optional(), maxDuration: rentalFields.maxDuration.optional(),
  noticeHours: rentalFields.noticeHours.optional(), advanceDays: rentalFields.advanceDays.optional(),
  cancellationHours: rentalFields.cancellationHours.optional(),
  units: z.array(unitSchema).min(1).max(100).optional(),
  openingHours: z.array(openingHourSchema).min(1).max(100).optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one rental field to update' });

const rentalInclude = {
  business: { select: { id: true, name: true, slug: true, kind: true, timezone: true, currency: true, isDemo: true, legacyReadOnly: true } },
  venueUnits: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  openingHours: { orderBy: [{ dayOfWeek: 'asc' as const }, { startTime: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.LocationInclude;
type RentalLocation = Prisma.LocationGetPayload<{ include: typeof rentalInclude }>;

const reservationInclude = {
  business: { select: { name: true, currency: true, timezone: true } },
  location: { select: { name: true, rentalCancellationHours: true } },
  unit: { select: { name: true } },
} satisfies Prisma.VenueReservationInclude;
type RentalReservation = Prisma.VenueReservationGetPayload<{ include: typeof reservationInclude }>;
type PaymentIntent = Prisma.PaymentIntentGetPayload<Record<string, never>>;
const postgresIntegerMax = 2_147_483_647;

function parseAmenities(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // Older or hand-authored fixtures may use a comma-delimited string.
  }
  return value.split(/[\n,]/u).map(item => item.trim()).filter(Boolean);
}

function rentalSummary(location: RentalLocation) {
  return {
    id: location.id, locationId: location.id, name: location.name, address: location.address,
    sport: location.sport, amenities: parseAmenities(location.amenities), unitLabel: location.rentalUnitLabel,
    price: location.rentalPrice, currency: location.business.currency, timezone: location.business.timezone,
    club: { name: location.business.name, slug: location.business.slug },
  };
}

function rentalDetail(location: RentalLocation, includeInactiveUnits = false) {
  return {
    ...rentalSummary(location), enabled: location.rentalEnabled, startInterval: location.rentalStartInterval,
    minDuration: location.rentalMinDuration, durationIncrement: location.rentalBookingIncrement,
    maxDuration: location.rentalMaxDuration, noticeHours: location.rentalNoticeHours,
    advanceDays: location.rentalAdvanceDays, cancellationHours: location.rentalCancellationHours,
    rules: location.rules, units: location.venueUnits.filter(unit => includeInactiveUnits || unit.active)
      .map(unit => ({ id: unit.id, name: unit.name, active: unit.active })),
    openingHours: location.openingHours.map(hour => ({
      dayOfWeek: hour.dayOfWeek, startTime: hour.startTime, endTime: hour.endTime,
    })),
  };
}

function paymentIntentJson(intent: PaymentIntent) {
  return {
    id: intent.id, kind: intent.kind, amount: intent.amount, currency: intent.currency, status: intent.status,
    provider: intent.provider, providerReference: intent.providerReference, idempotencyKey: intent.idempotencyKey,
    failureCode: intent.status === 'FAILED' ? 'SIMULATED_FAILURE' : null, reservationId: intent.reservationId,
    createdAt: intent.createdAt.toISOString(), confirmedAt: intent.confirmedAt?.toISOString() ?? null,
    failedAt: intent.failedAt?.toISOString() ?? null,
  };
}

function reservationSnapshot(reservation: Pick<RentalReservation, 'notes' | 'unit' | 'location'>) {
  try {
    const value: unknown = JSON.parse(reservation.notes);
    if (value && typeof value === 'object') {
      const snapshot = value as { cancellationHours?: unknown; unitName?: unknown };
      if (Number.isInteger(snapshot.cancellationHours)
        && Number(snapshot.cancellationHours) >= 0 && Number(snapshot.cancellationHours) <= 8760
        && typeof snapshot.unitName === 'string' && snapshot.unitName.length > 0) {
        return { cancellationHours: Number(snapshot.cancellationHours), unitName: snapshot.unitName };
      }
    }
  } catch {
    // Reservations created before snapshot metadata use the retained catalog values.
  }
  return { cancellationHours: reservation.location.rentalCancellationHours, unitName: reservation.unit.name };
}

function reservationJson(reservation: RentalReservation, now = new Date()) {
  const snapshot = reservationSnapshot(reservation);
  const cancellationDeadline = new Date(
    reservation.startAt.getTime() - snapshot.cancellationHours * 3_600_000,
  );
  return {
    id: reservation.id, businessName: reservation.business.name,
    locationId: reservation.locationId, locationName: reservation.location.name,
    unitId: reservation.unitId, unitName: snapshot.unitName, startAt: reservation.startAt.toISOString(),
    endAt: reservation.endAt.toISOString(), duration: reservation.duration, price: reservation.price,
    status: reservation.status, paymentStatus: reservation.paymentStatus, packageId: reservation.packageId,
    creditConsumed: reservation.creditConsumed, currency: reservation.business.currency,
    timezone: reservation.business.timezone, cancellationDeadline: cancellationDeadline.toISOString(),
    cancellable: ['PENDING', 'CONFIRMED'].includes(reservation.status)
      && reservation.cancelledAt === null && now.getTime() <= cancellationDeadline.getTime(),
  };
}

function isPublished(location: RentalLocation) {
  return location.active && location.type === 'FACILITY' && location.rentalEnabled
    && location.business.kind === 'CLUB' && !location.business.isDemo && !location.business.legacyReadOnly;
}

function isOwningClub(req: AccountRequest, businessId: string) {
  const { user, membership, business } = req.auth;
  return user.accountType === 'CLUB' && !!user.passwordHash && !!membership && membership.active
    && membership.userId === user.id && membership.businessId === businessId
    && membership.instructorId === null && business?.id === businessId && business.kind === 'CLUB';
}

function clubBusinessId(req: AccountRequest) {
  const business = req.auth.business;
  if (!business || !isOwningClub(req, business.id)) throw new HttpError(403, 'Only the club account can manage venue rentals');
  if (business.legacyReadOnly) throw new HttpError(403, 'This legacy workspace is read-only');
  return business.id;
}

function validateConfig(input: {
  price: number; minDuration: number; maxDuration: number; durationIncrement: number;
  units: Array<{ id?: string; name: string; active: boolean }>;
  openingHours: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
}) {
  if (input.maxDuration < input.minDuration) throw new HttpError(400, 'Maximum duration must not be shorter than minimum duration');
  if (input.minDuration < input.durationIncrement
    || input.minDuration % input.durationIncrement !== 0
    || input.maxDuration % input.durationIncrement !== 0) {
    throw new HttpError(400, 'Rental durations must be divisible by the booking increment');
  }
  if (Math.round(input.price * input.maxDuration / 60) > postgresIntegerMax) {
    throw new HttpError(400, 'The hourly price is too high for the maximum rental duration');
  }
  if (!input.units.some(unit => unit.active)) throw new HttpError(400, 'Keep at least one rental unit active');
  const ids = input.units.flatMap(unit => unit.id ? [unit.id] : []);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each rental unit may appear only once');
  const names = input.units.map(unit => unit.name.toLocaleLowerCase());
  if (new Set(names).size !== names.length) throw new HttpError(400, 'Rental unit names must be unique');
  for (const day of new Set(input.openingHours.map(hour => hour.dayOfWeek))) {
    const hours = input.openingHours.filter(hour => hour.dayOfWeek === day).sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let index = 1; index < hours.length; index += 1) {
      if (hours[index].startTime < hours[index - 1].endTime) {
        throw new HttpError(400, 'Opening-hour ranges cannot overlap on the same day');
      }
    }
  }
}

function locationJson(location: RentalLocation) {
  return {
    id: location.id, name: location.name, address: location.address, type: location.type, color: location.color,
    requiresApproval: location.requiresApproval, travelMinutes: location.travelMinutes, notes: location.notes,
    source: location.source, placeId: location.placeId, mapsUrl: location.mapsUrl, latitude: location.latitude,
    longitude: location.longitude, active: location.active,
  };
}

async function replaceUnits(tx: Tx, location: RentalLocation, units: Array<{ id?: string; name: string; active: boolean }>) {
  const existingById = new Map(location.venueUnits.map(unit => [unit.id, unit]));
  const existingByName = new Map(location.venueUnits.map(unit => [unit.name, unit]));
  const resolved = units.map(unit => ({ ...unit, existing: unit.id ? existingById.get(unit.id) : existingByName.get(unit.name) }));
  if (resolved.some(unit => unit.id && !unit.existing)) throw new HttpError(404, 'Rental unit not found at this venue');
  const retainedIds = new Set(resolved.flatMap(unit => unit.existing ? [unit.existing.id] : []));
  await tx.venueUnit.updateMany({
    where: { locationId: location.id, businessId: location.businessId, id: { notIn: [...retainedIds] } },
    data: { active: false },
  });
  // Temporarily free current names so two retained rows may swap names safely.
  for (const unit of resolved) {
    if (unit.existing && unit.existing.name !== unit.name) {
      await tx.venueUnit.update({ where: { id: unit.existing.id }, data: { name: `__rental_unit_${unit.existing.id}` } });
    }
  }
  for (const unit of resolved) {
    if (unit.existing) {
      await tx.venueUnit.update({ where: { id: unit.existing.id }, data: { name: unit.name, active: unit.active } });
    } else {
      await tx.venueUnit.create({ data: {
        businessId: location.businessId, locationId: location.id, name: unit.name, active: unit.active,
      } });
    }
  }
}

async function replaceOpeningHours(
  tx: Tx, location: Pick<RentalLocation, 'id' | 'businessId'>,
  hours: Array<{ dayOfWeek: number; startTime: string; endTime: string }>,
) {
  await tx.venueOpeningHour.deleteMany({ where: { locationId: location.id, businessId: location.businessId } });
  await tx.venueOpeningHour.createMany({ data: hours.map(hour => ({
    ...hour, businessId: location.businessId, locationId: location.id,
  })) });
}

async function lockVenueUnits(tx: Tx, unitIds: string[]) {
  for (const unitId of [...new Set(unitIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`venue-unit:${unitId}`}, 0))`;
  }
}

async function configuredLocation(db: Db, locationId: string) {
  return db.location.findUnique({ where: { id: locationId }, include: rentalInclude });
}

async function assertRentalMayBeDisabled(tx: Tx, businessId: string, locationId: string) {
  const activeOffer = await tx.packageOffer.findFirst({
    where: { businessId, active: true, rentalLocations: { some: { locationId } } }, select: { id: true },
  });
  if (activeOffer) throw new HttpError(409, 'Archive package offers that use this rental venue before disabling it');
}

async function disableRental(tx: Tx, location: RentalLocation) {
  await lockVenueUnits(tx, location.venueUnits.map(unit => unit.id));
  const history = await tx.venueReservation.count({ where: { locationId: location.id, businessId: location.businessId } });
  if (!history) {
    await tx.venueOpeningHour.deleteMany({ where: { locationId: location.id, businessId: location.businessId } });
    await tx.venueUnit.deleteMany({ where: { locationId: location.id, businessId: location.businessId } });
  }
}

function compositeCreateMatches(location: RentalLocation, input: z.infer<typeof compositeRentalInput>) {
  const core = input.location;
  const sameCore = location.name === core.name && location.address === core.address && location.type === core.type
    && location.color === core.color && location.requiresApproval === core.requiresApproval
    && location.travelMinutes === core.travelMinutes && location.notes === core.notes && location.source === core.source
    && location.placeId === core.placeId && location.mapsUrl === core.mapsUrl && location.latitude === core.latitude
    && location.longitude === core.longitude && location.active === core.active;
  if (!sameCore || location.rentalEnabled !== input.rental.enabled) return false;
  if (!input.rental.enabled) return !location.venueUnits.length && !location.openingHours.length;
  const units = location.venueUnits.map(unit => ({ name: unit.name, active: unit.active }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const wantedUnits = input.rental.units.map(unit => ({ name: unit.name, active: unit.active }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const hours = location.openingHours.map(({ dayOfWeek, startTime, endTime }) => ({ dayOfWeek, startTime, endTime }));
  const wantedHours = [...input.rental.openingHours]
    .sort((left, right) => left.dayOfWeek - right.dayOfWeek || left.startTime.localeCompare(right.startTime));
  return location.sport === input.rental.sport && location.rules === input.rental.rules
    && JSON.stringify(parseAmenities(location.amenities)) === JSON.stringify(input.rental.amenities)
    && location.rentalUnitLabel === input.rental.unitLabel && location.rentalPrice === input.rental.price
    && location.rentalStartInterval === input.rental.startInterval
    && location.rentalMinDuration === input.rental.minDuration
    && location.rentalBookingIncrement === input.rental.durationIncrement
    && location.rentalMaxDuration === input.rental.maxDuration
    && location.rentalNoticeHours === input.rental.noticeHours
    && location.rentalAdvanceDays === input.rental.advanceDays
    && location.rentalCancellationHours === input.rental.cancellationHours
    && JSON.stringify(units) === JSON.stringify(wantedUnits)
    && JSON.stringify(hours) === JSON.stringify(wantedHours);
}

async function saveCompositeLocation(
  tx: Tx, businessId: string, locationId: string, input: z.infer<typeof compositeRentalInput>,
) {
  // A generated location id doubles as the durable create idempotency key. The
  // advisory lock serializes both the first insert and lost-response replays.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rental-location:${locationId}`}, 0))`;
  await tx.$queryRaw`SELECT id FROM "Location" WHERE id = ${locationId} FOR UPDATE`;
  // Package-scope triggers use this same lock. Taking it before the location
  // guard prevents a concurrent offer write from slipping between validation
  // and the final update, including when that offer has another eligible scope.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(20260925, 200001)`;
  let location = await configuredLocation(tx, locationId);
  let created = false;

  if (input.mode === 'CREATE') {
    if (location && location.businessId !== businessId) {
      throw new HttpError(409, 'This location save key is already in use');
    }
    if (!location) {
      location = await tx.location.create({
        data: { id: locationId, businessId, ...input.location }, include: rentalInclude,
      });
      created = true;
    } else if (compositeCreateMatches(location, input)) {
      return { location, replay: true };
    } else {
      throw new HttpError(409, 'This location save key was already used. Reload locations before trying again');
    }
  } else {
    if (!location || location.businessId !== businessId) throw new HttpError(404, 'Location not found');
  }

  if (!location || location.businessId !== businessId) throw new HttpError(404, 'Location not found');
  if ((location.rentalEnabled && !input.rental.enabled) || (location.active && !input.location.active)) {
    await assertRentalMayBeDisabled(tx, businessId, locationId);
  }
  if (input.rental.enabled) {
    if (input.location.type !== 'FACILITY') throw new HttpError(400, 'Only a facility location can be offered for rental');
    if (!input.location.active) throw new HttpError(400, 'A rental location must remain active');
    validateConfig(input.rental);
    await lockVenueUnits(tx, location.venueUnits.map(unit => unit.id));
    await replaceUnits(tx, location, input.rental.units);
    await replaceOpeningHours(tx, location, input.rental.openingHours);
  } else if (location.rentalEnabled) {
    await disableRental(tx, location);
  }

  const rentalData = input.rental.enabled ? {
    rentalEnabled: true, sport: input.rental.sport, rules: input.rental.rules,
    amenities: JSON.stringify(input.rental.amenities), rentalUnitLabel: input.rental.unitLabel,
    rentalPrice: input.rental.price, rentalStartInterval: input.rental.startInterval,
    rentalMinDuration: input.rental.minDuration, rentalBookingIncrement: input.rental.durationIncrement,
    rentalMaxDuration: input.rental.maxDuration, rentalNoticeHours: input.rental.noticeHours,
    rentalAdvanceDays: input.rental.advanceDays, rentalCancellationHours: input.rental.cancellationHours,
  } : { rentalEnabled: false };
  const saved = await tx.location.update({
    where: { id: locationId, businessId }, data: { ...input.location, ...rentalData }, include: rentalInclude,
  });
  return { location: saved, replay: false, created };
}

const directoryQuery = z.object({
  query: z.string().trim().max(120).optional(), sport: z.string().trim().max(100).optional(),
  cursor: idSchema.optional(),
}).strict();

rentalsRouter.put('/rental-locations/:id', accountRoute(async (req, res) => {
  const businessId = clubBusinessId(req);
  const locationId = idSchema.parse(req.params.id);
  const input = compositeRentalInput.parse(req.body);
  if (input.mode === 'CREATE') createLocationIdSchema.parse(locationId);
  const result = await prisma.$transaction(
    tx => saveCompositeLocation(tx, businessId, locationId, input), { timeout: 30_000 },
  );
  res.status(result.created ? 201 : 200).json({
    location: locationJson(result.location), rental: rentalDetail(result.location, true), replay: result.replay,
  });
}));

rentalsRouter.get('/rentals', accountRoute(async (req, res) => {
  const query = directoryQuery.parse(req.query);
  const rentals = await prisma.location.findMany({
    where: {
      id: query.cursor ? { gt: query.cursor } : undefined, active: true, type: 'FACILITY', rentalEnabled: true,
      business: { kind: 'CLUB', isDemo: false, legacyReadOnly: false },
      venueUnits: { some: { active: true } }, openingHours: { some: {} },
      ...(query.sport ? { sport: { equals: query.sport, mode: 'insensitive' } } : {}),
      ...(query.query ? { OR: [
        { name: { contains: query.query, mode: 'insensitive' } },
        { address: { contains: query.query, mode: 'insensitive' } },
        { sport: { contains: query.query, mode: 'insensitive' } },
        { business: { name: { contains: query.query, mode: 'insensitive' } } },
      ] } : {}),
    }, include: rentalInclude, orderBy: { id: 'asc' }, take: 31,
  });
  const page = rentals.slice(0, 30);
  res.json({ rentals: page.map(rentalSummary), nextCursor: rentals.length > 30 ? page.at(-1)!.id : null });
}));

rentalsRouter.get('/rentals/reservations/mine', accountRoute(async (req, res) => {
  const reservations = await prisma.venueReservation.findMany({
    where: { userId: req.auth.user.id }, include: reservationInclude,
    orderBy: [{ startAt: 'desc' }, { createdAt: 'desc' }],
  });
  res.json({ reservations: reservations.map(reservation => reservationJson(reservation)) });
}));

rentalsRouter.get('/rentals/:id', accountRoute(async (req, res) => {
  const location = await configuredLocation(prisma, idSchema.parse(req.params.id));
  if (!location) throw new HttpError(404, 'Rental venue not found');
  const manager = isOwningClub(req, location.businessId);
  if (!manager && !isPublished(location)) throw new HttpError(404, 'Rental venue not found');
  res.json({ rental: rentalDetail(location, manager) });
}));

function localDay(date: string, timezone: string) {
  const day = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  if (!day.isValid || day.toISODate() !== date) throw new HttpError(400, 'Choose a valid calendar date');
  return day;
}

function assertDuration(location: RentalLocation, duration: number) {
  if (duration < location.rentalMinDuration || duration > location.rentalMaxDuration
    || duration % location.rentalBookingIncrement !== 0) {
    throw new HttpError(400, 'Choose an allowed rental duration');
  }
}

function openingContains(location: RentalLocation, startAt: Date, duration: number) {
  const localStart = DateTime.fromJSDate(startAt, { zone: location.business.timezone });
  if (localStart.second !== 0 || localStart.millisecond !== 0) return false;
  const minute = localStart.hour * 60 + localStart.minute;
  if (minute % location.rentalStartInterval !== 0) return false;
  const endAt = new Date(startAt.getTime() + duration * 60_000);
  const localEnd = DateTime.fromJSDate(endAt, { zone: location.business.timezone });
  if (localStart.toISODate() !== localEnd.toISODate()) return false;
  return location.openingHours.some(hour => {
    if (hour.dayOfWeek !== localStart.weekday % 7) return false;
    const [startHour, startMinute] = hour.startTime.split(':').map(Number);
    const [endHour, endMinute] = hour.endTime.split(':').map(Number);
    const openingMinute = startHour * 60 + startMinute;
    const localEndMinute = localEnd.hour * 60 + localEnd.minute;
    return minute >= openingMinute && localEndMinute <= endHour * 60 + endMinute;
  });
}

function localTimeAt(day: DateTime, minute: number) {
  const hour = Math.floor(minute / 60);
  const minuteOfHour = minute % 60;
  const local = DateTime.fromObject({
    year: day.year, month: day.month, day: day.day, hour, minute: minuteOfHour, second: 0, millisecond: 0,
  }, { zone: day.zoneName ?? 'UTC' });
  // Luxon advances a nonexistent spring-forward time to the next real clock
  // instant. That shifted value is not the time advertised by this slot.
  if (!local.isValid || local.toISODate() !== day.toISODate()
    || local.hour !== hour || local.minute !== minuteOfHour) return null;
  return local;
}

function rentalAmount(location: Pick<RentalLocation, 'rentalPrice'>, duration: number) {
  const amount = Math.round(location.rentalPrice * duration / 60);
  if (amount > postgresIntegerMax) throw new HttpError(409, 'This rental price cannot be represented safely');
  return amount;
}

function assertBookingWindow(location: RentalLocation, startAt: Date, duration: number, now = new Date()) {
  assertDuration(location, duration);
  if (!openingContains(location, startAt, duration)) throw new HttpError(409, 'This rental time is outside the venue opening hours');
  const earliest = now.getTime() + location.rentalNoticeHours * 3_600_000;
  if (startAt.getTime() < earliest) throw new HttpError(409, 'This rental time is inside the venue notice period');
  const nowLocal = DateTime.fromJSDate(now, { zone: location.business.timezone });
  const startLocal = DateTime.fromJSDate(startAt, { zone: location.business.timezone });
  if (startLocal.startOf('day') > nowLocal.startOf('day').plus({ days: location.rentalAdvanceDays })) {
    throw new HttpError(409, 'This rental time is beyond the venue advance-booking window');
  }
}

function overlaps(
  reservation: Pick<Prisma.VenueReservationGetPayload<Record<string, never>>, 'startAt' | 'endAt'>,
  startAt: Date, endAt: Date,
) {
  return reservation.startAt < endAt && reservation.endAt > startAt;
}

const slotsQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid calendar date'),
  duration: z.coerce.number().int(),
}).strict();

rentalsRouter.get('/rentals/:id/slots', accountRoute(async (req, res) => {
  const query = slotsQuery.parse(req.query);
  const location = await configuredLocation(prisma, idSchema.parse(req.params.id));
  if (!location || !isPublished(location)) throw new HttpError(404, 'Rental venue not found');
  assertDuration(location, query.duration);
  const day = localDay(query.date, location.business.timezone);
  const now = new Date();
  const localNow = DateTime.fromJSDate(now, { zone: location.business.timezone });
  if (day < localNow.startOf('day')
    || day > localNow.startOf('day').plus({ days: location.rentalAdvanceDays })) {
    res.json({ date: query.date, duration: query.duration, timezone: location.business.timezone, slots: [] });
    return;
  }
  const units = location.venueUnits.filter(unit => unit.active);
  const reservations = units.length ? await prisma.venueReservation.findMany({ where: {
    unitId: { in: units.map(unit => unit.id) }, status: { in: ['PENDING', 'CONFIRMED'] },
    startAt: { lt: day.plus({ days: 1 }).toJSDate() }, endAt: { gt: day.toJSDate() },
  } }) : [];
  const hours = location.openingHours.filter(hour => hour.dayOfWeek === day.weekday % 7);
  const slots: Array<{ unitId: string; unitName: string; startAt: string; endAt: string; price: number }> = [];
  const seen = new Set<string>();
  for (const unit of units) {
    for (const hour of hours) {
      const [startHour, startMinute] = hour.startTime.split(':').map(Number);
      const [endHour, endMinute] = hour.endTime.split(':').map(Number);
      const openingMinute = startHour * 60 + startMinute;
      const closingMinute = endHour * 60 + endMinute;
      const firstPatternMinute = openingMinute + ((location.rentalStartInterval
        - openingMinute % location.rentalStartInterval) % location.rentalStartInterval);
      for (let minute = firstPatternMinute; minute < closingMinute; minute += location.rentalStartInterval) {
        const localStart = localTimeAt(day, minute);
        if (!localStart) continue;
        const startAt = localStart.toJSDate();
        const endAt = new Date(startAt.getTime() + query.duration * 60_000);
        if (!openingContains(location, startAt, query.duration)) continue;
        if (startAt.getTime() < now.getTime() + location.rentalNoticeHours * 3_600_000) continue;
        if (reservations.some(reservation => reservation.unitId === unit.id && overlaps(reservation, startAt, endAt))) continue;
        const key = `${unit.id}:${startAt.toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({ unitId: unit.id, unitName: unit.name, startAt: startAt.toISOString(),
          endAt: endAt.toISOString(), price: rentalAmount(location, query.duration) });
      }
    }
  }
  slots.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.unitName.localeCompare(b.unitName));
  res.json({ date: query.date, duration: query.duration, timezone: location.business.timezone, slots });
}));

async function loadOwnedLocation(db: Db, locationId: string, businessId: string) {
  const location = await db.location.findFirst({ where: { id: locationId, businessId }, include: rentalInclude });
  if (!location) throw new HttpError(404, 'Location not found');
  if (location.type !== 'FACILITY') throw new HttpError(400, 'Only a facility location can be offered for rental');
  return location;
}

rentalsRouter.post('/rentals', accountRoute(async (req, res) => {
  const businessId = clubBusinessId(req);
  const input = createRentalInput.parse(req.body);
  validateConfig(input);
  const rental = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT id FROM "Location" WHERE id = ${input.locationId} AND "businessId" = ${businessId} FOR UPDATE`;
    const location = await loadOwnedLocation(tx, input.locationId, businessId);
    if (location.rentalEnabled) throw new HttpError(409, 'This location is already configured for rental');
    await lockVenueUnits(tx, location.venueUnits.map(unit => unit.id));
    await replaceUnits(tx, location, input.units);
    await replaceOpeningHours(tx, location, input.openingHours);
    return tx.location.update({ where: { id: location.id }, data: {
      rentalEnabled: true, sport: input.sport, rules: input.rules, amenities: JSON.stringify(input.amenities),
      rentalUnitLabel: input.unitLabel, rentalPrice: input.price, rentalStartInterval: input.startInterval,
      rentalMinDuration: input.minDuration, rentalBookingIncrement: input.durationIncrement,
      rentalMaxDuration: input.maxDuration, rentalNoticeHours: input.noticeHours,
      rentalAdvanceDays: input.advanceDays, rentalCancellationHours: input.cancellationHours,
    }, include: rentalInclude });
  });
  res.status(201).json({ rental: rentalDetail(rental, true) });
}));

rentalsRouter.patch('/rentals/:id', accountRoute(async (req, res) => {
  const businessId = clubBusinessId(req);
  const input = updateRentalInput.parse(req.body);
  const rental = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT id FROM "Location" WHERE id = ${req.params.id} AND "businessId" = ${businessId} FOR UPDATE`;
    const location = await loadOwnedLocation(tx, idSchema.parse(req.params.id), businessId);
    if (!location.rentalEnabled) throw new HttpError(409, 'Configure this location for rental before updating it');
    await lockVenueUnits(tx, location.venueUnits.map(unit => unit.id));
    const merged = {
      price: input.price ?? location.rentalPrice,
      minDuration: input.minDuration ?? location.rentalMinDuration,
      maxDuration: input.maxDuration ?? location.rentalMaxDuration,
      durationIncrement: input.durationIncrement ?? location.rentalBookingIncrement,
      units: input.units ?? location.venueUnits.map(unit => ({ id: unit.id, name: unit.name, active: unit.active })),
      openingHours: input.openingHours ?? location.openingHours.map(hour => ({
        dayOfWeek: hour.dayOfWeek, startTime: hour.startTime, endTime: hour.endTime,
      })),
    };
    validateConfig(merged);
    if (input.units) await replaceUnits(tx, location, input.units);
    if (input.openingHours) await replaceOpeningHours(tx, location, input.openingHours);
    return tx.location.update({ where: { id: location.id }, data: {
      ...(input.sport !== undefined ? { sport: input.sport } : {}),
      ...(input.rules !== undefined ? { rules: input.rules } : {}),
      ...(input.amenities !== undefined ? { amenities: JSON.stringify(input.amenities) } : {}),
      ...(input.unitLabel !== undefined ? { rentalUnitLabel: input.unitLabel } : {}),
      ...(input.price !== undefined ? { rentalPrice: input.price } : {}),
      ...(input.startInterval !== undefined ? { rentalStartInterval: input.startInterval } : {}),
      ...(input.minDuration !== undefined ? { rentalMinDuration: input.minDuration } : {}),
      ...(input.durationIncrement !== undefined ? { rentalBookingIncrement: input.durationIncrement } : {}),
      ...(input.maxDuration !== undefined ? { rentalMaxDuration: input.maxDuration } : {}),
      ...(input.noticeHours !== undefined ? { rentalNoticeHours: input.noticeHours } : {}),
      ...(input.advanceDays !== undefined ? { rentalAdvanceDays: input.advanceDays } : {}),
      ...(input.cancellationHours !== undefined ? { rentalCancellationHours: input.cancellationHours } : {}),
    }, include: rentalInclude });
  });
  res.json({ rental: rentalDetail(rental, true) });
}));

rentalsRouter.delete('/rentals/:id', accountRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const businessId = clubBusinessId(req);
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT id FROM "Location" WHERE id = ${req.params.id} AND "businessId" = ${businessId} FOR UPDATE`;
    const location = await loadOwnedLocation(tx, idSchema.parse(req.params.id), businessId);
    const activeOffer = await tx.packageOffer.findFirst({
      where: { businessId, active: true, rentalLocations: { some: { locationId: location.id } } }, select: { id: true },
    });
    if (activeOffer) {
      throw new HttpError(409, 'Archive package offers that use this rental venue before disabling it');
    }
    await lockVenueUnits(tx, location.venueUnits.map(unit => unit.id));
    const history = await tx.venueReservation.count({ where: { locationId: location.id, businessId } });
    if (!history) {
      await tx.venueOpeningHour.deleteMany({ where: { locationId: location.id, businessId } });
      await tx.venueUnit.deleteMany({ where: { locationId: location.id, businessId } });
    }
    await tx.location.update({ where: { id: location.id }, data: { rentalEnabled: false } });
  });
  res.json({ ok: true });
}));

const reservationInput = z.object({
  unitId: idSchema, startAt: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  duration: z.number().int(), idempotencyKey: z.string().trim().min(8).max(200),
  simulatedOutcome: z.enum(['SUCCEEDED', 'FAILED']), packageId: idSchema.optional(),
}).strict();

function rentalIntentReference(userId: string, locationId: string, input: z.infer<typeof reservationInput>) {
  const digest = createHash('sha256').update(JSON.stringify({
    userId, locationId, unitId: input.unitId, startAt: input.startAt.toISOString(), duration: input.duration,
    packageId: input.packageId ?? null, outcome: input.simulatedOutcome, idempotencyKey: input.idempotencyKey,
  })).digest('hex');
  return `sim_pi_${digest.slice(0, 48)}`;
}

async function loadIntentReservation(tx: Tx, intent: PaymentIntent) {
  if (!intent.reservationId) return null;
  const reservation = await tx.venueReservation.findUnique({ where: { id: intent.reservationId }, include: reservationInclude });
  if (!reservation) throw new HttpError(409, 'This rental checkout no longer has its reservation record');
  return reservation;
}

async function resolveStudent(tx: Tx, businessId: string, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-student:${businessId}:${userId}`}, 0))`;
  const linked = await tx.student.findFirst({ where: { businessId, userId } });
  if (linked) return linked;
  const account = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  const existing = await tx.student.findUnique({
    where: { businessId_email: { businessId, email: account.email } }, select: { userId: true },
  });
  if (existing) throw new HttpError(409, existing.userId
    ? 'This email is already connected to another student account for this club'
    : 'Ask the club to connect your existing student record before paying for a rental');
  return tx.student.create({ data: {
    businessId, userId, name: account.name, email: account.email, phone: account.phone,
    parentName: account.parentName, initials: initials(account.name),
  } });
}

async function eligiblePackage(tx: Tx, packageId: string, userId: string, location: RentalLocation, startAt: Date) {
  await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${packageId} FOR UPDATE`;
  const pkg = await tx.lessonPackage.findFirst({
    where: { id: packageId, businessId: location.businessId, student: { userId } },
    include: { rentalLocations: { where: { locationId: location.id }, select: { locationId: true } } },
  });
  if (!pkg) throw new HttpError(404, 'Rental package not found');
  if (!pkg.paid) throw new HttpError(409, 'This rental package has not been paid');
  if (pkg.expiresAt < startAt) throw new HttpError(409, 'This rental package expires before the selected time');
  if (!pkg.rentalLocations.length) throw new HttpError(409, 'This package does not cover the selected rental venue');
  if (pkg.usedCredits >= pkg.totalCredits) throw new HttpError(409, 'This rental package has no credits remaining');
  return pkg;
}

async function createReservation(req: AccountRequest, locationId: string, input: z.infer<typeof reservationInput>) {
  if (input.packageId && req.auth.user.accountType !== 'STUDENT') {
    throw new HttpError(403, 'Only a student account can redeem a rental package');
  }
  if (input.packageId && input.simulatedOutcome !== 'SUCCEEDED') {
    throw new HttpError(400, 'Package reservations do not simulate a card failure');
  }
  const providerReference = rentalIntentReference(req.auth.user.id, locationId, input);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-intent:${req.auth.user.id}:${input.idempotencyKey}`}, 0))`;
    const existing = await tx.paymentIntent.findUnique({
      where: { userId_idempotencyKey: { userId: req.auth.user.id, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      if (existing.kind !== 'RENTAL' || existing.providerReference !== providerReference) {
        throw new HttpError(409, 'This idempotency key was already used for a different rental checkout');
      }
      return { replay: true, reservation: await loadIntentReservation(tx, existing), paymentIntent: existing };
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`venue-unit:${input.unitId}`}, 0))`;
    const location = await configuredLocation(tx, locationId);
    if (!location || !isPublished(location)) throw new HttpError(404, 'Rental venue not found');
    const unit = location.venueUnits.find(candidate => candidate.id === input.unitId && candidate.active);
    if (!unit) throw new HttpError(404, 'Rental unit not found at this venue');
    assertBookingWindow(location, input.startAt, input.duration);
    const endAt = new Date(input.startAt.getTime() + input.duration * 60_000);
    const conflict = await tx.venueReservation.findFirst({ where: {
      unitId: unit.id, status: { in: ['PENDING', 'CONFIRMED'] }, startAt: { lt: endAt }, endAt: { gt: input.startAt },
    }, select: { id: true } });
    if (conflict) throw new HttpError(409, 'This rental unit was just reserved. Choose another time');
    const amount = rentalAmount(location, input.duration);
    const now = new Date();
    if (amount === 0 && input.simulatedOutcome === 'FAILED') {
      throw new HttpError(400, 'A free rental has no card payment to fail');
    }
    if (amount === 0 && input.packageId) {
      throw new HttpError(400, 'A free rental does not consume a package credit');
    }
    if (input.simulatedOutcome === 'FAILED') {
      const intent = await tx.paymentIntent.create({ data: {
        userId: req.auth.user.id, businessId: location.businessId, kind: 'RENTAL', amount,
        currency: location.business.currency, status: 'FAILED', providerReference,
        idempotencyKey: input.idempotencyKey, failedAt: now,
      } });
      return { replay: false, reservation: null, paymentIntent: intent };
    }

    const pkg = input.packageId
      ? await eligiblePackage(tx, input.packageId, req.auth.user.id, location, input.startAt)
      : null;
    if (pkg) {
      const consumed = await tx.lessonPackage.updateMany({
        where: { id: pkg.id, usedCredits: { lt: pkg.totalCredits } }, data: { usedCredits: { increment: 1 } },
      });
      if (!consumed.count) throw new HttpError(409, 'This rental package has no credits remaining');
    }
    const reservation = await tx.venueReservation.create({ data: {
      businessId: location.businessId, locationId: location.id, unitId: unit.id, userId: req.auth.user.id,
      startAt: input.startAt, endAt, duration: input.duration, price: amount, status: 'CONFIRMED',
      paymentStatus: pkg ? 'PACKAGE' : 'PAID', packageId: pkg?.id ?? null, creditConsumed: !!pkg,
      notes: JSON.stringify({ cancellationHours: location.rentalCancellationHours, unitName: unit.name }),
    }, include: reservationInclude });
    const intent = await tx.paymentIntent.create({ data: {
      userId: req.auth.user.id, businessId: location.businessId, kind: 'RENTAL', reservationId: reservation.id,
      amount: pkg ? 0 : amount, currency: location.business.currency, status: 'SUCCEEDED', providerReference,
      idempotencyKey: input.idempotencyKey, confirmedAt: now,
    } });
    if (!pkg && amount > 0 && req.auth.user.accountType === 'STUDENT') {
      const student = await resolveStudent(tx, location.businessId, req.auth.user.id);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${student.id}`}, 0))`;
      await tx.payment.create({ data: {
        businessId: location.businessId, studentId: student.id, paymentIntentId: intent.id,
        kind: 'STUDENT_TO_CLUB', amount, method: 'SIMULATED_STRIPE', note: `Online venue rental · ${location.name}`,
      } });
    }
    // The legacy Payment ledger only represents a student payer or a coach
    // payee. For coach and club renters the intent is therefore the complete
    // financial audit record; fabricating a Student row would corrupt identity.
    return { replay: false, reservation, paymentIntent: intent };
  }, { timeout: 30_000 });
}

function isReservationConflict(error: unknown) {
  const detail = error instanceof Prisma.PrismaClientKnownRequestError
    ? `${error.message} ${JSON.stringify(error.meta ?? {})}`
    : error instanceof Error ? error.message : '';
  return /VenueReservation_active_unit_overlap|23P01|exclusion constraint/u.test(detail);
}

rentalsRouter.post('/rentals/:id/reservations', accountRoute(async (req, res) => {
  const input = reservationInput.parse(req.body);
  let result: Awaited<ReturnType<typeof createReservation>>;
  try {
    result = await createReservation(req, idSchema.parse(req.params.id), input);
  } catch (error) {
    if (isReservationConflict(error)) throw new HttpError(409, 'This rental unit was just reserved. Choose another time');
    throw error;
  }
  res.status(result.replay ? 200 : 201).json({
    reservation: result.reservation ? reservationJson(result.reservation) : null,
    paymentIntent: paymentIntentJson(result.paymentIntent),
  });
}));

rentalsRouter.post('/rentals/reservations/:id/cancel', accountRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const reservation = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`venue-reservation:${req.params.id}`}, 0))`;
    const current = await tx.venueReservation.findFirst({
      where: { id: idSchema.parse(req.params.id), userId: req.auth.user.id }, include: reservationInclude,
    });
    if (!current) throw new HttpError(404, 'Rental reservation not found');
    if (current.status === 'CANCELLED' || current.cancelledAt) throw new HttpError(409, 'This rental reservation is already cancelled');
    const deadline = current.startAt.getTime() - reservationSnapshot(current).cancellationHours * 3_600_000;
    if (Date.now() > deadline) throw new HttpError(409, 'The cancellation window for this rental has closed');

    if (current.packageId && current.creditConsumed) {
      await tx.$queryRaw`SELECT id FROM "LessonPackage" WHERE id = ${current.packageId} FOR UPDATE`;
      const restored = await tx.lessonPackage.updateMany({
        where: { id: current.packageId, businessId: current.businessId, usedCredits: { gt: 0 } },
        data: { usedCredits: { decrement: 1 } },
      });
      if (!restored.count) throw new HttpError(409, 'The rental package credit could not be restored safely');
    }
    const intents = await tx.paymentIntent.findMany({
      where: { reservationId: current.id, businessId: current.businessId }, include: { payment: true },
    });
    const now = new Date();
    for (const intent of intents) {
      if (intent.payment && !intent.payment.reversedAt) {
        if (!intent.payment.studentId) throw new HttpError(409, 'This rental payment cannot be reversed safely');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${intent.payment.studentId}`}, 0))`;
        const payment = await tx.payment.findUnique({ where: { id: intent.payment.id } });
        if (payment && !payment.reversedAt) {
          await tx.payment.update({ where: { id: payment.id }, data: {
            reversedAt: now, reversedByUserId: req.auth.user.id, reversedReason: 'Rental reservation cancelled',
          } });
        }
      }
      if (intent.status === 'SUCCEEDED') {
        await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'REFUNDED' } });
      }
    }
    return tx.venueReservation.update({ where: { id: current.id }, data: {
      status: 'CANCELLED', paymentStatus: 'REFUNDED', creditConsumed: false, cancelledAt: now,
    }, include: reservationInclude });
  }, { timeout: 30_000 });
  res.json({ reservation: reservationJson(reservation) });
}));
