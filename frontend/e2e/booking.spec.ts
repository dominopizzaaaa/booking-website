import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CoachClubWorkspace, ManagerWorkspace } from '../src/lib/types';

const password = 'TestingOnly!2026';

function futureDate(days = 9) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function uniqueEmail(prefix: string, projectName: string) {
  const project = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${prefix}-${project}-${Date.now()}@example.test`;
}

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function expectStudentManageUrl(page: Page, slug: string, tab?: string) {
  await expect(page).toHaveURL(url =>
    url.pathname === '/manage'
      && url.searchParams.get('slug') === slug
      && url.searchParams.get('tab') === (tab ?? null)
      && [...url.searchParams.keys()].every(key => key === 'slug' || key === 'tab'),
  );
}

async function visibleWorkspaceNavigation(page: Page): Promise<Locator> {
  const mobileNavigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  if (await mobileNavigation.isVisible()) return mobileNavigation;

  const desktopNavigation = page.getByRole('navigation', { name: 'Primary' });
  await expect(desktopNavigation).toBeVisible();
  return desktopNavigation;
}

async function openWorkspaceView(page: Page, label: string) {
  const navigation = await visibleWorkspaceNavigation(page);
  await navigation.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Open ${label}`, exact: true }).click();
}

async function expectWorkspaceHomeUrl(page: Page) {
  await expect(page).toHaveURL(url =>
    url.pathname === '/'
      && url.searchParams.get('tab') === 'home'
      && !url.searchParams.has('view'),
  );
}

test('student creates an account, books, views history, and cancels', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
  const workspace = await (await page.request.get('/api/workspace')).json();
  const service = workspace.services.find((candidate: { type: string; locations: unknown[] }) =>
    candidate.type === 'PRIVATE' && candidate.locations.length > 0,
  );
  expect(service).toBeTruthy();
  const mapping = service.locations.find((candidate: { locationId: string }) =>
    workspace.locations.some((location: { id: string; requiresApproval: boolean }) =>
      location.id === candidate.locationId && !location.requiresApproval,
    ),
  ) || service.locations[0];
  const location = workspace.locations.find((candidate: { id: string }) => candidate.id === mapping.locationId);
  const coach = workspace.instructors.find((candidate: { id: string }) => candidate.id === mapping.instructorIds[0]);
  expect(location).toBeTruthy();
  expect(coach).toBeTruthy();

  let date = futureDate();
  let found = false;
  for (let offset = 9; offset < 23; offset++) {
    date = futureDate(offset);
    const response = await page.request.get(`/api/public/${workspace.business.slug}/slots`, {
      params: { serviceId: service.id, instructorId: coach.id, locationId: location.id, date },
    });
    const body = await response.json();
    if (body.slots?.some((slot: { available: boolean }) => slot.available)) {
      found = true;
      break;
    }
  }
  expect(found).toBe(true);

  // Club and student sessions share one cookie; release the demo-club
  // session before entering the account-required public booking journey.
  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto(`/book/${workspace.business.slug}`);
  await expect(page.getByRole('heading', { name: 'Good days start with a lesson.' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(service.name)) }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(location.name)) }).click();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(coach.name)) }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Choose a date').fill(date);
  await page.getByRole('button', { name: /^\d{1,2}:\d{2} [AP]M/ }).first().click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  const studentName = 'Jamie Browser Test';
  const studentEmail = uniqueEmail('jamie', testInfo.project.name);
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Full name').fill(studentName);
  await page.getByLabel('Email address').fill(studentEmail);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel(/^Phone/).fill('+65 9123 4567');
  await page.getByLabel(/^Parent or guardian/).fill('Robin Browser Test');
  await page.getByRole('button', { name: 'Continue with account' }).click();
  await expect(page.getByRole('heading', { name: studentName, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review booking' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /^(Confirm booking|Request booking)/ }).click();

  await expect(page.getByRole('heading', { name: /You’re on the calendar|Your request is in/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your booking receipt' })).toBeVisible();
  await page.screenshot({ path: `.data/screenshots/booking-receipt-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

  await page.getByRole('link', { name: 'My bookings', exact: true }).click();
  await expectStudentManageUrl(page, workspace.business.slug);
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();
  const studentNavigation = page.getByRole('navigation', { name: 'Student navigation' });
  await expect(studentNavigation.getByRole('button')).toHaveCount(5);
  await expect(studentNavigation.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');

  await studentNavigation.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expectStudentManageUrl(page, workspace.business.slug, 'explore');
  await expect(page.getByRole('heading', { name: workspace.business.name, exact: true })).toBeVisible();
  await expect(studentNavigation.getByRole('button', { name: 'Explore', exact: true })).toHaveAttribute('aria-current', 'page');

  await studentNavigation.getByRole('button', { name: 'Book', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Book a session', exact: true })).toBeVisible();
  await expectStudentManageUrl(page, workspace.business.slug, 'book');
  await expect(page.getByRole('radio', { name: new RegExp(escapeRegExp(workspace.business.name)) })).toBeChecked();
  await expect(studentNavigation.getByRole('button', { name: 'Book', exact: true })).toHaveAttribute('aria-current', 'page');

  const alertsNavigationButton = studentNavigation.getByRole('button', { name: /^Alerts/ });
  await expect(alertsNavigationButton).toHaveAccessibleName(/^Alerts, \d+ unread alerts?$/);
  await alertsNavigationButton.click();
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await expectStudentManageUrl(page, workspace.business.slug, 'alerts');
  await expect(studentNavigation.getByRole('button', { name: /^Alerts/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(/Live alerts are temporarily unavailable/)).toHaveCount(0);
  // Each alert is a row that opens its own detail dialog, so its title is the
  // row's accessible name rather than a heading in the list.
  await expect(page.getByRole('button', { name: /^Unread alert: Booking (confirmed|request received)$/ })).toBeVisible();
  const markAllRead = page.getByRole('button', { name: 'Mark all as read', exact: true });
  await expect(markAllRead).toBeVisible();
  await markAllRead.click();
  await expect(markAllRead).toHaveCount(0);
  await expect(alertsNavigationButton).toHaveAccessibleName('Alerts');
  const reloadedNotifications = page.waitForResponse(response =>
    response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/account/notifications',
  );
  await page.reload();
  await reloadedNotifications;
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await expect(page.getByText(/Live alerts are temporarily unavailable/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark all as read', exact: true })).toHaveCount(0);

  await studentNavigation.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expectStudentManageUrl(page, workspace.business.slug, 'profile');
  // Personal details read as a record. Editing is a deliberate step in a
  // dialog, so the page cannot be changed by brushing past an input.
  const personalDetails = page.locator('section', { has: page.getByRole('heading', { name: 'Personal details', exact: true }) }).first();
  await expect(personalDetails.getByRole('heading', { name: 'Personal details', exact: true })).toBeVisible();
  await expect(personalDetails).toContainText(studentName);
  await expect(personalDetails).toContainText(studentEmail);
  await expect(personalDetails).toContainText('+65 9123 4567');
  await expect(personalDetails).toContainText('Robin Browser Test');
  await expect(page.getByLabel('Full name', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Filter booking history' })).toBeVisible();
  await expect(studentNavigation.getByRole('button', { name: 'Profile', exact: true })).toHaveAttribute('aria-current', 'page');

  const updatedPhone = '+65 9876 5432';
  const updatedGuardian = 'Robin Browser Updated';
  await personalDetails.getByRole('button', { name: 'Edit', exact: true }).click();
  const profileDialog = page.getByRole('dialog');
  await expect(profileDialog.getByRole('heading', { name: 'Edit personal details' })).toBeVisible();
  await expect(profileDialog.getByLabel('Full name', { exact: true })).toHaveValue(studentName);
  const dialogEmail = profileDialog.getByLabel('Email address', { exact: true });
  await expect(dialogEmail).toHaveValue(studentEmail);
  await expect(dialogEmail).not.toBeEditable();
  await profileDialog.getByLabel('Phone', { exact: true }).fill(updatedPhone);
  await profileDialog.getByLabel('Parent or guardian', { exact: true }).fill(updatedGuardian);
  const profileSaveResponse = page.waitForResponse(response =>
    response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === '/api/account/profile',
  );
  await profileDialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await profileSaveResponse).status()).toBe(200);
  // Saving closes the editor and the record shows the new details.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(personalDetails).toContainText(updatedPhone);
  await expect(personalDetails).toContainText(updatedGuardian);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  const reloadedDetails = page.locator('section', { has: page.getByRole('heading', { name: 'Personal details', exact: true }) }).first();
  await expect(reloadedDetails).toContainText(studentEmail);
  await expect(reloadedDetails).toContainText(updatedPhone);
  await expect(reloadedDetails).toContainText(updatedGuardian);

  await studentNavigation.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();
  await expectStudentManageUrl(page, workspace.business.slug, 'home');
  const bookingCard = page.getByRole('article').filter({ hasText: service.name }).first();
  await expect(bookingCard).toContainText('Confirmed');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Upcoming sessions' })).toBeVisible();
  await expect(bookingCard).toContainText(service.name);
  // Opening the row shows the full booking, including who it is for.
  await bookingCard.getByRole('button').first().click();
  const bookingDialog = page.getByRole('dialog');
  await expect(bookingDialog.getByRole('heading', { name: service.name })).toBeVisible();
  await expect(bookingDialog).toContainText(studentName);
  await bookingDialog.getByRole('button', { name: 'Cancel booking' }).click();
  await expect(bookingDialog.getByRole('heading', { name: 'Cancel this session?' })).toBeVisible();
  await bookingDialog.getByRole('button', { name: 'Yes, cancel session' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const cancellationNotice = page.getByRole('status').filter({ hasText: 'Your booking has been cancelled.' });
  await expect(cancellationNotice).toBeVisible();
  await expect(cancellationNotice).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Booking history' })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: service.name }).first()).toContainText('Cancelled');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Booking history' })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: service.name }).first()).toContainText('Cancelled');
  const historyResponse = await page.request.get('/api/account/bookings', {
    params: { businessSlug: workspace.business.slug },
  });
  expect(historyResponse.ok()).toBeTruthy();
  const historyBody = await historyResponse.json();
  const history = Array.isArray(historyBody) ? historyBody : historyBody.bookings;
  expect(history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      booking: expect.objectContaining({ serviceId: service.id }),
      participant: expect.objectContaining({ email: studentEmail }),
    }),
  ]));
});

test('student shell guards stale actions and exposes current sessions and actionable alerts', async ({ page }) => {
  const now = Date.now();
  const session = {
    user: {
      id: 'student-user',
      name: 'Taylor Student',
      email: 'taylor@example.test',
      accountType: 'STUDENT',
      phone: '',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  };
  const business = {
    name: 'Known Test Club',
    slug: 'known-test-club',
    ownerName: 'Coach Test',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
    color: '#174c3c',
    tagline: 'A real club from booking history',
    cancellationHours: 24,
  };
  function accountBooking(
    id: string,
    serviceName: string,
    startAt: string,
    endAt: string,
  ) {
    const participant = {
      id: `participant-${id}`,
      studentId: 'student-record',
      name: session.user.name,
      email: session.user.email,
      attendance: 'UNMARKED',
      paid: false,
      price: 9000,
      packageId: null,
      notes: '',
      cancelled: false,
      cancelledAt: null,
    };
    return {
      business,
      booking: {
        id,
        serviceId: `service-${id}`,
        serviceName,
        instructorId: 'instructor-test',
        instructorName: 'Coach Test',
        locationId: 'location-test',
        locationName: 'Centre Court',
        locationColor: '#174c3c',
        startAt,
        endAt,
        status: 'CONFIRMED',
        type: 'PRIVATE',
        capacity: 1,
        price: 9000,
        notes: '',
        address: '1 Court Lane',
        paymentRoute: 'CLUB',
        coachAcceptance: 'NOT_REQUIRED',
        createdByRole: 'STUDENT',
        recurringId: null,
        participants: [participant],
      },
      participant,
      location: {
        id: 'location-test',
        name: 'Centre Court',
        address: '1 Court Lane',
        type: 'FACILITY',
        color: '#174c3c',
        requiresApproval: false,
        active: true,
      },
      // Intentionally stale server snapshots: local time policy must still win.
      canCancel: true,
      canReschedule: true,
      rescheduleRequest: null,
      awaitingCoach: false,
      paymentRoute: 'CLUB',
      management: { cancellationHours: 24, rescheduleNoticeHours: 24 },
    };
  }

  const inProgress = accountBooking(
    'in-progress-booking',
    'Live coaching',
    new Date(now - 15 * 60_000).toISOString(),
    new Date(now + 45 * 60_000).toISOString(),
  );
  const insideCutoff = accountBooking(
    'inside-cutoff-booking',
    'Tomorrow coaching',
    new Date(now + 60 * 60_000).toISOString(),
    new Date(now + 2 * 60 * 60_000).toISOString(),
  );

  await page.route('**/api/auth/me', route => route.fulfill({ json: session }));
  await page.route('**/api/account/clubs*', route => route.fulfill({ json: { clubs: [] } }));
  await page.route('**/api/account/bookings*', route => route.fulfill({
    json: { bookings: [inProgress, insideCutoff] },
  }));
  await page.route('**/api/account/notifications', route => route.fulfill({
    json: {
      notifications: [{
        id: 'action-alert',
        bookingId: 'in-progress-booking',
        type: 'BOOKING_RESCHEDULED',
        title: 'Schedule changed',
        message: 'Your coach moved this session. Review your bookings.',
        read: false,
        actionNeeded: true,
        createdAt: new Date(now).toISOString(),
        business: { name: business.name, slug: business.slug },
      }],
    },
  }));

  await page.goto(`/manage?slug=${business.slug}&tab=home`);
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();

  // Each booking is one summary row; its details and actions open in a dialog.
  const currentSection = page.locator('section[aria-labelledby="current-bookings"]');
  const currentCard = currentSection.getByRole('article').filter({ hasText: 'Live coaching' });
  await expect(currentSection.getByRole('heading', { name: 'In progress' })).toBeVisible();
  await expect(currentCard).toContainText('In progress');
  await currentCard.getByRole('button').first().click();
  const currentDialog = page.getByRole('dialog');
  await expect(currentDialog.getByRole('heading', { name: 'Live coaching' })).toBeVisible();
  // A session already under way is past every self-service window.
  await expect(currentDialog.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
  await expect(currentDialog.getByRole('button', { name: 'Ask for a new time' })).toHaveCount(0);
  await currentDialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const upcomingSection = page.locator('section[aria-labelledby="upcoming-bookings"]');
  const cutoffCard = upcomingSection.getByRole('article').filter({ hasText: 'Tomorrow coaching' });
  await expect(cutoffCard).toBeVisible();
  await cutoffCard.getByRole('button').first().click();
  const cutoffDialog = page.getByRole('dialog');
  await expect(cutoffDialog.getByRole('heading', { name: 'Tomorrow coaching' })).toBeVisible();
  // Inside the notice window, the server's stale "you may" is overruled locally.
  await expect(cutoffDialog.getByRole('button', { name: 'Cancel booking' })).toHaveCount(0);
  await expect(cutoffDialog.getByRole('button', { name: 'Ask for a new time' })).toHaveCount(0);
  await expect(cutoffDialog.getByText(/Changes close 24 hours before the session/)).toBeVisible();
  await cutoffDialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('section[aria-labelledby="booking-history"]')).toHaveCount(0);

  const studentNavigation = page.getByRole('navigation', { name: 'Student navigation' });
  const alertsButton = studentNavigation.getByRole('button', { name: 'Alerts, 1 unread alert' });
  await expect(alertsButton).toHaveAccessibleName('Alerts, 1 unread alert');
  await alertsButton.click();

  // Unread alerts sit at the top and open into a dialog carrying the detail
  // and a way through to whatever the alert is about.
  const alertRow = page.getByRole('button', { name: /^Unread alert: Schedule changed/ });
  await expect(alertRow).toBeVisible();
  await expect(alertRow.getByText('Action needed', { exact: true })).toBeVisible();
  await alertRow.click();
  const alertDialog = page.getByRole('dialog');
  await expect(alertDialog.getByRole('heading', { name: 'Schedule changed' })).toBeVisible();
  await expect(alertDialog.getByText('Your coach moved this session. Review your bookings.')).toBeVisible();
  await expect(alertDialog.getByRole('link', { name: business.name }))
    .toHaveAttribute('href', `/book/${business.slug}`);
  await alertDialog.getByRole('button', { name: 'Go to this booking' }).click();
  await expectStudentManageUrl(page, business.slug, 'home');
  // Following the alert lands on that booking's details, not just the list.
  // The dialog is modal, so the list behind it is hidden until it is closed.
  const followedBooking = page.getByRole('dialog');
  await expect(followedBooking.getByRole('heading', { name: 'Live coaching' })).toBeVisible();
  await followedBooking.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'My bookings' })).toBeVisible();
});

test('club sign-up creates an empty affiliation and sign-in restores it', async ({ page }, testInfo) => {
  const email = uniqueEmail('club', testInfo.project.name);
  await page.goto('/signup');
  await page.getByRole('radio', { name: 'Club or academy', exact: true }).click();
  await page.getByLabel('Contact name', { exact: true }).fill('Alex Test');
  await page.getByLabel('Club or academy name', { exact: true }).fill('Alex Coaching');
  await page.getByLabel(/Email/i).fill(email);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole('button', { name: 'Create your workspace' }).click();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  await expect(page.getByText('A few small steps. A whole new rhythm.')).toBeVisible();
  const navigation = await visibleWorkspaceNavigation(page);
  await expect(navigation.getByRole('button')).toHaveCount(5);
  await navigation.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(
    page
      .getByRole('main', { name: 'Profile workspace view' })
      .getByText('Club account', { exact: true }),
  ).toBeVisible();
  await navigation.getByRole('button', { name: 'Home', exact: true }).click();

  const workspace = await (await page.request.get('/api/workspace')).json();
  expect(workspace.business.isDemo).toBe(false);
  expect(workspace.bookings).toEqual([]);
  expect(workspace.user.accountType).toBe('CLUB');
  expect(workspace.user).not.toHaveProperty('role');
  expect(workspace.membership).toMatchObject({ businessId: workspace.business.id, instructorId: null });
  expect(workspace.membership).not.toHaveProperty('role');

  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto('/login');
  await page.getByLabel(/Email/i).fill(email);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  expect((await (await page.request.get('/api/workspace')).json()).business.id).toBe(workspace.business.id);
});

test('self-registered coach is linked to a club by its club account', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const coachEmail = uniqueEmail('coach', testInfo.project.name);
  const practiceName = `Casey Practice ${projectId(testInfo.project.name)} ${Date.now()}`;
  await page.goto('/signup');
  await page.getByRole('radio', { name: /Coach/ }).click();
  await page.getByLabel(/Your full name/i).fill('Casey Coach');
  await page.getByLabel(/Email/i).fill(coachEmail);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole('button', { name: 'Create coach account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Welcome, Casey Coach.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No club access yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
  const clubWorkspace = await (await page.request.get('/api/workspace')).json() as ManagerWorkspace;
  const claimedInstructor = clubWorkspace.instructors.find(candidate =>
    clubWorkspace.services.some(service =>
      service.locations.some(mapping => mapping.instructorIds.includes(candidate.id)),
    )
      && clubWorkspace.bookings.some(booking =>
        booking.instructorId === candidate.id && booking.participants.length > 0,
      ),
  );
  expect(claimedInstructor).toBeTruthy();
  if (!claimedInstructor) throw new Error('Demo workspace needs a bookable coach with a participant');
  const clubCoachAccess = await page.request.get('/api/staff');
  expect(clubCoachAccess.ok()).toBeTruthy();
  const claimedMembership = ((await clubCoachAccess.json()) as { id: string; instructorId: string | null }[])
    .find(membership => membership.instructorId === claimedInstructor.id);
  expect(claimedMembership).toBeTruthy();
  if (!claimedMembership) throw new Error('Demo coach profile needs a removable affiliation');
  const removeClaimedMembership = await page.request.delete(`/api/staff/${claimedMembership.id}`);
  expect(removeClaimedMembership.ok()).toBeTruthy();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  await openWorkspaceView(page, 'My coaches');
  const coachAccess = page.locator('section', {
    has: page.getByRole('heading', { name: 'Coach access', exact: true }),
  });
  await expect(coachAccess.getByRole('heading', { name: 'Coach access' })).toBeVisible();
  await coachAccess.getByRole('button', { name: 'Add coach', exact: true }).click();
  const coachAccessDialog = page.getByRole('dialog');
  await expect(coachAccessDialog.getByRole('heading', { name: 'Add coach access', exact: true })).toBeVisible();
  await coachAccessDialog
    .getByRole('textbox', { name: 'Courtly coach account email', exact: true })
    .fill(coachEmail);
  const retainedProfile = coachAccessDialog.getByLabel('Coach profile (optional)')
    .locator(`option[value="${claimedInstructor.id}"]`);
  await expect(retainedProfile).toBeDisabled();
  await expect(retainedProfile).toContainText('identity retained');
  const addCoachResponse = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/staff',
  );
  await coachAccessDialog.getByRole('button', { name: 'Add coach', exact: true }).click();
  const affiliationResponse = await addCoachResponse;
  expect(affiliationResponse.status()).toBe(201);
  const affiliation = await affiliationResponse.json() as { instructorId: string | null };
  expect(affiliation.instructorId).toBeTruthy();
  if (!affiliation.instructorId) throw new Error('New coach affiliation needs its own roster profile');
  const linkedCoach = page.getByRole('listitem').filter({ hasText: coachEmail });
  await expect(linkedCoach).toBeVisible();
  await expect(linkedCoach).toContainText('Casey Coach');

  // The new coach receives their own catalog and lesson history. A departed
  // coach's retained profile is never reassigned merely to make demo data
  // visible in the scoped workspace.
  const location = clubWorkspace.locations.find(candidate => candidate.active && !candidate.requiresApproval);
  const student = clubWorkspace.students.find(candidate => candidate.userId);
  expect(location).toBeTruthy();
  expect(student).toBeTruthy();
  if (!location || !student) throw new Error('Demo workspace needs an active venue and linked student');
  const serviceResponse = await page.request.post('/api/services', {
    data: {
      name: `Casey coaching ${projectId(testInfo.project.name)} ${Date.now()}`,
      description: 'A private lesson used to verify coach-scoped workspace data.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: 9_000,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{ locationId: location.id, price: 9_000, duration: 60, instructorIds: [affiliation.instructorId] }],
    },
  });
  expect(serviceResponse.ok(), JSON.stringify(await serviceResponse.json())).toBeTruthy();
  const service = await serviceResponse.json() as { id: string };
  const lessonDate = futureDate(10);
  const lessonStart = `${lessonDate}T19:00:00+08:00`;
  const lessonDay = new Date(`${lessonDate}T12:00:00+08:00`).getUTCDay();
  const availabilityResponse = await page.request.post('/api/availability', {
    data: { instructorId: affiliation.instructorId, locationId: location.id, dayOfWeek: lessonDay, startTime: '18:00', endTime: '21:00' },
  });
  expect(availabilityResponse.ok(), JSON.stringify(await availabilityResponse.json())).toBeTruthy();
  const bookingResponse = await page.request.post('/api/bookings', {
    data: {
      serviceId: service.id,
      instructorId: affiliation.instructorId,
      locationId: location.id,
      startAt: lessonStart,
      studentId: student.id,
      repeatWeeks: 1,
      notes: 'Assigned to Casey for scoped workspace verification.',
      address: '',
    },
  });
  expect(bookingResponse.ok(), JSON.stringify(await bookingResponse.json())).toBeTruthy();

  await page.request.post('/api/auth/logout', { data: {} });
  await page.goto('/login');
  await page.getByLabel(/Email/i).fill(coachEmail);
  await page.getByLabel(/^Password/i).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
  const coachWorkspace = await (await page.request.get('/api/workspace')).json() as CoachClubWorkspace;
  const instructor = coachWorkspace.instructors.find((candidate: { name: string }) => candidate.name === 'Casey Coach');
  expect(instructor).toBeTruthy();
  if (!instructor) throw new Error('Claimed coach profile is missing from the scoped workspace');
  expect(coachWorkspace.business.id).toBe(clubWorkspace.business.id);
  expect(coachWorkspace.user.accountType).toBe('COACH');
  expect(coachWorkspace.user).not.toHaveProperty('role');
  expect(coachWorkspace.membership).toMatchObject({ businessId: clubWorkspace.business.id, instructorId: instructor.id });
  expect(coachWorkspace.membership).not.toHaveProperty('role');
  expect(coachWorkspace.services.length).toBeGreaterThan(0);
  expect(coachWorkspace.bookings.length).toBeGreaterThan(0);
  expect(coachWorkspace.services[0]).not.toHaveProperty('price');
  expect(coachWorkspace.services[0].locations.length).toBeGreaterThan(0);
  expect(coachWorkspace.services[0].locations[0]).not.toHaveProperty('price');
  expect(coachWorkspace.bookings[0]).not.toHaveProperty('price');
  expect(coachWorkspace.bookings[0].participants.length).toBeGreaterThan(0);
  expect(coachWorkspace.bookings[0].participants[0]).not.toHaveProperty('paid');
  expect(coachWorkspace.bookings[0].participants[0]).not.toHaveProperty('price');
  expect(coachWorkspace.bookings[0].participants[0]).not.toHaveProperty('packageId');

  const coachNavigation = await visibleWorkspaceNavigation(page);
  await expect(coachNavigation.getByRole('button')).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Coach snapshot' })).toBeVisible();
  await expect(page.getByText("This week's sessions", { exact: true })).toBeVisible();
  await expect(page.getByText('Assigned students', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText("This week's earnings", { exact: true })).toHaveCount(0);
  await expect(page.locator('main').getByText('Outstanding', { exact: true })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(coachWorkspace.business.currency);
  await expect(page.locator('main').getByRole('button', { name: 'Booking page', exact: true })).toHaveCount(0);
  await expect(page.locator('main').getByText('Your booking page', { exact: true })).toHaveCount(0);
  await coachNavigation.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page.getByText(/Business setup, coach access, packages, payments, and reporting are managed/)).toBeVisible();
  for (const label of ['Calendar', 'Bookings', 'Students', 'Locations', 'Availability']) {
    await expect(page.getByRole('button', { name: `Open ${label}`, exact: true })).toBeEnabled();
  }
  for (const label of ['Services', 'My coaches', 'Lesson packages', 'Payments', 'Insights', 'Integrity']) {
    await expect(page.getByRole('button', { name: `Open ${label}`, exact: true })).toHaveCount(0);
  }

  // A coach can discover a venue before the club assigns it to a service. It
  // remains visible after refresh, but existing venue settings stay read-only.
  await page.getByRole('button', { name: 'Open Locations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Locations', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add location', exact: true }).click();
  const locationDialog = page.getByRole('dialog');
  const mapsLink = 'https://www.google.com/maps/place/Coach+Discovery+Court/@1.3045,103.8745,17z/data=!4m2';
  await locationDialog.getByRole('textbox', { name: 'Search for a venue', exact: true }).fill(mapsLink);
  await locationDialog.getByRole('button', { name: 'Search', exact: true }).click();
  await locationDialog.getByRole('button', { name: /Coach Discovery Court/ }).click();
  await expect(locationDialog.locator('input[name=\"name\"]')).toHaveValue('Coach Discovery Court');
  await locationDialog.getByRole('button', { name: 'Save location', exact: true }).click();
  await expect(locationDialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Coach Discovery Court', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Edit location/ })).toHaveCount(0);
  await page.goto('/?tab=explore');
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();

  await coachNavigation.getByRole('button', { name: 'Create', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create' });
  await expect(createDialog.getByRole('heading', { name: 'Quick actions', exact: true })).toBeVisible();
  await expect(createDialog.getByRole('button', { name: /^New booking\b/ })).toBeVisible();
  for (const action of ['Availability', 'Locations']) {
    await expect(createDialog.getByRole('button', { name: new RegExp(`^${action}\\b`) })).toBeVisible();
  }
  for (const action of ['Students', 'Services', 'Payments']) {
    await expect(createDialog.getByRole('button', { name: new RegExp(`^${action}\\b`) })).toHaveCount(0);
  }
  await createDialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.goto('/?tab=explore&view=payments');
  await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=explore$/);
  await expect(page.locator('main')).not.toContainText('A clear picture of money');

  const refreshedNavigation = await visibleWorkspaceNavigation(page);
  await refreshedNavigation.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.locator('main').getByRole('heading', { name: 'Casey Coach', exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('Coach', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByRole('button', { name: 'Business settings', exact: true })).toHaveCount(0);

  await page.goto('/?tab=profile&view=settings');
  await expect(page.locator('main').getByRole('heading', { name: 'Casey Coach', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\?tab=profile$/);
  await expect(page.locator('main').getByRole('button', { name: 'Business settings', exact: true })).toHaveCount(0);

  // A coach creates their one direct-payment practice from the account UI.
  // The endpoint also selects it, so entering the new workspace is part of the
  // same user journey rather than an API-only setup shortcut.
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: /Welcome, Casey Coach/ })).toBeVisible();
  const accountWorkspaces = page.locator('section', {
    has: page.getByRole('heading', { name: 'Your coaching workspaces' }),
  });
  await expect(accountWorkspaces.getByRole('button').filter({ hasText: clubWorkspace.business.name })).toBeVisible();
  await page.getByLabel('Name your practice').fill(practiceName);
  const createPracticeResponse = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/auth/practice',
  );
  await page.getByRole('button', { name: /Create practice/ }).click();
  expect((await createPracticeResponse).status()).toBe(201);
  await expectWorkspaceHomeUrl(page);
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();

  const soloWorkspace = await (await page.request.get('/api/workspace')).json() as ManagerWorkspace;
  expect(soloWorkspace.business).toMatchObject({ name: practiceName, kind: 'SOLO' });
  expect(soloWorkspace.user.accountType).toBe('COACH');
  expect(soloWorkspace.memberships.filter((membership: { business: { kind: string } }) => membership.business.kind === 'SOLO')).toHaveLength(1);
  expect(soloWorkspace.memberships.filter((membership: { business: { kind: string } }) => membership.business.kind === 'CLUB')).toHaveLength(1);

  let switchedNavigation = await visibleWorkspaceNavigation(page);
  await expect(page.getByText("This week's earnings", { exact: true })).toBeVisible();
  await expect(page.getByText('Outstanding', { exact: true })).toBeVisible();
  await switchedNavigation.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Services', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Open Payments', exact: true })).toBeEnabled();

  await switchedNavigation.getByRole('button', { name: 'Profile', exact: true }).click();
  const affiliationList = page.locator('section', {
    has: page.getByRole('heading', { name: 'My workspaces' }),
  });
  await expect(affiliationList.getByRole('listitem').filter({ hasText: clubWorkspace.business.name })).toBeVisible();
  await expect(affiliationList.getByRole('listitem').filter({ hasText: practiceName })).toBeVisible();

  await page.getByRole('button', { name: 'Switch workspace' }).click();
  let workspaceDialog = page.getByRole('dialog', { name: 'Switch workspace' });
  const clubOption = workspaceDialog.getByRole('button').filter({ hasText: clubWorkspace.business.name });
  const soloOption = workspaceDialog.getByRole('button').filter({ hasText: practiceName });
  await expect(clubOption).toContainText(/Club or academy/);
  await expect(soloOption).toContainText(/Own practice/);
  await expect(soloOption).toContainText(/Current/);
  await clubOption.click();
  await expectWorkspaceHomeUrl(page);
  await expect(page.getByRole('region', { name: 'Coach snapshot' })).toBeVisible();
  await expect(page.getByText("This week's earnings", { exact: true })).toHaveCount(0);
  await expect(page.getByText('Outstanding', { exact: true })).toHaveCount(0);

  const switchedClubWorkspace = await (await page.request.get('/api/workspace')).json();
  expect(switchedClubWorkspace.business).toMatchObject({ id: clubWorkspace.business.id, kind: 'CLUB' });
  switchedNavigation = await visibleWorkspaceNavigation(page);
  await switchedNavigation.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Availability', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Open Payments', exact: true })).toHaveCount(0);

  // Switching back from the club-scoped workspace resets stale tab/view state
  // and restores the manager-only business and financial tools.
  await switchedNavigation.getByRole('button', { name: 'Profile', exact: true }).click();
  await page.getByRole('button', { name: 'Switch workspace' }).click();
  workspaceDialog = page.getByRole('dialog', { name: 'Switch workspace' });
  await workspaceDialog.getByRole('button').filter({ hasText: practiceName }).click();
  await expectWorkspaceHomeUrl(page);
  await expect(page.getByText("This week's earnings", { exact: true })).toBeVisible();
  await expect(page.getByText('Outstanding', { exact: true })).toBeVisible();
  const switchedSoloWorkspace = await (await page.request.get('/api/workspace')).json();
  expect(switchedSoloWorkspace.business).toMatchObject({ id: soloWorkspace.business.id, kind: 'SOLO' });
  expect(switchedSoloWorkspace.memberships.filter((membership: { business: { kind: string } }) => membership.business.kind === 'SOLO')).toHaveLength(1);

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: /Welcome, Casey Coach/ })).toBeVisible();
  const finalAffiliations = page.locator('section', {
    has: page.getByRole('heading', { name: 'Your coaching workspaces' }),
  });
  await expect(finalAffiliations.getByRole('button').filter({ hasText: clubWorkspace.business.name })).toBeVisible();
  await expect(finalAffiliations.getByRole('button').filter({ hasText: practiceName })).toBeVisible();
  await expect(page.getByLabel('Name your practice')).toHaveCount(0);
});
