'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { CalendarPlus, Loader2, Send } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ApiError, loadSlots } from '@/lib/api';
import { CHAT_TIME_ZONE, nextSessionDate } from '@/lib/chat';
import type {
  ChatConversation,
  ChatProposalSchedulingChoice,
  ChatScheduleSuggestion,
  ChatSchedulingOption,
  ChatSession,
  SessionProposal,
  Slot,
} from '@/lib/types';
import { cn, dateKey, money, time } from '@/lib/utils';

type ProposeSessionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: ChatSession | null;
  conversation: ChatConversation | null;
  /** Present when answering a proposal with a different time ("Edit"). */
  counterTo?: SessionProposal | null;
  /** A session detected in the conversation; opens the dialog already filled in. */
  suggestion?: ChatScheduleSuggestion | null;
  onSubmit: (startAt: string, message: string, scheduling?: ChatProposalSchedulingChoice) => Promise<void>;
};

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter(value => {
    const candidate = key(value);
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function proposalOption(
  options: ChatSchedulingOption[],
  proposal?: SessionProposal | null,
  suggestion?: ChatScheduleSuggestion | null,
) {
  if (!proposal && suggestion) {
    return options.find(option =>
      option.businessSlug === suggestion.option.businessSlug
      && option.serviceId === suggestion.option.serviceId
      && option.locationId === suggestion.option.locationId
    ) ?? options[0] ?? null;
  }
  if (!proposal) return options[0] ?? null;
  return options.find(option =>
    option.businessSlug === proposal.businessSlug
    && option.serviceId === proposal.serviceId
    && option.instructorId === proposal.instructorId
    && option.locationId === proposal.locationId
  ) ?? null;
}

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
export function ProposeSessionDialog({ open, onOpenChange, session, conversation, counterTo, suggestion, onSubmit }: ProposeSessionDialogProps) {
  const schedulingOptions = conversation?.schedulingOptions ?? [];
  const prefill = counterTo ? null : suggestion ?? null;
  const defaultOption = proposalOption(schedulingOptions, counterTo, prefill);
  // Times are picked and shown on the chat's Singapore clock, like every
  // other time in the conversation.
  const zone = CHAT_TIME_ZONE;
  const initialDate = counterTo
    ? dateKey(counterTo.startAt, zone)
    : prefill ? prefill.date : nextSessionDate(session?.startAt ?? '', zone);
  const [businessSlug, setBusinessSlug] = useState(defaultOption?.businessSlug ?? '');
  const [serviceId, setServiceId] = useState(defaultOption?.serviceId ?? '');
  const [locationId, setLocationId] = useState(defaultOption?.locationId ?? '');
  const [date, setDate] = useState(initialDate);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [selected, setSelected] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The suggested time is selected once, when its slots first arrive; after
  // that the person's own choice wins.
  const prefillApplied = useRef<string | null>(null);
  const dateId = useId();
  const businessId = useId();
  const serviceSelectId = useId();
  const locationSelectId = useId();
  const noteId = useId();
  const timesId = useId();

  const businesses = useMemo(() => uniqueBy(schedulingOptions, option => option.businessSlug), [schedulingOptions]);
  const services = useMemo(() => uniqueBy(
    schedulingOptions.filter(option => option.businessSlug === businessSlug),
    option => option.serviceId,
  ), [schedulingOptions, businessSlug]);
  const locations = useMemo(() => uniqueBy(
    schedulingOptions.filter(option => option.businessSlug === businessSlug && option.serviceId === serviceId),
    option => option.locationId,
  ), [schedulingOptions, businessSlug, serviceId]);
  const selectedOption = schedulingOptions.find(option =>
    option.businessSlug === businessSlug && option.serviceId === serviceId && option.locationId === locationId
  ) ?? null;
  const slotBusinessSlug = session?.businessSlug ?? selectedOption?.businessSlug ?? '';
  const slotServiceId = session?.serviceId ?? selectedOption?.serviceId ?? '';
  const slotInstructorId = session?.instructorId ?? selectedOption?.instructorId ?? '';
  const slotLocationId = session?.locationId ?? selectedOption?.locationId ?? '';

  useEffect(() => {
    if (!open || session) return;
    const currentStillExists = schedulingOptions.some(option =>
      option.businessSlug === businessSlug && option.serviceId === serviceId && option.locationId === locationId
    );
    if (currentStillExists) return;
    const option = proposalOption(schedulingOptions, counterTo, prefill);
    setBusinessSlug(option?.businessSlug ?? '');
    setServiceId(option?.serviceId ?? '');
    setLocationId(option?.locationId ?? '');
  }, [open, session, schedulingOptions, businessSlug, serviceId, locationId, counterTo]);

  useEffect(() => {
    if (!open) return;
    const option = proposalOption(schedulingOptions, counterTo, prefill);
    setBusinessSlug(option?.businessSlug ?? '');
    setServiceId(option?.serviceId ?? '');
    setLocationId(option?.locationId ?? '');
    setDate(initialDate);
    setSelected('');
    setNote('');
    setError('');
    prefillApplied.current = null;
  // The starting date is chosen each time the dialog opens, not on every
  // render, so a slow poll cannot reset a date someone has picked.
  }, [open, counterTo?.id, prefill?.key]);

  useEffect(() => {
    if (!open || !date || !slotBusinessSlug || !slotServiceId || !slotInstructorId || !slotLocationId) {
      setSlotsLoading(false);
      setSlots([]);
      setSelected('');
      setSlotsError('');
      return;
    }
    let active = true;
    setSlotsLoading(true);
    setSlotsError('');
    setSlots([]);
    setSelected('');
    loadSlots(slotBusinessSlug, {
      serviceId: slotServiceId, instructorId: slotInstructorId, locationId: slotLocationId, date,
    })
      .then(result => { if (active) setSlots(result.slots.filter(slot => slot.available)); })
      .catch(cause => { if (active) setSlotsError(cause instanceof Error ? cause.message : 'Times could not be loaded.'); })
      .finally(() => { if (active) setSlotsLoading(false); });
    return () => { active = false; };
  }, [open, date, slotBusinessSlug, slotServiceId, slotInstructorId, slotLocationId]);

  // The chat may agree on a time between the usual grid steps. The server has
  // already checked the coach can teach then, so offer it alongside them.
  const suggestedStart = prefill && date === prefill.date
    && slotServiceId === prefill.option.serviceId && slotLocationId === prefill.option.locationId
    ? prefill.startAt : null;
  const choices = useMemo(() => {
    const base = slots.filter(slot => !counterTo || slot.startAt !== counterTo.startAt);
    if (!suggestedStart || prefill?.availability.status !== 'AVAILABLE' || slotsLoading
      || base.some(slot => Date.parse(slot.startAt) === Date.parse(suggestedStart))) return base;
    return [...base, { startAt: suggestedStart, endAt: suggestedStart, available: true, placesRemaining: 1 }]
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  }, [slots, counterTo, suggestedStart, prefill?.availability.status, slotsLoading]);

  useEffect(() => {
    if (!prefill || !suggestedStart || slotsLoading || prefillApplied.current === prefill.key) return;
    const match = choices.find(slot => Date.parse(slot.startAt) === Date.parse(suggestedStart));
    if (!match) return;
    prefillApplied.current = prefill.key;
    setSelected(match.startAt);
  }, [prefill, suggestedStart, slotsLoading, choices]);
  const today = dateKey(new Date(), zone);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const scheduling = !session && selectedOption ? {
        businessSlug: selectedOption.businessSlug,
        serviceId: selectedOption.serviceId,
        locationId: selectedOption.locationId,
      } : undefined;
      await onSubmit(selected, note.trim(), scheduling);
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
      <DialogTitle className="!mt-4 text-lg font-semibold text-[#263a30]">{counterTo ? 'Suggest a different time' : session ? 'Propose the next session' : 'Propose a session'}</DialogTitle>
      <DialogDescription className="!mt-2 text-xs leading-relaxed text-[#59675c]">
        {session
          ? <>{session.serviceName} with {session.instructorName} at {session.locationName}. Nothing is booked until{' '}
            {counterTo ? `${counterTo.proposedByYou ? 'the other side' : counterTo.proposedByName} accepts the new time` : 'the other side accepts'}.</>
          : <>Choose the club, class and location, then pick a time. Nothing is booked until the other person accepts.</>}
        {prefill && <> Filled in from your conversation; change anything before sending.</>}
      </DialogDescription>
      <form className="mt-5 space-y-4" onSubmit={submit}>
        {!session && <div className="space-y-3 rounded-2xl border border-[#e3e8df] bg-[#fafbf8] p-3.5">
          {schedulingOptions.length ? <>
            <div>
              <label htmlFor={businessId}>Club</label>
              <select id={businessId} value={businessSlug} disabled={submitting} onChange={event => {
                const option = schedulingOptions.find(candidate => candidate.businessSlug === event.target.value);
                setBusinessSlug(option?.businessSlug ?? '');
                setServiceId(option?.serviceId ?? '');
                setLocationId(option?.locationId ?? '');
              }}>
                {businesses.map(option => <option key={option.businessSlug} value={option.businessSlug}>{option.businessName}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={serviceSelectId}>Class</label>
              <select id={serviceSelectId} value={serviceId} disabled={submitting} onChange={event => {
                const option = schedulingOptions.find(candidate => candidate.businessSlug === businessSlug && candidate.serviceId === event.target.value);
                setServiceId(option?.serviceId ?? '');
                setLocationId(option?.locationId ?? '');
              }}>
                {services.map(option => <option key={option.serviceId} value={option.serviceId}>{option.serviceName}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={locationSelectId}>Location</label>
              <select id={locationSelectId} value={locationId} disabled={submitting} onChange={event => setLocationId(event.target.value)}>
                {locations.map(option => <option key={option.locationId} value={option.locationId}>{option.locationName}</option>)}
              </select>
            </div>
            {selectedOption && <p className="text-[11px] leading-relaxed text-[#59675c]">
              Coach {selectedOption.instructorName} · Times in SGT
              {Number.isFinite(selectedOption.price) && selectedOption.currency
                ? ` · ${selectedOption.price === 0 ? 'Free' : money(selectedOption.price!, selectedOption.currency)}`
                : ''}
            </p>}
          </> : <p role="alert" className="text-xs leading-relaxed text-[#8b4d3c]">There are no classes available to propose in this conversation.</p>}
        </div>}
        {session && selectedOption && Number.isFinite(selectedOption.price) && selectedOption.currency && <p className="rounded-xl bg-[#f5f7f1] p-3 text-xs font-semibold text-[#3f5f35]">
          Session price: {selectedOption.price === 0 ? 'Free' : money(selectedOption.price!, selectedOption.currency)}
        </p>}
        <div>
          <label htmlFor={dateId}>Date</label>
          <input id={dateId} type="date" min={today} value={date} onChange={event => setDate(event.target.value)} required disabled={submitting} />
        </div>
        <fieldset aria-describedby={timesId} className="min-w-0 border-0 p-0">
          <legend className="mb-2 text-[14px] font-semibold text-[#4d5e51]">Available times</legend>
          <p id={timesId} className="sr-only">Times are shown in Singapore time (SGT).</p>
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
          disabled={!selected || submitting || (!session && !selectedOption)}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#214e3e] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#173b2e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
          {counterTo ? 'Send new time' : 'Send proposal'}
        </button>
      </form>
    </DialogContent>
  </Dialog>;
}
