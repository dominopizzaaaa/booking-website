'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, FileKey2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cancelPrivacyRequest, createPrivacyRequest, loadPrivacyRequests } from '@/lib/api';
import type { PrivacyRequest, PrivacyRequestType } from '@/lib/types';
import { cn } from '@/lib/utils';

const activeStatuses = new Set(['RECEIVED', 'IDENTITY_VERIFICATION', 'IN_REVIEW', 'WAITING_FOR_SUBJECT']);
const requestLabels: Record<PrivacyRequestType, string> = {
  ACCESS: 'Access my data',
  CORRECTION: 'Correct my data',
  DELETION: 'Delete data that is no longer needed',
  CONSENT_WITHDRAWAL: 'Withdraw consent',
  RESTRICTION: 'Restrict a use of my data',
  OBJECTION: 'Object to a use of my data',
};
const statusLabels: Record<PrivacyRequest['status'], string> = {
  RECEIVED: 'Received', IDENTITY_VERIFICATION: 'Identity verification', IN_REVIEW: 'In review',
  WAITING_FOR_SUBJECT: 'Waiting for you', COMPLETED: 'Completed', PARTIALLY_COMPLETED: 'Partially completed',
  REFUSED: 'Refused', CANCELLED: 'Cancelled',
};

function dateLabel(value: string) {
  return new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium' }).format(new Date(value));
}

export function PrivacyRequestsPanel({ emailVerified, className }: { emailVerified?: boolean; className?: string }) {
  const [requests, setRequests] = useState<PrivacyRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [type, setType] = useState<PrivacyRequestType>('ACCESS');
  const [details, setDetails] = useState('');
  const [correction, setCorrection] = useState('');
  const [consequencesAccepted, setConsequencesAccepted] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { const result = await loadPrivacyRequests(); setRequests(result.requests); setNextCursor(result.nextCursor); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Privacy requests could not be loaded.'); }
    finally { setLoading(false); }
  }, []);

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true); setError('');
    try {
      const result = await loadPrivacyRequests({ cursor: nextCursor });
      setRequests(current => [...current, ...result.requests]);
      setNextCursor(result.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'More privacy requests could not be loaded.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || emailVerified === false) return;
    setSubmitting(true); setError(''); setNotice('');
    try {
      const result = await createPrivacyRequest({
        type, details: details.trim(),
        ...(type === 'CORRECTION' ? { correctionFields: { requestedCorrection: correction.trim() } } : {}),
        ...(type === 'CONSENT_WITHDRAWAL' ? { acknowledgeConsequences: true as const } : {}),
      });
      setRequests(current => [result.request, ...current]);
      setDetails(''); setCorrection(''); setConsequencesAccepted(false);
      setNotice('Your request has been recorded. You can track it below.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your privacy request could not be submitted.');
    } finally { setSubmitting(false); }
  }

  async function cancel(item: PrivacyRequest) {
    if (cancellingId || !window.confirm('Cancel this privacy request? You can submit a new request later.')) return;
    setCancellingId(item.id); setError(''); setNotice('');
    try {
      const result = await cancelPrivacyRequest(item.id);
      setRequests(current => current.map(request => request.id === item.id ? result.request : request));
      setNotice('The request was cancelled.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The request could not be cancelled.'); }
    finally { setCancellingId(null); }
  }

  const correctionMissing = type === 'CORRECTION' && !correction.trim();
  const withdrawalUnacknowledged = type === 'CONSENT_WITHDRAWAL' && !consequencesAccepted;

  return <section className={cn('rounded-2xl border border-[#e2e7dd] bg-white p-5 shadow-sm sm:p-6', className)} aria-labelledby="privacy-requests-heading">
    <div className="flex items-start gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#edf3e7] text-[#4f6847]"><FileKey2 size={18} /></span>
      <div className="min-w-0 flex-1"><h2 id="privacy-requests-heading" className="text-sm font-semibold text-[#3f4c42]">Privacy requests</h2><p className="mt-1 text-xs leading-relaxed text-[#59675c]">Track requests about your personal data or start a new one.</p></div>
    </div>

    {emailVerified === false ? <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">Verify your sign-in email before submitting a request. Existing requests remain visible.</p>
      : <details className="group mt-5 rounded-xl border border-[#dfe7d8] bg-[#f7f9f4] open:bg-white">
        <summary className="min-h-12 cursor-pointer px-4 py-3 text-sm font-semibold text-[#405941] marker:text-[#6f865f]">Start a privacy request</summary>
        <form className="space-y-4 border-t border-[#e4e9df] p-4" onSubmit={submit}>
        <p className="text-xs leading-relaxed text-[#59675c]">Requests are reviewed. Submitting one does not automatically erase records or override required retention.</p>
        <div><label htmlFor="privacy-request-type" className="text-xs font-semibold text-[#405941]">Request type</label><select id="privacy-request-type" className="mt-1.5 min-h-11 w-full rounded-xl border border-[#dfe5dd] bg-white px-3.5 text-sm" value={type} onChange={event => { setType(event.target.value as PrivacyRequestType); setError(''); setNotice(''); }} disabled={submitting}>{Object.entries(requestLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div><label htmlFor="privacy-request-details" className="text-xs font-semibold text-[#405941]">Details <span className="font-normal text-[#59675c]">(do not include passwords, card details, or identity documents)</span></label><textarea id="privacy-request-details" className="mt-1.5 min-h-24 w-full rounded-xl border border-[#dfe5dd] px-3.5 py-3 text-sm" value={details} onChange={event => setDetails(event.target.value)} maxLength={4000} placeholder="Describe the account, records, purpose, or time period involved." disabled={submitting} /></div>
        {type === 'CORRECTION' && <div><label htmlFor="privacy-request-correction" className="text-xs font-semibold text-[#405941]">What should be corrected?</label><textarea id="privacy-request-correction" className="mt-1.5 min-h-20 w-full rounded-xl border border-[#dfe5dd] px-3.5 py-3 text-sm" value={correction} onChange={event => setCorrection(event.target.value)} maxLength={2000} required disabled={submitting} /></div>}
        {type === 'CONSENT_WITHDRAWAL' && <label className="flex items-start gap-2 rounded-xl bg-[#f7f9f4] p-3 text-xs leading-relaxed text-[#4d5e51]"><input className="mt-0.5" type="checkbox" checked={consequencesAccepted} onChange={event => setConsequencesAccepted(event.target.checked)} required disabled={submitting} /><span>I understand that withdrawing consent may limit or end affected Courtly features, while prior processing and records subject to a valid retention requirement may remain.</span></label>}
        <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={submitting || correctionMissing || withdrawalUnacknowledged}>{submitting ? <Loader2 size={14} className="animate-spin" /> : <FileKey2 size={14} />}Submit privacy request</Button><Link href="/legal/privacy" className="text-xs font-semibold text-[#52704d] underline underline-offset-2">Read the Privacy Notice</Link></div>
        </form>
      </details>}

    {notice && <p role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-[#edf5e4] p-3 text-xs text-[#4f6847]"><CheckCircle2 size={15} className="mt-0.5 shrink-0" />{notice}</p>}
    {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>}

    <div className="mt-6 border-t border-[#edf0e8] pt-5">
      <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-semibold uppercase tracking-[1.2px] text-[#59675c]">Request history</h3><button type="button" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-[#52704d]" onClick={() => void refresh()} disabled={loading}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />Refresh</button></div>
      {loading ? <p role="status" className="mt-4 flex items-center gap-2 text-xs text-[#59675c]"><Loader2 size={14} className="animate-spin" />Loading privacy requests…</p>
        : requests.length === 0 ? <p className="mt-4 rounded-xl bg-[#f7f9f4] p-4 text-xs text-[#59675c]">You have not submitted a privacy request.</p>
          : <><ul className="mt-3 space-y-3">{requests.map(item => <li key={item.id} className="rounded-xl border border-[#e4e9df] p-4"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-sm font-semibold text-[#344b39]">{requestLabels[item.type]}</p><p className="mt-1 text-[11px] text-[#59675c]">Submitted {dateLabel(item.submittedAt)} · target response by {dateLabel(item.estimatedResponseAt ?? item.responseDueAt)}</p></div><span className={cn('rounded-full px-2.5 py-1 text-[10px] font-semibold', item.overdue ? 'bg-red-50 text-red-700' : activeStatuses.has(item.status) ? 'bg-amber-50 text-amber-800' : 'bg-[#edf3e7] text-[#4f6847]')}>{statusLabels[item.status]}{item.overdue ? ' · overdue' : ''}</span></div>{item.delayReason && <p className="mt-3 rounded-lg bg-[#fffaf0] p-3 text-xs text-[#756345]">Updated timing: {item.delayReason}</p>}{item.decisionReason && <p className="mt-3 text-xs leading-relaxed text-[#4d5e51]">Decision: {item.decisionReason}</p>}{activeStatuses.has(item.status) && <Button type="button" variant="ghost" size="sm" className="mt-3 text-[#8a4937]" disabled={cancellingId !== null} onClick={() => void cancel(item)}>{cancellingId === item.id ? <Loader2 size={13} className="animate-spin" /> : <XCircle size={13} />}Cancel request</Button>}</li>)}</ul>{nextCursor && <Button type="button" variant="outline" size="sm" className="mt-3" disabled={loading} onClick={() => void loadMore()}>Load more</Button>}</>}
    </div>
    <p className="mt-5 text-[11px] leading-relaxed text-[#59675c]">For help or an unauthenticated request, contact <a className="font-semibold underline underline-offset-2" href="mailto:domksj23@gmail.com">domksj23@gmail.com</a>.</p>
  </section>;
}
