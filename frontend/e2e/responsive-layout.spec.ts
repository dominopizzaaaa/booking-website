import { expect, test, type Page } from '@playwright/test';

// A sweep rather than a journey: every screen a person can land on, checked
// for the things that make a page unusable regardless of what it is for —
// sideways scrolling, a runtime error, an unreachable heading, or a control
// too small to hit on a phone. The three Playwright projects supply the
// viewports, so this file is written once and runs at each width.

const password = 'TestingOnly!2026';

function uniqueEmail(prefix: string, projectName: string) {
  const project = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${prefix}-${project}-${Date.now()}@example.test`;
}

/**
 * Uncaught exceptions only. A handled 401 or 404 still prints a console error
 * in Chromium, and those are ordinary signed-out and not-found paths that the
 * app is expected to render rather than faults.
 */
function watchForErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth };
  });
}

/** Everything a viewer can actually reach has to fit the screen they have. */
async function expectNoSidewaysScroll(page: Page) {
  const { scrollWidth, innerWidth } = await horizontalOverflow(page);
  expect(scrollWidth, `page is ${scrollWidth - innerWidth}px wider than the viewport`)
    .toBeLessThanOrEqual(innerWidth + 1);
}

// Several pages carry a desktop-only marketing heading that is hidden at
// phone widths, so this asserts on the first heading actually shown.
async function expectReachableHeading(page: Page) {
  const heading = page.locator('h1:visible, [role="heading"][aria-level="1"]:visible').first();
  await expect(heading).toBeVisible();
  await expect(heading).not.toHaveText('');
}

/**
 * On a phone, a primary control must be large enough to hit without aiming.
 * 44px is the long-standing touch-target floor both platforms publish.
 */
async function expectUsableTapTargets(page: Page, isPhone: boolean) {
  if (!isPhone) return;
  const navigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  if (!(await navigation.isVisible())) return;
  const buttons = navigation.getByRole('button');
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const box = await buttons.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height, `nav control ${index} is only ${box!.height}px tall`).toBeGreaterThanOrEqual(44);
    expect(box!.width, `nav control ${index} is only ${box!.width}px wide`).toBeGreaterThanOrEqual(44);
  }
}

async function checkScreen(page: Page, isPhone: boolean) {
  await expectReachableHeading(page);
  await expectNoSidewaysScroll(page);
  await expectUsableTapTargets(page, isPhone);
}

test.describe('every screen fits the screen it is on', () => {
  test('the signed-out entry points', async ({ page }, testInfo) => {
    const isPhone = testInfo.project.name.startsWith('phone');
    const errors = watchForErrors(page);

    for (const path of ['/login', '/signup']) {
      await page.goto(path);
      await checkScreen(page, isPhone);
      // A form on a phone must not need a sideways swipe to reach its fields.
      const email = page.getByLabel('Email address', { exact: true });
      await expect(email).toBeVisible();
      const box = await email.boundingBox();
      expect(box!.width).toBeLessThanOrEqual(testInfo.project.use.viewport!.width);
    }

    await page.goto('/admin');
    await expectNoSidewaysScroll(page);
    await expect(page.locator('h1, h2').first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('the provider workspace, across its primary tabs', async ({ page }, testInfo) => {
    const isPhone = testInfo.project.name.startsWith('phone');
    const errors = watchForErrors(page);
    const demo = await page.request.post('/api/auth/demo', { data: {} });
    expect(demo.ok()).toBeTruthy();

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible({ timeout: 45_000 });
    await checkScreen(page, isPhone);

    for (const tab of ['Explore', 'Chat', 'Profile'] as const) {
      const navigation = isPhone
        ? page.getByRole('navigation', { name: 'Mobile navigation' })
        : page.getByRole('navigation', { name: 'Primary' });
      await navigation.getByRole('button', { name: new RegExp(`^${tab}`) }).click();
      await expect(page).toHaveURL(new RegExp(`tab=${tab.toLowerCase()}`));
      await checkScreen(page, isPhone);
    }
    // Alerts sit behind the bell in the top bar at every width.
    await page.getByRole('banner').getByRole('button', { name: /^Alerts/ }).click();
    await expect(page).toHaveURL(/tab=alerts/);
    await checkScreen(page, isPhone);

    expect(errors).toEqual([]);
  });

  test('the public booking page and the student app', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const isPhone = testInfo.project.name.startsWith('phone');
    const errors = watchForErrors(page);

    const demo = await page.request.post('/api/auth/demo', { data: {} });
    expect(demo.ok()).toBeTruthy();
    const workspace = await (await page.request.get('/api/workspace')).json() as { business: { slug: string } };
    const slug = workspace.business.slug;
    expect(await (await page.request.post('/api/auth/logout', { data: {} })).ok()).toBeTruthy();

    // A booking page is the first thing a prospective student ever sees, and
    // they see it on a phone.
    await page.goto(`/book/${slug}`);
    await expect(page.getByRole('heading', { name: 'Good days start with a class.', exact: true }))
      .toBeVisible({ timeout: 45_000 });
    await expectNoSidewaysScroll(page);

    const studentEmail = uniqueEmail('layout-student', testInfo.project.name);
    await page.goto('/signup');
    const accountTypes = page.getByRole('group', { name: 'I’m joining Courtly as', exact: true });
    await accountTypes.getByRole('radio', { name: 'Student', exact: true }).check();
    await page.getByLabel('Your full name', { exact: true }).fill('Layout Student');
    await page.getByLabel('Username', { exact: true }).fill(`rls_${studentEmail.split('@')[0].replace(/-/g, '_').slice(-26)}`);
    await page.getByLabel('Email address', { exact: true }).fill(studentEmail);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Create student account', exact: true }).click();

    await expect(page).toHaveURL(url => url.pathname === '/manage');
    await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
    await checkScreen(page, isPhone);

    const studentNavigation = page.getByRole('navigation', { name: 'Student navigation' });
    if (await studentNavigation.isVisible()) {
      const tabs = studentNavigation.getByRole('button');
      for (let index = 0; index < await tabs.count(); index++) {
        await tabs.nth(index).click();
        await expectNoSidewaysScroll(page);
        await expectReachableHeading(page);
      }
    }

    await page.goto('/account');
    await expectReachableHeading(page);
    await expectNoSidewaysScroll(page);

    expect(errors).toEqual([]);
  });

  test('a booking page that does not exist explains itself without breaking the layout', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/book/no-such-club-anywhere');
    await expect(page.getByText(/couldn|not found|unavailable/i).first()).toBeVisible({ timeout: 45_000 });
    await expectNoSidewaysScroll(page);
    expect(errors).toEqual([]);
  });
});
