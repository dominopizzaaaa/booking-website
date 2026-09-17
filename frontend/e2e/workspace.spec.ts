import { expect, test, type Locator, type Page } from '@playwright/test';

type WorkspaceTab = 'Home' | 'Explore' | 'Create' | 'Alerts' | 'Profile';

async function visibleWorkspaceNavigation(page: Page): Promise<Locator> {
  const mobileNavigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  if (await mobileNavigation.isVisible()) return mobileNavigation;

  const desktopNavigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(desktopNavigation).toBeVisible();
  return desktopNavigation;
}

function workspaceTab(navigation: Locator, label: WorkspaceTab) {
  return label === 'Alerts'
    ? navigation.getByRole('button', { name: /^Alerts/ })
    : navigation.getByRole('button', { name: label, exact: true });
}

async function openWorkspaceTab(page: Page, label: WorkspaceTab) {
  const navigation = await visibleWorkspaceNavigation(page);
  await workspaceTab(navigation, label).click();
  return navigation;
}

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
  const navigation = await visibleWorkspaceNavigation(page);
  await expect(navigation.getByRole('button')).toHaveCount(5);
  for (const label of ['Home', 'Explore', 'Create', 'Alerts', 'Profile'] as const) {
    await expect(workspaceTab(navigation, label)).toBeVisible();
  }
  await expect(workspaceTab(navigation, 'Home')).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/\?tab=home$/);
  const workspace = await page.request.get('/api/workspace');
  expect(workspace.ok()).toBeTruthy();
  const data = await workspace.json();
  await expect.poll(() => page.evaluate(() => window.history.state?.workspaceBusinessId)).toBe(data.business.id);
  await expect(page.locator('header .mobile-menu')).toHaveAttribute('aria-label', 'Explore');
  if (await page.getByRole('navigation', { name: 'Mobile navigation' }).isVisible()) {
    await expect(page.locator('header').getByRole('button', { name: 'Explore', exact: true })).toBeVisible();
  }
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
  const navigation = await visibleWorkspaceNavigation(page);
  const create = workspaceTab(navigation, 'Create');
  const createBox = await create.boundingBox();
  expect(createBox).not.toBeNull();
  if (await page.getByRole('navigation', { name: 'Mobile navigation' }).isVisible()) {
    expect(createBox!.width).toBeGreaterThanOrEqual(44);
    expect(createBox!.height).toBeGreaterThanOrEqual(44);
  }
  await create.click();
  const createDialog = page.getByRole('dialog', { name: 'Create' });
  await expect(createDialog.getByRole('heading', { name: 'Quick actions', exact: true })).toBeVisible();
  for (const action of ['New booking', 'Customers', 'Availability', 'Services', 'Locations', 'Payments']) {
    await expect(createDialog.getByRole('button', { name: new RegExp(`^${action}\\b`) })).toBeVisible();
  }
  await createDialog.getByRole('button', { name: /^New booking\b/ }).click();
  const bookingDialog = page.getByRole('dialog', { name: 'Add a booking' });
  await expect(bookingDialog.getByRole('heading', { name: 'Add a booking' })).toBeVisible();
  await expect(bookingDialog.getByLabel('Service', { exact: true })).toBeVisible();
  await expect(bookingDialog.getByLabel('Location', { exact: true })).toBeVisible();
  await bookingDialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Search workspace' }).click();
  await page.getByRole('textbox', { name: 'Search customers and bookings' }).fill('tennis');
  await expect(page.getByRole('dialog').getByRole('button', { name: /Tennis/i }).first()).toBeVisible();
});

test('navigation shows every connected management screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible({ timeout: 45_000 });

  await openWorkspaceTab(page, 'Explore');
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=explore$/);
  await expect(page.locator('main')).toBeFocused();
  await page.getByRole('button', { name: 'Open Calendar' }).click();
  await expect(page.getByRole('heading', { name: 'Your calendar', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=explore&view=calendar$/);
  await expect(page.locator('main')).toBeFocused();
  await page.getByRole('button', { name: 'Search workspace' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page.locator('main')).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  await expect(page.locator('main')).toBeFocused();
  await expect(workspaceTab(await visibleWorkspaceNavigation(page), 'Home')).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/\?tab=home$/);
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=explore$/);
  await expect(workspaceTab(await visibleWorkspaceNavigation(page), 'Explore')).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Your calendar', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=explore&view=calendar$/);
  await expect(workspaceTab(await visibleWorkspaceNavigation(page), 'Explore')).toHaveAttribute('aria-current', 'page');

  const destinations = [
    ['calendar', 'Calendar', 'Your calendar'],
    ['bookings', 'Bookings', 'Bookings'],
    ['customers', 'Customers', 'Customers'],
    ['services', 'Services', 'Services'],
    ['locations', 'Locations', 'Locations'],
    ['team', 'Your team', 'Your team'],
    ['availability', 'Availability', 'Availability'],
    ['packages', 'Lesson packages', 'Lesson packages'],
    ['payments', 'Payments', 'Payments'],
    ['insights', 'Insights', 'Insights'],
  ] as const;

  for (const [view, label, heading] of destinations) {
    await openWorkspaceTab(page, 'Explore');
    await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Open ${label}`, exact: true }).click();
    await expect(page.locator('main').getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?tab=explore&view=${view}$`));
    await expect(workspaceTab(await visibleWorkspaceNavigation(page), 'Explore')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('main')).not.toContainText('Something went wrong');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  }

  await openWorkspaceTab(page, 'Alerts');
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=alerts$/);
  await expect(workspaceTab(await visibleWorkspaceNavigation(page), 'Alerts')).toHaveAttribute('aria-current', 'page');

  await openWorkspaceTab(page, 'Profile');
  await expect(page.locator('main').getByText('Workspace owner', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=profile$/);
  await expect(workspaceTab(await visibleWorkspaceNavigation(page), 'Profile')).toHaveAttribute('aria-current', 'page');
  await page.locator('main').getByRole('button', { name: 'Business settings', exact: true }).click();
  await expect(page.locator('main').getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=profile&view=settings$/);
  await expect(workspaceTab(await visibleWorkspaceNavigation(page), 'Profile')).toHaveAttribute('aria-current', 'page');
});

test('stale workspace history returns to the current workspace home', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible({ timeout: 45_000 });
  const workspace = await (await page.request.get('/api/workspace')).json();

  await openWorkspaceTab(page, 'Explore');
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const staleState = { ...(window.history.state || {}), workspaceBusinessId: 'another-business' };
    window.history.replaceState(staleState, '', '/?tab=explore&view=calendar');
    window.dispatchEvent(new PopStateEvent('popstate', { state: staleState }));
  });

  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=home$/);
  await expect(page.locator('main')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.history.state?.workspaceBusinessId)).toBe(workspace.business.id);
});
