import { Router } from 'express';
import { prisma } from './db.js';
import { asyncRoute, coachScoped, effectiveClubPermissions, hasClubPermission } from './http.js';
import { workspaceNotificationWhere } from './notifications.js';
import { bookingInclude, bookingInstructorJson, bookingJson, bookingLocationJson, bookingServiceJson, isClubAccount, membershipJson, packageJson, paymentJson, publicBusiness, serviceJson, withoutBookingFinancials, withoutServiceFinancials, workspaceUserJson } from './serializers.js';
import { integrityFlagInclude, integrityFlagJson } from './integrity.js';
import { rescheduleRequestJson } from './reschedule.js';
import { isReplaceableInstructorPlaceholder } from './staff.js';
export const workspaceRouter = Router();
workspaceRouter.get('/workspace', asyncRoute(async (req, res) => {
  const { business, user, membership, staffAccess } = req.auth;
  if (!business) throw new Error('Workspace middleware did not provide an active business');
  const coach = coachScoped(req.auth);
  const instructorId = coach ? membership?.instructorId || '__none__' : undefined;
  const permitted = (permission: string) => coach || hasClubPermission(req.auth, permission);
  const canViewBookings = permitted('BOOKINGS_VIEW');
  const canViewStudents = permitted('STUDENTS_VIEW');
  const canViewCatalog = permitted('CATALOG_VIEW');
  const canViewRoster = hasClubPermission(req.auth, 'ROSTER_VIEW');
  const canViewAvailability = coach || hasClubPermission(req.auth, 'AVAILABILITY_MANAGE');
  const canViewPackages = hasClubPermission(req.auth, 'PACKAGES_VIEW');
  const canViewPayments = hasClubPermission(req.auth, 'PAYMENTS_VIEW');
  const schedulingOnlyInstructors = !coach && !canViewRoster;
  const schedulingOnlyLocations = !coach && !canViewCatalog;
  const bookingOnlyServices = canViewBookings && !coach && !canViewCatalog;
  const studentScope = coach ? { participants: { some: { booking: { businessId: business.id, instructorId } } } } : {};
  const assignedServiceLocationScope = { instructors: { some: { instructorId } } };
  // The workspace is the operational shell, not the history API. Keep enough
  // context for the dashboard, calendar, finance, and 12-week insights while
  // the paginated /bookings endpoint owns older and distant records.
  const bookingWindowFrom = new Date(Date.now() - 12 * 7 * 86_400_000);
  const bookingWindowTo = new Date(Date.now() + 548 * 86_400_000);
  const bookingWindowNow = new Date();
  const bookingWindowSegmentLimit = 2_000;
  const bookingsPromise = canViewBookings ? Promise.all([
    prisma.booking.findMany({
      where: { businessId: business.id, instructorId, startAt: { gte: bookingWindowFrom, lt: bookingWindowNow } },
      include: bookingInclude, orderBy: [{ startAt: 'desc' }, { id: 'desc' }], take: bookingWindowSegmentLimit + 1,
    }),
    prisma.booking.findMany({
      where: { businessId: business.id, instructorId, startAt: { gte: bookingWindowNow, lt: bookingWindowTo } },
      include: bookingInclude, orderBy: [{ startAt: 'asc' }, { id: 'asc' }], take: bookingWindowSegmentLimit + 1,
    }),
  ]).then(([past, future]) => ({
    rows: [...past.slice(0, bookingWindowSegmentLimit).reverse(), ...future.slice(0, bookingWindowSegmentLimit)],
    truncated: past.length > bookingWindowSegmentLimit || future.length > bookingWindowSegmentLimit,
  })) : Promise.resolve({ rows: [], truncated: false });
  const [instructors, locations, services, availability, exceptions, students, packages, bookings, payments, notifications, rescheduleRequests, integrityFlags, packageScopes] = await Promise.all([
    canViewRoster || canViewCatalog || canViewAvailability || canViewBookings ? prisma.instructor.findMany({
      where: { businessId: business.id, ...(coach ? { id: instructorId } : {}) },
      include: { membership: { select: {
        id: true, userId: true,
        user: { select: { id: true, email: true, passwordHash: true, accountType: true } },
      } } },
      orderBy: { name: 'asc' },
    }) : Promise.resolve([]),
    canViewCatalog || canViewAvailability || canViewBookings ? prisma.location.findMany({
      where: {
        businessId: business.id,
        // Club coaches may add a venue before the club connects it to a
        // service. Keep every active venue visible so that save can be
        // confirmed, while archived venue management remains club-only.
        ...(coach ? { OR: [
          { active: true },
          { services: { some: assignedServiceLocationScope } },
        ] } : {}),
      },
      orderBy: { name: 'asc' },
    }) : Promise.resolve([]),
    canViewCatalog || canViewBookings ? prisma.service.findMany({
      where: {
        businessId: business.id,
        ...(coach ? { locations: { some: assignedServiceLocationScope } } : {}),
      },
      include: {
        locations: coach
          ? {
              where: assignedServiceLocationScope,
              include: { instructors: { where: { instructorId } } },
            }
          : { include: { instructors: true } },
      },
      orderBy: { name: 'asc' },
    }) : Promise.resolve([]),
    canViewAvailability ? prisma.availability.findMany({ where: { businessId: business.id, instructorId } }) : Promise.resolve([]),
    canViewAvailability ? prisma.availabilityException.findMany({ where: { businessId: business.id, instructorId } }) : Promise.resolve([]),
    canViewStudents ? prisma.student.findMany({ where: { businessId: business.id, ...studentScope }, include: { participants: { where: { cancelledAt: null, booking: { status: { not: 'CANCELLED' }, instructorId } }, include: { booking: { select: { startAt: true } } } } }, orderBy: { name: 'asc' } }) : Promise.resolve([]),
    canViewPackages ? prisma.lessonPackage.findMany({
      where: { businessId: business.id },
      include: { student: true, services: true, rentalLocations: true },
    }) : Promise.resolve([]),
    bookingsPromise,
    canViewPayments ? prisma.payment.findMany({ where: { businessId: business.id }, include: { student: true, instructor: { select: { name: true } } }, orderBy: { paidAt: 'desc' } }) : Promise.resolve([]),
    (coach || req.auth.accessMode === 'CLUB_ACCOUNT' || req.auth.permissions.length) ? prisma.notification.findMany({
      where: workspaceNotificationWhere(req.auth),
      orderBy: { createdAt: 'desc' },
      take: 100,
    }) : Promise.resolve([]),
    canViewBookings ? prisma.rescheduleRequest.findMany({
      where: { businessId: business.id, ...(coach ? { booking: { instructorId } } : {}) },
      include: { booking: { include: {
        business: { select: { id: true, name: true, timezone: true } },
        instructor: { select: { id: true, name: true, rescheduleNoticeHours: true } },
        service: { select: { name: true } },
        location: { select: { name: true } },
      } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    }) : Promise.resolve([]),
    // The safeguard belongs only to the institutional club account. A coach
    // never receives flags, whether they are in a club or their own practice.
    !hasClubPermission(req.auth, 'INTEGRITY_VIEW') ? Promise.resolve([]) : prisma.integrityFlag.findMany({
      where: { businessId: business.id },
      include: integrityFlagInclude,
      orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
      take: 100,
    }),
    canViewPackages ? Promise.all([
      prisma.service.findMany({
        where: { businessId: business.id }, select: { id: true, name: true, active: true }, orderBy: { name: 'asc' },
      }),
      prisma.location.findMany({
        where: { businessId: business.id, active: true, rentalEnabled: true, type: 'FACILITY' },
        select: { id: true, name: true, active: true, rentalEnabled: true }, orderBy: { name: 'asc' },
      }),
    ]).then(([packageServices, rentalLocations]) => ({ services: packageServices, rentalLocations }))
      : Promise.resolve({ services: [], rentalLocations: [] }),
  ]);
  res.json({
    business: publicBusiness(business), user: workspaceUserJson(user, membership),
    membership: membership ? membershipJson(membership) : null, memberships: req.auth.memberships.map(membershipJson),
    staffAccess: staffAccess ? { id: staffAccess.id, userId: staffAccess.userId, businessId: staffAccess.businessId,
      accessLevel: staffAccess.accessLevel, permissions: staffAccess.permissions, active: staffAccess.active,
      createdAt: staffAccess.createdAt.toISOString(), business: publicBusiness(staffAccess.business) } : null,
    staffAccesses: req.auth.staffAccesses.map(access => ({ id: access.id, userId: access.userId, businessId: access.businessId,
      accessLevel: access.accessLevel, permissions: access.permissions, active: access.active,
      createdAt: access.createdAt.toISOString(), business: publicBusiness(access.business) })),
    accessMode: req.auth.accessMode, permissions: effectiveClubPermissions(req.auth.permissions),
    instructors: instructors.map(({ membership: affiliation, ...instructor }) => schedulingOnlyInstructors
      ? bookingInstructorJson(instructor, canViewAvailability)
      : ({
          ...instructor,
          // The browser needs to distinguish a genuinely unclaimed roster row from
          // a removed coach whose historical identity is intentionally retained.
          accountLinkAvailable: !affiliation || isReplaceableInstructorPlaceholder(instructor.id, affiliation),
        })),
    locations: locations.map(location => schedulingOnlyLocations ? bookingLocationJson(location) : location),
    services: services.map(service => {
      if (bookingOnlyServices) return bookingServiceJson(service, canViewPayments);
      const json = serviceJson(service);
      return coach || !canViewPayments ? withoutServiceFinancials(json) : json;
    }), availability, exceptions,
    students: students.map(({ participants, ...c }) => ({ ...c, bookingCount: participants.length, lastBookingAt: participants.length ? new Date(Math.max(...participants.map(p => p.booking.startAt.getTime()))).toISOString() : null })),
    packages: packages.map(packageJson), bookings: bookings.rows.map(b => {
      const json = bookingJson(b);
      return coach || !canViewPayments ? withoutBookingFinancials(json) : json;
    }),
    bookingWindow: {
      from: bookingWindowFrom.toISOString(), to: bookingWindowTo.toISOString(),
      truncated: bookings.truncated,
    },
    packageScopes,
    payments: payments.map(paymentJson),
    notifications,
    rescheduleRequests: rescheduleRequests.map(rescheduleRequestJson),
    integrityFlags: integrityFlags.map(integrityFlagJson),
    // A club account operates one club and never switches; the profile
    // view reads this rather than inferring it from the membership count.
    clubAccount: isClubAccount(user),
  });
}));
