import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthSession, Business, ClubStaffAccess, Membership, User } from '@prisma/client';
import type { AccountCapability, AccountPolicyDecision } from './children-policy.js';

export type MembershipWithBusiness = Membership & { business: Business };
export type AuthContext = {
  user: User;
  session: AuthSession;
  // Runtime authentication permits a global account with no workspace. The
  // provider router is mounted behind requireWorkspace, so its handlers can
  // rely on these fields; public account routes use only the global user.
  membership: MembershipWithBusiness | null;
  business: Business | null;
  memberships: MembershipWithBusiness[];
  staffAccess: (ClubStaffAccess & { business: Business }) | null;
  staffAccesses: Array<ClubStaffAccess & { business: Business }>;
  accessMode: 'NONE' | 'CLUB_ACCOUNT' | 'COACH' | 'STAFF';
  permissions: readonly string[];
  /** Current server-authored account policy, recomputed on every authenticated request. */
  policy: AccountPolicyDecision;
};
export type AuthRequest = Request & { auth: AuthContext };
export type AccountRequest = AuthRequest;
export type WorkspaceRequest = Request & {
  auth: AuthContext & { business: Business };
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public details: Record<string, unknown> = {}) { super(message); }
}

export const requireAccountReady: RequestHandler = (req, _res, next) => {
  const auth = (req as AccountRequest).auth;
  if (!auth) return next(new HttpError(401, 'Please sign in to continue'));
  if (!auth.policy.capabilities.ordinaryAccess) {
    return next(new HttpError(403, 'Account action is required before continuing', {
      code: 'ACCOUNT_ACTION_REQUIRED',
      reason: auth.policy.reason,
    }));
  }
  next();
};

export const requireAccountCapability = (capability: AccountCapability): RequestHandler => (req, _res, next) => {
  const auth = (req as AccountRequest).auth;
  if (!auth) return next(new HttpError(401, 'Please sign in to continue'));
  if (!auth.policy.capabilities[capability]) {
    return next(new HttpError(403, 'This account cannot perform that action', {
      code: auth.policy.accountActionRequired ? 'ACCOUNT_ACTION_REQUIRED' : 'CAPABILITY_REQUIRED',
      reason: auth.policy.reason,
      capability,
    }));
  }
  next();
};

// Provider routers are installed after requireWorkspace. Express cannot carry
// that middleware refinement through its RequestHandler generic, so callbacks
// use the narrowed request while AuthRequest remains truthful for account-only
// routes and direct middleware consumers.
export const asyncRoute = (fn: (req: WorkspaceRequest, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => { Promise.resolve(fn(req as WorkspaceRequest, res, next)).catch(next); };

export type AccountType = 'STUDENT' | 'COACH' | 'CLUB';

/**
 * Who runs this business.
 *
 * There is no stored role to consult: what an account may do follows from what
 * it is. A club account runs its club. Coaches operate only inside active
 * club affiliations; retained solo-practice rows are historical and cannot
 * reach workspace routes.
 */
export function managesBusiness(auth: Pick<AuthContext, 'user' | 'business' | 'staffAccess'>) {
  if (!auth.business) return false;
  if (auth.business.kind !== 'CLUB' || auth.business.legacyReadOnly) return false;
  return auth.user.accountType === 'CLUB';
}

/**
 * Whether this request should be narrowed to one coach's own schedule, hiding
 * the rest of the club's roster, students and money from them.
 */
export function coachScoped(auth: Pick<AuthContext, 'user' | 'business' | 'staffAccess'>) {
  return !auth.staffAccess && auth.user.accountType === 'COACH' && auth.business?.kind === 'CLUB';
}

/**
 * Write authority carries the matching read authority. Keep this graph in one
 * place so route guards and serialized effective permissions cannot disagree.
 * Payment and integrity use action-specific names rather than `*_MANAGE`, but
 * their mutating actions follow the same rule.
 */
export const CLUB_PERMISSION_IMPLICATIONS: Readonly<Record<string, readonly string[]>> = {
  BOOKINGS_MANAGE: ['BOOKINGS_VIEW'],
  STUDENTS_MANAGE: ['STUDENTS_VIEW'],
  CATALOG_MANAGE: ['CATALOG_VIEW'],
  ROSTER_MANAGE: ['ROSTER_VIEW'],
  PACKAGES_MANAGE: ['PACKAGES_VIEW'],
  PAYMENTS_RECORD: ['PAYMENTS_VIEW'],
  PAYMENTS_REVERSE: ['PAYMENTS_VIEW'],
  PAYOUTS_RECORD: ['PAYMENTS_VIEW'],
  INTEGRITY_REVIEW: ['INTEGRITY_VIEW'],
  SAFEGUARDING_REVIEW: ['SAFEGUARDING_VIEW'],
  RENTALS_MANAGE: ['RENTALS_VIEW', 'CATALOG_MANAGE'],
};

export function effectiveClubPermissions(permissions: readonly string[]) {
  const effective = new Set(permissions);
  const pending = [...permissions];
  for (let index = 0; index < pending.length; index += 1) {
    for (const implied of CLUB_PERMISSION_IMPLICATIONS[pending[index]!] ?? []) {
      if (effective.has(implied)) continue;
      effective.add(implied);
      pending.push(implied);
    }
  }
  return [...effective];
}

export function hasClubPermission(auth: Pick<AuthContext, 'user' | 'business' | 'staffAccess'>, permission: string) {
  if (!auth.business || auth.business.kind !== 'CLUB' || auth.business.legacyReadOnly) return false;
  if (auth.user.accountType === 'CLUB') return true;
  return Boolean(auth.staffAccess?.active && auth.staffAccess.businessId === auth.business.id
    && effectiveClubPermissions(auth.staffAccess.permissions).includes(permission));
}

export const requireClubPermission = (permission: string): RequestHandler => (req, _res, next) => {
  const auth = (req as AuthRequest).auth;
  if (!auth?.business || !hasClubPermission(auth, permission)) {
    return next(new HttpError(403, `This workspace requires ${permission.toLowerCase().replaceAll('_', ' ')} permission`));
  }
  next();
};

/** Coach self-service stays scoped to its roster row; office users need the
 * explicit named permission. This is the common guard for shared routes. */
export const requireCoachOrClubPermission = (permission: string): RequestHandler => (req, _res, next) => {
  const auth = (req as AuthRequest).auth;
  if (!auth?.business) return next(new HttpError(403, 'Select a business workspace to continue'));
  if (!coachScoped(auth) && !hasClubPermission(auth, permission)) {
    return next(new HttpError(403, `This workspace requires ${permission.toLowerCase().replaceAll('_', ' ')} permission`));
  }
  next();
};

export const requireBusinessManager: RequestHandler = (req, _res, next) => {
  const auth = (req as AuthRequest).auth;
  if (!auth?.business) return next(new HttpError(403, 'Select a business workspace to continue'));
  if (!managesBusiness(auth)) return next(new HttpError(403, 'Club management access is required'));
  next();
};

/**
 * Staff belongs to a club. Only the institutional club account may change its
 * roster; a coach affiliation never grants that authority.
 */
export const requireClubAccount: RequestHandler = (req, _res, next) => {
  const auth = (req as AuthRequest).auth;
  if (!auth?.business) return next(new HttpError(403, 'Select a business workspace to continue'));
  if (!hasClubPermission(auth, 'ROSTER_MANAGE')) {
    return next(new HttpError(403, 'Coach roster management permission is required'));
  }
  next();
};

export function coachScope(req: AuthRequest, instructorId: string) {
  const membership = req.auth.membership;
  if (coachScoped(req.auth) && membership?.instructorId !== instructorId) {
    throw new HttpError(403, 'Coaches can only access their own schedule');
  }
}

// Parenthesized text is descriptive rather than part of a person's name (for
// example, "Dominic (Coach)"). Remove complete and unfinished qualifiers
// before reading the first two words, while retaining internal punctuation in
// real names such as Mary-Jane.
export function initials(name: string) {
  const normalized = name.normalize('NFC');
  const withoutQualifiers = normalized.replace(/[(（][^)）]*(?:[)）]|$)/gu, ' ');
  const words = withoutQualifiers
    .split(/\s+/)
    .map(word => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(word => word.length > 0);
  const letters = words.slice(0, 2).map(word => [...word][0]).join('');
  return (letters || [...withoutQualifiers].find(character => /[\p{L}\p{N}]/u.test(character)) || '?').toUpperCase();
}
