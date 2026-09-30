'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Laptop, Loader2, LockKeyhole, LogOut, MailCheck, RefreshCw, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { CourtlyLogo } from '@/components/public-booking';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  ApiError, confirmTotpEnrollment, disableAccountMfa, loadAccountSecurity, reauthenticateAccount,
  regenerateMfaRecoveryCodes, requestAccountEmailChange, revokeAccountSecuritySession,
  revokeOtherAccountSecuritySessions, startTotpEnrollment,
} from '@/lib/api';
import { isRecentAuthRequired } from '@/lib/account-security';
import type { AccountSecurity, AccountSecuritySession, MfaMethod, TotpEnrollment } from '@/lib/types';

const inputClass = '!min-h-12 !rounded-xl !border-[#dfe5dd] !px-3.5 !text-base';
type PendingAction = { label: string; run: () => Promise<void> };

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
function formatMoment(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function sessionName(session: AccountSecuritySession) {
  if (session.deviceLabel?.trim()) return session.deviceLabel;
  const agent = session.userAgent ?? '';
  const browser = /Firefox/iu.test(agent) ? 'Firefox' : /Edg/iu.test(agent) ? 'Edge' : /Chrome/iu.test(agent) ? 'Chrome' : /Safari/iu.test(agent) ? 'Safari' : 'Browser';
  const platform = /iPhone|iPad/iu.test(agent) ? 'iPhone or iPad' : /Android/iu.test(agent) ? 'Android device' : /Mac/iu.test(agent) ? 'Mac' : /Windows/iu.test(agent) ? 'Windows device' : '';
  return platform ? `${browser} on ${platform}` : browser;
}

function StatusNotice({ notice, error }: { notice: string; error: string }) {
  if (error) return <p role="alert" className="mt-4 rounded-xl border border-[#e4c7bc] bg-[#fff6f1] p-3.5 text-sm leading-relaxed text-[#8a4937]">{error}</p>;
  if (notice) return <p role="status" className="mt-4 rounded-xl border border-[#dce8d4] bg-[#f2f7ed] p-3.5 text-sm leading-relaxed text-[#45623f]">{notice}</p>;
  return null;
}

export function SecurityCenter() {
  const router = useRouter();
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthMethod, setReauthMethod] = useState<MfaMethod>('TOTP');
  const [reauthCode, setReauthCode] = useState('');
  const [reauthError, setReauthError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await loadAccountSecurity();
      setSecurity(result); setEmail('');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { router.replace('/login?next=%2Faccount%2Fsecurity'); return; }
      setError(errorMessage(cause, 'Unable to load account security settings.'));
    } finally { setLoading(false); }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  async function sensitive(label: string, action: () => Promise<void>) {
    try { await action(); }
    catch (cause) {
      if (isRecentAuthRequired(cause)) { setPendingAction({ label, run: action }); setReauthError(''); return; }
      throw cause;
    }
  }
  function clearMessages() { setError(''); setNotice(''); }

  async function changeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalized)) { setError('Enter a valid email address.'); return; }
    if (normalized === security?.email?.toLowerCase()) { setError('Enter a different email address.'); return; }
    setBusy('email'); clearMessages();
    try {
      await sensitive('change your sign-in email', async () => {
        await requestAccountEmailChange(normalized);
        setNotice(`A confirmation link was sent to ${normalized}. Your current email stays active until you confirm the new one.`);
      });
    } catch (cause) { setError(errorMessage(cause, 'Unable to start the email change.')); }
    finally { setBusy(null); }
  }

  async function beginEnrollment() {
    setBusy('enroll'); clearMessages();
    try {
      await sensitive('set up two-step verification', async () => {
        setEnrollment(await startTotpEnrollment()); setTotpCode('');
      });
    } catch (cause) { setError(errorMessage(cause, 'Unable to start authenticator setup.')); }
    finally { setBusy(null); }
  }
  async function confirmEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment || busy) return;
    const code = totpCode.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setBusy('confirm-mfa'); clearMessages();
    try {
      await sensitive('finish setting up two-step verification', async () => {
        const result = await confirmTotpEnrollment(enrollment.enrollmentId, code);
        setRecoveryCodes(result.recoveryCodes); setEnrollment(null); setTotpCode('');
        setSecurity(current => current ? { ...current, mfa: { enabled: true, verifiedAt: new Date().toISOString(), recoveryCodesRemaining: result.recoveryCodes.length } } : current);
        setNotice('Two-step verification is on. Save every recovery code before leaving this page.');
      });
    } catch (cause) { setError(errorMessage(cause, 'That authenticator code could not be verified.')); }
    finally { setBusy(null); }
  }
  async function disableMfa() {
    if (busy || !window.confirm('Turn off two-step verification for this account?')) return;
    setBusy('disable-mfa'); clearMessages();
    try {
      await sensitive('turn off two-step verification', async () => {
        await disableAccountMfa(); setRecoveryCodes([]); setEnrollment(null);
        setSecurity(current => current ? { ...current, mfa: { enabled: false, verifiedAt: null, recoveryCodesRemaining: 0 } } : current);
        setNotice('Two-step verification is off.');
      });
    } catch (cause) { setError(errorMessage(cause, 'Unable to turn off two-step verification.')); }
    finally { setBusy(null); }
  }
  async function regenerateCodes() {
    if (busy || !window.confirm('Replace all existing recovery codes? Old codes will stop working immediately.')) return;
    setBusy('recovery'); clearMessages();
    try {
      await sensitive('replace your recovery codes', async () => {
        const result = await regenerateMfaRecoveryCodes(); setRecoveryCodes(result.recoveryCodes);
        setSecurity(current => current ? { ...current, mfa: { ...current.mfa, recoveryCodesRemaining: result.recoveryCodes.length } } : current);
        setNotice('New recovery codes created. Save them now; old codes no longer work.');
      });
    } catch (cause) { setError(errorMessage(cause, 'Unable to replace recovery codes.')); }
    finally { setBusy(null); }
  }
  async function revokeSession(session: AccountSecuritySession) {
    const words = session.current ? 'Sign out this device now?' : `Sign out ${sessionName(session)}?`;
    if (busy || !window.confirm(words)) return;
    setBusy(`session:${session.id}`); clearMessages();
    try {
      await sensitive('revoke an active session', async () => {
        await revokeAccountSecuritySession(session.id);
        if (session.current) { router.replace('/login'); router.refresh(); return; }
        setSecurity(current => current ? { ...current, sessions: current.sessions.filter(item => item.id !== session.id) } : current);
        setNotice('That session has been signed out.');
      });
    } catch (cause) { setError(errorMessage(cause, 'Unable to revoke that session.')); }
    finally { setBusy(null); }
  }
  async function revokeOthers() {
    if (busy || !window.confirm('Sign out every other device?')) return;
    setBusy('other-sessions'); clearMessages();
    try {
      await sensitive('revoke other active sessions', async () => {
        await revokeOtherAccountSecuritySessions();
        setSecurity(current => current ? { ...current, sessions: current.sessions.filter(item => item.current) } : current);
        setNotice('Every other device has been signed out.');
      });
    } catch (cause) { setError(errorMessage(cause, 'Unable to revoke the other sessions.')); }
    finally { setBusy(null); }
  }
  async function submitReauth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingAction || busy) return;
    const code = reauthCode.replace(/\s/g, '');
    if (!reauthPassword) { setReauthError('Enter your current password.'); return; }
    if (security?.mfa.enabled && reauthMethod === 'TOTP' && !/^\d{6}$/.test(code)) { setReauthError('Enter the 6-digit code from your authenticator app.'); return; }
    setBusy('reauth'); setReauthError('');
    try {
      await reauthenticateAccount({ password: reauthPassword, ...(security?.mfa.enabled ? { method: reauthMethod, code: reauthMethod === 'TOTP' ? code : reauthCode.trim() } : {}) });
      const action = pendingAction;
      await action.run();
      setPendingAction(null); setReauthPassword(''); setReauthCode('');
    } catch (cause) { setReauthError(errorMessage(cause, 'Courtly could not confirm your identity.')); }
    finally { setBusy(null); }
  }
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied.`); setError(''); }
    catch { setError(`Could not copy ${label.toLowerCase()}. Select and copy it manually.`); }
  }

  return <main className="min-h-screen bg-[#f6f7f4] px-5 py-6 text-[#1c3029] sm:px-10 sm:py-9"><div className="mx-auto max-w-3xl"><header className="flex items-center justify-between gap-4"><Link href="/account" aria-label="Courtly account"><CourtlyLogo /></Link><Button variant="ghost" asChild><Link href="/account">Back to account</Link></Button></header><section className="mx-auto mt-12 max-w-2xl sm:mt-20"><div className="text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[#e0e6d7] bg-[#edf2e5] text-[#758b66]"><ShieldCheck size={25} /></span><p className="mt-6 text-[10px] font-semibold uppercase tracking-[2px] text-[#59675c]">ACCOUNT SECURITY</p><h1 className="mt-2 text-[32px] font-medium tracking-[-1px]">Protect your Courtly account</h1><p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-[#59675c]">Manage your sign-in email, authenticator, recovery codes, and devices.</p></div>
    {loading ? <div role="status" className="flex min-h-64 items-center justify-center gap-2 text-sm text-[#59675c]"><Loader2 size={18} className="animate-spin" />Loading security settings…</div> : error && !security ? <div className="mt-8 rounded-2xl border border-[#eedbd4] bg-white p-7 text-center"><p role="alert" className="text-sm text-[#8a4937]">{error}</p><Button variant="outline" className="mt-5" onClick={() => void load()}><RefreshCw size={14} />Try again</Button></div> : security ? <div className="mt-8 space-y-5"><StatusNotice notice={notice} error={error} />
      <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="security-email-heading"><div className="flex items-start gap-3"><MailCheck size={19} className="mt-0.5 shrink-0 text-[#66805a]" /><div><h2 id="security-email-heading" className="text-base text-[#405941]">Sign-in email</h2><p className="mt-1 text-xs leading-relaxed text-[#59675c]">Your current email is <strong>{security.email ?? 'not available'}</strong>{security.emailVerified ? ' and is verified.' : ' and still needs verification.'}</p></div></div><form className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={changeEmail}><div><label htmlFor="security-new-email">New email address</label><input id="security-new-email" type="email" className={inputClass} autoComplete="email" maxLength={254} required value={email} onChange={event => { setEmail(event.target.value); clearMessages(); }} disabled={!!busy} /></div><Button type="submit" className="min-h-12" disabled={!!busy || !security.email}>{busy === 'email' && <Loader2 size={14} className="animate-spin" />}Verify new email</Button></form><p className="mt-3 text-xs leading-relaxed text-[#59675c]">The change is not complete until you open the one-time link sent to the new address. Your current email remains active until then.</p></section>

      <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="security-mfa-heading"><div className="flex items-start justify-between gap-3"><div className="flex items-start gap-3"><KeyRound size={19} className="mt-0.5 shrink-0 text-[#66805a]" /><div><h2 id="security-mfa-heading" className="text-base text-[#405941]">Authenticator app</h2><p className="mt-1 text-xs leading-relaxed text-[#59675c]">{security.mfa.enabled ? `On · ${security.mfa.recoveryCodesRemaining} recovery code${security.mfa.recoveryCodesRemaining === 1 ? '' : 's'} left` : 'Add a second step after your password.'}</p></div></div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${security.mfa.enabled ? 'bg-[#edf5e4] text-[#4f6847]' : 'bg-[#f2f3ef] text-[#59675c]'}`}>{security.mfa.enabled ? 'On' : 'Off'}</span></div>
        {!security.mfa.enabled && !enrollment && <Button className="mt-5" onClick={() => void beginEnrollment()} disabled={!!busy}>{busy === 'enroll' && <Loader2 size={14} className="animate-spin" />}Set up authenticator</Button>}
        {enrollment && <div className="mt-5 rounded-xl border border-[#dce5d6] bg-[#f7f9f4] p-4"><ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-[#59675c]"><li>In your authenticator app, add a new account.</li><li>Scan using the app from the setup link, or enter the secret manually.</li><li>Enter the six-digit code below to confirm.</li></ol><div className="mt-4 rounded-lg bg-white p-3"><p className="text-xs font-semibold text-[#405941]">Manual setup secret</p><div className="mt-2 flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-sm tracking-wider">{enrollment.secret}</code><Button type="button" variant="ghost" size="icon" aria-label="Copy authenticator secret" onClick={() => void copy(enrollment.secret, 'Authenticator secret')}><Copy size={14} /></Button></div><a href={enrollment.otpauthUri} className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-[#45673c] underline underline-offset-2">Open in authenticator app</a></div><form className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={confirmEnrollment}><div className="min-w-0 flex-1"><label htmlFor="security-totp-confirm">6-digit authenticator code</label><input id="security-totp-confirm" className={inputClass} value={totpCode} onChange={event => { setTotpCode(event.target.value); clearMessages(); }} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></div><Button type="submit" className="min-h-12" disabled={!!busy}>{busy === 'confirm-mfa' && <Loader2 size={14} className="animate-spin" />}Confirm setup</Button><Button type="button" variant="ghost" className="min-h-12" onClick={() => { setEnrollment(null); setTotpCode(''); }}>Cancel</Button></form></div>}
        {security.mfa.enabled && <div className="mt-5 flex flex-wrap gap-2"><Button variant="outline" onClick={() => void regenerateCodes()} disabled={!!busy}>{busy === 'recovery' && <Loader2 size={14} className="animate-spin" />}Replace recovery codes</Button><Button variant="destructive" onClick={() => void disableMfa()} disabled={!!busy}>{busy === 'disable-mfa' && <Loader2 size={14} className="animate-spin" />}Turn off</Button></div>}
        {recoveryCodes.length > 0 && <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 className="font-semibold text-amber-950">Save these recovery codes now</h3><p className="mt-1 text-xs leading-relaxed text-amber-900">Each code works once. Store them outside Courtly; they will not be shown again.</p><ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-amber-950">{recoveryCodes.map(code => <li key={code} className="rounded-md bg-white/70 px-2 py-1">{code}</li>)}</ul><Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => void copy(recoveryCodes.join('\n'), 'Recovery codes')}><Copy size={13} />Copy all codes</Button></div>}
      </section>

      <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="security-sessions-heading"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><Laptop size={19} className="mt-0.5 shrink-0 text-[#66805a]" /><div><h2 id="security-sessions-heading" className="text-base text-[#405941]">Active sessions</h2><p className="mt-1 text-xs leading-relaxed text-[#59675c]">Review browsers and devices where your account is signed in.</p></div></div>{security.sessions.some(session => !session.current) && <Button variant="outline" size="sm" onClick={() => void revokeOthers()} disabled={!!busy}>{busy === 'other-sessions' && <Loader2 size={13} className="animate-spin" />}Sign out others</Button>}</div><ul className="mt-5 divide-y divide-[#edf0e8]">{security.sessions.map(session => <li key={session.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf2e7] text-[#66805a]">{session.current ? <Smartphone size={17} /> : <Laptop size={17} />}</span><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-[#344b39]">{sessionName(session)} {session.current && <span className="ml-1 rounded-full bg-[#edf5e4] px-2 py-0.5 text-[10px] text-[#4f6847]">This device</span>}</p><p className="mt-1 text-xs text-[#59675c]">Last active {formatMoment(session.lastSeenAt)}{session.ipAddress ? ` · ${session.ipAddress}` : ''}</p><p className="mt-1 text-[10px] text-[#59675c]">Signed in {formatMoment(session.createdAt)} · Expires {formatMoment(session.expiresAt)}</p></div><Button type="button" variant={session.current ? 'outline' : 'destructive'} size="sm" onClick={() => void revokeSession(session)} disabled={!!busy}>{busy === `session:${session.id}` ? <Loader2 size={13} className="animate-spin" /> : session.current ? <LogOut size={13} /> : <Trash2 size={13} />}{session.current ? 'Sign out' : 'Revoke'}</Button></li>)}</ul>{!security.sessions.length && <p role="status" className="mt-5 rounded-xl bg-[#f7f9f4] p-4 text-sm text-[#59675c]">No active sessions were returned.</p>}</section>

      <section className="rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6" aria-labelledby="security-password-heading"><div className="flex items-start gap-3"><LockKeyhole size={19} className="mt-0.5 shrink-0 text-[#66805a]" /><div><h2 id="security-password-heading" className="text-base text-[#405941]">Password</h2><p className="mt-1 text-xs leading-relaxed text-[#59675c]">Use the secure reset flow if you need a new password. Resetting it signs out existing sessions.</p></div></div><Button asChild variant="outline" className="mt-5"><Link href="/forgot-password">Reset password</Link></Button></section>
    </div> : null}</section></div>

    <Dialog open={!!pendingAction} onOpenChange={open => { if (!open && busy !== 'reauth') { setPendingAction(null); setReauthPassword(''); setReauthCode(''); setReauthError(''); } }}><DialogContent><DialogTitle className="text-xl font-semibold text-[#294735]">Confirm it’s you</DialogTitle><DialogDescription className="mt-2 text-sm leading-relaxed text-[#59675c]">Re-enter your credentials to {pendingAction?.label}. This extra check protects sensitive account changes.</DialogDescription><form className="mt-6 space-y-4" onSubmit={submitReauth}><div><label htmlFor="recent-auth-password">Current password</label><input id="recent-auth-password" type="password" autoComplete="current-password" className={inputClass} value={reauthPassword} onChange={event => { setReauthPassword(event.target.value); setReauthError(''); }} required autoFocus disabled={busy === 'reauth'} /></div>{security?.mfa.enabled && <><fieldset><legend className="mb-2 text-sm font-semibold text-[#4d5e51]">Second step</legend><div className="grid grid-cols-2 gap-2">{(['TOTP', 'RECOVERY_CODE'] as MfaMethod[]).map(method => <label key={method} className={`!mb-0 flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-xs ${reauthMethod === method ? 'border-[#66865b] bg-[#edf3e6]' : 'border-[#dfe5dd]'}`}><input type="radio" name="recent-auth-method" checked={reauthMethod === method} onChange={() => { setReauthMethod(method); setReauthCode(''); }} />{method === 'TOTP' ? 'Authenticator' : 'Recovery code'}</label>)}</div></fieldset><div><label htmlFor="recent-auth-code">{reauthMethod === 'TOTP' ? '6-digit authenticator code' : 'Recovery code'}</label><input id="recent-auth-code" className={inputClass} value={reauthCode} onChange={event => { setReauthCode(event.target.value); setReauthError(''); }} autoComplete="one-time-code" inputMode={reauthMethod === 'TOTP' ? 'numeric' : 'text'} pattern={reauthMethod === 'TOTP' ? '[0-9]{6}' : undefined} maxLength={reauthMethod === 'TOTP' ? 6 : 100} required disabled={busy === 'reauth'} /></div></>}{reauthError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{reauthError}</p>}<Button type="submit" className="w-full" disabled={busy === 'reauth'}>{busy === 'reauth' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Confirm and continue</Button></form></DialogContent></Dialog>
  </main>;
}
