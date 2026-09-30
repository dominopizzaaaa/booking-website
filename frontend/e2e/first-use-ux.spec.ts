import { expect, test, type Locator, type Page } from '@playwright/test';
import { currentLegalAcceptance } from './legal-acceptance';

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

test('signup explains personal, guardian, coach, and club account paths', async ({ page }) => {
  await page.goto('/signup');
  const accountTypes = page.getByRole('group', { name: 'I’m joining Courtly as', exact: true });

  await expect(accountTypes.getByRole('radio')).toHaveCount(3);
  await expect(accountTypes.getByText('Run one club and its bookings', { exact: true })).toBeVisible();
  await expect(accountTypes.getByText('Teach at one or more clubs', { exact: true })).toBeVisible();
  await expect(accountTypes.getByText('Book for yourself or manage children', { exact: true })).toBeVisible();

  for (const name of ['Club or academy', 'Coach', 'Player or guardian']) {
    await accountTypes.getByRole('radio', { name, exact: true }).check();
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  }
  await accountTypes.getByRole('radio', { name: 'Player or guardian', exact: true }).check();
  await expect(page.getByRole('heading', { name: 'One personal account, with Family for children' })).toBeVisible();
  await expect(page.getByText(/Parents and guardians do not need a separate account type/)).toBeVisible();
  await expect(page.getByText(/Ages 13–17:.*cannot book or pay on Courtly yet/)).toBeVisible();
  await expect(page.getByLabel('Your date of birth', { exact: true })).toBeVisible();
});

test('standalone student signup requires an explicit account type and opens the complete club directory', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const run = `${projectId(testInfo.project.name)}-${Date.now()}`;
  const studentEmail = uniqueEmail('standalone-student', testInfo.project.name);
  const coachEmail = `first-book-coach-${run}@example.test`;
  const clubEmail = `first-book-club-${run}@example.test`;
  const coachRegistration = await page.request.post('/api/auth/register', {
    data: { accountType: 'COACH', name: 'First Book Coach', username: `fbc_${run.replace(/-/g, '_').slice(-26)}`, email: coachEmail, password, dateOfBirth: '1990-01-01', ...currentLegalAcceptance },
  });
  expect(coachRegistration.ok(), await coachRegistration.text()).toBeTruthy();
  expect((await page.request.post('/api/auth/logout', { data: {} })).ok()).toBeTruthy();

  const clubName = `First Booking Club ${run}`;
  const clubRegistration = await page.request.post('/api/auth/register', {
    data: { accountType: 'CLUB', businessName: clubName, name: 'First Booking Operator', username: `fbl_${run.replace(/-/g, '_').slice(-26)}`, email: clubEmail, password, ...currentLegalAcceptance },
  });
  expect(clubRegistration.ok(), await clubRegistration.text()).toBeTruthy();
  const clubAuth = await clubRegistration.json() as { business: { slug: string } };
  const rosterResponse = await page.request.post('/api/staff', { data: { email: coachEmail } });
  expect(rosterResponse.ok(), await rosterResponse.text()).toBeTruthy();
  const roster = await rosterResponse.json() as { instructorId: string };
  const locationResponse = await page.request.post('/api/locations', {
    data: { name: 'First Booking Court', address: '1 Discovery Lane', type: 'FACILITY', requiresApproval: false },
  });
  expect(locationResponse.ok(), await locationResponse.text()).toBeTruthy();
  const location = await locationResponse.json() as { id: string };
  const serviceResponse = await page.request.post('/api/services', {
    data: {
      name: 'First Booking Tennis', description: 'A public class for first-time discovery.', category: 'Tennis',
      type: 'PRIVATE', duration: 60, price: 8_000, capacity: 1, bufferMinutes: 0, noticeHours: 0,
      color: 'sage', active: true,
      locations: [{ locationId: location.id, price: 8_000, duration: 60, instructorIds: [roster.instructorId] }],
    },
  });
  expect(serviceResponse.ok(), await serviceResponse.text()).toBeTruthy();

  const publicResponse = await page.request.get(`/api/public/${clubAuth.business.slug}`);
  expect(publicResponse.ok()).toBeTruthy();
  const publicBusiness = await publicResponse.json() as {
    business: { name: string; slug: string };
    services: Array<{ active: boolean; name: string; locations: unknown[] }>;
  };
  const service = publicBusiness.services.find(candidate => candidate.active && candidate.locations.length > 0);
  expect(service).toBeTruthy();

  // Release the club session before exercising standalone student signup.
  const clubLogout = await page.request.post('/api/auth/logout', { data: {} });
  expect(clubLogout.ok()).toBeTruthy();
  const accountTypes = page.getByRole('group', { name: 'I’m joining Courtly as', exact: true });

  await page.goto('/signup');
  await expect(accountTypes.getByRole('radio')).toHaveCount(3);
  for (const name of ['Club or academy', 'Coach', 'Player or guardian']) {
    await expect(accountTypes.getByRole('radio', { name, exact: true })).not.toBeChecked();
  }

  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Please choose how you’re joining Courtly.', { exact: true })).toBeVisible();

  await accountTypes.getByRole('radio', { name: 'Player or guardian', exact: true }).check();
  await expect(page.getByText('Create one student account for bookings across every club.', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Your student account keeps your bookings together/)).toHaveCount(0);
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await page.getByLabel('Your full name', { exact: true }).fill('First Use Student');
  await page.getByLabel('Username', { exact: true }).fill(`fus_${studentEmail.split('@')[0].replace(/-/g, '_').slice(-26)}`);
  await page.getByLabel('Your date of birth', { exact: true }).fill('1990-01-01');
  await page.getByLabel('Email address', { exact: true }).fill(studentEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create personal account', exact: true }).click();

  await expect(page).toHaveURL(url => url.pathname === '/manage' && url.search === '');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
  const tour = page.locator('.driver-popover.courtly-tour');
  await expect(tour.getByRole('heading', { name: 'Welcome to Courtly, First' })).toBeVisible();
  await expect(tour.getByText('Step 1 of 6', { exact: true })).toBeVisible();
  for (let step = 2; step <= 6; step += 1) {
    await tour.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(tour.getByText(`Step ${step} of 6`, { exact: true })).toBeVisible();
  }
  await expect(tour.getByRole('heading', { name: 'You’re ready to play' })).toBeVisible();
  await tour.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(tour).toHaveCount(0);

  await page.getByRole('navigation', { name: 'Student navigation' }).getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/manage' && url.searchParams.get('tab') === 'book');
  await expect(page.getByRole('heading', { name: 'Book a session', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /club.*found/i })).toBeVisible();
  const clubChoice = page.getByRole('radio', { name: new RegExp(escapeRegExp(publicBusiness.business.name)) });
  await expect(clubChoice).toBeVisible();
  await clubChoice.focus();
  await clubChoice.press('Space');
  await expect(clubChoice).toBeChecked();
  await page.getByRole('link', { name: `Continue to ${publicBusiness.business.name}`, exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `/book/${publicBusiness.business.slug}`);
  await expect(page.getByRole('heading', { name: 'Good days start with a class.', exact: true })).toBeVisible();
  await expect(page.getByText(publicBusiness.business.name, { exact: true }).first()).toBeVisible();
  const bookableService = page.getByRole('button', { name: new RegExp(escapeRegExp(service!.name)) });
  await expect(bookableService).toBeVisible();
  await expect(bookableService).toBeEnabled();

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
    await expect(page.getByRole('radio', { name: 'Player or guardian', exact: true })).toBeChecked();

    const signIn = page.getByRole('link', { name: 'Sign in', exact: true });
    await expect(signIn).toHaveAttribute('href', loginPath);
    await signIn.click();
    await expect(page).toHaveURL(url => `${url.pathname}${url.search}` === loginPath);
  }

  const email = uniqueEmail('unsafe-next-student', testInfo.project.name);
  const registration = await page.request.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: 'Unsafe Next Student', username: `uns_${email.split('@')[0].replace(/-/g, '_').slice(-26)}`, email, password, dateOfBirth: '1990-01-01', ...currentLegalAcceptance },
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
  const tour = page.locator('.driver-popover.courtly-tour');
  await expect(tour.getByRole('heading', { name: /Welcome to First Use Club/ })).toBeVisible();
  await expect(tour.getByText(/Step 1 of/)).toBeVisible();
  const next = tour.getByRole('button', { name: 'Next', exact: true });
  await expect(next).toBeFocused();
  await next.press('Enter');
  await expect(tour.getByText(/Step 2 of/)).toBeVisible();
  await expect(page.locator('[data-tour="workspace-home"]')).toHaveClass(/driver-active-element/);
  const back = tour.getByRole('button', { name: 'Back', exact: true });
  await expect(back).toBeEnabled();
  await back.click();
  await expect(tour.getByText(/Step 1 of/)).toBeVisible();
  await tour.getByRole('button', { name: 'Next', exact: true }).press('Enter');
  await expect(tour.getByText(/Step 2 of/)).toBeVisible();
  for (let step = 3; step <= 9; step += 1) {
    await tour.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(tour.getByText(new RegExp(`Step ${step} of`))).toBeVisible();
  }
  await expect(tour.getByRole('heading', { name: 'You’re ready to play' })).toBeVisible();
  await tour.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(tour).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'A few small steps. A whole new rhythm.', exact: true })).toBeVisible();
  await expect(page.getByText(/Complete the steps in order./)).toBeVisible();
  await expect(page.getByRole('button', { name: '1. Add an active location', exact: true })).toBeEnabled();
  await expect(page.getByText('Finish setup before sharing this page.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Ready to share/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy link', exact: true })).toHaveCount(0);

  const navigation = await visibleWorkspaceNavigation(page);
  await navigation.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByRole('button', { name: 'Take the tour', exact: true }).click();
  await expect(tour.getByRole('heading', { name: /Welcome to First Use Club/ })).toBeVisible();
  await tour.getByRole('button', { name: 'Close product tour' }).click();
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
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();

  const openBookings = page.getByRole('button', { name: 'Open Bookings', exact: true });
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
  await page.route('**/api/payments/capabilities', route => route.fulfill({
    json: {
      mode: 'simulated', enabled: true, liveCheckout: false,
      simulatedCheckout: true, publishableKey: null,
    },
  }));
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
