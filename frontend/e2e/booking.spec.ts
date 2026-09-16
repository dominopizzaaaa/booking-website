import { expect, test, type Page } from '@playwright/test';

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

async function openWorkspaceView(page: Page, label: string) {
  const navigationTrigger = page.getByRole('button', { name: 'Open navigation' });
  if (await navigationTrigger.isVisible()) await navigationTrigger.click();
  await page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
}

test('customer creates an account, books, views history, and cancels', async ({ page }, testInfo) => {
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
  await page.getByRole('button', { name: new RegExp(service.name) }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(location.name) }).click();
  await page.getByRole('button', { name: new RegExp(coach.name) }).click();
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
  await expect(page).toHaveURL(new RegExp(`/manage\\?slug=${workspace.business.slug}`));
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();
  const bookingCard = page.getByRole('article').filter({ hasText: service.name });
  await expect(bookingCard).toContainText(customerName);
  await expect(bookingCard).toContainText('Confirmed');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Upcoming sessions' })).toBeVisible();
  await expect(bookingCard).toContainText(service.name);
  await bookingCard.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(bookingCard.getByRole('region', { name: 'Confirm cancellation' })).toBeVisible();
  await bookingCard.getByRole('button', { name: 'Yes, cancel session' }).click();
  await expect(page.getByText('Your booking has been cancelled.', { exact: true })).toBeVisible();
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
});
