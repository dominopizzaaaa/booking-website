import { expect, test, type Page } from '@playwright/test';
import type { AccountBooking, AuthSession, StudentClubDirectoryEntry } from '../src/lib/types';

const knownBusiness = {
  name: 'Centre Court Academy',
  slug: 'centre-court-academy',
  ownerName: 'Casey Morgan',
  timezone: 'Asia/Singapore',
  currency: 'SGD',
  color: '#174c3c',
  tagline: 'Friendly tennis coaching for every level.',
  cancellationHours: 24,
  kind: 'CLUB' as const,
};

const discoveryBusiness = {
  ...knownBusiness,
  name: 'Shuttle House',
  slug: 'shuttle-house',
  ownerName: 'Jamie Lee',
  color: '#785b90',
  tagline: 'Badminton coaching from first rally to competition.',
};

const lowercaseSportBusiness = {
  ...knownBusiness,
  name: 'Baseline Tennis Club',
  slug: 'baseline-tennis-club',
  ownerName: 'Taylor Kim',
  color: '#8b623e',
  tagline: 'Tennis coaching for developing players.',
};

const session: AuthSession = {
  user: {
    id: 'directory-student',
    name: 'Avery Student',
    email: 'avery@example.test',
    accountType: 'STUDENT',
  },
  membership: null,
  business: null,
  memberships: [],
};

const knownBooking = {
  business: knownBusiness,
  booking: {
    id: 'directory-booking',
    serviceId: 'tennis-service',
    serviceName: 'Private tennis',
    instructorId: 'coach-1',
    instructorName: 'Jordan Coach',
    locationId: 'location-1',
    locationName: 'Centre Court',
    locationColor: '#174c3c',
    startAt: '2099-09-26T02:00:00.000Z',
    endAt: '2099-09-26T03:00:00.000Z',
    status: 'CONFIRMED',
    type: 'PRIVATE',
    capacity: 1,
    price: 8_000,
    paymentRoute: 'CLUB',
    coachAcceptance: 'NOT_REQUIRED',
    createdByRole: 'STUDENT',
    address: '',
    recurringId: null,
    participants: [],
  },
  participant: {
    id: 'directory-participant',
    studentId: 'student-1',
    name: 'Avery Student',
    email: 'avery@example.test',
    attendance: 'UNMARKED',
    paid: false,
    price: 8_000,
    packageId: null,
    notes: '',
  },
} satisfies AccountBooking;

const directory = [
  {
    business: knownBusiness,
    sports: ['Tennis'],
    serviceCount: 3,
    coachCount: 2,
    locationCount: 1,
    priceFrom: 6_000,
  },
  {
    business: discoveryBusiness,
    sports: ['Badminton'],
    serviceCount: 4,
    coachCount: 3,
    locationCount: 2,
    priceFrom: 4_500,
  },
  {
    business: lowercaseSportBusiness,
    sports: ['tennis'],
    serviceCount: 2,
    coachCount: 1,
    locationCount: 1,
    priceFrom: 5_500,
  },
] satisfies StudentClubDirectoryEntry[];

async function mockStudent(page: Page, clubs: StudentClubDirectoryEntry[] = directory) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: session }));
  await page.route('**/api/account/bookings*', route => route.fulfill({ json: { bookings: [knownBooking] } }));
  await page.route('**/api/account/clubs*', route => route.fulfill({ json: { clubs } }));
  await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/account/packages', route => route.fulfill({ json: { packages: [] } }));
  await page.route(/\/api\/rentals(?:\?.*)?$/, route => route.fulfill({
    json: { rentals: [], nextCursor: null },
  }));
}

test('student Explore separates familiar clubs from discovery and filters the directory', async ({ page }) => {
  await mockStudent(page);
  await page.goto('/manage?tab=explore');

  const yourClubs = page.getByRole('region', { name: 'Your clubs' });
  const discover = page.getByRole('region', { name: 'Discover new clubs' });
  await expect(yourClubs.getByRole('heading', { name: knownBusiness.name })).toBeVisible();
  await expect(discover.getByRole('heading', { name: discoveryBusiness.name })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '3 clubs found' })).toBeVisible();

  const tennisFilter = page.getByRole('button', { name: /^tennis$/i });
  await expect(tennisFilter).toHaveCount(1);
  await tennisFilter.click();
  await expect(page.getByRole('heading', { name: knownBusiness.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: lowercaseSportBusiness.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: discoveryBusiness.name })).toBeHidden();
  await page.getByRole('button', { name: 'All sports', exact: true }).click();

  await page.getByLabel('Search clubs').fill('Shuttle House');
  await expect(page.getByRole('heading', { name: discoveryBusiness.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: knownBusiness.name })).toBeHidden();
  await page.getByLabel('Search clubs').fill('');

  await page.getByLabel('Club', { exact: true }).selectOption(lowercaseSportBusiness.slug);
  await expect(page.getByRole('heading', { name: lowercaseSportBusiness.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: discoveryBusiness.name })).toBeHidden();
  await page.getByLabel('Club', { exact: true }).selectOption('');

  await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(page.getByRole('heading', { name: knownBusiness.name })).toBeHidden();
  await expect(page.getByRole('heading', { name: discoveryBusiness.name })).toBeVisible();

  await page.getByLabel('Search clubs').fill('Centre Court');
  await expect(page.getByRole('heading', { name: 'No clubs match these filters' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear all filters' }).click();

  await page.getByRole('button', { name: 'Badminton', exact: true }).click();
  await expect(page.getByRole('heading', { name: discoveryBusiness.name })).toBeVisible();
  await expect(page.getByRole('heading', { name: knownBusiness.name })).toBeHidden();
  await expect(page.getByRole('link', { name: `View ${discoveryBusiness.name} booking page` })).toHaveAttribute(
    'href',
    `/book/${discoveryBusiness.slug}`,
  );
});

test('directory failure leaves a known club available and can be retried', async ({ page }) => {
  let requests = 0;
  await mockStudent(page);
  await page.unroute('**/api/account/clubs*');
  await page.route('**/api/account/clubs*', route => {
    requests += 1;
    return requests === 1
      ? route.fulfill({ status: 503, json: { error: 'Club directory is unavailable.' } })
      : route.fulfill({ json: { clubs: [directory[1]] } });
  });

  await page.goto('/manage?tab=explore');
  await expect(page.getByRole('region', { name: 'Explore' }).getByRole('alert')).toContainText(
    'Club directory is unavailable.',
  );
  await expect(page.getByRole('heading', { name: knownBusiness.name })).toBeVisible();
  await page.getByLabel('Club', { exact: true }).selectOption(knownBusiness.slug);
  await page.getByRole('button', { name: 'Try club directory again' }).click();
  await expect(page.getByLabel('Club', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: discoveryBusiness.name })).toBeVisible();
});

test('Explore waits for booking history before assigning relationship categories', async ({ page }) => {
  let releaseBookings!: () => void;
  const bookingsReady = new Promise<void>((resolve) => { releaseBookings = resolve; });
  await page.route('**/api/auth/me', route => route.fulfill({ json: session }));
  await page.route('**/api/account/clubs*', route => route.fulfill({ json: { clubs: directory } }));
  await page.route('**/api/account/bookings*', async route => {
    await bookingsReady;
    await route.fulfill({ json: { bookings: [knownBooking] } });
  });
  await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/account/packages', route => route.fulfill({ json: { packages: [] } }));
  await page.route(/\/api\/rentals(?:\?.*)?$/, route => route.fulfill({
    json: { rentals: [], nextCursor: null },
  }));

  await page.goto('/manage?tab=explore');
  await expect(page.getByText('Finding clubs…')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Discover new clubs' })).toHaveCount(0);

  releaseBookings();
  await expect(page.getByRole('region', { name: 'Your clubs' })
    .getByRole('heading', { name: knownBusiness.name })).toBeVisible();
});

test('directory retry sends an expired student session back to sign in', async ({ page }) => {
  let sessionExpired = false;
  await mockStudent(page);
  await page.unroute('**/api/account/clubs*');
  await page.route('**/api/account/clubs*', route => {
    return route.fulfill({
      status: sessionExpired ? 401 : 503,
      json: { error: sessionExpired ? 'Authentication required' : 'Club directory is unavailable.' },
    });
  });

  await page.goto('/manage?tab=explore');
  await expect(page.getByRole('heading', { name: knownBusiness.name })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Explore' }).getByRole('alert')).toContainText(
    'Club directory is unavailable.',
  );
  const retry = page.getByRole('button', { name: 'Try club directory again' });
  await expect(retry).toBeVisible();
  sessionExpired = true;
  await retry.click();

  await expect(page).toHaveURL('/login?next=%2Fmanage%3Ftab%3Dexplore');
});
