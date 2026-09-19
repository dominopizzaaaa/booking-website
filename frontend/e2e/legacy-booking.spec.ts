import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  Booking,
  Participant,
  PublicBookingBusiness,
  PublicLocation,
  Slot,
} from '../src/lib/types';

const token = 'a'.repeat(43);
const slug = 'legacy-racket-club';
const now = new Date('2026-09-19T00:00:00.000Z');
const originalStart = '2026-09-26T02:00:00.000Z';
const movedStart = '2026-09-27T02:00:00.000Z';

type ManagedBooking = {
  business: PublicBookingBusiness;
  booking: Omit<Booking, 'participants'>;
  participant: Pick<Participant, 'name' | 'paid' | 'price' | 'cancelled' | 'cancelledAt'>;
  location: PublicLocation;
  canCancel: boolean;
  canReschedule: boolean;
  management: { cancellationHours: number; rescheduleNoticeHours: number };
};

function managedBooking(startAt = originalStart): ManagedBooking {
  return {
    business: {
      name: 'Legacy Racket Club',
      slug,
      ownerName: 'Courtly Tests',
      timezone: 'Asia/Singapore',
      currency: 'SGD',
      color: '#174c3c',
      tagline: 'A private booking link.',
      cancellationHours: 24,
      kind: 'CLUB',
    },
    booking: {
      id: 'legacy-booking',
      serviceId: 'legacy-service',
      serviceName: 'Private tennis',
      instructorId: 'legacy-coach',
      instructorName: 'Legacy Coach',
      locationId: 'legacy-court',
      locationName: 'Legacy Court',
      locationColor: '#78915e',
      startAt,
      endAt: new Date(new Date(startAt).getTime() + 3_600_000).toISOString(),
      status: 'CONFIRMED',
      type: 'PRIVATE',
      capacity: 1,
      price: 8_000,
      paymentRoute: 'CLUB',
      coachAcceptance: 'NOT_REQUIRED',
      createdByRole: 'STUDENT',
      address: '',
      recurringId: null,
    },
    participant: {
      name: 'Legacy Player',
      paid: false,
      price: 8_000,
      cancelled: false,
      cancelledAt: null,
    },
    location: {
      id: 'legacy-court',
      name: 'Legacy Court',
      address: '1 Court Lane',
      type: 'FACILITY',
      color: '#78915e',
      requiresApproval: false,
      active: true,
    },
    canCancel: true,
    canReschedule: true,
    management: { cancellationHours: 24, rescheduleNoticeHours: 72 },
  };
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockSlots(
  page: Page,
  onRequest?: (url: URL) => void,
  slots: Slot[] = [{
    startAt: movedStart,
    endAt: '2026-09-27T03:00:00.000Z',
    available: true,
    placesRemaining: 1,
  }],
) {
  await page.route(`**/api/public/${slug}/slots?*`, route => {
    const url = new URL(route.request().url());
    onRequest?.(url);
    return fulfillJson(route, {
      slots: url.searchParams.get('date') === '2026-09-27' ? slots : [],
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: now });
});

test('a valid legacy link loads the private booking details and available actions', async ({ page }) => {
  await page.route(`**/api/manage/${token}`, route => fulfillJson(route, managedBooking()));

  await page.goto(`/manage/${token}`);

  await expect(page.getByRole('heading', { name: 'Your booking', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Legacy Racket Club', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Private tennis', exact: true })).toBeVisible();
  await expect(page.getByText('With Legacy Coach · 60 minutes', { exact: true })).toBeVisible();
  await expect(page.getByText('When', { exact: true }).locator('..')).toContainText('Sat, 26 Sep');
  await expect(page.getByText('When', { exact: true }).locator('..')).toContainText('10:00 AM – 11:00 AM');
  await expect(page.getByText('Where', { exact: true }).locator('..')).toContainText('Legacy Court');
  await expect(page.getByText('Where', { exact: true }).locator('..')).toContainText('1 Court Lane');
  await expect(page.getByText('Booked for', { exact: true }).locator('..')).toContainText('Legacy Player');
  await expect(page.getByText('Session price', { exact: true }).locator('..')).toContainText('$80');
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('Cancellation requires 24 hours notice; rescheduling requires 72 hours notice.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule session', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toBeVisible();
});

test('the coach reschedule window can close while cancellation remains available', async ({ page }) => {
  const insideCoachNotice = managedBooking('2026-09-21T02:00:00.000Z');
  insideCoachNotice.canReschedule = false;
  let slotRequests = 0;
  await mockSlots(page, () => { slotRequests += 1; });
  await page.route(`**/api/manage/${token}`, route => fulfillJson(route, insideCoachNotice));

  await page.goto(`/manage/${token}`);

  await expect(page.getByText('Cancellation requires 24 hours notice; rescheduling requires 72 hours notice.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toBeVisible();
  expect(slotRequests).toBe(0);
});

test('a loaded reschedule permission expires at the exact browser-time cutoff', async ({ page }) => {
  const cutoff = new Date('2026-09-19T02:00:00.000Z');
  const atExactCutoff = managedBooking('2026-09-22T02:00:00.000Z');
  let rescheduleRequests = 0;
  await mockSlots(page);
  await page.route(`**/api/manage/${token}`, route => fulfillJson(route, atExactCutoff));
  await page.route(`**/api/manage/${token}/reschedule`, route => {
    expect(route.request().method()).toBe('POST');
    rescheduleRequests += 1;
    return fulfillJson(route, atExactCutoff);
  });

  await page.goto(`/manage/${token}`);
  await page.clock.pauseAt(cutoff);
  await page.getByRole('button', { name: 'Reschedule session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Find a better time', exact: true })).toBeVisible();

  await page.clock.runFor(51);

  await expect(page.getByRole('heading', { name: 'Find a better time', exact: true })).toHaveCount(0);
  await expect(page.getByText('This booking is now outside the rescheduling window. Contact your coach.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toBeVisible();
  expect(rescheduleRequests).toBe(0);
});

test('an open cancellation confirmation closes when its notice cutoff passes', async ({ page }) => {
  const cutoff = new Date('2026-09-19T02:00:00.000Z');
  const atExactCutoff = managedBooking('2026-09-20T02:00:00.000Z');
  let cancelRequests = 0;
  await page.route(`**/api/manage/${token}`, route => fulfillJson(route, atExactCutoff));
  await page.route(`**/api/manage/${token}/cancel`, route => {
    cancelRequests += 1;
    return fulfillJson(route, atExactCutoff);
  });

  await page.goto(`/manage/${token}`);
  await page.clock.pauseAt(cutoff);
  await page.getByRole('button', { name: 'Cancel booking', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Confirm cancellation' });
  await expect(confirmation).toBeVisible();

  await page.clock.runFor(51);

  await expect(confirmation).toHaveCount(0);
  await expect(page.getByText('This booking is now inside 24 hours of its start. Please contact your coach.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toHaveCount(0);
  expect(cancelRequests).toBe(0);
});

test('cancellation rechecks the live cutoff before submitting', async ({ page }) => {
  const cutoff = new Date('2026-09-19T02:00:00.000Z');
  const atExactCutoff = managedBooking('2026-09-20T02:00:00.000Z');
  let cancelRequests = 0;
  await page.route(`**/api/manage/${token}`, route => fulfillJson(route, atExactCutoff));
  await page.route(`**/api/manage/${token}/cancel`, route => {
    cancelRequests += 1;
    return fulfillJson(route, atExactCutoff);
  });

  await page.goto(`/manage/${token}`);
  await page.clock.pauseAt(cutoff);
  await page.getByRole('button', { name: 'Cancel booking', exact: true }).click();
  const submit = page.getByRole('button', { name: 'Yes, cancel this session', exact: true });
  await expect(submit).toBeVisible();

  await page.clock.setSystemTime(cutoff.getTime() + 1);
  await submit.click();

  expect(cancelRequests).toBe(0);
  await expect(page.getByText('This booking is now inside 24 hours of its start. Please contact your coach.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Confirm cancellation' })).toHaveCount(0);
});

test('an eligible legacy booking loads slots and reschedules successfully', async ({ page }) => {
  let current = managedBooking();
  const slotRequests: URL[] = [];
  const rescheduleBodies: unknown[] = [];
  await mockSlots(page, url => slotRequests.push(url));
  await page.route(`**/api/manage/${token}`, route => {
    expect(route.request().method()).toBe('GET');
    return fulfillJson(route, current);
  });
  await page.route(`**/api/manage/${token}/reschedule`, route => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    const body = request.postDataJSON() as { startAt: string };
    rescheduleBodies.push(body);
    current = {
      ...current,
      booking: {
        ...current.booking,
        startAt: body.startAt,
        endAt: new Date(new Date(body.startAt).getTime() + 3_600_000).toISOString(),
      },
    };
    return fulfillJson(route, current);
  });

  await page.goto(`/manage/${token}`);
  await page.getByRole('button', { name: 'Reschedule session', exact: true }).click();
  await page.getByLabel('Choose a date').fill('2026-09-27');
  const newTime = page.getByRole('button', { name: /^10:00 AM/ });
  await expect(newTime).toBeVisible();
  await newTime.click();
  await expect(page.getByText('New time: Sun, 27 Sep, 10:00 AM. Your current time remains reserved until this succeeds.')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm new time', exact: true }).click();

  await expect(page.getByText('Your session has been rescheduled. The new details are below.')).toBeVisible();
  await expect(page.getByText('When', { exact: true }).locator('..')).toContainText('Sun, 27 Sep');
  expect(rescheduleBodies).toEqual([{ startAt: movedStart }]);
  expect(slotRequests.map(url => url.searchParams.get('date'))).toEqual(
    expect.arrayContaining(['2026-09-26', '2026-09-27']),
  );
  expect(Object.fromEntries(slotRequests[slotRequests.length - 1]!.searchParams)).toEqual({
    serviceId: 'legacy-service',
    instructorId: 'legacy-coach',
    locationId: 'legacy-court',
    date: '2026-09-27',
  });
});

test('cancellation is sent only after confirmation and leaves a terminal booking', async ({ page }) => {
  let current = managedBooking();
  const cancelBodies: unknown[] = [];
  await page.route(`**/api/manage/${token}`, route => {
    expect(route.request().method()).toBe('GET');
    return fulfillJson(route, current);
  });
  await page.route(`**/api/manage/${token}/cancel`, route => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    cancelBodies.push(request.postDataJSON());
    current = {
      ...current,
      canCancel: false,
      canReschedule: false,
      booking: { ...current.booking, status: 'CANCELLED' },
      participant: {
        ...current.participant,
        cancelled: true,
        cancelledAt: now.toISOString(),
      },
    };
    return fulfillJson(route, current);
  });

  await page.goto(`/manage/${token}`);
  await page.getByRole('button', { name: 'Cancel booking', exact: true }).click();
  const confirmation = page.getByRole('region', { name: 'Confirm cancellation' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('This cannot be undone from this link.');
  expect(cancelBodies).toHaveLength(0);

  await confirmation.getByRole('button', { name: 'Yes, cancel this session', exact: true }).click();

  await expect(page.getByText('Your booking has been cancelled.')).toBeVisible();
  expect(cancelBodies).toEqual([{}]);
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText('This booking is cancelled. Sign in to your account when you are ready to book again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open my bookings', exact: true })).toBeVisible();
});

test('completed and elapsed legacy bookings cannot be changed', async ({ page }) => {
  let current = managedBooking();
  current = {
    ...current,
    canCancel: false,
    canReschedule: false,
    booking: { ...current.booking, status: 'COMPLETED' },
  };
  await page.route(`**/api/manage/${token}`, route => fulfillJson(route, current));

  await page.goto(`/manage/${token}`);
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByText(/This session has already started or finished/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open my bookings', exact: true })).toBeVisible();

  current = managedBooking('2026-09-18T02:00:00.000Z');
  await page.reload();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
  await expect(page.getByText(/This session has already started or finished/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toHaveCount(0);
});

test('an upcoming booking inside the cancellation cutoff cannot be changed', async ({ page }) => {
  const insideCancellationNotice = managedBooking('2026-09-19T14:00:00.000Z');
  await page.route(`**/api/manage/${token}`, route => fulfillJson(route, insideCancellationNotice));

  await page.goto(`/manage/${token}`);

  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText(/This session is inside the self-service change window/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reschedule session', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel booking', exact: true })).toHaveCount(0);
});

test('invalid and expired legacy links show an unavailable state that can be retried', async ({ page }) => {
  let response: 'invalid' | 'expired' | 'active' = 'invalid';
  await page.route(`**/api/manage/${token}`, route => {
    if (response === 'invalid') {
      return fulfillJson(route, { error: 'Management link not found' }, 404);
    }
    if (response === 'expired') {
      return fulfillJson(
        route,
        { error: 'This management link has expired. Please contact your coach.' },
        410,
      );
    }
    return fulfillJson(route, managedBooking());
  });

  await page.goto(`/manage/${token}`);
  await expect(page.getByRole('heading', { name: 'This booking link is unavailable', exact: true })).toBeVisible();
  const unavailableState = page
    .getByRole('heading', { name: 'This booking link is unavailable', exact: true })
    .locator('..');
  await expect(unavailableState.getByRole('alert')).toContainText('Management link not found');
  await expect(page.getByRole('link', { name: 'My account bookings', exact: true })).toHaveAttribute('href', '/manage');

  response = 'expired';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(unavailableState.getByRole('alert')).toContainText('This management link has expired');

  response = 'active';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your booking', exact: true })).toBeVisible();
});
