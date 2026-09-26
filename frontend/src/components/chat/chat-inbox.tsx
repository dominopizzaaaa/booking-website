'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  ArrowLeft,
  Bell,
  CalendarCheck2,
  CalendarClock,
  CalendarPlus,
  CalendarX2,
  Check,
  Info,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Undo2,
  UserRoundCheck,
  UserRoundMinus,
  UsersRound,
  X,
} from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';
import { toast } from 'sonner';
import {
  adminChatThread,
  adminChatThreads,
  counterChatProposal,
  loadChatThread,
  loadChatThreads,
  markChatRead,
  proposeChatSession,
  respondToChatProposal,
  sendChatMessage,
} from '@/lib/api';
import {
  chatBadge,
  chatListTime,
  chatMemberSummary,
  chatPreview,
  chatSessionLine,
  endsChatRun,
  groupChatDays,
  proposalResponseLabel,
  proposalStatusLine,
  proposalTone,
  startsChatRun,
} from '@/lib/chat';
import type {
  AccountType,
  ChatMessage,
  ChatProposalAction,
  ChatThreadDetail,
  ChatThreadSummary,
  SessionProposal,
} from '@/lib/types';
import { cn, initials, time } from '@/lib/utils';
import { ProposeSessionDialog } from './propose-session-dialog';

type ChatMode = 'participant' | 'admin';

export type ChatInboxProps = {
  mode: ChatMode;
  /** Who is reading; decides small copy such as whether to name the club. */
  viewerType: AccountType | 'ADMIN';
  threadId: string | null;
  onThreadChange: (threadId: string | null) => void;
  onUnreadChange?: (unreadThreads: number) => void;
  onOpenBooking?: (bookingId: string) => void;
  /** A session was booked, moved or cancelled from inside a chat. */
  onBookingsChanged?: () => void;
  className?: string;
  heading?: { eyebrow: string; title: string; description: string };
};

/** System lines that mean the reader's list of bookings is now out of date. */
const bookingEvents = new Set(['PROPOSAL_ACCEPTED', 'CANCELLED', 'RESCHEDULED']);

const listPollMs = 15_000;
const threadPollMs = 4_000;
const splitWidth = 880;

const roleLabel = { COACH: 'Coach', STUDENT: 'Student', CLUB: 'Club' } as const;

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

/** Whether the inbox has room to show the list beside the conversation. */
function useSplitLayout(ref: React.RefObject<HTMLElement | null>) {
  const [split, setSplit] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSplit(element.getBoundingClientRect().width >= splitWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return split;
}

function usePhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return phone;
}

function useVisiblePolling(callback: () => void, intervalMs: number, enabled = true) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') saved.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
}

function ThreadAvatar({ summary, size = 'md' }: { summary: Pick<ChatThreadSummary, 'session' | 'members'>; size?: 'md' | 'lg' }) {
  const other = summary.members.find(member => !member.isYou && member.role !== 'CLUB'
    && (summary.members.some(candidate => candidate.isYou && candidate.role === 'STUDENT') ? member.role === 'COACH' : member.role === 'STUDENT'));
  const group = summary.session.type === 'GROUP';
  return <span
    aria-hidden="true"
    className={cn(
      'grid shrink-0 place-items-center rounded-full font-semibold',
      size === 'lg' ? 'h-11 w-11 text-xs' : 'h-12 w-12 text-xs',
      group ? 'bg-[#e6eedd] text-[#4f6847]' : 'bg-[#e8dccc] text-[#6f5738]',
    )}
  >
    {group ? <UsersRound size={19} strokeWidth={1.7} /> : initials(other?.name ?? summary.session.serviceName)}
  </span>;
}

function ChatList({
  threads, selectedId, onSelect, search, onSearch, state, error, onRetry, hasMore, loadingMore, onLoadMore,
  viewerType, heading, nowMs,
}: {
  threads: ChatThreadSummary[];
  selectedId: string | null;
  onSelect: (threadId: string) => void;
  search: string;
  onSearch: (value: string) => void;
  state: 'loading' | 'ready' | 'error';
  error: string;
  onRetry: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  viewerType: ChatInboxProps['viewerType'];
  heading: NonNullable<ChatInboxProps['heading']>;
  nowMs: number;
}) {
  const searchId = useId();
  return <div className="chat-list-pane flex min-h-0 min-w-0 flex-col">
    <header className="chat-list-header">
      <p className="eyebrow">{heading.eyebrow}</p>
      <h1 className="!mt-1.5 text-[26px] font-semibold tracking-[-0.8px] text-[#263a30] sm:text-[29px]">{heading.title}</h1>
      <p className="!mt-1.5 text-xs leading-relaxed text-[#59675c]">{heading.description}</p>
      <div className="relative mt-4">
        <label htmlFor={searchId} className="sr-only">Search chats</label>
        <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#59675c]" />
        <input
          id={searchId}
          type="search"
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder={viewerType === 'ADMIN' ? 'Search club, class, coach or student' : 'Search class, coach or student'}
          className="!rounded-xl !pl-10"
          autoComplete="off"
        />
      </div>
    </header>
    <div className="chat-list-scroll mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-[#e3e8df] bg-white">
      {state === 'loading' && !threads.length ? <div role="status" className="flex items-center justify-center gap-2 p-10 text-xs text-[#59675c]"><Loader2 size={15} className="animate-spin" aria-hidden="true" />Loading chats…</div>
        : state === 'error' && !threads.length ? <div className="p-6 text-center">
          <p role="alert" className="text-xs leading-relaxed text-[#8b4d3c]">{error}</p>
          <button type="button" onClick={onRetry} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#dfe5df] px-4 text-xs font-semibold text-[#33443b] hover:bg-[#f2f5f1]"><RefreshCw size={13} aria-hidden="true" />Try again</button>
        </div>
          : !threads.length ? <div className="px-6 py-12 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#edf2e7] text-[#5f7a51]"><MessageCircle size={21} aria-hidden="true" /></span>
            <h2 className="!mt-4 text-sm font-semibold text-[#294735]">{search.trim() ? 'No chats match that search' : 'No chats yet'}</h2>
            <p className="!mx-auto !mt-2 max-w-xs text-xs leading-relaxed text-[#59675c]">
              {search.trim() ? 'Try a class, coach or student name.' : 'Every booked session gets its own chat with the coach, the students and the club.'}
            </p>
          </div>
            : <ul aria-label="Chats" className="divide-y divide-[#eef1ea]">
              {threads.map(thread => {
                const selected = thread.id === selectedId;
                const unread = thread.unreadCount > 0;
                const showClub = viewerType !== 'CLUB';
                return <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(thread.id)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'chat-list-item flex w-full items-center gap-3 px-4 py-3.5 text-left transition hover:bg-[#f7f9f4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#327a5a]',
                      selected && 'bg-[#eef3e9]',
                    )}
                  >
                    <ThreadAvatar summary={thread} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={cn('truncate text-sm text-[#263a30]', unread ? 'font-bold' : 'font-semibold')}>{thread.session.serviceName}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-[#59675c]">{chatListTime(thread.lastMessageAt, thread.session.timezone, nowMs)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-[#59675c]">
                        {chatSessionLine(thread.session)}{showClub ? ` · ${thread.session.businessName}` : ''}
                        {thread.session.status === 'CANCELLED' ? ' · Cancelled' : ''}
                      </span>
                      <span className={cn('mt-0.5 block truncate text-xs', unread ? 'font-semibold text-[#263a30]' : 'text-[#59675c]')}>
                        {chatPreview(thread.lastMessage)}
                      </span>
                      {typeof thread.messageCount === 'number' && <span className="mt-0.5 block text-[11px] text-[#59675c]">{thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}</span>}
                    </span>
                    {unread && <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-[#b3483a] px-1.5 text-[10px] font-bold leading-none text-white">
                      <span aria-hidden="true">{chatBadge(thread.unreadCount)}</span>
                      <span className="sr-only">{thread.unreadCount} unread message{thread.unreadCount === 1 ? '' : 's'}</span>
                    </span>}
                  </button>
                </li>;
              })}
            </ul>}
      {hasMore && <div className="border-t border-[#eef1ea] p-3">
        <button type="button" onClick={onLoadMore} disabled={loadingMore} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#dfe5df] text-xs font-semibold text-[#33443b] hover:bg-[#f2f5f1] disabled:opacity-60">
          {loadingMore && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}Show older chats
        </button>
      </div>}
    </div>
  </div>;
}

function systemAppearance(event: string | null) {
  switch (event) {
    case 'REMINDER': return { icon: Bell, tone: 'bg-[#f7efd9] text-[#6b5526]' };
    case 'PROPOSAL_ACCEPTED': return { icon: CalendarCheck2, tone: 'bg-[#e4eedb] text-[#3f5f35]' };
    case 'PROPOSAL_DECLINED':
    case 'PROPOSAL_WITHDRAWN':
    case 'CANCELLED': return { icon: CalendarX2, tone: 'bg-[#f6e6df] text-[#8a4f3c]' };
    case 'RESCHEDULED': return { icon: CalendarClock, tone: 'bg-[#f3ecd9] text-[#6f5c2b]' };
    case 'JOINED': return { icon: UserRoundCheck, tone: 'bg-[#eceeea] text-[#4d5e51]' };
    case 'LEFT': return { icon: UserRoundMinus, tone: 'bg-[#eceeea] text-[#4d5e51]' };
    default: return { icon: Info, tone: 'bg-[#eceeea] text-[#4d5e51]' };
  }
}

function SystemMessage({ message, timezone }: { message: ChatMessage; timezone: string }) {
  const { icon: Icon, tone } = systemAppearance(message.event);
  return <li className="flex justify-center px-2">
    <p className={cn('flex max-w-[min(92%,34rem)] items-start gap-2 rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed', tone)}>
      <Icon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        {message.body}
        <time dateTime={message.createdAt} className="mt-0.5 block text-[11px] font-medium">{time(message.createdAt, timezone)}</time>
      </span>
    </p>
  </li>;
}

function TextMessage({ message, timezone, showSender, showTime }: { message: ChatMessage; timezone: string; showSender: boolean; showTime: boolean }) {
  const role = message.senderRole === 'SYSTEM' ? null : roleLabel[message.senderRole];
  return <li className={cn('flex px-1', message.mine ? 'justify-end' : 'justify-start')}>
    <div className={cn('flex max-w-[82%] flex-col sm:max-w-[70%]', message.mine ? 'items-end' : 'items-start')}>
      {showSender && !message.mine && <p className="!mb-1 !ml-1 text-[11px] font-semibold text-[#4d5e51]">{message.senderName}{role && <span className="font-normal text-[#59675c]"> · {role}</span>}</p>}
      {message.mine && <span className="sr-only">You said:</span>}
      <p className={cn(
        'whitespace-pre-wrap break-words rounded-[20px] px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]',
        message.mine ? 'rounded-br-md bg-[#214e3e] text-white' : 'rounded-bl-md border border-[#e3e8df] bg-white text-[#263a30]',
      )}>{message.body}</p>
      {showTime && <time dateTime={message.createdAt} className={cn('mt-1 text-[11px] text-[#59675c]', message.mine ? 'mr-1' : 'ml-1')}>{time(message.createdAt, timezone)}</time>}
    </div>
  </li>;
}

function ProposalMessage({ message, proposal, busy, onAct, onCounter, onOpenBooking }: {
  message: ChatMessage;
  proposal: SessionProposal;
  busy: boolean;
  onAct: (proposal: SessionProposal, action: ChatProposalAction) => void;
  onCounter: (proposal: SessionProposal) => void;
  onOpenBooking?: (bookingId: string) => void;
}) {
  const zone = proposal.timezone;
  const summaryId = useId();
  const tone = proposalTone(proposal);
  const bookingId = proposal.responses.find(response => response.status === 'ACCEPTED' && response.bookingId
    && (response.forYou || !proposal.responses.some(candidate => candidate.forYou)))?.bookingId ?? null;
  const audience = proposal.forYou ? 'you' : proposal.forName ?? 'everyone in this class';
  return <li className={cn('flex px-1', message.mine ? 'justify-end' : 'justify-start')}>
    <article
      aria-labelledby={summaryId}
      className={cn(
        'chat-proposal w-full max-w-[22rem] overflow-hidden rounded-2xl border bg-white shadow-[0_6px_18px_rgba(29,57,43,0.06)]',
        tone === 'action' ? 'border-[#b9cfa9]' : 'border-[#e3e8df]',
      )}
    >
      <div className={cn('flex items-center gap-2 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[1.1px]', tone === 'action' ? 'bg-[#eef5e6] text-[#3f5f35]' : 'bg-[#f5f7f1] text-[#4d5e51]')}>
        <CalendarPlus size={14} aria-hidden="true" />
        {proposal.isCounter ? 'New time suggested' : 'Next session proposed'}
      </div>
      <div className="px-4 pb-3 pt-3">
        <h3 id={summaryId} className="text-base font-semibold leading-snug text-[#263a30]">
          {formatInTimeZone(proposal.startAt, zone, 'EEEE, d MMMM')}
          <span className="block text-sm font-medium text-[#33443b]">{time(proposal.startAt, zone)} – {time(proposal.endAt, zone)}</span>
        </h3>
        <p className="!mt-2 text-xs leading-relaxed text-[#59675c]">{proposal.serviceName} · {proposal.locationName} · {proposal.instructorName}</p>
        <p className="!mt-1 text-xs text-[#59675c]">From {proposal.proposedByYou ? 'you' : proposal.proposedByName} · for {audience}</p>
        {proposal.message && <p className="!mt-3 border-l-2 border-[#d9e3d2] pl-3 text-xs italic leading-relaxed text-[#4d5e51]">“{proposal.message}”</p>}
        <p className={cn(
          '!mt-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold',
          tone === 'action' ? 'bg-[#f8eed3] text-[#6b5526]' : tone === 'done' ? 'bg-[#e4eedb] text-[#3f5f35]' : tone === 'waiting' ? 'bg-[#eceeea] text-[#4d5e51]' : 'bg-[#f3eeea] text-[#6e5a4f]',
        )}>
          {tone === 'done' ? <Check size={12} aria-hidden="true" /> : tone === 'waiting' ? <Loader2 size={12} aria-hidden="true" /> : null}
          {proposalStatusLine(proposal)}
        </p>
        {proposal.forName === null && proposal.responses.length > 0 && <ul className="mt-2 space-y-1 text-[11px] text-[#59675c]" aria-label="Answers so far">
          {proposal.responses.map(response => <li key={`${response.studentName}-${response.createdAt}`}>{proposalResponseLabel(proposal, response)}</li>)}
        </ul>}
      </div>
      {(proposal.actions.accept || proposal.actions.withdraw || (bookingId && onOpenBooking)) && <div className="border-t border-[#eef1ea] p-3">
        {proposal.actions.accept && <div className="grid grid-cols-3 gap-2">
          <button type="button" disabled={busy} onClick={() => onAct(proposal, 'accept')} aria-describedby={summaryId}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-[#214e3e] px-2 text-xs font-semibold text-white transition hover:bg-[#173b2e] disabled:opacity-60">
            {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}Accept
          </button>
          <button type="button" disabled={busy} onClick={() => onAct(proposal, 'decline')} aria-describedby={summaryId}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[#dfe5df] bg-white px-2 text-xs font-semibold text-[#33443b] transition hover:bg-[#f2f5f1] disabled:opacity-60">
            <X size={14} aria-hidden="true" />Decline
          </button>
          <button type="button" disabled={busy} onClick={() => onCounter(proposal)} aria-describedby={summaryId}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[#dfe5df] bg-white px-2 text-xs font-semibold text-[#33443b] transition hover:bg-[#f2f5f1] disabled:opacity-60">
            <Pencil size={13} aria-hidden="true" />Edit
          </button>
        </div>}
        {proposal.actions.withdraw && <button type="button" disabled={busy} onClick={() => onAct(proposal, 'withdraw')} aria-describedby={summaryId}
          className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold text-[#6e5a4f] transition hover:bg-[#f7f2ee] disabled:opacity-60">
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Undo2 size={13} aria-hidden="true" />}Withdraw proposal
        </button>}
        {bookingId && onOpenBooking && <button type="button" onClick={() => onOpenBooking(bookingId)}
          className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[#dfe5df] px-3 text-xs font-semibold text-[#33443b] transition hover:bg-[#f2f5f1]">
          <CalendarCheck2 size={13} aria-hidden="true" />View booked session
        </button>}
      </div>}
    </article>
  </li>;
}

function ChatThreadPane({ threadId, mode, fullscreen, onBack, onUnreadChange, onActivity, onOpenBooking, onBookingsChanged }: {
  threadId: string;
  mode: ChatMode;
  fullscreen: boolean;
  onBack?: () => void;
  onUnreadChange?: (unreadThreads: number) => void;
  onActivity: (detail?: ChatThreadDetail) => void;
  onOpenBooking?: (bookingId: string) => void;
  onBookingsChanged?: () => void;
}) {
  const [detail, setDetail] = useState<ChatThreadDetail | null>(null);
  const [earlier, setEarlier] = useState<ChatMessage[]>([]);
  const [earlierHasMore, setEarlierHasMore] = useState<boolean | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { counterTo: SessionProposal | null }>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stickToBottom = useRef(true);
  const lastReadMessage = useRef<string | null>(null);
  const seenMessages = useRef<Set<string> | null>(null);
  const composerId = useId();
  const headingId = useId();

  const markRead = useCallback((latestId: string | null) => {
    if (mode !== 'participant' || !latestId || latestId === lastReadMessage.current) return;
    if (document.visibilityState !== 'visible') return;
    lastReadMessage.current = latestId;
    markChatRead(threadId).then(result => onUnreadChange?.(result.unreadThreads)).catch(() => {
      lastReadMessage.current = null;
    });
  }, [mode, threadId, onUnreadChange]);

  const apply = useCallback((next: ChatThreadDetail) => {
    // A booking made, moved or cancelled while the chat was open (by anyone)
    // arrives as a system line; the host app refreshes its bookings then.
    const seen = seenMessages.current;
    if (seen && next.messages.some(message => !seen.has(message.id) && message.event && bookingEvents.has(message.event))) {
      onBookingsChanged?.();
    }
    seenMessages.current = new Set([...(seen ?? []), ...next.messages.map(message => message.id)]);
    setDetail(next);
    setState('ready');
    markRead(next.messages.at(-1)?.id ?? null);
  }, [markRead, onBookingsChanged]);

  const load = useCallback(async (quiet = false) => {
    try {
      apply(mode === 'admin' ? await adminChatThread(threadId) : await loadChatThread(threadId));
    } catch (cause) {
      if (!quiet) {
        setState('error');
        setError(messageOf(cause));
      }
    }
  }, [apply, mode, threadId]);

  useEffect(() => {
    setDetail(null);
    setEarlier([]);
    setEarlierHasMore(null);
    setState('loading');
    setDraft('');
    stickToBottom.current = true;
    lastReadMessage.current = null;
    seenMessages.current = null;
    void load();
  // Reset only when a different conversation opens, not when callbacks
  // from the host are recreated.
  }, [threadId]);

  useVisiblePolling(() => { void load(true); }, mode === 'admin' ? 10_000 : threadPollMs);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  // Move focus into the conversation when it opens full screen, so keyboard
  // and screen-reader users land on the chat they chose.
  useEffect(() => {
    if (fullscreen && state === 'ready') headingRef.current?.focus({ preventScroll: true });
  }, [fullscreen, state]);

  const messages = useMemo(() => {
    if (!detail) return [];
    const seen = new Set(detail.messages.map(message => message.id));
    return [...earlier.filter(message => !seen.has(message.id)), ...detail.messages];
  }, [detail, earlier]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, state]);

  function trackScroll() {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  }

  async function loadEarlier() {
    const first = messages[0];
    if (!first || loadingEarlier) return;
    setLoadingEarlier(true);
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    try {
      const page = mode === 'admin' ? await adminChatThread(threadId, first.id) : await loadChatThread(threadId, first.id);
      stickToBottom.current = false;
      setEarlier(current => [...page.messages, ...current]);
      setEarlierHasMore(page.hasEarlier);
      window.requestAnimationFrame(() => {
        if (element) element.scrollTop = element.scrollHeight - previousHeight;
      });
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await sendChatMessage(threadId, body);
      setDraft('');
      if (composerRef.current) composerRef.current.style.height = '';
      stickToBottom.current = true;
      await load(true);
      onActivity();
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // On a keyboard, Enter sends and Shift+Enter starts a new line. Touch
    // keyboards keep Enter for new lines; the send button is right there.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
      && window.matchMedia('(pointer: fine)').matches) {
      event.preventDefault();
      void send();
    }
  }

  function resizeComposer(element: HTMLTextAreaElement) {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 144)}px`;
  }

  async function act(proposal: SessionProposal, action: ChatProposalAction) {
    if (busyProposalId) return;
    setBusyProposalId(proposal.id);
    try {
      const result = await respondToChatProposal(proposal.id, action);
      stickToBottom.current = true;
      apply(result.thread);
      onActivity(result.thread);
      toast.success(action === 'accept' ? 'Session booked. It’s on the calendar.' : action === 'decline' ? 'Proposal declined' : 'Proposal withdrawn');
    } catch (cause) {
      toast.error(messageOf(cause));
      void load(true);
    } finally {
      setBusyProposalId(null);
    }
  }

  async function submitProposal(startAt: string, message: string) {
    const counterTo = dialog?.counterTo ?? null;
    const result = counterTo
      ? await counterChatProposal(counterTo.id, startAt, message)
      : await proposeChatSession(threadId, startAt, message);
    stickToBottom.current = true;
    apply(result.thread);
    onActivity(result.thread);
    toast.success(counterTo ? 'New time sent' : 'Proposal sent');
  }

  if (state === 'loading' || !detail) {
    return <div className={cn('chat-thread-pane', fullscreen && 'chat-thread-fullscreen')}>
      {state === 'error'
        ? <div className="m-auto max-w-sm p-6 text-center">
          <p role="alert" className="text-sm leading-relaxed text-[#8b4d3c]">{error}</p>
          <div className="mt-4 flex justify-center gap-2">
            {onBack && <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#dfe5df] px-4 text-xs font-semibold text-[#33443b]"><ArrowLeft size={14} aria-hidden="true" />Back to chats</button>}
            <button type="button" onClick={() => { setState('loading'); void load(); }} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#214e3e] px-4 text-xs font-semibold text-white"><RefreshCw size={13} aria-hidden="true" />Try again</button>
          </div>
        </div>
        : <p role="status" className="!m-auto flex items-center gap-2 text-xs text-[#59675c]"><Loader2 size={15} className="animate-spin" aria-hidden="true" />Opening chat…</p>}
    </div>;
  }

  const { session } = detail;
  const zone = session.timezone;
  const days = groupChatDays(messages, zone);
  const canLoadEarlier = earlierHasMore ?? detail.hasEarlier;
  const statusBadge = session.status === 'CANCELLED' ? 'Cancelled' : session.status === 'COMPLETED' ? 'Completed' : session.status === 'PENDING' ? 'Pending' : null;

  return <div className={cn('chat-thread-pane', fullscreen && 'chat-thread-fullscreen')}>
    <header className="chat-thread-header flex items-center gap-2.5 border-b border-[#e6eae3] bg-white/95 px-3 py-2.5 backdrop-blur sm:px-4">
      {onBack && <button type="button" onClick={onBack} aria-label="Back to chats" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[#33443b] transition hover:bg-[#f2f5f1]">
        <ArrowLeft size={20} aria-hidden="true" />
      </button>}
      <ThreadAvatar summary={detail} size="lg" />
      <div className="min-w-0 flex-1">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="flex items-center gap-2 truncate text-sm font-semibold text-[#263a30] outline-none">
          <span className="truncate">{session.serviceName}</span>
          {statusBadge && <span className="badge shrink-0 !py-0.5">{statusBadge}</span>}
        </h2>
        <p className="truncate text-[11px] text-[#59675c]">{chatSessionLine(session)} · {session.locationName}</p>
        <p className="truncate text-[11px] text-[#59675c]">{chatMemberSummary(detail.members)}</p>
      </div>
      {onOpenBooking && mode === 'participant' && <button type="button" onClick={() => onOpenBooking(session.bookingId)}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[#dfe5df] px-3 text-xs font-semibold text-[#33443b] transition hover:bg-[#f2f5f1]">
        <CalendarClock size={14} aria-hidden="true" /><span className="max-[420px]:sr-only">Session</span>
      </button>}
    </header>

    <div ref={scrollRef} onScroll={trackScroll} className="chat-messages min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-4 sm:px-4">
      <p className="!mx-auto !mb-6 max-w-md text-balance text-center text-[11px] leading-relaxed text-[#59675c]">
        <LockKeyhole size={12} className="mr-1 inline-block align-[-1px]" aria-hidden="true" />
        Visible to the coach, the students and the club in this session, and to Courtly’s platform admins for safety.
      </p>
      {canLoadEarlier && <div className="mb-4 flex justify-center">
        <button type="button" onClick={() => void loadEarlier()} disabled={loadingEarlier} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[#dfe5df] bg-white px-4 text-xs font-semibold text-[#33443b] hover:bg-[#f2f5f1] disabled:opacity-60">
          {loadingEarlier && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}Load earlier messages
        </button>
      </div>}
      <div role="log" aria-labelledby={headingId} aria-live="polite" className="space-y-5">
        {days.map(dayGroup => <section key={dayGroup.key} aria-label={dayGroup.label}>
          <p className="!mb-3 text-center text-[11px] font-semibold uppercase tracking-[1.2px] text-[#59675c]" aria-hidden="true">{dayGroup.label}</p>
          <ol className="space-y-1.5">
            {dayGroup.messages.map((message, index) => {
              if (message.kind === 'SYSTEM') return <SystemMessage key={message.id} message={message} timezone={zone} />;
              if (message.kind === 'PROPOSAL' && message.proposal) {
                return <ProposalMessage key={message.id} message={message} proposal={message.proposal}
                  busy={busyProposalId === message.proposal.id}
                  onAct={(proposal, action) => void act(proposal, action)}
                  onCounter={proposal => setDialog({ counterTo: proposal })}
                  onOpenBooking={mode === 'participant' ? onOpenBooking : undefined} />;
              }
              return <TextMessage key={message.id} message={message} timezone={zone}
                showSender={startsChatRun(dayGroup.messages, index)} showTime={endsChatRun(dayGroup.messages, index)} />;
            })}
          </ol>
        </section>)}
      </div>
    </div>

    {detail.viewer.canPost ? <form onSubmit={event => void send(event)} className="chat-composer flex items-end gap-2 border-t border-[#e6eae3] bg-white px-2.5 pt-2.5 sm:px-3">
      {detail.viewer.canPropose && <button type="button" onClick={() => setDialog({ counterTo: null })} aria-label="Propose the next session" title="Propose the next session"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#e8efe0] text-[#214e3e] transition hover:bg-[#dce8d1]">
        <Plus size={21} strokeWidth={2.2} aria-hidden="true" />
      </button>}
      <label htmlFor={composerId} className="sr-only">Message</label>
      <textarea
        id={composerId}
        ref={composerRef}
        rows={1}
        value={draft}
        maxLength={2000}
        onChange={event => { setDraft(event.target.value); resizeComposer(event.target); }}
        onKeyDown={composerKeyDown}
        placeholder="Message…"
        className="chat-composer-input !min-h-11 flex-1 resize-none !rounded-[22px] !border-[#dfe5df] !bg-[#f7f8f5] !px-4 !py-2.5 text-sm leading-relaxed"
      />
      <button type="submit" disabled={!draft.trim() || sending} aria-label="Send message"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#214e3e] text-white transition hover:bg-[#173b2e] disabled:cursor-not-allowed disabled:opacity-40">
        {sending ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : <SendHorizontal size={18} aria-hidden="true" />}
      </button>
    </form>
      : <p className="chat-composer flex items-center justify-center gap-2 border-t border-[#e6eae3] bg-white px-3 pt-3 text-center text-xs text-[#59675c]">
        <LockKeyhole size={13} aria-hidden="true" />Read-only view for platform safety review
      </p>}

    {dialog && <ProposeSessionDialog
      open
      onOpenChange={open => { if (!open) setDialog(null); }}
      session={session}
      counterTo={dialog.counterTo}
      onSubmit={submitProposal}
    />}
  </div>;
}

const defaultHeading = {
  eyebrow: 'Session chats',
  title: 'Chats',
  description: 'One conversation for every session, with your coach, the students and the club.',
};

/**
 * Instagram-style inbox: the list and the open conversation sit side by side
 * where there is room, and on a phone the conversation takes the whole
 * screen with its own back button and composer.
 */
export function ChatInbox({
  mode, viewerType, threadId, onThreadChange, onUnreadChange, onOpenBooking, onBookingsChanged, className,
  heading = defaultHeading,
}: ChatInboxProps) {
  const rootRef = useRef<HTMLElement>(null);
  const split = useSplitLayout(rootRef);
  const phone = usePhone();
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestRef = useRef(0);

  const loadList = useCallback(async (query: string, quiet = false) => {
    const request = ++requestRef.current;
    if (!quiet) setState(current => (current === 'ready' ? current : 'loading'));
    try {
      const result = mode === 'admin' ? await adminChatThreads({ q: query }) : await loadChatThreads({ q: query });
      if (request !== requestRef.current) return;
      setNowMs(Date.now());
      setThreads(current => {
        // Keep older pages the reader already opened below the fresh first page.
        const fresh = new Set(result.threads.map(thread => thread.id));
        return quiet ? [...result.threads, ...current.filter(thread => !fresh.has(thread.id))] : result.threads;
      });
      if (!quiet) setNextCursor(result.nextCursor);
      setState('ready');
      if (typeof result.unreadThreads === 'number') onUnreadChange?.(result.unreadThreads);
    } catch (cause) {
      if (request !== requestRef.current) return;
      if (!quiet) {
        setError(messageOf(cause));
        setState('error');
      }
    }
  }, [mode, onUnreadChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadList(search); }, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [loadList, search]);

  useVisiblePolling(() => { void loadList(search, true); }, listPollMs);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = mode === 'admin'
        ? await adminChatThreads({ q: search, cursor: nextCursor })
        : await loadChatThreads({ q: search, cursor: nextCursor });
      setThreads(current => [...current, ...result.threads.filter(thread => !current.some(existing => existing.id === thread.id))]);
      setNextCursor(result.nextCursor);
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  // Reading a thread clears its row straight away instead of waiting for the
  // next list poll, and a new message moves the thread to the top.
  const handleActivity = useCallback((detail?: ChatThreadDetail) => {
    if (detail) {
      setThreads(current => current.map(thread => thread.id === detail.id
        ? { ...thread, unreadCount: 0, lastMessageAt: detail.lastMessageAt, lastMessage: detail.messages.at(-1) ?? thread.lastMessage }
        : thread));
    }
    void loadList(search, true);
  }, [loadList, search]);

  const handleUnread = useCallback((count: number) => {
    onUnreadChange?.(count);
    setThreads(current => current.map(thread => thread.id === threadId ? { ...thread, unreadCount: 0 } : thread));
  }, [onUnreadChange, threadId]);

  const fullscreen = phone && !!threadId;
  useEffect(() => {
    if (!fullscreen) return;
    // The shell's own bars step aside while a conversation fills the phone,
    // the way a messaging app hides its tab bar inside a thread.
    document.body.dataset.chatThreadOpen = 'true';
    return () => { delete document.body.dataset.chatThreadOpen; };
  }, [fullscreen]);

  const showList = split || !threadId;
  const showThread = split || !!threadId;

  return <section ref={rootRef} aria-label={heading.title} className={cn('chat-inbox', split ? 'chat-inbox-split' : 'chat-inbox-single', className)}>
    {showList && <ChatList
      threads={threads}
      selectedId={threadId}
      onSelect={onThreadChange}
      search={search}
      onSearch={setSearch}
      state={state}
      error={error}
      onRetry={() => void loadList(search)}
      hasMore={!!nextCursor}
      loadingMore={loadingMore}
      onLoadMore={() => void loadMore()}
      viewerType={viewerType}
      heading={heading}
      nowMs={nowMs}
    />}
    {showThread && (threadId
      ? <ChatThreadPane
        key={threadId}
        threadId={threadId}
        mode={mode}
        fullscreen={fullscreen}
        onBack={split ? undefined : () => onThreadChange(null)}
        onUnreadChange={handleUnread}
        onActivity={handleActivity}
        onOpenBooking={onOpenBooking}
        onBookingsChanged={onBookingsChanged}
      />
      : <div className="chat-thread-pane chat-thread-empty items-center justify-center p-8 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-[#edf2e7] text-[#5f7a51]"><MessageCircle size={24} aria-hidden="true" /></span>
        <h2 className="!mt-4 text-sm font-semibold text-[#294735]">Pick a chat</h2>
        <p className="!mt-2 max-w-xs text-xs leading-relaxed text-[#59675c]">
          {mode === 'admin'
            ? 'Choose a conversation to read it. The admin view is read-only.'
            : 'Message your session, and use + in a chat to propose your next session.'}
        </p>
      </div>)}
  </section>;
}
