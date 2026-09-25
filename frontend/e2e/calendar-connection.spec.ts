import { expect, test, type Page, type Request } from '@playwright/test';
import type {
  AuthSession,
  Business,
  CalendarConnectionStatus,
  CoachClubWorkspace,
  ManagerWorkspace,
  Membership,
  WorkspaceResponse,
} from '../src/lib/types';

const soloBusiness: Business & { kind: 'SOLO' } = {
  id: 'calendar-solo',
  name: 'Morgan Coaching',
  slug: 'morgan-coaching',
  ownerName: 'Morgan Coach',
  email: 'morgan@example.test',
  timezone: 'Asia/Singapore',
  currency: 'SGD',
  color: '#174c3c',
  tagline: 'Personal coaching.',
  cancellationHours: 24,
  kind: 'SOLO',
  isDemo: false,
};

const clubBusiness: Business & { kind: 'CLUB' } = {
  ...soloBusiness,
  id: 'calendar-club',
  name: 'Calendar Rackets Club',
  slug: 'calendar-rackets-club',
  ownerName: 'Club Operations',
  email: 'club@example.test',
  tagline: 'A welcoming club.',
  kind: 'CLUB',
};

const coachMembership: Membership = {
  id: 'calendar-coach-membership',
  userId: 'calendar-coach',
  businessId: clubBusiness.id,
  instructorId: 'calendar-coach-instructor',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  business: clubBusiness,
};

const clubMembership: Membership = {
  id: 'calendar-club-membership',
  userId: 'calendar-club-account',
  businessId: clubBusiness.id,
  instructorId: null,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  business: clubBusiness,
};

const coachWorkspace: CoachClubWorkspace = {
  business: clubBusiness,
  user: {
    id: 'calendar-coach',
    name: 'Morgan Coach',
    email: 'morgan@example.test',
    accountType: 'COACH',
    phone: '',
    parentName: '',
    instructorId: coachMembership.instructorId,
  },
  membership: coachMembership,
  memberships: [coachMembership],
  clubAccount: false,
  instructors: [],
  locations: [],
  services: [],
  availability: [],
  exceptions: [],
  students: [],
  packages: [],
  bookings: [],
  payments: [],
  notifications: [],
  rescheduleRequests: [],
  integrityFlags: [],
};

const clubWorkspace: ManagerWorkspace = {
  ...coachWorkspace,
  business: clubBusiness,
  user: {
    id: 'calendar-club-account',
    name: 'Calendar Rackets Club',
    email: 'signin.club@example.test',
    accountType: 'CLUB',
    phone: '',
    parentName: '',
    instructorId: null,
  },
  membership: clubMembership,
  memberships: [clubMembership],
  clubAccount: true,
  services: [],
  bookings: [],
  packages: [],
  payments: [],
  integrityFlags: [],
};

const coachSession: AuthSession = {
  user: {
    id: 'calendar-account-coach',
    name: 'Alex Calendar',
    email: 'alex.calendar@example.test',
    accountType: 'COACH',
    phone: '',
    parentName: '',
  },
  membership: null,
  business: null,
  memberships: [],
};

const studentSession: AuthSession = {
  user: {
    id: 'calendar-student',
    name: 'Sam Student',
    email: 'sam.student@example.test',
    accountType: 'STUDENT',
    phone: '',
    parentName: '',
  },
  membership: null,
  business: null,
  memberships: [],
};

const disconnected: CalendarConnectionStatus = {
  configured: true,
  eligible: true,
  provider: 'GOOGLE',
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

const connected: CalendarConnectionStatus = {
  ...disconnected,
  state: 'ACTIVE',
  connected: true,
  email: 'alex.google@example.test',
  calendarName: 'Alex coaching',
  syncEnabled: true,
  busyCheckEnabled: false,
  connectedAt: '2026-09-25T01:00:00.000Z',
  lastSyncedAt: '2026-09-25T02:00:00.000Z',
  lastBusyAt: '2026-09-25T02:05:00.000Z',
  busyCacheExpiresAt: '2026-09-25T02:10:00.000Z',
};

function calendarCard(page: Page) {
  return page.getByRole('region', { name: 'Google Calendar', exact: true });
}

async function mockWorkspace(page: Page, workspace: WorkspaceResponse) {
  await page.route('**/api/workspace', route => route.fulfill({ json: workspace }));
}

async function mockStudent(page: Page) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: studentSession }));
  await page.route('**/api/account/clubs*', route => route.fulfill({ json: { clubs: [] } }));
  await page.route('**/api/account/bookings*', route => route.fulfill({ json: { bookings: [] } }));
  await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/account/packages', route => route.fulfill({ json: { packages: [] } }));
  await page.route(/\/api\/rentals(?:\?.*)?$/, route => route.fulfill({
    json: { rentals: [], nextCursor: null },
  }));
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual(expect.objectContaining({ clientWidth: 390, scrollWidth: 390 }));
}

function requestBody(request: Request) {
  return request.postDataJSON() as Record<string, unknown>;
}

test('an eligible coach sees the disconnected card and starts OAuth with the profile return path', async ({ page }) => {
  await mockWorkspace(page, coachWorkspace);
  await page.route('**/api/calendar/connection', route => route.fulfill({ json: disconnected }));
  await page.route('**/api/calendar/google/connect', route => route.fulfill({
    json: { authorizationUrl: '/?tab=profile#mock-google-oauth' },
  }));

  await page.goto('/?tab=profile');
  const card = calendarCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Not connected');
  await expect(card).toContainText('This personal connection follows your Courtly account.');
  await expect(card).toContainText('Courtly stays authoritative.');

  const connectRequest = page.waitForRequest(request =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/calendar/google/connect',
  );
  await card.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
  expect(requestBody(await connectRequest)).toEqual({ returnTo: '/?tab=profile' });
  await expect(page).toHaveURL(url => url.hash === '#mock-google-oauth');
});

test('an eligible student sees the disconnected account-wide card in Profile', async ({ page }) => {
  await mockStudent(page);
  await page.route('**/api/calendar/connection', route => route.fulfill({ json: disconnected }));

  await page.goto('/manage?tab=profile');
  const card = calendarCard(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Not connected');
  await expect(card.getByRole('button', { name: 'Connect Google Calendar', exact: true })).toBeVisible();
  await expect(card).toContainText('Editing or deleting a Google event never changes the Courtly booking.');
});

test('a club sees coach-owned guidance without requesting personal calendar status', async ({ page }) => {
  let calendarRequests = 0;
  await mockWorkspace(page, clubWorkspace);
  await page.route('**/api/calendar/**', route => {
    calendarRequests += 1;
    return route.fulfill({ json: disconnected });
  });

  await page.goto('/?tab=profile');
  const card = calendarCard(page);
  await expect(card.getByText('Individual accounts only', { exact: true })).toBeVisible();
  await expect(card).toContainText('Each coach connects their own calendar from their Courtly profile.');
  await expect(card.getByRole('button', { name: /Connect Google Calendar/ })).toHaveCount(0);
  expect(calendarRequests).toBe(0);
});

test('an existing connection can be removed when Google Calendar configuration is unavailable', async ({ page }) => {
  let status: CalendarConnectionStatus = {
    ...connected,
    configured: false,
    state: 'REAUTH_REQUIRED',
    error: 'Reconnect Google Calendar to resume syncing.',
  };

  await page.route('**/api/auth/me', route => route.fulfill({ json: coachSession }));
  await page.route('**/api/calendar/connection', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: status });
    if (request.method() === 'DELETE') {
      status = {
        ...status,
        state: 'DISCONNECTING',
        connected: false,
        syncEnabled: false,
        busyCheckEnabled: false,
        error: null,
      };
      return route.fulfill({ status: 202, json: status });
    }
    return route.abort();
  });

  await page.goto('/account');
  const card = calendarCard(page);
  await expect(card).toContainText('Google Calendar is not available');
  await expect(card).toContainText('A saved connection still exists');
  await expect(card).toContainText('alex.google@example.test');
  await expect(card.getByRole('switch')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Sync now', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Reconnect Google Calendar', exact: true })).toHaveCount(0);

  await card.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect Google Calendar?' });
  await expect(dialog).toBeVisible();
  const disconnectRequest = page.waitForRequest(request =>
    request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/calendar/connection',
  );
  await dialog.getByRole('button', { name: 'Disconnect Google Calendar', exact: true }).click();
  expect((await disconnectRequest).postData()).toBe('{}');

  await expect(dialog).toBeHidden();
  await expect(page.getByText('Google Calendar disconnect queued', { exact: true })).toBeVisible();
  await expect(card).toContainText('Google Calendar is not available');
  await expect(card).toContainText('Disconnect pending');
  await expect(card.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
});

test('a connected coach can change preferences, queue a sync, and confirm disconnect', async ({ page }, testInfo) => {
  let status: CalendarConnectionStatus = { ...connected, error: 'The latest Google Calendar sync could not be completed.' };
  const preferenceBodies: Array<Record<string, unknown>> = [];

  await page.route('**/api/auth/me', route => route.fulfill({ json: coachSession }));
  await page.route('**/api/calendar/connection', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: status });
    if (request.method() === 'PATCH') {
      const body = requestBody(request);
      preferenceBodies.push(body);
      status = { ...status, ...body };
      return route.fulfill({ json: status });
    }
    if (request.method() === 'DELETE') {
      status = {
        ...status,
        state: 'DISCONNECTING',
        connected: false,
        syncEnabled: false,
        busyCheckEnabled: false,
        error: null,
      };
      return route.fulfill({ status: 202, json: status });
    }
    return route.abort();
  });
  await page.route('**/api/calendar/sync', route => route.fulfill({
    status: 202,
    json: { ...status, lastSyncedAt: '2026-09-25T03:00:00.000Z', error: null },
  }));

  await page.goto('/account');
  const card = calendarCard(page);
  await expect(card).toContainText('Sync needs attention');
  await expect(card.getByRole('alert')).toContainText('The latest Google Calendar sync could not be completed.');
  await expect(card).toContainText('alex.google@example.test');
  await expect(card).toContainText('Alex coaching');
  await page.screenshot({ path: `.data/screenshots/calendar-coach-${testInfo.project.name}.png`, fullPage: true });

  const syncSwitch = card.getByRole('switch', { name: 'Sync Courtly lessons', exact: true });
  const busySwitch = card.getByRole('switch', { name: 'Check Google busy times', exact: true });
  await expect(syncSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(busySwitch).toHaveAttribute('aria-checked', 'false');
  await expect(syncSwitch).toBeEnabled();
  await expect(busySwitch).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();

  await syncSwitch.click();
  await expect(syncSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(card.getByRole('button', { name: 'Sync now', exact: true })).toBeDisabled();
  await syncSwitch.click();
  await expect(syncSwitch).toHaveAttribute('aria-checked', 'true');
  await busySwitch.click();
  await expect(busySwitch).toHaveAttribute('aria-checked', 'true');
  expect(preferenceBodies).toEqual([
    { syncEnabled: false },
    { syncEnabled: true },
    { busyCheckEnabled: true },
  ]);

  const syncRequest = page.waitForRequest(request =>
    request.method() === 'POST' && new URL(request.url()).pathname === '/api/calendar/sync',
  );
  await card.getByRole('button', { name: 'Sync now', exact: true }).click();
  expect((await syncRequest).postData()).toBe('{}');
  await expect(page.getByText('Google Calendar sync queued', { exact: true })).toBeVisible();

  const disconnectButton = card.getByRole('button', { name: 'Disconnect', exact: true });
  await disconnectButton.click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect Google Calendar?' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await disconnectButton.click();
  const disconnectRequest = page.waitForRequest(request =>
    request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/calendar/connection',
  );
  await dialog.getByRole('button', { name: 'Disconnect Google Calendar', exact: true }).click();
  expect((await disconnectRequest).postData()).toBe('{}');
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Google Calendar disconnect queued', { exact: true })).toBeVisible();
  await expect(card).toContainText('Disconnecting');
  await expect(card).toContainText('Courtly is finishing the disconnect.');
  await expect(card.getByRole('button', { name: 'Connect Google Calendar', exact: true })).toHaveCount(0);
});

test('student calendar controls remain named, keyboard-operable, and contained at 390px', async ({ page }, testInfo) => {
  let status = { ...connected, email: 'student.google@example.test' };
  const patches: Array<Record<string, unknown>> = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await mockStudent(page);
  await page.route('**/api/calendar/connection', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: status });
    if (request.method() === 'PATCH') {
      const body = requestBody(request);
      patches.push(body);
      status = { ...status, ...body };
      return route.fulfill({ json: status });
    }
    return route.fulfill({ json: status });
  });

  await page.goto('/manage?tab=profile');
  const card = calendarCard(page);
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `.data/screenshots/calendar-student-${testInfo.project.name}.png`, fullPage: true });

  const switches = card.getByRole('switch');
  await expect(switches).toHaveCount(2);
  const busySwitch = card.getByRole('switch', { name: 'Check Google busy times', exact: true });
  const bounds = await busySwitch.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  await busySwitch.focus();
  await expect(busySwitch).toBeFocused();
  await busySwitch.press('Space');
  await expect(busySwitch).toHaveAttribute('aria-checked', 'true');
  expect(patches).toEqual([{ busyCheckEnabled: true }]);
  await expectNoHorizontalOverflow(page);
});
