'use client';

import { useMemo, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Bell,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  CreditCard,
  ExternalLink,
  Gift,
  HelpCircle,
  Link2,
  Loader2,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Ticket,
  UserRound,
  Users,
  UsersRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { mutate } from '@/lib/api';
import { alertAppearance, alertPageSize, sortAlerts } from '@/lib/alerts';
import { isManagerWorkspace, type AccountType, type AuthSession, type BusinessKind, type ManagerWorkspace, type Notification, type WorkspaceResponse, type WorkspaceUser } from '@/lib/types';
import { initials, shortDate, time } from '@/lib/utils';

export const exploreViewIds = [
  'calendar',
  'bookings',
  'students',
  'services',
  'locations',
  'team',
  'availability',
  'packages',
  'payments',
  'insights',
  'integrity',
] as const;

export type ExploreViewId = (typeof exploreViewIds)[number];

const clubCoachViews = new Set<ExploreViewId>(['calendar', 'bookings', 'students', 'locations', 'availability']);

export function isExploreView(value: string): value is ExploreViewId {
  return exploreViewIds.includes(value as ExploreViewId);
}

export function canAccessExploreView(context: { accountType: AccountType; businessKind: BusinessKind }, view: string) {
  const isClubCoach = context.accountType === 'COACH' && context.businessKind === 'CLUB';
  return isExploreView(view) && (!isClubCoach || clubCoachViews.has(view));
}

export type BookingReadiness = {
  publicReady: boolean;
  staffBookingReady: boolean;
  hasActiveLocation: boolean;
  hasActiveInstructor: boolean;
  hasAssignedService: boolean;
  hasMatchingAvailability: boolean;
  hasLinkedStudent: boolean;
};

/**
 * A booking page is only ready when one complete, active service path can
 * produce a slot. Coaches are scoped to their own roster assignment.
 */
export function getBookingReadiness(data: WorkspaceResponse): BookingReadiness {
  const isCoach = data.user.accountType === 'COACH';
  const activeLocationIds = new Set(data.locations.filter(location => location.active).map(location => location.id));
  const activeInstructorIds = new Set(data.instructors
    .filter(instructor => instructor.active && (!isCoach || instructor.id === data.membership.instructorId))
    .map(instructor => instructor.id));
  const assignedPaths = data.services
    .filter(service => service.active)
    .flatMap(service => service.locations
      .filter(mapping => activeLocationIds.has(mapping.locationId))
      .flatMap(mapping => mapping.instructorIds
        .filter(instructorId => activeInstructorIds.has(instructorId))
        .map(instructorId => ({ instructorId, locationId: mapping.locationId }))));
  const hasMatchingAvailability = assignedPaths.some(path => data.availability.some(window =>
    window.instructorId === path.instructorId && window.locationId === path.locationId,
  ));
  const hasLinkedStudent = data.students.some(student => !!student.userId);
  return {
    publicReady: hasMatchingAvailability,
    staffBookingReady: hasMatchingAvailability && hasLinkedStudent,
    hasActiveLocation: activeLocationIds.size > 0,
    hasActiveInstructor: activeInstructorIds.size > 0,
    hasAssignedService: assignedPaths.length > 0,
    hasMatchingAvailability,
    hasLinkedStudent,
  };
}

type ExploreItem = {
  id: ExploreViewId;
  label: string;
  description: string;
  icon: typeof CalendarDays;
  detail: (data: WorkspaceResponse) => string;
};

type ManagerExploreItem = Omit<ExploreItem, 'detail'> & {
  detail: (data: ManagerWorkspace) => string;
};

const sharedExploreItems: ExploreItem[] = [
  { id: 'calendar', label: 'Calendar', description: 'See lessons, time, and venue status at a glance.', icon: CalendarDays, detail: data => `${data.bookings.length} total bookings` },
  { id: 'bookings', label: 'Bookings', description: 'Review every lesson and open its full details.', icon: Ticket, detail: data => `${data.bookings.filter(booking => booking.status === 'PENDING').length} awaiting venue` },
  { id: 'students', label: 'Students', description: 'Keep player details, notes, and lesson history together.', icon: Users, detail: data => `${data.students.length} student${data.students.length === 1 ? '' : 's'}` },
  { id: 'locations', label: 'Locations', description: 'Manage venues, travel time, and approval rules.', icon: MapPin, detail: data => `${data.locations.filter(location => location.active).length} active` },
  { id: 'availability', label: 'Availability', description: 'Manage teaching windows and protect time away.', icon: Clock3, detail: data => `${data.availability.length} weekly windows` },
];

const managerExploreItems: ManagerExploreItem[] = [
  { id: 'services', label: 'Services', description: 'Shape the lessons students can choose and book.', icon: Gift, detail: data => `${data.services.filter(service => service.active).length} active` },
  { id: 'team', label: 'My coaches', description: 'Add coaches to your roster and keep their details together.', icon: UsersRound, detail: data => `${data.instructors.filter(instructor => instructor.active).length} active` },
  { id: 'packages', label: 'Lesson packages', description: 'Track lesson credits and student commitments.', icon: Ticket, detail: data => `${data.packages.length} package${data.packages.length === 1 ? '' : 's'}` },
  { id: 'payments', label: 'Payments', description: 'Record offline receipts and follow unpaid lessons.', icon: CreditCard, detail: data => `${data.payments.length} recorded` },
  { id: 'insights', label: 'Insights', description: 'Understand attendance, lessons, and recorded receipts.', icon: ChartNoAxesCombined, detail: data => `${data.bookings.filter(booking => booking.status === 'COMPLETED').length} completed lessons` },
  { id: 'integrity', label: 'Integrity', description: 'Review coaches and students training privately outside the club.', icon: ShieldAlert, detail: data => `${data.integrityFlags.filter(flag => flag.status === 'OPEN').length} open` },
];
const exploreItems = [...sharedExploreItems, ...managerExploreItems];

const exploreGroups: { title: string; ids: ExploreViewId[] }[] = [
  { title: 'Schedule', ids: ['calendar', 'bookings', 'availability'] },
  { title: 'People', ids: ['students', 'team'] },
  { title: 'Business setup', ids: ['services', 'locations'] },
  { title: 'Money & reporting', ids: ['packages', 'payments', 'insights'] },
  { title: 'Oversight', ids: ['integrity'] },
];

export function ExploreHub({ data, onNavigate }: { data: WorkspaceResponse; onNavigate: (view: string) => void }) {
  const managerData = isManagerWorkspace(data) ? data : null;
  const isClubCoach = managerData === null;
  function renderSharedCard(item: ExploreItem) {
    const Icon = item.icon;
    const description = isClubCoach && item.id === 'students'
      ? 'View the players already connected to your lessons.'
      : isClubCoach && item.id === 'locations'
        ? 'Find a teaching venue on Google Maps or add one by hand.'
      : data.user.accountType === 'CLUB' && item.id === 'availability'
        ? 'Manage coach availability and protect time away.'
      : item.description;
    return <button
      key={item.id}
      type="button"
      className="workspace-explore-card group min-h-40 rounded-2xl border border-[#e2e8df] bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-[#cbd8c5] hover:shadow-sm"
      onClick={() => onNavigate(item.id)}
      aria-label={`Open ${item.label}`}
    >
      <span className="flex items-start justify-between gap-4">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#edf2e7] text-[#66805a]"><Icon size={19} strokeWidth={1.6} /></span>
        <ArrowRight size={16} className="mt-1 text-[#a0aa99] transition-transform group-hover:translate-x-0.5" />
      </span>
      <span className="mt-5 block text-sm font-semibold text-[#294735]">{item.label}</span>
      <span className="mt-2 block text-[11px] leading-relaxed text-stone-500">{description}</span>
      <span className="mt-4 block text-[10px] text-stone-400">{item.detail(data)}</span>
    </button>;
  }
  function renderManagerCard(item: ManagerExploreItem) {
    if (!managerData) return null;
    const Icon = item.icon;
    return <button key={item.id} type="button" className="workspace-explore-card group min-h-40 rounded-2xl border border-[#e2e8df] bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-[#cbd8c5] hover:shadow-sm" onClick={() => onNavigate(item.id)} aria-label={`Open ${item.label}`}><span className="flex items-start justify-between gap-4"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#edf2e7] text-[#66805a]"><Icon size={19} strokeWidth={1.6} /></span><ArrowRight size={16} className="mt-1 text-[#a0aa99] transition-transform group-hover:translate-x-0.5" /></span><span className="mt-5 block text-sm font-semibold text-[#294735]">{item.label}</span><span className="mt-2 block text-[11px] leading-relaxed text-stone-500">{item.description}</span><span className="mt-4 block text-[10px] text-stone-400">{item.detail(managerData)}</span></button>;
  }
  return <section className="workspace-explore" aria-labelledby="workspace-explore-title">
    <header className="section-heading">
      <div>
        <p className="eyebrow">Your workspace</p>
        <h1 id="workspace-explore-title" className="mt-2">Explore</h1>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-stone-500">Everything that keeps {data.business.name} moving, gathered in one calm place.</p>
      </div>
    </header>
    {isClubCoach ? <div className="space-y-5">
      <section aria-labelledby="explore-your-tools">
        <h2 id="explore-your-tools" className="mb-3 text-sm text-[#405744]">Your tools</h2>
        <div className="workspace-explore-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{sharedExploreItems.filter(item => clubCoachViews.has(item.id)).map(renderSharedCard)}</div>
      </section>
      <div className="workspace-explore-role-note flex items-start gap-3 rounded-xl border border-[#e4e9dd] bg-[#f4f7ef] p-4 text-xs leading-relaxed text-[#66755f]"><ShieldCheck size={17} className="mt-0.5 shrink-0" /><p>Business setup, coach access, packages, payments, and reporting are managed by the club.</p></div>
    </div> : <div className="space-y-7">
      {exploreGroups.map(group => {
        const headingId = `explore-${group.title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
        return <section key={group.title} aria-labelledby={headingId}>
          <h2 id={headingId} className="mb-3 text-sm text-[#405744]">{group.title}</h2>
          <div className="workspace-explore-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{group.ids.map(id => { const shared = sharedExploreItems.find(item => item.id === id); return shared ? renderSharedCard(shared) : renderManagerCard(managerExploreItems.find(item => item.id === id)!); })}</div>
        </section>;
      })}
    </div>}
  </section>;
}

/**
 * Workspace alerts.
 *
 * Same shape as the student inbox and for the same reason: an undifferentiated
 * wall of bells makes a payment, a cancellation and a safeguard flag all look
 * alike. Each alert carries a type that picks its icon, unread sit at the top
 * with a wash behind them until opened, and the list shows a handful until
 * asked for more. The full message and the way through to the booking live in
 * the dialog.
 */
export function AlertsView({ data, refresh, onOpenBooking, onNavigate }: {
  data: WorkspaceResponse;
  refresh: () => Promise<void>;
  onOpenBooking?: (bookingId: string) => void;
  onNavigate?: (view: string) => void;
}) {
  const [markingRead, setMarkingRead] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const ordered = useMemo(() => sortAlerts(data.notifications), [data.notifications]);
  const unread = ordered.filter(notification => !notification.read);
  const shown = showAll ? ordered : ordered.slice(0, alertPageSize);
  const open = openId ? ordered.find(notification => notification.id === openId) ?? null : null;

  async function markRead(ids?: string[]) {
    setMarkingRead(true);
    try {
      await mutate('/notifications/read', 'PATCH', ids ? { ids } : undefined);
      await refresh();
      if (!ids) toast.success('All updates marked as read');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setMarkingRead(false);
    }
  }

  // Opening an alert is what marks it read, so the list responds to the tap
  // rather than waiting for a separate "mark read" gesture.
  function openAlert(notification: Notification) {
    setOpenId(notification.id);
    if (!notification.read) void markRead([notification.id]);
  }

  return <section className="workspace-alerts mx-auto max-w-4xl" aria-labelledby="workspace-alerts-title">
    <header className="section-heading">
      <div>
        <p className="eyebrow">Stay in the loop</p>
        <h1 id="workspace-alerts-title" className="mt-2">Alerts</h1>
        <p className="mt-2 text-xs leading-relaxed text-stone-500">Booking activity from this workspace. External messaging is not connected.</p>
      </div>
      {unread.length > 0 && <Button variant="outline" size="sm" onClick={() => void markRead()} disabled={markingRead}>{markingRead ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}Mark all as read</Button>}
    </header>

    {ordered.length ? <>
      <div className="workspace-alert-list overflow-hidden rounded-2xl border border-[#e3e8df] bg-white">
        {shown.map(notification => {
          const appearance = alertAppearance(notification);
          const Icon = appearance.icon;
          return <button
            key={notification.id}
            type="button"
            onClick={() => openAlert(notification)}
            aria-label={`${notification.read ? 'Read' : 'Unread'} alert: ${notification.title}`}
            className={`workspace-alert-item flex w-full gap-4 border-b border-[#edf0e9] p-4 text-left transition last:border-b-0 hover:bg-[#fafbf7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-700 sm:p-5 ${notification.read ? '' : 'bg-[#f6faf1]'}`}
          >
            <span className={`relative mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${appearance.tone}`}>
              <Icon size={16} strokeWidth={1.6} />
              {!notification.read && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-[#9a8a58]" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className={`text-xs ${notification.read ? 'font-medium text-stone-600' : 'font-semibold text-[#294735]'}`}>{notification.title}</span>
                {notification.actionNeeded && <span className="badge pending !text-[9px]">Action needed</span>}
              </span>
              <span className="mt-1.5 line-clamp-1 block text-xs leading-relaxed text-stone-500">{notification.message}</span>
              <span className="mt-2 block text-[9px] text-stone-400">{appearance.label} · {shortDate(notification.createdAt)}</span>
            </span>
            <ChevronRight size={15} className="mt-1 shrink-0 text-stone-300" aria-hidden="true" />
          </button>;
        })}
      </div>
      {ordered.length > alertPageSize && <Button variant="outline" size="sm" className="mt-4 w-full" onClick={() => setShowAll(value => !value)}>
        {showAll ? 'Show fewer' : `Show all ${ordered.length} alerts`}
      </Button>}
    </> : <div className="workspace-alerts-empty panel py-16 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#edf2e7] text-[#718568]"><Bell size={21} /></span><h2 className="mt-4 text-[#294735]">You&rsquo;re all caught up</h2><p className="mt-2 text-xs text-stone-500">New booking activity will appear here.</p></div>}

    {open && <Dialog open onOpenChange={value => { if (!value) setOpenId(null); }}>
      <DialogContent className="max-w-md">
        {(() => {
          const appearance = alertAppearance(open);
          const Icon = appearance.icon;
          return <>
            <div className="flex items-start gap-3.5">
              <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${appearance.tone}`}><Icon size={20} strokeWidth={1.7} /></span>
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-lg font-semibold tracking-tight text-[#294735]">{open.title}</DialogTitle>
                <DialogDescription className="mt-1.5 text-[11px] text-stone-400">
                  {appearance.label} · {shortDate(open.createdAt)} at {time(open.createdAt)}
                </DialogDescription>
              </div>
            </div>
            <p className="mt-5 text-sm leading-relaxed text-stone-600">{open.message}</p>
            {open.actionNeeded && <p className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-[#f6ebd5] px-3 py-1 text-[10px] font-semibold text-[#94793c]">This one needs you</p>}
            <div className="mt-6 flex flex-wrap gap-2 border-t border-[#edf0e8] pt-5">
              {open.bookingId && onOpenBooking && <Button onClick={() => { const id = open.bookingId!; setOpenId(null); onOpenBooking(id); }}>Go to this booking<ArrowRight size={14} /></Button>}
              {appearance.kind === 'integrity' && onNavigate && <Button variant="outline" onClick={() => { setOpenId(null); onNavigate('integrity'); }}>Open Integrity<ArrowRight size={14} /></Button>}
              {appearance.kind === 'payment' && onNavigate && <Button variant="outline" onClick={() => { setOpenId(null); onNavigate('payments'); }}>Open Payments<ArrowRight size={14} /></Button>}
              <Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>
            </div>
          </>;
        })()}
      </DialogContent>
    </Dialog>}
  </section>;
}

type ProfileViewProps = {
  data: WorkspaceResponse;
  onEditProfile: () => void;
  onSwitchWorkspace: () => void;
  onBusinessSettings: () => void;
  onHelp: () => void;
  onSignOut: () => void;
  onNavigate?: (view: string) => void;
};

/** Tools a club account expects to reach from its own profile page. */
const clubProfileShortcuts: ExploreViewId[] = [
  'team', 'calendar', 'bookings', 'students', 'services', 'locations', 'payments', 'integrity',
];

/**
 * Profile.
 *
 * A club account is the club, not a person, so it leads with the club's name
 * and opens business settings instead of editing a personal profile. A coach
 * keeps one personal profile while moving between their practice and clubs.
 */
export function ProfileView({ data, onEditProfile, onSwitchWorkspace, onBusinessSettings, onHelp, onSignOut, onNavigate }: ProfileViewProps) {
  const isCoach = data.user.accountType === 'COACH';
  const clubAccount = data.user.accountType === 'CLUB';
  const isClub = data.business.kind !== 'SOLO';
  const isSoloCoach = isCoach && !isClub;
  const isClubCoach = isCoach && isClub;
  const canManageBusiness = clubAccount || isSoloCoach;
  const bookingReadiness = getBookingReadiness(data);
  const bookingPath = `/book/${encodeURIComponent(data.business.slug)}`;
  const openFlags = data.integrityFlags.filter(flag => flag.status === 'OPEN').length;
  const awaitingCoach = data.bookings.filter(booking => booking.coachAcceptance === 'PENDING').length;
  const shortcuts = clubProfileShortcuts
    .map(id => exploreItems.find(item => item.id === id))
    .filter((item): item is ExploreItem => !!item);

  async function copyBookingLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${bookingPath}`);
      toast.success('Booking link copied');
    } catch {
      toast.error('Copy is unavailable. Open your booking page and copy the address.');
    }
  }

  return <section className="workspace-profile mx-auto max-w-5xl" aria-labelledby="workspace-profile-title">
    <header className="workspace-profile-header mb-6 rounded-2xl border border-[#e1e7dd] bg-white p-5 sm:p-7">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <span className={`grid h-20 w-20 shrink-0 place-items-center rounded-${clubAccount ? '2xl' : 'full'} ${clubAccount ? 'bg-[#e6eedd] text-[#5f7a51]' : 'bg-[#e8dccc] text-[#887052]'} text-xl font-semibold`}>
          {initials(clubAccount ? data.business.name : data.user.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{clubAccount ? (isClub ? 'Club account' : 'Business account') : 'Personal profile'}</p>
          <h1 id="workspace-profile-title" className="mt-2 truncate">{clubAccount ? data.business.name : data.user.name}</h1>
          <p className="mt-1 break-all text-xs text-stone-500">{clubAccount ? (data.business.tagline || data.business.email) : data.user.email}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="badge">{clubAccount ? 'Club manager' : isSoloCoach ? 'Coach · Own practice' : 'Coach'}</span>
            {clubAccount && <span className="badge bg-stone-100! text-stone-500!">Managed by {data.business.name}</span>}
            {!clubAccount && data.user.phone && <span className="badge bg-stone-100! text-stone-500!">{data.user.phone}</span>}
          </div>
          {clubAccount && <p className="mt-3 max-w-xl text-[11px] leading-relaxed text-stone-500">
            This login belongs to {data.business.name}, not to one person. It is created by the club and works with this club alone.
          </p>}
        </div>
        <Button variant="outline" onClick={clubAccount ? onBusinessSettings : onEditProfile}><Pencil size={14} />{clubAccount ? 'Edit club details' : 'Edit personal profile'}</Button>
      </div>
    </header>

    {clubAccount && onNavigate && <section className="mb-5" aria-labelledby="workspace-profile-tools">
      <h2 id="workspace-profile-tools" className="mb-3 text-sm text-[#405744]">Running {data.business.name}</h2>
      {(openFlags > 0 || awaitingCoach > 0) && <div className="mb-3 flex flex-wrap gap-2">
        {awaitingCoach > 0 && <button type="button" className="badge pending" onClick={() => onNavigate('bookings')}>{awaitingCoach} lesson{awaitingCoach === 1 ? '' : 's'} awaiting a coach</button>}
        {openFlags > 0 && <button type="button" className="badge pending" onClick={() => onNavigate('integrity')}>{openFlags} flag{openFlags === 1 ? '' : 's'} to review</button>}
      </div>}
      <div className="grid gap-2 sm:grid-cols-2">
        {shortcuts.map(item => {
          const Icon = item.icon;
          return <button
            key={item.id}
            type="button"
            className="flex min-h-16 items-center gap-3 rounded-xl border border-[#e3e8df] bg-white p-3 text-left transition hover:border-[#cbd8c5] hover:bg-[#f8faf6]"
            onClick={() => onNavigate(item.id)}
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#edf2e7] text-[#66805a]"><Icon size={17} strokeWidth={1.6} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-[#344b39]">{item.label}</span>
              <span className="mt-1 block text-[10px] text-stone-500">{item.detail(data)}</span>
            </span>
            <ChevronRight size={14} className="shrink-0 text-stone-300" />
          </button>;
        })}
      </div>
    </section>}

    <div className="workspace-profile-grid grid items-start gap-5 lg:grid-cols-[1.15fr_0.85fr]">
      <div className="space-y-5">
        <section className="panel overflow-hidden">
          <div className="panel-heading"><div className="flex items-center gap-2"><Building2 size={17} className="text-[#839677]" /><h2 className="text-[#294735]">{clubAccount ? 'This club' : isClub ? 'My clubs & academies' : 'My practice'}</h2></div><span className="badge">{data.business.isDemo ? 'Demo workspace' : clubAccount ? 'Club' : isSoloCoach ? 'Own practice' : 'Coach'}</span></div>
          <div className="px-5 pb-5 sm:px-6 sm:pb-6">
            <div className="flex items-center gap-3 rounded-xl bg-[#f5f7f1] p-4"><span className="business-avatar !h-11 !w-11 shrink-0">{initials(data.business.name)}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[#294735]">{data.business.name}</p><p className="mt-1 text-[10px] text-stone-500">{data.business.tagline || 'Your coaching business, beautifully connected.'}</p></div></div>
            {isClubCoach && <p className="mt-3 text-[11px] leading-relaxed text-stone-500">
              {data.memberships.length > 1
                ? `You coach at ${data.memberships.length} clubs or academies. A club adds you to its roster; you cannot join one yourself.`
                : 'A club or academy adds you to its roster. You cannot join one yourself.'}
            </p>}
            <div className={`mt-4 grid gap-2 ${isSoloCoach ? 'sm:grid-cols-2' : ''}`}>
              {/* A club account operates one club, so there is nothing to
                  switch between and the switcher would only confuse. */}
              {isCoach && <Button variant="outline" onClick={onSwitchWorkspace}><UsersRound size={14} />Switch workspace</Button>}
              {canManageBusiness && <Button variant="outline" onClick={onBusinessSettings}><Settings2 size={14} />{clubAccount ? 'Club settings' : 'Business settings'}</Button>}
            </div>
          </div>
        </section>
        {canManageBusiness && <section className="panel overflow-hidden">
          <div className="panel-heading"><div className="flex items-center gap-2"><Link2 size={17} className="text-[#839677]" /><h2 className="text-[#294735]">Your booking link</h2></div><span className="badge">{bookingReadiness.publicReady ? 'Ready' : 'Setup needed'}</span></div>
          <div className="px-5 pb-5 sm:px-6 sm:pb-6"><p className="text-xs leading-relaxed text-stone-500">{bookingReadiness.publicReady ? 'Share this page so students can choose a service and find an available lesson.' : 'Preview the page now. Finish your location, service assignment, and matching availability before sharing it.'}</p><div className="mt-4 flex min-w-0 items-center gap-2 rounded-xl border border-[#e3e8df] bg-[#fafbf8] p-3"><span className="min-w-0 flex-1 truncate text-xs text-stone-600">{bookingPath}</span>{bookingReadiness.publicReady && <Button size="icon" variant="ghost" aria-label="Copy booking link" onClick={() => void copyBookingLink()}><Copy size={14} /></Button>}</div><div className="mt-3 grid grid-cols-1 gap-2 sm:flex">{bookingReadiness.publicReady && <Button size="sm" onClick={() => void copyBookingLink()}><Copy size={13} />Copy link</Button>}<Button size="sm" variant="outline" asChild><a href={bookingPath} target="_blank" rel="noreferrer"><ExternalLink size={13} />Preview booking page</a></Button></div></div>
        </section>}
        {canManageBusiness && isClub && <section className="panel overflow-hidden">
          <div className="panel-heading"><div className="flex items-center gap-2"><ShieldCheck size={17} className="text-[#839677]" /><h2 className="text-[#294735]">How money moves</h2></div></div>
          <div className="px-5 pb-5 text-xs leading-relaxed text-stone-500 sm:px-6 sm:pb-6">
            <p>Every lesson booked through {data.business.name} is paid to the club. The club then records what it pays each coach, so the club&rsquo;s books stay complete and a coach is never paid twice for the same lesson.</p>
            {onNavigate && <Button size="sm" variant="outline" className="mt-3" onClick={() => onNavigate('payments')}><CreditCard size={13} />Open Payments<ArrowRight size={13} /></Button>}
          </div>
        </section>}
      </div>
      <aside className="space-y-5">
        <section className="panel overflow-hidden"><div className="panel-heading"><h2 className="text-[#294735]">Account &amp; support</h2></div><div className="workspace-profile-actions px-3 pb-3"><button type="button" className="nav-link !min-h-11" onClick={clubAccount ? onBusinessSettings : onEditProfile}><UserRound size={16} />{clubAccount ? 'Club details' : 'Personal details'}<ArrowRight size={13} className="ml-auto" /></button><button type="button" className="nav-link !min-h-11" onClick={onHelp}><HelpCircle size={16} />A little help<ArrowRight size={13} className="ml-auto" /></button><button type="button" className="nav-link !min-h-11 text-[#8b625c]!" onClick={onSignOut}><LogOut size={16} />Sign out</button></div></section>
        {isCoach && onNavigate && <section className="panel overflow-hidden">
          <div className="panel-heading"><h2 className="text-[#294735]">My workspaces</h2></div>
          <div className="px-5 pb-5 sm:px-6 sm:pb-6">
            <ul className="space-y-2">{data.memberships.map(membership => <li key={membership.id} className="flex items-center gap-2.5 rounded-xl bg-[#f5f7f1] p-3">
              <span className="business-avatar !h-8 !w-8 shrink-0 !text-[10px]">{initials(membership.business.name)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-[#344b39]">{membership.business.name}</span>
              {membership.businessId === data.business.id && <span className="badge !text-[9px]">Current</span>}
            </li>)}</ul>
            <p className="mt-3 text-[10px] leading-relaxed text-stone-500">Your own practice appears here alongside each club or academy that adds you to its roster.</p>
          </div>
        </section>}
        {data.business.isDemo && <section className="rounded-2xl border border-[#e1e8d6] bg-[#eef3e6] p-5"><ShieldCheck size={21} className="text-[#7c9169]" /><h2 className="mt-3 text-[#294735]">A private place to explore</h2><p className="mt-2 text-xs leading-relaxed text-[#77866d]">Your changes stay in this demo workspace. When you&rsquo;re ready, create a business of your own.</p><Button className="mt-4 w-full" asChild><a href="/signup">Create your own workspace</a></Button></section>}
      </aside>
    </div>
  </section>;
}

type CreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data?: WorkspaceResponse;
  accountType?: AccountType;
  businessKind?: BusinessKind;
  bookingReadiness?: BookingReadiness;
  onNewBooking: () => void;
  onNavigate: (view: string) => void;
};

export function CreateDialog({ open, onOpenChange, data, accountType: accountTypeProp, businessKind: businessKindProp, bookingReadiness, onNewBooking, onNavigate }: CreateDialogProps) {
  const accountType = data?.user.accountType ?? accountTypeProp ?? 'CLUB';
  const businessKind = data?.business.kind ?? businessKindProp ?? 'CLUB';
  const isCoach = accountType === 'COACH';
  const isClubCoach = isCoach && businessKind === 'CLUB';
  const readiness = data ? getBookingReadiness(data) : bookingReadiness ?? null;
  const actions = [
    { label: 'Students', description: 'Manage student records', view: 'students', icon: Users, coach: false },
    { label: 'Availability', description: 'Shape your teaching week', view: 'availability', icon: Clock3, coach: true },
    { label: 'Services', description: 'Add or edit a lesson', view: 'services', icon: Gift, coach: false },
    { label: 'Locations', description: isClubCoach ? 'Find or add a teaching venue' : 'Manage teaching venues', view: 'locations', icon: MapPin, coach: true },
    { label: 'Payments', description: 'Record an offline receipt', view: 'payments', icon: CreditCard, coach: false },
  ].filter(action => !isClubCoach || action.coach);
  function go(view: string) { onOpenChange(false); onNavigate(view); }
  const ownerManagedBlockers = [
    readiness && !readiness.hasActiveInstructor && (isCoach ? 'an active coach roster profile' : 'an active instructor'),
    readiness && !readiness.hasAssignedService && (isCoach ? 'a service assigned to you at an active location' : 'an active service assigned to an active instructor'),
    readiness && !readiness.hasLinkedStudent && 'a linked student account',
  ].filter((item): item is string => !!item);
  const missingBookingSetup = [
    readiness && !readiness.hasActiveLocation && 'an active location',
    ...ownerManagedBlockers,
    readiness && readiness.hasAssignedService && !readiness.hasMatchingAvailability && 'availability for that instructor and location',
  ].filter((item): item is string => !!item);
  const primarySetupView = readiness && !readiness.hasActiveLocation ? 'locations'
    : readiness && !readiness.hasActiveInstructor ? 'team'
      : readiness && !readiness.hasAssignedService ? 'services'
      : readiness && !readiness.hasMatchingAvailability ? 'availability'
        : 'students';
  const setupMessage = isClubCoach
    ? `${readiness && !readiness.hasActiveLocation ? 'Add an active location.' : ''}${readiness && !readiness.hasActiveLocation && ownerManagedBlockers.length ? ' Then ask' : ownerManagedBlockers.length ? 'Ask' : ''}${ownerManagedBlockers.length ? ` the club to add ${ownerManagedBlockers.join(', ')}.` : ''}${readiness && !readiness.hasMatchingAvailability && readiness.hasAssignedService ? `${(readiness && !readiness.hasActiveLocation) || ownerManagedBlockers.length ? ' Then set' : 'Set'} availability for your assigned service location.` : ''}`
    : `Complete ${missingBookingSetup.join(', ')} first.`;
  const showNewBooking = readiness?.staffBookingReady ?? true;
  const setupView = isClubCoach && ownerManagedBlockers.length && primarySetupView !== 'locations' ? 'explore' : primarySetupView;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="workspace-create-dialog max-w-lg"><DialogTitle className="sr-only">Create</DialogTitle><h2 className="text-lg font-semibold">Quick actions</h2><DialogDescription className="mt-2 text-xs text-stone-500">Start a booking or open a tool that supports your work.</DialogDescription>{showNewBooking ? <Button className="mt-5 h-auto w-full justify-start gap-3 rounded-xl p-4 text-left" onClick={() => { onOpenChange(false); window.requestAnimationFrame(onNewBooking); }}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15"><Plus size={18} /></span><span><span className="block text-xs font-semibold">New booking</span><span className="mt-1 block text-[10px] font-normal text-white/75">Choose a lesson, student, place, and time</span></span></Button> : <div className="mt-5 rounded-xl border border-[#e8dfc8] bg-[#fbf8ef] p-4"><p className="text-xs font-semibold text-[#6e6246]">New booking needs a little setup</p><p className="mt-1.5 text-[10px] leading-relaxed text-[#8f8265]">{setupMessage}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => go(setupView)}>{setupView === 'explore' ? 'View your tools' : setupView === 'locations' ? 'Add a location' : setupView === 'team' ? 'Open your team' : setupView === 'services' ? 'Set up services' : setupView === 'availability' ? 'Set availability' : 'Open students'}<ArrowRight size={13} /></Button></div>}<div className="mt-4"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-stone-400">Go to</p><div className="grid gap-2 sm:grid-cols-2">{actions.map(action => { const Icon = action.icon; return <button key={action.view} type="button" className="workspace-create-action flex min-h-20 items-center gap-3 rounded-xl border border-[#e3e8df] p-3 text-left transition hover:bg-[#f7f9f4]" onClick={() => go(action.view)}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#edf2e7] text-[#6e835f]"><Icon size={16} /></span><span><span className="block text-xs font-semibold text-[#344b39]">{action.label}</span><span className="mt-1 block text-[10px] text-stone-500">{action.description}</span></span></button>; })}</div></div></DialogContent></Dialog>;
}

export function PersonalProfileDialog({ open, onOpenChange, user, refresh }: { open: boolean; onOpenChange: (open: boolean) => void; user: WorkspaceUser; refresh: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    try {
      await mutate<AuthSession>('/auth/me', 'PATCH', {
        name: String(form.get('name') || '').trim(),
        phone: String(form.get('phone') || '').trim(),
        parentName: String(form.get('parentName') || '').trim(),
      });
      await refresh();
      toast.success('Personal profile updated');
      onOpenChange(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next); }}><DialogContent className="workspace-personal-profile-dialog max-w-lg" onEscapeKeyDown={event => { if (saving) event.preventDefault(); }} onPointerDownOutside={event => { if (saving) event.preventDefault(); }}><DialogTitle className="text-lg font-semibold">Edit personal profile</DialogTitle><DialogDescription className="mt-2 text-xs leading-relaxed text-stone-500">These details belong to your Courtly account and travel with you when you switch businesses.</DialogDescription><form className="mt-5 space-y-4" onSubmit={submit}><div><label htmlFor="personal-profile-name">Name</label><input id="personal-profile-name" name="name" defaultValue={user.name} autoComplete="name" required disabled={saving} /></div><div><label htmlFor="personal-profile-email">Email</label><input id="personal-profile-email" name="email" type="email" defaultValue={user.email} autoComplete="email" readOnly aria-describedby="personal-profile-email-note" /><p id="personal-profile-email-note" className="mt-1.5 text-[10px] leading-relaxed text-stone-400">Your sign-in email cannot be changed here.</p></div><div><label htmlFor="personal-profile-phone">Phone <span className="font-normal text-stone-400">(optional)</span></label><input id="personal-profile-phone" name="phone" type="tel" defaultValue={user.phone || ''} autoComplete="tel" disabled={saving} /></div><div><label htmlFor="personal-profile-parent-name">Parent or guardian name <span className="font-normal text-stone-400">(optional)</span></label><input id="personal-profile-parent-name" name="parentName" defaultValue={user.parentName || ''} autoComplete="name" disabled={saving} /></div><div className="flex justify-end gap-2 pt-2"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button><Button type="submit" disabled={saving}>{saving && <Loader2 size={14} className="animate-spin" />}Save profile</Button></div></form></DialogContent></Dialog>;
}
