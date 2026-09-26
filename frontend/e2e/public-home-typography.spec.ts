import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AccountType, AuthSession, PublicBusiness } from '../src/lib/types';

const slug = 'eng-chin-an-private-coaching';

const publicBusiness = {
  business: {
    name: 'Eng Chin An Racket Club',
    slug,
    ownerName: 'Eng Chin An Operations',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
    color: '#174c3c',
    tagline: 'Friendly coaching for every player.',
    cancellationHours: 24,
    kind: 'CLUB',
  },
  instructors: [{
    id: 'eng-chin-an-coach',
    name: 'Casey Coach',
    initials: 'CC',
    color: '#78915e',
    specialty: 'Tennis',
    active: true,
  }],
  locations: [{
    id: 'eng-chin-an-court',
    name: 'Centre Court',
    address: '1 Court Road, Singapore',
    type: 'FACILITY',
    color: '#78915e',
    requiresApproval: false,
    active: true,
  }],
  services: [{
    id: 'eng-chin-an-private',
    name: 'Private tennis class',
    description: 'A focused one-to-one tennis class.',
    category: 'Tennis',
    type: 'PRIVATE',
    duration: 60,
    price: 8_000,
    capacity: 1,
    bufferMinutes: 15,
    noticeHours: 4,
    color: '#78915e',
    active: true,
    locations: [{
      locationId: 'eng-chin-an-court',
      price: 8_000,
      duration: 60,
      instructorIds: ['eng-chin-an-coach'],
    }],
  }],
} satisfies PublicBusiness;

function sessionFor(accountType: AccountType): AuthSession {
  const userId = `eng-chin-an-${accountType.toLowerCase()}`;
  if (accountType === 'STUDENT') {
    return {
      user: {
        id: userId,
        name: 'Sam Student',
        username: 'sam_student',
        email: 'sam.student@example.test',
        accountType,
        sports: ['Tennis'],
        phone: '',
        parentName: '',
      },
      membership: null,
      business: null,
      memberships: [],
    };
  }

  const business = {
    id: 'eng-chin-an-business',
    name: publicBusiness.business.name,
    slug,
    ownerName: publicBusiness.business.ownerName,
    email: 'club@example.test',
    timezone: publicBusiness.business.timezone,
    currency: publicBusiness.business.currency,
    color: publicBusiness.business.color,
    tagline: publicBusiness.business.tagline,
    cancellationHours: publicBusiness.business.cancellationHours,
    kind: 'CLUB' as const,
    isDemo: false,
    legacyReadOnly: false,
  };
  const membership = {
    id: `eng-chin-an-${accountType.toLowerCase()}-membership`,
    userId,
    businessId: business.id,
    instructorId: accountType === 'COACH' ? 'eng-chin-an-coach' : null,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    business,
  };
  return {
    user: {
      id: userId,
      name: accountType === 'COACH' ? 'Casey Coach' : publicBusiness.business.name,
      username: accountType === 'COACH' ? 'casey_coach' : 'eng_chin_an',
      email: accountType === 'COACH' ? 'casey.coach@example.test' : 'club@example.test',
      accountType,
      sports: ['Tennis'],
      phone: '',
      parentName: '',
    },
    membership,
    business,
    memberships: [membership],
  };
}

async function mockLoadedPublicPage(page: Page, accountType: AccountType | null) {
  await page.route(new RegExp(`/api/public/${slug}$`), route => route.fulfill({ json: publicBusiness }));
  await page.route('**/api/auth/me', route => accountType
    ? route.fulfill({ json: sessionFor(accountType) })
    : route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Authentication required' }),
      }));

  await page.goto(`/book/${slug}`);
  await expect(page.getByRole('heading', { name: 'Good days start with a class.', exact: true })).toBeVisible();
}

function expectDestination(page: Page, pathname: string, search = '') {
  return expect(page).toHaveURL(url => url.pathname === pathname && url.search === search);
}

const homeDestinations: Array<{
  accountType: AccountType | null;
  label: string;
  href: string;
  pathname: string;
  search?: string;
}> = [
  {
    accountType: null,
    label: 'anonymous visitors',
    href: `/login?next=%2Fbook%2F${slug}`,
    pathname: '/login',
    search: `?next=%2Fbook%2F${slug}`,
  },
  {
    accountType: 'STUDENT',
    label: 'students',
    href: `/manage?slug=${slug}&tab=home`,
    pathname: '/manage',
    search: `?slug=${slug}&tab=home`,
  },
  { accountType: 'COACH', label: 'coaches', href: '/', pathname: '/' },
  { accountType: 'CLUB', label: 'clubs', href: '/', pathname: '/' },
];

for (const destination of homeDestinations) {
  test(`Back to Courtly sends ${destination.label} to their proper home`, async ({ page }) => {
    await mockLoadedPublicPage(page, destination.accountType);

    const back = page.getByRole('link', { name: 'Back to Courtly', exact: true });
    await expect(back).toHaveAttribute('href', destination.href);
    await back.click();
    await expectDestination(page, destination.pathname, destination.search);
  });
}

async function computedFontSize(locator: Locator) {
  return locator.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
}

test('loaded public booking typography and the home link keep their accessibility floors', async ({ page }) => {
  await mockLoadedPublicPage(page, null);

  const bodySize = await computedFontSize(page.locator('body'));
  expect(bodySize, 'body copy should remain at least 16px').toBeGreaterThanOrEqual(16);

  const classControl = page.getByRole('button', { name: /Private tennis class/ });
  const controlSize = await computedFontSize(classControl);
  const mobile = (page.viewportSize()?.width ?? 1440) < 640;
  expect(
    controlSize,
    `booking controls should remain at least ${mobile ? 16 : 14}px at this viewport`,
  ).toBeGreaterThanOrEqual(mobile ? 16 : 14);

  const caption = page.getByText('Step 1 of 5 · Class', { exact: true });
  expect(
    await computedFontSize(caption),
    'tiny utility classes should be remapped to the 12px caption floor',
  ).toBeGreaterThanOrEqual(12);

  const back = page.getByRole('link', { name: 'Back to Courtly', exact: true });
  const target = await back.boundingBox();
  expect(target).not.toBeNull();
  expect(target!.width, 'Back to Courtly should be at least 44px wide').toBeGreaterThanOrEqual(44);
  expect(target!.height, 'Back to Courtly should be at least 44px tall').toBeGreaterThanOrEqual(44);
});
