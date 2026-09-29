import type {
  ChatConversation,
  ChatMember,
  ChatMessage,
  ChatMessaging,
  ChatSession,
  ChatThreadDetail,
  ChatThreadList,
  ChatThreadSummary,
  SessionProposal,
} from './types';

type LegacyChatMember = Omit<ChatMember, 'username' | 'assigned'> & Partial<Pick<ChatMember, 'username' | 'assigned'>>;
type LegacySessionProposal = Omit<
  SessionProposal,
  'businessSlug' | 'serviceId' | 'instructorId' | 'locationId' | 'price' | 'currency'
> & Partial<Pick<
  SessionProposal,
  'businessSlug' | 'serviceId' | 'instructorId' | 'locationId' | 'price' | 'currency'
>>;
type ChatMessageWire = Omit<ChatMessage, 'proposal' | 'canReport' | 'reportedByViewer'> & {
  proposal?: SessionProposal | LegacySessionProposal | null;
  canReport?: boolean;
  reportedByViewer?: boolean;
};
type SessionSummary = Extract<ChatThreadSummary, { kind: 'SESSION' }>;
type SessionDetail = Extract<ChatThreadDetail, { kind: 'SESSION' }>;
type AccountDetail = Extract<ChatThreadDetail, { kind: 'ACCOUNT' }>;
type DetailSafetyWire = {
  safety?: Partial<ChatThreadDetail['safety']>;
  messaging?: Partial<ChatMessaging>;
  blockTarget?: ChatThreadDetail['safety']['blockTarget'];
};

export type ChatThreadSummaryWire = ChatThreadSummary | (
  Omit<SessionSummary, 'kind' | 'conversation' | 'members' | 'lastMessage'> & {
    kind?: 'SESSION';
    conversation?: ChatConversation | null;
    members: LegacyChatMember[];
    lastMessage: ChatMessageWire | null;
  }
);

export type ChatThreadDetailWire = (
  Omit<AccountDetail, 'messages' | 'safety'> & { messages: ChatMessageWire[] } & DetailSafetyWire
) | (
  Omit<SessionDetail, 'kind' | 'conversation' | 'members' | 'viewer' | 'messages' | 'safety'> & {
    kind?: 'SESSION';
    conversation?: ChatConversation | null;
    members: LegacyChatMember[];
    viewer: Omit<SessionDetail['viewer'], 'canAssignCoach'> & { canAssignCoach?: boolean };
    messages: ChatMessageWire[];
    safety?: Partial<ChatThreadDetail['safety']>;
    messaging?: Partial<ChatMessaging>;
    blockTarget?: ChatThreadDetail['safety']['blockTarget'];
  }
);

export type ChatThreadListWire = Omit<ChatThreadList, 'threads' | 'accountChatAvailable'> & {
  threads: ChatThreadSummaryWire[];
  accountChatAvailable?: boolean;
};

function normalizeMembers(members: readonly (ChatMember | LegacyChatMember)[]): ChatMember[] {
  return members.map(member => ({
    ...member,
    username: member.username ?? '',
    assigned: member.assigned ?? false,
  }));
}

function sessionConversation(session: ChatSession, members: ChatMember[]): ChatConversation {
  return {
    title: session.serviceName,
    subtitle: `${session.instructorName} · ${session.businessName}`,
    timezone: session.timezone,
    business: { name: session.businessName, slug: session.businessSlug },
    assignedCoach: members.find(member => member.role === 'COACH') ?? null,
    schedulingOptions: [{
      businessName: session.businessName,
      businessSlug: session.businessSlug,
      timezone: session.timezone,
      instructorId: session.instructorId,
      instructorName: session.instructorName,
      serviceId: session.serviceId,
      serviceName: session.serviceName,
      locationId: session.locationId,
      locationName: session.locationName,
    }],
  };
}

function normalizeProposal(proposal: SessionProposal | LegacySessionProposal, session?: ChatSession): SessionProposal {
  return {
    ...proposal,
    businessSlug: proposal.businessSlug ?? session?.businessSlug ?? '',
    serviceId: proposal.serviceId ?? session?.serviceId ?? '',
    instructorId: proposal.instructorId ?? session?.instructorId ?? '',
    locationId: proposal.locationId ?? session?.locationId ?? '',
  };
}

function normalizeMessage(message: ChatMessageWire, session?: ChatSession): ChatMessage {
  return {
    ...message,
    canReport: message.canReport ?? false,
    reportedByViewer: message.reportedByViewer ?? false,
    proposal: message.proposal ? normalizeProposal(message.proposal, session) : message.proposal,
  };
}

function normalizeSafety(thread: DetailSafetyWire): ChatThreadDetail['safety'] {
  const safety = thread.safety;
  const blockedByViewer = safety?.blockedByViewer ?? thread.messaging?.blockedByViewer ?? false;
  const messagingBlocked = safety?.messagingBlocked ?? thread.messaging?.blocked ?? false;
  return {
    canReport: safety?.canReport ?? false,
    blockTarget: safety?.blockTarget ?? thread.messaging?.blockTarget ?? thread.blockTarget ?? null,
    blockedByViewer,
    messagingBlocked,
    canBlock: safety?.canBlock ?? thread.messaging?.canBlock ?? false,
    canUnblock: safety?.canUnblock ?? thread.messaging?.canUnblock ?? false,
    reason: safety?.reason ?? thread.messaging?.reason ?? (messagingBlocked ? 'BLOCKED' : null),
  };
}

/** Fill fields absent from the pre-generalized SESSION response during a rolling deploy. */
export function normalizeChatThreadSummary(thread: ChatThreadSummaryWire): ChatThreadSummary {
  const members = normalizeMembers(thread.members);
  if (thread.kind === 'ACCOUNT') return {
    ...thread,
    members,
    lastMessage: thread.lastMessage ? normalizeMessage(thread.lastMessage) : null,
  };
  const session = thread.session;
  return {
    ...thread,
    kind: 'SESSION',
    bookingId: thread.bookingId || session.bookingId,
    session,
    conversation: thread.conversation ?? sessionConversation(session, members),
    members,
    lastMessage: thread.lastMessage ? normalizeMessage(thread.lastMessage, session) : null,
  };
}

/** Detail responses also lacked the coach-management capability before ACCOUNT chat shipped. */
export function normalizeChatThreadDetail(thread: ChatThreadDetailWire): ChatThreadDetail {
  const members = normalizeMembers(thread.members);
  if (thread.kind === 'ACCOUNT') {
    return {
      ...thread,
      members,
      viewer: { ...thread.viewer, canAssignCoach: thread.viewer.canAssignCoach ?? false },
      messages: thread.messages.map(message => normalizeMessage(message)),
      safety: normalizeSafety(thread),
    };
  }
  const session = thread.session;
  return {
    ...thread,
    kind: 'SESSION',
    bookingId: thread.bookingId || session.bookingId,
    session,
    conversation: thread.conversation ?? sessionConversation(session, members),
    members,
    viewer: { ...thread.viewer, canAssignCoach: false },
    messages: thread.messages.map(message => normalizeMessage(message, session)),
    safety: normalizeSafety(thread),
  };
}

export function normalizeChatThreadList(result: ChatThreadListWire): ChatThreadList {
  return {
    ...result,
    accountChatAvailable: result.accountChatAvailable ?? false,
    threads: result.threads.map(normalizeChatThreadSummary),
  };
}
