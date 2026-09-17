'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Check, CircleDot, Eye, EyeOff, Layers3, LoaderCircle, LockKeyhole, MapPin, ShieldCheck, Sparkles, UsersRound } from 'lucide-react';
import { api } from '@/lib/api';
import { CourtlyLogo } from '@/components/public-booking';
import type { AccountType, AuthSession } from '@/lib/types';
import { cn } from '@/lib/utils';

const accountOptions: Array<{ value: AccountType; label: string; detail: string }> = [
  { value: 'CLUB', label: 'Club or academy', detail: 'Create your club workspace' },
  { value: 'COACH', label: 'Coach', detail: 'Clubs add you by email' },
  { value: 'STUDENT', label: 'Student', detail: 'Book and manage lessons' },
];

type AuthRedirect = { parameter: 'next' | 'returnTo'; destination: string };

function safeLocalPath(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    return new URL(value, 'https://courtly.local').origin === 'https://courtly.local' ? value : null;
  } catch {
    return null;
  }
}

function readAuthRedirect(): AuthRedirect | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  for (const parameter of ['next', 'returnTo'] as const) {
    const destination = safeLocalPath(params.get(parameter));
    if (destination) return { parameter, destination };
  }
  return null;
}

function hrefWithRedirect(path: '/login' | '/signup', redirect: AuthRedirect | null) {
  if (!redirect) return path;
  return `${path}?${new URLSearchParams([[redirect.parameter, redirect.destination]]).toString()}`;
}

function isStudentDestination(destination: string | null) {
  return destination?.startsWith('/book/') || destination?.startsWith('/manage') || false;
}

function destinationFor(state: AuthSession, requested: string | null) {
  // Booking and management return paths belong to student self-service. A
  // coach or club must still land in the account/workspace it can operate.
  if (state.user.accountType === 'STUDENT') return requested ?? '/manage';
  if (state.membership && state.business) return '/';
  return '/account';
}

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const signup = mode === 'signup';
  const router = useRouter();
  const [accountType, setAccountType] = useState<AccountType | null>(null);
  const [redirect, setRedirect] = useState<AuthRedirect | null>(null);
  const [values, setValues] = useState({ businessName: '', name: '', email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<'form' | 'demo' | null>(null);
  const [error, setError] = useState('');
  const input = '!min-h-12 !rounded-xl !border-[#dfe5dd] !px-3.5 !text-base placeholder:!text-[#a7afa0] sm:!text-sm';
  const primary = 'inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#103e2f] disabled:cursor-wait disabled:opacity-60 disabled:shadow-none';
  useEffect(() => {
    const requested = readAuthRedirect();
    setRedirect(requested);
    if (signup) setAccountType(isStudentDestination(requested?.destination ?? null) ? 'STUDENT' : null);
  }, [signup]);
  const loginHref = hrefWithRedirect('/login', redirect);
  const alternateHref = hrefWithRedirect(signup ? '/login' : '/signup', redirect);
  function update(key: keyof typeof values, value: string) { setValues(current => ({ ...current, [key]: value })); if (error) setError(''); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (signup && !accountType) { setError('Please choose how you’re joining Courtly.'); return; }
    if (signup && values.name.trim().length < 2) { setError(`Please enter ${accountType === 'CLUB' ? 'a contact name' : 'your name'} using at least two characters.`); return; }
    if (signup && accountType === 'CLUB' && values.businessName.trim().length < 2) { setError('Please enter a club or academy name using at least two characters.'); return; }
    setBusy('form'); setError('');
    try {
      const result = await api<AuthSession>(signup ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify(signup ? { accountType, ...(accountType === 'CLUB' ? { businessName: values.businessName.trim() } : {}), name: values.name.trim(), email: values.email.trim(), password: values.password } : { email: values.email.trim(), password: values.password }) });
      router.replace(destinationFor(result, redirect?.destination ?? null)); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'We couldn’t sign you in. Please try again.'); setBusy(null); }
  }
  async function demo() {
    if (busy) return;
    setBusy('demo'); setError('');
    try { await api('/auth/demo', { method: 'POST', body: JSON.stringify({}) }); router.replace('/'); router.refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'The demo is not available right now. Please try again.'); setBusy(null); }
  }
  return <main className="min-h-screen overflow-x-clip bg-[#f6f7f4] text-[#1c3029] lg:grid lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
    <section className="relative hidden min-h-screen overflow-hidden bg-[#174c3c] p-12 text-white lg:flex lg:flex-col xl:p-16">
      <div className="relative z-10"><Link href={loginHref} aria-label="Courtly sign in"><CourtlyLogo light /></Link></div>
      <div className="relative z-10 my-auto max-w-lg py-14">
        <span className="!mb-7 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3.5 py-2 text-[10px] font-medium tracking-wide text-[#c3d5b3]"><span className="h-1.5 w-1.5 rounded-full bg-[#b8cd87]" />FOR THE LOVE OF THE GAME</span>
        <h1 className="!text-[45px] !font-medium !leading-[1.15] !tracking-[-1.8px] xl:!text-[53px]">A little less admin.<br />A lot more <span className="text-[#c5d7a1]">play.</span></h1>
        <p className="!mt-6 max-w-sm text-sm leading-[1.9] text-[#a8c0af]">Your lessons, your people, your places. One account keeps every side of the game beautifully in sync.</p>
        <div className="relative mt-12 rounded-2xl border border-white/15 bg-[#245945] p-5 shadow-[0_18px_55px_#092f2526] xl:p-6">
          <div className="!mb-5 flex items-center justify-between"><div><p className="text-[9px] font-medium uppercase tracking-[1.7px] text-[#a6b99a]">YOUR DAY, A LITTLE LIGHTER</p><p className="!mt-1.5 text-[15px] font-medium text-[#e5eddd]">More time on the court.</p></div><span className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/5 text-[#c0d29e]"><CalendarDays size={17} strokeWidth={1.5} /></span></div>
          {[{ time: '9:00', title: 'Private tennis lesson', place: 'Riverside Tennis Club', color: 'bg-[#c4d69d]', initials: 'AT' }, { time: '11:00', title: 'Junior group coaching', place: 'Greenwood Courts', color: 'bg-[#b2cbd1]', initials: '+4' }, { time: '15:00', title: 'A little room to grow', place: 'Your next great session', color: 'bg-[#ddc7a0]', initials: 'You' }].map((item, index) => <div key={item.time} className={cn('flex items-center gap-3 py-3.5', index > 0 && 'border-t border-white/10')}><span className="w-8 text-[10px] text-[#9cb59f]">{item.time}</span><span className={cn('h-8 w-0.5 shrink-0 rounded-full', item.color)} /><div className="flex-1"><p className="text-xs font-medium text-[#dce7d4]">{item.title}</p><p className="!mt-1.5 flex items-center gap-1 text-[9px] text-[#92ae96]"><MapPin size={10} />{item.place}</p></div><span className="grid h-7 w-7 place-items-center rounded-full border border-white/10 bg-white/5 text-[8px] font-medium text-[#becdaa]">{item.initials}</span></div>)}
          <div className="!mt-3 flex items-center gap-1.5 border-t border-white/10 pt-4 text-[9px] text-[#9fba97]"><Check size={11} /> A glimpse of your coaching day, in sync.</div>
        </div>
        <div className="!mt-8 flex flex-wrap gap-x-5 gap-y-3 text-[10px] text-[#9db796]"><span className="flex items-center gap-1.5"><CalendarDays size={13} />Simple bookings</span><span className="flex items-center gap-1.5"><UsersRound size={13} />Happy players</span><span className="flex items-center gap-1.5"><Layers3 size={13} />One calm workspace</span></div>
      </div>
      <div className="relative z-10 flex items-center justify-between text-[10px] text-[#85a48d]"><span>Made for coaches. Built around you.</span><CircleDot size={17} strokeWidth={1.3} /></div>
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-48 -right-60 h-[570px] w-[570px] rounded-full border border-[#b2c395]/10"><div className="absolute inset-14 rounded-full border border-[#b2c395]/10" /><div className="absolute inset-28 rounded-full border border-[#b2c395]/10" /></div>
    </section>
    <section className="flex min-h-screen flex-col px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-12 sm:py-9 lg:px-14 xl:px-24">
      <div className="flex min-h-12 items-center justify-between gap-3 lg:justify-end"><Link href={loginHref} className="inline-flex min-h-11 items-center lg:hidden" aria-label="Courtly sign in"><CourtlyLogo /></Link><div className="flex min-w-0 items-center justify-end gap-2 text-[11px] text-[#8b9780]"><span className="hidden sm:inline">{signup ? 'Already part of the club?' : 'New around here?'}</span><Link href={alternateHref} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-1 font-semibold text-[#45673c]">{signup ? 'Sign in' : 'Create an account'}<ArrowRight size={12} /></Link></div></div>
      <div className="mx-auto my-auto w-full max-w-[390px] py-8 sm:py-16">
        <span className="!mb-5 grid h-11 w-11 place-items-center rounded-2xl border border-[#e0e6d7] bg-[#edf2e5] text-[#849970] sm:!mb-6 sm:h-12 sm:w-12">{signup ? <Sparkles size={22} strokeWidth={1.5} /> : <CircleDot size={24} strokeWidth={1.5} />}</span>
        <p className="!mb-2 text-[10px] font-semibold uppercase tracking-[2px] text-[#95a085]">{signup ? 'A FRESH START, A LITTLE MORE PLAY' : 'ONE ACCOUNT, EVERY COURT'}</p>
        <h1 className="!text-[31px] !font-medium !leading-[1.12] !tracking-[-1px] sm:!text-[34px] sm:!tracking-[-1.1px]">{signup ? 'Make room for more.' : 'Good to see you again.'}</h1>
        <p className="!mt-3 text-sm leading-relaxed text-[#8a957f]">{signup ? accountType === 'CLUB' ? 'Create one club workspace for your academy, team, or venue.' : accountType === 'COACH' ? 'Create your coach account. Clubs can then add you by email.' : accountType === 'STUDENT' ? 'Create one student account for bookings across every club.' : 'Choose the account that fits how you learn, coach, or run your club.' : 'Sign in once, then we’ll take you to the right place.'}</p>
        <form className="!mt-7 space-y-4 sm:!mt-8 sm:space-y-5" onSubmit={submit}>
          {signup && <><fieldset><legend className="!mb-2 !text-xs !font-medium !text-[#617257]">I’m joining Courtly as</legend><div className="grid grid-cols-3 gap-2">{accountOptions.map(option => { const id = `auth-account-${option.value.toLowerCase()}`; return <div key={option.value} className="relative"><input id={id} type="radio" name="accountType" value={option.value} checked={accountType === option.value} onChange={() => { setAccountType(option.value); if (error) setError(''); }} onInvalid={() => { if (!accountType) setError('Please choose how you’re joining Courtly.'); }} required disabled={!!busy} aria-label={option.label} aria-describedby={`${id}-detail`} className="peer absolute right-2.5 top-3 z-10 h-4 w-4 accent-[#66865b]" /><label htmlFor={id} className="block min-h-[82px] cursor-pointer rounded-xl border border-[#dfe5dd] bg-white px-2.5 py-3 pr-7 text-left transition hover:bg-[#f5f7f2] peer-checked:border-[#66865b] peer-checked:bg-[#edf3e6] peer-checked:shadow-[0_0_0_1px_#66865b] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#66865b] peer-disabled:cursor-wait peer-disabled:opacity-60"><span className="block text-[11px] font-semibold text-[#34523d]">{option.label}</span><span id={`${id}-detail`} className="mt-1 block text-[9px] leading-snug text-[#8a957f]">{option.detail}</span></label></div>; })}</div></fieldset>{accountType === 'CLUB' && <div><label htmlFor="auth-business" className="!mb-2 !text-xs !font-medium !text-[#617257]">Club or academy name</label><input id="auth-business" className={input} value={values.businessName} onChange={event => update('businessName', event.target.value)} required minLength={2} maxLength={120} autoComplete="organization" placeholder="e.g. Oakwood Tennis Academy" disabled={!!busy} /></div>}<div><label htmlFor="auth-name" className="!mb-2 !text-xs !font-medium !text-[#617257]">{accountType === 'CLUB' ? 'Contact name' : 'Your full name'}</label><input id="auth-name" className={input} value={values.name} onChange={event => update('name', event.target.value)} required minLength={2} maxLength={120} autoComplete="name" placeholder="e.g. Jamie Lee" disabled={!!busy} /></div></>}
          <div><label htmlFor="auth-email" className="!mb-2 !text-xs !font-medium !text-[#617257]">Email address</label><input id="auth-email" className={input} type="email" value={values.email} onChange={event => update('email', event.target.value)} required maxLength={254} autoComplete="email" placeholder="you@example.com" disabled={!!busy} /></div>
          <div><label htmlFor="auth-password" className="!mb-2 !text-xs !font-medium !text-[#617257]">Password</label><div className="relative"><input id="auth-password" className={cn(input, '!pr-12')} type={showPassword ? 'text' : 'password'} value={values.password} onChange={event => update('password', event.target.value)} required minLength={signup ? 12 : undefined} maxLength={72} autoComplete={signup ? 'new-password' : 'current-password'} placeholder={signup ? 'Create a password' : 'Your password'} disabled={!!busy} aria-describedby={signup ? 'password-hint' : undefined} /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-[#9aa48e] transition hover:text-[#49673d]">{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>{signup && <p id="password-hint" className="!mt-2 text-[10px] text-[#99a28d]">Make it yours. Use at least 12 characters.</p>}</div>
          {error && <div role="alert" aria-live="polite" className="rounded-xl border border-[#eedbd4] bg-[#fff6f1] p-3.5 text-xs leading-relaxed text-[#a16a55]">{error}</div>}
          <button type="submit" className={primary} disabled={!!busy}>{busy === 'form' ? <><LoaderCircle size={16} className="animate-spin" />{signup ? 'Creating your account…' : 'Signing you in…'}</> : <>{signup ? accountType === 'CLUB' ? 'Create your workspace' : accountType === 'COACH' ? 'Create coach account' : accountType === 'STUDENT' ? 'Create student account' : 'Create account' : 'Sign in'}<ArrowRight size={16} /></>}</button>
        </form>
        {(!signup || accountType === 'CLUB') && <><div className="my-5 flex items-center gap-3 sm:my-6 sm:gap-4"><span className="h-px flex-1 bg-[#e3e7dd]" /><span className="shrink-0 text-[10px] text-[#a1aa94]">or take a little look around</span><span className="h-px flex-1 bg-[#e3e7dd]" /></div><button type="button" disabled={!!busy} onClick={() => void demo()} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-[#dce4d4] bg-[#f2f5eb] px-4 py-3 text-xs font-semibold text-[#70875a] transition hover:bg-[#eaf0df] disabled:cursor-wait disabled:opacity-60">{busy === 'demo' ? <LoaderCircle size={16} className="animate-spin" /> : <Sparkles size={15} />}{busy === 'demo' ? 'Preparing your demo…' : 'Explore the demo workspace'}<ArrowRight size={14} /></button><p className="!mt-3 text-center text-[10px] leading-relaxed text-[#9ca68e]">No sign-up needed. A sample coaching business, ready to explore.</p></>}
        {signup && accountType && <div className="!mt-7 flex items-start gap-2.5 rounded-xl border border-[#e5e9df] bg-white/50 p-3.5 text-[10px] leading-relaxed text-[#8d9b7d]"><ShieldCheck size={14} className="!mt-0.5 shrink-0" />{accountType === 'CLUB' ? 'This login belongs to your club and opens this club only. Add coaches later using the email on their own coach account.' : accountType === 'COACH' ? 'Your login belongs to you. A club adds you to its roster by email; you never join a club yourself, and a club never sets your password.' : 'Your student account keeps your bookings together without granting access to a club’s private workspace.'}</div>}
      </div>
      <footer className="mx-auto flex w-full max-w-[390px] flex-wrap items-center justify-center gap-x-4 gap-y-1 text-center text-[10px] text-[#a0aa93] sm:justify-between"><span>Good things, one session at a time.</span><span className="flex items-center gap-1"><LockKeyhole size={11} />Your space. Secure.</span></footer>
    </section>
  </main>;
}
