import { expect, test, type Locator, type Page } from '@playwright/test';

const password = 'TestingOnly!2026';

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function uniqueEmail(prefix: string, projectName: string) {
  return `${prefix}-${projectId(projectName)}-${Date.now()}@example.test`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function visibleWorkspaceNavigation(page: Page): Promise<Locator> {
  const mobile = page.getByRole('navigation', { name: 'Mobile navigation' });
  if (await mobile.isVisible()) return mobile;

  const desktop = page.getByRole('navigation', { name: 'Primary' });
  await expect(desktop).toBeVisible();
  return desktop;
}

test('signup account choices stay label-only while retaining the username field', async ({ page }) => {
  await page.goto('/signup');
  const accountTypes = page.getByRole('group', { name: 'I’m joining Courtly as', exact: true });

  await expect(accountTypes.getByRole('radio')).toHaveCount(3);
  await expect(page.getByText('Create your club workspace', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Clubs add you by email', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Book and manage lessons', { exact: true })).toHaveCount(0);

  for (const name of ['Club or academy', 'Coach', 'Student']) {
    await accountTypes.getByRole('radio', { name, exact: true }).check();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
    await expect(page.getByText(/This login belongs to your club|Your login belongs to you|Your student account keeps your bookings together/)).toHaveCount(0);
  }
});

test('standalone student signup requires an explicit account type and offers a working booking-link action', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const studentEmail = uniqueEmail('standalone-student', testInfo.project.name);
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();

  const workspaceResponse = await page.request.get('/api/workspace');
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json() as { business: { slug: string } };
  const publicResponse = await page.request.get(`/api/public/${workspace.business.slug}`);
  expect(publicResponse.ok()).toBeTruthy();
  const publicBusiness = await publicResponse.json() as {
    business: { name: string; slug: string };
    services: Array<{ active: boolean; name: string; locations: unknown[] }>;
  };
  const service = publicBusiness.services.find(candidate => candidate.active && candidate.locations.length > 0);
  expect(service).toBeTruthy();

  // Release the demo club session before exercising standalone student signup.
  const demoLogout = await page.request.post('/api/auth/logout', { data: {} });
  expect(demoLogout.ok()).toBeTruthy();
  const accountTypes = page.getByRole('group', { name: 'I’m joining Courtly as', exact: true });

  await page.goto('/signup');
  await expect(accountTypes.getByRole('radio')).toHaveCount(3);
  for (const name of ['Club or academy', 'Coach', 'Student']) {
    await expect(accountTypes.getByRole('radio', { name, exact: true })).not.toBeChecked();
  }

  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Please choose how you’re joining Courtly.', { exact: true })).toBeVisible();

  await accountTypes.getByRole('radio', { name: 'Student', exact: true }).check();
  await expect(page.getByText('Create one student account for bookings across every club.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Your student account keeps your bookings together/)).toHaveCount(0);
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await page.getByLabel('Your full name', { exact: true }).fill('First Use Student');
  await page.getByLabel('Username', { exact: true }).fill(`fus_${studentEmail.split('@')[0].replace(/-/g, '_').slice(-26)}`);
  await page.getByLabel('Email address', { exact: true }).fill(studentEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create student account', exact: true }).click();

  await expect(page).toHaveURL(url => url.pathname === '/manage' && url.search === '');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();

  const bookingLink = page.getByLabel('Club booking link or slug', { exact: true });
  const openBookingPage = page.getByRole('button', { name: 'Open booking page', exact: true });
  await expect(bookingLink).toHaveAttribute('placeholder', 'https://courtly.example/book/your-club');
  await expect(openBookingPage).toBeEnabled();

  await bookingLink.fill('https://evil.example/not-a-booking-link');
  await openBookingPage.click();
  await expect(page.getByText('Enter a Courtly booking link or club slug.', { exact: true })).toBeVisible();
  await expect(bookingLink).toHaveAttribute('aria-invalid', 'true');
  await expect(page).toHaveURL(url => url.pathname === '/manage');

  await bookingLink.fill(publicBusiness.business.slug);
  await openBookingPage.click();
  await expect(page).toHaveURL(url => url.pathname === `/book/${publicBusiness.business.slug}`);
  await expect(page.getByRole('heading', { name: 'Good days start with a class.', exact: true })).toBeVisible();
  await expect(page.getByText(publicBusiness.business.name, { exact: true }).first()).toBeVisible();
  const bookableService = page.getByRole('button', { name: new RegExp(escapeRegExp(service!.name)) });
  await expect(bookableService).toBeVisible();
  await expect(bookableService).toBeEnabled();

  await page.goto('/manage');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
  const fullBookingUrl = new URL(`/book/${publicBusiness.business.slug}`, page.url()).toString();
  await page.getByLabel('Club booking link or slug', { exact: true }).fill(fullBookingUrl);
  await page.getByRole('button', { name: 'Open booking page', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/book/${publicBusiness.business.slug}`);
  await expect(page.getByRole('heading', { name: 'Good days start with a class.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(escapeRegExp(service!.name)) })).toBeEnabled();
});

test('safe booking and manage destinations survive auth mode changes while an external next is dropped', async ({ page }, testInfo) => {
  const safeDestinations = [
    { parameter: 'next', destination: '/manage?slug=first-use-club&tab=book' },
    { parameter: 'returnTo', destination: '/book/first-use-club?source=e2e' },
  ] as const;

  for (const { parameter, destination } of safeDestinations) {
    const query = new URLSearchParams([[parameter, destination]]).toString();
    const signupPath = `/signup?${query}`;
    const loginPath = `/login?${query}`;

    await page.goto(loginPath);
    const createAccount = page.getByRole('link', { name: 'Create an account', exact: true });
    await expect(createAccount).toHaveAttribute('href', signupPath);
    await createAccount.click();
    await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === signupPath);
    await expect(page.getByRole('radio', { name: 'Student', exact: true })).toBeChecked();

    const signIn = page.getByRole('link', { name: 'Sign in', exact: true });
    await expect(signIn).toHaveAttribute('href', loginPath);
    await signIn.click();
    await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === loginPath);
  }

  const email = uniqueEmail('unsafe-next-student', testInfo.project.name);
  const registration = await page.request.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: 'Unsafe Next Student', username: `uns_${email.split('@')[0].replace(/-/g, '_').slice(-26)}`, email, password },
  });
  expect(registration.ok()).toBeTruthy();
  const logout = await page.request.post('/api/auth/logout', { data: {} });
  expect(logout.ok()).toBeTruthy();

  await page.route('https://evil.example/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>External destination</h1>' }),
  );
  await page.goto(`/login?${new URLSearchParams({ next: 'https://evil.example/steal' })}`);

  const createAccount = page.getByRole('link', { name: 'Create an account', exact: true });
  await expect(createAccount).toHaveAttribute('href', '/signup');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page).toHaveURL(url => url.pathname === '/manage' && url.hostname !== 'evil.example');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
});

test('a new club account sees setup guidance without premature sharing controls', async ({ page }, testInfo) => {
  const clubEmail = uniqueEmail('first-use-club', testInfo.project.name);
  await page.goto('/signup');
  await page.getByRole('radio', { name: 'Club or academy', exact: true }).check();
  await page.getByLabel('Contact name', { exact: true }).fill('First Use Club Contact');
  await page.getByLabel('Club or academy name', { exact: true }).fill(`First Use Club ${projectId(testInfo.project.name)}`);
  await page.getByLabel('Username', { exact: true }).fill(`fuc_${clubEmail.split('@')[0].replace(/-/g, '_').slice(-26)}`);
  await page.getByLabel('Email address', { exact: true }).fill(clubEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create your workspace', exact: true }).click();

  await expect(page).toHaveURL(url => url.pathname === '/');
  await expect(page.getByRole('heading', { name: 'A few small steps. A whole new rhythm.', exact: true })).toBeVisible();
  await expect(page.getByText(/Complete the steps in order./)).toBeVisible();
  await expect(page.getByRole('button', { name: '1. Add an active location', exact: true })).toBeEnabled();
  await expect(page.getByText('Finish setup before sharing this page.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Ready to share/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toHaveCount(0);
});

test('a demo club account can open a booking from Explore with the keyboard', async ({ page }) => {
  test.setTimeout(90_000);
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible({ timeout: 45_000 });

  const navigation = await visibleWorkspaceNavigation(page);
  const explore = navigation.getByRole('button', { name: 'Explore', exact: true });
  await explore.focus();
  await expect(explore).toBeFocused();
  await explore.press('Enter');
  await expect(page.getByRole('heading', { name: 'Explore training grounds', exact: true })).toBeVisible();

  const openBookings = page.getByRole('button', { name: 'Bookings', exact: true });
  await expect(openBookings).toBeVisible();
  await openBookings.evaluate(element => element.focus());
  await expect(openBookings).toBeFocused();
  await openBookings.press('Enter');
  await expect(page.getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();

  const booking = page.getByRole('button', { name: /^Open booking details for .+ with .+/ }).first();
  await expect(booking).toBeVisible();
  await booking.focus();
  await expect(booking).toBeFocused();
  await booking.press('Enter');

  const details = page.getByRole('dialog');
  await expect(details).toBeVisible();
  await expect(details.getByText(/^Booking details · /)).toBeVisible();
});

test('student bottom-tab navigation moves focus to the main content', async ({ page }, testInfo) => {
  const session = {
    user: {
      id: `focus-user-${projectId(testInfo.project.name)}`,
      name: 'Focus Student',
      email: uniqueEmail('focus-student', testInfo.project.name),
      accountType: 'STUDENT',
      phone: '',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  };

  await page.route('**/api/auth/me', route => route.fulfill({ json: session }));
  await page.route('**/api/account/clubs*', route => route.fulfill({ json: { clubs: [] } }));
  await page.route('**/api/account/bookings*', route => route.fulfill({ json: { bookings: [] } }));
  await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/account/packages', route => route.fulfill({ json: { packages: [] } }));
  await page.route(/\/api\/rentals(?:\?.*)?$/, route => route.fulfill({
    json: { rentals: [], nextCursor: null },
  }));

  await page.goto('/manage?tab=home');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();

  const main = page.locator('main');
  const navigation = page.getByRole('navigation', { name: 'Student navigation' });
  const explore = navigation.getByRole('button', { name: 'Explore', exact: true });
  await expect(main).not.toBeFocused();
  await explore.focus();
  await expect(explore).toBeFocused();
  await explore.press('Enter');

  await expect(page).toHaveURL(url => url.pathname === '/manage' && url.searchParams.get('tab') === 'explore');
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(explore).toHaveAttribute('aria-current', 'page');
  await expect(main).toBeFocused();
});
