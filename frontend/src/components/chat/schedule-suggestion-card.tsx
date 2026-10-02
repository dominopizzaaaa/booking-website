'use client';

import { useId } from 'react';
import { CalendarClock, Send, X } from 'lucide-react';
import { scheduleSuggestionSummary } from '@/lib/chat';
import type { ChatScheduleSuggestion } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The session the conversation seems to be arranging, offered as a shortcut
 * into the proposal dialog. Both people see it; dismissing hides it only for
 * the reader, and only until the plan changes.
 */
export function ScheduleSuggestionCard({ suggestion, disabled, onPropose, onDismiss }: {
  suggestion: ChatScheduleSuggestion;
  disabled: boolean;
  onPropose: () => void;
  onDismiss: () => void;
}) {
  const headingId = useId();
  const summary = scheduleSuggestionSummary(suggestion);
  const unavailable = suggestion.availability.status === 'UNAVAILABLE';
  return <section aria-labelledby={headingId} data-testid="chat-schedule-suggestion"
    className="chat-schedule-suggestion mx-2.5 mb-2 shrink-0 rounded-2xl border border-[#dfe5df] bg-[#f5f8f2] p-3 sm:mx-3">
    <div className="flex items-start gap-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#e8efe0] text-[#214e3e]">
        <CalendarClock size={17} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="text-[11px] font-semibold uppercase tracking-[1px] text-[#59675c]">Sounds like you’re planning a session</h3>
        <p className="!mt-0.5 text-sm font-semibold text-[#263a30]">{summary.when}</p>
        <p className="!mt-0.5 text-[11px] leading-relaxed text-[#59675c]">{suggestion.option.serviceName} · {summary.where}</p>
        {summary.lengthNote && <p className="!mt-0.5 text-[11px] leading-relaxed text-[#59675c]">{summary.lengthNote}</p>}
        {summary.availability && <p className={cn('!mt-1 text-[11px] font-semibold', unavailable ? 'text-[#8b4d3c]' : 'text-[#3f5f35]')}>
          {summary.availability}
        </p>}
      </div>
      <button type="button" onClick={onDismiss} disabled={disabled} aria-label="Dismiss suggested session"
        className="-mr-1.5 -mt-1.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-[#59675c] transition hover:bg-[#e8efe0] disabled:opacity-60">
        <X size={16} aria-hidden="true" />
      </button>
    </div>
    <button type="button" onClick={onPropose} disabled={disabled}
      className="mt-2.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#214e3e] px-4 text-xs font-semibold text-white transition hover:bg-[#173b2e] disabled:opacity-60">
      <Send size={14} aria-hidden="true" />{unavailable ? 'Choose another time' : 'Propose this time'}
    </button>
  </section>;
}
