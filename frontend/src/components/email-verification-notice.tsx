'use client';

import { useState } from 'react';
import { Loader2, MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { resendAccountEmailVerification } from '@/lib/api';

export function EmailVerificationNotice({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function resend() {
    if (busy) return;
    setBusy(true); setNotice(''); setError('');
    try {
      const result = await resendAccountEmailVerification();
      setNotice(result.alreadyVerified
        ? 'This email is already verified. Refresh the page to update its status.'
        : 'A new verification email has been queued. Use only the newest link.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A verification email could not be requested.');
    } finally { setBusy(false); }
  }

  return <section aria-labelledby="email-verification-heading" className="rounded-2xl border border-[#e7ddc8] bg-[#fffaf0] p-5">
    <div className="flex items-start gap-3"><MailCheck size={19} className="mt-0.5 shrink-0 text-[#806b3f]" /><div className="min-w-0 flex-1"><h2 id="email-verification-heading" className="text-sm font-semibold text-[#584c32]">Verify your email</h2><p className="mt-1 break-words text-xs leading-relaxed text-[#756345]">Confirm {email ?? 'your sign-in email'} before using privacy-sensitive features such as Family and privacy requests.</p></div></div>
    <Button type="button" variant="outline" className="mt-4" disabled={busy || !email} onClick={() => void resend()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <MailCheck size={14} />}Send verification email</Button>
    {notice && <p role="status" className="mt-3 text-xs leading-relaxed text-[#4f6847]">{notice}</p>}
    {error && <p role="alert" className="mt-3 text-xs leading-relaxed text-[#8a4937]">{error}</p>}
  </section>;
}
