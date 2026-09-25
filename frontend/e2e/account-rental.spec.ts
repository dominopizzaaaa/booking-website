import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import type {
  AuthSession,
  Business,
  CalendarConnectionStatus,
  RentalDetail,
  RentalListing,
  RentalReservation,
} from '../src/lib/types';

const frozenTime = new Date('2026-09-25T01:00:00.000Z');
const selectedDate = '2026-09-27';
const rentalStart = '2026-09-27T02:00:00.000Z';
const rentalEnd = '2026-09-27T03:30:00.000Z';

const inactiveClub: Business = {
  id: 'inactive-club',
  name: 'Dormant Rackets Club',
  slug: 'dormant-rackets-club',
  ownerName: 'Dormant Club',
  email: 'dormant@example.test',
  timezone: 'Asia/Singapore',
  currency: 'SGD',
  color: '#365f48',
  tagline: 'Not currently available.',
  cancellationHours: 24,
  kind: 'CLUB',
  isDemo: false,
  legacyReadOnly: false,
};

const legacyPractice: Business = {
  ...inactiveClub,
  id: 'legacy-practice',
  name: 'Archived Coach Practice',
  slug: 'archived-coach-practice',
  kind: 'SOLO',
  legacyReadOnly: true,
};

const clubBusiness: Business = {
  ...inactiveClub,
  id: 'harbour-sports-club',
  name: 'Harbour Sports Club',
  slug: 'harbour-sports-club',
  ownerName: 'Harbour team',
  email: 'harbour@example.test',
};

const coachSession = {
  user: {
    id: 'unaffiliated-coach',
    name: 'Casey Coach',
    username: 'casey_coach',
    email: 'casey.coach@example.test',
    accountType: 'COACH' as const,
    sports: ['Tennis'],
    phone: '',
    parentName: '',
  },
  membership: null,
  business: null,
  memberships: [
    {
      id: 'inactive-club-membership',
      userId: 'unaffiliated-coach',
      businessId: inactiveClub.id,
      instructorId: 'inactive-club-instructor',
      active: false,
      createdAt: '2026-01-10T00:00:00.000Z',
      business: inactiveClub,
    },
    {
      id: 'legacy-practice-membership',
      userId: 'unaffiliated-coach',
      businessId: legacyPractice.id,
      instructorId: 'legacy-practice-instructor',
      active: true,
      createdAt: '2025-01-10T00:00:00.000Z',
      business: legacyPractice,
    },
  ],
} satisfies AuthSession;

const clubSession = {
  user: {
    id: 'harbour-club-account',
    name: clubBusiness.name,
    username: 'harbour_club',
    email: 'club-login@example.test',
    accountType: 'CLUB' as const,
    sports: ['Tennis'],
  },
  membership: {
    id: 'harbour-club-membership',
    userId: 'harbour-club-account',
    businessId: clubBusiness.id,
    instructorId: null,
    active: true,
    createdAt: '2026-01-10T00:00:00.000Z',
    business: clubBusiness,
  },
  business: clubBusiness,
  memberships: [{
    id: 'harbour-club-membership',
    userId: 'harbour-club-account',
    businessId: clubBusiness.id,
    instructorId: null,
    active: true,
    createdAt: '2026-01-10T00:00:00.000Z',
    business: clubBusiness,
  }],
} satisfies AuthSession;

const rental: RentalListing = {
  id: 'harbour-training-courts',
  locationId: 'harbour-training-courts',
  name: 'Harbour Training Courts',
  address: '18 Marina Walk, Singapore',
  sport: 'Tennis',
  amenities: ['Lights', 'Changing rooms'],
  unitLabel: 'Court',
  price: 3_500,
  currency: 'SGD',
  timezone: 'Asia/Singapore',
  club: { name: 'Harbour Sports Club', slug: 'harbour-sports-club' },
};

const rentalDetail: RentalDetail = {
  ...rental,
  enabled: true,
  minDuration: 60,
  maxDuration: 120,
  startInterval: 30,
  durationIncrement: 30,
  noticeHours: 2,
  advanceDays: 30,
  cancellationHours: 12,
  rules: 'Non-marking shoes only.',
  units: [{ id: 'court-alpha', name: 'Court Alpha', active: true }],
  openingHours: [{ dayOfWeek: 0, startTime: '08:00', endTime: '22:00' }],
};

const reservation: RentalReservation = {
  id: 'coach-reservation',
  businessName: rental.club.name,
  locationId: rental.locationId,
  locationName: rental.name,
  unitId: 'court-alpha',
  unitName: 'Court Alpha',
  startAt: rentalStart,
  endAt: rentalEnd,
  duration: 90,
  price: 5_250,
  status: 'CONFIRMED',
  paymentStatus: 'PAID',
  packageId: null,
  creditConsumed: false,
  currency: 'SGD',
  timezone: 'Asia/Singapore',
  cancellationDeadline: '2026-09-26T14:00:00.000Z',
  cancellable: true,
};

const calendarStatus: CalendarConnectionStatus = {
  configured: false,
  eligible: true,
  provider: null,
  state: 'DISCONNECTED',
  connected: false,
  email: null,
  calendarName: null,
  syncEnabled: false,
  busyCheckEnabled: false,
  connectedAt: null,
  lastSyncedAt: null,
  lastBusyAt: null,
  busyCacheExpiresAt: null,
  error: null,
};

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function pathOf(request: Request) {
  return new URL(request.url()).pathname;
}

async function mockAccountRentalFlow(page: Page, options: {
  session?: AuthSession;
  initialReservations?: RentalReservation[];
  secondPageRental?: RentalListing;
  freeCheckout?: boolean;
  failFirstCheckout?: boolean;
} = {}) {
  const slotQueries: Array<{ date: string | null; duration: string | null }> = [];
  const rentalQueries: Array<{ sport: string | null; cursor: string | null }> = [];
  let reservationBody: Record<string, unknown> | null = null;
  const reservationBodies: Record<string, unknown>[] = [];
  let reservations = [...(options.initialReservations ?? [])];
  let cancellationCount = 0;
  const checkoutRental = options.freeCheckout ? { ...rental, price: 0 } : rental;
  const checkoutDetail = options.freeCheckout ? { ...rentalDetail, price: 0 } : rentalDetail;
  const checkoutReservation = options.freeCheckout ? { ...reservation, id: 'free-reservation', price: 0 } : reservation;

  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = pathOf(request);

    if (request.method() === 'GET' && path === '/api/auth/me') {
      return fulfillJson(route, options.session ?? coachSession);
    }
    if (request.method() === 'GET' && path === '/api/calendar/connection') {
      return fulfillJson(route, calendarStatus);
    }
    if (request.method() === 'GET' && path === '/api/rentals') {
      const query = { sport: url.searchParams.get('sport'), cursor: url.searchParams.get('cursor') };
      rentalQueries.push(query);
      if (query.sport && query.sport !== rental.sport) {
        return fulfillJson(route, { rentals: [], nextCursor: null });
      }
      if (url.searchParams.get('cursor') === 'second-page' && options.secondPageRental) {
        return fulfillJson(route, { rentals: [options.secondPageRental], nextCursor: null });
      }
      return fulfillJson(route, { rentals: [checkoutRental], nextCursor: options.secondPageRental ? 'second-page' : null });
    }
    if (request.method() === 'GET' && path === '/api/rentals/reservations/mine') {
      return fulfillJson(route, { reservations });
    }
    if (request.method() === 'GET' && path === `/api/rentals/${rental.id}`) {
      return fulfillJson(route, { rental: checkoutDetail });
    }
    if (request.method() === 'GET' && path === `/api/rentals/${rental.id}/slots`) {
      const query = { date: url.searchParams.get('date'), duration: url.searchParams.get('duration') };
      slotQueries.push(query);
      const selected = query.date === selectedDate && query.duration === '90';
      return fulfillJson(route, {
        date: query.date,
        duration: Number(query.duration),
        timezone: rental.timezone,
        slots: selected ? [{
          unitId: checkoutReservation.unitId,
          unitName: checkoutReservation.unitName,
          startAt: rentalStart,
          endAt: rentalEnd,
          price: checkoutReservation.price,
        }] : [],
      });
    }
    if (request.method() === 'POST' && path === `/api/rentals/${rental.id}/reservations`) {
      reservationBody = request.postDataJSON() as Record<string, unknown>;
      reservationBodies.push(reservationBody);
      if (options.failFirstCheckout && reservationBodies.length === 1) {
        return fulfillJson(route, {
          reservation: null,
          paymentIntent: {
            id: 'failed-rental-payment', kind: 'RENTAL', amount: checkoutReservation.price,
            currency: checkoutReservation.currency, status: 'FAILED', createdAt: frozenTime.toISOString(),
          },
        }, 201);
      }
      reservations = [checkoutReservation];
      return fulfillJson(route, {
        reservation: checkoutReservation,
        paymentIntent: {
          id: 'coach-rental-payment',
          kind: 'RENTAL',
          amount: checkoutReservation.price,
          currency: checkoutReservation.currency,
          status: 'SUCCEEDED',
          provider: checkoutReservation.price === 0 ? 'FREE' : 'SIMULATED_STRIPE',
          reservationId: checkoutReservation.id,
          createdAt: frozenTime.toISOString(),
          confirmedAt: frozenTime.toISOString(),
          failedAt: null,
        },
      }, 201);
    }
    if (request.method() === 'POST' && /^\/api\/rentals\/reservations\/[^/]+\/cancel$/.test(path)) {
      const id = path.split('/').at(-2);
      const current = reservations.find(item => item.id === id);
      if (!current) return fulfillJson(route, { error: 'Rental reservation not found' }, 404);
      cancellationCount += 1;
      const cancelled = { ...current, status: 'CANCELLED' as const, paymentStatus: 'REFUNDED' as const, creditConsumed: false, cancellable: false };
      reservations = reservations.map(item => item.id === id ? cancelled : item);
      return fulfillJson(route, { reservation: cancelled });
    }
    return fulfillJson(route, { error: `Unexpected mocked request: ${request.method()} ${path}` }, 500);
  });

  return { rentalQueries, slotQueries, reservationBody: () => reservationBody, reservationBodies: () => reservationBodies, cancellationCount: () => cancellationCount };
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }))).toEqual(expect.objectContaining({
    viewport: page.viewportSize()!.width,
    document: page.viewportSize()!.width,
  }));
}

test('an unaffiliated coach can reserve a rental from Account', async ({ page }) => {
  await page.clock.install({ time: frozenTime });
  const secondPageRental = { ...rental, id: 'east-side-courts', locationId: 'east-side-courts', name: 'East Side Courts' };
  const requests = await mockAccountRentalFlow(page, { secondPageRental });

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'No club access yet', exact: true })).toBeVisible();
  await expect(page.getByText(inactiveClub.name, { exact: true })).toHaveCount(0);
  await expect(page.getByText(legacyPractice.name, { exact: true })).toHaveCount(0);

  const rentals = page.getByRole('region', { name: 'Explore rental venues', exact: true });
  await expect.poll(() => requests.rentalQueries.at(-1)).toEqual({ sport: null, cursor: null });
  const sportFilter = rentals.getByLabel('Filter rental venues by sport', { exact: true });
  await sportFilter.fill(' Tennis ');
  await rentals.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect.poll(() => requests.rentalQueries.at(-1)).toEqual({ sport: 'Tennis', cursor: null });
  await expect(sportFilter).toHaveValue('Tennis');
  await expect(rentals.getByRole('heading', { name: rental.name, exact: true })).toBeVisible();
  const viewTimes = rentals.getByRole('button', {
    name: `View available times for ${rental.name}`,
    exact: true,
  });
  await expect(viewTimes).toBeEnabled();
  await page.getByRole('button', { name: 'Load more venues', exact: true }).click();
  await expect.poll(() => requests.rentalQueries.at(-1)).toEqual({ sport: 'Tennis', cursor: 'second-page' });
  await expect(rentals.getByRole('heading', { name: secondPageRental.name, exact: true })).toBeVisible();
  await sportFilter.fill('Badminton');
  await rentals.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect.poll(() => requests.rentalQueries.at(-1)).toEqual({ sport: null, cursor: null });
  await expect(sportFilter).toHaveValue('');
  await expect(rentals.getByRole('heading', { name: rental.name, exact: true })).toBeVisible();
  await viewTimes.click();

  const dialog = page.getByRole('dialog', { name: rental.name, exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await dialog.getByLabel('Date', { exact: true }).fill(selectedDate);
  await dialog.getByLabel('Duration', { exact: true }).selectOption('90');

  const slot = dialog.getByRole('button', { name: /10:00 AM.*Court Alpha.*\$52\.50/ });
  await expect(slot).toBeVisible();
  await expect(dialog.getByRole('status')).toHaveText('1 available time loaded.');
  await expect.poll(() => requests.slotQueries).toContainEqual({ date: selectedDate, duration: '90' });
  await slot.click();
  await expect(slot).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog).toContainText('Payment is simulated; no real card is charged.');
  await expectNoHorizontalOverflow(page);

  await dialog.getByRole('button', { name: 'Reserve · $52.50', exact: true }).click();
  await expect.poll(requests.reservationBody).toMatchObject({
    unitId: reservation.unitId,
    startAt: rentalStart,
    duration: 90,
    simulatedOutcome: 'SUCCEEDED',
    idempotencyKey: expect.any(String),
  });

  const confirmation = dialog.getByRole('heading', { name: 'Reservation confirmed', exact: true });
  await expect(confirmation).toBeFocused();
  await expect(dialog.getByRole('status')).toContainText('Payment was simulated; no real card was charged.');
  await expect(dialog.getByRole('status')).toContainText('Court Alpha');
  await expectNoHorizontalOverflow(page);

  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const history = page.getByRole('region', { name: 'My rental reservations' });
  await expect(history).toContainText('Harbour Training Courts');
  await expect(history).toContainText('Harbour Sports Club');
  await expect(history).toContainText('Paid with simulated Stripe');
  await history.getByRole('button', { name: 'Cancel reservation' }).click();
  const cancellation = page.getByRole('dialog', { name: 'Cancel rental reservation?' });
  await expect(cancellation).toContainText('refunds the simulated payment');
  await cancellation.getByRole('button', { name: 'Cancel reservation' }).click();
  await expect(history.getByRole('status')).toContainText('simulated payment was refunded');
  await expect(history).toContainText('Cancelled');
  await expect(history).toContainText('Simulated payment refunded');
  expect(requests.cancellationCount()).toBe(1);
});

test('account rental retry rotates the checkout key after a definitive failure', async ({ page }) => {
  await page.clock.install({ time: frozenTime });
  const requests = await mockAccountRentalFlow(page, { failFirstCheckout: true });
  await page.goto('/account');
  await page.getByRole('button', { name: `View available times for ${rental.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: rental.name, exact: true });
  await dialog.getByLabel('Date', { exact: true }).fill(selectedDate);
  await dialog.getByLabel('Duration', { exact: true }).selectOption('90');
  await dialog.getByRole('button', { name: /10:00 AM.*Court Alpha.*\$52\.50/ }).click();
  await dialog.getByRole('button', { name: 'Reserve · $52.50', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('payment did not complete');
  await dialog.getByRole('button', { name: 'Reserve · $52.50', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Reservation confirmed', exact: true })).toBeVisible();
  const bodies = requests.reservationBodies();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.idempotencyKey).not.toBe(bodies[0]?.idempotencyKey);
});

test('account free rental checkout never presents a card payment or refund', async ({ page }) => {
  await page.clock.install({ time: frozenTime });
  await mockAccountRentalFlow(page, { freeCheckout: true });
  await page.goto('/account');
  await page.getByRole('button', { name: `View available times for ${rental.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: rental.name, exact: true });
  await dialog.getByLabel('Date', { exact: true }).fill(selectedDate);
  await dialog.getByLabel('Duration', { exact: true }).selectOption('90');
  await dialog.getByRole('button', { name: /10:00 AM.*Court Alpha.*Free/ }).click();
  await expect(dialog).toContainText('This reservation is free; no payment or package credit is needed.');
  await expect(dialog).not.toContainText('Payment is simulated');
  await dialog.getByRole('button', { name: 'Reserve for free', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('No payment or package credit was needed.');
  await expect(dialog.getByRole('status')).not.toContainText('simulated');
});

test('a club account can find and cancel its own prior rental reservation', async ({ page }) => {
  await page.clock.install({ time: frozenTime });
  const clubReservation = { ...reservation, id: 'club-reservation', price: 0 };
  const requests = await mockAccountRentalFlow(page, { session: clubSession, initialReservations: [clubReservation] });

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Club profile', exact: true })).toBeVisible();
  const history = page.getByRole('region', { name: 'My rental reservations' });
  await expect(history).toContainText(rental.name);
  await expect(history).toContainText('Confirmed');
  await expect(history).toContainText('Free reservation');
  await history.getByRole('button', { name: 'Cancel reservation' }).click();
  const cancellation = page.getByRole('dialog', { name: 'Cancel rental reservation?' });
  await expect(cancellation).toContainText('No payment or package credit needs to be refunded.');
  await cancellation.getByRole('button', { name: 'Cancel reservation' }).click();

  await expect(history).toContainText('Cancelled');
  await expect(history).toContainText('Free reservation');
  await expect(history).not.toContainText('Simulated payment refunded');
  await expect(history.getByRole('status')).toContainText('No payment or package credit was needed.');
  expect(requests.cancellationCount()).toBe(1);
});
