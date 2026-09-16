'use client';
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell, CalendarDays, ChartNoAxesCombined, Check, ChevronDown, ChevronsUpDown, CircleHelp, Clock3, CreditCard, ExternalLink, Gift, LayoutDashboard, Loader2, LogOut, MapPin, Menu, Plus, Search, Settings2, ShieldCheck, Sparkles, Ticket, Users, UsersRound, X } from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError, loadWorkspace, mutate } from '@/lib/api';
import type { Booking, Workspace } from '@/lib/types';
import { initials, shortDate } from '@/lib/utils';
import Dashboard, { CalendarView } from './dashboard';
import { ManagementView } from './management';
import { NewBookingDialog, BookingDetail } from './booking-dialogs';
const nav = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'WORKSPACE' },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'bookings', label: 'Bookings', icon: Ticket },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'services', label: 'Services', icon: Gift, group: 'YOUR BUSINESS' },
  { id: 'locations', label: 'Locations', icon: MapPin },
  { id: 'team', label: 'Your team', icon: UsersRound },
  { id: 'availability', label: 'Availability', icon: Clock3 },
  { id: 'packages', label: 'Lesson packages', icon: Ticket },
  { id: 'payments', label: 'Payments', icon: CreditCard },
  { id: 'insights', label: 'Insights', icon: ChartNoAxesCombined },
];
export default function WorkspaceApp() {
  const router = useRouter();
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const initialized = useRef(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const returnDialogFocusToNavigation = useRef(false);
  const refresh = useCallback(async () => { setData(await loadWorkspace()); }, []);
  const initialize = useCallback(async () => {
    setError('');
    try { await refresh(); } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        try { await api('/auth/demo', { method: 'POST' }); await refresh(); }
        catch (demoError) {
          if (demoError instanceof ApiError && demoError.status === 403) router.replace('/login');
          else setError((demoError as Error).message);
        }
      } else setError((e as Error).message);
    }
  }, [refresh, router]);
  useEffect(() => { if (!initialized.current) { initialized.current = true; void initialize(); } }, [initialize]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); if (mobileOpen) { setMobileOpen(false); window.requestAnimationFrame(() => drawerTriggerRef.current?.focus()); return; } setSearchOpen(v => !v); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [mobileOpen]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => { setIsMobile(media.matches); if (!media.matches) setMobileOpen(false); };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const closeNavigation = useCallback((restoreFocus = false) => {
    setMobileOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => drawerTriggerRef.current?.focus());
  }, []);
  useEffect(() => {
    if (!mobileOpen || !isMobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { closeNavigation(true); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || []).filter(element => element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !drawerRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    window.requestAnimationFrame(() => drawerCloseRef.current?.focus());
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown); };
  }, [closeNavigation, isMobile, mobileOpen]);
  function openNavigation(event: ReactMouseEvent<HTMLButtonElement>) { drawerTriggerRef.current = event.currentTarget; event.currentTarget.blur(); setMobileOpen(true); }
  function openDialogFromNavigation(open: () => void) { if (!isMobile) { open(); return; } returnDialogFocusToNavigation.current = true; setMobileOpen(false); window.requestAnimationFrame(open); }
  function restoreFocusAfterNavigationDialog(event: Event) { if (!returnDialogFocusToNavigation.current) return; event.preventDefault(); returnDialogFocusToNavigation.current = false; drawerTriggerRef.current?.focus(); }
  function navigate(next: string) { const restoreFocus = isMobile && mobileOpen; setView(next); setMobileOpen(false); if (restoreFocus) window.requestAnimationFrame(() => drawerTriggerRef.current?.focus()); window.scrollTo({ top: 0 }); }
  if (!data) return <div className="grid min-h-screen place-items-center p-6"><div className="w-full max-w-md text-center"><div className="wordmark justify-center"><span className="brand-mark" />courtly<span className="ml-[-5px] text-[#9cad76]">.</span></div>{error ? <><h1 className="mt-7 !text-2xl">Let’s get you connected.</h1><p role="alert" className="mt-3 text-sm leading-relaxed text-stone-500">{error}</p><div className="mt-6 flex justify-center gap-3"><Button onClick={() => initialize()}>Try again</Button><Button variant="outline" asChild><Link href="/login">Sign in</Link></Button></div></> : <><div className="mt-9 flex items-center justify-center gap-2 text-xs text-stone-400"><Loader2 size={15} className="animate-spin" />Getting your day in a good place…</div><p className="mt-3 text-[10px] text-stone-400">Preparing your private demo workspace.</p><div className="mt-8 grid grid-cols-3 gap-3"><div className="skeleton h-20" /><div className="skeleton h-20" /><div className="skeleton h-20" /></div></>}</div></div>;
  const unread = data.notifications.filter(n => !n.read).length;
  const title = nav.find(n => n.id === view)?.label || 'Settings';
  const searchResults = search.trim().length > 0 ? data.customers.filter(c => `${c.name} ${c.email}`.toLowerCase().includes(search.toLowerCase())).slice(0, 5) : [];
  const bookingResults = search.trim().length > 0 ? data.bookings.filter(b => `${b.serviceName} ${b.locationName} ${b.participants.map(p => p.name).join(' ')}`.toLowerCase().includes(search.toLowerCase())).slice(0, 5) : [];
  return <div className="app-shell">
    {mobileOpen && isMobile && <button type="button" tabIndex={-1} aria-hidden="true" className="mobile-drawer-backdrop" onClick={() => closeNavigation(true)} />}
    <aside ref={drawerRef} id="workspace-navigation" className={`sidebar ${mobileOpen ? 'open' : ''}`} aria-label="Workspace navigation" aria-hidden={isMobile && !mobileOpen ? true : undefined} aria-modal={isMobile && mobileOpen ? true : undefined} role={isMobile && mobileOpen ? 'dialog' : undefined} inert={isMobile && !mobileOpen ? true : undefined}><div className="flex items-center justify-between px-3"><button className="wordmark" onClick={() => navigate('overview')} aria-label="Courtly overview"><span className="brand-mark" />courtly<span className="ml-[-6px] text-[#9cad76]">.</span></button><button ref={drawerCloseRef} className="drawer-close mobile-menu text-stone-400" onClick={() => closeNavigation(true)} aria-label="Close navigation"><X size={20} /></button></div>
      <button className="workspace-switch text-left" onClick={() => navigate('settings')}><span className="business-avatar">{initials(data.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-semibold">{data.business.name}</span><span className="mt-1 block text-[9px] text-[#a4ab99]">{data.business.isDemo ? 'Demo workspace' : 'Business workspace'}</span></span><ChevronsUpDown size={12} className="text-[#a4ab99]" /></button>
      <nav className="flex-1">{nav.filter(n => data.user.role !== 'COACH' || ['overview', 'calendar', 'bookings', 'customers', 'availability'].includes(n.id)).map(n => <div key={n.id}>{n.group && <p className="nav-caption">{n.group}</p>}<button className={`nav-link ${view === n.id ? 'active' : ''}`} aria-current={view === n.id ? 'page' : undefined} onClick={() => navigate(n.id)}><n.icon size={16} strokeWidth={1.65} /><span>{n.label}</span>{n.id === 'bookings' && data.bookings.some(b => b.status === 'PENDING') && <span className="nav-count">{data.bookings.filter(b => b.status === 'PENDING').length}</span>}</button></div>)}</nav>
      <div className="sidebar-bottom"><button className={`nav-link ${view === 'settings' ? 'active' : ''}`} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Settings2 size={16} strokeWidth={1.65} />Settings</button><button className="nav-link" onClick={() => openDialogFromNavigation(() => setHelpOpen(true))}><CircleHelp size={16} strokeWidth={1.65} />A little help</button><div className="plan-card"><div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold text-[#7b8a64]"><Sparkles size={12} />{data.business.isDemo ? 'A space to try things out' : 'Made for your next chapter'}</div><p className="text-[10px] leading-[1.65] text-[#a0a98d]">{data.business.isDemo ? 'Explore a real, private demo. Your changes stay in this workspace.' : 'Your coaching business, beautifully connected.'}</p>{data.business.isDemo && <Link href="/signup" className="mt-3 flex items-center justify-between text-[10px] font-semibold text-[#718557]">Make it yours<ExternalLink size={11} /></Link>}</div><button className="sidebar-account flex w-full items-center gap-2.5 border-t border-[#edf0e7] px-2 pt-4 text-left" onClick={() => openDialogFromNavigation(() => setAccountOpen(true))}><span className="tiny-avatar !h-8 !w-8 !min-w-8 !bg-[#e8dccc] !text-[10px] !text-[#887052]">{initials(data.user.name)}</span><span className="flex-1"><span className="block text-[11px] font-semibold">{data.user.name}</span><span className="mt-1 block text-[9px] text-[#a0a88f]">{data.user.role === 'OWNER' ? 'Workspace owner' : 'Team member'}</span></span><ChevronDown size={12} className="text-[#a0a88f]" /></button></div>
    </aside>
    <div className="main-shell" aria-hidden={isMobile && mobileOpen ? true : undefined} inert={isMobile && mobileOpen ? true : undefined}><header className="topbar"><div className="topbar-context flex min-w-0 items-center gap-2"><button className="topbar-action mobile-menu" onClick={openNavigation} aria-label="Open navigation" aria-controls="workspace-navigation" aria-expanded={mobileOpen}><Menu size={21} /></button><span className="truncate text-[12px] font-semibold">{title}</span><span className="desktop-only ml-1 text-[#d4d9cb]">/</span><span className="desktop-only text-[11px] text-[#a6ac9b]">{view === 'overview' ? 'A little clarity for your day' : 'Your coaching workspace'}</span></div><div className="topbar-actions flex items-center gap-2"><span className="desktop-only mr-3 text-[10px] text-[#949e85]">{formatInTimeZone(new Date(), data.business.timezone, 'EEEE, d MMM yyyy')}</span><div className="desktop-only mr-3 h-4 w-px bg-[#e9ece2]" /><button aria-label="Search workspace" className="topbar-action text-[#8a967b]" onClick={() => setSearchOpen(true)}><Search size={18} strokeWidth={1.7} /></button><button aria-label="Notifications" className="topbar-action relative text-[#8a967b]" onClick={() => setNotificationsOpen(true)}><Bell size={18} strokeWidth={1.7} />{unread > 0 && <span className="absolute right-2.5 top-2 h-1.5 w-1.5 rounded-full border border-white bg-[#b3a16c]" />}</button><button aria-label="Account" onClick={() => setAccountOpen(true)} className="topbar-action"><span className="tiny-avatar !h-7 !w-7 !bg-[#e8dccc] !text-[#8e7857]">{initials(data.user.name)}</span></button></div></header>
      <main className={`content view-${view}`}>{view === 'overview' ? <Dashboard data={data} onNavigate={navigate} onNew={() => setBookingOpen(true)} onBooking={setSelectedBooking} /> : view === 'calendar' || view === 'bookings' ? <CalendarView key={view} data={data} onNew={() => setBookingOpen(true)} onBooking={setSelectedBooking} listOnly={view === 'bookings'} /> : <ManagementView key={view} view={view} data={data} refresh={refresh} />}</main>
    </div>
    <nav className="mobile-bottom" aria-label="Mobile navigation" aria-hidden={isMobile && mobileOpen ? true : undefined} inert={isMobile && mobileOpen ? true : undefined}><button className={view === 'overview' ? 'active' : ''} aria-current={view === 'overview' ? 'page' : undefined} onClick={() => navigate('overview')}><LayoutDashboard size={20} strokeWidth={1.7} /><span>Home</span></button><button className={view === 'calendar' ? 'active' : ''} aria-current={view === 'calendar' ? 'page' : undefined} onClick={() => navigate('calendar')}><CalendarDays size={20} strokeWidth={1.7} /><span>Calendar</span></button><button className="mobile-bottom-new" onClick={() => setBookingOpen(true)} aria-label="New booking"><span className="mobile-bottom-new-icon"><Plus size={23} strokeWidth={2} /></span><span>New</span></button><button className={view === 'bookings' ? 'active' : ''} aria-current={view === 'bookings' ? 'page' : undefined} onClick={() => navigate('bookings')}><Ticket size={20} strokeWidth={1.7} /><span>Bookings</span></button><button className={!['overview', 'calendar', 'bookings'].includes(view) ? 'active' : ''} aria-current={!['overview', 'calendar', 'bookings'].includes(view) ? 'page' : undefined} onClick={openNavigation} aria-label="More navigation" aria-controls="workspace-navigation" aria-expanded={mobileOpen}><Menu size={20} strokeWidth={1.7} /><span>More</span></button></nav>
    <NewBookingDialog data={data} open={bookingOpen} onClose={() => setBookingOpen(false)} refresh={refresh} /><BookingDetail booking={selectedBooking} data={data} onClose={() => setSelectedBooking(null)} refresh={refresh} />
    <Dialog open={searchOpen} onOpenChange={setSearchOpen}><DialogContent><DialogTitle className="text-lg font-semibold">Find your next thing</DialogTitle><DialogDescription className="mt-2 text-xs text-stone-400">Search customers, services, locations, and lessons.</DialogDescription><div className="relative mt-5"><Search className="absolute left-3 top-3 text-stone-400" size={17} /><input aria-label="Search customers and bookings" autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="A name, a lesson, a place…" className="!pl-10" /></div><div className="mt-4 max-h-80 space-y-1 overflow-y-auto">{searchResults.map(c => <button key={c.id} className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-stone-50" onClick={() => { navigate('customers'); setSearchOpen(false); }}><Users size={16} className="text-stone-400" /><span className="text-xs">{c.name}<span className="mt-1 block text-[10px] text-stone-400">{c.email}</span></span></button>)}{bookingResults.map(b => <button key={b.id} className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-stone-50" onClick={() => { setSelectedBooking(b); setSearchOpen(false); }}><CalendarDays size={16} className="text-stone-400" /><span className="text-xs">{b.serviceName}<span className="mt-1 block text-[10px] text-stone-400">{b.locationName} · {shortDate(b.startAt)}</span></span></button>)}{search && !bookingResults.length && !searchResults.length && <p className="py-7 text-center text-xs text-stone-400">No matches just yet. Try another search.</p>}{!search && <p className="py-5 text-center text-xs text-stone-400">Tip: press ⌘K to search from anywhere.</p>}</div></DialogContent></Dialog>
    <Dialog open={notificationsOpen} onOpenChange={setNotificationsOpen}><DialogContent><DialogTitle className="text-lg font-semibold">Your updates</DialogTitle><DialogDescription className="mt-2 text-xs text-stone-400">Booking activity in your workspace. External messaging is not connected.</DialogDescription><div className="mt-5 max-h-96 space-y-3 overflow-y-auto">{data.notifications.slice(0, 12).map(n => <div key={n.id} className={`rounded-lg border p-3 ${n.read ? 'border-stone-100' : 'border-[#e2ead9] bg-[#f6f8f1]'}`}><p className="text-xs font-semibold">{n.title}</p><p className="mt-1.5 text-xs leading-relaxed text-stone-500">{n.message}</p><p className="mt-2 text-[9px] text-stone-400">{shortDate(n.createdAt)}</p></div>)}{!data.notifications.length && <p className="py-8 text-center text-xs text-stone-400">You’re all caught up.</p>}</div>{unread > 0 && <Button variant="outline" size="sm" className="mt-4" onClick={async () => { try { await mutate('/notifications/read', 'PATCH'); await refresh(); } catch (e) { toast.error((e as Error).message); } }}><Check size={13} />Mark all as read</Button>}</DialogContent></Dialog>
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent onCloseAutoFocus={restoreFocusAfterNavigationDialog}><DialogTitle className="text-lg font-semibold">A little help to get going</DialogTitle><DialogDescription className="mt-2 text-xs text-stone-400">Less admin. More time doing what you love.</DialogDescription><div className="mt-6 space-y-5 text-xs leading-relaxed">{[['1', 'Make yourself at home', 'Add the places you teach, then create your services. Set duration, pricing, and instructors for each location.'], ['2', 'Give your week some shape', 'Set location-specific working hours in Availability. Travel buffers protect time between venues; blocked dates keep your days off clear.'], ['3', 'Let the bookings come to you', 'Share your booking link. Customers see only available slots. Recurring lessons are checked together, so conflicts never silently slip through.'], ['4', 'Keep the real world in the loop', 'A pending lesson holds instructor time, but does not reserve a court. Secure your venue separately, then confirm it. Payments and messages are manual in this MVP.']].map(([n, title, body]) => <div className="flex gap-3" key={n}><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#edf2e5] text-[#7e926c]">{n}</span><div><h3>{title}</h3><p className="mt-1 text-stone-500">{body}</p></div></div>)}</div></DialogContent></Dialog>
    <Dialog open={accountOpen} onOpenChange={setAccountOpen}><DialogContent onCloseAutoFocus={restoreFocusAfterNavigationDialog}><DialogTitle className="text-lg font-semibold">{data.user.name}</DialogTitle><DialogDescription className="mt-2 text-xs text-stone-500">{data.user.email}</DialogDescription><div className="mt-5 space-y-3"><div className="flex items-center gap-2 rounded-lg bg-stone-50 p-3 text-xs"><ShieldCheck size={15} />{data.business.isDemo ? 'Private demo workspace · sample data' : `${data.business.name} · ${data.user.role.toLowerCase()}`}</div>{data.business.isDemo && <Button className="w-full" asChild><Link href="/signup">Create your own workspace</Link></Button>}<Button className="w-full" variant="outline" onClick={() => { setAccountOpen(false); navigate('settings'); }}><Settings2 size={14} />Business settings</Button><Button className="w-full" variant="ghost" onClick={async () => { try { await mutate('/auth/logout', 'POST'); router.push('/login'); } catch (e) { toast.error((e as Error).message); } }}><LogOut size={14} />Sign out</Button></div></DialogContent></Dialog>
  </div>;
}
