import { expect, test, type APIResponse, type Locator, type Page, type Response } from '@playwright/test';
import type { AdminBusiness, AdminOverview } from '../src/lib/api';
import type { LessonPackage, ManagerWorkspace, Payment } from '../src/lib/types';

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function uniqueValue(prefix: string, projectName: string) {
  return `${prefix} ${projectId(projectName)} ${Date.now()}`;
}

function futureSingaporeDate(days = 120) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency: 'SGD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

async function responseJson<T>(response: APIResponse | Response): Promise<T> {
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* Keep a non-JSON server error readable. */ }
  expect(response.ok(), typeof body === 'string' ? body : JSON.stringify(body)).toBeTruthy();
  return body as T;
}

function outstandingCount(workspace: ManagerWorkspace) {
  const bookings = workspace.bookings
    .filter(booking => booking.status !== 'CANCELLED')
    .flatMap(booking => booking.participants)
    .filter(participant => !participant.paid && !participant.packageId && participant.price > 0);
  const packages = workspace.packages.filter(pkg => !pkg.paid && pkg.price > 0);
  return bookings.length + packages.length;
}

function financeRecord(page: Page, text: string): Locator {
  const records = page.getByRole('region', { name: 'Payment records' });
  return (page.viewportSize()?.width ?? 1440) < 640
    ? records.locator('article').filter({ hasText: text })
    : records.locator('tbody tr').filter({ hasText: text });
}

function adminBusiness(page: Page, name: string): Locator {
  return (page.viewportSize()?.width ?? 1440) < 768
    ? page.getByRole('listitem').filter({ hasText: name })
    : page.getByRole('row').filter({ hasText: name });
}

function moneyStat(page: Page, label: string): Locator {
  return page.locator('article.stat-card').filter({ hasText: label });
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('a club receipt can be reversed without erasing its ledger trail or mixing in coach payouts', async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));
  const initial = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  expect(initial.business.kind).toBe('CLUB');

  const student = initial.students[0];
  const coach = initial.instructors.find(instructor => instructor.active);
  expect(student).toBeTruthy();
  expect(coach).toBeTruthy();

  const initialOutstanding = outstandingCount(initial);
  const initialCollected = initial.payments
    .filter(payment => !payment.reversedAt && payment.kind !== 'CLUB_TO_COACH')
    .reduce((sum, payment) => sum + payment.amount, 0);
  const initialPaidOut = initial.payments
    .filter(payment => !payment.reversedAt && payment.kind === 'CLUB_TO_COACH')
    .reduce((sum, payment) => sum + payment.amount, 0);
  const packageName = uniqueValue('Reversal package', testInfo.project.name);
  const packagePrice = 43_210;
  const expiryDate = futureSingaporeDate();

  await page.goto('/?tab=explore&view=students');
  await expect(page.locator('main').getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `View ${student.name}'s profile`, exact: true }).first().click();
  const studentProfile = page.getByRole('dialog', { name: student.name, exact: true });
  await studentProfile.getByRole('button', { name: 'Sell package', exact: true }).click();

  const packageDialog = page.getByRole('dialog');
  await expect(packageDialog.getByRole('heading', { name: 'Sell a class package', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(packageDialog.getByLabel('Student', { exact: true })).toHaveValue(student.id);
  // Field's generated input id is intentionally opaque; its stable form name
  // is the contract the submit handler reads.
  await packageDialog.locator('input[name="name"]').fill(packageName);
  await packageDialog.locator('input[name="totalCredits"]').fill('6');
  await packageDialog.locator('input[name="price"]').fill((packagePrice / 100).toFixed(2));
  await packageDialog.locator('input[name="expiresAt"]').fill(expiryDate);
  await expect(packageDialog.getByRole('checkbox', { name: /^Payment already received/ })).not.toBeChecked();

  const packageResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/packages',
  );
  await packageDialog.getByRole('button', { name: 'Create package', exact: true }).click();
  const packageResponse = await packageResponsePromise;
  const pkg = await responseJson<LessonPackage>(packageResponse);
  expect(packageResponse.request().postDataJSON()).toEqual({
    studentId: student.id,
    name: packageName,
    serviceId: null,
    totalCredits: 6,
    price: packagePrice,
    expiresAt: new Date(`${expiryDate}T23:59:59+08:00`).toISOString(),
    paid: false,
  });
  expect(pkg).toMatchObject({
    studentId: student.id,
    studentName: student.name,
    name: packageName,
    totalCredits: 6,
    usedCredits: 0,
    price: packagePrice,
    paid: false,
  });
  expect(pkg.expiresAt).toBe(new Date(`${expiryDate}T23:59:59+08:00`).toISOString());
  await expect(page.getByText('Package created', { exact: true })).toBeVisible();
  await expect(packageDialog).toHaveCount(0);

  await page.goto('/?tab=explore&view=packages');
  await expect(page.locator('main').getByRole('heading', { name: 'Package offers', exact: true })).toBeVisible();
  let packageCard = page.locator('main article').filter({ hasText: packageName });
  await expect(packageCard).toContainText(student.name);
  await expect(packageCard).toContainText(formatMoney(packagePrice));
  await expect(packageCard.getByText('Payment due', { exact: true }).first()).toBeVisible();
  await expect(packageCard.getByText('Paid', { exact: true })).toHaveCount(0);
  await expect(packageCard.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0);
  await expect(packageCard.getByRole('progressbar', { name: `${packageName} used credits` })).toHaveAttribute('aria-valuenow', '0');

  await page.goto('/?tab=explore&view=payments');
  await expect(page.locator('main').getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  const outstandingAfterSale = page.getByRole('tab', { name: `Outstanding (${initialOutstanding + 1})`, exact: true });
  await expect(outstandingAfterSale).toBeVisible();
  await outstandingAfterSale.click();

  const outstandingPackage = financeRecord(page, packageName);
  await expect(outstandingPackage).toContainText(student.name);
  await expect(outstandingPackage).toContainText(formatMoney(packagePrice));
  await outstandingPackage.getByRole('button', { name: 'Record payment', exact: true }).click();

  const paymentDialog = page.getByRole('dialog');
  await expect(paymentDialog.getByRole('heading', { name: 'Record a payment', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(paymentDialog.getByLabel('Student', { exact: true })).toHaveValue(student.id);
  await expect(paymentDialog.getByLabel('Payment for', { exact: true })).toHaveValue(`package:${pkg.id}`);
  const exactAmount = paymentDialog.getByLabel('Exact amount (SGD)', { exact: true });
  await expect(exactAmount).toHaveValue((packagePrice / 100).toFixed(2));
  await expect(exactAmount).not.toBeEditable();
  await paymentDialog.getByLabel('Payment method', { exact: true }).selectOption('CASH');
  const receiptNote = uniqueValue('Package receipt', testInfo.project.name);
  await paymentDialog.getByLabel('Reference or note (optional)', { exact: true }).fill(receiptNote);

  const paymentResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/payments',
  );
  await paymentDialog.getByRole('button', { name: 'Record payment', exact: true }).click();
  const paymentResponse = await paymentResponsePromise;
  const payment = await responseJson<Payment>(paymentResponse);
  expect(paymentResponse.request().postDataJSON()).toEqual({
    studentId: student.id,
    packageId: pkg.id,
    amount: packagePrice,
    method: 'CASH',
    note: receiptNote,
  });
  expect(payment).toMatchObject({
    kind: 'STUDENT_TO_CLUB',
    studentId: student.id,
    studentName: student.name,
    instructorId: null,
    instructorName: null,
    bookingId: null,
    packageId: pkg.id,
    amount: packagePrice,
    method: 'CASH',
    note: receiptNote,
    reversedAt: null,
  });
  await expect(page.getByText('Payment recorded', { exact: true })).toBeVisible();
  await expect(paymentDialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: `Outstanding (${initialOutstanding})`, exact: true })).toBeVisible();
  await expect(moneyStat(page, 'Collected from students')).toContainText(formatMoney(initialCollected + packagePrice));

  await page.getByRole('tab', { name: 'Payment history', exact: true }).click();
  let receiptRecord = financeRecord(page, receiptNote);
  await expect(receiptRecord).toContainText(student.name);
  await expect(receiptRecord).toContainText('Student → club');
  await expect(receiptRecord).toContainText(formatMoney(packagePrice));
  await expect(receiptRecord).not.toContainText('Reversed');

  await page.goto('/?tab=explore&view=packages');
  packageCard = page.locator('main article').filter({ hasText: packageName });
  await expect(packageCard.getByText('Paid', { exact: true })).toBeVisible();
  await expect(packageCard.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0);

  await page.goto('/?tab=explore&view=payments');
  await expect(page.locator('main').getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  receiptRecord = financeRecord(page, receiptNote);
  const reason = 'E2E correction keeps the audit record';
  const promptPromise = page.waitForEvent('dialog');
  const undoClick = receiptRecord.getByRole('button', { name: 'Undo', exact: true }).click();
  const prompt = await promptPromise;
  expect(prompt.type()).toBe('prompt');
  expect(prompt.message()).toBe('Reverse this payment? Say briefly why, for the ledger.');
  const reversalResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === `/api/payments/${payment.id}`,
  );
  await prompt.accept(reason);
  await undoClick;
  const reversalResponse = await reversalResponsePromise;
  const reversal = await responseJson<{ ok: true; payment: Payment }>(reversalResponse);
  expect(reversalResponse.request().postDataJSON()).toEqual({ reason });
  expect(reversal.payment).toMatchObject({
    id: payment.id,
    kind: 'STUDENT_TO_CLUB',
    studentId: student.id,
    instructorId: null,
    bookingId: null,
    packageId: pkg.id,
    amount: packagePrice,
    method: 'CASH',
    note: receiptNote,
    reversedReason: reason,
  });
  expect(reversal.payment.reversedAt).toBeTruthy();

  await expect(page.getByText('Payment reversed', { exact: true }).last()).toBeVisible();
  receiptRecord = financeRecord(page, receiptNote);
  await expect(receiptRecord).toContainText('Reversed');
  await expect(receiptRecord.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await expect(moneyStat(page, 'Collected from students')).toContainText(formatMoney(initialCollected));

  await page.goto('/?tab=explore&view=packages');
  packageCard = page.locator('main article').filter({ hasText: packageName });
  await expect(packageCard.getByText('Payment due', { exact: true }).first()).toBeVisible();
  await expect(packageCard.getByText('Paid', { exact: true })).toHaveCount(0);
  await expect(packageCard.getByRole('button', { name: 'Record payment', exact: true })).toHaveCount(0);
  const afterReversal = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  expect(afterReversal.packages.find(candidate => candidate.id === pkg.id)?.paid).toBe(false);
  expect(afterReversal.payments.find(candidate => candidate.id === payment.id)).toMatchObject({
    reversedReason: reason,
  });
  expect(afterReversal.payments.find(candidate => candidate.id === payment.id)?.reversedAt).toBeTruthy();

  await page.goto('/?tab=explore&view=payments');
  const outstandingAfterReversal = page.getByRole('tab', { name: `Outstanding (${initialOutstanding + 1})`, exact: true });
  await expect(outstandingAfterReversal).toBeVisible();
  await outstandingAfterReversal.click();
  await expect(financeRecord(page, packageName).getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Payment history', exact: true }).click();
  await expect(moneyStat(page, 'Collected from students')).toContainText(formatMoney(initialCollected));
  await page.getByRole('button', { name: 'Record coach payout', exact: true }).click();
  const payoutDialog = page.getByRole('dialog');
  await expect(payoutDialog.getByRole('heading', { name: 'Record a coach payout', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await payoutDialog.getByLabel('Coach', { exact: true }).selectOption(coach!.id);
  const payoutAmount = 13_725;
  const payoutNote = uniqueValue('Coach-only payout', testInfo.project.name);
  await payoutDialog.locator('input[name="amount"]').fill((payoutAmount / 100).toFixed(2));
  await payoutDialog.getByLabel('Payment method', { exact: true }).selectOption('BANK_TRANSFER');
  await payoutDialog.getByLabel('Reference or period (optional)', { exact: true }).fill(payoutNote);

  const payoutResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/payouts',
  );
  await payoutDialog.getByRole('button', { name: 'Record payout', exact: true }).click();
  const payoutResponse = await payoutResponsePromise;
  const payout = await responseJson<Payment>(payoutResponse);
  expect(payoutResponse.request().postDataJSON()).toEqual({
    instructorId: coach!.id,
    amount: payoutAmount,
    method: 'BANK_TRANSFER',
    note: payoutNote,
  });
  expect(payout).toMatchObject({
    kind: 'CLUB_TO_COACH',
    studentId: null,
    studentName: null,
    instructorId: coach!.id,
    instructorName: coach!.name,
    bookingId: null,
    packageId: null,
    amount: payoutAmount,
    method: 'BANK_TRANSFER',
    note: payoutNote,
    reversedAt: null,
  });
  await expect(page.getByText('Coach payout recorded', { exact: true })).toBeVisible();
  await expect(payoutDialog).toHaveCount(0);
  await expect(moneyStat(page, 'Collected from students')).toContainText(formatMoney(initialCollected));
  await expect(moneyStat(page, 'Paid to coaches')).toContainText(formatMoney(initialPaidOut + payoutAmount));
  await expect(page.getByRole('tab', { name: `Outstanding (${initialOutstanding + 1})`, exact: true })).toBeVisible();

  let payoutRecord = financeRecord(page, payoutNote);
  await expect(payoutRecord).toContainText(coach!.name);
  await expect(payoutRecord).toContainText('Coach payout');
  await expect(payoutRecord).toContainText('Club → coach');
  await expect(payoutRecord).toContainText(formatMoney(payoutAmount));

  const payoutReason = 'E2E payout correction keeps the audit record';
  const payoutPromptPromise = page.waitForEvent('dialog');
  const payoutUndoClick = payoutRecord.getByRole('button', { name: 'Undo', exact: true }).click();
  const payoutPrompt = await payoutPromptPromise;
  expect(payoutPrompt.type()).toBe('prompt');
  expect(payoutPrompt.message()).toBe('Reverse this payment? Say briefly why, for the ledger.');
  const payoutReversalResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === `/api/payments/${payout.id}`,
  );
  await payoutPrompt.accept(payoutReason);
  await payoutUndoClick;
  const payoutReversalResponse = await payoutReversalResponsePromise;
  const payoutReversal = await responseJson<{ ok: true; payment: Payment }>(payoutReversalResponse);
  expect(payoutReversalResponse.request().postDataJSON()).toEqual({ reason: payoutReason });
  expect(payoutReversal.payment).toMatchObject({
    id: payout.id,
    kind: 'CLUB_TO_COACH',
    studentId: null,
    instructorId: coach!.id,
    bookingId: null,
    packageId: null,
    amount: payoutAmount,
    method: 'BANK_TRANSFER',
    note: payoutNote,
    reversedReason: payoutReason,
  });
  expect(payoutReversal.payment.reversedAt).toBeTruthy();

  await expect(page.getByText('Payment reversed', { exact: true }).last()).toBeVisible();
  payoutRecord = financeRecord(page, payoutNote);
  await expect(payoutRecord).toContainText('Reversed');
  await expect(payoutRecord.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await expect(moneyStat(page, 'Collected from students')).toContainText(formatMoney(initialCollected));
  await expect(moneyStat(page, 'Paid to coaches')).toContainText(formatMoney(initialPaidOut));
  await expect(page.getByRole('tab', { name: `Outstanding (${initialOutstanding + 1})`, exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('the admin route explains how to enable an unconfigured console', async ({ page }) => {
  await page.route('**/api/admin/session', route => route.fulfill({
    json: { configured: false, authenticated: false },
  }));

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin console not configured', exact: true })).toBeVisible();
  await expect(page.locator('main')).toContainText('ADMIN_PASSWORD');
  await expect(page.getByLabel('Admin password', { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('an expired admin session returns to sign in and can be signed out explicitly', async ({ page }) => {
  let sessionExpired = false;
  let authenticated = true;
  const logoutRequests: Array<{ method: string; body: unknown }> = [];

  await page.route('**/api/admin/session', route => route.fulfill({
    json: { configured: true, authenticated },
  }));
  await page.route('**/api/admin/overview', route => route.fulfill(sessionExpired
    ? { status: 401, json: { error: 'Admin session expired' } }
    : {
        json: {
          generatedAt: '2026-09-19T08:00:00.000Z',
          totals: {
            businesses: 0, demoBusinesses: 0, realBusinesses: 0, users: 0, memberships: 0, students: 0,
            bookings: 0, upcomingBookings: 0, bookingsLast7Days: 0, packages: 0, paymentsCount: 0, paymentsTotal: 0,
          },
        } satisfies AdminOverview,
      }));
  await page.route(/\/api\/admin\/businesses(?:\?.*)?$/, route => route.fulfill({ json: { businesses: [] } }));
  await page.route('**/api/admin/logout', route => {
    logoutRequests.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    authenticated = false;
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Every workspace, at a glance', exact: true })).toBeVisible();
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await signOut.click();
  await expect(page.getByRole('heading', { name: 'Admin sign in', exact: true })).toBeVisible();
  expect(logoutRequests).toEqual([{ method: 'POST', body: {} }]);

  authenticated = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Every workspace, at a glance', exact: true })).toBeVisible();
  await expect(page.getByText('No businesses match your filters yet.', { exact: true })).toBeVisible();
  sessionExpired = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Admin sign in', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('an older delayed admin business response cannot overwrite newer filters', async ({ page }) => {
  const counts = { users: 1, students: 3, bookings: 4, locations: 2, services: 2, instructors: 1 };
  const realBusiness: AdminBusiness = {
    id: 'real-alpha',
    name: 'Alpha Academy',
    slug: 'alpha-academy',
    ownerName: 'Alex Owner',
    email: 'alex@alpha.example',
    currency: 'SGD',
    timezone: 'Asia/Singapore',
    isDemo: false,
    createdAt: '2026-09-10T08:00:00.000Z',
    counts,
  };
  const demoBusiness: AdminBusiness = {
    id: 'demo-alpha',
    name: 'Alpha Demo Club',
    slug: 'alpha-demo-club',
    ownerName: 'Demi Coach',
    email: 'demo-alpha@courtly.example',
    currency: 'SGD',
    timezone: 'Asia/Singapore',
    isDemo: true,
    createdAt: '2026-09-12T08:00:00.000Z',
    counts,
  };
  const overview: AdminOverview = {
    generatedAt: '2026-09-19T08:00:00.000Z',
    totals: {
      businesses: 2, demoBusinesses: 1, realBusinesses: 1, users: 2, memberships: 2, students: 6,
      bookings: 8, upcomingBookings: 2, bookingsLast7Days: 1, packages: 0, paymentsCount: 0, paymentsTotal: 0,
    },
  };

  let signalOlderRequest!: () => void;
  const olderRequestStarted = new Promise<void>(resolve => { signalOlderRequest = resolve; });
  let releaseOlderResponse!: () => void;
  const olderResponseGate = new Promise<void>(resolve => { releaseOlderResponse = resolve; });

  await page.route('**/api/admin/session', route => route.fulfill({
    json: { configured: true, authenticated: true },
  }));
  await page.route('**/api/admin/overview', route => route.fulfill({ json: overview }));
  await page.route(/\/api\/admin\/businesses(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get('search');
    const filter = url.searchParams.get('filter');

    if (search === 'alpha' && filter === 'all') {
      signalOlderRequest();
      await olderResponseGate;
      await route.fulfill({ json: { businesses: [realBusiness] } });
      return;
    }

    const businesses = search === 'alpha' && filter === 'demo'
      ? [demoBusiness]
      : [realBusiness, demoBusiness];
    await route.fulfill({ json: { businesses } });
  });

  await page.goto('/admin');
  await expect(adminBusiness(page, 'Alpha Academy')).toBeVisible();
  await expect(adminBusiness(page, 'Alpha Demo Club')).toBeVisible();

  const olderResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/businesses'
      && url.searchParams.get('search') === 'alpha'
      && url.searchParams.get('filter') === 'all';
  });
  const search = page.getByRole('searchbox', { name: 'Search businesses' });
  await search.fill('alpha');
  await olderRequestStarted;

  const newerResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/businesses'
      && url.searchParams.get('search') === 'alpha'
      && url.searchParams.get('filter') === 'demo';
  });
  const demoFilter = page.getByRole('group', { name: 'Filter businesses' })
    .getByRole('button', { name: 'demo', exact: true });
  await demoFilter.click();
  await newerResponse;
  await expect(demoFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(adminBusiness(page, 'Alpha Demo Club')).toBeVisible();
  await expect(adminBusiness(page, 'Alpha Academy')).toHaveCount(0);

  releaseOlderResponse();
  const staleResponse = await olderResponse;
  await staleResponse.finished();
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  await expect(adminBusiness(page, 'Alpha Demo Club')).toBeVisible();
  await expect(adminBusiness(page, 'Alpha Academy')).toHaveCount(0);
});

test('admin login, discovery, and destructive actions remain safe and usable at every viewport', async ({ page }) => {
  test.setTimeout(90_000);

  const counts = { users: 1, students: 3, bookings: 4, locations: 2, services: 2, instructors: 1 };
  let businesses: AdminBusiness[] = [
    {
      id: 'real-business',
      name: 'Alpha Academy',
      slug: 'alpha-academy',
      ownerName: 'Alex Owner',
      email: 'alex@alpha.example',
      currency: 'SGD',
      timezone: 'Asia/Singapore',
      isDemo: false,
      createdAt: '2026-09-10T08:00:00.000Z',
      counts,
    },
    {
      id: 'demo-business',
      name: 'Demo Racquet Club',
      slug: 'demo-racquet-club',
      ownerName: 'Demi Coach',
      email: 'demo@courtly.example',
      currency: 'SGD',
      timezone: 'Asia/Singapore',
      isDemo: true,
      createdAt: '2026-09-12T08:00:00.000Z',
      counts: { ...counts, students: 8, bookings: 12 },
    },
  ];
  const loginPasswords: string[] = [];
  const loginMethods: string[] = [];
  const purgeRequests: Array<{ method: string; body: unknown }> = [];
  const deleteRequests: Array<{ method: string; path: string }> = [];
  let purgeAttempts = 0;
  let deleteAttempts = 0;

  await page.route('**/api/admin/session', route => route.fulfill({
    json: { configured: true, authenticated: false },
  }));
  await page.route('**/api/admin/login', async route => {
    loginMethods.push(route.request().method());
    const body = route.request().postDataJSON() as { password: string };
    loginPasswords.push(body.password);
    if (body.password === 'wrong-admin') {
      await route.fulfill({ status: 401, json: { error: 'Incorrect admin password' } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/admin/overview', route => {
    const demos = businesses.filter(business => business.isDemo).length;
    const overview: AdminOverview = {
      generatedAt: '2026-09-19T08:00:00.000Z',
      totals: {
        businesses: businesses.length,
        demoBusinesses: demos,
        realBusinesses: businesses.length - demos,
        users: businesses.length,
        memberships: businesses.length,
        students: businesses.reduce((sum, business) => sum + business.counts.students, 0),
        bookings: businesses.reduce((sum, business) => sum + business.counts.bookings, 0),
        upcomingBookings: 5,
        bookingsLast7Days: 3,
        packages: 2,
        paymentsCount: 7,
        paymentsTotal: 123_400,
      },
    };
    return route.fulfill({ json: overview });
  });
  await page.route(/\/api\/admin\/businesses(?:\?.*)?$/, route => {
    const url = new URL(route.request().url());
    const filter = url.searchParams.get('filter') || 'all';
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const filtered = businesses.filter(business => {
      const matchesFilter = filter === 'all' || (filter === 'demo') === business.isDemo;
      const searchable = `${business.name} ${business.ownerName} ${business.email} ${business.slug}`.toLowerCase();
      return matchesFilter && (!search || searchable.includes(search));
    });
    return route.fulfill({ json: { businesses: filtered } });
  });
  await page.route(/\/api\/admin\/businesses\/[^/?]+$/, async route => {
    deleteRequests.push({
      method: route.request().method(),
      path: new URL(route.request().url()).pathname,
    });
    deleteAttempts += 1;
    if (deleteAttempts === 1) {
      await route.fulfill({ status: 500, json: { error: 'Delete failed safely for this test.' } });
      return;
    }
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() || '');
    businesses = businesses.filter(business => business.id !== id);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/admin/purge-demos', async route => {
    purgeRequests.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    purgeAttempts += 1;
    if (purgeAttempts === 1) {
      await route.fulfill({ status: 500, json: { error: 'Demo purge failed safely for this test.' } });
      return;
    }
    const deleted = businesses.filter(business => business.isDemo).length;
    businesses = businesses.filter(business => !business.isDemo);
    await route.fulfill({ json: { ok: true, deleted } });
  });

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Admin sign in', exact: true })).toBeVisible();
  const password = page.getByLabel('Admin password', { exact: true });
  const unlock = page.getByRole('button', { name: 'Unlock admin console', exact: true });
  await expect(unlock).toBeDisabled();
  await password.fill('wrong-admin');
  await unlock.click();
  const loginError = page.getByRole('alert').filter({ hasText: 'Incorrect admin password' });
  await expect(loginError).toHaveText('Incorrect admin password');

  await password.fill('correct-admin');
  await expect(loginError).toHaveCount(0);
  await unlock.click();
  await expect(page.getByRole('heading', { name: 'Every workspace, at a glance', exact: true })).toBeVisible();
  await expect(adminBusiness(page, 'Alpha Academy')).toBeVisible();
  await expect(adminBusiness(page, 'Demo Racquet Club')).toBeVisible();
  await expect(page.getByText('1 real · 1 demo', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const search = page.getByRole('searchbox', { name: 'Search businesses' });
  const alphaSearchResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/businesses'
      && url.searchParams.get('search') === 'alpha'
      && url.searchParams.get('filter') === 'all';
  });
  await search.fill('alpha');
  await alphaSearchResponse;
  await expect(adminBusiness(page, 'Alpha Academy')).toBeVisible();
  await expect(adminBusiness(page, 'Demo Racquet Club')).toHaveCount(0);

  const filters = page.getByRole('group', { name: 'Filter businesses' });
  await search.fill('');
  await expect(adminBusiness(page, 'Demo Racquet Club')).toBeVisible();
  const demoFilterResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/businesses'
      && url.searchParams.get('filter') === 'demo'
      && !url.searchParams.has('search');
  });
  const demoFilter = filters.getByRole('button', { name: 'demo', exact: true });
  await demoFilter.click();
  await demoFilterResponse;
  await expect(demoFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(adminBusiness(page, 'Demo Racquet Club')).toBeVisible();
  await expect(adminBusiness(page, 'Alpha Academy')).toHaveCount(0);

  const allFilterResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/admin/businesses'
      && url.searchParams.get('filter') === 'all'
      && !url.searchParams.has('search');
  });
  const allFilter = filters.getByRole('button', { name: 'all', exact: true });
  await allFilter.click();
  await allFilterResponse;
  await expect(allFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(adminBusiness(page, 'Alpha Academy')).toBeVisible();
  await expect(adminBusiness(page, 'Demo Racquet Club')).toBeVisible();

  const purgeTrigger = page.getByRole('button', { name: 'Purge demos', exact: true });
  await purgeTrigger.click();
  let purgeDialog = page.getByRole('dialog', { name: 'Remove all demo workspaces?' });
  await expect(purgeDialog).toBeVisible();
  await expect(purgeDialog).toContainText('Real provider accounts are untouched.');
  await expect(purgeDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press('Escape');
  await expect(purgeDialog).toHaveCount(0);
  await expect(purgeTrigger).toBeFocused();

  await purgeTrigger.click();
  purgeDialog = page.getByRole('dialog', { name: 'Remove all demo workspaces?' });
  await purgeDialog.getByRole('button', { name: 'Purge demos', exact: true }).click();
  await expect(page.getByText('Demo purge failed safely for this test.', { exact: true })).toBeVisible();
  await expect(purgeDialog).toBeVisible();
  await expect(purgeDialog.getByRole('button', { name: 'Purge demos', exact: true })).toBeEnabled();

  await purgeDialog.getByRole('button', { name: 'Purge demos', exact: true }).click();
  await expect(purgeDialog).toHaveCount(0);
  await expect(page.getByText('Removed 1 demo workspace.', { exact: true })).toBeVisible();
  await expect(adminBusiness(page, 'Demo Racquet Club')).toHaveCount(0);
  await expect(adminBusiness(page, 'Alpha Academy')).toBeVisible();
  await expect(page.getByText('1 real · 0 demo', { exact: true })).toBeVisible();

  await adminBusiness(page, 'Alpha Academy').getByRole('button', { name: 'Delete Alpha Academy', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete “Alpha Academy”?' });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toContainText('This cannot be undone.');
  await expect(deleteDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(deleteDialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await deleteDialog.getByRole('button', { name: 'Delete forever', exact: true }).click();
  await expect(page.getByText('Delete failed safely for this test.', { exact: true })).toBeVisible();
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByRole('button', { name: 'Delete forever', exact: true })).toBeEnabled();

  await deleteDialog.getByRole('button', { name: 'Delete forever', exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.getByText('Deleted “Alpha Academy”.', { exact: true })).toBeVisible();
  await expect(page.getByText('No businesses match your filters yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('0 real · 0 demo', { exact: true })).toBeVisible();
  expect(loginPasswords).toEqual(['wrong-admin', 'correct-admin']);
  expect(loginMethods).toEqual(['POST', 'POST']);
  expect(purgeAttempts).toBe(2);
  expect(purgeRequests).toEqual([
    { method: 'POST', body: {} },
    { method: 'POST', body: {} },
  ]);
  expect(deleteAttempts).toBe(2);
  expect(deleteRequests).toEqual([
    { method: 'DELETE', path: '/api/admin/businesses/real-business' },
    { method: 'DELETE', path: '/api/admin/businesses/real-business' },
  ]);
  await expectNoHorizontalOverflow(page);
});
