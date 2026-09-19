import { expect, test, type APIResponse, type Cookie, type Locator, type Page } from '@playwright/test';
import type {
  AccountBooking,
  ManagerWorkspace,
} from '../src/lib/types';

const password = 'TestingOnly!2026';
const timezone = 'Asia/Singapore';

type Journey = {
  bookingId: string;
  businessSlug: string;
  clubCookies: Cookie[];
  originalStartAt: string;
  participantId: string;
  proposedStartAt: string;
  serviceId: string;
  serviceName: string;
  studentEmail: string;
  studentName: string;
};

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function uniqueValue(prefix: string, projectName: string) {
  return `${prefix}-${projectId(projectName)}-${Date.now()}`;
}

function futureSingaporeDate(days = 15) {
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

function displayedTime(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
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

async function accountBooking(page: Page, participantId: string) {
  const result = await responseJson<{ bookings: AccountBooking[] }>(
    await page.request.get('/api/account/bookings'),
  );
  const item = result.bookings.find(candidate => candidate.participant.id === participantId);
  expect(item, `Expected participant ${participantId} in the student's bookings`).toBeTruthy();
  return item!;
}

async function workspaceBooking(page: Page, bookingId: string) {
  const workspace = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  const booking = workspace.bookings.find(candidate => candidate.id === bookingId);
  expect(booking, `Expected booking ${bookingId} in the provider workspace`).toBeTruthy();
  return { booking: booking!, workspace };
}

async function openStudentBooking(page: Page, journey: Journey) {
  await page.goto(`/manage?slug=${encodeURIComponent(journey.businessSlug)}`);
  await expect(page.getByRole('heading', { name: 'My bookings', exact: true })).toBeVisible();
  await page.getByRole('button', {
    name: `Open details for ${journey.serviceName} at`,
    exact: false,
  }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: journey.serviceName, exact: true })).toBeVisible();
  return dialog;
}

async function openProviderBooking(page: Page, journey: Journey) {
  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
  await page.getByRole('button', {
    name: `Open booking details for ${journey.serviceName} with ${journey.studentName}`,
    exact: true,
  }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: journey.serviceName, exact: true })).toBeVisible();
  return dialog;
}

async function expectNoHorizontalOverflow(page: Page, dialog?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  if (dialog) {
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  }
}

async function createJourney(page: Page, projectName: string, label: string): Promise<Journey> {
  const runId = uniqueValue(label, projectName);
  const studentName = `Reschedule Student ${runId}`;
  const studentEmail = `${runId}@example.test`;

  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: studentName, email: studentEmail, password },
  }));
  await logout(page);

  // A demo is a disposable club whose signed-in institutional account can
  // explicitly create the rest of this journey without sharing seed records.
  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));
  const workspace = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  const clubCookies = await page.context().cookies();
  const instructor = workspace.instructors[0];
  expect(instructor).toBeTruthy();

  const student = await responseJson<{ id: string }>(await page.request.post('/api/students', {
    data: { email: studentEmail, notes: `Isolated ${label} reschedule journey.` },
  }));
  const location = await responseJson<{ id: string }>(await page.request.post('/api/locations', {
    data: {
      name: `Reschedule court ${runId}`,
      address: '19 Negotiation Lane',
      type: 'FACILITY',
      requiresApproval: false,
      travelMinutes: 0,
    },
  }));
  const serviceName = `Reschedule lesson ${runId}`;
  const service = await responseJson<{ id: string }>(await page.request.post('/api/services', {
    data: {
      name: serviceName,
      description: 'A private lesson used to verify two-sided time changes.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: 9_500,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{
        locationId: location.id,
        price: 9_500,
        duration: 60,
        instructorIds: [instructor.id],
      }],
    },
  }));

  const date = futureSingaporeDate();
  await responseJson(await page.request.post('/api/availability', {
    data: {
      instructorId: instructor.id,
      locationId: location.id,
      dayOfWeek: dayOfWeek(date),
      startTime: '09:00',
      endTime: '14:00',
    },
  }));

  const originalStartAt = `${date}T10:00:00+08:00`;
  const proposedStartAt = `${date}T12:00:00+08:00`;
  await switchToUser(page, studentEmail);
  const created = await responseJson<{ bookings: ManagerWorkspace['bookings'] }>(
    await page.request.post(`/api/public/${workspace.business.slug}/bookings`, {
      data: {
        serviceId: service.id,
        instructorId: instructor.id,
        locationId: location.id,
        startAt: originalStartAt,
        repeatWeeks: 1,
        notes: 'Two-sided reschedule E2E.',
        address: '',
      },
    }),
  );
  expect(created.bookings).toHaveLength(1);
  expect(created.bookings[0]).toMatchObject({ status: 'CONFIRMED', coachAcceptance: 'NOT_REQUIRED' });
  const participant = created.bookings[0].participants.find(candidate => candidate.studentId === student.id);
  expect(participant).toBeTruthy();
  await restoreCookies(page, clubCookies);

  return {
    bookingId: created.bookings[0].id,
    businessSlug: workspace.business.slug,
    clubCookies,
    originalStartAt: new Date(originalStartAt).toISOString(),
    participantId: participant!.id,
    proposedStartAt: new Date(proposedStartAt).toISOString(),
    serviceId: service.id,
    serviceName,
    studentEmail,
    studentName,
  };
}

test.describe('two-sided rescheduling', () => {
  test.describe.configure({ mode: 'serial' });

  test('student proposes and provider accepts only after reviewing the pending request', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const journey = await createJourney(page, testInfo.project.name, 'student-provider');

    await switchToUser(page, journey.studentEmail);
    let dialog = await openStudentBooking(page, journey);
    await expect(dialog).toContainText(displayedTime(journey.originalStartAt));
    await dialog.getByRole('button', { name: 'Ask for a new time', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Ask for a new time', exact: true })).toBeVisible();
    await dialog.getByLabel('Choose a date', { exact: true }).fill(futureSingaporeDate());
    await expect(dialog.getByRole('button', { name: displayedTime(journey.proposedStartAt), exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: displayedTime(journey.proposedStartAt), exact: true }).click();

    const proposalResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/account/bookings/${journey.participantId}/reschedule-requests`,
    );
    await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
    expect((await proposalResponse).status()).toBe(201);
    const requestNotice = dialog.getByRole('status').filter({
      hasText: 'Your request was sent. The session moves once your coach accepts.',
    });
    await expect(requestNotice).toBeVisible();
    await expect(requestNotice).toBeFocused();
    await expect(dialog.getByRole('region', { name: 'Your reschedule request' })).toContainText('Waiting on your coach');
    await expect(dialog.getByRole('region', { name: 'Your reschedule request' })).toContainText('It keeps its current time until your coach accepts.');
    await expect(dialog).toContainText(displayedTime(journey.originalStartAt));
    expect((await accountBooking(page, journey.participantId)).booking.startAt).toBe(journey.originalStartAt);
    await expectNoHorizontalOverflow(page, dialog);

    await restoreCookies(page, journey.clubCookies);
    dialog = await openProviderBooking(page, journey);
    await expect(dialog.getByText('The student asked for a new time', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('The session keeps its current time until both sides agree.');
    await expect(dialog).toContainText(displayedTime(journey.originalStartAt));
    await expect(dialog).toContainText(displayedTime(journey.proposedStartAt));
    expect((await workspaceBooking(page, journey.bookingId)).booking.startAt).toBe(journey.originalStartAt);
    await expectNoHorizontalOverflow(page, dialog);

    const acceptResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/accept'),
    );
    await dialog.getByRole('button', { name: 'Accept new time', exact: true }).click();
    expect((await acceptResponse).status()).toBe(200);
    await expect(page.getByText('New time confirmed', { exact: true })).toBeVisible();
    await expect(dialog.getByText('The student asked for a new time', { exact: true })).toHaveCount(0);
    await expect(dialog).toContainText(displayedTime(journey.proposedStartAt));
    expect((await workspaceBooking(page, journey.bookingId)).booking.startAt).toBe(journey.proposedStartAt);

    await switchToUser(page, journey.studentEmail);
    const moved = await accountBooking(page, journey.participantId);
    expect(moved.booking.startAt).toBe(journey.proposedStartAt);
    expect(moved.rescheduleRequest).toBeNull();
  });

  test('provider proposes and student accepts while decline and withdraw keep the original time', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const journey = await createJourney(page, testInfo.project.name, 'provider-student');

    let dialog = await openProviderBooking(page, journey);
    await dialog.getByRole('button', { name: 'Propose a new time', exact: true }).click();
    await dialog.getByLabel('Propose a new time', { exact: true }).fill(futureSingaporeDate());
    await dialog.getByLabel('New lesson time', { exact: true }).selectOption(journey.proposedStartAt);
    const proposalMessage = 'Could we use the later court window?';
    await dialog.getByLabel('Message to the student', { exact: false }).fill(proposalMessage);
    const providerProposalResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/bookings/${journey.bookingId}/reschedule-requests`,
    );
    await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
    expect((await providerProposalResponse).status()).toBe(201);
    await expect(page.getByText('Request sent to the student', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Waiting for the student to reply', { exact: true })).toBeVisible();
    await expect(dialog).toContainText('The session keeps its current time until both sides agree.');
    await expect(dialog).toContainText(proposalMessage);
    expect((await workspaceBooking(page, journey.bookingId)).booking.startAt).toBe(journey.originalStartAt);
    await expectNoHorizontalOverflow(page, dialog);

    const withdrawResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/withdraw'),
    );
    await dialog.getByRole('button', { name: 'Withdraw request', exact: true }).click();
    expect((await withdrawResponse).status()).toBe(200);
    await expect(page.getByText('Request withdrawn', { exact: true })).toBeVisible();
    expect((await workspaceBooking(page, journey.bookingId)).booking.startAt).toBe(journey.originalStartAt);

    // Raise the same proposal again, then exercise the student's decline path.
    await dialog.getByRole('button', { name: 'Propose a new time', exact: true }).click();
    await dialog.getByLabel('Propose a new time', { exact: true }).fill(futureSingaporeDate());
    await dialog.getByLabel('New lesson time', { exact: true }).selectOption(journey.proposedStartAt);
    await dialog.getByLabel('Message to the student', { exact: false }).fill(proposalMessage);
    await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
    await expect(dialog.getByText('Waiting for the student to reply', { exact: true })).toBeVisible();

    await switchToUser(page, journey.studentEmail);
    dialog = await openStudentBooking(page, journey);
    const incoming = dialog.getByRole('region', { name: 'Proposed new time' });
    await expect(incoming).toContainText('A new time was proposed');
    await expect(incoming).toContainText(proposalMessage);
    await expect(dialog).toContainText(displayedTime(journey.originalStartAt));
    await expectNoHorizontalOverflow(page, dialog);
    const declineResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/decline'),
    );
    await incoming.getByRole('button', { name: 'Keep original time', exact: true }).click();
    expect((await declineResponse).status()).toBe(200);
    const declineNotice = dialog.getByRole('status').filter({ hasText: 'The session keeps its original time.' });
    await expect(declineNotice).toBeVisible();
    await expect(declineNotice).toBeFocused();
    expect((await accountBooking(page, journey.participantId)).booking.startAt).toBe(journey.originalStartAt);

    // The declined request is terminal, so a fresh provider proposal can be accepted.
    await restoreCookies(page, journey.clubCookies);
    dialog = await openProviderBooking(page, journey);
    await dialog.getByRole('button', { name: 'Propose a new time', exact: true }).click();
    await dialog.getByLabel('Propose a new time', { exact: true }).fill(futureSingaporeDate());
    await dialog.getByLabel('New lesson time', { exact: true }).selectOption(journey.proposedStartAt);
    await dialog.getByLabel('Message to the student', { exact: false }).fill('Final proposal for acceptance.');
    await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
    await expect(dialog.getByText('Waiting for the student to reply', { exact: true })).toBeVisible();

    await switchToUser(page, journey.studentEmail);
    dialog = await openStudentBooking(page, journey);
    const finalIncoming = dialog.getByRole('region', { name: 'Proposed new time' });
    const studentAcceptResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/accept'),
    );
    await finalIncoming.getByRole('button', { name: 'Accept new time', exact: true }).click();
    expect((await studentAcceptResponse).status()).toBe(200);
    const acceptNotice = dialog.getByRole('status').filter({ hasText: 'The new time is confirmed.' });
    await expect(acceptNotice).toBeVisible();
    await expect(acceptNotice).toBeFocused();
    await expect(dialog).toContainText(displayedTime(journey.proposedStartAt));
    const accepted = await accountBooking(page, journey.participantId);
    expect(accepted.booking.startAt).toBe(journey.proposedStartAt);
    expect(accepted.rescheduleRequest).toBeNull();
  });

  test('an incoming provider proposal closes at the original lesson end while decline remains available', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const journey = await createJourney(page, testInfo.project.name, 'ended-provider-proposal');
    const proposalMessage = 'Please review this alternative time.';
    await responseJson(await page.request.post(`/api/bookings/${journey.bookingId}/reschedule-requests`, {
      data: { startAt: journey.proposedStartAt, message: proposalMessage },
    }));

    await switchToUser(page, journey.studentEmail);
    const originalEnd = new Date(journey.originalStartAt).getTime() + 60 * 60_000;
    await page.clock.install({ time: new Date(originalEnd - 1_000) });

    const dialog = await openStudentBooking(page, journey);
    const incoming = dialog.getByRole('region', { name: 'Proposed new time' });
    await expect(incoming.getByRole('heading', { name: 'A new time was proposed', exact: true })).toBeVisible();
    await expect(incoming.getByRole('button', { name: 'Accept new time', exact: true })).toBeVisible();
    await expect(incoming.getByRole('button', { name: 'Keep original time', exact: true })).toBeVisible();

    await page.clock.runFor(1_050);

    await expect(incoming.getByRole('heading', { name: 'Reschedule request needs closing', exact: true })).toBeVisible();
    await expect(incoming).toContainText(
      'The original lesson has ended, so this proposal can no longer be accepted. Keep the original time to close it.',
    );
    await expect(incoming.getByRole('button', { name: 'Accept new time', exact: true })).toHaveCount(0);
    await expect(incoming.getByRole('button', { name: 'Keep original time', exact: true })).toBeVisible();

    const declineResponse = page.waitForResponse(response =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/decline'),
    );
    await incoming.getByRole('button', { name: 'Keep original time', exact: true }).click();
    expect((await declineResponse).status()).toBe(200);
    const declineNotice = dialog.getByRole('status').filter({ hasText: 'The session keeps its original time.' });
    await expect(declineNotice).toBeVisible();
    await expect(declineNotice).toBeFocused();
    const unchanged = await accountBooking(page, journey.participantId);
    expect(unchanged.booking.startAt).toBe(journey.originalStartAt);
    expect(unchanged.rescheduleRequest).toBeNull();
  });
});
