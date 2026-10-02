import { expect, test, type Page } from '@playwright/test';
import type {
  AccountBooking, AccountCapabilities, AccountPackage, AccountWaitlistEntry, AuthSession, ChildProgress, ChildSchedule,
  PackageActivity, ProgressSummary, SessionSearchResponse, StudentClubDirectoryEntry,
} from '../src/lib/types';
import { openDisclosure } from './progressive-disclosure';

// The training-companion layer of the student app. Every API is mocked so the
// assertions hold at all three viewports, and they use roles and labels only.

const NOW = new Date('2026-10-01T04:00:00.000Z'); // Thursday 1 October, 12:00 in Singapore

const riverside = {
  name: 'Riverside Rackets', slug: 'riverside-rackets', ownerName: 'Riverside team', timezone: 'Asia/Singapore',
  currency: 'SGD', color: '#174c3c', tagline: 'Tennis by the river.', cancellationHours: 24, kind: 'CLUB' as const,
};
const shuttle = { ...riverside, name: 'Shuttle House', slug: 'shuttle-house', tagline: 'Badminton for every level.', color: '#785b90' };

const capabilities: AccountCapabilities = {
  ordinaryAccess: true, familyManagement: false, payments: true, staffAccess: true, directory: true, chat: true,
  commerce: true, rentals: true, calendar: true, workspace: true, profileEdit: true,
};

function session(familyManagement = false): AuthSession {
  return {
    user: {
      id: 'companion-student', name: 'Avery Player', username: 'avery_player', email: 'avery@example.test',
      accountType: 'STUDENT', sports: ['Tennis'], accountControl: 'SELF', dateOfBirth: '1990-01-01',
      capabilities: { ...capabilities, familyManagement },
    },
    membership: null, business: null, memberships: [],
  };
}

function accountBooking(values: {
  id: string; club?: typeof riverside; service: string; serviceId?: string; startAt: string; endAt: string;
  status?: AccountBooking['booking']['status']; type?: 'PRIVATE' | 'GROUP';
}): AccountBooking {
  const club = values.club ?? riverside;
  const participant = {
    id: `participant-${values.id}`, studentId: 'student-1', name: 'Avery Player', email: 'avery@example.test',
    attendance: 'UNMARKED' as const, paid: true, price: 8_000, packageId: null, notes: '',
  };
  return {
    business: club,
    booking: {
      id: values.id, serviceId: values.serviceId ?? 'svc-private', serviceName: values.service, instructorId: 'coach-jordan',
      instructorName: 'Jordan Coach', locationId: 'loc-centre', locationName: 'Centre Court', locationColor: '#174c3c',
      startAt: values.startAt, endAt: values.endAt, status: values.status ?? 'CONFIRMED', type: values.type ?? 'PRIVATE',
      capacity: 1, price: 8_000, paymentRoute: 'CLUB', coachAcceptance: 'NOT_REQUIRED', createdByRole: 'STUDENT',
      address: '1 Club Lane', recurringId: null, participants: [participant],
    },
    participant, canCancel: true, canReschedule: true, paymentRoute: 'CLUB',
  };
}

const bookings: AccountBooking[] = [
  accountBooking({ id: 'booking-private', service: 'Private tennis', startAt: '2026-10-03T02:00:00.000Z', endAt: '2026-10-03T03:00:00.000Z' }),
  accountBooking({ id: 'booking-squad', club: shuttle, service: 'Squad session', startAt: '2026-10-03T08:00:00.000Z', endAt: '2026-10-03T09:30:00.000Z', status: 'PENDING', type: 'GROUP' }),
  accountBooking({ id: 'booking-past', service: 'Group tennis', serviceId: 'svc-group', startAt: '2026-09-26T02:00:00.000Z', endAt: '2026-09-26T03:00:00.000Z', status: 'COMPLETED', type: 'GROUP' }),
];

const directory: StudentClubDirectoryEntry[] = [
  { business: riverside, sports: ['Tennis'], serviceCount: 3, coachCount: 2, locationCount: 1, priceFrom: 3_000, areas: ['Tampines · East'] },
  { business: shuttle, sports: ['Badminton'], serviceCount: 2, coachCount: 1, locationCount: 1, priceFrom: 2_500, areas: ['Jurong'] },
];

const lowPackage: AccountPackage = {
  id: 'pkg-low', businessId: 'riverside', offerId: 'offer-1', name: 'Flexible five', totalCredits: 5, usedCredits: 4,
  remainingCredits: 1, price: 20_000, expiresAt: '2026-10-05T15:59:59.000Z', paid: true, state: 'ACTIVE',
  business: { name: riverside.name, slug: riverside.slug, currency: 'SGD' }, offer: { id: 'offer-1', name: 'Flexible five' },
  serviceId: null, serviceIds: ['svc-private', 'svc-group'], rentalLocationIds: [],
  services: [{ id: 'svc-private', name: 'Private tennis' }, { id: 'svc-group', name: 'Group tennis' }], rentalLocations: [],
};
const groupPackage: AccountPackage = {
  ...lowPackage, id: 'pkg-group', name: 'Group ten', totalCredits: 10, usedCredits: 3, remainingCredits: 7,
  expiresAt: '2026-12-31T15:59:59.000Z', serviceIds: ['svc-group'], services: [{ id: 'svc-group', name: 'Group tennis' }],
};
const expiredPackage: AccountPackage = {
  ...lowPackage, id: 'pkg-expired', name: 'Spring pass', usedCredits: 3, remainingCredits: 2,
  expiresAt: '2026-06-30T15:59:59.000Z', state: 'EXPIRED',
};

function waitlistEntry(values: Partial<AccountWaitlistEntry> & { id: string; service: string; startAt: string }): AccountWaitlistEntry {
  const { service, startAt, ...rest } = values;
  return {
    status: 'WAITING', aheadCount: 3, offeredAt: null, offerExpiresAt: null, createdAt: '2026-09-28T00:00:00.000Z', closedReason: null,
    business: riverside,
    booking: {
      id: `class-${values.id}`, serviceId: 'svc-group', serviceName: service, instructorId: 'coach-jordan', instructorName: 'Jordan Coach',
      locationId: 'loc-centre', locationName: 'Centre Court', startAt, endAt: startAt, capacity: 6, price: 3_000,
    },
    ...rest,
  };
}

const feedbackItems: ProgressSummary['feedback'] = [
  {
    id: 'feedback-1', bookingId: 'booking-past', participantId: 'participant-booking-past',
    business: { name: riverside.name, slug: riverside.slug }, serviceName: 'Group tennis', sport: 'Tennis', coachName: 'Jordan Coach',
    authorRole: 'COACH', sessionStartAt: '2026-09-26T02:00:00.000Z', timezone: 'Asia/Singapore',
    summary: 'Much steadier rallies from the baseline.', strengths: 'Footwork', focusAreas: 'Second serve toss height',
    nextGoal: 'Land seven of ten second serves', sharedAt: '2026-09-26T06:00:00.000Z', editedAt: null, viewed: false,
  },
  {
    id: 'feedback-2', bookingId: 'booking-older', participantId: 'participant-older',
    business: { name: shuttle.name, slug: shuttle.slug }, serviceName: 'Squad session', sport: 'Badminton', coachName: 'Sam Lee',
    authorRole: 'CLUB', sessionStartAt: '2026-09-12T08:00:00.000Z', timezone: 'Asia/Singapore',
    summary: 'Good energy in the drills.', strengths: '', focusAreas: '', nextGoal: '', sharedAt: '2026-09-12T12:00:00.000Z',
    editedAt: null, viewed: true,
  },
];

const progress: ProgressSummary = {
  stats: {
    attended: 12, booked: 15, upcoming: 2, hoursOnCourt: 14.5, currentStreakWeeks: 3, longestStreakWeeks: 5, clubs: 2,
    coaches: 2, lastAttendedAt: '2026-09-26T03:00:00.000Z', attendanceRate: 0.92,
  },
  monthly: [
    { month: '2026-05', attended: 1 }, { month: '2026-06', attended: 2 }, { month: '2026-07', attended: 0 },
    { month: '2026-08', attended: 3 }, { month: '2026-09', attended: 5 }, { month: '2026-10', attended: 1 },
  ],
  currentGoal: { text: 'Land seven of ten second serves', setAt: '2026-09-26T06:00:00.000Z', coachName: 'Jordan Coach', businessName: riverside.name },
  feedback: feedbackItems,
  filters: { clubs: [{ slug: riverside.slug, name: riverside.name }, { slug: shuttle.slug, name: shuttle.name }], coaches: ['Jordan Coach', 'Sam Lee'], sports: ['Badminton', 'Tennis'] },
};

const searchResponse: SessionSearchResponse = {
  truncated: true,
  results: [{
    business: riverside,
    service: { id: 'svc-group', name: 'Group tennis', category: 'Tennis', type: 'GROUP', duration: 60 },
    instructor: { id: 'coach-jordan', name: 'Jordan Coach', initials: 'JC', color: '#174c3c' },
    location: { id: 'loc-centre', name: 'Centre Court', area: 'Tampines · East', address: '1 Club Lane' },
    startAt: '2026-10-01T11:00:00.000Z', endAt: '2026-10-01T12:00:00.000Z', price: 3_000, placesRemaining: 3,
  }],
};

type MockOptions = {
  family?: 'ready' | 'disabled';
  waitlist?: AccountWaitlistEntry[];
  packages?: AccountPackage[];
  favorites?: string[];
  failFavoriteRemoval?: boolean;
  notifications?: unknown[];
};

async function mockCompanion(page: Page, options: MockOptions = {}) {
  const calls = {
    bookingLoads: 0, accept: [] as unknown[], decline: 0, leave: 0, viewed: [] as string[],
    progressQueries: [] as string[], searches: [] as string[], favoritePuts: [] as string[], favoriteDeletes: [] as string[],
  };
  let waitlist = [...(options.waitlist ?? [])];

  await page.clock.install({ time: NOW });
  await page.route('**/api/auth/me', route => route.fulfill({ json: session(options.family !== undefined) }));
  await page.route('**/api/payments/capabilities', route => route.fulfill({
    json: { mode: 'disabled', enabled: false, liveCheckout: false, simulatedCheckout: false, publishableKey: null },
  }));
  await page.route(/\/api\/account\/bookings(?:\?.*)?$/, route => { calls.bookingLoads += 1; return route.fulfill({ json: { bookings } }); });
  await page.route(/\/api\/account\/clubs(?:\?.*)?$/, route => route.fulfill({ json: { clubs: directory } }));
  await page.route(/\/api\/account\/notifications(?:\/read)?$/, route => route.fulfill({
    json: route.request().method() === 'GET' ? { notifications: options.notifications ?? [] } : { ok: true },
  }));
  await page.route(/\/api\/account\/packages$/, route => route.fulfill({ json: { packages: options.packages ?? [] } }));
  await page.route(/\/api\/account\/package-offers(?:\?.*)?$/, route => route.fulfill({ json: { offers: [] } }));
  await page.route(/\/api\/rentals(?:\?.*)?$/, route => route.fulfill({ json: { rentals: [], nextCursor: null } }));
  await page.route('**/api/rentals/reservations/mine', route => route.fulfill({ json: { reservations: [] } }));
  await page.route(/\/api\/chats\/unread(?:\?.*)?$/, route => route.fulfill({ json: { unreadThreads: 0 } }));
  await page.route('**/api/calendar/connection', route => route.fulfill({ json: { configured: false, eligible: true } }));

  await page.route(/\/api\/account\/packages\/[^/]+\/activity$/, route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const pkg = [lowPackage, expiredPackage, groupPackage].find(item => item.id === id)!;
    const activity: PackageActivity = {
      package: { id: pkg.id, name: pkg.name, totalCredits: pkg.totalCredits, usedCredits: pkg.usedCredits, remainingCredits: pkg.remainingCredits, expiresAt: pkg.expiresAt, business: pkg.business },
      events: pkg.id === 'pkg-expired'
        ? [
          { id: 'e1', kind: 'GRANTED', delta: 5, balanceAfter: 5, totalAfter: 5, note: '', createdAt: '2026-03-01T02:00:00.000Z', bookingId: null, reservationId: null, session: null },
          { id: 'e2', kind: 'BOOKED', delta: -3, balanceAfter: 2, totalAfter: 5, note: '', createdAt: '2026-04-01T02:00:00.000Z', bookingId: 'b', reservationId: null, session: { serviceName: 'Private tennis', startAt: '2026-04-04T02:00:00.000Z', timezone: 'Asia/Singapore' } },
          { id: 'expiry:pkg-expired', kind: 'EXPIRED', delta: -2, balanceAfter: 0, totalAfter: 5, note: '', createdAt: '2026-06-30T15:59:59.000Z', bookingId: null, reservationId: null, session: null },
        ]
        : [
          { id: 'e1', kind: 'GRANTED', delta: 5, balanceAfter: 5, totalAfter: 5, note: '', createdAt: '2026-09-01T02:00:00.000Z', bookingId: null, reservationId: null, session: null },
          { id: 'e2', kind: 'BOOKED', delta: -1, balanceAfter: 4, totalAfter: 5, note: '', createdAt: '2026-09-02T02:00:00.000Z', bookingId: 'booking-past', reservationId: null, session: { serviceName: 'Group tennis', startAt: '2026-09-26T02:00:00.000Z', timezone: 'Asia/Singapore' } },
          { id: 'e3', kind: 'BOOKED', delta: -3, balanceAfter: 1, totalAfter: 5, note: '', createdAt: '2026-09-20T02:00:00.000Z', bookingId: null, reservationId: null, session: null },
        ],
    };
    return route.fulfill({ json: activity });
  });

  await page.route('**/api/account/waitlist', route => route.fulfill({ json: { entries: waitlist } }));
  await page.route(/\/api\/account\/waitlist\/[^/]+\/accept$/, route => {
    calls.accept.push(route.request().postDataJSON());
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    waitlist = waitlist.map(entry => entry.id === id ? { ...entry, status: 'ACCEPTED' } : entry);
    return route.fulfill({ json: { entry: waitlist.find(entry => entry.id === id), bookings: [bookings[0].booking] } });
  });
  await page.route(/\/api\/account\/waitlist\/[^/]+\/decline$/, route => {
    calls.decline += 1;
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    waitlist = waitlist.map(entry => entry.id === id ? { ...entry, status: 'DECLINED' } : entry);
    return route.fulfill({ json: { entry: waitlist.find(entry => entry.id === id) } });
  });
  await page.route(/\/api\/account\/waitlist\/[^/]+$/, route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    calls.leave += 1;
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    waitlist = waitlist.map(entry => entry.id === id ? { ...entry, status: 'WITHDRAWN' } : entry);
    return route.fulfill({ json: { entry: waitlist.find(entry => entry.id === id) } });
  });

  await page.route(/\/api\/account\/progress(?:\?.*)?$/, route => {
    const url = new URL(route.request().url());
    calls.progressQueries.push(url.search);
    const slug = url.searchParams.get('businessSlug');
    return route.fulfill({ json: slug ? { ...progress, feedback: progress.feedback.filter(item => item.business.slug === slug) } : progress });
  });
  await page.route(/\/api\/account\/feedback\/[^/]+\/viewed$/, route => {
    calls.viewed.push(new URL(route.request().url()).pathname.split('/').at(-2)!);
    return route.fulfill({ json: { ok: true } });
  });

  let favorites = [...(options.favorites ?? [])];
  await page.route('**/api/account/favorites', route => route.fulfill({
    json: { favorites: favorites.map(slug => ({ slug, savedAt: '2026-09-30T00:00:00.000Z' })) },
  }));
  await page.route(/\/api\/account\/favorites\/[^/]+$/, route => {
    const slug = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    if (route.request().method() === 'PUT') {
      calls.favoritePuts.push(slug);
      favorites = [slug, ...favorites.filter(item => item !== slug)];
      return route.fulfill({ json: { slug, savedAt: NOW.toISOString() } });
    }
    calls.favoriteDeletes.push(slug);
    if (options.failFavoriteRemoval) return route.fulfill({ status: 500, json: { error: 'Saved clubs are temporarily unavailable.' } });
    favorites = favorites.filter(item => item !== slug);
    return route.fulfill({ json: { ok: true } });
  });

  await page.route(/\/api\/account\/sessions\/search(?:\?.*)?$/, route => {
    calls.searches.push(new URL(route.request().url()).search);
    return route.fulfill({ json: searchResponse });
  });

  await page.route('**/api/family/booking-children', route => options.family === 'disabled'
    ? route.fulfill({ status: 503, json: { error: 'Family accounts are not available yet.' } })
    : route.fulfill({ json: { children: [{ id: 'child-riley', displayName: 'Riley', username: 'riley_tan' }] } }));
  await page.route('**/api/family/children/child-riley/schedule', route => {
    const schedule: ChildSchedule = {
      child: { id: 'child-riley', name: 'Riley', username: 'riley_tan' },
      bookings: [
        {
          participantId: 'riley-place-1', bookingId: 'riley-booking-1', business: { name: riverside.name, slug: riverside.slug, timezone: 'Asia/Singapore' },
          serviceName: 'Junior squad', sport: 'Tennis', type: 'GROUP', coachName: 'Jordan Coach',
          location: { name: 'Centre Court', address: '1 Club Lane', area: 'Tampines · East', mapsUrl: '' },
          startAt: '2026-10-04T01:00:00.000Z', endAt: '2026-10-04T02:00:00.000Z', status: 'CONFIRMED', attendance: 'UNMARKED', hasFeedback: false,
        },
        {
          participantId: 'riley-place-0', bookingId: 'riley-booking-0', business: { name: riverside.name, slug: riverside.slug, timezone: 'Asia/Singapore' },
          serviceName: 'Junior squad', sport: 'Tennis', type: 'GROUP', coachName: 'Jordan Coach',
          location: { name: 'Centre Court', address: '1 Club Lane', area: 'Tampines · East', mapsUrl: '' },
          startAt: '2026-09-27T01:00:00.000Z', endAt: '2026-09-27T02:00:00.000Z', status: 'COMPLETED', attendance: 'PRESENT', hasFeedback: true,
        },
      ],
    };
    return route.fulfill({ json: schedule });
  });
  await page.route('**/api/family/children/child-riley/progress', route => {
    const childProgress: ChildProgress = {
      ...progress,
      child: { id: 'child-riley', name: 'Riley', username: 'riley_tan' },
      feedback: [{ ...feedbackItems[0], id: 'riley-feedback', serviceName: 'Junior squad', summary: 'Riley tracked the ball beautifully.' }],
    };
    return route.fulfill({ json: childProgress });
  });

  return calls;
}

async function expectNoSidewaysScroll(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('Home switches to a remembered month calendar that opens the same booking dialog', async ({ page }) => {
  await mockCompanion(page);
  await page.goto('/manage');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();

  const history = page.locator('section[aria-labelledby="booking-history"]');
  // Past sessions stay one tap away so Home leads with what is next.
  await history.getByRole('button', { name: /^See \d+ more session/ }).click();
  await expect(history.getByRole('link', { name: 'Book Group tennis at Riverside Rackets again' }))
    .toHaveAttribute('href', '/book/riverside-rackets?service=svc-group&coach=coach-jordan&venue=loc-centre&rebook=1');

  const views = page.getByRole('group', { name: 'Show bookings as' });
  await expect(views.getByRole('button', { name: 'List', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await views.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(views.getByRole('button', { name: 'Calendar', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const grid = page.getByRole('grid', { name: 'October 2026' });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('button', { name: 'Thursday 1 October, no sessions, today' })).toHaveAttribute('aria-current', 'date');
  const saturday = grid.getByRole('button', { name: 'Saturday 3 October, 2 sessions' });
  await saturday.click();
  const agenda = page.getByRole('region', { name: 'Saturday 3 October' });
  await expect(agenda.getByRole('button', { name: 'Open details for Squad session at Shuttle House' })).toBeVisible();

  // Arrow keys move the single focusable day; Page Down changes month.
  await saturday.focus();
  await page.keyboard.press('ArrowRight');
  await expect(grid.getByRole('button', { name: 'Sunday 4 October, no sessions' })).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect(page.getByRole('grid', { name: 'November 2026' }).getByRole('button', { name: 'Wednesday 4 November, no sessions' })).toBeFocused();
  await page.getByRole('button', { name: 'Go to today' }).click();
  await expect(page.getByRole('grid', { name: 'October 2026' })).toBeVisible();

  await page.getByRole('grid', { name: 'October 2026' }).getByRole('button', { name: 'Saturday 3 October, 2 sessions' }).click();
  await page.getByRole('region', { name: 'Saturday 3 October' })
    .getByRole('button', { name: 'Open details for Private tennis at Riverside Rackets' }).click();
  const dialog = page.getByRole('dialog', { name: 'Private tennis' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Book again' }))
    .toHaveAttribute('href', '/book/riverside-rackets?service=svc-private&coach=coach-jordan&venue=loc-centre&rebook=1');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('group', { name: 'Show bookings as' }).getByRole('button', { name: 'Calendar', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('grid', { name: 'October 2026' })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('an offered waitlist place can be confirmed with a package, and a waiting place left', async ({ page }) => {
  const calls = await mockCompanion(page, {
    packages: [groupPackage],
    waitlist: [
      waitlistEntry({ id: 'waiting', service: 'Junior squad', startAt: '2026-10-08T10:00:00.000Z' }),
      waitlistEntry({ id: 'offer', service: 'Group tennis', startAt: '2026-10-05T10:00:00.000Z', status: 'OFFERED', aheadCount: null, offeredAt: NOW.toISOString(), offerExpiresAt: '2026-10-01T06:00:00.000Z' }),
    ],
  });
  await page.goto('/manage');
  const panel = page.getByRole('region', { name: 'Your waitlist' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('1 place held for you')).toBeVisible();

  const offer = panel.getByRole('article', { name: 'Group tennis' });
  const waiting = panel.getByRole('article', { name: 'Junior squad' });
  await expect(offer).toContainText(/left to confirm/);
  await expect(offer).toContainText('Confirm by');
  await expect(waiting).toContainText('3 ahead of you');
  await expect(waiting).toContainText('the club may also offer a place directly');

  const loadsBefore = calls.bookingLoads;
  await offer.getByLabel('How to pay').selectOption({ label: 'Use 1 credit from Group ten (7 left)' });
  await offer.getByRole('button', { name: 'Confirm my place' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'You’re booked into Group tennis' })).toBeVisible();
  expect(calls.accept).toEqual([{ packageId: 'pkg-group' }]);
  await expect.poll(() => calls.bookingLoads).toBeGreaterThan(loadsBefore);
  await expect(panel.getByRole('article', { name: 'Group tennis' })).toHaveCount(0);

  await waiting.getByRole('button', { name: 'Leave waitlist' }).click();
  await waiting.getByRole('button', { name: 'Yes, leave' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'You left the waitlist for Junior squad' })).toBeVisible();
  await expect.poll(() => calls.leave).toBe(1);
  await expectNoSidewaysScroll(page);
});

test('declining an offered place asks first and passes it on', async ({ page }) => {
  const calls = await mockCompanion(page, {
    waitlist: [waitlistEntry({ id: 'offer', service: 'Group tennis', startAt: '2026-10-05T10:00:00.000Z', status: 'OFFERED', aheadCount: null, offerExpiresAt: '2026-10-01T05:00:00.000Z' })],
  });
  await page.goto('/manage');
  const offer = page.getByRole('region', { name: 'Your waitlist' }).getByRole('article', { name: 'Group tennis' });
  await offer.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(offer).toContainText('It will be offered to the next person');
  await offer.getByRole('button', { name: 'Keep the offer' }).click();
  expect(calls.decline).toBe(0);
  await offer.getByRole('button', { name: 'Decline', exact: true }).click();
  await offer.getByRole('button', { name: 'Yes, decline' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'You declined the place in Group tennis' })).toBeVisible();
  await expect.poll(() => calls.decline).toBe(1);
});

test('progress separates statistics from coach feedback and records a viewed note', async ({ page }) => {
  const calls = await mockCompanion(page, {
    notifications: [{
      id: 'alert-feedback', type: 'FEEDBACK_SHARED', bookingId: 'booking-past', packageId: null, title: 'New coach feedback',
      message: 'Jordan Coach shared feedback on your Group tennis session.', read: false, actionNeeded: false,
      createdAt: '2026-09-26T06:00:00.000Z', business: { name: riverside.name, slug: riverside.slug },
    }],
  });
  await page.goto('/manage');
  const card = page.getByRole('region', { name: 'Progress' });
  await expect(card).toContainText('3-week streak');
  await expect(card).toContainText('12');
  await expect(card).toContainText('Land seven of ten second serves');
  await expect(card).toContainText('Latest coach note');
  await card.getByRole('button', { name: 'View progress' }).click();

  await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'progress');
  await expect(page.getByRole('heading', { name: 'Progress', level: 1 })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Student navigation' });
  await expect(navigation.getByRole('button')).toHaveCount(5);
  await expect(page.getByText('Automatic statistics')).toBeVisible();
  await expect(page.getByText('Written by coaches')).toBeVisible();
  // The monthly chart and secondary statistics wait behind "More progress".
  await expect(page.getByRole('figure', { name: 'Sessions attended, last 6 months' })).toBeHidden();
  await page.getByRole('button', { name: 'More progress', exact: true }).click();
  await expect(page.getByRole('figure', { name: 'Sessions attended, last 6 months' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('September 2026');

  const notes = page.getByRole('region', { name: 'Coach feedback' });
  const first = notes.getByRole('article', { name: 'Group tennis' });
  await expect(first.getByText('New', { exact: true })).toBeVisible();
  await first.getByRole('button', { name: /^Read full feedback for Group tennis/ }).click();
  await expect(first.getByText('What to work on')).toBeVisible();
  await expect(first.getByRole('button', { name: /^Show less/ })).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => calls.viewed).toEqual(['feedback-1']);
  await expect(first.getByText('New', { exact: true })).toHaveCount(0);

  await openDisclosure(page, 'Filter feedback');
  await page.getByLabel('Club', { exact: true }).selectOption({ label: 'Shuttle House' });
  await expect.poll(() => calls.progressQueries.at(-1)).toBe('?businessSlug=shuttle-house');
  await expect(notes.getByRole('article', { name: 'Group tennis' })).toHaveCount(0);
  await expect(notes.getByRole('article', { name: 'Squad session' })).toBeVisible();

  await page.getByRole('button', { name: /^Alerts/ }).click();
  await page.getByRole('button', { name: 'Unread alert: New coach feedback' }).click();
  await page.getByRole('dialog', { name: 'New coach feedback' }).getByRole('button', { name: 'See coach feedback' }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'progress');
  await expectNoSidewaysScroll(page);
});

test('package warnings lead to the credit ledger and another purchase', async ({ page }) => {
  await mockCompanion(page, { packages: [lowPackage, expiredPackage] });
  await page.goto('/manage');
  const summary = page.getByRole('region', { name: 'Active packages' });
  const reminders = summary.getByRole('list', { name: 'Flexible five reminders' });
  await expect(reminders).toContainText('1 credit left');
  await expect(reminders).toContainText('Expires in 5 days');

  await summary.getByRole('button', { name: 'View activity for Flexible five' }).click();
  const dialog = page.getByRole('dialog', { name: 'Flexible five activity' });
  const ledger = dialog.getByRole('list', { name: 'Credit history, oldest first' });
  await expect(ledger.getByRole('listitem')).toHaveCount(3);
  await expect(ledger.getByRole('listitem').first()).toContainText('Credits added');
  await expect(ledger.getByRole('listitem').first()).toContainText('+5');
  await expect(ledger.getByRole('listitem').nth(1)).toContainText('Used for a Class');
  await expect(ledger.getByRole('listitem').nth(1)).toContainText('−1');
  await expect(ledger.getByRole('listitem').nth(1)).toContainText('Group tennis');
  await expect(ledger.getByRole('listitem').nth(1)).toContainText('4 credits left');
  await dialog.getByRole('button', { name: 'Buy another package' }).click();
  await expect(page.getByRole('dialog', { name: 'Packages from Riverside Rackets' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Packages from Riverside Rackets' }).getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('navigation', { name: 'Student navigation' }).getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'View My Packages' }).click();
  await page.locator('#student-package-list').getByRole('button', { name: 'View activity for Spring pass' }).click();
  const expired = page.getByRole('dialog', { name: 'Spring pass activity' });
  await expect(expired.getByRole('listitem').last()).toContainText('Expired unused');
  await expect(expired.getByRole('listitem').last()).toContainText('−2');
  await expectNoSidewaysScroll(page);
});

test('clubs can be saved optimistically, with a rollback when the save fails', async ({ page }) => {
  const calls = await mockCompanion(page, { favorites: [shuttle.slug], failFavoriteRemoval: true });
  await page.goto('/manage?tab=explore');
  const riversideHeart = page.getByRole('button', { name: 'Save Riverside Rackets' });
  const shuttleHeart = page.getByRole('button', { name: 'Save Shuttle House' });
  await expect(riversideHeart).toHaveAttribute('aria-pressed', 'false');
  await expect(shuttleHeart).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Tampines · East').first()).toBeVisible();

  await riversideHeart.click();
  await expect(riversideHeart).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => calls.favoritePuts).toEqual([riverside.slug]);

  await shuttleHeart.click();
  await expect(page.getByRole('status').filter({ hasText: 'Shuttle House could not be removed' })).toBeVisible();
  await expect(shuttleHeart).toHaveAttribute('aria-pressed', 'true');

  await openDisclosure(page, 'More club filters');
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '2 clubs found' })).toBeVisible();
  await expectNoSidewaysScroll(page);
});

test('Find a time searches across clubs, remembers the search, and links to the exact slot', async ({ page }) => {
  const calls = await mockCompanion(page);
  await page.goto('/manage?tab=explore');
  const finder = page.getByRole('region', { name: 'Find a time' });
  await expect(finder.getByLabel('Date')).toHaveValue('2026-10-01');
  await finder.getByLabel('Sport').selectOption('Tennis');
  await openDisclosure(finder, 'More filters');
  await finder.getByLabel('Time of day').selectOption('evening');
  await finder.getByRole('button', { name: 'Find times' }).click();

  await expect.poll(() => calls.searches.at(-1)).toBe('?date=2026-10-01&sport=Tennis&timeOfDay=evening');
  await expect(finder.getByRole('status').filter({ hasText: '1 open session found' })).toBeVisible();
  await expect(finder).toContainText('more open sessions than we can show');
  await expect(finder.getByRole('heading', { name: 'Thursday 1 October' })).toBeVisible();
  await expect(finder).toContainText('3 places left');
  await expect(finder).toContainText('$30');
  await expect(finder).toContainText('Tampines · East');
  await openDisclosure(finder, 'Recent searches');
  await expect(finder.getByRole('button', { name: 'Search again: Tennis · Evening' })).toBeVisible();

  const book = finder.getByRole('link', { name: 'Book Group tennis at Riverside Rackets, Thursday 1 October at 7:00 PM' });
  await expect(book).toHaveAttribute('href', '/book/riverside-rackets?service=svc-group&coach=coach-jordan&venue=loc-centre&date=2026-10-01&start=2026-10-01T11%3A00%3A00.000Z&source=search');
  await expectNoSidewaysScroll(page);
  await book.click();
  await expect(page).toHaveURL(url => url.pathname === '/book/riverside-rackets' && url.searchParams.get('source') === 'search');
});

test('a guardian views a child’s schedule and progress without signing in as the child', async ({ page }) => {
  const calls = await mockCompanion(page, { family: 'ready' });
  await page.goto('/manage');
  const switcher = page.getByLabel('Viewing as');
  await expect(switcher).toHaveValue('self');
  await switcher.selectOption({ label: 'Riley' });

  await expect(page).toHaveURL(url => url.searchParams.get('player') === 'child-riley');
  await expect(page.getByRole('heading', { name: /Riley.s training/, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'My bookings' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Active packages' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Profile & consent in Family/ })).toHaveAttribute('href', '/family');
  await expect(page.getByRole('button', { name: 'Book a Class for Riley' })).toBeVisible();

  const schedule = page.getByRole('tabpanel', { name: 'Schedule' });
  await schedule.getByRole('button', { name: 'Open details for Junior squad at Riverside Rackets' }).first().click();
  const session = page.getByRole('dialog', { name: 'Junior squad' });
  await expect(session).toContainText('read-only');
  await expect(session.getByRole('button', { name: /Message/ })).toHaveCount(0);
  await session.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('tab', { name: 'Progress' }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'progress' && url.searchParams.get('player') === 'child-riley');
  const progressPanel = page.getByRole('tabpanel', { name: 'Progress' });
  await progressPanel.getByRole('button', { name: /^Read full feedback for Junior squad/ }).click();
  await expect(progressPanel).toContainText('Riley tracked the ball beautifully.');
  // A guardian's reading is not the learner's receipt.
  expect(calls.viewed).toEqual([]);
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: 'Book a Class for Riley' }).click();
  await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'book' && !url.searchParams.has('player'));
  await expect(page.getByText('Booking for Riley?')).toBeVisible();
  await expect(page.getByLabel('Viewing as')).toHaveValue('self');
});

test('the player switcher stays hidden and a stale child link falls back when Family is off', async ({ page }) => {
  await mockCompanion(page, { family: 'disabled' });
  await page.goto('/manage?tab=home&player=child-riley');
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
  await expect(page).toHaveURL(url => !url.searchParams.has('player'));
  await expect(page.getByLabel('Viewing as')).toHaveCount(0);
});
