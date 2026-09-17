import { expect, test, type Locator, type Page } from '@playwright/test';

const password = 'TestingOnly!2026';

function futureDate(days = 9) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function uniqueEmail(prefix: string, projectName: string) {
  const project = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${prefix}-${project}-${Date.now()}@example.test`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function expectCustomerManageUrl(page: Page, slug: string, tab?: string) {
  await expect(page).toHaveURL(url =>
    url.pathname === '/manage'
      && url.searchParams.get('slug') === slug
      && url.searchParams.get('tab') === (tab ?? null)
      && [...url.searchParams.keys()].every(key => key === 'slug' || key === 'tab'),
  );
}

async function visibleWorkspaceNavigation(page: Page): Promise<Locator> {
  const mobileNavigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  if (await mobileNavigation.isVisible()) return mobileNavigation;

  const desktopNavigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(desktopNavigation).toBeVisible();
  return desktopNavigation;
}

async function openWorkspaceView(page: Page, label: string) {
  const navigation = await visibleWorkspaceNavigation(page);
  await navigation.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Open ${label}`, exact: true }).click();
}

test('customer creates an account, books, views history, and cancels', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
  const workspace = await (await page.request.get('/api/workspace')).json();
  const service = workspace.services.find((candidate: { type: string; locations: unknown[] }) =>
    candidate.type === 'PRIVATE' && candidate.locations.length > 0,
  );
  expect(service).toBeTruthy();
  const mapping = service.locations.find((candidate: { locationId: string }) =>
    workspace.locations.some((location: { id: string; requiresApproval: boolean }) =>
      location.id === candidate.locationId && !location.requiresApproval,
    ),
  ) || service.locations[0];
  const location = workspace.locations.find((candidate: { id: string }) => candidate.id === mapping.locationId);
  const coach = workspace.instructors.find((candidate: { id: string }) => candidate.id === mapping.instructorIds[0]);
  expect(location).toBeTruthy();
  expect(coach).toBeTruthy();

  let date = futureDate();
  let found = false;
  for (let offset = 9; offset < 23; offset++) {
    date = futureDate(offset);
    const response = await page.request.get(`/api/public/${workspace.business.slug}/slots`, {
      params: { serviceId: service.id, instructorId: coach.id, locationId: location.id, date },
    });
    const body = await response.json();
    if (body.slots?.some((slot: { available: boolean }) => slot.available)) {
      found = true;
      break;
    }
  }
  expect(found).toBe(true);

  // Provider and customer sessions share one cookie; release the demo-owner
  // session before entering the account-required public booking journey.
  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto(`/book/${workspace.business.slug}`);
  await expect(page.getByRole('heading', { name: 'Good days start with a lesson.' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(service.name)) }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(location.name)) }).click();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(coach.name)) }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Choose a date').fill(date);
  await page.getByRole('button', { name: /^\d{1,2}:\d{2} [AP]M/ }).first().click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  const customerName = 'Jamie Browser Test';
  const customerEmail = uniqueEmail('jamie', testInfo.project.name);
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Full name').fill(customerName);
  await page.getByLabel('Email address').fill(customerEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel(/^Phone/).fill('+65 9123 4567');
  await page.getByLabel(/^Parent or guardian/).fill('Robin Browser Test');
  await page.getByRole('button', { name: 'Continue with account' }).click();
  await expect(page.getByRole('heading', { name: customerName, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review booking' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /^(Confirm booking|Request booking)/ }).click();

  await expect(page.getByRole('heading', { name: /You’re on the calendar|Your request is in/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your booking receipt' })).toBeVisible();
  await page.screenshot({ path: `.data/screenshots/booking-receipt-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

  await page.getByRole('link', { name: 'My bookings', exact: true }).click();
  await expectCustomerManageUrl(page, workspace.business.slug);
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();
  const customerNavigation = page.getByRole('navigation', { name: 'Customer navigation' });
  await expect(customerNavigation.getByRole('button')).toHaveCount(5);
  await expect(customerNavigation.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');

  await customerNavigation.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expectCustomerManageUrl(page, workspace.business.slug, 'explore');
  await expect(page.getByRole('heading', { name: workspace.business.name, exact: true })).toBeVisible();
  await expect(customerNavigation.getByRole('button', { name: 'Explore', exact: true })).toHaveAttribute('aria-current', 'page');

  await customerNavigation.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Book a session', exact: true })).toBeVisible();
  await expectCustomerManageUrl(page, workspace.business.slug, 'book');
  await expect(page.getByRole('radio', { name: new RegExp(escapeRegExp(workspace.business.name)) })).toBeChecked();
  await expect(customerNavigation.getByRole('button', { name: 'Book', exact: true })).toHaveAttribute('aria-current', 'page');

  const alertsNavigationButton = customerNavigation.getByRole('button', { name: /^Alerts/ });
  await expect(alertsNavigationButton).toHaveAccessibleName(/^Alerts, \d+ unread alerts?$/);
  await alertsNavigationButton.click();
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await expectCustomerManageUrl(page, workspace.business.slug, 'alerts');
  await expect(customerNavigation.getByRole('button', { name: /^Alerts/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(/Live alerts are temporarily unavailable/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Booking (confirmed|request received)$/ })).toBeVisible();
  const markAllRead = page.getByRole('button', { name: 'Mark all as read', exact: true });
  await expect(markAllRead).toBeVisible();
  await markAllRead.click();
  await expect(markAllRead).toHaveCount(0);
  await expect(alertsNavigationButton).toHaveAccessibleName('Alerts');
  const reloadedNotifications = page.waitForResponse(response =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/account/notifications',
  );
  await page.reload();
  await reloadedNotifications;
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await expect(page.getByText(/Live alerts are temporarily unavailable/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark all as read', exact: true })).toHaveCount(0);

  await customerNavigation.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expectCustomerManageUrl(page, workspace.business.slug, 'profile');
  await expect(page.getByRole('heading', { name: 'Personal details', exact: true })).toBeVisible();
  const profileName = page.getByLabel('Full name', { exact: true });
  const profileEmail = page.getByLabel('Email address', { exact: true });
  const profilePhone = page.getByLabel('Phone', { exact: true });
  const profileGuardian = page.getByLabel('Parent or guardian', { exact: true });
  await expect(profileName).toHaveValue(customerName);
  await expect(profileEmail).toHaveValue(customerEmail);
  await expect(profileEmail).not.toBeEditable();
  await expect(profilePhone).toHaveValue('+65 9123 4567');
  await expect(profileGuardian).toHaveValue('Robin Browser Test');
  await expect(page.getByRole('group', { name: 'Filter booking history' })).toBeVisible();
  await expect(customerNavigation.getByRole('button', { name: 'Profile', exact: true })).toHaveAttribute('aria-current', 'page');

  const updatedPhone = '+65 9876 5432';
  const updatedGuardian = 'Robin Browser Updated';
  await profilePhone.fill(updatedPhone);
  await profileGuardian.fill(updatedGuardian);
  const profileSaveResponse = page.waitForResponse(response =>
    response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === '/api/account/profile',
  );
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  expect((await profileSaveResponse).status()).toBe(200);
  await expect(page.locator('#customer-profile-save-status')).toHaveText('Your profile has been updated.');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(customerEmail);
  await expect(page.getByLabel('Email address', { exact: true })).not.toBeEditable();
  await expect(page.getByLabel('Phone', { exact: true })).toHaveValue(updatedPhone);
  await expect(page.getByLabel('Parent or guardian', { exact: true })).toHaveValue(updatedGuardian);

  await customerNavigation.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();
  await expectCustomerManageUrl(page, workspace.business.slug, 'home');
  const bookingCard = page.getByRole('article').filter({ hasText: service.name });
  await expect(bookingCard).toContainText(customerName);
  await expect(bookingCard).toContainText('Confirmed');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Upcoming sessions' })).toBeVisible();
  await expect(bookingCard).toContainText(service.name);
  await bookingCard.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(bookingCard.getByRole('region', { name: 'Confirm cancellation' })).toBeVisible();
  await bookingCard.getByRole('button', { name: 'Yes, cancel session' }).click();
  const cancellationNotice = page.getByRole('status').filter({ hasText: 'Your booking has been cancelled.' });
  await expect(cancellationNotice).toBeVisible();
  await expect(cancellationNotice).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Booking history' })).toBeVisible();
  await expect(bookingCard).toContainText('Cancelled');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Booking history' })).toBeVisible();
  await expect(bookingCard).toContainText('Cancelled');
  const historyResponse = await page.request.get('/api/account/bookings', {
    params: { businessSlug: workspace.business.slug },
  });
  expect(historyResponse.ok()).toBeTruthy();
  const historyBody = await historyResponse.json();
  const history = Array.isArray(historyBody) ? historyBody : historyBody.bookings;
  expect(history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      booking: expect.objectContaining({ serviceId: service.id }),
      participant: expect.objectContaining({ email: customerEmail }),
    }),
  ]));
});

test('customer shell guards stale actions and exposes current sessions and actionable alerts', async ({ page }) => {
  const now = Date.now();
  const session = {
    user: {
      id: 'customer-user',
      name: 'Taylor Player',
      email: 'taylor@example.test',
      accountType: 'CUSTOMER',
      phone: '',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  };
  const business = {
    name: 'Known Test Club',
    slug: 'known-test-club',
    ownerName: 'Coach Test',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
    color: '#174c3c',
    tagline: 'A real club from booking history',
    cancellationHours: 24,
  };
  function accountBooking(
    id: string,
    serviceName: string,
    startAt: string,
    endAt: string,
  ) {
    const participant = {
      id: `participant-${id}`,
      customerId: 'customer-record',
      name: session.user.name,
      email: session.user.email,
      attendance: 'UNMARKED',
      paid: false,
      price: 9000,
      packageId: null,
      notes: '',
      cancelled: false,
      cancelledAt: null,
    };
    return {
      business,
      booking: {
        id,
        serviceId: `service-${id}`,
        serviceName,
        instructorId: 'instructor-test',
        instructorName: 'Coach Test',
        locationId: 'location-test',
        locationName: 'Centre Court',
        locationColor: '#174c3c',
        startAt,
        endAt,
        status: 'CONFIRMED',
        type: 'PRIVATE',
        capacity: 1,
        price: 9000,
        notes: '',
        address: '1 Court Lane',
        recurringId: null,
        participants: [participant],
      },
      participant,
      location: {
        id: 'location-test',
        name: 'Centre Court',
        address: '1 Court Lane',
        type: 'FACILITY',
        color: '#174c3c',
        requiresApproval: false,
        active: true,
      },
      // Intentionally stale server snapshots: local time policy must still win.
      canCancel: true,
      canReschedule: true,
    };
  }

  const inProgress = accountBooking(
    'in-progress-booking',
    'Live coaching',
    new Date(now - 15 * 60_000).toISOString(),
    new Date(now + 45 * 60_000).toISOString(),
  );
  const insideCutoff = accountBooking(
    'inside-cutoff-booking',
    'Tomorrow coaching',
    new Date(now + 60 * 60_000).toISOString(),
    new Date(now + 2 * 60 * 60_000).toISOString(),
  );

  await page.route('**/api/auth/me', route => route.fulfill({ json: session }));
  await page.route('**/api/account/bookings*', route => route.fulfill({
    json: { bookings: [inProgress, insideCutoff] },
  }));
  await page.route('**/api/account/notifications', route => route.fulfill({
    json: {
      notifications: [{
        id: 'action-alert',
        bookingId: 'in-progress-booking',
        type: 'BOOKING_RESCHEDULED',
        title: 'Schedule changed',
        message: 'Your coach moved this session. Review your bookings.',
        read: false,
        actionNeeded: true,
        createdAt: new Date(now).toISOString(),
        business: { name: business.name, slug: business.slug },
      }],
    },
  }));

  await page.goto(`/manage?slug=${business.slug}&tab=home`);
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();

  const currentSection = page.locator('section[aria-labelledby="current-bookings"]');
  const currentCard = currentSection.getByRole('article').filter({ hasText: 'Live coaching' });
  await expect(currentSection.getByRole('heading', { name: 'In progress' })).toBeVisible();
  await expect(currentCard).toContainText('In progress');
  await expect(currentCard.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
  await expect(currentCard.getByRole('button', { name: 'Reschedule' })).toHaveCount(0);

  const upcomingSection = page.locator('section[aria-labelledby="upcoming-bookings"]');
  const cutoffCard = upcomingSection.getByRole('article').filter({ hasText: 'Tomorrow coaching' });
  await expect(cutoffCard).toBeVisible();
  await expect(cutoffCard.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
  await expect(cutoffCard.getByRole('button', { name: 'Reschedule' })).toHaveCount(0);
  await expect(page.locator('section[aria-labelledby="booking-history"]')).toHaveCount(0);

  const customerNavigation = page.getByRole('navigation', { name: 'Customer navigation' });
  const alertsButton = customerNavigation.getByRole('button', { name: 'Alerts, 1 unread alert' });
  await expect(alertsButton).toHaveAccessibleName('Alerts, 1 unread alert');
  await alertsButton.click();

  const actionableAlert = page.getByRole('article').filter({ hasText: 'Schedule changed' });
  await expect(actionableAlert.getByText('Action needed', { exact: true })).toBeVisible();
  await expect(actionableAlert.getByRole('button', { name: 'View bookings' })).toBeVisible();
  await expect(actionableAlert.getByRole('link', { name: `Book with ${business.name}` }))
    .toHaveAttribute('href', `/book/${business.slug}`);
  await actionableAlert.getByRole('button', { name: 'View bookings' }).click();
  await expectCustomerManageUrl(page, business.slug, 'home');
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();
});

test('owner sign-up creates an empty club membership and sign-in restores it', async ({ page }, testInfo) => {
  const email = uniqueEmail('owner', testInfo.project.name);
  await page.goto('/signup');
  await page.getByRole('radio', { name: /Club owner/ }).click();
  await page.getByLabel(/Your full name/i).fill('Alex Test');
  await page.getByLabel(/Business name/i).fill('Alex Coaching');
  await page.getByLabel(/Email/i).fill(email);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole('button', { name: 'Create your workspace' }).click();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  await expect(page.getByText('A few small steps. A whole new rhythm.')).toBeVisible();
  const navigation = await visibleWorkspaceNavigation(page);
  await expect(navigation.getByRole('button')).toHaveCount(5);
  await navigation.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.getByText('Workspace owner', { exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: 'Home', exact: true }).click();

  const workspace = await (await page.request.get('/api/workspace')).json();
  expect(workspace.business.isDemo).toBe(false);
  expect(workspace.bookings).toEqual([]);
  expect(workspace.user.accountType).toBe('OWNER');
  expect(workspace.membership).toMatchObject({ role: 'OWNER', businessId: workspace.business.id });

  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto('/login');
  await page.getByLabel(/Email/i).fill(email);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  expect((await (await page.request.get('/api/workspace')).json()).business.id).toBe(workspace.business.id);
});

test('self-registered coach is linked to a club by its owner', async ({ page }, testInfo) => {
  const coachEmail = uniqueEmail('coach', testInfo.project.name);
  await page.goto('/signup');
  await page.getByRole('radio', { name: /Coach/ }).click();
  await page.getByLabel(/Your full name/i).fill('Casey Coach');
  await page.getByLabel(/Email/i).fill(coachEmail);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole('button', { name: 'Create coach account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Welcome, Casey Coach.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No club access yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
  const ownerWorkspace = await (await page.request.get('/api/workspace')).json();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  await openWorkspaceView(page, 'Your team');
  await expect(page.getByRole('heading', { name: 'Staff workspace access' })).toBeVisible();
  await page.getByRole('button', { name: 'Add staff member' }).click();
  await page.getByLabel('Courtly account email').fill(coachEmail);
  await page.getByLabel('Access role').selectOption('COACH');
  await page.getByRole('button', { name: 'Add to this business' }).click();
  const linkedStaff = page.getByRole('listitem').filter({ hasText: coachEmail });
  await expect(linkedStaff).toBeVisible();
  await expect(linkedStaff).toContainText('Instructor: Casey Coach');

  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto('/login');
  await page.getByLabel(/Email/i).fill(coachEmail);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  const coachWorkspace = await (await page.request.get('/api/workspace')).json();
  const instructor = coachWorkspace.instructors.find((candidate: { name: string }) => candidate.name === 'Casey Coach');
  expect(instructor).toBeTruthy();
  expect(coachWorkspace.business.id).toBe(ownerWorkspace.business.id);
  expect(coachWorkspace.membership).toMatchObject({ role: 'COACH', instructorId: instructor.id });

  const coachNavigation = await visibleWorkspaceNavigation(page);
  await expect(coachNavigation.getByRole('button')).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Coach snapshot' })).toBeVisible();
  await expect(page.getByText("This week's sessions", { exact: true })).toBeVisible();
  await expect(page.getByText('Assigned students', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText("This week's earnings", { exact: true })).toHaveCount(0);
  await expect(page.locator('main').getByText('Outstanding', { exact: true })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(coachWorkspace.business.currency);
  await expect(page.locator('main').getByRole('button', { name: 'Booking page', exact: true })).toHaveCount(0);
  await expect(page.locator('main').getByText('Your booking page', { exact: true })).toHaveCount(0);
  await coachNavigation.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page.getByText(/Business setup, team access, packages, payments, and reporting are managed/)).toBeVisible();
  for (const label of ['Calendar', 'Bookings', 'Customers', 'Availability']) {
    await expect(page.getByRole('button', { name: `Open ${label}`, exact: true })).toBeEnabled();
  }
  for (const label of ['Services', 'Locations', 'Your team', 'Lesson packages', 'Payments', 'Insights']) {
    await expect(page.getByRole('button', { name: `Open ${label}`, exact: true })).toHaveCount(0);
  }

  await coachNavigation.getByRole('button', { name: 'Create', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create' });
  await expect(createDialog.getByRole('heading', { name: 'Quick actions', exact: true })).toBeVisible();
  await expect(createDialog.getByText('New booking needs a little setup', { exact: true })).toBeVisible();
  await expect(createDialog.getByText(/Ask an owner or administrator/)).toBeVisible();
  for (const action of ['Availability']) {
    await expect(createDialog.getByRole('button', { name: new RegExp(`^${action}\\b`) })).toBeVisible();
  }
  for (const action of ['Customers', 'Services', 'Locations', 'Payments']) {
    await expect(createDialog.getByRole('button', { name: new RegExp(`^${action}\\b`) })).toHaveCount(0);
  }
  await createDialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.goto('/?tab=explore&view=payments');
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=explore$/);
  await expect(page.locator('main')).not.toContainText('A clear picture of money');

  const refreshedNavigation = await visibleWorkspaceNavigation(page);
  await refreshedNavigation.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.locator('main').getByRole('heading', { name: 'Casey Coach', exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('Coach', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByRole('button', { name: 'Business settings', exact: true })).toHaveCount(0);

  await page.goto('/?tab=profile&view=settings');
  await expect(page.locator('main').getByRole('heading', { name: 'Casey Coach', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=profile$/);
  await expect(page.locator('main').getByRole('button', { name: 'Business settings', exact: true })).toHaveCount(0);
});
