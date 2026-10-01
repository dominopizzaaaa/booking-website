'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, CalendarDays, Check, Download, Handshake, Loader2, LogOut, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, UsersRound, X } from 'lucide-react';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  ApiError, cancelFamilyHandover, createFamilyChild, createFamilyHandover, downloadFamilyChildExport,
  loadAuthSession, loadFamily, logoutAccount, renewFamilyChildConsent, requestFamilyChildDeletion, resendAccountEmailVerification,
  setFamilyDateOfBirth, updateFamilyChild, withdrawFamilyChildConsent,
} from '@/lib/api';
import {
  isFamilyConsentRenewalChild,
  type AuthSession,
  type FamilyChild,
  type FamilyChildEntry,
  type FamilyChildInput,
  type FamilyChildUpdateInput,
  type FamilyConsentRenewalChild,
  type FamilyResponse,
} from '@/lib/types';
import { ageBandLabel, canStartFamilyHandover, canViewFamilyTraining, childStatusLabel, familyBookingTargets, hasCurrentFamilyConsent, singaporeCivilDate, validPastDate } from './family-helpers';
import { ChildForm } from './child-form';
import { ChildTrainingSection } from './child-training';

type DialogState =
  | { kind: 'add' }
  | { kind: 'renew'; child: FamilyChildEntry }
  | { kind: 'edit' | 'withdraw' | 'delete' | 'handover'; child: FamilyChild }
  | null;
const panel = 'rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6';
const field = '!min-h-12 !rounded-xl !border-[#dfe5df] !px-3.5 !text-base sm:!text-sm';

function dateLabel(value: string | null | undefined) {
  if (!value) return 'Not recorded';
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}
function dateTimeLabel(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function permission(
  child: FamilyChild,
  value: FamilyChild['link']['permissions'][number],
  statuses: FamilyChild['link']['status'][] = ['ACTIVE'],
) {
  return statuses.includes(child.link.status) && child.link.permissions.includes(value);
}
function unwrapChild<T extends FamilyChildEntry>(value: T | { child: T }): T {
  return 'child' in value ? value.child : value;
}

function ConsentRenewalCard({ child, policyVersion, busy, onRenew }: {
  child: FamilyConsentRenewalChild; policyVersion: string; busy: boolean; onRenew: () => void;
}) {
  const needsRenewal = child.link.status === 'WITHDRAWN'
    || !child.consent
    || child.consent.status === 'WITHDRAWN'
    || child.consent.policyVersion !== policyVersion;
  return <article className={panel} aria-labelledby={`family-child-${child.id}`}>
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#fff2d8] text-[#785c24]"><ShieldCheck size={20} /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`family-child-${child.id}`} className="break-words text-lg text-[#304b39]">{child.displayName}</h2>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${needsRenewal ? 'bg-[#fff2d8] text-[#785c24]' : 'bg-[#edf5e4] text-[#4f6847]'}`}>{needsRenewal ? 'Consent renewal required' : 'Consent current'}</span>
          </div>
          <p className="mt-1 text-xs text-[#59675c]">{child.link.relationshipType}</p>
        </div>
      </div>
      {needsRenewal && <Button disabled={busy} onClick={onRenew}><ShieldCheck size={14} />Renew consent</Button>}
    </div>
    <p className="mt-5 rounded-xl border border-[#ead9c5] bg-[#fffaf3] p-4 text-sm leading-relaxed text-[#735f44]">
      Courtly shows this privacy-minimal entry only for guardian consent. Profile details and all other child actions are unavailable through this consent-only access.
    </p>
  </article>;
}

export function FamilyDashboard() {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [family, setFamily] = useState<FamilyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const dialogErrorRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const auth = await loadAuthSession();
      if (auth.user.accountType === 'CLUB' || auth.user.accountControl === 'GUARDIAN_MANAGED') {
        router.replace(auth.user.requiredAction ? '/account/action-required' : auth.user.accountType === 'STUDENT' ? '/manage' : '/');
        return;
      }
      if (auth.user.requiredAction) { router.replace('/account/action-required'); return; }
      setSession(auth);
      if (auth.user.capabilities?.familyManagement !== true) {
        setFamily(null);
        setError('Family management is not available for this account. Return to your account to continue.');
        return;
      }
      if (auth.user.dateOfBirth) setFamily(await loadFamily());
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { router.replace('/login?next=%2Ffamily'); return; }
      setError(cause instanceof Error ? cause.message : 'Unable to load Family.');
    } finally { setLoading(false); }
  }, [router]);
  useEffect(() => { void refresh(); }, [refresh]);
  const bookingTargets = useMemo(() => familyBookingTargets(session), [session]);
  const signInAgain = useCallback(() => router.replace('/login?next=%2Ffamily'), [router]);
  useEffect(() => {
    if (!notice || dialog) return;
    const frame = window.requestAnimationFrame(() => noticeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [dialog, notice]);
  useEffect(() => { if (dialog && error) dialogErrorRef.current?.focus(); }, [dialog, error]);

  function openDialog(next: Exclude<DialogState, null>) {
    setError('');
    setDialog(next);
  }
  function closeDialog() {
    if (busy) return;
    setError('');
    setDialog(null);
  }

  function replaceChild(next: FamilyChildEntry) {
    setFamily(current => current ? { ...current, children: current.children.map(child => child.id === next.id ? next : child) } : current);
  }
  async function run(key: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(key); setError(''); setNotice('');
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'That change could not be saved.'); }
    finally { setBusy(null); }
  }
  async function saveDateOfBirth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('dateOfBirth') || '');
    if (!validPastDate(value)) { setError('Enter your complete date of birth.'); return; }
    await run('dob', async () => { await setFamilyDateOfBirth(value); setNotice('Date of birth saved.'); await refresh(); });
  }
  async function saveChild(values: FamilyChildInput | FamilyChildUpdateInput) {
    await run(dialog?.kind === 'edit' ? `edit:${dialog.child.id}` : 'add', async () => {
      if (dialog?.kind === 'edit') {
        replaceChild(unwrapChild(await updateFamilyChild(dialog.child.id, values as FamilyChildUpdateInput)));
        setNotice('Child profile updated.');
      } else {
        const child = unwrapChild(await createFamilyChild(values as FamilyChildInput));
        setFamily(current => current ? { ...current, children: [...current.children, child] } : current);
        setNotice(`${child.displayName} was added to Family.`);
      }
      setDialog(null);
    });
  }
  async function exportChild(child: FamilyChild) {
    await run(`export:${child.id}`, async () => {
      const { blob, filename } = await downloadFamilyChildExport(child.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
      URL.revokeObjectURL(url); setNotice(`${child.displayName}’s data export downloaded.`);
    });
  }
  async function confirmAction() {
    if (!dialog || dialog.kind === 'add' || dialog.kind === 'edit' || dialog.kind === 'handover') return;
    const child = dialog.child;
    await run(`${dialog.kind}:${child.id}`, async () => {
      if (dialog.kind === 'withdraw') replaceChild(unwrapChild(await withdrawFamilyChildConsent(child.id)));
      if (dialog.kind === 'renew') {
        if (!family) throw new Error('The current child privacy policy is unavailable. Refresh Family and try again.');
        replaceChild(unwrapChild(await renewFamilyChildConsent(child.id, family.privacyPolicyVersion)));
      }
      if (dialog.kind === 'delete') await requestFamilyChildDeletion(child.id);
      setNotice(dialog.kind === 'withdraw' ? `Consent withdrawn for ${child.displayName}.` : dialog.kind === 'renew' ? `Consent renewed for ${child.displayName}.` : `Deletion requested for ${child.displayName}. The profile is restricted immediately and the request is pending separate human review.`);
      setDialog(null); await refresh();
    });
  }
  async function submitHandover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (dialog?.kind !== 'handover' || !family?.handoverAvailable) return;
    const destinationEmail = String(new FormData(event.currentTarget).get('destinationEmail') || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(destinationEmail)) { setError('Enter the email address the child will use for their independent account.'); return; }
    await run(`handover:${dialog.child.id}`, async () => {
      const result = await createFamilyHandover(dialog.child.id, destinationEmail);
      replaceChild({ ...dialog.child, handover: result.handover });
      setDialog(null);
      setNotice(result.emailQueued === true && result.handover.emailQueued === true
        ? 'Handover created and its verification email queued. The child must use that link to create their own password.'
        : 'The handover was created, but Courtly could not confirm that its verification email was queued.');
    });
  }
  async function cancelHandover(child: FamilyChild) {
    if (!child.handover || !window.confirm(`Cancel the pending handover for ${child.displayName}? The existing link will stop working.`)) return;
    await run(`cancel-handover:${child.id}`, async () => { await cancelFamilyHandover(child.id, child.handover!.id); await refresh(); setNotice(`Handover cancelled for ${child.displayName}.`); });
  }
  async function signOut() {
    await run('logout', async () => { await logoutAccount(); router.replace('/login'); router.refresh(); });
  }
  async function resendVerification() {
    await run('verification-email', async () => {
      const result = await resendAccountEmailVerification();
      setNotice(result.alreadyVerified
        ? 'Your email is already verified. Refreshing Family now.'
        : 'A new verification email has been queued. Use only the newest link.');
      if (result.alreadyVerified) await refresh();
    });
  }

  const missingDob = !!session && !session.user.dateOfBirth;
  return <main className="min-h-screen bg-[#f6f7f4] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-5 text-[#1c3029] sm:px-8 sm:py-8">
    <div className="mx-auto max-w-4xl">
      <header className="flex min-h-12 items-center justify-between gap-3"><Link href={session?.user.accountType === 'STUDENT' ? '/manage?tab=profile' : '/account'} aria-label="Courtly account"><CourtlyLogo /></Link>{session && <Button variant="ghost" onClick={() => void signOut()} disabled={busy === 'logout'}><LogOut size={15} />Sign out</Button>}</header>
      {loading ? <div role="status" className="grid min-h-[65vh] place-items-center text-sm text-[#59675c]"><span className="flex items-center gap-2"><Loader2 size={18} className="animate-spin" />Opening Family…</span></div>
      : error && !family ? <section className={`${panel} mx-auto mt-16 max-w-lg text-center`}><h1 className="text-2xl">{session ? 'Family is unavailable' : 'We couldn’t open Family'}</h1><p role="alert" className="mt-3 text-sm text-[#8a4937]">{error}</p><div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">{session && <Button asChild><Link href={session.user.accountType === 'STUDENT' ? '/manage?tab=profile' : '/account'}><ArrowLeft size={15} />Back to account</Link></Button>}<Button variant={session ? 'outline' : 'default'} onClick={() => void refresh()}><RefreshCw size={15} />Try again</Button></div></section>
      : session && missingDob ? <section className={`${panel} mx-auto mt-12 max-w-xl sm:mt-20`} aria-labelledby="family-dob-title"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#edf2e5] text-[#6f865f]"><CalendarDays size={22} /></span><p className="mt-6 text-xs font-semibold uppercase tracking-[1.8px] text-[#59675c]">One-time age check</p><h1 id="family-dob-title" className="mt-2 text-3xl font-medium tracking-tight">Confirm your date of birth</h1><p className="mt-3 text-sm leading-relaxed text-[#59675c]">Family is for eligible adult personal accounts. Courtly needs your complete date of birth before the server can decide whether this account may manage children.</p><form className="mt-6" onSubmit={event => void saveDateOfBirth(event)}><label htmlFor="family-guardian-dob">Date of birth</label><input id="family-guardian-dob" name="dateOfBirth" type="date" className={field} min="1900-01-01" max={singaporeCivilDate()} required disabled={busy === 'dob'} />{error && <p role="alert" className="mt-3 rounded-xl bg-[#fff6f1] p-3 text-sm text-[#8a4937]">{error}</p>}<Button className="mt-5 w-full" type="submit" disabled={busy === 'dob'}>{busy === 'dob' && <Loader2 size={15} className="animate-spin" />}Continue to Family</Button></form></section>
      : session && family ? <div className="mt-8 sm:mt-12">
        <Link href={session.user.accountType === 'STUDENT' ? '/manage?tab=profile' : '/account'} className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[#45673c]"><ArrowLeft size={15} />Back to account</Link>
        <header className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[1.8px] text-[#59675c]">Private family management</p><h1 className="mt-2 text-4xl font-medium tracking-[-1.2px]">Family</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-[#59675c]">Use your own adult account to add and manage every child in your care. Each child gets a separate profile and has no direct sign-in until a verified handover is completed.</p></div>{family.guardian.eligible && <Button size="lg" onClick={() => openDialog({ kind: 'add' })}><Plus size={17} />Add child</Button>}</header>
        {notice && <div ref={noticeRef} tabIndex={-1} role="status" className="mt-6 flex items-start gap-2 rounded-xl border border-[#d8e4cb] bg-[#edf5e4] p-4 text-sm text-[#4f6847] outline-none"><Check size={17} className="mt-0.5 shrink-0" />{notice}</div>}
        {error && !dialog && <div role="alert" className="mt-6 rounded-xl border border-[#e4c7bc] bg-[#fff6f1] p-4 text-sm text-[#8a4937]">{error}</div>}
        {!family.guardian.eligible && <section className={`${panel} mt-6 border-[#ead9c5] bg-[#fffaf3]`}><h2 className="text-lg">Family management is unavailable</h2><p className="mt-2 text-sm leading-relaxed text-[#735f44]">{family.guardian.emailVerified === false ? 'Verify your sign-in email before creating or managing a child profile.' : family.guardian.reason === 'PARENT_ACCOUNT_REQUIRED' ? 'This account must be managed by an adult and cannot manage another child.' : 'The server has determined that this account is not eligible to manage children.'}</p>{family.guardian.emailVerified === false && <Button className="mt-4" disabled={!!busy} onClick={() => void resendVerification()}>{busy === 'verification-email' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}Send verification email</Button>}</section>}
        {family.children.length ? <div className="mt-7 grid gap-4">{family.children.map(child => {
          if (isFamilyConsentRenewalChild(child)) {
            return <ConsentRenewalCard
              key={child.id}
              child={child}
              policyVersion={family.privacyPolicyVersion}
              busy={!!busy}
              onRenew={() => openDialog({ kind: 'renew', child })}
            />;
          }
          const consentCurrent = hasCurrentFamilyConsent(child, family.privacyPolicyVersion);
          const pendingHandover = child.handover?.status === 'PENDING';
          const handoverEligible = canStartFamilyHandover(child, family.privacyPolicyVersion);
          return <article key={child.id} className={panel} aria-labelledby={`family-child-${child.id}`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex min-w-0 items-start gap-3"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#e8efe0] text-[#4f6847]"><UserRound size={20} /></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 id={`family-child-${child.id}`} className="break-words text-lg text-[#304b39]">{child.displayName}</h2><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${child.accountStatus === 'ACTIVE' ? 'bg-[#edf5e4] text-[#4f6847]' : child.accountStatus === 'CONSENT_REQUIRED' ? 'bg-[#fff2d8] text-[#785c24]' : 'bg-[#fbebeb] text-[#8b4d3c]'}`}>{childStatusLabel(child)}</span></div><p className="mt-1 break-all text-sm text-[#59675c]">@{child.username}</p><p className="mt-1 text-xs text-[#59675c]">{child.link.relationshipType} · {ageBandLabel(child.ageBand)}</p></div></div>{permission(child, 'PROFILE_MANAGE') && child.accountStatus !== 'DELETION_REQUESTED' && <Button variant="outline" onClick={() => openDialog({ kind: 'edit', child })}><Pencil size={14} />Edit</Button>}</div>
          <details className="mt-5 rounded-xl border border-[#e4e9df] bg-[#fafbf8]">
            <summary className="min-h-11 cursor-pointer px-4 py-3 text-xs font-semibold text-[#405941] marker:text-[#6f865f]">Profile and privacy details</summary>
            <div className="border-t border-[#e4e9df] p-3">
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="rounded-xl bg-[#f5f7f1] p-3"><dt className="text-xs text-[#59675c]">Date of birth</dt><dd className="mt-1 text-sm font-semibold">{dateLabel(child.dateOfBirth)}</dd></div><div className="rounded-xl bg-[#f5f7f1] p-3"><dt className="text-xs text-[#59675c]">Visibility</dt><dd className="mt-1 text-sm font-semibold">{child.profileVisibility === 'CLUBS_ONLY' ? 'Clubs only' : 'Private'}</dd></div><div className="rounded-xl bg-[#f5f7f1] p-3"><dt className="text-xs text-[#59675c]">Consent</dt><dd className="mt-1 text-sm font-semibold">{consentCurrent ? `Current · ${child.consent!.policyVersion}` : 'Action needed'}</dd></div><div className="rounded-xl bg-[#f5f7f1] p-3"><dt className="text-xs text-[#59675c]">Account access</dt><dd className="mt-1 text-sm font-semibold">{child.accountControl === 'GUARDIAN_MANAGED' ? 'No sign-in' : 'Self-managed'}</dd></div></dl>
              {child.sports.length > 0 && <div className="mt-4 flex flex-wrap gap-2">{child.sports.map(sport => <span key={sport.toLowerCase()} className="rounded-full bg-[#edf3e7] px-2.5 py-1 text-xs font-semibold text-[#496353]">{sport}</span>)}</div>}
            </div>
          </details>
          {pendingHandover && <div className="mt-5 rounded-xl border border-[#dfdfca] bg-[#fbfaee] p-4"><p className="text-sm font-semibold text-[#655f3e]">Handover pending{child.handover?.maskedDestinationEmail ? ` for ${child.handover.maskedDestinationEmail}` : ''}</p><p className="mt-1 text-xs leading-relaxed text-[#756f51]">Expires {dateTimeLabel(child.handover?.expiresAt)}. Courtly queued the security email when this handover was created; delivery is not guaranteed. Until completion, this remains a guardian-managed profile with no sign-in.</p>{permission(child, 'HANDOVER_MANAGE') && <Button variant="outline" size="sm" className="mt-3" disabled={busy === `cancel-handover:${child.id}`} onClick={() => void cancelHandover(child)}><X size={14} />Cancel handover</Button>}</div>}
          {child.accountStatus === 'DELETION_REQUESTED' && <div className="mt-5 rounded-xl border border-[#ecd5cc] bg-[#fbefeb] p-4 text-sm leading-relaxed text-[#8b4d3c]">Deletion has been requested. The profile is restricted immediately, and the deletion request is pending a separate human review under Courtly’s retention and erasure process.</div>}
          {canViewFamilyTraining(child, family.privacyPolicyVersion) && <ChildTrainingSection child={child} bookingTargets={bookingTargets} onUnauthorized={signInAgain} />}
          <div className="mt-5 flex flex-wrap gap-2 border-t border-[#edf0e8] pt-5">{permission(child, 'DATA_EXPORT', ['ACTIVE', 'WITHDRAWN']) && (child.link.status === 'WITHDRAWN' || consentCurrent) && <Button variant="outline" disabled={!!busy} onClick={() => void exportChild(child)}>{busy === `export:${child.id}` ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}Export data</Button>}{permission(child, 'CONSENT_MANAGE') && child.accountStatus !== 'DELETION_REQUESTED' && consentCurrent && <Button variant="outline" disabled={!!busy} onClick={() => openDialog({ kind: 'withdraw', child })}><ShieldCheck size={14} />Withdraw consent</Button>}{permission(child, 'CONSENT_MANAGE', ['ACTIVE', 'WITHDRAWN']) && child.accountStatus !== 'DELETION_REQUESTED' && !consentCurrent && <Button disabled={!!busy} onClick={() => openDialog({ kind: 'renew', child })}><ShieldCheck size={14} />Renew consent</Button>}{handoverEligible && !pendingHandover && <Button variant="outline" disabled={!!busy || !family.handoverAvailable} title={!family.handoverAvailable ? 'Secure handover is unavailable' : undefined} onClick={() => openDialog({ kind: 'handover', child })}><Handshake size={14} />Start handover</Button>}{permission(child, 'DELETION_REQUEST') && child.accountStatus !== 'DELETION_REQUESTED' && <Button variant="destructive" disabled={!!busy} onClick={() => openDialog({ kind: 'delete', child })}><Trash2 size={14} />Request deletion</Button>}</div>
          {!family.handoverAvailable && handoverEligible && !pendingHandover && <p className="mt-3 text-xs leading-relaxed text-[#756f51]">Secure account handover is unavailable right now. Try again later.</p>}
        </article>; })}</div> : family.guardian.eligible ? <section className={`${panel} mt-8 py-12 text-center`}><UsersRound size={26} className="mx-auto text-[#71865f]" /><h2 className="mt-4 text-lg">No children added yet</h2><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[#59675c]">Add a child to manage their private profile, privacy choice, consent, data requests, and eventual verified handover.</p><Button className="mt-6" onClick={() => openDialog({ kind: 'add' })}><Plus size={16} />Add child</Button></section> : null}
        <details className="mt-7 rounded-2xl border border-[#dfe7d8] bg-[#f1f5ed] text-sm leading-relaxed text-[#59675c]"><summary className="min-h-12 cursor-pointer px-5 py-4 font-semibold text-[#304b39] marker:text-[#6f865f]">How booking and handover work</summary><div className="border-t border-[#dfe7d8] px-5 pb-5 pt-4"><p>Book one child at a time from a club’s booking page by choosing them under “Who is playing?”. Payment, cancellations, and reschedules for a child are arranged with the club.</p><p className="!mt-3 text-xs"><strong className="text-[#405941]">When they turn 13:</strong> a child may stay managed so you can keep booking for them, or you may start account handover. A self-managed teen can sign in for non-commercial features, but cannot book or pay on Courtly until 18.</p></div></details>
      </div> : null}
    </div>
    <Dialog open={!!dialog} onOpenChange={open => { if (!open) closeDialog(); }}><DialogContent className="max-w-2xl" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }} onCloseAutoFocus={event => { if (notice) { event.preventDefault(); window.requestAnimationFrame(() => noticeRef.current?.focus()); } }}>
      {dialog && error && <div ref={dialogErrorRef} tabIndex={-1} role="alert" className="mb-5 rounded-xl border border-[#e4c7bc] bg-[#fff6f1] p-3.5 pr-12 text-sm text-[#8a4937] outline-none">{error}</div>}
      {dialog?.kind === 'add' && family && <><DialogTitle className="text-xl">Add a child</DialogTitle><DialogDescription className="mt-2 text-sm leading-relaxed text-[#59675c]">Create a separate guardian-managed player profile for this child. You can return here and add every child you manage.</DialogDescription><div className="mt-6"><ChildForm policyVersion={family.privacyPolicyVersion} busy={busy === 'add'} onSubmit={saveChild} onCancel={closeDialog} /></div></>}
      {dialog?.kind === 'edit' && family && <><DialogTitle className="text-xl">Edit {dialog.child.displayName}</DialogTitle><DialogDescription className="mt-2 text-sm leading-relaxed text-[#59675c]">Username, date of birth, and guardian relationship are intentionally not editable here.</DialogDescription><div className="mt-6"><ChildForm child={dialog.child} policyVersion={family.privacyPolicyVersion} busy={busy === `edit:${dialog.child.id}`} onSubmit={saveChild} onCancel={closeDialog} /></div></>}
      {dialog && ['withdraw', 'renew', 'delete'].includes(dialog.kind) && 'child' in dialog && <><DialogTitle className="text-xl">{dialog.kind === 'withdraw' ? 'Withdraw guardian consent?' : dialog.kind === 'renew' ? 'Renew guardian consent?' : 'Request profile deletion?'}</DialogTitle><DialogDescription className="mt-3 text-sm leading-relaxed text-[#59675c]">{dialog.kind === 'withdraw' ? `${dialog.child.displayName} will lose access that depends on guardian consent. You can renew consent later if the policy allows it.` : dialog.kind === 'renew' ? `You confirm again that you are ${dialog.child.displayName}’s legal guardian and consent to the current child privacy policy (${family?.privacyPolicyVersion}).` : `${dialog.child.displayName}’s profile will be restricted immediately. The deletion request will then enter a separate human-reviewed retention and erasure process; submitting this request does not instantly erase the profile.`}</DialogDescription><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button variant="ghost" disabled={!!busy} onClick={closeDialog}>Cancel</Button><Button variant={dialog.kind === 'delete' ? 'destructive' : 'default'} disabled={!!busy} onClick={() => void confirmAction()}>{busy?.startsWith(dialog.kind) && <Loader2 size={14} className="animate-spin" />}{dialog.kind === 'withdraw' ? 'Withdraw consent' : dialog.kind === 'renew' ? 'Renew consent' : 'Request deletion'}</Button></div></>}
      {dialog?.kind === 'handover' && <><DialogTitle className="text-xl">Hand over {dialog.child.displayName}’s account</DialogTitle><DialogDescription className="mt-2 text-sm leading-relaxed text-[#59675c]">Create a time-limited verification link and queue its security email so the child can create their own 12-character password. Their profile remains managed until completion.</DialogDescription>{family?.handoverAvailable ? <form className="mt-6" onSubmit={event => void submitHandover(event)}><label htmlFor="handover-email">Destination email</label><input id="handover-email" name="destinationEmail" type="email" className={field} autoComplete="email" required disabled={!!busy} /><div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="ghost" disabled={!!busy} onClick={closeDialog}>Cancel</Button><Button type="submit" disabled={!!busy}>{busy?.startsWith('handover:') && <Loader2 size={14} className="animate-spin" />}Create and queue email</Button></div></form> : <div role="status" className="mt-6 rounded-xl border border-[#e7ddc8] bg-[#fffaf0] p-4 text-sm leading-relaxed text-[#756345]">Secure account handover is unavailable right now. Try again later.</div>}</>}
    </DialogContent></Dialog>
  </main>;
}
