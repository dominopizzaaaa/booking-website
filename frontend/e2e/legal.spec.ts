import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const policyPages = [
  ['/legal/privacy', 'Privacy Notice'],
  ['/legal/child-privacy', 'Child Privacy Notice'],
  ['/legal/terms', 'Terms of Service'],
  ['/legal/acceptable-use', 'Acceptable Use & Safeguarding Policy'],
  ['/legal/cancellation-refunds', 'Cancellation & Refund Policy'],
  ['/legal/package-terms', 'Package Terms'],
] as const;

test('legal index exposes every stable policy route', async ({ page }) => {
  await page.goto('/legal');
  await expect(page.getByRole('heading', { name: 'Legal & policies', level: 1 })).toBeVisible();
  for (const [path, name] of policyPages) {
    await expect(page.getByRole('link', { name: new RegExp(name) }).first()).toHaveAttribute('href', path);
  }
  await expect(page.getByText('version 2026-09-29', { exact: false })).toBeVisible();
});

for (const [path, name] of policyPages) {
  test(`${name} is public, versioned, keyboard navigable, and accessible`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(page.locator('#version-information')).toContainText('2026-09-29');
    await expect(page.getByRole('navigation', { name: `Sections in ${name}` })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to policy content' })).toBeFocused();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
      .analyze();
    expect(result.violations).toEqual([]);
  });
}

test('child notice leads with readable privacy and emergency guidance', async ({ page }) => {
  await page.goto('/legal/child-privacy');
  const firstSection = page.locator('#short-version');
  await expect(firstSection.getByRole('heading', { name: 'The short version—for children and young people' })).toBeVisible();
  await expect(firstSection.getByText('Your Courtly profile is about you', { exact: false })).toBeVisible();
  await expect(firstSection.getByText('Courtly’s email is not an emergency service.', { exact: false })).toBeVisible();
});

test('signup requires unticked legal acceptance and links to the exact documents', async ({ page }) => {
  await page.goto('/signup');
  const acceptance = page.getByLabel(/I agree to the Terms of Service/);
  await expect(acceptance).not.toBeChecked();
  await expect(page.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/legal/terms');
  await expect(page.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute('href', '/legal/privacy');
  await page.getByRole('radio', { name: 'Player or guardian' }).check();
  await page.getByLabel('Your full name').fill('Legal Test');
  await page.getByLabel('Username').fill('legal_test');
  await page.getByLabel('Your date of birth').fill('1990-01-01');
  await page.getByLabel('Email address').fill('legal@example.test');
  await page.getByLabel('Password', { exact: true }).fill('TestingOnly!2026');
  await page.getByRole('button', { name: 'Create personal account' }).click();
  await expect(page.locator('#auth-legalAcceptance-error')).toHaveText('Please accept the Terms of Service and acknowledge the Privacy Notice.');
  await expect(acceptance).toBeFocused();
});

test('email verification scrubs a fragment bearer before making its claim request', async ({ page }) => {
  let claimedToken = '';
  let requestUrl = '';
  await page.route('**/api/auth/verify-email', async route => {
    requestUrl = route.request().url();
    claimedToken = (route.request().postDataJSON() as { token?: string }).token || '';
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({
      error: 'This verification link is invalid or has expired', code: 'EMAIL_VERIFICATION_NOT_FOUND',
    }) });
  });

  await page.goto('/account/verify-email#token=fragment_only_token');
  await expect(page).toHaveURL(/\/account\/verify-email$/);
  await expect(page.getByText('This verification link is invalid or no longer available.', { exact: true })).toBeVisible();
  expect(claimedToken).toBe('fragment_only_token');
  expect(requestUrl).not.toContain('fragment_only_token');
  expect(await page.locator('meta[name="referrer"]').getAttribute('content')).toBe('no-referrer');
});
