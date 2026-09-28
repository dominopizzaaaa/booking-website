import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, HttpError, requireClubPermission } from './http.js';

const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
const auditQuery = z.object({
  cursor: z.preprocess(first, z.string().trim().min(1).max(1_000).optional()),
  limit: z.preprocess(first, z.coerce.number().int().min(1).max(100).default(30)),
}).passthrough();

type AuditCursor = { createdAt: Date; id: string };
type SafeAccessSnapshot = { accessLevel?: string; permissions?: string[] };
export type SafeAuditMetadata = SafeAccessSnapshot & { before?: SafeAccessSnapshot; after?: SafeAccessSnapshot };

function safePermissions(values: readonly string[]) {
  return values.filter(permission => /^[A-Z][A-Z0-9_]{0,63}$/u.test(permission)).slice(0, 50);
}

function encodeCursor(cursor: AuditCursor) {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): AuditCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded = z.object({ createdAt: z.string().datetime(), id: z.string().min(1).max(200) }).strict()
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { createdAt: new Date(decoded.createdAt), id: decoded.id };
  } catch {
    throw new HttpError(400, 'Invalid audit cursor');
  }
}

function objectValue(value: Prisma.JsonValue | undefined): Record<string, Prisma.JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : null;
}

function safeAccessSnapshot(value: Prisma.JsonValue | undefined): SafeAccessSnapshot | undefined {
  const candidate = objectValue(value);
  if (!candidate) return undefined;
  const snapshot: SafeAccessSnapshot = {};
  if (typeof candidate.accessLevel === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate.accessLevel)) {
    snapshot.accessLevel = candidate.accessLevel;
  }
  if (Array.isArray(candidate.permissions)) {
    snapshot.permissions = safePermissions(candidate.permissions.filter((permission): permission is string => typeof permission === 'string'));
  }
  return Object.keys(snapshot).length ? snapshot : undefined;
}

/**
 * Audit metadata is write-side extensible, so never serialize it wholesale.
 * Only the access snapshots needed by the current staff-access events cross
 * the API boundary; unknown fields and unknown event kinds fail closed.
 */
export function safeAuditMetadata(action: string, metadata: Prisma.JsonValue): SafeAuditMetadata {
  const candidate = objectValue(metadata);
  if (!candidate) return {};
  if (action === 'STAFF_ACCESS_UPDATED') {
    const before = safeAccessSnapshot(candidate.before);
    const after = safeAccessSnapshot(candidate.after);
    return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
  }
  if ([
    'STAFF_INVITATION_CREATED', 'STAFF_ACCESS_REVOKED',
    'STAFF_INVITATION_REVOKED', 'STAFF_INVITATION_ACCEPTED',
  ].includes(action)) {
    return safeAccessSnapshot(metadata) ?? {};
  }
  return {};
}

export function safeAuditSummary(action: string, summary: string) {
  if (![
    'STAFF_INVITATION_CREATED', 'STAFF_ACCESS_UPDATED', 'STAFF_ACCESS_REVOKED',
    'STAFF_INVITATION_REVOKED', 'STAFF_INVITATION_ACCEPTED',
  ].includes(action)) return `Recorded ${action.toLowerCase().replaceAll('_', ' ')}`;
  return summary
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted email]')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .slice(0, 500);
}

export const auditRouter = Router();

auditRouter.get('/audit-events', requireClubPermission('AUDIT_VIEW'), asyncRoute(async (req, res) => {
  const businessId = req.auth.business.id;
  const query = auditQuery.parse(req.query);
  const cursor = decodeCursor(query.cursor);
  const events = await prisma.businessAuditEvent.findMany({
    where: {
      businessId,
      ...(cursor ? { OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ] } : {}),
    },
    select: {
      id: true, actorName: true, actorAccountType: true, actorAccessKind: true, actorAccessLevel: true,
      actorPermissionsSnapshot: true,
      action: true, resourceType: true, resourceId: true, summary: true, metadata: true, createdAt: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });
  const page = events.slice(0, query.limit);
  res.json({
    events: page.map(event => ({
      id: event.id,
      actor: {
        name: event.actorName, accountType: event.actorAccountType,
        accessKind: event.actorAccessKind, accessLevel: event.actorAccessLevel,
        permissions: safePermissions(event.actorPermissionsSnapshot),
      },
      action: event.action,
      resource: { type: event.resourceType, id: event.resourceId },
      summary: safeAuditSummary(event.action, event.summary),
      metadata: safeAuditMetadata(event.action, event.metadata),
      createdAt: event.createdAt.toISOString(),
    })),
    nextCursor: events.length > query.limit && page.length
      ? encodeCursor({ createdAt: page.at(-1)!.createdAt, id: page.at(-1)!.id })
      : null,
  });
}));
