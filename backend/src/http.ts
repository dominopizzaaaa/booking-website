import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AuthSession, Business, Membership, User } from '@prisma/client';

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
};
export type AuthRequest = Request & { auth: AuthContext };
export type AccountRequest = AuthRequest;
export type WorkspaceRequest = Request & {
  auth: AuthContext & { membership: MembershipWithBusiness; business: Business };
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public details: Record<string, unknown> = {}) { super(message); }
}

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
 * it is. A club account runs its club. A coach runs their own practice, where
 * there is no club to answer to, but inside someone else's club they are a
 * coach and nothing more.
 */
export function managesBusiness(auth: Pick<AuthContext, 'user' | 'business'>) {
  if (!auth.business) return false;
  return (auth.user.accountType === 'CLUB' && auth.business.kind === 'CLUB')
    || (auth.user.accountType === 'COACH' && auth.business.kind === 'SOLO');
}

/**
 * Whether this request should be narrowed to one coach's own schedule, hiding
 * the rest of the club's roster, students and money from them.
 */
export function coachScoped(auth: Pick<AuthContext, 'user' | 'business'>) {
  return auth.user.accountType === 'COACH' && auth.business?.kind === 'CLUB';
}

export const requireBusinessManager: RequestHandler = (req, _res, next) => {
  const auth = (req as AuthRequest).auth;
  if (!auth?.membership) return next(new HttpError(403, 'Select a business workspace to continue'));
  if (!managesBusiness(auth)) return next(new HttpError(403, 'Only the club account can do this'));
  next();
};

/**
 * Staff belongs to a club. A coach's own practice has exactly one member — the
 * coach — so it never grows a roster.
 */
export const requireClubAccount: RequestHandler = (req, _res, next) => {
  const auth = (req as AuthRequest).auth;
  if (!auth?.membership || !auth.business) return next(new HttpError(403, 'Select a business workspace to continue'));
  if (auth.user.accountType !== 'CLUB' || auth.business.kind !== 'CLUB' || auth.membership.instructorId !== null) {
    return next(new HttpError(403, 'Only the club account can manage its coaches'));
  }
  next();
};

export function coachScope(req: AuthRequest, instructorId: string) {
  const membership = req.auth.membership;
  if (!membership) throw new HttpError(403, 'Select a business workspace to continue');
  if (coachScoped(req.auth) && membership.instructorId !== instructorId) {
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
