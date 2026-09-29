import { createHash, createHmac } from 'node:crypto';
import { config } from './config.js';

const tokenVersion = 'v1';
const tokenContext = 'courtly-email-verification';
export type EmailVerificationKeyring = {
  enabled: boolean;
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

type EmailVerificationConfigShape = {
  emailVerificationTokens?: EmailVerificationKeyring;
};

export class EmailVerificationTokenError extends Error {
  constructor(message = 'Email verification token key is unavailable') {
    super(message);
    this.name = 'EmailVerificationTokenError';
  }
}

export function configuredEmailVerificationKeyring(
  source: EmailVerificationConfigShape = config,
): EmailVerificationKeyring {
  return source.emailVerificationTokens ?? { enabled: false, activeKeyId: '', keys: new Map() };
}

export function deriveEmailVerificationToken(
  claimId: string,
  keyId = configuredEmailVerificationKeyring().activeKeyId,
  keyring: Pick<EmailVerificationKeyring, 'keys'> = configuredEmailVerificationKeyring(),
) {
  const normalizedId = claimId.trim();
  const key = keyring.keys.get(keyId);
  if (!normalizedId || !/^[A-Za-z0-9_-]{1,200}$/.test(normalizedId)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || !key || key.length !== 32) {
    throw new EmailVerificationTokenError();
  }
  return createHmac('sha256', key)
    .update(`${tokenContext}:${tokenVersion}:${keyId}:${normalizedId}`, 'utf8')
    .digest('base64url');
}

export function activeEmailVerificationToken(
  claimId: string,
  keyring: EmailVerificationKeyring = configuredEmailVerificationKeyring(),
) {
  if (!keyring.enabled) throw new EmailVerificationTokenError();
  const keyId = keyring.activeKeyId;
  return { keyId, token: deriveEmailVerificationToken(claimId, keyId, keyring) };
}

export function emailVerificationTokenDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function emailVerificationUrl(token: string) {
  // URL fragments are never sent in HTTP requests or Referer headers. The
  // verification page removes this fragment before posting the bearer.
  return `${config.publicAppOrigin}/account/verify-email#token=${encodeURIComponent(token)}`;
}
