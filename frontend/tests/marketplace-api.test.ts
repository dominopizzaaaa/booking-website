import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelRentalReservation,
  checkoutBookingParticipant,
  checkoutPackageOffer,
  createPackageOffer,
  createRentalReservation,
  deletePackageOffer,
  loadAccountPackageOffers,
  loadAccountPackages,
  loadAuthSession,
  loadRental,
  loadRentals,
  loadRentalSlots,
  normalizeAuthSession,
  registerStudentAccount,
  searchAccounts,
  updateAuthAccount,
  updateClubProfile,
  updatePackageOffer,
} from '../src/lib/api';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function respond(body: unknown) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      ok: true, status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
      json: async () => body,
    };
  }));
}

const legacySession = {
  user: { id: 'user-1', name: 'Avery Player', email: 'Avery.Player@example.test', accountType: 'STUDENT' as const },
  membership: null,
  business: null,
  memberships: [],
};

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('account contracts', () => {
  it('normalises old auth responses to a readable username and sports list', async () => {
    expect(normalizeAuthSession(legacySession)).toMatchObject({
      user: { username: 'avery_player', sports: [] },
    });
    respond(legacySession);
    expect((await loadAuthSession()).user).toMatchObject({ username: 'avery_player', sports: [] });
  });

  it('sends username and sports during student registration', async () => {
    respond({ ...legacySession, user: { ...legacySession.user, username: 'avery_player', sports: ['Tennis'] } });
    await registerStudentAccount({
      name: 'Avery Player', username: 'avery_player', sports: ['Tennis'],
      email: 'avery@example.test', password: 'long-password',
    });
    expect(calls[0]).toMatchObject({
      url: '/api/auth/register',
      init: { method: 'POST', body: JSON.stringify({
        name: 'Avery Player', username: 'avery_player', sports: ['Tennis'],
        email: 'avery@example.test', password: 'long-password', accountType: 'STUDENT',
      }) },
    });
  });

  it('updates identity fields and accepts both account-search response forms', async () => {
    respond({ ...legacySession, user: { ...legacySession.user, username: 'avery', sports: ['Padel'] } });
    await updateAuthAccount({ username: 'avery', sports: ['Padel'] });
    expect(calls[0]).toMatchObject({
      url: '/api/auth/me', init: { method: 'PATCH', body: JSON.stringify({ username: 'avery', sports: ['Padel'] }) },
    });

    const account = { name: 'Sam', username: 'sam', accountType: 'COACH', sports: ['Tennis'] };
    respond([account]);
    expect(await searchAccounts('  @sam  ')).toEqual([account]);
    expect(calls[0].url).toBe('/api/accounts/search?q=%40sam');
    respond({ accounts: [account] });
    expect(await searchAccounts('sam')).toEqual([account]);
  });

  it('updates a club and its account profile atomically', async () => {
    const values = {
      name: 'Courtly Club', ownerName: 'Casey Club', email: 'hello@courtly.test', tagline: 'Play well',
      color: '#214e3e', cancellationHours: 24, username: 'courtly_club', sports: ['Tennis'],
    };
    respond({
      ...legacySession,
      user: { ...legacySession.user, accountType: 'CLUB', name: values.name, username: values.username, sports: values.sports },
    });
    await updateClubProfile(values);
    expect(calls[0]).toMatchObject({
      url: '/api/auth/club-profile', init: { method: 'PATCH', body: JSON.stringify(values) },
    });
  });
});

describe('package marketplace requests', () => {
  const offerInput = {
    name: 'Ten plays', description: 'Classes and courts', price: 50_000, totalCredits: 10,
    validityDays: 180, active: true, serviceIds: ['svc/1'], rentalLocationIds: ['loc 1'],
  };

  it('constructs offer CRUD requests and preserves archive results', async () => {
    respond({ id: 'offer-1', ...offerInput });
    await createPackageOffer(offerInput);
    expect(calls[0]).toMatchObject({ url: '/api/package-offers', init: { method: 'POST', body: JSON.stringify(offerInput) } });

    respond({ id: 'offer/1', ...offerInput, active: false });
    await updatePackageOffer('offer/1', { active: false });
    expect(calls[0]).toMatchObject({ url: '/api/package-offers/offer%2F1', init: { method: 'PATCH', body: '{"active":false}' } });

    respond({ deleted: false, archived: true });
    await expect(deletePackageOffer('offer/1')).resolves.toEqual({ deleted: false, archived: true });
    expect(calls[0].url).toBe('/api/package-offers/offer%2F1');
  });

  it('loads student offers/packages and encodes the club slug', async () => {
    respond({ business: { name: 'Ace', slug: 'ace club', currency: 'SGD' }, offers: [] });
    await loadAccountPackageOffers('ace club');
    expect(calls[0].url).toBe('/api/account/package-offers?businessSlug=ace+club');
    respond({ packages: [] });
    await expect(loadAccountPackages()).resolves.toEqual({ packages: [] });
    expect(calls[0].url).toBe('/api/account/packages');
  });

  it('uses the same idempotent checkout contract for packages and classes', async () => {
    const values = { idempotencyKey: 'checkout-key', simulatedOutcome: 'SUCCEEDED' as const };
    const result = { paymentIntent: { id: 'pi-1', amount: 1000, currency: 'SGD', status: 'SUCCEEDED', createdAt: '2026-01-01' }, package: null, participant: null };
    respond(result);
    await checkoutPackageOffer('offer/1', values);
    expect(calls[0]).toMatchObject({ url: '/api/account/package-offers/offer%2F1/checkout', init: { method: 'POST', body: JSON.stringify(values) } });
    respond(result);
    await checkoutBookingParticipant('part 1', values);
    expect(calls[0]).toMatchObject({ url: '/api/account/bookings/part%201/checkout', init: { method: 'POST', body: JSON.stringify(values) } });
  });
});

describe('rental marketplace requests', () => {
  it('omits missing filters and encodes provided filters', async () => {
    respond({ rentals: [], nextCursor: null });
    await loadRentals();
    expect(calls[0].url).toBe('/api/rentals');
    respond({ rentals: [], nextCursor: 'next' });
    await loadRentals({ query: 'East side', sport: 'Table tennis', cursor: 'page/2' });
    expect(calls[0].url).toBe('/api/rentals?query=East+side&sport=Table+tennis&cursor=page%2F2');
  });

  it('unwraps rental detail and constructs slot queries', async () => {
    const rental = { id: 'r/1', name: 'Court One' };
    respond({ rental });
    await expect(loadRental('r/1')).resolves.toEqual(rental);
    expect(calls[0].url).toBe('/api/rentals/r%2F1');
    respond({ date: '2026-10-01', duration: 90, timezone: 'Asia/Singapore', slots: [] });
    await loadRentalSlots('r/1', { date: '2026-10-01', duration: 90 });
    expect(calls[0].url).toBe('/api/rentals/r%2F1/slots?date=2026-10-01&duration=90');
  });

  it('keeps package selection in reservation requests and sends an empty cancellation body', async () => {
    const values = { unitId: 'unit-1', startAt: '2026-10-01T10:00:00Z', duration: 60, idempotencyKey: 'rental-key', simulatedOutcome: 'SUCCEEDED' as const, packageId: 'pkg/1' };
    respond({ reservation: { id: 'res-1' }, paymentIntent: { id: 'pi-1' } });
    await createRentalReservation('rental/1', values);
    expect(calls[0]).toMatchObject({ url: '/api/rentals/rental%2F1/reservations', init: { method: 'POST', body: JSON.stringify(values) } });
    respond({ reservation: { id: 'res/1' } });
    await cancelRentalReservation('res/1');
    expect(calls[0]).toMatchObject({ url: '/api/rentals/reservations/res%2F1/cancel', init: { method: 'POST', body: '{}' } });
  });
});
