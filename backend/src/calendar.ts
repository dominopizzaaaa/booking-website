import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from './db.js';
import { config } from './config.js';
import { asyncRoute, HttpError, type AuthRequest } from './http.js';
import { calendarSecretAad, decryptCalendarSecret, encryptCalendarSecret } from './calendar-crypto.js';
import {
  exchangeGoogleAuthorizationCode,
  getGoogleIdentity,
  googleAuthorizationUrl,
  GoogleCalendarError,
  revokeGoogleToken,
} from './google-calendar.js';
import {
  disconnectCalendarConnection,
  queueCalendarBookingsForUser,
  queueCalendarBookingsForUserInTransaction,
} from './calendar-sync.js';

export const calendarRouter = Router();

const allowedReturnTo = z.enum(['/account', '/?tab=profile', '/manage?tab=profile']);
const connectInput = z.object({ returnTo: allowedReturnTo }).strict();
const preferencesInput = z.object({
  syncEnabled: z.boolean().optional(),
  busyCheckEnabled: z.boolean().optional(),
}).strict().refine(value => value.syncEnabled !== undefined || value.busyCheckEnabled !== undefined, {
  message: 'Choose at least one calendar preference to update',
});
const callbackState = z.string().trim().min(32).max(512);
const callbackCode = z.string().trim().min(1).max(4096);
const callbackError = z.string().trim().max(256);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const eligible = (req: AuthRequest) => ['STUDENT', 'COACH'].includes(req.auth.user.accountType);

function assertConfigured() {
  if (!config.googleCalendar.enabled) {
    throw new HttpError(503, 'Google Calendar is not configured on this server');
  }
}

function assertEligible(req: AuthRequest) {
  if (!eligible(req)) throw new HttpError(403, 'Only student and coach accounts can connect a personal calendar');
}

const publicErrors: Record<string, string> = {
  REAUTH_REQUIRED: 'Reconnect Google Calendar to resume syncing.',
  REFRESH_TOKEN_MISSING: 'Reconnect Google Calendar to resume syncing.',
  TOKEN_DECRYPT_FAILED: 'Reconnect Google Calendar to resume syncing.',
  PROVIDER_TIMEOUT: 'Google Calendar took too long to respond.',
  PROVIDER_UNAVAILABLE: 'Google Calendar is temporarily unavailable.',
  PROVIDER_REJECTED: 'Google Calendar could not complete the request.',
  GOOGLE_ACCOUNT_MISMATCH: 'Disconnect this Google account before connecting a different one.',
  CALENDAR_SCOPE_MISSING: 'Google Calendar permission was not granted. Reconnect and allow calendar access.',
  SYNC_FAILED: 'The latest calendar sync could not be completed.',
  BUSY_REFRESH_FAILED: 'Google busy times could not be refreshed.',
  REVOKE_FAILED: 'Google has not yet confirmed the disconnect.',
  OAUTH_FAILED: 'Google Calendar could not be connected. Try again.',
};

type PublicConnection = Awaited<ReturnType<typeof prisma.calendarConnection.findUnique>>;

async function connectionStatus(req: AuthRequest, connection?: PublicConnection) {
  const current = connection === undefined
    ? await prisma.calendarConnection.findUnique({ where: { userId: req.auth.user.id } })
    : connection;
  const accountEligible = eligible(req);
  if (!current) return {
    configured: config.googleCalendar.enabled, eligible: accountEligible, provider: 'GOOGLE' as const,
    state: 'DISCONNECTED' as const, connected: false, email: null, calendarName: null,
    syncEnabled: false, busyCheckEnabled: false, connectedAt: null, lastSyncedAt: null,
    lastBusyAt: null, busyCacheExpiresAt: null, error: null,
  };
  const expiry = current.busyLastRefreshedAt
    ? new Date(current.busyLastRefreshedAt.getTime() + config.googleCalendar.busyCacheMinutes * 60_000)
    : null;
  return {
    configured: config.googleCalendar.enabled, eligible: accountEligible, provider: 'GOOGLE' as const,
    state: current.status as 'ACTIVE' | 'REAUTH_REQUIRED' | 'DISCONNECTING',
    connected: current.status !== 'DISCONNECTING',
    email: current.providerEmail, calendarName: 'Primary calendar',
    syncEnabled: current.syncEnabled, busyCheckEnabled: current.busyCheckEnabled,
    connectedAt: current.createdAt.toISOString(), lastSyncedAt: current.lastSyncedAt?.toISOString() ?? null,
    lastBusyAt: current.busyLastRefreshedAt?.toISOString() ?? null,
    busyCacheExpiresAt: expiry?.toISOString() ?? null,
    error: current.lastErrorCode ? (publicErrors[current.lastErrorCode] ?? 'The calendar connection needs attention.') : null,
  };
}

function callbackRedirect(returnTo: string, outcome: 'connected' | 'error') {
  const origin = (() => {
    try { return new URL(config.googleCalendar.redirectUri).origin; }
    catch { return 'http://localhost:3000'; }
  })();
  const url = new URL(returnTo, origin);
  url.searchParams.set('calendar', outcome);
  return url.toString();
}

function fallbackCallbackRedirect(outcome: 'connected' | 'error') {
  return callbackRedirect('/account', outcome);
}

calendarRouter.get('/connection', asyncRoute(async (req, res) => {
  res.json(await connectionStatus(req));
}));

calendarRouter.post('/google/connect', asyncRoute(async (req, res) => {
  assertConfigured();
  assertEligible(req);
  const { returnTo } = connectInput.parse(req.body);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const attemptId = randomUUID();
  const now = new Date();
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar-user:${req.auth.user.id}`}, 0))`;
    const current = await tx.calendarConnection.findUnique({ where: { userId: req.auth.user.id } });
    if (current?.status === 'DISCONNECTING') {
      throw new HttpError(409, 'Wait for Google Calendar to finish disconnecting before reconnecting');
    }
    await tx.calendarOAuthAttempt.deleteMany({
      where: { OR: [{ expiresAt: { lt: now } }, { userId: req.auth.user.id }] },
    });
    await tx.calendarOAuthAttempt.create({
      data: {
        id: attemptId, userId: req.auth.user.id, authSessionId: req.auth.session.id,
        stateDigest: sha256(state),
        codeVerifierCiphertext: encryptCalendarSecret(
          verifier, calendarSecretAad('oauth-attempt', attemptId, 'pkce-verifier'),
        ),
        returnTo, createdAt: now,
        expiresAt: new Date(now.getTime() + config.googleCalendar.oauthAttemptMinutes * 60_000),
      },
    });
  });
  res.json({ authorizationUrl: googleAuthorizationUrl({ state, codeChallenge: pkceChallenge(verifier) }) });
}));

calendarRouter.get('/google/callback', asyncRoute(async (req, res) => {
  if (!config.googleCalendar.enabled || !eligible(req)) {
    res.redirect(303, fallbackCallbackRedirect('error'));
    return;
  }
  const queryValue = (name: string) => {
    const value = req.query[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
  };
  let query: { state: string; code?: string; error?: string };
  let issuedToken: string | null = null;
  let revocationJobId: string | null = null;
  let revocationLeaseToken: string | null = null;
  let grantPersisted = false;
  const revokeUnpersistedGrant = async () => {
    if (!issuedToken || grantPersisted) return;
    try {
      await revokeGoogleToken(issuedToken);
      if (revocationJobId && revocationLeaseToken) {
        await prisma.calendarRevocationJob.deleteMany({
          where: { id: revocationJobId, leaseToken: revocationLeaseToken },
        });
      }
    } catch (error) {
      // If the process or provider fails now, the encrypted tombstone remains
      // independently retryable without retaining a user or plaintext token.
      if (revocationJobId && revocationLeaseToken) {
        await prisma.calendarRevocationJob.updateMany({
          where: { id: revocationJobId, leaseToken: revocationLeaseToken },
          data: {
            availableAt: new Date(), leasedUntil: null, leaseToken: null,
            lastErrorCode: error instanceof GoogleCalendarError ? error.code : 'REVOKE_FAILED',
          },
        }).catch(() => undefined);
      }
    }
  };
  try {
    const code = queryValue('code');
    const providerError = queryValue('error');
    query = {
      state: callbackState.parse(queryValue('state')),
      ...(code === undefined ? {} : { code: callbackCode.parse(code) }),
      ...(providerError === undefined ? {} : { error: callbackError.parse(providerError) }),
    };
  }
  catch { res.redirect(303, fallbackCallbackRedirect('error')); return; }

  const attempt = await prisma.$transaction(async tx => {
    const found = await tx.calendarOAuthAttempt.findFirst({
      where: {
        stateDigest: sha256(query.state), userId: req.auth.user.id, authSessionId: req.auth.session.id,
        consumedAt: null, expiresAt: { gt: new Date() },
      },
    });
    if (!found) return null;
    const consumed = await tx.calendarOAuthAttempt.updateMany({
      where: { id: found.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    return consumed.count ? found : null;
  });
  if (!attempt) { res.redirect(303, fallbackCallbackRedirect('error')); return; }
  if (query.error || !query.code) { res.redirect(303, callbackRedirect(attempt.returnTo, 'error')); return; }

  try {
    const verifier = decryptCalendarSecret(
      attempt.codeVerifierCiphertext,
      calendarSecretAad('oauth-attempt', attempt.id, 'pkce-verifier'),
    );
    const tokens = await exchangeGoogleAuthorizationCode(query.code, verifier);
    issuedToken = tokens.refreshToken ?? tokens.accessToken;
    revocationJobId = randomUUID();
    revocationLeaseToken = randomUUID();
    await prisma.calendarRevocationJob.create({
      data: {
        id: revocationJobId,
        tokenCiphertext: encryptCalendarSecret(
          issuedToken, calendarSecretAad('revocation-job', revocationJobId, 'token'),
        ),
        leasedUntil: new Date(Date.now() + config.googleCalendar.oauthAttemptMinutes * 60_000),
        leaseToken: revocationLeaseToken,
      },
    });
    const identity = await getGoogleIdentity(tokens.accessToken);
    const persisted = await prisma.$transaction(async tx => {
      // Disconnect uses the same account-scoped lock. Provider calls happen
      // before it, while the short critical section prevents a completed
      // disconnect from being revived by a callback that began earlier.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar-user:${req.auth.user.id}`}, 0))`;
      const liveAttempt = await tx.calendarOAuthAttempt.findFirst({
        where: {
          id: attempt.id, userId: req.auth.user.id, authSessionId: req.auth.session.id,
          consumedAt: { not: null },
        },
        select: { id: true },
      });
      if (!liveAttempt) throw new GoogleCalendarError('OAUTH_ATTEMPT_CANCELLED');
      const old = await tx.calendarConnection.findUnique({ where: { userId: req.auth.user.id } });
      if (old?.status === 'DISCONNECTING') {
        throw new GoogleCalendarError('CONNECTION_DISCONNECTING');
      }
      if (old && old.providerAccountId !== identity.accountId) {
        await tx.calendarConnection.update({
          where: { id: old.id }, data: { lastErrorCode: 'GOOGLE_ACCOUNT_MISMATCH' },
        });
        return { mismatch: true as const };
      }
      if (!tokens.refreshToken && !old?.refreshTokenCiphertext) {
        throw new GoogleCalendarError('PROVIDER_RESPONSE_INVALID');
      }
      const connectionId = old?.id ?? randomUUID();
      const accessTokenCiphertext = encryptCalendarSecret(
        tokens.accessToken, calendarSecretAad('connection', connectionId, 'access-token'),
      );
      const refreshTokenCiphertext = tokens.refreshToken
        ? encryptCalendarSecret(tokens.refreshToken, calendarSecretAad('connection', connectionId, 'refresh-token'))
        : old!.refreshTokenCiphertext;
      const connection = await tx.calendarConnection.upsert({
        where: { userId: req.auth.user.id },
        create: {
          id: connectionId, userId: req.auth.user.id, provider: 'GOOGLE',
          providerAccountId: identity.accountId, providerEmail: identity.email, calendarTimeZone: identity.timeZone,
          accessTokenCiphertext, refreshTokenCiphertext, accessTokenExpiresAt: tokens.expiresAt,
          status: 'ACTIVE', syncEnabled: true, busyCheckEnabled: false, lastErrorCode: null,
          disconnectRequestedAt: null, busyRefreshAfter: new Date(),
        },
        update: {
          provider: 'GOOGLE', providerAccountId: identity.accountId, providerEmail: identity.email,
          calendarTimeZone: identity.timeZone, accessTokenCiphertext, refreshTokenCiphertext,
          accessTokenExpiresAt: tokens.expiresAt, status: 'ACTIVE', lastErrorCode: null,
          disconnectRequestedAt: null, busyRefreshAfter: new Date(),
        },
      });
      // Orphan cleanup has no booking to enqueue. Make retained cleanup work
      // immediately eligible when authorization is restored.
      await tx.calendarEventProjection.updateMany({
        where: { connectionId: connection.id, bookingId: null },
        data: { cleanupAfter: new Date() },
      });
      await queueCalendarBookingsForUserInTransaction(tx, req.auth.user.id);
      await tx.calendarRevocationJob.deleteMany({
        where: { id: revocationJobId!, leaseToken: revocationLeaseToken! },
      });
      return { mismatch: false as const };
    }, { timeout: 30_000 });
    if (persisted.mismatch) {
      await revokeUnpersistedGrant();
      res.redirect(303, callbackRedirect(attempt.returnTo, 'error'));
      return;
    }
    grantPersisted = true;
    res.redirect(303, callbackRedirect(attempt.returnTo, 'connected'));
  } catch {
    await revokeUnpersistedGrant();
    // A Google identity may already belong to another Courtly person. Treat
    // that uniqueness conflict as a failed link without exposing the account.
    await prisma.calendarConnection.updateMany({
      where: { userId: req.auth.user.id, status: { not: 'DISCONNECTING' } },
      data: { lastErrorCode: 'OAUTH_FAILED' },
    });
    res.redirect(303, callbackRedirect(attempt.returnTo, 'error'));
  }
}));

calendarRouter.patch('/connection', asyncRoute(async (req, res) => {
  assertConfigured();
  assertEligible(req);
  const body = preferencesInput.parse(req.body);
  const updated = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar-user:${req.auth.user.id}`}, 0))`;
    const connection = await tx.calendarConnection.findUnique({ where: { userId: req.auth.user.id } });
    if (!connection || connection.status === 'DISCONNECTING') {
      throw new HttpError(409, 'Connect Google Calendar before changing its settings');
    }
    const saved = await tx.calendarConnection.update({
      where: { id: connection.id },
      data: {
        ...body,
        ...(body.busyCheckEnabled === true ? { busyRefreshAfter: new Date() } : {}),
      },
    });
    if (body.syncEnabled !== undefined) {
      await queueCalendarBookingsForUserInTransaction(tx, req.auth.user.id);
    }
    if (body.busyCheckEnabled === false) {
      await tx.calendarBusyInterval.deleteMany({ where: { connectionId: connection.id } });
    }
    return saved;
  }, { timeout: 30_000 });
  res.json(await connectionStatus(req, updated));
}));

calendarRouter.post('/sync', asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  assertConfigured();
  assertEligible(req);
  const connection = await prisma.calendarConnection.findUnique({ where: { userId: req.auth.user.id } });
  if (!connection || connection.status === 'DISCONNECTING') throw new HttpError(409, 'Connect Google Calendar before syncing');
  if (connection.status === 'REAUTH_REQUIRED') throw new HttpError(409, 'Reconnect Google Calendar to resume syncing');
  await queueCalendarBookingsForUser(req.auth.user.id);
  const updated = await prisma.calendarConnection.update({
    where: { id: connection.id },
    data: { ...(connection.busyCheckEnabled ? { busyRefreshAfter: new Date() } : {}), lastErrorCode: null },
  });
  res.status(202).json(await connectionStatus(req, updated));
}));

calendarRouter.delete('/connection', asyncRoute(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  assertEligible(req);
  const updated = await disconnectCalendarConnection(req.auth.user.id);
  res.status(updated ? 202 : 200).json(await connectionStatus(req, updated));
}));
