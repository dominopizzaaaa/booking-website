import type { CoachAcceptance, Status, WorkspaceResponse } from '../../lib/types';

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

type BookingTiming = { status: Status; coachAcceptance: CoachAcceptance; startAt: string; endAt: string };

export function lessonHasStarted(startAt: string, now: number) {
  const start = new Date(startAt).getTime();
  return Number.isFinite(start) && start <= now;
}

export function lessonHasEnded(endAt: string, now: number) {
  const end = new Date(endAt).getTime();
  return Number.isFinite(end) && end <= now;
}

/** A class that actually runs: confirmed (or completed) and not waiting on its coach. */
function classIsRunnable(booking: BookingTiming) {
  return (booking.status === 'CONFIRMED' || booking.status === 'COMPLETED') && booking.coachAcceptance !== 'PENDING';
}

/**
 * Roll call happens court-side, so attendance opens when the lesson starts
 * rather than after it ends. Every other rule matches the API.
 */
export function attendanceOpen(booking: BookingTiming, now: number) {
  return classIsRunnable(booking) && lessonHasStarted(booking.startAt, now);
}

export type RunClassAvailability =
  | { state: 'UNAVAILABLE' }
  | { state: 'NOT_STARTED'; opensAt: string }
  | { state: 'OPEN'; ended: boolean };

/** When the "Run this Class" entry point is shown, and whether it opens yet. */
export function runClassAvailability(booking: BookingTiming, now: number): RunClassAvailability {
  if (!classIsRunnable(booking)) return { state: 'UNAVAILABLE' };
  if (!lessonHasStarted(booking.startAt, now)) return { state: 'NOT_STARTED', opensAt: booking.startAt };
  return { state: 'OPEN', ended: lessonHasEnded(booking.endAt, now) };
}

/** Completion is still only for a confirmed lesson that has finished. */
export function canCompleteClass(booking: BookingTiming, now: number) {
  return booking.status === 'CONFIRMED' && booking.coachAcceptance !== 'PENDING' && lessonHasEnded(booking.endAt, now);
}

/**
 * The next instant at which any of these rules can change, so an open dialog
 * can re-render exactly when attendance opens or the class ends.
 */
export function nextTimingBoundary(booking: Pick<BookingTiming, 'startAt' | 'endAt'>, now: number) {
  const boundaries = [booking.startAt, booking.endAt]
    .map(value => new Date(value).getTime())
    .filter(value => Number.isFinite(value) && value > now);
  return boundaries.length ? Math.min(...boundaries) : null;
}
