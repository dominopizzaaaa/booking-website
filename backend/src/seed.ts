import type { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { chatOpeningLine, chatWhen } from './chat-events.js';

export type SeedBusinessOptions = {
  slug?: string;
  isDemo?: boolean;
  clubEmail?: string;
  businessName?: string;
};

const timezone = 'Asia/Singapore';
const initials = (name: string) => name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();

// A client starts an atomic seed; an existing transaction remains owned by its caller.
export async function seedBusiness(prismaOrTx: PrismaClient | Prisma.TransactionClient, options: SeedBusinessOptions = {}) {
  const password = (!options.isDemo && process.env.SEED_CLUB_PASSWORD) || randomBytes(32).toString('base64url');
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('SEED_CLUB_PASSWORD must contain at least 8 characters and at most 72 UTF-8 bytes.');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  // Demo/sample people still receive real account credentials in the data
  // model. Their random password is deliberately not returned or shared; the
  // only interactive seed credential is the club password above.
  const samplePasswordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 12);
  if ('$transaction' in prismaOrTx) {
    return prismaOrTx.$transaction(tx => populateBusiness(tx, options, passwordHash, samplePasswordHash), { timeout: 60_000 });
  }
  return populateBusiness(prismaOrTx, options, passwordHash, samplePasswordHash);
}

async function populateBusiness(
  tx: Prisma.TransactionClient,
  options: SeedBusinessOptions,
  passwordHash: string,
  samplePasswordHash: string,
) {
  const now = DateTime.now().setZone(timezone);
  const weekStart = now.startOf('week');
  const todayIndex = now.weekday - 1;
  const tenantKey = randomBytes(12).toString('hex');
  const email = options.clubEmail?.trim().toLowerCase() || `marcus+${tenantKey}@courtly.example`;
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
      kind: 'CLUB',
      isDemo: options.isDemo ?? false,
      createdAt: now.minus({ months: 6 }).toJSDate(),
    },
  });
  const businessId = business.id;
  const paymentRoute = business.kind === 'SOLO' ? 'DIRECT' : 'CLUB';
  const studentPaymentKind = paymentRoute === 'DIRECT' ? 'STUDENT_TO_COACH' : 'STUDENT_TO_CLUB';
  const instructors = await Promise.all([
    { name: 'Marcus Tan', color: '#527a5b', email: `marcus.${tenantKey}@sample.courtly.invalid`, specialty: 'Tennis · technique and match play' },
    { name: 'Sarah Lim', color: '#5c7f91', email: `sarah.${tenantKey}@sample.courtly.invalid`, specialty: 'Junior tennis · confidence and fundamentals' },
    { name: 'Daniel Lee', color: '#b1854f', email: `daniel.${tenantKey}@sample.courtly.invalid`, specialty: 'Badminton · footwork and doubles' },
  ].map(instructor => tx.instructor.create({ data: { businessId, ...instructor, initials: initials(instructor.name) } })));
  // The club's own operating login. It runs the club and never teaches, so it
  // holds no roster entry; every coach below has their own account.
  const clubAccount = await tx.user.create({
    data: {
      name: business.name, email, username: `club_${tenantKey}`, sports: ['Tennis', 'Badminton'],
      passwordHash, accountType: 'CLUB', phone: '', parentName: '', createdAt: business.createdAt,
    },
  });
  const clubMembership = await tx.membership.create({
    data: { userId: clubAccount.id, businessId, createdAt: business.createdAt },
  });
  await Promise.all(instructors.map(async instructor => {
    const accountId = `seed-instructor-${instructor.id}`;
    const account = await tx.user.create({
      data: {
        id: accountId,
        name: instructor.name,
        email: instructor.email,
        username: `coach_${instructors.indexOf(instructor) + 1}_${tenantKey.slice(0, 14)}`,
        sports: [instructor.specialty.startsWith('Badminton') ? 'Badminton' : 'Tennis'],
        passwordHash: samplePasswordHash,
        accountType: 'COACH',
        phone: '',
        parentName: '',
        createdAt: business.createdAt,
      },
    });
    await tx.membership.create({
      data: { id: `seed-membership-${instructor.id}`, userId: account.id, businessId, instructorId: instructor.id, createdAt: business.createdAt },
    });
  }));

  const locations = await Promise.all([
    {
      name: 'Kallang Tennis Centre', address: '52 Stadium Road, Singapore 397724', type: 'FACILITY', color: '#78915e',
      requiresApproval: false, travelMinutes: 20, notes: 'Meet beside the main entrance.', sport: 'Tennis',
      rentalEnabled: true, rentalUnitLabel: 'Court', rentalPrice: 3200, rentalStartInterval: 30, rentalMinDuration: 60,
      rentalBookingIncrement: 30, rentalMaxDuration: 120, rentalNoticeHours: 2, rentalAdvanceDays: 60,
      rentalCancellationHours: 24, rules: 'Non-marking shoes are required. Check in before entering the court.',
      amenities: JSON.stringify(['Changing rooms', 'Racket hire', 'Water station']),
    },
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
  const rentalUnits = await Promise.all(['Court 1', 'Court 2', 'Court 3'].map(name => tx.venueUnit.create({
    data: { businessId, locationId: locations[0].id, name },
  })));
  await tx.venueOpeningHour.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId, locationId: locations[0].id, dayOfWeek, startTime: '07:00', endTime: '21:00',
    })),
  });
  const packageOffers = await Promise.all([
    tx.packageOffer.create({ data: {
      businessId, name: 'Racket Club Flex Pass', description: 'Ten credits for private tennis classes or a court reservation.',
      price: 85000, totalCredits: 10, validityDays: 90, active: true,
    } }),
    tx.packageOffer.create({ data: {
      businessId, name: 'Court Rental Bundle', description: 'Five credits for reserving a Kallang court.',
      price: 14000, totalCredits: 5, validityDays: 60, active: true,
    } }),
  ]);
  await tx.packageOfferService.create({
    data: { offerId: packageOffers[0].id, businessId, serviceId: services[0].id },
  });
  await tx.packageOfferLocation.createMany({ data: packageOffers.map(offer => ({
    offerId: offer.id, businessId, locationId: locations[0].id,
  })) });
  await tx.availability.createMany({
    data: instructors.flatMap(instructor => locations.flatMap(location => Array.from({ length: 7 }, (_, dayOfWeek) => ({
      businessId, instructorId: instructor.id, locationId: location.id, dayOfWeek, startTime: '07:00', endTime: '21:00',
    })))),
  });

  const studentDefinitions = [
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
  const students = studentDefinitions.map((student, index) => ({
    id: randomUUID(), userId: `seed-student-${randomUUID()}`, businessId, name: student.name, initials: initials(student.name),
    email: `${student.name.toLowerCase().replaceAll(' ', '.')}.${tenantKey}@sample.courtly.invalid`,
    phone: `+65 8${String(100_000 + index).padStart(7, '0')}`,
    parentName: student.parentName ?? '', notes: student.notes,
    createdAt: now.minus({ days: 90 - index * 3 }).toJSDate(),
  }));
  await tx.user.createMany({
    data: students.map(student => ({
      id: student.userId, name: student.name, email: student.email,
      username: `student_${students.indexOf(student) + 1}_${tenantKey.slice(0, 12)}`,
      sports: student.notes.toLowerCase().includes('badminton') ? ['Badminton'] : ['Tennis'],
      passwordHash: samplePasswordHash, accountType: 'STUDENT',
      phone: student.phone, parentName: student.parentName, createdAt: student.createdAt,
    })),
  });
  await tx.student.createMany({ data: students });

  const packageDefinitions = [
    { student: 0, service: 0, offer: 0, name: 'Racket Club Flex Pass', totalCredits: 10, price: 850, paid: true },
    { student: 9, service: 0, offer: null, name: 'Private Tennis · 5 lessons', totalCredits: 5, price: 425, paid: true },
    { student: 15, service: 0, offer: null, name: 'Private Tennis · 5 lessons', totalCredits: 5, price: 425, paid: false },
    { student: 1, service: 1, offer: null, name: 'Junior Tennis · 8 lessons', totalCredits: 8, price: 280, paid: true },
    { student: 3, service: 1, offer: null, name: 'Junior Tennis · 8 lessons', totalCredits: 8, price: 280, paid: true },
    { student: 5, service: 1, offer: null, name: 'Junior Tennis · 8 lessons', totalCredits: 8, price: 280, paid: false },
    { student: 12, service: 2, offer: null, name: 'Badminton · 8 lessons', totalCredits: 8, price: 280, paid: true },
    { student: 14, service: 3, offer: null, name: 'Match Play · 6 sessions', totalCredits: 6, price: 300, paid: true },
    { student: 16, service: null, offer: null, name: 'Racket Club · 10 flexible credits', totalCredits: 10, price: 500, paid: false },
  ];
  const packages = packageDefinitions.map((pkg, index) => ({
    id: randomUUID(), businessId, studentId: students[pkg.student].id,
    offerId: pkg.offer === null ? null : packageOffers[pkg.offer].id, name: pkg.name,
    serviceId: pkg.service === null ? null : services[pkg.service].id,
    totalCredits: pkg.totalCredits, usedCredits: 0, price: pkg.price * 100, paid: pkg.paid,
    expiresAt: now.plus({ days: index === 3 ? 14 : 90 }).endOf('day').toJSDate(),
  }));
  const bookings: Prisma.BookingCreateManyInput[] = [];
  const participants: Prisma.ParticipantCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = packages.filter(pkg => pkg.paid).map((pkg, index) => ({
    id: randomUUID(), businessId, studentId: pkg.studentId, packageId: pkg.id, amount: pkg.price,
    kind: studentPaymentKind,
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
      { hour: 9, service: 0, instructor: 0, location: 0, students: [adults[day % adults.length]] },
      { hour: 10, service: 2, instructor: 2, location: 1, students: Array.from({ length: 2 + day % 3 }, (_, seat) => adults[(day + 3 + seat) % adults.length]) },
      { hour: 11, service: 1, instructor: 1, location: 0, students: Array.from({ length: 4 + day % 3 }, (_, seat) => juniors[(day * 2 + seat) % juniors.length]) },
      { hour: 14, service: 3, instructor: 0, location: 2, students: Array.from({ length: 2 + (day + 1) % 3 }, (_, seat) => adults[(day + 6 + seat) % adults.length]) },
      { hour: 17, service: 0, instructor: 1, location: 3, students: [adults[(day + 7) % adults.length]] },
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
        price: assignment.price, notes, address: location.address, paymentRoute,
        createdAt: DateTime.min(startAt.minus({ days: 3 }), now.minus({ hours: 1 })).toJSDate(),
      });
      if (!cancelled && startAt > now) upcomingByCoach.set(instructorId, (upcomingByCoach.get(instructorId) ?? 0) + 1);
      if (status === 'PENDING') pendingByCoach.set(instructorId, (pendingByCoach.get(instructorId) ?? 0) + 1);

      for (const [seat, studentIndex] of session.students.entries()) {
        const student = students[studentIndex];
        const pkg = packages.find(item => item.studentId === student.id && (!item.serviceId || item.serviceId === service.id)
          && item.expiresAt >= startAt.toJSDate() && item.usedCredits < item.totalCredits);
        const creditConsumed = !!pkg && !cancelled;
        if (creditConsumed) pkg!.usedCredits++;
        const paid = !cancelled && (pkg ? pkg.paid : (day + slot + seat) % 3 !== 0);
        participants.push({
          id: randomUUID(), bookingId, studentId: student.id, price: assignment.price,
          paid, packageId: pkg?.id ?? null, creditConsumed,
          attendance: status === 'COMPLETED' ? ((day + slot + seat) % 13 === 0 ? 'ABSENT' : 'PRESENT') : 'UNMARKED',
          managementTokenHash: null,
          managementTokenExpiresAt: null,
          managementTokenRevokedAt: null,
          notes: '',
        });
        // Package purchases are recorded once; credit redemptions are not new revenue.
        if (paid && !pkg) {
          payments.push({
            id: randomUUID(), businessId, studentId: student.id, bookingId, amount: assignment.price,
            kind: studentPaymentKind,
            method: ['BANK_TRANSFER', 'CASH', 'OTHER'][(day + slot + seat) % 3],
            note: status === 'PENDING' ? 'Advance lesson payment; venue confirmation is still required.' : `Lesson payment · ${service.name}`,
            paidAt: DateTime.min(startAt.minus({ hours: 2 }), now.minus({ minutes: 20 + payments.length })).toJSDate(),
          });
        }
      }
    }
  }

  // All tenant foreign keys and package counters are persisted together.
  packages[0].usedCredits += 1;
  await tx.lessonPackage.createMany({ data: packages });
  await tx.lessonPackageService.create({
    data: { packageId: packages[0].id, businessId, serviceId: services[0].id },
  });
  await tx.lessonPackageLocation.create({
    data: { packageId: packages[0].id, businessId, locationId: locations[0].id },
  });
  const packageCheckoutAt = now.minus({ days: 2 });
  const packageIntent = await tx.paymentIntent.create({ data: {
    userId: students[0].userId, businessId, kind: 'PACKAGE', packageOfferId: packageOffers[0].id,
    packageId: packages[0].id, amount: packages[0].price, currency: business.currency, status: 'SUCCEEDED',
    provider: 'SIMULATED_STRIPE', providerReference: `sim_pi_seed_package_${tenantKey}`,
    idempotencyKey: `seed-package-${tenantKey}`, createdAt: packageCheckoutAt.toJSDate(), confirmedAt: packageCheckoutAt.toJSDate(),
  } });
  const packagePayment = payments.find(payment => payment.packageId === packages[0].id);
  if (packagePayment) {
    packagePayment.paymentIntentId = packageIntent.id;
    packagePayment.method = 'SIMULATED_STRIPE';
    packagePayment.note = `Online checkout for ${packageOffers[0].name}`;
  }
  const rentalStart = now.plus({ days: 7 }).startOf('day').plus({ hours: 12 });
  const rentalReservation = await tx.venueReservation.create({ data: {
    businessId, locationId: locations[0].id, unitId: rentalUnits[0].id, userId: students[10].userId,
    startAt: rentalStart.toJSDate(), endAt: rentalStart.plus({ minutes: 90 }).toJSDate(), duration: 90,
    price: 4800, status: 'CONFIRMED', paymentStatus: 'PAID', notes: 'Sample online court reservation.',
    createdAt: now.minus({ hours: 2 }).toJSDate(),
  } });
  const rentalIntent = await tx.paymentIntent.create({ data: {
    userId: students[10].userId, businessId, kind: 'RENTAL', reservationId: rentalReservation.id, amount: 4800,
    currency: business.currency, status: 'SUCCEEDED', provider: 'SIMULATED_STRIPE',
    providerReference: `sim_pi_seed_rental_${tenantKey}`, idempotencyKey: `seed-rental-${tenantKey}`,
    createdAt: now.minus({ hours: 2 }).toJSDate(), confirmedAt: now.minus({ hours: 2 }).toJSDate(),
  } });
  payments.push({
    id: randomUUID(), businessId, studentId: students[10].id, paymentIntentId: rentalIntent.id, amount: 4800,
    kind: 'STUDENT_TO_CLUB', method: 'SIMULATED_STRIPE', note: `Online venue rental · ${locations[0].name}`,
    paidAt: now.minus({ hours: 2 }).toJSDate(),
  });
  const packageRentalStart = rentalStart.plus({ days: 1 });
  const packageRental = await tx.venueReservation.create({ data: {
    businessId, locationId: locations[0].id, unitId: rentalUnits[1].id, userId: students[0].userId,
    startAt: packageRentalStart.toJSDate(), endAt: packageRentalStart.plus({ minutes: 60 }).toJSDate(), duration: 60,
    price: 3200, status: 'CONFIRMED', paymentStatus: 'PACKAGE', packageId: packages[0].id, creditConsumed: true,
    notes: 'Sample package-funded court reservation.', createdAt: now.minus({ hours: 1 }).toJSDate(),
  } });
  await tx.paymentIntent.create({ data: {
    userId: students[0].userId, businessId, kind: 'RENTAL', reservationId: packageRental.id, amount: 0,
    currency: business.currency, status: 'SUCCEEDED', provider: 'SIMULATED_STRIPE',
    providerReference: `sim_pi_seed_rental_package_${tenantKey}`, idempotencyKey: `seed-rental-package-${tenantKey}`,
    createdAt: now.minus({ hours: 1 }).toJSDate(), confirmedAt: now.minus({ hours: 1 }).toJSDate(),
  } });
  await tx.booking.createMany({ data: bookings });
  await tx.participant.createMany({ data: participants });
  await tx.payment.createMany({ data: payments });
  await seedSessionChats(tx, { businessId, businessName: business.name, clubUserId: clubAccount.id, now, bookings, participants, students, services, instructors, locations });
  const notifications: Prisma.NotificationCreateManyInput[] = [
    { businessId, instructorId: instructors[0].id, title: 'Your week is ready', message: 'Your lessons, students and payments are together in Courtly. All times are shown in Asia/Singapore.', read: true, createdAt: now.minus({ hours: 3 }).toJSDate() },
    { businessId, title: 'Payments are up to date', message: `${payments.length} sample payment records are on the books. Unpaid lessons and unpaid packages remain visible for follow-up.`, read: true, createdAt: now.minus({ hours: 2 }).toJSDate() },
    { businessId, title: 'Package credits tracked', message: `${packages.filter(pkg => pkg.usedCredits > 0).length} packages have lesson credits reserved or used. Cancelled sessions do not consume a credit.`, read: false, createdAt: now.minus({ minutes: 45 }).toJSDate() },
  ];
  for (const instructor of instructors) {
    const upcoming = upcomingByCoach.get(instructor.id) ?? 0;
    notifications.push({
      businessId, instructorId: instructor.id, type: 'BOOKING', title: 'Lesson reminders queued',
      message: upcoming > 0
        ? `${upcoming} upcoming lesson${upcoming === 1 ? '' : 's'} for ${instructor.name}. Confirmation and 24-hour reminders queued in Courtly; external delivery is not configured and no message has been sent.`
        : `This week's lessons for ${instructor.name} are complete. New booking confirmations and 24-hour reminders will be queued in Courtly; external delivery is not configured.`,
      read: false, createdAt: now.minus({ minutes: 15 + instructors.indexOf(instructor) }).toJSDate(),
    });
    const pending = pendingByCoach.get(instructor.id) ?? 0;
    if (pending > 0) notifications.push({
      businessId, instructorId: instructor.id, type: 'PENDING_ACTION', actionNeeded: true, title: 'Venue confirmation needed',
      message: `${pending} OCBC Arena session${pending === 1 ? '' : 's'} awaiting venue approval. Check court availability before confirming; Courtly has not reserved an external court.`,
      read: false, createdAt: now.minus({ minutes: 5 }).toJSDate(),
    });
  }
  await tx.notification.createMany({ data: notifications });
  return { business, clubAccount, clubMembership };
}

type SeedChatContext = {
  businessId: string;
  businessName: string;
  clubUserId: string;
  now: DateTime;
  bookings: Prisma.BookingCreateManyInput[];
  participants: Prisma.ParticipantCreateManyInput[];
  students: Array<{ id: string; userId: string; name: string }>;
  services: Array<{ id: string; name: string }>;
  instructors: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
};

/**
 * Every seeded session has its chat, as a booked session would. The next
 * private lesson and junior group already hold a conversation, and the lesson
 * carries an open next-session proposal, so a demo shows the whole flow.
 */
async function seedSessionChats(tx: Prisma.TransactionClient, context: SeedChatContext) {
  const { businessId, now } = context;
  const name = <T extends { id: string; name: string }>(items: T[], id: string) => items.find(item => item.id === id)!.name;
  const threads = context.bookings.map(booking => ({
    id: randomUUID(), businessId, bookingId: booking.id!,
    createdAt: booking.createdAt as Date, lastMessageAt: booking.createdAt as Date,
  }));
  await tx.chatThread.createMany({ data: threads });
  const messages: Prisma.ChatMessageCreateManyInput[] = threads.map((thread, index) => {
    const booking = context.bookings[index];
    return {
      threadId: thread.id, kind: 'SYSTEM', event: 'OPENED', senderRole: 'SYSTEM', createdAt: thread.createdAt,
      body: chatOpeningLine({
        serviceName: name(context.services, booking.serviceId), instructorName: name(context.instructors, booking.instructorId),
        locationName: name(context.locations, booking.locationId), startAt: booking.startAt as Date, timezone,
      }),
    };
  });
  const upcoming = (serviceId: string) => context.bookings.find(booking => booking.serviceId === serviceId
    && booking.status === 'CONFIRMED' && (booking.startAt as Date) > now.plus({ hours: 3 }).toJSDate());
  const studentsIn = (bookingId: string) => context.participants
    .filter(participant => participant.bookingId === bookingId)
    .map(participant => context.students.find(student => student.id === participant.studentId)!);
  const threadFor = (bookingId: string) => threads.find(thread => thread.bookingId === bookingId)!;
  const coachAccount = (instructorId: string) => ({ userId: `seed-instructor-${instructorId}`, name: name(context.instructors, instructorId) });
  const say = (threadId: string, minutesAgo: number, sender: { userId: string; name: string; role: 'STUDENT' | 'COACH' | 'CLUB' }, body: string) => {
    const createdAt = now.minus({ minutes: minutesAgo }).toJSDate();
    messages.push({ threadId, kind: 'TEXT', senderUserId: sender.userId, senderRole: sender.role, senderName: sender.name, body, createdAt });
    return createdAt;
  };

  const lesson = upcoming(context.services[0].id);
  const lessonStudent = lesson ? studentsIn(lesson.id!)[0] : undefined;
  if (lesson && lessonStudent) {
    const thread = threadFor(lesson.id!);
    const coach = { ...coachAccount(lesson.instructorId), role: 'COACH' as const };
    const student = { userId: lessonStudent.userId, name: lessonStudent.name, role: 'STUDENT' as const };
    const firstName = lessonStudent.name.split(' ')[0];
    say(thread.id, 150, coach, `Hi ${firstName}! Looking forward to our lesson. We'll keep building that second serve, so bring a spare racket if you have one.`);
    say(thread.id, 140, student, 'Will do, thanks coach! Could we also spend a few minutes on returns?');
    say(thread.id, 136, coach, 'Absolutely. Shall we keep the same time next week as well?');
    const startAt = DateTime.fromJSDate(lesson.startAt as Date).plus({ weeks: 1 });
    const proposalId = randomUUID();
    await tx.sessionProposal.create({ data: {
      id: proposalId, businessId, threadId: thread.id, serviceId: lesson.serviceId, instructorId: lesson.instructorId,
      locationId: lesson.locationId, address: lesson.address ?? '', startAt: startAt.toJSDate(),
      endAt: startAt.plus({ minutes: lesson.duration }).toJSDate(), proposedByRole: 'COACH',
      proposedByUserId: coach.userId, proposedByName: coach.name, targetStudentUserId: student.userId,
      targetStudentName: student.name, createdAt: now.minus({ minutes: 135 }).toJSDate(),
    } });
    messages.push({
      threadId: thread.id, kind: 'PROPOSAL', senderUserId: coach.userId, senderRole: 'COACH', senderName: coach.name,
      proposalId, createdAt: now.minus({ minutes: 135 }).toJSDate(),
      body: `${coach.name} proposed the next session: ${name(context.services, lesson.serviceId)} on ${chatWhen(startAt.toJSDate(), timezone)}.`,
    });
    thread.lastMessageAt = now.minus({ minutes: 135 }).toJSDate();
  }

  const group = upcoming(context.services[1].id);
  const groupStudents = group ? studentsIn(group.id!) : [];
  if (group && groupStudents.length) {
    const thread = threadFor(group.id!);
    const coach = { ...coachAccount(group.instructorId), role: 'COACH' as const };
    say(thread.id, 95, coach, 'Hi everyone! Please bring water, a junior racket and non-marking shoes. We will finish with a mini doubles tournament.');
    say(thread.id, 80, { userId: groupStudents[0].userId, name: groupStudents[0].name, role: 'STUDENT' }, 'Thank you Coach! See you there.');
    thread.lastMessageAt = say(thread.id, 60, { userId: context.clubUserId, name: context.businessName, role: 'CLUB' }, 'Courts 1 and 2 at Kallang are set aside for the junior group this week.');
  }

  await tx.chatMessage.createMany({ data: messages });
  for (const thread of threads.filter(candidate => candidate.lastMessageAt.getTime() !== candidate.createdAt.getTime())) {
    await tx.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: thread.lastMessageAt } });
  }
}
