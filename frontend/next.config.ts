import type { NextConfig } from 'next';

// Normalise BACKEND_URL: trim, strip trailing slashes, and ensure a protocol.
// Railway/Vercel often surface a bare host (e.g. "app.up.railway.app"); without
// a scheme Next.js rejects the rewrite below and `next build` exits 1.
const rawBackendUrl = (process.env.BACKEND_URL || 'http://127.0.0.1:4000').trim().replace(/\/+$/, '');
const backendUrl = /^https?:\/\//i.test(rawBackendUrl) ? rawBackendUrl : `https://${rawBackendUrl}`;
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  // Next currently emits bootstrap scripts without a per-request nonce. Keep
  // inline scripts bounded to this document and allow only Stripe's SDK.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'"} https://js.stripe.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.stripe.com",
  "font-src 'self'",
  `connect-src 'self'${process.env.NODE_ENV === 'production' ? '' : ' ws: wss:'} https://api.stripe.com https://r.stripe.com https://m.stripe.network https://checkout.stripe.com`,
  "frame-src https://js.stripe.com https://hooks.stripe.com https://m.stripe.network https://checkout.stripe.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  ...(process.env.NODE_ENV === 'production' ? ['upgrade-insecure-requests'] : []),
].join('; ');

export function createSecurityHeaders(isProduction = process.env.NODE_ENV === 'production') {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ...(isProduction
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }]
    : []),
  ];
}

export const securityHeaders = createSecurityHeaders();

const config: NextConfig = {
  turbopack: { root: process.cwd() },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backendUrl}/api/:path*` }];
  },
};

export default config;
