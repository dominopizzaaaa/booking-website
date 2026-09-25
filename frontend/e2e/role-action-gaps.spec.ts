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
    data: { accountType: 'COACH', name: coachName, username: `dc_${coachEmail.split('@')[0].replace(/-/g, '_').slice(-27)}`, email: coachEmail, password },
  }));
  await logout(page);
  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: studentName, username: `ds_${studentEmail.split('@')[0].replace(/-/g, '_').slice(-27)}`, email: studentEmail, password },
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
    'The club assigned this class. The student does not need to accept it, but the coach does before it is confirmed.',
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
    'Decline this class? The slot is released, any package credit is returned, and the club is asked to reassign it.',
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

  await expect(page.getByText('Class declined', { exact: true })).toBeVisible();
  await expect(bookingDialog.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(bookingDialog.getByText('Awaiting coach', { exact: true })).toHaveCount(0);
  await expect(bookingDialog.getByRole('button', { name: 'Accept class', exact: true })).toHaveCount(0);
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
  await expect(page.locator('main').getByRole('heading', { name: 'Package offers', exact: true })).toBeVisible();
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

test('a club reviews an integrity flag entirely from its alert', async ({ page }) => {
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
    json: {
      ...workspace,
      notifications: [{
        id: 'integrity-alert-role-action-gap',
        type: 'INTEGRITY',
        bookingId: null,
        integrityFlagId: flag.id,
        title: 'Review a private booking pattern',
        message: 'A coach and student also booked outside the club.',
        read: true,
        actionNeeded: flag.status === 'OPEN' || flag.status === 'REVIEWING',
        createdAt: flag.lastSeenAt,
      }],
      integrityFlags: [flag],
    },
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

  await page.goto('/?tab=alerts');
  await expect(page.locator('main').getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  const alert = page.getByRole('button', { name: 'Read alert: Review a private booking pattern', exact: true });
  await expect(alert.getByText('Action needed', { exact: true })).toBeVisible();
  await alert.click();

  let alertDialog = page.getByRole('dialog', { name: 'Review a private booking pattern' });
  await expect(alertDialog).toContainText(`${coachName} & ${studentName}`);
  await expect(alertDialog).toContainText('2 private sessions noticed');
  await expect(alertDialog).toContainText('Private match preparation');

  const reviewRequest = page.waitForRequest(request =>
    request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/integrity-flags/${flag.id}`,
  );
  await alertDialog.getByRole('button', { name: 'Reviewing', exact: true }).click();
  expect((await reviewRequest).postDataJSON()).toEqual({ status: 'REVIEWING', note: '' });
  await expect(page.getByText('Flag marked reviewing', { exact: true })).toBeVisible();
  await expect(alertDialog).toHaveCount(0);

  await alert.click();
  alertDialog = page.getByRole('dialog', { name: 'Review a private booking pattern' });
  await expect(alertDialog.getByText('Reviewing', { exact: true })).toBeVisible();

  const decisionNote = 'The club confirmed that this breached the coaching agreement.';
  const upholdRequest = page.waitForRequest(request =>
    request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/integrity-flags/${flag.id}`
      && request.postDataJSON().status === 'UPHELD',
  );
  const promptPromise = page.waitForEvent('dialog');
  const upholdClick = alertDialog.getByRole('button', { name: 'Uphold', exact: true }).click();
  const prompt = await promptPromise;
  expect(prompt.type()).toBe('prompt');
  expect(prompt.message()).toBe('Uphold this review. What did you conclude?');
  await prompt.accept(decisionNote);
  await upholdClick;
  expect((await upholdRequest).postDataJSON()).toEqual({ status: 'UPHELD', note: decisionNote });

  await expect(page.getByText('Flag marked upheld', { exact: true })).toBeVisible();
  await expect(alertDialog).toHaveCount(0);
  await expect(alert.getByText('Action needed', { exact: true })).toHaveCount(0);

  await alert.click();
  alertDialog = page.getByRole('dialog', { name: 'Review a private booking pattern' });
  await expect(alertDialog.getByText('Upheld', { exact: true })).toBeVisible();
  await expect(alertDialog).toContainText(`Your note: ${decisionNote}`);
  await expect(alertDialog).toContainText('This review has been closed.');
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
      username: 'morgan_coach',
      email: 'morgan.coach@example.test',
      accountType: 'COACH',
      sports: ['Tennis'],
      phone: '+65 8000 1000',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  };
  const updates: Array<{ name: string; phone: string; username: string; sports: string[] }> = [];

  await page.route('**/api/auth/me', async route => {
    if (route.request().method() === 'PATCH') {
      const update = route.request().postDataJSON() as { name: string; phone: string; username: string; sports: string[] };
      updates.push(update);
      session = { ...session, user: { ...session.user, ...update } };
    }
    await route.fulfill({ json: session });
  });

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Welcome, Morgan Coach.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit personal profile', exact: true }).click();
  await expect(page.getByLabel('Full name', { exact: true })).toHaveValue('Morgan Coach');
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('morgan_coach');
  await expect(page.getByLabel(/^Sports/)).toHaveValue('Tennis');
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
  expect((await saveRequest).postDataJSON()).toEqual({
    name: updatedName,
    phone: updatedPhone,
    username: 'morgan_coach',
    sports: ['Tennis'],
  });

  await expect(page.getByRole('button', { name: 'Save personal profile', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: `Welcome, ${updatedName}.`, exact: true })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="account-profile-heading"]')).toContainText(updatedPhone);
  expect(updates).toEqual([{
    name: updatedName,
    phone: updatedPhone,
    username: 'morgan_coach',
    sports: ['Tennis'],
  }]);

  await page.reload();
  await expect(page.getByRole('heading', { name: `Welcome, ${updatedName}.`, exact: true })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="account-profile-heading"]')).toContainText(updatedPhone);
  await expectNoHorizontalOverflow(page);
});

test('an unaffiliated coach can search public account profiles from the account page', async ({ page }) => {
  const session: AuthSession = {
    user: {
      id: 'account-search-coach',
      name: 'Morgan Search Coach',
      username: 'morgan_search',
      email: 'morgan.search@example.test',
      accountType: 'COACH',
      sports: ['Tennis'],
      phone: '',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  };
  let requestedQuery = '';

  await page.route('**/api/auth/me', route => route.fulfill({ json: session }));
  await page.route('**/api/rentals', route => route.fulfill({ json: { rentals: [], nextCursor: null } }));
  await page.route('**/api/calendar/connection', route => route.fulfill({
    json: { configured: false, eligible: true, provider: null, state: 'DISCONNECTED', connected: false, email: null, calendarName: null, syncEnabled: false, busyCheckEnabled: false, connectedAt: null, lastSyncedAt: null, lastBusyAt: null, busyCacheExpiresAt: null, error: null },
  }));
  await page.route('**/api/accounts/search?*', async route => {
    requestedQuery = new URL(route.request().url()).searchParams.get('q') ?? '';
    await route.fulfill({
      json: {
        accounts: [{ name: 'Avery Player', username: 'avery_player', accountType: 'STUDENT', sports: ['Badminton'] }],
      },
    });
  });

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'No club access yet', exact: true })).toBeVisible();
  const people = page.locator('section[aria-labelledby="account-people-heading"]');
  await expect(people.getByRole('heading', { name: 'Find people on Courtly', exact: true })).toBeVisible();
  await expect(people).toContainText('name, username, or exact email address');
  await people.getByRole('searchbox', { name: 'Search all Courtly accounts', exact: true }).fill('avery@example.test');
  await people.getByRole('button', { name: 'Search people', exact: true }).click();

  await expect.poll(() => requestedQuery).toBe('avery@example.test');
  const result = people.getByRole('listitem');
  await expect(result).toContainText('Avery Player');
  await expect(result).toContainText('@avery_player');
  await expect(result).toContainText('Badminton');
  await expect(result).not.toContainText('avery@example.test');
  await expectNoHorizontalOverflow(page);
});

test('a student can see and update their username from Profile', async ({ page }) => {
  let session: AuthSession = {
    user: {
      id: 'student-profile-identity',
      name: 'Avery Student',
      username: 'avery_student',
      email: 'avery.student@example.test',
      accountType: 'STUDENT',
      sports: ['Tennis'],
      phone: '+65 8123 4567',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  };
  const updates: Array<Record<string, unknown>> = [];

  await page.route('**/api/auth/me', route => route.fulfill({ json: session }));
  await page.route('**/api/account/profile', async route => {
    const update = route.request().postDataJSON() as Record<string, unknown>;
    updates.push(update);
    session = { ...session, user: { ...session.user, ...update } };
    await route.fulfill({ json: session });
  });
  await page.route('**/api/account/clubs*', route => route.fulfill({ json: { clubs: [], nextCursor: null } }));
  await page.route('**/api/account/bookings*', route => route.fulfill({ json: { bookings: [] } }));
  await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/account/packages', route => route.fulfill({ json: { packages: [] } }));
  await page.route('**/api/rentals', route => route.fulfill({ json: { rentals: [], nextCursor: null } }));
  await page.route('**/api/rentals/reservations/mine', route => route.fulfill({ json: { reservations: [] } }));
  await page.route('**/api/calendar/connection', route => route.fulfill({
    json: { configured: false, eligible: true, provider: null, state: 'DISCONNECTED', connected: false, email: null, calendarName: null, syncEnabled: false, busyCheckEnabled: false, connectedAt: null, lastSyncedAt: null, lastBusyAt: null, busyCacheExpiresAt: null, error: null },
  }));

  await page.goto('/manage?tab=profile');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(page.getByText('@avery_student', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const username = page.getByLabel('Username', { exact: true });
  await expect(username).toHaveValue('avery_student');
  await username.fill('avery_court');
  const saveRequest = page.waitForRequest(request =>
    request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/account/profile',
  );
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await saveRequest).postDataJSON()).toEqual({
    name: 'Avery Student',
    username: 'avery_court',
    phone: '+65 8123 4567',
    parentName: '',
    sports: ['Tennis'],
  });
  await expect(page.getByText('@avery_court', { exact: true })).toBeVisible();
  expect(updates).toHaveLength(1);
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
  await page.route('**/api/account/clubs*', route => route.fulfill({ json: { clubs: [] } }));
  await page.route('**/api/account/bookings*', route => route.fulfill({ json: { bookings: [] } }));
  await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));
  await page.route('**/api/account/packages', route => route.fulfill({ json: { packages: [] } }));
  await page.route(/\/api\/rentals(?:\?.*)?$/, route => route.fulfill({
    json: { rentals: [], nextCursor: null },
  }));

  await page.goto('/account');
  await expect(page).toHaveURL(url => url.pathname === '/manage');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
