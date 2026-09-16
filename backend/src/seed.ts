import type { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';

export type SeedBusinessOptions = {
  slug?: string;
  isDemo?: boolean;
  ownerEmail?: string;
  businessName?: string;
};

const timezone = 'Asia/Singapore';
const initials = (name: string) => name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();

// A client starts an atomic seed; an existing transaction remains owned by its caller.
export async function seedBusiness(prismaOrTx: PrismaClient | Prisma.TransactionClient, options: SeedBusinessOptions = {}) {
  const password = (!options.isDemo && process.env.SEED_OWNER_PASSWORD) || randomBytes(32).toString('base64url');
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('SEED_OWNER_PASSWORD must contain at least 8 characters and at most 72 UTF-8 bytes.');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  if ('$transaction' in prismaOrTx) {
    return prismaOrTx.$transaction(tx => populateBusiness(tx, options, passwordHash), { timeout: 60_000 });
  }
  return populateBusiness(prismaOrTx, options, passwordHash);
}

async function populateBusiness(tx: Prisma.TransactionClient, options: SeedBusinessOptions, passwordHash: string) {
  const now = DateTime.now().setZone(timezone);
  const weekStart = now.startOf('week');
  const todayIndex = now.weekday - 1;
  const tenantKey = randomBytes(12).toString('hex');
  const email = options.ownerEmail?.trim().toLowerCase() || `marcus+${tenantKey}@courtly.example`;
  const business = await tx.business.create({
    data: {
      name: options.businessName?.trim() || 'Marcus Tan Racket Club',
      slug: options.slug || `marcus-tan-${tenantKey}`,
      ownerName: 'Marcus Tan',
      email,
      timezone,
      currency: 'SGD',
      color: '#214e3e',
      tagline: 'Good coaching. Great possibilities.',
      cancellationHours: 24,
      isDemo: options.isDemo ?? false,
      createdAt: now.minus({ months: 6 }).toJSDate(),
    },
  });
  const businessId = business.id;
  const instructors = await Promise.all([
    { name: 'Marcus Tan', color: '#527a5b', email, specialty: 'Tennis · technique and match play' },
    { name: 'Sarah Lim', color: '#5c7f91', email: `sarah+${tenantKey}@courtly.example`, specialty: 'Junior tennis · confidence and fundamentals' },
    { name: 'Daniel Lee', color: '#b1854f', email: `daniel+${tenantKey}@courtly.example`, specialty: 'Badminton · footwork and doubles' },
  ].map(instructor => tx.instructor.create({ data: { businessId, ...instructor, initials: initials(instructor.name) } })));
  const owner = await tx.user.create({
    data: { businessId, name: 'Marcus Tan', email, passwordHash, role: 'OWNER', instructorId: instructors[0].id, createdAt: business.createdAt },
  });

  const locations = await Promise.all([
    { name: 'Kallang Tennis Centre', address: '52 Stadium Road, Singapore 397724', type: 'FACILITY', color: '#78915e', requiresApproval: false, travelMinutes: 20, notes: 'Meet beside the main entrance. Court reservations are arranged separately.' },
    { name: 'OCBC Arena', address: '5 Stadium Drive, Singapore 397631', type: 'RENTED', color: '#6f91a6', requiresApproval: true, travelMinutes: 20, notes: 'Rented badminton courts require venue confirmation. A Courtly booking does not reserve an external court.' },
    { name: 'Tanglin Club', address: '5 Stevens Road, Singapore 257814', type: 'FACILITY', color: '#b08a4f', requiresApproval: false, travelMinutes: 30, notes: 'Member or guest access required. Allow time to check in at reception.' },
    { name: 'Online', address: 'Online coaching · joining details shared after confirmation', type: 'ONLINE', color: '#84739c', requiresApproval: false, travelMinutes: 0, notes: 'Video technique review. Bring a recent recording and a little space to move.' },
  ].map(location => tx.location.create({ data: { businessId, ...location } })));

  const serviceDefinitions = [
    {
      name: 'Private Tennis', description: 'A one-to-one lesson built around your game. Online sessions focus on video analysis and technique.',
      category: 'Tennis', type: 'PRIVATE', duration: 60, price: 95, capacity: 1, bufferMinutes: 10, color: '#78915e',
      assignments: [
        { location: 0, price: 95, duration: 60, instructors: [0, 1] },
        { location: 2, price: 115, duration: 60, instructors: [0, 1] },
        { location: 3, price: 55, duration: 45, instructors: [0, 1] },
      ],
    },
    {
      name: 'Junior Tennis Group', description: 'Small-group tennis for young players: movement, rallies and plenty of encouragement.',
      category: 'Tennis', type: 'GROUP', duration: 60, price: 40, capacity: 6, bufferMinutes: 10, color: '#6f91a6',
      assignments: [
        { location: 0, price: 40, duration: 60, instructors: [1, 0] },
        { location: 2, price: 45, duration: 60, instructors: [1, 0] },
      ],
    },
    {
      name: 'Badminton Fundamentals', description: 'Build your footwork, serve and shot selection with a friendly small group.',
      category: 'Badminton', type: 'GROUP', duration: 60, price: 40, capacity: 4, bufferMinutes: 10, color: '#b08a4f',
      assignments: [{ location: 1, price: 40, duration: 60, instructors: [2] }],
    },
    {
      name: 'Match Play', description: 'Guided point play, doubles patterns and practical tactics for your next match.',
      category: 'Tennis', type: 'GROUP', duration: 90, price: 55, capacity: 4, bufferMinutes: 15, color: '#84739c',
      assignments: [
        { location: 0, price: 55, duration: 90, instructors: [0, 1] },
        { location: 2, price: 65, duration: 90, instructors: [0, 1] },
      ],
    },
  ];
  const services = await Promise.all(serviceDefinitions.map(({ assignments, ...service }) => tx.service.create({
    data: {
      // Monetary API values are integer cents, not display dollars.
      businessId, ...service, price: service.price * 100, noticeHours: 2,
      locations: {
        create: assignments.map(assignment => ({
          locationId: locations[assignment.location].id, price: assignment.price * 100, duration: assignment.duration,
          instructors: { create: assignment.instructors.map(index => ({ instructorId: instructors[index].id })) },
        })),
      },
    },
    include: { locations: true },
  })));
  await tx.availability.createMany({
    data: instructors.flatMap(instructor => locations.flatMap(location => Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId, instructorId: instructor.id, locationId: location.id, dayOfWeek, startTime: '07:00', endTime: '21:00',
    })))),
  });

  const customerDefinitions = [
    { name: 'Amelia Wong', notes: 'Working on a more consistent second serve.' },
    { name: 'Ethan Lim', parentName: 'Michelle Lim', notes: 'Junior player. Parent collects after class.' },
    { name: 'Chloe Tan', parentName: 'Angela Tan', notes: 'Junior player. Loves doubles games.' },
    { name: 'Ryan Ng', parentName: 'Felicia Ng', notes: 'Junior player. Focus on footwork and confidence.' },
    { name: 'Sophia Lee', parentName: 'David Lee', notes: 'Junior player. Bring the junior racket.' },
    { name: 'Oliver Chen', parentName: 'Rachel Chen', notes: 'Junior player. New to group lessons.' },
    { name: 'Ava Goh', parentName: 'Melissa Goh', notes: 'Junior player. Left-handed.' },
    { name: 'Noah Teo', parentName: 'Adrian Teo', notes: 'Junior player. Enjoys rally challenges.' },
    { name: 'Emma Koh', parentName: 'Jasmine Koh', notes: 'Junior player. Parent is the main contact.' },
    { name: 'Lucas Ong', notes: 'Preparing for a social doubles league.' },
    { name: 'Natalie Chua', notes: 'Prefers morning sessions.' },
    { name: 'Benjamin Low', notes: 'Returning to tennis after a break.' },
    { name: 'Grace Ho', notes: 'Focus on badminton footwork.' },
    { name: 'Isaac Yeo', notes: 'Working towards longer rallies.' },
    { name: 'Olivia Seah', notes: 'Enjoys match-play sessions.' },
    { name: 'Joshua Toh', notes: 'Uses online reviews between court sessions.' },
    { name: 'Hannah Neo', notes: 'Plays both tennis and badminton.' },
    { name: 'Daniel Foo', notes: 'Focus on backhand consistency.' },
    { name: 'Chloe Chan', notes: 'Prefers PayNow by bank transfer.' },
    { name: 'Aarav Menon', notes: 'Building confidence at the net.' },
  ];
  const customers = customerDefinitions.map((customer, index) => ({
    id: randomUUID(), businessId, name: customer.name, initials: initials(customer.name),
    email: `${customer.name.toLowerCase().replaceAll(' ', '.')}@example.com`,
    phone: `+65 8${String(100_000 + index).padStart(7, '0')}`,
    parentName: customer.parentName ?? '', notes: customer.notes,
    createdAt: now.minus({ days: 90 - index * 3 }).toJSDate(),
  }));
  await tx.customer.createMany({ data: customers });

  const packageDefinitions = [
    { customer: 0, service: 0, name: 'Private Tennis · 10 lessons', totalCredits: 10, price: 850, paid: true },
    { customer: 9, service: 0, name: 'Private Tennis · 5 lessons', totalCredits: 5, price: 425, paid: true },
    { customer: 15, service: 0, name: 'Private Tennis · 5 lessons', totalCredits: 5, price: 425, paid: false },
    { customer: 1, service: 1, name: 'Junior Tennis · 8 lessons', totalCredits: 8, price: 280, paid: true },
    { customer: 3, service: 1, name: 'Junior Tennis · 8 lessons', totalCredits: 8, price: 280, paid: true },
    { customer: 5, service: 1, name: 'Junior Tennis · 8 lessons', totalCredits: 8, price: 280, paid: false },
    { customer: 12, service: 2, name: 'Badminton · 8 lessons', totalCredits: 8, price: 280, paid: true },
    { customer: 14, service: 3, name: 'Match Play · 6 sessions', totalCredits: 6, price: 300, paid: true },
    { customer: 16, service: null, name: 'Racket Club · 10 flexible credits', totalCredits: 10, price: 500, paid: false },
  ];
  const packages = packageDefinitions.map((pkg, index) => ({
    id: randomUUID(), businessId, customerId: customers[pkg.customer].id, name: pkg.name,
    serviceId: pkg.service === null ? null : services[pkg.service].id,
    totalCredits: pkg.totalCredits, usedCredits: 0, price: pkg.price * 100, paid: pkg.paid,
    expiresAt: now.plus({ days: index === 3 ? 14 : 90 }).endOf('day').toJSDate(),
  }));
  const bookings: Prisma.BookingCreateManyInput[] = [];
  const participants: Prisma.ParticipantCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = packages.filter(pkg => pkg.paid).map((pkg, index) => ({
    id: randomUUID(), businessId, customerId: pkg.customerId, packageId: pkg.id, amount: pkg.price,
    method: 'BANK_TRANSFER', note: `PayNow · ${pkg.name}`,
    paidAt: now.minus({ days: index % 3, hours: 1 }).toJSDate(),
  }));
  const adults = [0, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const juniors = [1, 2, 3, 4, 5, 6, 7, 8];
  const pendingByCoach = new Map<string, number>();
  const upcomingByCoach = new Map<string, number>();

  for (let day = 0; day < 7; day++) {
    // Five daily sessions always include today's 09:00, 10:00 and 11:00.
    // Marcus and Sarah change venues only after generous travel/preparation gaps.
    const sessions = [
      { hour: 9, service: 0, instructor: 0, location: 0, customers: [adults[day % adults.length]] },
      { hour: 10, service: 2, instructor: 2, location: 1, customers: Array.from({ length: 2 + day % 3 }, (_, seat) => adults[(day + 3 + seat) % adults.length]) },
      { hour: 11, service: 1, instructor: 1, location: 0, customers: Array.from({ length: 4 + day % 3 }, (_, seat) => juniors[(day * 2 + seat) % juniors.length]) },
      { hour: 14, service: 3, instructor: 0, location: 2, customers: Array.from({ length: 2 + (day + 1) % 3 }, (_, seat) => adults[(day + 6 + seat) % adults.length]) },
      { hour: 17, service: 0, instructor: 1, location: 3, customers: [adults[(day + 7) % adults.length]] },
    ];
    for (const [slot, session] of sessions.entries()) {
      const service = services[session.service];
      const location = locations[session.location];
      const instructorId = instructors[session.instructor].id;
      const assignment = service.locations.find(item => item.locationId === location.id)!;
      const startAt = weekStart.plus({ days: day, hours: session.hour });
      const endAt = startAt.plus({ minutes: assignment.duration });
      const cancelled = (day === (todayIndex + 2) % 7 && slot === 4) || (day === (todayIndex + 4) % 7 && slot === 0);
      const status = cancelled ? 'CANCELLED' : endAt.toMillis() <= now.toMillis() ? 'COMPLETED'
        : location.requiresApproval ? 'PENDING' : 'CONFIRMED';
      const bookingId = randomUUID();
      const notes = cancelled ? 'Student requested a cancellation. Any reserved package credit has been restored.'
        : status === 'PENDING' ? 'Awaiting venue confirmation. No external court has been reserved by Courtly.'
          : session.service === 1 ? 'Bring water and a junior racket. Parent or guardian collects after the lesson.'
            : session.location === 3 ? 'Video technique review. Joining details will be shared before the session.'
              : session.service === 3 ? 'Guided doubles and point play. Allow 15 minutes for coach preparation.'
                : 'A little practice, a little progress. Bring water and your racket.';
      bookings.push({
        id: bookingId, businessId, serviceId: service.id, instructorId, locationId: location.id,
        startAt: startAt.toJSDate(), endAt: endAt.toJSDate(), duration: assignment.duration,
        bufferMinutes: service.bufferMinutes, status, type: service.type, capacity: service.capacity,
        price: assignment.price, notes, address: location.address,
        createdAt: DateTime.min(startAt.minus({ days: 3 }), now.minus({ hours: 1 })).toJSDate(),
      });
      if (!cancelled && startAt > now) upcomingByCoach.set(instructorId, (upcomingByCoach.get(instructorId) ?? 0) + 1);
      if (status === 'PENDING') pendingByCoach.set(instructorId, (pendingByCoach.get(instructorId) ?? 0) + 1);

      for (const [seat, customerIndex] of session.customers.entries()) {
        const customer = customers[customerIndex];
        const pkg = packages.find(item => item.customerId === customer.id && (!item.serviceId || item.serviceId === service.id)
          && item.expiresAt >= startAt.toJSDate() && item.usedCredits < item.totalCredits);
        const creditConsumed = !!pkg && !cancelled;
        if (creditConsumed) pkg!.usedCredits++;
        const paid = !cancelled && (pkg ? pkg.paid : (day + slot + seat) % 3 !== 0);
        participants.push({
          id: randomUUID(), bookingId, customerId: customer.id, price: assignment.price,
          paid, packageId: pkg?.id ?? null, creditConsumed,
          attendance: status === 'COMPLETED' ? ((day + slot + seat) % 13 === 0 ? 'ABSENT' : 'PRESENT') : 'UNMARKED',
          managementTokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
          managementTokenExpiresAt: endAt.plus({ days: 30 }).toJSDate(),
          notes: '',
        });
        // Package purchases are recorded once; credit redemptions are not new revenue.
        if (paid && !pkg) {
          payments.push({
            id: randomUUID(), businessId, customerId: customer.id, bookingId, amount: assignment.price,
            method: ['BANK_TRANSFER', 'CASH', 'OTHER'][(day + slot + seat) % 3],
            note: status === 'PENDING' ? 'Advance lesson payment; venue confirmation is still required.' : `Lesson payment · ${service.name}`,
            paidAt: DateTime.min(startAt.minus({ hours: 2 }), now.minus({ minutes: 20 + payments.length })).toJSDate(),
          });
        }
      }
    }
  }

  // All tenant foreign keys and package counters are persisted together.
  await tx.lessonPackage.createMany({ data: packages });
  await tx.booking.createMany({ data: bookings });
  await tx.participant.createMany({ data: participants });
  await tx.payment.createMany({ data: payments });
  const notifications: Prisma.NotificationCreateManyInput[] = [
    { businessId, instructorId: instructors[0].id, title: 'Your week is ready', message: 'Your lessons, students and payments are together in Courtly. All times are shown in Asia/Singapore.', read: true, createdAt: now.minus({ hours: 3 }).toJSDate() },
    { businessId, title: 'Payments are up to date', message: `${payments.length} sample payment records are on the books. Unpaid lessons and unpaid packages remain visible for follow-up.`, read: true, createdAt: now.minus({ hours: 2 }).toJSDate() },
    { businessId, title: 'Package credits tracked', message: `${packages.filter(pkg => pkg.usedCredits > 0).length} packages have lesson credits reserved or used. Cancelled sessions do not consume a credit.`, read: false, createdAt: now.minus({ minutes: 45 }).toJSDate() },
  ];
  for (const instructor of instructors) {
    const upcoming = upcomingByCoach.get(instructor.id) ?? 0;
    notifications.push({
      businessId, instructorId: instructor.id, title: 'Lesson reminders queued',
      message: upcoming > 0
        ? `${upcoming} upcoming lesson${upcoming === 1 ? '' : 's'} for ${instructor.name}. Confirmation and 24-hour reminders queued in Courtly; external delivery is not configured and no message has been sent.`
        : `This week's lessons for ${instructor.name} are complete. New booking confirmations and 24-hour reminders will be queued in Courtly; external delivery is not configured.`,
      read: false, createdAt: now.minus({ minutes: 15 + instructors.indexOf(instructor) }).toJSDate(),
    });
    const pending = pendingByCoach.get(instructor.id) ?? 0;
    if (pending > 0) notifications.push({
      businessId, instructorId: instructor.id, title: 'Venue confirmation needed',
      message: `${pending} OCBC Arena session${pending === 1 ? '' : 's'} awaiting venue approval. Check court availability before confirming; Courtly has not reserved an external court.`,
      read: false, createdAt: now.minus({ minutes: 5 }).toJSDate(),
    });
  }
  await tx.notification.createMany({ data: notifications });
  return { business, owner };
}
