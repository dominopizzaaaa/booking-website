'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, KeyRound, Loader2, LockKeyhole, MailCheck, ShieldCheck } from 'lucide-react';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import {
  ApiError, completeMfaLogin, confirmAccountEmailChange, requestPasswordReset, resetAccountPassword,
} from '@/lib/api';
import {
  authDestination, clearMfaLoginChallenge, consumeWindowFragmentToken, readMfaLoginChallenge,
  releaseWindowFragmentToken,
} from '@/lib/account-security';
import type { MfaMethod } from '@/lib/types';

const field = '!min-h-12 !rounded-xl !border-[#dfe5df] !px-3.5 !text-base';

function SecurityShell({ children, heading, eyebrow, description }: {
  children: ReactNode; heading: string; eyebrow: string; description: string;
}) {
  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-6 text-[#1c3029] sm:px-8 sm:py-10"><div className="mx-auto max-w-xl"><Link href="/login" aria-label="Courtly sign in" className="inline-flex min-h-11 items-center"><CourtlyLogo /></Link><section className="mt-10 rounded-3xl border border-[#e2e7dd] bg-white p-6 shadow-sm sm:mt-16 sm:p-9"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#edf2e5] text-[#6f865f]"><ShieldCheck size={22} /></span><p className="mt-6 text-xs font-semibold uppercase tracking-[1.8px] text-[#59675c]">{eyebrow}</p><h1 className="mt-2 text-3xl font-medium tracking-tight">{heading}</h1><p className="mt-3 text-sm leading-relaxed text-[#59675c]">{description}</p>{children}</section></div></main>;
}

function ErrorNotice({ children }: { children: ReactNode }) {
  return <p role="alert" aria-live="polite" className="rounded-xl border border-[#e4c7bc] bg-[#fff6f1] p-3.5 text-sm leading-relaxed text-[#8a4937]">{children}</p>;
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const normalized = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalized)) { setError('Enter a valid email address.'); return; }
    setBusy(true); setError('');
    try { await requestPasswordReset(normalized); setSent(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'We could not send password reset instructions.'); }
    finally { setBusy(false); }
  }
  return <SecurityShell eyebrow="Account recovery" heading="Reset your password" description="Enter the sign-in email for your Courtly account.">
    {sent ? <div className="mt-7"><span className="grid h-12 w-12 place-items-center rounded-full bg-[#edf5e4] text-[#4f6847]"><MailCheck size={22} /></span><h2 className="mt-4 text-lg font-semibold">Check your inbox</h2><p role="status" className="mt-2 text-sm leading-relaxed text-[#59675c]">If an eligible account exists for <strong className="break-all text-[#304b39]">{email.trim()}</strong>, a one-time reset link is on its way. For privacy, Courtly gives the same answer for every address.</p><Button asChild className="mt-6 w-full"><Link href="/login">Return to sign in<ArrowRight size={15} /></Link></Button></div>
      : <form className="mt-7 space-y-5" onSubmit={submit} noValidate><div><label htmlFor="forgot-password-email">Email address</label><input id="forgot-password-email" className={field} type="email" autoComplete="email" inputMode="email" maxLength={254} required autoFocus value={email} onChange={event => { setEmail(event.target.value); setError(''); }} disabled={busy} /></div>{error && <ErrorNotice>{error}</ErrorNotice>}<Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : <MailCheck size={16} />}{busy ? 'Sending securely…' : 'Send reset link'}</Button><p className="text-center text-xs text-[#59675c]"><Link href="/login" className="font-semibold underline underline-offset-2">Back to sign in</Link></p></form>}
  </SecurityShell>;
}

function resetError(cause: unknown) {
  const details = cause instanceof ApiError && cause.details && typeof cause.details === 'object' ? cause.details as { code?: string } : null;
  if (details?.code === 'PASSWORD_RESET_EXPIRED') return 'This reset link has expired or has already been used. Request a new one.';
  if (cause instanceof ApiError && cause.status === 404) return 'This reset link is invalid or no longer available.';
  return cause instanceof Error ? cause.message : 'Your password could not be reset.';
}

export function ResetPasswordPage() {
  const [token] = useState(consumeWindowFragmentToken);
  const released = useRef(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!released.current) { released.current = true; releaseWindowFragmentToken(token); } }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!token) { setError('This reset link is missing its secure token. Request a new one.'); return; }
    if (password.length < 12) { setError('Use at least 12 characters for your new password.'); return; }
    if (password !== confirmation) { setError('The passwords do not match.'); return; }
    setBusy(true); setError('');
    try { await resetAccountPassword(token, password); setComplete(true); setPassword(''); setConfirmation(''); }
    catch (cause) { setError(resetError(cause)); } finally { setBusy(false); }
  }
  return <SecurityShell eyebrow="Secure password reset" heading={complete ? 'Your password is updated' : 'Choose a new password'} description={complete ? 'Your old reset link can no longer be used. Sign in again on each device you want to keep using.' : 'Use a unique password you do not use for another service.'}>
    {complete ? <div className="mt-7 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#edf5e4] text-[#4f6847]"><Check size={25} /></span><Button asChild className="mt-7 w-full"><Link href="/login">Continue to sign in<ArrowRight size={15} /></Link></Button></div>
      : <form className="mt-7 space-y-5" onSubmit={submit}><div><label htmlFor="reset-password">New password</label><input id="reset-password" className={field} type="password" autoComplete="new-password" minLength={12} maxLength={72} required autoFocus value={password} onChange={event => { setPassword(event.target.value); setError(''); }} disabled={busy} /><p className="mt-1.5 text-xs text-[#59675c]">Use at least 12 characters.</p></div><div><label htmlFor="reset-password-confirmation">Confirm new password</label><input id="reset-password-confirmation" className={field} type="password" autoComplete="new-password" minLength={12} maxLength={72} required value={confirmation} onChange={event => { setConfirmation(event.target.value); setError(''); }} disabled={busy} /></div>{!token && <ErrorNotice>This reset link is missing its secure token. Request a new reset email.</ErrorNotice>}{error && <ErrorNotice>{error}</ErrorNotice>}<Button type="submit" size="lg" className="w-full" disabled={busy || !token}>{busy ? <Loader2 size={16} className="animate-spin" /> : <LockKeyhole size={16} />}{busy ? 'Updating password…' : 'Update password'}</Button><p className="text-center text-xs text-[#59675c]"><Link href="/forgot-password" className="font-semibold underline underline-offset-2">Request a new link</Link></p></form>}
  </SecurityShell>;
}

export function MfaChallengePage() {
  const router = useRouter();
  const [challenge, setChallenge] = useState<ReturnType<typeof readMfaLoginChallenge>>(null);
  const [loadingChallenge, setLoadingChallenge] = useState(true);
  const [method, setMethod] = useState<MfaMethod>('TOTP');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const stored = readMfaLoginChallenge();
    setChallenge(stored);
    if (stored?.methods[0]) setMethod(stored.methods[0]);
    setLoadingChallenge(false);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || busy) return;
    const answer = method === 'TOTP' ? code.replace(/\s/g, '') : code.trim();
    if (method === 'TOTP' && !/^\d{6}$/.test(answer)) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    if (method === 'RECOVERY_CODE' && answer.length < 6) { setError('Enter one of your unused recovery codes.'); return; }
    setBusy(true); setError('');
    try {
      const session = await completeMfaLogin(challenge.challengeId, method, answer);
      clearMfaLoginChallenge();
      router.replace(authDestination(session, challenge.returnTo)); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'That code could not be verified.'); }
    finally { setBusy(false); }
  }
  return <SecurityShell eyebrow="Two-step verification" heading="Confirm it’s you" description="Your password was accepted. Complete this second step to finish signing in.">
    {loadingChallenge ? <p role="status" className="mt-7 flex items-center gap-2 text-sm text-[#59675c]"><Loader2 size={16} className="animate-spin" />Loading your sign-in challenge…</p> : !challenge ? <div className="mt-7"><ErrorNotice>This sign-in challenge is missing or has expired. Start again so Courtly can issue a new challenge.</ErrorNotice><Button asChild className="mt-5 w-full"><Link href="/login">Return to sign in</Link></Button></div>
      : <form className="mt-7 space-y-5" onSubmit={submit}>{challenge.methods.length > 1 && <fieldset><legend className="mb-2 text-sm font-semibold text-[#4d5e51]">Verification method</legend><div className="grid grid-cols-2 gap-2">{challenge.methods.map(option => <label key={option} className={`!mb-0 flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm ${method === option ? 'border-[#66865b] bg-[#edf3e6]' : 'border-[#dfe5dd]'}`}><input type="radio" name="mfa-method" value={option} checked={method === option} onChange={() => { setMethod(option); setCode(''); setError(''); }} /><span>{option === 'TOTP' ? 'Authenticator app' : 'Recovery code'}</span></label>)}</div></fieldset>}<div><label htmlFor="mfa-login-code">{method === 'TOTP' ? '6-digit authenticator code' : 'Recovery code'}</label><input id="mfa-login-code" className={field} value={code} onChange={event => { setCode(event.target.value); setError(''); }} required autoFocus autoComplete="one-time-code" inputMode={method === 'TOTP' ? 'numeric' : 'text'} pattern={method === 'TOTP' ? '[0-9]{6}' : undefined} maxLength={method === 'TOTP' ? 6 : 100} disabled={busy} /></div>{error && <ErrorNotice>{error}</ErrorNotice>}<Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />}{busy ? 'Checking code…' : 'Verify and sign in'}</Button><p className="text-center text-xs text-[#59675c]"><Link href="/login" onClick={() => clearMfaLoginChallenge()} className="font-semibold underline underline-offset-2">Cancel and sign in again</Link></p></form>}
  </SecurityShell>;
}

export function ConfirmEmailChangePage() {
  const [token] = useState(consumeWindowFragmentToken);
  const attempted = useRef(false);
  const [status, setStatus] = useState<'loading' | 'complete' | 'error'>('loading');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true; releaseWindowFragmentToken(token);
    if (!token) { setError('This email-change link is missing its secure token.'); setStatus('error'); return; }
    confirmAccountEmailChange(token).then(result => { setEmail(result.email); setStatus('complete'); })
      .catch(cause => { setError(cause instanceof Error ? cause.message : 'This email change could not be confirmed.'); setStatus('error'); });
  }, [token]);
  return <SecurityShell eyebrow="Verified email change" heading={status === 'complete' ? 'Your email is updated' : 'Confirming your new email'} description={status === 'complete' ? `${email} is now your Courtly sign-in email.` : 'Courtly is checking this one-time confirmation link.'}>
    {status === 'loading' ? <p role="status" className="mt-7 flex items-center gap-2 text-sm text-[#59675c]"><Loader2 size={16} className="animate-spin" />Confirming securely…</p> : status === 'error' ? <div className="mt-7"><ErrorNotice>{error}</ErrorNotice><Button asChild variant="outline" className="mt-5 w-full"><Link href="/account/security">Return to security settings</Link></Button></div> : <div className="mt-7 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#edf5e4] text-[#4f6847]"><Check size={25} /></span><Button asChild className="mt-7 w-full"><Link href="/login">Sign in with the new email<ArrowRight size={15} /></Link></Button></div>}
  </SecurityShell>;
}
