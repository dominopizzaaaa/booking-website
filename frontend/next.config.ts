import type { NextConfig } from 'next';

// Normalise BACKEND_URL: trim, strip trailing slashes, and ensure a protocol.
// Railway/Vercel often surface a bare host (e.g. "app.up.railway.app"); without
// a scheme Next.js rejects the rewrite below and `next build` exits 1.
const rawBackendUrl = (process.env.BACKEND_URL || 'http://127.0.0.1:4000').trim().replace(/\/+$/, '');
const backendUrl = /^https?:\/\//i.test(rawBackendUrl) ? rawBackendUrl : `https://${rawBackendUrl}`;

const config: NextConfig = {
  turbopack: { root: process.cwd() },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backendUrl}/api/:path*` }];
  },
};

export default config;
