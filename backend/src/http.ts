import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Business, User } from '@prisma/client';
export type AuthRequest = Request & { auth: { user: User; business: Business } };
export class HttpError extends Error {
  constructor(public status: number, message: string, public details: Record<string, unknown> = {}) { super(message); }
}
export const asyncRoute = (fn: (req: AuthRequest, res: Response, next: NextFunction) => unknown): RequestHandler => (req, res, next) => { Promise.resolve(fn(req as AuthRequest, res, next)).catch(next); };
export const adminOnly: RequestHandler = (req, _res, next) => {
  const role = (req as AuthRequest).auth.user.role;
  if (!['OWNER', 'ADMIN'].includes(role)) return next(new HttpError(403, 'Owner or admin access required'));
  next();
};
export function coachScope(req: AuthRequest, instructorId: string) {
  if (req.auth.user.role === 'COACH' && req.auth.user.instructorId !== instructorId) throw new HttpError(403, 'Coaches can only access their own schedule');
}
export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
