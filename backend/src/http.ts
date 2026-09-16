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

export const adminOnly: RequestHandler = (req, _res, next) => {
  const membership = (req as AuthRequest).auth?.membership;
  if (!membership) return next(new HttpError(403, 'Select a business workspace to continue'));
  if (!['OWNER', 'ADMIN'].includes(membership.role)) return next(new HttpError(403, 'Owner or admin access required'));
  next();
};

export function coachScope(req: AuthRequest, instructorId: string) {
  const membership = req.auth.membership;
  if (!membership) throw new HttpError(403, 'Select a business workspace to continue');
  if (membership.role === 'COACH' && membership.instructorId !== instructorId) {
    throw new HttpError(403, 'Coaches can only access their own schedule');
  }
}

export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
