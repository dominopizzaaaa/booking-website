import { Router, type RequestHandler, type Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { prisma } from './db.js';
import { config, production } from './config.js';
import { asyncRoute, HttpError, initials } from './http.js';
import { publicBusiness, userJson } from './serializers.js';
import { seedBusiness } from './seed.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax' as const, path: '/' };
async function issueSession(userId: string, res: Response, previousToken?: string) {
  if (previousToken) await prisma.authSession.deleteMany({ where: { id: digest(previousToken) } });
  await prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400_000);
  await prisma.authSession.create({ data: { id: digest(token), userId, expiresAt } });
  res.cookie(config.sessionCookie, token, { ...cookieOptions, expires: expiresAt });
}
export const requireAuth: RequestHandler = asyncRoute(async (req, _res, next) => {
  const token = req.cookies?.[config.sessionCookie];
  if (typeof token !== 'string') throw new HttpError(401, 'Please sign in to continue');
  const session = await prisma.authSession.findUnique({ where: { id: digest(token) }, include: { user: { include: { business: true } } } });
  if (!session || session.expiresAt < new Date()) throw new HttpError(401, 'Session expired. Please sign in again');
  req.auth = { user: session.user, business: session.user.business };
  next();
});
const authRouter = Router();
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });
const credentials = z.object({ email: z.string().trim().email().transform(s => s.toLowerCase()), password: z.string().min(8).max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes') });
const registration = credentials.extend({
  password: z.string().min(12, 'Use a password with at least 12 characters').max(72).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must fit within 72 UTF-8 bytes'),
  businessName: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(120),
});
authRouter.post('/register', authLimit, asyncRoute(async (req, res) => {
  const body = registration.parse(req.body);
  const passwordHash = await bcrypt.hash(body.password, 12);
  const result = await prisma.$transaction(async tx => {
    const business = await tx.business.create({ data: { name: body.businessName, ownerName: body.name, email: body.email, slug: `${body.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'courtly'}-${randomBytes(4).toString('hex')}` } });
    const instructor = await tx.instructor.create({ data: { businessId: business.id, name: body.name, initials: initials(body.name), email: body.email } });
    const user = await tx.user.create({ data: { businessId: business.id, name: body.name, email: body.email, passwordHash, role: 'OWNER', instructorId: instructor.id } });
    return { business, user };
  });
  await issueSession(result.user.id, res, req.cookies?.[config.sessionCookie]);
  res.status(201).json({ user: userJson(result.user), business: publicBusiness(result.business) });
}));
authRouter.post('/login', authLimit, asyncRoute(async (req, res) => {
  const body = credentials.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email }, include: { business: true } });
  const valid = await bcrypt.compare(body.password, user?.passwordHash || '$2b$12$QrsSSNoV/kdmGVRTVVmoIOKhMlSeSPFjGtV8.iKB7MHYFUPprZWyK');
  if (!user || !valid) throw new HttpError(401, 'Email or password is incorrect');
  await issueSession(user.id, res, req.cookies?.[config.sessionCookie]);
  res.json({ user: userJson(user), business: publicBusiness(user.business) });
}));
authRouter.post('/demo', rateLimit({ windowMs: 60 * 60_000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Demo limit reached. Try again later.' } }), asyncRoute(async (req, res) => {
  if (!config.demoEnabled) throw new HttpError(403, 'Demo mode is disabled');
  const previous = req.cookies?.[config.sessionCookie];
  if (typeof previous === 'string') {
    const existing = await prisma.authSession.findUnique({ where: { id: digest(previous) }, include: { user: { include: { business: true } } } });
    if (existing && existing.expiresAt > new Date()) { res.json({ user: userJson(existing.user), business: publicBusiness(existing.user.business) }); return; }
  }
  const result = await prisma.$transaction(tx => seedBusiness(tx, { isDemo: true, slug: `marcus-tan-${randomBytes(6).toString('hex')}` }), { timeout: 60_000 });
  await issueSession(result.owner.id, res, previous);
  res.status(201).json({ user: userJson(result.owner), business: publicBusiness(result.business) });
}));
authRouter.post('/logout', asyncRoute(async (req, res) => {
  const token = req.cookies?.[config.sessionCookie];
  if (typeof token === 'string') await prisma.authSession.deleteMany({ where: { id: digest(token) } });
  res.clearCookie(config.sessionCookie, cookieOptions);
  res.json({ ok: true });
}));
authRouter.get('/me', requireAuth, asyncRoute(async (req, res) => { res.json({ user: userJson(req.auth.user), business: publicBusiness(req.auth.business) }); }));
export { authRouter };
