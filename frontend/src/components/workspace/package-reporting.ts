import type { LessonPackage, Location, Service } from '@/lib/types';

export type PurchasedPackageState = 'ACTIVE' | 'UNPAID' | 'EXPIRED' | 'EXHAUSTED';

export function purchasedPackageState(pkg: LessonPackage, now = Date.now()): PurchasedPackageState {
  if (!pkg.paid) return 'UNPAID';
  if (new Date(pkg.expiresAt).getTime() < now) return 'EXPIRED';
  if (pkg.usedCredits >= pkg.totalCredits) return 'EXHAUSTED';
  return 'ACTIVE';
}

export function purchasedPackageScopes(pkg: LessonPackage, services: Service[], locations: Location[]) {
  const classIds = pkg.serviceIds?.length ? pkg.serviceIds : pkg.serviceId ? [pkg.serviceId] : [];
  const rentalIds = pkg.rentalLocationIds ?? [];
  return {
    classNames: classIds.length
      ? classIds.map(id => services.find(service => service.id === id)?.name ?? 'Archived class')
      : rentalIds.length ? [] : ['All classes'],
    rentalNames: rentalIds.map(id => locations.find(location => location.id === id)?.name ?? 'Unavailable rental location'),
  };
}
