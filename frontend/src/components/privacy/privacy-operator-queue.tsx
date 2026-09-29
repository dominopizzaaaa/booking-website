'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { CheckCircle2, Clock3, FileKey2, LoaderCircle, RefreshCw } from 'lucide-react';
import { loadAdminPrivacyRequestEvents, loadAdminPrivacyRequests, updateAdminPrivacyRequest } from '@/lib/api';
import type { AdminPrivacyRequest, PrivacyOperatorStatus, PrivacyRequestDecision, PrivacyRequestEvent, PrivacyRequestStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const activeStatuses = ['RECEIVED', 'IDENTITY_VERIFICATION', 'IN_REVIEW', 'WAITING_FOR_SUBJECT'] as const;
const transitions: Partial<Record<PrivacyRequestStatus, PrivacyRequestStatus[]>> = {
  RECEIVED: ['RECEIVED', 'IDENTITY_VERIFICATION', 'IN_REVIEW'],
  IDENTITY_VERIFICATION: ['IDENTITY_VERIFICATION', 'IN_REVIEW', 'WAITING_FOR_SUBJECT', 'REFUSED'],
  IN_REVIEW: ['IN_REVIEW', 'WAITING_FOR_SUBJECT', 'COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED'],
  WAITING_FOR_SUBJECT: ['WAITING_FOR_SUBJECT', 'IDENTITY_VERIFICATION', 'IN_REVIEW', 'REFUSED'],
};
const statusLabel = (value: string) => value.toLowerCase().replaceAll('_', ' ').replace(/^./u, first => first.toUpperCase());
const terminalDecision: Partial<Record<PrivacyRequestStatus, PrivacyRequestDecision>> = {
  COMPLETED: 'FULFILLED', PARTIALLY_COMPLETED: 'PARTIALLY_FULFILLED', REFUSED: 'REFUSED',
};
const dateTime = (value: string | null) => value
  ? new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Not recorded';

export function PrivacyOperatorQueue() {
  const [requests, setRequests] = useState<AdminPrivacyRequest[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | PrivacyRequestStatus>('ACTIVE');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [events, setEvents] = useState<PrivacyRequestEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const requestGeneration = useRef(0);
  const eventGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true); setError('');
    try {
      const result = await loadAdminPrivacyRequests({
        status: statusFilter,
        ...(overdueOnly ? { overdue: true } : {}), limit: 200,
      });
      if (generation !== requestGeneration.current) return;
      const next = result.requests;
      setRequests(next);
      setNextCursor(result.nextCursor);
      setSelectedId(current => next.some(item => item.id === current) ? current : next[0]?.id ?? null);
    } catch (cause) { if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : 'Privacy cases could not be loaded.'); }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  }, [overdueOnly, statusFilter]);

  async function loadMore() {
    if (!nextCursor || loading) return;
    const generation = requestGeneration.current;
    const cursor = nextCursor;
    setLoading(true); setError('');
    try {
      const result = await loadAdminPrivacyRequests({
        status: statusFilter, ...(overdueOnly ? { overdue: true } : {}), limit: 200, cursor,
      });
      if (generation !== requestGeneration.current) return;
      setRequests(current => [...current, ...result.requests]);
      setNextCursor(result.nextCursor);
    } catch (cause) { if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : 'More privacy cases could not be loaded.'); }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  }

  useEffect(() => { void refresh(); }, [refresh]);
  const selected = requests.find(item => item.id === selectedId) ?? null;
  const terminalFilter = statusFilter !== 'ACTIVE' && !activeStatuses.includes(statusFilter as typeof activeStatuses[number]);

  useEffect(() => {
    const generation = ++eventGeneration.current;
    setEvents([]); setEventCursor(null);
    if (!selectedId) { setEventsLoading(false); return; }
    setEventsLoading(true);
    void loadAdminPrivacyRequestEvents(selectedId, { limit: 100 }).then(result => {
      if (generation !== eventGeneration.current) return;
      setEvents(result.events); setEventCursor(result.nextCursor);
    }).catch(cause => {
      if (generation === eventGeneration.current) setError(cause instanceof Error ? cause.message : 'Case history could not be loaded.');
    }).finally(() => { if (generation === eventGeneration.current) setEventsLoading(false); });
  }, [selectedId]);

  async function loadMoreEvents() {
    if (!selectedId || !eventCursor || eventsLoading) return;
    const generation = eventGeneration.current;
    const requestId = selectedId;
    const cursor = eventCursor;
    setEventsLoading(true);
    try {
      const result = await loadAdminPrivacyRequestEvents(requestId, { limit: 100, cursor });
      if (generation !== eventGeneration.current || requestId !== selectedId) return;
      setEvents(current => [...current, ...result.events]); setEventCursor(result.nextCursor);
    } catch (cause) {
      if (generation === eventGeneration.current) setError(cause instanceof Error ? cause.message : 'More case history could not be loaded.');
    } finally { if (generation === eventGeneration.current) setEventsLoading(false); }
  }

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || saving) return;
    const form = new FormData(event.currentTarget);
    const status = String(form.get('status')) as PrivacyOperatorStatus;
    const decision = terminalDecision[status];
    const delayed = form.get('recordDelay') === 'on';
    const legalHold = form.get('legalHold') === 'on';
    const delayReason = String(form.get('delayReason') || '').trim();
    const estimated = String(form.get('estimatedResponseAt') || '').trim();
    const decisionReason = String(form.get('decisionReason') || '').trim();
    const note = String(form.get('note') || '').trim();
    const externalAuditReference = String(form.get('externalAuditReference') || '').trim();
    if (delayed && (!delayReason || !estimated)) {
      setError('Provide both the delay reason and the new estimated response time.');
      return;
    }
    if (legalHold && !String(form.get('legalHoldReason') || '').trim()) {
      setError('Provide the specific legal-hold reason and review criteria.');
      return;
    }
    if (decision && !decisionReason) {
      setError('Provide the decision reason before closing the privacy case.');
      return;
    }
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await updateAdminPrivacyRequest(selected.id, {
        status, note, externalAuditReference,
        ...(form.get('identityVerified') === 'on' ? { identityVerified: true } : {}),
        ...(delayed ? { delayReason, estimatedResponseAt: new Date(estimated).toISOString() } : {}),
        legalHold, ...(legalHold ? { legalHoldReason: String(form.get('legalHoldReason') || '').trim() } : {}),
        ...(decision ? { decision, decisionReason } : {}),
      });
      setRequests(current => current.map(item => item.id === selected.id
        ? { ...item, ...result.request, subject: item.subject, legalHold: result.request.legalHold ?? false, legalHoldReason: result.request.legalHoldReason ?? null }
        : item));
      setNotice('The privacy case and its audit history were updated.');
      if (statusFilter === 'ACTIVE' && !activeStatuses.includes(status as typeof activeStatuses[number])) await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The privacy case could not be updated.'); }
    finally { setSaving(false); }
  }

  return <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.8fr)_minmax(420px,1.2fr)]">
    <section className="rounded-2xl border border-[#e6eae3] bg-white p-4" aria-labelledby="privacy-case-list-heading">
      <div className="flex items-start justify-between gap-3"><div><h2 id="privacy-case-list-heading" className="text-base font-semibold">Privacy cases</h2><p className="mt-1 text-xs text-[#59675c]">Reviewed data-subject requests; nearest deadlines first.</p></div><button type="button" aria-label="Refresh privacy cases" onClick={() => void refresh()} disabled={loading} className="grid h-10 w-10 place-items-center rounded-lg border border-[#dce4d4] text-[#5b6c53]"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /></button></div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2"><label className="text-[11px] font-semibold text-[#59675c]">Status<select className="mt-1 min-h-10 w-full rounded-lg border border-[#dfe5dd] bg-white px-2 text-xs" value={statusFilter} onChange={event => { requestGeneration.current += 1; const next = event.target.value as typeof statusFilter; setStatusFilter(next); if (next !== 'ACTIVE' && !activeStatuses.includes(next as typeof activeStatuses[number])) setOverdueOnly(false); }}><option value="ACTIVE">Active</option>{(['RECEIVED', 'IDENTITY_VERIFICATION', 'IN_REVIEW', 'WAITING_FOR_SUBJECT', 'COMPLETED', 'PARTIALLY_COMPLETED', 'REFUSED', 'CANCELLED'] as PrivacyRequestStatus[]).map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label><label className={cn('flex min-h-10 items-center gap-2 self-end rounded-lg bg-[#f7f9f4] px-3 text-xs text-[#4d5e51]', terminalFilter && 'opacity-50')}><input type="checkbox" checked={overdueOnly} disabled={terminalFilter} onChange={event => { requestGeneration.current += 1; setOverdueOnly(event.target.checked); }} />Overdue only</label></div>
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>}
      {loading ? <p role="status" className="mt-5 flex items-center gap-2 text-xs text-[#59675c]"><LoaderCircle size={14} className="animate-spin" />Loading cases…</p>
        : requests.length === 0 ? <p className="mt-5 rounded-xl bg-[#f7f9f4] p-4 text-xs text-[#59675c]">No cases match this view.</p>
          : <><ul className="mt-4 space-y-2">{requests.map(item => <li key={item.id}><button type="button" aria-pressed={selectedId === item.id} onClick={() => { eventGeneration.current += 1; setEvents([]); setEventCursor(null); setSelectedId(item.id); setNotice(''); setError(''); }} className={cn('w-full rounded-xl border p-3 text-left transition', selectedId === item.id ? 'border-[#adc3a2] bg-[#f2f6ee]' : 'border-[#e4e9df] hover:bg-[#fafbf8]')}><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-[#344b39]">{statusLabel(item.type)}</span>{item.overdue && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[9px] font-semibold text-red-700">Overdue</span>}</div><p className="mt-1 truncate text-xs text-[#59675c]">{item.subject.name} · @{item.subject.username}</p><p className="mt-1 text-[10px] text-[#59675c]">{statusLabel(item.status)} · due {dateTime(item.estimatedResponseAt ?? item.responseDueAt)}</p></button></li>)}</ul>{nextCursor && <button type="button" className="mt-3 min-h-10 w-full rounded-lg border border-[#dce4d4] text-xs font-semibold text-[#52704d]" disabled={loading} onClick={() => void loadMore()}>Load more cases</button>}</>}
    </section>

    <section className="rounded-2xl border border-[#e6eae3] bg-white p-5" aria-labelledby="privacy-case-detail-heading">
      {!selected ? <div className="grid min-h-64 place-items-center text-center text-[#59675c]"><div><FileKey2 className="mx-auto" size={24} /><p className="mt-3 text-sm">Choose a privacy case to review.</p></div></div> : <>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-[#59675c]">{statusLabel(selected.type)}</p><h2 id="privacy-case-detail-heading" className="mt-1 text-lg font-semibold text-[#26382f]">{selected.subject.name}</h2><p className="mt-1 text-xs text-[#59675c]">@{selected.subject.username} · {selected.subject.email ?? 'No email'} · submitted {dateTime(selected.submittedAt)}</p></div><span className={cn('rounded-full px-2.5 py-1 text-[10px] font-semibold', selected.overdue ? 'bg-red-50 text-red-700' : 'bg-[#edf3e7] text-[#4f6847]')}>{statusLabel(selected.status)}</span></div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-xl bg-[#f7f9f4] p-3"><dt className="text-[10px] uppercase tracking-wide text-[#59675c]">Target response</dt><dd className="mt-1 text-xs font-semibold text-[#344b39]">{dateTime(selected.estimatedResponseAt ?? selected.responseDueAt)}</dd></div><div className="rounded-xl bg-[#f7f9f4] p-3"><dt className="text-[10px] uppercase tracking-wide text-[#59675c]">Identity</dt><dd className="mt-1 text-xs font-semibold text-[#344b39]">{selected.identityVerifiedAt ? ['Verified', dateTime(selected.identityVerifiedAt)].join(' ') : 'Not recorded as verified'}</dd></div></dl>
        <div className="mt-4 rounded-xl border border-[#e4e9df] p-4"><h3 className="text-xs font-semibold text-[#405941]">Subject details</h3><p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-[#4d5e51]">{selected.details || 'No additional details supplied.'}</p>{selected.correctionFields && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-[#f7f9f4] p-3 text-[11px] text-[#4d5e51]">{JSON.stringify(selected.correctionFields, null, 2)}</pre>}</div>
        {selected.delayReason && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">Recorded delay: {selected.delayReason}</p>}
        {selected.decisionReason && <p className="mt-4 rounded-xl bg-[#edf5e4] p-3 text-xs text-[#4f6847]">Decision: {selected.decisionReason}</p>}
        <section className="mt-4 rounded-xl border border-[#e4e9df] p-4" aria-label="Case audit history"><h3 className="text-xs font-semibold text-[#405941]">Audit history</h3>{eventsLoading && events.length === 0 ? <p className="mt-3 text-xs text-[#59675c]">Loading history…</p> : events.length === 0 ? <p className="mt-3 text-xs text-[#59675c]">No history is available.</p> : <ul className="mt-3 space-y-3">{events.map(item => <li key={item.id} className="border-t border-[#edf0e8] pt-3 first:border-0 first:pt-0"><p className="text-xs font-semibold text-[#344b39]">{statusLabel(item.action)} · {dateTime(item.createdAt)}</p><p className="mt-1 text-[11px] text-[#59675c]">{item.actorNameSnapshot || statusLabel(item.actorKind)}{item.actorEmailSnapshot ? ` · ${item.actorEmailSnapshot}` : ''}</p>{item.note && <p className="mt-1 whitespace-pre-wrap text-xs text-[#4d5e51]">{item.note}</p>}{item.metadata?.externalAuditReference && <p className="mt-1 text-[11px] text-[#59675c]">Reference: {item.metadata.externalAuditReference}</p>}</li>)}</ul>}{eventCursor && <button type="button" className="mt-3 min-h-10 rounded-lg border border-[#dce4d4] px-3 text-xs font-semibold text-[#52704d]" disabled={eventsLoading} onClick={() => void loadMoreEvents()}>Load earlier history</button>}</section>
        {transitions[selected.status] ? <form key={selected.id + selected.updatedAt} className="mt-5 space-y-4 border-t border-[#edf0e8] pt-5" onSubmit={update}>
          <div className="grid gap-4 sm:grid-cols-2"><label className="text-xs font-semibold text-[#405941]">Next status<select name="status" className="mt-1.5 min-h-11 w-full rounded-xl border border-[#dfe5dd] bg-white px-3 text-sm" defaultValue={selected.status} disabled={saving}>{transitions[selected.status]!.map(value => <option key={value} value={value}>{statusLabel(value)}</option>)}</select></label><label className="flex items-center gap-2 self-end rounded-xl bg-[#f7f9f4] p-3 text-xs text-[#4d5e51]"><input name="identityVerified" type="checkbox" defaultChecked={Boolean(selected.identityVerifiedAt)} disabled={saving || Boolean(selected.identityVerifiedAt)} />Identity verified</label></div>
          <label className="block text-xs font-semibold text-[#405941]">Operator note<textarea name="note" className="mt-1.5 min-h-20 w-full rounded-xl border border-[#dfe5dd] px-3 py-2 text-sm" maxLength={4000} required disabled={saving} placeholder="Record the review action and evidence location without copying unnecessary personal data." /></label>
          <label className="block text-xs font-semibold text-[#405941]">External audit reference<input name="externalAuditReference" className="mt-1.5 min-h-11 w-full rounded-xl border border-[#dfe5dd] px-3 text-sm" maxLength={200} required disabled={saving} placeholder="Named operator log, ticket, or controlled case reference" /><span className="mt-1 block font-normal text-[#59675c]">Your named operator identity is recorded automatically. Link the action to its controlled case or evidence record.</span></label>
          <details className="rounded-xl border border-[#e4e9df] p-3"><summary className="cursor-pointer text-xs font-semibold text-[#405941]">Timing and legal hold</summary><div className="mt-3 space-y-3"><label className="flex items-center gap-2 text-xs"><input name="recordDelay" type="checkbox" />Record a written delay notice</label><input name="delayReason" className="min-h-10 w-full rounded-lg border border-[#dfe5dd] px-3 text-xs" maxLength={2000} placeholder="Delay reason" /><input name="estimatedResponseAt" type="datetime-local" className="min-h-10 w-full rounded-lg border border-[#dfe5dd] px-3 text-xs" /><label className="flex items-center gap-2 text-xs"><input name="legalHold" type="checkbox" defaultChecked={selected.legalHold} />Apply a specific legal hold</label><input name="legalHoldReason" className="min-h-10 w-full rounded-lg border border-[#dfe5dd] px-3 text-xs" maxLength={2000} defaultValue={selected.legalHoldReason ?? ''} placeholder="Hold ground, scope, owner, review date, and release criteria" /></div></details>
          <label className="block text-xs font-semibold text-[#405941]">Decision reason <span className="font-normal text-[#59675c]">(required only when closing)</span><textarea name="decisionReason" className="mt-1.5 min-h-20 w-full rounded-xl border border-[#dfe5dd] px-3 py-2 text-sm" maxLength={4000} disabled={saving} /></label>
          <button type="submit" disabled={saving} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#174c3c] px-4 text-xs font-semibold text-white disabled:opacity-60">{saving ? <LoaderCircle size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}Record case update</button>
        </form> : <p className="mt-5 flex items-center gap-2 border-t border-[#edf0e8] pt-5 text-xs text-[#59675c]"><Clock3 size={14} />This case is closed and immutable.</p>}
        {notice && <p role="status" className="mt-4 rounded-xl bg-[#edf5e4] p-3 text-xs text-[#4f6847]">{notice}</p>}
      </>}
    </section>
  </div>;
}
