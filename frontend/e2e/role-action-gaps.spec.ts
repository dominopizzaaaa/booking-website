import { expect, test, type APIResponse, type Cookie, type Page } from '@playwright/test';
import type {
  AuthSession,
  CoachScopedBooking,
  IntegrityFlag,
  LessonPackage,
  ManagerWorkspace,
} from '../src/lib/types';

const password = 'TestingOnly!2026';
const timezone = 'Asia/Singapore';

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function uniqueValue(prefix: string, projectName: string) {
  return `${prefix}-${projectId(projectName)}-${Date.now()}`;
}

function futureSingaporeDate(days = 12) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

function dayOfWeek(date: string) {
  return new Date(`${date}T12:00:00+08:00`).getUTCDay();
}

async function responseJson<T>(response: APIResponse): Promise<T> {
  const body = await response.json() as T;
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function logout(page: Page) {
  await responseJson(await page.request.post('/api/auth/logout', { data: {} }));
}

async function login(page: Page, email: string) {
  await responseJson(await page.request.post('/api/auth/login', {
    data: { email, password },
  }));
}

async function switchToUser(page: Page, email: string) {
  await page.context().clearCookies();
  await login(page, email);
}

async function restoreCookies(page: Page, cookies: Cookie[]) {
  await page.context().clearCookies();
  await page.context().addCookies(cookies);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
}

test('an assigned coach can decline a package lesson and every affected role sees the result', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const runId = uniqueValue('decline', testInfo.project.name);
  const coachName = `Decline Coach ${projectId(testInfo.project.name)}`;
  const studentName = `Decline Student ${projectId(testInfo.project.name)}`;
  const coachEmail = `${runId}-coach@example.test`;
  const studentEmail = `${runId}-student@example.test`;
  const serviceName = `Assigned package lesson ${runId}`;
  const packageName = `Decline credit ${runId}`;

  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'COACH', name: coachName, email: coachEmail, password },
  }));
  await logout(page);
  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: studentName, email: studentEmail, password },
  }));
  await logout(page);

  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));
  const club = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  const clubCookies = await page.context().cookies();

  const affiliation = await responseJson<{ instructorId: string | null }>(await page.request.post('/api/staff', {
    data: { email: coachEmail },
  }));
  expect(affiliation.instructorId).toBeTruthy();
  const instructorId = affiliation.instructorId!;

  const student = await responseJson<{ id: string }>(await page.request.post('/api/students', {
    data: { email: studentEmail, notes: 'Linked for the assigned-lesson decline journey.' },
  }));
  const location = await responseJson<{ id: string }>(await page.request.post('/api/locations', {
    data: {
      name: `Decline court ${runId}`,
      address: '21 Reassignment Road',
      type: 'FACILITY',
      requiresApproval: false,
      travelMinutes: 0,
    },
  }));
  const service = await responseJson<{ id: string }>(await page.request.post('/api/services', {
    data: {
      name: serviceName,
      description: 'A package lesson used to verify the coach-decline workflow.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: 9_000,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{
        locationId: location.id,
        price: 9_000,
        duration: 60,
        instructorIds: [instructorId],
      }],
    },
  }));
  const pkg = await responseJson<LessonPackage>(await page.request.post('/api/packages', {
    data: {
      studentId: student.id,
      name: packageName,
      serviceId: service.id,
      totalCredits: 2,
      price: 18_000,
      expiresAt: new Date(`${futureSingaporeDate(120)}T23:59:59+08:00`).toISOString(),
      paid: false,
    },
  }));

  const date = futureSingaporeDate();
  await responseJson(await page.request.post('/api/availability', {
    data: {
      instructorId,
      locationId: location.id,
      dayOfWeek: dayOfWeek(date),
      startTime: '09:00',
      endTime: '12:00',
    },
  }));
  const created = await responseJson<{ bookings: ManagerWorkspace['bookings'] }>(
    await page.request.post('/api/bookings', {
      data: {
        serviceId: service.id,
        instructorId,
        locationId: location.id,
        startAt: `${date}T10:00:00+08:00`,
        studentId: student.id,
        packageId: pkg.id,
        repeatWeeks: 1,
        notes: 'Club-assigned package lesson.',
        address: '',
      },
    }),
  );
  expect(created.bookings).toHaveLength(1);
  const booking = created.bookings[0];
  expect(booking).toMatchObject({
    status: 'PENDING',
    coachAcceptance: 'PENDING',
    createdByRole: 'CLUB',
  });
  expect(booking.participants[0]).toMatchObject({ packageId: pkg.id });
  const beforeDecline = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  expect(beforeDecline.packages.find(candidate => candidate.id === pkg.id)?.usedCredits).toBe(1);

  await switchToUser(page, coachEmail);
  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
  await page.getByRole('button', {
    name: `Open booking details for ${serviceName} with ${studentName}`,
    exact: true,
  }).click();

  const bookingDialog = page.getByRole('dialog');
  await expect(bookingDialog.getByRole('heading', { name: serviceName, exact: true })).toBeVisible();
  await expect(bookingDialog.getByText('Awaiting coach', { exact: true })).toBeVisible();
  await expect(bookingDialog.getByText(
    'The club assigned this lesson. The student does not need to accept it, but the coach does before it is confirmed.',
    { exact: true },
  )).toBeVisible();

  const declineResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/bookings/${booking.id}/decline`,
  );
  const confirmationPromise = page.waitForEvent('dialog');
  const declineClick = bookingDialog.getByRole('button', { name: 'Cannot teach this', exact: true }).click();
  const confirmation = await confirmationPromise;
  expect(confirmation.type()).toBe('confirm');
  expect(confirmation.message()).toBe(
    'Decline this lesson? The slot is released, any package credit is returned, and the club is asked to reassign it.',
  );
  await confirmation.accept();
  await declineClick;

  const declineResponse = await declineResponsePromise;
  const declined = await declineResponse.json() as CoachScopedBooking;
  expect(declineResponse.ok(), JSON.stringify(declined)).toBeTruthy();
  expect(declineResponse.request().postDataJSON()).toEqual({ message: '' });
  expect(declined).toMatchObject({
    id: booking.id,
    status: 'CANCELLED',
    coachAcceptance: 'DECLINED',
  });
  expect(declined).not.toHaveProperty('price');
  expect(declined.participants[0]).not.toHaveProperty('paid');
  expect(declined.participants[0]).not.toHaveProperty('price');
  expect(declined.participants[0]).not.toHaveProperty('packageId');

  await expect(page.getByText('Lesson declined', { exact: true })).toBeVisible();
  await expect(bookingDialog.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(bookingDialog.getByText('Awaiting coach', { exact: true })).toHaveCount(0);
  await expect(bookingDialog.getByRole('button', { name: 'Accept lesson', exact: true })).toHaveCount(0);
  await expect(bookingDialog.getByRole('button', { name: 'Cannot teach this', exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await bookingDialog.getByRole('button', { name: 'Close dialog' }).click();

  await restoreCookies(page, clubCookies);
  const clubAfterDecline = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  expect(clubAfterDecline.bookings.find(candidate => candidate.id === booking.id)).toMatchObject({
    status: 'CANCELLED',
    coachAcceptance: 'DECLINED',
  });
  expect(clubAfterDecline.packages.find(candidate => candidate.id === pkg.id)?.usedCredits).toBe(0);
  expect(clubAfterDecline.notifications.find(notification =>
    notification.bookingId === booking.id
      && notification.title === 'Coach declined an assigned lesson',
  )).toMatchObject({
    type: 'PENDING_ACTION',
    actionNeeded: true,
    message: 'The assigned coach cannot take this lesson. Reassign it to another coach.',
  });

  await page.goto('/?tab=explore&view=packages');
  await expect(page.locator('main').getByRole('heading', { name: 'Lesson packages', exact: true })).toBeVisible();
  const packageCard = page.locator('main article').filter({ hasText: packageName });
  await expect(packageCard).toContainText(/2\s*credits left/);
  await expect(packageCard.getByText('0 of 2 used', { exact: true })).toBeVisible();
  await expect(packageCard.getByRole('progressbar', { name: `${packageName} used credits` })).toHaveAttribute('aria-valuenow', '0');

  await page.goto('/?tab=alerts');
  await expect(page.locator('main').getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  const clubAlert = page.getByRole('button', {
    name: 'Unread alert: Coach declined an assigned lesson',
    exact: true,
  });
  await expect(clubAlert).toContainText('Reassign it to another coach.');
  await expect(clubAlert.getByText('Action needed', { exact: true })).toBeVisible();
  await clubAlert.click();
  const alertDialog = page.getByRole('dialog');
  await expect(alertDialog.getByRole('heading', { name: 'Coach declined an assigned lesson', exact: true })).toBeVisible();
  await expect(alertDialog).toContainText('The assigned coach cannot take this lesson. Reassign it to another coach.');
  await alertDialog.getByRole('button', { name: 'Close', exact: true }).click();

  await switchToUser(page, studentEmail);
  const studentNotifications = await responseJson<{
    notifications: Array<{ title: string; message: string; actionNeeded: boolean; bookingId: string | null }>;
  }>(await page.request.get('/api/account/notifications'));
  expect(studentNotifications.notifications.find(notification =>
    notification.bookingId === booking.id
      && notification.title === 'Your coach could not take this lesson',
  )).toMatchObject({
    actionNeeded: true,
    message: expect.stringContaining(`${club.business.name} will arrange an alternative.`),
  });

  await page.goto(`/manage?slug=${encodeURIComponent(club.business.slug)}&tab=alerts`);
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  const studentAlert = page.getByRole('button', {
    name: 'Unread alert: Your coach could not take this lesson',
    exact: true,
  });
  await expect(studentAlert).toContainText(`${club.business.name} will arrange an alternative.`);
  await expect(studentAlert.getByText('Action needed', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('a club can move an integrity flag through review and close it with a recorded decision', async ({ page }) => {
  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));
  const workspace = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  const coachName = 'Jordan Review';
  const studentName = 'Taylor Follow-up';
  let flag: IntegrityFlag = {
    id: 'integrity-role-action-gap',
    instructorId: workspace.instructors[0]?.id ?? null,
    coachName,
    studentName,
    type: 'PRIVATE_BOOKING_AFTER_CLUB',
    status: 'OPEN',
    detail: `${coachName} and ${studentName} booked directly after first training together through the club.`,
    occurrences: 2,
    outsideBusinessName: 'Jordan Review Coaching',
    firstSeenAt: '2026-09-02T02:00:00.000Z',
    lastSeenAt: '2026-09-18T02:00:00.000Z',
    resolvedAt: null,
    resolutionNote: '',
    flaggedSessionAt: '2026-09-25T02:00:00.000Z',
    flaggedServiceName: 'Private match preparation',
  };
  const decisions: Array<{ status: IntegrityFlag['status']; note: string }> = [];

  await page.route('**/api/workspace', route => route.fulfill({
    json: { ...workspace, integrityFlags: [flag] },
  }));
  await page.route(`**/api/integrity-flags/${flag.id}`, async route => {
    const decision = route.request().postDataJSON() as { status: IntegrityFlag['status']; note: string };
    decisions.push(decision);
    const closed = decision.status === 'DISMISSED' || decision.status === 'UPHELD';
    flag = {
      ...flag,
      status: decision.status,
      resolutionNote: decision.note,
      resolvedAt: closed ? '2026-09-19T04:00:00.000Z' : null,
    };
    await route.fulfill({ json: flag });
  });

  await page.goto('/?tab=explore&view=integrity');
  await expect(page.locator('main').getByRole('heading', { name: 'Integrity', exact: true })).toBeVisible();
  const openStat = page.locator('article.stat-card').filter({ hasText: 'Open flags' });
  const reviewingStat = page.locator('article.stat-card').filter({ hasText: 'Under review' });
  const closedStat = page.locator('article.stat-card').filter({ hasText: 'Closed' });
  await expect(openStat.getByText('1', { exact: true })).toBeVisible();
  await expect(reviewingStat.getByText('0', { exact: true })).toBeVisible();
  await expect(closedStat.getByText('0', { exact: true })).toBeVisible();

  let flagCard = page.locator('article.panel').filter({ hasText: `${coachName} & ${studentName}` });
  await expect(flagCard.getByRole('heading', { name: `${coachName} & ${studentName}`, exact: true })).toBeVisible();
  await expect(flagCard).toContainText('2 private sessions noticed');
  await expect(flagCard).toContainText('Private match preparation');

  const reviewRequest = page.waitForRequest(request =>
    request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/integrity-flags/${flag.id}`,
  );
  await flagCard.getByRole('button', { name: 'I’m looking into this', exact: true }).click();
  expect((await reviewRequest).postDataJSON()).toEqual({ status: 'REVIEWING', note: '' });
  await expect(page.getByText('Flag marked reviewing', { exact: true })).toBeVisible();
  await expect(flagCard.getByText('Reviewing', { exact: true })).toBeVisible();
  await expect(openStat.getByText('0', { exact: true })).toBeVisible();
  await expect(reviewingStat.getByText('1', { exact: true })).toBeVisible();

  const decisionNote = 'The club confirmed that this breached the coaching agreement.';
  const upholdRequest = page.waitForRequest(request =>
    request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/integrity-flags/${flag.id}`
      && request.postDataJSON().status === 'UPHELD',
  );
  const promptPromise = page.waitForEvent('dialog');
  const upholdClick = flagCard.getByRole('button', { name: 'Uphold this flag', exact: true }).click();
  const prompt = await promptPromise;
  expect(prompt.type()).toBe('prompt');
  expect(prompt.message()).toBe('Record this as upheld. What did you conclude?');
  await prompt.accept(decisionNote);
  await upholdClick;
  expect((await upholdRequest).postDataJSON()).toEqual({ status: 'UPHELD', note: decisionNote });

  await expect(page.getByText('Flag marked upheld', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing needs a decision', exact: true })).toBeVisible();
  await expect(reviewingStat.getByText('0', { exact: true })).toBeVisible();
  await expect(closedStat.getByText('1', { exact: true })).toBeVisible();
  await page.getByLabel('Filter flags', { exact: true }).selectOption('resolved');

  flagCard = page.locator('article.panel').filter({ hasText: `${coachName} & ${studentName}` });
  await expect(flagCard.getByText('Upheld', { exact: true })).toBeVisible();
  await expect(flagCard).toContainText(`Your note: ${decisionNote}`);
  expect(decisions).toEqual([
    { status: 'REVIEWING', note: '' },
    { status: 'UPHELD', note: decisionNote },
  ]);
  await expectNoHorizontalOverflow(page);
});

test('the account page saves a coach profile and keeps the new details after reload', async ({ page }) => {
  let session: AuthSession = {
    user: {
      id: 'account-profile-coach',
      name: 'Morgan Coach',
      email: 'morgan.coach@example.test',
      accountType: 'COACH',
      phone: '+65 8000 1000',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  };
  const updates: Array<{ name: string; phone: string }> = [];

  await page.route('**/api/auth/me', async route => {
    if (route.request().method() === 'PATCH') {
      const update = route.request().postDataJSON() as { name: string; phone: string };
      updates.push(update);
      session = { ...session, user: { ...session.user, ...update } };
    }
    await route.fulfill({ json: session });
  });

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Welcome, Morgan Coach.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit personal profile', exact: true }).click();
  await expect(page.getByLabel('Full name', { exact: true })).toHaveValue('Morgan Coach');
  await expect(page.getByLabel('Sign-in email', { exact: true })).toHaveValue('morgan.coach@example.test');
  await expect(page.getByLabel('Sign-in email', { exact: true })).not.toBeEditable();

  const updatedName = 'Morgan Court Coach';
  const updatedPhone = '+65 8111 2026';
  await page.getByLabel('Full name', { exact: true }).fill(updatedName);
  await page.getByLabel(/^Phone/).fill(updatedPhone);
  const saveRequest = page.waitForRequest(request =>
    request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/auth/me',
  );
  await page.getByRole('button', { name: 'Save personal profile', exact: true }).click();
  expect((await saveRequest).postDataJSON()).toEqual({ name: updatedName, phone: updatedPhone });

  await expect(page.getByRole('button', { name: 'Save personal profile', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: `Welcome, ${updatedName}.`, exact: true })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="account-profile-heading"]')).toContainText(updatedPhone);
  expect(updates).toEqual([{ name: updatedName, phone: updatedPhone }]);

  await page.reload();
  await expect(page.getByRole('heading', { name: `Welcome, ${updatedName}.`, exact: true })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="account-profile-heading"]')).toContainText(updatedPhone);
  await expectNoHorizontalOverflow(page);
});

test('the account page redirects anonymous visitors to sign in and students to self-service', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 401,
    json: { error: 'Please sign in to continue' },
  }));
  await page.goto('/account');
  await expect(page).toHaveURL(url => url.pathname === '/login');
  await expect(page.getByRole('heading', { name: 'Good to see you again.', exact: true })).toBeVisible();

  await page.unroute('**/api/auth/me');
  const studentSession: AuthSession = {
    user: {
      id: 'account-redirect-student',
      name: 'Account Redirect Student',
      email: 'account.redirect@example.test',
      accountType: 'STUDENT',
      phone: '',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  };
  await page.route('**/api/auth/me', route => route.fulfill({ json: studentSession }));
  await page.route('**/api/account/bookings*', route => route.fulfill({ json: { bookings: [] } }));
  await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));

  await page.goto('/account');
  await expect(page).toHaveURL(url => url.pathname === '/manage');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
