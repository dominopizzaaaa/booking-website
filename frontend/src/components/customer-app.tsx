'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  CircleDot,
  Clock3,
  Compass,
  ExternalLink,
  Home,
  Info,
  LoaderCircle,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Video,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { CourtlyLogo } from '@/components/public-booking';
import {
  ApiError,
  api,
  cancelAccountBooking,
  loadAccountBookings,
  loadAuthSession,
  loadSlots,
  logoutAccount,
  rescheduleAccountBooking,
} from '@/lib/api';
import type {
  AccountBooking,
  AuthSession,
  PublicBookingBusiness,
  PublicLocation,
  Slot,
} from '@/lib/types';
import { cn, dateKey, initials, money, shortDate, time } from '@/lib/utils';

type CustomerTab = 'home' | 'explore' | 'book' | 'alerts' | 'profile';
type BookingAction = {
  kind: 'cancel' | 'reschedule';
  participantId: string;
} | null;
type BookingFilter = 'all' | 'upcoming' | 'completed' | 'cancelled';
type Conflict = { date: string; reason: string };
type CustomerNotification = {
  id: string;
  type?: string;
  bookingId?: string;
  title: string;
  message: string;
  read: boolean;
  actionNeeded?: boolean;
  createdAt?: string;
  businessSlug?: string;
};
type KnownClub = {
  business: PublicBookingBusiness;
  bookingCount: number;
  nextAt?: string;
  lastAt?: string;
};

const primaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#103d2f] disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none';
const secondaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#dce3da] bg-white px-4 py-2.5 text-sm font-medium text-[#344d40] transition hover:border-[#bdcbbb] hover:bg-[#f3f6f1] disabled:cursor-not-allowed disabled:opacity-45';
const panel =
  'min-w-0 rounded-2xl border border-[#e5e9e4] bg-white shadow-[0_8px_30px_rgba(29,57,43,0.035)] [&_*]:min-w-0 [&_p]:break-words';
const field =
  '!min-h-12 !rounded-xl !border-[#dfe5df] !px-3.5 !text-base sm:!text-sm';

const tabs: Array<{ id: CustomerTab; label: string; icon: typeof Home }> = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'explore', label: 'Explore', icon: Compass },
  { id: 'book', label: 'Book', icon: Plus },
  { id: 'alerts', label: 'Alerts', icon: Bell },
  { id: 'profile', label: 'Profile', icon: UserRound },
];
const customerTabIds = new Set<CustomerTab>(tabs.map((tab) => tab.id));

function customerTab(value: string | null): CustomerTab {
  return value && customerTabIds.has(value as CustomerTab) ? (value as CustomerTab) : 'home';
}

function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
}

function conflictList(error: unknown): Conflict[] {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') {
    return [];
  }
  const conflicts = (error.details as { conflicts?: unknown }).conflicts;
  return Array.isArray(conflicts)
    ? conflicts.filter(
        (item): item is Conflict =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as Conflict).date === 'string' &&
          typeof (item as Conflict).reason === 'string',
      )
    : [];
}

function isCustomerSession(session: AuthSession | null) {
  if (!session) return false;
  if (session.user.accountType) return session.user.accountType === 'CUSTOMER';
  if (session.user.role) return session.user.role === 'CUSTOMER';
  return !session.membership && !session.business;
}

function bookingCancelled(item: AccountBooking) {
  return (
    item.booking.status === 'CANCELLED' ||
    item.participant.cancelled === true ||
    !!item.participant.cancelledAt
  );
}

function bookingState(item: AccountBooking, now = Date.now()) {
  if (bookingCancelled(item)) return 'Cancelled';
  const startsAt = new Date(item.booking.startAt).getTime();
  const endsAt = new Date(item.booking.endAt).getTime();
  if (
    item.booking.status === 'COMPLETED' ||
    endsAt <= now
  ) {
    return 'Completed';
  }
  if (startsAt <= now) return 'In progress';
  if (item.booking.status === 'PENDING') return 'Awaiting confirmation';
  return 'Confirmed';
}

function isUpcoming(item: AccountBooking, now = Date.now()) {
  return (
    !bookingCancelled(item) &&
    item.booking.status !== 'COMPLETED' &&
    new Date(item.booking.startAt).getTime() > now
  );
}

function isInProgress(item: AccountBooking, now = Date.now()) {
  return bookingState(item, now) === 'In progress';
}

function canChangeBooking(
  item: AccountBooking,
  kind: 'cancel' | 'reschedule',
  now = Date.now(),
) {
  const startsAt = new Date(item.booking.startAt).getTime();
  const cutoff = startsAt - item.business.cancellationHours * 3_600_000;
  const locallyAllowed =
    Number.isFinite(startsAt) &&
    !bookingCancelled(item) &&
    ['CONFIRMED', 'PENDING'].includes(item.booking.status) &&
    now < startsAt &&
    now <= cutoff;
  const serverAllows = kind === 'cancel' ? item.canCancel : item.canReschedule;
  return (
    locallyAllowed &&
    serverAllows !== false &&
    (kind === 'cancel' || item.booking.type === 'PRIVATE')
  );
}

function notificationArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.notifications)) return record.notifications;
  if (Array.isArray(record.items)) return record.items;
  if (record.data && typeof record.data === 'object') {
    const data = record.data as Record<string, unknown>;
    if (Array.isArray(data.notifications)) return data.notifications;
    if (Array.isArray(data.items)) return data.items;
  }
  return null;
}

function parseNotifications(value: unknown): CustomerNotification[] | null {
  const values = notificationArray(value);
  if (!values) return null;
  return values.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const item = candidate as Record<string, unknown>;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const message =
      typeof item.message === 'string'
        ? item.message.trim()
        : typeof item.body === 'string'
          ? item.body.trim()
          : typeof item.description === 'string'
            ? item.description.trim()
            : '';
    if (!title && !message) return [];
    const createdAt =
      typeof item.createdAt === 'string'
        ? item.createdAt
        : typeof item.timestamp === 'string'
          ? item.timestamp
          : undefined;
    const business =
      item.business && typeof item.business === 'object'
        ? (item.business as Record<string, unknown>)
        : null;
    return [
      {
        id:
          typeof item.id === 'string'
            ? item.id
            : `account-notification-${index}-${createdAt ?? 'undated'}`,
        type: typeof item.type === 'string' ? item.type : undefined,
        bookingId: typeof item.bookingId === 'string' ? item.bookingId : undefined,
        title: title || 'Booking update',
        message,
        read:
          typeof item.read === 'boolean'
            ? item.read
            : typeof item.isRead === 'boolean'
              ? item.isRead
              : typeof item.readAt === 'string',
        actionNeeded: typeof item.actionNeeded === 'boolean' ? item.actionNeeded : undefined,
        createdAt,
        businessSlug: typeof business?.slug === 'string' ? business.slug : undefined,
      },
    ];
  });
}

function notificationTime(value?: string) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function derivedBookingActivity(bookings: AccountBooking[], now = Date.now()): CustomerNotification[] {
  return bookings
    .map((item): CustomerNotification => {
      const state = bookingState(item, now);
      const scheduled = `${shortDate(item.booking.startAt, item.business.timezone)} at ${time(
        item.booking.startAt,
        item.business.timezone,
      )}`;
      if (state === 'Cancelled') {
        return {
          id: `booking-cancelled-${item.participant.id}`,
          title: 'Booking cancelled',
          message: `${item.booking.serviceName} at ${item.business.name} was cancelled.`,
          read: true,
          createdAt: item.participant.cancelledAt ?? item.booking.startAt,
          businessSlug: item.business.slug,
        };
      }
      if (state === 'Completed') {
        return {
          id: `booking-completed-${item.participant.id}`,
          title: 'Session completed',
          message: `${item.booking.serviceName} with ${item.booking.instructorName} · ${scheduled}.`,
          read: true,
          createdAt: item.booking.endAt,
          businessSlug: item.business.slug,
        };
      }
      if (state === 'Awaiting confirmation') {
        return {
          id: `booking-pending-${item.participant.id}`,
          title: 'Awaiting confirmation',
          message: `${item.business.name} is reviewing your ${item.booking.serviceName} request for ${scheduled}.`,
          read: true,
          createdAt: item.booking.startAt,
          businessSlug: item.business.slug,
        };
      }
      if (state === 'In progress') {
        return {
          id: `booking-in-progress-${item.participant.id}`,
          title: 'Session in progress',
          message: `${item.booking.serviceName} with ${item.booking.instructorName} is happening now at ${item.business.name}.`,
          read: true,
          createdAt: item.booking.startAt,
          businessSlug: item.business.slug,
        };
      }
      return {
        id: `booking-upcoming-${item.participant.id}`,
        title: 'Upcoming session',
        message: `${item.booking.serviceName} at ${item.business.name} is scheduled for ${scheduled}.`,
        read: true,
        createdAt: item.booking.startAt,
        businessSlug: item.business.slug,
      };
    })
    .sort((a, b) => notificationTime(b.createdAt) - notificationTime(a.createdAt));
}

function knownClubs(bookings: AccountBooking[], preferredSlug?: string, now = Date.now()): KnownClub[] {
  const grouped = new Map<string, KnownClub>();
  for (const item of bookings) {
    const existing = grouped.get(item.business.slug) ?? {
      business: item.business,
      bookingCount: 0,
    };
    existing.bookingCount += 1;
    const start = new Date(item.booking.startAt).getTime();
    if (!bookingCancelled(item) && start >= now) {
      if (!existing.nextAt || start < new Date(existing.nextAt).getTime()) {
        existing.nextAt = item.booking.startAt;
      }
    }
    if (!existing.lastAt || start > new Date(existing.lastAt).getTime()) {
      existing.lastAt = item.booking.startAt;
    }
    grouped.set(item.business.slug, existing);
  }
  return [...grouped.values()].sort((a, b) => {
    if (a.business.slug === preferredSlug) return -1;
    if (b.business.slug === preferredSlug) return 1;
    return notificationTime(b.nextAt ?? b.lastAt) - notificationTime(a.nextAt ?? a.lastAt);
  });
}

function statusClass(state: string) {
  if (state === 'Cancelled') return 'bg-[#f8e8e3] text-[#a67260]';
  if (state === 'Awaiting confirmation') return 'bg-[#f8eed3] text-[#9b844b]';
  if (state === 'Completed') return 'bg-[#e8edf2] text-[#728696]';
  if (state === 'In progress') return 'bg-[#dfeee7] text-[#39705a]';
  return 'bg-[#e9f0df] text-[#77905c]';
}

function LocationIcon({ location, size = 18 }: { location?: PublicLocation; size?: number }) {
  const Icon =
    location?.type === 'HOME' ? Home : location?.type === 'ONLINE' ? Video : MapPin;
  return <Icon size={size} strokeWidth={1.7} />;
}

function Detail({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-[#85927f]">{icon}</span>
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wider text-[#8a9487]">
          {label}
        </p>
        <div className="mt-1 text-sm leading-relaxed text-[#415244]">{children}</div>
      </div>
    </div>
  );
}

function ErrorNotice({ message, conflicts = [] }: { message: string; conflicts?: Conflict[] }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[#eedbd5] bg-[#fff7f3] p-4 text-sm leading-relaxed text-[#925541]"
    >
      <div className="flex items-start gap-2.5">
        <Info size={17} className="mt-0.5 shrink-0" />
        <span>{message}</span>
      </div>
      {conflicts.length > 0 && (
        <ul className="mt-3 space-y-2 pl-7">
          {conflicts.map((conflict, index) => (
            <li key={`${conflict.date}-${index}`}>
              <strong>{conflict.date}</strong> — {conflict.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className={cn(panel, 'px-6 py-10 text-center sm:px-10')}>
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#eef3e8] text-[#819672]">
        {icon}
      </span>
      <h2 className="mt-5 text-xl font-semibold tracking-tight text-[#263e33]">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#83907e]">{children}</p>
      {action && <div className="mt-6">{action}</div>}
    </section>
  );
}

function bookingSlugFromInput(value: string) {
  const input = value.trim();
  if (!input) return null;

  let encodedSlug = input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      const match = url.pathname.match(/^\/book\/([^/]+)\/?$/);
      if (!match) return null;
      encodedSlug = match[1];
    } catch {
      return null;
    }
  } else if (/^\/?book\//i.test(input)) {
    const path = input.split(/[?#]/, 1)[0];
    const match = path.match(/^\/?book\/([^/]+)\/?$/i);
    if (!match) return null;
    encodedSlug = match[1];
  } else if (/[/?#\s]/.test(input)) {
    return null;
  }

  try {
    const decodedSlug = decodeURIComponent(encodedSlug);
    return /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i.test(decodedSlug)
      ? decodedSlug
      : null;
  } catch {
    return null;
  }
}

function BookingLinkForm({ id }: { id: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  function openBookingPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const bookingSlug = bookingSlugFromInput(value);
    if (!bookingSlug) {
      setError('Enter a Courtly booking link or club slug.');
      return;
    }
    setError('');
    router.push(`/book/${encodeURIComponent(bookingSlug)}`);
  }

  return (
    <form onSubmit={openBookingPage} noValidate className="mx-auto max-w-md text-left">
      <label htmlFor={id} className="text-xs font-semibold text-[#465e4c]">
        Club booking link or slug
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoComplete="url"
          spellCheck={false}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hintId}
          placeholder="https://courtly.example/book/your-club"
          className={cn(field, 'min-w-0 flex-1')}
          onChange={(event) => {
            setValue(event.target.value);
            setError('');
          }}
        />
        <button type="submit" className={cn(primaryButton, 'shrink-0')}>
          Open booking page <ArrowRight size={15} />
        </button>
      </div>
      <p id={hintId} className="mt-2 text-[11px] leading-relaxed text-[#899487]">
        Use the full link your club shared, or just the part after /book/.
      </p>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-xs font-medium text-[#a16a55]">
          {error}
        </p>
      )}
    </form>
  );
}

function LoadingScreen({ text }: { text: string }) {
  return (
    <div role="status" className="flex min-h-[55vh] flex-col items-center justify-center gap-4">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#e9f0e2] text-[#174c3c]">
        <LoaderCircle size={23} className="animate-spin" />
      </span>
      <p className="text-sm text-[#7e8d7d]">{text}</p>
    </div>
  );
}

function CompactBooking({ item, nowMs }: { item: AccountBooking; nowMs: number }) {
  const state = bookingState(item, nowMs);
  return (
    <article className="flex items-start gap-3 rounded-xl border border-[#e8ece5] bg-white p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf2e7] text-[#7f966c]">
        <CalendarDays size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-[#294536]">{item.booking.serviceName}</h3>
            <p className="mt-1 text-xs text-[#8a9583]">{item.business.name}</p>
          </div>
          <span className={cn('rounded-full px-2 py-1 text-[9px] font-medium', statusClass(state))}>
            {state}
          </span>
        </div>
        <p className="mt-3 text-xs text-[#637363]">
          {shortDate(item.booking.startAt, item.business.timezone)} ·{' '}
          {time(item.booking.startAt, item.business.timezone)} · {item.booking.instructorName}
        </p>
      </div>
    </article>
  );
}

function BookingCard({
  item,
  action,
  busy,
  actionError,
  conflicts,
  date,
  setDate,
  slots,
  slotsLoading,
  slotsError,
  selectedSlot,
  setSelectedSlot,
  beginAction,
  closeAction,
  performAction,
  retrySlots,
  nowMs,
}: {
  item: AccountBooking;
  action: BookingAction;
  busy: boolean;
  actionError: string;
  conflicts: Conflict[];
  date: string;
  setDate: (value: string) => void;
  slots: Slot[];
  slotsLoading: boolean;
  slotsError: string;
  selectedSlot: Slot | null;
  setSelectedSlot: (slot: Slot | null) => void;
  beginAction: (item: AccountBooking, kind: 'cancel' | 'reschedule') => void;
  closeAction: () => void;
  performAction: () => void;
  retrySlots: () => void;
  nowMs: number;
}) {
  const actionHeadingRef = useRef<HTMLHeadingElement>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const rescheduleTriggerRef = useRef<HTMLButtonElement>(null);
  const state = bookingState(item, nowMs);
  const canCancel = canChangeBooking(item, 'cancel', nowMs);
  const canReschedule = canChangeBooking(item, 'reschedule', nowMs);
  const editing = action?.participantId === item.participant.id;
  const currentActionAllowed =
    !editing || (action ? canChangeBooking(item, action.kind, nowMs) : false);
  const availableSlots = slots.filter(
    (candidate) => candidate.available && candidate.startAt !== item.booking.startAt,
  );

  useEffect(() => {
    if (!editing) return;
    window.requestAnimationFrame(() => actionHeadingRef.current?.focus());
  }, [editing, action?.kind]);

  function closeAndRestoreFocus() {
    const kind = action?.kind;
    closeAction();
    window.setTimeout(() => {
      if (kind === 'cancel') cancelTriggerRef.current?.focus();
      else rescheduleTriggerRef.current?.focus();
    }, 0);
  }

  return (
    <article
      id={`customer-booking-${item.booking.id}`}
      tabIndex={-1}
      className={cn(panel, 'scroll-mt-24 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#edf0e8] bg-[#fafbf7] px-5 py-3.5 sm:px-6">
        <Link
          href={`/book/${encodeURIComponent(item.business.slug)}`}
          className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-[#31533e]"
        >
          <span
            aria-hidden="true"
            className="grid h-7 w-7 place-items-center rounded-full bg-[#e8efe0] text-[9px] font-bold text-[#70865d]"
          >
            {initials(item.business.name)}
          </span>
          {item.business.name} <ExternalLink size={12} />
        </Link>
        <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-medium', statusClass(state))}>
          {state}
        </span>
      </div>
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#eaf0e2] text-[#869d6f]">
            <CircleDot size={25} strokeWidth={1.5} />
          </span>
          <div className="flex-1">
            <h3 className="text-lg font-semibold tracking-tight text-[#263e33]">
              {item.booking.serviceName}
            </h3>
            <p className="mt-1 text-xs text-[#88967d]">With {item.booking.instructorName}</p>
          </div>
        </div>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Detail icon={<CalendarDays size={18} />} label="When">
            {shortDate(item.booking.startAt, item.business.timezone)}
            <p className="text-xs text-[#89977d]">
              {time(item.booking.startAt, item.business.timezone)} –{' '}
              {time(item.booking.endAt, item.business.timezone)}
            </p>
          </Detail>
          <Detail icon={<LocationIcon location={item.location} />} label="Where">
            {item.booking.locationName}
            {(item.booking.address || item.location?.address) && (
              <p className="text-xs text-[#89977d]">
                {item.booking.address || item.location?.address}
              </p>
            )}
          </Detail>
          <Detail icon={<ShieldCheck size={18} />} label="Session price">
            {money(item.participant.price ?? item.booking.price, item.business.currency)}
            <p className="text-xs text-[#89977d]">
              {item.participant.paid
                ? 'Marked paid by your coach'
                : 'Payment arranged with your coach'}
            </p>
          </Detail>
          <Detail icon={<UserRound size={18} />} label="Booked for">
            {item.participant.name}
          </Detail>
        </div>
        {state === 'Awaiting confirmation' && (
          <div className="mt-5 flex gap-2.5 rounded-xl border border-[#eee5ce] bg-[#fcf8ec] p-4 text-xs leading-relaxed text-[#897344]">
            <Info size={16} className="mt-0.5 shrink-0" />
            Your coach will confirm this request and any venue arrangements.
          </div>
        )}
        {!editing && (canCancel || canReschedule) && (
          <div className="mt-6 flex flex-wrap gap-3 border-t border-[#edf0e8] pt-5">
            {canReschedule && (
              <button
                ref={rescheduleTriggerRef}
                type="button"
                className={secondaryButton}
                onClick={() => beginAction(item, 'reschedule')}
              >
                <CalendarDays size={15} /> Reschedule
              </button>
            )}
            {canCancel && (
              <button
                ref={cancelTriggerRef}
                type="button"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#edddd7] px-4 py-2.5 text-sm font-medium text-[#a37565] transition hover:bg-[#fff7f3]"
                onClick={() => beginAction(item, 'cancel')}
              >
                <X size={15} /> Cancel booking
              </button>
            )}
          </div>
        )}
        {editing && action.kind === 'cancel' && (
          <div
            role="region"
            aria-label="Confirm cancellation"
            className="mt-6 rounded-xl border border-[#e7d4ca] bg-[#fffcf9] p-5"
          >
            <h4 ref={actionHeadingRef} tabIndex={-1} className="text-base font-semibold text-[#3d493f] outline-none">Cancel this session?</h4>
            <p className="mt-2 text-xs leading-relaxed text-[#958273]">
              Your place on {shortDate(item.booking.startAt, item.business.timezone)} at{' '}
              {time(item.booking.startAt, item.business.timezone)} will be released.
            </p>
            {!currentActionAllowed && !actionError && (
              <div className="mt-4">
                <ErrorNotice message={`This booking is now inside ${item.business.cancellationHours} hours of its start. Please contact your coach.`} />
              </div>
            )}
            {actionError && (
              <div className="mt-4">
                <ErrorNotice message={actionError} conflicts={conflicts} />
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className={secondaryButton} disabled={busy} onClick={closeAndRestoreFocus}>
                Keep booking
              </button>
              <button
                type="button"
                disabled={busy || !currentActionAllowed}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#a46d56] px-5 py-3 text-sm font-semibold text-white hover:bg-[#8b5945] disabled:opacity-50"
                onClick={performAction}
              >
                {busy ? <LoaderCircle size={15} className="animate-spin" /> : <X size={15} />}
                Yes, cancel session
              </button>
            </div>
          </div>
        )}
        {editing && action.kind === 'reschedule' && (
          <div
            role="region"
            aria-label="Reschedule session"
            className="mt-6 border-t border-[#edf0e8] pt-6"
          >
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                  <h4 ref={actionHeadingRef} tabIndex={-1} className="text-base font-semibold text-[#3d493f] outline-none">Find a better time</h4>
                <p className="mt-1 text-xs text-[#8b987f]">Same lesson, coach, and place.</p>
              </div>
              {!currentActionAllowed && !actionError && (
                <div className="mb-5">
                  <ErrorNotice message="This booking is now outside the self-service rescheduling window. Contact your coach." />
                </div>
              )}
              <button
                type="button"
                className={cn(secondaryButton, '!min-h-10 !px-3')}
                aria-label="Close reschedule"
                onClick={closeAndRestoreFocus}
              >
                <X size={16} />
              </button>
            </div>
            <label htmlFor={`reschedule-date-${item.participant.id}`} className="text-xs font-semibold">
              Choose a date
            </label>
            <input
              id={`reschedule-date-${item.participant.id}`}
              aria-label="Choose a date"
              type="date"
              value={date}
              min={dateKey(new Date(), item.business.timezone)}
              onChange={(event) => {
                setDate(event.target.value);
                setSelectedSlot(null);
              }}
              className={cn(field, 'mt-2 max-w-xs')}
            />
            <div className="mt-5 border-t border-[#edf0e8] pt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h5 className="text-sm font-semibold text-[#344b3a]">Available start times</h5>
                <span className="inline-flex items-center gap-1 text-[10px] text-[#87947d]">
                  <Clock3 size={12} /> {item.business.timezone.replaceAll('_', ' ')}
                </span>
              </div>
              {slotsLoading ? (
                <div role="status" className="flex min-h-24 items-center justify-center gap-2 text-xs text-[#82907d]">
                  <LoaderCircle size={16} className="animate-spin" /> Checking availability…
                </div>
              ) : slotsError ? (
                <div className="space-y-3">
                  <ErrorNotice message={slotsError} />
                  <button type="button" className={secondaryButton} onClick={retrySlots}>
                    <RefreshCw size={14} /> Retry availability
                  </button>
                </div>
              ) : availableSlots.length ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {availableSlots.map((candidate) => (
                    <button
                      key={candidate.startAt}
                      type="button"
                      aria-pressed={selectedSlot?.startAt === candidate.startAt}
                      onClick={() => setSelectedSlot(candidate)}
                      className={cn(
                        'min-h-12 rounded-xl border px-3 py-2 text-sm font-medium transition',
                        selectedSlot?.startAt === candidate.startAt
                          ? 'border-[#174c3c] bg-[#174c3c] text-white'
                          : 'border-[#dfe5dc] bg-white text-[#49604f] hover:border-[#9caf90]',
                      )}
                    >
                      {time(candidate.startAt, item.business.timezone)}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-[#dfe5dc] bg-[#fafbf8] px-4 py-7 text-center text-xs text-[#87937f]">
                  No other times are available on this date.
                </p>
              )}
            </div>
            {actionError && (
              <div className="mt-5">
                <ErrorNotice message={actionError} conflicts={conflicts} />
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className={secondaryButton} disabled={busy} onClick={closeAndRestoreFocus}>
                Keep original time
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={!selectedSlot || busy || slotsLoading || !currentActionAllowed}
                onClick={performAction}
              >
                {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}
                Confirm new time
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function ClubAvatar({ club, size = 'large' }: { club: KnownClub; size?: 'small' | 'large' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full border-[3px] border-white bg-[#dfe9d5] font-bold text-[#607854] shadow-[0_0_0_1px_#d8e1d2]',
        size === 'large' ? 'h-16 w-16 text-sm' : 'h-11 w-11 text-[11px]',
      )}
      style={
        club.business.color?.startsWith('#')
          ? { backgroundColor: `${club.business.color}20`, color: club.business.color }
          : undefined
      }
    >
      {initials(club.business.name)}
    </span>
  );
}

function AppHeader({
  userName,
  activeTab,
  homeHref,
  onOpenProfile,
}: {
  userName: string;
  activeTab: CustomerTab;
  homeHref: string;
  onOpenProfile: () => void;
}) {
  const title = tabs.find((tab) => tab.id === activeTab)?.label ?? 'Home';
  return (
    <header className="customer-header sticky top-0 z-40 border-b border-[#e7ebe4] bg-white/90 backdrop-blur-xl">
      <div className="mx-auto flex min-h-16 max-w-3xl items-center justify-between gap-4 px-4 sm:min-h-[72px] sm:px-6">
        <Link href={homeHref} aria-label="Courtly customer home" className="inline-flex min-h-11 items-center">
          <CourtlyLogo />
        </Link>
        <div className="flex items-center gap-2">
          <span className="hidden text-[11px] font-medium text-[#899486] sm:inline">{title}</span>
          <button
            type="button"
            aria-label="Open profile"
            aria-current={activeTab === 'profile' ? 'page' : undefined}
            title={`Signed in as ${userName}`}
            onClick={onOpenProfile}
            className="grid h-10 w-10 place-items-center rounded-full border border-[#dfe6da] bg-[#edf2e7] text-[10px] font-bold text-[#6e835e] transition hover:border-[#b8c8b1] hover:bg-[#e5eddd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2"
          >
            {initials(userName)}
          </button>
        </div>
      </div>
    </header>
  );
}

function BottomNavigation({
  activeTab,
  onChange,
  unread,
}: {
  activeTab: CustomerTab;
  onChange: (tab: CustomerTab) => void;
  unread: number;
}) {
  return (
    <nav
      aria-label="Customer navigation"
      className="customer-bottom-nav fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-3xl border-x border-t border-[#dfe5dc] bg-white/95 pb-[max(0.35rem,env(safe-area-inset-bottom))] shadow-[0_-12px_35px_rgba(25,55,40,0.08)] backdrop-blur-xl sm:bottom-4 sm:rounded-2xl sm:border sm:px-2 sm:pb-1"
    >
      <div className="grid min-h-[68px] grid-cols-5 items-end">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          const central = tab.id === 'book';
          return (
            <button
              key={tab.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              aria-label={
                tab.id === 'alerts' && unread > 0
                  ? `Alerts, ${unread} unread alert${unread === 1 ? '' : 's'}`
                  : tab.label
              }
              onClick={() => onChange(tab.id)}
              className={cn(
                'relative flex min-h-[62px] min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition sm:text-xs',
                active ? 'text-[#174c3c]' : 'text-[#8b958a] hover:bg-[#f6f8f3] hover:text-[#496353]',
                central && '-translate-y-2',
              )}
            >
              {central ? (
                <span
                  className={cn(
                    'grid h-12 w-12 place-items-center rounded-full border-4 border-[#f6f7f4] shadow-[0_5px_16px_rgba(23,76,60,0.25)] transition',
                    active ? 'bg-[#c9dca6] text-[#174c3c]' : 'bg-[#174c3c] text-white',
                  )}
                >
                  <Icon size={22} strokeWidth={2} />
                </span>
              ) : (
                <span className="relative grid h-7 w-8 place-items-center">
                  <Icon size={21} fill={active && tab.id === 'home' ? 'currentColor' : 'none'} strokeWidth={active ? 2.2 : 1.7} />
                  {tab.id === 'alerts' && unread > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute right-0 top-0 grid h-4 min-w-4 place-items-center rounded-full border-2 border-white bg-[#a86752] px-0.5 text-[8px] leading-none text-white"
                    >
                      {unread > 9 ? '9+' : unread}
                    </span>
                  )}
                </span>
              )}
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function CustomerApp({ slug }: { slug?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab = customerTab(requestedTab);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [bookings, setBookings] = useState<AccountBooking[]>([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookingsError, setBookingsError] = useState('');
  const [notifications, setNotifications] = useState<CustomerNotification[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsFallback, setNotificationsFallback] = useState(false);
  const [notificationError, setNotificationError] = useState('');
  const [markingRead, setMarkingRead] = useState(false);
  const [alertsStatus, setAlertsStatus] = useState('');
  const [bookingNavigationStatus, setBookingNavigationStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<BookingAction>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [slotsVersion, setSlotsVersion] = useState(0);
  const [selectedClubSlug, setSelectedClubSlug] = useState('');
  const [historyFilter, setHistoryFilter] = useState<BookingFilter>('all');
  const [profile, setProfile] = useState({ name: '', phone: '', parentName: '' });
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileNotice, setProfileNotice] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const successNoticeRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const previousTabRouteRef = useRef(requestedTab);
  const pendingBookingIdRef = useRef<string | null>(null);

  const tabHref = useCallback((tab: CustomerTab) => {
    const params = new URLSearchParams();
    if (slug) params.set('slug', slug);
    params.set('tab', tab);
    return `/manage?${params.toString()}`;
  }, [slug]);

  const loginHref = useMemo(() => {
    const destination = tabHref(activeTab);
    return `/login?next=${encodeURIComponent(destination)}`;
  }, [activeTab, tabHref]);
  const loginHrefRef = useRef(loginHref);
  loginHrefRef.current = loginHref;

  useEffect(() => {
    if (requestedTab === null || customerTabIds.has(requestedTab as CustomerTab)) return;
    router.replace(tabHref('home'), { scroll: false });
  }, [requestedTab, router, tabHref]);

  useEffect(() => {
    if (previousTabRouteRef.current === requestedTab) return;
    previousTabRouteRef.current = requestedTab;
    if (pendingBookingIdRef.current && activeTab === 'home') return;
    pendingBookingIdRef.current = null;
    setBookingNavigationStatus('');
    const frame = window.requestAnimationFrame(() => {
      mainRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, requestedTab]);

  useEffect(() => {
    if (activeTab !== 'alerts') setAlertsStatus('');
  }, [activeTab]);

  useEffect(() => {
    const bookingId = pendingBookingIdRef.current;
    if (activeTab !== 'home' || !bookingId || bookingsLoading || bookingsError) return;
    pendingBookingIdRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const bookingCard = document.getElementById(`customer-booking-${bookingId}`);
      if (bookingCard instanceof HTMLElement) {
        bookingCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        bookingCard.focus({ preventScroll: true });
        setBookingNavigationStatus('Booking details opened.');
      } else {
        mainRef.current?.focus({ preventScroll: true });
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setBookingNavigationStatus('That booking is no longer available. Showing all bookings.');
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, bookingsError, bookingsLoading]);

  const refreshSession = useCallback(async () => {
    setAuthLoading(true);
    setAuthError('');
    try {
      const value = await loadAuthSession();
      setSession(value);
    } catch (error) {
      setSession(null);
      if (error instanceof ApiError && error.status === 401) {
        router.replace(loginHrefRef.current);
      } else {
        setAuthError(messageOf(error));
      }
    } finally {
      setAuthLoading(false);
    }
  }, [router]);

  const refreshBookings = useCallback(async () => {
    setBookingsLoading(true);
    setBookingsError('');
    try {
      const value = await loadAccountBookings();
      setBookings(
        [...value.bookings].sort(
          (a, b) =>
            new Date(a.booking.startAt).getTime() - new Date(b.booking.startAt).getTime(),
        ),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace(loginHrefRef.current);
      } else {
        setBookingsError(messageOf(error));
      }
    } finally {
      setBookingsLoading(false);
    }
  }, [router]);

  const refreshNotifications = useCallback(async () => {
    setNotificationsLoading(true);
    setNotificationError('');
    try {
      const value = await api<unknown>('/account/notifications');
      const parsed = parseNotifications(value);
      if (!parsed) throw new Error('Notifications are not available yet.');
      setNotifications(parsed.sort((a, b) => notificationTime(b.createdAt) - notificationTime(a.createdAt)));
      setNotificationsFallback(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace(loginHrefRef.current);
        return;
      }
      setNotificationsFallback(true);
      setNotificationError(messageOf(error));
    } finally {
      setNotificationsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    if (!isCustomerSession(session)) return;
    setProfile({
      name: session!.user.name ?? '',
      phone: session!.user.phone ?? '',
      parentName: session!.user.parentName ?? '',
    });
    void refreshBookings();
    void refreshNotifications();
  }, [session, refreshBookings, refreshNotifications]);

  useEffect(() => {
    function updateClock() {
      setNowMs(Date.now());
    }
    const boundaries = bookings.flatMap((item) => {
      const start = new Date(item.booking.startAt).getTime();
      const end = new Date(item.booking.endAt).getTime();
      const cutoff = start - item.business.cancellationHours * 3_600_000;
      return [cutoff + 1, start, end].filter((value) => Number.isFinite(value) && value > nowMs);
    });
    const nextBoundary = boundaries.length ? Math.min(...boundaries) : Number.POSITIVE_INFINITY;
    const delay = Math.max(50, Math.min(30_000, nextBoundary - nowMs));
    const timer = window.setTimeout(updateClock, delay);
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') updateClock();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [bookings, nowMs]);

  useEffect(() => {
    if (!notice) return;
    const frame = window.requestAnimationFrame(() => successNoticeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [notice]);

  const clubs = useMemo(() => knownClubs(bookings, slug, nowMs), [bookings, nowMs, slug]);
  const current = useMemo(() => bookings.filter((item) => isInProgress(item, nowMs)), [bookings, nowMs]);
  const upcoming = useMemo(() => bookings.filter((item) => isUpcoming(item, nowMs)), [bookings, nowMs]);
  const history = useMemo(
    () =>
      bookings
        .filter((item) => {
          const state = bookingState(item, nowMs);
          return state === 'Cancelled' || state === 'Completed';
        })
        .sort(
          (a, b) =>
            new Date(b.booking.startAt).getTime() - new Date(a.booking.startAt).getTime(),
        ),
    [bookings, nowMs],
  );
  const fallbackActivity = useMemo(() => derivedBookingActivity(bookings, nowMs), [bookings, nowMs]);
  const visibleNotifications = notificationsFallback ? fallbackActivity : notifications;
  const unread = notificationsFallback ? 0 : notifications.filter((item) => !item.read).length;
  const actionBooking = action
    ? bookings.find((item) => item.participant.id === action.participantId)
    : undefined;

  useEffect(() => {
    if (selectedClubSlug && clubs.some((club) => club.business.slug === selectedClubSlug)) return;
    setSelectedClubSlug(clubs[0]?.business.slug ?? '');
  }, [clubs, selectedClubSlug]);

  useEffect(() => {
    if (action?.kind !== 'reschedule' || !actionBooking || !rescheduleDate) return;
    let ignore = false;
    setSlotsLoading(true);
    setSlotsError('');
    setSlots([]);
    setSelectedSlot(null);
    loadSlots(actionBooking.business.slug, {
      serviceId: actionBooking.booking.serviceId,
      instructorId: actionBooking.booking.instructorId,
      locationId: actionBooking.booking.locationId,
      date: rescheduleDate,
    })
      .then((value) => {
        if (!ignore) setSlots(value.slots);
      })
      .catch((error) => {
        if (!ignore) setSlotsError(messageOf(error));
      })
      .finally(() => {
        if (!ignore) setSlotsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [action?.kind, actionBooking, rescheduleDate, slotsVersion]);

  function selectTab(tab: CustomerTab) {
    setNotice('');
    setBookingNavigationStatus('');
    if (tab !== 'alerts') setAlertsStatus('');
    if (tab !== activeTab || requestedTab === null) {
      router.push(tabHref(tab), { scroll: false });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openAlertBooking(bookingId: string) {
    setNotice('');
    setBookingNavigationStatus('');
    pendingBookingIdRef.current = bookingId;
    if (activeTab !== 'home' || requestedTab === null) {
      router.push(tabHref('home'), { scroll: false });
      return;
    }
    const bookingCard = document.getElementById(`customer-booking-${bookingId}`);
    if (bookingCard instanceof HTMLElement) {
      bookingCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      bookingCard.focus({ preventScroll: true });
      pendingBookingIdRef.current = null;
      setBookingNavigationStatus('Booking details opened.');
    } else {
      pendingBookingIdRef.current = null;
      mainRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setBookingNavigationStatus('That booking is no longer available. Showing all bookings.');
    }
  }

  function beginAction(item: AccountBooking, kind: 'cancel' | 'reschedule') {
    const currentTime = Date.now();
    setNowMs(currentTime);
    if (!canChangeBooking(item, kind, currentTime)) return;
    setAction({ kind, participantId: item.participant.id });
    setActionError('');
    setConflicts([]);
    setNotice('');
    setSelectedSlot(null);
    if (kind === 'reschedule') {
      setRescheduleDate(dateKey(new Date(), item.business.timezone));
    }
  }

  function closeAction() {
    if (actionBusy) return;
    setAction(null);
    setActionError('');
    setConflicts([]);
    setSelectedSlot(null);
  }

  async function performAction() {
    if (!action || !actionBooking || actionBusy) return;
    if (action.kind === 'reschedule' && !selectedSlot) return;
    if (!canChangeBooking(actionBooking, action.kind, Date.now())) {
      setNowMs(Date.now());
      setActionError(
        action.kind === 'cancel'
          ? `This booking is now inside ${actionBooking.business.cancellationHours} hours of its start. Please contact your coach.`
          : 'This booking is now outside the self-service rescheduling window. Contact your coach.',
      );
      return;
    }
    setActionBusy(true);
    setActionError('');
    setConflicts([]);
    try {
      let updated: AccountBooking;
      if (action.kind === 'cancel') {
        updated = await cancelAccountBooking(action.participantId) as AccountBooking;
      } else {
        updated = await rescheduleAccountBooking(action.participantId, selectedSlot!.startAt) as AccountBooking;
      }
      const completedAction = action.kind;
      if (updated?.participant?.id) {
        setBookings((current) =>
          current.map((item) =>
            item.participant.id === updated.participant.id ? updated : item,
          ),
        );
      }
      setAction(null);
      setSelectedSlot(null);
      setNotice(
        completedAction === 'cancel'
          ? 'Your booking has been cancelled.'
          : 'Your session has been rescheduled.',
      );
      void refreshBookings();
      void refreshNotifications();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace(loginHrefRef.current);
      }
      setActionError(messageOf(error));
      setConflicts(conflictList(error));
    } finally {
      setActionBusy(false);
    }
  }

  async function markAllRead() {
    if (markingRead || notificationsFallback || unread === 0) return;
    setMarkingRead(true);
    setNotificationError('');
    setAlertsStatus('');
    try {
      await api<unknown>('/account/notifications/read', {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      setNotifications((current) => current.map((item) => ({ ...item, read: true })));
      setAlertsStatus('All alerts marked as read.');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace(loginHrefRef.current);
      } else {
        setNotificationError(messageOf(error));
      }
    } finally {
      setMarkingRead(false);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || profileBusy) return;
    const name = profile.name.trim();
    if (name.length < 2) {
      setProfileError('Please enter your name using at least two characters.');
      return;
    }
    setProfileBusy(true);
    setProfileError('');
    setProfileNotice('');
    try {
      const value = await api<unknown>('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          phone: profile.phone.trim(),
          parentName: profile.parentName.trim(),
        }),
      });
      const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
      const returnedUser = record?.user && typeof record.user === 'object'
        ? (record.user as AuthSession['user'])
        : null;
      const nextUser = returnedUser ?? {
        ...session.user,
        name,
        phone: profile.phone.trim(),
        parentName: profile.parentName.trim(),
      };
      setSession((current) => (current ? { ...current, user: { ...current.user, ...nextUser } } : current));
      setBookings((current) => current.map((item) => ({
        ...item,
        participant: { ...item.participant, name: nextUser.name },
        booking: {
          ...item.booking,
          participants: item.booking.participants.map((participant) =>
            participant.id === item.participant.id
              ? { ...participant, name: nextUser.name }
              : participant,
          ),
        },
      })));
      setProfile({
        name: nextUser.name,
        phone: nextUser.phone ?? '',
        parentName: nextUser.parentName ?? '',
      });
      setProfileNotice('Your profile has been updated.');
      void refreshBookings();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace(loginHrefRef.current);
      } else {
        setProfileError(messageOf(error));
      }
    } finally {
      setProfileBusy(false);
    }
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError('');
    try {
      await logoutAccount();
      router.replace('/login');
      router.refresh();
    } catch (error) {
      setSignOutError(messageOf(error));
      setSigningOut(false);
    }
  }

  const bookingCardProps = {
    action,
    busy: actionBusy,
    actionError,
    conflicts,
    date: rescheduleDate,
    setDate: setRescheduleDate,
    slots,
    slotsLoading,
    slotsError,
    selectedSlot,
    setSelectedSlot,
    beginAction,
    closeAction,
    performAction: () => void performAction(),
    retrySlots: () => setSlotsVersion((value) => value + 1),
    nowMs,
  };

  if (authLoading) {
    return (
      <main className="min-h-screen bg-[#f6f7f4] text-[#1c3029]">
        <LoadingScreen text="Opening your Courtly account…" />
      </main>
    );
  }

  if (!session) {
    return (
      <main className="min-h-screen bg-[#f6f7f4] px-5 py-12 text-[#1c3029]">
        <div className="mx-auto max-w-lg">
          <Link href="/login" aria-label="Courtly home" className="inline-flex min-h-11 items-center">
            <CourtlyLogo />
          </Link>
          <div className="mt-16">
            <EmptyState
              icon={<ShieldCheck size={23} />}
              title={authError ? 'We couldn’t open your account' : 'Sign in to your Courtly account'}
              action={
                <div className="flex flex-wrap justify-center gap-3">
                  <Link href={loginHref} className={primaryButton}>
                    Sign in <ArrowRight size={15} />
                  </Link>
                  {authError && (
                    <button type="button" className={secondaryButton} onClick={() => void refreshSession()}>
                      <RefreshCw size={14} /> Try again
                    </button>
                  )}
                </div>
              }
            >
              {authError || 'Your sessions, updates, and profile stay together in one private place.'}
            </EmptyState>
          </div>
        </div>
      </main>
    );
  }

  if (!isCustomerSession(session)) {
    return (
      <main className="min-h-screen bg-[#f6f7f4] px-5 py-12 text-[#1c3029]">
        <div className="mx-auto max-w-lg">
          <CourtlyLogo />
          <div className="mt-16">
            <EmptyState
              icon={<UserRound size={23} />}
              title="Customer account required"
              action={
                <div className="space-y-3">
                  <button type="button" className={primaryButton} disabled={signingOut} onClick={() => void signOut()}>
                    {signingOut && <LoaderCircle size={15} className="animate-spin" />}
                    Sign out and switch account
                  </button>
                  {signOutError && <p role="alert" className="text-xs text-[#a16a55]">{signOutError}</p>}
                </div>
              }
            >
              {session.user.email} is signed in as a provider. Switch to your customer account to view personal bookings.
            </EmptyState>
          </div>
        </div>
      </main>
    );
  }

  const selectedClub = clubs.find((club) => club.business.slug === selectedClubSlug);
  const linkedSlugIsNew = !!slug && !clubs.some((club) => club.business.slug === slug);
  const filteredHistory = bookings
    .filter((item) => {
      if (historyFilter === 'upcoming') return isUpcoming(item, nowMs);
      if (historyFilter === 'cancelled') return bookingCancelled(item);
      if (historyFilter === 'completed') return bookingState(item, nowMs) === 'Completed';
      return true;
    })
    .sort(
      (a, b) =>
        new Date(b.booking.startAt).getTime() - new Date(a.booking.startAt).getTime(),
    );

  return (
    <div className="customer-shell min-h-screen overflow-x-clip bg-[#f6f7f4] pb-32 text-[#1c3029] sm:pb-36">
      <AppHeader
        userName={session.user.name}
        activeTab={activeTab}
        homeHref={tabHref('home')}
        onOpenProfile={() => selectTab('profile')}
      />
      <main
        ref={mainRef}
        tabIndex={-1}
        className="customer-content mx-auto w-full max-w-3xl px-4 py-7 outline-none sm:px-6 sm:py-10"
      >
        <p role="status" className="sr-only">{bookingNavigationStatus}</p>
        {bookingsError && (
          <div className="mb-6 space-y-3">
            <ErrorNotice message={bookingsError} />
            <button type="button" className={secondaryButton} onClick={() => void refreshBookings()}>
              <RefreshCw size={14} /> Try bookings again
            </button>
          </div>
        )}

        {activeTab === 'home' && (
          <section id="customer-home-panel" aria-label="Home" className="customer-tab-panel customer-tab-home">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#8c9980]">
                  Good to see you, {session.user.name.split(/\s+/)[0]}
                </p>
                <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">
                  My bookings
                </h1>
                <p className="mt-2 text-sm text-[#849080]">Every club, one calm place.</p>
              </div>
              {clubs.length > 0 && (
                <button type="button" className={secondaryButton} onClick={() => selectTab('book')}>
                  <Plus size={15} /> Book a session
                </button>
              )}
            </div>

            {clubs.length > 0 && (
              <div className="-mx-4 mt-7 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" aria-label="Your clubs">
                {clubs.map((club) => (
                  <button
                    key={club.business.slug}
                    type="button"
                    className="flex w-20 shrink-0 flex-col items-center gap-2 text-center"
                    onClick={() => {
                      setSelectedClubSlug(club.business.slug);
                      selectTab('book');
                    }}
                  >
                    <ClubAvatar club={club} />
                    <span className="line-clamp-2 text-[10px] font-medium leading-tight text-[#617064]">
                      {club.business.name}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {notice && (
              <div ref={successNoticeRef} role="status" tabIndex={-1} className="mt-6 flex items-start gap-2.5 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#66834d] outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]">
                <CheckCheck size={18} className="mt-0.5 shrink-0" /> {notice}
              </div>
            )}

            {bookingsLoading ? (
              <LoadingScreen text="Gathering your sessions…" />
            ) : bookings.length === 0 && !bookingsError ? (
              <div className="mt-8">
                <EmptyState
                  icon={<CalendarDays size={23} />}
                  title={slug ? 'Book your first session with this club' : 'Open your club’s booking page'}
                  action={
                    slug ? (
                      <Link href={`/book/${encodeURIComponent(slug)}`} className={primaryButton}>
                        Open booking page <ArrowRight size={15} />
                      </Link>
                    ) : (
                      <BookingLinkForm id="customer-home-booking-link" />
                    )
                  }
                >
                  {slug
                    ? 'Choose a session on the club’s booking page. It will appear here after you book.'
                    : 'Paste the booking link your club sent you to choose a session.'}
                </EmptyState>
              </div>
            ) : (
              <div className="mt-8 space-y-10">
                {current.length > 0 && (
                  <section aria-labelledby="current-bookings">
                    <div className="mb-4 flex items-end justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#4e816c]">
                          Happening now
                        </p>
                        <h2 id="current-bookings" className="mt-1 text-xl font-semibold tracking-tight">
                          In progress
                        </h2>
                      </div>
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#4e816c]">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-[#5c9278]" /> Live
                      </span>
                    </div>
                    <div className="space-y-4">
                      {current.map((item) => (
                        <BookingCard key={item.participant.id} item={item} {...bookingCardProps} />
                      ))}
                    </div>
                  </section>
                )}
                {upcoming.length > 0 && (
                  <section aria-labelledby="upcoming-bookings">
                    <div className="mb-4 flex items-end justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#8a987e]">
                          Next up
                        </p>
                        <h2 id="upcoming-bookings" className="mt-1 text-xl font-semibold tracking-tight">
                          Upcoming sessions
                        </h2>
                      </div>
                      <span className="text-xs text-[#89957f]">
                        {upcoming.length} booking{upcoming.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="space-y-4">
                      {upcoming.map((item) => (
                        <BookingCard key={item.participant.id} item={item} {...bookingCardProps} />
                      ))}
                    </div>
                  </section>
                )}
                {history.length > 0 && (
                  <section aria-labelledby="booking-history">
                    <div className="mb-4">
                      <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#8a987e]">
                        Looking back
                      </p>
                      <h2 id="booking-history" className="mt-1 text-xl font-semibold tracking-tight">
                        Booking history
                      </h2>
                    </div>
                    <div className="space-y-4">
                      {history.map((item) => (
                        <BookingCard key={item.participant.id} item={item} {...bookingCardProps} />
                      ))}
                    </div>
                  </section>
                )}
                <section aria-labelledby="recent-activity">
                  <div className="mb-4 flex items-end justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#8a987e]">
                        In your orbit
                      </p>
                      <h2 id="recent-activity" className="mt-1 text-xl font-semibold tracking-tight">
                        Recent activity
                      </h2>
                    </div>
                    <button type="button" onClick={() => selectTab('alerts')} className="min-h-10 text-xs font-semibold text-[#648052]">
                      See all
                    </button>
                  </div>
                  <div className={cn(panel, 'divide-y divide-[#edf0e9] overflow-hidden')}>
                    {(visibleNotifications.length ? visibleNotifications : fallbackActivity).slice(0, 3).map((item) => (
                      <div key={item.id} className="flex items-start gap-3 p-4 sm:p-5">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#edf2e7] text-[#748a64]">
                          <Bell size={15} />
                        </span>
                        <div>
                          <h3 className="text-sm font-semibold text-[#344c3b]">{item.title}</h3>
                          <p className="mt-1 text-xs leading-relaxed text-[#849080]">{item.message}</p>
                        </div>
                      </div>
                    ))}
                    {visibleNotifications.length === 0 && fallbackActivity.length === 0 && (
                      <p className="p-7 text-center text-sm text-[#899487]">
                        Your booking activity will collect here.
                      </p>
                    )}
                  </div>
                  {fallbackActivity.length > 0 && (notificationsFallback || visibleNotifications.length === 0) && (
                    <p className="mt-2 text-[10px] text-[#929c91]">Based on the current status of your bookings.</p>
                  )}
                </section>
              </div>
            )}
          </section>
        )}

        {activeTab === 'explore' && (
          <section id="customer-explore-panel" aria-label="Explore" className="customer-tab-panel customer-tab-explore">
            <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#8c9980]">Your courts</p>
            <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">Explore</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#849080]">
              Revisit clubs you have genuinely booked with. Courtly does not list clubs you have not connected with.
            </p>
            {linkedSlugIsNew && (
              <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-[#dfe7d8] bg-[#f0f5ea] p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-[#3d5a41]">A club invited you to book</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#788874]">Open its live booking page from the link you followed.</p>
                </div>
                <Link href={`/book/${encodeURIComponent(slug!)}`} className={cn(primaryButton, 'shrink-0')}>
                  Open booking page <ArrowRight size={15} />
                </Link>
              </div>
            )}
            {bookingsLoading ? (
              <LoadingScreen text="Finding your clubs…" />
            ) : clubs.length === 0 ? (
              <div className="mt-8">
                <EmptyState
                  icon={<Compass size={23} />}
                  title={slug ? 'Book with this club to add it here' : 'Add your first club'}
                  action={
                    slug ? (
                      <Link href={`/book/${encodeURIComponent(slug)}`} className={primaryButton}>
                        Open booking page <ArrowRight size={15} />
                      </Link>
                    ) : (
                      <BookingLinkForm id="customer-explore-booking-link" />
                    )
                  }
                >
                  {slug
                    ? 'Choose a session on its booking page. The club will appear here after you book.'
                    : 'Paste a club’s Courtly booking link to choose a session and add it to your history.'}
                </EmptyState>
              </div>
            ) : (
              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                {clubs.map((club) => (
                  <article key={club.business.slug} className={cn(panel, 'overflow-hidden')}>
                    <div
                      className="h-1.5 bg-[#78936a]"
                      style={club.business.color?.startsWith('#') ? { backgroundColor: club.business.color } : undefined}
                    />
                    <div className="p-5">
                      <div className="flex items-start gap-3">
                        <ClubAvatar club={club} size="small" />
                        <div className="flex-1">
                          <h2 className="text-base font-semibold tracking-tight text-[#2c4737]">
                            {club.business.name}
                          </h2>
                          <p className="mt-1 text-xs text-[#899583]">
                            {club.business.tagline || `Coaching with ${club.business.ownerName}`}
                          </p>
                        </div>
                      </div>
                      <dl className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-[#f6f8f3] p-3">
                        <div>
                          <dt className="text-[9px] uppercase tracking-wide text-[#919b8c]">Your bookings</dt>
                          <dd className="mt-1 text-sm font-semibold text-[#456049]">{club.bookingCount}</dd>
                        </div>
                        <div>
                          <dt className="text-[9px] uppercase tracking-wide text-[#919b8c]">Next session</dt>
                          <dd className="mt-1 text-sm font-semibold text-[#456049]">
                            {club.nextAt ? shortDate(club.nextAt, club.business.timezone) : 'Nothing booked'}
                          </dd>
                        </div>
                      </dl>
                      <Link
                        href={`/book/${encodeURIComponent(club.business.slug)}`}
                        className={cn(primaryButton, 'mt-5 w-full')}
                      >
                        View booking page <ArrowRight size={15} />
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === 'book' && (
          <section id="customer-book-panel" aria-label="Book" className="customer-tab-panel customer-tab-book">
            <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#8c9980]">Make time to play</p>
            <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">
              Book a session
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#849080]">
              Choose a club from your booking history, then continue to its live availability.
            </p>
            {linkedSlugIsNew && (
              <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-[#dfe7d8] bg-[#f0f5ea] p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-[#3d5a41]">Book with the club that sent you here</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#788874]">Its identity is confirmed on the booking page before you choose a lesson.</p>
                </div>
                <Link href={`/book/${encodeURIComponent(slug!)}`} className={cn(primaryButton, 'shrink-0')}>
                  Continue <ArrowRight size={15} />
                </Link>
              </div>
            )}
            {bookingsLoading ? (
              <LoadingScreen text="Preparing your clubs…" />
            ) : clubs.length === 0 ? (
              <div className="mt-8">
                <EmptyState
                  icon={<Plus size={23} />}
                  title={slug ? 'Choose a session with this club' : 'Open your club’s booking page'}
                  action={
                    slug ? (
                      <Link href={`/book/${encodeURIComponent(slug)}`} className={primaryButton}>
                        Continue to booking <ArrowRight size={15} />
                      </Link>
                    ) : (
                      <BookingLinkForm id="customer-book-booking-link" />
                    )
                  }
                >
                  {slug
                    ? 'Open the club’s live availability and choose the session you want.'
                    : 'Paste the booking link your club sent you to see its live availability.'}
                </EmptyState>
              </div>
            ) : (
              <div className="mt-8">
                <fieldset>
                  <legend className="mb-3 text-xs font-semibold text-[#566b5a]">Choose a club</legend>
                  <div className="space-y-3">
                    {clubs.map((club) => {
                      const selected = selectedClubSlug === club.business.slug;
                      return (
                        <label
                          key={club.business.slug}
                          className={cn(
                            'relative flex min-h-[76px] w-full cursor-pointer items-center gap-3 rounded-2xl border bg-white p-4 text-left transition focus-within:ring-2 focus-within:ring-[#327a5a] focus-within:ring-offset-2',
                            selected
                              ? 'border-[#618159] ring-1 ring-[#618159]'
                              : 'border-[#e2e7df] hover:border-[#b8c8b1]',
                          )}
                        >
                          <input
                            type="radio"
                            name="customer-booking-club"
                            value={club.business.slug}
                            checked={selected}
                            onChange={() => setSelectedClubSlug(club.business.slug)}
                            className="sr-only"
                          />
                          <ClubAvatar club={club} size="small" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-[#304a39]">{club.business.name}</span>
                            <span className="mt-1 block text-xs text-[#899583]">
                              {club.bookingCount} past or upcoming booking{club.bookingCount === 1 ? '' : 's'}
                            </span>
                          </span>
                          <span
                            className={cn(
                              'grid h-6 w-6 place-items-center rounded-full border',
                              selected ? 'border-[#174c3c] bg-[#174c3c] text-white' : 'border-[#d8dfd5]',
                            )}
                          >
                            {selected && <Check aria-hidden="true" size={13} />}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                {selectedClub && (
                  <Link
                    href={`/book/${encodeURIComponent(selectedClub.business.slug)}`}
                    className={cn(primaryButton, 'mt-6 w-full')}
                  >
                    Continue to {selectedClub.business.name} <ArrowRight size={15} />
                  </Link>
                )}
                <p className="mt-4 text-center text-[10px] leading-relaxed text-[#939d90]">
                  Services, coaches, and times are shown on the club’s live booking page.
                </p>
              </div>
            )}
          </section>
        )}

        {activeTab === 'alerts' && (
          <section id="customer-alerts-panel" aria-label="Alerts" className="customer-tab-panel customer-tab-alerts">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#8c9980]">Stay in the loop</p>
                <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">Alerts</h1>
                <p className="mt-2 text-sm text-[#849080]">Booking updates from the clubs you know.</p>
              </div>
              {!notificationsFallback && unread > 0 && (
                <button type="button" className={secondaryButton} disabled={markingRead} onClick={() => void markAllRead()}>
                  {markingRead ? <LoaderCircle size={14} className="animate-spin" /> : <CheckCheck size={14} />}
                  Mark all as read
                </button>
              )}
            </div>
            {alertsStatus && (
              <div
                role="status"
                className="mt-6 flex items-center gap-2 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#66834d]"
              >
                <CheckCheck aria-hidden="true" size={17} /> {alertsStatus}
              </div>
            )}
            {notificationError && !notificationsFallback && (
              <div className="mt-6">
                <ErrorNotice message={notificationError} />
              </div>
            )}
            {notificationsFallback && (
              <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-[#e6e3d4] bg-[#fbfaf2] p-4 text-xs leading-relaxed text-[#82795d]">
                <Info size={15} className="mt-0.5 shrink-0" />
                <span>
                  Live alerts are temporarily unavailable, so this view is using the latest status from your bookings.
                  <button type="button" className="ml-1 font-semibold underline underline-offset-2" onClick={() => void refreshNotifications()}>
                    Try again
                  </button>
                </span>
              </div>
            )}
            {notificationsLoading && !notificationsFallback ? (
              <LoadingScreen text="Checking for updates…" />
            ) : visibleNotifications.length === 0 ? (
              <div className="mt-8">
                <EmptyState icon={<CheckCheck size={23} />} title="You’re all caught up">
                  Booking confirmations, changes, and useful reminders will appear here.
                </EmptyState>
              </div>
            ) : (
              <div className={cn(panel, 'mt-8 divide-y divide-[#edf0e9] overflow-hidden')}>
                {visibleNotifications.map((item) => {
                  const alertClub = clubs.find((club) => club.business.slug === item.businessSlug);
                  return (
                  <article key={item.id} className={cn('flex items-start gap-3 p-4 sm:p-5', !item.read && 'bg-[#f8faf4]')}>
                    <span className={cn(
                      'relative grid h-10 w-10 shrink-0 place-items-center rounded-full',
                      item.read ? 'bg-[#f0f2ed] text-[#879287]' : 'bg-[#e5eedb] text-[#678054]',
                    )}>
                      <Bell size={16} />
                      {!item.read && <span aria-hidden="true" className="absolute right-0 top-0 h-2.5 w-2.5 rounded-full border-2 border-white bg-[#a86752]" />}
                    </span>
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-sm font-semibold text-[#314a39]">{item.title}</h2>
                        {!item.read && <span className="sr-only">Unread</span>}
                        {item.actionNeeded && (
                          <span className="rounded-full bg-[#f8eed3] px-2 py-0.5 text-[9px] font-semibold text-[#927a42]">
                            Action needed
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-[#7f8c80]">{item.message}</p>
                      {item.createdAt && (
                        <p className="mt-2 text-[10px] text-[#a0a89e]">
                          {shortDate(
                            item.createdAt,
                            clubs.find((club) => club.business.slug === item.businessSlug)?.business.timezone,
                          )} ·{' '}
                          {time(
                            item.createdAt,
                            clubs.find((club) => club.business.slug === item.businessSlug)?.business.timezone,
                          )}
                        </p>
                      )}
                      {item.actionNeeded && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {item.bookingId ? (
                            <button
                              type="button"
                              className={cn(secondaryButton, '!min-h-9 !px-3 !py-1.5 !text-xs')}
                              onClick={() => openAlertBooking(item.bookingId!)}
                            >
                              View bookings <ArrowRight size={13} />
                            </button>
                          ) : item.actionNeeded ? (
                            <button
                              type="button"
                              className={cn(secondaryButton, '!min-h-9 !px-3 !py-1.5 !text-xs')}
                              onClick={() => selectTab('home')}
                            >
                              View bookings <ArrowRight size={13} />
                            </button>
                          ) : null}
                          {item.actionNeeded && alertClub && (
                            <Link
                              href={`/book/${encodeURIComponent(alertClub.business.slug)}`}
                              className={cn(secondaryButton, '!min-h-9 !px-3 !py-1.5 !text-xs')}
                            >
                              Book with {alertClub.business.name} <ExternalLink size={12} />
                            </Link>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {activeTab === 'profile' && (
          <section id="customer-profile-panel" aria-label="Profile" className="customer-tab-panel customer-tab-profile">
            <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#8c9980]">Your Courtly account</p>
            <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">Profile</h1>
            <p className="mt-2 text-sm text-[#849080]">Keep your details current across every club.</p>

            <form onSubmit={saveProfile} className={cn(panel, 'mt-8 p-5 sm:p-6')}>
              <div className="flex items-start gap-3 border-b border-[#edf0e9] pb-5">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#e8efe0] text-sm font-bold text-[#6b825b]">
                  {initials(profile.name || session.user.name)}
                </span>
                <div className="flex-1">
                  <h2 className="text-base font-semibold text-[#304b39]">Personal details</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#899583]">Shared only with clubs you book.</p>
                </div>
                <Pencil size={15} className="mt-1 text-[#91a087]" />
              </div>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <label htmlFor="customer-profile-name">Full name</label>
                  <input
                    id="customer-profile-name"
                    className={field}
                    value={profile.name}
                    onChange={(event) => {
                      setProfile((current) => ({ ...current, name: event.target.value }));
                      setProfileError('');
                      setProfileNotice('');
                    }}
                    required
                    minLength={2}
                    maxLength={120}
                    autoComplete="name"
                  />
                </div>
                <div>
                  <label htmlFor="customer-profile-email">Email address</label>
                  <input
                    id="customer-profile-email"
                    className={cn(field, '!bg-[#f5f6f3] !text-[#7f8b80]')}
                    value={session.user.email}
                    readOnly
                    aria-describedby="customer-profile-email-note"
                    autoComplete="email"
                  />
                  <p id="customer-profile-email-note" className="mt-1.5 text-[10px] text-[#9ba49b]">
                    Email is your sign-in identity and cannot be changed here.
                  </p>
                </div>
                <div>
                  <label htmlFor="customer-profile-phone">Phone</label>
                  <input
                    id="customer-profile-phone"
                    className={field}
                    type="tel"
                    value={profile.phone}
                    onChange={(event) => {
                      setProfile((current) => ({ ...current, phone: event.target.value }));
                      setProfileError('');
                      setProfileNotice('');
                    }}
                    maxLength={40}
                    autoComplete="tel"
                    placeholder="Optional"
                  />
                </div>
                <div>
                  <label htmlFor="customer-profile-parent">Parent or guardian</label>
                  <input
                    id="customer-profile-parent"
                    className={field}
                    value={profile.parentName}
                    onChange={(event) => {
                      setProfile((current) => ({ ...current, parentName: event.target.value }));
                      setProfileError('');
                      setProfileNotice('');
                    }}
                    maxLength={120}
                    placeholder="Optional"
                  />
                </div>
              </div>
              {profileError && <div className="mt-5"><ErrorNotice message={profileError} /></div>}
              {profileNotice && (
                <div role="status" className="mt-5 flex items-center gap-2 rounded-xl bg-[#edf5e4] p-4 text-sm text-[#66834d]">
                  <Check size={16} /> {profileNotice}
                </div>
              )}
              <button type="submit" className={cn(primaryButton, 'mt-5')} disabled={profileBusy}>
                {profileBusy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}
                Save profile
              </button>
            </form>

            <section className="mt-9" aria-labelledby="profile-booking-history">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#8a987e]">All your sessions</p>
                <h2 id="profile-booking-history" className="mt-1 text-xl font-semibold tracking-tight">Booking history</h2>
              </div>
              <div role="group" aria-label="Filter booking history" className="mt-4 flex gap-2 overflow-x-auto pb-2">
                {(['all', 'upcoming', 'completed', 'cancelled'] as BookingFilter[]).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    aria-pressed={historyFilter === filter}
                    onClick={() => setHistoryFilter(filter)}
                    className={cn(
                      'min-h-10 shrink-0 rounded-full border px-4 text-xs font-medium capitalize transition',
                      historyFilter === filter
                        ? 'border-[#174c3c] bg-[#174c3c] text-white'
                        : 'border-[#dfe5dc] bg-white text-[#667568] hover:border-[#aebdaa]',
                    )}
                  >
                    {filter}
                  </button>
                ))}
              </div>
              <div className="mt-3 space-y-3">
                {bookingsLoading ? (
                  <div role="status" className="flex min-h-28 items-center justify-center gap-2 rounded-2xl border border-[#e5e9e4] bg-white text-xs text-[#82907d]">
                    <LoaderCircle size={16} className="animate-spin" /> Gathering your sessions…
                  </div>
                ) : filteredHistory.length ? (
                  filteredHistory.map((item) => (
                    <CompactBooking key={item.participant.id} item={item} nowMs={nowMs} />
                  ))
                ) : (
                  <p className="rounded-2xl border border-dashed border-[#dfe5dc] bg-white px-5 py-8 text-center text-sm text-[#879287]">
                    No {historyFilter === 'all' ? '' : `${historyFilter} `}bookings to show.
                  </p>
                )}
              </div>
            </section>

            <section className={cn(panel, 'mt-9 p-5')}>
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f2eee9] text-[#91745f]">
                  <LogOut size={17} />
                </span>
                <div className="flex-1">
                  <h2 className="text-sm font-semibold text-[#3f4c42]">Finished for now?</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#899287]">Sign out of this device. Your bookings stay safely with your account.</p>
                </div>
              </div>
              <button type="button" className={cn(secondaryButton, 'mt-5 w-full text-[#8e6555]')} disabled={signingOut} onClick={() => void signOut()}>
                {signingOut ? <LoaderCircle size={15} className="animate-spin" /> : <LogOut size={15} />}
                Sign out
              </button>
              {signOutError && (
                <p role="alert" className="mt-3 text-xs text-[#a16a55]">{signOutError}</p>
              )}
            </section>
          </section>
        )}
      </main>
      <BottomNavigation activeTab={activeTab} onChange={selectTab} unread={unread} />
    </div>
  );
}
