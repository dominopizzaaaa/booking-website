import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config, production, skipRateLimits } from './config.js';
import { authRouter, requireAuth, requireStudent, requireWorkspace } from './auth.js';
import { adminRouter } from './admin.js';
import { publicRouter } from './public.js';
import { workspaceRouter } from './workspace.js';
import { bookingsRouter } from './bookings.js';
import { crudRouter } from './crud.js';
import { coachInvitationRouter, staffRouter } from './staff.js';
import { accountRouter, notificationPreferencesRouter } from './account-notifications.js';
import { venuesRouter } from './venues.js';
import { integrityRouter } from './integrity.js';
import { calendarRouter } from './calendar.js';
import { accountDirectoryRouter } from './account-directory.js';
import { commerceRouter } from './commerce.js';
import { rentalsRouter } from './rentals.js';
import { chatRouter } from './chat.js';
import { clubStaffAccessRouter, clubStaffInvitationRouter } from './staff-access.js';
import { bookingSeriesRouter } from './booking-series.js';
import { HttpError, requireAccountCapability, requireAccountReady } from './http.js';
import { prisma } from './db.js';
import { inspectSchema } from './schema-health.js';
import { paymentsRouter, stripeWebhookHandler } from './payments/routes.js';
import { liveCheckoutBlockReasons } from './payments/compliance.js';
import { auditRouter } from './audit-routes.js';
import { familyPublicRouter, familyRouter } from './family.js';
import { privacyAdminRouter, privacyPublicRouter, privacyRouter } from './privacy.js';
import { safeguardingRouter } from './safeguarding.js';
export const app = express();
app.disable('x-powered-by');
if (production) app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ credentials: true, origin(origin, cb) { cb(null, !origin || config.origins.includes(origin)); } }));
// Signature verification must receive the exact bytes Stripe signed. This is
// the only endpoint that bypasses the normal JSON parser.
app.post('/api/payments/webhooks/stripe', express.raw({ type: 'application/json', limit: '256kb' }), stripeWebhookHandler);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({
  windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false,
  skip: skipRateLimits,
  message: { error: 'Too many requests. Please slow down.' },
}));
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
  try {
    const schema = await inspectSchema(prisma);
    if (!schema.ready) {
      res.status(503).json({ error: 'Database schema is out of date. Run pending migrations.', schema: 'out-of-date' });
      return;
    }
    res.json({
      ok: true, service: 'courtly', database: 'connected', schema: 'ready', accountModel: 'student-coach-club-affiliations',
      capabilities: {
        accountProfile: true, rescheduleRequests: true, coachAcceptance: true,
        paymentReversal: true, integrityFlags: true,
        simulatedStripe: config.payments.mode === 'simulated', packageMarketplace: true, venueRentals: true, accountDirectory: true,
        sessionChat: true, accountChat: true, namedClubStaff: true, bookingSeries: true,
        operationalInbox: true, bookingExport: true,
        payments: config.payments.mode === 'stripe'
          ? liveCheckoutBlockReasons().length
            ? 'stripe-blocked'
            : (config.payments.publishableKey.startsWith('pk_live_') ? 'stripe-live' : 'stripe-test')
          : config.payments.mode,
        transactionalEmail: config.email.enabled ? 'configured' : 'disabled',
        family: config.familyFeatureEnabled ? 'enabled' : 'disabled',
        familyHandover: config.email.enabled && config.familyHandoverTokens.enabled
          ? 'configured'
          : 'disabled',
        venueSearch: config.googleMapsApiKey ? 'google-places' : 'maps-link',
        googleCalendar: config.googleCalendar.enabled ? 'configured' : 'disabled',
      },
    });
  }
  catch { res.status(503).json({ error: 'Database is unavailable' }); }
});
app.use('/api/public', privacyPublicRouter);
app.use('/api/auth', authRouter);
app.use('/api', adminRouter, privacyAdminRouter);
// Public handover claims must not advertise that a token route exists while
// Family is disabled. Authenticated Family surfaces may report temporary
// unavailability so signed-in clients can distinguish a rollout gate from an
// authorization failure. These prefix gates cover every current and future
// route mounted by the two Family routers below.
app.use('/api/family/handovers', (_req, _res, next) => {
  if (!config.familyFeatureEnabled) return next(new HttpError(404, 'Route not found'));
  next();
});
app.use('/api/family', (_req, _res, next) => {
  if (!config.familyFeatureEnabled) return next(new HttpError(503, 'Family features are temporarily unavailable'));
  next();
});
app.use('/api/family', familyPublicRouter);
app.use('/api/family', requireAuth, familyRouter);
app.use('/api', publicRouter);
// Privacy rights remain reachable for an authenticated account even when its
// ordinary product capabilities are restricted or awaiting remediation.
app.use('/api/privacy', requireAuth, privacyRouter);
// Everything below this point is an ordinary signed-in account surface. Keep
// public/auth/family remediation routes above it so an account that needs age,
// consent, deletion, or handover action can still reach the route that resolves
// that state. Narrow capability gates remain layered on each feature group.
app.use('/api', requireAuth, requireAccountReady);
app.use('/api', requireAccountCapability('directory'), accountDirectoryRouter);
app.use('/api', requireAccountCapability('payments'), paymentsRouter);
// A coach can review and accept invitations before selecting a workspace.
app.use('/api', requireAccountCapability('staffAccess'), coachInvitationRouter);
app.use('/api', requireAccountCapability('staffAccess'), clubStaffInvitationRouter);
// Commerce contains both global student checkout routes and club-workspace
// management routes, so each endpoint applies its own narrower guard.
app.use('/api', requireAccountCapability('commerce'), commerceRouter);
// Rental discovery is global to every signed-in account; manager mutations
// apply their club-only checks inside the router.
app.use('/api', requireAccountCapability('rentals'), rentalsRouter);
// Calendar grants belong to the global person, not a selected workspace.
app.use('/api/calendar', requireAccountCapability('calendar'), calendarRouter);
// Chat is account-level: people keep direct conversations and session chats
// across clubs, while each thread applies its own membership rule.
app.use('/api/chats', requireAccountCapability('chat'), chatRouter);
app.use('/api/account', notificationPreferencesRouter);
app.use('/api/account', requireStudent, accountRouter);
// Account-only public booking management installs its own authentication
// middleware. Every provider route below additionally requires an active,
// non-revoked membership selected on the session.
app.use('/api', requireAccountCapability('workspace'), requireWorkspace, workspaceRouter, bookingsRouter, bookingSeriesRouter, crudRouter, staffRouter, clubStaffAccessRouter, auditRouter, venuesRouter, integrityRouter, safeguardingRouter);
app.use((_req, _res, next) => next(new HttpError(404, 'Route not found')));
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, ...error.details }); return; }
  if (error instanceof ZodError) { res.status(400).json({ error: error.issues[0]?.message || 'Invalid input', issues: error.flatten() }); return; }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') { res.status(409).json({ error: 'This record already exists. Please use a different email or username.' }); return; }
    if (['P2025', 'P2003'].includes(error.code)) { res.status(400).json({ error: 'Record not found or still in use by another record' }); return; }
    if (error.code === 'P2034') { res.status(409).json({ error: 'Another update occurred at the same time. Please try again.' }); return; }
  }
  if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'Invalid JSON request body' }); return; }
  // A body larger than the parser accepts is the caller sending too much, not
  // this service failing. Reporting it as a server error would both mislead
  // the caller and raise a fault alert for someone else's oversized request.
  if (error instanceof Error && (error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' }); return;
  }
  console.error(error);
  res.status(500).json({ error: 'An unexpected server error occurred. Please try again.' });
};
app.use(errorHandler);
