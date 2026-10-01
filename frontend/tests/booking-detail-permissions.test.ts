import { describe, expect, it } from 'vitest';
import {
  attendanceOpen,
  bookingDetailCapabilities,
  canCompleteClass,
  lessonHasEnded,
  lessonHasStarted,
  nextTimingBoundary,
  runClassAvailability,
} from '../src/components/workspace/booking-detail-permissions';
import type { ClubPermission, WorkspaceResponse } from '../src/lib/types';

function workspaceAccess(
  accessMode: 'CLUB_ACCOUNT' | 'COACH' | 'STAFF',
  permissions: ClubPermission[] = [],
) {
  return {
    accessMode,
    permissions,
    user: { accountType: accessMode === 'CLUB_ACCOUNT' ? 'CLUB' : 'COACH' },
  } as unknown as WorkspaceResponse;
}

describe('bookingDetailCapabilities', () => {
  it('keeps a view-only staff booking detail read-only', () => {
    expect(bookingDetailCapabilities(workspaceAccess('STAFF', ['BOOKINGS_VIEW']))).toMatchObject({
      canManageBookings: false,
      canViewPayments: false,
      canRecordPayments: false,
      canReversePayments: false,
    });
  });

  it('keeps booking and payment mutations independently permissioned', () => {
    expect(bookingDetailCapabilities(workspaceAccess('STAFF', ['BOOKINGS_MANAGE']))).toMatchObject({
      canManageBookings: true,
      canViewPayments: false,
      canRecordPayments: false,
      canReversePayments: false,
    });
    expect(bookingDetailCapabilities(workspaceAccess('STAFF', ['BOOKINGS_VIEW', 'PAYMENTS_RECORD']))).toMatchObject({
      canManageBookings: false,
      canViewPayments: true,
      canRecordPayments: true,
      canReversePayments: false,
    });
    expect(bookingDetailCapabilities(workspaceAccess('STAFF', ['BOOKINGS_VIEW', 'PAYMENTS_REVERSE']))).toMatchObject({
      canManageBookings: false,
      canViewPayments: true,
      canRecordPayments: false,
      canReversePayments: true,
    });
    expect(bookingDetailCapabilities(workspaceAccess('STAFF', ['BOOKINGS_VIEW', 'PAYMENTS_VIEW']))).toMatchObject({
      canManageBookings: false,
      canViewPayments: true,
      canRecordPayments: false,
      canReversePayments: false,
    });
  });

  it('preserves full booking controls for the club account and coaches', () => {
    expect(bookingDetailCapabilities(workspaceAccess('CLUB_ACCOUNT'))).toMatchObject({
      canManageBookings: true,
      canViewPayments: true,
      canRecordPayments: true,
      canReversePayments: true,
    });
    expect(bookingDetailCapabilities(workspaceAccess('COACH'))).toMatchObject({
      canManageBookings: true,
      canViewPayments: false,
      canRecordPayments: false,
      canReversePayments: false,
    });
  });
});


const start = Date.parse('2026-10-01T10:00:00.000Z');
const end = Date.parse('2026-10-01T11:00:00.000Z');
const lesson = (overrides: Partial<{ status: 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'COMPLETED'; coachAcceptance: 'NOT_REQUIRED' | 'PENDING' | 'ACCEPTED' | 'DECLINED' }> = {}) => ({
  status: 'CONFIRMED' as const,
  coachAcceptance: 'NOT_REQUIRED' as const,
  startAt: new Date(start).toISOString(),
  endAt: new Date(end).toISOString(),
  ...overrides,
});

describe('lesson timing', () => {
  it('treats the exact start and end instants as reached', () => {
    expect(lessonHasStarted(lesson().startAt, start - 1)).toBe(false);
    expect(lessonHasStarted(lesson().startAt, start)).toBe(true);
    expect(lessonHasEnded(lesson().endAt, end - 1)).toBe(false);
    expect(lessonHasEnded(lesson().endAt, end)).toBe(true);
  });

  it('never treats an unparseable time as reached', () => {
    expect(lessonHasStarted('not a date', end)).toBe(false);
    expect(lessonHasEnded('', end)).toBe(false);
  });

  it('wakes for the next boundary and stops once the lesson is over', () => {
    expect(nextTimingBoundary(lesson(), start - 60_000)).toBe(start);
    expect(nextTimingBoundary(lesson(), start)).toBe(end);
    expect(nextTimingBoundary(lesson(), start + 30 * 60_000)).toBe(end);
    expect(nextTimingBoundary(lesson(), end)).toBeNull();
  });
});

describe('attendanceOpen', () => {
  it('opens roll call when the lesson starts rather than when it ends', () => {
    expect(attendanceOpen(lesson(), start - 1)).toBe(false);
    expect(attendanceOpen(lesson(), start)).toBe(true);
    expect(attendanceOpen(lesson(), start + 30 * 60_000)).toBe(true);
    expect(attendanceOpen(lesson(), end + 60_000)).toBe(true);
  });

  it('keeps completed lessons correctable', () => {
    expect(attendanceOpen(lesson({ status: 'COMPLETED' }), end + 60_000)).toBe(true);
  });

  it('stays closed for pending, cancelled, and coach-pending lessons', () => {
    expect(attendanceOpen(lesson({ status: 'PENDING' }), end)).toBe(false);
    expect(attendanceOpen(lesson({ status: 'CANCELLED' }), end)).toBe(false);
    expect(attendanceOpen(lesson({ coachAcceptance: 'PENDING' }), end)).toBe(false);
  });
});

describe('runClassAvailability', () => {
  it('announces when a confirmed Class will open', () => {
    expect(runClassAvailability(lesson(), start - 1)).toEqual({ state: 'NOT_STARTED', opensAt: lesson().startAt });
  });

  it('opens from the start and reports when the Class has ended', () => {
    expect(runClassAvailability(lesson(), start)).toEqual({ state: 'OPEN', ended: false });
    expect(runClassAvailability(lesson(), end)).toEqual({ state: 'OPEN', ended: true });
    expect(runClassAvailability(lesson({ status: 'COMPLETED' }), end)).toEqual({ state: 'OPEN', ended: true });
  });

  it('is unavailable until the Class actually runs', () => {
    expect(runClassAvailability(lesson({ status: 'PENDING', coachAcceptance: 'PENDING' }), start)).toEqual({ state: 'UNAVAILABLE' });
    expect(runClassAvailability(lesson({ status: 'PENDING', coachAcceptance: 'ACCEPTED' }), start)).toEqual({ state: 'UNAVAILABLE' });
    expect(runClassAvailability(lesson({ status: 'CANCELLED' }), start)).toEqual({ state: 'UNAVAILABLE' });
  });
});

describe('canCompleteClass', () => {
  it('allows completion only for a confirmed lesson that has ended', () => {
    expect(canCompleteClass(lesson(), end - 1)).toBe(false);
    expect(canCompleteClass(lesson(), end)).toBe(true);
    expect(canCompleteClass(lesson({ status: 'COMPLETED' }), end)).toBe(false);
    expect(canCompleteClass(lesson({ status: 'PENDING' }), end)).toBe(false);
  });
});
