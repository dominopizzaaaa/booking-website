'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  Plus,
  Search,
  UserRound,
  Users,
} from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError, loadWorkspace, mutate, searchAccounts } from '@/lib/api';
import type { AccountDirectoryUser, AccountType, AuthSession, BusinessKind, Membership, WorkspaceResponse } from '@/lib/types';
import { initials, shortDate } from '@/lib/utils';
import Dashboard, { CalendarView } from './dashboard';
import { ManagementView } from './management';
import { NewBookingDialog, BookingDetail } from './booking-dialogs';
import { RentalExplore } from './rental-explore';
import {
  AlertsView,
  canAccessExploreView,
  CreateDialog,
  isExploreView,
  PersonalProfileDialog,
  ProfileView,
} from './shell-views';

type PrimaryTab = 'home' | 'explore' | 'alerts' | 'profile';

const viewTitles: Record<string, string> = {
  overview: 'Home',
  explore: 'Explore',
  alerts: 'Alerts',
  profile: 'Profile',
  calendar: 'Calendar',
  bookings: 'Bookings',
  students: 'Students',
  services: 'Classes',
  locations: 'Locations',
  team: 'My coaches',
  availability: 'Availability',
  packages: 'Packages',
  payments: 'Payments',
  insights: 'Insights',
  settings: 'Settings',
};

function primaryTabForView(view: string): PrimaryTab {
  if (view === 'overview') return 'home';
  if (view === 'alerts') return 'alerts';
  if (view === 'profile' || view === 'settings') return 'profile';
  return 'explore';
}

function routeView(accountType: AccountType, businessKind: BusinessKind) {
  const isClubCoach = accountType === 'COACH' && businessKind === 'CLUB';
  const parameters = new URLSearchParams(window.location.search);
  const tab = parameters.get('tab');
  const nestedView = parameters.get('view');
  if (tab === 'alerts') return 'alerts';
  if (tab === 'profile') return nestedView === 'settings' && !isClubCoach ? 'settings' : 'profile';
  if (tab === 'explore') return nestedView && canAccessExploreView({ accountType, businessKind }, nestedView) ? nestedView : 'explore';
  if (!tab && nestedView) {
    if (nestedView === 'settings') return isClubCoach ? 'profile' : 'settings';
    if (canAccessExploreView({ accountType, businessKind }, nestedView)) return nestedView;
  }
  return 'overview';
}

function updateRoute(view: string, businessId: string, replace = false) {
  const url = new URL(window.location.href);
  if (url.pathname !== '/') return;
  url.searchParams.delete('tab');
  url.searchParams.delete('view');
  const tab = primaryTabForView(view);
  url.searchParams.set('tab', tab);
  if (isExploreView(view) || view === 'settings') url.searchParams.set('view', view);
  window.history[replace ? 'replaceState' : 'pushState']({ ...(window.history.state || {}), tab, view, workspaceBusinessId: businessId }, '', url);
}

export default function WorkspaceApp() {
  const router = useRouter();
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('overview');
  const [bookingOpen, setBookingOpen] = useState(false);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [accountResults, setAccountResults] = useState<AccountDirectoryUser[]>([]);
  const [accountSearchLoading, setAccountSearchLoading] = useState(false);
  const [accountSearchError, setAccountSearchError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [switchingMembershipId, setSwitchingMembershipId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [mainFocusRequest, setMainFocusRequest] = useState(0);
  const initialized = useRef(false);
  const routedBusinessId = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    const workspace = await loadWorkspace();
    setData(workspace);
  }, [router]);

  const initialize = useCallback(async () => {
    setError('');
    try {
      await refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        router.replace('/login');
      } else if (cause instanceof ApiError && cause.status === 403) {
        try {
          const auth = await api<AuthSession>('/auth/me');
          router.replace(auth.user.accountType === 'STUDENT' ? '/manage' : auth.membership && auth.business ? '/' : '/account');
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
      : routeView(data.user.accountType, data.business.kind);
    setView(next);
    updateRoute(next, data.business.id, true);
  }, [data]);

  useEffect(() => {
    if (!data) return;
    const handleHistory = () => {
      setBookingOpen(false);
      setSelectedBookingId(null);
      setSearchOpen(false);
      setSearch('');
      setCreateOpen(false);
      setHelpOpen(false);
      setProfileEditorOpen(false);
      setWorkspaceOpen(false);
      if (window.location.pathname !== '/') return;

      const historyBusinessId = window.history.state?.workspaceBusinessId;
      const next = typeof historyBusinessId === 'string' && historyBusinessId !== data.business.id
        ? 'overview'
        : routeView(data.user.accountType, data.business.kind);
      if (next !== view) {
        setView(next);
        setMainFocusRequest(request => request + 1);
      }
      // Next's App Router also restores its URL state during popstate. Let that
      // listener finish before replacing a stale workspace entry, otherwise it
      // can restore the old query string after this handler has corrected it.
      window.requestAnimationFrame(() => updateRoute(next, data.business.id, true));
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

  /** Open a booking named by an alert, so an alert can lead somewhere. */
  function openBookingById(bookingId: string) {
    const found = data?.bookings.some(booking => booking.id === bookingId);
    if (!found) {
      toast.error('That booking is no longer in this workspace.');
      return;
    }
    setSelectedBookingId(bookingId);
  }

  function navigate(nextView: string) {
    if (!data) return;
    const isClubCoach = data.user.accountType === 'COACH' && data.business.kind === 'CLUB';
    const safeView = isClubCoach && nextView === 'settings'
      ? 'profile'
      : isExploreView(nextView) && !canAccessExploreView({ accountType: data.user.accountType, businessKind: data.business.kind }, nextView)
        ? 'explore'
        : nextView;
    setCreateOpen(false);
    if (safeView !== view) {
      setView(safeView);
      updateRoute(safeView, data.business.id);
      setMainFocusRequest(request => request + 1);
    }
    window.scrollTo({ top: 0 });
  }

  async function switchWorkspace(membership: Membership) {
    if (switchingMembershipId || membership.id === data?.membership?.id || !membership.active) {
      setWorkspaceOpen(false);
      return;
    }
    setSwitchingMembershipId(membership.id);
    let sessionSwitched = false;
    try {
      const auth = await api<AuthSession>('/auth/switch-workspace', { method: 'POST', body: JSON.stringify({ membershipId: membership.id }) });
      sessionSwitched = true;
      setData(null);
      setError('');
      setWorkspaceOpen(false);
      if (!auth.membership || !auth.business) {
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
      setHelpOpen(false);
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
      setSwitchingMembershipId(null);
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
  const accountType = data.user.accountType;
  const isCoach = accountType === 'COACH';
  const clubAccount = accountType === 'CLUB';
  const clubMemberships = data.memberships.filter(membership =>
    membership.active && membership.business.kind === 'CLUB' && !membership.business.legacyReadOnly,
  );
  const title = isCoach && view === 'availability' ? 'Your availability' : viewTitles[view] || 'Workspace';
  const primaryTab = primaryTabForView(view);
  const searchResults = search.trim().length > 0 ? data.students.filter(student => `${student.name} ${student.email}`.toLowerCase().includes(search.toLowerCase())).slice(0, 5) : [];
  const bookingResults = search.trim().length > 0 ? data.bookings.filter(booking => `${booking.serviceName} ${booking.locationName} ${booking.participants.map(participant => participant.name).join(' ')}`.toLowerCase().includes(search.toLowerCase())).slice(0, 5) : [];
  const helpSteps = isCoach
    ? [
        ['1', 'Review your schedule', 'Use Calendar and Bookings to see your assigned lessons, times, students, and venue status.'],
        ['2', 'Know your students', 'Open Students to review the players assigned to you and the context you need for each lesson.'],
        ['3', 'Set your availability', 'Shape your weekly teaching hours and block dates when you are away.'],
        ['4', 'Record attendance', 'Open a booking after the lesson to mark each student as attended or a no-show.'],
      ]
    : [
        ['1', 'Make yourself at home', 'Add the places your coaches teach, then create your classes. Set duration, pricing, and coaches for each location.'],
        ['2', 'Give your week some shape', 'Set location-specific working hours in Availability. Travel buffers protect time between venues; blocked dates keep your days off clear.'],
        ['3', 'Let the bookings come to you', 'Share your booking link. Students see only available slots. Recurring lessons are checked together, so conflicts never silently slip through.'],
        ['4', 'Keep the real world in the loop', 'A pending class holds coach time, but does not reserve a court. Secure an external venue separately, then confirm it. Student checkout uses simulated Stripe, so no real card is charged.'],
      ];

  const primaryNavigation = [
    { id: 'home' as const, label: 'Home', icon: House, action: () => navigate('overview') },
    { id: 'explore' as const, label: 'Explore', icon: Compass, action: () => navigate('explore') },
    { id: 'alerts' as const, label: 'Alerts', icon: Bell, action: () => navigate('alerts') },
    { id: 'profile' as const, label: 'Profile', icon: UserRound, action: () => navigate('profile') },
  ];

  return <div className="app-shell workspace-shell">
    <aside className="sidebar workspace-sidebar desktop-only" aria-label="Workspace navigation" aria-hidden={isMobile ? true : undefined} inert={isMobile ? true : undefined}>
      <button className="wordmark" onClick={() => navigate('overview')} aria-label="Courtly home"><span className="brand-mark" />courtly<span className="ml-[-6px] text-[#9cad76]">.</span></button>
      {/* A club account operates one club, so the sidebar shows the club
          rather than a switcher that can only lead back to itself. */}
      {clubAccount
        ? <div className="workspace-switch text-left"><span className="business-avatar">{initials(data.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold">{data.business.name}</span><span className="mt-1 block text-[9px] text-[#59675c]">{data.business.isDemo ? 'Demo workspace' : 'Club account'}</span></span></div>
        : <button className="workspace-switch text-left" aria-haspopup="dialog" onClick={() => setWorkspaceOpen(true)}><span className="business-avatar">{initials(data.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold">{data.business.name}</span><span className="mt-1 block text-[9px] text-[#59675c]">{data.business.isDemo ? 'Demo workspace' : clubMemberships.length > 1 ? `${clubMemberships.length} club workspaces` : 'Coach workspace'}</span></span><ChevronsUpDown size={12} className="text-[#59675c]" /></button>}
      <nav className="workspace-primary-nav workspace-primary-nav-desktop mt-5 flex-1" aria-label="Primary">
        {primaryNavigation.slice(0, 2).map(item => <button key={item.id} type="button" className={`nav-link workspace-primary-tab workspace-primary-tab-${item.id} ${primaryTab === item.id ? 'active' : ''}`} aria-current={primaryTab === item.id ? 'page' : undefined} onClick={item.action}><item.icon size={18} strokeWidth={1.65} /><span>{item.label}</span></button>)}
        <button type="button" className="nav-link workspace-primary-tab workspace-primary-tab-create" aria-haspopup="dialog" aria-expanded={isCoach ? bookingOpen : createOpen} onClick={() => isCoach ? setBookingOpen(true) : setCreateOpen(true)}><Plus size={19} strokeWidth={1.8} /><span>{isCoach ? 'Book' : 'Create'}</span></button>
        {primaryNavigation.slice(2).map(item => <button key={item.id} type="button" className={`nav-link workspace-primary-tab workspace-primary-tab-${item.id} ${primaryTab === item.id ? 'active' : ''}`} aria-current={primaryTab === item.id ? 'page' : undefined} onClick={item.action}><item.icon size={18} strokeWidth={1.65} /><span>{item.label}</span>{item.id === 'alerts' && unread > 0 && <span className="nav-count workspace-tab-badge">{unread}<span className="sr-only"> unread</span></span>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="plan-card"><p className="text-[10px] font-semibold text-[#4f6847]">{data.business.isDemo ? 'A space to try things out' : 'Your workspace, your rhythm'}</p><p className="mt-2 text-[10px] leading-[1.65] text-[#59675c]">{data.business.isDemo ? 'Explore a real, private demo. Your changes stay here.' : 'Home, tools, updates, and your profile—all close by.'}</p></div>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="topbar-context flex min-w-0 items-center gap-2"><button className="topbar-action mobile-menu" onClick={() => navigate('explore')} aria-label="Explore"><Compass size={20} /></button><span className="truncate text-[12px] font-semibold">{title}</span><span className="desktop-only ml-1 text-[#d4d9cb]">/</span><span className="desktop-only text-[11px] text-[#59675c]">{primaryTab === 'home' ? 'A little clarity for your day' : primaryTab === 'explore' ? 'Everything your business needs' : primaryTab === 'alerts' ? `${unread} unread update${unread === 1 ? '' : 's'}` : 'Account and workspace'}</span></div><div className="topbar-actions flex items-center gap-2"><span className="desktop-only mr-3 text-[10px] text-[#59675c]">{formatInTimeZone(new Date(), data.business.timezone, 'EEEE, d MMM yyyy')}</span><div className="desktop-only mr-3 h-4 w-px bg-[#e9ece2]" /><button aria-label="Search workspace" className="topbar-action text-[#8a967b]" onClick={() => setSearchOpen(true)}><Search size={18} strokeWidth={1.7} /></button><button aria-label="Notifications" className="topbar-action desktop-only relative text-[#8a967b]" onClick={() => navigate('alerts')}><Bell size={18} strokeWidth={1.7} />{unread > 0 && <span className="absolute right-2.5 top-2 h-1.5 w-1.5 rounded-full border border-white bg-[#b3a16c]" />}</button><button aria-label="Profile" onClick={() => navigate('profile')} className="topbar-action desktop-only"><span className="tiny-avatar !h-7 !w-7 !bg-[#e8dccc] !text-[#6f5738]">{initials(data.user.name)}</span></button></div></header>
      <main ref={mainRef} tabIndex={-1} aria-label={`${title} workspace view`} className={`content view-${view} ${view === 'calendar' || view === 'bookings' ? 'max-sm:[&>.section-heading>button]:hidden' : ''}`}>
        {isExploreView(view) && (
          <nav aria-label="Explore navigation" className="mb-4">
            <Button type="button" variant="ghost" size="sm" className="-ml-3 text-[#59675c]" onClick={() => navigate('explore')}>
              <ArrowLeft size={14} aria-hidden="true" />
              Back to Explore
            </Button>
          </nav>
        )}
        {view === 'overview' ? <Dashboard key={data.business.id} data={data} onNavigate={navigate} onNew={() => setBookingOpen(true)} onBooking={setSelectedBookingId} />
          : view === 'explore' ? <RentalExplore data={data} onNavigate={navigate} />
          : view === 'alerts' ? <AlertsView data={data} refresh={refresh} onOpenBooking={openBookingById} onNavigate={navigate} />
          : view === 'profile' ? <ProfileView data={data} onEditProfile={() => setProfileEditorOpen(true)} onSwitchWorkspace={() => setWorkspaceOpen(true)} onBusinessSettings={() => navigate('settings')} onHelp={() => setHelpOpen(true)} onSignOut={() => void signOut()} onNavigate={navigate} />
          : view === 'calendar' || view === 'bookings' ? <CalendarView key={`${data.business.id}:${view}`} data={data} onNew={() => setBookingOpen(true)} onBooking={setSelectedBookingId} listOnly={view === 'bookings'} />
          : <ManagementView key={`${data.business.id}:${view}`} view={view} data={data} refresh={refresh} />}
      </main>
    </div>

    <nav className="mobile-bottom workspace-primary-nav workspace-primary-nav-mobile" aria-label="Mobile navigation">
      <button type="button" className={`workspace-primary-tab workspace-primary-tab-home ${primaryTab === 'home' ? 'active' : ''}`} aria-current={primaryTab === 'home' ? 'page' : undefined} onClick={() => navigate('overview')}><House size={20} strokeWidth={1.7} /><span>Home</span></button>
      <button type="button" className={`workspace-primary-tab workspace-primary-tab-explore ${primaryTab === 'explore' ? 'active' : ''}`} aria-current={primaryTab === 'explore' ? 'page' : undefined} onClick={() => navigate('explore')}><Compass size={20} strokeWidth={1.7} /><span>Explore</span></button>
      <button type="button" className="mobile-bottom-new workspace-primary-tab workspace-primary-tab-create" aria-label={isCoach ? 'Book' : 'Create'} aria-haspopup="dialog" aria-expanded={isCoach ? bookingOpen : createOpen} onClick={() => isCoach ? setBookingOpen(true) : setCreateOpen(true)}><span className="mobile-bottom-new-icon"><Plus size={23} strokeWidth={2} /></span><span>{isCoach ? 'Book' : 'Create'}</span></button>
      <button type="button" className={`workspace-primary-tab workspace-primary-tab-alerts relative ${primaryTab === 'alerts' ? 'active' : ''}`} aria-current={primaryTab === 'alerts' ? 'page' : undefined} onClick={() => navigate('alerts')}><Bell size={20} strokeWidth={1.7} /><span>Alerts</span>{unread > 0 && <span className="workspace-tab-badge absolute right-[27%] top-2 h-1.5 w-1.5 rounded-full bg-[#a18f58]"><span className="sr-only">{unread} unread</span></span>}</button>
      <button type="button" className={`workspace-primary-tab workspace-primary-tab-profile ${primaryTab === 'profile' ? 'active' : ''}`} aria-current={primaryTab === 'profile' ? 'page' : undefined} onClick={() => navigate('profile')}><UserRound size={20} strokeWidth={1.7} /><span>Profile</span></button>
    </nav>

    {!isCoach && <CreateDialog open={createOpen} onOpenChange={setCreateOpen} data={data} onNewBooking={() => setBookingOpen(true)} onNavigate={navigate} />}
    <NewBookingDialog data={data} open={bookingOpen} onClose={() => setBookingOpen(false)} refresh={refresh} />
    <BookingDetail bookingId={selectedBookingId} data={data} onClose={() => setSelectedBookingId(null)} refresh={refresh} />
    <PersonalProfileDialog open={profileEditorOpen} onOpenChange={setProfileEditorOpen} user={data.user} refresh={refresh} />

    <Dialog open={searchOpen} onOpenChange={setSearchOpen}><DialogContent><DialogTitle className="text-lg font-semibold">Search workspace</DialogTitle><DialogDescription className="mt-2 text-xs text-stone-400">Search Courtly people by name, username, or exact email, alongside local students and bookings.</DialogDescription><div className="relative mt-5"><Search className="absolute left-3 top-3 text-stone-400" size={17} /><input aria-label="Search people, students, and bookings" autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, username, exact email, or booking…" className="!pl-10" /></div><div className="mt-4 max-h-80 space-y-1 overflow-y-auto" aria-live="polite" aria-busy={accountSearchLoading}>{accountResults.map(account => <div key={account.username} className="flex w-full items-center gap-3 rounded-lg p-3 text-left"><UserRound size={16} className="shrink-0 text-stone-400" /><span className="min-w-0 flex-1 text-xs"><span className="block truncate">{account.name}</span><span className="mt-1 block truncate text-[10px] text-stone-400">@{account.username}{account.sports.length ? ` · ${account.sports.join(', ')}` : ''}</span></span><span className="text-[9px] font-semibold uppercase tracking-wide text-stone-400">{account.accountType.toLowerCase()}</span></div>)}{searchResults.map(student => <button key={student.id} className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-stone-50" onClick={() => { navigate('students'); setSearchOpen(false); }}><Users size={16} className="text-stone-400" /><span className="text-xs">{student.name}<span className="mt-1 block text-[10px] text-stone-400">Local student · {student.email}</span></span></button>)}{bookingResults.map(booking => <button key={booking.id} className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-stone-50" onClick={() => { setSelectedBookingId(booking.id); setSearchOpen(false); }}><CalendarDays size={16} className="text-stone-400" /><span className="text-xs">{booking.serviceName}<span className="mt-1 block text-[10px] text-stone-400">{booking.locationName} · {shortDate(booking.startAt)}</span></span></button>)}{accountSearchLoading && <p className="flex items-center justify-center gap-2 py-3 text-xs text-stone-400"><Loader2 size={14} className="animate-spin" />Searching people…</p>}{accountSearchError && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-700">{accountSearchError}</p>}{search && !accountSearchLoading && !accountResults.length && !bookingResults.length && !searchResults.length && <p className="py-7 text-center text-xs text-stone-400">No matches just yet. Try another search.</p>}{!search && <p className="py-5 text-center text-xs text-stone-400">Tip: press Ctrl/Command+K to search from anywhere.</p>}</div></DialogContent></Dialog>

    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent><DialogTitle className="text-lg font-semibold">{isCoach ? 'Help with your coaching workspace' : 'A little help to get going'}</DialogTitle><DialogDescription className="mt-2 text-xs text-stone-400">{isCoach ? 'Your schedule, students, availability, and attendance—all in one place.' : 'Less admin. More time doing what you love.'}</DialogDescription><div className="mt-6 space-y-5 text-xs leading-relaxed">{helpSteps.map(([number, heading, body]) => <div className="flex gap-3" key={number}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#edf2e5] text-[#7e926c]">{number}</span><div><h3>{heading}</h3><p className="mt-1 text-stone-500">{body}</p></div></div>)}</div></DialogContent></Dialog>

    <Dialog open={workspaceOpen && !clubAccount} onOpenChange={open => { if (!switchingMembershipId) setWorkspaceOpen(open); }}><DialogContent onEscapeKeyDown={event => { if (switchingMembershipId) event.preventDefault(); }} onPointerDownOutside={event => { if (switchingMembershipId) event.preventDefault(); }}><DialogTitle className="text-lg font-semibold">Switch workspace</DialogTitle><DialogDescription className="mt-2 text-xs leading-relaxed text-stone-500">Switch between clubs or academies that have added your coach account to their roster.</DialogDescription><div className="mt-5 space-y-2">{clubMemberships.map(membership => { const current = membership.id === data.membership?.id || membership.business.id === data.business.id; return <button key={membership.id} type="button" disabled={!!switchingMembershipId || current} aria-current={current ? 'true' : undefined} onClick={() => void switchWorkspace(membership)} className={`flex min-h-16 w-full items-center gap-3 rounded-xl border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${current ? 'border-[#cbd9bf] bg-[#f0f5e9]' : 'border-[#e3e8df] hover:bg-[#f8faf6]'}`}><span className="business-avatar shrink-0">{initials(membership.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-[#344b39]">{membership.business.name}</span><span className="mt-1 block text-[10px] text-stone-500">Club or academy</span></span>{switchingMembershipId === membership.id ? <Loader2 size={16} className="shrink-0 animate-spin text-[#69805e]" /> : current ? <span className="flex items-center gap-1 text-[10px] font-semibold text-[#66805a]"><Check size={13} />Current</span> : null}</button>; })}{!clubMemberships.length && <p className="rounded-xl bg-stone-50 p-4 text-xs leading-relaxed text-stone-500">No active club workspaces are available.</p>}</div></DialogContent></Dialog>
  </div>;
}
