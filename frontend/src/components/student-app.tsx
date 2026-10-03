'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import {
  ArrowRight,
  Bell,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronRight,
  CircleDot,
  Clock3,
  Compass,
  ExternalLink,
  Heart,
  Home,
  HelpCircle,
  Info,
  List as ListIcon,
  LoaderCircle,
  LogOut,
  MapPin,
  MessageCircle,
  PackageCheck,
  Pencil,
  ReceiptText,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TicketCheck,
  UserRound,
  UsersRound,
  Video,
  WalletCards,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type Ref,
  type ReactNode,
} from 'react';
import { CourtlyLogo } from '@/components/public-booking';
import { CalendarConnectionCard } from '@/components/calendar-connection-card';
import { EmailVerificationNotice } from '@/components/email-verification-notice';
import { PrivacyRequestsPanel } from '@/components/privacy/privacy-requests-panel';
import { NotificationPreferencesCard } from '@/components/notification-preferences';
import { PaymentReceiptsPanel } from '@/components/payment-receipts-panel';
import { AccountRentalHistory } from '@/components/account-rental-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Disclosure, SeeMoreButton } from '@/components/ui/progressive-disclosure';
import {
  ApiError,
  acceptAccountReschedule,
  api,
  cancelAccountBooking,
  checkoutBookingParticipant,
  checkoutPackageOffer,
  createLiveCheckoutIntent,
  createRentalReservation,
  declineAccountReschedule,
  loadAccountPackages,
  loadAccountPackageOffers,
  loadAccountProgress,
  loadFamilyBookingChildren,
  loadFavoriteClubs,
  markFeedbackViewed,
  removeFavoriteClub,
  saveFavoriteClub,
  loadAccountClubs,
  loadAccountBookings,
  loadAuthSession,
  loadCheckoutReview,
  loadLiveCheckoutIntent,
  loadPaymentCapabilities,
  loadRental,
  loadRentals,
  loadRentalSlots,
  loadSlots,
  logoutAccount,
  openBookingChat,
  requestAccountReschedule,
  searchAccounts,
} from '@/lib/api';
import { alertAppearance, alertPageSize, sortAlerts } from '@/lib/alerts';
import { rebookHref } from '@/lib/booking-links';
import { packageWarnings, sortPackagesByAttention } from '@/lib/package-insights';
import { childNamedIn, manageHref, resolvePlayer, SELF_PLAYER } from '@/lib/player-view';
import { withFavorite } from '@/lib/session-search';
import {
  bookingCancelled, bookingState, incomingRequest, isInProgress, isUpcoming, outgoingRequest,
} from '@/lib/student-bookings';
import {
  accountBookingEvent, bookingSportResolver, dayKeyFor, readHomeView, writeHomeView, type HomeView,
} from '@/lib/student-calendar';
import { BookingCalendar } from '@/components/student/booking-calendar';
import { ChildPlayerView, type ChildSegment } from '@/components/student/child-player-view';
import { FindATime } from '@/components/student/find-a-time';
import { PackageActivityDialog, PackageWarnings } from '@/components/student/package-extras';
import { PlayerSwitcher } from '@/components/student/player-switcher';
import { ProgressCard } from '@/components/student/progress-card';
import { ProgressView } from '@/components/student/progress-view';
import { EmptyState, ErrorNotice, LoadingScreen, type Conflict } from '@/components/student/shared';
import { compactButton, field, panel, primaryButton, secondaryButton, statusClass } from '@/components/student/styles';
import { WaitlistPanel } from '@/components/student/waitlist-panel';
import { alertsButtonLabel, chatBadge, chatTabLabel } from '@/lib/chat';
import { destroyProductTour, startProductTour, type ProductTourContext } from '@/lib/product-tour';
import { ChatInbox, useChatInboxPrefetch } from '@/components/chat/chat-inbox';
import { useChatUnread } from '@/components/chat/use-chat-unread';
import type {
  AccountBooking,
  AccountDirectoryUser,
  AccountPackage,
  AuthSession,
  CheckoutAcceptance,
  FamilyBookingChild,
  CheckoutPolicyKind,
  CheckoutReview,
  PackageOffer,
  PackageOfferBusiness,
  PaymentCapabilities,
  PaymentIntent,
  ProgressSummary,
  PublicBookingBusiness,
  PublicLocation,
  RentalDetail,
  RentalListing,
  RentalSlot,
  Slot,
  StudentClubDirectoryEntry,
} from '@/lib/types';
import {
  POLICY_PATHS,
} from '@/lib/policies';
import { cn, dateKey, initials, money, shortDate, time } from '@/lib/utils';

type StudentTab = 'home' | 'explore' | 'book' | 'chat' | 'alerts' | 'profile' | 'progress';
/** Which step the booking dialog is showing. */
type BookingDialogMode = 'details' | 'cancel' | 'reschedule';
type BookingFilter = 'all' | 'upcoming' | 'completed' | 'cancelled';
type ClubRelationshipFilter = 'all' | 'known' | 'discover' | 'saved';
type ExploreSegment = 'classes' | 'rentals';
type PaymentUiMode = 'loading' | 'live' | 'simulated' | 'disabled';
type LiveCheckoutSession = {
  localIntentId: string; clientSecret: string; connectedAccountId: string; amount: number; currency: string;
  kind: 'PACKAGE' | 'BOOKING'; targetId: string; label: string; clubName: string; retrySignature: string;
  review: CheckoutReview;
};
type CheckoutReviewState = {
  kind: 'PACKAGE' | 'BOOKING'; targetId: string; review: CheckoutReview | null;
  loading: boolean; accepted: boolean; error: string;
};
type StudentNotification = {
  id: string;
  type?: string;
  bookingId?: string;
  title: string;
  message: string;
  read: boolean;
  actionNeeded?: boolean;
  createdAt?: string;
  businessSlug?: string;
  packageId?: string;
};
type KnownClub = {
  business: PublicBookingBusiness;
  bookingCount: number;
  nextAt?: string;
  lastAt?: string;
};
type ExploreClub = {
  business: PublicBookingBusiness;
  directory?: StudentClubDirectoryEntry;
  known?: KnownClub;
};

// Chat sits in the tab bar; Alerts moved to the header bell, the way a
// notifications heart sits above a feed, but keeps its own ?tab=alerts page.
const tabs: Array<{ id: StudentTab; label: string; icon: typeof Home }> = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'explore', label: 'Explore', icon: Compass },
  { id: 'book', label: 'Book', icon: Plus },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'profile', label: 'Profile', icon: UserRound },
];
const tabTitles: Record<StudentTab, string> = {
  home: 'Home', explore: 'Explore', book: 'Book', chat: 'Chat', alerts: 'Alerts', profile: 'Profile', progress: 'Progress',
};
// Alerts and Progress are route-only destinations: reachable from the bell
// and the Home progress card, but deliberately not extra tab-bar buttons.
const studentTabIds = new Set<StudentTab>([...tabs.map((tab) => tab.id), 'alerts', 'progress']);

function studentTab(value: string | null): StudentTab {
  return value && studentTabIds.has(value as StudentTab) ? (value as StudentTab) : 'home';
}

function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
}

function addCalendarDays(key: string, days: number) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function normalizeSports(value: string) {
  const seen = new Set<string>();
  if (!value.trim()) return [];
  return value.split(',').map((sport) => sport.trim()).filter((sport) => {
    const key = sport.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function profileSportsError(value: string) {
  if (!value.trim()) return '';
  const entries = value.split(',').map((sport) => sport.trim());
  if (entries.some((sport) => !sport)) return 'Enter a sport between each comma, or remove the extra comma.';
  if (entries.some((sport) => sport.length > 40)) return 'Each sport must use 40 characters or fewer.';
  if (entries.filter(Boolean).length > 20) return 'Add no more than 20 sports.';
  return '';
}

function profileUsernameError(value: string) {
  return /^[a-z0-9_]{3,30}$/.test(value)
    ? ''
    : 'Choose a username with 3–30 lowercase letters, numbers, or underscores.';
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

function isStudentSession(session: AuthSession | null) {
  return session?.user.accountType === 'STUDENT';
}

function rescheduleNoticeHours(item: AccountBooking) {
  // The coach's own protection window, which can be stricter than the club's
  // cancellation notice. The server is the authority; this mirrors it so the
  // buttons disappear at the same moment rather than a request later.
  return Math.max(
    item.management?.rescheduleNoticeHours ?? item.business.cancellationHours,
    item.business.cancellationHours,
  );
}

function canChangeBooking(
  item: AccountBooking,
  kind: 'cancel' | 'reschedule',
  now = Date.now(),
) {
  const startsAt = new Date(item.booking.startAt).getTime();
  const noticeHours =
    kind === 'cancel' ? item.business.cancellationHours : rescheduleNoticeHours(item);
  const cutoff = startsAt - noticeHours * 3_600_000;
  const locallyAllowed =
    Number.isFinite(startsAt) &&
    !bookingCancelled(item) &&
    ['CONFIRMED', 'PENDING'].includes(item.booking.status) &&
    now < startsAt &&
    now <= cutoff;
  const serverAllows = kind === 'cancel' ? item.canCancel : item.canReschedule;
  if (kind === 'reschedule' && item.awaitingCoach) return false;
  // One live proposal at a time: while a request is open, the answer to it is
  // the only move available.
  if (kind === 'reschedule' && item.rescheduleRequest) return false;
  return (
    locallyAllowed &&
    serverAllows !== false &&
    (kind === 'cancel' || item.booking.type === 'PRIVATE')
  );
}

function rescheduleAcceptanceClosed(item: AccountBooking, now = Date.now()) {
  const endsAt = new Date(item.booking.endAt).getTime();
  return (
    bookingCancelled(item) ||
    item.booking.status === 'COMPLETED' ||
    (Number.isFinite(endsAt) && endsAt <= now)
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

function parseNotifications(value: unknown): StudentNotification[] | null {
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
        packageId: typeof item.packageId === 'string' ? item.packageId : undefined,
      },
    ];
  });
}

function notificationTime(value?: string) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function derivedBookingActivity(bookings: AccountBooking[], now = Date.now()): StudentNotification[] {
  return bookings
    .map((item): StudentNotification => {
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

function directoryClubs(
  directory: StudentClubDirectoryEntry[],
  known: KnownClub[],
  includeKnownOutsideDirectory: boolean,
): ExploreClub[] {
  const knownBySlug = new Map(known.map((club) => [club.business.slug, club]));
  const entries = directory.map((entry) => ({
    business: entry.business,
    directory: entry,
    known: knownBySlug.get(entry.business.slug),
  }));
  const listedSlugs = new Set(entries.map((club) => club.business.slug));
  return [
    ...entries,
    ...(includeKnownOutsideDirectory ? known : [])
      .filter((club) => !listedSlugs.has(club.business.slug))
      .map((club) => ({ business: club.business, known: club })),
  ];
}

function ExploreClubCard({
  club,
  onViewPackages,
  canBook = true,
  saved,
  onToggleSaved,
}: {
  club: ExploreClub;
  onViewPackages?: (club: ExploreClub) => void;
  canBook?: boolean;
  /** Undefined when saved clubs are unavailable; the heart is then omitted. */
  saved?: boolean;
  onToggleSaved?: (club: ExploreClub, saved: boolean) => void;
}) {
  const { business, directory, known } = club;
  const areas = directory?.areas?.filter((area) => area.trim()) ?? [];
  return (
    <article className={cn(panel, 'overflow-hidden')}>
      <div
        className="h-1.5 bg-[#78936a]"
        style={business.color?.startsWith('#') ? { backgroundColor: business.color } : undefined}
      />
      <div className="flex h-[calc(100%-0.375rem)] flex-col p-5">
        <div className="flex items-start gap-3">
          <ClubAvatar club={club} size="small" />
          <div className="flex-1">
            <h3 className="text-base font-semibold tracking-tight text-[#2c4737]">{business.name}</h3>
            <p className="mt-1 text-xs leading-relaxed text-[#59675c]">
              {business.tagline || `Coaching with ${business.ownerName}`}
            </p>
            {areas.length > 0 && (
              <p className="!mt-1.5 flex items-start gap-1 text-[11px] text-[#59675c]">
                <MapPin size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span><span className="sr-only">Areas: </span>{areas.join(', ')}</span>
              </p>
            )}
          </div>
          {saved !== undefined && onToggleSaved && (
            <button
              type="button"
              aria-pressed={saved}
              aria-label={`Save ${business.name}`}
              title={saved ? 'Saved' : 'Save club'}
              onClick={() => onToggleSaved(club, !saved)}
              className={cn(
                '-mr-2 -mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]',
                saved ? 'text-[#b3483a] hover:bg-[#fbefeb]' : 'text-[#59675c] hover:bg-[#f0f4ec]',
              )}
            >
              <Heart size={19} aria-hidden="true" fill={saved ? 'currentColor' : 'none'} strokeWidth={1.8} />
            </button>
          )}
        </div>

        {directory && directory.sports.length > 0 && (
          <ul aria-label={`${business.name} sports`} className="mt-4 flex flex-wrap gap-1.5">
            {directory.sports.map((sport) => (
              <li key={sport} className="rounded-full bg-[#edf3e7] px-2.5 py-1 text-[10px] font-semibold text-[#496353]">
                {sport}
              </li>
            ))}
          </ul>
        )}

        {directory && (
          <dl className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-[#f6f8f3] p-3 text-center">
            <div>
              <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Classes</dt>
              <dd className="mt-1 text-sm font-semibold text-[#456049]">{directory.serviceCount}</dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Coaches</dt>
              <dd className="mt-1 text-sm font-semibold text-[#456049]">{directory.coachCount}</dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Locations</dt>
              <dd className="mt-1 text-sm font-semibold text-[#456049]">{directory.locationCount}</dd>
            </div>
          </dl>
        )}

        {known && (
          <dl className="mt-3 grid grid-cols-2 gap-3 rounded-xl border border-[#e4e9df] p-3">
            <div>
              <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Your bookings</dt>
              <dd className="mt-1 text-sm font-semibold text-[#456049]">{known.bookingCount}</dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Next session</dt>
              <dd className="mt-1 text-sm font-semibold text-[#456049]">
                {known.nextAt ? shortDate(known.nextAt, business.timezone) : 'Nothing booked'}
              </dd>
            </div>
          </dl>
        )}

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            {directory ? (
              <>
                <p className="text-[9px] uppercase tracking-wide text-[#59675c]">Sessions from</p>
                <p className="mt-1 text-base font-semibold text-[#34533e]">
                  {money(directory.priceFrom, business.currency)}
                </p>
              </>
            ) : (
              <p className="text-xs text-[#59675c]">Live details are temporarily unavailable.</p>
            )}
          </div>
          {known && <span className="text-[10px] font-semibold text-[#4f6847]">You have booked here</span>}
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {onViewPackages && directory && (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => onViewPackages(club)}
              aria-label={`View ${business.name} package offers`}
            >
              <WalletCards size={15} /> Packages
            </button>
          )}
          {canBook ? <Link
              href={`/book/${encodeURIComponent(business.slug)}`}
              className={primaryButton}
              aria-label={`View ${business.name} booking page`}
            >
              View booking page <ArrowRight size={15} />
            </Link>
            : <p className="self-center text-xs leading-relaxed text-[#59675c]">Booking is unavailable for this account.</p>}
        </div>
      </div>
    </article>
  );
}

function packageStateLabel(value: AccountPackage['state']) {
  if (value === 'ACTIVE') return 'Active';
  if (value === 'EXHAUSTED') return 'Exhausted';
  if (value === 'EXPIRED') return 'Expired';
  return 'Payment pending';
}

function packageStateClass(value: AccountPackage['state']) {
  if (value === 'ACTIVE') return 'bg-[#e9f0df] text-[#4f6847]';
  if (value === 'EXPIRED') return 'bg-[#f8e8e3] text-[#8b4d3c]';
  if (value === 'UNPAID') return 'bg-[#f8eed3] text-[#70582e]';
  return 'bg-[#e8edf2] text-[#4f687d]';
}

function packageCoverage(pkg: AccountPackage) {
  const classes = pkg.services?.map((service) => service.name) ?? pkg.serviceNames ?? [];
  const rentals = pkg.rentalLocations?.map((location) => location.name) ?? pkg.rentalLocationNames ?? [];
  return { classes, rentals };
}

function PackageCard({
  pkg,
  nowMs,
  onFindRental,
  onViewActivity,
  onBuyAnother,
}: {
  pkg: AccountPackage;
  nowMs: number;
  onFindRental: (pkg: AccountPackage) => void;
  onViewActivity: (pkg: AccountPackage) => void;
  onBuyAnother?: (pkg: AccountPackage) => void;
}) {
  const coverage = packageCoverage(pkg);
  const active = pkg.state === 'ACTIVE';
  return (
    <article className={cn(panel, 'p-5')} aria-label={`${pkg.name} from ${pkg.business.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-[#59675c]">{pkg.business.name}</p>
          <h3 className="mt-1 text-base font-semibold text-[#2c4737]">{pkg.name}</h3>
        </div>
        <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-semibold', packageStateClass(pkg.state))}>
          {packageStateLabel(pkg.state)}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-[#f6f8f3] p-3">
        <div>
          <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Credits left</dt>
          <dd className="mt-1 text-base font-semibold text-[#34533e]">{pkg.remainingCredits} / {pkg.totalCredits}</dd>
        </div>
        <div>
          <dt className="text-[9px] uppercase tracking-wide text-[#59675c]">Expires</dt>
          <dd className="mt-1 text-sm font-semibold text-[#456049]">{shortDate(pkg.expiresAt)}</dd>
        </div>
      </dl>
      <PackageWarnings pkg={pkg} nowMs={nowMs} className="mt-3" />
      <div className="mt-4 space-y-2 text-xs leading-relaxed text-[#59675c]">
        <p><strong className="font-semibold text-[#415244]">Classes:</strong> {coverage.classes.length ? coverage.classes.join(', ') : 'None'}</p>
        <p><strong className="font-semibold text-[#415244]">Venue rentals:</strong> {coverage.rentals.length ? coverage.rentals.join(', ') : 'None'}</p>
      </div>
      {active && (coverage.classes.length > 0 || coverage.rentals.length > 0) && (
        <div className="mt-5 flex flex-wrap gap-2">
          {coverage.classes.length > 0 && (
            <Link
              href={`/book/${encodeURIComponent(pkg.business.slug)}?packageId=${encodeURIComponent(pkg.id)}`}
              className={secondaryButton}
            >
              Book an eligible class <ArrowRight size={14} />
            </Link>
          )}
          {coverage.rentals.length > 0 && (
            <button type="button" className={secondaryButton} onClick={() => onFindRental(pkg)}>
              Find an eligible rental <ArrowRight size={14} />
            </button>
          )}
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-[#edf0e8] pt-4">
        <button type="button" className={compactButton} onClick={() => onViewActivity(pkg)} aria-label={`View activity for ${pkg.name}`}>
          <ReceiptText size={14} aria-hidden="true" /> View activity
        </button>
        {onBuyAnother && (
          <button type="button" className={compactButton} onClick={() => onBuyAnother(pkg)} aria-label={`Buy another package from ${pkg.business.name}`}>
            <WalletCards size={14} aria-hidden="true" /> Buy another package
          </button>
        )}
      </div>
    </article>
  );
}

function RentalCard({
  rental, onOpen, onViewPackages,
}: {
  rental: RentalListing; onOpen: (rental: RentalListing) => void; onViewPackages?: (rental: RentalListing) => void;
}) {
  return (
    <article className={cn(panel, 'flex flex-col p-5')}>
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#eaf0e2] text-[#4f6847]">
          <MapPin size={19} />
        </span>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-[#59675c]">{rental.sport}</p>
          <h3 className="mt-1 text-base font-semibold text-[#2c4737]">{rental.name}</h3>
          {'club' in rental && rental.club && <p className="mt-1 text-xs text-[#59675c]">{rental.club.name}</p>}
        </div>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-[#59675c]">{rental.address}</p>
      {rental.amenities.length > 0 && (
        <ul aria-label={`${rental.name} amenities`} className="mt-3 flex flex-wrap gap-1.5">
          {rental.amenities.map((amenity) => <li key={amenity} className="rounded-full bg-[#edf3e7] px-2.5 py-1 text-[10px] font-semibold text-[#496353]">{amenity}</li>)}
        </ul>
      )}
      <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-5">
        <div>
          <p className="text-[9px] uppercase tracking-wide text-[#59675c]">From</p>
          <p className="mt-1 text-base font-semibold text-[#34533e]">{money(rental.price, rental.currency)} / hour</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {onViewPackages && <button type="button" className={secondaryButton} onClick={() => onViewPackages(rental)}>
            View packages
          </button>}
          <button type="button" className={primaryButton} onClick={() => onOpen(rental)}>
            View times <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </article>
  );
}

function HomePackageSummary({
  loading, error, packages, nowMs, onOpen, onViewActivity, onBuyAnother, emptyAction,
}: {
  loading: boolean; error: string; packages: AccountPackage[]; nowMs: number; onOpen: () => void;
  onViewActivity: (pkg: AccountPackage) => void; onBuyAnother: (pkg: AccountPackage) => void; emptyAction?: ReactNode;
}) {
  const shown = sortPackagesByAttention(packages, nowMs).slice(0, 2);
  return (
    <section data-tour="student-packages" aria-labelledby="home-packages-heading" className={cn(panel, 'mt-7 p-5')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]">Credits across clubs</p>
          <h2 id="home-packages-heading" className="mt-1 text-lg font-semibold tracking-tight">Active packages</h2>
        </div>
        <button type="button" className={cn(secondaryButton, '!min-h-10 !px-3 !text-xs')} onClick={onOpen}>
          My Packages <ArrowRight size={14} />
        </button>
      </div>
      {loading ? (
        <p role="status" className="mt-4 flex items-center gap-2 text-xs text-[#59675c]"><LoaderCircle size={14} className="animate-spin" /> Loading packages…</p>
      ) : error ? (
        <p role="alert" className="mt-4 text-xs text-[#8b4d3c]">{error}</p>
      ) : packages.length ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {shown.map((pkg) => {
            const attention = packageWarnings(pkg, nowMs).length > 0;
            return (
              <div key={pkg.id} className="rounded-xl bg-[#f4f7f0] p-4">
                <p className="text-sm font-semibold text-[#304b39]">{pkg.name}</p>
                <p className="mt-1 text-xs text-[#59675c]">{pkg.remainingCredits} of {pkg.totalCredits} credits left · {pkg.business.name}</p>
                <PackageWarnings pkg={pkg} nowMs={nowMs} className="mt-2" />
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                  <button type="button" className="min-h-10 text-xs font-semibold text-[#174c3c] underline underline-offset-2" onClick={() => onViewActivity(pkg)} aria-label={`View activity for ${pkg.name}`}>
                    View activity
                  </button>
                  {attention && (
                    <button type="button" className="min-h-10 text-xs font-semibold text-[#174c3c] underline underline-offset-2" onClick={() => onBuyAnother(pkg)} aria-label={`Buy another package from ${pkg.business.name}`}>
                      Buy another package
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-xs leading-relaxed text-[#59675c]">No active package credits. Browse a club in Explore to see its offers.</p>
          {emptyAction && <div className="mt-3 flex flex-wrap gap-2">{emptyAction}</div>}
        </div>
      )}
    </section>
  );
}

function checkoutKey(kind: string, id: string) {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-${id}-${random}`;
}

function activeCheckoutKey(attempts: Map<string, string>, kind: string, id: string, signature: string) {
  const existing = attempts.get(signature);
  if (existing) return existing;
  const key = checkoutKey(kind, id);
  attempts.set(signature, key);
  return key;
}

function forgetDefinitiveCheckoutFailure(attempts: Map<string, string>, signature: string, error: unknown) {
  if (error instanceof ApiError && error.status < 500) attempts.delete(signature);
}

const checkoutPolicyFallbacks: Record<CheckoutPolicyKind, { path: string; label: string }> = {
  TERMS: { path: POLICY_PATHS.terms, label: 'Terms of Service' },
  CANCELLATION_REFUNDS: { path: POLICY_PATHS.cancellationRefunds, label: 'Cancellation & Refund Policy' },
  PACKAGE_TERMS: { path: POLICY_PATHS.packageTerms, label: 'Package Terms' },
};

function checkoutAcceptance(review: CheckoutReview): CheckoutAcceptance {
  const policy = (kind: CheckoutPolicyKind) => review.policies.find(candidate => candidate.kind === kind);
  return {
    accepted: true,
    reviewHash: review.reviewHash,
    termsVersion: policy('TERMS')?.version ?? '',
    cancellationRefundPolicyVersion: policy('CANCELLATION_REFUNDS')?.version ?? '',
    packageTermsVersion: review.kind === 'PACKAGE' ? policy('PACKAGE_TERMS')?.version ?? '' : null,
  };
}

function checkoutDateTime(value: string, timezone: string | null) {
  const zone = timezone || 'Asia/Singapore';
  return `${shortDate(value, zone)} at ${time(value, zone)}`;
}

function gstDescription(review: CheckoutReview) {
  const merchant = review.merchant;
  if (merchant.gstRegistrationStatus === 'REGISTERED') {
    const treatment = merchant.pricesIncludeGst === true
      ? 'The club declares that the displayed checkout amount includes GST.'
      : merchant.pricesIncludeGst === false
        ? 'The club declares that displayed prices exclude GST; this amount must not be treated as the final payable price if GST will be added.'
        : 'The club has not declared whether displayed prices include GST.';
    return `Club-declared GST registration: registered${merchant.gstRegistrationNumber ? ` (${merchant.gstRegistrationNumber})` : ''}. ${treatment} Courtly has not independently verified this declaration.`;
  }
  if (merchant.gstRegistrationStatus === 'NOT_REGISTERED') return 'The club declares that it is not GST registered; Courtly has not independently verified this declaration.';
  return 'The club has not declared its GST registration status.';
}

function CheckoutReviewDetails({ review, compact = false }: { review: CheckoutReview; compact?: boolean }) {
  const item = review.item;
  const merchant = review.merchant;
  return (
    <div className={cn('space-y-4 text-xs leading-relaxed text-[#59675c]', compact && 'space-y-3')}>
      <section className="rounded-xl border border-[#dfe5dc] bg-[#f8faf6] p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-[#59675c]">Selected club details</p>
        <p className="mt-1 text-sm font-semibold text-[#304b39]">{merchant.tradingName}</p>
        <p className="mt-1">Legal name: {merchant.legalName || 'Not provided'}</p>
        <p>Registration number: {merchant.registrationNumber || 'Not provided'}</p>
        <p>Support email: {merchant.supportEmail || 'Not provided'}</p>
        <p>Support address: {merchant.supportAddress || 'Not provided'}</p>
        <p className="mt-2">{gstDescription(review)}</p>
      </section>

      <section className="rounded-xl border border-[#dfe5dc] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-[#59675c]">Purchase</p>
            <p className="mt-1 text-sm font-semibold text-[#304b39]">{item.label}</p>
          </div>
          <p className="text-right text-base font-semibold text-[#174c3c]"><span className="block text-[9px] uppercase tracking-wide text-[#59675c]">Checkout amount</span>{money(review.amount, review.currency)}</p>
        </div>
        {item.description && <p className="mt-2">{item.description}</p>}
        <dl className="mt-3 grid gap-x-5 gap-y-2 sm:grid-cols-2">
          {item.serviceName && <div><dt className="font-semibold text-[#415244]">Service</dt><dd>{item.serviceName}</dd></div>}
          {item.coachName && <div><dt className="font-semibold text-[#415244]">Coach</dt><dd>{item.coachName}</dd></div>}
          {item.venueName && <div><dt className="font-semibold text-[#415244]">Venue</dt><dd>{item.venueName}{item.venueAddress ? ` · ${item.venueAddress}` : ''}</dd></div>}
          {item.startAt && <div><dt className="font-semibold text-[#415244]">Starts</dt><dd>{checkoutDateTime(item.startAt, item.timezone)}</dd></div>}
          {item.endAt && <div><dt className="font-semibold text-[#415244]">Ends</dt><dd>{checkoutDateTime(item.endAt, item.timezone)}</dd></div>}
          {item.timezone && <div><dt className="font-semibold text-[#415244]">Timezone</dt><dd>{item.timezone}</dd></div>}
          {item.totalCredits !== null && <div><dt className="font-semibold text-[#415244]">Credits</dt><dd>{item.totalCredits}</dd></div>}
          {item.validityDays !== null && <div><dt className="font-semibold text-[#415244]">Validity</dt><dd>{item.validityDays} days</dd></div>}
        </dl>
        {item.scopeNames.length > 0 && <p className="mt-3"><strong className="font-semibold text-[#415244]">Eligible for:</strong> {item.scopeNames.join(', ')}</p>}
      </section>

      <section className="rounded-xl border border-[#dfe5dc] p-4">
        <p><strong className="font-semibold text-[#415244]">Purchaser:</strong> {review.purchaser.name}</p>
        <p><strong className="font-semibold text-[#415244]">Purchaser email:</strong> {review.purchaser.email}</p>
        <p className="mt-2"><strong className="font-semibold text-[#415244]">Cancellation deadline:</strong> {review.cancellation.deadline ? checkoutDateTime(review.cancellation.deadline, item.timezone) : 'No deadline provided'}</p>
        <p className="mt-1">{review.cancellation.rule}</p>
      </section>

      <p className="rounded-xl bg-[#f2f5f0] p-3">
        Product and payment-routing note: {review.platform.role}
      </p>
    </div>
  );
}

function CheckoutReviewDialog({ state, paymentMode, busy, onAcceptedChange, onContinue, onChange, onClose, onRetry }: {
  state: CheckoutReviewState | null; paymentMode: PaymentUiMode; busy: boolean; onAcceptedChange: (accepted: boolean) => void;
  onContinue: () => void; onChange: () => void; onClose: () => void; onRetry: () => void;
}) {
  if (!state) return null;
  const review = state.review;
  const identityBlocksLive = paymentMode === 'live' && review?.merchant.identityReady === false;
  const applicablePolicyKinds: CheckoutPolicyKind[] = review
    ? ['TERMS', 'CANCELLATION_REFUNDS', ...(review.kind === 'PACKAGE' ? ['PACKAGE_TERMS' as const] : [])]
    : [];
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent
        className="max-w-2xl"
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
      >
        <DialogTitle className="text-xl font-semibold tracking-tight text-[#20382d]">Review before payment</DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">
          Check the selected club details, purchase details, checkout amount, and cancellation terms before continuing.
        </DialogDescription>
        {state.loading ? (
          <div role="status" className="flex min-h-48 items-center justify-center gap-2 text-sm text-[#59675c]"><LoaderCircle size={17} className="animate-spin" /> Loading the latest checkout details…</div>
        ) : state.error ? (
          <div className="mt-5 space-y-4"><ErrorNotice message={state.error} /><button type="button" className={secondaryButton} onClick={onRetry}><RefreshCw size={14} /> Try again</button></div>
        ) : review ? (
          <div className="mt-5">
            <CheckoutReviewDetails review={review} />
            {!review.merchant.identityReady && (
              <p role="alert" className="mt-4 rounded-xl border border-[#eee5ce] bg-[#fcf8ec] p-4 text-xs leading-relaxed text-[#70582e]">
                {identityBlocksLive
                  ? 'Payment cannot continue because the club has not completed the required business and GST declarations.'
                  : 'Development warning: the club has not completed the required business and GST declarations. Simulated checkout may continue, but no real card will be charged.'}
                {review.merchant.missingFields.length > 0 ? ` Missing: ${review.merchant.missingFields.join(', ')}.` : ''}
              </p>
            )}
            <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-[#dfe5dc] p-4 text-xs leading-relaxed text-[#415244]">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#174c3c]" checked={state.accepted} disabled={busy} onChange={(event) => onAcceptedChange(event.target.checked)} />
              <span>
                I have reviewed the selected club details, item, checkout amount, and cancellation terms, and I accept{' '}
                {applicablePolicyKinds.map((kind, index) => {
                  const policy = review.policies.find((candidate) => candidate.kind === kind);
                  const fallback = checkoutPolicyFallbacks[kind];
                  return <span key={kind}>{index > 0 ? index === applicablePolicyKinds.length - 1 ? ' and ' : ', ' : ''}<Link href={fallback.path} target="_blank" rel="noreferrer" className="font-semibold text-[#174c3c] underline underline-offset-2">{policy?.label || fallback.label}</Link></span>;
                })}.
              </span>
            </label>
            <p className="mt-3 text-[10px] leading-relaxed text-[#667568]">
              For fraud prevention, raw IP addresses and raw browser details are not stored. Courtly may store session-scoped pseudonymous fingerprints. Stripe may request additional authentication.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className={primaryButton} disabled={!state.accepted || identityBlocksLive || busy || !['live', 'simulated'].includes(paymentMode)} onClick={onContinue}>
                {busy ? <LoaderCircle size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                {busy ? 'Starting checkout…' : paymentMode === 'simulated' ? 'Continue to demo payment' : 'Continue to Stripe'}
              </button>
              <button type="button" className={secondaryButton} disabled={busy} onClick={onChange}>Change purchase</button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const stripeAccounts = new Map<string, ReturnType<typeof loadStripe>>();

function connectedStripe(publishableKey: string, connectedAccountId: string) {
  const key = `${publishableKey}:${connectedAccountId}`;
  const existing = stripeAccounts.get(key);
  if (existing) return existing;
  const stripe = loadStripe(publishableKey, { stripeAccount: connectedAccountId });
  stripeAccounts.set(key, stripe);
  return stripe;
}

async function waitForCheckout(intentId: string) {
  let latest: PaymentIntent | null = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      latest = (await loadLiveCheckoutIntent(intentId)).paymentIntent;
      if (latest.status !== 'REQUIRES_CONFIRMATION') return latest;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw error;
      if (attempt === 23) throw error;
    }
    await new Promise(resolve => window.setTimeout(resolve, 750));
  }
  return latest;
}

function LivePaymentForm({ checkout, onBusyChange, onSettled, onDefinitiveFailure }: {
  checkout: LiveCheckoutSession; onBusyChange: (busy: boolean) => void;
  onSettled: () => Promise<PaymentIntent | null>; onDefinitiveFailure: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [finished, setFinished] = useState(false);
  const [ready, setReady] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements || submitting || finished) return;
    setSubmitting(true);
    onBusyChange(true);
    setMessage('');
    try {
      const submitted = await elements.submit();
      if (submitted.error) {
        setMessage(submitted.error.message || 'Check your payment details and try again.');
        return;
      }
      const returnUrl = new URL('/manage', window.location.origin);
      returnUrl.searchParams.set('tab', 'home');
      returnUrl.searchParams.set('checkout_intent', checkout.localIntentId);
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl.toString() },
        redirect: 'if_required',
      });
      if (result.error) {
        if (result.error.type === 'card_error') {
          setFinished(true);
          onDefinitiveFailure();
          setMessage(result.error.message || 'The card was declined. Close this window and try again.');
        } else {
          setMessage(result.error.message || 'Check your payment details and try again.');
        }
        return;
      }
      if (result.paymentIntent?.status === 'requires_payment_method') {
        setFinished(true);
        onDefinitiveFailure();
        setMessage('The payment was not completed. Close this window and try again.');
        return;
      }
      if (result.paymentIntent?.status === 'canceled') {
        setFinished(true);
        onDefinitiveFailure();
        setMessage('The payment was not completed. Close this window and try again.');
        return;
      }
      setMessage('Stripe accepted the payment. Waiting for Courtly to confirm it…');
      const settled = await onSettled();
      if (settled?.status === 'FAILED' || settled?.status === 'CANCELLED') {
        setFinished(true);
        onDefinitiveFailure();
        setMessage('The payment was not completed. Close this window and try again.');
      } else if (settled?.status !== 'SUCCEEDED') {
        setFinished(true);
        setMessage('Your payment is still processing. You can close this window; Courtly will show it once confirmed.');
      }
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setSubmitting(false);
      onBusyChange(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <PaymentElement
        options={{ layout: 'tabs' }}
        onReady={() => setReady(true)}
        onLoadError={() => {
          setFinished(true);
          setMessage('The secure payment form could not load. Please close this window and try again.');
        }}
      />
      {message && <p role={finished ? 'alert' : 'status'} className={cn('mt-4 text-xs leading-relaxed', finished ? 'text-[#8b4d3c]' : 'text-[#59675c]')}>{message}</p>}
      <button type="submit" className={cn(primaryButton, 'mt-5 w-full')} disabled={!stripe || !elements || !ready || submitting || finished}>
        {submitting ? <LoaderCircle size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
        {submitting ? 'Confirming payment…' : `Pay ${money(checkout.amount, checkout.currency)}`}
      </button>
      <p className="mt-3 text-center text-[10px] leading-relaxed text-[#667568]">
        Secure payment by Stripe. Courtly sends the total and currency; your payment details go directly to Stripe. Stripe may request additional authentication.
      </p>
    </form>
  );
}

function LiveCheckoutDialog({ checkout, publishableKey, testMode, busy, onBusyChange, onClose, onChange, onSettled, onDefinitiveFailure }: {
  checkout: LiveCheckoutSession | null; publishableKey: string; testMode: boolean; busy: boolean;
  onBusyChange: (busy: boolean) => void; onClose: () => void; onChange: () => void;
  onSettled: () => Promise<PaymentIntent | null>; onDefinitiveFailure: () => void;
}) {
  const stripe = useMemo(() => checkout
    ? connectedStripe(publishableKey, checkout.connectedAccountId)
    : null, [checkout, publishableKey]);
  if (!checkout || !stripe) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
      >
        <DialogTitle className="text-xl font-semibold tracking-tight text-[#20382d]">Pay {checkout.clubName}</DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">
          {checkout.label} · {money(checkout.amount, checkout.currency)}
        </DialogDescription>
        {testMode && (
          <p className="mt-4 rounded-xl border border-[#eee5ce] bg-[#fcf8ec] p-3 text-xs leading-relaxed text-[#70582e]">
            Stripe test mode — use test payment details. No real card will be charged.
          </p>
        )}
        <div className="mt-5">
          <CheckoutReviewDetails review={checkout.review} compact />
          <button type="button" className={cn(secondaryButton, 'mt-4')} disabled={busy} onClick={onChange}>
            Change purchase
          </button>
        </div>
        <div className="mt-6">
          <Elements
            stripe={stripe}
            options={{
              clientSecret: checkout.clientSecret,
              appearance: {
                theme: 'stripe',
                variables: { colorPrimary: '#174c3c', colorText: '#20382d', borderRadius: '12px' },
              },
            }}
          >
            <LivePaymentForm
              checkout={checkout}
              onBusyChange={onBusyChange}
              onSettled={onSettled}
              onDefinitiveFailure={onDefinitiveFailure}
            />
          </Elements>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LocationIcon({ location, size = 18 }: { location?: PublicLocation; size?: number }) {
  const Icon =
    location?.type === 'HOME' ? Home : location?.type === 'ONLINE' ? Video : MapPin;
  return <Icon size={size} strokeWidth={1.7} />;
}

function Detail({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-[#59675c]">{icon}</span>
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">
          {label}
        </p>
        <div className="mt-1 text-sm leading-relaxed text-[#415244]">{children}</div>
      </div>
    </div>
  );
}

function SuccessNotice({
  message,
  noticeRef,
  className,
}: {
  message: string;
  noticeRef: Ref<HTMLDivElement>;
  className?: string;
}) {
  return (
    <div
      ref={noticeRef}
      role="status"
      tabIndex={-1}
      className={cn(
        'flex items-start gap-2.5 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#4f6847] outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]',
        className,
      )}
    >
      <CheckCheck aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
      {message}
    </div>
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
      <p id={hintId} className="mt-2 text-[11px] leading-relaxed text-[#59675c]">
        Use the full link your club shared, or just the part after /book/.
      </p>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-xs font-medium text-[#8b4d3c]">
          {error}
        </p>
      )}
    </form>
  );
}

function CompactBooking({ item, nowMs, canBookAgain = false }: { item: AccountBooking; nowMs: number; canBookAgain?: boolean }) {
  const state = bookingState(item, nowMs);
  return (
    <article className="flex items-start gap-3 rounded-xl border border-[#e8ece5] bg-white p-4">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf2e7] text-[#4f6847]">
        <CalendarDays size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-[#294536]">{item.booking.serviceName}</h3>
            <p className="mt-1 text-xs text-[#59675c]">{item.business.name}</p>
          </div>
          <span className={cn('rounded-full px-2 py-1 text-[9px] font-medium', statusClass(state))}>
            {state}
          </span>
        </div>
        <p className="mt-3 text-xs text-[#637363]">
          {shortDate(item.booking.startAt, item.business.timezone)} ·{' '}
          {time(item.booking.startAt, item.business.timezone)} · {item.booking.instructorName}
        </p>
        {canBookAgain && state === 'Completed' && canRebook(item) && (
          <Link
            href={rebookHref(item.business.slug, item.booking)}
            className="mt-2 inline-flex min-h-10 items-center gap-1.5 text-xs font-semibold text-[#174c3c] underline-offset-2 hover:underline"
            aria-label={`Book ${item.booking.serviceName} at ${item.business.name} again`}
          >
            <RefreshCw size={13} aria-hidden="true" /> Book again
          </Link>
        )}
      </div>
    </article>
  );
}

/**
 * A booking as a single readable line.
 *
 * The home screen used to render every detail of every session inline, which
 * made a handful of bookings scroll for pages and buried the one thing a
 * person usually wants: when and where. The row carries only the headline —
 * lesson, club, time, status — and anything asking for a decision. Everything
 * else lives one tap away in the detail dialog.
 */
function canRebook(item: AccountBooking) {
  // Retained direct-route history belongs to retired solo practices.
  return item.paymentRoute !== 'DIRECT' && item.booking.paymentRoute !== 'DIRECT' && !!item.business.slug;
}

function BookingRow({
  item,
  nowMs,
  onOpen,
  canBookAgain = false,
}: {
  item: AccountBooking;
  nowMs: number;
  onOpen: (item: AccountBooking) => void;
  canBookAgain?: boolean;
}) {
  const state = bookingState(item, nowMs);
  const incoming = incomingRequest(item);
  const outgoing = outgoingRequest(item);
  return (
    <article
      id={`student-booking-${item.booking.id}`}
      tabIndex={-1}
      className={cn(panel, 'scroll-mt-24 outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]')}
    >
      <button
        type="button"
        onClick={() => onOpen(item)}
        aria-label={`Open details for ${item.booking.serviceName} at ${item.business.name}`}
        className="flex w-full items-center gap-3.5 rounded-2xl p-4 text-left transition hover:bg-[#fafbf7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] sm:p-5"
      >
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#eaf0e2] text-[#4f6847]">
          <CircleDot size={20} strokeWidth={1.6} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[15px] font-semibold tracking-tight text-[#263e33]">
              {item.booking.serviceName}
            </span>
            <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-medium', statusClass(state))}>
              {state}
            </span>
          </span>
          <span className="mt-1.5 block text-xs text-[#59675c]">
            {shortDate(item.booking.startAt, item.business.timezone)} ·{' '}
            {time(item.booking.startAt, item.business.timezone)} · {item.business.name}
          </span>
          {(incoming || outgoing) && (
            <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[#f6ead2] px-2.5 py-1 text-[10px] font-semibold text-[#70582e]">
              <CalendarClock size={11} />
              {incoming ? 'New time proposed · your reply needed' : 'Waiting on your coach'}
            </span>
          )}
        </span>
        <ChevronRight size={17} className="shrink-0 text-[#59675c]" aria-hidden="true" />
      </button>
      {canBookAgain && state === 'Completed' && canRebook(item) && (
        <div className="flex justify-end border-t border-[#f0f2ed] px-4 py-2 sm:px-5">
          <Link
            href={rebookHref(item.business.slug, item.booking)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-[#174c3c] hover:bg-[#f3f6f1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]"
            aria-label={`Book ${item.booking.serviceName} at ${item.business.name} again`}
          >
            <RefreshCw size={13} aria-hidden="true" /> Book again
          </Link>
        </div>
      )}
    </article>
  );
}

type BookingDialogProps = {
  item: AccountBooking | null;
  onClose: () => void;
  notice: string;
  noticeRef: Ref<HTMLDivElement>;
  mode: BookingDialogMode;
  setMode: (mode: BookingDialogMode) => void;
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
  performCancel: () => void;
  performRescheduleRequest: () => void;
  respondToRequest: (accept: boolean) => void;
  payForBooking: () => void;
  paymentMode: PaymentUiMode;
  stripeTestMode: boolean;
  paymentUnavailableReason: string;
  canRetryPayments: boolean;
  retryPaymentCapabilities: () => void;
  paymentOutcome: 'SUCCEEDED' | 'FAILED';
  setPaymentOutcome: (value: 'SUCCEEDED' | 'FAILED') => void;
  retrySlots: () => void;
  nowMs: number;
  canUseCommerce: boolean;
  canUseChat: boolean;
  onOpenChat: (bookingId: string) => void;
};

/**
 * Everything about one booking, on demand.
 *
 * Cancelling and proposing a new time both happen here, as steps inside the
 * same dialog, so the details stay one tap away rather than one navigation
 * away and the person never loses their place in the list.
 */
function BookingDialog({
  item,
  onClose,
  notice,
  noticeRef,
  mode,
  setMode,
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
  performCancel,
  performRescheduleRequest,
  respondToRequest,
  payForBooking,
  paymentMode,
  stripeTestMode,
  paymentUnavailableReason,
  canRetryPayments,
  retryPaymentCapabilities,
  paymentOutcome,
  setPaymentOutcome,
  retrySlots,
  nowMs,
  canUseCommerce,
  canUseChat,
  onOpenChat,
}: BookingDialogProps) {
  if (!item) return null;
  const state = bookingState(item, nowMs);
  const canCancel = canChangeBooking(item, 'cancel', nowMs);
  const canReschedule = canChangeBooking(item, 'reschedule', nowMs);
  const incoming = incomingRequest(item);
  const outgoing = outgoingRequest(item);
  const incomingClosed = !!incoming && rescheduleAcceptanceClosed(item, nowMs);
  const originalLessonEnded = new Date(item.booking.endAt).getTime() <= nowMs;
  const availableSlots = slots.filter(
    (candidate) => candidate.available && candidate.startAt !== item.booking.startAt,
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent
        className="max-w-lg"
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
      >
        <DialogTitle className="text-xl font-semibold tracking-tight text-[#20382d]">
          {item.booking.serviceName}
        </DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">
          With {item.booking.instructorName} at {item.business.name}
        </DialogDescription>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2.5 py-1 text-[10px] font-medium', statusClass(state))}>
            {state}
          </span>
          {canUseCommerce && <Link
              href={`/book/${encodeURIComponent(item.business.slug)}`}
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#5d7a52]"
            >
              Club booking page <ExternalLink size={11} />
            </Link>}
          {canUseChat && item.paymentRoute !== 'DIRECT' && !item.participant.cancelled && !item.participant.cancelledAt && (
            <button
              type="button"
              onClick={() => onOpenChat(item.booking.id)}
              disabled={busy}
              className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-[#dce3da] bg-white px-3 text-xs font-semibold text-[#344d40] transition hover:bg-[#f3f6f1] disabled:opacity-50"
            >
              <MessageCircle size={14} aria-hidden="true" /> Message
            </button>
          )}
        </div>

        {notice && (
          <SuccessNotice message={notice} noticeRef={noticeRef} className="mt-5" />
        )}

        {mode === 'details' && (
          <>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <Detail icon={<CalendarDays size={18} />} label="When">
                {shortDate(item.booking.startAt, item.business.timezone)}
                <p className="text-xs text-[#59675c]">
                  {time(item.booking.startAt, item.business.timezone)} –{' '}
                  {time(item.booking.endAt, item.business.timezone)}
                </p>
              </Detail>
              <Detail icon={<LocationIcon location={item.location} />} label="Where">
                {item.booking.locationName}
                {(item.booking.address || item.location?.address) && (
                  <p className="text-xs text-[#59675c]">
                    {item.booking.address || item.location?.address}
                  </p>
                )}
              </Detail>
              <Detail icon={<ShieldCheck size={18} />} label="Session price">
                {money(item.participant.price ?? item.booking.price, item.business.currency)}
                <p className="text-xs text-[#59675c]">
                  {item.participant.paid
                    ? item.paymentRoute === 'CLUB'
                      ? `Recorded as paid for ${item.business.name}`
                      : 'Recorded as paid under the historical coach route'
                    : item.paymentRoute === 'CLUB'
                      ? `Payment options are associated with ${item.business.name}`
                      : 'Historical payment route'}
                </p>
              </Detail>
              <Detail icon={<UserRound size={18} />} label="Booked for">
                {item.participant.name}
              </Detail>
            </div>

            {state === 'Awaiting coach' && (
              <div className="mt-5 flex gap-2.5 rounded-xl border border-[#eee5ce] bg-[#fcf8ec] p-4 text-xs leading-relaxed text-[#70582e]">
                <Info size={16} className="mt-0.5 shrink-0" />
                {item.business.name} booked this lesson for you. Your coach is confirming it — nothing
                is needed from you.
              </div>
            )}
            {state === 'Awaiting confirmation' && (
              <div className="mt-5 flex gap-2.5 rounded-xl border border-[#eee5ce] bg-[#fcf8ec] p-4 text-xs leading-relaxed text-[#70582e]">
                <Info size={16} className="mt-0.5 shrink-0" />
                Your coach will confirm this request and any venue arrangements.
              </div>
            )}

            {incoming && (
              <section
                aria-label="Proposed new time"
                className="mt-5 rounded-xl border border-[#e7dcc1] bg-[#fcf8ee] p-4"
              >
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[#6f5f36]">
                  <CalendarClock size={15} />
                  {incomingClosed ? 'Reschedule request needs closing' : 'A new time was proposed'}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-[#70582e]">
                  {item.business.name} asked to move this session to{' '}
                  <strong className="font-semibold">
                    {shortDate(incoming.proposedStartAt, item.business.timezone)} at{' '}
                    {time(incoming.proposedStartAt, item.business.timezone)}
                  </strong>
                  .
                </p>
                {incomingClosed && (
                  <p className="mt-2 text-xs leading-relaxed text-[#70582e]">
                    {originalLessonEnded ? 'The original lesson has ended' : 'The lesson is closed'}, so
                    this proposal can no longer be accepted. Keep the original time to close it.
                  </p>
                )}
                {incoming.message && (
                  <p className="mt-2 border-l-2 border-[#e0d3b4] pl-3 text-xs italic text-[#70582e]">
                    “{incoming.message}”
                  </p>
                )}
                {actionError && <div className="mt-4"><ErrorNotice message={actionError} conflicts={conflicts} /></div>}
                <div className="mt-4 flex flex-wrap gap-2.5">
                  {!incomingClosed && (
                    <button type="button" className={primaryButton} disabled={busy} onClick={() => respondToRequest(true)}>
                      {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}
                      Accept new time
                    </button>
                  )}
                  <button type="button" className={secondaryButton} disabled={busy} onClick={() => respondToRequest(false)}>
                    <X size={15} /> Keep original time
                  </button>
                </div>
              </section>
            )}

            {outgoing && (
              <section
                aria-label="Your reschedule request"
                className="mt-5 rounded-xl border border-[#dfe5dc] bg-[#f8faf6] p-4"
              >
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[#4a6050]">
                  <Clock3 size={15} /> Waiting on your coach
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-[#59675c]">
                  You asked to move this session to{' '}
                  <strong className="font-semibold">
                    {shortDate(outgoing.proposedStartAt, item.business.timezone)} at{' '}
                    {time(outgoing.proposedStartAt, item.business.timezone)}
                  </strong>
                  . It keeps its current time until your coach accepts.
                </p>
                {actionError && <div className="mt-4"><ErrorNotice message={actionError} conflicts={conflicts} /></div>}
                <button
                  type="button"
                  className={cn(secondaryButton, 'mt-4')}
                  disabled={busy}
                  onClick={() => respondToRequest(false)}
                >
                  {busy ? <LoaderCircle size={15} className="animate-spin" /> : <X size={15} />}
                  Withdraw request
                </button>
              </section>
            )}

            {actionError && !incoming && !outgoing && (
              <div className="mt-5"><ErrorNotice message={actionError} conflicts={conflicts} /></div>
            )}

            {!item.participant.paid && !item.participant.packageId && !bookingCancelled(item) && (
              <section aria-label="Pay for this class" className="mt-5 rounded-xl border border-[#dfe7d8] bg-[#f5f8f1] p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-[#3d5a41]">
                  <WalletCards size={16} /> Pay online
                </h3>
                {paymentMode === 'simulated' ? (
                  <>
                    <p className="mt-2 text-xs leading-relaxed text-[#59675c]">
                      Development/demo checkout only — this simulates Stripe and does not charge a real card.
                    </p>
                    <label htmlFor={`booking-payment-outcome-${item.participant.id}`} className="mt-4 block text-xs font-semibold text-[#465e4c]">
                      Simulated payment result
                    </label>
                    <select
                      id={`booking-payment-outcome-${item.participant.id}`}
                      className={cn(field, 'mt-2 w-full bg-white')}
                      value={paymentOutcome}
                      disabled={busy}
                      onChange={(event) => setPaymentOutcome(event.target.value as 'SUCCEEDED' | 'FAILED')}
                    >
                      <option value="SUCCEEDED">Simulate success</option>
                      <option value="FAILED">Simulate declined card</option>
                    </select>
                  </>
                ) : (
                  <p className="mt-2 text-xs leading-relaxed text-[#59675c]">
                    {paymentMode === 'live'
                      ? stripeTestMode
                        ? 'Stripe test checkout is enabled. Use test payment details; no real card will be charged.'
                        : `Continue to Stripe for the displayed checkout amount associated with ${item.business.name}. Courtly does not add tax or other charges to that amount.`
                      : paymentMode === 'loading' ? 'Checking secure payment availability…' : paymentUnavailableReason}
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className={primaryButton} disabled={busy || paymentMode === 'loading' || paymentMode === 'disabled'} onClick={payForBooking}>
                    {busy || paymentMode === 'loading' ? <LoaderCircle size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                    {paymentMode === 'simulated'
                      ? `Simulate ${money(item.participant.price ?? item.booking.price, item.business.currency)} payment`
                      : 'Continue to secure payment'}
                  </button>
                  {paymentMode === 'disabled' && canRetryPayments && (
                    <button type="button" className={secondaryButton} disabled={busy} onClick={retryPaymentCapabilities}>
                      <RefreshCw size={14} /> Check again
                    </button>
                  )}
                </div>
              </section>
            )}

            {(canCancel || canReschedule) && (
              <div className="mt-6 flex flex-wrap gap-3 border-t border-[#edf0e8] pt-5">
                {canReschedule && (
                  <button type="button" className={secondaryButton} onClick={() => setMode('reschedule')}>
                    <CalendarDays size={15} /> Ask for a new time
                  </button>
                )}
                {canCancel && (
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#edddd7] px-4 py-2.5 text-sm font-medium text-[#8b4d3c] transition hover:bg-[#fff7f3]"
                    onClick={() => setMode('cancel')}
                  >
                    <X size={15} /> Cancel booking
                  </button>
                )}
              </div>
            )}
            {!canCancel && !canReschedule && !incoming && !outgoing && state !== 'Cancelled' && state !== 'Completed' && (
              <p className="mt-6 border-t border-[#edf0e8] pt-5 text-[11px] leading-relaxed text-[#59675c]">
                Changes close {rescheduleNoticeHours(item)} hours before the session. Contact your coach
                if something has come up.
              </p>
            )}
            {canUseCommerce && canRebook(item) && (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e4e9df] bg-[#f8faf6] p-4">
                <p className="text-xs leading-relaxed text-[#59675c]">
                  Same Class, coach and venue — choose a new time on the club’s page.
                </p>
                <Link
                  href={rebookHref(item.business.slug, item.booking)}
                  className={state === 'Completed' || state === 'Cancelled' ? primaryButton : secondaryButton}
                >
                  <RefreshCw size={14} aria-hidden="true" /> Book again
                </Link>
              </div>
            )}
          </>
        )}

        {mode === 'cancel' && (
          <div className="mt-5 rounded-xl border border-[#e7d4ca] bg-[#fffcf9] p-5">
            <h3 className="text-base font-semibold text-[#3d493f]">Cancel this session?</h3>
            <p className="mt-2 text-xs leading-relaxed text-[#70582e]">
              Your place on {shortDate(item.booking.startAt, item.business.timezone)} at{' '}
              {time(item.booking.startAt, item.business.timezone)} will be released.
            </p>
            {actionError && <div className="mt-4"><ErrorNotice message={actionError} conflicts={conflicts} /></div>}
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className={secondaryButton} disabled={busy} onClick={() => setMode('details')}>
                Keep booking
              </button>
              <button
                type="button"
                disabled={busy || !canCancel}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#8b4d3c] px-5 py-3 text-sm font-semibold text-white hover:bg-[#743e31] disabled:opacity-50"
                onClick={performCancel}
              >
                {busy ? <LoaderCircle size={15} className="animate-spin" /> : <X size={15} />}
                Yes, cancel session
              </button>
            </div>
          </div>
        )}

        {mode === 'reschedule' && (
          <div className="mt-5">
            <h3 className="text-base font-semibold text-[#3d493f]">Ask for a new time</h3>
            <p className="mt-1 text-xs leading-relaxed text-[#59675c]">
              Same lesson, coach, and place. Your coach confirms the change before the session moves.
            </p>
            <label htmlFor={`reschedule-date-${item.participant.id}`} className="mt-5 block text-xs font-semibold">
              Choose a date
            </label>
            <input
              id={`reschedule-date-${item.participant.id}`}
              type="date"
              value={date}
              min={dateKey(new Date(), item.business.timezone)}
              onChange={(event) => {
                setDate(event.target.value);
                setSelectedSlot(null);
              }}
              className={cn(field, 'mt-2 max-w-xs')}
            />
            <div className="mt-5 border-t border-[#edf0e8] pt-5" aria-busy={slotsLoading}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-[#344b3a]">Available start times</h4>
                <span className="inline-flex items-center gap-1 text-[10px] text-[#59675c]">
                  <Clock3 size={12} /> {item.business.timezone.replaceAll('_', ' ')}
                </span>
              </div>
              <p role="status" aria-live="polite" className="sr-only">{slotsLoading ? 'Checking availability.' : slotsError ? 'Available times could not be loaded.' : availableSlots.length === 1 ? '1 available time loaded.' : availableSlots.length + ' available times loaded.'}</p>
              {slotsLoading ? (
                <div role="status" className="flex min-h-24 items-center justify-center gap-2 text-xs text-[#59675c]">
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
                <div role="radiogroup" aria-label="Available start times" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {availableSlots.map((candidate) => (
                    <button
                      key={candidate.startAt}
                      type="button"
                      role="radio"
                      aria-checked={selectedSlot?.startAt === candidate.startAt}
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
                <p className="rounded-xl border border-dashed border-[#dfe5dc] bg-[#fafbf8] px-4 py-7 text-center text-xs text-[#59675c]">
                  No other times are available on this date.
                </p>
              )}
            </div>
            {actionError && <div className="mt-5"><ErrorNotice message={actionError} conflicts={conflicts} /></div>}
            <div className="mt-5 flex flex-wrap gap-3">
              <button type="button" className={secondaryButton} disabled={busy} onClick={() => setMode('details')}>
                Keep original time
              </button>
              <button
                type="button"
                className={primaryButton}
                disabled={!selectedSlot || busy || slotsLoading || !canReschedule}
                onClick={performRescheduleRequest}
              >
                {busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}
                Send request
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One alert, opened.
 *
 * The list stays scannable by showing a line each; the full message and the
 * way through to whatever the alert is about live here. "Go to this booking"
 * is the point of the dialog — an alert that cannot take you to the thing it
 * describes leaves the reader to go hunting.
 */
type AlertDestination = {
  label: string;
  run: () => void;
};

function AlertDialog({
  alert,
  club,
  onClose,
  onOpenBooking,
  destinations = [],
  showBookingLink = true,
}: {
  alert: StudentNotification | null;
  club?: KnownClub;
  onClose: () => void;
  onOpenBooking: (bookingId: string) => void;
  /** Where a typed alert leads (progress, waitlist, packages), most useful first. */
  destinations?: AlertDestination[];
  showBookingLink?: boolean;
}) {
  if (!alert) return null;
  const appearance = alertAppearance(alert);
  const Icon = appearance.icon;
  const timezone = club?.business.timezone;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <div className="flex items-start gap-3.5">
          <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-2xl', appearance.tone)}>
            <Icon size={20} strokeWidth={1.7} />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg font-semibold tracking-tight text-[#20382d]">
              {alert.title}
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-[11px] text-[#59675c]">
              {appearance.label}
              {alert.createdAt && (
                <> · {shortDate(alert.createdAt, timezone)} at {time(alert.createdAt, timezone)}</>
              )}
            </DialogDescription>
          </div>
        </div>
        <p className="mt-5 text-sm leading-relaxed text-[#4c5c4d]">{alert.message}</p>
        {alert.actionNeeded && (
          <p className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[#f6ebd5] px-3 py-1 text-[10px] font-semibold text-[#70582e]">
            <Info size={11} /> This one needs you
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-2.5 border-t border-[#edf0e8] pt-5">
          {destinations.map((destination, index) => (
            <button
              key={destination.label}
              type="button"
              className={index === 0 ? primaryButton : secondaryButton}
              onClick={destination.run}
            >
              {destination.label} <ArrowRight size={15} aria-hidden="true" />
            </button>
          ))}
          {alert.bookingId && showBookingLink && (
            <button
              type="button"
              className={destinations.length ? secondaryButton : primaryButton}
              onClick={() => onOpenBooking(alert.bookingId!)}
            >
              Go to this booking <ArrowRight size={15} />
            </button>
          )}
          {club && (
            <Link href={`/book/${encodeURIComponent(club.business.slug)}`} className={secondaryButton}>
              {club.business.name} <ExternalLink size={13} />
            </Link>
          )}
          <button type="button" className={secondaryButton} onClick={onClose}>
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PackageOffersDialog({
  club, offers, loading, error, notice, busyId, paymentMode, stripeTestMode, paymentUnavailableReason, paymentOutcome,
  onPaymentOutcome, onBuy, canRetryPayments, onRetryPaymentCapabilities, onClose,
}: {
  club: { business: PackageOfferBusiness } | null; offers: PackageOffer[]; loading: boolean; error: string; notice: string; busyId: string | null;
  paymentMode: PaymentUiMode; stripeTestMode: boolean; paymentUnavailableReason: string;
  paymentOutcome: 'SUCCEEDED' | 'FAILED'; onPaymentOutcome: (value: 'SUCCEEDED' | 'FAILED') => void;
  onBuy: (offer: PackageOffer) => void; canRetryPayments: boolean; onRetryPaymentCapabilities: () => void; onClose: () => void;
}) {
  if (!club) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busyId) onClose(); }}>
      <DialogContent className="max-w-2xl" onEscapeKeyDown={(event) => { if (busyId) event.preventDefault(); }}>
        <DialogTitle className="text-xl font-semibold tracking-tight text-[#20382d]">
          Packages from {club.business.name}
        </DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">
          {paymentMode === 'live'
            ? stripeTestMode
              ? 'Stripe test checkout is enabled. Use test payment details; no real card will be charged.'
              : 'Buy credits for eligible classes and venue rentals through secure Stripe checkout.'
            : paymentMode === 'simulated'
              ? 'Buy credits for eligible classes and venue rentals. Development/demo checkout is simulated and no real card is charged.'
              : paymentMode === 'loading' ? 'Checking secure payment availability…' : paymentUnavailableReason}
        </DialogDescription>
        {notice && <div role="status" className="mt-5 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#4f6847]">{notice}</div>}
        {error && <div className="mt-5"><ErrorNotice message={error} /></div>}
        {loading ? (
          <div role="status" className="flex min-h-32 items-center justify-center gap-2 text-sm text-[#59675c]">
            <LoaderCircle size={17} className="animate-spin" /> Loading package offers…
          </div>
        ) : offers.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-[#dfe5dc] p-6 text-center text-sm text-[#59675c]">
            This club has no package offers right now.
          </p>
        ) : (
          <>
            {paymentMode === 'simulated' && (
              <>
                <label htmlFor="package-checkout-outcome" className="mt-5 block text-xs font-semibold text-[#465e4c]">Simulated payment result</label>
                <select id="package-checkout-outcome" className={cn(field, 'mt-2 w-full bg-white')} value={paymentOutcome} disabled={!!busyId} onChange={(event) => onPaymentOutcome(event.target.value as 'SUCCEEDED' | 'FAILED')}>
                  <option value="SUCCEEDED">Simulate success</option>
                  <option value="FAILED">Simulate declined card</option>
                </select>
              </>
            )}
            {paymentMode === 'disabled' && canRetryPayments && (
              <button type="button" className={cn(secondaryButton, 'mt-4')} onClick={onRetryPaymentCapabilities}>
                <RefreshCw size={14} /> Check payment availability again
              </button>
            )}
            <div className="mt-5 max-h-[55vh] space-y-3 overflow-y-auto pr-1">
              {offers.map((offer) => (
                <article key={offer.id} className="rounded-xl border border-[#e4e9df] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-[#304b39]">{offer.name}</h3>
                      {offer.description && <p className="mt-1 text-xs leading-relaxed text-[#59675c]">{offer.description}</p>}
                    </div>
                    <p className="text-base font-semibold text-[#34533e]">{money(offer.price, club.business.currency)}</p>
                  </div>
                  <p className="mt-3 text-xs text-[#59675c]">{offer.totalCredits} credits · valid for {offer.validityDays} days</p>
                  <p className="mt-2 text-[11px] leading-relaxed text-[#59675c]">
                    Eligible for {[...offer.services.map((service) => service.name), ...offer.rentalLocations.map((location) => location.name)].join(', ')}
                  </p>
                  <button type="button" className={cn(primaryButton, 'mt-4 w-full')} disabled={!!busyId || paymentMode === 'loading' || paymentMode === 'disabled'} onClick={() => onBuy(offer)}>
                    {busyId === offer.id || paymentMode === 'loading' ? <LoaderCircle size={15} className="animate-spin" /> : <WalletCards size={15} />}
                    {paymentMode === 'simulated' ? 'Buy with simulated Stripe' : 'Continue to secure payment'}
                  </button>
                </article>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RentalDialog({
  open, rental, loading, error, notice, date, duration, unitId, slots, slotsLoading, selectedSlot, packages, selectedPackageId,
  paymentOutcome, busy, onClose, onDate, onDuration, onUnit, onSlot, onPackage, onPaymentOutcome, onReserve,
}: {
  open: boolean; rental: RentalDetail | null; loading: boolean; error: string; notice: string; date: string; duration: number; unitId: string;
  slots: RentalSlot[]; slotsLoading: boolean; selectedSlot: RentalSlot | null; packages: AccountPackage[]; selectedPackageId: string;
  paymentOutcome: 'SUCCEEDED' | 'FAILED'; busy: boolean; onClose: () => void; onDate: (value: string) => void;
  onDuration: (value: number) => void; onUnit: (value: string) => void; onSlot: (value: RentalSlot | null) => void;
  onPackage: (value: string) => void; onPaymentOutcome: (value: 'SUCCEEDED' | 'FAILED') => void; onReserve: () => void;
}) {
  if (!open) return null;
  const durations = rental ? Array.from(
    { length: Math.floor((rental.maxDuration - rental.minDuration) / Math.max(1, rental.durationIncrement || rental.startInterval)) + 1 },
    (_, index) => rental.minDuration + index * Math.max(1, rental.durationIncrement || rental.startInterval),
  ) : [];
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-w-2xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
        <DialogTitle className="text-xl font-semibold tracking-tight text-[#20382d]">{rental?.name ?? 'Venue rental'}</DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">
          {rental ? `${rental.address} · ${rental.sport}` : 'Loading rental details…'}
        </DialogDescription>
        {notice && <div role="status" className="mt-5 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#4f6847]">{notice}</div>}
        {error && !rental && <div className="mt-5"><ErrorNotice message={error} /></div>}
        {loading ? <LoadingScreen text="Loading venue details…" /> : rental && (
          <div className="mt-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="rental-date" className="text-xs font-semibold text-[#465e4c]">Date</label>
                <input id="rental-date" type="date" min={dateKey(new Date(), rental.timezone)} max={addCalendarDays(dateKey(new Date(), rental.timezone), rental.advanceDays)} value={date} onChange={(event) => onDate(event.target.value)} className={cn(field, 'mt-2 w-full')} />
              </div>
              <div>
                <label htmlFor="rental-duration" className="text-xs font-semibold text-[#465e4c]">Duration</label>
                <select id="rental-duration" value={duration} onChange={(event) => onDuration(Number(event.target.value))} className={cn(field, 'mt-2 w-full bg-white')}>
                  {durations.map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="rental-unit" className="text-xs font-semibold text-[#465e4c]">{rental.unitLabel || 'Court'}</label>
                <select id="rental-unit" value={unitId} onChange={(event) => onUnit(event.target.value)} className={cn(field, 'mt-2 w-full bg-white')}>
                  {rental.units.filter((unit) => unit.active !== false).map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                </select>
              </div>
            </div>
            <section aria-labelledby="rental-times-heading" aria-busy={slotsLoading} className="mt-5 border-t border-[#edf0e8] pt-5">
              <h3 id="rental-times-heading" className="text-sm font-semibold text-[#344b3a]">Available start times</h3>
              <p role="status" aria-live="polite" className="sr-only">{slotsLoading ? 'Checking availability.' : slots.length === 1 ? '1 available time loaded.' : slots.length + ' available times loaded.'}</p>
              {slotsLoading ? (
                <p role="status" className="mt-4 flex items-center gap-2 text-xs text-[#59675c]"><LoaderCircle size={15} className="animate-spin" /> Checking availability…</p>
              ) : slots.length ? (
                <div role="radiogroup" aria-labelledby="rental-times-heading" className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {slots.map((slot) => <button key={`${slot.unitId}-${slot.startAt}`} type="button" role="radio" aria-checked={selectedSlot?.unitId === slot.unitId && selectedSlot.startAt === slot.startAt} onClick={() => onSlot(slot)} className={cn('min-h-12 rounded-xl border px-3 py-2 text-sm font-medium', selectedSlot?.unitId === slot.unitId && selectedSlot.startAt === slot.startAt ? 'border-[#174c3c] bg-[#174c3c] text-white' : 'border-[#dfe5dc] bg-white text-[#49604f]')}>{time(slot.startAt, rental.timezone)}</button>)}
                </div>
              ) : <p className="mt-3 rounded-xl border border-dashed border-[#dfe5dc] p-5 text-center text-xs text-[#59675c]">No available times for this date and duration.</p>}
            </section>
            {selectedSlot && (
              <section aria-label="Rental checkout" className="mt-5 rounded-xl border border-[#dfe7d8] bg-[#f5f8f1] p-4">
                <p className="text-sm font-semibold text-[#304b39]">{selectedSlot.unitName} · {time(selectedSlot.startAt, rental.timezone)} · {selectedSlot.price === 0 ? 'Free' : money(selectedSlot.price, rental.currency)}</p>
                {selectedSlot.price > 0 && packages.length > 0 && (
                  <>
                    <label htmlFor="rental-package" className="mt-4 block text-xs font-semibold text-[#465e4c]">Payment option</label>
                    <select id="rental-package" value={selectedPackageId} onChange={(event) => onPackage(event.target.value)} className={cn(field, 'mt-2 w-full bg-white')}>
                      <option value="">Simulated rental checkout</option>
                      {packages.map((pkg) => <option key={pkg.id} value={pkg.id}>Use {pkg.name} ({pkg.remainingCredits} credits left)</option>)}
                    </select>
                  </>
                )}
                {selectedSlot.price > 0 && !selectedPackageId && (
                  <>
                    <p className="mt-3 text-xs leading-relaxed text-[#59675c]"><strong>Simulated rental checkout:</strong> venue rentals do not use live Stripe yet, so no real card is charged.</p>
                    <label htmlFor="rental-payment-outcome" className="mt-3 block text-xs font-semibold text-[#465e4c]">Simulated payment result</label>
                    <select id="rental-payment-outcome" value={paymentOutcome} onChange={(event) => onPaymentOutcome(event.target.value as 'SUCCEEDED' | 'FAILED')} className={cn(field, 'mt-2 w-full bg-white')}><option value="SUCCEEDED">Simulate success</option><option value="FAILED">Simulate declined card</option></select>
                  </>
                )}
                {error && <div className="mt-4"><ErrorNotice message={error} /></div>}
                <button type="button" className={cn(primaryButton, 'mt-4 w-full')} disabled={busy} onClick={onReserve}>
                  {busy ? <LoaderCircle size={15} className="animate-spin" /> : <TicketCheck size={15} />}
                  {selectedSlot.price === 0 ? 'Reserve for free' : selectedPackageId ? 'Reserve with package credit' : 'Reserve with simulated Stripe'}
                </button>
              </section>
            )}
            {error && !selectedSlot && <div className="mt-5"><ErrorNotice message={error} /></div>}
            {rental.rules && <p className="mt-5 text-xs leading-relaxed text-[#59675c]"><strong className="font-semibold text-[#415244]">Venue rules:</strong> {rental.rules}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ClubAvatar({ club, size = 'large' }: { club: { business: PublicBookingBusiness }; size?: 'small' | 'large' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full border-[3px] border-white bg-[#dfe9d5] font-bold text-[#4f6847] shadow-[0_0_0_1px_#d8e1d2]',
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
  alertsUnread,
  onOpenAlerts,
  wide,
  playerSwitcher,
}: {
  userName: string;
  activeTab: StudentTab;
  homeHref: string;
  onOpenProfile: () => void;
  alertsUnread: number;
  onOpenAlerts: () => void;
  wide: boolean;
  playerSwitcher?: ReactNode;
}) {
  const title = tabTitles[activeTab];
  const alertsActive = activeTab === 'alerts';
  return (
    <header className="student-header sticky top-0 z-40 border-b border-[#e7ebe4] bg-white/90 backdrop-blur-xl">
      <div className={cn('mx-auto flex min-h-16 items-center justify-between gap-4 px-4 sm:min-h-[72px] sm:px-6', wide ? 'max-w-5xl' : 'max-w-3xl')}>
        <Link href={homeHref} aria-label="Courtly student home" className="inline-flex min-h-11 shrink-0 items-center">
          <CourtlyLogo />
        </Link>
        <div className="flex min-w-0 items-center gap-2">
          {playerSwitcher}
          <span className={cn('hidden text-[11px] font-medium text-[#59675c]', playerSwitcher ? 'lg:inline' : 'sm:inline')}>{title}</span>
          <button
            data-tour="student-alerts"
            type="button"
            aria-label={alertsButtonLabel(alertsUnread)}
            aria-current={alertsActive ? 'page' : undefined}
            onClick={onOpenAlerts}
            className={cn(
              'relative grid h-11 w-11 shrink-0 place-items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2',
              alertsActive ? 'bg-[#e8efe0] text-[#174c3c]' : 'text-[#48604f] hover:bg-[#f0f4ec]',
            )}
          >
            <Bell size={21} strokeWidth={alertsActive ? 2.2 : 1.8} aria-hidden="true" />
            {alertsUnread > 0 && (
              <span
                aria-hidden="true"
                className="absolute right-0.5 top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-white bg-[#b3483a] px-1 text-[10px] font-bold leading-none text-white"
              >
                {chatBadge(alertsUnread)}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label="Open profile"
            aria-current={activeTab === 'profile' ? 'page' : undefined}
            title={`Signed in as ${userName}`}
            onClick={onOpenProfile}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[#dfe6da] bg-[#edf2e7] text-[10px] font-bold text-[#4f6847] transition hover:border-[#b8c8b1] hover:bg-[#e5eddd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2"
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
  activeTab: StudentTab;
  onChange: (tab: StudentTab) => void;
  unread: number;
}) {
  return (
    <nav
      data-tour="student-navigation"
      aria-label="Student navigation"
      className="student-bottom-nav fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-3xl border-x border-t border-[#dfe5dc] bg-white/95 pb-[max(0.35rem,env(safe-area-inset-bottom))] shadow-[0_-12px_35px_rgba(25,55,40,0.08)] backdrop-blur-xl sm:bottom-4 sm:rounded-2xl sm:border sm:px-2 sm:pb-1"
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
              aria-label={tab.id === 'chat' ? chatTabLabel(unread) : tab.label}
              onClick={() => onChange(tab.id)}
              className={cn(
                'relative flex min-h-[62px] min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition sm:text-xs',
                active ? 'text-[#174c3c]' : 'text-[#59675c] hover:bg-[#f6f8f3] hover:text-[#496353]',
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
                  {tab.id === 'chat' && unread > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute right-0 top-0 grid h-4 min-w-4 place-items-center rounded-full border-2 border-white bg-[#b3483a] px-0.5 text-[8px] leading-none text-white"
                    >
                      {chatBadge(unread)}
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

export function StudentApp({ slug }: { slug?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab = studentTab(requestedTab);
  const chatThreadId = activeTab === 'chat' ? searchParams.get('thread') : null;
  const requestedPlayer = searchParams.get('player');
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [bookings, setBookings] = useState<AccountBooking[]>([]);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookingsReady, setBookingsReady] = useState(false);
  const [bookingsError, setBookingsError] = useState('');
  const [clubDirectory, setClubDirectory] = useState<StudentClubDirectoryEntry[]>([]);
  const [clubDirectoryLoading, setClubDirectoryLoading] = useState(false);
  const [clubDirectoryError, setClubDirectoryError] = useState('');
  const [clubSearch, setClubSearch] = useState('');
  const [clubSport, setClubSport] = useState('');
  const [clubSlug, setClubSlug] = useState('');
  const [clubRelationship, setClubRelationship] = useState<ClubRelationshipFilter>('all');
  const [exploreSegment, setExploreSegment] = useState<ExploreSegment>('classes');
  const [rentals, setRentals] = useState<RentalListing[]>([]);
  const [rentalsLoading, setRentalsLoading] = useState(false);
  const [rentalsError, setRentalsError] = useState('');
  const [rentalSearch, setRentalSearch] = useState('');
  const [rentalSport, setRentalSport] = useState('');
  const [openRentalId, setOpenRentalId] = useState<string | null>(null);
  const [rentalDetail, setRentalDetail] = useState<RentalDetail | null>(null);
  const [rentalDetailLoading, setRentalDetailLoading] = useState(false);
  const [rentalDate, setRentalDate] = useState(() => dateKey(new Date()));
  const [rentalDuration, setRentalDuration] = useState(60);
  const [rentalUnitId, setRentalUnitId] = useState('');
  const [rentalSlots, setRentalSlots] = useState<RentalSlot[]>([]);
  const [rentalSlotsLoading, setRentalSlotsLoading] = useState(false);
  const [rentalSlotsVersion, setRentalSlotsVersion] = useState(0);
  const [rentalError, setRentalError] = useState('');
  const [selectedRentalSlot, setSelectedRentalSlot] = useState<RentalSlot | null>(null);
  const [selectedRentalPackageId, setSelectedRentalPackageId] = useState('');
  const [rentalPackageFilterId, setRentalPackageFilterId] = useState('');
  const [rentalPaymentOutcome, setRentalPaymentOutcome] = useState<'SUCCEEDED' | 'FAILED'>('SUCCEEDED');
  const [rentalBookingBusy, setRentalBookingBusy] = useState(false);
  const [rentalNotice, setRentalNotice] = useState('');
  const [rentalHistoryVersion, setRentalHistoryVersion] = useState(0);
  const [packages, setPackages] = useState<AccountPackage[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(false);
  const [packagesError, setPackagesError] = useState('');
  const [packagesExpanded, setPackagesExpanded] = useState(false);
  const [offersClub, setOffersClub] = useState<{ business: PackageOfferBusiness } | null>(null);
  const [packageOffers, setPackageOffers] = useState<PackageOffer[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [offersError, setOffersError] = useState('');
  const [offerBusyId, setOfferBusyId] = useState<string | null>(null);
  const [offerNotice, setOfferNotice] = useState('');
  const [offerPaymentOutcome, setOfferPaymentOutcome] = useState<'SUCCEEDED' | 'FAILED'>('SUCCEEDED');
  const [paymentCapabilities, setPaymentCapabilities] = useState<PaymentCapabilities | null>(null);
  const [paymentCapabilitiesLoading, setPaymentCapabilitiesLoading] = useState(false);
  const [paymentCapabilitiesError, setPaymentCapabilitiesError] = useState('');
  const [checkoutReviewState, setCheckoutReviewState] = useState<CheckoutReviewState | null>(null);
  const [liveCheckout, setLiveCheckout] = useState<LiveCheckoutSession | null>(null);
  const [liveCheckoutBusy, setLiveCheckoutBusy] = useState(false);
  const [checkoutReturnStatus, setCheckoutReturnStatus] = useState<{ message: string; error: boolean } | null>(null);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [people, setPeople] = useState<AccountDirectoryUser[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState('');
  const [peopleSearchedFor, setPeopleSearchedFor] = useState('');
  const [notifications, setNotifications] = useState<StudentNotification[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsFallback, setNotificationsFallback] = useState(false);
  const [notificationError, setNotificationError] = useState('');
  const [markingRead, setMarkingRead] = useState(false);
  const [alertsStatus, setAlertsStatus] = useState('');
  const [bookingNavigationStatus, setBookingNavigationStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [openBookingId, setOpenBookingId] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<BookingDialogMode>('details');
  const [openAlertId, setOpenAlertId] = useState<string | null>(null);
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);
  const [showHomeHistory, setShowHomeHistory] = useState(false);
  const [showProfileHistory, setShowProfileHistory] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [bookingPaymentOutcome, setBookingPaymentOutcome] = useState<'SUCCEEDED' | 'FAILED'>('SUCCEEDED');
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
  const [profile, setProfile] = useState({ username: '', name: '', phone: '', parentName: '', sports: [] as string[] });
  const [profileSportsText, setProfileSportsText] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileNotice, setProfileNotice] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [homeView, setHomeView] = useState<HomeView>('list');
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  const [favoritesAvailable, setFavoritesAvailable] = useState(false);
  const [favoriteStatus, setFavoriteStatus] = useState('');
  const [homeProgress, setHomeProgress] = useState<ProgressSummary | null>(null);
  const [homeProgressLoading, setHomeProgressLoading] = useState(false);
  const [waitlistReload, setWaitlistReload] = useState(0);
  const [activityPackage, setActivityPackage] = useState<AccountPackage | null>(null);
  const [familyPlayers, setFamilyPlayers] = useState<FamilyBookingChild[]>([]);
  const [familyPlayersStatus, setFamilyPlayersStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  const [bookingForName, setBookingForName] = useState('');
  const successNoticeRef = useRef<HTMLDivElement>(null);
  const pendingFocusIdRef = useRef<string | null>(null);
  const suppressMainFocusRef = useRef(false);
  const homeProgressRequestRef = useRef(0);
  const mainRef = useRef<HTMLElement>(null);
  const replayTourRef = useRef(false);
  const previousTabRouteRef = useRef(requestedTab);
  const pendingBookingIdRef = useRef<string | null>(null);
  const bookingCheckoutKeysRef = useRef(new Map<string, string>());
  const packageCheckoutKeysRef = useRef(new Map<string, string>());
  const rentalCheckoutKeysRef = useRef(new Map<string, string>());
  const offersRequestRef = useRef(0);
  const checkoutReviewRequestRef = useRef(0);
  const packagesRequestRef = useRef(0);
  const checkoutReturnHandledRef = useRef<string | null>(null);
  const chatOpenedFromListRef = useRef(false);
  const { unreadThreads: chatUnread, beginUnreadRequest, commitUnreadNow } = useChatUnread(isStudentSession(session) && session?.user.capabilities?.chat !== false);
  const canUsePayments = !!session && session.user.capabilities?.payments !== false;
  const canUseCommerce = !!session && session.user.capabilities?.commerce !== false;
  const canUseRentals = !!session && session.user.capabilities?.rentals !== false;
  const canSearchPeople = !!session && session.user.capabilities?.directory !== false;
  const canUseDirectChat = !!session && session.user.capabilities?.chat !== false;
  // Warm Chat while the student is on another tab, so opening it is instant.
  useChatInboxPrefetch('STUDENT', session?.user.username, canUseDirectChat && activeTab !== 'chat');
  const canUseCalendar = !!session && session.user.capabilities?.calendar !== false;
  const canEditProfile = !!session && session.user.capabilities?.profileEdit !== false;
  const canUseFamily = session?.user.capabilities?.familyManagement === true;
  const studentUserId = isStudentSession(session) ? session!.user.id : null;
  // The child view is resolved only against the server's current list of
  // children this adult may view; until that list is known it shows nothing.
  const playersKnown = !!session && (!canUseFamily || familyPlayersStatus === 'ready' || familyPlayersStatus === 'unavailable');
  const playerResolution = resolvePlayer(
    requestedPlayer,
    playersKnown ? (familyPlayersStatus === 'ready' ? familyPlayers : []) : null,
    activeTab,
  );
  const activeChild = playerResolution.status === 'child' ? playerResolution.child : null;
  const childViewActive = playerResolution.status === 'child' || playerResolution.status === 'loading';

  const tabHref = useCallback((tab: StudentTab) => {
    const params = new URLSearchParams();
    if (slug) params.set('slug', slug);
    params.set('tab', tab);
    return `/manage?${params.toString()}`;
  }, [slug]);

  const chatHref = useCallback((threadId: string | null) => {
    const params = new URLSearchParams();
    if (slug) params.set('slug', slug);
    params.set('tab', 'chat');
    if (threadId) params.set('thread', threadId);
    return `/manage?${params.toString()}`;
  }, [slug]);

  const loginHref = useMemo(() => {
    const destination = tabHref(activeTab);
    return `/login?next=${encodeURIComponent(destination)}`;
  }, [activeTab, tabHref]);
  const loginHrefRef = useRef(loginHref);
  loginHrefRef.current = loginHref;

  useEffect(() => {
    if (requestedTab === null || studentTabIds.has(requestedTab as StudentTab)) return;
    router.replace(tabHref('home'), { scroll: false });
  }, [requestedTab, router, tabHref]);

  useEffect(() => {
    if (previousTabRouteRef.current === requestedTab) return;
    previousTabRouteRef.current = requestedTab;
    if (pendingBookingIdRef.current && activeTab === 'home') return;
    pendingBookingIdRef.current = null;
    setBookingNavigationStatus('');
    // A child view's own Schedule/Progress tabs move focus themselves.
    if (suppressMainFocusRef.current) {
      suppressMainFocusRef.current = false;
      return;
    }
    const sectionId = pendingFocusIdRef.current;
    pendingFocusIdRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const section = sectionId ? document.getElementById(sectionId) : null;
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        section.focus({ preventScroll: true });
        return;
      }
      mainRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, requestedTab]);

  useEffect(() => {
    if (playerResolution.status !== 'invalid') return;
    // A stale or foreign child ID simply falls back to the adult's own view.
    router.replace(manageHref(activeTab, { slug }), { scroll: false });
  }, [activeTab, playerResolution.status, router, slug]);

  useEffect(() => {
    if (!studentUserId) return;
    setHomeView(readHomeView(studentUserId));
  }, [studentUserId]);

  useEffect(() => {
    if (!studentUserId || !canUseFamily) {
      setFamilyPlayers([]);
      setFamilyPlayersStatus(studentUserId ? 'unavailable' : 'idle');
      return;
    }
    let ignore = false;
    setFamilyPlayersStatus('loading');
    loadFamilyBookingChildren()
      .then((value) => {
        if (ignore) return;
        setFamilyPlayers(value.children ?? []);
        setFamilyPlayersStatus('ready');
      })
      .catch(() => {
        // Family switched off (503), not yet eligible, or an older API: the
        // switcher is an extra, so it quietly stays hidden.
        if (ignore) return;
        setFamilyPlayers([]);
        setFamilyPlayersStatus('unavailable');
      });
    return () => { ignore = true; };
  }, [canUseFamily, studentUserId]);

  useEffect(() => {
    if (activeTab !== 'alerts') setAlertsStatus('');
  }, [activeTab]);

  useEffect(() => {
    if (!session || !isStudentSession(session) || activeTab !== 'home' || !bookingsReady || childViewActive) return;
    const studentSession = session;
    const context: ProductTourContext = {
      kind: 'student',
      userId: studentSession.user.id,
      firstName: studentSession.user.name.split(' ')[0],
    };
    const force = replayTourRef.current;
    replayTourRef.current = false;
    const timer = window.setTimeout(() => { void startProductTour(context, { force }); }, 300);
    return () => {
      window.clearTimeout(timer);
      destroyProductTour();
    };
  }, [activeTab, bookingsReady, childViewActive, session]);

  useEffect(() => {
    const bookingId = pendingBookingIdRef.current;
    if (activeTab !== 'home' || !bookingId || bookingsLoading || bookingsError) return;
    pendingBookingIdRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const bookingCard = document.getElementById(`student-booking-${bookingId}`);
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
      if (value.user.requiredAction) {
        router.replace('/account/action-required');
        return;
      }
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
      setBookingsReady(true);
    }
  }, [router]);

  const refreshClubDirectory = useCallback(async () => {
    setClubDirectoryLoading(true);
    setClubDirectoryError('');
    try {
      const value = await loadAccountClubs();
      setClubDirectory(value.clubs);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace(loginHrefRef.current);
      } else {
        // Directory discovery is additive. A failed or staggered deployment
        // must not take a signed-in student away from their bookings.
        setClubDirectoryError(messageOf(error));
      }
    } finally {
      setClubDirectoryLoading(false);
    }
  }, [router]);

  const refreshPackages = useCallback(async () => {
    if (!canUseCommerce) {
      packagesRequestRef.current += 1;
      setPackages([]);
      setPackagesLoading(false);
      setPackagesError('');
      return;
    }
    const requestId = ++packagesRequestRef.current;
    setPackagesLoading(true);
    setPackagesError('');
    try {
      const value = await loadAccountPackages();
      if (packagesRequestRef.current === requestId) setPackages(value.packages);
    } catch (error) {
      if (packagesRequestRef.current !== requestId) return;
      if (error instanceof ApiError && error.status === 401) router.replace(loginHrefRef.current);
      else setPackagesError(messageOf(error));
    } finally {
      if (packagesRequestRef.current === requestId) setPackagesLoading(false);
    }
  }, [canUseCommerce, router]);

  const refreshPaymentCapabilities = useCallback(async () => {
    if (!canUsePayments) {
      setPaymentCapabilities(null);
      setPaymentCapabilitiesLoading(false);
      setPaymentCapabilitiesError('');
      return;
    }
    setPaymentCapabilitiesLoading(true);
    setPaymentCapabilitiesError('');
    try {
      const value = await loadPaymentCapabilities();
      if (value.liveCheckout && !value.publishableKey) {
        throw new Error('Secure card checkout is not configured correctly.');
      }
      setPaymentCapabilities(value);
    } catch (error) {
      setPaymentCapabilities(null);
      if (error instanceof ApiError && error.status === 401) router.replace(loginHrefRef.current);
      else setPaymentCapabilitiesError(messageOf(error));
    } finally {
      setPaymentCapabilitiesLoading(false);
    }
  }, [canUsePayments, router]);

  const refreshRentals = useCallback(async () => {
    if (!canUseRentals) {
      setRentals([]);
      setRentalsLoading(false);
      setRentalsError('');
      return;
    }
    setRentalsLoading(true);
    setRentalsError('');
    try {
      const allRentals: RentalListing[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      while (true) {
        const value = await loadRentals(cursor ? { cursor } : {});
        allRentals.push(...value.rentals);
        if (!value.nextCursor) break;
        if (seenCursors.has(value.nextCursor)) throw new Error('The rental directory returned an invalid page. Please try again.');
        seenCursors.add(value.nextCursor);
        cursor = value.nextCursor;
      }
      setRentals(allRentals);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) router.replace(loginHrefRef.current);
      else setRentalsError(messageOf(error));
    } finally {
      setRentalsLoading(false);
    }
  }, [canUseRentals, router]);

  const refreshFavorites = useCallback(async () => {
    if (!canSearchPeople) {
      setFavorites(new Set());
      setFavoritesAvailable(false);
      return;
    }
    try {
      const value = await loadFavoriteClubs();
      setFavorites(new Set(value.favorites.map((favorite) => favorite.slug)));
      setFavoritesAvailable(true);
    } catch {
      // Saved clubs are additive; without them Explore works exactly as before.
      setFavoritesAvailable(false);
    }
  }, [canSearchPeople]);

  const refreshHomeProgress = useCallback(async () => {
    const request = ++homeProgressRequestRef.current;
    setHomeProgressLoading(true);
    try {
      const value = await loadAccountProgress();
      if (homeProgressRequestRef.current === request) setHomeProgress(value);
    } catch {
      if (homeProgressRequestRef.current === request) setHomeProgress(null);
    } finally {
      if (homeProgressRequestRef.current === request) setHomeProgressLoading(false);
    }
  }, []);

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
    if (!isStudentSession(session)) return;
    setProfile({
      username: session!.user.username ?? '',
      name: session!.user.name ?? '',
      phone: session!.user.phone ?? '',
      parentName: session!.user.parentName ?? '',
      sports: session!.user.sports ?? [],
    });
    setProfileSportsText((session!.user.sports ?? []).join(', '));
    setBookingsReady(false);
    void refreshBookings();
    if (session!.user.capabilities?.commerce !== false || session!.user.capabilities?.directory !== false) {
      void refreshClubDirectory();
    } else {
      setClubDirectory([]);
      setClubDirectoryError('');
      setClubDirectoryLoading(false);
    }
    void refreshNotifications();
    void refreshPackages();
    void refreshPaymentCapabilities();
    void refreshRentals();
    void refreshFavorites();
    void refreshHomeProgress();
  }, [session, refreshBookings, refreshClubDirectory, refreshFavorites, refreshHomeProgress, refreshNotifications, refreshPackages, refreshPaymentCapabilities, refreshRentals]);

  useEffect(() => {
    if (!isStudentSession(session) || !canUsePayments) return;
    const intentId = searchParams.get('checkout_intent');
    if (!intentId || checkoutReturnHandledRef.current === intentId) return;
    checkoutReturnHandledRef.current = intentId;
    const clean = new URLSearchParams(searchParams.toString());
    clean.delete('checkout_intent');
    clean.delete('payment_intent');
    clean.delete('payment_intent_client_secret');
    clean.delete('redirect_status');
    router.replace(`/manage${clean.size ? `?${clean}` : ''}`, { scroll: false });
    setCheckoutReturnStatus({ message: 'Stripe returned your payment. Waiting for Courtly to confirm it…', error: false });
    void waitForCheckout(intentId)
      .then((intent) => {
        if (intent?.status === 'SUCCEEDED') {
          setCheckoutReturnStatus({ message: 'Payment confirmed. Your Courtly account is up to date.', error: false });
          void refreshBookings();
          if (canUseCommerce) void refreshPackages();
          void refreshNotifications();
        } else if (intent?.status === 'FAILED' || intent?.status === 'CANCELLED' || intent?.status === 'REFUNDED') {
          setCheckoutReturnStatus({ message: 'The payment was not completed. No Courtly purchase was recorded.', error: true });
        } else {
          setCheckoutReturnStatus({ message: 'Your payment is still processing. Courtly will show it once confirmation arrives.', error: false });
        }
      })
      .catch((error) => setCheckoutReturnStatus({ message: `We could not check the payment yet. ${messageOf(error)}`, error: true }));
  }, [canUseCommerce, canUsePayments, refreshBookings, refreshNotifications, refreshPackages, router, searchParams, session]);

  useEffect(() => {
    if (canUseRentals) return;
    setExploreSegment('classes');
    setOpenRentalId(null);
    setRentalDetail(null);
    setRentalSlots([]);
    setSelectedRentalSlot(null);
    setRentalPackageFilterId('');
  }, [canUseRentals]);

  useEffect(() => {
    if (canUseCommerce) return;
    offersRequestRef.current += 1;
    setOffersClub(null);
    setLiveCheckout(current => current?.kind === 'PACKAGE' ? null : current);
    setPackagesExpanded(false);
    setRentalPackageFilterId('');
  }, [canUseCommerce]);

  useEffect(() => {
    if (canUsePayments) return;
    setLiveCheckout(null);
  }, [canUsePayments]);

  useEffect(() => {
    if (canEditProfile) return;
    setProfileEditorOpen(false);
  }, [canEditProfile]);

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
  const exploreClubs = useMemo(
    () => canUseCommerce ? directoryClubs(clubDirectory, clubs, !!clubDirectoryError) : [],
    [canUseCommerce, clubDirectory, clubDirectoryError, clubs],
  );
  // Book keeps a previously used or explicitly linked club available even
  // when it is intentionally excluded from public discovery (for example a
  // private demo workspace). The directory remains the source for all other
  // first-time choices.
  const bookClubs = useMemo(
    () => canUseCommerce ? directoryClubs(clubDirectory, clubs, true) : [],
    [canUseCommerce, clubDirectory, clubs],
  );
  const clubSports = useMemo(() => {
    const labels = new Map<string, string>();
    for (const sport of clubDirectory.flatMap((club) => club.sports)) {
      const key = sport.trim().toLowerCase();
      if (key && !labels.has(key)) labels.set(key, sport.trim());
    }
    return [...labels].map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [clubDirectory]);
  useEffect(() => {
    if (clubSlug && !exploreClubs.some((club) => club.business.slug === clubSlug)) setClubSlug('');
    if (clubSport && !clubSports.some((sport) => sport.key === clubSport)) setClubSport('');
  }, [clubSlug, clubSport, clubSports, exploreClubs]);
  const filteredExploreClubs = useMemo(() => {
    const query = clubSearch.trim().toLowerCase();
    return exploreClubs.filter((club) => {
      const matchesSearch = !query || [
        club.business.name,
        club.business.tagline,
        club.business.ownerName,
        club.business.slug,
        ...(club.directory?.sports ?? []),
      ].some((value) => value.toLowerCase().includes(query));
      const matchesSport = !clubSport || club.directory?.sports.some(
        (sport) => sport.trim().toLowerCase() === clubSport,
      );
      const matchesClub = !clubSlug || club.business.slug === clubSlug;
      const matchesRelationship =
        clubRelationship === 'all' ||
        (clubRelationship === 'saved'
          ? favorites.has(club.business.slug)
          : clubRelationship === 'known' ? !!club.known : !club.known);
      return matchesSearch && matchesSport && matchesClub && matchesRelationship;
    });
  }, [clubRelationship, clubSearch, clubSlug, clubSport, exploreClubs, favorites]);
  const filteredKnownClubs = filteredExploreClubs.filter((club) => club.known);
  const filteredDiscoveryClubs = filteredExploreClubs.filter((club) => !club.known);
  const exploreLoading = clubDirectoryLoading || !bookingsReady;
  const rentalSports = useMemo(() => {
    const labels = new Map<string, string>();
    for (const rental of rentals) {
      const key = rental.sport.trim().toLowerCase();
      if (key && !labels.has(key)) labels.set(key, rental.sport.trim());
    }
    return [...labels].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [rentals]);
  const filteredRentals = useMemo(() => {
    const query = rentalSearch.trim().toLowerCase();
    return rentals.filter((rental) => {
      const matchesQuery = !query || [rental.name, rental.address, rental.sport, ...rental.amenities]
        .some((value) => value.toLowerCase().includes(query));
      const matchesPackage = !rentalPackageFilterId || packages.some((pkg) =>
        pkg.id === rentalPackageFilterId && pkg.rentalLocationIds.includes(rental.locationId));
      return matchesQuery && (!rentalSport || rental.sport.trim().toLowerCase() === rentalSport) && matchesPackage;
    });
  }, [packages, rentalPackageFilterId, rentalSearch, rentalSport, rentals]);
  const activePackages = useMemo(() => packages.filter((pkg) => pkg.state === 'ACTIVE'), [packages]);
  const eligibleRentalPackages = useMemo(() => {
    if (!rentalDetail) return [];
    const selectedStart = selectedRentalSlot ? new Date(selectedRentalSlot.startAt).getTime() : null;
    return activePackages.filter((pkg) =>
      pkg.remainingCredits > 0
      && pkg.rentalLocationIds.includes(rentalDetail.locationId)
      && (selectedStart === null || new Date(pkg.expiresAt).getTime() >= selectedStart));
  }, [activePackages, rentalDetail, selectedRentalSlot]);
  useEffect(() => {
    if (selectedRentalPackageId && !eligibleRentalPackages.some((pkg) => pkg.id === selectedRentalPackageId)) {
      setSelectedRentalPackageId('');
    }
  }, [eligibleRentalPackages, selectedRentalPackageId]);
  const current = useMemo(() => bookings.filter((item) => isInProgress(item, nowMs)), [bookings, nowMs]);
  const upcoming = useMemo(() => bookings.filter((item) => isUpcoming(item, nowMs)), [bookings, nowMs]);
  const prioritizedUpcoming = useMemo(
    () => [...upcoming].sort((a, b) => {
      const actionDifference = Number(!!incomingRequest(b)) - Number(!!incomingRequest(a));
      return actionDifference || new Date(a.booking.startAt).getTime() - new Date(b.booking.startAt).getTime();
    }),
    [upcoming],
  );
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
  // Unread first, newest first — so what needs attention never sits below the
  // fold behind a week of read confirmations.
  const visibleNotifications = useMemo(
    () => sortAlerts(notificationsFallback ? fallbackActivity : notifications),
    [fallbackActivity, notifications, notificationsFallback],
  );
  const unread = notificationsFallback ? 0 : notifications.filter((item) => !item.read).length;
  const shownNotifications = showAllAlerts
    ? visibleNotifications
    : visibleNotifications.slice(0, alertPageSize);
  const openAlert = openAlertId
    ? visibleNotifications.find((item) => item.id === openAlertId) ?? null
    : null;
  const actionBooking = openBookingId
    ? bookings.find((item) => item.booking.id === openBookingId)
    : undefined;
  const paymentMode: PaymentUiMode = !canUsePayments
    ? 'disabled'
    : paymentCapabilitiesLoading && !paymentCapabilities
    ? 'loading'
    : paymentCapabilities?.liveCheckout && paymentCapabilities.publishableKey
      ? 'live'
      : paymentCapabilities?.simulatedCheckout ? 'simulated' : 'disabled';
  const paymentUnavailableReason = !canUsePayments
    ? 'Payments are unavailable for this account.'
    : paymentCapabilitiesError
    ? `Payment availability could not be checked. ${paymentCapabilitiesError}`
    : 'Online payment is not enabled for this Courtly deployment.';
  const stripeTestMode = paymentCapabilities?.publishableKey?.startsWith('pk_test_') ?? false;
  // Bookings are shown on the day they happen at their club; "today" follows
  // the learner's first club, which for almost everyone is Singapore time.
  const calendarTimezone = bookings[0]?.business.timezone || 'Asia/Singapore';
  const todayKey = dayKeyFor(new Date(nowMs), calendarTimezone) || dateKey(new Date(nowMs));
  const sportOf = useMemo(
    () => bookingSportResolver(clubDirectory, homeProgress?.feedback ?? []),
    [clubDirectory, homeProgress],
  );
  const calendarEvents = useMemo(
    () => bookings.map((item) => accountBookingEvent(item, nowMs, sportOf(item))),
    [bookings, nowMs, sportOf],
  );
  const canFindTime = canUseCommerce && canSearchPeople;

  useEffect(() => {
    if (!favoritesAvailable && clubRelationship === 'saved') setClubRelationship('all');
  }, [clubRelationship, favoritesAvailable]);

  useEffect(() => {
    if (!canUseRentals || !openRentalId) return;
    let ignore = false;
    setRentalDetailLoading(true);
    setRentalError('');
    loadRental(openRentalId)
      .then((value) => {
        if (ignore) return;
        setRentalDetail(value);
        setRentalDuration(value.minDuration);
        setRentalDate(dateKey(new Date(), value.timezone));
        setRentalUnitId(value.units.find((unit) => unit.active !== false)?.id ?? '');
        setSelectedRentalPackageId(rentalPackageFilterId);
      })
      .catch((error) => { if (!ignore) setRentalError(messageOf(error)); })
      .finally(() => { if (!ignore) setRentalDetailLoading(false); });
    return () => { ignore = true; };
  }, [canUseRentals, openRentalId]);

  useEffect(() => {
    if (!canUseRentals || !rentalDetail || !rentalDate || !rentalDuration) return;
    let ignore = false;
    setRentalSlotsLoading(true);
    setRentalError('');
    setSelectedRentalSlot(null);
    loadRentalSlots(rentalDetail.id, { date: rentalDate, duration: rentalDuration })
      .then((value) => {
        if (!ignore) setRentalSlots(value.slots.filter((slot) => !rentalUnitId || slot.unitId === rentalUnitId));
      })
      .catch((error) => { if (!ignore) setRentalError(messageOf(error)); })
      .finally(() => { if (!ignore) setRentalSlotsLoading(false); });
    return () => { ignore = true; };
  }, [canUseRentals, rentalDate, rentalDetail, rentalDuration, rentalSlotsVersion, rentalUnitId]);

  useEffect(() => {
    if (selectedClubSlug && bookClubs.some((club) => club.business.slug === selectedClubSlug)) return;
    setSelectedClubSlug(bookClubs[0]?.business.slug ?? '');
  }, [bookClubs, selectedClubSlug]);

  useEffect(() => {
    if (dialogMode !== 'reschedule' || !actionBooking || !rescheduleDate) return;
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
  }, [dialogMode, actionBooking, rescheduleDate, slotsVersion]);

  // The tab bar always belongs to the signed-in adult, so choosing a tab
  // also leaves any child view.
  function selectTab(tab: StudentTab) {
    setNotice('');
    setBookingNavigationStatus('');
    if (tab !== 'alerts') setAlertsStatus('');
    if (tab !== 'book') setBookingForName('');
    if (tab !== activeTab || requestedTab === null || !!requestedPlayer) {
      router.push(tabHref(tab), { scroll: false });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Open a tab and land on one of its sections, focusing its heading. */
  function goToSection(tab: StudentTab, sectionId: string) {
    setOpenAlertId(null);
    if (tab === 'explore') setExploreSegment('classes');
    if (tab === activeTab && requestedTab !== null && !requestedPlayer) {
      window.requestAnimationFrame(() => {
        const section = document.getElementById(sectionId);
        if (!section) return;
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        section.focus({ preventScroll: true });
      });
      return;
    }
    pendingFocusIdRef.current = sectionId;
    selectTab(tab);
  }

  function chooseHomeView(view: HomeView) {
    setHomeView(view);
    if (studentUserId) writeHomeView(studentUserId, view);
  }

  function choosePlayer(value: string) {
    const tab = activeTab === 'progress' ? 'progress' : 'home';
    setOpenBookingId(null);
    setOpenAlertId(null);
    router.push(manageHref(tab, { slug, player: value === SELF_PLAYER ? null : value }), { scroll: false });
  }

  function changeChildSegment(segment: ChildSegment) {
    if (!activeChild) return;
    const tab = segment === 'progress' ? 'progress' : 'home';
    if (tab === activeTab) return;
    suppressMainFocusRef.current = true;
    router.push(manageHref(tab, { slug, player: activeChild.id }), { scroll: false });
  }

  function bookForChild(child: FamilyBookingChild) {
    selectTab('book');
    setBookingForName(child.displayName);
  }

  async function toggleSavedClub(club: ExploreClub, saved: boolean) {
    const slugToSave = club.business.slug;
    setFavorites((current) => withFavorite(current, slugToSave, saved));
    setFavoriteStatus('');
    try {
      if (saved) await saveFavoriteClub(slugToSave);
      else await removeFavoriteClub(slugToSave);
      setFavoriteStatus(saved ? `${club.business.name} saved.` : `${club.business.name} removed from saved clubs.`);
    } catch (error) {
      // Optimistic, so undo exactly the change that failed.
      setFavorites((current) => withFavorite(current, slugToSave, !saved));
      setFavoriteStatus(`${club.business.name} could not be ${saved ? 'saved' : 'removed'}. ${messageOf(error)}`);
    }
  }

  function openPackageActivity(pkg: AccountPackage) {
    setOpenAlertId(null);
    setActivityPackage(pkg);
  }

  function buyAnotherPackage(pkg: Pick<AccountPackage, 'business'>) {
    if (!canUseCommerce) return;
    setActivityPackage(null);
    setOpenAlertId(null);
    openPackageOffers({ business: pkg.business });
  }

  /**
   * Typed alerts lead somewhere more useful than a booking: coach feedback to
   * Progress, waitlist news to the waitlist, package reminders to the
   * package. A waitlist booking ID names a Class the learner is not in yet,
   * so "Go to this booking" is offered only for the learner's own sessions.
   */
  function alertDestinations(alert: StudentNotification): { destinations: AlertDestination[]; showBookingLink: boolean } {
    const ownBooking = !!alert.bookingId && bookings.some((item) => item.booking.id === alert.bookingId);
    if (alert.type === 'FEEDBACK_SHARED') {
      const child = !ownBooking && familyPlayersStatus === 'ready' ? childNamedIn(alert.title, familyPlayers) : null;
      if (child) {
        return {
          destinations: [{
            label: `See ${child.displayName}’s progress`,
            run: () => { setOpenAlertId(null); router.push(manageHref('progress', { slug, player: child.id }), { scroll: false }); },
          }],
          showBookingLink: false,
        };
      }
      return { destinations: [{ label: 'See coach feedback', run: () => { setOpenAlertId(null); selectTab('progress'); } }], showBookingLink: ownBooking };
    }
    if (alert.type === 'WAITLIST_OFFERED' || alert.type === 'WAITLIST_CLOSED') {
      return {
        destinations: [{
          label: alert.type === 'WAITLIST_OFFERED' ? 'Review the held place' : 'View your waitlist',
          run: () => { setWaitlistReload((value) => value + 1); goToSection('home', 'student-waitlist-heading'); },
        }],
        showBookingLink: ownBooking,
      };
    }
    if ((alert.type === 'PACKAGE_LOW' || alert.type === 'PACKAGE_EXPIRING') && canUseCommerce) {
      const pkg = alert.packageId ? packages.find((candidate) => candidate.id === alert.packageId) : undefined;
      const destinations: AlertDestination[] = [];
      if (pkg) destinations.push({ label: 'View package activity', run: () => openPackageActivity(pkg) });
      destinations.push({ label: 'View my packages', run: () => { setPackagesExpanded(true); goToSection('profile', 'student-packages-heading'); } });
      if (pkg) destinations.push({ label: 'Buy another package', run: () => buyAnotherPackage(pkg) });
      return { destinations, showBookingLink: false };
    }
    return { destinations: [], showBookingLink: true };
  }
  function replayProductTour() {
    replayTourRef.current = true;
    if (activeTab === 'home') {
      replayTourRef.current = false;
      void startProductTour({
        kind: 'student',
        userId: session!.user.id,
        firstName: session!.user.name.split(' ')[0],
      }, { force: true });
    } else {
      selectTab('home');
    }
  }
  function openAlertBooking(bookingId: string) {
    setNotice('');
    setBookingNavigationStatus('');
    setOpenAlertId(null);
    const known = bookings.some((item) => item.booking.id === bookingId);
    if (!known) {
      // The alert outlived its booking. Say so rather than opening an empty
      // dialog or silently doing nothing.
      pendingBookingIdRef.current = null;
      setBookingNavigationStatus('That booking is no longer available.');
      selectTab('home');
      return;
    }
    pendingBookingIdRef.current = null;
    openBooking(bookingId);
    if (activeTab !== 'home' || requestedTab === null) {
      router.push(tabHref('home'), { scroll: false });
    }
    setBookingNavigationStatus('Booking details opened.');
  }

  const openBookingRow = (item: AccountBooking) => openBooking(item.booking.id);

  // Each opened conversation is a history entry, so Back returns to the list,
  // and the on-screen back arrow pops that entry rather than stacking another.
  function selectChatThread(threadId: string | null) {
    if (!threadId && chatOpenedFromListRef.current) {
      chatOpenedFromListRef.current = false;
      router.back();
      return;
    }
    chatOpenedFromListRef.current = !!threadId && activeTab === 'chat' && !chatThreadId;
    router.push(chatHref(threadId), { scroll: false });
  }

  async function openChatForBooking(bookingId: string) {
    if (!canUseDirectChat) return;
    try {
      const { threadId } = await openBookingChat(bookingId);
      setOpenBookingId(null);
      setDialogMode('details');
      selectChatThread(threadId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) router.replace(loginHrefRef.current);
      else setActionError(messageOf(error));
    }
  }

  // A proposal accepted in chat books a session this list has not seen yet.
  async function openBookingFromChat(bookingId: string) {
    if (!bookings.some((item) => item.booking.id === bookingId)) await refreshBookings();
    openBooking(bookingId);
  }

  function openBooking(bookingId: string) {
    setNowMs(Date.now());
    setOpenBookingId(bookingId);
    setDialogMode('details');
    setActionError('');
    setConflicts([]);
    setSelectedSlot(null);
    setNotice('');
  }

  function closeBooking() {
    if (actionBusy) return;
    setOpenBookingId(null);
    setDialogMode('details');
    setActionError('');
    setConflicts([]);
    setSelectedSlot(null);
  }

  function changeDialogMode(mode: BookingDialogMode) {
    if (actionBusy || !actionBooking) return;
    setActionError('');
    setConflicts([]);
    setSelectedSlot(null);
    if (mode === 'reschedule') {
      if (!canChangeBooking(actionBooking, 'reschedule', Date.now())) return;
      setRescheduleDate(dateKey(new Date(), actionBooking.business.timezone));
    }
    setDialogMode(mode);
  }

  /** Apply whichever booking the server returned, and refresh the rest. */
  function applyUpdatedBooking(updated: AccountBooking | undefined, message: string) {
    if (updated?.participant?.id) {
      setBookings((current) =>
        current.map((item) => (item.participant.id === updated.participant.id ? updated : item)),
      );
    }
    setDialogMode('details');
    setSelectedSlot(null);
    setNotice(message);
    void refreshBookings();
    void refreshNotifications();
  }

  async function runBookingAction(
    call: () => Promise<AccountBooking>,
    successMessage: string,
    options: { close?: boolean } = {},
  ) {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError('');
    setConflicts([]);
    try {
      const updated = await call();
      applyUpdatedBooking(updated, successMessage);
      if (options.close) setOpenBookingId(null);
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

  function performCancel() {
    if (!actionBooking) return;
    if (!canChangeBooking(actionBooking, 'cancel', Date.now())) {
      setNowMs(Date.now());
      setActionError(`This booking is now inside ${actionBooking.business.cancellationHours} hours of its start. Please contact your coach.`);
      return;
    }
    const participantId = actionBooking.participant.id;
    void runBookingAction(
      () => cancelAccountBooking(participantId) as Promise<AccountBooking>,
      'Your booking has been cancelled.',
      { close: true },
    );
  }

  // Asking for a new time does not move the session. The coach's side has to
  // accept first, so the copy promises a request rather than a change.
  function performRescheduleRequest() {
    if (!actionBooking || !selectedSlot) return;
    if (!canChangeBooking(actionBooking, 'reschedule', Date.now())) {
      setNowMs(Date.now());
      setActionError('This booking is now outside the rescheduling window. Contact your coach.');
      return;
    }
    const participantId = actionBooking.participant.id;
    const startAt = selectedSlot.startAt;
    void runBookingAction(
      () => requestAccountReschedule(participantId, startAt),
      'Your request was sent. The session moves once your coach accepts.',
    );
  }

  function respondToRequest(accept: boolean) {
    const request = actionBooking?.rescheduleRequest;
    if (!request || !actionBooking) return;
    if (accept && rescheduleAcceptanceClosed(actionBooking, Date.now())) {
      setNowMs(Date.now());
      setActionError('The original lesson has ended, so this proposal can no longer be accepted. Keep the original time to close it.');
      return;
    }
    const mine = request.requestedByRole === 'STUDENT';
    void runBookingAction(
      () => (accept ? acceptAccountReschedule(request.id) : declineAccountReschedule(request.id)),
      accept
        ? 'The new time is confirmed.'
        : mine
          ? 'Your request was withdrawn.'
          : 'The session keeps its original time.',
    );
  }

  function completeLiveCheckout(checkout: LiveCheckoutSession) {
    const attempts = checkout.kind === 'PACKAGE' ? packageCheckoutKeysRef.current : bookingCheckoutKeysRef.current;
    attempts.delete(checkout.retrySignature);
    setLiveCheckout(null);
    if (checkout.kind === 'PACKAGE') {
      setOfferNotice(`${checkout.label} is now in My Packages. Stripe payment confirmed.`);
      void refreshPackages();
    } else {
      setBookings((current) => current.map((item) => item.participant.id === checkout.targetId
        ? {
            ...item, participant: { ...item.participant, paid: true },
            booking: {
              ...item.booking, participants: item.booking.participants.map((participant) =>
                participant.id === checkout.targetId ? { ...participant, paid: true } : participant),
            },
          } : item));
      setNotice(`Stripe payment confirmed for the checkout associated with ${checkout.clubName}.`);
      void refreshBookings();
    }
    void refreshNotifications();
  }

  function requestCheckoutReview(kind: 'PACKAGE' | 'BOOKING', targetId: string) {
    const requestId = ++checkoutReviewRequestRef.current;
    setCheckoutReviewState({ kind, targetId, review: null, loading: true, accepted: false, error: '' });
    void loadCheckoutReview(kind, targetId)
      .then((review) => {
        if (checkoutReviewRequestRef.current !== requestId) return;
        if (review.kind !== kind) throw new Error('The checkout details did not match this purchase. Please try again.');
        setCheckoutReviewState({ kind, targetId, review, loading: false, accepted: false, error: '' });
      })
      .catch((error) => {
        if (checkoutReviewRequestRef.current !== requestId) return;
        if (error instanceof ApiError && error.status === 401) router.replace(loginHrefRef.current);
        setCheckoutReviewState({ kind, targetId, review: null, loading: false, accepted: false, error: messageOf(error) });
      });
  }

  function closeCheckoutReview() {
    if (actionBusy || offerBusyId) return;
    checkoutReviewRequestRef.current += 1;
    setCheckoutReviewState(null);
  }

  function retryCheckoutReview() {
    if (!checkoutReviewState) return;
    requestCheckoutReview(checkoutReviewState.kind, checkoutReviewState.targetId);
  }

  function changeCheckoutPurchase() {
    checkoutReviewRequestRef.current += 1;
    setCheckoutReviewState(null);
    setLiveCheckout(null);
  }

  function continueReviewedCheckout() {
    const current = checkoutReviewState;
    if (!current?.accepted || !current.review || current.review.kind !== current.kind) return;
    if (paymentMode === 'live' && !current.review.merchant.identityReady) return;
    if (current.kind === 'BOOKING') executeBookingCheckout(current.review);
    else executePackageCheckout(current.review);
  }

  function payForBooking() {
    if (!canUsePayments || !actionBooking || actionBusy) return;
    requestCheckoutReview('BOOKING', actionBooking.participant.id);
  }

  function executeBookingCheckout(review: CheckoutReview) {
    if (!canUsePayments || !actionBooking || actionBusy || review.kind !== 'BOOKING' || review.reviewHash.length === 0
      || checkoutReviewState?.targetId !== actionBooking.participant.id) return;
    const participantId = actionBooking.participant.id;
    const acceptance = checkoutAcceptance(review);
    if (paymentMode === 'live') {
      const signature = JSON.stringify([participantId, 'stripe', review.reviewHash]);
      const idempotencyKey = activeCheckoutKey(bookingCheckoutKeysRef.current, 'booking', participantId, signature);
      setActionBusy(true);
      setActionError('');
      void createLiveCheckoutIntent({ kind: 'BOOKING', targetId: participantId, idempotencyKey, acceptance })
        .then(({ paymentIntent, connectedAccountId }) => {
          const clientSecret = paymentIntent.clientSecret;
          const checkout: LiveCheckoutSession = {
            localIntentId: paymentIntent.id, clientSecret: clientSecret ?? '', connectedAccountId,
            amount: paymentIntent.amount, currency: paymentIntent.currency, kind: 'BOOKING', targetId: participantId,
            label: review.item.label, clubName: review.merchant.tradingName, retrySignature: signature, review,
          };
          if (paymentIntent.status === 'SUCCEEDED') {
            setCheckoutReviewState(null);
            completeLiveCheckout(checkout);
            return;
          }
          if (paymentIntent.status === 'FAILED' || paymentIntent.status === 'CANCELLED' || paymentIntent.status === 'REFUNDED') {
            bookingCheckoutKeysRef.current.delete(signature);
            throw new Error('This payment attempt is closed. Please try again.');
          }
          if (!clientSecret || !connectedAccountId) throw new Error('Secure checkout could not be initialized.');
          setCheckoutReviewState(null);
          setLiveCheckout(checkout);
        })
        .catch((error) => {
          forgetDefinitiveCheckoutFailure(bookingCheckoutKeysRef.current, signature, error);
          if (error instanceof ApiError && error.status === 401) router.replace(loginHrefRef.current);
          else setCheckoutReviewState((current) => current ? { ...current, accepted: false, error: messageOf(error) } : current);
        })
        .finally(() => setActionBusy(false));
      return;
    }
    if (paymentMode !== 'simulated') return;
    const outcome = bookingPaymentOutcome;
    const signature = JSON.stringify([participantId, outcome, review.reviewHash]);
    const idempotencyKey = activeCheckoutKey(bookingCheckoutKeysRef.current, 'booking', participantId, signature);
    setActionBusy(true);
    setActionError('');
    void checkoutBookingParticipant(participantId, {
      idempotencyKey,
      simulatedOutcome: outcome,
      acceptance,
    })
      .then((result) => {
        bookingCheckoutKeysRef.current.delete(signature);
        if (result.paymentIntent.status !== 'SUCCEEDED') {
          setCheckoutReviewState(null);
          setActionError('The simulated Stripe payment was declined. No real card was charged.');
          return;
        }
        setCheckoutReviewState(null);
        setBookings((current) => current.map((item) => item.participant.id === participantId
          ? {
              ...item,
              participant: { ...item.participant, paid: true },
              booking: {
                ...item.booking,
                participants: item.booking.participants.map((participant) =>
                  participant.id === participantId ? { ...participant, paid: true } : participant),
              },
            }
          : item));
        setNotice(`Simulated Stripe payment completed for ${actionBooking.business.name}; no real card was charged.`);
        void refreshBookings();
        void refreshNotifications();
      })
      .catch((error) => {
        forgetDefinitiveCheckoutFailure(bookingCheckoutKeysRef.current, signature, error);
        if (error instanceof ApiError && error.status === 401) router.replace(loginHrefRef.current);
        else setCheckoutReviewState((current) => current ? { ...current, accepted: false, error: messageOf(error) } : current);
      })
      .finally(() => setActionBusy(false));
  }

  function openPackageOffers(club: { business: PackageOfferBusiness }) {
    if (!canUseCommerce) return;
    const requestId = ++offersRequestRef.current;
    setOffersClub(club);
    setPackageOffers([]);
    setOffersError('');
    setOfferNotice('');
    setOffersLoading(true);
    void loadAccountPackageOffers(club.business.slug)
      .then((value) => {
        if (offersRequestRef.current === requestId) setPackageOffers(value.offers);
      })
      .catch((error) => {
        if (offersRequestRef.current === requestId) setOffersError(messageOf(error));
      })
      .finally(() => {
        if (offersRequestRef.current === requestId) setOffersLoading(false);
      });
  }

  function closePackageOffers() {
    offersRequestRef.current += 1;
    setOffersClub(null);
    setOffersLoading(false);
  }

  function buyPackage(offer: PackageOffer) {
    if (!canUseCommerce || !canUsePayments || offerBusyId) return;
    requestCheckoutReview('PACKAGE', offer.id);
  }

  function executePackageCheckout(review: CheckoutReview) {
    if (!canUseCommerce || !canUsePayments || offerBusyId || review.kind !== 'PACKAGE' || review.reviewHash.length === 0) return;
    const offer = packageOffers.find((candidate) => candidate.id === checkoutReviewState?.targetId);
    if (!offer) {
      setCheckoutReviewState((current) => current ? { ...current, accepted: false, error: 'This package offer is no longer available. Return to the package list and choose again.' } : current);
      return;
    }
    if (offer.businessId && review.merchant.businessId !== offer.businessId) {
      setCheckoutReviewState((current) => current ? { ...current, accepted: false, error: 'The selected club details no longer match this package offer. Return to the package list and try again.' } : current);
      return;
    }
    const acceptance = checkoutAcceptance(review);
    if (paymentMode === 'live') {
      const signature = JSON.stringify([offer.id, 'stripe', review.reviewHash]);
      const idempotencyKey = activeCheckoutKey(packageCheckoutKeysRef.current, 'package', offer.id, signature);
      setOfferBusyId(offer.id);
      setOffersError('');
      setOfferNotice('');
      void createLiveCheckoutIntent({ kind: 'PACKAGE', targetId: offer.id, idempotencyKey, acceptance })
        .then(({ paymentIntent, connectedAccountId }) => {
          const clientSecret = paymentIntent.clientSecret;
          const checkout: LiveCheckoutSession = {
            localIntentId: paymentIntent.id, clientSecret: clientSecret ?? '', connectedAccountId,
            amount: paymentIntent.amount, currency: paymentIntent.currency, kind: 'PACKAGE', targetId: offer.id,
            label: review.item.label, clubName: review.merchant.tradingName, retrySignature: signature, review,
          };
          if (paymentIntent.status === 'SUCCEEDED') {
            setCheckoutReviewState(null);
            completeLiveCheckout(checkout);
            return;
          }
          if (paymentIntent.status === 'FAILED' || paymentIntent.status === 'CANCELLED' || paymentIntent.status === 'REFUNDED') {
            packageCheckoutKeysRef.current.delete(signature);
            throw new Error('This payment attempt is closed. Please try again.');
          }
          if (!clientSecret || !connectedAccountId) throw new Error('Secure checkout could not be initialized.');
          setCheckoutReviewState(null);
          setLiveCheckout(checkout);
        })
        .catch((error) => {
          forgetDefinitiveCheckoutFailure(packageCheckoutKeysRef.current, signature, error);
          if (error instanceof ApiError && error.status === 401) router.replace(loginHrefRef.current);
          else setCheckoutReviewState((current) => current ? { ...current, accepted: false, error: messageOf(error) } : current);
        })
        .finally(() => setOfferBusyId(null));
      return;
    }
    if (paymentMode !== 'simulated') return;
    const signature = JSON.stringify([offer.id, offerPaymentOutcome, review.reviewHash]);
    const idempotencyKey = activeCheckoutKey(packageCheckoutKeysRef.current, 'package', offer.id, signature);
    setOfferBusyId(offer.id);
    setOffersError('');
    setOfferNotice('');
    void checkoutPackageOffer(offer.id, {
      idempotencyKey,
      simulatedOutcome: offerPaymentOutcome,
      acceptance,
    })
      .then((result) => {
        packageCheckoutKeysRef.current.delete(signature);
        if (result.paymentIntent.status !== 'SUCCEEDED' || !result.package) {
          setCheckoutReviewState(null);
          setOffersError('The simulated Stripe payment was declined. No real card was charged.');
          return;
        }
        setCheckoutReviewState(null);
        setOfferNotice(`${offer.name} is now in My Packages. This was a simulated Stripe payment; no real card was charged.`);
        void refreshPackages();
        void refreshNotifications();
      })
      .catch((error) => {
        forgetDefinitiveCheckoutFailure(packageCheckoutKeysRef.current, signature, error);
        setCheckoutReviewState((current) => current ? { ...current, accepted: false, error: messageOf(error) } : current);
      })
      .finally(() => setOfferBusyId(null));
  }

  function forgetLiveCheckoutAttempt(checkout = liveCheckout) {
    if (!checkout) return;
    const attempts = checkout.kind === 'PACKAGE' ? packageCheckoutKeysRef.current : bookingCheckoutKeysRef.current;
    attempts.delete(checkout.retrySignature);
  }

  async function settleLiveCheckout() {
    if (!liveCheckout) return null;
    const checkout = liveCheckout;
    const intent = await waitForCheckout(checkout.localIntentId);
    if (intent?.status !== 'SUCCEEDED') return intent;
    completeLiveCheckout(checkout);
    return intent;
  }

  function findRentalForPackage(pkg: AccountPackage) {
    if (!canUseCommerce || !canUseRentals) return;
    setPackagesExpanded(false);
    setRentalPackageFilterId(pkg.id);
    setRentalSport('');
    setRentalSearch('');
    setExploreSegment('rentals');
    selectTab('explore');
  }

  function closeRental() {
    setOpenRentalId(null);
    setRentalDetail(null);
    setRentalSlots([]);
    setSelectedRentalSlot(null);
    setSelectedRentalPackageId('');
    setRentalError('');
    setRentalNotice('');
  }

  function reserveRental() {
    if (!canUseRentals || (!selectedRentalPackageId && !canUsePayments) || !rentalDetail || !selectedRentalSlot || rentalBookingBusy) return;
    const rentalId = rentalDetail.id;
    const slot = selectedRentalSlot;
    const freeRental = slot.price === 0;
    const packageId = freeRental ? '' : selectedRentalPackageId;
    const outcome = freeRental || packageId ? 'SUCCEEDED' : rentalPaymentOutcome;
    const signature = JSON.stringify([rentalId, slot.unitId, slot.startAt, rentalDuration, packageId, outcome]);
    const idempotencyKey = activeCheckoutKey(rentalCheckoutKeysRef.current, 'rental', rentalId, signature);
    setRentalBookingBusy(true);
    setRentalError('');
    setRentalNotice('');
    void createRentalReservation(rentalId, {
      unitId: slot.unitId,
      startAt: slot.startAt,
      duration: rentalDuration,
      idempotencyKey,
      simulatedOutcome: outcome,
      ...(packageId ? { packageId } : {}),
    })
      .then((result) => {
        rentalCheckoutKeysRef.current.delete(signature);
        if (result.paymentIntent.status === 'REFUNDED' || result.reservation?.status === 'CANCELLED') {
          setRentalError('That earlier reservation was cancelled and refunded. No new reservation was made. Try again to start a new demo checkout.');
          return;
        }
        if (result.paymentIntent.status !== 'SUCCEEDED' || !result.reservation) {
          setRentalError('The simulated Stripe payment was declined. No real card was charged and the court was not reserved.');
          return;
        }
        setRentalNotice(freeRental
          ? `${result.reservation.unitName} is reserved for free. No payment or package credit was needed.`
          : packageId
          ? `${result.reservation.unitName} is reserved with one package credit.`
          : `${result.reservation.unitName} is reserved. This was a simulated Stripe payment; no real card was charged.`);
        setSelectedRentalSlot(null);
        setRentalSlotsVersion((value) => value + 1);
        setRentalHistoryVersion((value) => value + 1);
        void refreshPackages();
      })
      .catch((error) => {
        forgetDefinitiveCheckoutFailure(rentalCheckoutKeysRef.current, signature, error);
        setRentalError(messageOf(error));
      })
      .finally(() => setRentalBookingBusy(false));
  }

  async function submitPeopleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = peopleQuery.trim();
    const searchableQuery = query.startsWith('@') ? query.slice(1) : query;
    if (searchableQuery.length < 3 || peopleLoading) {
      setPeopleError('Enter at least 3 characters to search people.');
      return;
    }
    setPeopleLoading(true);
    setPeopleError('');
    setPeopleSearchedFor('');
    try {
      setPeople(await searchAccounts(query));
      setPeopleSearchedFor(query);
    } catch (error) {
      setPeople([]);
      setPeopleError(messageOf(error));
    } finally {
      setPeopleLoading(false);
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

  /**
   * Opening an alert is what marks it read, the way a message thread works.
   * The shading clears immediately so the list responds to the tap; if the
   * server refuses, the next refresh restores the unread state honestly.
   */
  function openAlertDetails(alert: StudentNotification) {
    setOpenAlertId(alert.id);
    if (notificationsFallback || alert.read) return;
    setNotifications((current) =>
      current.map((item) => (item.id === alert.id ? { ...item, read: true } : item)),
    );
    void api<unknown>('/account/notifications/read', {
      method: 'PATCH',
      body: JSON.stringify({ ids: [alert.id] }),
    }).catch(() => {
      void refreshNotifications();
    });
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !canEditProfile || profileBusy) return;
    const name = profile.name.trim();
    if (name.length < 2) {
      setProfileError('Please enter your name using at least two characters.');
      return;
    }
    const username = profile.username.trim().toLowerCase();
    const usernameError = profileUsernameError(username);
    if (usernameError) {
      setProfileError(usernameError);
      return;
    }
    const sportsError = profileSportsError(profileSportsText);
    if (sportsError) {
      setProfileError(sportsError);
      return;
    }
    setProfileBusy(true);
    setProfileError('');
    setProfileNotice('');
    try {
      const sports = normalizeSports(profileSportsText);
      const value = await api<AuthSession>('/account/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          username,
          phone: profile.phone.trim(),
          parentName: profile.parentName.trim(),
          sports,
        }),
      });
      const nextUser = value.user;
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
        username: nextUser.username ?? username,
        name: nextUser.name,
        phone: nextUser.phone ?? '',
        parentName: nextUser.parentName ?? '',
        sports: nextUser.sports ?? profile.sports,
      });
      setProfileSportsText((nextUser.sports ?? sports).join(', '));
      setProfileNotice('Your profile has been updated.');
      setProfileEditorOpen(false);
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

  const bookingDialogProps = {
    onClose: closeBooking,
    notice,
    noticeRef: successNoticeRef,
    mode: dialogMode,
    setMode: changeDialogMode,
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
    performCancel,
    performRescheduleRequest,
    respondToRequest,
    payForBooking,
    paymentMode,
    stripeTestMode,
    paymentUnavailableReason,
    canRetryPayments: canUsePayments,
    retryPaymentCapabilities: () => void refreshPaymentCapabilities(),
    paymentOutcome: bookingPaymentOutcome,
    setPaymentOutcome: setBookingPaymentOutcome,
    retrySlots: () => setSlotsVersion((value) => value + 1),
    nowMs,
    canUseCommerce,
    canUseChat: canUseDirectChat,
    onOpenChat: (bookingId: string) => void openChatForBooking(bookingId),
  };

  if (authLoading) {
    return (
      <main className="min-h-screen bg-[#f6f7f4] text-[#1c3029]">
        <LoadingScreen text="Opening your student account…" />
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
              title={authError ? 'We couldn’t open your account' : 'Sign in to your student account'}
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

  if (!isStudentSession(session)) {
    return (
      <main className="min-h-screen bg-[#f6f7f4] px-5 py-12 text-[#1c3029]">
        <div className="mx-auto max-w-lg">
          <CourtlyLogo />
          <div className="mt-16">
            <EmptyState
              icon={<UserRound size={23} />}
              title="Student account required"
              action={
                <div className="space-y-3">
                  <button type="button" className={primaryButton} disabled={signingOut} onClick={() => void signOut()}>
                    {signingOut && <LoaderCircle size={15} className="animate-spin" />}
                    Sign out and switch account
                  </button>
                  {signOutError && <p role="alert" className="text-xs text-[#8b4d3c]">{signOutError}</p>}
                </div>
              }
            >
              {session.user.email ?? 'This account'} is signed in as a coach or club account. Switch to your student account to view personal bookings.
            </EmptyState>
          </div>
        </div>
      </main>
    );
  }

  const selectedClub = bookClubs.find((club) => club.business.slug === selectedClubSlug);
  const linkedSlugIsNew = !!slug && !bookClubs.some((club) => club.business.slug === slug);
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
    <div className="student-shell min-h-screen overflow-x-clip bg-[#f6f7f4] pb-32 text-[#1c3029] sm:pb-36">
      <a href="#student-main" className="fixed left-3 top-3 z-[70] -translate-y-24 rounded-lg bg-[#174c3c] px-4 py-3 text-sm font-semibold text-white shadow-lg transition focus:translate-y-0">
        Skip to main content
      </a>
      <AppHeader
        userName={session.user.name}
        activeTab={activeTab}
        homeHref={tabHref('home')}
        onOpenProfile={() => selectTab('profile')}
        alertsUnread={unread}
        onOpenAlerts={() => selectTab('alerts')}
        wide={activeTab === 'chat'}
        playerSwitcher={familyPlayersStatus === 'ready' && familyPlayers.length > 0 ? (
          <PlayerSwitcher players={familyPlayers} value={activeChild?.id ?? SELF_PLAYER} onChange={choosePlayer} />
        ) : undefined}
      />
      <BottomNavigation activeTab={activeTab} onChange={selectTab} unread={chatUnread} />
      <main
        id="student-main"
        ref={mainRef}
        tabIndex={-1}
        className={cn(
          'student-content mx-auto w-full px-4 py-7 outline-none sm:px-6 sm:py-10',
          activeTab === 'chat' ? 'max-w-5xl' : 'max-w-3xl',
        )}
      >
        {bookingNavigationStatus && <p role="status" className="sr-only">{bookingNavigationStatus}</p>}
        {checkoutReturnStatus && (
          <div
            role={checkoutReturnStatus.error ? 'alert' : 'status'}
            className={cn(
              'mb-6 rounded-xl border p-4 text-sm',
              checkoutReturnStatus.error
                ? 'border-[#ecd5cc] bg-[#fbefeb] text-[#8b4d3c]'
                : 'border-[#d8e4cb] bg-[#edf5e4] text-[#4f6847]',
            )}
          >
            {checkoutReturnStatus.message}
          </div>
        )}
        {bookingsError && !childViewActive && (
          <div className="mb-6 space-y-3">
            <ErrorNotice message={bookingsError} />
            <button type="button" className={secondaryButton} onClick={() => void refreshBookings()}>
              <RefreshCw size={14} /> Try bookings again
            </button>
          </div>
        )}

        {playerResolution.status === 'loading' && <LoadingScreen text="Opening the player view…" />}
        {activeChild && (
          <ChildPlayerView
            key={activeChild.id}
            child={activeChild}
            userId={session.user.id}
            nowMs={nowMs}
            todayKey={todayKey}
            segment={activeTab === 'progress' ? 'progress' : 'schedule'}
            onSegment={changeChildSegment}
            onBook={() => bookForChild(activeChild)}
            onExit={() => {
              choosePlayer(SELF_PLAYER);
              window.requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
            }}
          />
        )}

        {activeTab === 'home' && !childViewActive && (
          <section id="student-home-panel" data-tour="student-home" aria-label="Home" className="student-tab-panel student-tab-home">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">
                  Good to see you, {session.user.name.split(/\s+/)[0]}
                </p>
                <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">
                  My bookings
                </h1>
                <p className="mt-2 text-sm text-[#59675c]">Every club, one calm place.</p>
              </div>
              {clubs.length > 0 && canUseCommerce && (
                <button type="button" className={secondaryButton} onClick={() => selectTab('book')}>
                  <Plus size={15} /> Book a session
                </button>
              )}
            </div>

            {clubs.length > 0 && (
              <div data-tour="student-clubs" className="-mx-4 mt-7 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" aria-label="Your clubs">
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

            {notice && !actionBooking && (
              <SuccessNotice message={notice} noticeRef={successNoticeRef} className="mt-6" />
            )}

            <WaitlistPanel
              enabled={canUseCommerce}
              nowMs={nowMs}
              packages={packages}
              canUsePackages={canUseCommerce}
              reloadKey={waitlistReload}
              onBooked={() => {
                void refreshBookings();
                void refreshPackages();
                void refreshNotifications();
              }}
            />

            {bookingsLoading ? (
              <LoadingScreen text="Gathering your sessions…" />
            ) : bookings.length === 0 && !bookingsError ? (
              <div className="mt-8">
                {slug && canUseCommerce ? (
                  <EmptyState
                    icon={<CalendarDays size={23} />}
                    title="Book your first session with this club"
                    action={
                      <div className="flex flex-wrap justify-center gap-2.5">
                        <Link href={`/book/${encodeURIComponent(slug)}`} className={primaryButton}>
                          Open booking page <ArrowRight size={15} />
                        </Link>
                        {canFindTime && (
                          <button type="button" className={secondaryButton} onClick={() => goToSection('explore', 'student-find-time-heading')}>
                            <Search size={15} aria-hidden="true" /> Find a time at any club
                          </button>
                        )}
                      </div>
                    }
                  >
                    Choose a session on the club’s booking page. It will appear here after you book.
                  </EmptyState>
                ) : canUseCommerce ? (
                  <EmptyState
                    icon={<CalendarDays size={23} />}
                    title="Find your first session"
                    action={
                      <div className="space-y-5">
                        <div className="flex flex-wrap justify-center gap-2.5">
                          {canFindTime && (
                            <button type="button" className={primaryButton} onClick={() => goToSection('explore', 'student-find-time-heading')}>
                              <Search size={15} aria-hidden="true" /> Find a time
                            </button>
                          )}
                          <button type="button" className={canFindTime ? secondaryButton : primaryButton} onClick={() => selectTab('explore')}>
                            <Compass size={15} aria-hidden="true" /> Explore clubs
                          </button>
                        </div>
                        <details className="mx-auto max-w-md rounded-xl border border-[#e4e9df] px-4 py-3 text-left">
                          <summary className="min-h-8 cursor-pointer text-xs font-semibold text-[#344d40]">Have a booking link from your club?</summary>
                          <div className="mt-3"><BookingLinkForm id="student-home-booking-link" /></div>
                        </details>
                      </div>
                    }
                  >
                    Search open times across every club, or browse clubs, coaches and venues. Sessions you book appear here.
                  </EmptyState>
                ) : (
                  <EmptyState icon={<CalendarDays size={23} />} title="No sessions yet">
                    Guardian booking and commerce for children are not available.
                  </EmptyState>
                )}
              </div>
            ) : (
              <div data-tour="student-bookings" className="mt-8 space-y-10">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-[#59675c]">
                    {upcoming.length} upcoming · {history.length} in your history
                  </p>
                  <div data-tour="student-view-toggle" role="group" aria-label="Show bookings as" className="inline-flex gap-1 rounded-xl bg-[#eaf0e5] p-1">
                    {(['list', 'calendar'] as const).map((view) => (
                      <button
                        key={view}
                        type="button"
                        aria-pressed={homeView === view}
                        onClick={() => chooseHomeView(view)}
                        className={cn(
                          'inline-flex min-h-10 items-center gap-1.5 rounded-lg px-4 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]',
                          homeView === view ? 'bg-white text-[#174c3c] shadow-sm' : 'text-[#59675c] hover:bg-white/60',
                        )}
                      >
                        {view === 'list' ? <ListIcon size={14} aria-hidden="true" /> : <CalendarDays size={14} aria-hidden="true" />}
                        {view === 'list' ? 'List' : 'Calendar'}
                      </button>
                    ))}
                  </div>
                </div>

                {homeView === 'calendar' ? (
                  <section aria-labelledby="student-calendar-heading">
                    <div className="mb-4">
                      <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]">Month view</p>
                      <h2 id="student-calendar-heading" className="mt-1 text-xl font-semibold tracking-tight">Calendar</h2>
                    </div>
                    <BookingCalendar
                      idPrefix="student-calendar"
                      label="Your booking calendar"
                      events={calendarEvents}
                      todayKey={todayKey}
                      onOpen={(event) => openBooking(event.id)}
                      emptyDayAction={canFindTime ? (
                        <button type="button" className={compactButton} onClick={() => goToSection('explore', 'student-find-time-heading')}>
                          <Search size={13} aria-hidden="true" /> Find a time
                        </button>
                      ) : undefined}
                    />
                  </section>
                ) : (
                  <>
                    {current.length > 0 && (
                      <section aria-labelledby="current-bookings">
                        <div className="mb-4 flex items-end justify-between gap-4">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#174c3c]">
                              Happening now
                            </p>
                            <h2 id="current-bookings" className="mt-1 text-xl font-semibold tracking-tight">
                              In progress
                            </h2>
                          </div>
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#174c3c]">
                            <span className="h-2 w-2 animate-pulse rounded-full bg-[#5c9278]" /> Live
                          </span>
                        </div>
                        <div className="space-y-3">
                          {current.map((item) => (
                            <BookingRow key={item.participant.id} item={item} nowMs={nowMs} onOpen={openBookingRow} />
                          ))}
                        </div>
                      </section>
                    )}
                    {upcoming.length > 0 && (
                      <section aria-labelledby="upcoming-bookings">
                        <div className="mb-4 flex items-end justify-between gap-4">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]">
                              Next up
                            </p>
                            <h2 id="upcoming-bookings" className="mt-1 text-xl font-semibold tracking-tight">
                              Upcoming sessions
                            </h2>
                          </div>
                          <span className="text-xs text-[#59675c]">
                            {upcoming.length} booking{upcoming.length === 1 ? '' : 's'}
                          </span>
                        </div>
                        <div className="space-y-3">
                          {prioritizedUpcoming.slice(0, 3).map((item) => (
                            <BookingRow key={item.participant.id} item={item} nowMs={nowMs} onOpen={openBookingRow} />
                          ))}
                        </div>
                        <div id="upcoming-booking-list" hidden={!showAllUpcoming} className="mt-3 space-y-3">
                          {prioritizedUpcoming.slice(3).map((item) => (
                            <BookingRow key={item.participant.id} item={item} nowMs={nowMs} onOpen={openBookingRow} />
                          ))}
                        </div>
                        {prioritizedUpcoming.length > 3 && (
                          <SeeMoreButton
                            expanded={showAllUpcoming}
                            controls="upcoming-booking-list"
                            hiddenCount={prioritizedUpcoming.length - 3}
                            noun="sessions"
                            onToggle={() => setShowAllUpcoming((value) => !value)}
                            className="mt-3 w-full"
                          />
                        )}
                      </section>
                    )}
                    {upcoming.length === 0 && current.length === 0 && canUseCommerce && (
                      <section aria-labelledby="no-upcoming-bookings" className="rounded-2xl border border-dashed border-[#dfe5dc] bg-white px-5 py-6 text-center">
                        <h2 id="no-upcoming-bookings" className="text-base font-semibold text-[#304b39]">Nothing booked yet</h2>
                        <p className="!mt-1 text-xs text-[#59675c]">Book again from your history, or find an open time at any club.</p>
                        <div className="mt-4 flex flex-wrap justify-center gap-2">
                          {canFindTime && (
                            <button type="button" className={compactButton} onClick={() => goToSection('explore', 'student-find-time-heading')}>
                              <Search size={13} aria-hidden="true" /> Find a time
                            </button>
                          )}
                          <button type="button" className={compactButton} onClick={() => selectTab('explore')}>
                            <Compass size={13} aria-hidden="true" /> Explore clubs
                          </button>
                        </div>
                      </section>
                    )}
                    {history.length > 0 && (
                      <section aria-labelledby="booking-history">
                        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]">Past sessions</p>
                            <h2 id="booking-history" className="!mt-1 text-xl font-semibold tracking-tight">History</h2>
                          </div>
                          <SeeMoreButton
                            expanded={showHomeHistory}
                            controls="home-booking-history-list"
                            hiddenCount={history.length}
                            noun="sessions"
                            onToggle={() => setShowHomeHistory((value) => !value)}
                          />
                        </div>
                        <div id="home-booking-history-list" hidden={!showHomeHistory} className="space-y-3">
                            {history.map((item) => (
                              <BookingRow key={item.participant.id} item={item} nowMs={nowMs} onOpen={openBookingRow} canBookAgain={canUseCommerce} />
                            ))}
                        </div>
                      </section>
                    )}
                  </>
                )}
                <section aria-labelledby="recent-activity">
                  <div className="mb-4 flex items-end justify-between gap-4">
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]">
                        In your orbit
                      </p>
                      <h2 id="recent-activity" className="mt-1 text-xl font-semibold tracking-tight">
                        Recent activity
                      </h2>
                    </div>
                    <button type="button" onClick={() => selectTab('alerts')} className="min-h-10 text-xs font-semibold text-[#174c3c]">
                      See all
                    </button>
                  </div>
                  <div className={cn(panel, 'divide-y divide-[#edf0e9] overflow-hidden')}>
                    {(visibleNotifications.length ? visibleNotifications : fallbackActivity).slice(0, 3).map((item) => {
                      const appearance = alertAppearance(item);
                      const Icon = appearance.icon;
                      return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => openAlertDetails(item)}
                        className={cn(
                          'flex w-full items-start gap-3 p-4 text-left transition hover:bg-[#fafbf7] sm:p-5',
                          !item.read && 'bg-[#f8faf4]',
                        )}
                      >
                        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full', appearance.tone)}>
                          <Icon size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-[#344c3b]">{item.title}</span>
                          <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-[#59675c]">{item.message}</span>
                        </span>
                        <ChevronRight size={15} className="mt-1 shrink-0 text-[#59675c]" aria-hidden="true" />
                      </button>
                      );
                    })}
                    {visibleNotifications.length === 0 && fallbackActivity.length === 0 && (
                      <p className="p-7 text-center text-sm text-[#59675c]">
                        Your booking activity will collect here.
                      </p>
                    )}
                  </div>
                  {fallbackActivity.length > 0 && (notificationsFallback || visibleNotifications.length === 0) && (
                    <p className="mt-2 text-[10px] text-[#59675c]">Based on the current status of your bookings.</p>
                  )}
                </section>
              </div>
            )}

            <ProgressCard
              summary={homeProgress}
              loading={homeProgressLoading}
              onOpen={() => selectTab('progress')}
              emptyAction={canFindTime ? (
                <button type="button" className={compactButton} onClick={() => goToSection('explore', 'student-find-time-heading')}>
                  <Search size={14} aria-hidden="true" /> Find a time
                </button>
              ) : undefined}
            />

            {canUseCommerce && <HomePackageSummary
              loading={packagesLoading}
              error={packagesError}
              packages={activePackages}
              nowMs={nowMs}
              onOpen={() => { setPackagesExpanded(true); selectTab('profile'); }}
              onViewActivity={openPackageActivity}
              onBuyAnother={buyAnotherPackage}
              emptyAction={
                <button type="button" className={compactButton} onClick={() => selectTab('explore')}>
                  <Compass size={14} aria-hidden="true" /> Explore clubs
                </button>
              }
            />}
          </section>
        )}

        {activeTab === 'explore' && (
          <section id="student-explore-panel" aria-label="Explore" className="student-tab-panel student-tab-explore">
            <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">Find your court</p>
            <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">Explore</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#59675c]">
              Find coaching, reserve a venue, or look up people across Courtly.
            </p>
            <div role="tablist" aria-label="Explore marketplace" aria-orientation="horizontal" className={cn('mt-6 grid gap-2 rounded-2xl bg-[#eaf0e5] p-1.5', canUseRentals ? 'grid-cols-2' : 'grid-cols-1')}>
              {([['classes', 'Classes/clubs'], ...(canUseRentals ? [['rentals', 'Venue rentals'] as const] : [])] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`student-explore-${value}-tab`}
                  aria-selected={exploreSegment === value}
                  aria-controls={`student-${value}-marketplace`}
                  tabIndex={exploreSegment === value ? 0 : -1}
                  onClick={() => setExploreSegment(value)}
                  onKeyDown={(event) => {
                    const next = !canUseRentals
                      ? event.key === 'Home' || event.key === 'End' ? 'classes' : null
                      : event.key === 'Home'
                      ? 'classes'
                      : event.key === 'End'
                        ? 'rentals'
                        : event.key === 'ArrowRight' || event.key === 'ArrowLeft'
                          ? value === 'classes' ? 'rentals' : 'classes'
                          : null;
                    if (!next) return;
                    event.preventDefault();
                    setExploreSegment(next);
                    document.getElementById(`student-explore-${next}-tab`)?.focus();
                  }}
                  className={cn(
                    'min-h-11 rounded-xl px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]',
                    exploreSegment === value ? 'bg-white text-[#174c3c] shadow-sm' : 'text-[#59675c] hover:bg-white/60',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {canSearchPeople && <Disclosure
              title="Find people"
              summary="Search players, coaches, and clubs."
              className="mt-5"
            ><section aria-labelledby="student-people-search-title">
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#eef3e8] text-[#4f6847]"><UsersRound size={18} /></span>
                <div>
                  <h2 id="student-people-search-title" className="text-sm font-semibold text-[#304b39]">Find people</h2>
                  <p className="!mt-1 text-xs text-[#59675c]">Use a name, username, or exact email.</p>
                </div>
              </div>
              <form onSubmit={submitPeopleSearch} className="mt-4 flex flex-col gap-2 sm:flex-row">
                <label htmlFor="student-people-search" className="sr-only">Search all Courtly accounts</label>
                <input id="student-people-search" type="search" value={peopleQuery} onChange={(event) => { setPeopleQuery(event.target.value); setPeople([]); setPeopleSearchedFor(''); setPeopleError(''); }} placeholder="Name, @username, or exact email" className={cn(field, 'min-w-0 flex-1')} />
                <button type="submit" className={primaryButton} disabled={peopleLoading}>
                  {peopleLoading ? <LoaderCircle size={15} className="animate-spin" /> : <Search size={15} />} Search people
                </button>
              </form>
              {peopleError && <p role="alert" className="mt-3 text-xs text-[#8b4d3c]">{peopleError}</p>}
              {!peopleLoading && !peopleError && !!peopleSearchedFor && people.length === 0 && (
                <p role="status" className="mt-3 text-xs text-[#59675c]">No accounts matched “{peopleSearchedFor}”.</p>
              )}
              {people.length > 0 && (
                <ul aria-label="Account search results" className="mt-4 grid gap-2 sm:grid-cols-2">
                  {people.map((person) => (
                    <li key={person.username} className="min-w-0 rounded-xl border border-[#e4e9df] bg-[#fafbf8] p-3">
                      <div className="flex items-start gap-2.5">
                        <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#e8efe0] text-[11px] font-bold text-[#4f6847]">{initials(person.name)}</span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[#304b39]">{person.name}</p>
                          <p className="truncate text-xs text-[#59675c]">@{person.username} · {person.accountType.toLowerCase()}</p>
                          {person.sports.length > 0 && <p className="truncate text-[11px] text-[#59675c]">{person.sports.join(', ')}</p>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section></Disclosure>}

            {exploreSegment === 'classes' ? (
              <div id="student-classes-marketplace" role="tabpanel" aria-labelledby="student-explore-classes-tab">
            {canUseCommerce && bookingsReady && linkedSlugIsNew && (
              <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-[#dfe7d8] bg-[#f0f5ea] p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-[#3d5a41]">A club invited you to book</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#59675c]">Open its live booking page from the link you followed.</p>
                </div>
                <Link href={`/book/${encodeURIComponent(slug!)}`} className={cn(primaryButton, 'shrink-0')}>
                  Open booking page <ArrowRight size={15} />
                </Link>
              </div>
            )}

            {canFindTime && <FindATime userId={session.user.id} todayKey={dateKey(new Date(nowMs))} sports={clubSports} />}

            {clubDirectoryError && exploreClubs.length > 0 && (
              <div className="mt-6 space-y-3">
                <ErrorNotice message={`We couldn’t load every club. ${clubDirectoryError}`} />
                <button type="button" className={secondaryButton} onClick={() => void refreshClubDirectory()}>
                  <RefreshCw size={14} /> Try club directory again
                </button>
              </div>
            )}

            <div className={cn(panel, 'mt-7 p-4 sm:p-5')}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="student-club-search" className="text-xs font-semibold text-[#465e4c]">
                    Search clubs
                  </label>
                  <div className="relative mt-2">
                    <Search aria-hidden="true" size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#647469]" />
                    <input
                      id="student-club-search"
                      type="search"
                      value={clubSearch}
                      onChange={(event) => setClubSearch(event.target.value)}
                      placeholder="Club name, owner, or sport"
                      className={cn(field, 'w-full !pl-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]')}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="student-club-select" className="text-xs font-semibold text-[#465e4c]">
                    Club
                  </label>
                  <select
                    id="student-club-select"
                    value={clubSlug}
                    onChange={(event) => setClubSlug(event.target.value)}
                    className={cn(field, 'mt-2 w-full bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a]')}
                  >
                    <option value="">All clubs</option>
                    {exploreClubs.map((club) => (
                      <option key={club.business.slug} value={club.business.slug}>{club.business.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <Disclosure title="More club filters" summary="Relationship or sport" className="mt-4">
              <fieldset>
                <legend className="text-xs font-semibold text-[#465e4c]">Relationship</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {([
                    ['all', 'All clubs'],
                    ['known', 'Your clubs'],
                    ['discover', 'Discover'],
                    ...(favoritesAvailable ? [['saved', 'Saved'] as const] : []),
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={clubRelationship === value}
                      onClick={() => setClubRelationship(value)}
                      className={cn(
                        'min-h-10 rounded-full border px-4 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2',
                        clubRelationship === value
                          ? 'border-[#174c3c] bg-[#174c3c] text-white'
                          : 'border-[#d8e1d5] bg-white text-[#496353] hover:bg-[#f3f6f1]',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </fieldset>

              {clubSports.length > 0 && (
                <fieldset className="mt-5">
                  <legend className="text-xs font-semibold text-[#465e4c]">Sport</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      aria-pressed={!clubSport}
                      onClick={() => setClubSport('')}
                      className={cn(
                        'min-h-10 rounded-full border px-4 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2',
                        !clubSport ? 'border-[#55734d] bg-[#e8f0df] text-[#34533e]' : 'border-[#d8e1d5] bg-white text-[#496353] hover:bg-[#f3f6f1]',
                      )}
                    >
                      All sports
                    </button>
                    {clubSports.map((sport) => (
                      <button
                        key={sport.key}
                        type="button"
                        aria-pressed={clubSport === sport.key}
                        onClick={() => setClubSport(sport.key)}
                        className={cn(
                          'min-h-10 rounded-full border px-4 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#327a5a] focus-visible:ring-offset-2',
                          clubSport === sport.key
                            ? 'border-[#55734d] bg-[#e8f0df] text-[#34533e]'
                            : 'border-[#d8e1d5] bg-white text-[#496353] hover:bg-[#f3f6f1]',
                        )}
                      >
                        {sport.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              </Disclosure>
            </div>

            <p role="status" aria-live="polite" className="mt-5 text-xs font-medium text-[#59675c]">
              {exploreLoading
                ? 'Loading clubs…'
                : `${filteredExploreClubs.length} club${filteredExploreClubs.length === 1 ? '' : 's'} found`}
            </p>
            {favoriteStatus && <p role="status" className="!mt-1 text-xs text-[#59675c]">{favoriteStatus}</p>}

            {exploreLoading ? (
              <LoadingScreen text="Finding clubs…" />
            ) : exploreClubs.length === 0 ? (
              <div className="mt-6">
                <EmptyState
                  icon={<Compass size={23} />}
                  title={clubDirectoryError ? 'Your club directory is temporarily unavailable' : 'No clubs are available yet'}
                  action={
                    clubDirectoryError ? (
                      <button type="button" className={primaryButton} onClick={() => void refreshClubDirectory()}>
                        <RefreshCw size={14} /> Try again
                      </button>
                    ) : undefined
                  }
                >
                  {clubDirectoryError
                    ? 'Your bookings are still available. Try loading the directory again when you are ready.'
                    : 'Come back soon as more bookable clubs join Courtly.'}
                </EmptyState>
              </div>
            ) : filteredExploreClubs.length === 0 && clubRelationship === 'saved' && favorites.size === 0 ? (
              <div className="mt-6">
                <EmptyState
                  icon={<Heart size={23} />}
                  title="No saved clubs yet"
                  action={
                    <button type="button" className={secondaryButton} onClick={() => setClubRelationship('all')}>
                      Browse all clubs
                    </button>
                  }
                >
                  Tap the heart on any club to keep it here for quick booking.
                </EmptyState>
              </div>
            ) : filteredExploreClubs.length === 0 ? (
              <div className="mt-6">
                <EmptyState
                  icon={<Search size={23} />}
                  title="No clubs match these filters"
                  action={
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => {
                        setClubSearch('');
                        setClubSport('');
                        setClubSlug('');
                        setClubRelationship('all');
                      }}
                    >
                      Clear all filters
                    </button>
                  }
                >
                  Try another club name or sport, or clear the filters to see the full directory.
                </EmptyState>
              </div>
            ) : (
              <div className="mt-7 space-y-10">
                {filteredKnownClubs.length > 0 && (
                  <section aria-labelledby="student-known-clubs">
                    <div className="mb-4 flex items-end justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#174c3c]">Welcome back</p>
                        <h2 id="student-known-clubs" className="mt-1 text-xl font-semibold tracking-tight">Your clubs</h2>
                      </div>
                      <span className="text-xs text-[#59675c]">{filteredKnownClubs.length} shown</span>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {filteredKnownClubs.map((club) => <ExploreClubCard key={club.business.slug} club={club} canBook={canUseCommerce} onViewPackages={canUseCommerce ? openPackageOffers : undefined} saved={favoritesAvailable ? favorites.has(club.business.slug) : undefined} onToggleSaved={toggleSavedClub} />)}
                    </div>
                  </section>
                )}
                {filteredDiscoveryClubs.length > 0 && (
                  <section aria-labelledby="student-discover-clubs">
                    <div className="mb-4 flex items-end justify-between gap-4">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]">Try somewhere new</p>
                        <h2 id="student-discover-clubs" className="mt-1 text-xl font-semibold tracking-tight">Discover new clubs</h2>
                      </div>
                      <span className="text-xs text-[#59675c]">{filteredDiscoveryClubs.length} shown</span>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      {filteredDiscoveryClubs.map((club) => <ExploreClubCard key={club.business.slug} club={club} canBook={canUseCommerce} onViewPackages={canUseCommerce ? openPackageOffers : undefined} saved={favoritesAvailable ? favorites.has(club.business.slug) : undefined} onToggleSaved={toggleSavedClub} />)}
                    </div>
                  </section>
                )}
              </div>
            )}
              </div>
            ) : canUseRentals ? (
              <div id="student-rentals-marketplace" role="tabpanel" aria-labelledby="student-explore-rentals-tab" className="mt-7">
                <AccountRentalHistory
                  refreshToken={rentalHistoryVersion}
                  onCancelled={() => {
                    void refreshPackages();
                    setSelectedRentalSlot(null);
                    setRentalSlotsVersion((value) => value + 1);
                  }}
                />
                <div className={cn(panel, 'p-4 sm:p-5')}>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="student-rental-search" className="text-xs font-semibold text-[#465e4c]">Search rentals</label>
                      <div className="relative mt-2"><Search aria-hidden="true" size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#647469]" /><input id="student-rental-search" type="search" value={rentalSearch} onChange={(event) => setRentalSearch(event.target.value)} placeholder="Venue, address, or amenity" className={cn(field, 'w-full !pl-10')} /></div>
                    </div>
                    <div>
                      <label htmlFor="student-rental-sport" className="text-xs font-semibold text-[#465e4c]">Sport</label>
                      <select id="student-rental-sport" value={rentalSport} onChange={(event) => setRentalSport(event.target.value)} className={cn(field, 'mt-2 w-full bg-white')}>
                        <option value="">All sports</option>
                        {rentalSports.map((sport) => <option key={sport.key} value={sport.key}>{sport.label}</option>)}
                      </select>
                    </div>
                  </div>
                  {rentalPackageFilterId && (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#edf5e4] p-3 text-xs text-[#4f6847]">
                      <span>Showing rentals eligible for {packages.find((pkg) => pkg.id === rentalPackageFilterId)?.name ?? 'your package'}.</span>
                      <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setRentalPackageFilterId('')}>Clear package filter</button>
                    </div>
                  )}
                </div>
                <p role="status" aria-live="polite" className="mt-5 text-xs font-medium text-[#59675c]">{rentalsLoading ? 'Loading rentals…' : `${filteredRentals.length} rental${filteredRentals.length === 1 ? '' : 's'} found`}</p>
                {rentalsError && <div className="mt-5 space-y-3"><ErrorNotice message={rentalsError} /><button type="button" className={secondaryButton} onClick={() => void refreshRentals()}><RefreshCw size={14} /> Try rentals again</button></div>}
                {rentalsLoading ? <LoadingScreen text="Finding venues…" /> : filteredRentals.length ? (
                  <div className="mt-6 grid gap-4 sm:grid-cols-2">{filteredRentals.map((rental) => <RentalCard key={rental.id} rental={rental} onViewPackages={canUseCommerce ? (value) => openPackageOffers({ business: { ...value.club, currency: value.currency } }) : undefined} onOpen={(value) => { setRentalDetail(null); setRentalNotice(''); setRentalError(''); setSelectedRentalPackageId(rentalPackageFilterId); setOpenRentalId(value.id); }} />)}</div>
                ) : !rentalsError && (
                  <div className="mt-6"><EmptyState icon={<MapPin size={23} />} title={rentals.length ? 'No rentals match these filters' : 'No venue rentals are available yet'} action={rentals.length ? <button type="button" className={secondaryButton} onClick={() => { setRentalSearch(''); setRentalSport(''); setRentalPackageFilterId(''); }}>Clear rental filters</button> : undefined}>{rentals.length ? 'Try another venue, amenity, or sport.' : 'Come back soon as clubs make courts available.'}</EmptyState></div>
                )}
              </div>
            ) : null}
          </section>
        )}

        {activeTab === 'book' && (
          <section id="student-book-panel" aria-label="Book" className="student-tab-panel student-tab-book">
            <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">Make time to play</p>
            <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">
              Book a session
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#59675c]">
              Choose any available club, then continue to its live classes, coaches, and times.
            </p>
            <p role="status" aria-live="polite" className="sr-only">
              {exploreLoading
                ? 'Loading bookable clubs.'
                : clubDirectoryError && bookClubs.length === 0
                  ? 'The club directory could not be loaded.'
                  : `${bookClubs.length} bookable club${bookClubs.length === 1 ? '' : 's'} found.`}
            </p>
            {bookingForName && canUseCommerce && (
              <div role="status" className="mt-6 flex gap-2.5 rounded-2xl border border-[#dfe7d8] bg-[#f0f5ea] p-4 text-xs leading-relaxed text-[#3d5a41]">
                <UsersRound size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                <p>Booking for {bookingForName}? Choose a club below, then pick {bookingForName} as the player on its booking page.</p>
              </div>
            )}
            {canUseCommerce && linkedSlugIsNew && (
              <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-[#dfe7d8] bg-[#f0f5ea] p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-[#3d5a41]">Book with the club that sent you here</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#59675c]">Its identity is confirmed on the booking page before you choose a lesson.</p>
                </div>
                <Link href={`/book/${encodeURIComponent(slug!)}`} className={cn(primaryButton, 'shrink-0')}>
                  Continue <ArrowRight size={15} />
                </Link>
              </div>
            )}
            {!canUseCommerce ? (
              <div className="mt-8"><EmptyState icon={<ShieldCheck size={23} />} title="Booking is unavailable for this account">Guardian booking and commerce for children are not available.</EmptyState></div>
            ) : exploreLoading ? (
              <LoadingScreen text="Finding clubs you can book…" />
            ) : clubDirectoryError && bookClubs.length === 0 ? (
              <div className="mt-8">
                <EmptyState
                  icon={<RefreshCw size={23} />}
                  title="Club directory unavailable"
                  action={
                    <div className="space-y-4"><button type="button" className={secondaryButton} onClick={() => void refreshClubDirectory()}><RefreshCw size={14} />Try directory again</button><BookingLinkForm id="student-book-booking-link" /></div>
                  }
                >
                  {clubDirectoryError} You can still open a booking link a club shared with you.
                </EmptyState>
              </div>
            ) : bookClubs.length === 0 ? (
              <div className="mt-8"><EmptyState icon={<Compass size={23} />} title="No clubs are bookable yet" action={canFindTime ? <button type="button" className={secondaryButton} onClick={() => goToSection('explore', 'student-find-time-heading')}><Search size={15} aria-hidden="true" /> Find a time</button> : undefined}>Clubs appear here as soon as they publish a class with a coach, venue, and availability.</EmptyState></div>
            ) : (
              <div className="mt-8">
                <fieldset>
                  <legend className="mb-3 text-xs font-semibold text-[#566b5a]">Choose from {bookClubs.length} bookable club{bookClubs.length === 1 ? '' : 's'}</legend>
                  <div className="space-y-3">
                    {bookClubs.map((club) => {
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
                            name="student-booking-club"
                            value={club.business.slug}
                            checked={selected}
                            onChange={() => setSelectedClubSlug(club.business.slug)}
                            className="sr-only"
                          />
                          <ClubAvatar club={club} size="small" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-semibold text-[#304a39]">{club.business.name}</span>
                            <span className="mt-1 block text-xs text-[#59675c]">{club.directory ? `${club.directory.sports.join(', ') || 'Multi-sport'} · ${club.directory.serviceCount} class${club.directory.serviceCount === 1 ? '' : 'es'} · from ${money(club.directory.priceFrom, club.business.currency)}` : `${club.known?.bookingCount ?? 0} past or upcoming booking${club.known?.bookingCount === 1 ? '' : 's'}`}</span>
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
                <p className="mt-4 text-center text-[10px] leading-relaxed text-[#59675c]">
                  Classes, coaches, and times are shown on the club’s live booking page.
                </p>
              </div>
            )}
          </section>
        )}

        {activeTab === 'chat' && canUseDirectChat && (
          <section id="student-chat-panel" aria-label="Chat" className="student-tab-panel student-tab-chat">
            <ChatInbox
              mode="participant"
              viewerType="STUDENT"
              viewerUsername={session.user.username}
              threadId={chatThreadId}
              onThreadChange={selectChatThread}
              beginUnreadRequest={beginUnreadRequest}
              commitUnreadNow={commitUnreadNow}
              onOpenBooking={(bookingId) => void openBookingFromChat(bookingId)}
              onBookingsChanged={() => { void refreshBookings(); void refreshNotifications(); }}
              className="sm:h-[calc(100dvh-260px)] sm:min-h-[460px]"
              heading={{
                eyebrow: 'Your conversations',
                title: 'Chats',
                description: 'Message coaches and clubs, or use + in a schedulable conversation to propose a session.',
              }}
            />
          </section>
        )}

        {activeTab === 'chat' && !canUseDirectChat && (
          <section aria-label="Chat unavailable" className={cn(panel, 'p-8 text-center')}><ShieldCheck size={23} className="mx-auto text-[#71865f]" /><h1 className="mt-4 text-xl font-semibold">Chat is unavailable for this account</h1><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#59675c]">Courtly applies this restriction from the account policy returned by the server.</p></section>
        )}

        {activeTab === 'progress' && !childViewActive && (
          <section id="student-progress-panel" aria-label="Progress" className="student-tab-panel student-tab-progress">
            <ProgressView
              idPrefix="student-progress"
              eyebrowText="Your training"
              title="Progress"
              description="What you have attended across every club, and the notes your coaches have shared."
              load={loadAccountProgress}
              serverFilters
              markViewed={markFeedbackViewed}
              backAction={
                <button type="button" onClick={() => selectTab('home')} className="mb-4 inline-flex min-h-10 items-center gap-1 text-xs font-semibold text-[#174c3c]">
                  <ArrowRight size={13} aria-hidden="true" className="rotate-180" /> Back to Home
                </button>
              }
              emptyAction={canFindTime ? (
                <button type="button" className={secondaryButton} onClick={() => goToSection('explore', 'student-find-time-heading')}>
                  <Search size={15} aria-hidden="true" /> Find a time
                </button>
              ) : undefined}
            />
          </section>
        )}

        {activeTab === 'alerts' && (
          <section id="student-alerts-panel" aria-label="Alerts" className="student-tab-panel student-tab-alerts">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">Stay in the loop</p>
                <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">Alerts</h1>
                <p className="mt-2 text-sm text-[#59675c]">Booking updates from the clubs you know.</p>
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
                className="mt-6 flex items-center gap-2 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#4f6847]"
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
              <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-[#e6e3d4] bg-[#fbfaf2] p-4 text-xs leading-relaxed text-[#70582e]">
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
                <EmptyState
                  icon={<CheckCheck size={23} />}
                  title="You’re all caught up"
                  action={canFindTime ? (
                    <button type="button" className={secondaryButton} onClick={() => goToSection('explore', 'student-find-time-heading')}>
                      <Search size={15} aria-hidden="true" /> Find a time
                    </button>
                  ) : undefined}
                >
                  Booking confirmations, changes, coach feedback, waitlist offers and package reminders will appear here.
                </EmptyState>
              </div>
            ) : (
              <>
                <div className={cn(panel, 'mt-8 divide-y divide-[#edf0e9] overflow-hidden')}>
                  {shownNotifications.map((item) => {
                    const appearance = alertAppearance(item);
                    const Icon = appearance.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => openAlertDetails(item)}
                        aria-label={`${item.read ? 'Read' : 'Unread'} alert: ${item.title}`}
                        className={cn(
                          'flex w-full items-start gap-3 p-4 text-left transition hover:bg-[#fafbf7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#327a5a] sm:p-5',
                          // Unread alerts keep a soft wash until they are
                          // opened, the way an unread thread does.
                          !item.read && 'bg-[#f5f9ef]',
                        )}
                      >
                        <span className={cn('relative grid h-10 w-10 shrink-0 place-items-center rounded-full', appearance.tone)}>
                          <Icon size={17} strokeWidth={1.7} />
                          {!item.read && (
                            <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-[#8b4d3c]" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className={cn('text-sm text-[#314a39]', item.read ? 'font-medium' : 'font-semibold')}>
                              {item.title}
                            </span>
                            {item.actionNeeded && (
                              <span className="rounded-full bg-[#f8eed3] px-2 py-0.5 text-[9px] font-semibold text-[#70582e]">
                                Action needed
                              </span>
                            )}
                          </span>
                          <span className="mt-1.5 line-clamp-1 block text-xs leading-relaxed text-[#59675c]">
                            {item.message}
                          </span>
                          {item.createdAt && (
                            <span className="mt-1.5 block text-[10px] text-[#59675c]">
                              {appearance.label} ·{' '}
                              {shortDate(
                                item.createdAt,
                                clubs.find((club) => club.business.slug === item.businessSlug)?.business.timezone,
                              )}
                            </span>
                          )}
                        </span>
                        <ChevronRight size={16} className="mt-1 shrink-0 text-[#59675c]" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                {visibleNotifications.length > shownNotifications.length && (
                  <button
                    type="button"
                    className={cn(secondaryButton, 'mt-4 w-full')}
                    onClick={() => setShowAllAlerts(true)}
                  >
                    Show all {visibleNotifications.length} alerts
                  </button>
                )}
                {showAllAlerts && visibleNotifications.length > alertPageSize && (
                  <button
                    type="button"
                    className={cn(secondaryButton, 'mt-4 w-full')}
                    onClick={() => setShowAllAlerts(false)}
                  >
                    Show fewer
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {activeTab === 'profile' && (
          <section id="student-profile-panel" aria-label="Profile" className="student-tab-panel student-tab-profile">
            <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">Your student account</p>
            <h1 className="mt-1.5 text-[30px] font-medium tracking-[-1px] text-[#20382d] sm:text-[36px]">Profile</h1>
            <p className="mt-2 text-sm text-[#59675c]">Keep your details current across every club.</p>
            {session.user.emailVerified === false && <div className="mt-6"><EmailVerificationNotice email={session.user.email} /></div>}
            {session.user.accountControl !== 'GUARDIAN_MANAGED' && <section className={cn(panel, 'mt-6 p-5 sm:p-6')} aria-labelledby="student-security-heading"><div className="flex items-start gap-3"><ShieldCheck size={19} className="mt-0.5 shrink-0 text-[#66805a]" /><div className="min-w-0 flex-1"><h2 id="student-security-heading" className="text-base font-semibold text-[#304b39]">Account security</h2><p className="mt-1 text-xs leading-relaxed text-[#59675c]">Manage your sign-in email, authenticator, recovery codes, and active devices.</p></div></div><Link href="/account/security" className={cn(secondaryButton, 'mt-4 w-full sm:w-auto')}>Open security settings<ArrowRight size={14} /></Link></section>}
            {/*
              Personal details read as a record, not a form. People open this
              tab to check what a club sees far more often than to change it,
              and a page of live inputs invites accidental edits. Editing is a
              deliberate step, in a dialog.
            */}
            <section className={cn(panel, 'mt-8 p-5 sm:p-6')} aria-labelledby="student-personal-details">
              <div className="flex items-start gap-3 border-b border-[#edf0e9] pb-5">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#e8efe0] text-sm font-bold text-[#4f6847]">
                  {initials(profile.name || session.user.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 id="student-personal-details" className="text-base font-semibold text-[#304b39]">Personal details</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#59675c]">Shared only with clubs you book.</p>
                </div>
                {canEditProfile && <button
                  type="button"
                  className={cn(secondaryButton, '!min-h-10 shrink-0 !px-3 !text-xs')}
                  onClick={() => {
                    setProfileError('');
                    setProfileNotice('');
                    setProfile({
                      username: session.user.username ?? '',
                      name: session.user.name ?? '',
                      phone: session.user.phone ?? '',
                      parentName: session.user.parentName ?? '',
                      sports: session.user.sports ?? [],
                    });
                    setProfileSportsText((session.user.sports ?? []).join(', '));
                    setProfileEditorOpen(true);
                  }}
                >
                  <Pencil size={14} /> Edit
                </button>}
              </div>
              <dl className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Username</dt>
                  <dd className="mt-1.5 break-all text-sm text-[#415244]">@{profile.username || session.user.username}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Full name</dt>
                  <dd className="mt-1.5 text-sm text-[#415244]">{profile.name || session.user.name}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Email address</dt>
                  <dd className="mt-1.5 break-all text-sm text-[#415244]">{session.user.email ?? 'No independent sign-in email'}</dd>
                  <dd className="mt-1 text-[10px] text-[#59675c]">{session.user.email ? 'Your sign-in identity; it cannot be changed here.' : 'This profile does not currently have an independent email sign-in.'}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Phone</dt>
                  <dd className={cn('mt-1.5 text-sm', profile.phone ? 'text-[#415244]' : 'text-[#59675c]')}>
                    {profile.phone || 'Not added'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Parent or guardian</dt>
                  <dd className={cn('mt-1.5 text-sm', profile.parentName ? 'text-[#415244]' : 'text-[#59675c]')}>
                    {profile.parentName || 'Not added'}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[10px] font-medium uppercase tracking-wider text-[#59675c]">Sports</dt>
                  <dd className="mt-2 flex flex-wrap gap-1.5">
                    {profile.sports.length ? profile.sports.map((sport) => (
                      <span key={sport.toLowerCase()} className="rounded-full bg-[#edf3e7] px-2.5 py-1 text-[10px] font-semibold text-[#496353]">{sport}</span>
                    )) : <span className="text-sm text-[#59675c]">No sports added</span>}
                  </dd>
                </div>
              </dl>
              {profileNotice && !profileEditorOpen && (
                <div role="status" className="mt-5 flex items-center gap-2 rounded-xl bg-[#edf5e4] p-4 text-sm text-[#4f6847]">
                  <Check size={16} /> {profileNotice}
                </div>
              )}
            </section>

            {canEditProfile && <Dialog
              open={profileEditorOpen}
              onOpenChange={(open) => { if (!profileBusy) setProfileEditorOpen(open); }}
            >
              <DialogContent
                className="max-w-lg"
                onEscapeKeyDown={(event) => { if (profileBusy) event.preventDefault(); }}
                onPointerDownOutside={(event) => { if (profileBusy) event.preventDefault(); }}
              >
                <DialogTitle className="text-xl font-semibold tracking-tight text-[#20382d]">
                  Edit personal details
                </DialogTitle>
                <DialogDescription className="mt-2 text-xs leading-relaxed text-[#59675c]">
                  These details belong to your student account and travel with you to every club you book.
                </DialogDescription>
                <form onSubmit={saveProfile} className="mt-5">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <label htmlFor="student-profile-username">Username</label>
                      <input
                        id="student-profile-username"
                        className={field}
                        value={profile.username}
                        onChange={(event) => {
                          setProfile((current) => ({ ...current, username: event.target.value.toLowerCase() }));
                          setProfileError('');
                        }}
                        required
                        minLength={3}
                        maxLength={30}
                        pattern="[a-z0-9_]{3,30}"
                        autoComplete="username"
                        aria-describedby="student-profile-username-note"
                        disabled={profileBusy}
                      />
                      <p id="student-profile-username-note" className="mt-1.5 text-[10px] text-[#59675c]">Use 3–30 lowercase letters, numbers, or underscores.</p>
                    </div>
                    <div>
                      <label htmlFor="student-profile-name">Full name</label>
                      <input
                        id="student-profile-name"
                        className={field}
                        value={profile.name}
                        onChange={(event) => {
                          setProfile((current) => ({ ...current, name: event.target.value }));
                          setProfileError('');
                        }}
                        required
                        minLength={2}
                        maxLength={120}
                        autoComplete="name"
                        disabled={profileBusy}
                      />
                    </div>
                    <div>
                      <label htmlFor="student-profile-email">Email address</label>
                      <input
                        id="student-profile-email"
                        className={cn(field, '!bg-[#f5f6f3] !text-[#59675c]')}
                        value={session.user.email ?? ''}
                        readOnly
                        aria-describedby="student-profile-email-note"
                        autoComplete="email"
                      />
                      <p id="student-profile-email-note" className="mt-1.5 text-[10px] text-[#59675c]">
                        Email is your sign-in identity and cannot be changed here.
                      </p>
                    </div>
                    <div>
                      <label htmlFor="student-profile-phone">Phone</label>
                      <input
                        id="student-profile-phone"
                        className={field}
                        type="tel"
                        value={profile.phone}
                        onChange={(event) => {
                          setProfile((current) => ({ ...current, phone: event.target.value }));
                          setProfileError('');
                        }}
                        maxLength={40}
                        autoComplete="tel"
                        placeholder="Optional"
                        disabled={profileBusy}
                      />
                    </div>
                    <div>
                      <label htmlFor="student-profile-parent">Parent or guardian</label>
                      <input
                        id="student-profile-parent"
                        className={field}
                        value={profile.parentName}
                        onChange={(event) => {
                          setProfile((current) => ({ ...current, parentName: event.target.value }));
                          setProfileError('');
                        }}
                        maxLength={120}
                        placeholder="Optional"
                        disabled={profileBusy}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label htmlFor="student-profile-sports">Sports</label>
                      <input
                        id="student-profile-sports"
                        className={field}
                        value={profileSportsText}
                        onChange={(event) => {
                          setProfileSportsText(event.target.value);
                          setProfileError('');
                        }}
                        maxLength={500}
                        placeholder="Tennis, badminton"
                        aria-describedby="student-profile-sports-note"
                        disabled={profileBusy}
                      />
                      <p id="student-profile-sports-note" className="mt-1.5 text-[10px] text-[#59675c]">Separate sports with commas.</p>
                    </div>
                  </div>
                  {profileError && <div className="mt-5"><ErrorNotice message={profileError} /></div>}
                  <div className="mt-6 flex flex-wrap justify-end gap-3 border-t border-[#edf0e8] pt-5">
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={profileBusy}
                      onClick={() => setProfileEditorOpen(false)}
                    >
                      Cancel
                    </button>
                    <button type="submit" className={primaryButton} disabled={profileBusy}>
                      {profileBusy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}
                      Save changes
                    </button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>}

            {canUseFamily && <section className={cn(panel, 'mt-6 p-5 sm:p-6')} aria-labelledby="student-family-heading"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf3e7] text-[#4f6847]"><UsersRound size={18} /></span><div className="min-w-0 flex-1"><h2 id="student-family-heading" className="text-sm font-semibold text-[#3f4c42]">Family</h2><p className="mt-1 text-xs leading-relaxed text-[#59675c]">Add and manage more than one child from this adult account, then book a separate lesson place for each child. Managed children have no email, password, or sign-in.</p></div></div><Link href="/family" className={cn(primaryButton, 'mt-5 w-full sm:w-auto')}>Manage children<ArrowRight size={15} /></Link></section>}

            {canUseCalendar && <CalendarConnectionCard
              accountType={session.user.accountType}
              returnTo="/manage?tab=profile"
              className="mt-6"
            />}
            <NotificationPreferencesCard className="mt-6" />
            {canUsePayments && <PaymentReceiptsPanel className="mt-6" />}
            <PrivacyRequestsPanel emailVerified={session.user.emailVerified} className="mt-6" />

            {canUseCommerce && <section id="student-packages" className="mt-9 scroll-mt-24" aria-labelledby="student-packages-heading">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]">Credits across clubs</p>
                  <h2 id="student-packages-heading" tabIndex={-1} className="mt-1 text-xl font-semibold tracking-tight outline-none">My Packages</h2>
                </div>
                <button
                  type="button"
                  className={secondaryButton}
                  aria-expanded={packagesExpanded}
                  aria-controls="student-package-list"
                  onClick={() => setPackagesExpanded((value) => !value)}
                >
                  <PackageCheck size={15} /> {packagesExpanded ? 'Hide packages' : 'View My Packages'}
                </button>
              </div>
                <div id="student-package-list" hidden={!packagesExpanded} className="mt-5">
                  {packagesLoading ? (
                    <LoadingScreen text="Loading your packages…" />
                  ) : packagesError ? (
                    <div className="space-y-3"><ErrorNotice message={packagesError} /><button type="button" className={secondaryButton} onClick={() => void refreshPackages()}><RefreshCw size={14} /> Try packages again</button></div>
                  ) : packages.length ? (
                    <div className="grid gap-4 sm:grid-cols-2">{packages.map((pkg) => <PackageCard key={pkg.id} pkg={pkg} nowMs={nowMs} onFindRental={findRentalForPackage} onViewActivity={openPackageActivity} onBuyAnother={buyAnotherPackage} />)}</div>
                  ) : (
                    <EmptyState icon={<PackageCheck size={23} />} title="No packages yet" action={<button type="button" className={primaryButton} onClick={() => selectTab('explore')}>Explore club packages <ArrowRight size={15} /></button>}>Packages you buy from a club will appear here with their remaining credits and eligible activities.</EmptyState>
                  )}
                </div>
            </section>}

            <section className="mt-9" aria-labelledby="profile-booking-history">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[1.7px] text-[#59675c]">All your sessions</p>
                  <h2 id="profile-booking-history" className="mt-1 text-xl font-semibold tracking-tight">Booking history</h2>
                </div>
                <SeeMoreButton
                  expanded={showProfileHistory}
                  controls="profile-booking-history-content"
                  hiddenCount={bookings.length}
                  noun="bookings"
                  collapsedLabel="View booking history"
                  onToggle={() => setShowProfileHistory((value) => !value)}
                />
              </div>
              <div id="profile-booking-history-content" hidden={!showProfileHistory}>
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
                  <div role="status" className="flex min-h-28 items-center justify-center gap-2 rounded-2xl border border-[#e5e9e4] bg-white text-xs text-[#59675c]">
                    <LoaderCircle size={16} className="animate-spin" /> Gathering your sessions…
                  </div>
                ) : filteredHistory.length ? (
                  filteredHistory.map((item) => (
                    <CompactBooking key={item.participant.id} item={item} nowMs={nowMs} canBookAgain={canUseCommerce} />
                  ))
                ) : (
                  <p className="rounded-2xl border border-dashed border-[#dfe5dc] bg-white px-5 py-8 text-center text-sm text-[#59675c]">
                    No {historyFilter === 'all' ? '' : `${historyFilter} `}bookings to show.
                  </p>
                )}
              </div>
              </div>
            </section>

            <section className={cn(panel, 'mt-9 p-5')}>
              <div className="flex items-start gap-3 border-b border-[#edf0e8] pb-5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf3e7] text-[#4f6847]"><HelpCircle size={17} /></span>
                <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold text-[#3f4c42]">Help &amp; support</h2><p className="mt-1 text-xs leading-relaxed text-[#59675c]">Take another guided look at the player app whenever you need it.</p></div>
              </div>
              <button data-tour="student-tour-replay" type="button" className={cn(secondaryButton, 'mt-5 w-full')} onClick={replayProductTour}><HelpCircle size={15} />Take the tour</button>
            </section>

            <section className={cn(panel, 'mt-5 p-5')}>
              <div className="flex items-start gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f2eee9] text-[#6f5738]">
                  <LogOut size={17} />
                </span>
                <div className="flex-1">
                  <h2 className="text-sm font-semibold text-[#3f4c42]">Finished for now?</h2>
                  <p className="mt-1 text-xs leading-relaxed text-[#59675c]">Sign out of this device. Your bookings stay safely with your account.</p>
                </div>
              </div>
              <button type="button" className={cn(secondaryButton, 'mt-5 w-full text-[#8e6555]')} disabled={signingOut} onClick={() => void signOut()}>
                {signingOut ? <LoaderCircle size={15} className="animate-spin" /> : <LogOut size={15} />}
                Sign out
              </button>
              {signOutError && (
                <p role="alert" className="mt-3 text-xs text-[#8b4d3c]">{signOutError}</p>
              )}
            </section>
          </section>
        )}
      </main>
      <BookingDialog item={canUsePayments && (liveCheckout || checkoutReviewState) ? null : actionBooking ?? null} {...bookingDialogProps} />
      {canUseCommerce && <PackageOffersDialog
        club={liveCheckout || checkoutReviewState ? null : offersClub}
        offers={packageOffers}
        loading={offersLoading}
        error={offersError}
        notice={offerNotice}
        busyId={offerBusyId}
        paymentMode={paymentMode}
        stripeTestMode={stripeTestMode}
        paymentUnavailableReason={paymentUnavailableReason}
        canRetryPayments={canUsePayments}
        paymentOutcome={offerPaymentOutcome}
        onPaymentOutcome={setOfferPaymentOutcome}
        onBuy={buyPackage}
        onRetryPaymentCapabilities={() => void refreshPaymentCapabilities()}
        onClose={closePackageOffers}
      />}
      {canUsePayments && <CheckoutReviewDialog
        state={checkoutReviewState}
        paymentMode={paymentMode}
        busy={actionBusy || !!offerBusyId}
        onAcceptedChange={(accepted) => setCheckoutReviewState((current) => current ? { ...current, accepted } : current)}
        onContinue={continueReviewedCheckout}
        onChange={changeCheckoutPurchase}
        onClose={closeCheckoutReview}
        onRetry={retryCheckoutReview}
      />}
      {canUsePayments && <LiveCheckoutDialog
        checkout={liveCheckout}
        publishableKey={paymentCapabilities?.publishableKey ?? ''}
        testMode={stripeTestMode}
        busy={liveCheckoutBusy}
        onBusyChange={setLiveCheckoutBusy}
        onClose={() => setLiveCheckout(null)}
        onChange={() => setLiveCheckout(null)}
        onSettled={settleLiveCheckout}
        onDefinitiveFailure={() => forgetLiveCheckoutAttempt()}
      />}
      {canUseRentals && <RentalDialog
        open={!!openRentalId}
        rental={rentalDetail}
        loading={rentalDetailLoading}
        error={rentalError}
        notice={rentalNotice}
        date={rentalDate}
        duration={rentalDuration}
        unitId={rentalUnitId}
        slots={rentalSlots}
        slotsLoading={rentalSlotsLoading}
        selectedSlot={selectedRentalSlot}
        packages={eligibleRentalPackages}
        selectedPackageId={selectedRentalPackageId}
        paymentOutcome={rentalPaymentOutcome}
        busy={rentalBookingBusy}
        onClose={closeRental}
        onDate={setRentalDate}
        onDuration={setRentalDuration}
        onUnit={setRentalUnitId}
        onSlot={setSelectedRentalSlot}
        onPackage={setSelectedRentalPackageId}
        onPaymentOutcome={setRentalPaymentOutcome}
        onReserve={reserveRental}
      />}
      <AlertDialog
        alert={openAlert}
        club={clubs.find((club) => club.business.slug === openAlert?.businessSlug)}
        onClose={() => setOpenAlertId(null)}
        onOpenBooking={openAlertBooking}
        {...(openAlert ? alertDestinations(openAlert) : {})}
      />
      {canUseCommerce && <PackageActivityDialog
        pkg={offersClub || liveCheckout || checkoutReviewState ? null : activityPackage}
        onClose={() => setActivityPackage(null)}
        onBuyAnother={activityPackage ? () => buyAnotherPackage(activityPackage) : undefined}
      />}
    </div>
  );
}
