import { createHash, randomBytes } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db.js';
import { asyncRoute, effectiveClubPermissions, HttpError, type AuthRequest } from './http.js';
import { institutionalClubActor, namedStaffActor, recordBusinessAudit } from './audit.js';

export const CLUB_PERMISSIONS = [
  'BOOKINGS_VIEW', 'BOOKINGS_MANAGE', 'STUDENTS_VIEW', 'STUDENTS_MANAGE',
  'CATALOG_VIEW', 'CATALOG_MANAGE', 'AVAILABILITY_MANAGE', 'ROSTER_VIEW',
  'ROSTER_MANAGE', 'PACKAGES_VIEW', 'PACKAGES_MANAGE', 'PAYMENTS_VIEW',
  'PAYMENTS_RECORD', 'PAYMENTS_REVERSE', 'PAYOUTS_RECORD', 'INTEGRITY_VIEW',
  'INTEGRITY_REVIEW', 'RENTALS_VIEW', 'RENTALS_MANAGE', 'SETTINGS_MANAGE',
  'STAFF_MANAGE', 'AUDIT_VIEW',
] as const;
export type ClubPermission = typeof CLUB_PERMISSIONS[number];

export const CLUB_ACCESS_PRESETS = {
  ADMINISTRATOR: CLUB_PERMISSIONS,
  OPERATIONS: ['BOOKINGS_VIEW', 'BOOKINGS_MANAGE', 'STUDENTS_VIEW', 'STUDENTS_MANAGE', 'CATALOG_VIEW', 'CATALOG_MANAGE', 'AVAILABILITY_MANAGE', 'ROSTER_VIEW', 'ROSTER_MANAGE', 'RENTALS_VIEW', 'RENTALS_MANAGE'],
  FRONT_DESK: ['BOOKINGS_VIEW', 'BOOKINGS_MANAGE', 'STUDENTS_VIEW', 'STUDENTS_MANAGE', 'PAYMENTS_VIEW', 'PAYMENTS_RECORD'],
  FINANCE: ['PACKAGES_VIEW', 'PACKAGES_MANAGE', 'PAYMENTS_VIEW', 'PAYMENTS_RECORD', 'PAYMENTS_REVERSE', 'PAYOUTS_RECORD', 'AUDIT_VIEW'],
  SAFEGUARDING: ['BOOKINGS_VIEW', 'STUDENTS_VIEW', 'INTEGRITY_VIEW', 'INTEGRITY_REVIEW', 'AUDIT_VIEW'],
  READ_ONLY: ['BOOKINGS_VIEW', 'STUDENTS_VIEW', 'CATALOG_VIEW', 'ROSTER_VIEW', 'PACKAGES_VIEW', 'RENTALS_VIEW'],
} as const satisfies Record<string, readonly ClubPermission[]>;
export type ClubAccessLevel = keyof typeof CLUB_ACCESS_PRESETS | 'CUSTOM';

const permissionSchema = z.enum(CLUB_PERMISSIONS);
const accessLevelSchema = z.enum(['ADMINISTRATOR', 'OPERATIONS', 'FRONT_DESK', 'FINANCE', 'SAFEGUARDING', 'READ_ONLY', 'CUSTOM']);
const accessInputShape = {
  accessLevel: accessLevelSchema,
  permissions: z.array(permissionSchema).max(CLUB_PERMISSIONS.length).optional(),
};
const validateAccessInput = (value: { accessLevel: ClubAccessLevel; permissions?: ClubPermission[] }, context: z.RefinementCtx) => {
  if (value.accessLevel === 'CUSTOM' && !value.permissions?.length) {
    context.addIssue({ code: 'custom', message: 'Choose at least one permission for custom access', path: ['permissions'] });
  }
  if (value.accessLevel !== 'CUSTOM' && value.permissions !== undefined) {
    context.addIssue({ code: 'custom', message: 'Preset access cannot include custom permissions', path: ['permissions'] });
  }
  if (value.accessLevel === 'CUSTOM' && value.permissions?.includes('RENTALS_MANAGE')
    && !value.permissions.includes('CATALOG_MANAGE')) {
    context.addIssue({ code: 'custom', message: 'Managing rentals also requires manage catalogue permission', path: ['permissions'] });
  }
};
const accessInputSchema = z.object(accessInputShape).strict().superRefine(validateAccessInput);
const invitationInputSchema = z.object({
  ...accessInputShape,
  email: z.string().trim().max(254).email().transform(value => value.toLowerCase()),
}).strict().superRefine(validateAccessInput);
const acceptSchema = z.union([
  z.object({ invitationId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ token: z.string().min(20).max(200) }).strict(),
]);
const idSchema = z.string().trim().min(1).max(200);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;

function resolvedAccess(input: z.infer<typeof accessInputSchema>) {
  const permissions = input.accessLevel === 'CUSTOM'
    ? input.permissions!
    : CLUB_ACCESS_PRESETS[input.accessLevel];
  return { accessLevel: input.accessLevel, permissions: [...new Set(permissions)].sort() };
}

type StaffAuth = AuthRequest['auth'] & {
  staffAccess?: { id: string; businessId: string; active: boolean; accessLevel: string; permissions: string[] } | null;
};

function administrationContext(req: AuthRequest) {
  const auth = req.auth as StaffAuth;
  if (!auth.business || auth.business.kind !== 'CLUB' || auth.business.legacyReadOnly) {
    throw new HttpError(403, 'Select an active club workspace to continue');
  }
  if (auth.user.accountType === 'CLUB' && auth.membership?.businessId === auth.business.id
    && auth.membership.instructorId === null) {
    return { businessId: auth.business.id, actor: institutionalClubActor(auth.user), staffAccess: null };
  }
  const access = auth.staffAccess;
  if (!access?.active || access.businessId !== auth.business.id || !access.permissions.includes('STAFF_MANAGE')) {
    throw new HttpError(403, 'Staff administration permission is required');
  }
  return { businessId: auth.business.id, actor: namedStaffActor(auth.user, access), staffAccess: access };
}

type AdministrationContext = ReturnType<typeof administrationContext>;
type PermissionTarget = { accessLevel: string; permissions: readonly string[] };

function requireTargetWithinStaffAuthority(context: AdministrationContext, target: PermissionTarget) {
  if (!context.staffAccess) return;
  if (target.accessLevel === 'ADMINISTRATOR' || target.permissions.includes('STAFF_MANAGE')) {
    throw new HttpError(403, 'Only the club account can manage staff-management access');
  }
  const ownPermissions = new Set(effectiveClubPermissions(context.staffAccess.permissions));
  if (target.permissions.some(permission => !ownPermissions.has(permission))) {
    throw new HttpError(403, 'Named staff can only manage access within their own permissions');
  }
}

function requireAssignableAccess(context: AdministrationContext, target: PermissionTarget) {
  requireTargetWithinStaffAuthority(context, target);
}

export const requireStaffAdministration: RequestHandler = (req, _res, next) => {
  try { administrationContext(req as AuthRequest); next(); } catch (error) { next(error); }
};

const accessSelect = {
  id: true, businessId: true, userId: true, accessLevel: true, permissions: true, active: true,
  invitedByUserId: true, revokedAt: true, revokedByUserId: true, createdAt: true, updatedAt: true,
  user: { select: { name: true, username: true, email: true, accountType: true, sports: true } },
} satisfies Prisma.ClubStaffAccessSelect;

const accessJson = (access: Prisma.ClubStaffAccessGetPayload<{ select: typeof accessSelect }>) => ({
  id: access.id, businessId: access.businessId, userId: access.userId, name: access.user.name,
  username: access.user.username, email: access.user.email, accountType: access.user.accountType,
  sports: access.user.sports, accessLevel: access.accessLevel, permissions: access.permissions,
  active: access.active, invitedByUserId: access.invitedByUserId, revokedAt: access.revokedAt?.toISOString() ?? null,
  revokedByUserId: access.revokedByUserId, createdAt: access.createdAt.toISOString(), updatedAt: access.updatedAt.toISOString(),
});

const invitationSelect = {
  id: true, businessId: true, email: true, accessLevel: true, permissions: true, invitedByUserId: true,
  expiresAt: true, acceptedAt: true, acceptedByUserId: true, revokedAt: true, revokedByUserId: true, createdAt: true,
  business: { select: { name: true, slug: true } },
} satisfies Prisma.ClubStaffInvitationSelect;
type SelectedInvitation = Prisma.ClubStaffInvitationGetPayload<{ select: typeof invitationSelect }>;
const invitationJson = (invitation: SelectedInvitation) => ({
  ...invitation, expiresAt: invitation.expiresAt.toISOString(), acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
  revokedAt: invitation.revokedAt?.toISOString() ?? null, createdAt: invitation.createdAt.toISOString(),
  status: invitation.acceptedAt ? 'ACCEPTED' : invitation.revokedAt ? 'REVOKED'
    : invitation.expiresAt <= new Date() ? 'EXPIRED' : 'PENDING',
});

export const clubStaffAccessRouter = Router();
export const clubStaffInvitationRouter = Router();

clubStaffAccessRouter.get('/staff-access', requireStaffAdministration, asyncRoute(async (req, res) => {
  const { businessId } = administrationContext(req);
  const accesses = await prisma.clubStaffAccess.findMany({
    where: { businessId }, select: accessSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  res.json({ staff: accesses.map(accessJson) });
}));

clubStaffAccessRouter.get('/staff-access/invitations', requireStaffAdministration, asyncRoute(async (req, res) => {
  const { businessId } = administrationContext(req);
  const invitations = await prisma.clubStaffInvitation.findMany({
    where: { businessId }, select: invitationSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50,
  });
  res.json({ invitations: invitations.map(invitationJson) });
}));

clubStaffAccessRouter.post('/staff-access/invitations', requireStaffAdministration, asyncRoute(async (req, res) => {
  const input = invitationInputSchema.parse(req.body);
  const administration = administrationContext(req);
  const { businessId, actor } = administration;
  const resolved = resolvedAccess(input);
  requireAssignableAccess(administration, resolved);
  const rawToken = randomBytes(32).toString('base64url');
  const invitation = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:staff-invite:${businessId}:${input.email}`}, 0))`;
    const existing = await tx.clubStaffAccess.findFirst({
      where: { businessId, active: true, user: { email: input.email } }, select: { id: true },
    });
    if (existing) throw new HttpError(409, 'This person already has staff access to the club');
    const now = new Date();
    const replacedInvitations = await tx.clubStaffInvitation.findMany({
      where: { businessId, email: input.email, acceptedAt: null, revokedAt: null },
      select: { accessLevel: true, permissions: true },
    });
    for (const replaced of replacedInvitations) requireTargetWithinStaffAuthority(administration, replaced);
    await tx.clubStaffInvitation.updateMany({
      where: { businessId, email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now, revokedByUserId: req.auth.user.id },
    });
    const created = await tx.clubStaffInvitation.create({
      data: { businessId, email: input.email, tokenHash: digest(rawToken), ...resolved,
        invitedByUserId: req.auth.user.id, expiresAt: new Date(now.getTime() + invitationLifetimeMs) },
      select: invitationSelect,
    });
    await recordBusinessAudit(tx, { businessId, actor, action: 'STAFF_INVITATION_CREATED',
      resourceType: 'ClubStaffInvitation', resourceId: created.id, summary: `Invited ${input.email} as ${resolved.accessLevel}`,
      metadata: { email: input.email, accessLevel: resolved.accessLevel, permissions: resolved.permissions } });
    return created;
  }, { isolationLevel: 'Serializable' });
  const destination = `/account?staffInvite=${encodeURIComponent(rawToken)}`;
  res.status(201).json({ invitation: invitationJson(invitation), invitePath: `/signup?${new URLSearchParams({ next: destination })}` });
}));

clubStaffAccessRouter.patch('/staff-access/:accessId', requireStaffAdministration, asyncRoute(async (req, res) => {
  const accessId = idSchema.parse(req.params.accessId);
  const input = accessInputSchema.parse(req.body);
  const resolved = resolvedAccess(input);
  const administration = administrationContext(req);
  const { businessId, actor } = administration;
  requireAssignableAccess(administration, resolved);
  const updated = await prisma.$transaction(async tx => {
    const current = await tx.clubStaffAccess.findFirst({ where: { id: accessId, businessId }, select: accessSelect });
    if (!current) throw new HttpError(404, 'Staff access not found');
    if (!current.active) throw new HttpError(409, 'Staff access has been revoked');
    if (current.userId === req.auth.user.id && req.auth.accessMode === 'STAFF') {
      throw new HttpError(403, 'Named staff cannot change their own access. Ask the club account or another administrator.');
    }
    requireTargetWithinStaffAuthority(administration, current);
    const access = await tx.clubStaffAccess.update({ where: { id: current.id }, data: resolved, select: accessSelect });
    await recordBusinessAudit(tx, { businessId, actor, action: 'STAFF_ACCESS_UPDATED', resourceType: 'ClubStaffAccess',
      resourceId: access.id, summary: `Updated access for ${access.user.name}`, metadata: {
        before: { accessLevel: current.accessLevel, permissions: current.permissions }, after: resolved,
      } });
    return access;
  });
  res.json(accessJson(updated));
}));

clubStaffAccessRouter.delete('/staff-access/:accessId', requireStaffAdministration, asyncRoute(async (req, res) => {
  const accessId = idSchema.parse(req.params.accessId);
  const administration = administrationContext(req);
  const { businessId, actor } = administration;
  await prisma.$transaction(async tx => {
    const current = await tx.clubStaffAccess.findFirst({ where: { id: accessId, businessId }, select: accessSelect });
    if (!current) throw new HttpError(404, 'Staff access not found');
    if (!current.active) throw new HttpError(409, 'Staff access has already been revoked');
    if (current.userId === req.auth.user.id) throw new HttpError(403, 'You cannot revoke your own active staff access');
    requireTargetWithinStaffAuthority(administration, current);
    const now = new Date();
    await tx.authSession.updateMany({ where: { activeStaffAccessId: current.id }, data: { activeStaffAccessId: null } });
    await tx.clubStaffAccess.update({ where: { id: current.id }, data: { active: false, revokedAt: now, revokedByUserId: req.auth.user.id } });
    await recordBusinessAudit(tx, { businessId, actor, action: 'STAFF_ACCESS_REVOKED', resourceType: 'ClubStaffAccess',
      resourceId: current.id, summary: `Revoked access for ${current.user.name}`, metadata: { accessLevel: current.accessLevel, permissions: current.permissions } });
  });
  res.json({ ok: true });
}));

clubStaffAccessRouter.delete('/staff-access/invitations/:invitationId', requireStaffAdministration, asyncRoute(async (req, res) => {
  const invitationId = idSchema.parse(req.params.invitationId);
  const administration = administrationContext(req);
  const { businessId, actor } = administration;
  await prisma.$transaction(async tx => {
    const invitation = await tx.clubStaffInvitation.findFirst({
      where: { id: invitationId, businessId, acceptedAt: null, revokedAt: null }, select: invitationSelect,
    });
    if (!invitation) throw new HttpError(404, 'Pending staff invitation not found');
    requireTargetWithinStaffAuthority(administration, invitation);
    await tx.clubStaffInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date(), revokedByUserId: req.auth.user.id } });
    await recordBusinessAudit(tx, { businessId, actor, action: 'STAFF_INVITATION_REVOKED',
      resourceType: 'ClubStaffInvitation', resourceId: invitation.id, summary: `Revoked invitation for ${invitation.email}`,
      metadata: { email: invitation.email, accessLevel: invitation.accessLevel } });
  });
  res.json({ ok: true });
}));

clubStaffInvitationRouter.get('/club-staff-invitations', asyncRoute(async (req, res) => {
  if (req.auth.user.accountType === 'CLUB') throw new HttpError(403, 'Club accounts cannot accept named staff access');
  const invitations = await prisma.clubStaffInvitation.findMany({
    where: { email: req.auth.user.email.toLowerCase(), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: invitationSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  res.json({ invitations: invitations.map(invitationJson) });
}));

clubStaffInvitationRouter.post('/club-staff-invitations/accept', asyncRoute(async (req, res) => {
  const input = acceptSchema.parse(req.body);
  if (req.auth.user.accountType === 'CLUB') throw new HttpError(403, 'Club accounts cannot accept named staff access');
  const invitationId = 'invitationId' in input ? input.invitationId
    : (await prisma.clubStaffInvitation.findUnique({ where: { tokenHash: digest(input.token) }, select: { id: true } }))?.id;
  if (!invitationId) throw new HttpError(404, 'Staff invitation not found');
  const access = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`courtly:staff-invitation:${invitationId}`}, 0))`;
    const invitation = await tx.clubStaffInvitation.findUnique({
      where: { id: invitationId }, select: { ...invitationSelect, business: { select: { name: true, slug: true, kind: true, legacyReadOnly: true } } },
    });
    if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
      throw new HttpError(409, 'This staff invitation is no longer available');
    }
    if (invitation.email !== req.auth.user.email.toLowerCase()) {
      throw new HttpError(403, `This invitation was sent to ${invitation.email}. Sign in with that account to accept it.`);
    }
    if (invitation.business.kind !== 'CLUB' || invitation.business.legacyReadOnly) throw new HttpError(409, 'This club is no longer accepting staff invitations');
    const grant = await tx.clubStaffAccess.upsert({
      where: { businessId_userId: { businessId: invitation.businessId, userId: req.auth.user.id } },
      create: { businessId: invitation.businessId, userId: req.auth.user.id, accessLevel: invitation.accessLevel,
        permissions: invitation.permissions, invitedByUserId: invitation.invitedByUserId },
      update: { active: true, accessLevel: invitation.accessLevel, permissions: invitation.permissions,
        invitedByUserId: invitation.invitedByUserId, revokedAt: null, revokedByUserId: null },
      select: accessSelect,
    });
    await tx.clubStaffInvitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date(), acceptedByUserId: req.auth.user.id } });
    await tx.authSession.update({ where: { id: req.auth.session.id }, data: { activeMembershipId: null, activeStaffAccessId: grant.id } });
    await recordBusinessAudit(tx, { businessId: invitation.businessId, actor: namedStaffActor(req.auth.user, grant),
      action: 'STAFF_INVITATION_ACCEPTED', resourceType: 'ClubStaffAccess', resourceId: grant.id,
      summary: `${req.auth.user.name} accepted named staff access`, metadata: { invitationId: invitation.id, accessLevel: grant.accessLevel } });
    return grant;
  }, { isolationLevel: 'Serializable' });
  res.json({ staffAccess: accessJson(access) });
}));
