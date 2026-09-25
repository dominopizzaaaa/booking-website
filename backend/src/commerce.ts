import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { requireAuth, requireStudent, requireWorkspace } from './auth.js';
import { asyncRoute, HttpError, initials, requireClubAccount } from './http.js';
import { notifyWorkspace } from './notifications.js';
import { createBookingAccountAlerts } from './account-notifications.js';
import { lockInstructors } from './scheduling.js';

export const commerceRouter = Router();

type Tx = Prisma.TransactionClient;

const id = z.string().trim().min(1).max(200);
const offerFields = {
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).default(''),
  price: z.number().int().positive().max(100_000_000),
  totalCredits: z.number().int().min(1).max(1000),
  validityDays: z.number().int().min(1).max(3650),
  active: z.boolean().default(true),
  serviceIds: z.array(id).max(100).default([]),
  rentalLocationIds: z.array(id).max(100).default([]),
};
const offerCreate = z.object(offerFields).strict().superRefine((value, context) => {
  if (!value.serviceIds.length && !value.rentalLocationIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceIds'], message: 'Choose at least one service or rental venue' });
  }
  if (new Set(value.serviceIds).size !== value.serviceIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceIds'], message: 'Service scopes must be unique' });
  }
  if (new Set(value.rentalLocationIds).size !== value.rentalLocationIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['rentalLocationIds'], message: 'Rental venue scopes must be unique' });
  }
});
const offerPatch = z.object({
  name: offerFields.name.optional(),
  description: offerFields.description.optional(),
  price: offerFields.price.optional(),
  totalCredits: offerFields.totalCredits.optional(),
  validityDays: offerFields.validityDays.optional(),
  active: offerFields.active.optional(),
  serviceIds: offerFields.serviceIds.optional(),
  rentalLocationIds: offerFields.rentalLocationIds.optional(),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'Provide at least one package offer field to update' })
  .superRefine((value, context) => {
    if (value.serviceIds && new Set(value.serviceIds).size !== value.serviceIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceIds'], message: 'Service scopes must be unique' });
    }
    if (value.rentalLocationIds && new Set(value.rentalLocationIds).size !== value.rentalLocationIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['rentalLocationIds'], message: 'Rental venue scopes must be unique' });
    }
  });
const accountOffersQuery = z.object({ businessSlug: z.string().trim().min(1).max(200) }).strict();
const checkoutInput = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  simulatedOutcome: z.enum(['SUCCEEDED', 'FAILED']),
}).strict();

const offerInclude = {
  business: { select: { name: true, slug: true, currency: true, kind: true, isDemo: true, legacyReadOnly: true } },
  services: { include: { service: { select: { id: true, name: true } } }, orderBy: { serviceId: 'asc' as const } },
  rentalLocations: { include: { location: { select: { id: true, name: true } } }, orderBy: { locationId: 'asc' as const } },
} satisfies Prisma.PackageOfferInclude;
type OfferWithScopes = Prisma.PackageOfferGetPayload<{ include: typeof offerInclude }>;

const packageInclude = {
  business: { select: { name: true, slug: true, currency: true } },
  offer: { select: { id: true, name: true } },
  services: { include: { service: { select: { id: true, name: true } } }, orderBy: { serviceId: 'asc' as const } },
  rentalLocations: { include: { location: { select: { id: true, name: true } } }, orderBy: { locationId: 'asc' as const } },
} satisfies Prisma.LessonPackageInclude;
type PackageWithScopes = Prisma.LessonPackageGetPayload<{ include: typeof packageInclude }>;

function offerJson(offer: OfferWithScopes) {
  const services = offer.services.map(scope => scope.service);
  const rentalLocations = offer.rentalLocations.map(scope => scope.location);
  return {
    id: offer.id, businessId: offer.businessId, name: offer.name, description: offer.description,
    price: offer.price, totalCredits: offer.totalCredits, validityDays: offer.validityDays, active: offer.active,
    createdAt: offer.createdAt.toISOString(), updatedAt: offer.updatedAt.toISOString(),
    business: { name: offer.business.name, slug: offer.business.slug, currency: offer.business.currency },
    serviceIds: services.map(service => service.id),
    rentalLocationIds: rentalLocations.map(location => location.id), services, rentalLocations,
  };
}

function packageState(pkg: Pick<PackageWithScopes, 'paid' | 'usedCredits' | 'totalCredits' | 'expiresAt'>, now = new Date()) {
  if (!pkg.paid) return 'UNPAID' as const;
  if (pkg.expiresAt < now) return 'EXPIRED' as const;
  if (pkg.usedCredits >= pkg.totalCredits) return 'EXHAUSTED' as const;
  return 'ACTIVE' as const;
}

export function accountPackageJson(pkg: PackageWithScopes) {
  const services = pkg.services.map(scope => scope.service);
  const rentalLocations = pkg.rentalLocations.map(scope => scope.location);
  return {
    id: pkg.id, businessId: pkg.businessId, offerId: pkg.offerId, name: pkg.name,
    serviceId: pkg.serviceId, totalCredits: pkg.totalCredits, usedCredits: pkg.usedCredits,
    remainingCredits: Math.max(0, pkg.totalCredits - pkg.usedCredits), price: pkg.price,
    expiresAt: pkg.expiresAt.toISOString(), paid: pkg.paid, state: packageState(pkg),
    business: pkg.business, offer: pkg.offer, serviceIds: services.map(service => service.id),
    rentalLocationIds: rentalLocations.map(location => location.id), services, rentalLocations,
  };
}

type IntentResult = Prisma.PaymentIntentGetPayload<Record<string, never>>;
function paymentIntentJson(intent: IntentResult) {
  return {
    id: intent.id, kind: intent.kind, status: intent.status, amount: intent.amount, currency: intent.currency,
    provider: intent.provider, providerReference: intent.providerReference,
    idempotencyKey: intent.idempotencyKey, failureCode: intent.status === 'FAILED' ? 'SIMULATED_FAILURE' : null,
    packageOfferId: intent.packageOfferId, packageId: intent.packageId, participantId: intent.participantId,
    reservationId: intent.reservationId, createdAt: intent.createdAt.toISOString(),
    confirmedAt: intent.confirmedAt?.toISOString() ?? null, failedAt: intent.failedAt?.toISOString() ?? null,
  };
}

type CheckoutParticipant = Prisma.ParticipantGetPayload<{ include: { student: { select: { name: true; email: true } } } }>;
function checkoutParticipantJson(participant: CheckoutParticipant) {
  return {
    id: participant.id, bookingId: participant.bookingId, studentId: participant.studentId, name: participant.student.name,
    email: participant.student.email, attendance: participant.attendance, paid: participant.paid,
    price: participant.price, packageId: participant.packageId, notes: participant.notes,
    cancelled: !!participant.cancelledAt, cancelledAt: participant.cancelledAt?.toISOString() ?? null,
  };
}

async function validateOfferScopes(
  tx: Tx, businessId: string, serviceIds: string[], rentalLocationIds: string[],
) {
  if (!serviceIds.length && !rentalLocationIds.length) throw new HttpError(400, 'Choose at least one service or rental venue');
  const [serviceCount, locations] = await Promise.all([
    serviceIds.length ? tx.service.count({ where: { id: { in: serviceIds }, businessId, active: true } }) : 0,
    rentalLocationIds.length ? tx.location.findMany({
      where: { id: { in: rentalLocationIds }, businessId, active: true }, select: { id: true, rentalEnabled: true },
    }) : [],
  ]);
  if (serviceCount !== serviceIds.length) throw new HttpError(400, 'Every package service must be active and belong to this club');
  if (locations.length !== rentalLocationIds.length || locations.some(location => !location.rentalEnabled)) {
    throw new HttpError(400, 'Every package rental venue must be an active rentable facility in this club');
  }
}

async function replaceOfferScopes(
  tx: Tx, offerId: string, businessId: string, serviceIds: string[], rentalLocationIds: string[],
) {
  await tx.packageOfferService.deleteMany({ where: { offerId, businessId } });
  await tx.packageOfferLocation.deleteMany({ where: { offerId, businessId } });
  if (serviceIds.length) await tx.packageOfferService.createMany({
    data: serviceIds.map(serviceId => ({ offerId, serviceId, businessId })),
  });
  if (rentalLocationIds.length) await tx.packageOfferLocation.createMany({
    data: rentalLocationIds.map(locationId => ({ offerId, locationId, businessId })),
  });
}

commerceRouter.get('/package-offers', requireAuth, requireWorkspace, requireClubAccount, asyncRoute(async (req, res) => {
  const offers = await prisma.packageOffer.findMany({
    where: { businessId: req.auth.business.id }, include: offerInclude,
    orderBy: [{ active: 'desc' }, { createdAt: 'desc' }, { name: 'asc' }],
  });
  res.json({ offers: offers.map(offerJson) });
}));

commerceRouter.post('/package-offers', requireAuth, requireWorkspace, requireClubAccount, asyncRoute(async (req, res) => {
  const input = offerCreate.parse(req.body);
  const offer = await prisma.$transaction(async tx => {
    await validateOfferScopes(tx, req.auth.business.id, input.serviceIds, input.rentalLocationIds);
    return tx.packageOffer.create({ data: {
      businessId: req.auth.business.id, name: input.name, description: input.description, price: input.price,
      totalCredits: input.totalCredits, validityDays: input.validityDays, active: input.active,
      services: { create: input.serviceIds.map(serviceId => ({ serviceId })) },
      rentalLocations: { create: input.rentalLocationIds.map(locationId => ({ locationId })) },
    }, include: offerInclude });
  });
  res.status(201).json(offerJson(offer));
}));

commerceRouter.patch('/package-offers/:id', requireAuth, requireWorkspace, requireClubAccount, asyncRoute(async (req, res) => {
  const input = offerPatch.parse(req.body);
  const offer = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PackageOffer" WHERE id = ${req.params.id} AND "businessId" = ${req.auth.business.id} FOR UPDATE`;
    const current = await tx.packageOffer.findFirst({
      where: { id: req.params.id, businessId: req.auth.business.id },
      include: { services: true, rentalLocations: true },
    });
    if (!current) throw new HttpError(404, 'Package offer not found');
    const serviceIds = input.serviceIds ?? current.services.map(scope => scope.serviceId);
    const rentalLocationIds = input.rentalLocationIds ?? current.rentalLocations.map(scope => scope.locationId);
    await validateOfferScopes(tx, req.auth.business.id, serviceIds, rentalLocationIds);
    if (input.price !== undefined && input.price !== current.price) {
      const completedSales = await tx.paymentIntent.count({
        where: {
          businessId: req.auth.business.id, packageOfferId: current.id, kind: 'PACKAGE',
          status: { in: ['SUCCEEDED', 'REFUNDED'] },
        },
      });
      if (completedSales) {
        throw new HttpError(409, 'The price of a package offer cannot change after its first sale');
      }
    }
    if (input.serviceIds || input.rentalLocationIds) {
      await replaceOfferScopes(tx, current.id, req.auth.business.id, serviceIds, rentalLocationIds);
    }
    return tx.packageOffer.update({
      where: { id: current.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.totalCredits !== undefined ? { totalCredits: input.totalCredits } : {}),
        ...(input.validityDays !== undefined ? { validityDays: input.validityDays } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
      },
      include: offerInclude,
    });
  });
  res.json(offerJson(offer));
}));

commerceRouter.delete('/package-offers/:id', requireAuth, requireWorkspace, requireClubAccount, asyncRoute(async (req, res) => {
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PackageOffer" WHERE id = ${req.params.id} AND "businessId" = ${req.auth.business.id} FOR UPDATE`;
    const offer = await tx.packageOffer.findFirst({ where: { id: req.params.id, businessId: req.auth.business.id } });
    if (!offer) throw new HttpError(404, 'Package offer not found');
    const [packages, intents] = await Promise.all([
      tx.lessonPackage.count({ where: { offerId: offer.id, businessId: req.auth.business.id } }),
      tx.paymentIntent.count({ where: { packageOfferId: offer.id, businessId: req.auth.business.id } }),
    ]);
    if (packages || intents) {
      await tx.packageOffer.update({ where: { id: offer.id }, data: { active: false } });
      return { deleted: false, archived: true };
    }
    await tx.packageOffer.delete({ where: { id: offer.id } });
    return { deleted: true, archived: false };
  });
  res.json(result);
}));

commerceRouter.get('/account/package-offers', requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const query = accountOffersQuery.parse(req.query);
  const business = await prisma.business.findFirst({
    where: { slug: query.businessSlug, kind: 'CLUB', isDemo: false, legacyReadOnly: false },
    select: { id: true, name: true, slug: true, currency: true },
  });
  if (!business) throw new HttpError(404, 'Club not found');
  const offers = await prisma.packageOffer.findMany({
    where: { businessId: business.id, active: true }, include: offerInclude, orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
  });
  res.json({ business: { name: business.name, slug: business.slug, currency: business.currency }, offers: offers.map(offerJson) });
}));

commerceRouter.get('/account/packages', requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const packages = await prisma.lessonPackage.findMany({
    where: { student: { userId: req.auth.user.id } }, include: packageInclude,
    orderBy: [{ expiresAt: 'asc' }, { name: 'asc' }],
  });
  res.json({ packages: packages.map(accountPackageJson) });
}));

type ReplayTarget =
  | { kind: 'PACKAGE'; packageOfferId: string; participantId: null }
  | { kind: 'BOOKING'; packageOfferId: null; participantId: string };

function assertMatchingReplay(intent: IntentResult, target: ReplayTarget, outcome: 'SUCCEEDED' | 'FAILED') {
  // A refund is a later lifecycle transition of an originally successful
  // checkout. It must not make an exact retry look like a different request.
  const matchesOriginalOutcome = outcome === 'SUCCEEDED'
    ? intent.status === 'SUCCEEDED' || intent.status === 'REFUNDED'
    : intent.status === 'FAILED';
  if (intent.kind !== target.kind || intent.packageOfferId !== target.packageOfferId
    || intent.participantId !== target.participantId || !matchesOriginalOutcome) {
    throw new HttpError(409, 'This idempotency key was already used for a different checkout');
  }
}

async function replayResult(tx: Tx, intent: IntentResult) {
  const pkg = intent.packageId ? await tx.lessonPackage.findUnique({ where: { id: intent.packageId }, include: packageInclude }) : null;
  const participant = intent.participantId ? await tx.participant.findUnique({
    where: { id: intent.participantId }, include: { student: { select: { name: true, email: true } } },
  }) : null;
  return {
    paymentIntent: paymentIntentJson(intent), package: pkg ? accountPackageJson(pkg) : null,
    participant: participant ? checkoutParticipantJson(participant) : null,
  };
}

async function findReplay(tx: Tx, userId: string, idempotencyKey: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-intent:${userId}:${idempotencyKey}`}, 0))`;
  return tx.paymentIntent.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
}

commerceRouter.post('/account/package-offers/:id/checkout', requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const input = checkoutInput.parse(req.body);
  const result = await prisma.$transaction(async tx => {
    const existing = await findReplay(tx, req.auth.user.id, input.idempotencyKey);
    const target = { kind: 'PACKAGE' as const, packageOfferId: req.params.id, participantId: null };
    if (existing) {
      assertMatchingReplay(existing, target, input.simulatedOutcome);
      return { replay: true, body: await replayResult(tx, existing) };
    }
    await tx.$queryRaw`SELECT id FROM "PackageOffer" WHERE id = ${req.params.id} FOR UPDATE`;
    const offer = await tx.packageOffer.findFirst({ where: { id: req.params.id, active: true }, include: offerInclude });
    if (!offer || offer.business.kind !== 'CLUB' || offer.business.isDemo || offer.business.legacyReadOnly) {
      throw new HttpError(404, 'Package offer not found');
    }
    await validateOfferScopes(
      tx, offer.businessId, offer.services.map(scope => scope.serviceId),
      offer.rentalLocations.map(scope => scope.locationId),
    );
    const now = new Date();
    if (input.simulatedOutcome === 'FAILED') {
      const intent = await tx.paymentIntent.create({ data: {
        userId: req.auth.user.id, businessId: offer.businessId, kind: 'PACKAGE', packageOfferId: offer.id,
        amount: offer.price, currency: offer.business.currency, status: 'FAILED', providerReference: `sim_pi_${randomUUID()}`,
        idempotencyKey: input.idempotencyKey, failedAt: now,
      } });
      return { replay: false, body: await replayResult(tx, intent) };
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-student:${offer.businessId}:${req.auth.user.id}`}, 0))`;
    let student = await tx.student.findFirst({ where: { businessId: offer.businessId, userId: req.auth.user.id } });
    if (!student) {
      const account = await tx.user.findUniqueOrThrow({ where: { id: req.auth.user.id } });
      const conflicting = await tx.student.findUnique({
        where: { businessId_email: { businessId: offer.businessId, email: account.email } }, select: { userId: true },
      });
      if (conflicting) throw new HttpError(409, 'Ask the club to connect your existing student record before buying a package');
      student = await tx.student.create({ data: {
        businessId: offer.businessId, userId: account.id, name: account.name, email: account.email,
        phone: account.phone, parentName: account.parentName, initials: initials(account.name),
      } });
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${student.id}`}, 0))`;
    const expiresAt = new Date(now.getTime() + offer.validityDays * 86_400_000);
    const pkg = await tx.lessonPackage.create({ data: {
      businessId: offer.businessId, studentId: student.id, offerId: offer.id, name: offer.name, serviceId: null,
      totalCredits: offer.totalCredits, usedCredits: 0, price: offer.price, expiresAt, paid: true,
      services: { create: offer.services.map(scope => ({ serviceId: scope.serviceId })) },
      rentalLocations: { create: offer.rentalLocations.map(scope => ({ locationId: scope.locationId })) },
    }, include: packageInclude });
    const intent = await tx.paymentIntent.create({ data: {
      userId: req.auth.user.id, businessId: offer.businessId, kind: 'PACKAGE', packageOfferId: offer.id, packageId: pkg.id,
      amount: offer.price, currency: offer.business.currency, status: 'SUCCEEDED', providerReference: `sim_pi_${randomUUID()}`,
      idempotencyKey: input.idempotencyKey, confirmedAt: now,
    } });
    await tx.payment.create({ data: {
      businessId: offer.businessId, studentId: student.id, packageId: pkg.id, paymentIntentId: intent.id,
      kind: 'STUDENT_TO_CLUB', amount: offer.price, method: 'SIMULATED_STRIPE', note: `Online checkout for ${offer.name}`,
    } });
    await notifyWorkspace(tx, {
      businessId: offer.businessId, type: 'PAYMENT', title: `Package purchased · ${student.name}`,
      message: `${student.name} bought ${offer.name} for ${offer.business.currency} ${(offer.price / 100).toFixed(2)} through simulated Stripe checkout.`,
    });
    await tx.accountNotification.create({ data: {
      userId: req.auth.user.id, businessId: offer.businessId, type: 'PAYMENT_RECORDED',
      title: 'Package purchase confirmed', message: `${offer.name} is ready to use. ${offer.totalCredits} credits expire on ${expiresAt.toISOString().slice(0, 10)}.`,
    } });
    return { replay: false, body: { paymentIntent: paymentIntentJson(intent), package: accountPackageJson(pkg), participant: null } };
  }, { timeout: 30_000 });
  res.status(result.replay ? 200 : 201).json(result.body);
}));

commerceRouter.post('/account/bookings/:participantId/checkout', requireAuth, requireStudent, asyncRoute(async (req, res) => {
  const input = checkoutInput.parse(req.body);
  const result = await prisma.$transaction(async tx => {
    const existing = await findReplay(tx, req.auth.user.id, input.idempotencyKey);
    const target = { kind: 'BOOKING' as const, packageOfferId: null, participantId: req.params.participantId };
    if (existing) {
      assertMatchingReplay(existing, target, input.simulatedOutcome);
      return { replay: true, body: await replayResult(tx, existing) };
    }
    const initial = await tx.participant.findFirst({
      where: { id: req.params.participantId, student: { userId: req.auth.user.id } },
      select: { id: true, studentId: true, booking: { select: { instructorId: true } } },
    });
    if (!initial) throw new HttpError(404, 'Booking participant not found');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment:${initial.studentId}`}, 0))`;
    // Provider cancellation uses the same instructor lock and reloads the
    // booking afterwards. Taking it before our own reload prevents checkout
    // from charging a lesson that was cancelled while this request waited.
    await lockInstructors(tx, [initial.booking.instructorId]);
    await tx.$queryRaw`SELECT id FROM "Participant" WHERE id = ${req.params.participantId} FOR UPDATE`;
    const participant = await tx.participant.findFirst({
      where: { id: req.params.participantId, studentId: initial.studentId, student: { userId: req.auth.user.id } },
      include: {
        student: true,
        booking: { include: { business: { select: { name: true, currency: true, kind: true, isDemo: true, legacyReadOnly: true } } } },
      },
    });
    if (!participant) throw new HttpError(404, 'Booking participant not found');
    if (participant.booking.instructorId !== initial.booking.instructorId) {
      throw new HttpError(409, 'Session changed. Please retry.');
    }
    if (participant.booking.status === 'CANCELLED') throw new HttpError(409, 'Cancelled bookings cannot be paid');
    if (participant.booking.paymentRoute !== 'CLUB' || participant.booking.business.kind !== 'CLUB'
      || participant.booking.business.isDemo || participant.booking.business.legacyReadOnly) {
      throw new HttpError(409, 'This historical booking is read-only and cannot receive a new payment');
    }
    if (participant.cancelledAt) throw new HttpError(409, 'Cancelled bookings cannot be paid');
    if (participant.packageId) throw new HttpError(409, 'This booking is already covered by a package');
    if (participant.paid) throw new HttpError(409, 'This booking is already paid');
    const collected = await tx.payment.aggregate({
      where: {
        bookingId: participant.bookingId, studentId: participant.studentId,
        kind: { not: 'CLUB_TO_COACH' }, reversedAt: null,
      },
      _sum: { amount: true },
    });
    const outstanding = participant.price - (collected._sum.amount ?? 0);
    if (outstanding <= 0) throw new HttpError(409, 'This booking is already paid');
    const now = new Date();
    if (input.simulatedOutcome === 'FAILED') {
      const intent = await tx.paymentIntent.create({ data: {
        userId: req.auth.user.id, businessId: participant.booking.businessId, kind: 'BOOKING', participantId: participant.id,
        amount: outstanding, currency: participant.booking.business.currency, status: 'FAILED',
        providerReference: `sim_pi_${randomUUID()}`, idempotencyKey: input.idempotencyKey, failedAt: now,
      } });
      return { replay: false, body: await replayResult(tx, intent) };
    }
    const intent = await tx.paymentIntent.create({ data: {
      userId: req.auth.user.id, businessId: participant.booking.businessId, kind: 'BOOKING', participantId: participant.id,
      amount: outstanding, currency: participant.booking.business.currency, status: 'SUCCEEDED',
      providerReference: `sim_pi_${randomUUID()}`, idempotencyKey: input.idempotencyKey, confirmedAt: now,
    } });
    await tx.payment.create({ data: {
      businessId: participant.booking.businessId, studentId: participant.studentId, bookingId: participant.bookingId,
      paymentIntentId: intent.id, kind: 'STUDENT_TO_CLUB', amount: outstanding, method: 'SIMULATED_STRIPE', note: 'Online lesson checkout',
    } });
    const paid = await tx.participant.update({
      where: { id: participant.id }, data: { paid: true },
      include: { student: { select: { name: true, email: true } } },
    });
    await notifyWorkspace(tx, {
      businessId: participant.booking.businessId, bookingId: participant.bookingId, type: 'PAYMENT',
      title: `Payment received · ${participant.student.name}`,
      message: `${participant.student.name} paid ${participant.booking.business.currency} ${(outstanding / 100).toFixed(2)} through simulated Stripe checkout.`,
    });
    await createBookingAccountAlerts(tx, participant.bookingId, 'PAYMENT_RECORDED', [req.auth.user.id]);
    return {
      replay: false,
      body: { paymentIntent: paymentIntentJson(intent), package: null, participant: checkoutParticipantJson(paid) },
    };
  }, { timeout: 30_000 });
  res.status(result.replay ? 200 : 201).json(result.body);
}));
