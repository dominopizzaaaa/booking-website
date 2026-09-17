'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Building2, Check, Loader2, LogOut, Pencil, Plus, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-react';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import { api, ApiError, createOwnPractice, mutate } from '@/lib/api';
import type { AuthSession, Business, Membership } from '@/lib/types';
import { initials } from '@/lib/utils';

const inputClass = '!min-h-11 !rounded-xl !border-[#dfe5dd] !px-3.5 !text-sm';

function workspaceDescription(membership: Membership) {
  const label = membership.business.kind === 'SOLO' ? 'Independent practice' : 'Club or academy';
  return membership.active ? label : `${label} · inactive`;
}

export default function AccountPage() {
  const router = useRouter();
  const [state, setState] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [practiceName, setPracticeName] = useState('');
  const [creatingPractice, setCreatingPractice] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const auth = await api<AuthSession>('/auth/me');
      if (auth.user.accountType === 'STUDENT') {
        router.replace('/manage');
        return;
      }
      setState(auth);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        router.replace('/login');
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Unable to load your account.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  async function openWorkspace(membership: Membership) {
    if (switching || !membership.active || !state) return;
    setError('');

    // A club account is the club itself and has exactly one workspace. When
    // its session already points there, opening it needs no switch request.
    if (state.user.accountType === 'CLUB' && state.membership?.id === membership.id) {
      router.replace('/');
      router.refresh();
      return;
    }

    setSwitching(membership.id);
    try {
      const auth = await api<AuthSession>('/auth/switch-workspace', {
        method: 'POST',
        body: JSON.stringify({ membershipId: membership.id }),
      });
      if (!auth.membership || !auth.business) throw new Error('That workspace is not available right now.');
      router.replace('/');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to open that workspace.');
    } finally {
      setSwitching(null);
    }
  }

  async function startPractice() {
    const name = practiceName.trim();
    if (name.length < 2) {
      setError('Give your practice a name of at least two characters.');
      return;
    }
    setCreatingPractice(true);
    setError('');
    try {
      const auth = await createOwnPractice(name);
      if (!auth.membership || !auth.business) throw new Error('Your practice was created but could not be opened. Refresh and try again.');
      router.replace('/');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create your practice.');
      setCreatingPractice(false);
    }
  }

  async function saveCoachProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || state.user.accountType !== 'COACH' || savingProfile) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') || '').trim();
    const phone = String(form.get('phone') || '').trim();
    if (name.length < 2) {
      setError('Please enter your name using at least two characters.');
      return;
    }
    setSavingProfile(true);
    setError('');
    try {
      const auth = await api<AuthSession>('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ name, phone }),
      });
      setState(auth);
      setEditingProfile(false);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save your personal profile.');
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveClubProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state?.business || state.user.accountType !== 'CLUB' || savingProfile) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') || '').trim();
    const ownerName = String(form.get('ownerName') || '').trim();
    const email = String(form.get('email') || '').trim();
    const tagline = String(form.get('tagline') || '').trim();
    const color = String(form.get('color') || '').trim();
    const cancellationHours = Number(form.get('cancellationHours'));
    if (name.length < 2 || ownerName.length < 2) {
      setError('Club and contact names must use at least two characters.');
      return;
    }
    if (!Number.isInteger(cancellationHours) || cancellationHours < 0 || cancellationHours > 720) {
      setError('Cancellation notice must be a whole number from 0 to 720 hours.');
      return;
    }
    setSavingProfile(true);
    setError('');
    try {
      // A CLUB identity represents the business, not a portable person. Its
      // profile therefore updates the existing workspace and never /auth/me.
      const business = await api<Business>('/business', {
        method: 'PATCH',
        body: JSON.stringify({ name, ownerName, email, tagline, color, cancellationHours }),
      });
      setState(current => current ? {
        ...current,
        business,
        membership: current.membership
          ? { ...current.membership, business: current.membership.businessId === business.id ? business : current.membership.business }
          : null,
        memberships: current.memberships.map(membership =>
          membership.businessId === business.id ? { ...membership, business } : membership),
      } : current);
      setEditingProfile(false);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save the club profile.');
    } finally {
      setSavingProfile(false);
    }
  }

  async function logout() {
    try {
      await mutate('/auth/logout', 'POST');
      router.replace('/login');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign out.');
    }
  }

  const clubAccount = state?.user.accountType === 'CLUB';
  const coachAccount = state?.user.accountType === 'COACH';
  const soloPractice = state?.memberships.find(membership => membership.business.kind === 'SOLO');
  const clubMembership = clubAccount
    ? state?.memberships.find(membership => membership.businessId === state.business?.id) ?? state?.memberships[0]
    : undefined;

  return <main className="min-h-screen bg-[#f6f7f4] px-5 py-6 text-[#1c3029] sm:px-10 sm:py-9">
    <div className="mx-auto max-w-3xl">
      <header className="flex items-center justify-between gap-4">
        <Link href={state?.membership ? '/' : '/account'} aria-label="Courtly home"><CourtlyLogo /></Link>
        {state && <Button variant="ghost" onClick={() => { void logout(); }}><LogOut size={15} />Sign out</Button>}
      </header>

      <section className="mx-auto mt-12 max-w-2xl sm:mt-20">
        {loading ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><Loader2 size={24} className="animate-spin text-[#71865f]" /><p className="mt-4 text-sm text-stone-500">Loading your Courtly account…</p></div>
          : error && !state ? <div className="rounded-2xl border border-[#eedbd4] bg-white p-7 text-center shadow-sm"><h1 className="text-2xl">We couldn’t load your account.</h1><p role="alert" className="mt-3 text-sm text-[#a16a55]">{error}</p><Button className="mt-6" onClick={() => { void load(); }}><RefreshCw size={15} />Try again</Button></div>
          : state ? <>
            <div className="text-center">
              <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[#e0e6d7] bg-[#edf2e5] text-[#758b66]">{clubAccount ? <Building2 size={25} strokeWidth={1.5} /> : <UserRound size={25} strokeWidth={1.5} />}</span>
              <p className="mt-6 text-[10px] font-semibold uppercase tracking-[2px] text-[#95a085]">{clubAccount ? 'Club account' : 'Coach account'}</p>
              <h1 className="mt-2 !text-[32px] !font-medium !tracking-[-1px]">{clubAccount ? state.business?.name || state.user.name : `Welcome, ${state.user.name}.`}</h1>
              <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-stone-500">{clubAccount
                ? 'This login belongs to the club and opens this club alone. Update the workspace profile or continue to the club dashboard.'
                : state.memberships.some(item => item.active)
                  ? 'Your coach account travels with you. Choose a workspace or update your personal profile.'
                  : 'Your coach account is ready. A club adds you to its roster using your account email.'}</p>
            </div>

            <div className="mt-8 space-y-5">
              {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>}
              <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="account-profile-heading">
                <div className="flex items-start justify-between gap-3">
                  <div><p className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#95a085]">{clubAccount ? 'Club account' : 'Personal profile'}</p><h2 id="account-profile-heading" className="mt-1 text-lg text-[#2f4938]">{clubAccount ? 'Club profile' : state.user.name}</h2></div>
                  {!editingProfile && <Button variant="outline" size="sm" onClick={() => { setEditingProfile(true); setError(''); }}><Pencil size={13} />{clubAccount ? 'Edit club profile' : 'Edit personal profile'}</Button>}
                </div>

                {editingProfile && clubAccount && state.business ? <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={saveClubProfile}>
                  <div className="sm:col-span-2"><label htmlFor="club-profile-name">Club or academy name</label><input id="club-profile-name" name="name" className={inputClass} defaultValue={state.business.name} minLength={2} maxLength={120} autoComplete="organization" required disabled={savingProfile} /></div>
                  <div><label htmlFor="club-profile-contact">Contact name</label><input id="club-profile-contact" name="ownerName" className={inputClass} defaultValue={state.business.ownerName} minLength={2} maxLength={120} autoComplete="name" required disabled={savingProfile} /></div>
                  <div><label htmlFor="club-profile-email">Contact email</label><input id="club-profile-email" name="email" className={inputClass} type="email" defaultValue={state.business.email} maxLength={254} autoComplete="email" required disabled={savingProfile} /></div>
                  <div className="sm:col-span-2"><label htmlFor="club-profile-tagline">Tagline <span className="font-normal text-stone-400">(optional)</span></label><input id="club-profile-tagline" name="tagline" className={inputClass} defaultValue={state.business.tagline} maxLength={500} disabled={savingProfile} /></div>
                  <div><label htmlFor="club-profile-color">Brand colour</label><input id="club-profile-color" name="color" className={inputClass} type="color" defaultValue={state.business.color} required disabled={savingProfile} /></div>
                  <div><label htmlFor="club-profile-cancellation">Cancellation notice (hours)</label><input id="club-profile-cancellation" name="cancellationHours" className={inputClass} type="number" defaultValue={state.business.cancellationHours} min={0} max={720} step={1} required disabled={savingProfile} /></div>
                  <p className="sm:col-span-2 text-[10px] leading-relaxed text-stone-500">This edits the existing club workspace. The sign-in email remains {state.user.email}.</p>
                  <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={() => setEditingProfile(false)} disabled={savingProfile}><X size={14} />Cancel</Button><Button type="submit" disabled={savingProfile}>{savingProfile && <Loader2 size={14} className="animate-spin" />}Save club profile</Button></div>
                </form> : editingProfile && coachAccount ? <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={saveCoachProfile}>
                  <div><label htmlFor="coach-profile-name">Full name</label><input id="coach-profile-name" name="name" className={inputClass} defaultValue={state.user.name} minLength={2} maxLength={120} autoComplete="name" required disabled={savingProfile} /></div>
                  <div><label htmlFor="coach-profile-phone">Phone <span className="font-normal text-stone-400">(optional)</span></label><input id="coach-profile-phone" name="phone" className={inputClass} type="tel" defaultValue={state.user.phone || ''} maxLength={40} autoComplete="tel" disabled={savingProfile} /></div>
                  <div className="sm:col-span-2"><label htmlFor="coach-profile-email">Sign-in email</label><input id="coach-profile-email" className={inputClass} value={state.user.email} readOnly /><p className="mt-1.5 text-[10px] leading-relaxed text-stone-400">Your sign-in email cannot be changed here. Clubs use it to add your account.</p></div>
                  <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={() => setEditingProfile(false)} disabled={savingProfile}><X size={14} />Cancel</Button><Button type="submit" disabled={savingProfile}>{savingProfile && <Loader2 size={14} className="animate-spin" />}Save personal profile</Button></div>
                </form> : <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl bg-[#f4f7ef] p-4"><p className="text-[10px] uppercase tracking-[1.2px] text-stone-400">{clubAccount ? 'Contact name' : 'Account email'}</p><p className="mt-1 break-all text-xs font-semibold text-[#405941]">{clubAccount ? state.business?.ownerName : state.user.email}</p></div>
                  <div className="rounded-xl bg-[#f4f7ef] p-4"><p className="text-[10px] uppercase tracking-[1.2px] text-stone-400">{clubAccount ? 'Contact email' : 'Phone'}</p><p className="mt-1 break-all text-xs font-semibold text-[#405941]">{clubAccount ? state.business?.email : state.user.phone || 'Not added'}</p></div>
                  {clubAccount && <div className="rounded-xl bg-[#f4f7ef] p-4 sm:col-span-2"><p className="text-[10px] uppercase tracking-[1.2px] text-stone-400">Sign-in email</p><p className="mt-1 break-all text-xs font-semibold text-[#405941]">{state.user.email}</p><p className="mt-1 text-[10px] text-stone-500">Separate from the public contact email above.</p></div>}
                </div>}
              </section>

              <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="account-workspaces-heading">
                <div className="flex items-start gap-3"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-[#6f865f]" /><div><h2 id="account-workspaces-heading" className="text-sm text-[#405941]">{clubAccount ? 'Your club workspace' : 'Your coaching workspaces'}</h2><p className="mt-1 text-[11px] leading-relaxed text-stone-500">{clubAccount ? 'A club account has one club and never switches to another.' : `Clubs add your coach account using ${state.user.email}. Your password always remains yours.`}</p></div></div>

                <div className="mt-5 space-y-3">
                  {clubAccount && clubMembership ? <button type="button" disabled={!clubMembership.active} onClick={() => { void openWorkspace(clubMembership); }} className="flex min-h-[72px] w-full items-center gap-3 rounded-xl border border-[#cbd9bf] bg-[#f8faf5] p-3.5 text-left transition hover:bg-[#f2f6ed] disabled:cursor-not-allowed disabled:opacity-55"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e7efe0] text-xs font-semibold text-[#617851]">{initials(clubMembership.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[#344b39]">{clubMembership.business.name}</span><span className="mt-1 block text-[10px] text-stone-500">{clubMembership.active ? 'Club workspace' : 'Club workspace · inactive'}</span></span><ArrowRight size={16} className="text-stone-400" /></button>
                    : coachAccount ? state.memberships.map(membership => <button key={membership.id} type="button" disabled={!!switching || !membership.active} onClick={() => { void openWorkspace(membership); }} className="flex min-h-[72px] w-full items-center gap-3 rounded-xl border border-[#e2e7dd] p-3.5 text-left transition hover:border-[#cbd9bf] hover:bg-[#f8faf5] disabled:cursor-not-allowed disabled:opacity-55"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf2e6] text-xs font-semibold text-[#617851]">{initials(membership.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[#344b39]">{membership.business.name}</span><span className="mt-1 block text-[10px] text-stone-500">{workspaceDescription(membership)}</span></span>{switching === membership.id ? <Loader2 size={17} className="animate-spin text-[#71865f]" /> : membership.id === state.membership?.id ? <span className="flex items-center gap-1 text-[10px] font-semibold text-[#66805a]"><Check size={13} />Selected</span> : <ArrowRight size={16} className="text-stone-400" />}</button>) : null}

                  {coachAccount && !state.memberships.length && <div className="py-5 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[#f0f3ec] text-[#809174]"><Building2 size={19} /></span><h3 className="mt-4 text-sm">No club access yet</h3><p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-stone-500">Share your account email with a club or academy. Once it adds you to its roster, return here and refresh.</p></div>}
                  {clubAccount && !clubMembership && <p className="rounded-xl bg-[#fff6f1] p-4 text-xs leading-relaxed text-[#a16a55]">This club login is not connected to its workspace. Please contact support.</p>}
                </div>

                {coachAccount && !soloPractice && <div className="mt-5 rounded-xl border border-[#e2e7dd] bg-[#fafbf8] p-4">
                  <div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#edf2e6] text-[#617851]"><Plus size={17} /></span><div className="min-w-0 flex-1"><h3 className="text-xs font-semibold text-[#405941]">Teach your own students too?</h3><p className="mt-1 text-[11px] leading-relaxed text-stone-500">Create one independent practice for direct students. Their lesson payments go to you, separately from club lessons.</p><div className="mt-3 flex gap-2 max-sm:flex-col"><input aria-label="Name your practice" value={practiceName} onChange={event => { setPracticeName(event.target.value); if (error) setError(''); }} maxLength={120} placeholder="e.g. Jamie Lee Coaching" className="min-w-0 flex-1" disabled={creatingPractice} /><Button variant="outline" className="shrink-0" disabled={creatingPractice || practiceName.trim().length < 2} onClick={() => { void startPractice(); }}>{creatingPractice ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}Create practice</Button></div></div></div>
                </div>}

                <div className="mt-5 flex flex-wrap justify-center gap-2 border-t border-[#edf0e8] pt-5"><Button variant="outline" disabled={loading || !!switching} onClick={() => { void load(); }}><RefreshCw size={14} />Refresh access</Button>{state.membership && <Button disabled={!!switching} onClick={() => { const selected = state.memberships.find(item => item.id === state.membership?.id); if (selected) void openWorkspace(selected); }}>Open current workspace<ArrowRight size={14} /></Button>}</div>
              </section>
            </div>
          </> : null}
      </section>
    </div>
  </main>;
}
