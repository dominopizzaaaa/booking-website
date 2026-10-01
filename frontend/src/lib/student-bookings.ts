import type { AccountBooking, ChildScheduleItem } from './types';

/**
 * How a booking reads to the learner. Shared by the list, the calendar and
 * the booking dialog so every view names the same session the same way.
 */
export type StudentBookingState =
  | 'Cancelled' | 'Completed' | 'In progress' | 'Awaiting coach' | 'Awaiting confirmation' | 'Confirmed';

export function bookingCancelled(item: AccountBooking) {
  return (
    item.booking.status === 'CANCELLED' ||
    item.participant.cancelled === true ||
    !!item.participant.cancelledAt
  );
}

export function bookingState(item: AccountBooking, now = Date.now()): StudentBookingState {
  if (bookingCancelled(item)) return 'Cancelled';
  const startsAt = new Date(item.booking.startAt).getTime();
  const endsAt = new Date(item.booking.endAt).getTime();
  if (item.booking.status === 'COMPLETED' || endsAt <= now) return 'Completed';
  if (startsAt <= now) return 'In progress';
  if (item.awaitingCoach || item.booking.coachAcceptance === 'PENDING') return 'Awaiting coach';
  if (item.booking.status === 'PENDING') return 'Awaiting confirmation';
  return 'Confirmed';
}

export function isUpcoming(item: AccountBooking, now = Date.now()) {
  return (
    !bookingCancelled(item) &&
    item.booking.status !== 'COMPLETED' &&
    new Date(item.booking.startAt).getTime() > now
  );
}

export function isInProgress(item: AccountBooking, now = Date.now()) {
  return bookingState(item, now) === 'In progress';
}

/** A proposal the student has to answer, rather than one they raised. */
export function incomingRequest(item: AccountBooking) {
  const request = item.rescheduleRequest;
  return request && request.status === 'PENDING' && request.requestedByRole !== 'STUDENT'
    ? request
    : null;
}

export function outgoingRequest(item: AccountBooking) {
  const request = item.rescheduleRequest;
  return request && request.status === 'PENDING' && request.requestedByRole === 'STUDENT'
    ? request
    : null;
}

/**
 * A guardian's read-only view of a child's place. There is no reschedule
 * negotiation or coach-acceptance detail in the projection, so the vocabulary
 * is the subset the server can actually support.
 */
export function childScheduleState(item: Pick<ChildScheduleItem, 'status' | 'startAt' | 'endAt'>, now = Date.now()): StudentBookingState {
  if (item.status === 'CANCELLED') return 'Cancelled';
  const startsAt = new Date(item.startAt).getTime();
  const endsAt = new Date(item.endAt).getTime();
  if (item.status === 'COMPLETED' || endsAt <= now) return 'Completed';
  if (startsAt <= now) return 'In progress';
  if (item.status === 'PENDING') return 'Awaiting confirmation';
  return 'Confirmed';
}

export function attendanceLabel(value: ChildScheduleItem['attendance'] | undefined) {
  if (value === 'PRESENT') return 'Attended';
  if (value === 'LATE') return 'Attended (arrived late)';
  if (value === 'ABSENT') return 'Absent';
  if (value === 'EXCUSED') return 'Excused';
  return '';
}
