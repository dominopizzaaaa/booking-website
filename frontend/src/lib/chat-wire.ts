import type {
  ChatConversation,
  ChatMember,
  ChatMessage,
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
type ChatMessageWire = Omit<ChatMessage, 'proposal'> & { proposal?: SessionProposal | LegacySessionProposal | null };
type SessionSummary = Extract<ChatThreadSummary, { kind: 'SESSION' }>;
type SessionDetail = Extract<ChatThreadDetail, { kind: 'SESSION' }>;

export type ChatThreadSummaryWire = ChatThreadSummary | (
  Omit<SessionSummary, 'kind' | 'conversation' | 'members' | 'lastMessage'> & {
    kind?: 'SESSION';
    conversation?: ChatConversation | null;
    members: LegacyChatMember[];
    lastMessage: ChatMessageWire | null;
  }
);

export type ChatThreadDetailWire = ChatThreadDetail | (
  Omit<SessionDetail, 'kind' | 'conversation' | 'members' | 'viewer' | 'messages'> & {
    kind?: 'SESSION';
    conversation?: ChatConversation | null;
    members: LegacyChatMember[];
    viewer: Omit<SessionDetail['viewer'], 'canAssignCoach'> & { canAssignCoach?: boolean };
    messages: ChatMessageWire[];
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
    proposal: message.proposal ? normalizeProposal(message.proposal, session) : message.proposal,
  };
}

/** Fill fields absent from the pre-generalized SESSION response during a rolling deploy. */
export function normalizeChatThreadSummary(thread: ChatThreadSummaryWire): ChatThreadSummary {
  const members = normalizeMembers(thread.members);
  if (thread.kind === 'ACCOUNT') return { ...thread, members };
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
  };
}

export function normalizeChatThreadList(result: ChatThreadListWire): ChatThreadList {
  return {
    ...result,
    accountChatAvailable: result.accountChatAvailable ?? false,
    threads: result.threads.map(normalizeChatThreadSummary),
  };
}
