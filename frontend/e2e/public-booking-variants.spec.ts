import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Response,
  type Route,
} from '@playwright/test';
import type {
  AuthSession,
  Booking,
  Location,
  ManagerWorkspace,
  PublicBusiness,
  Service,
  Slot,
} from '../src/lib/types';

const password = 'TestingOnly!2026';

type Setup = {
  slug: string;
  catalog: PublicBusiness;
  coachName: string;
  coachEmail: string;
  coachStorage: Awaited<ReturnType<APIRequestContext['storageState']>>;
  studentName: string;
  studentEmail: string;
  groupService: Service;
  privateService: Service;
  facility: Location;
  home: Location;
  online: Location;
  pending: Location;
  groupDate: string;
  groupStartAt: string;
  fullGroupStartAt: string;
  homeDate: string;
  onlineDate: string;
  pendingDate: string;
  coachDate: string;
  recurringDate: string;
  recurringStartAt: string;
  groupBookingId: string;
};

let provider: APIRequestContext;
let setup: Setup;

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function futureSingaporeDate(days: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

function localStart(date: string, hour: number) {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`).toISOString();
}

function addWeeks(startAt: string, weeks: number) {
  return new Date(new Date(startAt).getTime() + weeks * 7 * 86_400_000).toISOString();
}

function localDayOfWeek(date: string) {
  return new Date(`${date}T12:00:00+08:00`).getUTCDay();
}

async function responseJson<T>(response: APIResponse): Promise<T> {
  const body = await response.json() as T;
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function browserResponseJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T;
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', json });
}

async function createLocation(values: {
  name: string;
  address: string;
  type: 'HOME' | 'ONLINE' | 'RENTED';
  requiresApproval: boolean;
}) {
  return responseJson<Location>(await provider.post('/api/locations', {
    data: { ...values, travelMinutes: 0, notes: '' },
  }));
}

test.beforeAll(async ({}, workerInfo) => {
  test.setTimeout(120_000);
  const baseURL = String(workerInfo.project.use.baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000');
  const runId = `${projectId(workerInfo.project.name)}-${Date.now()}`;
  const coachName = `Variant Coach ${projectId(workerInfo.project.name)}`;
  const coachEmail = `variant-coach-${runId}@example.test`;
  const studentName = `Variant Student ${projectId(workerInfo.project.name)}`;
  const studentEmail = `variant-student-${runId}@example.test`;

  const coach = await playwrightRequest.newContext({ baseURL });
  const student = await playwrightRequest.newContext({ baseURL });
  provider = await playwrightRequest.newContext({ baseURL });
  try {
    await responseJson<AuthSession>(await coach.post('/api/auth/register', {
      data: { accountType: 'COACH', name: coachName, email: coachEmail, password },
    }));
    await responseJson<AuthSession>(await student.post('/api/auth/register', {
      data: { accountType: 'STUDENT', name: studentName, email: studentEmail, password },
    }));
    await student.dispose();

    await responseJson<AuthSession>(await provider.post('/api/auth/demo', { data: {} }));
    const workspace = await responseJson<ManagerWorkspace>(await provider.get('/api/workspace'));
    const facility = workspace.locations.find(candidate =>
      candidate.type === 'FACILITY' && candidate.active && !candidate.requiresApproval,
    );
    expect(facility).toBeTruthy();
    if (!facility) throw new Error('Demo workspace needs an active facility');
    expect(workspace.students.length).toBeGreaterThanOrEqual(2);

    const affiliation = await responseJson<{ instructorId: string | null }>(await provider.post('/api/staff', {
      data: { email: coachEmail },
    }));
    expect(affiliation.instructorId).toBeTruthy();
    const instructorId = affiliation.instructorId!;

    const [home, online, pending] = await Promise.all([
      createLocation({
        name: `At your home ${runId}`,
        address: '',
        type: 'HOME',
        requiresApproval: false,
      }),
      createLocation({
        name: `Video coaching ${runId}`,
        address: 'Joining details shared after confirmation',
        type: 'ONLINE',
        requiresApproval: false,
      }),
      createLocation({
        name: `Approval court ${runId}`,
        address: 'Venue arranged separately',
        type: 'RENTED',
        requiresApproval: true,
      }),
    ]);

    const groupService = await responseJson<Service>(await provider.post('/api/services', {
      data: {
        name: `Variant group ${runId}`,
        description: 'A live group lesson for public-booking capacity coverage.',
        category: 'Tennis',
        type: 'GROUP',
        duration: 60,
        price: 7_500,
        capacity: 3,
        bufferMinutes: 0,
        noticeHours: 0,
        color: 'sage',
        active: true,
        locations: [{ locationId: facility.id, price: 7_500, duration: 60, instructorIds: [instructorId] }],
      },
    }));
    const privateService = await responseJson<Service>(await provider.post('/api/services', {
      data: {
        name: `Variant private ${runId}`,
        description: 'A live private lesson for public-booking venue coverage.',
        category: 'Tennis',
        type: 'PRIVATE',
        duration: 60,
        price: 8_500,
        capacity: 1,
        bufferMinutes: 0,
        noticeHours: 0,
        color: 'sage',
        active: true,
        locations: [facility, home, online, pending].map(venue => ({
          locationId: venue.id,
          price: 8_500,
          duration: 60,
          instructorIds: [instructorId],
        })),
      },
    }));

    const groupDate = futureSingaporeDate(30);
    const homeDate = futureSingaporeDate(31);
    const onlineDate = futureSingaporeDate(32);
    const pendingDate = futureSingaporeDate(33);
    const coachDate = futureSingaporeDate(34);
    const recurringDate = futureSingaporeDate(42);
    const availability = [
      { locationId: facility.id, date: groupDate },
      { locationId: facility.id, date: recurringDate },
      { locationId: home.id, date: homeDate },
      { locationId: online.id, date: onlineDate },
      { locationId: online.id, date: coachDate },
      { locationId: pending.id, date: pendingDate },
    ];
    for (const item of availability.filter((item, index, values) =>
      values.findIndex(candidate => candidate.locationId === item.locationId
        && localDayOfWeek(candidate.date) === localDayOfWeek(item.date)) === index,
    )) {
      await responseJson(await provider.post('/api/availability', {
        data: {
          instructorId,
          locationId: item.locationId,
          dayOfWeek: localDayOfWeek(item.date),
          startTime: '09:00',
          endTime: '14:00',
        },
      }));
    }

    // Logging in again selects the club affiliation that was added after the
    // standalone coach account was registered. Successful logins do not spend
    // the failed-login rate-limit budget.
    await responseJson<AuthSession>(await coach.post('/api/auth/login', {
      data: { email: coachEmail, password },
    }));
    const groupStartAt = localStart(groupDate, 10);
    const fullGroupStartAt = localStart(groupDate, 12);
    const groupBooking = await responseJson<{ bookings: Booking[] }>(await coach.post('/api/bookings', {
      data: {
        serviceId: groupService.id,
        instructorId,
        locationId: facility.id,
        startAt: groupStartAt,
        studentId: workspace.students[0].id,
        repeatWeeks: 1,
        notes: 'Existing group participant.',
        address: '',
      },
    }));
    for (const existingStudent of workspace.students.slice(0, 3)) {
      await responseJson<{ bookings: Booking[] }>(await coach.post('/api/bookings', {
        data: {
          serviceId: groupService.id,
          instructorId,
          locationId: facility.id,
          startAt: fullGroupStartAt,
          studentId: existingStudent.id,
          repeatWeeks: 1,
          notes: 'Fills the second group.',
          address: '',
        },
      }));
    }

    const recurringStartAt = localStart(recurringDate, 10);
    await responseJson<{ bookings: Booking[] }>(await coach.post('/api/bookings', {
      data: {
        serviceId: privateService.id,
        instructorId,
        locationId: facility.id,
        startAt: addWeeks(recurringStartAt, 2),
        studentId: workspace.students[1].id,
        repeatWeeks: 1,
        notes: 'Conflicts with week three of the public recurrence.',
        address: '',
      },
    }));

    const coachStorage = await coach.storageState();
    const catalog = await responseJson<PublicBusiness>(await provider.get(`/api/public/${workspace.business.slug}`));
    setup = {
      slug: workspace.business.slug,
      catalog,
      coachName,
      coachEmail,
      coachStorage,
      studentName,
      studentEmail,
      groupService,
      privateService,
      facility,
      home,
      online,
      pending,
      groupDate,
      groupStartAt,
      fullGroupStartAt,
      homeDate,
      onlineDate,
      pendingDate,
      coachDate,
      recurringDate,
      recurringStartAt,
      groupBookingId: groupBooking.bookings[0].id,
    };
  } finally {
    await coach.dispose();
    // `student` is normally closed immediately after registration. dispose()
    // is idempotent enough for the exceptional setup path as well.
    await student.dispose().catch(() => undefined);
  }
});

test.afterAll(async () => {
  await provider?.dispose();
});

async function loginStudent(page: Page) {
  await responseJson<AuthSession>(await page.request.post('/api/auth/login', {
    data: { email: setup.studentEmail, password },
  }));
}

async function openLiveBooking(page: Page) {
  await page.goto(`/book/${setup.slug}`);
  await expect(page.getByRole('heading', { name: 'Good days start with a lesson.', exact: true })).toBeVisible();
}

function visibleBookingAction(page: Page, name: string | RegExp) {
  return page.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true });
}

async function chooseLessonAndTime(
  page: Page,
  service: Service,
  venue: Location,
  date: string,
  timeLabel = '10:00 AM',
) {
  await page.getByRole('button', { name: new RegExp(escapeRegExp(service.name)) }).click();
  await visibleBookingAction(page, 'Continue').click();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(venue.name)) }).click();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(setup.coachName)) }).click();
  await visibleBookingAction(page, 'Continue').click();
  await page.getByLabel('Choose a date', { exact: true }).fill(date);
  await page.getByRole('button', { name: new RegExp(`^${escapeRegExp(timeLabel)}`) }).click();
  await visibleBookingAction(page, 'Continue').click();
}

async function submitReviewedBooking(page: Page, action: 'Confirm booking' | 'Request booking') {
  await page.getByRole('checkbox').check();
  const responsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/public/${setup.slug}/bookings`,
  );
  await visibleBookingAction(page, action).click();
  return responsePromise;
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
}

test('an already-signed-in student keeps the selected booking and skips account access', async ({ page }) => {
  await loginStudent(page);
  await openLiveBooking(page);
  await chooseLessonAndTime(page, setup.privateService, setup.online, setup.onlineDate);

  await expect(page.getByRole('heading', { name: setup.studentName, exact: true })).toBeVisible();
  await expect(page.getByText(setup.studentEmail, { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Sign in', exact: true })).toHaveCount(0);
  await visibleBookingAction(page, 'Review booking').click();

  const review = page.locator('section', {
    has: page.getByRole('heading', { name: 'Your session, at a glance', exact: true }),
  });
  await expect(review).toContainText(setup.privateService.name);
  await expect(review).toContainText(setup.online.name);
  await expect(review).toContainText('10:00 AM – 11:00 AM');
  await expectNoHorizontalOverflow(page);
});

test('a signed-in coach is rejected and can safely sign out without losing the selection', async ({ page }) => {
  await page.context().addCookies(setup.coachStorage.cookies);
  await openLiveBooking(page);
  await chooseLessonAndTime(page, setup.privateService, setup.online, setup.coachDate);

  await expect(page.getByRole('heading', { name: 'Use a student account to book', exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`signed in as ${escapeRegExp(setup.coachEmail)}, a coach or club account`))).toBeVisible();
  await expect(visibleBookingAction(page, 'Continue with account')).toBeDisabled();

  const logout = page.waitForResponse(response =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/auth/logout',
  );
  await page.getByRole('button', { name: 'Sign out and switch account', exact: true }).click();
  expect((await logout).ok()).toBeTruthy();
  await expect(page.getByRole('tab', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Date & time', exact: true }).click();
  await expect(page.getByRole('button', { name: /^10:00 AM/ })).toHaveAttribute('aria-pressed', 'true');
  await expectNoHorizontalOverflow(page);
});

test('a student joins an existing group while a full group stays unavailable', async ({ page }) => {
  await loginStudent(page);
  await openLiveBooking(page);
  await page.getByRole('button', { name: new RegExp(escapeRegExp(setup.groupService.name)) }).click();
  await visibleBookingAction(page, 'Continue').click();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(setup.facility.name)) }).click();
  await page.getByRole('button', { name: new RegExp(escapeRegExp(setup.coachName)) }).click();
  await visibleBookingAction(page, 'Continue').click();
  await page.getByLabel('Choose a date', { exact: true }).fill(setup.groupDate);

  await expect(page.getByRole('button', { name: /10:00 AM.*2 places left/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '12:00 PM', exact: true })).toHaveCount(0);
  const slots = await responseJson<{ slots: Slot[] }>(await page.request.get(`/api/public/${setup.slug}/slots`, {
    params: {
      serviceId: setup.groupService.id,
      instructorId: setup.catalog.instructors.find(candidate => candidate.name === setup.coachName)!.id,
      locationId: setup.facility.id,
      date: setup.groupDate,
    },
  }));
  expect(slots.slots.find(candidate => candidate.startAt === setup.fullGroupStartAt)).toMatchObject({
    available: false,
    placesRemaining: 0,
    reason: 'This group is full',
  });

  await page.getByRole('button', { name: /10:00 AM.*2 places left/ }).click();
  await visibleBookingAction(page, 'Continue').click();
  await visibleBookingAction(page, 'Review booking').click();
  const response = await submitReviewedBooking(page, 'Confirm booking');
  const result = await browserResponseJson<{ bookings: Booking[] }>(response);
  expect(result.bookings[0].id).toBe(setup.groupBookingId);
  await expect(page.getByRole('heading', { name: 'You’re on the calendar.', exact: true })).toBeVisible();

  const providerBookings = await responseJson<Booking[]>(await provider.get('/api/bookings'));
  const joined = providerBookings.find(candidate => candidate.id === setup.groupBookingId);
  expect(joined?.participants.map(participant => participant.email)).toEqual(expect.arrayContaining([setup.studentEmail]));
  expect(joined?.participants).toHaveLength(2);
  await expectNoHorizontalOverflow(page);
});

test('HOME requires an address and persists it with the booking', async ({ page }) => {
  await loginStudent(page);
  await openLiveBooking(page);
  await chooseLessonAndTime(page, setup.privateService, setup.home, setup.homeDate);

  const bookingEndpoint = `/api/public/${setup.slug}/bookings`;
  let bookingPostCount = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === bookingEndpoint) {
      bookingPostCount += 1;
    }
  });
  const currentStep = page.locator('nav[aria-label="Booking progress"] button[aria-current="step"]');
  const detailsForm = page.locator('form#booking-details');
  const reviewHeading = page.getByRole('heading', { name: 'Your session, at a glance', exact: true });
  const review = page.locator('section', { has: reviewHeading });
  const address = page.getByLabel('Session address', { exact: false });
  await expect(address).toBeVisible();
  await visibleBookingAction(page, 'Review booking').click();

  await expect(currentStep).toContainText('Student account');
  await expect(detailsForm).toBeVisible();
  await expect(reviewHeading).toHaveCount(0);
  await expect(address).toBeFocused();
  expect(await address.evaluate(element => (element as HTMLTextAreaElement).validity.valueMissing)).toBe(true);
  expect(bookingPostCount).toBe(0);

  const homeAddress = '88 Test Street, #08-08, Singapore 888888';
  await address.fill(homeAddress);
  await visibleBookingAction(page, 'Review booking').click();
  await expect(currentStep).toContainText('Review');
  await expect(detailsForm).toHaveCount(0);
  await expect(reviewHeading).toBeVisible();
  await expect(review).toContainText(homeAddress);
  expect(bookingPostCount).toBe(0);
  const response = await submitReviewedBooking(page, 'Confirm booking');
  const result = await browserResponseJson<{ bookings: Booking[] }>(response);
  expect(result.bookings[0]).toMatchObject({ address: homeAddress, status: 'CONFIRMED' });
  await expect(page.getByRole('heading', { name: 'You’re on the calendar.', exact: true })).toBeVisible();
  expect(bookingPostCount).toBe(1);
  await expectNoHorizontalOverflow(page);
});

test('ONLINE books without an address and follows the confirmed path', async ({ page }) => {
  await loginStudent(page);
  await openLiveBooking(page);
  await chooseLessonAndTime(page, setup.privateService, setup.online, setup.onlineDate);

  await expect(page.getByLabel('Session address', { exact: false })).toHaveCount(0);
  await visibleBookingAction(page, 'Review booking').click();
  await expect(page.getByText('Joining details shared after confirmation', { exact: true })).toBeVisible();
  const response = await submitReviewedBooking(page, 'Confirm booking');
  const result = await browserResponseJson<{ bookings: Booking[] }>(response);
  expect(result.bookings[0]).toMatchObject({ address: '', status: 'CONFIRMED' });
  await expect(page.getByRole('heading', { name: 'You’re on the calendar.', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('a venue requiring approval uses the request and pending receipt path', async ({ page }) => {
  await loginStudent(page);
  await openLiveBooking(page);
  await chooseLessonAndTime(page, setup.privateService, setup.pending, setup.pendingDate);

  await visibleBookingAction(page, 'Review booking').click();
  await expect(page.getByText('Venue confirmation required', { exact: true })).toBeVisible();
  const response = await submitReviewedBooking(page, 'Request booking');
  const result = await browserResponseJson<{ bookings: Booking[] }>(response);
  expect(result.bookings[0].status).toBe('PENDING');
  await expect(page.getByRole('heading', { name: 'Your request is in.', exact: true })).toBeVisible();
  await expect(page.getByText('Awaiting confirmation', { exact: true })).toBeVisible();
  await expect(page.getByText('Venue to be arranged — booking does not reserve a court', { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('a recurring conflict is atomic and sends the student back to choose another time', async ({ page }) => {
  await loginStudent(page);
  await openLiveBooking(page);
  await chooseLessonAndTime(page, setup.privateService, setup.facility, setup.recurringDate);

  await page.getByRole('button', { name: /4 weeks/ }).click();
  await visibleBookingAction(page, 'Review booking').click();
  const response = await submitReviewedBooking(page, 'Confirm booking');
  expect(response.status()).toBe(409);
  const body = await response.json() as { error: string; conflicts: Array<{ date: string; reason: string }> };
  expect(body.error).toContain('No bookings were created');
  expect(body.conflicts).toContainEqual({
    date: addWeeks(setup.recurringStartAt, 2),
    reason: 'Coach already has a session or preparation buffer',
  });

  const conflictAlert = page.getByRole('alert').filter({ hasText: 'No bookings were created' });
  await expect(conflictAlert).toContainText('Coach already has a session or preparation buffer');
  const requestedStarts = new Set(Array.from({ length: 4 }, (_, index) => addWeeks(setup.recurringStartAt, index)));
  const providerBookings = await responseJson<Booking[]>(await provider.get('/api/bookings'));
  const partialBookings = providerBookings.filter(candidate =>
    requestedStarts.has(candidate.startAt)
      && candidate.participants.some(participant => participant.email === setup.studentEmail),
  );
  expect(partialBookings).toEqual([]);

  await page.getByRole('button', { name: 'Choose a different time', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make a little time for your game.', exact: true })).toBeVisible();
  await expect(visibleBookingAction(page, 'Continue')).toBeDisabled();
  await expectNoHorizontalOverflow(page);
});

test('invalid slugs and slot failures provide working retry controls', async ({ page }) => {
  const retrySlug = `missing-${projectId(test.info().project.name)}-${Date.now()}`;
  await page.goto(`/book/${retrySlug}`);
  await expect(page.getByRole('heading', { name: 'We couldn’t open this booking page', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Booking page not found' })).toBeVisible();

  const fixture = retryCatalog(retrySlug);
  await page.route(`**/api/public/${retrySlug}`, route => fulfillJson(route, fixture));
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good days start with a lesson.', exact: true })).toBeVisible();

  let slotsAvailable = false;
  const date = futureSingaporeDate(20);
  await page.route(`**/api/public/${retrySlug}/slots?*`, route =>
    slotsAvailable
      ? fulfillJson(route, { slots: [{
          startAt: localStart(date, 10),
          endAt: localStart(date, 11),
          available: true,
          placesRemaining: 1,
        }] })
      : fulfillJson(route, { error: 'Availability is temporarily unavailable' }, 503),
  );
  await page.getByRole('button', { name: new RegExp(fixture.services[0].name) }).click();
  await visibleBookingAction(page, 'Continue').click();
  await page.getByRole('button', { name: new RegExp(fixture.locations[0].name) }).click();
  await page.getByRole('button', { name: new RegExp(fixture.instructors[0].name) }).click();
  await visibleBookingAction(page, 'Continue').click();
  await page.getByLabel('Choose a date', { exact: true }).fill(date);

  await expect(page.getByRole('alert').filter({ hasText: 'Availability is temporarily unavailable' })).toBeVisible();
  slotsAvailable = true;
  await page.getByRole('button', { name: 'Retry availability', exact: true }).click();
  await expect(page.getByRole('button', { name: /^10:00 AM/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

function retryCatalog(slug: string): PublicBusiness {
  return {
    business: {
      name: 'Retry Racket Club',
      slug,
      ownerName: 'Courtly Tests',
      timezone: 'Asia/Singapore',
      currency: 'SGD',
      color: '#214e3e',
      tagline: 'Try that request again.',
      cancellationHours: 24,
      kind: 'CLUB',
    },
    instructors: [{
      id: 'retry-coach',
      name: 'Retry Coach',
      initials: 'RC',
      color: '#527a5b',
      specialty: 'Reliable retries',
      active: true,
    }],
    locations: [{
      id: 'retry-court',
      name: 'Retry Court',
      address: '1 Retry Way',
      type: 'FACILITY',
      color: '#78915e',
      requiresApproval: false,
      active: true,
    }],
    services: [{
      id: 'retry-lesson',
      name: 'Retry lesson',
      description: 'A deterministic slot retry.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: 7_500,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{
        locationId: 'retry-court',
        price: 7_500,
        duration: 60,
        instructorIds: ['retry-coach'],
      }],
    }],
  };
}
