import { expect, test } from '@playwright/test';
import type { ManagerWorkspace } from '../src/lib/types';

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.title.includes('switches actions when the lesson end passes')) {
    await page.clock.install({ time: new Date('2026-09-19T00:00:00.000Z') });
  }
  const demo = await page.request.post('/api/auth/demo', { data: {} });
  expect(demo.ok()).toBeTruthy();
});

test('provider records attendance and notes before completing an ended session', async ({ page }) => {
  const workspaceResponse = await page.request.get('/api/workspace');
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json() as ManagerWorkspace;
  const source = workspace.bookings.find(booking => booking.participants.length > 0);
  expect(source).toBeTruthy();
  if (!source) throw new Error('Demo workspace needs a booking with a participant');

  const serviceName = 'Provider lifecycle check';
  const endAt = new Date(Date.now() - 30 * 60_000).toISOString();
  let booking: ManagerWorkspace['bookings'][number] = {
    ...source,
    serviceName,
    startAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    endAt,
    status: 'CONFIRMED',
    coachAcceptance: 'NOT_REQUIRED',
    notes: '',
    participants: source.participants.map(participant => ({
      ...participant,
      attendance: 'UNMARKED',
    })),
  };
  const participant = booking.participants[0];
  const futureBooking: ManagerWorkspace['bookings'][number] = {
    ...source,
    id: `${source.id}-future`,
    serviceName: 'Future completion guard',
    startAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    endAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    status: 'CONFIRMED',
    coachAcceptance: 'NOT_REQUIRED',
  };

  await page.route('**/api/workspace', route => route.fulfill({
    json: {
      ...workspace,
      bookings: [
        ...workspace.bookings.map(candidate => candidate.id === booking.id ? booking : candidate),
        futureBooking,
      ],
    },
  }));
  await page.route(`**/api/bookings/${booking.id}/participants/${participant.id}`, async route => {
    const values = route.request().postDataJSON() as { attendance: 'PRESENT' | 'ABSENT' };
    booking = {
      ...booking,
      participants: booking.participants.map(candidate =>
        candidate.id === participant.id ? { ...candidate, attendance: values.attendance } : candidate,
      ),
    };
    await route.fulfill({ json: booking.participants.find(candidate => candidate.id === participant.id) });
  });
  await page.route(`**/api/bookings/${booking.id}`, async route => {
    const values = route.request().postDataJSON() as { notes?: string; status?: 'COMPLETED' };
    booking = { ...booking, ...values };
    await route.fulfill({ json: booking });
  });

  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
  const bookingRow = page.getByRole('row').filter({ hasText: serviceName });
  await expect(bookingRow).toContainText('Confirmed');
  await bookingRow.getByRole('button', { name: /Open booking details/ }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: serviceName, exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Mark completed', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Propose a new time', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Cancel class', exact: true })).toHaveCount(0);

  const attendanceRequest = page.waitForRequest(request =>
    request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/bookings/${booking.id}/participants/${participant.id}`,
  );
  await dialog.getByRole('button', { name: 'Attended', exact: true }).click();
  expect((await attendanceRequest).postDataJSON()).toEqual({ attendance: 'PRESENT' });
  await expect(dialog.getByRole('button', { name: 'Attended', exact: true })).toHaveClass(/bg-\[#214e3e\]/);

  const notes = 'Strong footwork and consistent recovery between shots.';
  await dialog.getByLabel('Internal class notes', { exact: true }).fill(notes);
  const notesRequest = page.waitForRequest(request =>
    request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/bookings/${booking.id}`,
  );
  await dialog.getByRole('button', { name: 'Save notes', exact: true }).click();
  expect((await notesRequest).postDataJSON()).toEqual({ notes });

  const completionRequest = page.waitForRequest(request =>
    request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/bookings/${booking.id}`
      && request.postDataJSON().status === 'COMPLETED',
  );
  await dialog.getByRole('button', { name: 'Mark completed', exact: true }).click();
  expect((await completionRequest).postDataJSON()).toEqual({ status: 'COMPLETED' });
  await expect(page.getByText('Class marked completed', { exact: true })).toBeVisible();
  await expect(dialog.getByText('completed', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Mark completed', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Internal class notes', { exact: true })).toHaveValue(notes);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);

  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  const futureRow = page.getByRole('row').filter({ hasText: futureBooking.serviceName });
  await futureRow.getByRole('button', { name: /Open booking details/ }).click();
  await expect(dialog.getByRole('heading', { name: futureBooking.serviceName, exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Mark completed', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Propose a new time', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel class', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Attended', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'No-show', exact: true })).toHaveCount(0);
});

test('an open provider booking switches actions when the lesson end passes', async ({ page }) => {
  const clockStart = new Date('2026-09-19T00:00:00.000Z');
  const workspaceResponse = await page.request.get('/api/workspace');
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json() as ManagerWorkspace;
  const source = workspace.bookings.find(booking => booking.participants.length > 0);
  expect(source).toBeTruthy();
  if (!source) throw new Error('Demo workspace needs a booking with a participant');

  const boundaryBooking: ManagerWorkspace['bookings'][number] = {
    ...source,
    id: `${source.id}-end-boundary`,
    serviceName: 'Live lesson end boundary',
    startAt: new Date(clockStart.getTime() - 30 * 60_000).toISOString(),
    endAt: new Date(clockStart.getTime() + 60_000).toISOString(),
    status: 'CONFIRMED',
    coachAcceptance: 'NOT_REQUIRED',
    participants: source.participants.map(participant => ({
      ...participant,
      id: `${participant.id}-end-boundary`,
      attendance: 'UNMARKED',
    })),
  };
  await page.route('**/api/workspace', route => route.fulfill({
    json: { ...workspace, bookings: [...workspace.bookings, boundaryBooking] },
  }));

  await page.goto('/?tab=explore&view=bookings');
  const bookingRow = page.getByRole('row').filter({ hasText: boundaryBooking.serviceName });
  await bookingRow.getByRole('button', { name: /Open booking details/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: boundaryBooking.serviceName, exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Propose a new time', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel class', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Attended', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'No-show', exact: true })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Propose a new time', exact: true }).click();
  await expect(dialog.getByLabel('New class time')).toBeVisible();
  await page.clock.runFor(60_050);

  await expect(dialog.getByLabel('New class time')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Propose a new time', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Cancel class', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Mark completed', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Attended', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'No-show', exact: true })).toBeVisible();
});

test('an ended lesson keeps pending reschedule cleanup available without reopening schedule actions', async ({ page }) => {
  const workspaceResponse = await page.request.get('/api/workspace');
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json() as ManagerWorkspace;
  const source = workspace.bookings.find(booking => booking.participants.length > 0);
  expect(source).toBeTruthy();
  if (!source) throw new Error('Demo workspace needs a booking with a participant');

  const now = Date.now();
  const endedBooking = (suffix: string, serviceName: string): ManagerWorkspace['bookings'][number] => ({
    ...source,
    id: `${source.id}-${suffix}`,
    serviceName,
    startAt: new Date(now - 90 * 60_000).toISOString(),
    endAt: new Date(now - 30 * 60_000).toISOString(),
    status: 'CONFIRMED',
    coachAcceptance: 'NOT_REQUIRED',
    participants: source.participants.map(participant => ({
      ...participant,
      id: `${participant.id}-${suffix}`,
      attendance: 'UNMARKED',
    })),
  });
  const incomingBooking = endedBooking('incoming-reschedule', 'Ended lesson with student request');
  const outgoingBooking = endedBooking('outgoing-reschedule', 'Ended lesson with provider request');
  const pendingRequest = (
    booking: ManagerWorkspace['bookings'][number],
    suffix: string,
    requestedByRole: 'STUDENT' | 'CLUB',
  ): ManagerWorkspace['rescheduleRequests'][number] => ({
    id: `pending-${suffix}`,
    bookingId: booking.id,
    participantId: requestedByRole === 'STUDENT' ? booking.participants[0].id : null,
    requestedByRole,
    requestedByUserId: requestedByRole === 'CLUB' ? workspace.user.id : null,
    proposedStartAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    proposedEndAt: new Date(now + 25 * 60 * 60_000).toISOString(),
    originalStartAt: booking.startAt,
    message: requestedByRole === 'STUDENT' ? 'Could we use tomorrow instead?' : 'The court is unavailable today.',
    status: 'PENDING',
    respondedAt: null,
    responseMessage: '',
    createdAt: new Date(now - 2 * 60 * 60_000).toISOString(),
    serviceName: booking.serviceName,
    instructorName: booking.instructorName,
    locationName: booking.locationName,
    businessName: workspace.business.name,
    timezone: workspace.business.timezone,
  });
  const incomingRequest = pendingRequest(incomingBooking, 'incoming', 'STUDENT');
  const outgoingRequest = pendingRequest(outgoingBooking, 'outgoing', 'CLUB');
  let requests = [...workspace.rescheduleRequests, incomingRequest, outgoingRequest];

  await page.route('**/api/workspace', route => route.fulfill({
    json: {
      ...workspace,
      bookings: [...workspace.bookings, incomingBooking, outgoingBooking],
      rescheduleRequests: requests,
    },
  }));
  await page.route(`**/api/reschedule-requests/${incomingRequest.id}/decline`, async route => {
    requests = requests.map(request => request.id === incomingRequest.id
      ? { ...request, status: 'DECLINED' as const, respondedAt: new Date().toISOString() }
      : request);
    await route.fulfill({ json: requests.find(request => request.id === incomingRequest.id) });
  });
  await page.route(`**/api/reschedule-requests/${outgoingRequest.id}/withdraw`, async route => {
    requests = requests.map(request => request.id === outgoingRequest.id
      ? { ...request, status: 'WITHDRAWN' as const, respondedAt: new Date().toISOString() }
      : request);
    await route.fulfill({ json: requests.find(request => request.id === outgoingRequest.id) });
  });

  await page.goto('/?tab=explore&view=bookings');
  const dialog = page.getByRole('dialog');
  const incomingRow = page.getByRole('row').filter({ hasText: incomingBooking.serviceName });
  await incomingRow.getByRole('button', { name: /Open booking details/ }).click();

  let requestRegion = dialog.getByRole('region', { name: 'Pending reschedule request' });
  await expect(requestRegion).toContainText('Reschedule request needs closing');
  await expect(requestRegion).toContainText('The original class has ended, so this proposal can no longer be accepted. Decline the request to close it.');
  await expect(requestRegion.getByRole('button', { name: 'Accept new time', exact: true })).toHaveCount(0);
  await expect(requestRegion.getByRole('button', { name: 'Decline', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Propose a new time', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Cancel class', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Mark completed', exact: true })).toBeVisible();

  const declineRequest = page.waitForRequest(request =>
    request.method() === 'POST'
      && new URL(request.url()).pathname === `/api/reschedule-requests/${incomingRequest.id}/decline`,
  );
  await requestRegion.getByRole('button', { name: 'Decline', exact: true }).click();
  expect((await declineRequest).postDataJSON()).toEqual({ message: '' });
  await expect(page.getByText('Request declined', { exact: true })).toBeVisible();
  await expect(requestRegion).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  const outgoingRow = page.getByRole('row').filter({ hasText: outgoingBooking.serviceName });
  await outgoingRow.getByRole('button', { name: /Open booking details/ }).click();
  requestRegion = dialog.getByRole('region', { name: 'Pending reschedule request' });
  await expect(requestRegion).toContainText('The original class has ended, so this proposal can no longer be accepted. Withdraw the request to close it.');
  await expect(requestRegion.getByRole('button', { name: 'Accept new time', exact: true })).toHaveCount(0);
  await expect(requestRegion.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
  await expect(requestRegion.getByRole('button', { name: 'Withdraw request', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Propose a new time', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Cancel class', exact: true })).toHaveCount(0);

  const withdrawRequest = page.waitForRequest(request =>
    request.method() === 'POST'
      && new URL(request.url()).pathname === `/api/reschedule-requests/${outgoingRequest.id}/withdraw`,
  );
  await requestRegion.getByRole('button', { name: 'Withdraw request', exact: true }).click();
  expect((await withdrawRequest).postDataJSON()).toEqual({});
  await expect(page.getByText('Request withdrawn', { exact: true })).toBeVisible();
  await expect(requestRegion).toHaveCount(0);
});

test('provider reschedule controls require the exact provider role that raised the request', async ({ page }) => {
  const workspaceResponse = await page.request.get('/api/workspace');
  expect(workspaceResponse.ok()).toBeTruthy();
  const workspace = await workspaceResponse.json() as ManagerWorkspace;
  const source = workspace.bookings.find(booking => booking.participants.length > 0);
  expect(source).toBeTruthy();
  if (!source) throw new Error('Demo workspace needs a booking with a participant');

  const now = Date.now();
  const fixtureBooking = (suffix: string, serviceName: string, ended: boolean): ManagerWorkspace['bookings'][number] => ({
    ...source,
    id: `${source.id}-${suffix}`,
    serviceName,
    startAt: new Date(now + (ended ? -90 : 60) * 60_000).toISOString(),
    endAt: new Date(now + (ended ? -30 : 120) * 60_000).toISOString(),
    status: 'CONFIRMED',
    coachAcceptance: 'NOT_REQUIRED',
    participants: source.participants.map(participant => ({
      ...participant,
      id: `${participant.id}-${suffix}`,
    })),
  });
  const coachBooking = fixtureBooking('coach-owned-request', 'Coach-owned reschedule request', false);
  const clubBooking = fixtureBooking('club-owned-request', 'Club-owned ended reschedule request', true);
  const fixtureRequest = (
    booking: ManagerWorkspace['bookings'][number],
    suffix: string,
    requestedByRole: 'COACH' | 'CLUB',
  ): ManagerWorkspace['rescheduleRequests'][number] => ({
    id: `provider-role-request-${suffix}`,
    bookingId: booking.id,
    participantId: null,
    requestedByRole,
    requestedByUserId: `requester-${requestedByRole.toLowerCase()}`,
    proposedStartAt: new Date(now + 24 * 60 * 60_000).toISOString(),
    proposedEndAt: new Date(now + 25 * 60 * 60_000).toISOString(),
    originalStartAt: booking.startAt,
    message: `${requestedByRole === 'COACH' ? 'Coach' : 'Club'} proposal`,
    status: 'PENDING',
    respondedAt: null,
    responseMessage: '',
    createdAt: new Date(now - 60 * 60_000).toISOString(),
    serviceName: booking.serviceName,
    instructorName: booking.instructorName,
    locationName: booking.locationName,
    businessName: workspace.business.name,
    timezone: workspace.business.timezone,
  });
  const coachRequest = fixtureRequest(coachBooking, 'coach', 'COACH');
  const clubRequest = fixtureRequest(clubBooking, 'club', 'CLUB');
  let viewerRole: 'CLUB' | 'COACH' = 'CLUB';

  await page.route('**/api/workspace', route => route.fulfill({
    json: {
      ...workspace,
      user: {
        ...workspace.user,
        accountType: viewerRole,
        instructorId: viewerRole === 'COACH' ? source.instructorId : null,
      },
      membership: {
        ...workspace.membership,
        instructorId: viewerRole === 'COACH' ? source.instructorId : null,
      },
      clubAccount: viewerRole === 'CLUB',
      bookings: [...workspace.bookings, coachBooking, clubBooking],
      rescheduleRequests: [...workspace.rescheduleRequests, coachRequest, clubRequest],
    },
  }));

  await page.goto('/?tab=explore&view=bookings');
  const dialog = page.getByRole('dialog');
  const coachRequestRow = page.getByRole('row').filter({ hasText: coachBooking.serviceName });
  await coachRequestRow.getByRole('button', { name: /Open booking details/ }).click();

  let requestRegion = dialog.getByRole('region', { name: 'Pending reschedule request' });
  await expect(requestRegion).toContainText('The coach proposed a new time');
  await expect(requestRegion).toContainText('The class keeps its current time until the student replies. Only the coach account that raised it can withdraw the request.');
  await expect(requestRegion.getByRole('button', { name: 'Withdraw request', exact: true })).toHaveCount(0);
  await expect(requestRegion.getByRole('button', { name: 'Accept new time', exact: true })).toHaveCount(0);
  await expect(requestRegion.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);

  viewerRole = 'COACH';
  await page.reload();
  const clubRequestRow = page.getByRole('row').filter({ hasText: clubBooking.serviceName });
  await clubRequestRow.getByRole('button', { name: /Open booking details/ }).click();

  requestRegion = dialog.getByRole('region', { name: 'Pending reschedule request' });
  await expect(requestRegion).toContainText('Reschedule request needs closing');
  await expect(requestRegion).toContainText('The original class has ended, so this proposal can no longer be accepted. Only the club account that raised it can withdraw the request.');
  await expect(requestRegion.getByRole('button', { name: 'Withdraw request', exact: true })).toHaveCount(0);
  await expect(requestRegion.getByRole('button', { name: 'Accept new time', exact: true })).toHaveCount(0);
  await expect(requestRegion.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
});
