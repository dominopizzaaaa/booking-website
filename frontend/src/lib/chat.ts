import { formatInTimeZone } from 'date-fns-tz';
import type { ChatMember, ChatMessage, ChatSession, SessionProposal, SessionProposalResponse } from './types';
import { addDaysKey, dateKey } from './utils';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** Instagram-style age for the chat list: now, 5m, 3h, Tue, 14 Oct. */
export function chatListTime(iso: string, timezone: string, now = Date.now()) {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return '';
  const elapsed = Math.max(0, now - at);
  if (elapsed < minute) return 'now';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
  if (dateKey(new Date(at), timezone) === dateKey(new Date(now), timezone)) return `${Math.floor(elapsed / hour)}h`;
  if (elapsed < 6 * day) return formatInTimeZone(at, timezone, 'EEE');
  return formatInTimeZone(at, timezone, 'd MMM');
}

/** A badge never grows wider than two characters. */
export const chatBadge = (count: number) => (count > 9 ? '9+' : String(count));

// A control that carries a number must say what the number counts, otherwise
// a screen reader announces "Chat 3".
export const chatTabLabel = (unread: number) =>
  unread > 0 ? `Chat, ${unread} unread chat${unread === 1 ? '' : 's'}` : 'Chat';
export const alertsButtonLabel = (unread: number) =>
  unread > 0 ? `Alerts, ${unread} unread alert${unread === 1 ? '' : 's'}` : 'Alerts';

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** The one line under a thread in the list. */
export function chatPreview(message: ChatMessage | null) {
  if (!message) return 'No messages yet';
  if (message.kind !== 'TEXT') return message.body;
  const author = message.mine ? 'You' : message.senderRole === 'CLUB' ? message.senderName : firstName(message.senderName);
  return `${author}: ${message.body}`;
}

export function chatSessionLine(session: Pick<ChatSession, 'startAt' | 'timezone'>) {
  return formatInTimeZone(session.startAt, session.timezone, "EEE, d MMM '·' h:mm a");
}

/** "Coach Sarah Lim · 5 students · Kallang Racket Club" */
export function chatMemberSummary(members: ChatMember[]) {
  const coach = members.find(member => member.role === 'COACH');
  const students = members.filter(member => member.role === 'STUDENT');
  const club = members.find(member => member.role === 'CLUB');
  const studentPart = students.length === 1 ? students[0].name : students.length ? `${students.length} students` : null;
  return [coach ? `Coach ${coach.name}` : null, studentPart, club?.name ?? null].filter(Boolean).join(' · ');
}

/** Name the first two people and count the rest. */
export function listNames(names: string[]) {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function dayLabel(key: string, timezone: string, now: number) {
  if (key === dateKey(new Date(now), timezone)) return 'Today';
  if (key === dateKey(new Date(now - day), timezone)) return 'Yesterday';
  const sameYear = key.slice(0, 4) === dateKey(new Date(now), timezone).slice(0, 4);
  return formatInTimeZone(new Date(`${key}T12:00:00Z`), 'UTC', sameYear ? 'EEE, d MMM' : 'EEE, d MMM yyyy');
}

/** Consecutive messages grouped under a day heading in the session's zone. */
export function groupChatDays(messages: ChatMessage[], timezone: string, now = Date.now()) {
  const days: Array<{ key: string; label: string; messages: ChatMessage[] }> = [];
  for (const message of messages) {
    const key = dateKey(message.createdAt, timezone);
    let current = days.at(-1);
    if (!current || current.key !== key) {
      current = { key, label: dayLabel(key, timezone, now), messages: [] };
      days.push(current);
    }
    current.messages.push(message);
  }
  return days;
}

const sameAuthor = (a: ChatMessage, b: ChatMessage) =>
  a.kind !== 'SYSTEM' && b.kind !== 'SYSTEM' && a.mine === b.mine
  && a.senderRole === b.senderRole && a.senderName === b.senderName
  && Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) <= 5 * minute;

/** A run is one person's consecutive messages; the name prints once at its start. */
export const startsChatRun = (messages: ChatMessage[], index: number) =>
  index === 0 || !sameAuthor(messages[index - 1], messages[index]);
export const endsChatRun = (messages: ChatMessage[], index: number) =>
  index === messages.length - 1 || !sameAuthor(messages[index], messages[index + 1]);

/** How one answer reads, from the side of the person looking at it. */
export function proposalResponseLabel(proposal: Pick<SessionProposal, 'proposedByRole' | 'instructorName'>, response: SessionProposalResponse) {
  // A student's proposal is answered by the coach; a coach's by the student.
  const responder = response.byYou ? 'You' : proposal.proposedByRole === 'STUDENT' ? proposal.instructorName : response.studentName;
  const student = response.forYou ? 'You' : response.studentName;
  if (response.status === 'ACCEPTED') return `${student} ${student === 'You' ? 'are' : 'is'} booked`;
  if (response.status === 'DECLINED') return `${responder} declined`;
  return `${responder} suggested another time`;
}

/** The status line on a proposal card, from the reader's point of view. */
export function proposalStatusLine(proposal: SessionProposal) {
  const own = proposal.responses.find(response => response.forYou && proposal.forName === null);
  if (own) return proposalResponseLabel(proposal, own);
  switch (proposal.status) {
    case 'OPEN':
      if (proposal.actions.accept) return 'Your answer is needed';
      return proposal.awaiting.length ? `Waiting for ${listNames(proposal.awaiting)}` : 'Waiting for an answer';
    case 'ACCEPTED':
    case 'DECLINED':
    case 'COUNTERED':
      return proposal.responses[0] ? proposalResponseLabel(proposal, proposal.responses[0]) : 'Answered';
    case 'WITHDRAWN':
      return proposal.proposedByYou ? 'You withdrew this proposal' : 'Withdrawn';
    case 'CLOSED':
      return 'Everyone has answered';
    case 'EXPIRED':
      return 'This time has passed';
  }
}

export function proposalTone(proposal: SessionProposal) {
  if (proposal.status === 'OPEN') return proposal.actions.accept ? 'action' : 'waiting';
  if (proposal.status === 'ACCEPTED' || proposal.responses.some(response => response.status === 'ACCEPTED' && response.forYou)) return 'done';
  return 'closed';
}

/**
 * The date a new proposal opens on: the same weekday a week after the
 * session, rolled forward until it is no longer in the past.
 */
export function nextSessionDate(startAt: string, timezone: string, now = Date.now()) {
  const today = dateKey(new Date(now), timezone);
  if (!Number.isFinite(new Date(startAt).getTime())) return addDaysKey(today, 1, timezone);
  let candidate = addDaysKey(dateKey(startAt, timezone), 7, timezone);
  while (candidate <= today) candidate = addDaysKey(candidate, 7, timezone);
  return candidate;
}
