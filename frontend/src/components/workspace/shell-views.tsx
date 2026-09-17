'use client';

import { useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Bell,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  Clock3,
  Copy,
  CreditCard,
  ExternalLink,
  Gift,
  HelpCircle,
  Link2,
  Loader2,
  LockKeyhole,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  Settings2,
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
import type { AuthSession, MembershipRole, Workspace, WorkspaceUser } from '@/lib/types';
import { initials, shortDate } from '@/lib/utils';

export const exploreViewIds = [
  'calendar',
  'bookings',
  'customers',
  'services',
  'locations',
  'team',
  'availability',
  'packages',
  'payments',
  'insights',
] as const;

export type ExploreViewId = (typeof exploreViewIds)[number];

const coachViews = new Set<ExploreViewId>(['calendar', 'bookings', 'customers', 'availability']);

export function isExploreView(value: string): value is ExploreViewId {
  return exploreViewIds.includes(value as ExploreViewId);
}

export function canAccessExploreView(role: MembershipRole, view: string) {
  return isExploreView(view) && (role !== 'COACH' || coachViews.has(view));
}

type ExploreItem = {
  id: ExploreViewId;
  label: string;
  description: string;
  icon: typeof CalendarDays;
  detail: (data: Workspace) => string;
};

const exploreItems: ExploreItem[] = [
  { id: 'calendar', label: 'Calendar', description: 'See lessons, time, and venue status at a glance.', icon: CalendarDays, detail: data => `${data.bookings.length} total bookings` },
  { id: 'bookings', label: 'Bookings', description: 'Review every lesson and open its full details.', icon: Ticket, detail: data => `${data.bookings.filter(booking => booking.status === 'PENDING').length} awaiting venue` },
  { id: 'customers', label: 'Customers', description: 'Keep player details, notes, and lesson history together.', icon: Users, detail: data => `${data.customers.length} customer${data.customers.length === 1 ? '' : 's'}` },
  { id: 'services', label: 'Services', description: 'Shape the lessons customers can choose and book.', icon: Gift, detail: data => `${data.services.filter(service => service.active).length} active` },
  { id: 'locations', label: 'Locations', description: 'Manage venues, travel time, and approval rules.', icon: MapPin, detail: data => `${data.locations.filter(location => location.active).length} active` },
  { id: 'team', label: 'Your team', description: 'Connect coaches and maintain your teaching roster.', icon: UsersRound, detail: data => `${data.instructors.filter(instructor => instructor.active).length} active` },
  { id: 'availability', label: 'Availability', description: 'Set teaching windows and protect time away.', icon: Clock3, detail: data => `${data.availability.length} weekly windows` },
  { id: 'packages', label: 'Lesson packages', description: 'Track lesson credits and customer commitments.', icon: Ticket, detail: data => `${data.packages.length} package${data.packages.length === 1 ? '' : 's'}` },
  { id: 'payments', label: 'Payments', description: 'Record offline receipts and follow unpaid lessons.', icon: CreditCard, detail: data => `${data.payments.length} recorded` },
  { id: 'insights', label: 'Insights', description: 'Understand attendance, lessons, and recorded receipts.', icon: ChartNoAxesCombined, detail: data => `${data.bookings.filter(booking => booking.status === 'COMPLETED').length} completed lessons` },
];

export function ExploreHub({ data, onNavigate }: { data: Workspace; onNavigate: (view: string) => void }) {
  const restrictedCount = data.membership.role === 'COACH' ? exploreItems.length - coachViews.size : 0;
  return <section className="workspace-explore" aria-labelledby="workspace-explore-title">
    <header className="section-heading">
      <div>
        <p className="eyebrow">Your workspace</p>
        <h1 id="workspace-explore-title" className="mt-2">Explore</h1>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-stone-500">Everything that keeps {data.business.name} moving, gathered in one calm place.</p>
      </div>
    </header>
    {restrictedCount > 0 && <div className="workspace-explore-role-note mb-5 flex items-start gap-3 rounded-xl border border-[#e4e9dd] bg-[#f4f7ef] p-4 text-xs leading-relaxed text-[#66755f]"><ShieldCheck size={17} className="mt-0.5 shrink-0" /><p>Your coach access keeps business setup and financial records private. Ask an owner or administrator if you need one of the locked areas.</p></div>}
    <div className="workspace-explore-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {exploreItems.map(item => {
        const allowed = canAccessExploreView(data.membership.role, item.id);
        const Icon = item.icon;
        return <button
          key={item.id}
          type="button"
          className={`workspace-explore-card group min-h-40 rounded-2xl border p-5 text-left transition ${allowed ? 'border-[#e2e8df] bg-white hover:-translate-y-0.5 hover:border-[#cbd8c5] hover:shadow-sm' : 'cursor-not-allowed border-[#eceeea] bg-[#fafbf9] text-stone-400'}`}
          onClick={() => allowed && onNavigate(item.id)}
          disabled={!allowed}
          aria-label={allowed ? `Open ${item.label}` : `${item.label}, owner or administrator access required`}
        >
          <span className="flex items-start justify-between gap-4">
            <span className={`grid h-10 w-10 place-items-center rounded-xl ${allowed ? 'bg-[#edf2e7] text-[#66805a]' : 'bg-stone-100 text-stone-400'}`}><Icon size={19} strokeWidth={1.6} /></span>
            {allowed ? <ArrowRight size={16} className="mt-1 text-[#a0aa99] transition-transform group-hover:translate-x-0.5" /> : <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-[0.08em] text-stone-400"><LockKeyhole size={11} />Restricted</span>}
          </span>
          <span className={`mt-5 block text-sm font-semibold ${allowed ? 'text-[#294735]' : 'text-stone-500'}`}>{item.label}</span>
          <span className="mt-2 block text-[11px] leading-relaxed text-stone-500">{item.description}</span>
          <span className="mt-4 block text-[10px] text-stone-400">{allowed ? item.detail(data) : 'Owner or administrator access'}</span>
        </button>;
      })}
    </div>
  </section>;
}

function NotificationGroup({ title, notifications, unread }: { title: string; notifications: Workspace['notifications']; unread?: boolean }) {
  if (!notifications.length) return null;
  return <section className="workspace-alert-group" aria-labelledby={`alerts-${unread ? 'unread' : 'read'}-title`}>
    <h2 id={`alerts-${unread ? 'unread' : 'read'}-title`} className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-stone-500">{title}<span className="rounded-full bg-[#edf1e8] px-2 py-0.5 text-[9px] text-[#718166]">{notifications.length}</span></h2>
    <div className="workspace-alert-list overflow-hidden rounded-2xl border border-[#e3e8df] bg-white">
      {notifications.map(notification => <article key={notification.id} className={`workspace-alert-item flex gap-4 border-b border-[#edf0e9] p-4 last:border-b-0 sm:p-5 ${unread ? 'bg-[#f8faf5]' : ''}`}>
        <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${unread ? 'bg-[#e5eddb] text-[#5f7855]' : 'bg-stone-100 text-stone-400'}`}><Bell size={16} strokeWidth={1.6} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3"><h3 className={`text-xs ${unread ? 'font-semibold text-[#294735]' : 'font-medium text-stone-600'}`}>{notification.title}</h3>{unread && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#9a8a58]" aria-label="Unread" />}</div>
          <p className="mt-1.5 text-xs leading-relaxed text-stone-500">{notification.message}</p>
          <p className="mt-2 text-[9px] text-stone-400">{shortDate(notification.createdAt)} · {unread ? 'Unread' : 'Read'}</p>
        </div>
      </article>)}
    </div>
  </section>;
}

export function AlertsView({ data, refresh }: { data: Workspace; refresh: () => Promise<void> }) {
  const [markingRead, setMarkingRead] = useState(false);
  const unread = data.notifications.filter(notification => !notification.read);
  const read = data.notifications.filter(notification => notification.read);
  async function markAllRead() {
    setMarkingRead(true);
    try {
      await mutate('/notifications/read', 'PATCH');
      await refresh();
      toast.success('All updates marked as read');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setMarkingRead(false);
    }
  }
  return <section className="workspace-alerts mx-auto max-w-4xl" aria-labelledby="workspace-alerts-title">
    <header className="section-heading">
      <div>
        <p className="eyebrow">Stay in the loop</p>
        <h1 id="workspace-alerts-title" className="mt-2">Alerts</h1>
        <p className="mt-2 text-xs leading-relaxed text-stone-500">Booking activity from this workspace. External messaging is not connected.</p>
      </div>
      {unread.length > 0 && <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={markingRead}>{markingRead ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}Mark all as read</Button>}
    </header>
    {data.notifications.length ? <div className="space-y-7"><NotificationGroup title="New" notifications={unread} unread /><NotificationGroup title="Earlier" notifications={read} /></div> : <div className="workspace-alerts-empty panel py-16 text-center"><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#edf2e7] text-[#718568]"><Bell size={21} /></span><h2 className="mt-4 text-[#294735]">You’re all caught up</h2><p className="mt-2 text-xs text-stone-500">New booking activity will appear here.</p></div>}
  </section>;
}

type ProfileViewProps = {
  data: Workspace;
  onEditProfile: () => void;
  onSwitchWorkspace: () => void;
  onBusinessSettings: () => void;
  onHelp: () => void;
  onSignOut: () => void;
};

export function ProfileView({ data, onEditProfile, onSwitchWorkspace, onBusinessSettings, onHelp, onSignOut }: ProfileViewProps) {
  const canManageBusiness = data.membership.role !== 'COACH';
  const bookingPath = `/book/${encodeURIComponent(data.business.slug)}`;
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
        <span className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-[#e8dccc] text-xl font-semibold text-[#887052]">{initials(data.user.name)}</span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Personal profile</p>
          <h1 id="workspace-profile-title" className="mt-2 truncate">{data.user.name}</h1>
          <p className="mt-1 break-all text-xs text-stone-500">{data.user.email}</p>
          <div className="mt-3 flex flex-wrap gap-2"><span className="badge">{data.membership.role === 'OWNER' ? 'Workspace owner' : data.membership.role === 'ADMIN' ? 'Workspace admin' : 'Coach'}</span>{data.user.phone && <span className="badge bg-stone-100! text-stone-500!">{data.user.phone}</span>}</div>
        </div>
        <Button variant="outline" onClick={onEditProfile}><Pencil size={14} />Edit personal profile</Button>
      </div>
    </header>
    <div className="workspace-profile-grid grid items-start gap-5 lg:grid-cols-[1.15fr_0.85fr]">
      <div className="space-y-5">
        <section className="panel overflow-hidden">
          <div className="panel-heading"><div className="flex items-center gap-2"><Building2 size={17} className="text-[#839677]" /><h2 className="text-[#294735]">Current business</h2></div><span className="badge">{data.business.isDemo ? 'Demo workspace' : data.membership.role.toLowerCase()}</span></div>
          <div className="px-5 pb-5 sm:px-6 sm:pb-6">
            <div className="flex items-center gap-3 rounded-xl bg-[#f5f7f1] p-4"><span className="business-avatar !h-11 !w-11 shrink-0">{initials(data.business.name)}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[#294735]">{data.business.name}</p><p className="mt-1 text-[10px] text-stone-500">{data.business.tagline || 'Your coaching business, beautifully connected.'}</p></div></div>
            <div className={`mt-4 grid gap-2 ${data.membership.role !== 'COACH' ? 'sm:grid-cols-2' : ''}`}><Button variant="outline" onClick={onSwitchWorkspace}><UsersRound size={14} />Switch business</Button>{data.membership.role !== 'COACH' && <Button variant="outline" onClick={onBusinessSettings}><Settings2 size={14} />Business settings</Button>}</div>
          </div>
        </section>
        {canManageBusiness && <section className="panel overflow-hidden">
          <div className="panel-heading"><div className="flex items-center gap-2"><Link2 size={17} className="text-[#839677]" /><h2 className="text-[#294735]">Your booking link</h2></div><span className="badge">Public page</span></div>
          <div className="px-5 pb-5 sm:px-6 sm:pb-6"><p className="text-xs leading-relaxed text-stone-500">Share this page so customers can choose a service and find an available lesson.</p><div className="mt-4 flex min-w-0 items-center gap-2 rounded-xl border border-[#e3e8df] bg-[#fafbf8] p-3"><span className="min-w-0 flex-1 truncate text-xs text-stone-600">{bookingPath}</span><Button size="icon" variant="ghost" aria-label="Copy booking link" onClick={() => void copyBookingLink()}><Copy size={14} /></Button></div><div className="mt-3 grid grid-cols-1 gap-2 sm:flex"><Button size="sm" onClick={() => void copyBookingLink()}><Copy size={13} />Copy link</Button><Button size="sm" variant="outline" asChild><a href={bookingPath} target="_blank" rel="noreferrer"><ExternalLink size={13} />Open booking page</a></Button></div></div>
        </section>}
      </div>
      <aside className="space-y-5">
        <section className="panel overflow-hidden"><div className="panel-heading"><h2 className="text-[#294735]">Account & support</h2></div><div className="workspace-profile-actions px-3 pb-3"><button type="button" className="nav-link !min-h-11" onClick={onEditProfile}><UserRound size={16} />Personal details<ArrowRight size={13} className="ml-auto" /></button><button type="button" className="nav-link !min-h-11" onClick={onHelp}><HelpCircle size={16} />A little help<ArrowRight size={13} className="ml-auto" /></button><button type="button" className="nav-link !min-h-11 text-[#8b625c]!" onClick={onSignOut}><LogOut size={16} />Sign out</button></div></section>
        {data.business.isDemo && <section className="rounded-2xl border border-[#e1e8d6] bg-[#eef3e6] p-5"><ShieldCheck size={21} className="text-[#7c9169]" /><h2 className="mt-3 text-[#294735]">A private place to explore</h2><p className="mt-2 text-xs leading-relaxed text-[#77866d]">Your changes stay in this demo workspace. When you’re ready, create a business of your own.</p><Button className="mt-4 w-full" asChild><a href="/signup">Create your own workspace</a></Button></section>}
      </aside>
    </div>
  </section>;
}

type CreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: MembershipRole;
  onNewBooking: () => void;
  onNavigate: (view: string) => void;
};

export function CreateDialog({ open, onOpenChange, role, onNewBooking, onNavigate }: CreateDialogProps) {
  const actions = [
    { label: 'Customers', description: 'Open customer records', view: 'customers', icon: Users, coach: true },
    { label: 'Availability', description: 'Shape your teaching week', view: 'availability', icon: Clock3, coach: true },
    { label: 'Services', description: 'Add or edit a lesson', view: 'services', icon: Gift, coach: false },
    { label: 'Locations', description: 'Manage teaching venues', view: 'locations', icon: MapPin, coach: false },
    { label: 'Payments', description: 'Record an offline receipt', view: 'payments', icon: CreditCard, coach: false },
  ].filter(action => role !== 'COACH' || action.coach);
  function go(view: string) { onOpenChange(false); onNavigate(view); }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="workspace-create-dialog max-w-lg"><DialogTitle className="text-lg font-semibold">Create</DialogTitle><DialogDescription className="mt-2 text-xs text-stone-500">Start a booking, or jump to the place where you manage what comes next.</DialogDescription><Button className="mt-5 h-auto w-full justify-start gap-3 rounded-xl p-4 text-left" onClick={() => { onOpenChange(false); window.requestAnimationFrame(onNewBooking); }}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15"><Plus size={18} /></span><span><span className="block text-xs font-semibold">New booking</span><span className="mt-1 block text-[10px] font-normal text-white/75">Choose a lesson, customer, place, and time</span></span></Button><div className="mt-3 grid gap-2 sm:grid-cols-2">{actions.map(action => { const Icon = action.icon; return <button key={action.view} type="button" className="workspace-create-action flex min-h-20 items-center gap-3 rounded-xl border border-[#e3e8df] p-3 text-left transition hover:bg-[#f7f9f4]" onClick={() => go(action.view)}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#edf2e7] text-[#6e835f]"><Icon size={16} /></span><span><span className="block text-xs font-semibold text-[#344b39]">{action.label}</span><span className="mt-1 block text-[10px] text-stone-500">{action.description}</span></span></button>; })}</div></DialogContent></Dialog>;
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
