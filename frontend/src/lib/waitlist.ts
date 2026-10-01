import type { AccountPackage, AccountWaitlistEntry, WaitlistStatus } from './types';

export const waitlistOrderNote =
  'Places are usually offered in waitlist order, but the club may also offer a place directly.';

function plural(value: number, unit: string) {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/**
 * Wording for the time left on a held place. It rounds up to the minute so a
 * learner is never told "0 minutes" while the offer is still open, and it
 * says plainly when the hold has passed rather than leaving a stale number.
 */
export function offerCountdown(expiresAt: string | null | undefined, now = Date.now()) {
  const deadline = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  if (!Number.isFinite(deadline)) return { expired: false, urgent: false, text: 'Confirm soon to keep this place' };
  const ms = deadline - now;
  if (ms <= 0) return { expired: true, urgent: false, text: 'This offer has expired' };
  const minutes = Math.ceil(ms / 60_000);
  const urgent = ms <= 60 * 60_000;
  if (minutes < 60) return { expired: false, urgent, text: `${plural(minutes, 'minute')} left to confirm` };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return { expired: false, urgent, text: `${plural(hours, 'hour')}${rest ? ` ${plural(rest, 'minute')}` : ''} left to confirm` };
  }
  return { expired: false, urgent, text: `${plural(Math.floor(hours / 24), 'day')} left to confirm` };
}

/** "N ahead of you" — a count, never a promised position. */
export function aheadText(aheadCount: number | null | undefined) {
  if (aheadCount === null || aheadCount === undefined || !Number.isFinite(aheadCount) || aheadCount < 0) {
    return 'Waiting for a place';
  }
  if (aheadCount === 0) return 'No one is ahead of you right now';
  return `${aheadCount} ahead of you`;
}

export function waitlistStatusText(status: WaitlistStatus) {
  switch (status) {
    case 'WAITING': return 'On the waitlist';
    case 'OFFERED': return 'Place held for you';
    case 'ACCEPTED': return 'Booked';
    case 'DECLINED': return 'You declined the place';
    case 'EXPIRED': return 'Offer expired';
    case 'WITHDRAWN': return 'You left the waitlist';
    case 'REMOVED': return 'Removed by the club';
    case 'CLOSED': return 'Waitlist closed';
  }
}

export function isLiveWaitlistEntry(entry: Pick<AccountWaitlistEntry, 'status'>) {
  return entry.status === 'WAITING' || entry.status === 'OFFERED';
}

/**
 * Offers first (soonest deadline first) because they expire, then places
 * still waiting in session order, then recently closed entries newest first.
 */
export function sortWaitlistEntries<T extends Pick<AccountWaitlistEntry, 'status' | 'offerExpiresAt' | 'createdAt' | 'booking'>>(entries: T[]) {
  const rank = (entry: T) => entry.status === 'OFFERED' ? 0 : entry.status === 'WAITING' ? 1 : 2;
  const time = (value: string | null | undefined) => {
    const parsed = value ? new Date(value).getTime() : Number.NaN;
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  };
  return [...entries].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank) return byRank;
    if (a.status === 'OFFERED') return time(a.offerExpiresAt) - time(b.offerExpiresAt);
    if (a.status === 'WAITING') return time(a.booking.startAt) - time(b.booking.startAt);
    return time(b.createdAt) - time(a.createdAt);
  });
}

/**
 * Packages that could pay for an offered place: paid, active, from the same
 * club, scoped to the Class, still holding a credit, and valid on the day.
 * The server re-checks all of this when the place is confirmed.
 */
export function eligibleWaitlistPackages(entry: Pick<AccountWaitlistEntry, 'business' | 'booking'>, packages: AccountPackage[]) {
  const startsAt = new Date(entry.booking.startAt).getTime();
  return packages.filter(pkg =>
    pkg.state === 'ACTIVE'
    && pkg.paid
    && pkg.remainingCredits > 0
    && pkg.business.slug === entry.business.slug
    && ((pkg.serviceIds ?? []).includes(entry.booking.serviceId) || pkg.serviceId === entry.booking.serviceId)
    && (!Number.isFinite(startsAt) || new Date(pkg.expiresAt).getTime() >= startsAt));
}
