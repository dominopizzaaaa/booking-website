import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  AccountCapabilities,
  AuthSession,
  FamilyChild,
  FamilyConsentRenewalChild,
  FamilyResponse,
} from '../src/lib/types';

const capabilities: AccountCapabilities = {
  ordinaryAccess: true, familyManagement: true, payments: true, staffAccess: true,
  directory: true, chat: true, commerce: true, rentals: true, calendar: true,
  workspace: true, profileEdit: true,
};
const guardianSession: AuthSession = {
  user: {
    id: 'guardian-1', name: 'Avery Guardian', legalName: 'Avery Guardian',
    username: 'avery_guardian', email: 'avery@example.test', accountType: 'STUDENT',
    sports: [], phone: '', parentName: '', dateOfBirth: '1988-04-12',
    accountControl: 'SELF', accountStatus: 'ACTIVE', profileVisibility: 'PUBLIC',
    ageBand: 'ADULT', needsAgeReview: false, requiredAction: null, capabilities,
  },
  membership: null, business: null, memberships: [], accessMode: 'NONE',
};

function child(id: string, displayName: string, overrides: Partial<FamilyChild> = {}): FamilyChild {
  return {
    id, legalName: `${displayName} Tan`, displayName, username: `${displayName.toLowerCase()}_tan`,
    dateOfBirth: '2012-04-12', sports: ['Tennis'], profileVisibility: 'CLUBS_ONLY',
    accountControl: 'GUARDIAN_MANAGED', accountStatus: 'ACTIVE', ageBand: 'TEEN',
    requiredAction: null,
    link: {
      id: `link-${id}`, status: 'ACTIVE', relationshipType: 'Parent',
      permissions: ['PROFILE_MANAGE', 'PRIVACY_MANAGE', 'DATA_EXPORT', 'CONSENT_MANAGE', 'DELETION_REQUEST', 'HANDOVER_MANAGE'],
      createdAt: '2026-09-01T00:00:00.000Z', endedAt: null,
    },
    consent: {
      status: 'GRANTED', policyVersion: '2026-09-29', consentedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: null, withdrawnAt: null,
    },
    handover: null, deletionRequestedAt: null,
    ...overrides,
  };
}

function renewalChild(id = 'renewal-child'): FamilyConsentRenewalChild {
  return {
    id, displayName: 'Riley', access: 'CONSENT_RENEWAL',
    link: { id: `link-${id}`, status: 'WITHDRAWN', relationshipType: 'Parent' },
    consent: {
      status: 'WITHDRAWN', policyVersion: '2026-09-29', consentedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: null, withdrawnAt: '2026-09-20T00:00:00.000Z',
    },
  };
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', json });
}

async function mockFamily(page: Page, current: () => FamilyResponse, session = guardianSession) {
  await page.route(/\/api\/auth\/me$/, route => fulfillJson(route, session));
  await page.route(/\/api\/family$/, route => fulfillJson(route, current()));
}

async function expectNoOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual(expect.objectContaining({ clientWidth: 390, scrollWidth: 390 }));
}

test('empty Family supports keyboard-safe add validation and an in-dialog API error on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let family: FamilyResponse = {
    guardian: { eligible: true, reason: null }, children: [],
    privacyPolicyVersion: '2026-09-29', handoverAvailable: true,
  };
  await mockFamily(page, () => family);
  let attempts = 0;
  await page.route(/\/api\/family\/children$/, async route => {
    attempts += 1;
    if (attempts === 1) return fulfillJson(route, { error: 'That username is already in use.' }, 409);
    const created = child('new-child', 'Riley', { username: 'riley_junior', dateOfBirth: '2018-05-04' });
    family = { ...family, children: [created] };
    return fulfillJson(route, { child: created }, 201);
  });

  await page.goto('/family');
  await expect(page.getByRole('heading', { name: 'No children added yet' })).toBeVisible();
  await expectNoOverflow(page);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);

  await page.getByRole('button', { name: 'Add child' }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Add a child' });
  await dialog.getByRole('button', { name: 'Add child' }).click();
  await expect(dialog.getByRole('alert')).toContainText('legal name and display name');
  await expect(dialog.getByRole('alert')).toBeFocused();

  await dialog.getByLabel('Legal name').fill('Riley Tan');
  await dialog.getByLabel('Display name').fill('Riley');
  await dialog.getByLabel('Username').fill('riley_junior');
  await dialog.getByLabel('Date of birth').fill('2018-05-04');
  await dialog.getByLabel('Your relationship to this child').fill('Parent');
  await dialog.getByLabel(/I confirm that I am this child/).check();
  await dialog.getByLabel(/I consent to the current child privacy policy/).check();
  await dialog.getByRole('button', { name: 'Add child' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('That username is already in use.');
  await expect(dialog.getByRole('alert')).toBeFocused();

  await dialog.getByRole('button', { name: 'Add child' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Riley was added to Family.' });
  await expect(notice).toBeVisible();
  await expect(notice).toBeFocused();
  await expectNoOverflow(page);
});

test('multiple children keep consent-only rows private and obey per-link permissions', async ({ page }) => {
  let renewal = renewalChild();
  const profileOnly = child('profile-only', 'Morgan', {
    link: {
      id: 'link-profile-only', status: 'ACTIVE', relationshipType: 'Guardian',
      permissions: ['PROFILE_MANAGE'], createdAt: '2026-09-01T00:00:00.000Z', endedAt: null,
    },
  });
  const full = child('full-child', 'Taylor');
  const response = (): FamilyResponse => ({
    guardian: { eligible: true, reason: null }, children: [renewal, profileOnly, full],
    privacyPolicyVersion: '2026-09-29', handoverAvailable: true,
  });
  await mockFamily(page, response);
  await page.route(/\/api\/family\/children\/renewal-child\/consent\/renew$/, async route => {
    expect(route.request().postDataJSON()).toEqual({
      legalGuardianConfirmed: true, privacyPolicyVersion: '2026-09-29',
    });
    renewal = {
      ...renewal, link: { ...renewal.link, status: 'ACTIVE' },
      consent: {
        status: 'RENEWED', policyVersion: '2026-09-29', consentedAt: '2026-09-29T00:00:00.000Z',
        expiresAt: null, withdrawnAt: null,
      },
    };
    await fulfillJson(route, { child: renewal });
  });

  await page.goto('/family');
  const renewalCard = page.getByRole('article', { name: 'Riley' });
  await expect(renewalCard).toContainText('privacy-minimal');
  await expect(renewalCard.getByText('@riley_tan')).toHaveCount(0);
  await expect(renewalCard.getByRole('button', { name: 'Renew consent' })).toBeVisible();
  await expect(renewalCard.getByRole('button', { name: /Edit|Export|deletion|handover/i })).toHaveCount(0);

  const profileCard = page.getByRole('article', { name: 'Morgan' });
  await expect(profileCard.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(profileCard.getByRole('button', { name: /Export|Withdraw consent|Start handover|Request deletion/ })).toHaveCount(0);

  await renewalCard.getByRole('button', { name: 'Renew consent' }).click();
  const renewDialog = page.getByRole('dialog', { name: 'Renew guardian consent?' });
  await renewDialog.getByRole('button', { name: 'Renew consent' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Consent renewed for Riley.' })).toBeFocused();
  await expect(page.getByRole('article', { name: 'Riley' })).toContainText('Consent current');
});

test('handover follows server age bands and availability while deletion copy promises review, not erasure', async ({ page }) => {
  const family: FamilyResponse = {
    guardian: { eligible: true, reason: null },
    children: [
      child('young-child', 'Young', { ageBand: 'CHILD' }),
      child('teen-child', 'Teen', { ageBand: 'TEEN' }),
      child('adult-child', 'Adult', { ageBand: 'ADULT' }),
    ],
    privacyPolicyVersion: '2026-09-29', handoverAvailable: false,
  };
  await mockFamily(page, () => family);
  await page.goto('/family');

  await expect(page.getByRole('article', { name: 'Young' }).getByRole('button', { name: 'Start handover' })).toHaveCount(0);
  for (const name of ['Teen', 'Adult']) {
    const card = page.getByRole('article', { name });
    await expect(card.getByRole('button', { name: 'Start handover' })).toBeDisabled();
    await expect(card).toContainText('Secure account handover is unavailable right now. Try again later.');
  }

  await page.getByRole('article', { name: 'Teen' }).getByRole('button', { name: 'Request deletion' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request profile deletion?' });
  await expect(dialog).toContainText('restricted immediately');
  await expect(dialog).toContainText('separate human-reviewed');
  await expect(dialog).toContainText('does not instantly erase');
});

test('required-action remediation trusts the server capability and avoids an under-13 Family loop', async ({ page }) => {
  let familyRequests = 0;
  const restricted: AuthSession = {
    ...guardianSession,
    user: {
      ...guardianSession.user, dateOfBirth: '2018-04-12', ageBand: 'CHILD',
      requiredAction: 'PARENT_ACCOUNT_REQUIRED',
      capabilities: { ...capabilities, ordinaryAccess: false, familyManagement: false, payments: false, staffAccess: false, directory: false, chat: false, commerce: false, rentals: false, calendar: false, workspace: false },
    },
  };
  await page.route(/\/api\/auth\/me$/, route => fulfillJson(route, restricted));
  await page.route(/\/api\/family$/, route => { familyRequests += 1; return fulfillJson(route, {}); });

  await page.goto('/account/action-required');
  await expect(page.getByRole('heading', { name: 'A parent or guardian must create this profile' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Open Family/ })).toHaveCount(0);

  await page.goto('/family');
  await expect(page).toHaveURL(/\/account\/action-required$/);
  await expect(page.getByRole('heading', { name: 'A parent or guardian must create this profile' })).toBeVisible();
  expect(familyRequests).toBe(0);
});

test('direct Family access fails closed when the server omits the capability', async ({ page }) => {
  let familyRequests = 0;
  const oldSession: AuthSession = {
    ...guardianSession, user: { ...guardianSession.user, capabilities: undefined },
  };
  await page.route(/\/api\/auth\/me$/, route => fulfillJson(route, oldSession));
  await page.route(/\/api\/family$/, route => { familyRequests += 1; return fulfillJson(route, {}); });
  await page.goto('/family');
  await expect(page.getByRole('heading', { name: 'Family is unavailable' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'not available for this account' })).toBeVisible();
  expect(familyRequests).toBe(0);
});
