import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { config } from './config.js';

const envelopeVersion = 'v1';
const ivBytes = 12;
const tagBytes = 16;
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export type AccountSecurityKeyring = {
  enabled: boolean;
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

export class AccountSecurityCryptoError extends Error {
  constructor(message = 'Account security key is unavailable') {
    super(message);
    this.name = 'AccountSecurityCryptoError';
  }
}

function keyring(): AccountSecurityKeyring {
  return config.accountSecurityKeys;
}

function activeKey(keys = keyring()) {
  const key = keys.keys.get(keys.activeKeyId);
  if (!keys.enabled || !key || key.length !== 32) throw new AccountSecurityCryptoError();
  return { id: keys.activeKeyId, key };
}

function decodeBase32(value: string) {
  const normalized = value.toUpperCase().replace(/[=\s-]/g, '');
  if (!normalized || /[^A-Z2-7]/.test(normalized)) throw new AccountSecurityCryptoError('TOTP secret is invalid');
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    buffer = (buffer << 5) | base32Alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function encodeBase32(value: Buffer) {
  let bits = 0;
  let buffer = 0;
  let output = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += base32Alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits) output += base32Alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

export function generateTotpSecret() {
  return encodeBase32(randomBytes(20));
}

export function generateTotpCode(secret: string, now = Date.now()) {
  const secretBytes = decodeBase32(secret);
  if (secretBytes.length < 10) throw new AccountSecurityCryptoError('TOTP secret is invalid');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', secretBytes).update(counter).digest();
  const index = digest[digest.length - 1]! & 0x0f;
  const binary = (((digest[index]! & 0x7f) << 24)
    | (digest[index + 1]! << 16) | (digest[index + 2]! << 8) | digest[index + 3]!) >>> 0;
  return String(binary % 1_000_000).padStart(6, '0');
}

/** RFC 6238 (HMAC-SHA1, 30 second step, six digits). Returns the accepted
 * counter so callers can persist it and reject replay of the same OTP. */
export function verifyTotp(
  secret: string,
  code: string,
  options: { now?: number; window?: number; afterStep?: bigint | number | null } = {},
) {
  const normalizedCode = code.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(normalizedCode)) return null;
  let secretBytes: Buffer;
  try { secretBytes = decodeBase32(secret); }
  catch { return null; }
  if (secretBytes.length < 10) return null;
  const center = Math.floor((options.now ?? Date.now()) / 30_000);
  const afterStep = options.afterStep === null || options.afterStep === undefined
    ? null : BigInt(options.afterStep);
  const window = Math.max(0, Math.min(options.window ?? 1, 2));
  for (let offset = -window; offset <= window; offset += 1) {
    const step = BigInt(center + offset);
    if (step < 0n || (afterStep !== null && step <= afterStep)) continue;
    const expected = generateTotpCode(secret, Number(step) * 30_000);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(normalizedCode))) return step;
  }
  return null;
}

export function encryptMfaSecret(secret: string, userId: string, keys = keyring()) {
  const { id, key } = activeKey(keys);
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`courtly-account-mfa:${envelopeVersion}:${userId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [envelopeVersion, id, iv.toString('base64url'), ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptMfaSecret(envelope: string, userId: string, keys: Pick<AccountSecurityKeyring, 'keys'> = keyring()) {
  try {
    const [version, keyId, ivValue, ciphertextValue, tagValue, ...extra] = envelope.split('.');
    if (version !== envelopeVersion || !keyId || !ivValue || ciphertextValue === undefined || !tagValue || extra.length) {
      throw new AccountSecurityCryptoError();
    }
    const key = keys.keys.get(keyId);
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    if (!key || key.length !== 32 || iv.length !== ivBytes || tag.length !== tagBytes) throw new AccountSecurityCryptoError();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`courtly-account-mfa:${envelopeVersion}:${userId}`, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof AccountSecurityCryptoError) throw error;
    throw new AccountSecurityCryptoError();
  }
}

export function deriveSecurityClaimToken(purpose: 'password-reset' | 'email-change', claimId: string, keyId = keyring().activeKeyId, keys = keyring()) {
  const key = keys.keys.get(keyId);
  if (!key || key.length !== 32 || !/^[A-Za-z0-9_-]{1,200}$/.test(claimId) || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
    throw new AccountSecurityCryptoError();
  }
  return createHmac('sha256', key).update(`courtly-${purpose}:v1:${keyId}:${claimId}`).digest('base64url');
}

export function activeSecurityClaimToken(purpose: 'password-reset' | 'email-change', claimId: string) {
  const { id } = activeKey();
  return { keyId: id, token: deriveSecurityClaimToken(purpose, claimId, id) };
}

export function securityTokenDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function recoveryCodeDigest(userId: string, code: string, keyId = keyring().activeKeyId, keys = keyring()) {
  const key = keys.keys.get(keyId);
  if (!key || key.length !== 32) throw new AccountSecurityCryptoError();
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHmac('sha256', key).update(`courtly-mfa-recovery:v1:${userId}:${normalized}`).digest('hex');
}

export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const value = randomBytes(9).toString('base64url').toUpperCase().replace(/[_-]/g, 'A').slice(0, 12);
    return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
  });
}

export const passwordResetUrl = (token: string) =>
  `${config.publicAppOrigin}/account/reset-password#token=${encodeURIComponent(token)}`;
export const emailChangeUrl = (token: string) =>
  `${config.publicAppOrigin}/account/confirm-email#token=${encodeURIComponent(token)}`;
