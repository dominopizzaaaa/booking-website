import { Router } from 'express';
import { prisma } from './db.js';
import { asyncRoute } from './http.js';
import { bookingInclude, bookingJson, membershipJson, packageJson, publicBusiness, serviceJson, workspaceUserJson } from './serializers.js';
export const workspaceRouter = Router();
workspaceRouter.get('/workspace', asyncRoute(async (req, res) => {
  const { business, user, membership } = req.auth;
  if (!business || !membership) throw new Error('Workspace middleware did not provide an active membership');
  const coach = membership.role === 'COACH';
  const instructorId = coach ? membership.instructorId || '__none__' : undefined;
  const customerScope = coach ? { participants: { some: { booking: { businessId: business.id, instructorId } } } } : {};
  const [instructors, locations, services, availability, exceptions, customers, packages, bookings, payments, notifications] = await Promise.all([
    prisma.instructor.findMany({ where: { businessId: business.id, ...(coach ? { id: instructorId } : {}) }, orderBy: { name: 'asc' } }),
    prisma.location.findMany({ where: { businessId: business.id }, orderBy: { name: 'asc' } }),
    prisma.service.findMany({ where: { businessId: business.id }, include: { locations: { include: { instructors: true } } }, orderBy: { name: 'asc' } }),
    prisma.availability.findMany({ where: { businessId: business.id, instructorId } }),
    prisma.availabilityException.findMany({ where: { businessId: business.id, instructorId } }),
    prisma.customer.findMany({ where: { businessId: business.id, ...customerScope }, include: { participants: { where: { cancelledAt: null, booking: { status: { not: 'CANCELLED' }, instructorId } }, include: { booking: { select: { startAt: true } } } } }, orderBy: { name: 'asc' } }),
    coach ? Promise.resolve([]) : prisma.lessonPackage.findMany({ where: { businessId: business.id }, include: { customer: true } }),
    prisma.booking.findMany({ where: { businessId: business.id, instructorId }, include: bookingInclude, orderBy: { startAt: 'asc' } }),
    coach ? Promise.resolve([]) : prisma.payment.findMany({ where: { businessId: business.id }, include: { customer: true }, orderBy: { paidAt: 'desc' } }),
    prisma.notification.findMany({ where: { businessId: business.id, ...(coach ? { instructorId } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  res.json({ business: publicBusiness(business), user: workspaceUserJson(user, membership), membership: membershipJson(membership), memberships: req.auth.memberships.map(membershipJson), instructors, locations, services: services.map(service => { const json = serviceJson(service); return coach ? { ...json, locations: json.locations.filter((location: { instructorIds: string[] }) => location.instructorIds.includes(instructorId!)).map((location: { instructorIds: string[] }) => ({ ...location, instructorIds: [instructorId!] })) } : json; }), availability, exceptions,
    customers: customers.map(({ participants, ...c }) => ({ ...c, bookingCount: participants.length, lastBookingAt: participants.length ? new Date(Math.max(...participants.map(p => p.booking.startAt.getTime()))).toISOString() : null })),
    packages: packages.map(packageJson), bookings: bookings.map(b => bookingJson(b)), payments: payments.map(({ customer, ...p }) => ({ ...p, customerName: customer.name })), notifications });
}));
