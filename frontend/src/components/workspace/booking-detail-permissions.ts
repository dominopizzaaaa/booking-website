import type { WorkspaceResponse } from '../../lib/types';

export function bookingDetailCapabilities(data: WorkspaceResponse) {
  const mode = data.accessMode
    ?? (data.staffAccess ? 'STAFF' : data.user.accountType === 'CLUB' ? 'CLUB_ACCOUNT' : 'COACH');
  const permissions = data.permissions ?? data.staffAccess?.permissions ?? [];
  const clubAccount = mode === 'CLUB_ACCOUNT';

  return {
    mode,
    canManageBookings: clubAccount || mode === 'COACH' || permissions.includes('BOOKINGS_MANAGE'),
    canViewPayments: clubAccount || permissions.some(permission =>
      ['PAYMENTS_VIEW', 'PAYMENTS_RECORD', 'PAYMENTS_REVERSE', 'PAYOUTS_RECORD'].includes(permission)),
    canRecordPayments: clubAccount || permissions.includes('PAYMENTS_RECORD'),
    canReversePayments: clubAccount || permissions.includes('PAYMENTS_REVERSE'),
  };
}
