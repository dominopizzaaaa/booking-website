import 'dotenv/config';
export const production = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL) {
  if (production) throw new Error('DATABASE_URL is required in production');
  process.env.DATABASE_URL = 'postgresql://postgres:courtly_local_dev@127.0.0.1:55432/courtly?schema=public';
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
  sessionDays: 14,
  demoEnabled: process.env.DEMO_ENABLED === 'true' || (!production && process.env.DEMO_ENABLED !== 'false'),
  // The browser suite creates many isolated accounts from one loopback IP.
  // Keep the escape hatch test-only even if it is accidentally configured on
  // a deployed service.
  e2eRateLimitBypass: !production && process.env.E2E_DISABLE_RATE_LIMITS === 'true',
  origins: (process.env.APP_ORIGIN || (production ? '' : 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3100,http://127.0.0.1:3100,http://localhost:3107,http://127.0.0.1:3107,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4000,http://127.0.0.1:4000')).split(',').map(x => x.trim()).filter(Boolean),
};

export const skipRateLimits = () => config.e2eRateLimitBypass;
