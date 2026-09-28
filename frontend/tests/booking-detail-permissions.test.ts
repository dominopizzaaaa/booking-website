import { describe, expect, it } from 'vitest';
import { bookingDetailCapabilities } from '../src/components/workspace/booking-detail-permissions';
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
