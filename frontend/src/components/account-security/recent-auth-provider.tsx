'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ApiError, loadAccountSecurity, reauthenticateAccount } from '@/lib/api';
import { registerRecentAuthHandler } from '@/lib/recent-auth-coordinator';
import type { MfaMethod } from '@/lib/types';

const inputClass = '!min-h-12 !rounded-xl !border-[#dfe5dd] !px-3.5 !text-base';
type PendingPrompt = { resolve: () => void; reject: (reason: Error) => void };

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

export function RecentAuthProvider({ children }: { children: ReactNode }) {
  const pending = useRef<PendingPrompt | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [method, setMethod] = useState<MfaMethod>('TOTP');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const clear = useCallback(() => {
    setOpen(false); setLoading(false); setSubmitting(false); setMfaEnabled(null);
    setPassword(''); setMethod('TOTP'); setCode(''); setError('');
  }, []);

  const cancel = useCallback(() => {
    generation.current += 1;
    const active = pending.current;
    pending.current = null;
    clear();
    active?.reject(new ApiError('Identity confirmation was cancelled.', 428, { code: 'RECENT_AUTH_CANCELLED' }));
  }, [clear]);

  const prompt = useCallback(() => new Promise<void>((resolve, reject) => {
    if (pending.current) {
      reject(new Error('An identity confirmation prompt is already active.'));
      return;
    }
    const currentGeneration = generation.current + 1;
    generation.current = currentGeneration;
    pending.current = { resolve, reject };
    setOpen(true); setLoading(true); setMfaEnabled(null); setError(''); setPassword(''); setCode('');
    void loadAccountSecurity()
      .then(security => { if (mounted.current && generation.current === currentGeneration) setMfaEnabled(security.mfa.enabled); })
      .catch(cause => { if (mounted.current && generation.current === currentGeneration) setError(message(cause, 'Unable to load your security settings.')); })
      .finally(() => { if (mounted.current && generation.current === currentGeneration) setLoading(false); });
  }), []);

  useEffect(() => {
    mounted.current = true;
    const unregister = registerRecentAuthHandler(prompt);
    return () => {
      mounted.current = false;
      unregister();
      const active = pending.current;
      pending.current = null;
      active?.reject(new Error('Identity confirmation is no longer available.'));
    };
  }, [prompt]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending.current || submitting || mfaEnabled === null) return;
    const compactCode = code.replace(/\s/g, '');
    if (!password) { setError('Enter your current password.'); return; }
    if (mfaEnabled && method === 'TOTP' && !/^\d{6}$/.test(compactCode)) {
      setError('Enter the 6-digit code from your authenticator app.'); return;
    }
    if (mfaEnabled && method === 'RECOVERY_CODE' && !code.trim()) {
      setError('Enter one of your recovery codes.'); return;
    }
    setSubmitting(true); setError('');
    try {
      await reauthenticateAccount({
        password,
        ...(mfaEnabled ? { method, code: method === 'TOTP' ? compactCode : code.trim() } : {}),
      });
      const active = pending.current;
      pending.current = null;
      clear();
      active?.resolve();
    } catch (cause) {
      setError(message(cause, 'Courtly could not confirm your identity.'));
      setSubmitting(false);
    }
  }

  return <>{children}<Dialog open={open} onOpenChange={next => { if (!next && !submitting) cancel(); }}><DialogContent><DialogTitle className="text-xl font-semibold text-[#294735]">Confirm it’s you</DialogTitle><DialogDescription className="mt-2 text-sm leading-relaxed text-[#59675c]">Re-enter your credentials to continue this sensitive action. Courtly will retry it once after the check succeeds.</DialogDescription>{loading ? <div role="status" className="mt-6 flex min-h-24 items-center justify-center gap-2 text-sm text-[#59675c]"><Loader2 size={16} className="animate-spin" />Loading security settings…</div> : <form className="mt-6 space-y-4" onSubmit={submit}><div><label htmlFor="global-recent-auth-password">Current password</label><input id="global-recent-auth-password" type="password" autoComplete="current-password" className={inputClass} value={password} onChange={event => { setPassword(event.target.value); setError(''); }} required autoFocus disabled={submitting} /></div>{mfaEnabled && <><fieldset><legend className="mb-2 text-sm font-semibold text-[#4d5e51]">Second step</legend><div className="grid grid-cols-2 gap-2">{(['TOTP', 'RECOVERY_CODE'] as MfaMethod[]).map(value => <label key={value} className={`!mb-0 flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 text-xs ${method === value ? 'border-[#66865b] bg-[#edf3e6]' : 'border-[#dfe5dd]'}`}><input type="radio" name="global-recent-auth-method" checked={method === value} onChange={() => { setMethod(value); setCode(''); setError(''); }} />{value === 'TOTP' ? 'Authenticator' : 'Recovery code'}</label>)}</div></fieldset><div><label htmlFor="global-recent-auth-code">{method === 'TOTP' ? '6-digit authenticator code' : 'Recovery code'}</label><input id="global-recent-auth-code" className={inputClass} value={code} onChange={event => { setCode(event.target.value); setError(''); }} autoComplete="one-time-code" inputMode={method === 'TOTP' ? 'numeric' : 'text'} pattern={method === 'TOTP' ? '[0-9]{6}' : undefined} maxLength={method === 'TOTP' ? 6 : 100} required disabled={submitting} /></div></>}{error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}<Button type="submit" className="w-full" disabled={submitting || mfaEnabled === null}>{submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}Confirm and continue</Button></form>}</DialogContent></Dialog></>;
}
