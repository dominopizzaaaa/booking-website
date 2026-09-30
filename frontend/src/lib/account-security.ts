import type { AuthSession, MfaLoginChallenge } from './types';

export type BrowserLocation = { hash: string; pathname: string; search: string };
export type StoredMfaChallenge = MfaLoginChallenge & { returnTo: string | null };

const mfaChallengeKey = 'courtly:mfa-login-challenge';
const pendingFragmentTokens = new Map<string, string>();

export function isRecentAuthRequired(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const error = value as { status?: unknown; details?: unknown };
  if (error.status !== 428 || !error.details || typeof error.details !== 'object') return false;
  return (error.details as { code?: unknown }).code === 'RECENT_AUTH_REQUIRED';
}

export function safeLocalReturnPath(value: string | null | undefined) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    return new URL(value, 'https://courtly.local').origin === 'https://courtly.local' ? value : null;
  } catch {
    return null;
  }
}

export function authDestination(session: AuthSession, requested?: string | null) {
  if (session.user.requiredAction) return '/account/action-required';
  const safeRequested = safeLocalReturnPath(requested);
  if (safeRequested?.startsWith('/account?staffInvite=')) return safeRequested;
  if (safeRequested === '/account/security' || safeRequested?.startsWith('/account/security?')) return safeRequested;
  if (session.user.accountType === 'STUDENT') return safeRequested ?? '/manage';
  if (session.business?.kind === 'CLUB' && !session.business.legacyReadOnly && session.accessMode !== 'NONE') return '/';
  return '/account';
}

export function consumeFragmentToken(
  location: BrowserLocation,
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void,
  historyState: unknown = null,
) {
  const token = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash)
    .get('token')?.trim() || '';
  if (location.hash) replaceState(historyState, '', `${location.pathname}${location.search}`);
  return token;
}

export function consumeWindowFragmentToken() {
  if (typeof window === 'undefined') return '';
  const key = window.location.pathname;
  const token = consumeFragmentToken(
    window.location, window.history.replaceState.bind(window.history), window.history.state,
  );
  if (token) pendingFragmentTokens.set(key, token);
  return token || pendingFragmentTokens.get(key) || '';
}

export function releaseWindowFragmentToken(token: string) {
  for (const [key, value] of pendingFragmentTokens) if (value === token) pendingFragmentTokens.delete(key);
}

export function storeMfaLoginChallenge(challenge: MfaLoginChallenge, returnTo?: string | null) {
  if (typeof window === 'undefined') return;
  const value: StoredMfaChallenge = { ...challenge, returnTo: safeLocalReturnPath(returnTo) };
  try { window.sessionStorage.setItem(mfaChallengeKey, JSON.stringify(value)); } catch { /* Storage can be unavailable. */ }
}

export function readMfaLoginChallenge(storage?: Pick<Storage, 'getItem'>): StoredMfaChallenge | null {
  const source = storage ?? (typeof window === 'undefined' ? null : window.sessionStorage);
  if (!source) return null;
  let raw: string | null;
  try { raw = source.getItem(mfaChallengeKey); } catch { return null; }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredMfaChallenge>;
    if (value.mfaRequired !== true || typeof value.challengeId !== 'string' || !value.challengeId
      || typeof value.expiresAt !== 'string' || !Array.isArray(value.methods)) return null;
    const methods = value.methods.filter(method => method === 'TOTP' || method === 'RECOVERY_CODE');
    const expiresAt = new Date(value.expiresAt).getTime();
    if (!methods.length || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return {
      mfaRequired: true, challengeId: value.challengeId, expiresAt: value.expiresAt, methods,
      returnTo: safeLocalReturnPath(value.returnTo),
    };
  } catch {
    return null;
  }
}

export function clearMfaLoginChallenge(storage?: Pick<Storage, 'removeItem'>) {
  const source = storage ?? (typeof window === 'undefined' ? null : window.sessionStorage);
  try { source?.removeItem(mfaChallengeKey); } catch { /* Nothing sensitive is retained elsewhere. */ }
}
