import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { CalendarCryptoError, decryptCalendarSecret, encryptCalendarSecret } from '../src/calendar-crypto.js';
import { googleProviderEventId } from '../src/google-calendar.js';

const keys = new Map([
  ['old', Buffer.alloc(32, 3)],
  ['current', Buffer.alloc(32, 7)],
]);

describe('Calendar credential encryption', () => {
  it('round trips an AES-256-GCM envelope without exposing plaintext', () => {
    const envelope = encryptCalendarSecret('refresh-token-value', 'connection:a:refresh', {
      activeKeyId: 'current', keys,
    });
    expect(envelope).toMatch(/^v1.current./);
    expect(envelope).not.toContain('refresh-token-value');
    expect(decryptCalendarSecret(envelope, 'connection:a:refresh', { keys })).toBe('refresh-token-value');
  });

  it('authenticates owner and purpose through AAD', () => {
    const envelope = encryptCalendarSecret('secret', 'connection:a:access', {
      activeKeyId: 'current', keys,
    });
    expect(() => decryptCalendarSecret(envelope, 'connection:b:access', { keys })).toThrow(CalendarCryptoError);
    expect(() => decryptCalendarSecret(envelope, 'connection:a:refresh', { keys })).toThrow(CalendarCryptoError);
  });

  it('decrypts an old-key envelope while new writes use the active key', () => {
    const oldEnvelope = encryptCalendarSecret('old-secret', 'aad', { activeKeyId: 'old', keys });
    const newEnvelope = encryptCalendarSecret('new-secret', 'aad', { activeKeyId: 'current', keys });
    expect(oldEnvelope).toMatch(/^v1.old./);
    expect(newEnvelope).toMatch(/^v1.current./);
    expect(decryptCalendarSecret(oldEnvelope, 'aad', { keys })).toBe('old-secret');
  });

  it('rejects malformed and tampered envelopes', () => {
    const envelope = encryptCalendarSecret('secret', 'aad', { activeKeyId: 'current', keys });
    const parts = envelope.split('.');
    parts[3] = `${parts[3]!.startsWith('a') ? 'b' : 'a'}${parts[3]!.slice(1)}`;
    const tampered = parts.join('.');
    expect(() => decryptCalendarSecret('v2.current.bad.bad.bad', 'aad', { keys })).toThrow(CalendarCryptoError);
    expect(() => decryptCalendarSecret(tampered, 'aad', { keys })).toThrow(CalendarCryptoError);
  });
});

describe('Google provider event identity', () => {
  it('is deterministic, per connection, and valid for Google event IDs', () => {
    const first = googleProviderEventId('connection-a', 'booking-a');
    expect(first).toBe(googleProviderEventId('connection-a', 'booking-a'));
    expect(first).not.toBe(googleProviderEventId('connection-b', 'booking-a'));
    expect(first).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});
