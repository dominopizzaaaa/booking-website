import type { AccountPackage, CreditEventKind } from './types';

/** A package is "low" at one credit or fewer and "expiring soon" within two weeks. */
export const LOW_BALANCE_CREDITS = 1;
export const EXPIRING_SOON_DAYS = 14;
const DAY = 86_400_000;

export type PackageWarning = { kind: 'empty' | 'low' | 'expiring'; text: string };

/**
 * Warnings worth a glance on a package card. Unpaid and expired packages are
 * excluded: the first cannot be used yet, and the second already says so in
 * its state badge.
 */
export function packageWarnings(
  pkg: Pick<AccountPackage, 'state' | 'remainingCredits' | 'expiresAt'>,
  now = Date.now(),
): PackageWarning[] {
  if (pkg.state === 'UNPAID' || pkg.state === 'EXPIRED') return [];
  const warnings: PackageWarning[] = [];
  const remaining = Math.max(0, pkg.remainingCredits);
  if (remaining === 0) warnings.push({ kind: 'empty', text: 'No credits left' });
  else if (remaining <= LOW_BALANCE_CREDITS) warnings.push({ kind: 'low', text: remaining === 1 ? '1 credit left' : `${remaining} credits left` });
  const expiresAt = new Date(pkg.expiresAt).getTime();
  const left = expiresAt - now;
  if (remaining > 0 && Number.isFinite(expiresAt) && left > 0 && left <= EXPIRING_SOON_DAYS * DAY) {
    const days = Math.ceil(left / DAY);
    warnings.push({ kind: 'expiring', text: days <= 1 ? 'Expires within a day' : `Expires in ${days} days` });
  }
  return warnings;
}

/** Packages that need attention first, keeping the server's order otherwise. */
export function sortPackagesByAttention<T extends Pick<AccountPackage, 'state' | 'remainingCredits' | 'expiresAt'>>(packages: T[], now = Date.now()) {
  return packages
    .map((pkg, index) => ({ pkg, index, urgent: packageWarnings(pkg, now).length > 0 }))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.index - b.index)
    .map(entry => entry.pkg);
}

export function creditEventLabel(kind: CreditEventKind) {
  switch (kind) {
    case 'OPENING_BALANCE': return 'Opening balance';
    case 'GRANTED': return 'Credits added';
    case 'BOOKED': return 'Used for a Class';
    case 'RESTORED': return 'Credit returned';
    case 'RENTAL_RESERVED': return 'Used for a court rental';
    case 'RENTAL_RESTORED': return 'Rental credit returned';
    case 'ADJUSTED': return 'Adjusted by the club';
    case 'USED': return 'Credit used';
    case 'EXPIRED': return 'Expired unused';
  }
}

/** "+5", "−1" (a true minus sign) or "0". */
export function formatCreditDelta(delta: number) {
  if (!Number.isFinite(delta) || delta === 0) return '0';
  return delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
}

/** What a screen reader hears instead of the bare symbol. */
export function creditDeltaDescription(delta: number) {
  if (!Number.isFinite(delta) || delta === 0) return 'No change to credits';
  const count = Math.abs(delta);
  return `${count} credit${count === 1 ? '' : 's'} ${delta > 0 ? 'added' : 'removed'}`;
}

export function balanceText(balance: number) {
  return `${balance} credit${balance === 1 ? '' : 's'} left`;
}
