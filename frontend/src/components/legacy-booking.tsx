'use client';

import Link from 'next/link';
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Home,
  Info,
  LoaderCircle,
  MapPin,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Video,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, loadSlots } from '@/lib/api';
import type { Booking, Participant, PublicBookingBusiness, PublicLocation, Slot } from '@/lib/types';
import { cn, dateKey, money, shortDate, time } from '@/lib/utils';

const primaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#103d2f] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none';
const secondaryButton =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#dce3da] bg-white px-4 py-2.5 text-sm font-medium text-[#344d40] transition hover:border-[#bdcbbb] hover:bg-[#f3f6f1] disabled:cursor-not-allowed disabled:opacity-40';
const panel =
  'min-w-0 rounded-2xl border border-[#e5e9e4] bg-white [&_*]:min-w-0 [&_p]:break-words [&_a]:min-h-11';

type LegacyManagedBooking = {
  business: PublicBookingBusiness;
  booking: Omit<Booking, 'participants'>;
  participant: Pick<Participant, 'name' | 'paid' | 'price' | 'cancelled' | 'cancelledAt'>;
  location?: PublicLocation;
  canCancel?: boolean;
  canReschedule?: boolean;
};
type Action = 'none' | 'cancel' | 'reschedule';
type Conflict = { date: string; reason: string };

function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
}

function conflictList(error: unknown): Conflict[] {
  if (
    !(error instanceof ApiError) ||
    !error.details ||
    typeof error.details !== 'object'
  ) {
    return [];
  }
  const conflicts = (error.details as { conflicts?: unknown }).conflicts;
  return Array.isArray(conflicts)
    ? conflicts.filter(
        (item): item is Conflict =>
          !!item &&
          typeof item === 'object' &&
          typeof item.date === 'string' &&
          typeof item.reason === 'string',
      )
    : [];
}

function plusDays(key: string, days: number) {
  const value = new Date(`${key}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dayLabel(key: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-SG', {
    ...options,
    timeZone: 'UTC',
  }).format(new Date(`${key}T12:00:00Z`));
}

function LocationIcon({
  location,
  size = 18,
}: {
  location?: PublicLocation;
  size?: number;
}) {
  const Icon =
    location?.type === 'HOME'
      ? Home
      : location?.type === 'ONLINE'
        ? Video
        : MapPin;
  return <Icon size={size} strokeWidth={1.7} />;
}

function LegacyShell({
  business,
  children,
}: {
  business?: LegacyManagedBooking['business'];
  children: ReactNode;
}) {
  return (
    <div
      className="min-h-screen overflow-x-clip bg-[#f6f7f4] text-[#1c3029]"
      style={
        business?.color?.startsWith('#')
          ? { borderTop: `4px solid ${business.color}` }
          : undefined
      }
    >
      <header className="sticky top-0 z-40 border-b border-[#e5e9e4] bg-white/95 backdrop-blur-xl">
        <div className="!mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:min-h-20 sm:px-8">
          <Link
            href="/manage"
            aria-label="Courtly account bookings"
            className="inline-flex min-h-11 items-center gap-2 text-[22px] font-bold tracking-[-1px] text-[#174c3c] sm:gap-2.5 sm:text-[27px] sm:tracking-[-1.2px]"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#174c3c] text-[#d8e9bb] sm:h-8 sm:w-8">
              <CircleDot
                className="h-6 w-6 sm:h-[26px] sm:w-[26px]"
                strokeWidth={1.4}
              />
            </span>
            Courtly
            <span className="-ml-1 mt-2 h-1.5 w-1.5 rounded-full bg-[#a6bb7d]" />
          </Link>
          <span className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border border-[#e5e9e4] bg-[#f6f8f2] px-2.5 py-1.5 text-[10px] font-medium text-[#617455] sm:px-3 sm:text-[11px]">
            <ShieldCheck size={13} /> Private booking link
          </span>
        </div>
      </header>
      {children}
      <footer className="!mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-[11px] text-[#8a9489] sm:flex-row sm:px-8">
        <span>Thoughtfully powered by Courtly</span>
        <span>
          {business
            ? `${business.name} · ${business.timezone.replaceAll('_', ' ')}`
            : 'Your coaching day, in sync.'}
        </span>
      </footer>
    </div>
  );
}

function Loading() {
  return (
    <div
      role="status"
      className="flex min-h-72 flex-col items-center justify-center gap-4 text-sm text-[#7a877b]"
    >
      <LoaderCircle className="animate-spin text-[#174c3c]" size={26} />
      <span>Opening your booking…</span>
    </div>
  );
}

function ErrorNotice({
  message,
  conflicts = [],
}: {
  message: string;
  conflicts?: Conflict[];
}) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[#eedbd5] bg-[#fff7f3] p-4 text-sm leading-relaxed text-[#925541]"
    >
      <div className="flex items-start gap-2.5">
        <Info size={17} className="!mt-0.5 shrink-0" />
        <span>{message}</span>
      </div>
      {conflicts.length > 0 && (
        <ul className="!mt-3 space-y-2 pl-7">
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

function DetailRow({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="!mt-0.5 shrink-0 text-[#85927f]">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wider text-[#8a9487]">
          {title}
        </p>
        <div className="!mt-1 text-sm leading-relaxed text-[#415244]">
          {children}
        </div>
      </div>
    </div>
  );
}

function DateSlots({
  date,
  onDateChange,
  slots,
  loading,
  error,
  onRetry,
  selected,
  onSelect,
  timezone,
  minimumDate,
}: {
  date: string;
  onDateChange: (date: string) => void;
  slots: Slot[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  selected: string;
  onSelect: (slot: Slot) => void;
  timezone: string;
  minimumDate: string;
}) {
  const [week, setWeek] = useState(date || minimumDate);
  const dates = Array.from({ length: 7 }, (_, index) => plusDays(week, index));
  const available = slots.filter((candidate) => candidate.available);

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="!text-base !font-semibold">
          {dayLabel(week, { month: 'long', year: 'numeric' })}
        </h3>
        <div className="grid w-full min-w-0 grid-cols-[44px_44px_minmax(0,1fr)] gap-2 sm:w-auto sm:grid-cols-[44px_44px_146px]">
          <button
            type="button"
            className={cn(
              secondaryButton,
              '!h-11 !min-h-11 !w-11 !px-0 !py-0',
            )}
            disabled={week <= minimumDate}
            onClick={() =>
              setWeek(
                plusDays(week, -7) < minimumDate
                  ? minimumDate
                  : plusDays(week, -7),
              )
            }
            aria-label="Previous week"
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className={cn(
              secondaryButton,
              '!h-11 !min-h-11 !w-11 !px-0 !py-0',
            )}
            onClick={() => setWeek(plusDays(week, 7))}
            aria-label="Next week"
          >
            <ChevronRight size={18} />
          </button>
          <div className="min-w-0 overflow-hidden rounded-xl">
            <label htmlFor="legacy-booking-date" className="sr-only">
              Choose a date
            </label>
            <input
              id="legacy-booking-date"
              type="date"
              value={date}
              min={minimumDate}
              onChange={(event) => {
                if (event.target.value && event.target.value >= minimumDate) {
                  onDateChange(event.target.value);
                  setWeek(event.target.value);
                }
              }}
              className="!block !min-h-11 !w-full !min-w-0 !max-w-full !rounded-xl !px-2.5 !py-2 !text-base sm:!text-xs"
            />
          </div>
        </div>
      </div>
      <div className="-mx-5 flex snap-x snap-mandatory gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:grid sm:grid-cols-7 sm:px-0">
        {dates.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onDateChange(key)}
            aria-pressed={date === key}
            aria-label={dayLabel(key, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
            className={cn(
              'flex min-h-[76px] w-[54px] shrink-0 snap-start flex-col items-center justify-center gap-1.5 rounded-xl border px-1 py-2.5 transition sm:w-auto',
              date === key
                ? 'border-[#174c3c] bg-[#174c3c] text-white shadow-sm'
                : 'border-[#e5e9e4] bg-white text-[#8a9487] hover:border-[#a1b397] hover:bg-[#f8faf5]',
            )}
          >
            <span className="text-[10px] font-medium uppercase tracking-wide sm:text-xs sm:normal-case sm:tracking-normal">
              {dayLabel(key, { weekday: 'short' })}
            </span>
            <span
              className={cn(
                'text-xl font-semibold',
                date !== key && 'text-[#3b5140]',
              )}
            >
              {dayLabel(key, { day: 'numeric' })}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t border-[#eef0eb] pt-5">
        <div className="!mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="!text-sm">Available start times</h3>
          <span className="flex items-center gap-1 text-[11px] text-[#82907e]">
            <Clock3 size={12} /> {timezone.replaceAll('_', ' ')}
          </span>
        </div>
        {loading ? (
          <div
            role="status"
            className="flex min-h-28 items-center justify-center gap-2 py-8 text-sm text-[#81907c]"
          >
            <LoaderCircle size={17} className="animate-spin" />
            Checking availability…
          </div>
        ) : error ? (
          <div className="space-y-3">
            <ErrorNotice message={error} />
            <button type="button" className={secondaryButton} onClick={onRetry}>
              <RefreshCw size={15} /> Retry availability
            </button>
          </div>
        ) : available.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#dfe6db] bg-[#f8faf5] px-5 py-9 text-center">
            <CalendarDays
              size={28}
              strokeWidth={1.5}
              className="!mx-auto mb-3 text-[#92a385]"
            />
            <h3 className="!text-sm">No times available on this date</h3>
            <p className="!mx-auto mt-2 max-w-xs text-xs leading-relaxed text-[#83907d]">
              Choose another day to keep the same lesson, coach, and location.
            </p>
            <button
              type="button"
              onClick={() => {
                const next = plusDays(date, 1);
                onDateChange(next);
                if (!dates.includes(next)) setWeek(next);
              }}
              className="!mt-4 inline-flex min-h-11 items-center gap-1.5 px-2 text-xs font-semibold text-[#174c3c]"
            >
              Try the next day <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {available.map((candidate) => (
              <button
                key={candidate.startAt}
                type="button"
                aria-pressed={selected === candidate.startAt}
                onClick={() => onSelect(candidate)}
                className={cn(
                  'flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 py-3 text-sm font-semibold transition sm:px-2',
                  selected === candidate.startAt
                    ? 'border-[#174c3c] bg-[#e8eee9] text-[#174c3c] ring-1 ring-[#174c3c]'
                    : 'border-[#e5e9e4] bg-white text-[#5b6c58] hover:border-[#9eaf94]',
                )}
              >
                <span className="whitespace-nowrap">
                  {time(candidate.startAt, timezone)}
                </span>
                {candidate.placesRemaining > 1 && (
                  <span className="text-[9px] font-normal text-[#82907c]">
                    {candidate.placesRemaining} places left
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function LegacyBooking({ token }: { token: string }) {
  const [data, setData] = useState<LegacyManagedBooking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState<Action>('none');
  const [actionError, setActionError] = useState('');
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [slotsVersion, setSlotsVersion] = useState(0);
  const path = `/manage/${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const value = await api<LegacyManagedBooking>(path);
      setData(value);
      setDate(dateKey(new Date(), value.business.timezone));
    } catch (loadError) {
      setData(null);
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (action !== 'reschedule' || !data || !date) return;
    let ignore = false;
    setSlotsLoading(true);
    setSlotsError('');
    setSlots([]);
    setSelectedSlot(null);
    loadSlots(data.business.slug, {
      serviceId: data.booking.serviceId,
      instructorId: data.booking.instructorId,
      locationId: data.booking.locationId,
      date,
    })
      .then((value) => {
        if (!ignore) {
          setSlots(
            value.slots.filter(
              (candidate) => candidate.startAt !== data.booking.startAt,
            ),
          );
        }
      })
      .catch((slotsLoadError) => {
        if (!ignore) setSlotsError(messageOf(slotsLoadError));
      })
      .finally(() => {
        if (!ignore) setSlotsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [action, data, date, slotsVersion]);

  function beginAction(nextAction: Exclude<Action, 'none'>) {
    if (!data) return;
    setAction(nextAction);
    setActionError('');
    setConflicts([]);
    setNotice('');
    setSelectedSlot(null);
    if (nextAction === 'reschedule') {
      setDate(dateKey(data.booking.startAt, data.business.timezone));
    }
  }

  function closeAction() {
    setAction('none');
    setActionError('');
    setConflicts([]);
    setSelectedSlot(null);
  }

  async function performAction() {
    if (action === 'none' || busy) return;
    if (action === 'reschedule' && !selectedSlot) return;
    setBusy(true);
    setActionError('');
    setConflicts([]);
    try {
      const completedAction = action;
      const value = await api<LegacyManagedBooking>(`${path}/${action}`, {
        method: 'POST',
        body: JSON.stringify(
          action === 'reschedule'
            ? { startAt: selectedSlot!.startAt }
            : {},
        ),
      });
      setData(value);
      setSelectedSlot(null);
      setAction('none');
      setNotice(
        completedAction === 'cancel'
          ? 'Your booking has been cancelled.'
          : 'Your session has been rescheduled. The new details are below.',
      );
    } catch (actionFailure) {
      setActionError(messageOf(actionFailure));
      setConflicts(conflictList(actionFailure));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <LegacyShell>
        <Loading />
      </LegacyShell>
    );
  }

  if (error || !data) {
    return (
      <LegacyShell>
        <main className="!mx-auto max-w-lg px-5 py-16">
          <section className={cn(panel, 'space-y-5 p-7')}>
            <ShieldCheck size={30} className="text-[#93a582]" />
            <h1 className="!text-2xl">This booking link is unavailable</h1>
            <ErrorNotice
              message={error || 'This management link is not available.'}
            />
            <p className="text-xs leading-relaxed text-[#86947a]">
              Check that you opened the full link from your original booking
              receipt. If it has expired, contact your coach or sign in to your
              account.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={secondaryButton}
                onClick={() => void load()}
              >
                <RefreshCw size={15} /> Try again
              </button>
              <Link href="/manage" className={primaryButton}>
                My account bookings <ArrowRight size={15} />
              </Link>
            </div>
          </section>
        </main>
      </LegacyShell>
    );
  }

  const { booking, business, participant, location } = data;
  const cancelled =
    booking.status === 'CANCELLED' ||
    participant.cancelled === true ||
    !!participant.cancelledAt;
  const completed =
    booking.status === 'COMPLETED' ||
    new Date(booking.endAt).getTime() < Date.now();
  const pending = booking.status === 'PENDING';
  const started = new Date(booking.startAt).getTime() <= Date.now();
  const insideWindow =
    new Date(booking.startAt).getTime() - Date.now() <
    business.cancellationHours * 3_600_000;
  const fallbackCanChange =
    !cancelled && !completed && !started && !insideWindow;
  const canCancel =
    !cancelled && !completed && (data.canCancel ?? fallbackCanChange);
  const canReschedule =
    !cancelled &&
    !completed &&
    booking.type === 'PRIVATE' &&
    (data.canReschedule ?? fallbackCanChange);
  const status = cancelled
    ? 'Cancelled'
    : pending
      ? 'Awaiting confirmation'
      : completed
        ? 'Completed'
        : 'Confirmed';

  return (
    <LegacyShell business={business}>
      <main className="!mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
        <div className="!mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="!mb-2 text-[10px] font-semibold uppercase tracking-[2px] text-[#8d9b80]">
              Existing private booking link
            </p>
            <h1 className="!text-3xl !font-medium !tracking-tight sm:!text-4xl">
              Your booking
            </h1>
            <p className="!mt-3 text-sm text-[#86937c]">
              View or update this booking without signing in.
            </p>
          </div>
          <Link href="/manage" className={secondaryButton}>
            My account bookings <ArrowRight size={14} />
          </Link>
        </div>

        {notice && (
          <div
            role="status"
            className="!mb-5 flex items-start gap-2.5 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm leading-relaxed text-[#66834d]"
          >
            <CheckCheck size={18} className="!mt-0.5 shrink-0" />
            {notice}
          </div>
        )}

        <section className={cn(panel, 'overflow-hidden')}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#edf0e8] bg-[#fafbf7] px-5 py-4 sm:px-6 sm:py-5">
            <h2 className="!text-base">{business.name}</h2>
            <span
              className={cn(
                'rounded-full px-3 py-1.5 text-[10px] font-medium',
                status === 'Cancelled'
                  ? 'bg-[#f8e8e3] text-[#a67260]'
                  : status === 'Awaiting confirmation'
                    ? 'bg-[#f8eed3] text-[#9b844b]'
                    : status === 'Completed'
                      ? 'bg-[#e8edf2] text-[#728696]'
                      : 'bg-[#e9f0df] text-[#77905c]',
              )}
            >
              {status}
            </span>
          </div>
          <div className="p-5 sm:p-8">
            <div className="!mb-7 flex items-center gap-4">
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[#eaf0e2] text-[#869d6f]">
                <CircleDot size={29} strokeWidth={1.5} />
              </span>
              <div>
                <h2 className="!text-xl">{booking.serviceName}</h2>
                <p className="!mt-1.5 text-xs text-[#88967d]">
                  With {booking.instructorName} ·{' '}
                  {Math.max(
                    0,
                    Math.round(
                      (new Date(booking.endAt).getTime() -
                        new Date(booking.startAt).getTime()) /
                        60_000,
                    ),
                  )}{' '}
                  minutes
                </p>
              </div>
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <DetailRow icon={<CalendarDays size={18} />} title="When">
                {shortDate(booking.startAt, business.timezone)}
                <p className="text-xs text-[#89977d]">
                  {time(booking.startAt, business.timezone)} –{' '}
                  {time(booking.endAt, business.timezone)}
                </p>
                <p className="text-[10px] text-[#9aa48e]">
                  {business.timezone.replaceAll('_', ' ')}
                </p>
              </DetailRow>
              <DetailRow
                icon={<LocationIcon location={location} />}
                title="Where"
              >
                {booking.locationName}
                <p className="break-words text-xs text-[#89977d]">
                  {booking.address ||
                    location?.address ||
                    'Details provided by your coach'}
                </p>
              </DetailRow>
              <DetailRow icon={<UserRound size={18} />} title="Booked for">
                {participant.name || 'Your session'}
              </DetailRow>
              <DetailRow icon={<ShieldCheck size={18} />} title="Session price">
                {money(participant.price ?? booking.price, business.currency)}
                <p className="text-xs text-[#89977d]">
                  {participant.paid
                    ? 'Marked paid by your coach'
                    : 'Payment arranged with your coach'}
                </p>
              </DetailRow>
            </div>
            {pending && (
              <div className="!mt-6 flex gap-2.5 rounded-xl border border-[#eee5ce] bg-[#fcf8ec] p-4 text-xs leading-relaxed text-[#897344]">
                <Info size={16} className="!mt-0.5 shrink-0" />
                <div>
                  <strong>Your session is awaiting confirmation.</strong>
                  <p className="!mt-1">
                    Your coach will confirm the lesson and any venue
                    arrangements.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        {action === 'none' && (
          <section className={cn(panel, 'mt-5 p-5 sm:p-6')}>
            <h2 className="!text-base">Plans change. We get it.</h2>
            <p className="!mt-2 text-xs leading-relaxed text-[#87967b]">
              {cancelled
                ? 'This booking is cancelled. Sign in to your account when you are ready to book again.'
                : `Changes must be made at least ${business.cancellationHours} hours before the session and affect only this booking.`}
            </p>
            {!cancelled && booking.type === 'GROUP' && !canReschedule && (
              <p className="!mt-3 text-xs leading-relaxed text-[#849575]">
                Contact your coach to move a place in a group session.
              </p>
            )}
            {!cancelled && !canCancel && !canReschedule && (
              <p className="!mt-3 rounded-xl bg-[#f6f8f2] p-3 text-xs leading-relaxed text-[#849575]">
                {started || completed
                  ? 'This session has already started or finished.'
                  : 'This session is inside the self-service change window.'}{' '}
                Contact your coach if you need help.
              </p>
            )}
            <div className="!mt-5 flex flex-wrap gap-3">
              {canReschedule && (
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => beginAction('reschedule')}
                >
                  <CalendarDays size={16} /> Reschedule session
                </button>
              )}
              {canCancel && (
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#edddd7] px-4 py-2.5 text-sm font-medium text-[#a37565] transition hover:bg-[#fff7f3]"
                  onClick={() => beginAction('cancel')}
                >
                  <X size={15} /> Cancel booking
                </button>
              )}
              {(cancelled || completed) && (
                <Link href="/manage" className={primaryButton}>
                  Open my bookings <ArrowRight size={15} />
                </Link>
              )}
            </div>
          </section>
        )}

        {action === 'cancel' && (
          <section
            role="region"
            aria-label="Confirm cancellation"
            className="!mt-5 rounded-2xl border border-[#e7d4ca] bg-[#fffcf9] p-5 sm:p-6"
          >
            <h2 className="!text-lg">Cancel this session?</h2>
            <p className="!mt-2 text-sm leading-relaxed text-[#958273]">
              This releases your place in {booking.serviceName} on{' '}
              {shortDate(booking.startAt, business.timezone)} at{' '}
              {time(booking.startAt, business.timezone)}. This cannot be
              undone from this link.
            </p>
            <p className="!mt-3 text-xs leading-relaxed text-[#a09586]">
              If you paid your coach directly, contact them about their refund
              policy.
            </p>
            {actionError && (
              <div className="!mt-4">
                <ErrorNotice message={actionError} conflicts={conflicts} />
              </div>
            )}
            <div className="!mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                onClick={closeAction}
              >
                Keep my booking
              </button>
              <button
                type="button"
                disabled={busy}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#a46d56] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#8b5945] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void performAction()}
              >
                {busy ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <X size={15} />
                )}
                {busy ? 'Cancelling…' : 'Yes, cancel this session'}
              </button>
            </div>
          </section>
        )}

        {action === 'reschedule' && (
          <section className={cn(panel, 'mt-5 p-5 sm:p-7')}>
            <div className="!mb-6 flex items-start justify-between gap-4">
              <div>
                <h2 className="!text-lg">Find a better time</h2>
                <p className="!mt-2 text-xs text-[#8b987f]">
                  The lesson, coach, and location stay the same.
                </p>
              </div>
              <button
                type="button"
                className={cn(secondaryButton, '!px-2.5')}
                aria-label="Close reschedule"
                disabled={busy}
                onClick={closeAction}
              >
                <X size={17} />
              </button>
            </div>
            <DateSlots
              date={date}
              onDateChange={(value) => {
                setDate(value);
                setSelectedSlot(null);
              }}
              slots={slots}
              loading={slotsLoading}
              error={slotsError}
              onRetry={() => setSlotsVersion((value) => value + 1)}
              selected={selectedSlot?.startAt ?? ''}
              onSelect={setSelectedSlot}
              timezone={business.timezone}
              minimumDate={dateKey(new Date(), business.timezone)}
            />
            {selectedSlot && (
              <div className="!mt-5 rounded-xl bg-[#f0f5e8] p-4 text-xs leading-relaxed text-[#7d9169]">
                New time:{' '}
                <strong>
                  {shortDate(selectedSlot.startAt, business.timezone)},{' '}
                  {time(selectedSlot.startAt, business.timezone)}
                </strong>
                . Your current time remains reserved until this succeeds.
              </div>
            )}
            {actionError && (
              <div className="!mt-5">
                <ErrorNotice message={actionError} conflicts={conflicts} />
              </div>
            )}
            <div className="!mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                onClick={closeAction}
              >
                Keep original time
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={!selectedSlot || busy || slotsLoading}
                onClick={() => void performAction()}
              >
                {busy ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <Check size={15} />
                )}
                {busy ? 'Rescheduling…' : 'Confirm new time'}
              </button>
            </div>
          </section>
        )}

        <div className="!mt-7 flex items-start gap-2.5 px-1 text-[11px] leading-relaxed text-[#96a08a]">
          <ShieldCheck size={15} className="!mt-0.5 shrink-0" />
          <p>
            This legacy link is a private credential. Keep it safe: anyone with
            the link can manage this booking. New bookings and your full history
            are available through your Courtly account.
          </p>
        </div>
      </main>
    </LegacyShell>
  );
}
