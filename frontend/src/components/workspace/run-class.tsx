'use client';

import { useCallback, useEffect, useId, useMemo, useState, type RefObject } from 'react';
import { CalendarDays, Check, CheckCheck, ChevronDown, Loader2, MapPin, MessageCircle, NotebookPen, ShieldCheck, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { loadBookingFeedback, markAllAttendance, markParticipantAttendance, mutate, saveParticipantFeedback } from '@/lib/api';
import type { Attendance, ProviderFeedback, ProviderFeedbackList, WorkspaceBooking } from '@/lib/types';
import {
  activeRoster, attendanceLabels, attendanceSummary, attendanceSummaryText, bulkPresentPlan, draftFromFeedback,
  feedbackAllowedFor, feedbackDirty, feedbackDraftError, feedbackInputFromDraft, feedbackLimits, feedbackStatus,
  feedbackStatusLabels, type FeedbackDraft, type FeedbackStatus,
} from '@/lib/run-class';
import { cn, shortDate, time } from '@/lib/utils';
import { AttendanceControl } from './attendance-control';
import { canCompleteClass, nextTimingBoundary } from './booking-detail-permissions';

/** Re-render exactly when a lesson starts or ends, and again when the tab returns. */
export function useLessonClock(booking: { startAt: string; endAt: string } | null, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  const startAt = booking?.startAt;
  const endAt = booking?.endAt;
  useEffect(() => {
    if (!active || !startAt || !endAt) return;
    let timer: number | undefined;
    function tick() {
      const live = Date.now();
      setNow(live);
      const next = nextTimingBoundary({ startAt: startAt!, endAt: endAt! }, live);
      if (next !== null) timer = window.setTimeout(tick, Math.max(50, Math.min(30_000, next - live)));
    }
    tick();
    function handleVisibility() {
      if (document.visibilityState !== 'visible') return;
      if (timer !== undefined) window.clearTimeout(timer);
      tick();
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [active, startAt, endAt]);
  return now;
}

type RunClassProps = {
  booking: WorkspaceBooking;
  timezone: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  refresh: () => Promise<void>;
  /** Present only when this person may open the session chat. */
  onOpenChat?: (bookingId: string) => void;
  /** The current trigger. Completing the Class refreshes the workspace, which
   * can remount the button Radix remembered, so focus returns through a ref. */
  returnFocusRef?: RefObject<HTMLElement | null>;
};

type PendingExit = 'close' | 'chat' | null;

const statusTone: Record<FeedbackStatus, string> = {
  NOT_STARTED: 'bg-stone-100! text-stone-600!',
  UNSAVED: 'pending',
  DRAFT: 'completed',
  SHARED: '',
};

/**
 * Court-side "Run this Class".
 *
 * Built for a phone held between drills: one roster, one tap per learner for
 * attendance, and a feedback note that can be drafted for the club before it
 * is shared. Nothing here edits the booking itself except completion, which
 * still follows the ordinary lifecycle.
 */
export function RunClassDialog({ booking, timezone, open, onOpenChange, refresh, onOpenChat, returnFocusRef }: RunClassProps) {
  const now = useLessonClock(booking, open);
  const [overrides, setOverrides] = useState<Record<string, Attendance>>({});
  const [savingAttendance, setSavingAttendance] = useState<{ participantId: string; value: Attendance } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [feedback, setFeedback] = useState<ProviderFeedbackList | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, FeedbackDraft>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [savingFeedback, setSavingFeedback] = useState<string | null>(null);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [pendingExit, setPendingExit] = useState<PendingExit>(null);
  const [announcement, setAnnouncement] = useState('');

  const roster = useMemo(() => activeRoster(booking.participants).map(participant => ({
    ...participant, attendance: overrides[participant.id] ?? participant.attendance,
  })), [booking.participants, overrides]);
  const summary = attendanceSummary(roster);
  const plan = bulkPresentPlan(roster);
  const savedFor = useCallback((participantId: string): ProviderFeedback | null =>
    feedback?.feedback.find(item => item.participantId === participantId) ?? null, [feedback]);
  const draftFor = (participantId: string) => drafts[participantId] ?? draftFromFeedback(savedFor(participantId));
  const dirtyIds = roster.map(participant => participant.id)
    .filter(id => drafts[id] && feedbackDirty(drafts[id], savedFor(id)));
  const ended = new Date(booking.endAt).getTime() <= now;
  const canComplete = canCompleteClass(booking, now);

  const loadFeedback = useCallback(async () => {
    setFeedbackLoading(true);
    setFeedbackError('');
    try {
      setFeedback(await loadBookingFeedback(booking.id));
    } catch (cause) {
      setFeedbackError(cause instanceof Error ? cause.message : 'Feedback could not be loaded.');
    } finally {
      setFeedbackLoading(false);
    }
  }, [booking.id]);

  useEffect(() => {
    if (!open) return;
    setOverrides({});
    setDrafts({});
    setDraftErrors({});
    setExpanded([]);
    setPendingExit(null);
    setFeedback(null);
    void loadFeedback();
  }, [open, loadFeedback]);

  function settleRefresh() {
    // The roll call is already reflected locally; a slow workspace reload
    // must not hold up the next tap.
    void refresh().catch(() => undefined);
  }

  async function mark(participantId: string, name: string, value: Attendance) {
    setSavingAttendance({ participantId, value });
    try {
      const result = await markParticipantAttendance(booking.id, participantId, value);
      setOverrides(current => ({ ...current, [participantId]: result.attendance }));
      setAnnouncement(`${name} marked ${attendanceLabels[result.attendance].toLowerCase()}.`);
      settleRefresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Attendance could not be saved.');
    } finally {
      setSavingAttendance(null);
    }
  }

  async function markAllPresent() {
    if (plan.kind === 'NONE') return;
    setBulkBusy(true);
    try {
      const result = await markAllAttendance(booking.id, 'PRESENT', plan.participantIds);
      setOverrides(current => ({
        ...current,
        ...Object.fromEntries(result.participants.map(participant => [participant.id, participant.attendance])),
      }));
      const message = `${result.participants.length} learner${result.participants.length === 1 ? '' : 's'} marked present.`;
      setAnnouncement(message);
      toast.success(message);
      settleRefresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Attendance could not be saved.');
    } finally {
      setBulkBusy(false);
    }
  }

  function updateDraft(participantId: string, change: Partial<FeedbackDraft>) {
    setDrafts(current => ({ ...current, [participantId]: { ...(current[participantId] ?? draftFromFeedback(savedFor(participantId))), ...change } }));
    setDraftErrors(current => {
      if (!current[participantId]) return current;
      const next = { ...current };
      delete next[participantId];
      return next;
    });
  }

  async function saveFeedback(participantId: string, name: string) {
    const draft = draftFor(participantId);
    const problem = feedbackDraftError(draft);
    if (problem) {
      setDraftErrors(current => ({ ...current, [participantId]: problem }));
      return;
    }
    setSavingFeedback(participantId);
    try {
      const saved = await saveParticipantFeedback(booking.id, participantId, feedbackInputFromDraft(draft));
      setFeedback(current => ({
        canWrite: current?.canWrite ?? true,
        feedback: [...(current?.feedback ?? []).filter(item => item.participantId !== participantId), saved],
      }));
      setDrafts(current => ({ ...current, [participantId]: draftFromFeedback(saved) }));
      const message = saved.visibility === 'SHARED' ? `Feedback shared with ${name}.` : `Feedback saved for the club. ${name} cannot see it yet.`;
      setAnnouncement(message);
      toast.success(message);
    } catch (cause) {
      setDraftErrors(current => ({ ...current, [participantId]: cause instanceof Error ? cause.message : 'Feedback could not be saved.' }));
    } finally {
      setSavingFeedback(null);
    }
  }

  async function complete() {
    setCompleting(true);
    try {
      await mutate(`/bookings/${booking.id}`, 'PATCH', { status: 'COMPLETED' });
      await refresh();
      toast.success('Class marked completed');
      setAnnouncement('Class marked completed.');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'The Class could not be completed.');
    } finally {
      setCompleting(false);
    }
  }

  function exit(kind: Exclude<PendingExit, null>, force = false) {
    if (!force && dirtyIds.length) {
      setPendingExit(kind);
      return;
    }
    setPendingExit(null);
    if (kind === 'chat' && onOpenChat) {
      onOpenChange(false);
      onOpenChat(booking.id);
      return;
    }
    onOpenChange(false);
  }

  const busy = bulkBusy || completing || !!savingFeedback;
  const canWrite = feedback?.canWrite ?? false;

  return <Dialog open={open} onOpenChange={next => { if (!next) exit('close'); else onOpenChange(true); }}>
    <DialogContent
      onCloseAutoFocus={event => {
        const target = returnFocusRef?.current;
        if (target?.isConnected) {
          event.preventDefault();
          target.focus();
        }
      }}
      aria-describedby="run-class-description"
      className="run-class-dialog flex h-[100dvh] max-h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 p-0 left-0 top-0 translate-x-0 translate-y-0 max-sm:top-0 max-sm:max-h-[100dvh] max-sm:rounded-none! sm:left-1/2 sm:top-1/2 sm:h-[min(92dvh,920px)] sm:max-h-[92dvh] sm:w-[calc(100%-3rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border"
    >
      <header className="shrink-0 border-b border-[#e7ebe2] bg-white px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
        <p className="eyebrow" aria-hidden="true">Run this Class</p>
        <DialogTitle className="!mt-1.5 text-xl font-semibold tracking-tight text-[#173f2f]"><span className="sr-only">Run this Class: </span>{booking.serviceName}</DialogTitle>
        <DialogDescription id="run-class-description" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#59675c]">
          <span className="inline-flex items-center gap-1.5"><CalendarDays size={13} aria-hidden="true" />{shortDate(booking.startAt, timezone)} · {time(booking.startAt, timezone)} – {time(booking.endAt, timezone)}</span>
          <span className="inline-flex items-center gap-1.5"><MapPin size={13} aria-hidden="true" />{booking.locationName}</span>
          <span className="inline-flex items-center gap-1.5"><UserRound size={13} aria-hidden="true" />{booking.instructorName}</span>
        </DialogDescription>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className={`badge ${booking.status.toLowerCase()}`}>{booking.status === 'COMPLETED' ? 'Completed' : ended ? 'Ended' : 'In progress'}</span>
          <p className="text-xs font-medium text-[#344b39]">{attendanceSummaryText(summary)}</p>
        </div>
        <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          {/* aria-disabled rather than disabled: once everyone is marked the
              pressed button must keep keyboard focus instead of dropping it. */}
          <Button type="button" aria-disabled={plan.kind === 'NONE' || busy || !!savingAttendance || undefined} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-55" onClick={() => { if (plan.kind !== 'NONE' && !busy && !savingAttendance) void markAllPresent(); }}>
            {bulkBusy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <CheckCheck size={15} aria-hidden="true" />}{plan.label}
          </Button>
          {onOpenChat && <Button type="button" variant="outline" disabled={busy} onClick={() => exit('chat')}><MessageCircle size={15} aria-hidden="true" />Message the Class</Button>}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#f7f8f5] px-4 py-4 sm:px-6">
        {feedbackError && <div className="mb-3 rounded-xl border border-red-100 bg-red-50 p-3 text-xs text-red-700"><p role="alert">Feedback could not be loaded: {feedbackError}</p><Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void loadFeedback()}>Try again</Button></div>}
        {!roster.length ? <p className="rounded-xl border border-[#e3e8df] bg-white p-5 text-sm text-[#59675c]">Nobody holds a place in this Class.</p>
          : <ul className="space-y-3" aria-label="Class roster">{roster.map(participant => (
            <RosterRow
              key={participant.id}
              name={participant.name}
              attendance={participant.attendance}
              savingAttendance={savingAttendance?.participantId === participant.id ? savingAttendance.value : null}
              attendanceLocked={busy || !!savingAttendance}
              onMark={value => void mark(participant.id, participant.name, value)}
              saved={savedFor(participant.id)}
              draft={draftFor(participant.id)}
              feedbackReady={!!feedback && !feedbackLoading}
              feedbackLoading={feedbackLoading}
              canWrite={canWrite}
              expanded={expanded.includes(participant.id)}
              onToggle={() => setExpanded(current => current.includes(participant.id) ? current.filter(id => id !== participant.id) : [...current, participant.id])}
              onChange={change => updateDraft(participant.id, change)}
              onSave={() => void saveFeedback(participant.id, participant.name)}
              saving={savingFeedback === participant.id}
              error={draftErrors[participant.id] ?? ''}
              timezone={timezone}
            />
          ))}</ul>}
      </div>

      <footer className="shrink-0 border-t border-[#e7ebe2] bg-white px-4 py-3 sm:px-6" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        {pendingExit ? <div role="region" aria-labelledby="run-class-unsaved-heading" className="rounded-xl border border-[#e7dcc1] bg-[#fcf8ee] p-3">
          <h3 id="run-class-unsaved-heading" className="text-sm text-[#5f4b1f]">Unsaved feedback</h3>
          <p className="!mt-1 text-xs leading-relaxed text-[#6a5a33]">Feedback for {dirtyIds.length} learner{dirtyIds.length === 1 ? ' has' : 's have'} not been saved. Leaving now discards {dirtyIds.length === 1 ? 'it' : 'them'}.</p>
          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="destructive" onClick={() => exit(pendingExit, true)}>{pendingExit === 'chat' ? 'Discard and open chat' : 'Discard and close'}</Button>
            <Button type="button" autoFocus onClick={() => setPendingExit(null)}>Keep editing</Button>
          </div>
        </div> : <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-relaxed text-[#59675c]">
            {booking.status === 'COMPLETED' ? 'This Class is complete. You can still correct attendance and feedback.'
              : canComplete ? summary.unmarked ? `${summary.unmarked} learner${summary.unmarked === 1 ? ' is' : 's are'} still unmarked.` : 'Everyone is marked. Complete the Class when you are done.'
                : `You can complete the Class once it ends at ${time(booking.endAt, timezone)}.`}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:flex">
            {canComplete && <Button type="button" disabled={busy} onClick={() => void complete()}>{completing ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}Complete Class</Button>}
            <Button type="button" variant="outline" onClick={() => exit('close')}>Done</Button>
          </div>
        </div>}
      </footer>
    </DialogContent>
  </Dialog>;
}

function RosterRow({
  name, attendance, savingAttendance, attendanceLocked, onMark, saved, draft, feedbackReady, feedbackLoading, canWrite,
  expanded, onToggle, onChange, onSave, saving, error, timezone,
}: {
  name: string; attendance: Attendance; savingAttendance: Attendance | null; attendanceLocked: boolean;
  onMark: (value: Attendance) => void; saved: ProviderFeedback | null; draft: FeedbackDraft;
  feedbackReady: boolean; feedbackLoading: boolean; canWrite: boolean; expanded: boolean; onToggle: () => void;
  onChange: (change: Partial<FeedbackDraft>) => void; onSave: () => void; saving: boolean; error: string; timezone: string;
}) {
  const id = useId();
  const status = feedbackStatus(draft, saved);
  const attended = feedbackAllowedFor(attendance);
  const writable = feedbackReady && canWrite && attended;
  const panelId = `${id}-feedback`;
  const nameId = `${id}-name`;
  return <li className="rounded-xl border border-[#e3e8df] bg-white p-3 sm:p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 id={nameId} className="truncate text-sm text-[#294735]">{name}</h3>
        <p className="!mt-1 text-[11px] text-[#59675c]">{attendanceLabels[attendance]}</p>
      </div>
      {feedbackReady && <span className={`badge ${statusTone[status]}`}>{feedbackStatusLabels[status]}</span>}
    </div>
    <div className="mt-3">
      <AttendanceControl value={attendance} learnerName={name} locked={attendanceLocked} busyValue={savingAttendance} onChange={onMark} />
    </div>
    <Button type="button" variant="ghost" size="sm" className="mt-2 -ml-2" aria-expanded={expanded} aria-controls={panelId} onClick={onToggle}>
      <NotebookPen size={14} aria-hidden="true" />{saved ? 'Edit feedback' : 'Write feedback'}<span className="sr-only"> for {name}</span>
      <ChevronDown size={14} aria-hidden="true" className={cn('transition-transform', expanded && 'rotate-180')} />
    </Button>
    {expanded && <div id={panelId} className="mt-2 border-t border-[#edf0e8] pt-3">
      {feedbackLoading ? <p className="flex items-center gap-2 text-xs text-[#59675c]"><Loader2 size={13} className="animate-spin" aria-hidden="true" />Loading feedback…</p>
        : !feedbackReady ? <p className="text-xs text-[#59675c]">Feedback is unavailable until it loads.</p>
          : <FeedbackEditor name={name} draft={draft} saved={saved} writable={writable} attended={attended} canWrite={canWrite} status={status} onChange={onChange} onSave={onSave} saving={saving} error={error} timezone={timezone} />}
    </div>}
  </li>;
}

function FeedbackEditor({ name, draft, saved, writable, attended, canWrite, status, onChange, onSave, saving, error, timezone }: {
  name: string; draft: FeedbackDraft; saved: ProviderFeedback | null; writable: boolean; attended: boolean; canWrite: boolean;
  status: FeedbackStatus; onChange: (change: Partial<FeedbackDraft>) => void; onSave: () => void; saving: boolean; error: string; timezone: string;
}) {
  const id = useId();
  const shared = draft.visibility === 'SHARED';
  const field = (key: 'summary' | 'strengths' | 'focusAreas' | 'nextGoal' | 'clubNote') => ({
    id: `${id}-${key}`,
    value: draft[key],
    maxLength: feedbackLimits[key],
    disabled: !writable || saving,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ [key]: event.target.value } as Partial<FeedbackDraft>),
  });
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (writable && !saving && status === 'UNSAVED') onSave(); }}>
    {!canWrite ? <p className="rounded-lg bg-[#f5f7f1] p-3 text-xs leading-relaxed text-[#59675c]">Feedback is read-only for this Class.</p>
      : !attended ? <p className="rounded-lg bg-[#f5f7f1] p-3 text-xs leading-relaxed text-[#59675c]">Mark {name} present or late to write feedback.</p> : null}
    <div><label htmlFor={`${id}-summary`}>How the session went</label><textarea rows={3} placeholder="What you worked on and how it went" {...field('summary')} /></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div><label htmlFor={`${id}-strengths`}>Strengths</label><textarea rows={2} placeholder="What is working well" {...field('strengths')} /></div>
      <div><label htmlFor={`${id}-focusAreas`}>Focus areas</label><textarea rows={2} placeholder="What to practise next" {...field('focusAreas')} /></div>
    </div>
    <div><label htmlFor={`${id}-nextGoal`}>Next goal</label><input placeholder="One clear goal for next time" {...field('nextGoal')} /></div>
    <div className="rounded-xl border border-[#dfe7d3] bg-[#f6f9f1] p-3">
      <label htmlFor={`${id}-share`} className="mb-0 flex cursor-pointer items-start gap-3">
        <input id={`${id}-share`} type="checkbox" className="mt-1 shrink-0" checked={shared} disabled={!writable || saving} aria-describedby={`${id}-share-hint`} onChange={event => onChange({ visibility: event.target.checked ? 'SHARED' : 'PRIVATE' })} />
        <span className="text-sm font-semibold text-[#344b39]">Share with learner</span>
      </label>
      <p id={`${id}-share-hint`} className="!mt-1.5 pl-7 text-[11px] leading-relaxed text-[#59675c]">
        Shared feedback appears in {name}&rsquo;s progress. If {name} is a child, their parent or guardian sees it too.
        {saved?.sharedAt ? ` First shared ${shortDate(saved.sharedAt, timezone)}.` : ' They are notified the first time you share.'}
      </p>
    </div>
    <div className="rounded-xl border border-[#eadfc4] bg-[#fdf9ef] p-3">
      <label htmlFor={`${id}-clubNote`} className="flex items-center gap-1.5 text-[#5f4b1f]"><ShieldCheck size={14} aria-hidden="true" />Internal note for the club</label>
      <textarea rows={2} aria-describedby={`${id}-clubNote-hint`} placeholder="For coaches and club staff only" {...field('clubNote')} />
      <p id={`${id}-clubNote-hint`} className="!mt-1.5 text-[11px] leading-relaxed text-[#6a5a33]">Never shown to learners, parents or guardians, even when the feedback is shared.</p>
    </div>
    {saved && <p className="text-[11px] text-[#59675c]">Written by {saved.authorName}{saved.editedByName ? ` · last edited by ${saved.editedByName}` : ''}{saved.viewedAt ? ' · seen by the learner' : ''}</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs leading-relaxed text-red-700">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] font-medium text-[#59675c]" aria-live="polite">{feedbackStatusLabels[status]}</p>
      {/* Saving leaves this button focused, so it never switches to disabled under the keyboard. */}
      <Button type="submit" size="sm" aria-disabled={!writable || saving || status !== 'UNSAVED' || undefined} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-55">
        {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
        {shared ? 'Save and share' : 'Save for the club'}<span className="sr-only"> feedback for {name}</span>
      </Button>
    </div>
  </form>;
}
