import { expect, test } from '@playwright/test';

function futureDate(days = 9) {
  const date = new Date(); date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

test('customer books, sees persistent receipt, and cancels with a private link', async ({ page }, testInfo) => {
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
  const workspace = await (await page.request.get('/api/workspace')).json();
  const service = workspace.services.find((s: { type: string; locations: unknown[] }) => s.type === 'PRIVATE' && s.locations.length);
  const mapping = service.locations.find((m: { locationId: string }) => workspace.locations.some((l: { id: string; requiresApproval: boolean }) => l.id === m.locationId && !l.requiresApproval)) || service.locations[0];
  const location = workspace.locations.find((l: { id: string }) => l.id === mapping.locationId);
  const coach = workspace.instructors.find((i: { id: string }) => i.id === mapping.instructorIds[0]);
  let date = futureDate();
  let found = false;
  for (let offset = 9; offset < 23; offset++) {
    date = futureDate(offset);
    const response = await page.request.get(`/api/public/${workspace.business.slug}/slots`, { params: { serviceId: service.id, instructorId: coach.id, locationId: location.id, date } });
    const body = await response.json();
    if (body.slots?.some((s: { available: boolean }) => s.available)) { found = true; break; }
  }
  expect(found).toBe(true);
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
  await page.getByLabel(/Player’s full name/).fill('Jamie Browser Test');
  await page.getByLabel(/Email address/).fill(`jamie-${Date.now()}@example.test`);
  await page.getByLabel(/Phone number/).fill('+65 9123 4567');
  await page.getByLabel(/Parent or guardian/).fill('Robin Browser Test');
  await page.getByRole('button', { name: 'Review booking' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /^(Confirm booking|Request booking)/ }).click();
  await expect(page.getByRole('heading', { name: /You’re on the calendar|Your request is in/ })).toBeVisible();
  await page.screenshot({ path: `.data/screenshots/booking-receipt-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.getByRole('link', { name: 'Manage booking', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your next good game.' })).toBeVisible();
  await page.reload();
  await expect(page.locator('main')).toContainText('Jamie Browser Test');
  await page.getByRole('button', { name: 'Cancel booking', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, cancel this session' }).click();
  await expect(page.getByText('Your booking has been cancelled.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Find a new session' })).toBeVisible();
});

test('sign up creates an empty private workspace and sign in returns to it', async ({ page }) => {
  const email = `owner-${Date.now()}@example.test`;
  await page.goto('/signup');
  await page.getByLabel(/Your full name/i).fill('Alex Test');
  await page.getByLabel(/Business name/i).fill('Alex Coaching');
  await page.getByLabel(/Email/i).fill(email);
  await page.getByLabel(/^Password/i).fill('TestingOnly!2026');
  const agree = page.getByRole('checkbox');
  if (await agree.count()) await agree.check();
  await page.getByRole('button', { name: /Create.*workspace/i }).click();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  await expect(page.getByText('A few small steps. A whole new rhythm.')).toBeVisible();
  const workspace = await (await page.request.get('/api/workspace')).json();
  expect(workspace.business.isDemo).toBe(false);
  expect(workspace.bookings).toEqual([]);
  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto('/login');
  await page.getByLabel(/Email/i).fill(email);
  await page.getByLabel(/^Password/i).fill('TestingOnly!2026');
  await page.getByRole('button', { name: /Sign in/i }).click();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  expect((await (await page.request.get('/api/workspace')).json()).business.id).toBe(workspace.business.id);
});
