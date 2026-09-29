'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Loader2, MailCheck, RefreshCw } from 'lucide-react';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import { ApiError, resendAccountEmailVerification, verifyAccountEmail } from '@/lib/api';
import { consumeWindowVerificationToken, releaseWindowVerificationToken } from '@/lib/email-verification';

type VerificationState = 'loading' | 'verified' | 'unavailable';

function verificationError(error: unknown) {
  const details = error instanceof ApiError && error.details && typeof error.details === 'object'
    ? error.details as { code?: string }
    : null;
  if (details?.code === 'EMAIL_VERIFICATION_EXPIRED') {
    return 'This verification link has expired or has already been used.';
  }
  if (details?.code === 'EMAIL_VERIFICATION_NOT_FOUND' || (error instanceof ApiError && error.status === 404)) {
    return 'This verification link is invalid or no longer available.';
  }
  return error instanceof Error ? error.message : 'Your email could not be verified. Please try again.';
}

export function EmailVerificationPage() {
  const [token] = useState(consumeWindowVerificationToken);
  const attemptedToken = useRef<string | null>(null);
  const [state, setState] = useState<VerificationState>('loading');
  const [error, setError] = useState('');
  const [resending, setResending] = useState(false);
  const [resendNotice, setResendNotice] = useState('');

  async function verify() {
    if (!token) {
      setError('This verification link is missing its secure token.');
      setState('unavailable');
      return;
    }
    setState('loading');
    setError('');
    try {
      await verifyAccountEmail(token);
      setState('verified');
    } catch (cause) {
      setError(verificationError(cause));
      setState('unavailable');
    }
  }

  async function resend() {
    setResending(true);
    setResendNotice('');
    try {
      const result = await resendAccountEmailVerification();
      setResendNotice(result.alreadyVerified
        ? 'This account email is already verified. You can continue to Courtly.'
        : 'A new verification email has been queued. Use only the newest link.');
    } catch (cause) {
      setResendNotice(cause instanceof ApiError && cause.status === 401
        ? 'Sign in to your Courtly account before requesting another verification email.'
        : verificationError(cause));
    } finally { setResending(false); }
  }

  useEffect(() => {
    if (attemptedToken.current === token) return;
    attemptedToken.current = token;
    releaseWindowVerificationToken(token);
    void verify();
  }, [token]);

  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-6 text-[#1c3029] sm:px-8 sm:py-10"><div className="mx-auto max-w-xl"><Link href="/login" aria-label="Courtly sign in" className="inline-flex min-h-11 items-center"><CourtlyLogo /></Link><section className="mt-10 rounded-3xl border border-[#e2e7dd] bg-white p-6 text-center shadow-sm sm:mt-16 sm:p-9">
    {state === 'loading' ? <div role="status" className="flex min-h-52 items-center justify-center gap-2 text-sm text-[#59675c]"><Loader2 size={17} className="animate-spin" />Verifying your email…</div>
      : state === 'verified' ? <><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#edf5e4] text-[#4f6847]"><Check size={25} /></span><p className="mt-6 text-xs font-semibold uppercase tracking-[1.8px] text-[#59675c]">Email verified</p><h1 className="mt-2 text-3xl font-medium tracking-tight">Your email is confirmed</h1><p className="mt-3 text-sm leading-relaxed text-[#59675c]">You can now use account features that require a verified email address.</p><Button asChild className="mt-7 w-full"><Link href="/login">Continue to Courtly<ArrowRight size={15} /></Link></Button></>
      : <><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#fff3ec] text-[#9a634d]"><MailCheck size={24} /></span><h1 className="mt-6 text-2xl font-medium">This verification link is unavailable</h1><p role="alert" className="mt-3 text-sm leading-relaxed text-[#8a4937]">{error}</p><div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">{token && <Button variant="outline" onClick={() => void verify()} disabled={resending}><RefreshCw size={14} />Try this link again</Button>}<Button onClick={() => void resend()} disabled={resending}>{resending ? <Loader2 size={14} className="animate-spin" /> : <MailCheck size={14} />}Send a new email</Button></div>{resendNotice && <p role="status" className="mt-4 rounded-xl bg-[#f4f7ef] p-3 text-sm leading-relaxed text-[#4f6847]">{resendNotice}</p>}<p className="mt-5 text-xs leading-relaxed text-[#59675c]">If you still cannot verify, contact <a className="font-semibold underline underline-offset-2" href="mailto:domksj23@gmail.com">domksj23@gmail.com</a>. Do not forward the link.</p></>}
  </section></div></main>;
}
