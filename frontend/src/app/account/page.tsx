'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Building2, Check, Loader2, LogOut, Plus, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import { api, ApiError, createOwnPractice, mutate } from '@/lib/api';
import type { AuthSession, Membership } from '@/lib/types';
import { initials } from '@/lib/utils';

export default function AccountPage() {
  const router = useRouter();
  const [state, setState] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [practiceName, setPracticeName] = useState('');
  const [creatingPractice, setCreatingPractice] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const auth = await api<AuthSession>('/auth/me');
      if (auth.user.accountType === 'CUSTOMER') { router.replace('/manage'); return; }
      setState(auth);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { router.replace('/login'); return; }
      setError(cause instanceof Error ? cause.message : 'Unable to load your account.');
    } finally { setLoading(false); }
  }, [router]);
  useEffect(() => { void load(); }, [load]);
  async function openWorkspace(membership: Membership) {
    if (switching || !membership.active) return;
    setSwitching(membership.id); setError('');
    try {
      const auth = await api<AuthSession>('/auth/switch-workspace', { method: 'POST', body: JSON.stringify({ membershipId: membership.id }) });
      if (!auth.membership || !auth.business) throw new Error('That workspace is not available right now.');
      router.replace('/'); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to open that workspace.'); }
    finally { setSwitching(null); }
  }
  // A coach's personal students have nothing to do with a club: those lessons
  // are paid straight to the coach. Running them needs a workspace of their
  // own, which is the one workspace a coach creates rather than being added to.
  async function startPractice() {
    const name = practiceName.trim();
    if (name.length < 2) { setError('Give your practice a name of at least two characters.'); return; }
    setCreatingPractice(true); setError('');
    try {
      const auth = await createOwnPractice(name);
      if (!auth.membership || !auth.business) throw new Error('Your practice was created but could not be opened. Refresh and try again.');
      router.replace('/'); router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create your practice.');
      setCreatingPractice(false);
    }
  }

  async function logout() {
    try { await mutate('/auth/logout', 'POST'); router.replace('/login'); router.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to sign out.'); }
  }

  return <main className="min-h-screen bg-[#f6f7f4] px-5 py-6 text-[#1c3029] sm:px-10 sm:py-9">
    <div className="mx-auto max-w-3xl">
      <header className="flex items-center justify-between gap-4"><Link href="/" aria-label="Courtly home"><CourtlyLogo /></Link>{state && <Button variant="ghost" onClick={() => { void logout(); }}><LogOut size={15} />Sign out</Button>}</header>
      <section className="mx-auto mt-16 max-w-2xl sm:mt-24">
        {loading ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><Loader2 size={24} className="animate-spin text-[#71865f]" /><p className="mt-4 text-sm text-stone-500">Loading your Courtly account…</p></div> : error && !state ? <div className="rounded-2xl border border-[#eedbd4] bg-white p-7 text-center shadow-sm"><h1 className="text-2xl">We couldn’t load your account.</h1><p role="alert" className="mt-3 text-sm text-[#a16a55]">{error}</p><Button className="mt-6" onClick={() => { void load(); }}><RefreshCw size={15} />Try again</Button></div> : state ? <>
          <div className="text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[#e0e6d7] bg-[#edf2e5] text-[#758b66]"><UserRound size={25} strokeWidth={1.5} /></span><p className="mt-6 text-[10px] font-semibold uppercase tracking-[2px] text-[#95a085]">Your Courtly account</p><h1 className="mt-2 !text-[32px] !font-medium !tracking-[-1px]">Welcome, {state.user.name}.</h1><p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-stone-500">{state.memberships.some(item => item.active) ? 'Choose the business workspace you want to open.' : 'Your coach account is ready. A club adds you to its roster using the email below — you cannot join a club yourself.'}</p></div>
          <div className="mt-8 rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6">
            <div className="flex items-start gap-3 rounded-xl bg-[#f4f7ef] p-4"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-[#6f865f]" /><div><p className="text-xs font-semibold text-[#405941]">{state.user.email}</p><p className="mt-1 text-[11px] leading-relaxed text-stone-500">This is the email a club owner should use to add you. Your password remains private.</p></div></div>
            <div className="mt-5 space-y-3">{state.memberships.map(membership => <button key={membership.id} type="button" disabled={!!switching || !membership.active} onClick={() => { void openWorkspace(membership); }} className="flex min-h-[72px] w-full items-center gap-3 rounded-xl border border-[#e2e7dd] p-3.5 text-left transition hover:border-[#cbd9bf] hover:bg-[#f8faf5] disabled:cursor-not-allowed disabled:opacity-55"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf2e6] text-xs font-semibold text-[#617851]">{initials(membership.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[#344b39]">{membership.business.name}</span><span className="mt-1 block text-[10px] capitalize text-stone-500">{membership.active ? membership.role.toLowerCase() : `${membership.role.toLowerCase()} · inactive`}</span></span>{switching === membership.id ? <Loader2 size={17} className="animate-spin text-[#71865f]" /> : membership.id === state.membership?.id ? <span className="flex items-center gap-1 text-[10px] font-semibold text-[#66805a]"><Check size={13} />Selected</span> : <ArrowRight size={16} className="text-stone-400" />}</button>)}
              {!state.memberships.length && <div className="py-5 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[#f0f3ec] text-[#809174]"><Building2 size={19} /></span><h2 className="mt-4 text-sm">No club access yet</h2><p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-stone-500">Share your account email with the club or academy. A club adds you to its roster; you cannot join one yourself. Once they add you, return here and refresh.</p></div>}
            </div>
            {state.user.accountType !== 'CUSTOMER' && !state.memberships.some(membership => membership.business.kind === 'SOLO' && membership.role === 'OWNER') && <div className="mt-5 rounded-xl border border-[#e2e7dd] bg-[#fafbf8] p-4">
              <div className="flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#edf2e6] text-[#617851]"><Plus size={17} /></span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-xs font-semibold text-[#405941]">Teach your own students too?</h2>
                  <p className="mt-1 text-[11px] leading-relaxed text-stone-500">Set up your own practice for students who come to you directly, separately from any club. Those lessons are paid straight to you.</p>
                  <div className="mt-3 flex gap-2 max-sm:flex-col">
                    <input aria-label="Name your practice" value={practiceName} onChange={event => { setPracticeName(event.target.value); if (error) setError(''); }} maxLength={120} placeholder="e.g. Jamie Lee Coaching" className="min-w-0 flex-1" disabled={creatingPractice} />
                    <Button variant="outline" className="shrink-0" disabled={creatingPractice || practiceName.trim().length < 2} onClick={() => { void startPractice(); }}>{creatingPractice ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}Create practice</Button>
                  </div>
                </div>
              </div>
            </div>}
            {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-xs text-red-700">{error}</p>}
            <div className="mt-5 flex flex-wrap justify-center gap-2 border-t border-[#edf0e8] pt-5"><Button variant="outline" disabled={loading || !!switching} onClick={() => { void load(); }}><RefreshCw size={14} />Refresh access</Button>{state.membership && <Button disabled={!!switching} onClick={() => { const selected = state.memberships.find(item => item.id === state.membership?.id); if (selected) void openWorkspace(selected); }}>Open current workspace<ArrowRight size={14} /></Button>}</div>
          </div>
        </> : null}
      </section>
    </div>
  </main>;
}
