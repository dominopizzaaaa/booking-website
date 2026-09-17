import { Router } from 'express';
import { prisma } from './db.js';
import { asyncRoute, coachScoped } from './http.js';
import { bookingInclude, bookingJson, isClubAccount, membershipJson, packageJson, paymentJson, publicBusiness, serviceJson, withoutBookingFinancials, withoutServiceFinancials, workspaceUserJson } from './serializers.js';
import { integrityFlagInclude, integrityFlagJson } from './integrity.js';
import { rescheduleRequestJson } from './reschedule.js';
import { isReplaceableInstructorPlaceholder } from './staff.js';
export const workspaceRouter = Router();
workspaceRouter.get('/workspace', asyncRoute(async (req, res) => {
  const { business, user, membership } = req.auth;
  if (!business || !membership) throw new Error('Workspace middleware did not provide an active membership');
  const coach = coachScoped(req.auth);
  const instructorId = coach ? membership.instructorId || '__none__' : undefined;
  const studentScope = coach ? { participants: { some: { booking: { businessId: business.id, instructorId } } } } : {};
  const assignedServiceLocationScope = { instructors: { some: { instructorId } } };
  const [instructors, locations, services, availability, exceptions, students, packages, bookings, payments, notifications, rescheduleRequests, integrityFlags] = await Promise.all([
    prisma.instructor.findMany({
      where: { businessId: business.id, ...(coach ? { id: instructorId } : {}) },
      include: { membership: { select: {
        id: true, userId: true,
        user: { select: { id: true, email: true, passwordHash: true, accountType: true } },
      } } },
      orderBy: { name: 'asc' },
    }),
    prisma.location.findMany({
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
    }),
    prisma.service.findMany({
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
    }),
    prisma.availability.findMany({ where: { businessId: business.id, instructorId } }),
    prisma.availabilityException.findMany({ where: { businessId: business.id, instructorId } }),
    prisma.student.findMany({ where: { businessId: business.id, ...studentScope }, include: { participants: { where: { cancelledAt: null, booking: { status: { not: 'CANCELLED' }, instructorId } }, include: { booking: { select: { startAt: true } } } } }, orderBy: { name: 'asc' } }),
    coach ? Promise.resolve([]) : prisma.lessonPackage.findMany({ where: { businessId: business.id }, include: { student: true } }),
    prisma.booking.findMany({ where: { businessId: business.id, instructorId }, include: bookingInclude, orderBy: { startAt: 'asc' } }),
    coach ? Promise.resolve([]) : prisma.payment.findMany({ where: { businessId: business.id }, include: { student: true, instructor: { select: { name: true } } }, orderBy: { paidAt: 'desc' } }),
    prisma.notification.findMany({ where: { businessId: business.id, ...(coach ? { instructorId } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.rescheduleRequest.findMany({
      where: { businessId: business.id, ...(coach ? { booking: { instructorId } } : {}) },
      include: { booking: { include: {
        business: { select: { id: true, name: true, timezone: true } },
        instructor: { select: { id: true, name: true, rescheduleNoticeHours: true } },
        service: { select: { name: true } },
        location: { select: { name: true } },
      } } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    }),
    // The safeguard is the club's business to review, not a coach's.
    coach ? Promise.resolve([]) : prisma.integrityFlag.findMany({
      where: { businessId: business.id },
      include: integrityFlagInclude,
      orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
      take: 100,
    }),
  ]);
  res.json({ business: publicBusiness(business), user: workspaceUserJson(user, membership), membership: membershipJson(membership), memberships: req.auth.memberships.map(membershipJson), instructors: instructors.map(({ membership: affiliation, ...instructor }) => ({
    ...instructor,
    // The browser needs to distinguish a genuinely unclaimed roster row from
    // a removed coach whose historical identity is intentionally retained.
    accountLinkAvailable: !affiliation || isReplaceableInstructorPlaceholder(instructor.id, affiliation),
  })), locations, services: services.map(service => {
    const json = serviceJson(service);
    return coach ? withoutServiceFinancials(json) : json;
  }), availability, exceptions,
    students: students.map(({ participants, ...c }) => ({ ...c, bookingCount: participants.length, lastBookingAt: participants.length ? new Date(Math.max(...participants.map(p => p.booking.startAt.getTime()))).toISOString() : null })),
    packages: packages.map(packageJson), bookings: bookings.map(b => {
      const json = bookingJson(b);
      return coach ? withoutBookingFinancials(json) : json;
    }),
    payments: payments.map(paymentJson),
    notifications,
    rescheduleRequests: rescheduleRequests.map(rescheduleRequestJson),
    integrityFlags: integrityFlags.map(integrityFlagJson),
    // A club account operates one club and never switches; the profile
    // view reads this rather than inferring it from the membership count.
    clubAccount: isClubAccount(user),
  });
}));
