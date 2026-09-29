'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, RefreshCw, Search, ShieldAlert, UserRoundCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  applyAdminSafeguardingAccountAction,
  loadAdminSafeguardingReport,
  loadAdminSafeguardingReports,
  loadClubSafeguardingReport,
  loadClubSafeguardingReports,
  updateAdminSafeguardingReport,
  updateClubSafeguardingReport,
} from '@/lib/api';
import {
  chatReportCategoryLabel,
  safeguardingSeverityLabel,
  safeguardingSeverityOrder,
  safeguardingStatusLabel,
  safeguardingStatusOrder,
} from '@/lib/chat';
import type {
  SafeguardingReport,
  SafeguardingReportFilters,
  SafeguardingReportSeverity,
  SafeguardingReportSummary,
  SafeguardingReportStatus,
} from '@/lib/types';
import { cn } from '@/lib/utils';

type QueueMode = 'admin' | 'club';

const severityTone: Record<SafeguardingReportSeverity, string> = {
  CRITICAL: 'border-red-200 bg-red-50 text-red-800',
  HIGH: 'border-orange-200 bg-orange-50 text-orange-800',
  MEDIUM: 'border-amber-200 bg-amber-50 text-amber-800',
  LOW: 'border-stone-200 bg-stone-50 text-stone-700',
};

const statusTone: Record<SafeguardingReportStatus, string> = {
  OPEN: 'bg-red-50 text-red-800',
  IN_REVIEW: 'bg-amber-50 text-amber-800',
  REFERRED_TO_PLATFORM: 'bg-purple-50 text-purple-800',
  ACTION_TAKEN: 'bg-emerald-50 text-emerald-800',
  CLOSED_NO_ACTION: 'bg-stone-100 text-stone-700',
};

const formatTimestamp = (value?: string | null) => value
  ? new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : 'Not recorded';
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'Something went wrong. Please try again.';

export function SafeguardingReportQueue({ mode, canReview = true }: { mode: QueueMode; canReview?: boolean }) {
  const [reports, setReports] = useState<SafeguardingReportSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SafeguardingReport | null>(null);
  const [status, setStatus] = useState<SafeguardingReportStatus | ''>('');
  const [severity, setSeverity] = useState<SafeguardingReportSeverity | ''>('');
  const [searchDraft, setSearchDraft] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');
  const listRequest = useRef(0);
  const detailRequest = useRef(0);

  const listLoader = mode === 'admin' ? loadAdminSafeguardingReports : loadClubSafeguardingReports;
  const detailLoader = mode === 'admin' ? loadAdminSafeguardingReport : loadClubSafeguardingReport;

  const loadFirst = useCallback(async () => {
    const request = ++listRequest.current;
    setLoading(true);
    setError('');
    try {
      const result = await listLoader({ ...(status ? { status } : {}), ...(severity ? { severity } : {}), ...(query ? { q: query } : {}) });
      if (request !== listRequest.current) return;
      setReports(result.reports);
      setNextCursor(result.nextCursor);
      setSelectedId(current => current && result.reports.some(report => report.id === current) ? current : result.reports[0]?.id ?? null);
    } catch (cause) {
      if (request === listRequest.current) setError(errorMessage(cause));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [listLoader, query, severity, status]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const request = ++detailRequest.current;
    setDetail(null);
    setLoadingDetail(true);
    detailLoader(selectedId).then(result => {
      if (request === detailRequest.current) setDetail(result);
    }).catch(cause => {
      if (request === detailRequest.current) toast.error(errorMessage(cause));
    }).finally(() => {
      if (request === detailRequest.current) setLoadingDetail(false);
    });
  }, [detailLoader, selectedId]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const request = ++listRequest.current;
    setLoadingMore(true);
    try {
      const filters: SafeguardingReportFilters = {
        cursor: nextCursor, ...(status ? { status } : {}), ...(severity ? { severity } : {}), ...(query ? { q: query } : {}),
      };
      const result = await listLoader(filters);
      if (request !== listRequest.current) return;
      setReports(current => [...current, ...result.reports.filter(report => !current.some(existing => existing.id === report.id))]);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (request === listRequest.current) toast.error(errorMessage(cause));
    } finally {
      if (request === listRequest.current) setLoadingMore(false);
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(searchDraft.trim());
  }

  const commitReport = (report: SafeguardingReport) => {
    setDetail(report);
    setReports(current => current.map(item => item.id === report.id ? { ...item, ...report } : item));
  };

  return <section aria-labelledby={`${mode}-safeguarding-heading`} className="overflow-hidden rounded-2xl border border-[#e2e7df] bg-white">
    <div className="border-b border-[#e9ece5] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#7c6a55]">{mode === 'admin' ? 'Platform safety' : 'Club safeguarding'}</p>
          <h2 id={`${mode}-safeguarding-heading`} className="mt-1 text-lg font-semibold text-[#294735]">Safety reports</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[#59675c]">Reports appear after someone raises a concern; Courtly does not monitor every message. Treat this queue as confidential.</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void loadFirst()}><RefreshCw size={14} className={cn(loading && 'animate-spin')} />Refresh</Button>
      </div>
      <form onSubmit={search} className="mt-4 grid gap-2 md:grid-cols-[minmax(12rem,1fr)_11rem_10rem_auto]">
        <label className="relative"><span className="sr-only">Search safety reports</span><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#899488]" /><input type="search" value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="Search account or case…" className="min-h-11 pl-9" /></label>
        <select aria-label="Filter safety reports by status" value={status} onChange={event => setStatus(event.target.value as SafeguardingReportStatus | '')} className="min-h-11 text-xs"><option value="">All statuses</option>{safeguardingStatusOrder.map(value => <option key={value} value={value}>{safeguardingStatusLabel(value)}</option>)}</select>
        <select aria-label="Filter safety reports by severity" value={severity} onChange={event => setSeverity(event.target.value as SafeguardingReportSeverity | '')} className="min-h-11 text-xs"><option value="">All severity</option>{safeguardingSeverityOrder.map(value => <option key={value} value={value}>{safeguardingSeverityLabel(value)}</option>)}</select>
        <Button type="submit" variant="outline">Search</Button>
      </form>
    </div>

    {error && <div className="border-b border-red-100 bg-red-50 p-4"><p role="alert" className="text-xs text-red-700">{error}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void loadFirst()}>Try again</Button></div>}

    <div className="grid min-h-[28rem] lg:grid-cols-[minmax(18rem,0.85fr)_minmax(24rem,1.4fr)]">
      <div className="border-b border-[#e9ece5] lg:border-b-0 lg:border-r" aria-busy={loading}>
        {loading && !reports.length ? <p role="status" className="flex items-center justify-center gap-2 p-10 text-xs text-[#59675c]"><Loader2 size={15} className="animate-spin" />Loading reports…</p>
          : reports.length ? <ul className="divide-y divide-[#edf0e8]">{reports.map(report => <li key={report.id}><button type="button" onClick={() => setSelectedId(report.id)} aria-current={selectedId === report.id ? 'true' : undefined} className={cn('flex min-h-24 w-full items-start gap-3 p-4 text-left transition hover:bg-[#f8faf6]', selectedId === report.id && 'bg-[#f0f5eb]')}>
            <span className={cn('mt-0.5 rounded-full border px-2 py-1 text-[9px] font-bold uppercase tracking-wide', severityTone[report.severity])}>{safeguardingSeverityLabel(report.severity)}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-[#294735]">{report.subject.name || `@${report.subject.username}`}</span><span className="mt-1 block text-[11px] leading-relaxed text-[#59675c]">{chatReportCategoryLabel(report.category)}</span><span className="mt-1 block text-[10px] text-[#788079]">{safeguardingStatusLabel(report.status)} · {formatTimestamp(report.createdAt)}</span></span>
            <ChevronRight size={15} className="mt-1 shrink-0 text-[#8d998b]" aria-hidden="true" />
          </button></li>)}</ul>
          : !error && <div className="p-10 text-center"><CheckCircle2 size={24} className="mx-auto text-[#6f8b65]" /><p className="mt-3 text-sm font-semibold text-[#294735]">No matching reports</p><p className="mt-1 text-xs text-[#59675c]">New concerns will appear here after someone submits a report.</p></div>}
        {nextCursor && <div className="border-t border-[#edf0e8] p-3 text-center"><Button type="button" variant="ghost" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore && <Loader2 size={13} className="animate-spin" />}Load more</Button></div>}
      </div>
      <div className="min-w-0">
        {loadingDetail ? <p role="status" className="flex items-center justify-center gap-2 p-10 text-xs text-[#59675c]"><Loader2 size={15} className="animate-spin" />Opening report…</p>
          : detail ? <ReportDetail mode={mode} report={detail} canReview={canReview} onUpdated={commitReport} />
            : <div className="grid min-h-72 place-items-center p-8 text-center text-[#59675c]"><div><ShieldAlert size={25} className="mx-auto" /><p className="mt-3 text-sm">Choose a report to review its case details.</p></div></div>}
      </div>
    </div>
  </section>;
}

function ReportDetail({ mode, report, canReview, onUpdated }: { mode: QueueMode; report: SafeguardingReport; canReview: boolean; onUpdated: (report: SafeguardingReport) => void }) {
  const [status, setStatus] = useState(report.status);
  const [severity, setSeverity] = useState(report.severity);
  const [assignedTo, setAssignedTo] = useState(report.assignedTo ?? '');
  const [assignment, setAssignment] = useState<'' | 'SELF' | 'UNASSIGNED'>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [accountNote, setAccountNote] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);

  useEffect(() => {
    setStatus(report.status); setSeverity(report.severity); setAssignedTo(report.assignedTo ?? '');
    setAssignment(''); setNote(''); setAccountNote('');
  }, [report]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rationale = note.trim();
    if (busy || !canReview || !rationale) return;
    setBusy(true);
    try {
      const adminAssignedTo = assignedTo.trim() || null;
      const updated = mode === 'admin'
        ? await updateAdminSafeguardingReport(report.id, {
          status, severity,
          ...(adminAssignedTo !== report.assignedTo ? { assignedTo: adminAssignedTo } : {}),
          note: rationale,
        })
        : await updateClubSafeguardingReport(report.id, {
          ...(status !== report.status && (status === 'IN_REVIEW' || status === 'REFERRED_TO_PLATFORM') ? { status } : {}),
          severity, ...(assignment ? { assignment } : {}), note: rationale,
        });
      onUpdated(updated);
      toast.success('Safety case updated');
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function runAccountAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode !== 'admin' || !accountNote.trim() || accountBusy) return;
    setAccountBusy(true);
    try {
      const restoring = report.targetSafetyStatus === 'ACCOUNT_CHAT_RESTRICTED';
      const updated = await applyAdminSafeguardingAccountAction(
        report.id, restoring ? 'RESTORE_ACCOUNT_CHAT' : 'RESTRICT_ACCOUNT_CHAT', accountNote.trim(),
      );
      onUpdated(updated);
      setAccountNote('');
      toast.success(restoring ? 'Account chat restored' : 'Account chat restricted');
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setAccountBusy(false); }
  }

  return <article className="p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-[10px] font-semibold uppercase tracking-[1.2px] text-[#788079]">Case {report.id.slice(-8).toUpperCase()}</p><h3 className="mt-1 text-xl font-semibold text-[#294735]">{report.subject.name || `@${report.subject.username}`}</h3><p className="mt-1 text-xs text-[#59675c]">@{report.subject.username}{report.subject.accountType ? ` · ${report.subject.accountType.toLowerCase()}` : ''}</p></div>
      <div className="flex flex-wrap gap-2"><span className={cn('rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase', severityTone[report.severity])}>{safeguardingSeverityLabel(report.severity)}</span><span className={cn('rounded-full px-2.5 py-1 text-[10px] font-semibold', statusTone[report.status])}>{safeguardingStatusLabel(report.status)}</span></div>
    </div>

    <dl className="mt-5 grid gap-3 rounded-xl bg-[#f7f8f5] p-4 text-xs sm:grid-cols-2">
      <div><dt className="font-semibold text-[#667268]">Concern</dt><dd className="mt-1 text-[#33443b]">{chatReportCategoryLabel(report.category)}</dd></div>
      <div><dt className="font-semibold text-[#667268]">Reported</dt><dd className="mt-1 text-[#33443b]">{formatTimestamp(report.createdAt)}</dd></div>
      <div><dt className="font-semibold text-[#667268]">Club</dt><dd className="mt-1 text-[#33443b]">{report.business?.name ?? 'No club attached'}</dd></div>
      <div><dt className="font-semibold text-[#667268]">Session</dt><dd className="mt-1 text-[#33443b]">{report.session?.serviceName ?? (report.session ? 'Booking-linked conversation' : 'Direct conversation')}{report.session?.startAt ? ` · ${formatTimestamp(report.session.startAt)}` : ''}</dd></div>
      <div><dt className="font-semibold text-[#667268]">Assigned to</dt><dd className="mt-1 text-[#33443b]">{report.assignedTo || 'Unassigned'}</dd></div>
      {mode === 'admin' && <div><dt className="font-semibold text-[#667268]">Account safety status</dt><dd className="mt-1 text-[#33443b]">{report.targetSafetyStatus || report.subject.safetyStatus || 'No restriction recorded'}</dd></div>}
    </dl>

    {mode === 'club' ? <div className="mt-4 rounded-xl border border-[#e2e7df] bg-white p-4 text-xs leading-relaxed text-[#59675c]"><strong className="font-semibold text-[#33443b]">Reporter withheld.</strong> Courtly shares the concern category and necessary case evidence without exposing reporter identity, free-form details, or platform-only context.</div> : <>
      <section className="mt-5"><h4 className="text-xs font-semibold uppercase tracking-wide text-[#667268]">Reporter and details</h4><p className="mt-2 text-sm text-[#33443b]">{report.reporter?.name || report.reporter?.username ? `${report.reporter.name ?? ''}${report.reporter.username ? ` (@${report.reporter.username})` : ''}` : 'Reporter snapshot unavailable'}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[#4d5e51]">{report.description || 'No optional details were provided.'}</p></section>
    </>}

    <section className="mt-5"><h4 className="text-xs font-semibold uppercase tracking-wide text-[#667268]">Reported message</h4>{report.reportedMessage ? <blockquote className="mt-2 rounded-xl border-l-4 border-[#c68b76] bg-[#fff8f5] p-4 text-sm leading-relaxed text-[#3e463f]"><p className="whitespace-pre-wrap break-words">“{report.reportedMessage.body}”</p><footer className="mt-2 text-[11px] text-[#6e746f]">{report.reportedMessage.senderName} · {formatTimestamp(report.reportedMessage.createdAt)}</footer></blockquote> : <p className="mt-2 text-xs text-[#59675c]">The report was submitted without a specific message anchor.</p>}</section>

    {mode === 'admin' && report.evidence?.context && report.evidence.context.length > 0 && <section className="mt-5"><h4 className="text-xs font-semibold uppercase tracking-wide text-[#667268]">Evidence context</h4><ol className="mt-2 space-y-2">{report.evidence.context.map(message => <li key={message.id} className="rounded-xl border border-[#e5e9e0] p-3 text-xs"><p className="font-semibold text-[#4a5c50]">{message.senderName} · {formatTimestamp(message.createdAt)}</p><p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-[#59675c]">{message.body}</p></li>)}</ol></section>}

    {canReview && <form onSubmit={save} className="mt-6 rounded-xl border border-[#dfe6da] bg-[#fbfcf9] p-4"><h4 className="text-sm font-semibold text-[#294735]">Review case</h4><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-[#4d5e51]">Status<select className="mt-1 min-h-11 text-xs" value={status} onChange={event => setStatus(event.target.value as SafeguardingReportStatus)}>{(mode === 'admin' ? safeguardingStatusOrder : [...new Set<SafeguardingReportStatus>([report.status, 'IN_REVIEW', 'REFERRED_TO_PLATFORM'])]).map(value => <option key={value} value={value} disabled={mode === 'club' && value !== 'IN_REVIEW' && value !== 'REFERRED_TO_PLATFORM'}>{safeguardingStatusLabel(value)}</option>)}</select></label><label className="text-xs font-semibold text-[#4d5e51]">Severity<select className="mt-1 min-h-11 text-xs" value={severity} onChange={event => setSeverity(event.target.value as SafeguardingReportSeverity)}>{safeguardingSeverityOrder.map(value => <option key={value} value={value}>{safeguardingSeverityLabel(value)}</option>)}</select></label>{mode === 'admin' ? <label className="text-xs font-semibold text-[#4d5e51] sm:col-span-2">Assigned reviewer<input className="mt-1 min-h-11" value={assignedTo} onChange={event => setAssignedTo(event.target.value)} maxLength={120} placeholder="Name or team label; leave blank to unassign" /></label> : <label className="text-xs font-semibold text-[#4d5e51] sm:col-span-2">Assignment<select className="mt-1 min-h-11 text-xs" value={assignment} onChange={event => setAssignment(event.target.value as typeof assignment)}><option value="">Keep current assignment</option><option value="SELF">Assign to me</option><option value="UNASSIGNED">Leave unassigned</option></select></label>}</div><label className="mt-3 block text-xs font-semibold text-[#4d5e51]">Internal review rationale<textarea rows={3} maxLength={2000} required className="mt-1" value={note} onChange={event => setNote(event.target.value)} /></label><div className="mt-3 flex justify-end"><Button type="submit" disabled={busy || !note.trim()}>{busy && <Loader2 size={14} className="animate-spin" />}Save review</Button></div></form>}

    {mode === 'admin' && canReview && <form onSubmit={runAccountAction} className="mt-5 rounded-xl border border-[#edcfbf] bg-[#fff9f5] p-4"><div className="flex items-start gap-3"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-[#a75c43]" /><div><h4 className="text-sm font-semibold text-[#6f3f32]">{report.targetSafetyStatus === 'ACCOUNT_CHAT_RESTRICTED' ? 'Restore account chat' : 'Restrict account chat'}</h4><p className="mt-1 text-xs leading-relaxed text-[#79594f]">{report.targetSafetyStatus === 'ACCOUNT_CHAT_RESTRICTED' ? 'This restores direct chat only when this case owns the active restriction. A reason is required and audited.' : 'This stops the reported account from using direct chat. A reason is required and is added to the case audit trail.'}</p></div></div><label className="mt-3 block text-xs font-semibold text-[#6f4d43]">Required reason<input value={accountNote} onChange={event => setAccountNote(event.target.value)} required maxLength={1000} className="mt-1 min-h-11" /></label><div className="mt-3 flex justify-end"><Button type="submit" variant={report.targetSafetyStatus === 'ACCOUNT_CHAT_RESTRICTED' ? 'outline' : 'destructive'} disabled={accountBusy || !accountNote.trim()}>{accountBusy && <Loader2 size={14} className="animate-spin" />}{report.targetSafetyStatus === 'ACCOUNT_CHAT_RESTRICTED' ? 'Restore account chat' : 'Restrict account chat'}</Button></div></form>}

    {mode === 'admin' && ((report.audits?.length ?? 0) > 0 || report.auditHistoryHasEarlier) && <section className="mt-6"><h4 className="text-xs font-semibold uppercase tracking-wide text-[#667268]">Case history</h4>{report.auditHistoryHasEarlier && <p className="mt-2 rounded-lg bg-[#f4f6f1] p-3 text-xs leading-relaxed text-[#59675c]">Earlier retained case-history events are not included in this response.</p>}{report.audits && report.audits.length > 0 && <ol className="mt-3 space-y-3 border-l border-[#dfe5df] pl-4">{report.audits.map(event => <li key={event.id} className="text-xs leading-relaxed text-[#59675c]"><p className="font-semibold text-[#33443b]">{event.action.replaceAll('_', ' ').toLowerCase()}</p><p>{event.actorName || 'Authorized reviewer'} · {formatTimestamp(event.createdAt)}</p>{event.note && <p className="mt-1 whitespace-pre-wrap">{event.note}</p>}</li>)}</ol>}</section>}
    {!canReview && <p className="mt-5 flex items-start gap-2 rounded-xl bg-[#f4f6f1] p-4 text-xs leading-relaxed text-[#59675c]"><UserRoundCheck size={16} className="shrink-0" />You have view access. A colleague with safeguarding review permission can change this case.</p>}
  </article>;
}
