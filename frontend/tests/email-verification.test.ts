import { describe, expect, it, vi } from 'vitest';
import { consumeVerificationToken } from '../src/lib/email-verification';

describe('email verification fragment', () => {
  it('extracts the bearer and removes the entire fragment before callers can send it', () => {
    const replaceState = vi.fn();
    const state = { navigation: 'state' };
    const token = consumeVerificationToken({
      pathname: '/account/verify-email', search: '?source=inbox',
      hash: '#token=secure_bearer&ignored=value',
    }, replaceState, state);

    expect(token).toBe('secure_bearer');
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(state, '', '/account/verify-email?source=inbox');
  });

  it('returns no bearer and does not rewrite a URL with no fragment', () => {
    const replaceState = vi.fn();
    expect(consumeVerificationToken({
      pathname: '/account/verify-email', search: '', hash: '',
    }, replaceState)).toBe('');
    expect(replaceState).not.toHaveBeenCalled();
  });
});
