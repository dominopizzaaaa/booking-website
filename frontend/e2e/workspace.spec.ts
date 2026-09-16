import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
});

test('demo workspace loads, persists, and adapts to the screen', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Today's sessions", { exact: true })).toBeVisible();
  const workspace = await page.request.get('/api/workspace');
  expect(workspace.ok()).toBeTruthy();
  const data = await workspace.json();
  expect(data.locations.length).toBeGreaterThanOrEqual(3);
  expect(data.bookings.length).toBeGreaterThan(0);
  expect(data.business.isDemo).toBe(true);
  await page.screenshot({ path: `.data/screenshots/overview-${testInfo.project.name}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  const second = await (await page.request.get('/api/workspace')).json();
  expect(second.business.id).toBe(data.business.id);
  expect(errors).toEqual([]);
});

test('provider can inspect lessons and open booking form', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible({ timeout: 45_000 });
  const lesson = page.locator('.lesson-card').first();
  if (await lesson.count()) {
    await lesson.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/Booking details/)).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog' }).click();
  }
  const mobileNewBooking = page.locator('.mobile-bottom').getByRole('button', { name: 'New booking', exact: true });
  const usesMobileAction = await mobileNewBooking.isVisible();
  const newBooking = usesMobileAction
    ? mobileNewBooking
    : page.locator('main').getByRole('button', { name: 'New booking', exact: true });
  const newBookingBox = await newBooking.boundingBox();
  expect(newBookingBox).not.toBeNull();
  if (usesMobileAction) {
    expect(newBookingBox!.width).toBeGreaterThanOrEqual(44);
    expect(newBookingBox!.height).toBeGreaterThanOrEqual(44);
  }
  await newBooking.click();
  await expect(page.getByRole('heading', { name: 'Add a booking' })).toBeVisible();
  await expect(page.getByLabel('Service', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Location', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Search workspace' }).click();
  await page.getByRole('textbox', { name: 'Search customers and bookings' }).fill('tennis');
  await expect(page.getByRole('dialog').getByRole('button', { name: /Tennis/i }).first()).toBeVisible();
});

test('navigation shows every connected management screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible({ timeout: 45_000 });
  for (const label of ['Services', 'Locations', 'Customers', 'Lesson packages', 'Payments', 'Availability', 'Your team', 'Insights', 'Settings']) {
    const navigationTrigger = page.getByRole('button', { name: 'Open navigation' });
    if (await navigationTrigger.isVisible()) await navigationTrigger.click();
    await page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('Something went wrong');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  }
});
