'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Loader2, ShieldCheck, UserRoundMinus, UsersRound } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { assignChatCoach, removeChatCoach } from '@/lib/api';
import type { ChatAssignableCoach, ChatConversation, ChatThreadDetail } from '@/lib/types';
import { initials } from '@/lib/utils';

type PendingChange =
  | { kind: 'assign'; coach: ChatAssignableCoach }
  | { kind: 'remove'; name: string };

type ManageConversationCoachDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threadId: string;
  conversation: ChatConversation;
  onUpdated: (thread: ChatThreadDetail) => void;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Coach access could not be changed. Please try again.';
}

export function ManageConversationCoachDialog({
  open, onOpenChange, threadId, conversation, onUpdated,
}: ManageConversationCoachDialogProps) {
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const confirmationRef = useRef<HTMLHeadingElement>(null);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const originKey = useRef<string | null>(null);
  const restoreOrigin = useRef(false);
  const lifecycle = useRef(0);
  const assigned = conversation.assignedCoach;
  const choices = (conversation.assignableCoaches ?? []).filter(coach => coach.username !== assigned?.username);

  useEffect(() => {
    if (!open) return;
    setPending(null);
    setSaving(false);
    setError('');
    originKey.current = null;
    restoreOrigin.current = false;
  }, [open, conversation.assignedCoach?.username]);

  useEffect(() => {
    const generation = ++lifecycle.current;
    return () => {
      if (lifecycle.current === generation) lifecycle.current += 1;
    };
  }, [threadId]);

  useLayoutEffect(() => {
    if (pending) confirmationRef.current?.focus({ preventScroll: true });
    else if (restoreOrigin.current) {
      restoreOrigin.current = false;
      if (originKey.current) actionRefs.current.get(originKey.current)?.focus({ preventScroll: true });
    }
  }, [pending]);

  function setActionRef(key: string, element: HTMLButtonElement | null) {
    if (element) actionRefs.current.set(key, element);
    else actionRefs.current.delete(key);
  }

  function askForConfirmation(change: PendingChange, key: string) {
    originKey.current = key;
    setError('');
    setPending(change);
  }

  function returnToChoices() {
    restoreOrigin.current = true;
    setPending(null);
    setError('');
  }

  async function confirm() {
    if (!pending || saving) return;
    const generation = lifecycle.current;
    setSaving(true);
    setError('');
    try {
      const result = pending.kind === 'remove'
        ? await removeChatCoach(threadId)
        : await assignChatCoach(threadId, pending.coach.membershipId);
      if (generation !== lifecycle.current) return;
      onUpdated(result.thread);
      onOpenChange(false);
    } catch (cause) {
      if (generation === lifecycle.current) setError(messageOf(cause));
    } finally {
      if (generation === lifecycle.current) setSaving(false);
    }
  }

  return <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next); }}>
    <DialogContent
      className="max-w-md"
      onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus({ preventScroll: true }); }}
      onEscapeKeyDown={event => { if (saving) event.preventDefault(); }}
    >
      <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#e8efe0] text-[#214e3e]"><UsersRound size={20} aria-hidden="true" /></span>
      <DialogTitle ref={titleRef} tabIndex={-1} className="!mt-4 text-lg font-semibold text-[#263a30] outline-none">Manage conversation coach</DialogTitle>
      <DialogDescription className="!mt-2 text-xs leading-relaxed text-[#59675c]">
        Choose the one coach who can join this conversation between your club and the student.
      </DialogDescription>

      {pending ? <div className="mt-5">
        <div className="rounded-2xl border border-[#d9e3d2] bg-[#f5f8f2] p-4">
          <ShieldCheck size={20} className="text-[#4f6847]" aria-hidden="true" />
          <h3 ref={confirmationRef} tabIndex={-1} className="!mt-3 text-sm font-semibold text-[#294735] outline-none">
            {pending.kind === 'remove' ? `Remove ${pending.name}?` : assigned ? `Replace ${assigned.name} with ${pending.coach.name}?` : `Add ${pending.coach.name}?`}
          </h3>
          <p className="!mt-2 text-xs leading-relaxed text-[#59675c]">
            {pending.kind === 'remove'
              ? `${pending.name} will lose access to this conversation. The existing messages remain visible to the club and student.`
              : `${pending.coach.name} will be able to read the full conversation history, including every message sent before they joined.${assigned ? ` ${assigned.name} will lose access.` : ''}`}
          </p>
          <p role="status" aria-live="polite" className="sr-only">
            {pending.kind === 'remove'
              ? `Confirm removal of ${pending.name}.`
              : `Confirm ${pending.coach.name} can read the full conversation history.`}
          </p>
        </div>
        {error && <p role="alert" className="!mt-3 rounded-xl border border-[#eedbd4] bg-[#fff6f1] p-3 text-xs leading-relaxed text-[#8b4d3c]">{error}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={returnToChoices} disabled={saving}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#dfe5df] px-3 text-xs font-semibold text-[#33443b] hover:bg-[#f2f5f1] disabled:opacity-60">
            <ArrowLeft size={14} aria-hidden="true" />Back
          </button>
          <button type="button" onClick={() => void confirm()} disabled={saving}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#214e3e] px-3 text-xs font-semibold text-white hover:bg-[#173b2e] disabled:opacity-60">
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            {pending.kind === 'remove' ? 'Remove coach' : assigned ? 'Replace coach' : 'Add coach'}
          </button>
        </div>
      </div> : <div className="mt-5 space-y-4">
        <section aria-labelledby="current-conversation-coach">
          <h3 id="current-conversation-coach" className="text-xs font-semibold uppercase tracking-[1px] text-[#59675c]">Current coach</h3>
          {assigned ? <div className="mt-2 flex items-center gap-3 rounded-xl border border-[#dfe5df] p-3">
            <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#e8dccc] text-xs font-semibold text-[#6f5738]">{initials(assigned.name)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[#263a30]">{assigned.name}</span>
              <span className="block truncate text-xs text-[#59675c]">@{assigned.username}</span>
            </span>
            <button ref={element => setActionRef(`remove:${assigned.username}`, element)} type="button"
              onClick={() => askForConfirmation({ kind: 'remove', name: assigned.name }, `remove:${assigned.username}`)}
              aria-label={`Remove ${assigned.name} from conversation`}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-[#8b4d3c] hover:bg-[#fff3ee]">
              <UserRoundMinus size={14} aria-hidden="true" /><span className="max-[390px]:sr-only">Remove</span>
            </button>
          </div> : <p className="!mt-2 rounded-xl bg-[#f5f7f1] p-3 text-xs leading-relaxed text-[#59675c]">No coach can currently read or reply to this conversation.</p>}
        </section>

        <section aria-labelledby="available-conversation-coaches">
          <h3 id="available-conversation-coaches" className="text-xs font-semibold uppercase tracking-[1px] text-[#59675c]">{assigned ? 'Replace with' : 'Choose a coach'}</h3>
          <p className="!mt-1.5 text-[11px] leading-relaxed text-[#59675c]">You will confirm history access before the coach is added.</p>
          {choices.length ? <ul className="mt-2 max-h-[min(42dvh,20rem)] space-y-2 overflow-y-auto overscroll-contain pr-1">
            {choices.map(coach => <li key={coach.membershipId}>
              <button ref={element => setActionRef(`assign:${coach.membershipId}`, element)} type="button"
                onClick={() => askForConfirmation({ kind: 'assign', coach }, `assign:${coach.membershipId}`)}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-[#e1e6df] px-3 py-2 text-left transition hover:border-[#bdcab8] hover:bg-[#f7f9f4]">
                <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#e8dccc] text-xs font-semibold text-[#6f5738]">{initials(coach.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[#263a30]">{coach.name}</span>
                  <span className="block truncate text-xs text-[#59675c]">@{coach.username}{coach.sports.length ? ` · ${coach.sports.join(', ')}` : ''}</span>
                </span>
                <span className="shrink-0 text-xs font-semibold text-[#214e3e]">Choose</span>
              </button>
            </li>)}
          </ul> : <p className="!mt-2 rounded-xl bg-[#f5f7f1] p-3 text-xs leading-relaxed text-[#59675c]">No other active coaches are available.</p>}
        </section>
        {error && <p role="alert" className="rounded-xl border border-[#eedbd4] bg-[#fff6f1] p-3 text-xs leading-relaxed text-[#8b4d3c]">{error}</p>}
      </div>}
    </DialogContent>
  </Dialog>;
}
