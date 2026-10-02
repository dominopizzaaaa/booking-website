import { createHash } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { Prisma, type ChatMessage } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { prisma } from './db.js';
import { skipRateLimits } from './config.js';
import { sharedRateLimit } from './rate-limit.js';
import { asyncRoute, HttpError, type AccountRequest, type AccountType } from './http.js';
import { loadAccountPolicy } from './account-policy.js';
import { ageOnSingaporeDate, SINGAPORE_TIME_ZONE } from './children-policy.js';
import {
  bookingInput, bookableInstructorWhere, createBookingsInTransaction, evaluateSlot, lockInstructors, schedulingContext, type Tx,
} from './scheduling.js';
import {
  chatEligible, chatWhen, ensureChatThread, postChatSystemLine, postThreadSystemLine, silentChatEventsFor, type ChatRole,
} from './chat-events.js';

/**
 * Who is reading. Chat belongs to the global account, like Calendar, so a
 * coach sees every session they teach across the clubs that rostered them
 * and a student sees every session they are booked into.
 */
export type ChatViewer = {
  userId: string;
  name: string;
  accountType: AccountType;
  safetyStatus: string;
  /** The club businesses this account operates; empty for people. */
  clubBusinessIds: string[];
};

export function chatViewerFor(auth: AccountRequest['auth']): ChatViewer {
  return {
    userId: auth.user.id,
    name: auth.user.name,
    accountType: auth.user.accountType as AccountType,
    safetyStatus: auth.user.safetyStatus,
    clubBusinessIds: auth.user.accountType === 'CLUB'
      ? auth.memberships
        .filter(membership => membership.active && membership.instructorId === null && membership.userId === auth.user.id)
        .map(membership => membership.businessId)
      : [],
  };
}

const sessionInclude = {
  business: {
    select: {
      id: true, name: true, slug: true, timezone: true, currency: true, kind: true, legacyReadOnly: true,
      memberships: {
        where: { active: true, instructorId: null, user: { accountType: 'CLUB' } },
        select: { user: { select: { id: true, name: true, username: true } } },
        take: 1,
      },
    },
  },
  service: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  instructor: {
    select: {
      id: true, name: true, active: true,
      membership: { select: { userId: true, active: true, user: { select: { name: true, username: true } } } },
    },
  },
  participants: {
    where: { cancelledAt: null },
    select: { student: { select: { userId: true, name: true, user: { select: { name: true, username: true } } } } },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.BookingInclude;

type ChatBooking = Prisma.BookingGetPayload<{ include: typeof sessionInclude }>;
type Student = { userId: string; name: string; username?: string };

const threadInclude = {
  booking: { include: sessionInclude },
  business: { select: { id: true, name: true, slug: true, timezone: true, currency: true, kind: true, legacyReadOnly: true } },
  members: {
    orderBy: [{ joinedAt: 'asc' as const }, { userId: 'asc' as const }],
    include: {
      user: { select: { id: true, name: true, username: true, accountType: true, sports: true, safetyStatus: true } },
      membership: {
        select: {
          id: true, userId: true, businessId: true, active: true, instructorId: true,
          instructor: { select: { id: true, name: true, active: true } },
        },
      },
    },
  },
} satisfies Prisma.ChatThreadInclude;

type LoadedThread = Prisma.ChatThreadGetPayload<{ include: typeof threadInclude }>;

const proposalInclude = {
  responses: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  business: { select: { name: true, slug: true, timezone: true } },
  service: { select: { name: true } },
  location: { select: { name: true } },
  instructor: { select: { name: true } },
} satisfies Prisma.SessionProposalInclude;

type FullProposal = Prisma.SessionProposalGetPayload<{ include: typeof proposalInclude }>;

const messagePageSize = 100;
const reportContextRadius = 2;

const reportCategory = z.enum([
  'GROOMING_SEXUAL',
  'HARASSMENT',
  'SELF_HARM_IMMEDIATE_DANGER',
  'SPAM_OTHER',
]);
type ReportCategory = z.infer<typeof reportCategory>;

const reportInput = z.object({
  category: reportCategory,
  description: z.string().trim().max(2000).default(''),
  messageId: z.string().trim().min(1).max(200).optional(),
}).strict();

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function evidenceHash(evidence: Prisma.InputJsonObject) {
  return createHash('sha256').update(stableJson(evidence)).digest('hex');
}

function initialReportSeverity(category: ReportCategory, childInvolved: boolean) {
  if (category === 'SELF_HARM_IMMEDIATE_DANGER') return 'CRITICAL';
  if (category === 'GROOMING_SEXUAL') return childInvolved ? 'CRITICAL' : 'HIGH';
  if (category === 'HARASSMENT') return childInvolved ? 'HIGH' : 'MEDIUM';
  return childInvolved ? 'MEDIUM' : 'LOW';
}

function evidenceMessage(message: ChatMessage) {
  return {
    id: message.id, kind: message.kind, event: message.event || null,
    senderUserId: message.senderUserId, senderRole: message.senderRole, senderName: message.senderName,
    body: message.body, proposalId: message.proposalId, createdAt: message.createdAt.toISOString(),
  };
}

/** Students with a registered account who still hold a place in the session. */
const activeStudents = (booking: ChatBooking): Student[] => booking.participants.flatMap(participant =>
  participant.student.userId ? [{
    userId: participant.student.userId,
    name: participant.student.user?.name ?? participant.student.name,
    username: participant.student.user?.username,
  }] : []);

function activeAccountMembers(thread: LoadedThread) {
  return thread.members.filter(member => {
    if (member.removedAt) return false;
    if (member.source !== 'CLUB_ASSIGNED') return true;
    return !!thread.businessId && member.membership?.userId === member.userId
      && member.membership.businessId === thread.businessId && member.membership.active
      && !!member.membership.instructorId && !!member.membership.instructor?.active;
  });
}

function directAccountMembers(thread: LoadedThread) {
  return thread.members.filter(member => member.removedAt === null
    && (member.source === 'INITIATOR' || member.source === 'TARGET'));
}

function exactDirectPair(thread: LoadedThread) {
  if (thread.kind !== 'ACCOUNT') return null;
  const members = directAccountMembers(thread);
  if (members.length !== 2 || members[0]!.userId === members[1]!.userId) return null;
  return members;
}

function directPairForViewer(thread: LoadedThread, viewer: ChatViewer) {
  const pair = exactDirectPair(thread);
  if (!pair || !pair.some(member => member.userId === viewer.userId)) return null;
  const target = pair.find(member => member.userId !== viewer.userId);
  return target ? { pair, target } : null;
}

function pairKey(userIds: readonly string[]) {
  return [...userIds].sort().join(':');
}

async function lockAccountSafetyPair(tx: Tx, userIds: readonly string[]) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-chat-safety:${pairKey(userIds)}`}, 0))`;
}

function accountContactUserIds(thread: LoadedThread, viewerUserId: string) {
  return [...new Set(activeAccountMembers(thread)
    .filter(member => member.userId !== viewerUserId)
    .map(member => member.userId))].sort();
}

async function lockAccountSafetyEdges(tx: Tx, viewerUserId: string, contactUserIds: readonly string[]) {
  // A club-assigned coach is a real recipient of everything posted in the
  // room. Lock every viewer/recipient edge in canonical order so a block and a
  // concurrent send/assignment cannot pass one another.
  for (const contactUserId of [...contactUserIds].sort()) {
    await lockAccountSafetyPair(tx, [viewerUserId, contactUserId]);
  }
}

function blockEdges(viewerUserId: string, contactUserIds: readonly string[]): Prisma.ChatAccountBlockWhereInput {
  return { OR: contactUserIds.flatMap(contactUserId => [
    { blockerUserId: viewerUserId, blockedUserId: contactUserId },
    { blockerUserId: contactUserId, blockedUserId: viewerUserId },
  ]) };
}

function safetyRestrictionReason(statuses: readonly string[]) {
  if (statuses.includes('ACCOUNT_CHAT_RESTRICTED')) return 'ACCOUNT_CHAT_RESTRICTED' as const;
  return null;
}

async function accountMessagingState(
  thread: LoadedThread, viewer: ChatViewer | null, db: Tx | typeof prisma = prisma,
) {
  const pair = exactDirectPair(thread);
  if (!viewer || !pair) return {
    blocked: false, blockedByViewer: false, canBlock: false, canUnblock: false,
    reason: null as 'BLOCKED' | 'ACCOUNT_CHAT_RESTRICTED' | null, blockTarget: null,
  };
  const participant = viewer ? directPairForViewer(thread, viewer) : null;
  const contactUserIds = accountContactUserIds(thread, viewer.userId);
  const statusUserIds = [...new Set([viewer.userId, ...contactUserIds])];
  const [blocks, users] = await Promise.all([
    db.chatAccountBlock.findMany({
      where: blockEdges(viewer.userId, contactUserIds),
      select: { blockerUserId: true, blockedUserId: true },
    }),
    db.user.findMany({ where: { id: { in: statusUserIds } }, select: { id: true, safetyStatus: true } }),
  ]);
  // A direct-chat restriction contains contact involving the subject in both
  // directions. It does not affect SESSION conversations.
  const restriction = safetyRestrictionReason(users.map(user => user.safetyStatus));
  const blockedByViewer = !!viewer && blocks.some(block => block.blockerUserId === viewer.userId);
  // Only the person who placed a block is told that it is their own control.
  // Everyone else receives the same generic restriction state as platform
  // containment, so the API is not a block-status oracle.
  const reason = blockedByViewer ? 'BLOCKED' as const
    : blocks.length || restriction ? 'ACCOUNT_CHAT_RESTRICTED' as const : null;
  return {
    blocked: reason !== null,
    blockedByViewer,
    canBlock: !!participant && !blockedByViewer,
    canUnblock: blockedByViewer,
    reason,
    blockTarget: participant
      ? { name: participant.target.user.name, username: participant.target.user.username }
      : null,
  };
}

async function assertAccountMessagingAllowed(tx: Tx, viewer: ChatViewer, thread: LoadedThread) {
  if (thread.kind !== 'ACCOUNT') return;
  const pair = exactDirectPair(thread);
  if (!pair) throw new HttpError(403, 'Messaging is unavailable in this account conversation');
  const contactUserIds = accountContactUserIds(thread, viewer.userId);
  const statusUserIds = [...new Set([viewer.userId, ...contactUserIds])].sort();
  await lockAccountSafetyEdges(tx, viewer.userId, contactUserIds);
  // Serialize with the platform restriction's FOR UPDATE lock. Whichever
  // transaction wins is authoritative: a completed message precedes the
  // restriction, while a later writer observes the restriction and fails.
  const users = await tx.$queryRaw<Array<{ id: string; safetyStatus: string }>>(Prisma.sql`
    SELECT "id", "safetyStatus" FROM "User"
    WHERE "id" IN (${Prisma.join(statusUserIds)})
    ORDER BY "id" FOR SHARE`);
  const blocks = await tx.chatAccountBlock.findMany({
    where: blockEdges(viewer.userId, contactUserIds), select: { blockerUserId: true },
  });
  const blockedByViewer = blocks.some(block => block.blockerUserId === viewer.userId);
  const reason = blockedByViewer ? 'BLOCKED' as const
    : blocks.length || safetyRestrictionReason(users.map(user => user.safetyStatus))
      ? 'ACCOUNT_CHAT_RESTRICTED' as const : null;
  if (reason) {
    throw new HttpError(403, 'Messaging is unavailable in this account conversation', {
      code: 'CHAT_MESSAGING_BLOCKED', reason,
    });
  }
}

async function assertProspectiveAccountMemberAllowed(
  tx: Tx, thread: LoadedThread, prospectiveUserId: string,
) {
  const contactUserIds = [...new Set(activeAccountMembers(thread)
    .filter(member => member.userId !== prospectiveUserId)
    .map(member => member.userId))].sort();
  await lockAccountSafetyEdges(tx, prospectiveUserId, contactUserIds);
  const userIds = [...new Set([prospectiveUserId, ...contactUserIds])].sort();
  const users = await tx.$queryRaw<Array<{ safetyStatus: string }>>(Prisma.sql`
    SELECT "safetyStatus" FROM "User"
    WHERE "id" IN (${Prisma.join(userIds)})
    ORDER BY "id" FOR SHARE`);
  const blocks = await tx.chatAccountBlock.count({ where: blockEdges(prospectiveUserId, contactUserIds) });
  if (blocks > 0 || safetyRestrictionReason(users.map(user => user.safetyStatus))) {
    throw new HttpError(403, 'This coach cannot be assigned to this conversation');
  }
}

async function assertDirectPairMessagingAllowed(tx: Tx, viewer: ChatViewer, otherUserId: string) {
  const userIds = [viewer.userId, otherUserId];
  await lockAccountSafetyPair(tx, userIds);
  const users = await tx.$queryRaw<Array<{ id: string; safetyStatus: string }>>(Prisma.sql`
    SELECT "id", "safetyStatus" FROM "User"
    WHERE "id" IN (${Prisma.join([...userIds].sort())})
    ORDER BY "id" FOR SHARE`);
  const blocks = await tx.chatAccountBlock.count({ where: { OR: [
    { blockerUserId: viewer.userId, blockedUserId: otherUserId },
    { blockerUserId: otherUserId, blockedUserId: viewer.userId },
  ] } });
  const reason = blocks > 0 ? 'BLOCKED' : safetyRestrictionReason(users.map(user => user.safetyStatus));
  if (reason) {
    throw new HttpError(403, 'Messaging is unavailable for these accounts', {
      code: 'CHAT_MESSAGING_BLOCKED', reason,
    });
  }
}

function accountRoleIn(viewer: ChatViewer, thread: LoadedThread): ChatRole | null {
  const member = activeAccountMembers(thread).find(candidate => candidate.userId === viewer.userId);
  return member ? viewer.accountType : null;
}

/**
 * The single membership rule. A student is in the chat while they hold a
 * place, the coach while their club affiliation is live, and the club
 * account for every session its business runs.
 */
export function chatRoleIn(viewer: ChatViewer, booking: ChatBooking): ChatRole | null {
  if (!chatEligible(booking)) return null;
  if (viewer.accountType === 'STUDENT') {
    return activeStudents(booking).some(student => student.userId === viewer.userId) ? 'STUDENT' : null;
  }
  if (viewer.accountType === 'COACH') {
    const affiliation = booking.instructor.membership;
    return booking.instructor.active && affiliation?.active && affiliation.userId === viewer.userId ? 'COACH' : null;
  }
  if (viewer.accountType === 'CLUB') return viewer.clubBusinessIds.includes(booking.businessId) ? 'CLUB' : null;
  return null;
}

/** The same rule as chatRoleIn, as a query over threads. */
function accessibleThreadsWhere(viewer: ChatViewer, includeAccountChats = true): Prisma.ChatThreadWhereInput {
  const activeClub = { business: { is: { kind: 'CLUB', legacyReadOnly: false } } };
  const session = viewer.accountType === 'STUDENT'
    ? { kind: 'SESSION', ...activeClub, booking: { is: { paymentRoute: 'CLUB', participants: { some: { cancelledAt: null, student: { userId: viewer.userId } } } } } }
    : viewer.accountType === 'COACH'
      ? { kind: 'SESSION', ...activeClub, booking: { is: {
        paymentRoute: 'CLUB',
        instructor: { is: { active: true, membership: { is: { userId: viewer.userId, active: true } } } },
      } } }
      : { kind: 'SESSION', ...activeClub, businessId: { in: viewer.clubBusinessIds }, booking: { is: { paymentRoute: 'CLUB' } } };
  const account = {
    kind: 'ACCOUNT',
    members: {
      some: {
        userId: viewer.userId, removedAt: null,
        OR: [
          { source: { not: 'CLUB_ASSIGNED' } },
          {
            source: 'CLUB_ASSIGNED',
            membership: { is: { userId: viewer.userId, active: true, instructorId: { not: null }, instructor: { is: { active: true } } } },
          },
        ],
      },
    },
  };
  return includeAccountChats ? { OR: [session, account] } : session;
}

/**
 * A message is unread when someone else wrote it (or the platform did),
 * after the reader's last visit, and it is not one of the quiet events. The
 * account type decides the role, because each maps to exactly one role.
 */
function unreadMessageSql(viewer: ChatViewer) {
  const silent = silentChatEventsFor(viewer.accountType as ChatRole);
  return Prisma.sql`message."createdAt" > COALESCE(readState."lastReadAt", '-infinity'::timestamp)
    AND (message."senderUserId" IS NULL OR message."senderUserId" <> ${viewer.userId})
    AND NOT (message."kind" = 'SYSTEM' AND message."event" IN (${Prisma.join(silent)}))`;
}

function accessibleThreadsSql(viewer: ChatViewer, includeAccountChats = true) {
  const sessionAccess = viewer.accountType === 'STUDENT'
    ? Prisma.sql`EXISTS (
        SELECT 1 FROM "Participant" AS participant
        JOIN "Student" AS student ON student."id" = participant."studentId"
        WHERE participant."bookingId" = booking."id" AND participant."cancelledAt" IS NULL
          AND student."userId" = ${viewer.userId})`
    : viewer.accountType === 'COACH'
      ? Prisma.sql`EXISTS (
          SELECT 1
          FROM "Membership" AS membership
          JOIN "Instructor" AS instructor ON instructor."id" = membership."instructorId"
          WHERE membership."instructorId" = booking."instructorId"
            AND membership."userId" = ${viewer.userId} AND membership."active"
            AND instructor."active")`
      : viewer.clubBusinessIds.length
        ? Prisma.sql`thread."businessId" IN (${Prisma.join(viewer.clubBusinessIds)})`
        : Prisma.sql`FALSE`;
  const accountAccess = includeAccountChats ? Prisma.sql`
    OR
    (thread."kind" = 'ACCOUNT' AND EXISTS (
      SELECT 1
      FROM "ChatThreadMember" AS member
      LEFT JOIN "Membership" AS membership ON membership."id" = member."membershipId"
      LEFT JOIN "Instructor" AS instructor ON instructor."id" = membership."instructorId"
      WHERE member."threadId" = thread."id"
        AND member."userId" = ${viewer.userId} AND member."removedAt" IS NULL
        AND (member."source" <> 'CLUB_ASSIGNED' OR (
          membership."userId" = member."userId"
          AND membership."businessId" = thread."businessId"
          AND membership."active" AND membership."instructorId" IS NOT NULL
          AND instructor."active"
        ))
    ))` : Prisma.empty;
  return Prisma.sql`(
    (thread."kind" = 'SESSION'
      AND booking."paymentRoute" = 'CLUB'
      AND business."kind" = 'CLUB' AND business."legacyReadOnly" = false
      AND ${sessionAccess})
    ${accountAccess}
  )`;
}

export async function unreadThreadCount(
  viewer: ChatViewer, db: Tx | typeof prisma = prisma, includeAccountChats = true,
) {
  const [row] = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS count
    FROM "ChatThread" AS thread
    LEFT JOIN "Booking" AS booking ON booking."id" = thread."bookingId"
    LEFT JOIN "Business" AS business ON business."id" = thread."businessId"
    LEFT JOIN "ChatReadState" AS readState
      ON readState."threadId" = thread."id" AND readState."userId" = ${viewer.userId}
    WHERE ${accessibleThreadsSql(viewer, includeAccountChats)}
      AND EXISTS (
        SELECT 1 FROM "ChatMessage" AS message
        WHERE message."threadId" = thread."id" AND ${unreadMessageSql(viewer)}
      )
  `);
  return row?.count ?? 0;
}

async function unreadCounts(viewer: ChatViewer, threadIds: string[], db: Tx | typeof prisma = prisma) {
  if (!threadIds.length) return new Map<string, number>();
  const rows = await db.$queryRaw<Array<{ threadId: string; unread: number }>>(Prisma.sql`
    SELECT message."threadId" AS "threadId", count(*)::int AS unread
    FROM "ChatMessage" AS message
    LEFT JOIN "ChatReadState" AS readState ON readState."threadId" = message."threadId" AND readState."userId" = ${viewer.userId}
    WHERE message."threadId" IN (${Prisma.join(threadIds)}) AND ${unreadMessageSql(viewer)}
    GROUP BY message."threadId"
  `);
  return new Map(rows.map(row => [row.threadId, row.unread]));
}

function sessionJson(booking: ChatBooking) {
  return {
    bookingId: booking.id,
    serviceId: booking.serviceId,
    instructorId: booking.instructorId,
    locationId: booking.locationId,
    serviceName: booking.service.name,
    type: booking.type as 'PRIVATE' | 'GROUP',
    status: booking.status,
    startAt: booking.startAt.toISOString(),
    endAt: booking.endAt.toISOString(),
    locationName: booking.location.name,
    instructorName: booking.instructor.name,
    businessName: booking.business.name,
    businessSlug: booking.business.slug,
    timezone: booking.business.timezone,
  };
}

// Members are shown by name and role only. Account IDs never leave the
// server: whether a message or proposal is the reader's own is computed here.
function membersJson(booking: ChatBooking, viewerId: string | null) {
  const coachMembership = booking.instructor.active && booking.instructor.membership?.active
    ? booking.instructor.membership : null;
  const club = booking.business.memberships[0]?.user;
  return [
    {
      role: 'COACH' as const, name: booking.instructor.name, username: coachMembership?.user.username ?? '',
      isYou: !!viewerId && coachMembership?.userId === viewerId, assigned: true,
    },
    ...activeStudents(booking).map(student => ({
      role: 'STUDENT' as const, name: student.name, username: student.username ?? '',
      isYou: student.userId === viewerId, assigned: false,
    })),
    {
      role: 'CLUB' as const, name: booking.business.name, username: club?.username ?? '',
      isYou: !!viewerId && club?.id === viewerId, assigned: false,
    },
  ];
}

function accountMembersJson(thread: LoadedThread, viewerId: string | null) {
  return activeAccountMembers(thread).map(member => ({
    role: member.user.accountType as ChatRole,
    name: member.user.name,
    username: member.user.username,
    isYou: !!viewerId && member.userId === viewerId,
    assigned: member.source === 'CLUB_ASSIGNED',
  }));
}

function messageJson(message: ChatMessage, viewerId: string | null) {
  return {
    id: message.id,
    kind: message.kind as 'TEXT' | 'SYSTEM' | 'PROPOSAL',
    event: message.event || null,
    senderRole: message.senderRole as ChatRole | 'SYSTEM',
    senderName: message.senderName,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    mine: message.kind !== 'SYSTEM' && !!viewerId && message.senderUserId === viewerId,
    proposalId: message.proposalId,
  };
}

/** Who can answer a proposal, and on behalf of which student. */
function responderFor(proposal: FullProposal, viewer: ChatViewer, role: ChatRole, students: Student[]): Student | null {
  if (proposal.status !== 'OPEN') return null;
  const answered = new Set(proposal.responses.map(response => response.studentUserId));
  if (proposal.proposedByRole === 'STUDENT') {
    // A student's proposal is answered by the coach, for that student.
    if (role !== 'COACH' || !proposal.targetStudentUserId || answered.has(proposal.targetStudentUserId)) return null;
    return students.find(student => student.userId === proposal.targetStudentUserId) ?? null;
  }
  if (role !== 'STUDENT' || answered.has(viewer.userId)) return null;
  if (proposal.targetStudentUserId && proposal.targetStudentUserId !== viewer.userId) return null;
  return students.find(student => student.userId === viewer.userId) ?? null;
}

function proposalJson(
  proposal: FullProposal,
  context: { viewer: ChatViewer | null; role: ChatRole | 'ADMIN'; students: Student[]; validContext: boolean; now: Date },
) {
  const { viewer, role, students, now } = context;
  const expired = proposal.status === 'OPEN' && proposal.startAt <= now;
  const open = proposal.status === 'OPEN' && !expired;
  const answered = new Set(proposal.responses.map(response => response.studentUserId));
  const awaiting = !open ? []
    : proposal.proposedByRole === 'STUDENT' ? [proposal.instructor.name]
      : proposal.targetStudentUserId ? (answered.has(proposal.targetStudentUserId) ? [] : [proposal.targetStudentName])
        : students.filter(student => !answered.has(student.userId)).map(student => student.name);
  const canRespond = open && context.validContext && !!viewer && role !== 'ADMIN'
    && !!responderFor(proposal, viewer, role, students);
  const viewerId = viewer?.userId ?? null;
  const seesBookings = role === 'COACH' || role === 'CLUB' || role === 'ADMIN';
  // A coach may agree to the time but never receives the club's student
  // price. Students see the contractual amount they will pay; clubs and the
  // platform console retain their existing financial visibility.
  const seesPrice = role !== 'COACH';
  return {
    id: proposal.id,
    status: expired ? 'EXPIRED' as const : proposal.status as 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'COUNTERED' | 'WITHDRAWN' | 'CLOSED',
    startAt: proposal.startAt.toISOString(),
    endAt: proposal.endAt.toISOString(),
    timezone: proposal.business.timezone,
    ...(seesPrice ? { price: proposal.price, currency: proposal.currency } : {}),
    businessSlug: proposal.business.slug,
    serviceId: proposal.serviceId,
    instructorId: proposal.instructorId,
    locationId: proposal.locationId,
    serviceName: proposal.service.name,
    locationName: proposal.location.name,
    instructorName: proposal.instructor.name,
    proposedByRole: proposal.proposedByRole as 'STUDENT' | 'COACH',
    proposedByName: proposal.proposedByName,
    proposedByYou: !!viewerId && proposal.proposedByUserId === viewerId,
    /** Null when a coach asked a whole group; each student answers for themselves. */
    forName: proposal.targetStudentUserId ? proposal.targetStudentName : null,
    forYou: !!viewerId && proposal.targetStudentUserId === viewerId,
    isCounter: !!proposal.counterOfId,
    message: proposal.message,
    createdAt: proposal.createdAt.toISOString(),
    awaiting,
    responses: proposal.responses.map(response => ({
      studentName: response.studentName,
      status: response.status as 'ACCEPTED' | 'DECLINED' | 'COUNTERED',
      forYou: !!viewerId && response.studentUserId === viewerId,
      byYou: !!viewerId && response.responderUserId === viewerId,
      bookingId: seesBookings || (!!viewerId && response.studentUserId === viewerId) ? response.bookingId : null,
      createdAt: response.createdAt.toISOString(),
    })),
    actions: {
      accept: canRespond,
      decline: canRespond,
      counter: canRespond,
      withdraw: open && !!viewerId && role !== 'ADMIN' && proposal.proposedByUserId === viewerId,
    },
  };
}

/** The name a person carries inside this session's chat. */
function displayNameIn(role: ChatRole, viewer: ChatViewer, booking: ChatBooking) {
  if (role === 'COACH') return booking.instructor.name;
  if (role === 'CLUB') return booking.business.name;
  return activeStudents(booking).find(student => student.userId === viewer.userId)?.name ?? viewer.name;
}

function displayNameForThread(thread: LoadedThread, role: ChatRole, viewer: ChatViewer) {
  return thread.kind === 'SESSION' && thread.booking
    ? displayNameIn(role, viewer, thread.booking)
    : activeAccountMembers(thread).find(member => member.userId === viewer.userId)?.user.name ?? viewer.name;
}

function accountStudents(thread: LoadedThread): Student[] {
  return activeAccountMembers(thread)
    .filter(member => member.user.accountType === 'STUDENT')
    .map(member => ({ userId: member.userId, name: member.user.name, username: member.user.username }));
}

function assignedCoachMember(thread: LoadedThread) {
  return activeAccountMembers(thread).find(member => member.source === 'CLUB_ASSIGNED') ?? null;
}

type SchedulingOption = {
  businessId: string; businessName: string; businessSlug: string; timezone: string;
  price: number; currency: string;
  instructorId: string; instructorName: string; serviceId: string; serviceName: string;
  locationId: string; locationName: string; address?: string;
};

async function schedulingOptionsFor(
  thread: LoadedThread,
  db: Tx | typeof prisma = prisma,
): Promise<SchedulingOption[]> {
  if (thread.kind === 'SESSION' && thread.booking) {
    const booking = thread.booking;
    const assignment = await db.serviceLocation.findFirst({
      where: {
        serviceId: booking.serviceId, locationId: booking.locationId,
        service: { businessId: booking.businessId, active: true },
        location: { businessId: booking.businessId, active: true },
        instructors: { some: {
          instructorId: booking.instructorId,
          instructor: { is: bookableInstructorWhere(booking.businessId) },
        } },
      },
      select: { price: true, location: { select: { address: true } } },
    });
    if (!assignment) return [];
    return [{
      businessId: booking.businessId, businessName: booking.business.name, businessSlug: booking.business.slug,
      timezone: booking.business.timezone, price: assignment.price, currency: booking.business.currency,
      instructorId: booking.instructorId, instructorName: booking.instructor.name,
      serviceId: booking.serviceId, serviceName: booking.service.name, locationId: booking.locationId,
      locationName: booking.location.name, address: assignment.location.address,
    }];
  }
  if (thread.kind !== 'ACCOUNT') return [];
  const members = activeAccountMembers(thread);
  const student = members.find(member => member.user.accountType === 'STUDENT');
  if (!student) return [];
  const directCoach = members.find(member => member.source !== 'CLUB_ASSIGNED' && member.user.accountType === 'COACH');
  const assigned = assignedCoachMember(thread);
  const coachUserId = assigned?.userId ?? directCoach?.userId;
  if (!coachUserId) return [];
  const businessId = assigned?.membership?.businessId ?? thread.businessId ?? undefined;
  const instructors = await db.instructor.findMany({
    where: {
      ...bookableInstructorWhere(businessId),
      membership: { is: { userId: coachUserId, active: true, ...(businessId ? { businessId } : {}) } },
      business: { kind: 'CLUB', legacyReadOnly: false },
    },
    select: {
      id: true, name: true, business: { select: { id: true, name: true, slug: true, timezone: true, currency: true } },
      assignments: {
        where: { serviceLocation: { service: { active: true, type: 'PRIVATE' }, location: { active: true } } },
        select: {
          serviceLocation: { select: {
            price: true,
            service: { select: { id: true, name: true } },
            location: { select: { id: true, name: true, address: true } },
          } },
        },
      },
    },
    orderBy: [{ business: { name: 'asc' } }, { name: 'asc' }],
  });
  return instructors.flatMap(instructor => instructor.assignments.map(assignment => ({
    businessId: instructor.business.id,
    businessName: instructor.business.name, businessSlug: instructor.business.slug, timezone: instructor.business.timezone,
    price: assignment.serviceLocation.price, currency: instructor.business.currency,
    instructorId: instructor.id, instructorName: instructor.name,
    serviceId: assignment.serviceLocation.service.id, serviceName: assignment.serviceLocation.service.name,
    locationId: assignment.serviceLocation.location.id, locationName: assignment.serviceLocation.location.name,
    address: assignment.serviceLocation.location.address,
  })));
}

function publicSchedulingOption(option: SchedulingOption, role: ChatRole | 'ADMIN') {
  const { businessId: _, address: __, ...result } = option;
  if (role !== 'COACH') return result;
  // Coaches choose the teaching graph and time, but club pricing remains
  // private from them everywhere in the provider experience.
  const { price: ___, currency: ____, ...coachSafe } = result;
  return coachSafe;
}

async function conversationJson(
  thread: LoadedThread, viewer: ChatViewer | null, role: ChatRole | 'ADMIN',
  db: Tx | typeof prisma = prisma,
  // List rows never offer scheduling or coach assignment; only an open
  // thread does. Skipping those lookups keeps the inbox to one query per page
  // instead of one per conversation.
  { summary = false }: { summary?: boolean } = {},
) {
  if (thread.kind === 'SESSION' && thread.booking) {
    const session = thread.booking;
    return {
      title: session.service.name,
      subtitle: `${session.instructor.name} · ${session.business.name}`,
      timezone: session.business.timezone,
      business: { name: session.business.name, slug: session.business.slug },
      assignedCoach: membersJson(session, viewer?.userId ?? null).find(member => member.role === 'COACH') ?? null,
      schedulingOptions: summary ? [] : (await schedulingOptionsFor(thread, db)).map(option => publicSchedulingOption(option, role)),
    };
  }
  const members = accountMembersJson(thread, viewer?.userId ?? null);
  const directMembers = members.filter(member => !member.assigned);
  const other = directMembers.find(member => !member.isYou) ?? directMembers[0] ?? null;
  const assigned = members.find(member => member.assigned) ?? null;
  const canAssignCoach = !summary && !!viewer && role === 'CLUB' && !!thread.businessId
    && viewer.clubBusinessIds.includes(thread.businessId)
    && directMembers.some(member => member.role === 'STUDENT')
    && directMembers.some(member => member.role === 'CLUB');
  const assignableCoaches = canAssignCoach ? await db.membership.findMany({
    where: { businessId: thread.businessId!, active: true, instructor: { is: { active: true } }, user: { accountType: 'COACH', passwordHash: { not: null } } },
    select: { id: true, user: { select: { name: true, username: true, sports: true } } },
    orderBy: { user: { name: 'asc' } },
  }) : null;
  const options = summary ? [] : await schedulingOptionsFor(thread, db);
  return {
    title: other?.name ?? 'Conversation',
    subtitle: assigned ? `Coach ${assigned.name} assigned` : other ? `${other.role[0]}${other.role.slice(1).toLowerCase()} account` : '',
    // A conversation with no club has no business clock; Courtly operates on
    // Singapore time, which is also the default for every club.
    timezone: thread.business?.timezone ?? options[0]?.timezone ?? SINGAPORE_TIME_ZONE,
    business: thread.business ? { name: thread.business.name, slug: thread.business.slug } : null,
    assignedCoach: assigned,
    ...(assignableCoaches ? {
      assignableCoaches: assignableCoaches.map(membership => ({
        membershipId: membership.id, name: membership.user.name, username: membership.user.username, sports: membership.user.sports,
      })),
    } : {}),
    schedulingOptions: options.map(option => publicSchedulingOption(option, role)),
  };
}

async function buildThreadDetail(
  thread: LoadedThread,
  viewer: ChatViewer | null,
  role: ChatRole | 'ADMIN',
  options: { before?: string } = {},
  db: Tx | typeof prisma = prisma,
) {
  let pivot: { id: string; createdAt: Date } | null = null;
  if (options.before) {
    pivot = await db.chatMessage.findFirst({
      where: { id: options.before, threadId: thread.id }, select: { id: true, createdAt: true },
    });
    if (!pivot) throw new HttpError(400, 'That message is not part of this chat');
  }
  const page = await db.chatMessage.findMany({
    where: {
      threadId: thread.id,
      ...(pivot ? { OR: [
        { createdAt: { lt: pivot.createdAt } },
        { createdAt: pivot.createdAt, id: { lt: pivot.id } },
      ] } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: messagePageSize + 1,
  });
  const hasEarlier = page.length > messagePageSize;
  const messages = page.slice(0, messagePageSize).reverse();
  const proposalIds = [...new Set(messages.flatMap(message => message.proposalId ? [message.proposalId] : []))];
  const proposals = proposalIds.length
    ? await db.sessionProposal.findMany({ where: { id: { in: proposalIds } }, include: proposalInclude })
    : [];
  const students = thread.kind === 'SESSION' && thread.booking ? activeStudents(thread.booking) : accountStudents(thread);
  const conversation = await conversationJson(thread, viewer, role, db);
  const validProposal = (proposal: FullProposal) => thread.kind === 'SESSION'
    || conversation.schedulingOptions.some(option => option.businessSlug === proposal.business.slug
      && option.serviceId === proposal.serviceId && option.instructorId === proposal.instructorId
      && option.locationId === proposal.locationId);
  const proposalById = new Map(proposals.map(proposal => [proposal.id, proposalJson(proposal, {
    viewer, role, students, validContext: validProposal(proposal), now: new Date(),
  })]));
  const viewerId = viewer?.userId ?? null;
  const participant = role === 'STUDENT' || role === 'COACH' || role === 'CLUB';
  const [messaging, viewerReports] = await Promise.all([
    accountMessagingState(thread, viewer, db),
    viewer && messages.length ? db.chatSafetyReport.findMany({
      where: { reporterUserId: viewer.userId, messageId: { in: messages.map(message => message.id) } },
      select: { messageId: true },
    }) : [],
  ]);
  const reportedMessageIds = new Set(viewerReports.flatMap(report => report.messageId ? [report.messageId] : []));
  const messagingAllowed = thread.kind !== 'ACCOUNT' || !messaging.blocked;
  const safety = {
    canReport: participant,
    blockTarget: messaging.blockTarget,
    blockedByViewer: messaging.blockedByViewer,
    messagingBlocked: messaging.blocked,
    canBlock: messaging.canBlock,
    canUnblock: messaging.canUnblock,
    reason: messaging.reason,
  };
  return {
    id: thread.id,
    kind: thread.kind as 'SESSION' | 'ACCOUNT',
    bookingId: thread.bookingId,
    lastMessageAt: thread.lastMessageAt.toISOString(),
    session: thread.booking ? sessionJson(thread.booking) : null,
    conversation,
    members: thread.booking ? membersJson(thread.booking, viewerId) : accountMembersJson(thread, viewerId),
    viewer: {
      role,
      canPost: participant && messagingAllowed,
      // Coaches and students plan their next session here; the club reads
      // along but books through its own workspace.
      canPropose: messagingAllowed && (role === 'STUDENT' || role === 'COACH') && students.length > 0
        && conversation.schedulingOptions.length > 0,
      canAssignCoach: thread.kind === 'ACCOUNT' && role === 'CLUB' && !!thread.businessId
        && !!viewer?.clubBusinessIds.includes(thread.businessId)
        && activeAccountMembers(thread).some(member => member.source !== 'CLUB_ASSIGNED' && member.user.accountType === 'STUDENT'),
    },
    messages: messages.map(message => ({
      ...messageJson(message, viewerId),
      proposal: message.proposalId ? proposalById.get(message.proposalId) ?? null : null,
      canReport: !!viewer && participant && message.kind !== 'SYSTEM'
        && !!message.senderUserId && message.senderUserId !== viewer.userId,
      reportedByViewer: reportedMessageIds.has(message.id),
    })),
    safety,
    messaging: {
      blocked: messaging.blocked, blockedByViewer: messaging.blockedByViewer,
      canBlock: messaging.canBlock, canUnblock: messaging.canUnblock, reason: messaging.reason,
    },
    blockTarget: messaging.blockTarget,
    hasEarlier,
  };
}

async function loadAccessibleThread(viewer: ChatViewer, threadId: string, db: Tx | typeof prisma = prisma) {
  const thread = await db.chatThread.findUnique({
    where: { id: threadId }, include: threadInclude,
  });
  const role = !thread ? null
    : thread.kind === 'SESSION' && thread.booking ? chatRoleIn(viewer, thread.booking)
      : thread.kind === 'ACCOUNT' ? accountRoleIn(viewer, thread) : null;
  // A thread the reader cannot join is indistinguishable from one that does
  // not exist, so thread IDs cannot be probed across clubs.
  if (!thread || !role) throw new HttpError(404, 'Chat not found');
  return { thread, role };
}

async function threadDetailInTransaction(tx: Tx, viewer: ChatViewer, threadId: string) {
  const { thread, role } = await loadAccessibleThread(viewer, threadId, tx);
  return buildThreadDetail(thread, viewer, role, {}, tx);
}

export async function chatThreadForViewer(
  viewer: ChatViewer, threadId: string, options: { before?: string; includeAccountChats?: boolean } = {},
) {
  const { thread, role } = await loadAccessibleThread(viewer, threadId);
  if (thread.kind === 'ACCOUNT' && options.includeAccountChats === false) throw new HttpError(404, 'Chat not found');
  return buildThreadDetail(thread, viewer, role, options);
}

function threadSummaryJson(
  thread: LoadedThread & { messages: ChatMessage[] },
  viewerId: string | null,
  unread: number,
  conversation: Awaited<ReturnType<typeof conversationJson>>,
) {
  const last = thread.messages[0];
  return {
    id: thread.id,
    kind: thread.kind as 'SESSION' | 'ACCOUNT',
    bookingId: thread.bookingId,
    lastMessageAt: thread.lastMessageAt.toISOString(),
    session: thread.booking ? sessionJson(thread.booking) : null,
    conversation,
    members: thread.booking ? membersJson(thread.booking, viewerId) : accountMembersJson(thread, viewerId),
    lastMessage: last ? messageJson(last, viewerId) : null,
    unreadCount: unread,
  };
}

function threadSearchWhere(search: string): Prisma.ChatThreadWhereInput {
  const contains = { contains: search, mode: 'insensitive' as const };
  return { OR: [
    { business: { name: contains } },
    { booking: { service: { name: contains } } },
    { booking: { instructor: { name: contains } } },
    { booking: { location: { name: contains } } },
    { booking: { participants: { some: { cancelledAt: null, student: { name: contains } } } } },
    { members: { some: { removedAt: null, user: { OR: [{ name: contains }, { username: contains }] } } } },
  ] };
}

const listQuery = z.object({
  cursor: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  contract: z.literal('accounts').optional(),
}).strict();
const chatContractQuery = z.object({ contract: z.literal('accounts').optional() }).strict();
const chatId = z.string().trim().min(1).max(200);

async function listThreads(
  where: Prisma.ChatThreadWhereInput,
  query: Pick<z.infer<typeof listQuery>, 'q' | 'cursor' | 'limit'>,
) {
  const threads = await prisma.chatThread.findMany({
    where: query.q ? { AND: [where, threadSearchWhere(query.q)] } : where,
    include: {
      ...threadInclude,
      messages: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
    },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = threads.length > query.limit;
  const page = hasMore ? threads.slice(0, query.limit) : threads;
  return { page, nextCursor: hasMore ? page.at(-1)!.id : null };
}

export async function listChatThreads(viewer: ChatViewer, query: z.infer<typeof listQuery>) {
  const includeAccountChats = query.contract === 'accounts';
  const { page, nextCursor } = await listThreads(accessibleThreadsWhere(viewer, includeAccountChats), query);
  const [unread, unreadThreads] = await Promise.all([
    unreadCounts(viewer, page.map(thread => thread.id)),
    unreadThreadCount(viewer, prisma, includeAccountChats),
  ]);
  return {
    threads: await Promise.all(page.map(async thread => threadSummaryJson(
      thread, viewer.userId, unread.get(thread.id) ?? 0, await conversationJson(thread, viewer,
        thread.kind === 'SESSION' && thread.booking ? chatRoleIn(viewer, thread.booking)! : accountRoleIn(viewer, thread)!,
        prisma, { summary: true }),
    ))),
    nextCursor,
    unreadThreads,
    accountChatAvailable: includeAccountChats,
  };
}

// Platform admins read every conversation for safety review. They never
// post, so the reader has no viewer identity and no actions.
export async function listChatThreadsForAdmin(query: z.infer<typeof listQuery>) {
  const includeAccountChats = query.contract === 'accounts';
  const { page, nextCursor } = await listThreads(includeAccountChats ? {} : { kind: 'SESSION' }, query);
  const counts = page.length
    ? await prisma.chatMessage.groupBy({
      // Count what people wrote; system lines are the platform's own record.
      by: ['threadId'], where: { threadId: { in: page.map(thread => thread.id) }, kind: { not: 'SYSTEM' } }, _count: { _all: true },
    })
    : [];
  const countByThread = new Map(counts.map(count => [count.threadId, count._count._all]));
  return {
    threads: await Promise.all(page.map(async thread => ({
      ...threadSummaryJson(thread, null, 0, await conversationJson(thread, null, 'ADMIN', prisma, { summary: true })),
      messageCount: countByThread.get(thread.id) ?? 0,
    }))),
    nextCursor,
    accountChatAvailable: includeAccountChats,
  };
}

export async function chatThreadForAdmin(
  threadId: string, options: { before?: string; includeAccountChats?: boolean } = {},
) {
  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId }, include: threadInclude,
  });
  if (!thread || (thread.kind === 'ACCOUNT' && options.includeAccountChats === false)) {
    throw new HttpError(404, 'Chat not found');
  }
  return buildThreadDetail(thread, null, 'ADMIN', options);
}

export const adminChatListQuery = listQuery;
export const threadQuery = z.object({
  before: z.string().trim().min(1).max(200).optional(),
  contract: z.literal('accounts').optional(),
}).strict();

/**
 * Validate a proposed time against live availability. Nothing is reserved:
 * acceptance repeats this inside the booking transaction.
 */
async function proposedSlotContext(
  tx: Tx,
  source: { businessId: string; serviceId: string; instructorId: string; locationId: string },
  startAt: Date,
  studentUserIds: string[],
) {
  if (!Number.isFinite(startAt.getTime()) || startAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'Choose a time in the future');
  }
  await lockInstructors(tx, [source.instructorId]);
  await lockProposalCommercialTerms(tx, source);
  let context: Awaited<ReturnType<typeof schedulingContext>>;
  try {
    context = await schedulingContext(tx, source.businessId, source.serviceId, source.instructorId, source.locationId);
  } catch (error) {
    if (error instanceof HttpError && [400, 404].includes(error.status)) {
      throw new HttpError(409, 'This class can no longer be booked with this coach at this venue. Ask the club to set it up again.');
    }
    throw error;
  }
  const slot = await evaluateSlot(tx, context, startAt, { studentUserIds });
  if (!slot.available) {
    throw new HttpError(409, 'That time is not available', {
      conflicts: [{ date: startAt.toISOString(), reason: slot.reason || 'Unavailable' }],
    });
  }
  return { slot, context };
}

async function lockProposalCommercialTerms(
  tx: Tx,
  source: { businessId: string; serviceId: string; locationId: string },
) {
  // Currency and the venue-specific price are part of the agreement. Hold
  // their rows through proposal creation or acceptance so catalogue edits
  // cannot interleave after the live terms have been checked. Callers first
  // take the instructor lock, matching the catalogue mutation lock order.
  await tx.$queryRaw`SELECT "id" FROM "Business" WHERE "id" = ${source.businessId} FOR SHARE`;
  await tx.$queryRaw`
    SELECT "id" FROM "ServiceLocation"
    WHERE "serviceId" = ${source.serviceId} AND "locationId" = ${source.locationId}
    FOR SHARE`;
}

async function postProposalMessage(
  tx: Tx,
  threadId: string,
  proposal: { id: string; startAt: Date; counterOfId: string | null },
  author: { userId: string; name: string; role: ChatRole },
  details: { serviceName: string; timezone: string },
) {
  const createdAt = new Date();
  const when = chatWhen(proposal.startAt, details.timezone);
  await tx.chatMessage.create({
    data: {
      threadId, kind: 'PROPOSAL', senderUserId: author.userId, senderRole: author.role, senderName: author.name,
      proposalId: proposal.id, createdAt,
      body: proposal.counterOfId
        ? `${author.name} suggested a different time: ${when}.`
        : `${author.name} proposed the next session: ${details.serviceName} on ${when}.`,
    },
  });
  await touchThread(tx, threadId, createdAt);
  await markRead(tx, threadId, author.userId, createdAt);
}

async function touchThread(tx: Tx, threadId: string, at: Date) {
  await tx.chatThread.updateMany({ where: { id: threadId, lastMessageAt: { lt: at } }, data: { lastMessageAt: at } });
}

async function markRead(tx: Tx | typeof prisma, threadId: string, userId: string, at: Date) {
  // One atomic statement. Opening a thread and sending in it both mark it
  // read, and a find-then-insert upsert let those concurrent first reads race
  // into a primary-key violation. Read positions only move forward, whichever
  // request lands last. The column stores UTC wall time without a zone.
  await tx.$executeRaw`
    INSERT INTO "ChatReadState" ("threadId", "userId", "lastReadAt")
    VALUES (${threadId}, ${userId}, (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
    ON CONFLICT ("threadId", "userId")
    DO UPDATE SET "lastReadAt" = GREATEST("ChatReadState"."lastReadAt", EXCLUDED."lastReadAt")
  `;
}

async function lockSessionCoachAccessForWrite(tx: Tx, viewer: ChatViewer, instructorId: string) {
  if (viewer.accountType !== 'COACH') return;
  // Follow the scheduling lock order before retaining shared roster locks.
  // Every write reloads access after them, so deactivation either finishes
  // first or waits until this authorized write commits.
  await lockInstructors(tx, [instructorId]);
  await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "instructorId" = ${instructorId} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "Instructor" WHERE "id" = ${instructorId} FOR SHARE`;
}

async function lockThreadAccessForWrite(tx: Tx, viewer: ChatViewer, threadId: string) {
  const thread = await tx.chatThread.findUnique({
    where: { id: threadId }, select: { kind: true, booking: { select: { instructorId: true } } },
  });
  if (thread?.kind === 'ACCOUNT') {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-chat-coach:${threadId}`}, 0))`;
    const assignedInstructorIds = (await tx.chatThreadMember.findMany({
      where: { threadId, source: 'CLUB_ASSIGNED', removedAt: null },
      select: { membership: { select: { instructorId: true } } },
    })).flatMap(member => member.membership?.instructorId ? [member.membership.instructorId] : []);
    // Assignment takes the conversation lock held above, so an empty roster
    // cannot gain a coach before commit and the row locks below would be no-ops.
    if (!assignedInstructorIds.length) return;
    // Instructor lifecycle writers take the scheduling lock before changing
    // roster rows. Follow that order here too, or a proposal could retain a
    // row share lock while waiting on a deletion that needs the same row.
    await lockInstructors(tx, assignedInstructorIds);
    // Automatic roster revocation does not take the conversation advisory
    // lock, so retain the assigned roster rows before rechecking membership.
    await tx.$queryRaw`
      SELECT membership."id"
      FROM "ChatThreadMember" AS member
      JOIN "Membership" AS membership ON membership."id" = member."membershipId"
      WHERE member."threadId" = ${threadId}
        AND member."source" = 'CLUB_ASSIGNED' AND member."removedAt" IS NULL
      FOR SHARE OF membership`;
    await tx.$queryRaw`
      SELECT instructor."id"
      FROM "ChatThreadMember" AS member
      JOIN "Membership" AS membership ON membership."id" = member."membershipId"
      JOIN "Instructor" AS instructor ON instructor."id" = membership."instructorId"
      WHERE member."threadId" = ${threadId}
        AND member."source" = 'CLUB_ASSIGNED' AND member."removedAt" IS NULL
      FOR SHARE OF instructor`;
  } else if (thread?.kind === 'SESSION' && viewer.accountType === 'COACH' && thread.booking) {
    await lockSessionCoachAccessForWrite(tx, viewer, thread.booking.instructorId);
  }
}

const proposalInput = z.object({
  startAt: z.string().datetime({ offset: true }),
  message: z.string().trim().max(500).default(''),
}).strict();
const accountProposalInput = proposalInput.extend({
  businessSlug: z.string().trim().min(1).max(80),
  serviceId: z.string().trim().min(1).max(200),
  locationId: z.string().trim().min(1).max(200),
}).strict();
const declineInput = z.object({ message: z.string().trim().max(500).default('') }).strict();
const emptyInput = z.object({}).strict();

/** A person may keep a few options open at once, but not flood a chat. */
const maxOpenProposalsPerPerson = 3;

export async function proposeNextSession(viewer: ChatViewer, threadId: string, rawInput: unknown) {
  return prisma.$transaction(async tx => {
    await lockThreadAccessForWrite(tx, viewer, threadId);
    const { thread, role } = await loadAccessibleThread(viewer, threadId, tx);
    await assertAccountMessagingAllowed(tx, viewer, thread);
    if (role !== 'STUDENT' && role !== 'COACH') {
      throw new HttpError(403, 'Only a coach and student in this conversation can propose a time');
    }
    const accountInput = thread.kind === 'ACCOUNT' ? accountProposalInput.parse(rawInput) : null;
    const input = accountInput ?? proposalInput.parse(rawInput);
    const students = thread.kind === 'SESSION' && thread.booking ? activeStudents(thread.booking) : accountStudents(thread);
    if (!students.length) throw new HttpError(400, 'There is no student in this conversation to propose a time to');
    const choices = await schedulingOptionsFor(thread, tx);
    const source = thread.kind === 'SESSION' && thread.booking ? {
      businessId: thread.booking.businessId, businessName: thread.booking.business.name,
      businessSlug: thread.booking.business.slug, timezone: thread.booking.business.timezone,
      price: thread.booking.price, currency: thread.booking.business.currency,
      serviceId: thread.booking.serviceId, serviceName: thread.booking.service.name,
      instructorId: thread.booking.instructorId, instructorName: thread.booking.instructor.name,
      locationId: thread.booking.locationId, locationName: thread.booking.location.name, address: thread.booking.address,
    } : choices.find(option => option.businessSlug === accountInput!.businessSlug
      && option.serviceId === accountInput!.serviceId && option.locationId === accountInput!.locationId);
    if (!source) {
      throw new HttpError(409, 'This class can no longer be proposed in this conversation. Choose another class or ask the club to assign a coach.');
    }
    // A student proposes for themselves. A coach addresses the one student in
    // a private session, or the whole group, where each student answers.
    const target = role === 'STUDENT'
      ? students.find(student => student.userId === viewer.userId)!
      : thread.kind === 'ACCOUNT' || (thread.booking?.type === 'PRIVATE' && students.length === 1) ? students[0] : null;
    const openCount = await tx.sessionProposal.count({
      where: { threadId: thread.id, proposedByUserId: viewer.userId, status: 'OPEN', startAt: { gt: new Date() } },
    });
    if (openCount >= maxOpenProposalsPerPerson) {
      throw new HttpError(409, 'You already have several proposals waiting for an answer. Withdraw one first.');
    }
    const startAt = new Date(input.startAt);
    const { slot, context } = await proposedSlotContext(tx, source, startAt, target ? [target.userId] : []);
    const author = { userId: viewer.userId, name: displayNameForThread(thread, role, viewer), role };
    const proposal = await tx.sessionProposal.create({
      data: {
        businessId: source.businessId, threadId: thread.id,
        serviceId: source.serviceId, instructorId: source.instructorId,
        locationId: source.locationId, address: source.address ?? '',
        price: context.assignment.price, currency: context.business.currency,
        startAt, endAt: slot.endAt, proposedByRole: role, proposedByUserId: viewer.userId,
        proposedByName: author.name, targetStudentUserId: target?.userId ?? null,
        targetStudentName: target?.name ?? '', message: input.message,
      },
    });
    await postProposalMessage(tx, thread.id, proposal, author, {
      serviceName: source.serviceName, timezone: source.timezone,
    });
    return { threadId: thread.id, thread: await threadDetailInTransaction(tx, viewer, thread.id) };
  }, { timeout: 30_000 });
}

async function lockAndLoadProposal(tx: Tx, viewer: ChatViewer, proposalId: string) {
  // Accept, decline, counter and withdraw are competing terminal decisions.
  // Serialize them on the proposal before reading its state, so a waiter sees
  // the winner's committed answer instead of acting on a stale OPEN row.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`session-proposal:${proposalId}`}, 0))`;
  const proposal = await tx.sessionProposal.findUnique({ where: { id: proposalId }, include: proposalInclude });
  if (!proposal) throw new HttpError(404, 'Proposal not found');
  await lockThreadAccessForWrite(tx, viewer, proposal.threadId);
  const { thread, role } = await loadAccessibleThread(viewer, proposal.threadId, tx).catch(error => {
    if (error instanceof HttpError && error.status === 404) throw new HttpError(404, 'Proposal not found');
    throw error;
  });
  await assertAccountMessagingAllowed(tx, viewer, thread);
  return { proposal, thread, role };
}

async function proposalStudentsAndContext(
  tx: Tx,
  thread: LoadedThread,
  proposal: FullProposal,
) {
  const students = thread.kind === 'SESSION' && thread.booking ? activeStudents(thread.booking) : accountStudents(thread);
  if (thread.kind === 'ACCOUNT') {
    const options = await schedulingOptionsFor(thread, tx);
    if (!options.some(option => option.businessId === proposal.businessId
      && option.serviceId === proposal.serviceId && option.instructorId === proposal.instructorId
      && option.locationId === proposal.locationId)) {
      throw new HttpError(409, 'This proposal is no longer available because the conversation’s scheduling setup changed');
    }
  }
  return students;
}

function proposalSystemLine(
  tx: Tx,
  thread: LoadedThread,
  line: Parameters<typeof postThreadSystemLine>[2],
) {
  return thread.kind === 'SESSION' && thread.bookingId
    ? postChatSystemLine(tx, thread.bookingId, line)
    : postThreadSystemLine(tx, thread.id, line);
}

function assertAnswerable(proposal: FullProposal, viewer: ChatViewer, role: ChatRole, students: Student[]) {
  if (proposal.status !== 'OPEN') throw new HttpError(409, 'This proposal has already been answered');
  if (proposal.startAt.getTime() <= Date.now()) throw new HttpError(409, 'This proposed time has already passed');
  const student = responderFor(proposal, viewer, role, students);
  if (student) return student;
  if (proposal.proposedByUserId === viewer.userId) {
    throw new HttpError(403, 'The other side answers a proposal. Withdraw your own proposal instead.');
  }
  if (proposal.responses.some(response => response.studentUserId === viewer.userId)) {
    throw new HttpError(409, 'You have already answered this proposal');
  }
  if (proposal.proposedByRole === 'STUDENT' && role === 'COACH') {
    throw new HttpError(409, 'That student is no longer booked into this session');
  }
  throw new HttpError(403, proposal.proposedByRole === 'STUDENT'
    ? 'Only the coach can answer a student’s proposal'
    : 'Only the student this proposal is for can answer it');
}

/**
 * Close a proposal once nobody is left to answer it: at the first answer for
 * a one-student proposal, or when every student in a group has answered.
 */
async function settleProposal(
  tx: Tx,
  proposal: FullProposal,
  outcome: 'ACCEPTED' | 'DECLINED' | 'COUNTERED',
  students: Student[],
) {
  const closedAt = new Date();
  if (proposal.targetStudentUserId) {
    await tx.sessionProposal.updateMany({ where: { id: proposal.id, status: 'OPEN' }, data: { status: outcome, closedAt } });
    return;
  }
  const answered = new Set((await tx.sessionProposalResponse.findMany({
    where: { proposalId: proposal.id }, select: { studentUserId: true },
  })).map(response => response.studentUserId));
  if (students.every(student => answered.has(student.userId))) {
    await tx.sessionProposal.updateMany({ where: { id: proposal.id, status: 'OPEN' }, data: { status: 'CLOSED', closedAt } });
  }
}

export async function acceptProposal(viewer: ChatViewer, proposalId: string, rawInput: unknown) {
  emptyInput.parse(rawInput ?? {});
  return prisma.$transaction(async tx => {
    const { proposal, thread, role } = await lockAndLoadProposal(tx, viewer, proposalId);
    const students = await proposalStudentsAndContext(tx, thread, proposal);
    const student = assertAnswerable(proposal, viewer, role, students);
    await lockInstructors(tx, [proposal.instructorId]);
    await lockProposalCommercialTerms(tx, proposal);
    let liveContext: Awaited<ReturnType<typeof schedulingContext>>;
    try {
      liveContext = await schedulingContext(
        tx, proposal.businessId, proposal.serviceId, proposal.instructorId, proposal.locationId,
      );
    } catch (error) {
      if (error instanceof HttpError && [400, 404].includes(error.status)) {
        throw new HttpError(409, 'This proposed class is no longer available. Send a new proposal.');
      }
      throw error;
    }
    if (liveContext.assignment.price !== proposal.price || liveContext.business.currency !== proposal.currency) {
      throw new HttpError(409, 'The class price changed after this proposal was sent. Send a new proposal with the current price.');
    }
    const account = await tx.user.findUnique({
      where: { id: student.userId }, select: { name: true, email: true, accountType: true, passwordHash: true },
    });
    if (!account || account.accountType !== 'STUDENT' || !account.passwordHash) {
      throw new HttpError(409, 'That student account can no longer be booked');
    }
    // Both sides agreed, so this is the student's booking of an agreed time:
    // it needs no further coach acceptance and follows the club money path.
    const result = await createBookingsInTransaction(tx, proposal.businessId, bookingInput.parse({
      serviceId: proposal.serviceId, instructorId: proposal.instructorId, locationId: proposal.locationId,
      startAt: proposal.startAt.toISOString(), address: proposal.address, notes: '',
      student: { name: account.name, email: account.email },
    }), { studentUserId: student.userId });
    const booking = result.bookings[0];
    if (booking.price !== proposal.price
      || booking.participants.some(participant => participant.price !== proposal.price)) {
      throw new HttpError(409, 'The class price changed after this proposal was sent. Send a new proposal with the current price.');
    }
    await tx.sessionProposalResponse.create({
      data: {
        proposalId: proposal.id, studentUserId: student.userId, studentName: student.name,
        responderUserId: viewer.userId, status: 'ACCEPTED', bookingId: booking.id,
      },
    });
    await settleProposal(tx, proposal, 'ACCEPTED', students);
    const responderName = displayNameForThread(thread, role, viewer);
    const when = chatWhen(proposal.startAt, proposal.business.timezone);
    const booked = `${student.name} is booked for ${proposal.service.name} on ${when}`;
    const status = booking.status === 'PENDING'
      ? ' The club is confirming the venue before it goes on the calendar.'
      : ' It has been added to the calendar.';
    await proposalSystemLine(tx, thread, {
      event: 'PROPOSAL_ACCEPTED',
      body: role === 'COACH' ? `${responderName} accepted. ${booked}.${status}` : `${booked}.${status}`,
      actor: { userId: viewer.userId, name: responderName },
    });
    await markRead(tx, thread.id, viewer.userId, new Date());
    return {
      threadId: thread.id, bookingId: booking.id,
      thread: await threadDetailInTransaction(tx, viewer, thread.id),
    };
  }, { timeout: 30_000 });
}

export async function declineProposal(viewer: ChatViewer, proposalId: string, rawInput: unknown) {
  const input = declineInput.parse(rawInput ?? {});
  return prisma.$transaction(async tx => {
    const { proposal, thread, role } = await lockAndLoadProposal(tx, viewer, proposalId);
    const students = await proposalStudentsAndContext(tx, thread, proposal);
    const student = assertAnswerable(proposal, viewer, role, students);
    await tx.sessionProposalResponse.create({
      data: {
        proposalId: proposal.id, studentUserId: student.userId, studentName: student.name,
        responderUserId: viewer.userId, status: 'DECLINED',
      },
    });
    await settleProposal(tx, proposal, 'DECLINED', students);
    const responderName = displayNameForThread(thread, role, viewer);
    await proposalSystemLine(tx, thread, {
      event: 'PROPOSAL_DECLINED',
      body: `${responderName} declined ${chatWhen(proposal.startAt, proposal.business.timezone)}.`
        + (input.message ? ` “${input.message}”` : ''),
      actor: { userId: viewer.userId, name: responderName },
    });
    await markRead(tx, thread.id, viewer.userId, new Date());
    return { threadId: thread.id, thread: await threadDetailInTransaction(tx, viewer, thread.id) };
  }, { timeout: 30_000 });
}

/**
 * "Edit": answer with a different time. The original closes and a new
 * proposal travels back the other way, so the person who asked first is the
 * one who confirms the final time.
 */
export async function counterProposal(viewer: ChatViewer, proposalId: string, rawInput: unknown) {
  return prisma.$transaction(async tx => {
    const { proposal, thread, role } = await lockAndLoadProposal(tx, viewer, proposalId);
    const accountInput = thread.kind === 'ACCOUNT' ? accountProposalInput.parse(rawInput) : null;
    const input = accountInput ?? proposalInput.parse(rawInput);
    const students = await proposalStudentsAndContext(tx, thread, proposal);
    const student = assertAnswerable(proposal, viewer, role, students);
    const startAt = new Date(input.startAt);
    if (startAt.getTime() === proposal.startAt.getTime()) {
      throw new HttpError(400, 'Choose a different time to suggest, or accept this one');
    }
    let source: {
      businessId: string; serviceId: string; instructorId: string; locationId: string; address: string;
      serviceName: string; timezone: string; price: number; currency: string;
    };
    if (thread.kind === 'ACCOUNT') {
      const choice = (await schedulingOptionsFor(thread, tx)).find(option => option.businessSlug === accountInput!.businessSlug
        && option.serviceId === accountInput!.serviceId && option.locationId === accountInput!.locationId);
      if (!choice) throw new HttpError(409, 'This class can no longer be proposed in this conversation');
      source = { ...choice, address: choice.address ?? '' };
    } else {
      source = {
        businessId: proposal.businessId, serviceId: proposal.serviceId, instructorId: proposal.instructorId,
        locationId: proposal.locationId, address: proposal.address, serviceName: proposal.service.name,
        timezone: proposal.business.timezone, price: proposal.price, currency: proposal.currency,
      };
    }
    const { slot, context } = await proposedSlotContext(tx, source, startAt, [student.userId]);
    await tx.sessionProposalResponse.create({
      data: {
        proposalId: proposal.id, studentUserId: student.userId, studentName: student.name,
        responderUserId: viewer.userId, status: 'COUNTERED',
      },
    });
    await settleProposal(tx, proposal, 'COUNTERED', students);
    const author = { userId: viewer.userId, name: displayNameForThread(thread, role, viewer), role };
    const counter = await tx.sessionProposal.create({
      data: {
        businessId: source.businessId, threadId: proposal.threadId, serviceId: source.serviceId,
        instructorId: source.instructorId, locationId: source.locationId, address: source.address,
        price: context.assignment.price, currency: context.business.currency,
        startAt, endAt: slot.endAt, proposedByRole: role, proposedByUserId: viewer.userId,
        proposedByName: author.name, targetStudentUserId: student.userId, targetStudentName: student.name,
        counterOfId: proposal.id, message: input.message,
      },
    });
    await postProposalMessage(tx, thread.id, counter, author, {
      serviceName: source.serviceName, timezone: source.timezone,
    });
    return {
      threadId: thread.id, proposalId: counter.id,
      thread: await threadDetailInTransaction(tx, viewer, thread.id),
    };
  }, { timeout: 30_000 });
}

export async function withdrawProposal(viewer: ChatViewer, proposalId: string, rawInput: unknown) {
  emptyInput.parse(rawInput ?? {});
  return prisma.$transaction(async tx => {
    const { proposal, thread, role } = await lockAndLoadProposal(tx, viewer, proposalId);
    if (proposal.proposedByUserId !== viewer.userId) {
      throw new HttpError(403, 'Only the person who proposed a time can withdraw it');
    }
    if (proposal.status !== 'OPEN') throw new HttpError(409, 'This proposal has already been answered');
    await tx.sessionProposal.update({ where: { id: proposal.id }, data: { status: 'WITHDRAWN', closedAt: new Date() } });
    const name = displayNameForThread(thread, role, viewer);
    await proposalSystemLine(tx, thread, {
      event: 'PROPOSAL_WITHDRAWN',
      body: `${name} withdrew the proposed time (${chatWhen(proposal.startAt, proposal.business.timezone)}).`,
      actor: { userId: viewer.userId, name },
    });
    await markRead(tx, thread.id, viewer.userId, new Date());
    return { threadId: thread.id, thread: await threadDetailInTransaction(tx, viewer, thread.id) };
  }, { timeout: 30_000 });
}

/**
 * Open the chat for a booking, creating it on first use. Bookings made
 * before chat shipped gain a thread the first time someone opens it.
 */
export async function openBookingChat(viewer: ChatViewer, bookingId: string) {
  return prisma.$transaction(async tx => {
    const candidate = await tx.booking.findUnique({ where: { id: bookingId }, select: { instructorId: true } });
    if (candidate) await lockSessionCoachAccessForWrite(tx, viewer, candidate.instructorId);
    const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: sessionInclude });
    if (candidate && booking?.instructorId !== candidate.instructorId) {
      throw new HttpError(409, 'Session changed concurrently. Please retry.');
    }
    if (!booking || !chatRoleIn(viewer, booking)) throw new HttpError(404, 'Chat not found');
    const threadId = await ensureChatThread(tx, booking.id);
    if (!threadId) throw new HttpError(404, 'Chat not found');
    return threadId;
  });
}

const accountChatInput = z.object({
  username: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9_]+$/, 'Enter an exact username'),
}).strict();
const coachAssignmentInput = z.object({ membershipId: z.string().trim().min(1).max(200) }).strict();

/** Open the one durable account conversation for an unordered pair. */
export async function openAccountChat(viewer: ChatViewer, rawInput: unknown) {
  const { username: rawUsername } = accountChatInput.parse(rawInput);
  const username = rawUsername.toLowerCase();
  const target = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true, name: true, username: true, accountType: true, passwordHash: true,
      dateOfBirth: true, accountControl: true, accountStatus: true, profileVisibility: true,
    },
  });
  const targetPolicy = target?.passwordHash ? await loadAccountPolicy(target) : null;
  if (!target || !targetPolicy?.publiclyDiscoverable) {
    throw new HttpError(404, 'Account not found');
  }
  if (target.id === viewer.userId) throw new HttpError(400, 'Choose another account to start a conversation');
  const accountIds = [viewer.userId, target.id].sort();
  const directKey = accountIds.join(':');
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-chat:${directKey}`}, 0))`;
    await assertDirectPairMessagingAllowed(tx, viewer, target.id);
    const existing = await tx.chatThread.findUnique({ where: { directKey }, select: { id: true } });
    if (existing) return existing.id;
    const clubUserId = [
      ...(viewer.accountType === 'CLUB' ? [viewer.userId] : []),
      ...(target.accountType === 'CLUB' ? [target.id] : []),
    ];
    let businessId: string | null = null;
    if (clubUserId.length === 1) {
      const institutional = await tx.membership.findFirst({
        where: {
          userId: clubUserId[0], active: true, instructorId: null,
          business: { kind: 'CLUB', legacyReadOnly: false },
        },
        select: { businessId: true },
      });
      if (!institutional) throw new HttpError(409, 'That club is not available for conversations');
      businessId = institutional.businessId;
    }
    const now = new Date();
    const thread = await tx.chatThread.create({
      data: {
        kind: 'ACCOUNT', businessId, directKey, lastMessageAt: now, createdAt: now,
        members: { create: [
          { userId: viewer.userId, source: 'INITIATOR', joinedAt: now, addedByUserId: viewer.userId },
          { userId: target.id, source: 'TARGET', joinedAt: now, addedByUserId: viewer.userId },
        ] },
        messages: { create: {
          kind: 'SYSTEM', event: 'OPENED', senderRole: 'SYSTEM',
          body: 'This account conversation is ready. Everyone shown as a member can read and reply here.', createdAt: now,
        } },
      },
      select: { id: true },
    });
    await markRead(tx, thread.id, viewer.userId, now);
    return thread.id;
  });
}

function assertCoachAssignableRoom(viewer: ChatViewer, thread: LoadedThread, role: ChatRole) {
  const directMembers = activeAccountMembers(thread).filter(member => member.source !== 'CLUB_ASSIGNED');
  const clubStudentPair = directMembers.length === 2
    && directMembers.some(member => member.user.accountType === 'CLUB')
    && directMembers.some(member => member.user.accountType === 'STUDENT');
  if (thread.kind !== 'ACCOUNT' || role !== 'CLUB' || !thread.businessId
    || !viewer.clubBusinessIds.includes(thread.businessId) || !clubStudentPair) {
    throw new HttpError(404, 'Chat not found');
  }
}

export async function assignConversationCoach(viewer: ChatViewer, threadId: string, rawInput: unknown) {
  const input = coachAssignmentInput.parse(rawInput);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-chat-coach:${threadId}`}, 0))`;
    const { thread, role } = await loadAccessibleThread(viewer, threadId, tx);
    assertCoachAssignableRoom(viewer, thread, role);
    await assertAccountMessagingAllowed(tx, viewer, thread);
    const membership = await tx.membership.findFirst({
      where: {
        id: input.membershipId, businessId: thread.businessId!, active: true,
        instructor: { is: bookableInstructorWhere(thread.businessId!) },
        user: { accountType: 'COACH', passwordHash: { not: null } },
      },
      select: { id: true, userId: true, user: { select: { name: true } } },
    });
    if (!membership) throw new HttpError(404, 'Coach not found');
    await assertProspectiveAccountMemberAllowed(tx, thread, membership.userId);
    const current = activeAccountMembers(thread).find(member => member.source === 'CLUB_ASSIGNED');
    if (current?.membershipId === membership.id) return thread.id;
    const now = new Date();
    await tx.chatThreadMember.updateMany({
      where: { threadId, source: 'CLUB_ASSIGNED', removedAt: null }, data: { removedAt: now },
    });
    await tx.chatThreadMember.upsert({
      where: { threadId_userId: { threadId, userId: membership.userId } },
      create: {
        threadId, userId: membership.userId, source: 'CLUB_ASSIGNED', membershipId: membership.id,
        joinedAt: now, addedByUserId: viewer.userId,
      },
      update: {
        source: 'CLUB_ASSIGNED', membershipId: membership.id, joinedAt: now, removedAt: null, addedByUserId: viewer.userId,
      },
    });
    await postThreadSystemLine(tx, threadId, {
      event: 'COACH_ASSIGNED', body: `${membership.user.name} was assigned to this conversation.`,
      actor: { userId: viewer.userId, name: viewer.name },
    });
    return thread.id;
  });
}

export async function removeConversationCoach(viewer: ChatViewer, threadId: string, rawInput: unknown) {
  emptyInput.parse(rawInput ?? {});
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`account-chat-coach:${threadId}`}, 0))`;
    const { thread, role } = await loadAccessibleThread(viewer, threadId, tx);
    assertCoachAssignableRoom(viewer, thread, role);
    const current = activeAccountMembers(thread).find(member => member.source === 'CLUB_ASSIGNED');
    if (!current) return thread.id;
    await tx.chatThreadMember.update({
      where: { threadId_userId: { threadId, userId: current.userId } }, data: { removedAt: new Date() },
    });
    await postThreadSystemLine(tx, threadId, {
      event: 'COACH_REMOVED', body: `${current.user.name} was removed from this conversation.`,
      actor: { userId: viewer.userId, name: viewer.name },
    });
    return thread.id;
  });
}

function reportReceipt(report: {
  id: string; category: string; status: string; severity: string; childInvolved: boolean; createdAt: Date;
}) {
  return {
    id: report.id, category: report.category, status: report.status, severity: report.severity,
    childInvolved: report.childInvolved, createdAt: report.createdAt.toISOString(),
  };
}

function threadUserSnapshots(thread: LoadedThread) {
  if (thread.kind === 'ACCOUNT') return activeAccountMembers(thread).map(member => ({
    userId: member.userId, name: member.user.name, username: member.user.username,
    role: member.user.accountType as ChatRole, assigned: member.source === 'CLUB_ASSIGNED',
  }));
  if (!thread.booking) return [];
  const booking = thread.booking;
  const coach = booking.instructor.membership?.active ? [{
    userId: booking.instructor.membership.userId, name: booking.instructor.name,
    username: booking.instructor.membership.user.username, role: 'COACH' as const, assigned: true,
  }] : [];
  const students = activeStudents(booking).map(student => ({
    userId: student.userId, name: student.name, username: student.username ?? '',
    role: 'STUDENT' as const, assigned: false,
  }));
  const club = booking.business.memberships[0]?.user;
  return [...coach, ...students, ...(club ? [{
    userId: club.id, name: booking.business.name, username: club.username,
    role: 'CLUB' as const, assigned: false,
  }] : [])];
}

async function nearbyReportContext(tx: Tx, threadId: string, message: ChatMessage) {
  const earlier = await tx.chatMessage.findMany({
    where: { threadId, OR: [
      { createdAt: { lt: message.createdAt } },
      { createdAt: message.createdAt, id: { lt: message.id } },
    ] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: reportContextRadius,
  });
  const later = await tx.chatMessage.findMany({
    where: { threadId, OR: [
      { createdAt: { gt: message.createdAt } },
      { createdAt: message.createdAt, id: { gt: message.id } },
    ] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: reportContextRadius,
  });
  return [...earlier.reverse(), message, ...later].map(evidenceMessage);
}

export async function reportChatSafetyConcern(viewer: ChatViewer, threadId: string, rawInput: unknown) {
  const input = reportInput.parse(rawInput);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chat-report:${viewer.userId}:${threadId}:${input.messageId ?? 'thread'}:${input.category}`}, 0))`;
    const { thread } = await loadAccessibleThread(viewer, threadId, tx);
    const pair = exactDirectPair(thread);
    if (!input.messageId && (thread.kind !== 'ACCOUNT' || !pair || !pair.some(member => member.userId === viewer.userId))) {
      throw new HttpError(400, 'Choose a message to report in this conversation');
    }
    const message = input.messageId ? await tx.chatMessage.findFirst({
      where: { id: input.messageId, threadId },
    }) : null;
    if (input.messageId && !message) throw new HttpError(400, 'That message is not part of this chat');
    if (message && (message.kind === 'SYSTEM' || !message.senderUserId)) {
      throw new HttpError(400, 'System messages cannot be reported');
    }
    if (message?.senderUserId === viewer.userId) throw new HttpError(400, 'You cannot report your own message');

    const subjectUserId = message?.senderUserId
      ?? pair?.find(member => member.userId !== viewer.userId)?.userId
      ?? null;
    if (!subjectUserId || subjectUserId === viewer.userId) throw new HttpError(400, 'Choose another account to report');

    const duplicate = await tx.chatSafetyReport.findFirst({
      where: {
        threadId, messageId: input.messageId ?? null, reporterUserId: viewer.userId, category: input.category,
      },
      select: { id: true, category: true, status: true, severity: true, childInvolved: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (duplicate) return { report: reportReceipt(duplicate), created: false };

    const memberSnapshots = threadUserSnapshots(thread);
    const userIds = [...new Set([viewer.userId, subjectUserId, ...memberSnapshots.map(member => member.userId)])];
    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, username: true, accountType: true, dateOfBirth: true, accountControl: true, accountStatus: true },
    });
    const userById = new Map(users.map(user => [user.id, user]));
    const reporter = userById.get(viewer.userId);
    const subject = userById.get(subjectUserId);
    if (!reporter || !subject) throw new HttpError(409, 'A conversation account is no longer available');
    const childInvolved = users.some(user => user.accountType === 'STUDENT'
      && (user.accountControl === 'GUARDIAN_MANAGED'
        || (ageOnSingaporeDate(user.dateOfBirth) ?? Number.POSITIVE_INFINITY) < 18));
    const severity = initialReportSeverity(input.category, childInvolved);
    const context = message ? await nearbyReportContext(tx, threadId, message) : [];
    const evidence = {
      version: 1, capturedAt: new Date().toISOString(),
      thread: { id: thread.id, kind: thread.kind },
      business: thread.business ? { id: thread.business.id, name: thread.business.name, slug: thread.business.slug } : null,
      session: thread.booking ? {
        bookingId: thread.booking.id, serviceName: thread.booking.service.name,
        startAt: thread.booking.startAt.toISOString(), timezone: thread.booking.business.timezone,
      } : null,
      reporter: { userId: reporter.id, name: reporter.name, username: reporter.username, accountType: reporter.accountType },
      subject: { userId: subject.id, name: subject.name, username: subject.username, accountType: subject.accountType },
      members: memberSnapshots.map(member => ({
        userId: member.userId, name: member.name, username: member.username, role: member.role, assigned: member.assigned,
      })),
      reportedMessage: message ? evidenceMessage(message) : null,
      context,
    } satisfies Prisma.InputJsonObject;
    const report = await tx.chatSafetyReport.create({
      data: {
        threadId: thread.id, messageId: message?.id ?? null, businessId: thread.businessId, bookingId: thread.bookingId,
        reporterUserId: viewer.userId, subjectUserId, category: input.category, status: 'OPEN', severity, childInvolved,
        description: input.description, evidence, evidenceHash: evidenceHash(evidence),
        auditEvents: { create: {
          actorKind: 'ACCOUNT', actorUserId: viewer.userId, actorName: viewer.name, action: 'REPORT_CREATED',
          toStatus: 'OPEN', toSeverity: severity,
        } },
      },
      select: { id: true, category: true, status: true, severity: true, childInvolved: true, createdAt: true },
    });
    return { report: reportReceipt(report), created: true };
  });
}

export async function setChatAccountBlock(viewer: ChatViewer, threadId: string, blocked: boolean) {
  return prisma.$transaction(async tx => {
    const { thread } = await loadAccessibleThread(viewer, threadId, tx);
    if (thread.kind !== 'ACCOUNT') throw new HttpError(400, 'Only direct account conversations can be blocked');
    const direct = directPairForViewer(thread, viewer);
    if (!direct) throw new HttpError(403, 'Only the two direct participants can block this conversation');
    await lockAccountSafetyPair(tx, direct.pair.map(member => member.userId));
    const key = { blockerUserId: viewer.userId, blockedUserId: direct.target.userId };
    if (blocked) {
      await tx.chatAccountBlock.upsert({
        where: { blockerUserId_blockedUserId: key }, create: key, update: {},
      });
    } else {
      const removed = await tx.chatAccountBlock.deleteMany({ where: key });
      if (!removed.count) throw new HttpError(403, 'You can only remove a block that you placed');
    }
    return threadDetailInTransaction(tx, viewer, threadId);
  });
}

export async function postChatMessage(viewer: ChatViewer, threadId: string, rawInput: unknown) {
  const input = z.object({
    body: z.string().trim().min(1, 'Write a message first').max(2000, 'Keep messages under 2,000 characters'),
  }).strict().parse(rawInput);
  return prisma.$transaction(async tx => {
    await lockThreadAccessForWrite(tx, viewer, threadId);
    const { thread, role } = await loadAccessibleThread(viewer, threadId, tx);
    await assertAccountMessagingAllowed(tx, viewer, thread);
    const createdAt = new Date();
    const message = await tx.chatMessage.create({
      data: {
        threadId: thread.id, kind: 'TEXT', senderUserId: viewer.userId, senderRole: role,
        senderName: displayNameForThread(thread, role, viewer), body: input.body, createdAt,
      },
    });
    await touchThread(tx, thread.id, createdAt);
    await markRead(tx, thread.id, viewer.userId, createdAt);
    return messageJson(message, viewer.userId);
  });
}

export async function markChatRead(viewer: ChatViewer, threadId: string, includeAccountChats = true) {
  return prisma.$transaction(async tx => {
    await lockThreadAccessForWrite(tx, viewer, threadId);
    const { thread } = await loadAccessibleThread(viewer, threadId, tx);
    await markRead(tx, thread.id, viewer.userId, new Date());
    return unreadThreadCount(viewer, tx, includeAccountChats);
  });
}

function reminderText(
  session: { startAt: Date; status: string; service: { name: string }; instructor: { name: string }; location: { name: string } },
  timezone: string,
  now: Date,
) {
  const start = DateTime.fromJSDate(session.startAt, { zone: timezone }).setLocale('en');
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  const days = Math.round(start.startOf('day').diff(today, 'days').days);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : start.toFormat('cccc');
  return `Reminder: ${session.service.name} is ${day}, ${start.toFormat('ccc d LLL')} at ${start.toFormat('h:mm a')}, `
    + `with ${session.instructor.name} at ${session.location.name}.`
    + (session.status === 'PENDING' ? ' The club is still confirming the venue.' : '');
}

const reminderWindowMs = 24 * 3_600_000;

async function remindSession(tx: Tx, bookingId: string, now: Date) {
  const threadId = await ensureChatThread(tx, bookingId);
  if (!threadId) return false;
  // Several API processes may run this worker. The row lock makes the
  // reminder for one start time a single decision.
  const [locked] = await tx.$queryRaw<Array<{ reminderStartAt: Date | null }>>`
    SELECT "reminderStartAt" FROM "ChatThread" WHERE "id" = ${threadId} FOR UPDATE`;
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: {
      startAt: true, status: true, coachAcceptance: true,
      business: { select: { timezone: true } },
      service: { select: { name: true } }, instructor: { select: { name: true } }, location: { select: { name: true } },
      participants: { where: { cancelledAt: null }, select: { id: true }, take: 1 },
    },
  });
  if (!locked || !booking || !booking.participants.length) return false;
  const confirmedOrVenuePending = booking.status === 'CONFIRMED'
    || (booking.status === 'PENDING' && booking.coachAcceptance !== 'PENDING');
  const untilStart = booking.startAt.getTime() - now.getTime();
  if (!confirmedOrVenuePending || untilStart <= 0 || untilStart > reminderWindowMs) return false;
  if (locked.reminderStartAt?.getTime() === booking.startAt.getTime()) return false;
  await tx.chatThread.update({ where: { id: threadId }, data: { reminderStartAt: booking.startAt } });
  await postChatSystemLine(tx, bookingId, {
    event: 'REMINDER', body: reminderText(booking, booking.business.timezone, now),
  });
  return true;
}

/**
 * Post the day-before reminder into every session starting within the next
 * 24 hours that has not been reminded for its current start time. A moved
 * session is reminded again for its new time.
 */
export async function sendDueSessionReminders(
  options: { now?: Date; limit?: number; businessIds?: string[] } = {},
) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const horizon = new Date(now.getTime() + reminderWindowMs);
  // Production sweeps every club. A caller may narrow the sweep, which keeps
  // integration tests inside the businesses they own.
  const scope = options.businessIds
    ? Prisma.sql`AND booking."businessId" IN (${Prisma.join(options.businessIds.length ? options.businessIds : [''])})`
    : Prisma.empty;
  // Booking times are stored as UTC wall-clock timestamps. Convert the
  // bound instants explicitly so the comparison ignores the session zone.
  const due = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT booking."id"
    FROM "Booking" AS booking
    JOIN "Business" AS business ON business."id" = booking."businessId"
    LEFT JOIN "ChatThread" AS thread ON thread."bookingId" = booking."id"
    WHERE booking."startAt" > (${now}::timestamptz AT TIME ZONE 'UTC')
      AND booking."startAt" <= (${horizon}::timestamptz AT TIME ZONE 'UTC')
      AND (booking."status" = 'CONFIRMED' OR (booking."status" = 'PENDING' AND booking."coachAcceptance" <> 'PENDING'))
      AND booking."paymentRoute" = 'CLUB' AND business."kind" = 'CLUB' AND business."legacyReadOnly" = false
      AND (thread."id" IS NULL OR thread."reminderStartAt" IS DISTINCT FROM booking."startAt")
      AND EXISTS (
        SELECT 1 FROM "Participant" AS participant
        WHERE participant."bookingId" = booking."id" AND participant."cancelledAt" IS NULL
      )
      ${scope}
    ORDER BY booking."startAt" ASC, booking."id" ASC
    LIMIT ${limit}`;
  let sent = 0;
  for (const { id } of due) {
    try {
      if (await prisma.$transaction(tx => remindSession(tx, id, now), { timeout: 15_000 })) sent += 1;
    } catch (error) {
      // One bad session must not stop the rest of the batch.
      console.error('Session reminder failed', error);
    }
  }
  return sent;
}

export function startChatReminderWorker(intervalMs = 60_000) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await sendDueSessionReminders(); }
    catch (error) { console.error('Session reminder tick failed', error); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

const requireChatAccount: RequestHandler = (req, _res, next) => {
  const auth = (req as AccountRequest).auth;
  if (!auth?.user.passwordHash) return next(new HttpError(403, 'A registered account is required to use chat'));
  next();
};

const chatWriteLimit = sharedRateLimit({
  name: 'chat-write',
  windowMs: 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  // Authentication runs first, so people sharing a network do not share one
  // conversation budget.
  keyGenerator: req => (req as AccountRequest).auth?.user.id ?? 'unauthenticated',
  message: { error: 'You are sending messages too quickly. Please wait a moment.' },
});

const chatCreateLimit = sharedRateLimit({
  name: 'chat-create',
  windowMs: 5 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  keyGenerator: req => (req as AccountRequest).auth?.user.id ?? 'unauthenticated',
  message: { error: 'You are starting conversations too quickly. Please wait a moment.' },
});

const chatReportLimit = sharedRateLimit({
  name: 'chat-report',
  windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  keyGenerator: req => (req as AccountRequest).auth?.user.id ?? 'unauthenticated',
  message: { error: 'You are sending reports too quickly. Please wait before trying again.' },
});

export const chatRouter = Router();
chatRouter.use(requireChatAccount);

chatRouter.get('/', asyncRoute(async (req, res) => {
  res.json(await listChatThreads(chatViewerFor(req.auth), listQuery.parse(req.query)));
}));

chatRouter.get('/unread', asyncRoute(async (req, res) => {
  const query = chatContractQuery.parse(req.query);
  res.json({ unreadThreads: await unreadThreadCount(
    chatViewerFor(req.auth), prisma, query.contract === 'accounts',
  ) });
}));

chatRouter.post('/accounts', chatCreateLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const threadId = await openAccountChat(viewer, req.body);
  // Return the opened conversation too, so the client can show it without a
  // second round trip. Older clients read only threadId.
  res.json({ threadId, thread: await chatThreadForViewer(viewer, threadId) });
}));

chatRouter.post('/bookings/:bookingId', asyncRoute(async (req, res) => {
  emptyInput.parse(req.body ?? {});
  const bookingId = chatId.parse(req.params.bookingId);
  res.json({ threadId: await openBookingChat(chatViewerFor(req.auth), bookingId) });
}));

chatRouter.post('/proposals/:proposalId/accept', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  res.json(await acceptProposal(viewer, chatId.parse(req.params.proposalId), req.body));
}));

chatRouter.post('/proposals/:proposalId/decline', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  res.json(await declineProposal(viewer, chatId.parse(req.params.proposalId), req.body));
}));

chatRouter.post('/proposals/:proposalId/counter', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  res.status(201).json(await counterProposal(viewer, chatId.parse(req.params.proposalId), req.body));
}));

chatRouter.post('/proposals/:proposalId/withdraw', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  res.json(await withdrawProposal(viewer, chatId.parse(req.params.proposalId), req.body));
}));

chatRouter.get('/:threadId', asyncRoute(async (req, res) => {
  const { before, contract } = threadQuery.parse(req.query);
  res.json(await chatThreadForViewer(chatViewerFor(req.auth), chatId.parse(req.params.threadId), {
    before, includeAccountChats: contract === 'accounts',
  }));
}));

chatRouter.post('/:threadId/messages', chatWriteLimit, asyncRoute(async (req, res) => {
  res.status(201).json({ message: await postChatMessage(chatViewerFor(req.auth), chatId.parse(req.params.threadId), req.body) });
}));

chatRouter.post('/:threadId/reports', chatReportLimit, asyncRoute(async (req, res) => {
  const result = await reportChatSafetyConcern(chatViewerFor(req.auth), chatId.parse(req.params.threadId), req.body);
  const guidance = result.report.severity === 'CRITICAL' ? {
    immediateDanger: true as const,
    police: { label: 'Singapore Police' as const, phone: '999' as const },
    policeSms: { label: 'Police Emergency SMS' as const, phone: '70999' as const },
    navh: { label: 'National Anti-Violence and Sexual Harassment Helpline' as const, phone: '1800-777-0000' as const },
  } : undefined;
  res.status(result.created ? 201 : 200).json({ report: result.report, ...(guidance ? { guidance } : {}) });
}));

chatRouter.post('/:threadId/block', chatWriteLimit, asyncRoute(async (req, res) => {
  emptyInput.parse(req.body ?? {});
  const viewer = chatViewerFor(req.auth);
  res.json({ thread: await setChatAccountBlock(viewer, chatId.parse(req.params.threadId), true) });
}));

chatRouter.delete('/:threadId/block', chatWriteLimit, asyncRoute(async (req, res) => {
  emptyInput.parse(req.body ?? {});
  const viewer = chatViewerFor(req.auth);
  res.json({ thread: await setChatAccountBlock(viewer, chatId.parse(req.params.threadId), false) });
}));

chatRouter.post('/:threadId/coach', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const threadId = await assignConversationCoach(viewer, chatId.parse(req.params.threadId), req.body);
  res.json({ thread: await chatThreadForViewer(viewer, threadId) });
}));

chatRouter.delete('/:threadId/coach', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const threadId = await removeConversationCoach(viewer, chatId.parse(req.params.threadId), req.body);
  res.json({ thread: await chatThreadForViewer(viewer, threadId) });
}));

chatRouter.post('/:threadId/read', asyncRoute(async (req, res) => {
  emptyInput.parse(req.body ?? {});
  const query = chatContractQuery.parse(req.query);
  res.json({
    ok: true,
    unreadThreads: await markChatRead(
      chatViewerFor(req.auth), chatId.parse(req.params.threadId), query.contract === 'accounts',
    ),
  });
}));

chatRouter.post('/:threadId/proposals', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const result = await proposeNextSession(viewer, chatId.parse(req.params.threadId), req.body);
  res.status(201).json({ thread: result.thread });
}));
