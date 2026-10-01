import { describe, expect, it } from 'vitest';
import {
  balanceText, creditDeltaDescription, creditEventLabel, EXPIRING_SOON_DAYS, formatCreditDelta, LOW_BALANCE_CREDITS,
  packageWarnings, sortPackagesByAttention,
} from '../src/lib/package-insights';
import type { AccountPackage, CreditEventKind } from '../src/lib/types';

const NOW = Date.parse('2026-10-01T04:00:00.000Z');
const days = (value: number) => new Date(NOW + value * 86_400_000).toISOString();

function pkg(overrides: Partial<Pick<AccountPackage, 'state' | 'remainingCredits' | 'expiresAt'>> = {}) {
  return { state: 'ACTIVE' as AccountPackage['state'], remainingCredits: 5, expiresAt: days(60), ...overrides };
}

describe('package warnings', () => {
  it('uses the documented thresholds', () => {
    expect(LOW_BALANCE_CREDITS).toBe(1);
    expect(EXPIRING_SOON_DAYS).toBe(14);
  });

  it('warns at one credit or none, but not at two', () => {
    expect(packageWarnings(pkg({ remainingCredits: 2 }), NOW)).toEqual([]);
    expect(packageWarnings(pkg({ remainingCredits: 1 }), NOW)).toEqual([{ kind: 'low', text: '1 credit left' }]);
    expect(packageWarnings(pkg({ remainingCredits: 0, state: 'EXHAUSTED' }), NOW)).toEqual([{ kind: 'empty', text: 'No credits left' }]);
  });

  it('warns about expiry within 14 days only while credits remain', () => {
    expect(packageWarnings(pkg({ expiresAt: days(15) }), NOW)).toEqual([]);
    expect(packageWarnings(pkg({ expiresAt: days(14) }), NOW)).toEqual([{ kind: 'expiring', text: 'Expires in 14 days' }]);
    expect(packageWarnings(pkg({ expiresAt: days(0.5) }), NOW)).toEqual([{ kind: 'expiring', text: 'Expires within a day' }]);
    expect(packageWarnings(pkg({ expiresAt: days(3), remainingCredits: 0, state: 'EXHAUSTED' }), NOW)).toEqual([{ kind: 'empty', text: 'No credits left' }]);
  });

  it('combines low balance and expiry', () => {
    expect(packageWarnings(pkg({ remainingCredits: 1, expiresAt: days(2) }), NOW).map(warning => warning.kind)).toEqual(['low', 'expiring']);
  });

  it('stays quiet for expired and unpaid packages, whose badge already explains them', () => {
    expect(packageWarnings(pkg({ state: 'EXPIRED', remainingCredits: 1, expiresAt: days(-1) }), NOW)).toEqual([]);
    expect(packageWarnings(pkg({ state: 'UNPAID', remainingCredits: 1 }), NOW)).toEqual([]);
  });

  it('brings packages needing attention to the front without reordering the rest', () => {
    const list = [
      { id: 'a', ...pkg() }, { id: 'b', ...pkg({ remainingCredits: 1 }) }, { id: 'c', ...pkg() }, { id: 'd', ...pkg({ expiresAt: days(3) }) },
    ];
    expect(sortPackagesByAttention(list, NOW).map(item => item.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('credit ledger wording', () => {
  it('signs deltas with a true minus sign', () => {
    expect(formatCreditDelta(5)).toBe('+5');
    expect(formatCreditDelta(-1)).toBe('−1');
    expect(formatCreditDelta(0)).toBe('0');
  });

  it('describes deltas for screen readers', () => {
    expect(creditDeltaDescription(1)).toBe('1 credit added');
    expect(creditDeltaDescription(-3)).toBe('3 credits removed');
    expect(creditDeltaDescription(0)).toBe('No change to credits');
    expect(balanceText(1)).toBe('1 credit left');
    expect(balanceText(4)).toBe('4 credits left');
  });

  it('labels every ledger kind, including the synthetic expiry', () => {
    const kinds: CreditEventKind[] = ['OPENING_BALANCE', 'GRANTED', 'BOOKED', 'RESTORED', 'RENTAL_RESERVED', 'RENTAL_RESTORED', 'ADJUSTED', 'USED', 'EXPIRED'];
    const labels = kinds.map(creditEventLabel);
    expect(labels.every(label => typeof label === 'string' && label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(kinds.length);
    expect(creditEventLabel('EXPIRED')).toBe('Expired unused');
  });
});
