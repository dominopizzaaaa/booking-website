import type { Prisma, User } from '@prisma/client';

export type AuditAccessKind = 'CLUB_ACCOUNT' | 'CLUB_STAFF' | 'COACH' | 'SYSTEM';

export type BusinessAuditActor = {
  userId: string | null;
  name: string;
  email: string;
  accountType: string;
  accessKind: AuditAccessKind;
  staffAccessId?: string | null;
  accessLevel?: string | null;
  permissions?: readonly string[];
};

export type BusinessAuditInput = {
  businessId: string;
  actor: BusinessAuditActor;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue;
  requestId?: string | null;
};

/**
 * Persist an immutable, human-attributable audit snapshot. Call this with the
 * transaction that performs the mutation so state and attribution cannot
 * diverge. Callers must pass only redacted metadata: no tokens, credentials,
 * provider payloads, or other secrets.
 */
export function recordBusinessAudit(tx: Prisma.TransactionClient, input: BusinessAuditInput) {
  return tx.businessAuditEvent.create({
    data: {
      businessId: input.businessId,
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
      actorEmail: input.actor.email,
      actorAccountType: input.actor.accountType,
      actorAccessKind: input.actor.accessKind,
      actorStaffAccessId: input.actor.staffAccessId ?? null,
      actorAccessLevel: input.actor.accessLevel ?? null,
      actorPermissionsSnapshot: [...(input.actor.permissions ?? [])],
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      summary: input.summary,
      metadata: input.metadata ?? {},
      requestId: input.requestId ?? null,
    },
  });
}

export function institutionalClubActor(user: Pick<User, 'id' | 'name' | 'email' | 'accountType'>): BusinessAuditActor {
  return {
    userId: user.id, name: user.name, email: user.email, accountType: user.accountType,
    accessKind: 'CLUB_ACCOUNT', permissions: [],
  };
}

export function namedStaffActor(
  user: Pick<User, 'id' | 'name' | 'email' | 'accountType'>,
  access: { id: string; accessLevel: string; permissions: readonly string[] },
): BusinessAuditActor {
  return {
    userId: user.id, name: user.name, email: user.email, accountType: user.accountType,
    accessKind: 'CLUB_STAFF', staffAccessId: access.id, accessLevel: access.accessLevel,
    permissions: access.permissions,
  };
}
