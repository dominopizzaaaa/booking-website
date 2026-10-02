import { expect, test, type Page } from '@playwright/test';
import type {
  AuthSession, CoachProfile, FeedbackInput, GrowthInsights, ManagerWorkspace, ProviderFeedback, ProviderWaitlist,
  TrainingGroup, TrainingGroupInput,
} from '../src/lib/types';

// The training-companion workspace surfaces run against a fresh demo club so
// navigation, permissions and refresh are real. Companion endpoints and the
// lessons under test are mocked so every viewport sees the same state.

type WorkspaceBooking = ManagerWorkspace['bookings'][number];

async function demoWorkspace(page: Page) {
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
  const response = await page.request.get('/api/workspace');
  expect(response.ok()).toBeTruthy();
  return await response.json() as ManagerWorkspace;
}

function sourceBooking(workspace: ManagerWorkspace) {
  const source = workspace.bookings.find(booking => booking.participants.length > 0);
  if (!source) throw new Error('The demo workspace needs a booking with a participant');
  return source;
}

async function serveBookings(page: Page, workspace: ManagerWorkspace, bookings: () => WorkspaceBooking[]) {
  await page.route('**/api/workspace', route => route.fulfill({ json: { ...workspace, bookings: bookings() } }));
  await page.route(/\/api\/bookings(?:\?.*)?$/, route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: { bookings: bookings(), nextCursor: null } });
  });
}

async function openBooking(page: Page, serviceName: string) {
  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible({ timeout: 45_000 });
  await page.locator('main article').filter({ hasText: serviceName }).getByRole('button', { name: /Open booking details/ }).click();
  const dialog = page.getByRole('dialog', { name: serviceName, exact: true });
  await expect(dialog.getByRole('heading', { name: serviceName, exact: true })).toBeVisible();
  return dialog;
}

function requestTo(page: Page, method: string, pathname: string) {
  return page.waitForRequest(request => request.method() === method && new URL(request.url()).pathname === pathname);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
}

test('a coach-side user runs a started Class: roll call, shared feedback, and completion', async ({ page }) => {
  const workspace = await demoWorkspace(page);
  const source = sourceBooking(workspace);
  const serviceName = 'Run this Class check';
  let booking: WorkspaceBooking = {
    ...source,
    id: `${source.id}-run`,
    serviceName,
    startAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    endAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    status: 'CONFIRMED',
    coachAcceptance: 'NOT_REQUIRED',
    paymentRoute: 'CLUB',
    participants: source.participants.map(participant => ({
      ...participant, id: `${participant.id}-run`, attendance: 'UNMARKED', cancelled: false,
    })),
  };
  const learner = booking.participants[0];
  let saved: ProviderFeedback | null = null;

  await serveBookings(page, workspace, () => [...workspace.bookings, booking]);
  await page.route(`**/api/bookings/${booking.id}/waitlist`, route => route.fulfill({ json: { entries: [], placesFree: 0, canManage: true } satisfies ProviderWaitlist }));
  await page.route(`**/api/bookings/${booking.id}/feedback`, route => route.fulfill({ json: { feedback: saved ? [saved] : [], canWrite: true } }));
  await page.route(`**/api/bookings/${booking.id}/participants`, async route => {
    const body = route.request().postDataJSON() as { attendance: 'PRESENT'; participantIds?: string[] };
    booking = { ...booking, participants: booking.participants.map(participant => ({ ...participant, attendance: body.attendance })) };
    await route.fulfill({ json: { participants: booking.participants.map(participant => ({ id: participant.id, attendance: participant.attendance })) } });
  });
  await page.route(`**/api/bookings/${booking.id}/participants/${learner.id}`, async route => {
    const body = route.request().postDataJSON() as { attendance: WorkspaceBooking['participants'][number]['attendance'] };
    booking = { ...booking, participants: booking.participants.map(participant => participant.id === learner.id ? { ...participant, attendance: body.attendance } : participant) };
    await route.fulfill({ json: { id: learner.id, attendance: body.attendance } });
  });
  await page.route(`**/api/bookings/${booking.id}/participants/${learner.id}/feedback`, async route => {
    const body = route.request().postDataJSON() as FeedbackInput;
    saved = {
      id: 'feedback-e2e', bookingId: booking.id, participantId: learner.id, studentId: learner.studentId, studentName: learner.name,
      authorName: workspace.business.name, authorRole: 'CLUB', editedByName: null, visibility: body.visibility,
      summary: body.summary ?? '', strengths: body.strengths ?? '', focusAreas: body.focusAreas ?? '', nextGoal: body.nextGoal ?? '',
      clubNote: body.clubNote ?? '', sharedAt: body.visibility === 'SHARED' ? new Date().toISOString() : null,
      editedAt: null, viewedAt: null, createdAt: new Date().toISOString(),
    };
    await route.fulfill({ json: saved });
  });
  await page.route(`**/api/bookings/${booking.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    booking = { ...booking, ...(route.request().postDataJSON() as Partial<WorkspaceBooking>) };
    await route.fulfill({ json: booking });
  });

  const detail = await openBooking(page, serviceName);
  await detail.getByRole('button', { name: 'Run this Class', exact: true }).click();
  const run = page.getByRole('dialog', { name: `Run this Class: ${serviceName}`, exact: true });
  await expect(run).toBeVisible();
  const count = booking.participants.length;
  await expect(run).toContainText(`0 of ${count} marked`);
  await expectNoHorizontalOverflow(page);

  const bulk = requestTo(page, 'PATCH', `/api/bookings/${booking.id}/participants`);
  await run.getByRole('button', { name: 'Mark all present', exact: true }).click();
  expect((await bulk).postDataJSON()).toEqual({ attendance: 'PRESENT' });
  const attendance = run.getByRole('group', { name: `Attendance for ${learner.name}`, exact: true });
  await expect(attendance.getByRole('button', { name: 'Present', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(run).toContainText(`${count} of ${count} marked`);
  await expect(run.getByRole('button', { name: 'Everyone is marked', exact: true })).toHaveAttribute('aria-disabled', 'true');

  const late = requestTo(page, 'PATCH', `/api/bookings/${booking.id}/participants/${learner.id}`);
  await attendance.getByRole('button', { name: 'Late', exact: true }).click();
  expect((await late).postDataJSON()).toEqual({ attendance: 'LATE' });
  await expect(attendance.getByRole('button', { name: 'Late', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(run).toContainText('1 late');

  const toggle = run.getByRole('button', { name: `Write feedback for ${learner.name}` });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await run.getByLabel('How the session went', { exact: true }).fill('Sharp footwork and a calm second serve.');
  await run.getByLabel('Next goal', { exact: true }).fill('Split step before every return');
  await run.getByLabel('Internal note for the club', { exact: true }).fill('Ready for the intermediate squad next term.');
  await expect(run.getByText('Never shown to learners, parents or guardians, even when the feedback is shared.')).toBeVisible();
  await run.getByRole('checkbox', { name: 'Share with learner', exact: true }).check();
  await expect(run.getByText(/If .+ is a child, their parent or guardian sees it too\./)).toBeVisible();
  await expect(run.getByText('Unsaved changes', { exact: true }).first()).toBeVisible();

  const feedbackRequest = requestTo(page, 'PUT', `/api/bookings/${booking.id}/participants/${learner.id}/feedback`);
  await run.getByRole('button', { name: `Save and share feedback for ${learner.name}` }).click();
  expect((await feedbackRequest).postDataJSON()).toEqual({
    visibility: 'SHARED',
    summary: 'Sharp footwork and a calm second serve.',
    strengths: '',
    focusAreas: '',
    nextGoal: 'Split step before every return',
    clubNote: 'Ready for the intermediate squad next term.',
  });
  await expect(run.getByText('Saved · shared', { exact: true }).first()).toBeVisible();
  await expect(run.getByText('Unsaved changes', { exact: true })).toHaveCount(0);

  const completion = requestTo(page, 'PATCH', `/api/bookings/${booking.id}`);
  await run.getByRole('button', { name: 'Complete Class', exact: true }).click();
  expect((await completion).postDataJSON()).toEqual({ status: 'COMPLETED' });
  await expect(run).toContainText('This Class is complete.');
  await expect(run.getByRole('button', { name: 'Complete Class', exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await run.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(run).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Run this Class', exact: true })).toBeFocused();
});

test('the Run this Class entry waits for the start, and the waitlist offers and removes places', async ({ page }) => {
  const workspace = await demoWorkspace(page);
  const source = sourceBooking(workspace);
  const serviceName = 'Waitlist panel check';
  const startAt = new Date(Date.now() + 26 * 60 * 60_000).toISOString();
  const booking: WorkspaceBooking = {
    ...source,
    id: `${source.id}-waitlist`,
    serviceName,
    type: 'GROUP',
    capacity: Math.max(4, source.participants.length + 1),
    startAt,
    endAt: new Date(Date.parse(startAt) + 60 * 60_000).toISOString(),
    status: 'CONFIRMED',
    coachAcceptance: 'NOT_REQUIRED',
    participants: source.participants.map(participant => ({ ...participant, id: `${participant.id}-waitlist`, attendance: 'UNMARKED' })),
  };
  const offerExpiresAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
  let waitlist: ProviderWaitlist = {
    placesFree: 1,
    canManage: true,
    entries: [
      { id: 'wait-ben', studentId: 'student-ben', studentName: 'Ben Lim', status: 'WAITING', position: 1, offeredAt: null, offerExpiresAt: null, createdAt: new Date().toISOString() },
      { id: 'wait-cara', studentId: 'student-cara', studentName: 'Cara Ng', status: 'WAITING', position: 2, offeredAt: null, offerExpiresAt: null, createdAt: new Date().toISOString() },
      { id: 'wait-dee', studentId: 'student-dee', studentName: 'Dee Koh', status: 'OFFERED', position: null, offeredAt: new Date().toISOString(), offerExpiresAt, createdAt: new Date().toISOString() },
    ],
  };

  await serveBookings(page, workspace, () => [...workspace.bookings, booking]);
  await page.route(`**/api/bookings/${booking.id}/waitlist`, route => route.fulfill({ json: waitlist }));
  await page.route('**/api/waitlist/wait-ben/offer', async route => {
    waitlist = {
      ...waitlist, placesFree: 0,
      entries: waitlist.entries.map(entry => entry.id === 'wait-ben' ? { ...entry, status: 'OFFERED', position: null, offeredAt: new Date().toISOString(), offerExpiresAt } : entry.id === 'wait-cara' ? { ...entry, position: 1 } : entry),
    };
    await route.fulfill({ json: { entry: waitlist.entries.find(entry => entry.id === 'wait-ben') } });
  });
  await page.route('**/api/waitlist/wait-cara', async route => {
    waitlist = { ...waitlist, entries: waitlist.entries.map(entry => entry.id === 'wait-cara' ? { ...entry, status: 'REMOVED', position: null } : entry) };
    await route.fulfill({ json: { entry: waitlist.entries.find(entry => entry.id === 'wait-cara') } });
  });

  const detail = await openBooking(page, serviceName);
  await expect(detail.getByText(/^Opens at /)).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Run this Class', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('group', { name: /^Attendance for / })).toHaveCount(0);

  const panel = detail.getByRole('region', { name: 'Waitlist', exact: true });
  await expect(panel).toContainText('#1Ben Lim');
  await expect(panel).toContainText('Place offered · held until');
  await expect(panel).toContainText('1 place free');

  const offer = requestTo(page, 'POST', '/api/waitlist/wait-ben/offer');
  await panel.getByRole('button', { name: 'Offer place to Ben Lim', exact: true }).click();
  await offer;
  await expect(page.getByText('Place offered to Ben Lim', { exact: true })).toBeVisible();
  await expect(panel).toContainText('0 places free');
  await expect(panel.getByRole('button', { name: /^Offer place/ })).toHaveCount(0);

  await panel.getByRole('button', { name: 'Remove Cara Ng', exact: true }).click();
  const confirm = panel.getByRole('region', { name: 'Remove Cara Ng from the waitlist', exact: true });
  await expect(confirm.getByRole('button', { name: 'Keep on waitlist', exact: true })).toBeFocused();
  const removal = requestTo(page, 'DELETE', '/api/waitlist/wait-cara');
  await confirm.getByRole('button', { name: 'Remove from waitlist', exact: true }).click();
  await removal;
  await expect(page.getByText('Cara Ng removed from the waitlist', { exact: true })).toBeVisible();
  await expect(panel).not.toContainText('Cara Ng');
  await panel.getByRole('button', { name: 'Show 1 closed entry', exact: true }).click();
  await expect(panel).toContainText('Removed by the club');
  await expectNoHorizontalOverflow(page);
});

test('a club creates a training group with members and schedules it as a series', async ({ page }) => {
  const workspace = await demoWorkspace(page);
  const linked = workspace.students.filter(student => !!student.userId && !!student.email);
  expect(linked.length).toBeGreaterThanOrEqual(2);
  const [first, second] = linked;
  const activeLocations = new Set(workspace.locations.filter(location => location.active).map(location => location.id));
  const activeCoaches = new Set(workspace.instructors.filter(instructor => instructor.active).map(instructor => instructor.id));
  // Prefer a group Class the series dialog can actually book, so its prefill is kept.
  const groupService = workspace.services.find(service => service.active && service.type === 'GROUP'
    && service.locations.some(mapping => activeLocations.has(mapping.locationId) && mapping.instructorIds.some(id => activeCoaches.has(id))));
  let groups: TrainingGroup[] = [];
  const groupName = 'Saturday performance squad';

  await page.route('**/api/training-groups', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as TrainingGroupInput;
      const group: TrainingGroup = {
        id: 'group-e2e', name: body.name, sport: body.sport ?? '', level: body.level ?? '', ageBand: body.ageBand ?? '',
        description: body.description ?? '', scheduleNote: body.scheduleNote ?? '', capacity: body.capacity ?? null,
        serviceId: body.serviceId ?? null, locationId: body.locationId ?? null, instructorId: body.instructorId ?? null,
        active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), members: [],
      };
      groups = [group];
      return route.fulfill({ status: 201, json: group });
    }
    return route.fulfill({ json: { groups } });
  });
  await page.route('**/api/training-groups/group-e2e/members', async route => {
    const { studentIds } = route.request().postDataJSON() as { studentIds: string[] };
    groups = groups.map(group => ({
      ...group,
      members: studentIds.map(id => {
        const student = workspace.students.find(candidate => candidate.id === id)!;
        return { studentId: id, name: student.name, initials: student.initials, joinedAt: new Date().toISOString() };
      }),
    }));
    await route.fulfill({ json: groups[0] });
  });
  await page.route('**/api/training-groups/group-e2e', async route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    groups = groups.map(group => ({ ...group, active: false }));
    await route.fulfill({ json: groups[0] });
  });

  await page.goto('/?tab=explore&view=students');
  await expect(page.locator('main').getByRole('heading', { name: 'Students', exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('tab', { name: 'Directory', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Training groups', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No training groups yet', exact: true })).toBeVisible();
  await page.locator('main').getByRole('button', { name: 'New group', exact: true }).click();

  const editor = page.getByRole('dialog', { name: 'New training group', exact: true });
  await editor.getByRole('textbox', { name: 'Group name', exact: true }).fill(groupName);
  await editor.getByLabel('Sport', { exact: true }).fill('Tennis');
  await editor.getByLabel('Capacity', { exact: true }).fill('2');
  if (groupService) await editor.getByLabel('Class', { exact: true }).selectOption(groupService.id);
  for (const student of [first, second]) {
    await editor.getByRole('searchbox', { name: 'Search students to add', exact: true }).fill(student.email!);
    await expect(editor.getByRole('checkbox')).toHaveCount(1);
    await editor.getByRole('checkbox').check();
  }
  await expect(editor).toContainText('2 of 2 places filled');
  await editor.getByRole('searchbox', { name: 'Search students to add', exact: true }).fill('');
  const blocked = editor.getByRole('checkbox', { checked: false }).first();
  if (await blocked.count()) await expect(blocked).toBeDisabled();
  await expectNoHorizontalOverflow(page);

  const create = requestTo(page, 'POST', '/api/training-groups');
  const members = requestTo(page, 'PUT', '/api/training-groups/group-e2e/members');
  await editor.getByRole('button', { name: 'Create group', exact: true }).click();
  expect((await create).postDataJSON()).toMatchObject({ name: groupName, sport: 'Tennis', capacity: 2, ...(groupService ? { serviceId: groupService.id } : {}) });
  expect((await members).postDataJSON()).toEqual({ studentIds: [first.id, second.id] });
  await expect(editor).toHaveCount(0);

  const card = page.locator('main li').filter({ has: page.getByRole('heading', { name: groupName, exact: true }) });
  await expect(card.getByRole('list', { name: `${groupName} members` })).toContainText(first.name);
  await expect(card.getByRole('list', { name: `${groupName} members` })).toContainText(second.name);
  await expect(card).toContainText('2 of 2 places filled');

  await card.getByRole('button', { name: `Schedule series for ${groupName}`, exact: true }).click();
  const series = page.getByRole('dialog', { name: 'Add a booking', exact: true });
  await expect(series.getByRole('note')).toContainText(`Scheduling ${groupName}`);
  await expect(series.getByRole('button', { name: 'Series', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(series.getByLabel('Series name (optional)', { exact: true })).toHaveValue(groupName);
  if (groupService) await expect(series.getByLabel('Class', { exact: true })).toHaveValue(groupService.id);
  await series.getByRole('button', { name: 'Close dialog' }).click();

  await card.getByRole('button', { name: `Archive ${groupName}`, exact: true }).click();
  const archive = page.getByRole('dialog', { name: 'Archive this training group?', exact: true });
  const archiveRequest = requestTo(page, 'DELETE', '/api/training-groups/group-e2e');
  await archive.getByRole('button', { name: 'Archive group', exact: true }).click();
  await archiveRequest;
  await expect(page.getByRole('heading', { name: 'No training groups yet', exact: true })).toBeVisible();
});

test('a coach edits a coaching profile with a live booking-page preview', async ({ page }) => {
  const workspace = await demoWorkspace(page);
  const auth = await (await page.request.get('/api/auth/me')).json() as AuthSession;
  const instructor = workspace.instructors.find(candidate => candidate.active);
  if (!instructor) throw new Error('The demo workspace needs an active coach');
  let coachProfile: CoachProfile = { bio: '', languages: [], coachingLevels: [], coachingAgeGroups: [], qualifications: [], coachingSince: null };
  const coachName = 'Morgan Coach';
  const coachWorkspace = () => ({
    ...workspace,
    clubAccount: false,
    accessMode: 'COACH',
    permissions: [],
    packages: [],
    payments: [],
    integrityFlags: [],
    membership: { ...workspace.membership, instructorId: instructor.id },
    user: { ...workspace.user, name: coachName, accountType: 'COACH', instructorId: instructor.id, sports: ['Tennis'], coachProfile },
  });
  await page.route('**/api/workspace', route => route.fulfill({ json: coachWorkspace() }));
  await page.route('**/api/auth/me', async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON() as { coachProfile: CoachProfile };
    coachProfile = { ...coachProfile, ...body.coachProfile };
    await route.fulfill({ json: { ...auth, user: { ...auth.user, name: coachName, accountType: 'COACH', coachProfile } } });
  });

  await page.goto('/?tab=profile');
  const panel = page.getByRole('region', { name: 'Coaching profile', exact: true });
  await expect(panel).toBeVisible({ timeout: 45_000 });
  // Sports alone already make a public card, so the preview shows them rather
  // than the empty-profile hint (the server's profile is null only without sports).
  await expect(panel).toContainText(`${coachName}Tennis`);
  await expect(panel).not.toContainText('Only your name appears until you add a few details.');
  await panel.getByRole('button', { name: 'Edit coaching profile', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit coaching profile', exact: true });
  // Each missing detail in the preview's checklist moves focus to the field that fills it.
  const languages = dialog.getByLabel('Languages', { exact: true });
  await dialog.getByRole('button', { name: 'Add the languages you coach in', exact: true }).click();
  await expect(languages).toBeFocused();
  await dialog.getByLabel('Bio', { exact: true }).fill('Patient technical coach for juniors and adults.');
  await languages.fill('English, Malay, english');
  await languages.press('Enter');
  await languages.pressSequentially('French,');
  await dialog.getByRole('button', { name: 'Remove French', exact: true }).click();
  await expect(languages).toBeFocused();
  await expect(dialog.getByRole('list', { name: 'Languages added', exact: true }).getByRole('listitem')).toHaveText(['English', 'Malay']);
  await dialog.getByRole('checkbox', { name: 'Intermediate', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'Adults', exact: true }).check();
  await dialog.getByLabel('Qualifications (self-reported)', { exact: true }).fill('ITF Level 1\nFirst Aid');
  await dialog.getByLabel('Coaching since', { exact: true }).fill('2015');

  const preview = dialog.getByRole('article', { name: `Preview of ${coachName}'s coach card`, exact: true });
  await expect(preview).toContainText('Patient technical coach for juniors and adults.');
  await expect(preview).toContainText('Speaks English, Malay');
  await expect(preview).toContainText('Self-reported qualifications');
  await expect(preview).toContainText('Courtly does not verify qualifications.');
  await expect(preview).toContainText('Coaching since 2015');
  await expectNoHorizontalOverflow(page);

  const save = requestTo(page, 'PATCH', '/api/auth/me');
  await dialog.getByRole('button', { name: 'Save coaching profile', exact: true }).click();
  expect((await save).postDataJSON()).toEqual({
    coachProfile: {
      bio: 'Patient technical coach for juniors and adults.',
      languages: ['English', 'Malay'],
      coachingLevels: ['INTERMEDIATE'],
      coachingAgeGroups: ['ADULT'],
      qualifications: ['ITF Level 1', 'First Aid'],
      coachingSince: 2015,
    },
  });
  await expect(page.getByText('Coaching profile saved', { exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText('Patient technical coach for juniors and adults.');
  await expect(panel).toContainText('Intermediate');
});

test('club growth insights render anonymous funnel, retention, and an accessible daily chart', async ({ page }) => {
  await demoWorkspace(page);
  const requestedDays: number[] = [];
  const growth = (days: number): GrowthInsights => ({
    days,
    funnel: { pageViews: 400, availabilityChecks: 160, bookings: 40, rebooks: 10, waitlistJoined: 8, waitlistAccepted: 2, searchImpressions: 120 },
    daily: Array.from({ length: days }, (_, index) => {
      const date = new Date(Date.UTC(2026, 8, 1 + index));
      return { day: date.toISOString().slice(0, 10), pageViews: index === 2 ? 30 : index % 3, availabilityChecks: index % 2, bookings: index === 2 ? 4 : 0 };
    }),
    retention: { activeStudents: 25, returningStudents: 10, repeatRate: 0.4 },
    feedback: { attendedPlaces: 0, withSharedFeedback: 0, coverage: null, viewed: 0, viewRate: null },
    waitlist: { waiting: 3, offered: 1 },
  });
  await page.route(/\/api\/insights\/growth(?:\?.*)?$/, route => {
    const days = Number(new URL(route.request().url()).searchParams.get('days') ?? 30);
    requestedDays.push(days);
    return route.fulfill({ json: growth(days) });
  });

  await page.goto('/?tab=explore&view=insights');
  await expect(page.locator('main').getByRole('heading', { name: 'Insights', exact: true })).toBeVisible({ timeout: 45_000 });
  const section = page.getByRole('region', { name: 'Growth', exact: true });
  await expect(section).toContainText('anonymous daily totals: no visitor, account or device is recorded');
  await expect(section.getByRole('button', { name: '30 days', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const funnel = section.getByRole('region', { name: 'Booking funnel', exact: true });
  await expect(funnel).toContainText('Booking page views');
  await expect(funnel).toContainText('40% of the previous step');
  await expect(funnel).toContainText('25% of the previous step');
  await expect(funnel).toContainText('10%');
  await expect(section.getByRole('region', { name: 'Retention', exact: true })).toContainText('40%');
  // No attended places yet: coverage reads as "not enough data", never NaN.
  await expect(section.getByRole('region', { name: 'Coach feedback', exact: true })).toContainText('—');
  await expect(section).not.toContainText('NaN');
  await expect(section.getByRole('region', { name: 'Waitlists right now', exact: true })).toContainText('3');

  const chart = section.getByRole('img', { name: /^Daily booking page views/ });
  await expect(chart).toBeVisible();
  await expect(section).toContainText('Booking page views per day over the last 30 days');

  await section.getByRole('button', { name: '7 days', exact: true }).click();
  await expect(section.getByRole('button', { name: '7 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(section).toContainText('Booking page views per day over the last 7 days');
  expect(requestedDays).toContain(7);

  await section.getByRole('button', { name: 'Show daily numbers', exact: true }).click();
  const table = section.getByRole('region', { name: 'Daily numbers', exact: true }).getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(8);
  await expectNoHorizontalOverflow(page);
});
