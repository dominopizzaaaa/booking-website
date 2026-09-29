'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { AlertTriangle, Flag, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { chatReportCategories } from '@/lib/chat';
import type { ChatMessage, ChatReportCategory, ChatReportInput } from '@/lib/types';

export function ReportMessageDialog({ message, onClose, onSubmit }: {
  message: ChatMessage | null;
  onClose: () => void;
  onSubmit: (input: ChatReportInput) => Promise<void>;
}) {
  const categoryName = useId();
  const detailsId = useId();
  const [category, setCategory] = useState<ChatReportCategory | null>(null);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setCategory(null);
    setDescription('');
    setError('');
    setBusy(false);
  }, [message?.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message || !category || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        category,
        messageId: message.id,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The report could not be sent. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return <Dialog open={message !== null} onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent
      className="max-w-xl"
      aria-busy={busy}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
      onPointerDownOutside={event => { if (busy) event.preventDefault(); }}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#fff0eb] text-[#a64d38]"><Flag size={20} aria-hidden="true" /></div>
      <DialogTitle className="mt-4 text-xl font-semibold tracking-tight text-[#263a30]">Report this message</DialogTitle>
      <DialogDescription className="mt-2 text-sm leading-relaxed text-[#59675c]">
        Tell the authorized safeguarding team what concerns you. Other conversation participants are not told who made the report.
      </DialogDescription>

      <div className="mt-5 rounded-xl border border-[#e5e9e0] bg-[#f7f8f5] p-3">
        <p className="text-[10px] font-semibold uppercase tracking-[1px] text-[#6d796f]">Message included with this report</p>
        <blockquote className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-[#33443b]">“{message?.body}”</blockquote>
        {message && <p className="mt-2 text-[11px] text-[#6d796f]">{message.senderName} · {new Date(message.createdAt).toLocaleString()}</p>}
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-[#eccdbf] bg-[#fff7f3] p-4 text-sm leading-relaxed text-[#7b4134]">
        <AlertTriangle className="mt-0.5 shrink-0" size={18} aria-hidden="true" />
        <p><strong className="font-semibold">If anyone is in immediate danger, do not wait for a report response.</strong> Call Singapore Police at <a className="font-semibold underline" href="tel:999">999</a>. If it is unsafe or not possible to speak, SMS <a className="font-semibold underline" href="sms:70999">70999</a>. For violence or abuse, call NAVH at <a className="font-semibold underline" href="tel:18007770000">1800-777-0000</a>. Courtly reporting is not an emergency response.</p>
      </div>

      <form className="mt-5" onSubmit={submit}>
        <fieldset disabled={busy}>
          <legend id={categoryName} className="text-sm font-semibold text-[#33443b]">What is the concern?</legend>
          <div className="mt-2 grid gap-2" role="radiogroup" aria-labelledby={categoryName}>
            {chatReportCategories.map(option => <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-[#dfe5df] px-3 py-2 text-sm text-[#33443b] has-[:checked]:border-[#547a62] has-[:checked]:bg-[#eff5ed]">
              <input type="radio" name="report-category" value={option.value} checked={category === option.value} onChange={() => setCategory(option.value)} />
              <span>{option.label}</span>
            </label>)}
          </div>
          <label htmlFor={detailsId} className="mt-4 block text-sm font-semibold text-[#33443b]">Details <span className="font-normal text-[#6d796f]">(optional)</span></label>
          <textarea id={detailsId} rows={4} maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} className="mt-2" placeholder="Share only what reviewers need to understand the concern." />
        </fieldset>

        <p className="mt-4 text-xs leading-relaxed text-[#59675c]">The selected message, relevant conversation context, your category, and any details above are sent to authorized reviewers. Courtly does not monitor every message.</p>
        {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-xs leading-relaxed text-red-700">{error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-2 border-t border-[#edf0e8] pt-4 sm:flex-row sm:justify-end">
          <button type="button" disabled={busy} onClick={onClose} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#dfe5df] px-4 text-sm font-semibold text-[#33443b] hover:bg-[#f2f5f1] disabled:opacity-60">Cancel</button>
          <button type="submit" disabled={busy || !category} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#8f4938] px-4 text-sm font-semibold text-white hover:bg-[#793b2e] disabled:opacity-50">
            {busy && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}Send report
          </button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
