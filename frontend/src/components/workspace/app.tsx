'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Bell,
  CalendarDays,
  Check,
  ChevronsUpDown,
  Compass,
  House,
  Loader2,
  MessageCircle,
  Plus,
  Search,
  UserRound,
  Users,
} from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { SeeMoreButton } from '@/components/ui/progressive-disclosure';
import { ApiError, loadAuthSession, loadBooking, loadWorkspace, mutate, openBookingChat, searchAccounts, switchWorkspaceAccess } from '@/lib/api';
import { alertsButtonLabel, chatBadge, chatTabLabel } from '@/lib/chat';
import { destroyProductTour, startProductTour, type ProductTourContext } from '@/lib/product-tour';
import type { AccountDirectoryUser, ClubPermission, ClubStaffWorkspaceAccess, Membership, WorkspaceResponse } from '@/lib/types';
import { cn, initials, shortDate } from '@/lib/utils';
import { ChatInbox } from '@/components/chat/chat-inbox';
import { useChatUnread } from '@/components/chat/use-chat-unread';
import Dashboard, { CalendarView } from './dashboard';
import { ManagementView } from './management';
import { NewBookingDialog, BookingDetail } from './booking-dialogs';
import { RentalExplore } from './rental-explore';
import { RentalReservations } from './rental-reservations';
import {
  AlertsView,
  canAccessExploreView,
  CreateDialog,
  ExploreHub,
  isExploreView,
  PersonalProfileDialog,
  ProfileView,
} from './shell-views';

// Alerts is not a tab: like a notifications heart, it lives in the top bar
// while Chat takes its place in the primary navigation.
type PrimaryTab = 'home' | 'explore' | 'chat' | 'alerts' | 'profile';

const viewTitles: Record<string, string> = {
  overview: 'Home',
  explore: 'Explore',
  chat: 'Chat',
  alerts: 'Alerts',
  profile: 'Profile',
  calendar: 'Calendar',
  bookings: 'Bookings',
  students: 'Students',
  services: 'Classes',
  locations: 'Locations',
  team: 'My coaches',
  availability: 'Availability',
  rentals: 'Rent a court',
  packages: 'Packages',
  payments: 'Payments',
  insights: 'Insights',
  settings: 'Settings',
};

function primaryTabForView(view: string): PrimaryTab {
  if (view === 'overview') return 'home';
  if (view === 'chat') return 'chat';
  if (view === 'alerts') return 'alerts';
  if (view === 'profile' || view === 'settings') return 'profile';
  return 'explore';
}

const staffViewPermissions: Partial<Record<string, ClubPermission[]>> = {
  calendar: ['BOOKINGS_VIEW', 'BOOKINGS_MANAGE'],
  bookings: ['BOOKINGS_VIEW', 'BOOKINGS_MANAGE'],
  students: ['STUDENTS_VIEW', 'STUDENTS_MANAGE'],
  services: ['CATALOG_VIEW', 'CATALOG_MANAGE'],
  locations: ['CATALOG_VIEW', 'CATALOG_MANAGE'],
  team: ['ROSTER_VIEW', 'ROSTER_MANAGE'],
  availability: ['AVAILABILITY_MANAGE'],
  rentals: ['RENTALS_VIEW', 'RENTALS_MANAGE'],
  packages: ['PACKAGES_VIEW', 'PACKAGES_MANAGE'],
  payments: ['PAYMENTS_VIEW', 'PAYMENTS_RECORD', 'PAYMENTS_REVERSE', 'PAYOUTS_RECORD'],
  insights: ['PAYMENTS_VIEW', 'AUDIT_VIEW', 'SAFEGUARDING_VIEW', 'BOOKINGS_VIEW'],
  settings: ['SETTINGS_MANAGE'],
};

function accessMode(data: WorkspaceResponse) {
  return data.accessMode ?? (data.user.accountType === 'CLUB' ? 'CLUB_ACCOUNT' : 'COACH');
}

function workspaceTourContext(data: WorkspaceResponse): ProductTourContext {
  const mode = accessMode(data);
  return {
    kind: mode === 'COACH' ? 'workspace-coach' : mode === 'STAFF' ? 'workspace-staff' : 'workspace-club',
    userId: data.user.id,
    firstName: data.user.name.split(' ')[0],
    businessName: data.business.name,
  };
}

function canAccessWorkspaceView(data: WorkspaceResponse, view: string) {
  if (accessMode(data) !== 'STAFF') {
    return !isExploreView(view) || canAccessExploreView({ accountType: data.user.accountType, businessKind: data.business.kind }, view);
  }
  if (!isExploreView(view) && view !== 'settings') return true;
  const required = staffViewPermissions[view];
  return !!required?.some(permission => (data.permissions ?? data.staffAccess?.permissions ?? []).includes(permission));
}

const staffToolDescriptions: Partial<Record<string, string>> = {
  calendar: 'See the club schedule and venue status.', bookings: 'Find and review club lessons.',
  students: 'Open the club student directory.', services: 'Review classes and their venue assignments.',
  locations: 'Review club venues and rental configuration.', team: 'Review the coach roster.',
  availability: 'Manage coach availability.', rentals: 'Review owned-venue reservations.',
  packages: 'Review class and rental credit packages.', payments: 'Review receipts and payouts.',
  insights: 'Open growth insights, reporting and the club audit log.', settings: 'Manage club settings.',
};

function StaffLanding({ data, onNavigate, home }: { data: WorkspaceResponse; onNavigate: (view: string) => void; home: boolean }) {
  const [showAllTools, setShowAllTools] = useState(false);
  const moreToolsId = useId();
  const tools = Object.keys(staffViewPermissions).filter(view => view !== 'settings' && canAccessWorkspaceView(data, view));
  const primaryTools = tools.slice(0, 3);
  const secondaryTools = tools.slice(3);
  const hiddenCount = Math.max(0, tools.length - 3);
  return <section className="mx-auto max-w-5xl" aria-labelledby="staff-workspace-title">
    <header data-tour="workspace-home" className="section-heading"><div><p className="eyebrow">Named staff access</p><h1 id="staff-workspace-title" className="mt-2">{home ? `Welcome, ${data.user.name.split(' ')[0]}.` : 'Your club tools'}</h1><p className="mt-2 max-w-2xl text-xs leading-relaxed text-stone-500">You are working in {data.business.name} as named staff. The tools below reflect the permissions assigned by the club.</p></div></header>
    <div data-tour="workspace-staff-tools">{tools.length ? <><div className="workspace-explore-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{primaryTools.map(tool => <StaffToolButton key={tool} tool={tool} onNavigate={onNavigate} />)}</div>{hiddenCount > 0 && <><div className="my-3 flex justify-center border-y border-[#e2e7df] py-2"><SeeMoreButton expanded={showAllTools} onToggle={() => setShowAllTools(value => !value)} controls={moreToolsId} hiddenCount={hiddenCount} noun="tools" /></div><div id={moreToolsId} hidden={!showAllTools} className="workspace-explore-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{secondaryTools.map(tool => <StaffToolButton key={tool} tool={tool} onNavigate={onNavigate} />)}</div></>}</> : <div className="rounded-2xl border border-[#e2e8df] bg-white p-6 text-sm text-stone-500">This role does not currently include any workspace tools. Ask the club account to review your staff access.</div>}</div>
  </section>;
}

function StaffToolButton({ tool, onNavigate }: { tool: string; onNavigate: (view: string) => void }) {
  return <button type="button" className="workspace-explore-card group min-h-32 rounded-2xl border border-[#e2e8df] bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-[#cbd8c5] hover:shadow-sm" onClick={() => onNavigate(tool)}><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#edf2e7] text-[#66805a]"><Compass size={17} /></span><span className="mt-4 block text-sm font-semibold text-[#294735]">{viewTitles[tool] ?? tool}</span><span className="mt-2 block text-[11px] leading-relaxed text-stone-500">{staffToolDescriptions[tool]}</span></button>;
}

function routeView(data: WorkspaceResponse) {
  const isClubCoach = accessMode(data) === 'COACH';
  const parameters = new URLSearchParams(window.location.search);
  const tab = parameters.get('tab');
  const nestedView = parameters.get('view');
  if (tab === 'alerts') return 'alerts';
  if (tab === 'chat') return 'chat';
  if (tab === 'profile') return nestedView === 'settings' && !isClubCoach && canAccessWorkspaceView(data, 'settings') ? 'settings' : 'profile';
  if (tab === 'explore') return nestedView && canAccessWorkspaceView(data, nestedView) ? nestedView : 'explore';
  if (!tab && nestedView) {
    if (nestedView === 'settings') return isClubCoach || !canAccessWorkspaceView(data, 'settings') ? 'profile' : 'settings';
    if (canAccessWorkspaceView(data, nestedView)) return nestedView;
  }
  return 'overview';
}

function routeThread(view: string) {
  return view === 'chat' ? new URLSearchParams(window.location.search).get('thread') : null;
}

function updateRoute(view: string, businessId: string, replace = false, threadId: string | null = null) {
  const url = new URL(window.location.href);
  if (url.pathname !== '/') return;
  url.searchParams.delete('tab');
  url.searchParams.delete('view');
  url.searchParams.delete('thread');
  const tab = primaryTabForView(view);
  url.searchParams.set('tab', tab);
  if (isExploreView(view) || view === 'settings') url.searchParams.set('view', view);
  if (view === 'chat' && threadId) url.searchParams.set('thread', threadId);
  const previous = window.history.state || {};
  // A conversation opened from the chat list sits directly above it, so the
  // on-screen back arrow can pop history instead of stacking another list.
  const chatListBelow = view === 'chat' && !!threadId
    && (replace ? !!previous.chatListBelow : previous.view === 'chat' && !previous.threadId);
  window.history[replace ? 'replaceState' : 'pushState']({
    ...previous, tab, view, threadId, chatListBelow, workspaceBusinessId: businessId,
  }, '', url);
}

export default function WorkspaceApp() {
  const router = useRouter();
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('overview');
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [accountResults, setAccountResults] = useState<AccountDirectoryUser[]>([]);
  const [accountSearchLoading, setAccountSearchLoading] = useState(false);
  const [accountSearchError, setAccountSearchError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [switchingAccessId, setSwitchingAccessId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mainFocusRequest, setMainFocusRequest] = useState(0);
  const initialized = useRef(false);
  const routedBusinessId = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const replayTourRef = useRef(false);
  const { unreadThreads: chatUnread, beginUnreadRequest, commitUnreadNow } = useChatUnread(!!data);

  const refresh = useCallback(async () => {
    let workspace = await loadWorkspace();
    if (selectedBookingId && !workspace.bookings.some(booking => booking.id === selectedBookingId)) {
      try {
        const { booking } = await loadBooking(selectedBookingId);
        workspace = { ...workspace, bookings: [...workspace.bookings, booking] } as WorkspaceResponse;
      } catch {
        // A removed or newly inaccessible booking should disappear on refresh.
      }
    }
    setData(workspace);
  }, [selectedBookingId]);

  const initialize = useCallback(async () => {
    setError('');
    try {
      const auth = await loadAuthSession();
      if (auth.user.requiredAction) {
        router.replace('/account/action-required');
        return;
      }
      if (auth.user.capabilities?.workspace === false) {
        router.replace(auth.user.accountType === 'STUDENT' ? '/manage' : '/account');
        return;
      }
      await refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        router.replace('/login');
      } else if (cause instanceof ApiError && cause.status === 403) {
        try {
          const auth = await loadAuthSession();
          router.replace(auth.business && auth.accessMode !== 'NONE' ? '/' : auth.user.accountType === 'STUDENT' ? '/manage' : '/account');
        } catch (authError) {
          if (authError instanceof ApiError && authError.status === 401) router.replace('/login');
          else setError((authError as Error).message);
        }
      } else {
        setError((cause as Error).message);
      }
    }
  }, [refresh, router]);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void initialize();
    }
  }, [initialize]);

  useEffect(() => {
    if (!data || routedBusinessId.current === data.business.id) return;
    routedBusinessId.current = data.business.id;
    const historyBusinessId = window.history.state?.workspaceBusinessId;
    const next = typeof historyBusinessId === 'string' && historyBusinessId !== data.business.id
      ? 'overview'
      : routeView(data);
    const thread = routeThread(next);
    setView(next);
    setChatThreadId(thread);
    updateRoute(next, data.business.id, true, thread);
  }, [data]);

  useEffect(() => {
    if (!data) return;
    const handleHistory = () => {
      setBookingOpen(false);
      setSelectedBookingId(null);
      setSearchOpen(false);
      setSearch('');
      setCreateOpen(false);
      setProfileEditorOpen(false);
      setWorkspaceOpen(false);
      if (window.location.pathname !== '/') return;

      const historyBusinessId = window.history.state?.workspaceBusinessId;
      const next = typeof historyBusinessId === 'string' && historyBusinessId !== data.business.id
        ? 'overview'
        : routeView(data);
      const thread = routeThread(next);
      setChatThreadId(thread);
      if (next !== view) {
        setView(next);
        setMainFocusRequest(request => request + 1);
      }
      // Next's App Router also restores its URL state during popstate. Let that
      // listener finish before replacing a stale workspace entry, otherwise it
      // can restore the old query string after this handler has corrected it.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => updateRoute(next, data.business.id, true, thread));
      });
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', handleHistory);
    return () => window.removeEventListener('popstate', handleHistory);
  }, [data, view]);

  useEffect(() => {
    if (!mainFocusRequest) return;
    const frame = window.requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"][data-state="open"]')) {
        mainRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mainFocusRequest]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(open => !open);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    if (!data || view !== 'overview') return;
    const force = replayTourRef.current;
    replayTourRef.current = false;
    const timer = window.setTimeout(() => {
      void startProductTour(workspaceTourContext(data), { force });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      destroyProductTour();
    };
  }, [data?.business.id, data?.user.id, view]);

  useEffect(() => {
    const query = search.trim();
    const searchableQuery = query.startsWith('@') ? query.slice(1) : query;
    if (!searchOpen || searchableQuery.length < 3) {
      setAccountResults([]);
      setAccountSearchLoading(false);
      setAccountSearchError('');
      return;
    }

    let active = true;
    setAccountResults([]);
    setAccountSearchLoading(true);
    setAccountSearchError('');
    const timer = window.setTimeout(() => {
      void searchAccounts(query)
        .then(result => { if (active) setAccountResults(result); })
        .catch(cause => {
          if (!active) return;
          setAccountResults([]);
          setAccountSearchError(cause instanceof Error ? cause.message : 'People search is unavailable right now.');
        })
        .finally(() => { if (active) setAccountSearchLoading(false); });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [search, searchOpen]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  /** Open a booking from the bounded workspace snapshot or fetch its exact record. */
  async function openBookingById(bookingId: string) {
    if (data?.bookings.some(booking => booking.id === bookingId)) {
      setSelectedBookingId(bookingId);
      return;
    }
    try {
      const { booking } = await loadBooking(bookingId);
      setData(current => current ? { ...current, bookings: [...current.bookings, booking] } as WorkspaceResponse : current);
      setSelectedBookingId(bookingId);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'That booking could not be opened.');
    }
  }

  function navigate(nextView: string) {
    if (!data) return;
    const safeView = !canAccessWorkspaceView(data, nextView) ? 'explore' : nextView;
    setCreateOpen(false);
    if (safeView !== view || (safeView === 'chat' && chatThreadId)) {
      setView(safeView);
      // The Chat tab always opens on the list, the way a messaging app does.
      setChatThreadId(null);
      updateRoute(safeView, data.business.id);
      setMainFocusRequest(request => request + 1);
    }
    window.scrollTo({ top: 0 });
  }

  function selectChatThread(threadId: string | null) {
    if (!data) return;
    if (!threadId && window.history.state?.chatListBelow) {
      window.history.back();
      return;
    }
    setView('chat');
    setChatThreadId(threadId);
    // Each opened conversation is a history entry, so Back returns to the
    // list on a phone just as the on-screen back arrow does.
    updateRoute('chat', data.business.id, false, threadId);
  }

  // A proposal accepted in chat books a session this workspace has not
  // loaded yet, so look again before saying it belongs elsewhere.
  async function openBookingFromChat(bookingId: string) {
    let workspace = data;
    if (!workspace?.bookings.some(booking => booking.id === bookingId)) {
      try {
        workspace = await loadWorkspace();
        setData(workspace);
      } catch (cause) {
        toast.error((cause as Error).message);
        return;
      }
    }
    if (workspace.bookings.some(booking => booking.id === bookingId)) setSelectedBookingId(bookingId);
    else toast.message('That session belongs to another club workspace. Switch workspace to open it.');
  }

  async function openChatForBooking(bookingId: string) {
    try {
      const { threadId } = await openBookingChat(bookingId);
      setSelectedBookingId(null);
      selectChatThread(threadId);
      window.scrollTo({ top: 0 });
    } catch (cause) {
      toast.error((cause as Error).message);
    }
  }

  async function switchWorkspace(source: 'MEMBERSHIP' | 'STAFF', access: Membership | ClubStaffWorkspaceAccess) {
    const current = source === 'MEMBERSHIP'
      ? accessMode(data!) === 'COACH' && access.id === data?.membership?.id
      : accessMode(data!) === 'STAFF' && access.id === data?.staffAccess?.id;
    if (switchingAccessId || current || !access.active) {
      setWorkspaceOpen(false);
      return;
    }
    const accessId = `${source}:${access.id}`;
    setSwitchingAccessId(accessId);
    let sessionSwitched = false;
    try {
      const auth = await switchWorkspaceAccess(source, access.id);
      sessionSwitched = true;
      setData(null);
      setError('');
      setWorkspaceOpen(false);
      if (auth.accessMode === 'NONE' || !auth.business) {
        router.replace('/account');
        return;
      }
      routedBusinessId.current = null;
      setView('overview');
      updateRoute('overview', auth.business.id, true);
      setBookingOpen(false);
      setSelectedBookingId(null);
      setSearch('');
      setSearchOpen(false);
      setCreateOpen(false);
      setProfileEditorOpen(false);
      await refresh();
      toast.success(`Switched to ${auth.business.name}`);
      window.scrollTo({ top: 0 });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to switch workspace.';
      if (sessionSwitched) {
        setData(null);
        setError(message);
        if (cause instanceof ApiError && cause.status === 401) router.replace('/login');
        else if (cause instanceof ApiError && cause.status === 403) router.replace('/account');
        toast.error('Workspace changed, but its data could not be loaded. Try again.');
      } else {
        toast.error(message);
      }
    } finally {
      setSwitchingAccessId(null);
    }
  }

  async function signOut() {
    try {
      await mutate('/auth/logout', 'POST');
      router.push('/login');
    } catch (cause) {
      toast.error((cause as Error).message);
    }
  }

  if (!data) {
    return <div className="grid min-h-screen place-items-center p-6"><div className="w-full max-w-md text-center"><div className="wordmark justify-center"><span className="brand-mark" />courtly<span className="ml-[-5px] text-[#9cad76]">.</span></div>{error ? <><h1 className="mt-7 !text-2xl">Let’s get you connected.</h1><p role="alert" className="mt-3 text-sm leading-relaxed text-stone-500">{error}</p><div className="mt-6 flex justify-center gap-3"><Button onClick={() => void initialize()}>Try again</Button><Button variant="outline" asChild><Link href="/login">Sign in</Link></Button></div></> : <><div className="mt-9 flex items-center justify-center gap-2 text-xs text-stone-400"><Loader2 size={15} className="animate-spin" />Getting your day in a good place…</div><p className="mt-3 text-[10px] text-stone-400">Preparing your private demo workspace.</p><div className="mt-8 grid grid-cols-3 gap-3"><div className="skeleton h-20" /><div className="skeleton h-20" /><div className="skeleton h-20" /></div></>}</div></div>;
  }

  const unread = data.notifications.filter(notification => !notification.read).length;
  const mode = accessMode(data);
  const isCoach = mode === 'COACH';
  const isStaff = mode === 'STAFF';
  const clubAccount = mode === 'CLUB_ACCOUNT';
  const clubMemberships = data.memberships.filter(membership =>
    membership.active && membership.business.kind === 'CLUB' && !membership.business.legacyReadOnly,
  );
  const staffWorkspaces = (data.staffAccesses ?? []).filter(access =>
    access.active && access.business.kind === 'CLUB' && !access.business.legacyReadOnly,
  );
  const workspaceAccessCount = clubMemberships.length + staffWorkspaces.length;
  const canSwitchWorkspace = !clubAccount && workspaceAccessCount > 0;
  const permissions = data.permissions ?? data.staffAccess?.permissions ?? [];
  const canCreateBooking = !isStaff || permissions.includes('BOOKINGS_MANAGE');
  const title = isCoach && view === 'availability' ? 'Your availability' : viewTitles[view] || 'Workspace';
  const primaryTab = primaryTabForView(view);
  const searchResults = search.trim().length > 0 ? data.students.filter(student => `${student.name} ${student.email ?? ''}`.toLowerCase().includes(search.toLowerCase())).slice(0, 5) : [];
  const bookingResults = search.trim().length > 0 ? data.bookings.filter(booking => `${booking.serviceName} ${booking.locationName} ${booking.participants.map(participant => participant.name).join(' ')}`.toLowerCase().includes(search.toLowerCase())).slice(0, 5) : [];
  function replayProductTour() {
    if (!data) return;
    replayTourRef.current = true;
    if (view === 'overview') {
      replayTourRef.current = false;
      void startProductTour(workspaceTourContext(data), { force: true });
    } else {
      navigate('overview');
    }
  }

  const primaryNavigation = [
    { id: 'home' as const, label: 'Home', icon: House, action: () => navigate('overview') },
    { id: 'explore' as const, label: 'Explore', icon: Compass, action: () => navigate('explore') },
    { id: 'chat' as const, label: 'Chat', icon: MessageCircle, action: () => navigate('chat') },
    { id: 'profile' as const, label: 'Profile', icon: UserRound, action: () => navigate('profile') },
  ];

  return <div className="app-shell workspace-shell">
    <aside className="sidebar workspace-sidebar desktop-only" aria-label="Workspace navigation" aria-hidden={isMobile ? true : undefined} inert={isMobile ? true : undefined}>
      <button className="wordmark" onClick={() => navigate('overview')} aria-label="Courtly home"><span className="brand-mark" />courtly<span className="ml-[-6px] text-[#9cad76]">.</span></button>
      {/* A club account operates one club, so the sidebar shows the club
          rather than a switcher that can only lead back to itself. */}
      {clubAccount
        ? <div className="workspace-switch text-left"><span className="business-avatar">{initials(data.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold">{data.business.name}</span><span className="mt-1 block text-[9px] text-[#59675c]">{data.business.isDemo ? 'Demo workspace' : 'Club account'}</span></span></div>
        : <button className="workspace-switch text-left" aria-haspopup="dialog" onClick={() => setWorkspaceOpen(true)}><span className="business-avatar">{initials(data.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold">{data.business.name}</span><span className="mt-1 block text-[9px] text-[#59675c]">{data.business.isDemo ? 'Demo workspace' : workspaceAccessCount > 1 ? `${workspaceAccessCount} workspace roles` : isStaff ? 'Staff workspace' : 'Coach workspace'}</span></span><ChevronsUpDown size={12} className="text-[#59675c]" /></button>}
      <nav data-tour="workspace-navigation" className="workspace-primary-nav workspace-primary-nav-desktop mt-5 flex-1" aria-label="Primary">
        {primaryNavigation.slice(0, 2).map(item => <button key={item.id} type="button" className={`nav-link workspace-primary-tab workspace-primary-tab-${item.id} ${primaryTab === item.id ? 'active' : ''}`} aria-current={primaryTab === item.id ? 'page' : undefined} onClick={item.action}><item.icon size={18} strokeWidth={1.65} /><span>{item.label}</span></button>)}
        {canCreateBooking && <button data-tour="workspace-create" type="button" className="nav-link workspace-primary-tab workspace-primary-tab-create" aria-haspopup="dialog" aria-expanded={isCoach ? bookingOpen : createOpen} onClick={() => isCoach ? setBookingOpen(true) : setCreateOpen(true)}><Plus size={19} strokeWidth={1.8} /><span>{isCoach ? 'Book' : 'Create'}</span></button>}
        {primaryNavigation.slice(2).map(item => <button key={item.id} type="button" className={`nav-link workspace-primary-tab workspace-primary-tab-${item.id} ${primaryTab === item.id ? 'active' : ''}`} aria-current={primaryTab === item.id ? 'page' : undefined} aria-label={item.id === 'chat' ? chatTabLabel(chatUnread) : undefined} onClick={item.action}><item.icon size={18} strokeWidth={1.65} /><span>{item.label}</span>{item.id === 'chat' && chatUnread > 0 && <span className="nav-count workspace-tab-badge !bg-[#b3483a] !text-white" aria-hidden="true">{chatBadge(chatUnread)}</span>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="plan-card"><p className="text-[10px] font-semibold text-[#4f6847]">{data.business.isDemo ? 'A space to try things out' : 'Your workspace, your rhythm'}</p><p className="mt-2 text-[10px] leading-[1.65] text-[#59675c]">{data.business.isDemo ? 'Explore a real, private demo. Your changes stay here.' : 'Home, tools, updates, and your profile—all close by.'}</p></div>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="topbar-context flex min-w-0 items-center gap-2"><button className="mobile-workspace-context mobile-menu min-w-0 items-center gap-2 rounded-xl px-1.5 py-1 text-left" onClick={() => canSwitchWorkspace ? setWorkspaceOpen(true) : navigate('profile')} aria-label={canSwitchWorkspace ? `Current workspace ${data.business.name}. Switch workspace` : `Current workspace ${data.business.name}. Open profile`}><span className="business-avatar !h-8 !w-8 shrink-0">{initials(data.business.name)}</span><span className="min-w-0"><span className="block truncate text-[11px] font-semibold text-[#304b39]">{data.business.name}</span><span className="block truncate text-[10px] text-[#59675c]">{title}</span></span>{canSwitchWorkspace && <ChevronsUpDown size={12} className="shrink-0 text-[#71806e]" />}</button><span className="desktop-only truncate text-[12px] font-semibold">{title}</span><span className="desktop-only ml-1 text-[#d4d9cb]">/</span><span className="desktop-only text-[11px] text-[#59675c]">{primaryTab === 'home' ? 'A little clarity for your day' : primaryTab === 'explore' ? 'Everything your business needs' : primaryTab === 'alerts' ? `${unread} unread update${unread === 1 ? '' : 's'}` : primaryTab === 'chat' ? 'Conversations with players, coaches and clubs' : 'Account and workspace'}</span></div><div className="topbar-actions flex items-center gap-2"><span className="desktop-only mr-3 text-[10px] text-[#59675c]">{formatInTimeZone(new Date(), data.business.timezone, 'EEEE, d MMM yyyy')}</span><div className="desktop-only mr-3 h-4 w-px bg-[#e9ece2]" /><button aria-label="Search workspace" className="topbar-action text-[#8a967b]" onClick={() => setSearchOpen(true)}><Search size={18} strokeWidth={1.7} /></button><button type="button" aria-label={alertsButtonLabel(unread)} aria-current={view === 'alerts' ? 'page' : undefined} className={cn('topbar-action topbar-alerts relative text-[#59675c]', view === 'alerts' && 'active')} onClick={() => navigate('alerts')}><Bell size={19} strokeWidth={view === 'alerts' ? 2.2 : 1.7} aria-hidden="true" />{unread > 0 && <span className="topbar-badge" aria-hidden="true">{chatBadge(unread)}</span>}</button><button aria-label="Profile" onClick={() => navigate('profile')} className="topbar-action desktop-only"><span className="tiny-avatar !h-7 !w-7 !bg-[#e8dccc] !text-[#6f5738]">{initials(data.user.name)}</span></button></div></header>
      <main ref={mainRef} tabIndex={-1} aria-label={`${title} workspace view`} className={`content view-${view} ${view === 'calendar' || view === 'bookings' ? 'max-sm:[&>.section-heading>button]:hidden' : ''}`}>
        {isExploreView(view) && (
          <nav aria-label="Explore navigation" className="mb-4">
            <Button type="button" variant="ghost" size="sm" className="-ml-3 text-[#59675c]" onClick={() => navigate('explore')}>
              <ArrowLeft size={14} aria-hidden="true" />
              Back to Explore
            </Button>
          </nav>
        )}
        {view === 'overview' ? isStaff ? <StaffLanding data={data} onNavigate={navigate} home /> : <Dashboard key={data.business.id} data={data} onNavigate={navigate} onNew={() => setBookingOpen(true)} onBooking={bookingId => void openBookingById(bookingId)} />
          : view === 'explore' ? isStaff ? <StaffLanding data={data} onNavigate={navigate} home={false} /> : <ExploreHub data={data} onNavigate={navigate} />
          : view === 'rentals' ? isStaff ? <RentalReservations /> : <RentalExplore />
          : view === 'alerts' ? <AlertsView data={data} refresh={refresh} onOpenBooking={openBookingById} onNavigate={navigate} />
          : view === 'chat' ? <ChatInbox
            key={data.business.id}
            mode="participant"
            viewerType={data.user.accountType}
            viewerUsername={data.user.username}
            threadId={chatThreadId}
            onThreadChange={selectChatThread}
            beginUnreadRequest={beginUnreadRequest}
            commitUnreadNow={commitUnreadNow}
            onOpenBooking={bookingId => void openBookingFromChat(bookingId)}
            onBookingsChanged={() => void refresh().catch(() => undefined)}
            className="md:h-[calc(100dvh-160px)] md:min-h-[520px]"
            heading={{
              eyebrow: data.user.accountType === 'CLUB' ? 'Club conversations' : 'Your conversations',
              title: 'Chats',
              description: data.user.accountType === 'CLUB'
                ? `Message students and coaches as ${data.business.name}, or continue a session conversation.`
                : 'Message students and clubs, or use + in a schedulable conversation to propose a session.',
            }}
          />
          : view === 'profile' ? <ProfileView data={data} onEditProfile={() => setProfileEditorOpen(true)} onSwitchWorkspace={() => setWorkspaceOpen(true)} onBusinessSettings={() => navigate('settings')} onHelp={replayProductTour} onSignOut={() => void signOut()} onNavigate={navigate} refresh={refresh} />
          : view === 'calendar' || view === 'bookings' ? <CalendarView key={`${data.business.id}:${view}`} data={data} onNew={() => setBookingOpen(true)} onBooking={bookingId => void openBookingById(bookingId)} listOnly={view === 'bookings'} />
          : <ManagementView key={`${data.business.id}:${view}`} view={view} data={data} refresh={refresh} />}
      </main>
    </div>

    <nav data-tour="workspace-navigation" className="mobile-bottom workspace-primary-nav workspace-primary-nav-mobile" aria-label="Mobile navigation">
      <button type="button" className={`workspace-primary-tab workspace-primary-tab-home ${primaryTab === 'home' ? 'active' : ''}`} aria-current={primaryTab === 'home' ? 'page' : undefined} onClick={() => navigate('overview')}><House size={20} strokeWidth={1.7} /><span>Home</span></button>
      <button type="button" className={`workspace-primary-tab workspace-primary-tab-explore ${primaryTab === 'explore' ? 'active' : ''}`} aria-current={primaryTab === 'explore' ? 'page' : undefined} onClick={() => navigate('explore')}><Compass size={20} strokeWidth={1.7} /><span>Explore</span></button>
      {canCreateBooking && <button data-tour="workspace-create" type="button" className="mobile-bottom-new workspace-primary-tab workspace-primary-tab-create" aria-label={isCoach ? 'Book' : 'Create'} aria-haspopup="dialog" aria-expanded={isCoach ? bookingOpen : createOpen} onClick={() => isCoach ? setBookingOpen(true) : setCreateOpen(true)}><span className="mobile-bottom-new-icon"><Plus size={23} strokeWidth={2} /></span><span>{isCoach ? 'Book' : 'Create'}</span></button>}
      <button type="button" className={`workspace-primary-tab workspace-primary-tab-chat relative ${primaryTab === 'chat' ? 'active' : ''}`} aria-current={primaryTab === 'chat' ? 'page' : undefined} aria-label={chatTabLabel(chatUnread)} onClick={() => navigate('chat')}><MessageCircle size={20} strokeWidth={1.7} aria-hidden="true" /><span>Chat</span>{chatUnread > 0 && <span className="workspace-tab-badge absolute right-[24%] top-1.5 grid h-4 min-w-4 place-items-center rounded-full border-2 border-white bg-[#b3483a] px-0.5 text-[8px] font-bold leading-none text-white" aria-hidden="true">{chatBadge(chatUnread)}</span>}</button>
      <button type="button" className={`workspace-primary-tab workspace-primary-tab-profile ${primaryTab === 'profile' ? 'active' : ''}`} aria-current={primaryTab === 'profile' ? 'page' : undefined} onClick={() => navigate('profile')}><UserRound size={20} strokeWidth={1.7} /><span>Profile</span></button>
    </nav>

    {!isCoach && canCreateBooking && <CreateDialog open={createOpen} onOpenChange={setCreateOpen} data={data} onNewBooking={() => setBookingOpen(true)} onNavigate={navigate} />}
    {canCreateBooking && <NewBookingDialog data={data} open={bookingOpen} onClose={() => setBookingOpen(false)} refresh={refresh} />}
    <BookingDetail bookingId={selectedBookingId} data={data} onClose={() => setSelectedBookingId(null)} refresh={refresh} onOpenChat={bookingId => void openChatForBooking(bookingId)} />
    <PersonalProfileDialog open={profileEditorOpen} onOpenChange={setProfileEditorOpen} user={data.user} refresh={refresh} />

    <Dialog open={searchOpen} onOpenChange={setSearchOpen}><DialogContent><DialogTitle className="text-lg font-semibold">Search workspace</DialogTitle><DialogDescription className="mt-2 text-xs text-stone-400">Search Courtly people by name, username, or exact email, alongside local students and bookings.</DialogDescription><div className="relative mt-5"><Search className="absolute left-3 top-3 text-stone-400" size={17} /><input aria-label="Search people, students, and bookings" autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, username, exact email, or booking…" className="!pl-10" /></div><div className="mt-4 max-h-80 space-y-1 overflow-y-auto" aria-live="polite" aria-busy={accountSearchLoading}>{accountResults.map(account => <div key={account.username} className="flex w-full items-center gap-3 rounded-lg p-3 text-left"><UserRound size={16} className="shrink-0 text-stone-400" /><span className="min-w-0 flex-1 text-xs"><span className="block truncate">{account.name}</span><span className="mt-1 block truncate text-[10px] text-stone-400">@{account.username}{account.sports.length ? ` · ${account.sports.join(', ')}` : ''}</span></span><span className="text-[9px] font-semibold uppercase tracking-wide text-stone-400">{account.accountType.toLowerCase()}</span></div>)}{searchResults.map(student => <button key={student.id} className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-stone-50" onClick={() => { navigate('students'); setSearchOpen(false); }}><Users size={16} className="text-stone-400" /><span className="text-xs">{student.name}<span className="mt-1 block text-[10px] text-stone-400">Local student · {student.email ?? 'No direct email'}</span></span></button>)}{bookingResults.map(booking => <button key={booking.id} className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-stone-50" onClick={() => { setSelectedBookingId(booking.id); setSearchOpen(false); }}><CalendarDays size={16} className="text-stone-400" /><span className="text-xs">{booking.serviceName}<span className="mt-1 block text-[10px] text-stone-400">{booking.locationName} · {shortDate(booking.startAt)}</span></span></button>)}{accountSearchLoading && <p className="flex items-center justify-center gap-2 py-3 text-xs text-stone-400"><Loader2 size={14} className="animate-spin" />Searching people…</p>}{accountSearchError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{accountSearchError}</p>}{search && !accountSearchLoading && !accountResults.length && !bookingResults.length && !searchResults.length && <p className="py-7 text-center text-xs text-stone-400">No matches just yet. Try another search.</p>}{!search && <p className="py-5 text-center text-xs text-stone-400">Tip: press Ctrl/Command+K to search from anywhere.</p>}</div></DialogContent></Dialog>

    <Dialog open={workspaceOpen && !clubAccount} onOpenChange={open => { if (!switchingAccessId) setWorkspaceOpen(open); }}><DialogContent onEscapeKeyDown={event => { if (switchingAccessId) event.preventDefault(); }} onPointerDownOutside={event => { if (switchingAccessId) event.preventDefault(); }}><DialogTitle className="text-lg font-semibold">Switch workspace</DialogTitle><DialogDescription className="mt-2 text-xs leading-relaxed text-stone-500">Choose a coach affiliation or named staff role. Switching roles never changes your personal account type.</DialogDescription><div className="mt-5 space-y-2">
      {clubMemberships.map(membership => { const current = mode === 'COACH' && membership.id === data.membership?.id; const key = `MEMBERSHIP:${membership.id}`; return <button key={key} type="button" disabled={!!switchingAccessId || current} aria-current={current ? 'true' : undefined} onClick={() => void switchWorkspace('MEMBERSHIP', membership)} className={`flex min-h-16 w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${current ? 'border-[#cbd9bf] bg-[#f0f5e9]' : 'border-[#e3e8df] hover:bg-[#f8faf6]'}`}><span className="business-avatar shrink-0">{initials(membership.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-[#344b39]">{membership.business.name}</span><span className="mt-1 block text-[10px] text-stone-500">Coach affiliation</span></span>{switchingAccessId === key ? <Loader2 size={16} className="shrink-0 animate-spin text-[#69805e]" /> : current ? <span className="flex items-center gap-1 text-[10px] font-semibold text-[#66805a]"><Check size={13} />Current</span> : null}</button>; })}
      {staffWorkspaces.map(access => { const current = mode === 'STAFF' && access.id === data.staffAccess?.id; const key = `STAFF:${access.id}`; return <button key={key} type="button" disabled={!!switchingAccessId || current} aria-current={current ? 'true' : undefined} onClick={() => void switchWorkspace('STAFF', access)} className={`flex min-h-16 w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${current ? 'border-[#cbd9bf] bg-[#f0f5e9]' : 'border-[#e3e8df] hover:bg-[#f8faf6]'}`}><span className="business-avatar shrink-0">{initials(access.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-[#344b39]">{access.business.name}</span><span className="mt-1 block text-[10px] text-stone-500">{access.accessLevel.toLowerCase().replaceAll('_', ' ')} staff access</span></span>{switchingAccessId === key ? <Loader2 size={16} className="shrink-0 animate-spin text-[#69805e]" /> : current ? <span className="flex items-center gap-1 text-[10px] font-semibold text-[#66805a]"><Check size={13} />Current</span> : null}</button>; })}
      {!workspaceAccessCount && <p className="rounded-xl bg-stone-50 p-4 text-xs leading-relaxed text-stone-500">No active club workspaces are available.</p>}
      <Button variant="outline" className="w-full" asChild><Link href="/account">Manage workspace access</Link></Button>
    </div></DialogContent></Dialog>
  </div>;
}
