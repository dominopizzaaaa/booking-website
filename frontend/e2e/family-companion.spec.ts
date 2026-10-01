import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  AccountCapabilities,
  AuthSession,
  ChildProgress,
  ChildSchedule,
  ChildScheduleItem,
  FamilyChild,
  FamilyResponse,
  LearnerFeedback,
} from '../src/lib/types';

// A guardian abroad must still see Class times on the club's clock.
test.use({ timezoneId: 'Europe/London' });

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

function child(id: string, displayName: string, permissions: FamilyChild['link']['permissions']): FamilyChild {
  return {
    id, legalName: `${displayName} Tan`, displayName, username: `${displayName.toLowerCase()}_tan`,
    dateOfBirth: '2016-04-12', sports: ['Badminton'], profileVisibility: 'CLUBS_ONLY',
    accountControl: 'GUARDIAN_MANAGED', accountStatus: 'ACTIVE', ageBand: 'CHILD', requiredAction: null,
    link: { id: `link-${id}`, status: 'ACTIVE', relationshipType: 'Parent', permissions, createdAt: '2026-09-01T00:00:00.000Z', endedAt: null },
    consent: { status: 'GRANTED', policyVersion: '2026-09-29', consentedAt: '2026-09-01T00:00:00.000Z', expiresAt: null, withdrawnAt: null },
    handover: null, deletionRequestedAt: null,
  };
}

const allPermissions: FamilyChild['link']['permissions'] = ['PROFILE_MANAGE', 'BOOKINGS_MANAGE', 'PRIVACY_MANAGE', 'DATA_EXPORT', 'CONSENT_MANAGE', 'DELETION_REQUEST', 'HANDOVER_MANAGE'];
const family: FamilyResponse = {
  guardian: { eligible: true, reason: null },
  children: [
    child('riley-child', 'Riley', allPermissions),
    child('morgan-child', 'Morgan', allPermissions),
    child('taylor-child', 'Taylor', ['PROFILE_MANAGE', 'CONSENT_MANAGE']),
  ],
  privacyPolicyVersion: '2026-09-29', handoverAvailable: true,
};

/** 01:00 UTC is 9:00 AM in Singapore, whatever the browser's own zone. */
function utcDay(offsetDays: number, hour = 1) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

function scheduleItem(overrides: Partial<ChildScheduleItem>): ChildScheduleItem {
  return {
    participantId: 'participant', bookingId: 'booking',
    business: { name: 'Elever Badminton Academy', slug: 'elever', timezone: 'Asia/Singapore' },
    serviceName: 'Junior squad', sport: 'Badminton', type: 'GROUP', coachName: 'Dominic Loh',
    location: { name: 'Court 1', address: '1 Sports Way', area: 'Tampines · East', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Court+1' },
    startAt: utcDay(3), endAt: utcDay(3, 2), status: 'CONFIRMED', attendance: 'UNMARKED', hasFeedback: false,
    ...overrides,
  };
}

const schedule: ChildSchedule = {
  child: { id: 'riley-child', name: 'Riley', username: 'riley_tan' },
  bookings: [
    scheduleItem({ participantId: 'past', bookingId: 'past-booking', serviceName: 'Footwork clinic', startAt: utcDay(-5), endAt: utcDay(-5, 2), status: 'COMPLETED', attendance: 'PRESENT', hasFeedback: true }),
    scheduleItem({ participantId: 'next', bookingId: 'next-booking' }),
  ],
};

function feedback(id: string, overrides: Partial<LearnerFeedback>): LearnerFeedback {
  return {
    id, bookingId: 'past-booking', participantId: 'past',
    business: { name: 'Elever Badminton Academy', slug: 'elever' }, serviceName: 'Footwork clinic', sport: 'Badminton',
    coachName: 'Dominic Loh', authorRole: 'COACH', sessionStartAt: utcDay(-5), timezone: 'Asia/Singapore',
    summary: 'Great footwork on the back court.', strengths: 'Early preparation', focusAreas: 'Backhand grip', nextGoal: 'Split-step before every return',
    sharedAt: utcDay(-4), editedAt: null, viewed: false,
    ...overrides,
  };
}

const progress: ChildProgress = {
  child: { id: 'riley-child', name: 'Riley', username: 'riley_tan' },
  stats: {
    attended: 12, booked: 14, upcoming: 1, hoursOnCourt: 13.5, currentStreakWeeks: 3, longestStreakWeeks: 5,
    clubs: 1, coaches: 1, lastAttendedAt: utcDay(-5), attendanceRate: 0.857,
  },
  monthly: [
    { month: '2026-05', attended: 1 }, { month: '2026-06', attended: 2 }, { month: '2026-07', attended: 4 },
    { month: '2026-08', attended: 2 }, { month: '2026-09', attended: 2 }, { month: '2026-10', attended: 1 },
  ],
  currentGoal: { text: 'Split-step before every return', setAt: utcDay(-4), coachName: 'Dominic Loh', businessName: 'Elever Badminton Academy' },
  feedback: [
    feedback('feedback-new', {}),
    feedback('feedback-old', { serviceName: 'Junior squad', summary: 'Good effort in drills.', strengths: '', focusAreas: '', nextGoal: '', authorRole: 'CLUB', sessionStartAt: utcDay(-20) }),
  ],
  filters: { clubs: [{ slug: 'elever', name: 'Elever Badminton Academy' }], coaches: ['Dominic Loh'], sports: ['Badminton'] },
};

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', json });
}

async function mockCompanion(page: Page) {
  const requests: string[] = [];
  await page.route(/\/api\/auth\/me$/, route => fulfillJson(route, guardianSession));
  await page.route(/\/api\/family$/, route => fulfillJson(route, family));
  await page.route(/\/api\/family\/children\/[^/]+\/(schedule|progress)$/, route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname.includes('/riley-child/schedule')) return fulfillJson(route, schedule);
    if (url.pathname.includes('/riley-child/progress')) {
      // An internal remark must never surface, even if a server regression sent one.
      return fulfillJson(route, { ...progress, feedback: progress.feedback.map(entry => ({ ...entry, clubNote: 'Internal: discuss fees with parent' })) });
    }
    return fulfillJson(route, { error: 'Child profile not found', code: 'CHILD_NOT_FOUND' }, 404);
  });
  return requests;
}

async function expectNoOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
}

test('a guardian reads a child’s schedule, progress, and shared coach feedback without edit controls', async ({ page }) => {
  const requests = await mockCompanion(page);
  await page.goto('/family');

  const card = page.getByRole('article', { name: 'Riley' });
  await expect(card.getByRole('heading', { name: 'Classes and progress' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Book a Class for Riley' })).toHaveAttribute('href', '/manage?tab=explore');
  await expect(page.getByRole('article', { name: 'Taylor' }).getByRole('heading', { name: 'Classes and progress' })).toHaveCount(0);
  expect(requests).toEqual([]);

  const scheduleButton = card.getByRole('button', { name: 'Schedule for Riley' });
  await expect(scheduleButton).toHaveAttribute('aria-expanded', 'false');
  await scheduleButton.click();
  await expect(scheduleButton).toHaveAttribute('aria-expanded', 'true');
  await expect(scheduleButton).toBeFocused();

  const schedulePanel = card.getByRole('region', { name: 'Riley’s schedule' });
  await expect(schedulePanel).toContainText('View only.');
  await expect(schedulePanel).toContainText('to cancel or reschedule, contact the club');
  await expect(schedulePanel).toContainText('Times are shown in the club’s time zone (Asia/Singapore).');

  const upcoming = schedulePanel.getByRole('region', { name: /Upcoming/ });
  await expect(upcoming.getByRole('listitem')).toHaveCount(1);
  for (const text of ['Junior squad', '9:00 AM – 10:00 AM', 'Elever Badminton Academy', 'Dominic Loh', 'Court 1', 'Tampines · East', 'Confirmed']) {
    await expect(upcoming).toContainText(text);
  }
  const directions = upcoming.getByRole('link', { name: /Directions to Court 1/ });
  await expect(directions).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps/);
  await expect(directions).toHaveAttribute('target', '_blank');

  const recent = schedulePanel.getByRole('region', { name: /Recent/ });
  await expect(recent).toContainText('Footwork clinic');
  await expect(recent).toContainText('Attended');
  await expect(recent).toContainText('Coach feedback available');
  await expect(schedulePanel.getByRole('button', { name: /cancel|reschedule/i })).toHaveCount(0);
  await expectNoOverflow(page);
  await expectAccessible(page);

  await schedulePanel.getByRole('button', { name: 'Read it in Progress' }).click();
  const progressPanel = card.getByRole('region', { name: 'Riley’s progress' });
  await expect(progressPanel.getByRole('heading', { name: 'Riley’s progress' })).toBeFocused();
  await expect(card.getByRole('button', { name: 'Progress for Riley' })).toHaveAttribute('aria-expanded', 'true');
  await expect(scheduleButton).toHaveAttribute('aria-expanded', 'false');

  await expect(progressPanel).toContainText('View only.');
  await expect(progressPanel).toContainText('Internal club notes are never shown here.');
  for (const text of ['Classes attended', '12', 'Attendance rate', '86%', 'Weekly streak', '3 weeks', 'Best 5 weeks', 'Hours on court', '13.5']) {
    await expect(progressPanel).toContainText(text);
  }
  const chart = progressPanel.getByRole('figure');
  await expect(chart).toContainText('12 Classes attended in the last 6 months.');
  await expect(chart).toContainText('Busiest month: July 2026 (4).');
  await expect(chart).toContainText('July 2026: 4 Classes attended');

  await expect(progressPanel.getByRole('region', { name: 'Current goal' })).toContainText('Split-step before every return');
  await expect(progressPanel.getByRole('region', { name: 'Current goal' })).toContainText('Set by Dominic Loh at Elever Badminton Academy');
  const timeline = progressPanel.getByRole('region', { name: /Shared coach feedback/ });
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  await expect(timeline).toContainText('Great footwork on the back court.');
  await expect(timeline).toContainText('Coach Dominic Loh');
  await expect(timeline).toContainText('Good effort in drills.');
  await expect(page.getByText('Internal: discuss fees with parent')).toHaveCount(0);
  await expectNoOverflow(page);
  await expectAccessible(page);

  // Closing the open panel keeps focus on the control that closed it.
  const progressButton = card.getByRole('button', { name: 'Progress for Riley' });
  await progressButton.click();
  await expect(progressButton).toHaveAttribute('aria-expanded', 'false');
  await expect(progressButton).toBeFocused();
  await expect(card.getByRole('region', { name: 'Riley’s progress' })).toHaveCount(0);
  expect(requests).toEqual(['/api/family/children/riley-child/schedule', '/api/family/children/riley-child/progress']);
});

test('a privacy-safe 404 retires a child’s schedule and progress entry points gracefully', async ({ page }) => {
  const requests = await mockCompanion(page);
  await page.goto('/family');

  const card = page.getByRole('article', { name: 'Morgan' });
  await card.getByRole('button', { name: 'Schedule for Morgan' }).click();
  const notice = card.getByRole('status').filter({ hasText: 'aren’t available from your Family link' });
  await expect(notice).toBeVisible();
  await expect(notice).toBeFocused();
  await expect(card.getByRole('button', { name: /Schedule for Morgan|Progress for Morgan/ })).toHaveCount(0);
  await expect(card.getByRole('region', { name: /Morgan’s (schedule|progress)/ })).toHaveCount(0);
  await expect(card.getByRole('link', { name: /Book a Class for Morgan/ })).toHaveCount(0);
  expect(requests).toEqual(['/api/family/children/morgan-child/schedule']);

  // The rest of the dashboard, including the other child's projections, keeps working.
  await expect(card.getByRole('button', { name: 'Request deletion' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Riley' }).getByRole('button', { name: 'Schedule for Riley' })).toBeEnabled();
  await expectNoOverflow(page);
  await expectAccessible(page);
});

test('the installable web app manifest and its icons are served', async ({ page, request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toMatch(/application\/(manifest\+)?json/);
  const manifest = await response.json();
  expect(manifest).toMatchObject({ name: 'Courtly', short_name: 'Courtly', start_url: '/', scope: '/', display: 'standalone' });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: '/icons/icon-192.png', sizes: '192x192' }),
    expect.objectContaining({ src: '/icons/icon-512.png', sizes: '512x512' }),
    expect.objectContaining({ src: '/icons/icon-maskable-512.png', purpose: 'maskable' }),
  ]));
  for (const icon of manifest.icons as Array<{ src: string }>) {
    const image = await request.get(icon.src);
    expect(image.ok(), icon.src).toBe(true);
    expect(image.headers()['content-type']).toContain('image/png');
  }

  await page.goto('/login');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /\/manifest\.webmanifest/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#214e3e');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute('href', /\/icon\.svg/);
});
