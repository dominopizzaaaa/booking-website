import 'dotenv/config';
export const production = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL) {
  if (production) throw new Error('DATABASE_URL is required in production');
  process.env.DATABASE_URL = 'postgresql://postgres:courtly_local_dev@127.0.0.1:55432/courtly?schema=public';
}

export type CalendarTokenKey = { id: string; key: Buffer };

function calendarConfiguration() {
  const clientId = (process.env.GOOGLE_CALENDAR_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '').trim();
  const redirectUri = (process.env.GOOGLE_CALENDAR_REDIRECT_URI || '').trim();
  const activeKeyId = (process.env.CALENDAR_TOKEN_ACTIVE_KEY_ID || '').trim();
  const encodedKeys = (process.env.CALENDAR_TOKEN_ENCRYPTION_KEYS || '').trim();
  const keys = new Map<string, Buffer>();
  let valid = Boolean(clientId && clientSecret && redirectUri && activeKeyId && encodedKeys);

  try {
    const parsedRedirect = new URL(redirectUri);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsedRedirect.hostname);
    const secureRedirect = parsedRedirect.protocol === 'https:'
      || (!production && parsedRedirect.protocol === 'http:' && loopback);
    if (!secureRedirect || parsedRedirect.username
      || parsedRedirect.password || parsedRedirect.hash) valid = false;
  } catch {
    valid = false;
  }

  if (encodedKeys) {
    for (const entry of encodedKeys.split(',')) {
      const separator = entry.indexOf(':');
      const id = entry.slice(0, separator).trim();
      const encoded = entry.slice(separator + 1).trim();
      if (separator < 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(id)
        || !/^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{3}=$/.test(encoded) || keys.has(id)) {
        valid = false;
        continue;
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32 || key.toString('base64') !== encoded) {
        valid = false;
        continue;
      }
      keys.set(id, key);
    }
  }
  if (!keys.has(activeKeyId)) valid = false;

  return {
    enabled: valid, clientId, clientSecret, redirectUri, activeKeyId, keys,
    oauthAttemptMinutes: 10,
    requestTimeoutMs: 10_000,
    workerIntervalMs: 30_000,
    busyRefreshMinutes: 10,
    busyCacheMinutes: 30,
  };
}

function paymentConfiguration() {
  const requested = (process.env.PAYMENTS_MODE || 'disabled').trim().toLowerCase();
  if (!['disabled', 'stripe', 'simulated'].includes(requested)) throw new Error('PAYMENTS_MODE must be disabled, stripe, or simulated');
  if (production && requested === 'simulated') throw new Error('Simulated payments cannot run in production');
  const secretKey = (process.env.STRIPE_SECRET_KEY || '').trim();
  const publishableKey = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
  const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (requested === 'stripe') {
    if (!secretKey || !publishableKey || !webhookSecret) throw new Error('Stripe mode requires STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, and STRIPE_WEBHOOK_SECRET');
    const secretLive = secretKey.startsWith('sk_live_');
    const publishableLive = publishableKey.startsWith('pk_live_');
    if (secretLive !== publishableLive) throw new Error('Stripe secret and publishable keys must use the same test or live mode');
  }
  return { mode: requested as 'disabled' | 'stripe' | 'simulated', enabled: requested !== 'disabled', secretKey, publishableKey, webhookSecret };
}

function emailConfiguration() {
  const requested = (process.env.EMAIL_PROVIDER || 'disabled').trim().toLowerCase();
  if (!['disabled', 'capture', 'resend'].includes(requested)) throw new Error('EMAIL_PROVIDER must be disabled, capture, or resend');
  if (production && requested === 'capture') throw new Error('Capture email cannot run in production');
  const apiKey = (process.env.EMAIL_API_KEY || '').trim();
  const fromAddress = (process.env.EMAIL_FROM_ADDRESS || '').trim();
  const fromName = (process.env.EMAIL_FROM_NAME || 'Courtly').trim();
  const replyTo = (process.env.EMAIL_REPLY_TO || '').trim();
  if (requested !== 'disabled' && (!fromAddress || (requested === 'resend' && !apiKey))) {
    throw new Error('Configured email requires EMAIL_FROM_ADDRESS and provider credentials');
  }
  return { mode: requested as 'disabled' | 'capture' | 'resend', enabled: requested !== 'disabled', apiKey, fromAddress, fromName, replyTo };
}

export const config = {
  port: Number(process.env.PORT || 4000),
  sessionCookie: production ? '__Host-courtly_session' : 'courtly_session',
  adminCookie: production ? '__Host-courtly_admin' : 'courtly_admin',
  adminPassword: (process.env.ADMIN_PASSWORD || '').trim(),
  adminSessionHours: 12,
  // Optional. Enables server-side Google Places venue lookup; the key never
  // reaches the browser. Without it, venues are added by pasting a Maps link
  // or by typing an address.
  googleMapsApiKey: (process.env.GOOGLE_MAPS_API_KEY || '').trim(),
  googleCalendar: calendarConfiguration(),
  payments: paymentConfiguration(),
  email: emailConfiguration(),
  publicAppOrigin: (process.env.PUBLIC_APP_ORIGIN || process.env.APP_ORIGIN?.split(',')[0] || 'http://localhost:3000').trim().replace(/\/$/, ''),
  sessionDays: 14,
  demoEnabled: process.env.DEMO_ENABLED === 'true' || (!production && process.env.DEMO_ENABLED !== 'false'),
  // The browser suite creates many isolated accounts from one loopback IP.
  // Keep the escape hatch test-only even if it is accidentally configured on
  // a deployed service.
  e2eRateLimitBypass: !production && process.env.E2E_DISABLE_RATE_LIMITS === 'true',
  origins: (process.env.APP_ORIGIN || (production ? '' : 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001,http://localhost:3100,http://127.0.0.1:3100,http://localhost:3107,http://127.0.0.1:3107,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4000,http://127.0.0.1:4000')).split(',').map(x => x.trim()).filter(Boolean),
};

export const skipRateLimits = () => config.e2eRateLimitBypass;
