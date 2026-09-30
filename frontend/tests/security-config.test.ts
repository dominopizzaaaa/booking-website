import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import config, { createSecurityHeaders, securityHeaders } from '../next.config';

describe('public security configuration', () => {
  it('sets browser isolation and a Stripe-compatible content policy', async () => {
    const headers = Object.fromEntries(securityHeaders.map(header => [header.key, header.value]));
    expect(headers['Content-Security-Policy']).toContain("default-src 'self'");
    expect(headers['Content-Security-Policy']).toContain('https://js.stripe.com');
    expect(headers['Content-Security-Policy']).toContain('https://hooks.stripe.com');
    expect(headers['Content-Security-Policy']).toContain('https://m.stripe.network');
    expect(headers['Content-Security-Policy']).not.toContain("default-src *");
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(Object.fromEntries(createSecurityHeaders(true).map(header => [header.key, header.value]))['Strict-Transport-Security']).toBe('max-age=31536000');
    expect(Object.fromEntries(createSecurityHeaders(false).map(header => [header.key, header.value]))).not.toHaveProperty('Strict-Transport-Security');
    expect(await config.headers?.()).toEqual([{ source: '/:path*', headers: securityHeaders }]);
  });

  it('publishes a bounded, non-HTTP security contact', () => {
    const contents = readFileSync(resolve('public/.well-known/security.txt'), 'utf8');
    expect(contents).toContain('Contact: mailto:domksj23@gmail.com');
    expect(contents).toMatch(/Expires: \d{4}-\d{2}-\d{2}T00:00:00Z/);
    expect(contents).not.toMatch(/https?:\/\/localhost|response|SLA/i);
  });
});
