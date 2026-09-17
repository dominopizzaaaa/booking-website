import {
  Banknote,
  Bell,
  CalendarClock,
  CalendarX2,
  CircleAlert,
  CircleCheck,
  Handshake,
  Info,
  ShieldAlert,
  UserCheck,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * One alert vocabulary, two audiences.
 *
 * The server sends a `type` on every alert, but the two streams grew separate
 * vocabularies: workspace alerts use short names (PAYMENT), customer alerts
 * use event names (BOOKING_RESCHEDULED), and rows written before typed alerts
 * shipped carry only a title. Matching on the type first and falling back to
 * the wording keeps every one of those readable, and an unrecognised type
 * degrades to a neutral bell rather than breaking the list.
 */
export type AlertKind =
  | 'booking'
  | 'payment'
  | 'payout'
  | 'reschedule'
  | 'cancellation'
  | 'pending'
  | 'integrity'
  | 'attendance'
  | 'notice';

export type AlertAppearance = {
  kind: AlertKind;
  icon: LucideIcon;
  label: string;
  /** Tailwind classes for the icon medallion, tuned for the calm palette. */
  tone: string;
};

const appearances: Record<AlertKind, AlertAppearance> = {
  booking: { kind: 'booking', icon: CircleCheck, label: 'Booking', tone: 'bg-[#e4eedb] text-[#5c7a4d]' },
  payment: { kind: 'payment', icon: Banknote, label: 'Payment', tone: 'bg-[#e3eef0] text-[#4d7580]' },
  payout: { kind: 'payout', icon: Wallet, label: 'Payout', tone: 'bg-[#e6ecf3] text-[#5a708c]' },
  reschedule: { kind: 'reschedule', icon: CalendarClock, label: 'Reschedule', tone: 'bg-[#f3ecd9] text-[#8d7740]' },
  cancellation: { kind: 'cancellation', icon: CalendarX2, label: 'Cancellation', tone: 'bg-[#f6e3dc] text-[#9c6450]' },
  pending: { kind: 'pending', icon: CircleAlert, label: 'Needs you', tone: 'bg-[#f6ebd5] text-[#94793c]' },
  integrity: { kind: 'integrity', icon: ShieldAlert, label: 'Review', tone: 'bg-[#f0e6ef] text-[#7d5f7c]' },
  attendance: { kind: 'attendance', icon: UserCheck, label: 'Attendance', tone: 'bg-[#e8eee3] text-[#65795a]' },
  notice: { kind: 'notice', icon: Bell, label: 'Update', tone: 'bg-[#eceeea] text-[#7d857b]' },
};

const byType: Record<string, AlertKind> = {
  // Workspace vocabulary.
  BOOKING: 'booking',
  PAYMENT: 'payment',
  PAYOUT: 'payout',
  RESCHEDULE: 'reschedule',
  CANCELLATION: 'cancellation',
  PENDING_ACTION: 'pending',
  INTEGRITY: 'integrity',
  ATTENDANCE: 'attendance',
  NOTICE: 'notice',
  // Customer account vocabulary.
  BOOKING_CREATED: 'booking',
  BOOKING_CONFIRMED: 'booking',
  BOOKING_COMPLETED: 'booking',
  BOOKING_REQUESTED: 'pending',
  BOOKING_PENDING: 'pending',
  BOOKING_ASSIGNED: 'pending',
  BOOKING_CANCELLED: 'cancellation',
  BOOKING_RESCHEDULED: 'reschedule',
  RESCHEDULE_REQUESTED: 'reschedule',
  RESCHEDULE_ACCEPTED: 'reschedule',
  RESCHEDULE_DECLINED: 'reschedule',
  RESCHEDULE_WITHDRAWN: 'reschedule',
  PAYMENT_RECORDED: 'payment',
  PAYMENT_REVERSED: 'payment',
};

function kindFromWording(text: string): AlertKind {
  const value = text.toLowerCase();
  if (value.includes('payout')) return 'payout';
  if (value.includes('payment') || value.includes('paid') || value.includes('receipt')) return 'payment';
  if (value.includes('reschedul') || value.includes('new time')) return 'reschedule';
  if (value.includes('cancel')) return 'cancellation';
  if (value.includes('flag') || value.includes('review')) return 'integrity';
  if (value.includes('attend') || value.includes('no-show')) return 'attendance';
  if (value.includes('await') || value.includes('pending') || value.includes('accept')) return 'pending';
  if (value.includes('booking') || value.includes('lesson') || value.includes('session')) return 'booking';
  return 'notice';
}

export function alertKind(
  alert: { type?: string | null; title?: string; message?: string; actionNeeded?: boolean },
): AlertKind {
  const typed = alert.type ? byType[alert.type] : undefined;
  if (typed) return typed;
  const guessed = kindFromWording(`${alert.title ?? ''} ${alert.message ?? ''}`);
  // An alert that asks for something is worth marking as such even when its
  // wording put it in a gentler bucket.
  return guessed === 'notice' && alert.actionNeeded ? 'pending' : guessed;
}

export function alertAppearance(
  alert: { type?: string | null; title?: string; message?: string; actionNeeded?: boolean },
): AlertAppearance {
  return appearances[alertKind(alert)];
}

/** How many alerts to show before offering the rest behind "Show all". */
export const alertPageSize = 5;

/**
 * Unread first, newest first within each group — the Instagram ordering the
 * list is modelled on, so what needs attention is never below the fold.
 */
export function sortAlerts<T extends { read: boolean; createdAt?: string }>(alerts: T[]): T[] {
  const at = (value?: string) => {
    if (!value) return Number.NEGATIVE_INFINITY;
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return [...alerts].sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1;
    return at(b.createdAt) - at(a.createdAt);
  });
}
