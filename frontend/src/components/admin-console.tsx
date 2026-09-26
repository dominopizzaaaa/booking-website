'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, Building2, CalendarClock, Check, Layers3, LoaderCircle, LockKeyhole, LogOut, MessageCircle, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, TrendingUp, Users, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  adminBusinesses, adminDeleteBusiness, adminLogin, adminLogout, adminOverview, adminPurgeDemos, adminSession,
  ApiError, type AdminBusiness, type AdminOverview,
} from '@/lib/api';
import { CourtlyLogo } from '@/components/public-booking';
import { ChatInbox } from '@/components/chat/chat-inbox';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'real' | 'demo';
type Section = 'businesses' | 'chats';
const relative = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};
const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export function AdminConsole() {
  const [phase, setPhase] = useState<'loading' | 'unconfigured' | 'login' | 'ready'>('loading');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [loginError, setLoginError] = useState('');

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [businesses, setBusinesses] = useState<AdminBusiness[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [section, setSection] = useState<Section>('businesses');
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loadingData, setLoadingData] = useState(false);
  const [confirm, setConfirm] = useState<AdminBusiness | 'demos' | null>(null);
  const [working, setWorking] = useState(false);
  const cancelConfirmationRef = useRef<HTMLButtonElement>(null);
  const confirmationTriggerRef = useRef<HTMLButtonElement>(null);
  const businessSearchRef = useRef<HTMLInputElement>(null);
  const refreshGenerationRef = useRef(0);

  useEffect(() => {
    adminSession()
      .then(session => setPhase(!session.configured ? 'unconfigured' : session.authenticated ? 'ready' : 'login'))
      .catch(() => setPhase('login'));
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    setLoadingData(true);
    try {
      const [ov, list] = await Promise.all([adminOverview(), adminBusinesses({ search: search.trim() || undefined, filter })]);
      if (generation !== refreshGenerationRef.current) return;
      setOverview(ov);
      setBusinesses(list.businesses);
    } catch (error) {
      if (generation !== refreshGenerationRef.current) return;
      if (error instanceof ApiError && error.status === 401) { setPhase('login'); return; }
      toast.error(errorText(error, 'Could not load platform data.'));
    } finally {
      if (generation === refreshGenerationRef.current) setLoadingData(false);
    }
  }, [search, filter]);

  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = setTimeout(refresh, 250);
    return () => clearTimeout(timer);
  }, [phase, refresh]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signingIn || !password) return;
    setSigningIn(true); setLoginError('');
    try {
      await adminLogin(password);
      setPassword('');
      setPhase('ready');
    } catch (error) {
      setLoginError(errorText(error, 'Sign in failed. Please try again.'));
    } finally {
      setSigningIn(false);
    }
  }
  async function signOut() {
    try { await adminLogout(); } catch { /* ignore */ }
    refreshGenerationRef.current += 1;
    setOverview(null); setBusinesses([]); setPhase('login');
  }
  async function runDelete() {
    if (!confirm || working) return;
    setWorking(true);
    try {
      if (confirm === 'demos') {
        const result = await adminPurgeDemos();
        toast.success(`Removed ${result.deleted} demo ${result.deleted === 1 ? 'workspace' : 'workspaces'}.`);
      } else {
        await adminDeleteBusiness(confirm.id);
        toast.success(`Deleted “${confirm.name}”.`);
      }
      setConfirm(null);
      await refresh();
    } catch (error) {
      toast.error(errorText(error, 'Action failed. Please try again.'));
    } finally {
      setWorking(false);
    }
  }

  if (phase === 'loading') return (
    <main className="grid min-h-screen place-items-center bg-[#f6f7f4] text-[#59675c]">
      <LoaderCircle className="animate-spin" size={26} />
    </main>
  );

  if (phase === 'unconfigured') return (
    <ShellCentered>
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-[#e0e6d7] bg-[#edf2e5] text-[#59675c]"><ShieldCheck size={24} strokeWidth={1.5} /></div>
      <h1 className="!mt-5 !text-[24px] !font-medium !tracking-[-0.6px]">Admin console not configured</h1>
      <p className="!mt-3 text-sm leading-relaxed text-[#59675c]">Set an <code className="rounded bg-[#eef2e8] px-1.5 py-0.5 text-[12px] text-[#4c6046]">ADMIN_PASSWORD</code> environment variable on the backend (Railway), then redeploy to unlock this page.</p>
    </ShellCentered>
  );

  if (phase === 'login') return (
    <ShellCentered>
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-[#e0e6d7] bg-[#edf2e5] text-[#59675c]"><LockKeyhole size={22} strokeWidth={1.5} /></div>
      <p className="!mb-2 !mt-5 text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">PLATFORM ADMINISTRATION</p>
      <h1 className="!text-[26px] !font-medium !tracking-[-0.8px]">Admin sign in</h1>
      <p className="!mt-2.5 text-sm leading-relaxed text-[#59675c]">Enter the platform admin password to manage every workspace on Courtly.</p>
      <form className="!mt-6 space-y-4 text-left" onSubmit={signIn}>
        <div>
          <label htmlFor="admin-password" className="!mb-2 block !text-xs !font-medium !text-[#617257]">Admin password</label>
          <input id="admin-password" type="password" autoFocus autoComplete="current-password" value={password}
            onChange={event => { setPassword(event.target.value); if (loginError) setLoginError(''); }}
            className="!min-h-12 !rounded-xl !border-[#dfe5dd] !px-3.5 !text-base placeholder:!text-[#59675c] sm:!text-sm" placeholder="••••••••••••" disabled={signingIn} />
        </div>
        {loginError && <div role="alert" aria-live="polite" className="rounded-xl border border-[#eedbd4] bg-[#fff6f1] p-3.5 text-xs leading-relaxed text-[#8b4d3c]">{loginError}</div>}
        <button type="submit" disabled={signingIn || !password} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#103e2f] disabled:cursor-wait disabled:opacity-60">
          {signingIn ? <><LoaderCircle size={16} className="animate-spin" />Signing in…</> : <>Unlock admin console<ShieldCheck size={16} /></>}
        </button>
      </form>
    </ShellCentered>
  );

  const t = overview?.totals;
  return (
    <main className="min-h-screen bg-[#f6f7f4] pb-[max(2rem,env(safe-area-inset-bottom))] text-[#1c3029]">
      <header className="sticky top-0 z-20 border-b border-[#e6eae3] bg-[#ffffffe6] backdrop-blur-md">
        <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <CourtlyLogo />
            <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-[#dbe4d3] bg-[#eef3e8] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[1.4px] text-[#5c7150] sm:inline-flex"><ShieldCheck size={12} />Admin</span>
          </div>
          <div className="flex items-center gap-2">
            <button aria-label="Refresh" onClick={() => void refresh()} disabled={loadingData} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl border border-[#dce4d4] bg-white px-3.5 text-xs font-semibold text-[#5b6c53] transition hover:bg-[#f2f5ec] disabled:opacity-60"><RefreshCw size={14} className={cn(loadingData && 'animate-spin')} /><span className="hidden sm:inline">Refresh</span></button>
            <button aria-label="Sign out" onClick={() => void signOut()} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl border border-[#dce4d4] bg-white px-3.5 text-xs font-semibold text-[#5b6c53] transition hover:bg-[#f2f5ec]"><LogOut size={14} /><span className="hidden sm:inline">Sign out</span></button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1180px] px-4 pt-6 sm:px-6 sm:pt-8">
        <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">PLATFORM OVERVIEW</p>
        <h1 className="!mt-1.5 !text-[27px] !font-medium !leading-tight !tracking-[-0.9px] sm:!text-[31px]">Every workspace, at a glance</h1>
        <p className="!mt-2 max-w-xl text-sm leading-relaxed text-[#59675c]">Monitor providers, activity and payments across the whole platform. Deletions here are permanent and cascade to every record a business owns.</p>

        <section className="!mt-6 grid grid-cols-2 gap-3 sm:!mt-7 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard icon={<Building2 size={16} />} label="Businesses" value={t?.businesses} hint={t ? `${t.realBusinesses} real · ${t.demoBusinesses} demo` : undefined} />
          <StatCard icon={<Users size={16} />} label="Students" value={t?.students} hint={t ? `${t.memberships} business affiliations` : undefined} />
          <StatCard icon={<CalendarClock size={16} />} label="Bookings" value={t?.bookings} hint={t ? `${t.upcomingBookings} upcoming` : undefined} />
          <StatCard icon={<TrendingUp size={16} />} label="New this week" value={t?.bookingsLast7Days} hint="bookings created" />
          <StatCard icon={<Wallet size={16} />} label="Student payments" value={t?.paymentsCount} hint={t ? `${formatMoney(t.paymentsTotal)} collected` : undefined} />
          <StatCard icon={<Layers3 size={16} />} label="Packages" value={t?.packages} hint="prepaid plans" />
          <StatCard icon={<MessageCircle size={16} />} label="Session chats" value={t?.chatThreads} hint={t?.chatMessages !== undefined ? `${t.chatMessages.toLocaleString()} messages` : undefined} />
        </section>

        {/* Safety review reads every session chat; nothing here can post. */}
        <div role="group" aria-label="Console section" className="!mt-8 inline-grid grid-cols-2 rounded-xl border border-[#dce4d4] bg-white p-1">
          {(['businesses', 'chats'] as Section[]).map(option => (
            <button key={option} type="button" aria-pressed={section === option} onClick={() => setSection(option)}
              className={cn('min-h-11 rounded-lg px-4 text-xs font-semibold capitalize transition', section === option ? 'bg-[#174c3c] text-white' : 'text-[#5b6c53] hover:bg-[#f2f5ec]')}>
              {option}
            </button>
          ))}
        </div>

        {section === 'chats' && <section className="!mt-5" aria-label="Session chats">
          <ChatInbox
            mode="admin"
            viewerType="ADMIN"
            threadId={chatThreadId}
            onThreadChange={setChatThreadId}
            className="md:h-[calc(100dvh-140px)] md:min-h-[540px]"
            heading={{
              eyebrow: 'Platform safety',
              title: 'Session chats',
              description: 'Read any conversation between students, coaches and clubs. This view is read-only.',
            }}
          />
        </section>}

        {section === 'businesses' && <section className="!mt-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <h2 className="!text-[16px] !font-semibold !tracking-[-0.3px]">Businesses</h2>
              <span className="rounded-full bg-[#e9eee2] px-2 py-0.5 text-[11px] font-semibold text-[#6b7a5f]">{businesses.length}</span>
            </div>
            <div className="grid w-full gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
              <div className="relative w-full sm:w-64">
                <label htmlFor="admin-business-search" className="sr-only">Search businesses</label>
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#9aa48e]" />
                <input ref={businessSearchRef} id="admin-business-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search name, contact, email…" className="!min-h-11 !rounded-xl !border-[#dfe5dd] !pl-9 !pr-3 !text-base sm:!text-sm" />
              </div>
              <div role="group" aria-label="Filter businesses" className="grid w-full grid-cols-3 rounded-xl border border-[#dce4d4] bg-white p-1 sm:flex sm:w-auto">
                {(['all', 'real', 'demo'] as Filter[]).map(option => (
                  <button key={option} aria-pressed={filter === option} onClick={() => setFilter(option)} className={cn('min-h-11 rounded-lg px-3 text-xs font-semibold capitalize transition sm:min-h-9', filter === option ? 'bg-[#174c3c] text-white' : 'text-[#6b7a5f] hover:bg-[#f2f5ec]')}>{option}</button>
                ))}
              </div>
              <button onClick={event => { confirmationTriggerRef.current = event.currentTarget; setConfirm('demos'); }} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#e6d9c9] bg-[#fdf6ee] px-3.5 text-xs font-semibold text-[#70582e] transition hover:bg-[#faeede] sm:w-auto"><Sparkles size={14} />Purge demos</button>
            </div>
          </div>

          <div className="!mt-4 overflow-hidden rounded-2xl border border-[#e6eae3] bg-white">
            {loadingData && !businesses.length ? (
              <div className="grid place-items-center py-16 text-[#59675c]"><LoaderCircle className="animate-spin" size={22} /></div>
            ) : !businesses.length ? (
              <div className="grid place-items-center gap-2 py-16 text-center text-[#59675c]"><Building2 size={26} className="text-[#59675c]" /><p className="text-sm">No businesses match your filters yet.</p></div>
            ) : (
              <>
                {/* Desktop table */}
                <table className="hidden w-full border-collapse text-left text-sm md:table">
                  <thead>
                    <tr className="border-b border-[#eef0e9] text-[10px] uppercase tracking-[0.6px] text-[#59675c]">
                      <th className="px-5 py-3 font-medium">Business</th>
                      <th className="px-3 py-3 font-medium">Contact</th>
                      <th className="px-3 py-3 text-center font-medium">Students</th>
                      <th className="px-3 py-3 text-center font-medium">Bookings</th>
                      <th className="px-3 py-3 text-center font-medium">Places</th>
                      <th className="px-3 py-3 font-medium">Created</th>
                      <th className="px-5 py-3 text-right font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {businesses.map(business => (
                      <tr key={business.id} className="border-b border-[#f0f2e9] last:border-0 hover:bg-[#fafbf8]">
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-2 font-medium text-[#26382f]">
                            <span className="truncate">{business.name}</span>
                            {business.isDemo && <span className="shrink-0 rounded-full bg-[#f8efd7] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#70582e]">Demo</span>}
                          </div>
                          <p className="!mt-0.5 truncate text-[11px] text-[#59675c]">/{business.slug}</p>
                        </td>
                        <td className="px-3 py-3.5"><p className="truncate text-[13px] text-[#4d5e51]">{business.ownerName}</p><p className="truncate text-[11px] text-[#59675c]">{business.email}</p></td>
                        <td className="px-3 py-3.5 text-center tabular-nums text-[#4d5e51]">{business.counts.students}</td>
                        <td className="px-3 py-3.5 text-center tabular-nums text-[#4d5e51]">{business.counts.bookings}</td>
                        <td className="px-3 py-3.5 text-center tabular-nums text-[#4d5e51]">{business.counts.locations}</td>
                        <td className="px-3 py-3.5 text-[12px] text-[#59675c]">{relative(business.createdAt)}</td>
                        <td className="px-5 py-3.5 text-right">
                          <button onClick={event => { confirmationTriggerRef.current = event.currentTarget; setConfirm(business); }} aria-label={`Delete ${business.name}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#f0dcd7] bg-[#fdf3f0] px-3 text-xs font-semibold text-[#8b4d3c] transition hover:bg-[#fbe8e2]"><Trash2 size={13} />Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Mobile cards */}
                <ul className="divide-y divide-[#f0f2e9] md:hidden">
                  {businesses.map(business => (
                    <li key={business.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate font-medium text-[#26382f]">{business.name}</p>
                            {business.isDemo && <span className="shrink-0 rounded-full bg-[#f8efd7] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-[#70582e]">Demo</span>}
                          </div>
                          <p className="!mt-0.5 truncate text-[11px] text-[#59675c]">{business.ownerName} · {business.email}</p>
                        </div>
                        <button onClick={event => { confirmationTriggerRef.current = event.currentTarget; setConfirm(business); }} aria-label={`Delete ${business.name}`} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[#f0dcd7] bg-[#fdf3f0] text-[#8b4d3c]"><Trash2 size={15} /></button>
                      </div>
                      <div className="!mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#59675c]">
                        <span><b className="font-semibold text-[#4d5e51]">{business.counts.students}</b> students</span>
                        <span><b className="font-semibold text-[#4d5e51]">{business.counts.bookings}</b> bookings</span>
                        <span><b className="font-semibold text-[#4d5e51]">{business.counts.locations}</b> places</span>
                        <span>{relative(business.createdAt)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {overview && <p className="!mt-3 text-center text-[11px] text-[#59675c]">Last updated {new Date(overview.generatedAt).toLocaleTimeString()} · showing up to 200 most recent businesses</p>}
        </section>}
      </div>

      <Dialog open={confirm !== null} onOpenChange={open => { if (!open && !working) setConfirm(null); }}>
        {confirm && (
          <DialogContent
            aria-busy={working}
            className="w-full max-w-md rounded-3xl p-6 shadow-2xl max-sm:bottom-0 max-sm:rounded-b-none"
            onEscapeKeyDown={event => { if (working) event.preventDefault(); }}
            onPointerDownOutside={event => { if (working) event.preventDefault(); }}
            onOpenAutoFocus={event => {
              event.preventDefault();
              cancelConfirmationRef.current?.focus();
            }}
            onCloseAutoFocus={event => {
              event.preventDefault();
              const trigger = confirmationTriggerRef.current;
              (working ? businessSearchRef.current : trigger?.isConnected ? trigger : businessSearchRef.current)?.focus();
            }}
          >
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#fdece7] text-[#c06a4f]"><AlertTriangle size={22} /></div>
            <DialogTitle className="!mt-4 !text-[20px] !font-semibold !tracking-[-0.4px]">{confirm === 'demos' ? 'Remove all demo workspaces?' : `Delete “${confirm.name}”?`}</DialogTitle>
            <DialogDescription className="!mt-2 text-sm leading-relaxed text-[#59675c]">
              {confirm === 'demos'
                ? 'This permanently deletes every demo business and all of their data. Real provider accounts are untouched.'
                : 'This permanently deletes the business and every student, booking, package and payment it owns. This cannot be undone.'}
            </DialogDescription>
            <div className="!mt-6 flex gap-3">
              <button ref={cancelConfirmationRef} onClick={() => setConfirm(null)} disabled={working} className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-[#dce4d4] bg-white text-sm font-semibold text-[#5b6c53] transition hover:bg-[#f2f5ec] disabled:opacity-60">Cancel</button>
              <button onClick={() => void runDelete()} disabled={working} className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-[#b0503a] text-sm font-semibold text-white transition hover:bg-[#98432f] disabled:cursor-wait disabled:opacity-60">
                {working ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}{confirm === 'demos' ? 'Purge demos' : 'Delete forever'}
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}

function ShellCentered({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f6f7f4] px-5 py-10 text-[#1c3029]">
      <div className="w-full max-w-[400px] rounded-3xl border border-[#e6eae3] bg-white p-8 text-center shadow-[0_20px_60px_#193d2f12]">{children}</div>
    </main>
  );
}

function StatCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value?: number; hint?: string }) {
  return (
    <div className="rounded-2xl border border-[#e6eae3] bg-white p-4">
      <div className="flex items-center justify-between">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#f2f5ed] text-[#73886b]">{icon}</span>
      </div>
      <p className="!mt-3 text-[26px] font-semibold tabular-nums leading-none tracking-[-0.8px] text-[#26382f]">{value === undefined ? '—' : value.toLocaleString()}</p>
      <p className="!mt-2 text-[12px] font-medium text-[#5b6c53]">{label}</p>
      {hint && <p className="!mt-0.5 truncate text-[11px] text-[#59675c]">{hint}</p>}
    </div>
  );
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}
