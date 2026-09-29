import { describe, expect, it } from 'vitest';
import {
  EmailVerificationTokenError, activeEmailVerificationToken,
  deriveEmailVerificationToken, emailVerificationUrl,
} from '../src/email-verification-token.js';
import { assertSignupEmailVerificationAvailable } from '../src/auth.js';

describe('email verification claims', () => {
  const keys = new Map([
    ['v1', Buffer.alloc(32, 1)],
    ['v2', Buffer.alloc(32, 2)],
  ]);

  it('pins each token to its persisted key id across key rotation', () => {
    const oldToken = deriveEmailVerificationToken('claim_1', 'v1', { keys });
    const active = activeEmailVerificationToken('claim_1', { enabled: true, activeKeyId: 'v2', keys });

    expect(active.keyId).toBe('v2');
    expect(active.token).toBe(deriveEmailVerificationToken('claim_1', 'v2', { keys }));
    expect(active.token).not.toBe(oldToken);
    expect(() => deriveEmailVerificationToken('claim_1', 'removed', { keys }))
      .toThrow(EmailVerificationTokenError);
  });

  it('places the bearer in a URL fragment rather than the request query', () => {
    const url = new URL(emailVerificationUrl('sensitive_token'));
    expect(url.pathname).toBe('/account/verify-email');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#token=sensitive_token');
  });

  it('fails production signup closed unless email and an active key are available', () => {
    const keyring = { enabled: true, activeKeyId: 'v2', keys };
    expect(() => assertSignupEmailVerificationAvailable(true, false, keyring))
      .toThrowError(expect.objectContaining({
        status: 503, details: { code: 'SIGNUP_EMAIL_VERIFICATION_UNAVAILABLE' },
      }));
    expect(() => assertSignupEmailVerificationAvailable(true, true, { enabled: true, activeKeyId: 'missing', keys }))
      .toThrowError(expect.objectContaining({ status: 503 }));
    expect(() => assertSignupEmailVerificationAvailable(true, true, { enabled: false, activeKeyId: 'v2', keys }))
      .toThrowError(expect.objectContaining({ status: 503 }));
    expect(() => assertSignupEmailVerificationAvailable(true, true, keyring)).not.toThrow();
    expect(() => assertSignupEmailVerificationAvailable(false, false, { enabled: false, activeKeyId: '', keys: new Map() }))
      .not.toThrow();
  });
});
