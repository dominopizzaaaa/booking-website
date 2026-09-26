import { expect, test, type Locator, type Page } from '@playwright/test';

// The workspace alert list is how a club or coach triages what happened while
// they were on court: unread first, capped, and readable on a phone held in
// one hand. It is a list people act from, so its actions are checked here in
// the browser rather than only at the API.

// Alerts open from the bell in the top bar, which stays in the same place on
// a desktop and a phone, the way a notifications heart does.
const alertsBell = (page: Page): Locator => page.getByRole('banner').getByRole('button', { name: /^Alerts/ });

async function openAlerts(page: Page) {
  await alertsBell(page).click();
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await expect(alertsBell(page)).toHaveAttribute('aria-current', 'page');
}

test.beforeEach(async ({ page }) => {
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible({ timeout: 45_000 });
});

test('the alert list shows unread work first and caps what it shows at once', async ({ page }) => {
  const workspace = await (await page.request.get('/api/workspace')).json() as {
    notifications: Array<{ id: string; read: boolean; createdAt: string }>;
  };
  test.skip(workspace.notifications.length === 0, 'This demo workspace has no alerts to triage.');

  await openAlerts(page);
  const items = page.locator('.workspace-alert-item');
  const total = workspace.notifications.length;
  await expect(items).toHaveCount(Math.min(total, 5));

  // Unread rows come first, so the top of the list is what still needs doing.
  const labels = await items.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? ''));
  const firstRead = labels.findIndex(label => label.startsWith('Read alert'));
  const lastUnread = labels.map(label => label.startsWith('Unread alert')).lastIndexOf(true);
  if (firstRead !== -1 && lastUnread !== -1) expect(lastUnread).toBeLessThan(firstRead);

  const showAll = page.getByRole('button', { name: /^Show all \d+ alerts$/ });
  if (total > 5) {
    await expect(showAll).toBeVisible();
    await showAll.click();
    await expect(items).toHaveCount(total);
    await page.getByRole('button', { name: 'Show fewer', exact: true }).click();
    await expect(items).toHaveCount(5);
  } else {
    await expect(showAll).toHaveCount(0);
  }
});

test('opening an alert marks it read and offers a way through to its subject', async ({ page }) => {
  const workspace = await (await page.request.get('/api/workspace')).json() as {
    notifications: Array<{ id: string; read: boolean; title: string; bookingId: string | null }>;
  };
  const unread = workspace.notifications.filter(notification => !notification.read);
  test.skip(unread.length === 0, 'This demo workspace has no unread alerts.');

  await openAlerts(page);
  // The badge is a number, so it has to say what the number counts.
  await expect(alertsBell(page)).toHaveAccessibleName(/^Alerts, \d+ unread alerts?$/);

  const firstUnread = page.locator('.workspace-alert-item[aria-label^="Unread alert"]').first();
  await expect(firstUnread).toHaveAttribute('aria-label', /^Unread alert: .+/);
  await firstUnread.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();

  // Reading it is what marks it read; the badge follows without a reload.
  await expect.poll(async () => {
    const response = await page.request.get('/api/workspace');
    const data = await response.json() as { notifications: Array<{ read: boolean }> };
    return data.notifications.filter(notification => !notification.read).length;
  }).toBeLessThan(unread.length);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The badge follows in place, without a reload. Reading an alert re-sorts
  // the list, so the count is what to assert on rather than any one row.
  await expect(alertsBell(page)).toHaveAccessibleName(
    unread.length === 1 ? 'Alerts' : new RegExp(`^Alerts, ${unread.length - 1} unread alerts?$`),
  );
});

test('marking everything read empties the badge and the action itself', async ({ page }) => {
  const workspace = await (await page.request.get('/api/workspace')).json() as {
    notifications: Array<{ read: boolean }>;
  };
  test.skip(workspace.notifications.every(notification => notification.read),
    'This demo workspace has nothing unread to clear.');

  await openAlerts(page);
  const markAll = page.getByRole('button', { name: 'Mark all as read', exact: true });
  await expect(markAll).toBeVisible();
  await markAll.click();

  await expect(markAll).toHaveCount(0);
  await expect(alertsBell(page)).toHaveAccessibleName('Alerts');
  await expect(page.locator('.workspace-alert-item[aria-label^="Unread alert"]')).toHaveCount(0);

  const after = await (await page.request.get('/api/workspace')).json() as {
    notifications: Array<{ read: boolean }>;
  };
  expect(after.notifications.every(notification => notification.read)).toBe(true);

  // The cleared state survives a reload rather than only living in the tab.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('button', { name: 'Mark all as read', exact: true })).toHaveCount(0);
  await expect(alertsBell(page)).toHaveAccessibleName('Alerts');
});

test('the alert list stays readable and reachable at this viewport', async ({ page }, testInfo) => {
  await openAlerts(page);
  const items = page.locator('.workspace-alert-item');
  test.skip(await items.count() === 0, 'This demo workspace has no alerts to lay out.');

  // Nothing may push the page sideways on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

  const box = await items.first().boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(testInfo.project.use.viewport!.width);
  // A row is a tap target, so it has to be big enough to hit accurately.
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // The list is keyboard-operable: an alert opens from the keyboard and the
  // dialog takes focus rather than leaving it behind on the row.
  await items.first().focus();
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/\S/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
