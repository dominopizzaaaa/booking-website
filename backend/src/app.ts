import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config, production } from './config.js';
import { authRouter, requireAuth, requireWorkspace } from './auth.js';
import { adminRouter } from './admin.js';
import { publicRouter } from './public.js';
import { workspaceRouter } from './workspace.js';
import { bookingsRouter } from './bookings.js';
import { crudRouter } from './crud.js';
import { staffRouter } from './staff.js';
import { HttpError } from './http.js';
import { prisma } from './db.js';
export const app = express();
app.disable('x-powered-by');
if (production) app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ credentials: true, origin(origin, cb) { cb(null, !origin || config.origins.includes(origin)); } }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    const sameOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== sameOrigin && !config.origins.includes(origin)) return next(new HttpError(403, 'Request origin is not allowed'));
    if (!req.is('application/json') && Number(req.get('content-length') || 0) > 0) return next(new HttpError(415, 'Use application/json'));
    if (req.get('sec-fetch-site') === 'cross-site' && !origin) return next(new HttpError(403, 'Cross-site requests are not allowed'));
  }
  next();
});
app.get('/api/health', async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true, service: 'courtly', database: 'connected', accountModel: 'global-memberships' }); }
  catch { res.status(503).json({ error: 'Database is unavailable' }); }
});
app.use('/api/auth', authRouter);
app.use('/api', adminRouter);
app.use('/api', publicRouter);
// Account-only public booking management installs its own authentication
// middleware. Every provider route below additionally requires an active,
// non-revoked membership selected on the session.
app.use('/api', requireAuth, requireWorkspace, workspaceRouter, bookingsRouter, crudRouter, staffRouter);
app.use((_req, _res, next) => next(new HttpError(404, 'Route not found')));
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, ...error.details }); return; }
  if (error instanceof ZodError) { res.status(400).json({ error: error.issues[0]?.message || 'Invalid input', issues: error.flatten() }); return; }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') { res.status(409).json({ error: 'This record already exists. Please use a different email or name.' }); return; }
    if (['P2025', 'P2003'].includes(error.code)) { res.status(400).json({ error: 'Record not found or still in use by another record' }); return; }
    if (error.code === 'P2034') { res.status(409).json({ error: 'Another update occurred at the same time. Please try again.' }); return; }
  }
  if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'Invalid JSON request body' }); return; }
  console.error(error);
  res.status(500).json({ error: 'An unexpected server error occurred. Please try again.' });
};
app.use(errorHandler);
