import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authDestination, clearMfaLoginChallenge, consumeFragmentToken, isRecentAuthRequired, readMfaLoginChallenge,
  safeLocalReturnPath, storeMfaLoginChallenge,
} from '../src/lib/account-security';
import { registerRecentAuthHandler, requestRecentAuthentication } from '../src/lib/recent-auth-coordinator';
import type { AuthSession, MfaLoginChallenge } from '../src/lib/types';

afterEach(() => { vi.unstubAllGlobals(); });

describe('account security fragment handling', () => {
  it('extracts and scrubs a one-time bearer without putting it in the request URL', () => {
    const replaceState = vi.fn();
    expect(consumeFragmentToken({
      pathname: '/account/reset-password', search: '?source=email', hash: '#token=reset_bearer&ignored=value',
    }, replaceState, { navigation: true })).toBe('reset_bearer');
    expect(replaceState).toHaveBeenCalledWith({ navigation: true }, '', '/account/reset-password?source=email');
  });

  it('rejects external and protocol-relative return destinations', () => {
    expect(safeLocalReturnPath('/manage?tab=profile')).toBe('/manage?tab=profile');
    expect(safeLocalReturnPath('//attacker.example')).toBeNull();
    expect(safeLocalReturnPath('https://attacker.example')).toBeNull();
    expect(safeLocalReturnPath('/safe\\redirect')).toBeNull();
  });
});

describe('MFA login challenge storage', () => {
  const challenge: MfaLoginChallenge = {
    mfaRequired: true, challengeId: 'challenge-1', methods: ['TOTP', 'RECOVERY_CODE'],
    expiresAt: '2099-01-01T00:00:00.000Z',
  };

  it('stores only the bounded challenge and a safe return path', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: {
      setItem: (key: string, value: string) => values.set(key, value),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    } });
    storeMfaLoginChallenge(challenge, '/account/security');
    expect(readMfaLoginChallenge()).toEqual({ ...challenge, returnTo: '/account/security' });
    clearMfaLoginChallenge();
    expect(readMfaLoginChallenge()).toBeNull();
  });

  it('fails closed for expired or malformed challenges', () => {
    const storage = { getItem: () => JSON.stringify({ ...challenge, expiresAt: '2000-01-01T00:00:00.000Z' }) };
    expect(readMfaLoginChallenge(storage)).toBeNull();
    expect(readMfaLoginChallenge({ getItem: () => '{not json' })).toBeNull();
  });
});

describe('post-login destination', () => {
  const session = {
    user: { id: 'u1', name: 'A', username: 'a_user', email: 'a@example.test', accountType: 'STUDENT' },
    membership: null, business: null, memberships: [],
  } as AuthSession;

  it('uses a safe requested student destination and ignores an external one', () => {
    expect(authDestination(session, '/book/club')).toBe('/book/club');
    expect(authDestination(session, '//attacker.example')).toBe('/manage');
  });

  it('returns every account type to the signed-in security page', () => {
    const coach = { ...session, user: { ...session.user, accountType: 'COACH' as const } };
    expect(authDestination(coach, '/account/security')).toBe('/account/security');
  });
});

describe('recent authentication errors', () => {
  it('recognizes only the stable 428 code', () => {
    expect(isRecentAuthRequired({ status: 428, details: { code: 'RECENT_AUTH_REQUIRED' } })).toBe(true);
    expect(isRecentAuthRequired({ status: 401, details: { code: 'RECENT_AUTH_REQUIRED' } })).toBe(false);
    expect(isRecentAuthRequired({ status: 428, details: { code: 'OTHER' } })).toBe(false);
  });

  it('coalesces concurrent protected actions behind one credential prompt', async () => {
    let release!: () => void;
    const prompt = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const unregister = registerRecentAuthHandler(prompt);
    const first = requestRecentAuthentication();
    const second = requestRecentAuthentication();
    expect(prompt).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    unregister();
  });

  it('reports no prompt when the app provider is not mounted', async () => {
    expect(await requestRecentAuthentication()).toBe(false);
  });
});
