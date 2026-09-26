'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { CalendarPlus, Loader2, Send } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ApiError, loadSlots } from '@/lib/api';
import { nextSessionDate } from '@/lib/chat';
import type { ChatSession, SessionProposal, Slot } from '@/lib/types';
import { cn, dateKey, time } from '@/lib/utils';

type ProposeSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: ChatSession;
  /** Present when answering a proposal with a different time ("Edit"). */
  counterTo?: SessionProposal | null;
  onSubmit: (startAt: string, message: string) => Promise<void>;
};

function conflictReason(error: unknown) {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== 'object') return '';
  const conflicts = (error.details as { conflicts?: Array<{ reason?: unknown }> }).conflicts;
  return Array.isArray(conflicts) && typeof conflicts[0]?.reason === 'string' ? conflicts[0].reason : '';
}

/**
 * Pick a time for the next session. Only times the coach can actually teach
 * are offered; the server checks again, including the student's own diary,
 * when the proposal is sent and again when it is accepted.
 */
export function ProposeSessionDialog({ open, onOpenChange, session, counterTo, onSubmit }: ProposeSessionDialogProps) {
  const zone = session.timezone;
  const initialDate = counterTo ? dateKey(counterTo.startAt, zone) : nextSessionDate(session.startAt, zone);
  const [date, setDate] = useState(initialDate);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const dateId = useId();
  const noteId = useId();
  const timesId = useId();

  useEffect(() => {
    if (!open) return;
    setDate(initialDate);
    setSelected('');
    setNote('');
    setError('');
  // The starting date is chosen each time the dialog opens, not on every
  // render, so a slow poll cannot reset a date someone has picked.
  }, [open, counterTo?.id]);

  useEffect(() => {
    if (!open || !date) return;
    let active = true;
    setSlotsLoading(true);
    setSlotsError('');
    setSlots([]);
    setSelected('');
    loadSlots(session.businessSlug, {
      serviceId: session.serviceId, instructorId: session.instructorId, locationId: session.locationId, date,
    })
      .then(result => { if (active) setSlots(result.slots.filter(slot => slot.available)); })
      .catch(cause => { if (active) setSlotsError(cause instanceof Error ? cause.message : 'Times could not be loaded.'); })
      .finally(() => { if (active) setSlotsLoading(false); });
    return () => { active = false; };
  }, [open, date, session.businessSlug, session.serviceId, session.instructorId, session.locationId]);

  const choices = slots.filter(slot => !counterTo || slot.startAt !== counterTo.startAt);
  const today = dateKey(new Date(), zone);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onSubmit(selected, note.trim());
      onOpenChange(false);
    } catch (cause) {
      const reason = conflictReason(cause);
      setError(`${cause instanceof Error ? cause.message : 'The proposal could not be sent.'}${reason ? ` ${reason}.` : ''}`);
    } finally {
      setSubmitting(false);
    }
  }

  return <Dialog open={open} onOpenChange={next => { if (!submitting) onOpenChange(next); }}>
    <DialogContent className="chat-propose-dialog max-w-md" onEscapeKeyDown={event => { if (submitting) event.preventDefault(); }}>
      <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#e8efe0] text-[#214e3e]"><CalendarPlus size={20} aria-hidden="true" /></span>
      <DialogTitle className="!mt-4 text-lg font-semibold text-[#263a30]">{counterTo ? 'Suggest a different time' : 'Propose the next session'}</DialogTitle>
      <DialogDescription className="!mt-2 text-xs leading-relaxed text-[#59675c]">
        {session.serviceName} with {session.instructorName} at {session.locationName}. Nothing is booked until{' '}
        {counterTo ? `${counterTo.proposedByYou ? 'the other side' : counterTo.proposedByName} accepts the new time` : 'the other side accepts'}.
      </DialogDescription>
      <form className="mt-5 space-y-4" onSubmit={submit}>
        <div>
          <label htmlFor={dateId}>Date</label>
          <input id={dateId} type="date" min={today} value={date} onChange={event => setDate(event.target.value)} required disabled={submitting} />
        </div>
        <fieldset aria-describedby={timesId} className="min-w-0 border-0 p-0">
          <legend className="mb-2 text-[14px] font-semibold text-[#4d5e51]">Available times</legend>
          <p id={timesId} className="sr-only">Times are shown in {zone}.</p>
          {slotsLoading ? <p role="status" className="flex items-center gap-2 rounded-xl bg-[#f5f7f1] p-3 text-xs text-[#59675c]"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Checking the coach’s availability…</p>
            : slotsError ? <p role="alert" className="rounded-xl bg-[#fff6f1] p-3 text-xs text-[#8b4d3c]">{slotsError}</p>
              : choices.length ? <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {choices.map(slot => <button
                  key={slot.startAt}
                  type="button"
                  aria-pressed={selected === slot.startAt}
                  onClick={() => setSelected(slot.startAt)}
                  disabled={submitting}
                  className={cn(
                    'min-h-11 rounded-xl border px-2 text-xs font-semibold transition',
                    selected === slot.startAt
                      ? 'border-[#214e3e] bg-[#214e3e] text-white'
                      : 'border-[#dfe5df] bg-white text-[#33443b] hover:border-[#b9c8b4] hover:bg-[#f5f8f2]',
                  )}
                >{time(slot.startAt, zone)}</button>)}
              </div>
                : <p className="rounded-xl bg-[#f5f7f1] p-3 text-xs leading-relaxed text-[#59675c]">No available times on this day. Try another date.</p>}
        </fieldset>
        <div>
          <label htmlFor={noteId}>Note <span className="font-normal text-[#59675c]">(optional)</span></label>
          <input id={noteId} value={note} maxLength={500} onChange={event => setNote(event.target.value)} placeholder="Anything to add?" disabled={submitting} />
        </div>
        {error && <p role="alert" className="rounded-xl border border-[#eedbd4] bg-[#fff6f1] p-3 text-xs leading-relaxed text-[#8b4d3c]">{error}</p>}
        <button
          type="submit"
          disabled={!selected || submitting}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#214e3e] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#173b2e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
          {counterTo ? 'Send new time' : 'Send proposal'}
        </button>
      </form>
    </DialogContent>
  </Dialog>;
}
