import { describe, expect, it } from 'vitest';
import {
  aheadText, eligibleWaitlistPackages, isLiveWaitlistEntry, offerCountdown, sortWaitlistEntries, waitlistOrderNote,
  waitlistStatusText,
} from '../src/lib/waitlist';
import type { AccountPackage, AccountWaitlistEntry } from '../src/lib/types';

const NOW = Date.parse('2026-10-01T04:00:00.000Z');
const minutes = (value: number) => new Date(NOW + value * 60_000).toISOString();

function entry(overrides: Partial<AccountWaitlistEntry> & { startAt?: string } = {}): AccountWaitlistEntry {
  const { startAt, ...rest } = overrides;
  return {
    id: 'w1', status: 'WAITING', aheadCount: 2, offeredAt: null, offerExpiresAt: null, createdAt: '2026-09-30T00:00:00.000Z',
    closedReason: null,
    business: { name: 'Riverside Rackets', slug: 'riverside', ownerName: 'Owner', timezone: 'Asia/Singapore', currency: 'SGD', color: '#174c3c', tagline: '', cancellationHours: 24 },
    booking: {
      id: 'b1', serviceId: 'group-tennis', serviceName: 'Group tennis', instructorId: 'coach', instructorName: 'Jordan Coach',
      locationId: 'loc', locationName: 'Centre Court', startAt: startAt ?? '2026-10-05T10:00:00.000Z', endAt: '2026-10-05T11:00:00.000Z',
      capacity: 6, price: 3000,
    },
    ...rest,
  };
}

function pkg(overrides: Partial<AccountPackage> = {}): AccountPackage {
  return {
    id: 'pkg', businessId: 'biz', offerId: null, name: 'Group ten', totalCredits: 10, usedCredits: 3, remainingCredits: 7,
    price: 25000, expiresAt: '2026-12-31T15:59:59.000Z', paid: true, state: 'ACTIVE',
    business: { name: 'Riverside Rackets', slug: 'riverside', currency: 'SGD' }, offer: null, serviceId: null,
    serviceIds: ['group-tennis'], rentalLocationIds: [], services: [], rentalLocations: [],
    ...overrides,
  };
}

describe('offer countdown', () => {
  it('rounds up to the minute so an open offer never reads as zero', () => {
    expect(offerCountdown(new Date(NOW + 30_000).toISOString(), NOW)).toEqual({ expired: false, urgent: true, text: '1 minute left to confirm' });
    expect(offerCountdown(minutes(45), NOW).text).toBe('45 minutes left to confirm');
  });

  it('switches to hours and days for longer holds', () => {
    expect(offerCountdown(minutes(60), NOW)).toEqual({ expired: false, urgent: true, text: '1 hour left to confirm' });
    expect(offerCountdown(minutes(135), NOW)).toEqual({ expired: false, urgent: false, text: '2 hours 15 minutes left to confirm' });
    expect(offerCountdown(minutes(60 * 49), NOW).text).toBe('2 days left to confirm');
  });

  it('says plainly when the hold has passed or has no deadline', () => {
    expect(offerCountdown(minutes(0), NOW)).toEqual({ expired: true, urgent: false, text: 'This offer has expired' });
    expect(offerCountdown(minutes(-5), NOW).expired).toBe(true);
    expect(offerCountdown(null, NOW)).toEqual({ expired: false, urgent: false, text: 'Confirm soon to keep this place' });
  });
});

describe('ahead-count wording', () => {
  it('states a count, never a promised position', () => {
    expect(aheadText(3)).toBe('3 ahead of you');
    expect(aheadText(1)).toBe('1 ahead of you');
    expect(aheadText(0)).toBe('No one is ahead of you right now');
    expect(aheadText(null)).toBe('Waiting for a place');
    expect(aheadText(-1)).toBe('Waiting for a place');
    expect(waitlistOrderNote).toMatch(/club may also offer a place directly/);
    expect(aheadText(2)).not.toMatch(/next|position|#/i);
  });

  it('labels every status', () => {
    expect(waitlistStatusText('OFFERED')).toBe('Place held for you');
    expect(waitlistStatusText('CLOSED')).toBe('Waitlist closed');
    expect(isLiveWaitlistEntry({ status: 'OFFERED' })).toBe(true);
    expect(isLiveWaitlistEntry({ status: 'EXPIRED' })).toBe(false);
  });
});

describe('waitlist ordering', () => {
  it('puts offers first by deadline, then waiting places by session, then closed entries newest first', () => {
    const sorted = sortWaitlistEntries([
      entry({ id: 'closed-old', status: 'CLOSED', createdAt: '2026-09-01T00:00:00.000Z' }),
      entry({ id: 'waiting-late', startAt: '2026-10-09T10:00:00.000Z' }),
      entry({ id: 'offer-later', status: 'OFFERED', offerExpiresAt: minutes(300) }),
      entry({ id: 'closed-new', status: 'EXPIRED', createdAt: '2026-09-20T00:00:00.000Z' }),
      entry({ id: 'waiting-soon', startAt: '2026-10-03T10:00:00.000Z' }),
      entry({ id: 'offer-soon', status: 'OFFERED', offerExpiresAt: minutes(20) }),
    ]);
    expect(sorted.map(item => item.id)).toEqual(['offer-soon', 'offer-later', 'waiting-soon', 'waiting-late', 'closed-new', 'closed-old']);
  });
});

describe('packages that can confirm an offered place', () => {
  it('accepts only paid, active, same-club packages scoped to the Class with a credit left on the day', () => {
    const offered = entry({ status: 'OFFERED' });
    const packages = [
      pkg({ id: 'ok' }),
      pkg({ id: 'legacy-scope', serviceIds: [], serviceId: 'group-tennis' }),
      pkg({ id: 'other-club', business: { name: 'Shuttle House', slug: 'shuttle', currency: 'SGD' } }),
      pkg({ id: 'other-class', serviceIds: ['private-tennis'] }),
      pkg({ id: 'empty', remainingCredits: 0, state: 'EXHAUSTED' }),
      pkg({ id: 'unpaid', paid: false, state: 'UNPAID' }),
      pkg({ id: 'expires-first', expiresAt: '2026-10-04T00:00:00.000Z' }),
    ];
    expect(eligibleWaitlistPackages(offered, packages).map(item => item.id)).toEqual(['ok', 'legacy-scope']);
  });
});
