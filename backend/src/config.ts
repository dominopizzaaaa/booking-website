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
  sessionDays: 14,
  demoEnabled: process.env.DEMO_ENABLED === 'true' || (!production && process.env.DEMO_ENABLED !== 'false'),
  origins: (process.env.APP_ORIGIN || (production ? '' : 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3100,http://127.0.0.1:3100,http://localhost:3107,http://127.0.0.1:3107,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4000,http://127.0.0.1:4000')).split(',').map(x => x.trim()).filter(Boolean),
};
