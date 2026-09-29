import 'dotenv/config';
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const production = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL) {
  if (production) throw new Error('DATABASE_URL is required in production');
  process.env.DATABASE_URL = 'postgresql://postgres:courtly_local_dev@127.0.0.1:55432/courtly?schema=public';
}

export type CalendarTokenKey = { id: string; key: Buffer };
export type FamilyHandoverTokenKey = { id: string; key: Buffer };
export type EmailVerificationTokenKey = { id: string; key: Buffer };
export type AdminOperatorCredential = {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
};

const adminOperatorSchema = z.object({
  id: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'Admin operator id must contain only letters, numbers, underscores, or hyphens'),
  name: z.string().trim().min(1).max(120).refine(value => !/[\u0000-\u001f\u007f]/u.test(value),
    'Admin operator name must not contain control characters'),
  email: z.string().trim().toLowerCase().email().max(320),
  passwordHash: z.string().regex(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/,
    'Admin operator passwordHash must be a bcrypt hash with cost 12'),
}).strict().refine(operator => Buffer.byteLength(` <${operator.email}> [${operator.id}]`, 'utf8') < 120, {
  message: 'Admin operator id and email are too long for audit attribution',
});

export function adminOperatorConfiguration(raw = process.env.ADMIN_OPERATORS_JSON): AdminOperatorCredential[] {
  const encoded = (raw || '').trim();
  if (!encoded) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); }
  catch { throw new Error('ADMIN_OPERATORS_JSON must be a valid JSON array'); }
  const operators = z.array(adminOperatorSchema).min(1).max(100).parse(parsed);
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const operator of operators) {
    if (ids.has(operator.id)) throw new Error(`ADMIN_OPERATORS_JSON contains duplicate id: ${operator.id}`);
    if (emails.has(operator.email)) throw new Error(`ADMIN_OPERATORS_JSON contains duplicate email: ${operator.email}`);
    ids.add(operator.id);
    emails.add(operator.email);
  }
  return operators;
}

function adminSessionKeyConfiguration(): { key: Buffer; configured: boolean; valid: boolean } {
  const encoded = (process.env.ADMIN_SESSION_SECRET || '').trim();
  const decoded = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  if (encoded && (decoded.length !== 32 || decoded.toString('base64') !== encoded)) {
    if (production) {
      return {
        key: createHash('sha256').update('courtly-invalid-production-admin-session').digest(),
        configured: true, valid: false,
      };
    }
    throw new Error('ADMIN_SESSION_SECRET must be exactly 32 bytes encoded as base64');
  }
  // Production treats a missing key as admin-unconfigured, so the rest of the
  // application remains available. This fallback is never accepted there.
  return {
    key: decoded.length === 32
      ? decoded
      : createHash('sha256').update('courtly-local-admin-session-only').digest(),
    configured: decoded.length === 32, valid: true,
  };
}

function featureFlag(value: string | undefined, defaultValue: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === 'true';
}

function familyHandoverTokenConfiguration() {
  const activeKeyId = (process.env.FAMILY_HANDOVER_TOKEN_ACTIVE_KEY_ID || '').trim();
  const encodedKeys = (process.env.FAMILY_HANDOVER_TOKEN_KEYS || '').trim();
  const keys = new Map<string, Buffer>();
  let valid = Boolean(activeKeyId && encodedKeys);

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

  return { enabled: valid, activeKeyId, keys };
}

function emailVerificationTokenConfiguration() {
  const configuredActiveKeyId = (process.env.EMAIL_VERIFICATION_TOKEN_ACTIVE_KEY_ID || '').trim();
  const encodedKeys = (process.env.EMAIL_VERIFICATION_TOKEN_KEYS || '').trim();

  // Local development remains usable without secret provisioning. Production
  // never receives this fallback: an absent or malformed keyring leaves only
  // registration/resend unavailable, rather than taking down unrelated APIs.
  if (!production && !configuredActiveKeyId && !encodedKeys) {
    const activeKeyId = 'local-v1';
    return {
      enabled: true,
      activeKeyId,
      keys: new Map([[activeKeyId, createHash('sha256')
        .update('courtly-local-email-verification-only').digest()]]),
    };
  }

  const keys = new Map<string, Buffer>();
  let valid = Boolean(configuredActiveKeyId && encodedKeys);
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
  if (!keys.has(configuredActiveKeyId)) valid = false;
  return { enabled: valid, activeKeyId: configuredActiveKeyId, keys };
}

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

function publicAppOriginConfiguration(emailEnabled: boolean) {
  const explicit = (process.env.PUBLIC_APP_ORIGIN || '').trim();
  const fallback = (process.env.APP_ORIGIN?.split(',')[0] || 'http://localhost:3000').trim();
  const candidate = explicit || fallback;
  if (production && emailEnabled) {
    if (!explicit) {
      throw new Error('PUBLIC_APP_ORIGIN is required when production email is enabled');
    }
    let parsed: URL;
    try { parsed = new URL(explicit); }
    catch { throw new Error('PUBLIC_APP_ORIGIN must be a canonical HTTPS origin'); }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash
      || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
      throw new Error('PUBLIC_APP_ORIGIN must be a canonical non-loopback HTTPS origin');
    }
    return parsed.origin;
  }
  return candidate.replace(/\/$/, '');
}

const email = emailConfiguration();
let adminOperators: AdminOperatorCredential[] = [];
let adminOperatorsValid = true;
try { adminOperators = adminOperatorConfiguration(); }
catch (error) {
  if (!production) throw error;
  adminOperatorsValid = false;
}
const adminSession = adminSessionKeyConfiguration();
const emailVerificationTokens = emailVerificationTokenConfiguration();

export const config = {
  port: Number(process.env.PORT || 4000),
  sessionCookie: production ? '__Host-courtly_session' : 'courtly_session',
  adminCookie: production ? '__Host-courtly_admin' : 'courtly_admin',
  // Named operators are mandatory in production. ADMIN_PASSWORD remains a
  // non-production compatibility path and cannot reach sensitive admin routes.
  adminOperators,
  adminSessionSecret: adminSession.key,
  adminSessionSecretConfigured: adminSession.configured,
  adminConfigurationValid: adminOperatorsValid && adminSession.valid,
  adminPassword: production ? '' : (process.env.ADMIN_PASSWORD || '').trim(),
  adminSessionHours: 12,
  // Optional. Enables server-side Google Places venue lookup; the key never
  // reaches the browser. Without it, venues are added by pasting a Maps link
  // or by typing an address.
  googleMapsApiKey: (process.env.GOOGLE_MAPS_API_KEY || '').trim(),
  googleCalendar: calendarConfiguration(),
  payments: paymentConfiguration(),
  email,
  // Family is deliberately opt-in in production so schema rollout, worker
  // readiness, and the matching frontend can be verified before writes open.
  familyFeatureEnabled: featureFlag(process.env.FAMILY_FEATURE_ENABLED, !production),
  familyHandoverTokens: familyHandoverTokenConfiguration(),
  // Destructive business deletion is never available in a production process.
  // Local and test environments retain it for cleanup and coverage.
  realBusinessDeletionEnabled: !production,
  // Versioned HMAC keys keep email-verification bearers out of persistent
  // storage and allow rotation without invalidating still-live claims.
  emailVerificationTokens,
  publicAppOrigin: publicAppOriginConfiguration(email.enabled),
  // Public policy publication and signup acceptance are production-disabled
  // until an accountable owner records approval of this exact version and
  // content hash. A date alone must never approve changed draft text.
  legalDocumentsApprovedVersion: (process.env.LEGAL_DOCUMENTS_APPROVED_VERSION || '').trim(),
  legalDocumentsApprovedHash: (process.env.LEGAL_DOCUMENTS_APPROVED_HASH || '').trim().toLowerCase(),
  // This acknowledgement is deliberately independent from legal-document
  // publication. Live Stripe checkout stays closed until the current seller,
  // payment-recipient, refund-owner, and GST decisions are approved.
  paymentCommercialApprovedVersion: (process.env.PAYMENT_COMMERCIAL_APPROVED_VERSION || '').trim(),
  // Marketing remains hard-disabled until consent evidence, unsubscribe, DNC,
  // campaign approval, and suppression controls are implemented end to end.
  marketingEnabled: false,
  sessionDays: 14,
  demoEnabled: process.env.DEMO_ENABLED === 'true' || (!production && process.env.DEMO_ENABLED !== 'false'),
  // The browser suite creates many isolated accounts from one loopback IP.
  // Keep the escape hatch test-only even if it is accidentally configured on
  // a deployed service.
  e2eRateLimitBypass: !production && process.env.E2E_DISABLE_RATE_LIMITS === 'true',
  origins: (process.env.APP_ORIGIN || (production ? '' : 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001,http://localhost:3100,http://127.0.0.1:3100,http://localhost:3107,http://127.0.0.1:3107,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4000,http://127.0.0.1:4000')).split(',').map(x => x.trim()).filter(Boolean),
};

export const skipRateLimits = () => config.e2eRateLimitBypass;
