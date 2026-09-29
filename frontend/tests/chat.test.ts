import { describe, expect, it } from 'vitest';
import {
  alertsButtonLabel, blockedComposerMessage, chatBadge, chatListTime, chatMemberSummary, chatPreview, chatReportCategories, chatReportCategoryLabel, chatSessionLine, chatTabLabel,
  chatThreadAvatar, chatThreadSubtitle, chatThreadTimezone, chatThreadTitle, endsChatRun, groupChatDays, listNames,
  nextSessionDate, proposalResponseLabel, proposalStatusLine, safeguardingSeverityOrder, safeguardingStatusLabel, safeguardingStatusOrder, startsChatRun,
} from '../src/lib/chat';
import type { ChatMessage, ChatThreadSummary, SessionProposal } from '../src/lib/types';

const zone = 'Asia/Singapore';
// 2026-10-14 10:00 in Singapore.
const now = Date.parse('2026-10-14T02:00:00.000Z');

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: overrides.id ?? 'message', kind: 'TEXT', event: null, senderRole: 'COACH', senderName: 'Marcus Tan',
  body: 'See you soon', createdAt: '2026-10-14T01:00:00.000Z', mine: false, proposalId: null,
  canReport: false, reportedByViewer: false, ...overrides,
});

const proposal = (overrides: Partial<SessionProposal> = {}): SessionProposal => ({
  id: 'proposal', status: 'OPEN', startAt: '2026-10-21T02:00:00.000Z', endAt: '2026-10-21T03:00:00.000Z', timezone: zone,
  price: 6500, currency: 'SGD',
  businessSlug: 'kallang-racket-club', serviceId: 'service', instructorId: 'instructor', locationId: 'location',
  serviceName: 'Private Tennis', locationName: 'Kallang', instructorName: 'Marcus Tan',
  proposedByRole: 'COACH', proposedByName: 'Marcus Tan', proposedByYou: false, forName: 'Amelia Wong', forYou: true,
  isCounter: false, message: '', createdAt: '2026-10-14T01:00:00.000Z', awaiting: ['Amelia Wong'], responses: [],
  actions: { accept: true, decline: true, counter: true, withdraw: false }, ...overrides,
});

describe('chatListTime', () => {
  it('shrinks recent activity the way a message list does', () => {
    expect(chatListTime('2026-10-14T01:59:40.000Z', zone, now)).toBe('now');
    expect(chatListTime('2026-10-14T01:35:00.000Z', zone, now)).toBe('25m');
    expect(chatListTime('2026-10-13T20:00:00.000Z', zone, now)).toBe('6h');
  });

  it('switches to a weekday, then a date, once the day has turned', () => {
    // 11pm the previous evening in Singapore is yesterday, not "11h".
    expect(chatListTime('2026-10-13T15:00:00.000Z', zone, now)).toBe('Tue');
    expect(chatListTime('2026-09-30T02:00:00.000Z', zone, now)).toBe('30 Sep');
  });

  it('prints nothing for an unreadable timestamp', () => {
    expect(chatListTime('not-a-date', zone, now)).toBe('');
  });
});

describe('labels that carry a number', () => {
  it('say what the number counts', () => {
    expect(chatTabLabel(0)).toBe('Chat');
    expect(chatTabLabel(1)).toBe('Chat, 1 unread chat');
    expect(chatTabLabel(4)).toBe('Chat, 4 unread chats');
    expect(alertsButtonLabel(0)).toBe('Alerts');
    expect(alertsButtonLabel(2)).toBe('Alerts, 2 unread alerts');
  });

  it('keep the visual badge to two characters', () => {
    expect(chatBadge(3)).toBe('3');
    expect(chatBadge(10)).toBe('9+');
  });
});

describe('chat safeguarding wording', () => {
  it('keeps the four report choices explicit and in a stable order', () => {
    expect(chatReportCategories).toEqual([
      { value: 'GROOMING_SEXUAL', label: 'Grooming or sexual behaviour' },
      { value: 'HARASSMENT', label: 'Harassment or threats' },
      { value: 'SELF_HARM_IMMEDIATE_DANGER', label: 'Self-harm or immediate danger' },
      { value: 'SPAM_OTHER', label: 'Spam or another concern' },
    ]);
    expect(chatReportCategoryLabel('SELF_HARM_IMMEDIATE_DANGER')).toBe('Self-harm or immediate danger');
  });

  it('orders cases by urgency and exposes readable status labels', () => {
    expect(safeguardingSeverityOrder).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
    expect(safeguardingStatusOrder).toEqual(['OPEN', 'IN_REVIEW', 'REFERRED_TO_PLATFORM', 'ACTION_TAKEN', 'CLOSED_NO_ACTION']);
    expect(safeguardingStatusLabel('REFERRED_TO_PLATFORM')).toBe('Referred to platform');
  });

  it('explains both blocked-composer states without hiding history', () => {
    expect(blockedComposerMessage(true)).toBe('You blocked this account. Unblock them to send direct messages. Message history remains available.');
    expect(blockedComposerMessage(false)).toBe('Direct messaging is unavailable because one of these accounts has blocked the other. Message history remains available.');
  });
});

describe('chatPreview', () => {
  it('names the author by first name, or as you', () => {
    expect(chatPreview(message())).toBe('Marcus: See you soon');
    expect(chatPreview(message({ mine: true }))).toBe('You: See you soon');
  });

  it('keeps a club’s full name, and system and proposal lines as written', () => {
    expect(chatPreview(message({ senderRole: 'CLUB', senderName: 'Kallang Racket Club' }))).toBe('Kallang Racket Club: See you soon');
    expect(chatPreview(message({ kind: 'SYSTEM', senderRole: 'SYSTEM', body: 'Reminder: tennis is tomorrow.' }))).toBe('Reminder: tennis is tomorrow.');
    expect(chatPreview(message({ kind: 'PROPOSAL', body: 'Marcus Tan proposed the next session.' }))).toBe('Marcus Tan proposed the next session.');
    expect(chatPreview(null)).toBe('No messages yet');
  });
});

describe('session and member lines', () => {
  it('shows the session time in the club’s zone', () => {
    expect(chatSessionLine({ startAt: '2026-10-21T02:00:00.000Z', timezone: zone })).toBe('Wed, 21 Oct · 10:00 AM');
  });

  it('names a private student but counts a group', () => {
    expect(chatMemberSummary([
      { role: 'COACH', name: 'Marcus Tan', username: 'marcus', isYou: false, assigned: true },
      { role: 'STUDENT', name: 'Amelia Wong', username: 'amelia', isYou: true, assigned: false },
      { role: 'CLUB', name: 'Kallang Racket Club', username: 'kallang', isYou: false, assigned: false },
    ])).toBe('Coach Marcus Tan · Amelia Wong · Kallang Racket Club');
    expect(chatMemberSummary([
      { role: 'COACH', name: 'Sarah Lim', username: 'sarah', isYou: false, assigned: true },
      { role: 'STUDENT', name: 'Ethan', username: 'ethan', isYou: false, assigned: false },
      { role: 'STUDENT', name: 'Chloe', username: 'chloe', isYou: false, assigned: false },
      { role: 'CLUB', name: 'Club', username: 'club', isYou: false, assigned: false },
    ])).toBe('Coach Sarah Lim · 2 students · Club');
    expect(listNames(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
  });
});

describe('generalized thread presentation', () => {
  const members = [
    { role: 'STUDENT' as const, name: 'Amelia Wong', username: 'amelia', isYou: true, assigned: false },
    { role: 'CLUB' as const, name: 'Kallang Club Account', username: 'kallang', isYou: false, assigned: false },
    { role: 'COACH' as const, name: 'Marcus Tan', username: 'marcus', isYou: false, assigned: true },
  ];
  const accountThread = {
    id: 'thread', kind: 'ACCOUNT' as const, bookingId: null, session: null, lastMessageAt: '2026-10-14T01:00:00.000Z',
    members, lastMessage: null, unreadCount: 0,
    conversation: {
      title: 'Kallang Racket Club', subtitle: 'Club · Coach Marcus Tan', timezone: zone,
      business: { name: 'Kallang Racket Club', slug: 'kallang-racket-club' }, assignedCoach: members[2],
      schedulingOptions: [],
    },
  } satisfies ChatThreadSummary;

  it('uses server-authored account conversation context without a session', () => {
    expect(chatThreadTitle(accountThread)).toBe('Kallang Racket Club');
    expect(chatThreadSubtitle(accountThread)).toBe('Club · Coach Marcus Tan');
    expect(chatThreadTimezone(accountThread)).toBe(zone);
    expect(chatThreadAvatar(accountThread)).toEqual({ kind: 'initials', label: 'Kallang Racket Club' });
  });

  it('falls back to initiating participants and excludes an assigned coach', () => {
    const thread = {
      ...accountThread,
      conversation: { ...accountThread.conversation, title: '  ', subtitle: '' },
    };
    expect(chatThreadTitle(thread)).toBe('Kallang Club Account');
    expect(chatThreadSubtitle(thread)).toBe('Coach Marcus Tan · Amelia Wong · Kallang Club Account');
  });

  it('preserves the existing session title, context and group avatar decision', () => {
    const thread = {
      ...accountThread,
      kind: 'SESSION' as const,
      bookingId: 'booking',
      session: {
        bookingId: 'booking', serviceId: 'service', instructorId: 'instructor', locationId: 'location',
        serviceName: 'Group Tennis', type: 'GROUP' as const, status: 'CANCELLED' as const,
        startAt: '2026-10-21T02:00:00.000Z', endAt: '2026-10-21T03:00:00.000Z', locationName: 'Kallang',
        instructorName: 'Marcus Tan', businessName: 'Kallang Racket Club', businessSlug: 'kallang-racket-club', timezone: zone,
      },
    } satisfies ChatThreadSummary;
    expect(chatThreadTitle(thread)).toBe('Group Tennis');
    expect(chatThreadSubtitle(thread)).toBe('Wed, 21 Oct · 10:00 AM · Kallang Racket Club · Cancelled');
    expect(chatThreadSubtitle(thread, false)).toBe('Wed, 21 Oct · 10:00 AM · Cancelled');
    expect(chatThreadTimezone(thread)).toBe(zone);
    expect(chatThreadAvatar(thread)).toEqual({ kind: 'group', label: 'Group Tennis' });
  });
});

describe('groupChatDays', () => {
  it('starts a new heading when the club’s calendar day changes', () => {
    const days = groupChatDays([
      message({ id: 'a', createdAt: '2026-10-12T03:00:00.000Z' }),
      message({ id: 'b', createdAt: '2026-10-13T15:30:00.000Z' }),
      message({ id: 'c', createdAt: '2026-10-13T16:30:00.000Z' }),
    ], zone, now);
    expect(days.map(item => [item.label, item.messages.map(entry => entry.id)])).toEqual([
      ['Mon, 12 Oct', ['a']],
      ['Yesterday', ['b']],
      ['Today', ['c']],
    ]);
  });
});

describe('message runs', () => {
  it('prints a sender once for consecutive messages close together', () => {
    const messages = [
      message({ id: 'a', createdAt: '2026-10-14T01:00:00.000Z' }),
      message({ id: 'b', createdAt: '2026-10-14T01:02:00.000Z' }),
      message({ id: 'c', createdAt: '2026-10-14T01:30:00.000Z' }),
      message({ id: 'd', createdAt: '2026-10-14T01:31:00.000Z', mine: true }),
      message({ id: 'e', kind: 'SYSTEM', senderRole: 'SYSTEM', createdAt: '2026-10-14T01:31:30.000Z' }),
    ];
    expect(messages.map((_, index) => startsChatRun(messages, index))).toEqual([true, false, true, true, true]);
    expect(messages.map((_, index) => endsChatRun(messages, index))).toEqual([false, true, true, true, true]);
  });
});

describe('proposal wording', () => {
  it('asks the person who must answer, and tells the proposer who they are waiting for', () => {
    expect(proposalStatusLine(proposal())).toBe('Your answer is needed');
    expect(proposalStatusLine(proposal({
      proposedByYou: true, forYou: false, actions: { accept: false, decline: false, counter: false, withdraw: true },
    }))).toBe('Waiting for Amelia Wong');
  });

  it('describes answers from both sides of the negotiation', () => {
    const accepted = { studentName: 'Amelia Wong', status: 'ACCEPTED' as const, forYou: true, byYou: true, bookingId: 'booking', createdAt: '' };
    expect(proposalStatusLine(proposal({ status: 'ACCEPTED', responses: [accepted] }))).toBe('You are booked');
    expect(proposalResponseLabel(proposal({ proposedByRole: 'STUDENT' }),
      { ...accepted, status: 'DECLINED', forYou: true, byYou: false })).toBe('Marcus Tan declined');
    expect(proposalResponseLabel(proposal(), { ...accepted, status: 'COUNTERED', forYou: false, byYou: false }))
      .toBe('Amelia Wong suggested another time');
  });

  it('shows a group member their own answer while others still decide', () => {
    expect(proposalStatusLine(proposal({
      forName: null, forYou: false, awaiting: ['Finn'], actions: { accept: false, decline: false, counter: false, withdraw: false },
      responses: [{ studentName: 'Eve', status: 'ACCEPTED', forYou: true, byYou: true, bookingId: 'booking', createdAt: '' }],
    }))).toBe('You are booked');
    expect(proposalStatusLine(proposal({ status: 'EXPIRED' }))).toBe('This time has passed');
    expect(proposalStatusLine(proposal({ status: 'WITHDRAWN', proposedByYou: true }))).toBe('You withdrew this proposal');
  });
});

describe('nextSessionDate', () => {
  it('opens a new proposal on the same weekday next week', () => {
    expect(nextSessionDate('2026-10-15T02:00:00.000Z', zone, now)).toBe('2026-10-22');
  });

  it('rolls a long-past session forward into the future', () => {
    expect(nextSessionDate('2026-09-01T02:00:00.000Z', zone, now)).toBe('2026-10-20');
  });
});
