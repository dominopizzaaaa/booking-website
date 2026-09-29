'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, Loader2, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import { ApiError, completeFamilyHandover, loadFamilyHandover } from '@/lib/api';
import type { FamilyHandoverPublic } from '@/lib/types';

const field = '!min-h-12 !rounded-xl !border-[#dfe5df] !px-3.5 !text-base';

function errorCopy(error: unknown) {
  const details = error instanceof ApiError && error.details && typeof error.details === 'object' ? error.details as { code?: string; reason?: string } : null;
  const code = details?.code ?? details?.reason;
  if (code === 'HANDOVER_EXPIRED') return 'This handover link has expired. Ask the guardian to create a new one.';
  if (code === 'HANDOVER_ALREADY_USED' || code === 'HANDOVER_REPLAYED') return 'This handover link has already been completed and cannot be used again.';
  if (code === 'EMAIL_CONFLICT') return 'That email already belongs to a Courtly account. Sign in to that account or ask the guardian to use another email.';
  if (error instanceof ApiError && error.status === 404) return 'This handover link is invalid or no longer available.';
  return error instanceof Error ? error.message : 'This handover could not be completed.';
}

export function FamilyHandoverPage() {
  const token = useSearchParams().get('token')?.trim() || '';
  const [request, setRequest] = useState<FamilyHandoverPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);

  async function load() {
    if (!token) { setError('This handover link is missing its secure token. Ask the guardian for a new link.'); setLoading(false); return; }
    setLoading(true); setError('');
    try { setRequest(await loadFamilyHandover(token)); }
    catch (cause) { setError(errorCopy(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !token) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    const confirmPassword = String(form.get('confirmPassword') || '');
    if (password.length < 12) { setError('Use at least 12 characters for your new password.'); return; }
    if (password !== confirmPassword) { setError('The passwords do not match.'); return; }
    setBusy(true); setError('');
    try { await completeFamilyHandover(token, password); setComplete(true); }
    catch (cause) { setError(errorCopy(cause)); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-6 text-[#1c3029] sm:px-8 sm:py-10"><div className="mx-auto max-w-xl"><Link href="/login" aria-label="Courtly sign in" className="inline-flex min-h-11 items-center"><CourtlyLogo /></Link><section className="mt-10 rounded-3xl border border-[#e2e7dd] bg-white p-6 shadow-sm sm:mt-16 sm:p-9">
    {loading ? <div role="status" className="flex min-h-52 items-center justify-center gap-2 text-sm text-[#59675c]"><Loader2 size={17} className="animate-spin" />Checking this secure handover…</div>
      : complete ? <div className="text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#edf5e4] text-[#4f6847]"><Check size={25} /></span><p className="mt-6 text-xs font-semibold uppercase tracking-[1.8px] text-[#59675c]">Handover complete</p><h1 className="mt-2 text-3xl font-medium tracking-tight">Your account is ready</h1><p className="mt-3 text-sm leading-relaxed text-[#59675c]">The managed child profile is now an independent Courtly account. Sign in using the verified email and the password you just created.</p><Button asChild className="mt-7 w-full"><Link href="/login">Continue to sign in<ArrowRight size={15} /></Link></Button></div>
      : error && !request ? <div className="text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#fff3ec] text-[#9a634d]"><LockKeyhole size={24} /></span><h1 className="mt-6 text-2xl font-medium">This handover link is unavailable</h1><p role="alert" className="mt-3 text-sm leading-relaxed text-[#8a4937]">{error}</p><Button variant="outline" className="mt-6" onClick={() => void load()}><RefreshCw size={14} />Check again</Button></div>
      : request ? <><span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#edf2e5] text-[#6f865f]"><ShieldCheck size={22} /></span><p className="mt-6 text-xs font-semibold uppercase tracking-[1.8px] text-[#59675c]">Verified account handover</p><h1 className="mt-2 text-3xl font-medium tracking-tight">Create your Courtly password</h1><p className="mt-3 text-sm leading-relaxed text-[#59675c]">This handover will make <strong className="text-[#304b39]">{request.childName}</strong> an independent account with its own sign-in.</p>{request.maskedDestinationEmail && <p className="mt-3 rounded-xl bg-[#f4f7ef] p-3 text-sm text-[#59675c]">Verified email: <strong className="text-[#304b39]">{request.maskedDestinationEmail}</strong></p>}<p className="mt-3 text-xs text-[#59675c]">This link expires {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(request.expiresAt))} and can be used once.</p><form className="mt-7 space-y-5" onSubmit={event => void submit(event)}><div><label htmlFor="handover-password">New password</label><input id="handover-password" name="password" type="password" className={field} minLength={12} maxLength={72} autoComplete="new-password" required disabled={busy} /><p className="mt-1.5 text-xs text-[#59675c]">Use at least 12 characters.</p></div><div><label htmlFor="handover-confirm-password">Confirm password</label><input id="handover-confirm-password" name="confirmPassword" type="password" className={field} minLength={12} maxLength={72} autoComplete="new-password" required disabled={busy} /></div>{error && <p role="alert" className="rounded-xl border border-[#e4c7bc] bg-[#fff6f1] p-3.5 text-sm text-[#8a4937]">{error}</p>}<Button type="submit" size="lg" className="w-full" disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : <LockKeyhole size={16} />}Complete handover</Button></form></> : null}
  </section></div></main>;
}
