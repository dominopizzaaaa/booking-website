import type { Prisma } from '@prisma/client';
export const bookingInclude = { service: true, instructor: true, location: true, participants: { include: { customer: true } } } satisfies Prisma.BookingInclude;
export type FullBooking = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;
export const publicBusiness = (b: any) => ({ id: b.id, name: b.name, slug: b.slug, ownerName: b.ownerName, email: b.email, timezone: b.timezone, currency: b.currency, color: b.color, tagline: b.tagline, cancellationHours: b.cancellationHours, isDemo: b.isDemo });
export const publicBookingBusiness = (b: any) => ({
  name: b.name, slug: b.slug, ownerName: b.ownerName, timezone: b.timezone, currency: b.currency,
  color: b.color, tagline: b.tagline, cancellationHours: b.cancellationHours,
});
export const publicInstructor = (instructor: any) => ({
  id: instructor.id, name: instructor.name, initials: instructor.initials, color: instructor.color,
  specialty: instructor.specialty, active: instructor.active,
});
export const publicLocation = (location: any) => ({
  id: location.id, name: location.name, address: location.address, type: location.type, color: location.color,
  requiresApproval: location.requiresApproval, active: location.active,
});
export const userJson = (u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, instructorId: u.instructorId });
export const serviceJson = (s: any) => ({
  id: s.id, name: s.name, description: s.description, category: s.category, type: s.type,
  duration: s.duration, price: s.price, capacity: s.capacity, bufferMinutes: s.bufferMinutes,
  noticeHours: s.noticeHours, color: s.color, active: s.active,
  locations: s.locations.map((l: any) => ({
    locationId: l.locationId, price: l.price, duration: l.duration,
    instructorIds: l.instructors.map((i: any) => i.instructorId),
  })),
});
export function bookingJson(b: FullBooking, options: { includeNotes?: boolean } = {}) {
  return { id: b.id, serviceId: b.serviceId, serviceName: b.service.name, instructorId: b.instructorId, instructorName: b.instructor.name, locationId: b.locationId, locationName: b.location.name, locationColor: b.location.color, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), status: b.status, type: b.type, capacity: b.capacity, price: b.price, ...(options.includeNotes === false ? {} : { notes: b.notes }), address: b.address, recurringId: b.recurringId,
    participants: b.participants.filter(p => !p.cancelledAt).map(p => ({ id: p.id, customerId: p.customerId, name: p.customer.name, email: p.customer.email, attendance: p.attendance, paid: p.paid, price: p.price, packageId: p.packageId, notes: p.notes })) };
}
export const packageJson = (p: any) => ({ id: p.id, customerId: p.customerId, customerName: p.customer.name, name: p.name, serviceId: p.serviceId, totalCredits: p.totalCredits, usedCredits: p.usedCredits, price: p.price, expiresAt: p.expiresAt.toISOString(), paid: p.paid });
