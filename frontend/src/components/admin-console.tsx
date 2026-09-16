'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Building2, CalendarClock, Check, Layers3, LoaderCircle, LockKeyhole, LogOut, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, TrendingUp, Users, Wallet, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  adminBusinesses, adminDeleteBusiness, adminLogin, adminLogout, adminOverview, adminPurgeDemos, adminSession,
  ApiError, type AdminBusiness, type AdminOverview,
} from '@/lib/api';
import { CourtlyLogo } from '@/components/public-booking';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'real' | 'demo';
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
  const [search, setSearch] = useState('');
  const [loadingData, setLoadingData] = useState(false);
  const [confirm, setConfirm] = useState<AdminBusiness | 'demos' | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    adminSession()
      .then(session => setPhase(!session.configured ? 'unconfigured' : session.authenticated ? 'ready' : 'login'))
      .catch(() => setPhase('login'));
  }, []);

  const refresh = useCallback(async () => {
    setLoadingData(true);
    try {
      const [ov, list] = await Promise.all([adminOverview(), adminBusinesses({ search: search.trim() || undefined, filter })]);
      setOverview(ov);
      setBusinesses(list.businesses);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { setPhase('login'); return; }
      toast.error(errorText(error, 'Could not load platform data.'));
    } finally {
      setLoadingData(false);
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
    <main className="grid min-h-screen place-items-center bg-[#f6f7f4] text-[#7d8a7b]">
      <LoaderCircle className="animate-spin" size={26} />
    </main>
  );

  if (phase === 'unconfigured') return (
    <ShellCentered>
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-[#e0e6d7] bg-[#edf2e5] text-[#849970]"><ShieldCheck size={24} strokeWidth={1.5} /></div>
      <h1 className="!mt-5 !text-[24px] !font-medium !tracking-[-0.6px]">Admin console not configured</h1>
      <p className="!mt-3 text-sm leading-relaxed text-[#8a957f]">Set an <code className="rounded bg-[#eef2e8] px-1.5 py-0.5 text-[12px] text-[#4c6046]">ADMIN_PASSWORD</code> environment variable on the backend (Railway), then redeploy to unlock this page.</p>
    </ShellCentered>
  );

  if (phase === 'login') return (
    <ShellCentered>
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-[#e0e6d7] bg-[#edf2e5] text-[#849970]"><LockKeyhole size={22} strokeWidth={1.5} /></div>
      <p className="!mb-2 !mt-5 text-[10px] font-semibold uppercase tracking-[2px] text-[#95a085]">PLATFORM ADMINISTRATION</p>
      <h1 className="!text-[26px] !font-medium !tracking-[-0.8px]">Admin sign in</h1>
      <p className="!mt-2.5 text-sm leading-relaxed text-[#8a957f]">Enter the platform admin password to manage every workspace on Courtly.</p>
      <form className="!mt-6 space-y-4 text-left" onSubmit={signIn}>
        <div>
          <label htmlFor="admin-password" className="!mb-2 block !text-xs !font-medium !text-[#617257]">Admin password</label>
          <input id="admin-password" type="password" autoFocus autoComplete="current-password" value={password}
            onChange={event => { setPassword(event.target.value); if (loginError) setLoginError(''); }}
            className="!min-h-12 !rounded-xl !border-[#dfe5dd] !px-3.5 !text-base placeholder:!text-[#a7afa0] sm:!text-sm" placeholder="••••••••••••" disabled={signingIn} />
        </div>
        {loginError && <div role="alert" aria-live="polite" className="rounded-xl border border-[#eedbd4] bg-[#fff6f1] p-3.5 text-xs leading-relaxed text-[#a16a55]">{loginError}</div>}
        <button type="submit" disabled={signingIn || !password} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#103e2f] disabled:cursor-wait disabled:opacity-60">
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
            <button onClick={() => void refresh()} disabled={loadingData} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#dce4d4] bg-white px-3.5 text-xs font-semibold text-[#5b6c53] transition hover:bg-[#f2f5ec] disabled:opacity-60"><RefreshCw size={14} className={cn(loadingData && 'animate-spin')} /><span className="hidden sm:inline">Refresh</span></button>
            <button onClick={() => void signOut()} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#dce4d4] bg-white px-3.5 text-xs font-semibold text-[#5b6c53] transition hover:bg-[#f2f5ec]"><LogOut size={14} /><span className="hidden sm:inline">Sign out</span></button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1180px] px-4 pt-6 sm:px-6 sm:pt-8">
        <p className="text-[10px] font-semibold uppercase tracking-[2px] text-[#95a085]">PLATFORM OVERVIEW</p>
        <h1 className="!mt-1.5 !text-[27px] !font-medium !leading-tight !tracking-[-0.9px] sm:!text-[31px]">Every workspace, at a glance</h1>
        <p className="!mt-2 max-w-xl text-sm leading-relaxed text-[#8a957f]">Monitor providers, activity and payments across the whole platform. Deletions here are permanent and cascade to every record a business owns.</p>

        <section className="!mt-6 grid grid-cols-2 gap-3 sm:!mt-7 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard icon={<Building2 size={16} />} label="Businesses" value={t?.businesses} hint={t ? `${t.realBusinesses} real · ${t.demoBusinesses} demo` : undefined} />
          <StatCard icon={<Users size={16} />} label="Customers" value={t?.customers} hint={t ? `${t.users} staff logins` : undefined} />
          <StatCard icon={<CalendarClock size={16} />} label="Bookings" value={t?.bookings} hint={t ? `${t.upcomingBookings} upcoming` : undefined} />
          <StatCard icon={<TrendingUp size={16} />} label="New this week" value={t?.bookingsLast7Days} hint="bookings created" />
          <StatCard icon={<Wallet size={16} />} label="Payments logged" value={t?.paymentsCount} hint={t ? formatMoney(t.paymentsTotal) : undefined} />
          <StatCard icon={<Layers3 size={16} />} label="Packages" value={t?.packages} hint="prepaid plans" />
        </section>

        <section className="!mt-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <h2 className="!text-[16px] !font-semibold !tracking-[-0.3px]">Businesses</h2>
              <span className="rounded-full bg-[#e9eee2] px-2 py-0.5 text-[11px] font-semibold text-[#6b7a5f]">{businesses.length}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#9aa48e]" />
                <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search name, owner, email…" className="!min-h-11 !rounded-xl !border-[#dfe5dd] !pl-9 !pr-3 !text-base sm:!text-sm" />
              </div>
              <div className="flex rounded-xl border border-[#dce4d4] bg-white p-1">
                {(['all', 'real', 'demo'] as Filter[]).map(option => (
                  <button key={option} onClick={() => setFilter(option)} className={cn('min-h-9 rounded-lg px-3 text-xs font-semibold capitalize transition', filter === option ? 'bg-[#174c3c] text-white' : 'text-[#6b7a5f] hover:bg-[#f2f5ec]')}>{option}</button>
                ))}
              </div>
              <button onClick={() => setConfirm('demos')} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#e6d9c9] bg-[#fdf6ee] px-3.5 text-xs font-semibold text-[#a97b46] transition hover:bg-[#faeede]"><Sparkles size={14} />Purge demos</button>
            </div>
          </div>

          <div className="!mt-4 overflow-hidden rounded-2xl border border-[#e6eae3] bg-white">
            {loadingData && !businesses.length ? (
              <div className="grid place-items-center py-16 text-[#9aa48e]"><LoaderCircle className="animate-spin" size={22} /></div>
            ) : !businesses.length ? (
              <div className="grid place-items-center gap-2 py-16 text-center text-[#8a957f]"><Building2 size={26} className="text-[#b3bfa7]" /><p className="text-sm">No businesses match your filters yet.</p></div>
            ) : (
              <>
                {/* Desktop table */}
                <table className="hidden w-full border-collapse text-left text-sm md:table">
                  <thead>
                    <tr className="border-b border-[#eef0e9] text-[10px] uppercase tracking-[0.6px] text-[#a1a794]">
                      <th className="px-5 py-3 font-medium">Business</th>
                      <th className="px-3 py-3 font-medium">Owner</th>
                      <th className="px-3 py-3 text-center font-medium">Customers</th>
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
                            {business.isDemo && <span className="shrink-0 rounded-full bg-[#f8efd7] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[#a1854c]">Demo</span>}
                          </div>
                          <p className="!mt-0.5 truncate text-[11px] text-[#98a08e]">/{business.slug}</p>
                        </td>
                        <td className="px-3 py-3.5"><p className="truncate text-[13px] text-[#4d5e51]">{business.ownerName}</p><p className="truncate text-[11px] text-[#98a08e]">{business.email}</p></td>
                        <td className="px-3 py-3.5 text-center tabular-nums text-[#4d5e51]">{business.counts.customers}</td>
                        <td className="px-3 py-3.5 text-center tabular-nums text-[#4d5e51]">{business.counts.bookings}</td>
                        <td className="px-3 py-3.5 text-center tabular-nums text-[#4d5e51]">{business.counts.locations}</td>
                        <td className="px-3 py-3.5 text-[12px] text-[#818c78]">{relative(business.createdAt)}</td>
                        <td className="px-5 py-3.5 text-right">
                          <button onClick={() => setConfirm(business)} aria-label={`Delete ${business.name}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#f0dcd7] bg-[#fdf3f0] px-3 text-xs font-semibold text-[#b0654f] transition hover:bg-[#fbe8e2]"><Trash2 size={13} />Delete</button>
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
                            {business.isDemo && <span className="shrink-0 rounded-full bg-[#f8efd7] px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-[#a1854c]">Demo</span>}
                          </div>
                          <p className="!mt-0.5 truncate text-[11px] text-[#98a08e]">{business.ownerName} · {business.email}</p>
                        </div>
                        <button onClick={() => setConfirm(business)} aria-label={`Delete ${business.name}`} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-[#f0dcd7] bg-[#fdf3f0] text-[#b0654f]"><Trash2 size={15} /></button>
                      </div>
                      <div className="!mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#818c78]">
                        <span><b className="font-semibold text-[#4d5e51]">{business.counts.customers}</b> customers</span>
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
          {overview && <p className="!mt-3 text-center text-[11px] text-[#a1a794]">Last updated {new Date(overview.generatedAt).toLocaleTimeString()} · showing up to 200 most recent businesses</p>}
        </section>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 grid place-items-end bg-[#112c2252] p-0 backdrop-blur-sm sm:place-items-center sm:p-4" onClick={() => !working && setConfirm(null)}>
          <div className="w-full rounded-t-3xl bg-white p-6 shadow-2xl sm:max-w-md sm:rounded-3xl" onClick={event => event.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#fdece7] text-[#c06a4f]"><AlertTriangle size={22} /></div>
              <button onClick={() => !working && setConfirm(null)} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-xl text-[#9aa48e] hover:bg-[#f2f5ec]"><X size={18} /></button>
            </div>
            <h2 className="!mt-4 !text-[20px] !font-semibold !tracking-[-0.4px]">{confirm === 'demos' ? 'Remove all demo workspaces?' : `Delete “${confirm.name}”?`}</h2>
            <p className="!mt-2 text-sm leading-relaxed text-[#7c8878]">
              {confirm === 'demos'
                ? 'This permanently deletes every demo business and all of their data. Real provider accounts are untouched.'
                : 'This permanently deletes the business and every customer, booking, package and payment it owns. This cannot be undone.'}
            </p>
            <div className="!mt-6 flex gap-3">
              <button onClick={() => setConfirm(null)} disabled={working} className="inline-flex min-h-12 flex-1 items-center justify-center rounded-xl border border-[#dce4d4] bg-white text-sm font-semibold text-[#5b6c53] transition hover:bg-[#f2f5ec] disabled:opacity-60">Cancel</button>
              <button onClick={() => void runDelete()} disabled={working} className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-[#b0503a] text-sm font-semibold text-white transition hover:bg-[#98432f] disabled:cursor-wait disabled:opacity-60">
                {working ? <LoaderCircle size={16} className="animate-spin" /> : <Check size={16} />}{confirm === 'demos' ? 'Purge demos' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
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
      {hint && <p className="!mt-0.5 truncate text-[11px] text-[#98a08e]">{hint}</p>}
    </div>
  );
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'SGD', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}
