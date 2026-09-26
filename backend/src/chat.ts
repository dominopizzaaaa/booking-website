import { Router, type RequestHandler } from 'express';
import { Prisma, type ChatMessage } from '@prisma/client';
import { DateTime } from 'luxon';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from './db.js';
import { skipRateLimits } from './config.js';
import { asyncRoute, HttpError, type AccountRequest, type AccountType } from './http.js';
import {
  bookingInput, createBookingsInTransaction, evaluateSlot, lockInstructors, schedulingContext, type Tx,
} from './scheduling.js';
import {
  chatEligible, chatWhen, ensureChatThread, postChatSystemLine, silentChatEventsFor, type ChatRole,
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
  /** The club businesses this account operates; empty for people. */
  clubBusinessIds: string[];
};

export function chatViewerFor(auth: AccountRequest['auth']): ChatViewer {
  return {
    userId: auth.user.id,
    name: auth.user.name,
    accountType: auth.user.accountType as AccountType,
    clubBusinessIds: auth.user.accountType === 'CLUB'
      ? auth.memberships
        .filter(membership => membership.active && membership.instructorId === null && membership.userId === auth.user.id)
        .map(membership => membership.businessId)
      : [],
  };
}

const sessionInclude = {
  business: { select: { id: true, name: true, slug: true, timezone: true, kind: true, legacyReadOnly: true } },
  service: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  instructor: { select: { id: true, name: true, membership: { select: { userId: true, active: true } } } },
  participants: {
    where: { cancelledAt: null },
    select: { student: { select: { userId: true, name: true } } },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.BookingInclude;

type ChatBooking = Prisma.BookingGetPayload<{ include: typeof sessionInclude }>;
type Student = { userId: string; name: string };

const proposalInclude = {
  responses: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  service: { select: { name: true } },
  location: { select: { name: true } },
  instructor: { select: { name: true } },
} satisfies Prisma.SessionProposalInclude;

type FullProposal = Prisma.SessionProposalGetPayload<{ include: typeof proposalInclude }>;

const messagePageSize = 100;

/** Students with a registered account who still hold a place in the session. */
const activeStudents = (booking: ChatBooking): Student[] => booking.participants.flatMap(participant =>
  participant.student.userId ? [{ userId: participant.student.userId, name: participant.student.name }] : []);

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
    return affiliation?.active && affiliation.userId === viewer.userId ? 'COACH' : null;
  }
  if (viewer.accountType === 'CLUB') return viewer.clubBusinessIds.includes(booking.businessId) ? 'CLUB' : null;
  return null;
}

/** The same rule as chatRoleIn, as a query over threads. */
function accessibleThreadsWhere(viewer: ChatViewer): Prisma.ChatThreadWhereInput {
  const activeClub = { business: { kind: 'CLUB', legacyReadOnly: false } };
  if (viewer.accountType === 'STUDENT') {
    return { ...activeClub, booking: { paymentRoute: 'CLUB', participants: { some: { cancelledAt: null, student: { userId: viewer.userId } } } } };
  }
  if (viewer.accountType === 'COACH') {
    return { ...activeClub, booking: { paymentRoute: 'CLUB', instructor: { membership: { is: { userId: viewer.userId, active: true } } } } };
  }
  return { ...activeClub, businessId: { in: viewer.clubBusinessIds }, booking: { paymentRoute: 'CLUB' } };
}

function accessibleThreadsSql(viewer: ChatViewer) {
  if (viewer.accountType === 'STUDENT') {
    return Prisma.sql`EXISTS (
      SELECT 1 FROM "Participant" AS participant
      JOIN "Student" AS student ON student."id" = participant."studentId"
      WHERE participant."bookingId" = booking."id" AND participant."cancelledAt" IS NULL
        AND student."userId" = ${viewer.userId})`;
  }
  if (viewer.accountType === 'COACH') {
    return Prisma.sql`EXISTS (
      SELECT 1 FROM "Membership" AS membership
      WHERE membership."instructorId" = booking."instructorId"
        AND membership."userId" = ${viewer.userId} AND membership."active")`;
  }
  return viewer.clubBusinessIds.length
    ? Prisma.sql`thread."businessId" IN (${Prisma.join(viewer.clubBusinessIds)})`
    : Prisma.sql`FALSE`;
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

export async function unreadThreadCount(viewer: ChatViewer, db: Tx | typeof prisma = prisma) {
  const [row] = await db.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT count(*)::int AS count
    FROM "ChatThread" AS thread
    JOIN "Booking" AS booking ON booking."id" = thread."bookingId"
    JOIN "Business" AS business ON business."id" = thread."businessId"
    LEFT JOIN "ChatReadState" AS readState ON readState."threadId" = thread."id" AND readState."userId" = ${viewer.userId}
    WHERE booking."paymentRoute" = 'CLUB' AND business."kind" = 'CLUB' AND business."legacyReadOnly" = false
      AND ${accessibleThreadsSql(viewer)}
      AND EXISTS (
        SELECT 1 FROM "ChatMessage" AS message
        WHERE message."threadId" = thread."id" AND ${unreadMessageSql(viewer)}
      )
  `);
  return row?.count ?? 0;
}

async function unreadCounts(viewer: ChatViewer, threadIds: string[]) {
  if (!threadIds.length) return new Map<string, number>();
  const rows = await prisma.$queryRaw<Array<{ threadId: string; unread: number }>>(Prisma.sql`
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
  const coach = booking.instructor.membership?.active ? booking.instructor.membership.userId : null;
  return [
    { role: 'COACH' as const, name: booking.instructor.name, isYou: !!viewerId && coach === viewerId },
    ...activeStudents(booking).map(student => ({ role: 'STUDENT' as const, name: student.name, isYou: student.userId === viewerId })),
    { role: 'CLUB' as const, name: booking.business.name, isYou: false },
  ];
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
  context: { viewer: ChatViewer | null; role: ChatRole | 'ADMIN'; students: Student[]; timezone: string; now: Date },
) {
  const { viewer, role, students, now } = context;
  const expired = proposal.status === 'OPEN' && proposal.startAt <= now;
  const open = proposal.status === 'OPEN' && !expired;
  const answered = new Set(proposal.responses.map(response => response.studentUserId));
  const awaiting = !open ? []
    : proposal.proposedByRole === 'STUDENT' ? [proposal.instructor.name]
      : proposal.targetStudentUserId ? (answered.has(proposal.targetStudentUserId) ? [] : [proposal.targetStudentName])
        : students.filter(student => !answered.has(student.userId)).map(student => student.name);
  const canRespond = open && !!viewer && role !== 'ADMIN' && !!responderFor(proposal, viewer, role, students);
  const viewerId = viewer?.userId ?? null;
  const seesBookings = role === 'COACH' || role === 'CLUB' || role === 'ADMIN';
  return {
    id: proposal.id,
    status: expired ? 'EXPIRED' as const : proposal.status as 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'COUNTERED' | 'WITHDRAWN' | 'CLOSED',
    startAt: proposal.startAt.toISOString(),
    endAt: proposal.endAt.toISOString(),
    timezone: context.timezone,
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

type ThreadWithBooking = Prisma.ChatThreadGetPayload<{ include: { booking: { include: typeof sessionInclude } } }>;

/** The name a person carries inside this session's chat. */
function displayNameIn(role: ChatRole, viewer: ChatViewer, booking: ChatBooking) {
  if (role === 'COACH') return booking.instructor.name;
  if (role === 'CLUB') return booking.business.name;
  return activeStudents(booking).find(student => student.userId === viewer.userId)?.name ?? viewer.name;
}

async function buildThreadDetail(
  thread: ThreadWithBooking,
  viewer: ChatViewer | null,
  role: ChatRole | 'ADMIN',
  options: { before?: string } = {},
) {
  let pivot: { id: string; createdAt: Date } | null = null;
  if (options.before) {
    pivot = await prisma.chatMessage.findFirst({
      where: { id: options.before, threadId: thread.id }, select: { id: true, createdAt: true },
    });
    if (!pivot) throw new HttpError(400, 'That message is not part of this chat');
  }
  const page = await prisma.chatMessage.findMany({
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
    ? await prisma.sessionProposal.findMany({ where: { id: { in: proposalIds } }, include: proposalInclude })
    : [];
  const students = activeStudents(thread.booking);
  const context = { viewer, role, students, timezone: thread.booking.business.timezone, now: new Date() };
  const proposalById = new Map(proposals.map(proposal => [proposal.id, proposalJson(proposal, context)]));
  const viewerId = viewer?.userId ?? null;
  const participant = role === 'STUDENT' || role === 'COACH' || role === 'CLUB';
  return {
    id: thread.id,
    bookingId: thread.bookingId,
    lastMessageAt: thread.lastMessageAt.toISOString(),
    session: sessionJson(thread.booking),
    members: membersJson(thread.booking, viewerId),
    viewer: {
      role,
      canPost: participant,
      // Coaches and students plan their next session here; the club reads
      // along but books through its own workspace.
      canPropose: (role === 'STUDENT' || role === 'COACH') && students.length > 0,
    },
    messages: messages.map(message => ({
      ...messageJson(message, viewerId),
      proposal: message.proposalId ? proposalById.get(message.proposalId) ?? null : null,
    })),
    hasEarlier,
  };
}

async function loadAccessibleThread(viewer: ChatViewer, threadId: string, db: Tx | typeof prisma = prisma) {
  const thread = await db.chatThread.findUnique({
    where: { id: threadId }, include: { booking: { include: sessionInclude } },
  });
  const role = thread ? chatRoleIn(viewer, thread.booking) : null;
  // A thread the reader cannot join is indistinguishable from one that does
  // not exist, so thread IDs cannot be probed across clubs.
  if (!thread || !role) throw new HttpError(404, 'Chat not found');
  return { thread, role };
}

export async function chatThreadForViewer(viewer: ChatViewer, threadId: string, options: { before?: string } = {}) {
  const { thread, role } = await loadAccessibleThread(viewer, threadId);
  return buildThreadDetail(thread, viewer, role, options);
}

function threadSummaryJson(
  thread: ThreadWithBooking & { messages: ChatMessage[] },
  viewerId: string | null,
  unread: number,
) {
  const last = thread.messages[0];
  return {
    id: thread.id,
    bookingId: thread.bookingId,
    lastMessageAt: thread.lastMessageAt.toISOString(),
    session: sessionJson(thread.booking),
    members: membersJson(thread.booking, viewerId),
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
  ] };
}

const listQuery = z.object({
  cursor: z.string().trim().min(1).max(200).optional(),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
}).strict();

async function listThreads(where: Prisma.ChatThreadWhereInput, query: z.infer<typeof listQuery>) {
  const threads = await prisma.chatThread.findMany({
    where: query.q ? { AND: [where, threadSearchWhere(query.q)] } : where,
    include: {
      booking: { include: sessionInclude },
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
  const { page, nextCursor } = await listThreads(accessibleThreadsWhere(viewer), query);
  const unread = await unreadCounts(viewer, page.map(thread => thread.id));
  return {
    threads: page.map(thread => threadSummaryJson(thread, viewer.userId, unread.get(thread.id) ?? 0)),
    nextCursor,
    unreadThreads: await unreadThreadCount(viewer),
  };
}

// Platform admins read every conversation for safety review. They never
// post, so the reader has no viewer identity and no actions.
export async function listChatThreadsForAdmin(query: z.infer<typeof listQuery>) {
  const { page, nextCursor } = await listThreads({}, query);
  const counts = page.length
    ? await prisma.chatMessage.groupBy({
      // Count what people wrote; system lines are the platform's own record.
      by: ['threadId'], where: { threadId: { in: page.map(thread => thread.id) }, kind: { not: 'SYSTEM' } }, _count: { _all: true },
    })
    : [];
  const countByThread = new Map(counts.map(count => [count.threadId, count._count._all]));
  return {
    threads: page.map(thread => ({ ...threadSummaryJson(thread, null, 0), messageCount: countByThread.get(thread.id) ?? 0 })),
    nextCursor,
  };
}

export async function chatThreadForAdmin(threadId: string, options: { before?: string } = {}) {
  const thread = await prisma.chatThread.findUnique({
    where: { id: threadId }, include: { booking: { include: sessionInclude } },
  });
  if (!thread) throw new HttpError(404, 'Chat not found');
  return buildThreadDetail(thread, null, 'ADMIN', options);
}

export const adminChatListQuery = listQuery;
export const threadQuery = z.object({ before: z.string().trim().min(1).max(200).optional() }).strict();

/**
 * Validate a proposed time against live availability. Nothing is reserved:
 * acceptance repeats this inside the booking transaction.
 */
async function assertProposedSlot(
  tx: Tx,
  source: { businessId: string; serviceId: string; instructorId: string; locationId: string },
  startAt: Date,
  studentUserIds: string[],
) {
  if (!Number.isFinite(startAt.getTime()) || startAt.getTime() <= Date.now()) {
    throw new HttpError(400, 'Choose a time in the future');
  }
  await lockInstructors(tx, [source.instructorId]);
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
  return slot;
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
  await tx.chatReadState.upsert({
    where: { threadId_userId: { threadId, userId } },
    create: { threadId, userId, lastReadAt: at },
    update: {},
  });
  // Read positions only move forward, whichever request lands last.
  await tx.chatReadState.updateMany({ where: { threadId, userId, lastReadAt: { lt: at } }, data: { lastReadAt: at } });
}

const proposalInput = z.object({
  startAt: z.string().datetime({ offset: true }),
  message: z.string().trim().max(500).default(''),
}).strict();
const declineInput = z.object({ message: z.string().trim().max(500).default('') }).strict();
const emptyInput = z.object({}).strict();

/** A person may keep a few options open at once, but not flood a chat. */
const maxOpenProposalsPerPerson = 3;

export async function proposeNextSession(viewer: ChatViewer, threadId: string, rawInput: unknown) {
  const input = proposalInput.parse(rawInput);
  return prisma.$transaction(async tx => {
    const { thread, role } = await loadAccessibleThread(viewer, threadId, tx);
    if (role !== 'STUDENT' && role !== 'COACH') {
      throw new HttpError(403, 'Only the coach and students in this session can propose a time');
    }
    const students = activeStudents(thread.booking);
    if (!students.length) throw new HttpError(400, 'Nobody is booked into this session to propose a time to');
    // A student proposes for themselves. A coach addresses the one student in
    // a private session, or the whole group, where each student answers.
    const target = role === 'STUDENT'
      ? students.find(student => student.userId === viewer.userId)!
      : thread.booking.type === 'PRIVATE' && students.length === 1 ? students[0] : null;
    const openCount = await tx.sessionProposal.count({
      where: { threadId: thread.id, proposedByUserId: viewer.userId, status: 'OPEN', startAt: { gt: new Date() } },
    });
    if (openCount >= maxOpenProposalsPerPerson) {
      throw new HttpError(409, 'You already have several proposals waiting for an answer. Withdraw one first.');
    }
    const startAt = new Date(input.startAt);
    const slot = await assertProposedSlot(tx, thread.booking, startAt, target ? [target.userId] : []);
    const author = { userId: viewer.userId, name: displayNameIn(role, viewer, thread.booking), role };
    const proposal = await tx.sessionProposal.create({
      data: {
        businessId: thread.businessId, threadId: thread.id,
        serviceId: thread.booking.serviceId, instructorId: thread.booking.instructorId,
        locationId: thread.booking.locationId, address: thread.booking.address,
        startAt, endAt: slot.endAt, proposedByRole: role, proposedByUserId: viewer.userId,
        proposedByName: author.name, targetStudentUserId: target?.userId ?? null,
        targetStudentName: target?.name ?? '', message: input.message,
      },
    });
    await postProposalMessage(tx, thread.id, proposal, author, {
      serviceName: thread.booking.service.name, timezone: thread.booking.business.timezone,
    });
    return thread.id;
  }, { timeout: 30_000 });
}

async function lockAndLoadProposal(tx: Tx, viewer: ChatViewer, proposalId: string) {
  // Accept, decline, counter and withdraw are competing terminal decisions.
  // Serialize them on the proposal before reading its state, so a waiter sees
  // the winner's committed answer instead of acting on a stale OPEN row.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`session-proposal:${proposalId}`}, 0))`;
  const proposal = await tx.sessionProposal.findUnique({ where: { id: proposalId }, include: proposalInclude });
  if (!proposal) throw new HttpError(404, 'Proposal not found');
  const { thread, role } = await loadAccessibleThread(viewer, proposal.threadId, tx).catch(error => {
    if (error instanceof HttpError && error.status === 404) throw new HttpError(404, 'Proposal not found');
    throw error;
  });
  return { proposal, thread, role };
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
    const students = activeStudents(thread.booking);
    const student = assertAnswerable(proposal, viewer, role, students);
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
    await tx.sessionProposalResponse.create({
      data: {
        proposalId: proposal.id, studentUserId: student.userId, studentName: student.name,
        responderUserId: viewer.userId, status: 'ACCEPTED', bookingId: booking.id,
      },
    });
    await settleProposal(tx, proposal, 'ACCEPTED', students);
    const responderName = displayNameIn(role, viewer, thread.booking);
    const when = chatWhen(proposal.startAt, thread.booking.business.timezone);
    const booked = `${student.name} is booked for ${proposal.service.name} on ${when}`;
    const status = booking.status === 'PENDING'
      ? ' The club is confirming the venue before it goes on the calendar.'
      : ' It has been added to the calendar.';
    await postChatSystemLine(tx, thread.bookingId, {
      event: 'PROPOSAL_ACCEPTED',
      body: role === 'COACH' ? `${responderName} accepted. ${booked}.${status}` : `${booked}.${status}`,
      actor: { userId: viewer.userId, name: responderName },
    });
    await markRead(tx, thread.id, viewer.userId, new Date());
    return { threadId: thread.id, bookingId: booking.id };
  }, { timeout: 30_000 });
}

export async function declineProposal(viewer: ChatViewer, proposalId: string, rawInput: unknown) {
  const input = declineInput.parse(rawInput ?? {});
  return prisma.$transaction(async tx => {
    const { proposal, thread, role } = await lockAndLoadProposal(tx, viewer, proposalId);
    const students = activeStudents(thread.booking);
    const student = assertAnswerable(proposal, viewer, role, students);
    await tx.sessionProposalResponse.create({
      data: {
        proposalId: proposal.id, studentUserId: student.userId, studentName: student.name,
        responderUserId: viewer.userId, status: 'DECLINED',
      },
    });
    await settleProposal(tx, proposal, 'DECLINED', students);
    const responderName = displayNameIn(role, viewer, thread.booking);
    await postChatSystemLine(tx, thread.bookingId, {
      event: 'PROPOSAL_DECLINED',
      body: `${responderName} declined ${chatWhen(proposal.startAt, thread.booking.business.timezone)}.`
        + (input.message ? ` “${input.message}”` : ''),
      actor: { userId: viewer.userId, name: responderName },
    });
    await markRead(tx, thread.id, viewer.userId, new Date());
    return { threadId: thread.id };
  }, { timeout: 30_000 });
}

/**
 * "Edit": answer with a different time. The original closes and a new
 * proposal travels back the other way, so the person who asked first is the
 * one who confirms the final time.
 */
export async function counterProposal(viewer: ChatViewer, proposalId: string, rawInput: unknown) {
  const input = proposalInput.parse(rawInput);
  return prisma.$transaction(async tx => {
    const { proposal, thread, role } = await lockAndLoadProposal(tx, viewer, proposalId);
    const students = activeStudents(thread.booking);
    const student = assertAnswerable(proposal, viewer, role, students);
    const startAt = new Date(input.startAt);
    if (startAt.getTime() === proposal.startAt.getTime()) {
      throw new HttpError(400, 'Choose a different time to suggest, or accept this one');
    }
    const slot = await assertProposedSlot(tx, proposal, startAt, [student.userId]);
    await tx.sessionProposalResponse.create({
      data: {
        proposalId: proposal.id, studentUserId: student.userId, studentName: student.name,
        responderUserId: viewer.userId, status: 'COUNTERED',
      },
    });
    await settleProposal(tx, proposal, 'COUNTERED', students);
    const author = { userId: viewer.userId, name: displayNameIn(role, viewer, thread.booking), role };
    const counter = await tx.sessionProposal.create({
      data: {
        businessId: proposal.businessId, threadId: proposal.threadId, serviceId: proposal.serviceId,
        instructorId: proposal.instructorId, locationId: proposal.locationId, address: proposal.address,
        startAt, endAt: slot.endAt, proposedByRole: role, proposedByUserId: viewer.userId,
        proposedByName: author.name, targetStudentUserId: student.userId, targetStudentName: student.name,
        counterOfId: proposal.id, message: input.message,
      },
    });
    await postProposalMessage(tx, thread.id, counter, author, {
      serviceName: proposal.service.name, timezone: thread.booking.business.timezone,
    });
    return { threadId: thread.id, proposalId: counter.id };
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
    const name = displayNameIn(role, viewer, thread.booking);
    await postChatSystemLine(tx, thread.bookingId, {
      event: 'PROPOSAL_WITHDRAWN',
      body: `${name} withdrew the proposed time (${chatWhen(proposal.startAt, thread.booking.business.timezone)}).`,
      actor: { userId: viewer.userId, name },
    });
    await markRead(tx, thread.id, viewer.userId, new Date());
    return { threadId: thread.id };
  }, { timeout: 30_000 });
}

/**
 * Open the chat for a booking, creating it on first use. Bookings made
 * before chat shipped gain a thread the first time someone opens it.
 */
export async function openBookingChat(viewer: ChatViewer, bookingId: string) {
  return prisma.$transaction(async tx => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId }, include: sessionInclude });
    if (!booking || !chatRoleIn(viewer, booking)) throw new HttpError(404, 'Chat not found');
    const threadId = await ensureChatThread(tx, booking.id);
    if (!threadId) throw new HttpError(404, 'Chat not found');
    return threadId;
  });
}

export async function postChatMessage(viewer: ChatViewer, threadId: string, rawInput: unknown) {
  const input = z.object({
    body: z.string().trim().min(1, 'Write a message first').max(2000, 'Keep messages under 2,000 characters'),
  }).strict().parse(rawInput);
  return prisma.$transaction(async tx => {
    const { thread, role } = await loadAccessibleThread(viewer, threadId, tx);
    const createdAt = new Date();
    const message = await tx.chatMessage.create({
      data: {
        threadId: thread.id, kind: 'TEXT', senderUserId: viewer.userId, senderRole: role,
        senderName: displayNameIn(role, viewer, thread.booking), body: input.body, createdAt,
      },
    });
    await touchThread(tx, thread.id, createdAt);
    await markRead(tx, thread.id, viewer.userId, createdAt);
    return messageJson(message, viewer.userId);
  });
}

export async function markChatRead(viewer: ChatViewer, threadId: string) {
  const { thread } = await loadAccessibleThread(viewer, threadId);
  await markRead(prisma, thread.id, viewer.userId, new Date());
  return unreadThreadCount(viewer);
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

const chatWriteLimit = rateLimit({
  windowMs: 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  // Authentication runs first, so people sharing a network do not share one
  // conversation budget.
  keyGenerator: req => (req as AccountRequest).auth?.user.id ?? 'unauthenticated',
  message: { error: 'You are sending messages too quickly. Please wait a moment.' },
});

export const chatRouter = Router();
chatRouter.use(requireChatAccount);

chatRouter.get('/', asyncRoute(async (req, res) => {
  res.json(await listChatThreads(chatViewerFor(req.auth), listQuery.parse(req.query)));
}));

chatRouter.get('/unread', asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.query);
  res.json({ unreadThreads: await unreadThreadCount(chatViewerFor(req.auth)) });
}));

chatRouter.post('/bookings/:bookingId', asyncRoute(async (req, res) => {
  emptyInput.parse(req.body ?? {});
  const bookingId = z.string().trim().min(1).max(200).parse(req.params.bookingId);
  res.json({ threadId: await openBookingChat(chatViewerFor(req.auth), bookingId) });
}));

chatRouter.post('/proposals/:proposalId/accept', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const result = await acceptProposal(viewer, req.params.proposalId, req.body);
  res.json({ ...result, thread: await chatThreadForViewer(viewer, result.threadId) });
}));

chatRouter.post('/proposals/:proposalId/decline', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const result = await declineProposal(viewer, req.params.proposalId, req.body);
  res.json({ ...result, thread: await chatThreadForViewer(viewer, result.threadId) });
}));

chatRouter.post('/proposals/:proposalId/counter', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const result = await counterProposal(viewer, req.params.proposalId, req.body);
  res.status(201).json({ ...result, thread: await chatThreadForViewer(viewer, result.threadId) });
}));

chatRouter.post('/proposals/:proposalId/withdraw', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const result = await withdrawProposal(viewer, req.params.proposalId, req.body);
  res.json({ ...result, thread: await chatThreadForViewer(viewer, result.threadId) });
}));

chatRouter.get('/:threadId', asyncRoute(async (req, res) => {
  const { before } = threadQuery.parse(req.query);
  res.json(await chatThreadForViewer(chatViewerFor(req.auth), req.params.threadId, { before }));
}));

chatRouter.post('/:threadId/messages', chatWriteLimit, asyncRoute(async (req, res) => {
  res.status(201).json({ message: await postChatMessage(chatViewerFor(req.auth), req.params.threadId, req.body) });
}));

chatRouter.post('/:threadId/read', asyncRoute(async (req, res) => {
  emptyInput.parse(req.body ?? {});
  res.json({ ok: true, unreadThreads: await markChatRead(chatViewerFor(req.auth), req.params.threadId) });
}));

chatRouter.post('/:threadId/proposals', chatWriteLimit, asyncRoute(async (req, res) => {
  const viewer = chatViewerFor(req.auth);
  const threadId = await proposeNextSession(viewer, req.params.threadId, req.body);
  res.status(201).json({ thread: await chatThreadForViewer(viewer, threadId) });
}));
