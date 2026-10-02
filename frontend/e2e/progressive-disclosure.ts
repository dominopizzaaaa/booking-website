import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Secondary content sits in the shared `Disclosure` (a native `details`) and
 * long lists stop at a few items behind "See N more …". Journeys that need
 * that content open it the way a person would, instead of assuming it is
 * already on screen.
 */

/** Open the collapsed disclosure whose summary carries `title`; a no-op when open. */
export async function openDisclosure(scope: Page | Locator, title: string) {
  const summary = scope.locator('summary').filter({ hasText: title }).first();
  await expect(summary).toBeVisible();
  const details = summary.locator('xpath=..');
  if (await details.getAttribute('open') === null) await summary.click();
  await expect(details).toHaveAttribute('open', '');
}

/**
 * Make a choice in a bounded list visible, expanding "See N more …" lists
 * until it appears, and return it for the caller to act on.
 */
export async function revealChoice(scope: Page | Locator, choice: Locator) {
  const more = scope.getByRole('button', { name: /^See \d+ more\b/ }).filter({ visible: true });
  await expect(choice.or(more).first()).toBeVisible();
  while (!await choice.isVisible() && await more.count()) {
    await more.first().click();
  }
  await expect(choice).toBeVisible();
  return choice;
}
