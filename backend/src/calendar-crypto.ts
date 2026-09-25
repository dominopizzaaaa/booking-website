import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config, type CalendarTokenKey } from './config.js';

const envelopeVersion = 'v1';
const ivBytes = 12;
const tagBytes = 16;

export class CalendarCryptoError extends Error {
  constructor(message = 'Calendar credential could not be decrypted') {
    super(message);
    this.name = 'CalendarCryptoError';
  }
}

type Keyring = { activeKeyId: string; keys: ReadonlyMap<string, Buffer> };

function activeKey(keyring: Keyring): CalendarTokenKey {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key || key.length !== 32) throw new CalendarCryptoError('Calendar token encryption is not configured');
  return { id: keyring.activeKeyId, key };
}

function encoded(value: Buffer) {
  return value.toString('base64url');
}

function decoded(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new CalendarCryptoError();
  return Buffer.from(value, 'base64url');
}

/**
 * Encrypt a token or PKCE verifier. AAD must identify both its owning row and
 * purpose, preventing a valid ciphertext from being moved to another column.
 */
export function encryptCalendarSecret(
  plaintext: string,
  aad: string,
  keyring: Keyring = config.googleCalendar,
) {
  if (!plaintext || !aad) throw new CalendarCryptoError('Calendar credential is empty');
  const { id, key } = activeKey(keyring);
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagBytes });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [envelopeVersion, id, encoded(iv), encoded(ciphertext), encoded(cipher.getAuthTag())].join('.');
}

export function decryptCalendarSecret(
  envelope: string,
  aad: string,
  keyring: Pick<Keyring, 'keys'> = config.googleCalendar,
) {
  try {
    const [version, keyId, encodedIv, encodedCiphertext, encodedTag, ...rest] = envelope.split('.');
    if (version !== envelopeVersion || !keyId || !encodedIv || encodedCiphertext === undefined
      || !encodedTag || rest.length) throw new CalendarCryptoError();
    const key = keyring.keys.get(keyId);
    const iv = decoded(encodedIv);
    const ciphertext = decoded(encodedCiphertext);
    const tag = decoded(encodedTag);
    if (!key || key.length !== 32 || iv.length !== ivBytes || tag.length !== tagBytes || !aad) {
      throw new CalendarCryptoError();
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: tagBytes });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof CalendarCryptoError) throw error;
    throw new CalendarCryptoError();
  }
}

export const calendarSecretAad = (
  ownerType: 'connection' | 'oauth-attempt' | 'revocation-job',
  ownerId: string,
  field: string,
) =>
  `courtly-calendar:${envelopeVersion}:${ownerType}:${ownerId}:${field}`;
