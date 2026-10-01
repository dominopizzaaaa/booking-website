import { expect, test, type Page, type Route } from '@playwright/test';
import { rebookHref, searchResultHref } from '../src/lib/booking-links';
import type {
  AccountWaitlistEntry,
  AuthSession,
  Booking,
  PublicBusiness,
  Slot,
  WaitlistJoinInput,
} from '../src/lib/types';

// The public booking page's training-companion layer, against mocked API
// responses so every viewport sees the same catalogue: the decision header,
// rich coach cards, "Book again" and search preselection, and the waitlist
// entry point on full group Classes.

const slug = 'companion-rackets';

function singaporeDate(days: number) {
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

function addMinutes(startAt: string, minutes: number) {
  return new Date(new Date(startAt).getTime() + minutes * 60_000).toISOString();
}

const catalog: PublicBusiness = {
  business: {
    name: 'Companion Rackets Club',
    slug,
    ownerName: 'Companion Operations',
    timezone: 'Asia/Singapore',
    currency: 'SGD',
    color: '#174c3c',
    tagline: 'Coaching for every level.',
    cancellationHours: 24,
    kind: 'CLUB',
    description: 'A friendly indoor tennis and badminton club with juniors, adults and returning players on court every day.',
    publicPhone: '+65 6123 4567',
    websiteUrl: 'https://www.companion-rackets.example/coaching',
    supportEmail: 'hello@companion-rackets.example',
  },
  instructors: [
    {
      id: 'coach-casey',
      name: 'Casey Lim',
      initials: 'CL',
      color: '#527a5b',
      specialty: 'Footwork and match play',
      active: true,
      profile: {
        bio: 'I coach players who want to move better and enjoy competing. Sessions start with footwork patterns, build into '
          + 'live-ball drills, and finish with match play so every new skill is tested under a little pressure. I have '
          + 'coached juniors through their first tournaments and adults returning to the court after years away, and I '
          + 'adapt every plan to the player in front of me rather than a fixed syllabus. Expect clear goals, honest '
          + 'feedback after each session, and plenty of rallies.',
        languages: ['English', 'Mandarin'],
        coachingLevels: ['INTERMEDIATE', 'BEGINNER'],
        coachingAgeGroups: ['ADULT', 'JUNIOR'],
        qualifications: ['Level 2 club coach', 'First aid certified'],
        coachingSince: 2016,
        sports: ['Tennis', 'Badminton'],
      },
    },
    {
      id: 'coach-drew',
      name: 'Drew Tan',
      initials: 'DT',
      color: '#78915e',
      specialty: 'Serve and volley',
      active: true,
      profile: null,
    },
  ],
  locations: [
    {
      id: 'court-east',
      name: 'East Courts',
      address: '1 Rally Road, Singapore',
      area: 'Tampines · East',
      type: 'FACILITY',
      color: '#78915e',
      requiresApproval: false,
      active: true,
    },
    {
      id: 'court-central',
      name: 'Central Hall',
      address: '2 Serve Street, Singapore',
      area: 'Bishan · Central',
      type: 'FACILITY',
      color: '#527a5b',
      requiresApproval: false,
      active: true,
    },
  ],
  services: [
    {
      id: 'svc-private',
      name: 'Private tennis lesson',
      description: 'One-to-one coaching.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: 8_000,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [
        { locationId: 'court-east', price: 8_000, duration: 60, instructorIds: ['coach-casey', 'coach-drew'] },
        { locationId: 'court-central', price: 9_000, duration: 60, instructorIds: ['coach-casey'] },
      ],
    },
    {
      id: 'svc-group',
      name: 'Junior badminton clinic',
      description: 'Small-group skills and games.',
      category: 'Badminton',
      type: 'GROUP',
      duration: 90,
      price: 4_500,
      capacity: 4,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{ locationId: 'court-east', price: 4_500, duration: 90, instructorIds: ['coach-casey'] }],
    },
  ],
  summary: {
    sports: ['Badminton', 'Tennis'],
    priceFrom: 4_500,
    coachCount: 2,
    locationCount: 2,
    serviceCount: 2,
    groupClassCount: 1,
    areas: ['Bishan · Central', 'Tampines · East'],
  },
};

const studentSession: AuthSession = {
  user: {
    id: 'companion-student',
    name: 'Avery Player',
    username: 'avery_player',
    email: 'avery.player@example.test',
    accountType: 'STUDENT',
    accountControl: 'SELF',
    sports: ['Tennis'],
    phone: '',
    parentName: '',
    emailVerified: true,
  },
  membership: null,
  business: null,
  memberships: [],
};

const guardianSession: AuthSession = {
  ...studentSession,
  user: {
    ...studentSession.user,
    capabilities: {
      ordinaryAccess: true, familyManagement: true, payments: true, staffAccess: true, directory: true, chat: true,
      commerce: true, rentals: true, calendar: true, workspace: false, profileEdit: true,
    },
  },
};

function privateSlots(date: string): Slot[] {
  return [10, 12].map(hour => ({
    startAt: localStart(date, hour),
    endAt: addMinutes(localStart(date, hour), 60),
    available: true,
    placesRemaining: 1,
  }));
}

function groupSlots(date: string): Slot[] {
  return [
    { startAt: localStart(date, 10), endAt: addMinutes(localStart(date, 10), 90), available: true, placesRemaining: 2 },
    { startAt: localStart(date, 12), endAt: addMinutes(localStart(date, 12), 90), available: false, placesRemaining: 0, reason: 'This group is full' },
  ];
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', json });
}

async function mockClub(
  page: Page,
  session: AuthSession | null,
  publicCatalog = catalog,
  slotsFor: (url: URL) => Slot[] = (url) => {
    const date = url.searchParams.get('date') ?? singaporeDate(1);
    return url.searchParams.get('serviceId') === 'svc-group' ? groupSlots(date) : privateSlots(date);
  },
) {
  await page.route(/\/api\/auth\/me$/, route => session
    ? fulfillJson(route, session)
    : fulfillJson(route, { error: 'Authentication required' }, 401));
  await page.route(new RegExp(`/api/public/${slug}$`), route => fulfillJson(route, publicCatalog));
  await page.route(new RegExp(`/api/public/${slug}/slots\\?`), route => {
    const url = new URL(route.request().url());
    return fulfillJson(route, { slots: slotsFor(url) });
  });
  await page.route(new RegExp(`/api/public/${slug}/bookings$`), async route => {
    const body = route.request().postDataJSON() as { serviceId: string; instructorId: string; locationId: string; startAt: string };
    const service = publicCatalog.services.find(candidate => candidate.id === body.serviceId)!;
    const mapping = service.locations.find(candidate => candidate.locationId === body.locationId)!;
    const coach = publicCatalog.instructors.find(candidate => candidate.id === body.instructorId)!;
    const venue = publicCatalog.locations.find(candidate => candidate.id === body.locationId)!;
    const booking: Booking = {
      id: 'companion-booking-1',
      serviceId: service.id,
      serviceName: service.name,
      instructorId: coach.id,
      instructorName: coach.name,
      locationId: venue.id,
      locationName: venue.name,
      locationColor: venue.color,
      startAt: body.startAt,
      endAt: addMinutes(body.startAt, mapping.duration),
      status: 'CONFIRMED',
      type: service.type,
      capacity: service.capacity,
      price: mapping.price,
      paymentRoute: 'CLUB',
      coachAcceptance: 'NOT_REQUIRED',
      createdByRole: 'STUDENT',
      notes: '',
      address: '',
      recurringId: null,
      participants: [{
        id: 'companion-participant-1',
        studentId: 'companion-student-row',
        name: studentSession.user.name,
        email: studentSession.user.email,
        attendance: 'UNMARKED',
        paid: false,
        price: mapping.price,
        packageId: null,
        notes: '',
      }],
    };
    await fulfillJson(route, { bookings: [booking] }, 201);
  });
}

function visibleAction(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true }).filter({ visible: true });
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
}

const stepTwoHeading = (page: Page) =>
  page.getByRole('heading', { name: 'Choose a date and time', exact: true });

test('the decision header shows a new player what they need before booking', async ({ page }) => {
  await mockClub(page, null);
  await page.goto(`/book/${slug}`);
  await expect(page.getByRole('heading', { name: 'Choose a class', exact: true })).toBeVisible();

  const header = page.getByRole('region', { name: catalog.business.name, exact: true });
  let clubDetails = header.getByRole('button', { name: 'See more club details', exact: true });
  await expect(clubDetails).toHaveAttribute('aria-expanded', 'false');
  await clubDetails.click();
  clubDetails = header.getByRole('button', { name: 'Show less club details', exact: true });
  await expect(clubDetails).toHaveAttribute('aria-expanded', 'true');
  await expect(header.getByText(/^A friendly indoor tennis and badminton club/)).toBeVisible();
  await expect(header.getByText('Badminton, Tennis', { exact: true })).toBeVisible();
  await expect(header.getByText(/^S?\$45 \/ class$/)).toBeVisible();
  await expect(header.getByText('2 coaches', { exact: true })).toBeVisible();
  await expect(header.getByText('Bishan · Central, Tampines · East', { exact: true })).toBeVisible();
  const cancellation = header.getByText('Cancel or reschedule at least 24 hours before your session.', { exact: true });
  await expect(cancellation).toBeVisible();

  await expect(header.getByRole('link', { name: /hello@companion-rackets\.example/ }))
    .toHaveAttribute('href', 'mailto:hello@companion-rackets.example');
  await expect(header.getByRole('link', { name: /\+65 6123 4567/ })).toHaveAttribute('href', 'tel:+6561234567');
  const website = header.getByRole('link', { name: /companion-rackets\.example\/coaching/ });
  await expect(website).toHaveAttribute('href', 'https://www.companion-rackets.example/coaching');
  await expect(website).toHaveAttribute('target', '_blank');
  await expect(website).toHaveAttribute('rel', /\bnoopener\b/);
  await expect(website).toHaveAttribute('rel', /\bnoreferrer\b/);

  const explainer = header.locator('summary').filter({ hasText: 'What happens after booking' });
  await expect(explainer.locator('..')).not.toHaveAttribute('open', '');
  await explainer.click();
  await expect(explainer.locator('..')).toHaveAttribute('open', '');
  for (const text of [
    /^Your place is confirmed straight away/,
    /^Nothing is charged on this page\./,
    /^Cancel or reschedule from My bookings at least 24 hours before the session\./,
    /^Each Class has a chat in Courtly/,
  ]) {
    await expect(header.getByText(text)).toBeVisible();
  }
  await expectNoHorizontalOverflow(page);

  // The optional club context folds away, and opens again on request.
  await page.getByRole('button', { name: /Private tennis lesson/ }).click();
  await visibleAction(page, 'Continue').click();
  await expect(clubDetails).toHaveAttribute('aria-expanded', 'true');
  await clubDetails.click();
  clubDetails = header.getByRole('button', { name: 'See more club details', exact: true });
  await expect(clubDetails).toHaveAttribute('aria-expanded', 'false');
  await expect(cancellation).toBeHidden();
  await clubDetails.click();
  clubDetails = header.getByRole('button', { name: 'Show less club details', exact: true });
  await expect(clubDetails).toHaveAttribute('aria-expanded', 'true');
  await expect(cancellation).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('coach cards show a self-reported public profile without contact details', async ({ page }) => {
  await mockClub(page, null);
  await page.goto(`/book/${slug}`);
  await page.getByRole('button', { name: /Private tennis lesson/ }).click();
  await visibleAction(page, 'Continue').click();

  const east = page.getByRole('button', { name: /East Courts/ });
  await expect(east).toContainText('Tampines · East');
  await expect(page.getByRole('button', { name: /Central Hall/ })).toContainText('Bishan · Central');
  await east.click();

  const coaches = page.getByRole('list', { name: 'Coaches', exact: true });
  const casey = coaches.getByRole('listitem').filter({ hasText: 'Casey Lim' });
  await expect(casey).toContainText(/\d+ years coaching · since 2016/);
  const background = casey.locator('summary').filter({ hasText: 'Coach background' });
  await expect(background.locator('..')).not.toHaveAttribute('open', '');
  await background.click();
  await expect(background.locator('..')).toHaveAttribute('open', '');
  await expect(casey).toContainText('Tennis, Badminton');
  await expect(casey).toContainText('Beginner, Intermediate');
  await expect(casey).toContainText('Juniors, Adults');
  await expect(casey).toContainText('English, Mandarin');
  await expect(casey).toContainText('Self-reported qualifications');
  await expect(casey).toContainText('Level 2 club coach');
  await expect(casey).not.toContainText('@');

  const more = casey.getByRole('button', { name: 'See more', exact: true });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(casey.getByRole('button', { name: 'Show less', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(casey).toContainText('plenty of rallies');

  // The bio toggle is never named for the coach, so choosing by name stays unambiguous.
  const chooseCasey = page.getByRole('button', { name: /Casey Lim/ });
  await expect(chooseCasey).toHaveCount(1);
  await chooseCasey.click();
  await expect(chooseCasey).toHaveAttribute('aria-pressed', 'true');

  const drew = coaches.getByRole('listitem').filter({ hasText: 'Drew Tan' });
  await expect(drew.getByRole('button')).toHaveCount(1);
  await expect(drew).not.toContainText('Self-reported qualifications');
  await expectNoHorizontalOverflow(page);
});

test('long booking choices reveal more only when requested', async ({ page }) => {
  const extraCoaches = Array.from({ length: 4 }, (_, index) => ({
    id: `coach-extra-${index}`,
    name: `Extra Coach ${index + 1}`,
    initials: `E${index + 1}`,
    color: '#78915e',
    specialty: 'All levels',
    active: true,
    profile: null,
  }));
  const extraLocations = Array.from({ length: 4 }, (_, index) => ({
    id: `court-extra-${index}`,
    name: `Extra Court ${index + 1}`,
    address: `${index + 3} Rally Road`,
    area: 'Singapore',
    type: 'FACILITY' as const,
    color: '#78915e',
    requiresApproval: false,
    active: true,
  }));
  const coaches = [...catalog.instructors, ...extraCoaches];
  const locations = [...catalog.locations, ...extraLocations];
  const coachIds = coaches.map(coach => coach.id);
  const privateService = catalog.services[0];
  const expandedCatalog: PublicBusiness = {
    ...catalog,
    instructors: coaches,
    locations,
    services: [
      {
        ...privateService,
        locations: locations.map(location => ({
          locationId: location.id, price: 8_000, duration: 60, instructorIds: coachIds,
        })),
      },
      ...catalog.services.slice(1),
      ...Array.from({ length: 4 }, (_, index) => ({
        ...privateService, id: `svc-extra-${index}`, name: `Extra class ${index + 1}`,
      })),
    ],
  };
  await mockClub(page, null, expandedCatalog, url => {
    const date = url.searchParams.get('date') ?? singaporeDate(1);
    return Array.from({ length: 10 }, (_, index) => ({
      startAt: localStart(date, 8 + index),
      endAt: addMinutes(localStart(date, 8 + index), 60),
      available: true,
      placesRemaining: 1,
    }));
  });

  await page.goto(`/book/${slug}`);
  await expect(page.getByRole('button', { name: /Extra class 3/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'See 2 more classes', exact: true }).click();
  await expect(page.getByRole('button', { name: /Extra class 3/ })).toBeVisible();

  await page.getByRole('button', { name: /Private tennis lesson/ }).click();
  await visibleAction(page, 'Continue').click();
  await expect(page.getByRole('button', { name: /Extra Court 3/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'See 2 more places', exact: true }).click();
  await expect(page.getByRole('button', { name: /Extra Court 3/ })).toBeVisible();
  await page.getByRole('button', { name: /East Courts/ }).click();
  await expect(page.getByRole('button', { name: /Extra Coach 3/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'See 2 more coaches', exact: true }).click();
  await expect(page.getByRole('button', { name: /Extra Coach 3/ })).toBeVisible();
  await page.getByRole('button', { name: /Casey Lim/ }).click();
  await visibleAction(page, 'Continue').click();
  await expect(page.getByRole('radio')).toHaveCount(8);
  await page.getByRole('button', { name: 'See 2 more times', exact: true }).click();
  await expect(page.getByRole('radio')).toHaveCount(10);
  await expectNoHorizontalOverflow(page);
});

test('Book again prefills the Class and books the next available time in one tap', async ({ page }) => {
  await mockClub(page, studentSession);
  const nextSlots = [2, 4, 6, 8, 10].map(days => privateSlots(singaporeDate(days))[0]);
  const nextRequests: URL[] = [];
  await page.route(new RegExp(`/api/public/${slug}/next-available\\?`), route => {
    nextRequests.push(new URL(route.request().url()));
    return fulfillJson(route, { slots: nextSlots });
  });

  await page.goto(rebookHref(slug, { serviceId: 'svc-private', instructorId: 'coach-casey', locationId: 'court-east' }));
  await expect(stepTwoHeading(page)).toBeVisible();
  const banner = page.getByRole('status').filter({ hasText: 'Booking again' });
  await expect(banner).toContainText('Private tennis lesson with Casey Lim at East Courts from your last booking.');
  await expect(banner).toContainText('You can still change anything.');

  const strip = page.getByRole('region', { name: 'Next available with Casey Lim', exact: true });
  const choices = strip.getByRole('button');
  await expect(choices).toHaveCount(5);
  expect(nextRequests.length).toBeGreaterThanOrEqual(1);
  expect(Object.fromEntries(nextRequests.at(-1)!.searchParams)).toEqual({
    serviceId: 'svc-private', instructorId: 'coach-casey', locationId: 'court-east', limit: '5',
  });

  // A time beyond this week: the day strip follows it and the slot is selected.
  const chosen = nextSlots[3];
  await choices.nth(3).click();
  await expect(choices.nth(3)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Choose a date', { exact: true })).toHaveValue(singaporeDate(8));
  await expect(page.getByRole('radio', { name: /^10:00 AM/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('button[aria-label][aria-pressed="true"]')).toHaveCount(1);
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Dismiss booking again message', exact: true }).click();
  await expect(banner).toHaveCount(0);
  await expect(stepTwoHeading(page)).toBeFocused();

  await visibleAction(page, 'Continue').click();
  await expect(page.getByRole('heading', { name: studentSession.user.name, exact: true })).toBeVisible();
  await visibleAction(page, 'Review booking').click();
  await page.getByRole('checkbox').check();
  const bookingRequest = page.waitForRequest(request =>
    request.method() === 'POST' && new URL(request.url()).pathname === `/api/public/${slug}/bookings`);
  await visibleAction(page, 'Confirm booking').click();
  expect((await bookingRequest).postDataJSON()).toMatchObject({
    serviceId: 'svc-private',
    instructorId: 'coach-casey',
    locationId: 'court-east',
    startAt: chosen.startAt,
    repeatWeeks: 1,
    source: 'REBOOK',
  });
  await expect(page.getByRole('heading', { name: 'You’re on the calendar.', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('a search result opens on its exact day and slot and is attributed to search', async ({ page }) => {
  await mockClub(page, studentSession);
  let nextAvailableRequests = 0;
  await page.route(new RegExp(`/api/public/${slug}/next-available\\?`), route => {
    nextAvailableRequests += 1;
    return fulfillJson(route, { slots: [] });
  });
  const date = singaporeDate(12);
  const startAt = localStart(date, 12);

  await page.goto(searchResultHref({
    business: { slug }, service: { id: 'svc-private' }, instructor: { id: 'coach-casey' }, location: { id: 'court-east' }, startAt,
  }, date));
  await expect(stepTwoHeading(page)).toBeVisible();
  await expect(page.getByLabel('Choose a date', { exact: true })).toHaveValue(date);
  await expect(page.getByRole('radio', { name: /^12:00 PM/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'From your search' }))
    .toContainText('Private tennis lesson with Casey Lim at East Courts for');
  await expect(page.getByRole('region', { name: /^Next available/ })).toHaveCount(0);
  expect(nextAvailableRequests).toBe(0);
  await expectNoHorizontalOverflow(page);

  await visibleAction(page, 'Continue').click();
  await visibleAction(page, 'Review booking').click();
  await page.getByRole('checkbox').check();
  const bookingRequest = page.waitForRequest(request =>
    request.method() === 'POST' && new URL(request.url()).pathname === `/api/public/${slug}/bookings`);
  await visibleAction(page, 'Confirm booking').click();
  expect((await bookingRequest).postDataJSON()).toMatchObject({ startAt, source: 'SEARCH' });
  await expect(page.getByRole('heading', { name: 'You’re on the calendar.', exact: true })).toBeVisible();
});

test('a search result whose time has gone explains it and selects nothing', async ({ page }) => {
  await mockClub(page, studentSession);
  const date = singaporeDate(12);
  await page.goto(searchResultHref({
    business: { slug }, service: { id: 'svc-private' }, instructor: { id: 'coach-casey' }, location: { id: 'court-east' },
    startAt: localStart(date, 11),
  }, date));
  await expect(stepTwoHeading(page)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'is no longer available' })).toContainText('11:00 AM');
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(visibleAction(page, 'Continue')).toBeDisabled();
  await expectNoHorizontalOverflow(page);
});

test('a signed-in student joins the waitlist for a full group Class', async ({ page }) => {
  await mockClub(page, studentSession);
  const date = singaporeDate(9);
  const fullStart = localStart(date, 12);
  const joined: WaitlistJoinInput[] = [];
  await page.route(new RegExp(`/api/public/${slug}/waitlist$`), route => {
    const body = route.request().postDataJSON() as WaitlistJoinInput;
    joined.push(body);
    const entry: AccountWaitlistEntry = {
      id: 'companion-waitlist-1',
      status: 'WAITING',
      aheadCount: 2,
      offeredAt: null,
      offerExpiresAt: null,
      createdAt: new Date().toISOString(),
      closedReason: null,
      business: catalog.business,
      booking: {
        id: 'companion-group-booking', serviceId: body.serviceId, serviceName: 'Junior badminton clinic',
        instructorId: body.instructorId, instructorName: 'Casey Lim', locationId: body.locationId, locationName: 'East Courts',
        startAt: body.startAt, endAt: addMinutes(body.startAt, 90), capacity: 4, price: 4_500,
      },
    };
    return fulfillJson(route, { entry }, 201);
  });

  await page.goto(`/book/${slug}?service=svc-group&coach=coach-casey&venue=court-east&date=${date}`);
  await expect(stepTwoHeading(page)).toBeVisible();
  await expect(page.getByRole('radio', { name: /^10:00 AM.*2 places left/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /^12:00 PM/ })).toHaveCount(0);

  const full = page.getByRole('region', { name: 'Full group times', exact: true });
  await full.getByRole('button', { name: 'Join waitlist for 12:00 PM', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Join the waitlist?' });
  await expect(confirm).toContainText('Junior badminton clinic with Casey Lim');
  await expect(confirm).toContainText('held for you for a limited time');
  await expect(confirm).toContainText('Confirm the offer in My bookings');
  await expect(confirm).toContainText('doesn’t book or charge anything');
  await expectNoHorizontalOverflow(page);
  await confirm.getByRole('button', { name: 'Join waitlist', exact: true }).click();

  const success = page.getByRole('dialog', { name: 'You’re on the waitlist' });
  await expect(success).toContainText('2 people ahead of you.');
  await expect(success.getByRole('heading', { name: 'You’re on the waitlist', exact: true })).toBeFocused();
  await expect(success.getByRole('link', { name: 'Open My bookings', exact: true })).toHaveAttribute('href', '/manage');
  expect(joined).toEqual([{
    serviceId: 'svc-group', instructorId: 'coach-casey', locationId: 'court-east', startAt: fullStart,
  }]);
  await success.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(full).toContainText('On the waitlist · 2 people ahead of you.');
  await expect(full.getByRole('button', { name: /Join waitlist/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('a visitor is asked to sign in, returning to the same full Class', async ({ page }) => {
  await mockClub(page, null);
  const date = singaporeDate(9);
  await page.goto(`/book/${slug}?service=svc-group&coach=coach-casey&venue=court-east&date=${date}`);
  await expect(stepTwoHeading(page)).toBeVisible();

  const full = page.getByRole('region', { name: 'Full group times', exact: true });
  await expect(full.getByRole('button', { name: /Join waitlist/ })).toHaveCount(0);
  const signIn = full.getByRole('link', { name: 'Sign in to join waitlist for 12:00 PM', exact: true });
  const href = await signIn.getAttribute('href');
  const login = new URL(href ?? '', 'https://courtly.test');
  expect(login.pathname).toBe('/login');
  const back = new URL(login.searchParams.get('next') ?? '', 'https://courtly.test');
  expect(back.pathname).toBe(`/book/${slug}`);
  expect(Object.fromEntries(back.searchParams)).toEqual({
    service: 'svc-group', coach: 'coach-casey', venue: 'court-east', date, start: localStart(date, 12),
  });
  await expectNoHorizontalOverflow(page);
});

test('the waitlist is hidden while a guardian books for a child', async ({ page }) => {
  await mockClub(page, guardianSession);
  await page.route(/\/api\/family\/booking-children$/, route => fulfillJson(route, {
    children: [{ id: 'companion-child', displayName: 'Riley', username: 'riley_player' }],
  }));
  const date = singaporeDate(9);
  await page.goto(`/book/${slug}?service=svc-group&coach=coach-casey&venue=court-east&date=${date}`);
  await expect(stepTwoHeading(page)).toBeVisible();
  const full = page.getByRole('region', { name: 'Full group times', exact: true });
  await expect(full.getByRole('button', { name: 'Join waitlist for 12:00 PM', exact: true })).toBeVisible();

  await page.getByRole('radio', { name: /^10:00 AM/ }).click();
  await visibleAction(page, 'Continue').click();
  await page.getByRole('radio', { name: /Riley/ }).check();
  await visibleAction(page, 'Back').click();
  await expect(stepTwoHeading(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Full group times', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Join waitlist/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
