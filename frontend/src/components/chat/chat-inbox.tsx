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
  Flag,
  Info,
  Loader2,
  LockKeyhole,
  MessageCircle,
  MessageCirclePlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SendHorizontal,
  Settings2,
  Undo2,
  UserRoundCheck,
  UserRoundMinus,
  UserRoundX,
  UsersRound,
  X,
} from 'lucide-react';
import { formatInTimeZone } from 'date-fns-tz';
import { toast } from 'sonner';
import {
  ApiError,
  adminChatThread,
  adminChatThreads,
  blockChatAccount,
  counterChatProposal,
  loadChatThread,
  loadChatThreads,
  markChatRead,
  proposeChatSession,
  reportChatMessage,
  respondToChatProposal,
  sendChatMessage,
  unblockChatAccount,
} from '@/lib/api';
import {
  chatBadge,
  blockedComposerMessage,
  chatListTime,
  chatMemberSummary,
  chatPreview,
  chatSessionLine,
  chatThreadAvatar,
  chatThreadSubtitle,
  chatThreadTimezone,
  chatThreadTitle,
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
  ChatProposalSchedulingChoice,
  ChatProposalAction,
  ChatThreadDetail,
  ChatThreadSummary,
  SessionProposal,
} from '@/lib/types';
import { cn, initials, money, time } from '@/lib/utils';
import { ManageConversationCoachDialog } from './manage-conversation-coach-dialog';
import { NewConversationDialog } from './new-conversation-dialog';
import { ProposeSessionDialog } from './propose-session-dialog';
import { BlockAccountDialog } from '@/components/safeguarding/block-account-dialog';
import { ReportMessageDialog } from '@/components/safeguarding/report-message-dialog';
import { Disclosure } from '@/components/ui/progressive-disclosure';

type ChatMode = 'participant' | 'admin';

export type ChatInboxProps = {
  mode: ChatMode;
  /** Who is reading; decides small copy such as whether to name the club. */
  viewerType: AccountType | 'ADMIN';
  /** Optional during rolling deploys where older auth payloads lack usernames. */
  viewerUsername?: string;
  threadId: string | null;
  onThreadChange: (threadId: string | null) => void;
  /** Sequence an unread-producing request before it starts. */
  beginUnreadRequest?: () => (unreadThreads: number) => void;
  /** Commit a completed mark-read result over any older in-flight poll. */
  commitUnreadNow?: (unreadThreads: number) => void;
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

function accessWasRevoked(error: unknown) {
  return error instanceof ApiError && (error.status === 403 || error.status === 404);
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

function ThreadAvatar({ summary, size = 'md' }: { summary: ChatThreadSummary | ChatThreadDetail; size?: 'md' | 'lg' }) {
  const avatar = chatThreadAvatar(summary);
  const group = avatar.kind === 'group';
  return <span
    aria-hidden="true"
    className={cn(
      'grid shrink-0 place-items-center rounded-full font-semibold',
      size === 'lg' ? 'h-11 w-11 text-xs' : 'h-12 w-12 text-xs',
      group ? 'bg-[#e6eedd] text-[#4f6847]' : 'bg-[#e8dccc] text-[#6f5738]',
    )}
  >
    {group ? <UsersRound size={19} strokeWidth={1.7} /> : initials(avatar.label)}
  </span>;
}

function accountMemberSummary(members: ChatThreadSummary['members']) {
  return members.map(member => {
    if (member.isYou) return `You (${roleLabel[member.role]})`;
    if (member.role === 'COACH') return `Coach ${member.name}${member.assigned ? ' (assigned)' : ''}`;
    return `${member.name} (${roleLabel[member.role]})`;
  }).join(' · ');
}

function ChatList({
  threads, selectedId, onSelect, search, onSearch, state, error, onRetry, hasMore, loadingMore, onLoadMore,
  viewerType, heading, nowMs, onNewConversation, onThreadButtonRef,
  headingRef,
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
  onNewConversation?: () => void;
  onThreadButtonRef: (threadId: string, element: HTMLButtonElement | null) => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const searchId = useId();
  return <div className="chat-list-pane flex min-h-0 min-w-0 flex-col">
    <header className="chat-list-header">
      <p className="eyebrow">{heading.eyebrow}</p>
      <h1 ref={headingRef} tabIndex={-1} className="!mt-1.5 text-[26px] font-semibold tracking-[-0.8px] text-[#263a30] outline-none sm:text-[29px]">{heading.title}</h1>
      <p className="!mt-1.5 text-xs leading-relaxed text-[#59675c]">{heading.description}</p>
      {onNewConversation && <button
        type="button"
        onClick={onNewConversation}
        className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#214e3e] px-4 text-xs font-semibold text-white transition hover:bg-[#173b2e]"
      >
        <MessageCirclePlus size={16} aria-hidden="true" />New conversation
      </button>}
      <div className="relative mt-4">
        <label htmlFor={searchId} className="sr-only">Filter conversations</label>
        <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#59675c]" />
        <input
          id={searchId}
          type="search"
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder={viewerType === 'ADMIN' ? 'Filter by club, class or person' : 'Filter your conversations'}
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
            <h2 className="!mt-4 text-sm font-semibold text-[#294735]">{search.trim() ? 'No conversations match that filter' : 'No conversations yet'}</h2>
            <p className="!mx-auto !mt-2 max-w-xs text-xs leading-relaxed text-[#59675c]">
              {search.trim() ? 'Try a class, club or person name.' : onNewConversation ? 'Start a conversation with a student, coach or club.' : 'Conversations appear here when people start messaging.'}
            </p>
            {!search.trim() && onNewConversation && <button type="button" onClick={onNewConversation}
              className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#cbd7c5] bg-white px-4 text-xs font-semibold text-[#214e3e] hover:bg-[#f5f8f2]">
              <MessageCirclePlus size={15} aria-hidden="true" />New conversation
            </button>}
          </div>
            : <ul aria-label="Chats" className="divide-y divide-[#eef1ea]">
              {threads.map(thread => {
                const selected = thread.id === selectedId;
                const unread = thread.unreadCount > 0;
                const showClub = viewerType !== 'CLUB';
                const directMembers = thread.members.filter(member => !member.assigned);
                const title = viewerType === 'ADMIN' && thread.kind === 'ACCOUNT'
                  ? directMembers.map(member => member.name).join(' & ') || chatThreadTitle(thread)
                  : chatThreadTitle(thread);
                const subtitle = chatThreadSubtitle(thread, showClub);
                const timezone = chatThreadTimezone(thread);
                return <li key={thread.id}>
                  <button
                    ref={element => onThreadButtonRef(thread.id, element)}
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
                        <span className={cn('truncate text-sm text-[#263a30]', unread ? 'font-bold' : 'font-semibold')}>{title}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-[#59675c]">{chatListTime(thread.lastMessageAt, timezone, nowMs)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-[#59675c]">
                        {subtitle}
                      </span>
                      <span className={cn('mt-0.5 block truncate text-xs', unread ? 'font-semibold text-[#263a30]' : 'text-[#59675c]')}>
                        {chatPreview(thread.lastMessage)}
                      </span>
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

function MessageReportButton({ message, onReport }: { message: ChatMessage; onReport: (message: ChatMessage) => void }) {
  if (!message.canReport && !message.reportedByViewer) return null;
  return <button
    type="button"
    disabled={message.reportedByViewer}
    onClick={() => onReport(message)}
    aria-label={message.reportedByViewer ? `Message from ${message.senderName} reported` : `Report message from ${message.senderName}`}
    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold text-[#6c5a52] transition hover:bg-[#f7f2ee] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8f4938] focus-visible:ring-offset-2 disabled:text-[#788079]"
  >
    <Flag size={13} aria-hidden="true" />{message.reportedByViewer ? 'Reported' : 'Report'}
  </button>;
}

function TextMessage({ message, timezone, showSender, showTime, onReport }: { message: ChatMessage; timezone: string; showSender: boolean; showTime: boolean; onReport: (message: ChatMessage) => void }) {
  const role = message.senderRole === 'SYSTEM' ? null : roleLabel[message.senderRole];
  return <li className={cn('flex px-1', message.mine ? 'justify-end' : 'justify-start')}>
    <div className={cn('flex max-w-[82%] flex-col sm:max-w-[70%]', message.mine ? 'items-end' : 'items-start')}>
      {showSender && !message.mine && <p className="!mb-1 !ml-1 text-[11px] font-semibold text-[#4d5e51]">{message.senderName}{role && <span className="font-normal text-[#59675c]"> · {role}</span>}</p>}
      {message.mine && <span className="sr-only">You said:</span>}
      <p className={cn(
        'whitespace-pre-wrap break-words rounded-[20px] px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]',
        message.mine ? 'rounded-br-md bg-[#214e3e] text-white' : 'rounded-bl-md border border-[#e3e8df] bg-white text-[#263a30]',
      )}>{message.body}</p>
      {(showTime || message.canReport || message.reportedByViewer) && <div className={cn('flex min-h-11 items-center gap-1', message.mine ? 'mr-1' : 'ml-1')}>
        {showTime && <time dateTime={message.createdAt} className="text-[11px] text-[#59675c]">{time(message.createdAt, timezone)}</time>}
        <MessageReportButton message={message} onReport={onReport} />
      </div>}
    </div>
  </li>;
}

function ProposalMessage({ message, proposal, busy, onAct, onCounter, onOpenBooking, onReport }: {
  message: ChatMessage;
  proposal: SessionProposal;
  busy: boolean;
  onAct: (proposal: SessionProposal, action: ChatProposalAction) => void;
  onCounter: (proposal: SessionProposal) => void;
  onOpenBooking?: (bookingId: string) => void;
  onReport: (message: ChatMessage) => void;
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
        {typeof proposal.price === 'number' && Number.isFinite(proposal.price) && proposal.currency && <p className="!mt-1 text-xs font-semibold text-[#3f5f35]">{proposal.price === 0 ? 'Free' : money(proposal.price, proposal.currency)}</p>}
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
      {(proposal.actions.accept || proposal.actions.withdraw || (bookingId && onOpenBooking) || message.canReport || message.reportedByViewer) && <div className="border-t border-[#eef1ea] p-3">
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
        {(message.canReport || message.reportedByViewer) && <div className="mt-1 flex justify-end"><MessageReportButton message={message} onReport={onReport} /></div>}
      </div>}
    </article>
  </li>;
}

function ChatThreadPane({ threadId, mode, fullscreen, singlePane, onBack, beginUnreadRequest, commitUnreadNow, onRead, onRevoked, onActivity, onOpenBooking, onBookingsChanged }: {
  threadId: string;
  mode: ChatMode;
  fullscreen: boolean;
  singlePane: boolean;
  onBack?: () => void;
  beginUnreadRequest?: () => (unreadThreads: number) => void;
  commitUnreadNow?: (unreadThreads: number) => void;
  onRead: (threadId: string) => void;
  onRevoked: (threadId: string) => void;
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
  const [coachDialogOpen, setCoachDialogOpen] = useState(false);
  const [reportMessage, setReportMessage] = useState<ChatMessage | null>(null);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stickToBottom = useRef(true);
  const lastReadMessage = useRef<string | null>(null);
  const seenMessages = useRef<Set<string> | null>(null);
  const lifecycle = useRef(0);
  const contentGeneration = useRef(0);
  const latestLoad = useRef(0);
  const latestEarlier = useRef(0);
  const latestMutation = useRef(0);
  const mutationInFlight = useRef(false);
  const composerId = useId();
  const headingId = useId();

  function invalidateContentRequests() {
    contentGeneration.current += 1;
    latestLoad.current += 1;
    latestEarlier.current += 1;
    setLoadingEarlier(false);
    return lifecycle.current;
  }

  function beginMutation() {
    if (mutationInFlight.current) return null;
    mutationInFlight.current = true;
    return { lifecycle: invalidateContentRequests(), mutation: ++latestMutation.current };
  }

  function mutationIsCurrent(operation: { lifecycle: number; mutation: number }) {
    return operation.lifecycle === lifecycle.current && operation.mutation === latestMutation.current;
  }

  const revokeAccess = useCallback((cause: unknown) => {
    if (mode !== 'participant' || !accessWasRevoked(cause)) return false;
    contentGeneration.current += 1;
    latestLoad.current += 1;
    latestEarlier.current += 1;
    setLoadingEarlier(false);
    setDetail(null);
    setEarlier([]);
    setEarlierHasMore(null);
    setDraft('');
    setDialog(null);
    setCoachDialogOpen(false);
    setReportMessage(null);
    setBlockDialogOpen(false);
    setBlockBusy(false);
    setSending(false);
    setBusyProposalId(null);
    lastReadMessage.current = null;
    seenMessages.current = null;
    onRevoked(threadId);
    return true;
  }, [mode, onRevoked, threadId]);

  const markRead = useCallback((latestId: string | null) => {
    if (mode !== 'participant' || !latestId || latestId === lastReadMessage.current) return;
    if (document.visibilityState !== 'visible') return;
    lastReadMessage.current = latestId;
    const activeLifecycle = lifecycle.current;
    const commitUnread = beginUnreadRequest?.();
    markChatRead(threadId).then(result => {
      if (commitUnreadNow) commitUnreadNow(result.unreadThreads);
      else commitUnread?.(result.unreadThreads);
      if (activeLifecycle === lifecycle.current) onRead(threadId);
    }).catch(cause => {
      if (activeLifecycle !== lifecycle.current) return;
      if (revokeAccess(cause)) return;
      if (lastReadMessage.current === latestId) lastReadMessage.current = null;
    });
  }, [beginUnreadRequest, commitUnreadNow, mode, onRead, revokeAccess, threadId]);

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
    const activeLifecycle = lifecycle.current;
    const generation = contentGeneration.current;
    const request = ++latestLoad.current;
    try {
      const next = mode === 'admin' ? await adminChatThread(threadId) : await loadChatThread(threadId);
      if (activeLifecycle !== lifecycle.current || generation !== contentGeneration.current || request !== latestLoad.current) return;
      apply(next);
    } catch (cause) {
      if (activeLifecycle !== lifecycle.current || generation !== contentGeneration.current || request !== latestLoad.current) return;
      if (revokeAccess(cause)) return;
      if (!quiet) {
        setState('error');
        setError(messageOf(cause));
      }
    }
  }, [apply, mode, revokeAccess, threadId]);

  useEffect(() => {
    lifecycle.current += 1;
    contentGeneration.current += 1;
    latestLoad.current += 1;
    latestEarlier.current += 1;
    mutationInFlight.current = false;
    setDetail(null);
    setEarlier([]);
    setEarlierHasMore(null);
    setState('loading');
    setDraft('');
    stickToBottom.current = true;
    lastReadMessage.current = null;
    seenMessages.current = null;
    void load();
    return () => {
      lifecycle.current += 1;
      contentGeneration.current += 1;
      latestLoad.current += 1;
      latestEarlier.current += 1;
    };
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

  // Move focus into any single-pane conversation, including the 768–879px
  // range where the list is replaced even though the phone chrome stays.
  useEffect(() => {
    if (singlePane && state === 'ready') headingRef.current?.focus({ preventScroll: true });
  }, [singlePane, state, threadId]);

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
    const activeLifecycle = lifecycle.current;
    const generation = contentGeneration.current;
    const request = ++latestEarlier.current;
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    try {
      const page = mode === 'admin' ? await adminChatThread(threadId, first.id) : await loadChatThread(threadId, first.id);
      if (activeLifecycle !== lifecycle.current || generation !== contentGeneration.current || request !== latestEarlier.current) return;
      stickToBottom.current = false;
      setEarlier(current => [...page.messages, ...current]);
      setEarlierHasMore(page.hasEarlier);
      window.requestAnimationFrame(() => {
        if (activeLifecycle === lifecycle.current && generation === contentGeneration.current && element) {
          element.scrollTop = element.scrollHeight - previousHeight;
        }
      });
    } catch (cause) {
      if (activeLifecycle === lifecycle.current && generation === contentGeneration.current && request === latestEarlier.current
        && !revokeAccess(cause)) toast.error(messageOf(cause));
    } finally {
      if (activeLifecycle === lifecycle.current && request === latestEarlier.current) setLoadingEarlier(false);
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    const operation = beginMutation();
    if (!operation) return;
    setSending(true);
    try {
      await sendChatMessage(threadId, body);
      if (!mutationIsCurrent(operation)) return;
      invalidateContentRequests();
      setDraft('');
      if (composerRef.current) composerRef.current.style.height = '';
      stickToBottom.current = true;
      onActivity();
      await load(true);
    } catch (cause) {
      if (mutationIsCurrent(operation)) {
        if (!revokeAccess(cause)) {
          invalidateContentRequests();
          toast.error(messageOf(cause));
          void load(true);
        }
      }
    } finally {
      if (operation.lifecycle === lifecycle.current) {
        mutationInFlight.current = false;
        setSending(false);
        composerRef.current?.focus();
      }
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
    const operation = beginMutation();
    if (!operation) return;
    setBusyProposalId(proposal.id);
    try {
      const result = await respondToChatProposal(proposal.id, action);
      if (!mutationIsCurrent(operation)) return;
      invalidateContentRequests();
      stickToBottom.current = true;
      apply(result.thread);
      onActivity(result.thread);
      if (action === 'accept') toast('Proposal accepted');
      else toast.success(action === 'decline' ? 'Proposal declined' : 'Proposal withdrawn');
    } catch (cause) {
      if (mutationIsCurrent(operation)) {
        if (!revokeAccess(cause)) {
          invalidateContentRequests();
          toast.error(messageOf(cause));
          void load(true);
        }
      }
    } finally {
      if (operation.lifecycle === lifecycle.current) {
        mutationInFlight.current = false;
        setBusyProposalId(null);
      }
    }
  }

  async function submitProposal(startAt: string, message: string, scheduling?: ChatProposalSchedulingChoice) {
    const counterTo = dialog?.counterTo ?? null;
    const operation = beginMutation();
    if (!operation) throw new Error('Another chat update is still in progress. Please wait.');
    try {
      const result = counterTo
        ? await counterChatProposal(counterTo.id, startAt, message, scheduling)
        : await proposeChatSession(threadId, startAt, message, scheduling);
      if (!mutationIsCurrent(operation)) return;
      invalidateContentRequests();
      stickToBottom.current = true;
      apply(result.thread);
      onActivity(result.thread);
      toast.success(counterTo ? 'New time sent' : 'Proposal sent');
    } catch (cause) {
      if (mutationIsCurrent(operation)) {
        if (!revokeAccess(cause)) {
          invalidateContentRequests();
          void load(true);
        } else {
          return;
        }
      }
      throw cause;
    } finally {
      if (operation.lifecycle === lifecycle.current) mutationInFlight.current = false;
    }
  }

  async function submitReport(input: Parameters<typeof reportChatMessage>[1]) {
    const reportedId = input.messageId;
    await reportChatMessage(threadId, input);
    if (reportedId) {
      setDetail(current => current ? {
        ...current,
        messages: current.messages.map(message => message.id === reportedId
          ? { ...message, canReport: false, reportedByViewer: true }
          : message),
      } : current);
      setEarlier(current => current.map(message => message.id === reportedId
        ? { ...message, canReport: false, reportedByViewer: true }
        : message));
    }
    toast.success('Report sent to the safeguarding team');
  }

  async function updateBlock(block: boolean) {
    if (blockBusy) return;
    setBlockBusy(true);
    try {
      const next = block ? await blockChatAccount(threadId) : await unblockChatAccount(threadId);
      invalidateContentRequests();
      apply(next);
      onActivity(next);
      setBlockDialogOpen(false);
      toast.success(block ? 'Account blocked' : 'Account unblocked');
    } catch (cause) {
      toast.error(messageOf(cause));
    } finally {
      setBlockBusy(false);
    }
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

  const session = detail.kind === 'SESSION' ? detail.session : null;
  const conversation = detail.kind === 'ACCOUNT' ? detail.conversation : null;
  const zone = chatThreadTimezone(detail);
  const directMembers = detail.members.filter(member => !member.assigned);
  const title = mode === 'admin' && conversation
    ? directMembers.map(member => member.name).join(' & ') || chatThreadTitle(detail)
    : chatThreadTitle(detail);
  const baseSubtitle = session ? `${chatSessionLine(session)} · ${session.locationName}` : chatThreadSubtitle(detail, true);
  const subtitle = conversation ? `${baseSubtitle}${baseSubtitle ? ' · ' : ''}${zone}` : baseSubtitle;
  const days = groupChatDays(messages, zone);
  const canLoadEarlier = earlierHasMore ?? detail.hasEarlier;
  const statusBadge = session?.status === 'CANCELLED' ? 'Cancelled' : session?.status === 'COMPLETED' ? 'Completed' : session?.status === 'PENDING' ? 'Pending' : null;

  return <div className={cn('chat-thread-pane', fullscreen && 'chat-thread-fullscreen')}>
    <header className="chat-thread-header flex items-center gap-2.5 border-b border-[#e6eae3] bg-white/95 px-3 py-2.5 backdrop-blur sm:px-4">
      {onBack && <button type="button" onClick={onBack} aria-label="Back to chats" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[#33443b] transition hover:bg-[#f2f5f1]">
        <ArrowLeft size={20} aria-hidden="true" />
      </button>}
      <ThreadAvatar summary={detail} size="lg" />
      <div className="min-w-0 flex-1">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="flex items-center gap-2 truncate text-sm font-semibold text-[#263a30] outline-none">
          <span className="truncate">{title}</span>
          {statusBadge && <span className="badge shrink-0 !py-0.5">{statusBadge}</span>}
        </h2>
        <p className="truncate text-[11px] text-[#59675c]">{subtitle}</p>
      </div>
      {conversation && mode === 'participant' && detail.viewer.canAssignCoach && <button type="button" onClick={() => setCoachDialogOpen(true)}
        aria-label="Manage conversation coach" title="Manage conversation coach"
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[#dfe5df] px-3 text-xs font-semibold text-[#33443b] transition hover:bg-[#f2f5f1]">
        <Settings2 size={14} aria-hidden="true" /><span className="max-[480px]:sr-only">Coach</span>
      </button>}
      {session && onOpenBooking && mode === 'participant' && <button type="button" onClick={() => onOpenBooking(session.bookingId)}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[#dfe5df] px-3 text-xs font-semibold text-[#33443b] transition hover:bg-[#f2f5f1]">
        <CalendarClock size={14} aria-hidden="true" /><span className="max-[420px]:sr-only">Session</span>
      </button>}
      {mode === 'participant' && detail.safety.blockTarget && (detail.safety.canBlock || detail.safety.canUnblock) && <button type="button" disabled={blockBusy}
        onClick={() => detail.safety.canUnblock ? void updateBlock(false) : setBlockDialogOpen(true)}
        aria-label={`${detail.safety.canUnblock ? 'Unblock' : 'Block'} ${detail.safety.blockTarget.name}`}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[#eadbd5] px-3 text-xs font-semibold text-[#7b493d] transition hover:bg-[#fff5f1] disabled:opacity-60">
        {blockBusy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <UserRoundX size={14} aria-hidden="true" />}
        <span className="max-[520px]:sr-only">{detail.safety.canUnblock ? 'Unblock' : 'Block'}</span>
      </button>}
    </header>

    <div ref={scrollRef} onScroll={trackScroll} className="chat-messages min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-4 sm:px-4">
      <Disclosure
        title="Conversation details"
        summary={conversation ? accountMemberSummary(detail.members) : chatMemberSummary(detail.members)}
        className="!mx-auto !mb-5 max-w-xl bg-white"
      >
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-[#59675c]">
          <LockKeyhole size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{session
            ? 'Visible to the coach, students, and club in this session. Courtly does not monitor every message; authorized reviewers can review relevant context after a report.'
            : `Visible to the people in this conversation${conversation?.assignedCoach ? `, including ${conversation.assignedCoach.name}` : ''}. Courtly does not monitor every message; authorized reviewers can review relevant context after a report.`}</span>
        </p>
      </Disclosure>
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
                  onOpenBooking={mode === 'participant' ? onOpenBooking : undefined}
                  onReport={setReportMessage} />;
              }
              return <TextMessage key={message.id} message={message} timezone={zone}
                showSender={startsChatRun(dayGroup.messages, index)} showTime={endsChatRun(dayGroup.messages, index)} onReport={setReportMessage} />;
            })}
          </ol>
        </section>)}
      </div>
    </div>

    {detail.safety.messagingBlocked ? <div className="chat-composer flex flex-wrap items-center justify-center gap-2 border-t border-[#e6eae3] bg-white px-3 pt-3 text-center text-xs text-[#59675c]">
      <LockKeyhole size={13} aria-hidden="true" />
      <span>{blockedComposerMessage(detail.safety.blockedByViewer, detail.safety.reason)}</span>
      {detail.safety.canUnblock && detail.safety.blockTarget && <button type="button" disabled={blockBusy} onClick={() => void updateBlock(false)} className="min-h-11 rounded-lg px-3 font-semibold text-[#214e3e] underline underline-offset-2 disabled:opacity-60">Unblock</button>}
    </div> : detail.viewer.canPost ? <form onSubmit={event => void send(event)} className="chat-composer flex items-end gap-2 border-t border-[#e6eae3] bg-white px-2.5 pt-2.5 sm:px-3">
      {detail.viewer.canPropose && <button type="button" disabled={sending || !!busyProposalId} onClick={() => setDialog({ counterTo: null })} aria-label={session ? 'Propose the next session' : 'Propose a session'} title={session ? 'Propose the next session' : 'Propose a session'}
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
        disabled={!!busyProposalId}
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
      conversation={detail.conversation}
      counterTo={dialog.counterTo}
      onSubmit={submitProposal}
    />}
    {conversation && coachDialogOpen && <ManageConversationCoachDialog
      open
      onOpenChange={setCoachDialogOpen}
      threadId={threadId}
      conversation={conversation}
      onUpdated={thread => {
        invalidateContentRequests();
        apply(thread);
        onActivity(thread);
        toast.success(thread.conversation?.assignedCoach ? 'Conversation coach updated' : 'Coach removed from conversation');
      }}
    />}
    <ReportMessageDialog message={reportMessage} onClose={() => setReportMessage(null)} onSubmit={submitReport} />
    <BlockAccountDialog target={blockDialogOpen ? detail.safety.blockTarget : null} busy={blockBusy} onClose={() => setBlockDialogOpen(false)} onConfirm={() => void updateBlock(true)} />
  </div>;
}

const defaultHeading = {
  eyebrow: 'Conversations',
  title: 'Chats',
  description: 'Messages and session planning, together.',
};

/**
 * Instagram-style inbox: the list and the open conversation sit side by side
 * where there is room, and on a phone the conversation takes the whole
 * screen with its own back button and composer.
 */
export function ChatInbox({
  mode, viewerType, viewerUsername, threadId, onThreadChange, beginUnreadRequest, commitUnreadNow, onOpenBooking, onBookingsChanged, className,
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
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [accountChatAvailable, setAccountChatAvailable] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestRef = useRef(0);
  const threadButtons = useRef(new Map<string, HTMLButtonElement>());
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const openedFromRow = useRef<string | null>(null);
  const previousThreadId = useRef(threadId);

  const loadList = useCallback(async (query: string, quiet = false) => {
    const request = ++requestRef.current;
    const commitUnread = beginUnreadRequest?.();
    setLoadingMore(false);
    if (!quiet) setState(current => (current === 'ready' ? current : 'loading'));
    try {
      const result = mode === 'admin' ? await adminChatThreads({ q: query }) : await loadChatThreads({ q: query });
      if (request !== requestRef.current) return;
      setNowMs(Date.now());
      // A first-page refresh is also the server's current authorization set.
      // Replace the rows and cursor together: keeping older pages would retain
      // revoked previews, while keeping their cursor would skip that page when
      // the reader asks to load it again.
      setThreads(result.threads);
      setAccountChatAvailable(result.accountChatAvailable);
      setNextCursor(result.nextCursor);
      setState('ready');
      if (typeof result.unreadThreads === 'number') commitUnread?.(result.unreadThreads);
    } catch (cause) {
      if (request !== requestRef.current) return;
      if (!quiet) {
        setError(messageOf(cause));
        setState('error');
      }
    }
  }, [beginUnreadRequest, mode]);

  const changeSearch = useCallback((value: string) => {
    // Invalidate first-page polling and pagination immediately; waiting for
    // the debounce would let an old query append into the new result set.
    requestRef.current += 1;
    setLoadingMore(false);
    setSearch(value);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadList(search); }, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [loadList, search]);

  useVisiblePolling(() => { void loadList(search, true); }, listPollMs);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const request = ++requestRef.current;
    const query = search;
    const cursor = nextCursor;
    const commitUnread = beginUnreadRequest?.();
    setLoadingMore(true);
    try {
      const result = mode === 'admin'
        ? await adminChatThreads({ q: query, cursor })
        : await loadChatThreads({ q: query, cursor });
      if (request !== requestRef.current) return;
      setThreads(current => [...current, ...result.threads.filter(thread => !current.some(existing => existing.id === thread.id))]);
      setNextCursor(result.nextCursor);
      if (typeof result.unreadThreads === 'number') commitUnread?.(result.unreadThreads);
    } catch (cause) {
      if (request === requestRef.current) toast.error(messageOf(cause));
    } finally {
      if (request === requestRef.current) setLoadingMore(false);
    }
  }

  // Reading a thread clears its row straight away instead of waiting for the
  // next list poll, and a new message moves the thread to the top.
  const handleActivity = useCallback((detail?: ChatThreadDetail) => {
    requestRef.current += 1;
    if (detail) {
      setThreads(current => current.map(thread => thread.id === detail.id
        ? { ...thread, unreadCount: 0, lastMessageAt: detail.lastMessageAt, lastMessage: detail.messages.at(-1) ?? thread.lastMessage }
        : thread));
    }
    void loadList(search, true);
  }, [loadList, search]);

  const handleRead = useCallback((readThreadId: string) => {
    requestRef.current += 1;
    setThreads(current => current.map(thread => thread.id === readThreadId ? { ...thread, unreadCount: 0 } : thread));
  }, []);

  const handleRevoked = useCallback((revokedThreadId: string) => {
    requestRef.current += 1;
    setThreads(current => current.filter(thread => thread.id !== revokedThreadId));
    if (threadId === revokedThreadId) onThreadChange(null);
    void loadList(search, true);
  }, [loadList, onThreadChange, search, threadId]);

  const selectThread = useCallback((selectedThreadId: string) => {
    openedFromRow.current = selectedThreadId;
    onThreadChange(selectedThreadId);
  }, [onThreadChange]);

  const setThreadButtonRef = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) threadButtons.current.set(id, element);
    else threadButtons.current.delete(id);
  }, []);

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

  useLayoutEffect(() => {
    const previous = previousThreadId.current;
    previousThreadId.current = threadId;
    if (previous && !threadId) {
      const targetId = openedFromRow.current ?? previous;
      (threadButtons.current.get(targetId) ?? listHeadingRef.current)?.focus({ preventScroll: true });
      openedFromRow.current = null;
    }
  }, [split, threadId, showList]);

  return <section ref={rootRef} aria-label={heading.title} className={cn('chat-inbox', split ? 'chat-inbox-split' : 'chat-inbox-single', className)}>
    {showList && <ChatList
      threads={threads}
      selectedId={threadId}
      onSelect={selectThread}
      search={search}
      onSearch={changeSearch}
      state={state}
      error={error}
      onRetry={() => void loadList(search)}
      hasMore={!!nextCursor}
      loadingMore={loadingMore}
      onLoadMore={() => void loadMore()}
      viewerType={viewerType}
      heading={heading}
      nowMs={nowMs}
      onNewConversation={mode === 'participant' && accountChatAvailable ? () => setNewConversationOpen(true) : undefined}
      onThreadButtonRef={setThreadButtonRef}
      headingRef={listHeadingRef}
    />}
    {showThread && (threadId
      ? <ChatThreadPane
        key={threadId}
        threadId={threadId}
        mode={mode}
        fullscreen={fullscreen}
        singlePane={!split}
        onBack={split ? undefined : () => onThreadChange(null)}
        beginUnreadRequest={beginUnreadRequest}
        commitUnreadNow={commitUnreadNow}
        onRead={handleRead}
        onRevoked={handleRevoked}
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
            : 'Choose a conversation, or start one with a student, coach or club.'}
        </p>
        {mode === 'participant' && accountChatAvailable && <button type="button" onClick={() => setNewConversationOpen(true)}
          className="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[#cbd7c5] bg-white px-4 text-xs font-semibold text-[#214e3e] hover:bg-[#f5f8f2]">
          <MessageCirclePlus size={15} aria-hidden="true" />New conversation
        </button>}
      </div>)}
    {mode === 'participant' && accountChatAvailable && <NewConversationDialog
      open={newConversationOpen}
      onOpenChange={setNewConversationOpen}
      viewerUsername={viewerUsername}
      onCreated={createdThreadId => {
        openedFromRow.current = createdThreadId;
        requestRef.current += 1;
        setSearch('');
        onThreadChange(createdThreadId);
        void loadList('', true);
      }}
    />}
  </section>;
}
