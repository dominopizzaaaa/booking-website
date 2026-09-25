'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Building2, Check, Compass, Loader2, LogOut, MapPin, Pencil, RefreshCw, Search, ShieldCheck, UserRound, UsersRound, X } from 'lucide-react';
import { CalendarConnectionCard } from '@/components/calendar-connection-card';
import { AccountRentalDialog } from '@/components/account-rental-dialog';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import { api, ApiError, loadAuthSession, loadRentals, mutate, searchAccounts, updateAuthAccount, updateClubProfile } from '@/lib/api';
import type { AccountDirectoryUser, AuthSession, Membership, RentalListing } from '@/lib/types';
import { initials, money } from '@/lib/utils';

const inputClass = '!min-h-11 !rounded-xl !border-[#dfe5dd] !px-3.5 !text-sm';

function workspaceDescription(membership: Membership) {
  return membership.active && !membership.business.legacyReadOnly ? 'Club or academy' : 'Club or academy · inactive';
}

const usernamePattern = /^[a-z0-9_]{3,30}$/;
function profileSports(form: FormData): string[] | null {
  const seen = new Set<string>();
  const raw = String(form.get('sports') || '');
  if (!raw.trim()) return [];
  const entries = raw.split(',').map(value => value.trim());
  if (entries.some(value => !value)) return null;
  return entries.filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function AccountPage() {
  const router = useRouter();
  const [state, setState] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);
  const [rentals, setRentals] = useState<RentalListing[]>([]);
  const [rentalsNextCursor, setRentalsNextCursor] = useState<string | null>(null);
  const [rentalsLoading, setRentalsLoading] = useState(false);
  const [rentalsLoadingMore, setRentalsLoadingMore] = useState(false);
  const [rentalsError, setRentalsError] = useState('');
  const [rentalSport, setRentalSport] = useState('');
  const [appliedRentalSport, setAppliedRentalSport] = useState('');
  const [selectedRentalId, setSelectedRentalId] = useState<string | null>(null);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [people, setPeople] = useState<AccountDirectoryUser[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState('');
  const [peopleSearchedFor, setPeopleSearchedFor] = useState('');
  const [editingProfile, setEditingProfile] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [error, setError] = useState('');
  const rentalRequestGenerationRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const auth = await loadAuthSession();
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
  const loadRentalFirstPage = useCallback(async (sport: string) => {
    const normalizedSport = sport.trim();
    const generation = ++rentalRequestGenerationRef.current;
    setRentalsLoading(true);
    setRentalsLoadingMore(false);
    setRentalsError('');
    try {
      const result = await loadRentals(normalizedSport ? { sport: normalizedSport } : {});
      if (generation !== rentalRequestGenerationRef.current) return;
      setRentals(result.rentals);
      setRentalsNextCursor(result.nextCursor);
    } catch (cause) {
      if (generation === rentalRequestGenerationRef.current) {
        setRentals([]);
        setRentalsNextCursor(null);
        setRentalsError(cause instanceof Error ? cause.message : 'Unable to load rental venues.');
      }
    } finally {
      if (generation === rentalRequestGenerationRef.current) setRentalsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (state?.user.accountType !== 'COACH') return;
    setRentalSport('');
    setAppliedRentalSport('');
    void loadRentalFirstPage('');
    return () => { rentalRequestGenerationRef.current += 1; };
  }, [state?.user.accountType, loadRentalFirstPage]);

  function submitRentalFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sport = rentalSport.trim();
    setRentalSport(sport);
    setAppliedRentalSport(sport);
    void loadRentalFirstPage(sport);
  }

  function clearRentalFilters() {
    setRentalSport('');
    setAppliedRentalSport('');
    void loadRentalFirstPage('');
  }

  async function loadMoreRentals() {
    if (!rentalsNextCursor || rentalsLoading || rentalsLoadingMore) return;
    const generation = rentalRequestGenerationRef.current;
    setRentalsLoadingMore(true);
    setRentalsError('');
    try {
      const result = await loadRentals({
        ...(appliedRentalSport ? { sport: appliedRentalSport } : {}),
        cursor: rentalsNextCursor,
      });
      if (generation !== rentalRequestGenerationRef.current) return;
      setRentals(current => [...current, ...result.rentals]);
      setRentalsNextCursor(result.nextCursor);
    } catch (cause) {
      if (generation === rentalRequestGenerationRef.current) {
        setRentalsError(cause instanceof Error ? cause.message : 'Unable to load more rental venues.');
      }
    } finally {
      if (generation === rentalRequestGenerationRef.current) setRentalsLoadingMore(false);
    }
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
    } catch (cause) {
      setPeople([]);
      setPeopleError(cause instanceof Error ? cause.message : 'People search is unavailable right now.');
    } finally {
      setPeopleLoading(false);
    }
  }

  async function openWorkspace(membership: Membership) {
    if (switching || !membership.active || membership.business.kind !== 'CLUB' || membership.business.legacyReadOnly || !state) return;
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

  async function saveCoachProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || state.user.accountType !== 'COACH' || savingProfile) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') || '').trim();
    const phone = String(form.get('phone') || '').trim();
    const username = String(form.get('username') || '').trim().toLowerCase();
    const sports = profileSports(form);
    if (name.length < 2) {
      setError('Please enter your name using at least two characters.');
      return;
    }
    if (!usernamePattern.test(username)) { setError('Choose a username with 3–30 lowercase letters, numbers, or underscores.'); return; }
    if (!sports || sports.length > 20 || sports.some(sport => sport.length > 40)) { setError('Separate sports with single commas and add up to 20, using no more than 40 characters for each.'); return; }
    setSavingProfile(true);
    setError('');
    try {
      const auth = await updateAuthAccount({ name, phone, username, sports });
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
    const username = String(form.get('username') || '').trim().toLowerCase();
    const sports = profileSports(form);
    if (name.length < 2 || ownerName.length < 2) {
      setError('Club and contact names must use at least two characters.');
      return;
    }
    if (!usernamePattern.test(username)) { setError('Choose a username with 3–30 lowercase letters, numbers, or underscores.'); return; }
    if (!sports || sports.length > 20 || sports.some(sport => sport.length > 40)) { setError('Separate sports with single commas and add up to 20, using no more than 40 characters for each.'); return; }
    if (!Number.isInteger(cancellationHours) || cancellationHours < 0 || cancellationHours > 720) {
      setError('Cancellation notice must be a whole number from 0 to 720 hours.');
      return;
    }
    setSavingProfile(true);
    setError('');
    try {
      const auth = await updateClubProfile({ name, ownerName, email, tagline, color, cancellationHours, username, sports });
      setState(auth);
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
  const clubAffiliations = state?.memberships.filter(membership => membership.active && membership.business.kind === 'CLUB' && !membership.business.legacyReadOnly) ?? [];
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
                : clubAffiliations.length
                  ? 'Your coach account travels with you. Choose a club or update your personal profile.'
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
                  <div><label htmlFor="club-profile-username">Username</label><input id="club-profile-username" name="username" className={inputClass} defaultValue={state.user.username || ''} minLength={3} maxLength={30} pattern="[a-z0-9_]{3,30}" autoComplete="username" required disabled={savingProfile} /></div>
                  <div><label htmlFor="club-profile-sports">Sports <span className="font-normal text-stone-400">(comma-separated)</span></label><input id="club-profile-sports" name="sports" className={inputClass} defaultValue={(state.user.sports ?? []).join(', ')} maxLength={819} placeholder="Tennis, badminton, padel" disabled={savingProfile} /></div>
                  <div className="sm:col-span-2"><label htmlFor="club-profile-tagline">Tagline <span className="font-normal text-stone-400">(optional)</span></label><input id="club-profile-tagline" name="tagline" className={inputClass} defaultValue={state.business.tagline} maxLength={500} disabled={savingProfile} /></div>
                  <div><label htmlFor="club-profile-color">Brand colour</label><input id="club-profile-color" name="color" className={inputClass} type="color" defaultValue={state.business.color} required disabled={savingProfile} /></div>
                  <div><label htmlFor="club-profile-cancellation">Cancellation notice (hours)</label><input id="club-profile-cancellation" name="cancellationHours" className={inputClass} type="number" defaultValue={state.business.cancellationHours} min={0} max={720} step={1} required disabled={savingProfile} /></div>
                  <p className="sm:col-span-2 text-[10px] leading-relaxed text-stone-500">This edits the existing club workspace. The sign-in email remains {state.user.email}.</p>
                  <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={() => setEditingProfile(false)} disabled={savingProfile}><X size={14} />Cancel</Button><Button type="submit" disabled={savingProfile}>{savingProfile && <Loader2 size={14} className="animate-spin" />}Save club profile</Button></div>
                </form> : editingProfile && coachAccount ? <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={saveCoachProfile}>
                  <div><label htmlFor="coach-profile-name">Full name</label><input id="coach-profile-name" name="name" className={inputClass} defaultValue={state.user.name} minLength={2} maxLength={120} autoComplete="name" required disabled={savingProfile} /></div>
                  <div><label htmlFor="coach-profile-phone">Phone <span className="font-normal text-stone-400">(optional)</span></label><input id="coach-profile-phone" name="phone" className={inputClass} type="tel" defaultValue={state.user.phone || ''} maxLength={40} autoComplete="tel" disabled={savingProfile} /></div>
                  <div><label htmlFor="coach-profile-username">Username</label><input id="coach-profile-username" name="username" className={inputClass} defaultValue={state.user.username || ''} minLength={3} maxLength={30} pattern="[a-z0-9_]{3,30}" autoComplete="username" required disabled={savingProfile} /></div>
                  <div><label htmlFor="coach-profile-sports">Sports <span className="font-normal text-stone-400">(comma-separated)</span></label><input id="coach-profile-sports" name="sports" className={inputClass} defaultValue={(state.user.sports ?? []).join(', ')} maxLength={819} placeholder="Tennis, badminton, padel" disabled={savingProfile} /></div>
                  <div className="sm:col-span-2"><label htmlFor="coach-profile-email">Sign-in email</label><input id="coach-profile-email" className={inputClass} value={state.user.email} readOnly /><p className="mt-1.5 text-[10px] leading-relaxed text-stone-400">Your sign-in email cannot be changed here. Clubs use it to add your account.</p></div>
                  <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="ghost" onClick={() => setEditingProfile(false)} disabled={savingProfile}><X size={14} />Cancel</Button><Button type="submit" disabled={savingProfile}>{savingProfile && <Loader2 size={14} className="animate-spin" />}Save personal profile</Button></div>
                </form> : <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl bg-[#f4f7ef] p-4"><p className="text-[10px] uppercase tracking-[1.2px] text-stone-400">{clubAccount ? 'Contact name' : 'Account email'}</p><p className="mt-1 break-all text-xs font-semibold text-[#405941]">{clubAccount ? state.business?.ownerName : state.user.email}</p></div>
                  <div className="rounded-xl bg-[#f4f7ef] p-4"><p className="text-[10px] uppercase tracking-[1.2px] text-stone-400">{clubAccount ? 'Contact email' : 'Phone'}</p><p className="mt-1 break-all text-xs font-semibold text-[#405941]">{clubAccount ? state.business?.email : state.user.phone || 'Not added'}</p></div>
                  <div className="rounded-xl bg-[#f4f7ef] p-4"><p className="text-xs uppercase tracking-[1.2px] text-stone-400">Username</p><p className="mt-1 break-all text-sm font-semibold text-[#405941]">@{state.user.username}</p></div>
                  <div className="rounded-xl bg-[#f4f7ef] p-4"><p className="text-xs uppercase tracking-[1.2px] text-stone-400">Sports</p><p className="mt-1 text-sm font-semibold text-[#405941]">{state.user.sports?.length ? state.user.sports.join(', ') : 'Not added'}</p></div>
                  {clubAccount && <div className="rounded-xl bg-[#f4f7ef] p-4 sm:col-span-2"><p className="text-[10px] uppercase tracking-[1.2px] text-stone-400">Sign-in email</p><p className="mt-1 break-all text-xs font-semibold text-[#405941]">{state.user.email}</p><p className="mt-1 text-[10px] text-stone-500">Separate from the public contact email above.</p></div>}
                </div>}
              </section>

              <CalendarConnectionCard accountType={state.user.accountType} returnTo="/account" />

              <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="account-workspaces-heading">
                <div className="flex items-start gap-3"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-[#6f865f]" /><div><h2 id="account-workspaces-heading" className="text-sm text-[#405941]">{clubAccount ? 'Your club workspace' : 'Your coaching workspaces'}</h2><p className="mt-1 text-[11px] leading-relaxed text-stone-500">{clubAccount ? 'A club account has one club and never switches to another.' : `Clubs add your coach account using ${state.user.email}. Your password always remains yours.`}</p></div></div>

                <div className="mt-5 space-y-3">
                  {clubAccount && clubMembership ? <button type="button" disabled={!clubMembership.active} onClick={() => { void openWorkspace(clubMembership); }} className="flex min-h-[72px] w-full items-center gap-3 rounded-xl border border-[#cbd9bf] bg-[#f8faf5] p-3.5 text-left transition hover:bg-[#f2f6ed] disabled:cursor-not-allowed disabled:opacity-55"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e7efe0] text-xs font-semibold text-[#617851]">{initials(clubMembership.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[#344b39]">{clubMembership.business.name}</span><span className="mt-1 block text-[10px] text-stone-500">{clubMembership.active ? 'Club workspace' : 'Club workspace · inactive'}</span></span><ArrowRight size={16} className="text-stone-400" /></button>
                    : coachAccount ? clubAffiliations.map(membership => <button key={membership.id} type="button" disabled={!!switching || !membership.active} onClick={() => { void openWorkspace(membership); }} className="flex min-h-[72px] w-full items-center gap-3 rounded-xl border border-[#e2e7dd] p-3.5 text-left transition hover:border-[#cbd9bf] hover:bg-[#f8faf5] disabled:cursor-not-allowed disabled:opacity-55"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf2e6] text-xs font-semibold text-[#617851]">{initials(membership.business.name)}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[#344b39]">{membership.business.name}</span><span className="mt-1 block text-xs text-stone-500">{workspaceDescription(membership)}</span></span>{switching === membership.id ? <Loader2 size={17} className="animate-spin text-[#71865f]" /> : membership.id === state.membership?.id ? <span className="flex items-center gap-1 text-xs font-semibold text-[#66805a]"><Check size={13} />Selected</span> : <ArrowRight size={16} className="text-stone-400" />}</button>) : null}

                  {coachAccount && !clubAffiliations.length && <div className="py-5 text-center"><span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[#f0f3ec] text-[#809174]"><Building2 size={19} /></span><h3 className="mt-4 text-sm">No club access yet</h3><p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-stone-500">Share your account email with a club or academy. Once it adds you to its roster, return here and refresh.</p></div>}
                  {clubAccount && !clubMembership && <p className="rounded-xl bg-[#fff6f1] p-4 text-xs leading-relaxed text-[#a16a55]">This club login is not connected to its workspace. Please contact support.</p>}
                </div>

                <div className="mt-5 flex flex-wrap justify-center gap-2 border-t border-[#edf0e8] pt-5"><Button variant="outline" disabled={loading || !!switching} onClick={() => { void load(); }}><RefreshCw size={14} />Refresh access</Button>{state.membership && clubAffiliations.some(item => item.id === state.membership?.id) && <Button disabled={!!switching} onClick={() => { const selected = clubAffiliations.find(item => item.id === state.membership?.id); if (selected) void openWorkspace(selected); }}>Open current workspace<ArrowRight size={14} /></Button>}</div>
              </section>

              {coachAccount && <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="account-people-heading">
                <div className="flex items-start gap-3"><UsersRound size={19} className="mt-0.5 shrink-0 text-[#6f865f]" /><div><h2 id="account-people-heading" className="text-base text-[#405941]">Find people on Courtly</h2><p className="mt-1 text-xs leading-relaxed text-stone-500">Search players, coaches, and clubs by name, username, or exact email address. Results show public profile details only.</p></div></div>
                <form className="mt-5 flex flex-col gap-2 sm:flex-row" onSubmit={submitPeopleSearch}>
                  <label htmlFor="account-people-search" className="sr-only">Search all Courtly accounts</label>
                  <input id="account-people-search" type="search" className={`${inputClass} min-w-0 flex-1`} value={peopleQuery} onChange={event => { setPeopleQuery(event.target.value); setPeople([]); setPeopleSearchedFor(''); setPeopleError(''); }} placeholder="Name, @username, or exact email" />
                  <Button type="submit" disabled={peopleLoading}>{peopleLoading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}Search people</Button>
                </form>
                {peopleError && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs text-red-700">{peopleError}</p>}
                {!peopleLoading && !peopleError && peopleSearchedFor && !people.length && <p role="status" className="mt-3 text-xs text-stone-500">No accounts matched “{peopleSearchedFor}”.</p>}
                {people.length > 0 && <ul aria-label="Account search results" className="mt-4 grid gap-2 sm:grid-cols-2">{people.map(person => <li key={person.username} className="min-w-0 rounded-xl border border-[#e4e9df] bg-[#fafbf8] p-3"><div className="flex items-start gap-2.5"><span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#e8efe0] text-[11px] font-bold text-[#4f6847]">{initials(person.name)}</span><div className="min-w-0"><p className="truncate text-sm font-semibold text-[#304b39]">{person.name}</p><p className="truncate text-xs text-stone-500">@{person.username} · {person.accountType.toLowerCase()}</p>{person.sports.length > 0 && <p className="truncate text-[11px] text-stone-500">{person.sports.join(', ')}</p>}</div></div></li>)}</ul>}
              </section>}

              {coachAccount && <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="account-rentals-heading">
                <div className="flex items-start gap-3"><Compass size={19} className="mt-0.5 shrink-0 text-[#6f865f]" /><div><h2 id="account-rentals-heading" className="text-base text-[#405941]">Explore rental venues</h2><p className="mt-1 text-xs leading-relaxed text-stone-500">Find a court or training space even before a club hires you.</p></div></div>
                <form role="search" aria-label="Filter rental venues" className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={submitRentalFilters}>
                  <div className="min-w-0 flex-1"><label htmlFor="account-rental-sport" className="text-xs font-semibold text-[#405941]">Filter rental venues by sport</label><input id="account-rental-sport" type="search" className={`${inputClass} mt-1.5 w-full`} value={rentalSport} onChange={event => setRentalSport(event.target.value)} placeholder="Tennis, badminton, padel…" /></div>
                  <div className="flex gap-2"><Button type="submit" className="flex-1 sm:flex-none" disabled={rentalsLoading}>{rentalsLoading && <Loader2 size={14} className="animate-spin" />}Apply filters</Button>{(rentalSport || appliedRentalSport) && <Button type="button" variant="outline" className="flex-1 sm:flex-none" disabled={rentalsLoading} onClick={clearRentalFilters}>Clear filters</Button>}</div>
                </form>
                {rentalsLoading ? <p role="status" className="mt-5 flex items-center gap-2 text-xs text-stone-500"><Loader2 size={14} className="animate-spin" />Finding places to play…</p>
                  : rentalsError ? <p role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-xs text-red-700">{rentalsError}</p>
                    : rentals.length ? <><div className="mt-5 grid gap-3 sm:grid-cols-2">{rentals.map(rental => <article key={rental.id} className="flex flex-col rounded-xl border border-[#e4e9df] p-4"><div className="flex items-start gap-2"><MapPin size={15} className="mt-0.5 shrink-0 text-[#71865f]" /><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-[#344b39]">{rental.name}</h3><p className="mt-1 text-xs text-stone-500">{rental.sport || 'Multi-sport'} · {rental.club.name}</p><p className="mt-2 text-xs font-semibold text-[#50704c]">From {money(rental.price, rental.currency)} per hour</p></div></div><Button type="button" variant="outline" size="sm" className="mt-4 self-start" aria-label={`View available times for ${rental.name}`} onClick={() => setSelectedRentalId(rental.id)}>View times<ArrowRight size={13} /></Button></article>)}</div>{rentalsNextCursor && <Button type="button" variant="outline" className="mt-4" disabled={rentalsLoadingMore} onClick={() => void loadMoreRentals()}>{rentalsLoadingMore && <Loader2 size={14} className="animate-spin" />}Load more venues</Button>}</>
                      : <p className="mt-5 rounded-xl bg-[#f7f9f4] p-4 text-xs text-stone-500">{appliedRentalSport ? `No rental venues match “${appliedRentalSport}”.` : 'No rental venues are listed yet. Check back soon.'}</p>}
              </section>}
            </div>
            <AccountRentalDialog rentalId={selectedRentalId} onClose={() => setSelectedRentalId(null)} />
          </> : null}
      </section>
    </div>
  </main>;
}
