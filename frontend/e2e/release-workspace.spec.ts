import { expect, test, type Page, type Request, type Route } from '@playwright/test';

const frozenTime = new Date('2026-09-25T02:00:00.000Z');
const bookingStart = '2026-09-26T02:00:00.000Z';
const rentalStart = '2026-09-26T03:00:00.000Z';

const business = {
  id: 'release-club',
  name: 'Release Rackets Club',
  slug: 'release-rackets-club',
  ownerName: 'Release Operations',
  email: 'club@example.test',
  timezone: 'Asia/Singapore',
  currency: 'SGD',
  color: '#174c3c',
  tagline: 'A dependable place to play.',
  cancellationHours: 24,
  kind: 'CLUB',
  isDemo: false,
  legacyReadOnly: false,
};

const location = {
  id: 'release-court',
  name: 'Release Centre Court',
  address: '1 Release Road, Singapore',
  type: 'FACILITY',
  color: '#78915e',
  requiresApproval: false,
  travelMinutes: 15,
  notes: 'Indoor court.',
  source: 'MANUAL',
  placeId: '',
  mapsUrl: '',
  latitude: null,
  longitude: null,
  active: true,
};

const instructor = {
  id: 'release-coach-profile',
  name: 'Casey Coach',
  initials: 'CC',
  color: '#78915e',
  email: 'casey.coach@example.test',
  specialty: 'Legacy specialty should stay hidden',
  rescheduleNoticeHours: 36,
  active: true,
  accountLinkAvailable: false,
};

const privateService = {
  id: 'private-class',
  name: 'Private release lesson',
  description: 'One-to-one coaching.',
  category: 'Tennis',
  type: 'PRIVATE',
  duration: 60,
  price: 8_000,
  capacity: 1,
  bufferMinutes: 15,
  noticeHours: 4,
  color: '#78915e',
  active: true,
  locations: [{ locationId: location.id, price: 8_000, duration: 60, instructorIds: [instructor.id] }],
};

const groupService = {
  ...privateService,
  id: 'group-class',
  name: 'Group release clinic',
  type: 'GROUP',
  capacity: 6,
};

const student = {
  id: 'release-student-row',
  userId: 'release-student-account',
  name: 'Sam Student',
  email: 'sam.student@example.test',
  phone: '',
  initials: 'SS',
  notes: '',
  parentName: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  bookingCount: 0,
  lastBookingAt: null,
};

function membership(userId: string, instructorId: string | null) {
  return {
    id: `membership-${userId}`,
    userId,
    businessId: business.id,
    instructorId,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    business,
  };
}

function workspace(accountType: 'CLUB' | 'COACH') {
  const coach = accountType === 'COACH';
  const userId = coach ? 'release-coach-account' : 'release-club-account';
  const currentMembership = membership(userId, coach ? instructor.id : null);
  return {
    business,
    user: {
      id: userId,
      name: coach ? instructor.name : business.name,
      username: coach ? 'casey_coach' : 'release_rackets',
      email: coach ? instructor.email : 'signin.club@example.test',
      accountType,
      sports: ['Tennis'],
      phone: '',
      parentName: '',
      instructorId: coach ? instructor.id : null,
    },
    membership: currentMembership,
    memberships: [currentMembership],
    clubAccount: !coach,
    instructors: [instructor],
    locations: [location],
    services: [privateService, groupService],
    availability: [{
      id: 'release-hours',
      instructorId: instructor.id,
      locationId: location.id,
      dayOfWeek: 6,
      startTime: '09:00',
      endTime: '13:00',
    }],
    exceptions: [],
    students: [student],
    packages: [],
    bookings: [],
    payments: [],
    notifications: [],
    rescheduleRequests: [],
    integrityFlags: [],
  };
}

function coachWorkspaceWithAffiliations() {
  const current = workspace('COACH');
  return {
    ...current,
    memberships: [
      current.membership,
      {
        ...membership('release-coach-account', 'other-active-coach-profile'),
        id: 'membership-other-club',
        businessId: 'other-club',
        business: {
          ...business,
          id: 'other-club',
          name: 'Second Serve Academy',
          slug: 'second-serve-academy',
        },
      },
      {
        ...membership('release-coach-account', 'inactive-coach-profile'),
        id: 'membership-inactive-club',
        businessId: 'inactive-club',
        active: false,
        business: {
          ...business,
          id: 'inactive-club',
          name: 'Inactive Courts Club',
          slug: 'inactive-courts-club',
        },
      },
      {
        ...membership('release-coach-account', 'solo-coach-profile'),
        id: 'membership-solo-practice',
        businessId: 'solo-practice',
        business: {
          ...business,
          id: 'solo-practice',
          name: 'Casey Private Coaching',
          slug: 'casey-private-coaching',
          kind: 'SOLO',
        },
      },
      {
        ...membership('release-coach-account', 'legacy-coach-profile'),
        id: 'membership-legacy-club',
        businessId: 'legacy-club',
        business: {
          ...business,
          id: 'legacy-club',
          name: 'Legacy Courts Club',
          slug: 'legacy-courts-club',
          legacyReadOnly: true,
        },
      },
    ],
  };
}

const integrityFlag = {
  id: 'release-integrity-flag',
  instructorId: instructor.id,
  coachName: instructor.name,
  studentName: student.name,
  type: 'OUTSIDE_BOOKING',
  status: 'OPEN',
  detail: 'A direct lesson followed an earlier club lesson for this coach and student.',
  occurrences: 2,
  outsideBusinessName: 'Casey Private Coaching',
  firstSeenAt: '2026-09-20T02:00:00.000Z',
  lastSeenAt: '2026-09-24T02:00:00.000Z',
  resolvedAt: null,
  resolutionNote: '',
  flaggedSessionAt: '2026-09-24T02:00:00.000Z',
  flaggedServiceName: 'Private release lesson',
};

function integrityWorkspace() {
  return {
    ...workspace('CLUB'),
    notifications: [{
      id: 'release-integrity-alert',
      type: 'INTEGRITY',
      bookingId: null,
      integrityFlagId: integrityFlag.id,
      title: 'Review a private booking pattern',
      message: 'A coach and student also booked outside the club.',
      read: true,
      actionNeeded: true,
      createdAt: '2026-09-24T02:00:00.000Z',
    }],
    integrityFlags: [integrityFlag],
  };
}

const rental = {
  id: location.id,
  locationId: location.id,
  enabled: true,
  name: location.name,
  address: location.address,
  sport: 'Tennis',
  amenities: ['Indoor', 'Showers'],
  unitLabel: 'Court',
  price: 4_500,
  currency: 'SGD',
  timezone: 'Asia/Singapore',
  club: { name: business.name, slug: business.slug },
  minDuration: 60,
  maxDuration: 120,
  startInterval: 30,
  durationIncrement: 30,
  noticeHours: 2,
  advanceDays: 30,
  cancellationHours: 24,
  rules: 'Non-marking shoes only.',
  units: [{ id: 'release-unit', name: 'Court 1', active: true }],
  openingHours: [{ dayOfWeek: 6, startTime: '09:00', endTime: '21:00' }],
};

const reservation = {
  id: 'release-reservation',
  businessName: business.name,
  locationId: location.id,
  locationName: location.name,
  unitId: 'release-unit',
  unitName: 'Court 1',
  startAt: rentalStart,
  endAt: '2026-09-26T04:00:00.000Z',
  duration: 60,
  price: 4_500,
  status: 'CONFIRMED',
  paymentStatus: 'PAID',
  packageId: null,
  creditConsumed: false,
  currency: 'SGD',
  timezone: 'Asia/Singapore',
  cancellationDeadline: '2026-09-25T03:00:00.000Z',
  cancellable: true,
};

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function requestPath(request: Request) {
  return new URL(request.url()).pathname;
}

async function mockWorkspace(page: Page, accountType: 'CLUB' | 'COACH') {
  await page.route('**/api/workspace', route => fulfillJson(route, workspace(accountType)));
}

async function mockMarketplace(page: Page, options: { initialReservations?: Array<typeof reservation> } = {}) {
  let reservations = [...(options.initialReservations ?? [])];
  let cancellationCount = 0;
  await page.route(/\/api\/rentals(?:\/.*)?(?:\?.*)?$/, route => {
    const request = route.request();
    const path = requestPath(request);
    if (request.method() === 'GET' && path === '/api/rentals') {
      return fulfillJson(route, { rentals: [rental], nextCursor: null });
    }
    if (request.method() === 'GET' && path === '/api/rentals/reservations/mine') {
      return fulfillJson(route, { reservations });
    }
    if (request.method() === 'GET' && path === `/api/rentals/${location.id}`) {
      return fulfillJson(route, { rental });
    }
    if (request.method() === 'GET' && path === `/api/rentals/${rental.id}/slots`) {
      return fulfillJson(route, {
        date: '2026-09-26',
        duration: 60,
        timezone: rental.timezone,
        slots: [{
          unitId: 'release-unit',
          unitName: 'Court 1',
          startAt: rentalStart,
          endAt: reservation.endAt,
          price: 4_500,
        }],
      });
    }
    if (request.method() === 'POST' && path === `/api/rentals/${rental.id}/reservations`) {
      reservations = [reservation, ...reservations.filter(item => item.id !== reservation.id)];
      return fulfillJson(route, {
        reservation,
        paymentIntent: {
          id: 'release-rental-payment',
          kind: 'RENTAL',
          amount: 4_500,
          currency: 'SGD',
          status: 'SUCCEEDED',
          reservationId: reservation.id,
          createdAt: frozenTime.toISOString(),
        },
      });
    }
    if (request.method() === 'POST' && /^\/api\/rentals\/reservations\/[^/]+\/cancel$/.test(path)) {
      const reservationId = path.split('/').at(-2);
      const current = reservations.find(item => item.id === reservationId);
      if (!current) return fulfillJson(route, { error: 'Rental reservation not found' }, 404);
      cancellationCount += 1;
      const cancelled = {
        ...current,
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
        creditConsumed: false,
        cancellable: false,
      };
      reservations = reservations.map(item => item.id === reservationId ? cancelled : item);
      return fulfillJson(route, { reservation: cancelled });
    }
    return fulfillJson(route, { error: `Unexpected rental request: ${request.method()} ${path}` }, 500);
  });
  return { cancellationCount: () => cancellationCount };
}

async function mockDisconnectedCalendar(page: Page) {
  await page.route('**/api/calendar/connection', route => fulfillJson(route, {
    configured: false,
    eligible: true,
    provider: null,
    state: 'DISCONNECTED',
    connected: false,
    email: null,
    calendarName: null,
    syncEnabled: false,
    busyCheckEnabled: false,
    connectedAt: null,
    lastSyncedAt: null,
    lastBusyAt: null,
    busyCacheExpiresAt: null,
    error: null,
  }));
}

function responseFor(page: Page, method: string, pathname: string) {
  return page.waitForResponse(response =>
    response.request().method() === method && requestPath(response.request()) === pathname,
  );
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: frozenTime });
});

test('coach navigation opens a private-only booking form and books as the current coach', async ({ page }) => {
  const otherInstructor = {
    ...instructor,
    id: 'other-release-coach-profile',
    name: 'Jordan Other Coach',
    email: 'jordan.other@example.test',
  };
  const otherCoachPrivateService = {
    ...privateService,
    id: 'other-coach-private-class',
    name: 'Another coach private class',
    locations: [{
      ...privateService.locations[0],
      instructorIds: [otherInstructor.id],
    }],
  };
  const coachWorkspace = workspace('COACH');
  await page.route('**/api/workspace', route => fulfillJson(route, {
    ...coachWorkspace,
    instructors: [instructor, otherInstructor],
    services: [privateService, groupService, otherCoachPrivateService],
  }));
  await page.route(`**/api/public/${business.slug}/slots?*`, route => fulfillJson(route, {
    slots: [{ startAt: bookingStart, endAt: '2026-09-26T03:00:00.000Z', available: true, placesRemaining: 1 }],
  }));
  await page.route('**/api/bookings', route => fulfillJson(route, { bookings: [] }, 201));

  await page.goto('/');
  await expect(page.getByRole('main')).toBeVisible();

  const expectedCoachTabs = ['Home', 'Explore', 'Book', 'Alerts', 'Profile'];
  const desktopNavigation = page.locator('nav[aria-label="Primary"]');
  const mobileNavigation = page.locator('nav[aria-label="Mobile navigation"]');
  for (const navigation of [desktopNavigation, mobileNavigation]) {
    await expect(navigation.locator('button')).toHaveCount(5);
    await expect(navigation.locator('button').allTextContents()).resolves.toEqual(expectedCoachTabs);
  }

  const mobileViewport = (page.viewportSize()?.width ?? 0) < 1024;
  await expect(mobileViewport ? mobileNavigation : desktopNavigation).toBeVisible();
  await expect(mobileViewport ? desktopNavigation : mobileNavigation).toBeHidden();
  const navigation = mobileViewport ? mobileNavigation : desktopNavigation;
  await navigation.getByRole('button', { name: 'Book', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Add a booking' });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toContainText('A quick booking for the lessons arranged off the court.');
  await expect(dialog).not.toContainText('no payment collected online');
  await expect(dialog.getByLabel('1-1 session', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Instructor', { exact: true })).toHaveCount(0);
  const sessionDetails = dialog.getByRole('group', { name: '1-1 session details', exact: true });
  await expect(sessionDetails.getByText('Club', { exact: true })).toBeVisible();
  await expect(sessionDetails.getByText(business.name, { exact: true })).toBeVisible();
  await expect(sessionDetails.getByText('Duration', { exact: true })).toBeVisible();
  await expect(sessionDetails.getByText('60 minutes', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText('Bookings can only be created for students already linked');

  const serviceOptions = dialog.getByLabel('1-1 session', { exact: true }).locator('option');
  await expect(serviceOptions).toHaveText(['Choose a class', privateService.name]);
  await expect(dialog.getByText(groupService.name, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(otherCoachPrivateService.name, { exact: true })).toHaveCount(0);

  await dialog.getByLabel('Registered student', { exact: true }).selectOption(student.id);
  await dialog.getByRole('button', { name: '10:00 AM', exact: true }).click();

  const bookingResponse = responseFor(page, 'POST', '/api/bookings');
  await dialog.getByRole('button', { name: 'Add booking', exact: true }).click();
  const body = (await bookingResponse).request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({
    serviceId: privateService.id,
    locationId: location.id,
    startAt: bookingStart,
    studentId: student.id,
    repeatWeeks: 1,
    notes: '',
    address: '',
  });
  if ('instructorId' in body) expect(body.instructorId).toBe(instructor.id);
  else expect(body).not.toHaveProperty('instructorId');
});

test('club catalog calls lessons Classes and submits only roster-owned coach details', async ({ page }) => {
  await mockWorkspace(page, 'CLUB');
  await mockMarketplace(page);
  await page.route('**/api/staff', route => {
    const request = route.request();
    if (request.method() === 'GET') return fulfillJson(route, []);
    if (request.method() === 'POST') {
      return fulfillJson(route, {
        id: 'membership-jordan-coach',
        userId: 'jordan-coach-account',
        name: 'Jordan Coach',
        username: 'jordan_coach',
        email: 'jordan.coach@example.test',
        accountType: 'COACH',
        sports: ['Tennis'],
        instructorId: 'new-release-coach-profile',
        active: true,
        createdAt: frozenTime.toISOString(),
      }, 201);
    }
    return fulfillJson(route, { error: 'Unexpected staff request: ' + request.method() }, 500);
  });
  await page.route(/\/api\/instructors(?:\/[^/?]+)?$/, route => {
    const request = route.request();
    const path = requestPath(request);
    if (request.method() === 'PATCH' && path === `/api/instructors/${instructor.id}`) {
      return fulfillJson(route, { ...instructor, ...request.postDataJSON() });
    }
    return fulfillJson(route, { error: `Unexpected instructor request: ${request.method()} ${path}` }, 500);
  });

  await page.goto('/?tab=explore');
  const manage = page.getByRole('region', { name: 'Manage' });
  await expect(page.getByRole('heading', { name: 'Explore training grounds', exact: true })).toBeVisible();
  await expect(manage.getByRole('button', { name: 'Classes', exact: true })).toBeVisible();
  await expect(manage.getByRole('button', { name: 'Services', exact: true })).toHaveCount(0);

  await manage.getByRole('button', { name: 'Classes', exact: true }).click();
  await expect(page.locator('main').getByRole('heading', { name: 'Classes', exact: true })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('Services');

  await page.goto('/?tab=explore&view=team');
  const coachCard = page.locator('main article').filter({
    has: page.getByRole('heading', { name: instructor.name, exact: true }),
  });
  await expect(coachCard).toContainText(instructor.email);
  await expect(coachCard).toContainText('36 hour reschedule notice');
  await expect(coachCard).not.toContainText(instructor.specialty);
  await expect(coachCard.getByText(/^(Active|Archived)$/)).toHaveCount(0);

  await coachCard.getByRole('button', { name: 'Edit roster details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit coach details' });
  await expect(dialog).toContainText(instructor.email);
  await expect(dialog.getByLabel('Calendar colour', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: /^Reschedule notice \(hours\)/ })).toBeVisible();
  await expect(dialog.getByLabel('Specialty', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Active instructor', { exact: true })).toHaveCount(0);

  await dialog.getByRole('spinbutton', { name: /^Reschedule notice \(hours\)/ }).fill('48');
  const editResponse = responseFor(page, 'PATCH', `/api/instructors/${instructor.id}`);
  await dialog.getByRole('button', { name: 'Save roster details', exact: true }).click();
  expect((await editResponse).request().postDataJSON()).toEqual({
    color: instructor.color,
    rescheduleNoticeHours: 48,
  });
  await expect(dialog).toHaveCount(0);

  const coachAccess = page.getByRole('region', { name: 'Coach access', exact: true });
  await coachAccess.getByRole('button', { name: 'Add coach', exact: true }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add coach access' });
  await expect(addDialog).toContainText('Use an exact username or email, or an unambiguous exact name.');
  await addDialog.getByRole('searchbox').fill('jordan.coach@example.test');
  await expect(addDialog.getByRole('spinbutton', { name: /^Reschedule notice \(hours\)/ })).toHaveValue('24');
  await addDialog.getByRole('spinbutton', { name: /^Reschedule notice \(hours\)/ }).fill('72');

  const createResponse = responseFor(page, 'POST', '/api/staff');
  await addDialog.getByRole('button', { name: 'Add coach', exact: true }).click();
  expect((await createResponse).request().postDataJSON()).toEqual({
    instructorId: null,
    query: 'jordan.coach@example.test',
    rescheduleNoticeHours: 72,
  });
});

test('manager booking choices require an active location and active assigned coach path', async ({ page }) => {
  const archivedLocation = {
    ...location,
    id: 'archived-release-court',
    name: 'Archived Release Court',
    active: false,
  };
  const unstaffedLocation = {
    ...location,
    id: 'unstaffed-release-court',
    name: 'Unstaffed Release Court',
  };
  const inactiveInstructor = {
    ...instructor,
    id: 'inactive-release-coach-profile',
    name: 'Inactive Release Coach',
    email: 'inactive.coach@example.test',
    active: false,
  };
  const activeAndArchivedService = {
    ...privateService,
    locations: [
      {
        ...privateService.locations[0],
        instructorIds: [instructor.id, inactiveInstructor.id],
      },
      {
        locationId: unstaffedLocation.id,
        price: privateService.price,
        duration: privateService.duration,
        instructorIds: [],
      },
      {
        locationId: archivedLocation.id,
        price: privateService.price,
        duration: privateService.duration,
        instructorIds: [instructor.id],
      },
    ],
  };
  const archivedOnlyCoachService = {
    ...privateService,
    id: 'archived-only-coach-class',
    name: 'Archived-only coach class',
    locations: [{
      locationId: archivedLocation.id,
      price: privateService.price,
      duration: privateService.duration,
      instructorIds: [instructor.id],
    }],
  };
  const unstaffedService = {
    ...privateService,
    id: 'unstaffed-class',
    name: 'Unstaffed class',
    locations: [{
      locationId: unstaffedLocation.id,
      price: privateService.price,
      duration: privateService.duration,
      instructorIds: [],
    }],
  };
  const inactiveCoachService = {
    ...privateService,
    id: 'inactive-coach-class',
    name: 'Inactive-coach class',
    locations: [{
      locationId: location.id,
      price: privateService.price,
      duration: privateService.duration,
      instructorIds: [inactiveInstructor.id],
    }],
  };
  const clubWorkspace = workspace('CLUB');
  await page.route('**/api/workspace', route => fulfillJson(route, {
    ...clubWorkspace,
    instructors: [instructor, inactiveInstructor],
    locations: [location, unstaffedLocation, archivedLocation],
    services: [activeAndArchivedService, archivedOnlyCoachService, unstaffedService, inactiveCoachService],
  }));
  await page.route(`**/api/public/${business.slug}/slots?*`, route => fulfillJson(route, { slots: [] }));

  await page.goto('/');
  const navigation = page.locator(
    'nav[aria-label="Mobile navigation"]:visible, nav[aria-label="Primary"]:visible',
  );
  await expect(navigation).toBeVisible();
  await navigation.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create' }).getByRole('button', { name: /New booking/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Add a booking' });
  await expect(dialog.getByLabel('Class', { exact: true }).locator('option')).toHaveText([
    'Choose a class',
    privateService.name,
  ]);
  await expect(dialog.getByLabel('Location', { exact: true }).locator('option')).toHaveText([
    'Select location',
    location.name,
  ]);
  await expect(dialog.getByLabel('Instructor', { exact: true }).locator('option')).toHaveText([
    'Select instructor',
    instructor.name,
  ]);
  await expect(dialog.getByText(unstaffedLocation.name, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(archivedLocation.name, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(archivedOnlyCoachService.name, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(unstaffedService.name, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(inactiveCoachService.name, { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(inactiveInstructor.name, { exact: true })).toHaveCount(0);
});

test('club booking offers only packages whose immutable scopes cover the selected class', async ({ page }) => {
  const clubWorkspace = workspace('CLUB');
  await page.route('**/api/workspace', route => fulfillJson(route, {
    ...clubWorkspace,
    packages: [
      { id: 'class-pass', studentId: student.id, studentName: student.name, name: 'Private class pass', serviceId: null, serviceIds: [privateService.id], rentalLocationIds: [], totalCredits: 4, usedCredits: 0, price: 20_000, expiresAt: '2027-01-01T00:00:00.000Z', paid: true },
      { id: 'group-pass', studentId: student.id, studentName: student.name, name: 'Group class pass', serviceId: null, serviceIds: [groupService.id], rentalLocationIds: [], totalCredits: 4, usedCredits: 0, price: 20_000, expiresAt: '2027-01-01T00:00:00.000Z', paid: true },
      { id: 'rental-pass', studentId: student.id, studentName: student.name, name: 'Rental-only pass', serviceId: null, serviceIds: [], rentalLocationIds: [location.id], totalCredits: 4, usedCredits: 0, price: 20_000, expiresAt: '2027-01-01T00:00:00.000Z', paid: true },
      { id: 'unpaid-pass', studentId: student.id, studentName: student.name, name: 'Unpaid private pass', serviceId: null, serviceIds: [privateService.id], rentalLocationIds: [], totalCredits: 8, usedCredits: 0, price: 20_000, expiresAt: '2027-01-01T00:00:00.000Z', paid: false },
      { id: 'expired-pass', studentId: student.id, studentName: student.name, name: 'Expired private pass', serviceId: null, serviceIds: [privateService.id], rentalLocationIds: [], totalCredits: 8, usedCredits: 0, price: 20_000, expiresAt: '2026-09-24T00:00:00.000Z', paid: true },
      { id: 'short-pass', studentId: student.id, studentName: student.name, name: 'One-credit private pass', serviceId: null, serviceIds: [privateService.id], rentalLocationIds: [], totalCredits: 1, usedCredits: 0, price: 20_000, expiresAt: '2027-01-01T00:00:00.000Z', paid: true },
      { id: 'future-expiry-pass', studentId: student.id, studentName: student.name, name: 'Soon-expiring private pass', serviceId: null, serviceIds: [privateService.id], rentalLocationIds: [], totalCredits: 8, usedCredits: 0, price: 20_000, expiresAt: '2026-10-02T01:59:59.000Z', paid: true },
    ],
  }));
  await page.route(`**/api/public/${business.slug}/slots?*`, route => fulfillJson(route, {
    slots: [{ startAt: bookingStart, endAt: '2026-09-26T03:00:00.000Z', available: true, placesRemaining: 1 }],
  }));

  await page.goto('/');
  const navigation = await page.getByRole('navigation', { name: 'Mobile navigation' }).isVisible()
    ? page.getByRole('navigation', { name: 'Mobile navigation' })
    : page.getByRole('navigation', { name: 'Primary' });
  await navigation.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create' }).getByRole('button', { name: /New booking/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Add a booking' });
  await dialog.getByLabel('Registered student', { exact: true }).selectOption(student.id);
  await dialog.getByRole('button', { name: '10:00 AM', exact: true }).click();
  const packageSelect = dialog.getByLabel('Package credits', { exact: true });
  await expect(packageSelect.locator('option')).toHaveText([
    'Pay per class',
    'Private class pass · 4 credits left',
    'One-credit private pass · 1 credits left',
    'Soon-expiring private pass · 8 credits left',
  ]);
  await dialog.getByLabel('Repeat', { exact: true }).selectOption('4');
  await expect(packageSelect.locator('option')).toHaveText(['Pay per class', 'Private class pass · 4 credits left']);
  await dialog.getByLabel('Class', { exact: true }).selectOption(groupService.id);
  await dialog.getByRole('button', { name: '10:00 AM', exact: true }).click();
  await expect(packageSelect.locator('option')).toHaveText(['Pay per class', 'Group class pass · 4 credits left']);
});

test('public booking can drop a preselected package that expires before the final recurrence', async ({ page }) => {
  const packageId = 'expiring-release-class-pass';
  const accountPackage = {
    id: packageId,
    businessId: business.id,
    offerId: 'release-class-pass-offer',
    name: 'Expiring release class pass',
    totalCredits: 8,
    usedCredits: 0,
    remainingCredits: 8,
    price: 20_000,
    expiresAt: '2026-10-10T15:59:59.000Z',
    paid: true,
    state: 'ACTIVE',
    business: { id: business.id, name: business.name, slug: business.slug, currency: business.currency },
    offer: { id: 'release-class-pass-offer', name: 'Release class pass' },
    serviceId: null,
    serviceIds: [privateService.id],
    rentalLocationIds: [],
    services: [{ id: privateService.id, name: privateService.name }],
    rentalLocations: [],
  };
  await page.route(/\/api\/auth\/me$/, route => fulfillJson(route, {
    user: {
      id: student.userId,
      name: student.name,
      username: 'sam_student',
      email: student.email,
      accountType: 'STUDENT',
      sports: ['Tennis'],
      phone: '',
      parentName: '',
    },
    membership: null,
    business: null,
    memberships: [],
  }));
  await page.route(/\/api\/account\/packages$/, route => fulfillJson(route, { packages: [accountPackage] }));
  await page.route(new RegExp(`/api/public/${business.slug}$`), route => fulfillJson(route, {
    business,
    instructors: [instructor],
    locations: [location],
    services: [privateService],
  }));
  await page.route(`**/api/public/${business.slug}/slots?*`, route => fulfillJson(route, {
    slots: [{ startAt: bookingStart, endAt: '2026-09-26T03:00:00.000Z', available: true, placesRemaining: 1 }],
  }));
  await page.route(new RegExp(`/api/public/${business.slug}/bookings$`), route => {
    const bookings = Array.from({ length: 4 }, (_, index) => {
      const startAt = new Date(new Date(bookingStart).getTime() + index * 7 * 86_400_000).toISOString();
      const endAt = new Date(new Date(startAt).getTime() + 60 * 60_000).toISOString();
      return {
        id: `release-public-booking-${index + 1}`,
        serviceId: privateService.id,
        serviceName: privateService.name,
        instructorId: instructor.id,
        instructorName: instructor.name,
        locationId: location.id,
        locationName: location.name,
        locationColor: location.color,
        startAt,
        endAt,
        status: 'CONFIRMED',
        type: 'PRIVATE',
        capacity: 1,
        price: privateService.price,
        paymentRoute: 'CLUB',
        coachAcceptance: 'NOT_REQUIRED',
        createdByRole: 'STUDENT',
        notes: '',
        address: '',
        recurringId: 'release-public-recurring',
        participants: [{
          id: `release-public-participant-${index + 1}`,
          studentId: student.id,
          name: student.name,
          email: student.email,
          attendance: 'UNMARKED',
          paid: false,
          price: privateService.price,
          packageId: null,
          notes: '',
          cancelled: false,
          cancelledAt: null,
        }],
      };
    });
    return fulfillJson(route, { bookings }, 201);
  });

  const visibleAction = (name: string) => page.getByRole('button', { name, exact: true }).filter({ visible: true });
  await page.goto(`/book/${business.slug}?packageId=${packageId}`);
  await expect(page.getByRole('heading', { name: 'Good days start with a class.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(privateService.name) }).click();
  await visibleAction('Continue').click();
  await page.getByRole('button', { name: new RegExp(location.name) }).click();
  await page.getByRole('button', { name: new RegExp(instructor.name) }).click();
  await visibleAction('Continue').click();
  await page.getByLabel('Choose a date', { exact: true }).fill('2026-09-26');
  await page.getByRole('button', { name: /^10:00 AM/ }).click();
  await visibleAction('Continue').click();
  await page.getByRole('button', { name: /^4 weeks/ }).click();

  await expect(page.getByText(`${accountPackage.name} expires before the final weekly class.`, { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Use standard price instead', exact: true }).filter({ visible: true }).first().click();
  await expect.poll(() => new URL(page.url()).searchParams.has('packageId')).toBe(false);
  await visibleAction('Review booking').click();
  await page.getByRole('checkbox').check();
  const confirm = visibleAction('Confirm booking');
  await expect(confirm).toBeEnabled();
  const bookingResponse = responseFor(page, 'POST', `/api/public/${business.slug}/bookings`);
  await confirm.click();
  const bookingBody = (await bookingResponse).request().postDataJSON() as Record<string, unknown>;
  expect(bookingBody).toEqual({
    serviceId: privateService.id,
    locationId: location.id,
    instructorId: instructor.id,
    startAt: bookingStart,
    student: { phone: '', parentName: '' },
    repeatWeeks: 4,
    notes: '',
  });
  expect(bookingBody).not.toHaveProperty('packageId');
});

test('club managers create, edit, and disable a facility rental listing', async ({ page }) => {
  let configuredRental: Record<string, unknown> | null = null;
  const compositeSaves: Array<{ path: string; body: Record<string, unknown> }> = [];
  let rejectNextSave = true;
  const { id: _locationId, ...locationInput } = location;

  await mockWorkspace(page, 'CLUB');
  await page.route(/\/api\/rental-locations\/[^/?]+$/, route => {
    const request = route.request();
    if (request.method() !== 'PUT') {
      return fulfillJson(route, { error: `Unexpected composite request: ${request.method()}` }, 500);
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    compositeSaves.push({ path: requestPath(request), body });
    if (rejectNextSave) {
      rejectNextSave = false;
      return fulfillJson(route, { error: 'Rental settings were rejected atomically.' }, 409);
    }
    const rentalInput = body.rental as Record<string, unknown>;
    const savedLocation = { ...location, ...(body.location as Record<string, unknown>) };
    configuredRental = rentalInput.enabled ? {
      ...rental, ...rentalInput, id: location.id, locationId: location.id, enabled: true,
      units: (rentalInput.units as Array<Record<string, unknown>>).map((unit, index) => ({
        ...unit, id: unit.id ?? `configured-unit-${index + 1}`,
      })),
    } : null;
    return fulfillJson(route, {
      location: savedLocation,
      rental: configuredRental ?? { ...rental, id: location.id, locationId: location.id, enabled: false },
      replay: false,
    });
  });
  await page.route(/\/api\/rentals(?:\/.*)?(?:\?.*)?$/, route => {
    const request = route.request();
    const path = requestPath(request);
    if (request.method() === 'GET' && path === '/api/rentals') {
      return fulfillJson(route, { rentals: [], nextCursor: null });
    }
    if (request.method() === 'GET' && path === `/api/rentals/${location.id}`) {
      return configuredRental
        ? fulfillJson(route, { rental: configuredRental })
        : fulfillJson(route, { error: 'Rental configuration not found' }, 404);
    }
    return fulfillJson(route, { error: `Unexpected rental request: ${request.method()} ${path}` }, 500);
  });

  await page.goto('/?tab=explore&view=locations');
  const locationCard = page.locator('main article').filter({
    has: page.getByRole('heading', { name: location.name, exact: true }),
  });
  await locationCard.getByRole('button', { name: 'Edit location', exact: true }).click();

  let dialog = page.getByRole('dialog', { name: 'Edit location' });
  await expect(dialog.getByRole('heading', { name: 'Training ground rental', exact: true })).toBeVisible();
  const rentalToggle = dialog.getByRole('checkbox', { name: /^Offer this location for public rental/ });
  await expect(rentalToggle).not.toBeChecked();
  await rentalToggle.check();
  await dialog.getByRole('textbox', { name: /^Sport/ }).fill('Tennis');
  await dialog.getByRole('spinbutton', { name: /^Hourly rate \(SGD\)/ }).fill('55');
  await dialog.getByRole('textbox', { name: /^Unit label/ }).fill('Court');
  await dialog.getByRole('spinbutton', { name: /^Number of units/ }).fill('2');
  await dialog.getByRole('textbox', { name: /^Unit 1 name/ }).fill('Court Alpha');
  await dialog.getByRole('textbox', { name: /^Unit 2 name/ }).fill('Court Beta');
  await dialog.getByRole('combobox', { name: /^Booking start interval \(minutes\)/ }).selectOption('30');
  await dialog.getByRole('spinbutton', { name: /^Minimum rental duration \(minutes\)/ }).fill('60');
  await dialog.getByRole('combobox', { name: /^Duration increment \(minutes\)/ }).selectOption('30');
  await dialog.getByRole('spinbutton', { name: /^Maximum rental duration \(minutes\)/ }).fill('120');
  await dialog.getByRole('spinbutton', { name: /^Minimum booking notice \(hours\)/ }).fill('3');
  await dialog.getByRole('spinbutton', { name: /^Maximum advance booking \(days\)/ }).fill('45');
  await dialog.getByRole('spinbutton', { name: /^Cancellation notice \(hours\)/ }).fill('12');
  await dialog.getByRole('textbox', { name: /^Amenities/ }).fill('Indoor\nShowers');
  await dialog.getByRole('textbox', { name: /^Rental rules/ }).fill('Non-marking shoes only.');
  for (const day of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    await dialog.getByLabel(day, { exact: true }).uncheck();
  }
  await dialog.getByLabel('Saturday opening time', { exact: true }).fill('09:00');
  await dialog.getByLabel('Saturday closing time', { exact: true }).fill('20:00');

  await dialog.getByRole('button', { name: 'Save location', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Rental settings were rejected atomically.');
  expect(compositeSaves).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Save location', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(compositeSaves).toHaveLength(2);
  expect(compositeSaves[1].path).toBe(`/api/rental-locations/${location.id}`);
  expect(compositeSaves[1].body).toEqual({
    mode: 'UPDATE',
    location: locationInput,
    rental: { enabled: true, sport: 'Tennis',
    rules: 'Non-marking shoes only.',
    amenities: ['Indoor', 'Showers'],
    unitLabel: 'Court',
    price: 5_500,
    startInterval: 30,
    minDuration: 60,
    durationIncrement: 30,
    maxDuration: 120,
    noticeHours: 3,
    advanceDays: 45,
    cancellationHours: 12,
    units: [
      { name: 'Court Alpha', active: true },
      { name: 'Court Beta', active: true },
    ],
    openingHours: [{ dayOfWeek: 6, startTime: '09:00', endTime: '20:00' }],
    },
  });

  await locationCard.getByRole('button', { name: 'Edit location', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit location' });
  await expect(dialog.getByRole('checkbox', { name: /^Offer this location for public rental/ })).toBeChecked();
  await dialog.getByRole('spinbutton', { name: /^Hourly rate \(SGD\)/ }).fill('62.50');
  await dialog.getByRole('spinbutton', { name: /^Minimum booking notice \(hours\)/ }).fill('4');
  await dialog.getByRole('textbox', { name: /^Amenities/ }).fill('Indoor\nLockers');

  await dialog.getByRole('button', { name: 'Save location', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(compositeSaves).toHaveLength(3);
  expect(compositeSaves[2].body).toEqual({
    mode: 'UPDATE', location: locationInput, rental: { enabled: true, sport: 'Tennis',
    rules: 'Non-marking shoes only.',
    amenities: ['Indoor', 'Lockers'],
    unitLabel: 'Court',
    price: 6_250,
    startInterval: 30,
    minDuration: 60,
    durationIncrement: 30,
    maxDuration: 120,
    noticeHours: 4,
    advanceDays: 45,
    cancellationHours: 12,
    units: [
      { id: 'configured-unit-1', name: 'Court Alpha', active: true },
      { id: 'configured-unit-2', name: 'Court Beta', active: true },
    ],
    openingHours: [{ dayOfWeek: 6, startTime: '09:00', endTime: '20:00' }],
    },
  });

  await locationCard.getByRole('button', { name: 'Edit location', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit location' });
  await dialog.getByRole('checkbox', { name: /^Offer this location for public rental/ }).uncheck();
  await dialog.getByRole('button', { name: 'Save location', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(compositeSaves).toHaveLength(4);
  expect(compositeSaves[3].body).toEqual({ mode: 'UPDATE', location: locationInput, rental: { enabled: false } });
});

test('package offers submit both class and rental eligibility scopes', async ({ page }) => {
  await mockWorkspace(page, 'CLUB');
  await mockMarketplace(page);
  await page.route('**/api/package-offers', route => {
    if (route.request().method() === 'GET') return fulfillJson(route, { offers: [] });
    return fulfillJson(route, { id: 'release-offer' }, 201);
  });

  await page.goto('/?tab=explore');
  const manage = page.getByRole('region', { name: 'Manage' });
  await expect(manage.getByRole('button', { name: 'Packages', exact: true })).toBeVisible();
  await manage.getByRole('button', { name: 'Packages', exact: true }).click();
  await expect(page.locator('main').getByRole('heading', { name: 'Package offers', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create offer', exact: true }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Create a package offer' });
  await expect(dialog.getByRole('heading', { name: 'Eligible classes', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Rentable locations', exact: true })).toBeVisible();
  await expect(dialog).toContainText('one rental booking');
  await expect(dialog).not.toContainText('one hour at an eligible rental location');
  await dialog.getByRole('textbox', { name: /^Offer name/ }).fill('Release flex pass');
  await dialog.getByRole('textbox', { name: /^Description/ }).fill('Lessons and court time in one pass.');
  await dialog.getByRole('spinbutton', { name: /^Credits/ }).fill('8');
  await dialog.getByRole('spinbutton', { name: /^Price \(SGD\)/ }).fill('320.50');
  await dialog.getByRole('spinbutton', { name: /^Valid for \(days\)/ }).fill('90');
  await dialog.getByLabel(privateService.name, { exact: true }).check();
  await dialog.getByLabel(location.name, { exact: true }).check();

  const offerResponse = responseFor(page, 'POST', '/api/package-offers');
  await dialog.getByRole('button', { name: 'Create offer', exact: true }).click();
  expect((await offerResponse).request().postDataJSON()).toEqual({
    name: 'Release flex pass',
    description: 'Lessons and court time in one pass.',
    price: 32_050,
    totalCredits: 8,
    validityDays: 90,
    active: true,
    serviceIds: [privateService.id],
    rentalLocationIds: [location.id],
  });
});

test('rental marketplace loads details and submits the selected slot reservation', async ({ page }) => {
  await mockWorkspace(page, 'CLUB');
  const requests = await mockMarketplace(page);

  await page.goto('/?tab=explore');
  await expect(page.getByRole('heading', { name: 'Explore training grounds', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: rental.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `View times for ${rental.name}`, exact: true }).click();

  const dialog = page.getByRole('dialog', { name: rental.name });
  await expect(dialog.getByLabel('Date', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Duration', { exact: true })).toHaveValue('60');
  await expect(dialog.getByRole('heading', { name: 'Available times', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Payment is simulated; no real card is charged.');
  await expect(dialog.getByRole('button', { name: /Court 1.*\$45/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Court 1.*\$45/ }).click();

  const reservationResponse = responseFor(page, 'POST', `/api/rentals/${rental.id}/reservations`);
  await dialog.getByRole('button', { name: /Reserve.*\$45/ }).click();
  const body = (await reservationResponse).request().postDataJSON() as Record<string, unknown>;
  expect(body).toMatchObject({
    unitId: 'release-unit',
    startAt: rentalStart,
    duration: 60,
    simulatedOutcome: 'SUCCEEDED',
  });
  expect(body.idempotencyKey).toEqual(expect.any(String));
  await expect(dialog.getByRole('heading', { name: 'Reservation confirmed', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Payment was simulated; no real card was charged.');

  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const history = page.getByRole('region', { name: 'My rental reservations', exact: true });
  await expect(history).toContainText(rental.name);
  await expect(history).toContainText('Paid with simulated Stripe');
  await history.getByRole('button', { name: 'Cancel reservation', exact: true }).click();
  const cancellation = page.getByRole('dialog', { name: 'Cancel rental reservation?' });
  await expect(cancellation).toContainText('refunds the simulated payment');
  await cancellation.getByRole('button', { name: 'Cancel reservation', exact: true }).click();
  await expect(history.getByRole('status')).toContainText('simulated payment was refunded');
  await expect(history).toContainText('Cancelled');
  expect(requests.cancellationCount()).toBe(1);
});

test('an affiliated coach can view and cancel account-wide rental history from workspace Explore', async ({ page }) => {
  const otherClubReservation = {
    ...reservation,
    id: 'second-serve-reservation',
    businessName: 'Second Serve Academy',
    locationId: 'second-serve-courts',
    locationName: 'Second Serve Courts',
    unitId: 'second-serve-court-2',
    unitName: 'Court 2',
  };
  await mockWorkspace(page, 'COACH');
  const requests = await mockMarketplace(page, { initialReservations: [otherClubReservation] });

  await page.goto('/?tab=explore');
  const history = page.getByRole('region', { name: 'My rental reservations', exact: true });
  await expect(history).toContainText(otherClubReservation.locationName);
  await expect(history).toContainText(otherClubReservation.businessName);
  await history.getByRole('button', { name: 'Cancel reservation', exact: true }).click();
  const cancellation = page.getByRole('dialog', { name: 'Cancel rental reservation?' });
  await expect(cancellation).toContainText(otherClubReservation.locationName);
  await cancellation.getByRole('button', { name: 'Cancel reservation', exact: true }).click();
  await expect(history).toContainText('Cancelled');
  expect(requests.cancellationCount()).toBe(1);
});

test('workspace rental retry rotates the checkout key after a definitive failure', async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await mockWorkspace(page, 'CLUB');
  await mockMarketplace(page);
  await page.route(`**/api/rentals/${rental.id}/reservations`, route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    if (bodies.length === 1) {
      return fulfillJson(route, {
        reservation: null,
        paymentIntent: { id: 'failed-release-rental', kind: 'RENTAL', amount: 4_500, currency: 'SGD', status: 'FAILED', createdAt: frozenTime.toISOString() },
      }, 201);
    }
    return fulfillJson(route, {
      reservation,
      paymentIntent: { id: 'release-rental-payment', kind: 'RENTAL', amount: 4_500, currency: 'SGD', status: 'SUCCEEDED', reservationId: reservation.id, createdAt: frozenTime.toISOString() },
    }, 201);
  });

  await page.goto('/?tab=explore');
  await page.getByRole('button', { name: `View times for ${rental.name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: rental.name });
  await dialog.getByRole('button', { name: /Court 1.*\$45/ }).click();
  await dialog.getByRole('button', { name: /Reserve.*\$45/ }).click();
  await expect(dialog.getByRole('alert')).toContainText('payment did not complete');
  await dialog.getByRole('button', { name: /Reserve.*\$45/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Reservation confirmed', exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.idempotencyKey).not.toBe(bodies[0]?.idempotencyKey);
});

test('global account search accepts names, usernames, and emails while coach switching lists only active clubs', async ({ page }) => {
  const searchedQueries: string[] = [];
  const account = {
    name: 'Alex Directory',
    username: 'alex_directory',
    accountType: 'COACH',
    sports: ['Tennis'],
  };

  await page.route('**/api/workspace', route => fulfillJson(route, coachWorkspaceWithAffiliations()));
  await page.route('**/api/accounts/search?*', route => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    searchedQueries.push(query);
    return fulfillJson(route, { accounts: [account] });
  });
  await mockDisconnectedCalendar(page);

  await page.goto('/');
  await page.getByRole('button', { name: 'Search workspace', exact: true }).click();
  const searchDialog = page.getByRole('dialog', { name: 'Search workspace' });
  const searchInput = searchDialog.getByLabel('Search people, students, and bookings', { exact: true });

  for (const query of ['Alex Directory', '@alex_directory', 'alex.directory@example.test']) {
    const searchResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === '/api/accounts/search'
        && url.searchParams.get('q') === query;
    });
    await searchInput.fill(query);
    await page.clock.runFor(300);
    await searchResponse;
    await expect(searchDialog.getByText(account.name, { exact: true })).toBeVisible();
    await expect(searchDialog.getByText(`@${account.username} · Tennis`, { exact: true })).toBeVisible();
    await expect(searchDialog.getByText('alex.directory@example.test', { exact: true })).toHaveCount(0);
  }
  expect(searchedQueries).toEqual(['Alex Directory', '@alex_directory', 'alex.directory@example.test']);

  await searchDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.goto('/?tab=profile');
  await page.locator('main').getByRole('button', { name: 'Switch workspace', exact: true }).click();
  const workspaceDialog = page.getByRole('dialog', { name: 'Switch workspace' });
  await expect(workspaceDialog.getByText(business.name, { exact: true })).toBeVisible();
  await expect(workspaceDialog.getByText('Second Serve Academy', { exact: true })).toBeVisible();
  await expect(workspaceDialog.getByText('Inactive Courts Club', { exact: true })).toHaveCount(0);
  await expect(workspaceDialog.getByText('Casey Private Coaching', { exact: true })).toHaveCount(0);
  await expect(workspaceDialog.getByText('Legacy Courts Club', { exact: true })).toHaveCount(0);
});

test('integrity reviews live in Alerts and expose their evidence and actions there', async ({ page }) => {
  await page.route('**/api/workspace', route => fulfillJson(route, integrityWorkspace()));
  await mockDisconnectedCalendar(page);
  await page.route(/\/api\/rentals(?:\/.*)?(?:\?.*)?$/, route => {
    if (requestPath(route.request()) === '/api/rentals/reservations/mine') {
      return fulfillJson(route, { reservations: [] });
    }
    return fulfillJson(route, { rentals: [], nextCursor: null });
  });
  await page.route(`**/api/integrity-flags/${integrityFlag.id}`, route => fulfillJson(route, {
    ...integrityFlag,
    status: 'REVIEWING',
  }));

  await page.goto('/?tab=explore');
  await expect(page.getByRole('heading', { name: 'Explore training grounds', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Integrity/ })).toHaveCount(0);

  await page.goto('/?tab=profile');
  await expect(page.locator('main').getByText('Integrity', { exact: true })).toHaveCount(0);

  await page.goto('/?tab=alerts');
  await page.getByRole('button', { name: 'Read alert: Review a private booking pattern', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review a private booking pattern' });
  await expect(dialog).toContainText(`${integrityFlag.coachName} & ${integrityFlag.studentName}`);
  await expect(dialog).toContainText(integrityFlag.detail);
  await expect(dialog).toContainText('2 private sessions noticed');
  await expect(dialog).toContainText(integrityFlag.flaggedServiceName);
  await expect(dialog).toContainText(integrityFlag.outsideBusinessName);

  const reviewResponse = responseFor(page, 'PATCH', `/api/integrity-flags/${integrityFlag.id}`);
  await dialog.getByRole('button', { name: 'Reviewing', exact: true }).click();
  expect((await reviewResponse).request().postDataJSON()).toEqual({ status: 'REVIEWING', note: '' });
});
