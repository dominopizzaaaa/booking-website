import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptMfaSecret, deriveSecurityClaimToken, encryptMfaSecret, recoveryCodeDigest,
  securityTokenDigest, verifyTotp,
} from '../src/account-security-crypto.js';

const keyring = { enabled: true, activeKeyId: 'test-v1', keys: new Map([['test-v1', Buffer.alloc(32, 37)]]) };

function rfcCode(secret: Buffer, seconds: number) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

describe('account security cryptography', () => {
  it.each([59, 1_111_111_109, 1_111_111_111, 1_234_567_890, 2_000_000_000])
  ('verifies RFC 6238 SHA-1 counters at %s seconds', seconds => {
    // RFC 6238's base32 seed is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const expected = rfcCode(Buffer.from('12345678901234567890'), seconds);
    expect(verifyTotp(secret, expected, { now: seconds * 1000, window: 0 })).toBe(BigInt(Math.floor(seconds / 30)));
  });

  it('accepts a bounded clock window and rejects reused counters', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const code = rfcCode(Buffer.from('12345678901234567890'), 90);
    expect(verifyTotp(secret, code, { now: 120_000, window: 1 })).toBe(3n);
    expect(verifyTotp(secret, code, { now: 120_000, window: 1, afterStep: 3n })).toBeNull();
    expect(verifyTotp(secret, '12345x', { now: 120_000 })).toBeNull();
  });

  it('binds encrypted MFA secrets to their user and detects tampering', () => {
    const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP', 'user-one', keyring);
    expect(encrypted).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptMfaSecret(encrypted, 'user-one', keyring)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptMfaSecret(encrypted, 'user-two', keyring)).toThrow();
    const parts = encrypted.split('.');
    parts[3] = `${parts[3]![0] === 'A' ? 'B' : 'A'}${parts[3]!.slice(1)}`;
    expect(() => decryptMfaSecret(parts.join('.'), 'user-one', keyring)).toThrow();
  });

  it('domain-separates claim tokens and keyed recovery-code hashes', () => {
    const reset = deriveSecurityClaimToken('password-reset', 'claim-1', 'test-v1', keyring);
    const email = deriveSecurityClaimToken('email-change', 'claim-1', 'test-v1', keyring);
    expect(reset).not.toBe(email);
    expect(securityTokenDigest(reset)).toMatch(/^[a-f0-9]{64}$/);
    expect(recoveryCodeDigest('user-one', 'ABCD-EFGH-IJKL', 'test-v1', keyring))
      .toBe(recoveryCodeDigest('user-one', 'abcdefghijkl', 'test-v1', keyring));
    expect(recoveryCodeDigest('user-one', 'ABCD-EFGH-IJKL', 'test-v1', keyring))
      .not.toBe(recoveryCodeDigest('user-two', 'ABCD-EFGH-IJKL', 'test-v1', keyring));
  });
});
