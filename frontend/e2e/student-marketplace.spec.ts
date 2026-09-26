import { expect, test, type Page } from '@playwright/test';
import type { AccountBooking, AccountPackage, AuthSession, RentalDetail, RentalListing, RentalReservation } from '../src/lib/types';

const business = {
  name: 'Riverside Rackets',
  slug: 'riverside-rackets',
  ownerName: 'Riverside team',
  timezone: 'Asia/Singapore',
  currency: 'SGD',
  color: '#174c3c',
  tagline: 'Tennis and pickleball by the river.',
  cancellationHours: 24,
  kind: 'CLUB' as const,
};

const session = {
  user: {
    id: 'student-marketplace-user', name: 'Avery Student', username: 'avery',
    email: 'avery@example.test', accountType: 'STUDENT' as const, sports: ['Tennis'],
  },
  membership: null, business: null, memberships: [],
} satisfies AuthSession;

const unpaidBooking = {
  business,
  booking: {
    id: 'booking-unpaid', serviceId: 'service-tennis', serviceName: 'Private tennis',
    instructorId: 'coach-1', instructorName: 'Jordan Coach', locationId: 'location-club',
    locationName: 'Riverside Centre', locationColor: '#174c3c',
    startAt: '2099-09-26T02:00:00.000Z', endAt: '2099-09-26T03:00:00.000Z',
    status: 'CONFIRMED' as const, type: 'PRIVATE' as const, capacity: 1, price: 8_000,
    paymentRoute: 'CLUB' as const, coachAcceptance: 'NOT_REQUIRED' as const,
    createdByRole: 'STUDENT' as const, address: '1 Club Lane', recurringId: null, participants: [],
  },
  participant: {
    id: 'participant-unpaid', studentId: 'student-1', name: 'Avery Student', email: 'avery@example.test',
    attendance: 'UNMARKED' as const, paid: false, price: 8_000, packageId: null, notes: '',
  },
  canCancel: true, canReschedule: true, paymentRoute: 'CLUB' as const,
} satisfies AccountBooking;

const rentals: RentalListing[] = [
  {
    id: 'rental-tennis', locationId: 'location-tennis', name: 'Garden Tennis Courts',
    address: '10 Green Way', sport: 'Tennis', amenities: ['Lights'], unitLabel: 'Court',
    price: 2_500, currency: 'SGD', timezone: 'Asia/Singapore', club: { name: business.name, slug: business.slug },
  },
  {
    id: 'rental-pickleball', locationId: 'location-pickleball', name: 'River Pickleball Hall',
    address: '22 River Road', sport: 'Pickleball', amenities: ['Showers', 'Equipment hire'], unitLabel: 'Court',
    price: 3_000, currency: 'SGD', timezone: 'Asia/Singapore', club: { name: business.name, slug: business.slug },
  },
];

const rentalDetail: RentalDetail = {
  ...rentals[1], enabled: true, minDuration: 60, maxDuration: 120, startInterval: 30,
  durationIncrement: 30, noticeHours: 2, advanceDays: 30, cancellationHours: 12,
  rules: 'Non-marking shoes only.', units: [{ id: 'court-1', name: 'Court 1', active: true }],
  openingHours: [{ dayOfWeek: 5, startTime: '08:00', endTime: '22:00' }],
};

const packageRentalReservation: RentalReservation = {
  id: 'student-package-reservation', businessName: business.name, locationId: rentalDetail.locationId, locationName: rentalDetail.name,
  unitId: 'court-1', unitName: 'Court 1', startAt: '2099-09-26T10:00:00.000Z', endAt: '2099-09-26T11:00:00.000Z',
  duration: 60, price: 3_000, status: 'CONFIRMED', paymentStatus: 'PACKAGE', packageId: 'package-1',
  creditConsumed: true, currency: 'SGD', timezone: 'Asia/Singapore',
  cancellationDeadline: '2099-09-25T22:00:00.000Z', cancellable: true,
};

const purchasedPackage: AccountPackage = {
  id: 'package-1', businessId: 'business-1', offerId: 'offer-1', name: 'Flexible five',
  totalCredits: 5, usedCredits: 1, remainingCredits: 4, price: 20_000,
  expiresAt: '2099-12-31T15:59:59.000Z', paid: true, state: 'ACTIVE',
  business: { name: business.name, slug: business.slug, currency: 'SGD' },
  offer: { id: 'offer-1', name: 'Flexible five' }, serviceId: null,
  serviceIds: ['service-tennis'], rentalLocationIds: ['location-pickleball'],
  services: [{ id: 'service-tennis', name: 'Private tennis' }],
  rentalLocations: [{ id: 'location-pickleball', name: 'River Pickleball Hall' }],
};

async function mockMarketplace(page: Page, options: {
  bookings?: AccountBooking[]; initialPackages?: AccountPackage[]; rentalReplayRefundedAfterLostResponse?: boolean;
  initialReservations?: RentalReservation[]; emptyClubDirectory?: boolean; freeRental?: boolean;
} = {}) {
  let packages = [...(options.initialPackages ?? [])];
  let bookings = [...(options.bookings ?? [])];
  let rentalRequest: Record<string, unknown> | null = null;
  const rentalRequests: Record<string, unknown>[] = [];
  let bookingPaymentRequest: Record<string, unknown> | null = null;
  let rentalConfirmed = false;
  let reservations = [...(options.initialReservations ?? [])];
  let packageLoads = 0;

  await page.route('**/api/auth/me', async route => {
    if (route.request().method() === 'PATCH') {
      const update = route.request().postDataJSON() as Partial<AuthSession['user']>;
      await route.fulfill({ json: { ...session, user: { ...session.user, ...update } } });
      return;
    }
    await route.fulfill({ json: session });
  });
  await page.route('**/api/account/profile', async route => {
    const update = route.request().postDataJSON() as Partial<AuthSession['user']>;
    await route.fulfill({ json: { ...session, user: { ...session.user, ...update } } });
  });
  await page.route(/\/api\/account\/bookings(?:\?.*)?$/, route => route.fulfill({ json: { bookings } }));
  await page.route(/\/api\/account\/clubs(?:\?.*)?$/, route => route.fulfill({ json: { clubs: options.emptyClubDirectory ? [] : [{ business, sports: ['Tennis', 'Pickleball'], serviceCount: 2, coachCount: 2, locationCount: 2, priceFrom: 5_000 }] } }));
  await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/account/packages', route => { packageLoads += 1; return route.fulfill({ json: { packages } }); });
  await page.route(/\/api\/account\/package-offers(?:\?.*)?$/, route => route.fulfill({ json: {
    business: { name: business.name, slug: business.slug, currency: business.currency },
    offers: [{
      id: 'offer-1', businessId: 'business-1', name: 'Flexible five', description: 'Five credits for classes or courts.',
      price: 20_000, totalCredits: 5, validityDays: 90, active: true, archivedAt: null,
      createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
      business: { name: business.name, slug: business.slug, currency: business.currency },
      serviceIds: ['service-tennis'], rentalLocationIds: ['location-pickleball'],
      services: [{ id: 'service-tennis', name: 'Private tennis' }],
      rentalLocations: [{ id: 'location-pickleball', name: 'River Pickleball Hall' }],
    }],
  } }));
  await page.route('**/api/account/package-offers/offer-1/checkout', async route => {
    packages = [purchasedPackage];
    await route.fulfill({ status: 201, json: { paymentIntent: { id: 'pi-package', amount: 20_000, currency: 'SGD', status: 'SUCCEEDED', provider: 'SIMULATED_STRIPE', providerReference: 'sim-package', createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), failedAt: null }, package: purchasedPackage, participant: null } });
  });
  await page.route('**/api/account/bookings/participant-unpaid/checkout', async route => {
    bookingPaymentRequest = route.request().postDataJSON();
    bookings = [{ ...unpaidBooking, participant: { ...unpaidBooking.participant, paid: true } }];
    await route.fulfill({ status: 201, json: { paymentIntent: { id: 'pi-booking', amount: 8_000, currency: 'SGD', status: 'SUCCEEDED', provider: 'SIMULATED_STRIPE', providerReference: 'sim-booking', createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), failedAt: null }, package: null, participant: { id: 'participant-unpaid', bookingId: 'booking-unpaid', paid: true } } });
  });
  await page.route(/\/api\/rentals(?:\?.*)?$/, route => route.fulfill({ json: { rentals, nextCursor: null } }));
  await page.route(/\/api\/rentals\/rental-pickleball$/, route => route.fulfill({ json: { rental: options.freeRental ? { ...rentalDetail, price: 0 } : rentalDetail } }));
  await page.route(/\/api\/rentals\/rental-pickleball\/slots(?:\?.*)?$/, route => route.fulfill({ json: {
    date: '2099-09-26', duration: 60, timezone: 'Asia/Singapore',
    slots: rentalConfirmed ? [] : [{ unitId: 'court-1', unitName: 'Court 1', startAt: '2099-09-26T10:00:00.000Z', endAt: '2099-09-26T11:00:00.000Z', price: options.freeRental ? 0 : 3_000 }],
  } }));
  await page.route('**/api/rentals/rental-pickleball/reservations', async route => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    rentalRequest = request;
    rentalRequests.push(request);
    if (options.rentalReplayRefundedAfterLostResponse && rentalRequests.length === 1) {
      await route.abort('failed');
      return;
    }
    if (options.rentalReplayRefundedAfterLostResponse && rentalRequests.length === 2) {
      await route.fulfill({ status: 200, json: {
        reservation: { id: 'reservation-cancelled', businessName: business.name, locationId: rentalDetail.locationId, locationName: rentalDetail.name, unitId: 'court-1', unitName: 'Court 1', startAt: '2099-09-26T10:00:00.000Z', endAt: '2099-09-26T11:00:00.000Z', duration: 60, price: 3_000, status: 'CANCELLED', paymentStatus: 'REFUNDED', packageId: null, creditConsumed: false, currency: 'SGD', timezone: 'Asia/Singapore', cancellationDeadline: '2099-09-25T22:00:00.000Z', cancellable: false },
        paymentIntent: { id: 'pi-rental-refunded', amount: 3_000, currency: 'SGD', status: 'REFUNDED', provider: 'SIMULATED_STRIPE', providerReference: 'sim-rental-refunded', createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), failedAt: null },
      } });
      return;
    }
    rentalConfirmed = true;
    const confirmedReservation: RentalReservation = {
      id: 'reservation-1', businessName: business.name, locationId: rentalDetail.locationId, locationName: rentalDetail.name, unitId: 'court-1', unitName: 'Court 1', startAt: '2099-09-26T10:00:00.000Z', endAt: '2099-09-26T11:00:00.000Z', duration: 60, price: options.freeRental ? 0 : 3_000, status: 'CONFIRMED', paymentStatus: 'PAID', packageId: null, creditConsumed: false, currency: 'SGD', timezone: 'Asia/Singapore', cancellationDeadline: '2099-09-25T22:00:00.000Z', cancellable: true,
    };
    reservations = [confirmedReservation, ...reservations.filter(item => item.id !== confirmedReservation.id)];
    await route.fulfill({ status: 201, json: {
      reservation: confirmedReservation,
      paymentIntent: { id: 'pi-rental', amount: options.freeRental ? 0 : 3_000, currency: 'SGD', status: 'SUCCEEDED', provider: options.freeRental ? 'FREE' : 'SIMULATED_STRIPE', providerReference: 'sim-rental', createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), failedAt: null },
    } });
  });
  await page.route('**/api/rentals/reservations/mine', route => route.fulfill({ json: { reservations } }));
  await page.route(/\/api\/rentals\/reservations\/[^/]+\/cancel$/, route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const current = reservations.find(item => item.id === id);
    if (!current) return route.fulfill({ status: 404, json: { error: 'Rental reservation not found' } });
    const cancelled = { ...current, status: 'CANCELLED' as const, paymentStatus: 'REFUNDED' as const, creditConsumed: false, cancellable: false };
    reservations = reservations.map(item => item.id === id ? cancelled : item);
    if (current.packageId) packages = packages.map(item => item.id === current.packageId
      ? { ...item, usedCredits: Math.max(0, item.usedCredits - 1), remainingCredits: item.remainingCredits + 1 }
      : item);
    return route.fulfill({ json: { reservation: cancelled } });
  });
  await page.route(/\/api\/accounts\/search(?:\?.*)?$/, route => route.fulfill({ json: [{ name: 'Jamie Coach', username: 'jamie_coach', accountType: 'COACH', sports: ['Tennis'] }] }));
  await page.route('**/api/calendar/connection', route => route.fulfill({ json: { configured: false, eligible: true } }));

  return { rentalRequest: () => rentalRequest, rentalRequests: () => rentalRequests, bookingPaymentRequest: () => bookingPaymentRequest, packageLoads: () => packageLoads };
}

test('student can search accounts, buy an offer, and see package eligibility', async ({ page }) => {
  await mockMarketplace(page);
  await page.goto('/manage?tab=explore');

  const navigation = page.getByRole('navigation', { name: 'Student navigation' });
  await expect(navigation.getByRole('button')).toHaveCount(5);
  for (const tab of ['Home', 'Explore', 'Book', 'Chat', 'Profile']) {
    await expect(navigation.getByRole('button', { name: tab, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('tab', { name: 'Classes/clubs' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Classes/clubs' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Venue rentals' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Venue rentals' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Classes/clubs' })).toBeFocused();

  await page.getByLabel('Search all Courtly accounts').fill('jamie');
  await page.getByRole('button', { name: 'Search people' }).click();
  const searchResults = page.getByRole('list', { name: 'Account search results' });
  await expect(searchResults).toContainText('Jamie Coach');
  await expect(searchResults).toContainText('@jamie_coach · coach');
  await expect(searchResults).toContainText('Tennis');
  await expect(searchResults).not.toContainText('jamie@example.test');

  await page.getByRole('button', { name: `View ${business.name} package offers` }).click();
  const offersDialog = page.getByRole('dialog');
  await expect(offersDialog.getByRole('heading', { name: `Packages from ${business.name}` })).toBeVisible();
  await expect(offersDialog).toContainText('Five credits for classes or courts.');
  await expect(offersDialog).toContainText('Private tennis, River Pickleball Hall');
  await offersDialog.getByRole('button', { name: 'Buy with simulated Stripe' }).click();
  await expect(offersDialog.getByRole('status')).toContainText('no real card was charged');
  await offersDialog.getByRole('button', { name: 'Close dialog' }).click();

  await navigation.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'View My Packages' }).click();
  const packages = page.locator('#student-package-list');
  await expect(packages).toContainText('Flexible five');
  await expect(packages).toContainText('4 / 5');
  await expect(packages).toContainText('Private tennis');
  await expect(packages).toContainText('River Pickleball Hall');
  await expect(packages.getByRole('link', { name: 'Book an eligible class' })).toHaveAttribute('href', `/book/${business.slug}?packageId=${purchasedPackage.id}`);
  await packages.getByRole('button', { name: 'Find an eligible rental' }).click();
  await expect(page.getByRole('tab', { name: 'Venue rentals' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'River Pickleball Hall' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Garden Tennis Courts' })).toBeHidden();
});

test('student filters rentals and completes a clearly simulated reservation', async ({ page }) => {
  await page.clock.install({ time: new Date('2099-08-27T00:00:00.000Z') });
  const state = await mockMarketplace(page);
  await page.goto('/manage?tab=explore');
  await page.getByRole('tab', { name: 'Venue rentals' }).click();

  await page.getByLabel('Sport', { exact: true }).selectOption('pickleball');
  await expect(page.getByRole('heading', { name: 'River Pickleball Hall' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Garden Tennis Courts' })).toBeHidden();
  await page.getByLabel('Search rentals').fill('equipment');
  await expect(page.getByRole('status').filter({ hasText: '1 rental found' })).toBeVisible();

  await page.getByRole('button', { name: 'View times' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'River Pickleball Hall' })).toBeVisible();
  await expect(dialog.getByLabel('Date', { exact: true })).toHaveAttribute('max', '2099-09-26');
  await expect(dialog.getByText('Demo checkout only')).toHaveCount(0);
  await dialog.getByRole('button', { name: '6:00 PM' }).click();
  await expect(dialog.getByText(/Demo checkout only/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Reserve with simulated Stripe' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'no real card was charged' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '6:00 PM' })).toHaveCount(0);
  await expect(dialog).toContainText('No available times for this date and duration.');
  expect(state.rentalRequest()).toMatchObject({
    unitId: 'court-1', startAt: '2099-09-26T10:00:00.000Z', duration: 60, simulatedOutcome: 'SUCCEEDED',
  });
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('region', { name: 'My rental reservations' })).toContainText('Court 1');
});

test('a rental-only club exposes package offers from its rental card', async ({ page }) => {
  await mockMarketplace(page, { emptyClubDirectory: true });
  await page.goto('/manage?tab=explore');
  await page.getByRole('tab', { name: 'Venue rentals' }).click();
  await page.getByRole('button', { name: 'View packages', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: `Packages from ${business.name}` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Flexible five');
  await expect(page.getByRole('heading', { name: 'Your clubs' })).toHaveCount(0);
});

test('a free student rental hides card and package controls and needs no refund', async ({ page }) => {
  await mockMarketplace(page, { freeRental: true });
  await page.goto('/manage?tab=explore');
  await page.getByRole('tab', { name: 'Venue rentals' }).click();
  await page.getByRole('button', { name: 'View times' }).nth(1).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '6:00 PM' }).click();
  await expect(dialog).toContainText('Free');
  await expect(dialog.getByLabel('Payment option')).toHaveCount(0);
  await expect(dialog.getByLabel('Demo payment result')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Reserve for free', exact: true }).click();
  const confirmation = dialog.getByRole('status').filter({ hasText: 'reserved for free' });
  await expect(confirmation).toContainText('reserved for free');
  await expect(confirmation).toContainText('No payment or package credit was needed');
  await expect(dialog).not.toContainText('no real card was charged');
});

test('a cancelled refunded rental replay is not presented as a new reservation', async ({ page }) => {
  const state = await mockMarketplace(page, { rentalReplayRefundedAfterLostResponse: true });
  await page.goto('/manage?tab=explore');
  await page.getByRole('tab', { name: 'Venue rentals' }).click();
  await page.getByRole('button', { name: 'View times' }).nth(1).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '6:00 PM' }).click();
  await dialog.getByRole('button', { name: 'Reserve with simulated Stripe' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();

  await dialog.getByRole('button', { name: 'Reserve with simulated Stripe' }).click();
  await expect(dialog.getByRole('alert')).toContainText('cancelled and refunded');
  await expect(dialog.getByRole('status')).toHaveCount(0);
  let requests = state.rentalRequests();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);

  await dialog.getByRole('button', { name: 'Reserve with simulated Stripe' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'no real card was charged' })).toBeVisible();
  requests = state.rentalRequests();
  expect(requests).toHaveLength(3);
  expect(requests[2]?.idempotencyKey).not.toBe(requests[1]?.idempotencyKey);
});

test('student reopens rental history and restores a package credit on cancellation', async ({ page }) => {
  const state = await mockMarketplace(page, {
    initialPackages: [purchasedPackage],
    initialReservations: [packageRentalReservation],
  });
  await page.goto('/manage?tab=explore');
  await page.getByRole('tab', { name: 'Venue rentals' }).click();

  const history = page.getByRole('region', { name: 'My rental reservations' });
  await expect(history).toContainText('River Pickleball Hall');
  await expect(history).toContainText('Package credit used');
  await history.getByRole('button', { name: 'Cancel reservation' }).click();

  const confirmation = page.getByRole('dialog', { name: 'Cancel rental reservation?' });
  await expect(confirmation).toContainText('Cancelling restores one package credit.');
  await confirmation.getByRole('button', { name: 'Cancel reservation' }).click();
  await expect(history.getByRole('status')).toContainText('One package credit was restored');
  await expect(history).toContainText('Cancelled');
  await expect(history).toContainText('Package credit restored');
  await expect(history.getByRole('button', { name: 'Cancel reservation' })).toHaveCount(0);
  await expect.poll(state.packageLoads).toBeGreaterThan(1);

  await page.getByRole('tab', { name: 'Classes/clubs' }).click();
  await page.getByRole('tab', { name: 'Venue rentals' }).click();
  await expect(history).toContainText('Package credit restored');

  await page.getByRole('navigation', { name: 'Student navigation' }).getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'View My Packages' }).click();
  await expect(page.locator('#student-package-list')).toContainText('5 / 5');
});

test('unpaid class checkout is simulated and the marketplace does not overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockMarketplace(page, { bookings: [unpaidBooking], initialPackages: [purchasedPackage] });
  await page.goto('/manage');
  await expect(page.getByRole('heading', { name: 'Active packages' })).toBeVisible();
  await expect(page.getByText('4 of 5 credits left')).toBeVisible();

  await page.getByRole('button', { name: `Open details for ${unpaidBooking.booking.serviceName} at ${business.name}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Payment is due to ${business.name}, who pays your coach`);
  await expect(dialog).toContainText('does not charge a real card');
  await dialog.getByRole('button', { name: /Pay .* with simulated Stripe/ }).click();
  await expect(dialog.getByRole('status')).toContainText(`Paid to ${business.name}`);
  await expect(dialog.getByRole('status')).toContainText('no real card was charged');
  await expect(dialog).toContainText(`Paid to ${business.name}`);
  expect(state.bookingPaymentRequest()).toMatchObject({ simulatedOutcome: 'SUCCEEDED' });

  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  const profileButton = page.getByRole('button', { name: 'Open profile', exact: true });
  const profileBox = await profileButton.boundingBox();
  expect(profileBox?.width).toBeGreaterThanOrEqual(44);
  expect(profileBox?.height).toBeGreaterThanOrEqual(44);
  await page.getByRole('navigation', { name: 'Student navigation' }).getByRole('button', { name: 'Explore' }).click();
  await page.getByRole('tab', { name: 'Venue rentals' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('profile edits sports and exposes all package states', async ({ page }) => {
  const exhausted = { ...purchasedPackage, id: 'package-exhausted', name: 'Used five', usedCredits: 5, remainingCredits: 0, state: 'EXHAUSTED' as const };
  const expired = { ...purchasedPackage, id: 'package-expired', name: 'Spring pass', expiresAt: '2020-01-01T00:00:00.000Z', state: 'EXPIRED' as const };
  await mockMarketplace(page, { initialPackages: [purchasedPackage, exhausted, expired] });
  await page.goto('/manage?tab=profile');

  const details = page.locator('section', { has: page.getByRole('heading', { name: 'Personal details' }) }).first();
  await expect(details).toContainText('Tennis');
  await details.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Sports').fill('Tennis, Badminton');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(details).toContainText('Badminton');

  await page.getByRole('button', { name: 'View My Packages' }).click();
  const packageList = page.locator('#student-package-list');
  await expect(packageList.getByText('Active', { exact: true })).toBeVisible();
  await expect(packageList.getByText('Exhausted', { exact: true })).toBeVisible();
  await expect(packageList.getByText('Expired', { exact: true })).toBeVisible();
});
