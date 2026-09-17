import type { Business, Membership, Prisma, User } from '@prisma/client';
import { prisma } from './db.js';

export const bookingInclude = { service: true, instructor: true, location: true, participants: { include: { customer: true } } } satisfies Prisma.BookingInclude;
export type FullBooking = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;
export type MembershipWithBusiness = Membership & { business: Business };
export type AccountType = 'CUSTOMER' | 'COACH' | 'OWNER';
export type MembershipRole = 'OWNER' | 'ADMIN' | 'COACH';

export const publicBusiness = (b: Business) => ({
  id: b.id, name: b.name, slug: b.slug, ownerName: b.ownerName, email: b.email, timezone: b.timezone,
  currency: b.currency, color: b.color, tagline: b.tagline, cancellationHours: b.cancellationHours, isDemo: b.isDemo,
});
export const publicBookingBusiness = (b: Business) => ({
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

// Account identity and workspace authorization are deliberately serialized separately.
export const userJson = (user: User) => ({
  id: user.id, name: user.name, email: user.email, phone: user.phone, parentName: user.parentName,
  accountType: user.accountType as AccountType,
});
export const workspaceUserJson = (user: User, membership: Pick<Membership, 'role' | 'instructorId'>) => ({
  ...userJson(user), role: membership.role as MembershipRole, instructorId: membership.instructorId,
});
export const membershipJson = (membership: MembershipWithBusiness) => ({
  id: membership.id, userId: membership.userId, businessId: membership.businessId, role: membership.role as MembershipRole,
  instructorId: membership.instructorId, active: membership.active, createdAt: membership.createdAt.toISOString(),
  business: publicBusiness(membership.business),
});

export type AuthState = {
  user: ReturnType<typeof userJson>;
  membership: ReturnType<typeof membershipJson> | null;
  business: ReturnType<typeof publicBusiness> | null;
  memberships: ReturnType<typeof membershipJson>[];
};

/**
 * Build the canonical account/session response. Undefined selects the first active
 * membership; null intentionally represents no selected workspace.
 */
export async function authState(userId: string, activeMembershipId?: string | null): Promise<AuthState> {
  const account = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { memberships: { include: { business: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  const { memberships, ...user } = account;
  const selected = account.accountType === 'CUSTOMER' || activeMembershipId === null
    ? null
    : activeMembershipId === undefined
      ? memberships.find(candidate => candidate.active && candidate.userId === account.id
        && candidate.businessId === candidate.business.id) ?? null
      : memberships.find(candidate => candidate.id === activeMembershipId && candidate.active
        && candidate.userId === account.id && candidate.businessId === candidate.business.id) ?? null;
  return {
    user: userJson(user),
    membership: selected ? membershipJson(selected) : null,
    business: selected ? publicBusiness(selected.business) : null,
    memberships: memberships.map(membershipJson),
  };
}

export const serviceJson = (s: any) => ({
  id: s.id, name: s.name, description: s.description, category: s.category, type: s.type,
  duration: s.duration, price: s.price, capacity: s.capacity, bufferMinutes: s.bufferMinutes,
  noticeHours: s.noticeHours, color: s.color, active: s.active,
  locations: s.locations.map((l: any) => ({
    locationId: l.locationId, price: l.price, duration: l.duration,
    instructorIds: l.instructors.map((i: any) => i.instructorId),
  })),
});
type ServiceFinancials = { price: unknown; locations: Array<{ price: unknown }> };
type ServiceWithoutFinancials<T extends ServiceFinancials> = Omit<T, 'price' | 'locations'> & {
  locations: Array<Omit<T['locations'][number], 'price'>>;
};
export function withoutServiceFinancials<T extends ServiceFinancials>(service: T): ServiceWithoutFinancials<T> {
  const { price: _price, locations, ...safe } = service;
  return {
    ...safe,
    locations: locations.map(location => {
      const { price: _locationPrice, ...details } = location;
      return details;
    }),
  } as ServiceWithoutFinancials<T>;
}
type BookingFinancials = {
  price: unknown;
  participants: Array<{ paid: unknown; price: unknown; packageId: unknown }>;
};
type BookingWithoutFinancials<T extends BookingFinancials> = Omit<T, 'price' | 'participants'> & {
  participants: Array<Omit<T['participants'][number], 'paid' | 'price' | 'packageId'>>;
};
export function withoutBookingFinancials<T extends BookingFinancials>(booking: T): BookingWithoutFinancials<T> {
  const { price: _price, participants, ...safe } = booking;
  return {
    ...safe,
    participants: participants.map(participant => {
      const { paid: _paid, price: _participantPrice, packageId: _packageId, ...details } = participant;
      return details;
    }),
  } as BookingWithoutFinancials<T>;
}
export function bookingJson(b: FullBooking, options: { includeNotes?: boolean } = {}) {
  return { id: b.id, serviceId: b.serviceId, serviceName: b.service.name, instructorId: b.instructorId, instructorName: b.instructor.name, locationId: b.locationId, locationName: b.location.name, locationColor: b.location.color, startAt: b.startAt.toISOString(), endAt: b.endAt.toISOString(), status: b.status, type: b.type, capacity: b.capacity, price: b.price, ...(options.includeNotes === false ? {} : { notes: b.notes }), address: b.address, recurringId: b.recurringId,
    participants: b.participants.filter(p => !p.cancelledAt).map(p => ({ id: p.id, customerId: p.customerId, name: p.customer.name, email: p.customer.email, attendance: p.attendance, paid: p.paid, price: p.price, packageId: p.packageId, notes: p.notes })) };
}
export const packageJson = (p: any) => ({ id: p.id, customerId: p.customerId, customerName: p.customer.name, name: p.name, serviceId: p.serviceId, totalCredits: p.totalCredits, usedCredits: p.usedCredits, price: p.price, expiresAt: p.expiresAt.toISOString(), paid: p.paid });
