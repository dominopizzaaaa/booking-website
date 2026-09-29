import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FamilyHandoverTokenError,
  deriveFamilyHandoverToken,
  familyHandoverTokenDigest,
} from '../src/family-handover-token.js';

describe('family handover token derivation', () => {
  const current = Buffer.alloc(32, 7);
  const previous = Buffer.alloc(32, 11);
  const keyring = { keys: new Map([['current', current], ['previous', previous]]) };

  it('is deterministic, URL-safe, and bound to the handover ID and key version', () => {
    const first = deriveFamilyHandoverToken('handover-a', 'current', keyring);
    expect(first).toBe(deriveFamilyHandoverToken('handover-a', 'current', keyring));
    expect(first).not.toBe(deriveFamilyHandoverToken('handover-b', 'current', keyring));
    expect(first).not.toBe(deriveFamilyHandoverToken('handover-a', 'previous', keyring));
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(familyHandoverTokenDigest(first)).toBe(createHash('sha256').update(first).digest('hex'));
  });

  it('supports retained rotation keys and fails closed when a referenced key is gone', () => {
    expect(deriveFamilyHandoverToken('handover-old', 'previous', keyring)).toHaveLength(43);
    expect(() => deriveFamilyHandoverToken('handover-old', 'missing', keyring))
      .toThrow(FamilyHandoverTokenError);
  });
});
