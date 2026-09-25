import { describe, expect, it } from 'vitest';
import type { LessonPackage, Location, Service } from '../src/lib/types';
import { purchasedPackageScopes, purchasedPackageState } from '../src/components/workspace/package-reporting';

const basePackage: LessonPackage = {
  id: 'package-1',
  studentId: 'student-1',
  studentName: 'Avery Player',
  name: 'Flexible pass',
  serviceId: null,
  serviceIds: [],
  rentalLocationIds: [],
  totalCredits: 4,
  usedCredits: 0,
  price: 20_000,
  expiresAt: '2026-10-01T00:00:00.000Z',
  paid: true,
};

describe('purchasedPackageState', () => {
  const now = new Date('2026-09-25T00:00:00.000Z').getTime();

  it('never reports an unpaid package as active', () => {
    expect(purchasedPackageState({ ...basePackage, paid: false }, now)).toBe('UNPAID');
    expect(purchasedPackageState({ ...basePackage, paid: false, expiresAt: '2026-09-01T00:00:00.000Z' }, now)).toBe('UNPAID');
    expect(purchasedPackageState({ ...basePackage, paid: false, usedCredits: 4 }, now)).toBe('UNPAID');
  });

  it('distinguishes expired, exhausted, and active entitlements', () => {
    expect(purchasedPackageState({ ...basePackage, expiresAt: '2026-09-24T23:59:59.999Z' }, now)).toBe('EXPIRED');
    expect(purchasedPackageState({ ...basePackage, expiresAt: '2026-09-25T00:00:00.000Z' }, now)).toBe('ACTIVE');
    expect(purchasedPackageState({ ...basePackage, usedCredits: 4 }, now)).toBe('EXHAUSTED');
    expect(purchasedPackageState(basePackage, now)).toBe('ACTIVE');
  });
});

describe('purchasedPackageScopes', () => {
  const services = [
    { id: 'class-1', name: 'Private tennis', active: true },
  ] as Service[];
  const locations = [
    { id: 'court-1', name: 'Centre court', active: true },
  ] as Location[];

  it('reports immutable class and rental scopes, including archived records', () => {
    expect(purchasedPackageScopes({
      ...basePackage,
      serviceIds: ['class-1', 'archived-class'],
      rentalLocationIds: ['court-1', 'archived-court'],
    }, services, locations)).toEqual({
      classNames: ['Private tennis', 'Archived class'],
      rentalNames: ['Centre court', 'Unavailable rental location'],
    });
  });

  it('keeps legacy unscoped packages valid for all classes', () => {
    expect(purchasedPackageScopes(basePackage, services, locations)).toEqual({
      classNames: ['All classes'],
      rentalNames: [],
    });
  });

  it('honours the legacy single-class scope', () => {
    expect(purchasedPackageScopes({ ...basePackage, serviceId: 'class-1' }, services, locations)).toEqual({
      classNames: ['Private tennis'],
      rentalNames: [],
    });
  });
});
