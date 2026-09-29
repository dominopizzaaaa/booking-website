'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Loader2, LogOut, RefreshCw, ShieldAlert, UsersRound } from 'lucide-react';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import { ApiError, loadAuthSession, logoutAccount } from '@/lib/api';
import type { AuthSession } from '@/lib/types';
import { requiredActionCopy } from './family-helpers';

export function ActionRequiredPage() {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const value = await loadAuthSession();
      if (!value.user.requiredAction) {
        router.replace(value.user.accountType === 'STUDENT' ? '/manage' : value.business && value.accessMode !== 'NONE' ? '/' : '/account');
        return;
      }
      setSession(value);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { router.replace('/login'); return; }
      setError(cause instanceof Error ? cause.message : 'Unable to check your account.');
    } finally { setLoading(false); }
  }, [router]);
  useEffect(() => { void load(); }, [load]);
  async function signOut() {
    if (signingOut) return; setSigningOut(true); setError('');
    try { await logoutAccount(); router.replace('/login'); router.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to sign out.'); setSigningOut(false); }
  }
  const copy = requiredActionCopy(session?.user.requiredAction);
  const guardianRemediation = session?.user.requiredAction === 'CONSENT_REQUIRED' || session?.user.requiredAction === 'GUARDIAN_SESSION_STALE';
  const canOpenFamily = session?.user.capabilities?.familyManagement === true;
  return <main className="min-h-screen bg-[#f6f7f4] px-5 py-7 text-[#1c3029]"><div className="mx-auto max-w-xl"><CourtlyLogo /><section className="mt-14 rounded-3xl border border-[#e3dfd4] bg-white p-6 text-center shadow-sm sm:mt-20 sm:p-9">{loading ? <div role="status" className="flex min-h-56 items-center justify-center gap-2 text-sm text-[#59675c]"><Loader2 size={17} className="animate-spin" />Checking your account…</div> : session ? <><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#fff3e6] text-[#8c6840]"><ShieldAlert size={25} /></span><p className="mt-6 text-xs font-semibold uppercase tracking-[1.8px] text-[#59675c]">Account protection</p><h1 className="mt-2 text-3xl font-medium tracking-tight">{copy.title}</h1><p className="mt-4 text-sm leading-relaxed text-[#59675c]">{copy.detail}</p>{guardianRemediation && <p className="mt-3 text-sm leading-relaxed text-[#59675c]">Ask the parent or guardian who manages this profile to sign in and open Family. This account cannot bypass that server policy.</p>}<div className="mt-8 grid gap-3">{canOpenFamily && <Button asChild size="lg"><Link href="/family"><UsersRound size={16} />Open Family<ArrowRight size={15} /></Link></Button>}<Button variant="outline" size="lg" disabled={loading} onClick={() => void load()}><RefreshCw size={15} />Check again</Button><Button variant="ghost" size="lg" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? <Loader2 size={15} className="animate-spin" /> : <LogOut size={15} />}Sign out</Button></div></> : <><h1 className="text-2xl">We couldn’t check your account</h1><p role="alert" className="mt-3 text-sm text-[#8a4937]">{error}</p><Button className="mt-6" onClick={() => void load()}><RefreshCw size={14} />Try again</Button></>}</section></div></main>;
}
