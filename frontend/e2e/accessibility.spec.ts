import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { AccountBooking, ManagerWorkspace } from '../src/lib/types';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const frozenTime = new Date('2026-09-19T00:00:00.000Z');
const bookingStart = '2026-09-26T02:00:00.000Z';
const bookingEnd = '2026-09-26T03:00:00.000Z';
const legacyToken = 'a'.repeat(43);

const adminBusiness = {
  id: 'accessible-tennis-club',
  name: 'Accessible Tennis Club',
  slug: 'accessible-tennis-club',
  ownerName: 'Casey Morgan',
  email: 'casey@example.test',
  currency: 'SGD',
  timezone: 'Asia/Singapore',
  isDemo: false,
  createdAt: '2026-09-18T08:00:00.000Z',
  counts: { users: 4, students: 12, bookings: 24, locations: 2, services: 3, instructors: 2 },
};

const adminDemoBusiness = {
  ...adminBusiness,
  id: 'courtly-demo-academy',
  name: 'Courtly Demo Academy',
  slug: 'courtly-demo-academy',
  ownerName: 'Demo Manager',
  email: 'demo@example.test',
  isDemo: true,
  counts: { users: 3, students: 8, bookings: 15, locations: 2, services: 2, instructors: 1 },
};

const bookingBusiness = {
  id: 'accessible-tennis-club',
  name: 'Accessible Tennis Club',
  slug: 'accessible-tennis-club',
  ownerName: 'Casey Morgan',
  email: 'casey@example.test',
  timezone: 'Asia/Singapore',
  currency: 'SGD',
  color: '#174c3c',
  tagline: 'Tennis made welcoming.',
  cancellationHours: 24,
  kind: 'CLUB' as const,
  isDemo: false,
};

const bookingLocation = {
  id: 'court-1',
  name: 'Centre Court',
  address: '1 Court Lane',
  type: 'FACILITY' as const,
  color: '#78915e',
  requiresApproval: false,
  travelMinutes: 15,
  notes: '',
  source: 'MANUAL' as const,
  placeId: '',
  mapsUrl: '',
  latitude: null,
  longitude: null,
  active: true,
};

const bookingParticipant = {
  id: 'student-participant',
  studentId: 'student-1',
  name: 'Avery Student',
  email: 'avery.student@example.test',
  attendance: 'UNMARKED' as const,
  paid: false,
  price: 8_000,
  packageId: null,
  notes: '',
  cancelled: false,
  cancelledAt: null,
};

const populatedBooking: AccountBooking = {
  business: bookingBusiness,
  booking: {
    id: 'student-booking',
    serviceId: 'service-1',
    serviceName: 'Private tennis',
    instructorId: 'coach-1',
    instructorName: 'Jordan Coach',
    locationId: bookingLocation.id,
    locationName: bookingLocation.name,
    locationColor: bookingLocation.color,
    startAt: bookingStart,
    endAt: bookingEnd,
    status: 'CONFIRMED',
    type: 'PRIVATE',
    capacity: 1,
    price: 8_000,
    paymentRoute: 'CLUB',
    coachAcceptance: 'NOT_REQUIRED',
    createdByRole: 'STUDENT',
    notes: 'Focus on first serve.',
    address: '',
    recurringId: null,
    participants: [bookingParticipant],
  },
  participant: bookingParticipant,
  location: bookingLocation,
  canCancel: true,
  canReschedule: true,
  rescheduleRequest: null,
  awaitingCoach: false,
  paymentRoute: 'CLUB',
  management: {
    cancellationHours: 24,
    rescheduleNoticeHours: 72,
    reminders: '',
    venueReserved: true,
  },
};

const studentSession = {
  user: {
    id: 'accessible-student',
    name: 'Avery Student',
    email: 'avery.student@example.test',
    accountType: 'STUDENT' as const,
    phone: '+65 8123 4567',
    parentName: '',
  },
  membership: null,
  business: null,
  memberships: [],
};

const providerWorkspace: ManagerWorkspace = {
  business: bookingBusiness,
  user: {
    id: 'accessible-manager',
    name: 'Casey Morgan',
    email: 'casey@example.test',
    accountType: 'CLUB',
    phone: '+65 8000 0000',
    parentName: '',
    instructorId: null,
  },
  membership: {
    id: 'membership-1',
    userId: 'accessible-manager',
    businessId: bookingBusiness.id,
    instructorId: null,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    business: bookingBusiness,
  },
  memberships: [],
  clubAccount: true,
  instructors: [{
    id: 'coach-1',
    name: 'Jordan Coach',
    initials: 'JC',
    color: '#78915e',
    email: 'jordan@example.test',
    specialty: 'Private tennis',
    rescheduleNoticeHours: 72,
    active: true,
    accountLinkAvailable: false,
  }],
  locations: [bookingLocation],
  services: [{
    id: 'service-1',
    name: 'Private tennis',
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
    locations: [{
      locationId: bookingLocation.id,
      price: 8_000,
      duration: 60,
      instructorIds: ['coach-1'],
    }],
  }],
  availability: [{
    id: 'availability-1',
    instructorId: 'coach-1',
    locationId: bookingLocation.id,
    dayOfWeek: 6,
    startTime: '09:00',
    endTime: '12:00',
  }],
  exceptions: [],
  students: [{
    id: 'student-1',
    userId: 'accessible-student',
    name: 'Avery Student',
    email: 'avery.student@example.test',
    phone: '+65 8123 4567',
    initials: 'AS',
    notes: 'Working on serve consistency.',
    parentName: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    bookingCount: 1,
    lastBookingAt: bookingStart,
  }],
  packages: [{
    id: 'package-1',
    studentId: 'student-1',
    studentName: 'Avery Student',
    name: 'Five lesson pass',
    serviceId: 'service-1',
    totalCredits: 5,
    usedCredits: 2,
    price: 35_000,
    expiresAt: '2027-01-01T15:59:59.000Z',
    paid: false,
  }],
  bookings: [{ ...populatedBooking.booking, id: 'provider-booking' }],
  payments: [{
    id: 'payment-1',
    bookingId: null,
    packageId: null,
    amount: 5_000,
    method: 'BANK_TRANSFER',
    note: 'Account credit',
    paidAt: '2026-09-18T02:00:00.000Z',
    reversedAt: null,
    reversedReason: '',
    kind: 'STUDENT_TO_CLUB',
    studentId: 'student-1',
    studentName: 'Avery Student',
    instructorId: null,
    instructorName: null,
  }],
  notifications: [{
    id: 'notification-1',
    type: 'INTEGRITY',
    bookingId: null,
    title: 'Review a private booking pattern',
    message: 'A coach and student also booked outside the club.',
    read: true,
    actionNeeded: true,
    createdAt: '2026-09-18T08:00:00.000Z',
  }],
  rescheduleRequests: [],
  integrityFlags: [{
    id: 'flag-1',
    instructorId: 'coach-1',
    coachName: 'Jordan Coach',
    studentName: 'Avery Student',
    type: 'OUTSIDE_BOOKING',
    status: 'OPEN',
    detail: 'A private session was observed outside this club relationship.',
    occurrences: 2,
    outsideBusinessName: 'Jordan Coaching',
    firstSeenAt: '2026-09-10T02:00:00.000Z',
    lastSeenAt: '2026-09-17T02:00:00.000Z',
    resolvedAt: null,
    resolutionNote: '',
    flaggedSessionAt: '2026-09-17T02:00:00.000Z',
    flaggedServiceName: 'Private tennis',
  }],
};

async function expectNoWcagViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  const summary = violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map(node => node.target),
  }));
  expect(summary, 'Expected no WCAG A/AA accessibility violations').toEqual([]);
}

async function mockAdmin(page: Page) {
  const businesses = [adminBusiness, adminDemoBusiness];
  await page.route('**/api/admin/session', route => route.fulfill({ json: { configured: true, authenticated: true } }));
  await page.route('**/api/admin/overview', route => route.fulfill({
    json: {
      generatedAt: '2026-09-19T08:00:00.000Z',
      totals: {
        businesses: 2, demoBusinesses: 1, realBusinesses: 1, users: 7, memberships: 4, students: 20,
        bookings: 39, upcomingBookings: 5, bookingsLast7Days: 8, packages: 3, paymentsCount: 11, paymentsTotal: 174_000,
      },
    },
  }));
  await page.route(/\/api\/admin\/businesses(?:\?.*)?$/, route => {
    const url = new URL(route.request().url());
    const filter = url.searchParams.get('filter') ?? 'all';
    const search = url.searchParams.get('search')?.trim().toLowerCase() ?? '';
    const matching = businesses.filter(business => {
      const matchesFilter = filter === 'all' || (filter === 'demo') === business.isDemo;
      const matchesSearch = !search || [business.name, business.slug, business.ownerName, business.email]
        .some(value => value.toLowerCase().includes(search));
      return matchesFilter && matchesSearch;
    });
    return route.fulfill({ json: { businesses: matching } });
  });
}

async function mockStudent(page: Page) {
  await page.route('**/api/auth/me', route => route.fulfill({ json: studentSession }));
  await page.route('**/api/account/bookings*', route => route.fulfill({
    json: { bookings: [populatedBooking] },
  }));
  await page.route('**/api/account/notifications', route => route.fulfill({
    json: {
      notifications: [{
        id: 'student-notification',
        type: 'RESCHEDULE',
        bookingId: populatedBooking.booking.id,
        title: 'Booking time confirmed',
        message: 'Your lesson is confirmed for Saturday morning.',
        read: true,
        actionNeeded: true,
        createdAt: '2026-09-18T08:00:00.000Z',
        business: { slug: bookingBusiness.slug },
      }],
    },
  }));
}

async function mockProvider(page: Page) {
  await page.route('**/api/workspace', route => route.fulfill({ json: providerWorkspace }));
}

async function freezeClock(page: Page) {
  await page.clock.install({ time: frozenTime });
}

test.describe('automated WCAG checks', () => {
  test('unconfigured admin state has no detectable WCAG A or AA violations', async ({ page }) => {
    await page.route('**/api/admin/session', route => route.fulfill({
      json: { configured: false, authenticated: false },
    }));

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin console not configured' })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('admin login and error states have no detectable WCAG A or AA violations', async ({ page }) => {
    await page.route('**/api/admin/session', route => route.fulfill({
      json: { configured: true, authenticated: false },
    }));
    await page.route('**/api/admin/login', route => route.fulfill({
      status: 401,
      json: { error: 'Incorrect admin password.' },
    }));

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Admin sign in' })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByLabel('Admin password').fill('incorrect-password');
    await page.getByRole('button', { name: 'Unlock admin console' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Incorrect admin password.' })).toHaveText('Incorrect admin password.');
    await expectNoWcagViolations(page);
  });

  test('admin dashboard has no detectable WCAG A or AA violations', async ({ page }) => {
    await mockAdmin(page);
    await page.goto('/admin');

    await expect(page.getByRole('heading', { name: 'Every workspace, at a glance' })).toBeVisible();
    await expect(page.getByRole('button', { name: `Delete ${adminBusiness.name}` })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('button', { name: `Delete ${adminBusiness.name}` }).click();
    await expect(page.getByRole('dialog', { name: `Delete “${adminBusiness.name}”?` })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('authenticated student profile has no detectable WCAG A or AA violations', async ({ page }) => {
    await page.route('**/api/auth/me', route => route.fulfill({ json: studentSession }));
    await page.route('**/api/account/bookings*', route => route.fulfill({ json: { bookings: [] } }));
    await page.route('**/api/account/notifications', route => route.fulfill({ json: { notifications: [] } }));

    await page.goto('/manage?tab=profile');
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
    await expect(page.getByText('avery.student@example.test', { exact: true })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('legacy booking details and action panels have no detectable WCAG A or AA violations', async ({ page }) => {
    await freezeClock(page);
    await page.route(`**/api/manage/${legacyToken}`, route => route.fulfill({
      json: {
        business: bookingBusiness,
        booking: { ...populatedBooking.booking, participants: undefined },
        participant: {
          name: bookingParticipant.name,
          paid: bookingParticipant.paid,
          price: bookingParticipant.price,
          cancelled: bookingParticipant.cancelled,
          cancelledAt: bookingParticipant.cancelledAt,
        },
        location: bookingLocation,
        canCancel: true,
        canReschedule: true,
        management: { cancellationHours: 24, rescheduleNoticeHours: 72 },
      },
    }));
    await page.route(`**/api/public/${bookingBusiness.slug}/slots?*`, route => route.fulfill({
      json: {
        slots: [{
          startAt: '2026-09-27T02:00:00.000Z',
          endAt: '2026-09-27T03:00:00.000Z',
          available: true,
          placesRemaining: 1,
        }],
      },
    }));

    await page.goto(`/manage/${legacyToken}`);
    await expect(page.getByRole('heading', { name: 'Your booking', exact: true })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('button', { name: 'Cancel booking', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Confirm cancellation' })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('button', { name: 'Keep my booking', exact: true }).click();
    await page.getByRole('button', { name: 'Reschedule session', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Find a better time', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^10:00 AM/ })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('populated student booking and detail states have no detectable WCAG A or AA violations', async ({ page }) => {
    await freezeClock(page);
    await mockStudent(page);

    await page.goto('/manage?tab=home');
    await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Upcoming sessions', exact: true })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('button', {
      name: `Open details for ${populatedBooking.booking.serviceName} at ${bookingBusiness.name}`,
      exact: true,
    }).click();
    const bookingDialog = page.getByRole('dialog', { name: populatedBooking.booking.serviceName });
    await expect(bookingDialog).toBeVisible();
    await expectNoWcagViolations(page);

    await bookingDialog.getByRole('button', { name: 'Cancel booking', exact: true }).click();
    await expect(bookingDialog.getByRole('heading', { name: 'Cancel this session?', exact: true })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('populated student discovery and alert views have no detectable WCAG A or AA violations', async ({ page }) => {
    await freezeClock(page);
    await mockStudent(page);

    await page.goto('/manage?tab=explore');
    await expect(page.getByRole('heading', { name: 'Explore', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: bookingBusiness.name, exact: true })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.goto('/manage?tab=book');
    await expect(page.getByRole('heading', { name: 'Book a session', exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: new RegExp(bookingBusiness.name) })).toBeChecked();
    await expectNoWcagViolations(page);

    await page.goto('/manage?tab=alerts');
    await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read alert: Booking time confirmed', exact: true })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('button', { name: 'Read alert: Booking time confirmed', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Booking time confirmed' })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('populated provider bookings and finance views have no detectable WCAG A or AA violations', async ({ page }) => {
    await freezeClock(page);
    await mockProvider(page);

    await page.goto('/?tab=explore&view=bookings');
    await expect(page.getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('button', {
      name: 'Open booking details for Private tennis with Avery Student',
      exact: true,
    }).click();
    await expect(page.getByRole('dialog', { name: 'Private tennis' })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('dialog').getByRole('button', { name: 'Close dialog' }).click();
    await page.goto('/?tab=explore&view=payments');
    await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
    await expectNoWcagViolations(page);

    const paymentTabs = page.getByRole('tablist', { name: 'Payments view' });
    await paymentTabs.getByRole('tab', { name: /^Outstanding/ }).click();
    await expect(page.getByRole('tabpanel', { name: /^Outstanding/ })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('populated provider student directory and profile have no detectable WCAG A or AA violations', async ({ page }) => {
    await freezeClock(page);
    await mockProvider(page);

    await page.goto('/?tab=explore&view=students');
    await expect(page.getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: "View Avery Student's profile" }).first()).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('button', { name: "View Avery Student's profile" }).first().click();
    await expect(page.getByRole('dialog', { name: 'Avery Student' })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('populated provider integrity and alerts have no detectable WCAG A or AA violations', async ({ page }) => {
    await freezeClock(page);
    await mockProvider(page);

    await page.goto('/?tab=explore&view=integrity');
    await expect(page.getByRole('heading', { name: 'Integrity', exact: true })).toBeVisible();
    await expect(page.getByText('Jordan Coach & Avery Student', { exact: true })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.goto('/?tab=alerts');
    await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
    await expectNoWcagViolations(page);

    await page.getByRole('button', { name: 'Read alert: Review a private booking pattern', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Review a private booking pattern' })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('populated provider insights have no detectable WCAG A or AA violations', async ({ page }) => {
    await freezeClock(page);
    await mockProvider(page);

    await page.goto('/?tab=explore&view=insights');
    await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: /^Weekly recorded receipts total/ })).toBeVisible();
    await expectNoWcagViolations(page);
  });

  test('authenticated provider workspace has no detectable WCAG A or AA violations', async ({ page }) => {
    await freezeClock(page);
    await mockProvider(page);

    await page.goto('/?tab=home');
    await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();
    await expectNoWcagViolations(page);
  });
});

test('admin filters are named and destructive confirmation manages keyboard focus', async ({ page }) => {
  await mockAdmin(page);
  await page.goto('/admin');

  await expect(page.getByRole('searchbox', { name: 'Search businesses' })).toBeVisible();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(refresh).toBeVisible();
  await expect(signOut).toBeVisible();
  if ((page.viewportSize()?.width ?? 1440) < 768) {
    for (const control of [refresh, signOut]) {
      await expect.poll(async () => control.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.width >= 44 && rect.height >= 44;
      }), { message: 'Mobile admin controls should be at least 44×44 CSS pixels' }).toBe(true);
    }
    const mobileDelete = page
      .getByRole('button', { name: `Delete ${adminBusiness.name}`, exact: true })
      .filter({ visible: true });
    await expect(mobileDelete).toBeVisible();
    await expect.poll(async () => mobileDelete.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44;
    }), { message: 'Mobile delete target should be at least 44×44 CSS pixels' }).toBe(true);
  }
  const filters = page.getByRole('group', { name: 'Filter businesses' });
  await expect(filters.getByRole('button', { name: 'all', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const demoRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/admin/businesses' && url.searchParams.get('filter') === 'demo' && !url.searchParams.has('search');
  });
  await filters.getByRole('button', { name: 'demo', exact: true }).click();
  await demoRequest;
  await expect(filters.getByRole('button', { name: 'demo', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: `Delete ${adminDemoBusiness.name}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Delete ${adminBusiness.name}` })).toHaveCount(0);

  const search = page.getByRole('searchbox', { name: 'Search businesses' });
  const filteredSearchRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/admin/businesses'
      && url.searchParams.get('filter') === 'demo'
      && url.searchParams.get('search') === adminBusiness.name;
  });
  await search.fill(adminBusiness.name);
  await filteredSearchRequest;
  await expect(page.getByText('No businesses match your filters yet.', { exact: true })).toBeVisible();

  const restoredDemoRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/admin/businesses' && url.searchParams.get('filter') === 'demo' && !url.searchParams.has('search');
  });
  await search.clear();
  await restoredDemoRequest;
  await expect(page.getByRole('button', { name: `Delete ${adminDemoBusiness.name}` })).toBeVisible();

  const realRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/admin/businesses' && url.searchParams.get('filter') === 'real' && !url.searchParams.has('search');
  });
  await filters.getByRole('button', { name: 'real', exact: true }).click();
  await realRequest;
  await expect(page.getByRole('button', { name: `Delete ${adminBusiness.name}` })).toBeVisible();
  await expect(page.getByRole('button', { name: `Delete ${adminDemoBusiness.name}` })).toHaveCount(0);

  const deleteButton = page.getByRole('button', { name: `Delete ${adminBusiness.name}` });
  await deleteButton.focus();
  await deleteButton.press('Enter');

  const dialog = page.getByRole('dialog', { name: `Delete “${adminBusiness.name}”?` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This cannot be undone.');
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();

  await cancel.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(deleteButton).toBeFocused();
});

test('student search and custom tablists support keyboard-only operation', async ({ page }) => {
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();

  await page.goto('/?tab=explore&view=students');
  await expect(page.getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
  const studentSearch = page.getByRole('searchbox', { name: 'Search students by name, email, phone, or parent' });
  await studentSearch.focus();
  await studentSearch.pressSequentially('Amelia Wong');
  await expect(page.getByText('Ethan Lim', { exact: true })).toHaveCount(0);

  const openAmelia = page.getByRole('button', { name: "View Amelia Wong's profile" }).first();
  await openAmelia.focus();
  await openAmelia.press('Enter');

  const profile = page.getByRole('dialog', { name: 'Amelia Wong' });
  const studentTabs = profile.getByRole('tablist', { name: 'Student records' });
  const lessonHistory = studentTabs.getByRole('tab', { name: /^Lesson history/ });
  const packages = studentTabs.getByRole('tab', { name: /^Packages/ });
  await expect(lessonHistory).toHaveAttribute('tabindex', '0');
  await expect(packages).toHaveAttribute('tabindex', '-1');

  await lessonHistory.focus();
  await lessonHistory.press('End');
  await expect(packages).toBeFocused();
  await expect(packages).toHaveAttribute('aria-selected', 'true');
  await expect(packages).toHaveAttribute('tabindex', '0');
  await expect(profile.getByRole('tabpanel', { name: /^Packages/ })).toBeVisible();

  await packages.press('ArrowRight');
  await expect(lessonHistory).toBeFocused();
  await expect(lessonHistory).toHaveAttribute('aria-selected', 'true');
  await lessonHistory.press('ArrowLeft');
  await expect(packages).toBeFocused();
  await profile.getByRole('button', { name: 'Close dialog' }).click();

  await page.goto('/?tab=explore&view=payments');
  await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search payments' })).toBeVisible();
  const paymentTabs = page.getByRole('tablist', { name: 'Payments view' });
  const history = paymentTabs.getByRole('tab', { name: 'Payment history', exact: true });
  const outstanding = paymentTabs.getByRole('tab', { name: /^Outstanding/ });
  await expect(history).toHaveAttribute('tabindex', '0');
  await expect(outstanding).toHaveAttribute('tabindex', '-1');

  await history.focus();
  await history.press('ArrowRight');
  await expect(outstanding).toBeFocused();
  await expect(outstanding).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: /^Outstanding/ })).toBeVisible();
  await outstanding.press('Home');
  await expect(history).toBeFocused();
  await expect(history).toHaveAttribute('aria-selected', 'true');
  await history.press('ArrowLeft');
  await expect(outstanding).toBeFocused();
});
