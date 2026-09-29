import { createHash, createHmac } from 'node:crypto';
import { config } from './config.js';

const tokenVersion = 'v1';
const tokenContext = 'courtly-family-handover';

type FamilyHandoverKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

export class FamilyHandoverTokenError extends Error {
  constructor(message = 'Family handover token key is unavailable') {
    super(message);
    this.name = 'FamilyHandoverTokenError';
  }
}

/**
 * Derive rather than persist a handover bearer token. The stable handover ID
 * and non-secret key ID may live in the outbox; only the server keyring can
 * reconstruct the token needed at delivery time.
 */
export function deriveFamilyHandoverToken(
  handoverId: string,
  keyId = config.familyHandoverTokens.activeKeyId,
  keyring: Pick<FamilyHandoverKeyring, 'keys'> = config.familyHandoverTokens,
) {
  const normalizedId = handoverId.trim();
  const key = keyring.keys.get(keyId);
  if (!normalizedId || !/^[A-Za-z0-9_-]{1,200}$/.test(normalizedId)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId) || !key || key.length !== 32) {
    throw new FamilyHandoverTokenError();
  }
  return createHmac('sha256', key)
    .update(`${tokenContext}:${tokenVersion}:${normalizedId}`, 'utf8')
    .digest('base64url');
}

export function familyHandoverTokenDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function activeFamilyHandoverToken(handoverId: string) {
  const keyId = config.familyHandoverTokens.activeKeyId;
  return { keyId, token: deriveFamilyHandoverToken(handoverId, keyId) };
}

export function familyHandoverClaimUrl(token: string) {
  return `${config.publicAppOrigin}/family/handover?token=${encodeURIComponent(token)}`;
}
