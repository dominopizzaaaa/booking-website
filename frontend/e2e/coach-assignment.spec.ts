import { expect, test, type APIResponse, type Page } from '@playwright/test';
import type { CoachScopedBooking, ManagerWorkspace, Payment } from '../src/lib/types';

const password = 'TestingOnly!2026';

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function uniqueValue(prefix: string, projectName: string) {
  return `${prefix}-${projectId(projectName)}-${Date.now()}`;
}

function futureSingaporeDate(days = 10) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

async function responseJson<T>(response: APIResponse): Promise<T> {
  const body = await response.json() as T;
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function logout(page: Page) {
  await responseJson(await page.request.post('/api/auth/logout', { data: {} }));
}

test('a coach accepts a lesson assigned by the club from the booking dialog', async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  const runId = uniqueValue('assignment', testInfo.project.name);
  const coachName = `Assignment Coach ${projectId(testInfo.project.name)}`;
  const studentName = `Assignment Student ${projectId(testInfo.project.name)}`;
  const coachEmail = `${runId}-coach@example.test`;
  const studentEmail = `${runId}-student@example.test`;
  const serviceName = `Coach acceptance ${runId}`;
  const locationName = `Assignment court ${runId}`;

  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'COACH', name: coachName, email: coachEmail, password },
  }));
  await logout(page);
  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: studentName, email: studentEmail, password },
  }));
  await logout(page);

  // A fresh demo gives this journey an isolated club without spending another
  // shared auth-rate-limit slot on a third registration. Everything relevant
  // to the assignment is still created explicitly below.
  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));
  const clubWorkspace = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));

  const affiliation = await responseJson<{ instructorId: string | null }>(await page.request.post('/api/staff', {
    data: { email: coachEmail },
  }));
  expect(affiliation.instructorId).toBeTruthy();
  const instructorId = affiliation.instructorId!;

  const student = await responseJson<{ id: string }>(await page.request.post('/api/students', {
    data: { email: studentEmail, notes: 'Created for the coach-assignment journey.' },
  }));
  const location = await responseJson<{ id: string }>(await page.request.post('/api/locations', {
    data: { name: locationName, address: '1 Assignment Way', type: 'FACILITY', requiresApproval: false },
  }));
  const service = await responseJson<{ id: string }>(await page.request.post('/api/services', {
    data: {
      name: serviceName,
      description: 'A private lesson used to verify coach acceptance.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: 9_000,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{ locationId: location.id, price: 9_000, duration: 60, instructorIds: [instructorId] }],
    },
  }));

  const date = futureSingaporeDate();
  const startAt = `${date}T10:00:00+08:00`;
  const dayOfWeek = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  await responseJson(await page.request.post('/api/availability', {
    data: { instructorId, locationId: location.id, dayOfWeek, startTime: '09:00', endTime: '12:00' },
  }));

  const created = await responseJson<{ bookings: Array<{ id: string; status: string; coachAcceptance: string; createdByRole: string }> }>(
    await page.request.post('/api/bookings', {
      data: {
        serviceId: service.id,
        instructorId,
        locationId: location.id,
        startAt,
        studentId: student.id,
        repeatWeeks: 1,
        notes: 'Club-assigned lesson.',
        address: '',
      },
    }),
  );
  expect(created.bookings).toHaveLength(1);
  const booking = created.bookings[0];
  expect(booking).toMatchObject({
    status: 'PENDING',
    coachAcceptance: 'PENDING',
    createdByRole: 'CLUB',
  });

  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
  await page.getByRole('button', {
    name: `Open booking details for ${serviceName} with ${studentName}`,
    exact: true,
  }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: serviceName, exact: true })).toBeVisible();
  await expect(dialog.getByText('Awaiting coach', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Accept lesson', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  // A club payout is its own ledger party: it belongs to the coach, not to an
  // arbitrary student whose lesson happened to fund the club. Exercise the
  // responsive dialog and assert that contract directly from its response.
  await page.goto('/?tab=explore&view=payments');
  await expect(page.locator('main').getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Record coach payout', exact: true }).click();
  const payoutDialog = page.getByRole('dialog');
  await expect(payoutDialog.getByRole('heading', { name: 'Record a coach payout', exact: true })).toBeVisible();
  await payoutDialog.getByLabel('Coach', { exact: true }).selectOption(instructorId);
  await payoutDialog.locator('input[name=\"amount\"]').fill('125.50');
  await payoutDialog.locator('textarea[name=\"note\"]').fill('Assignment journey payout');
  const payoutResponse = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/payouts',
  );
  await payoutDialog.getByRole('button', { name: 'Record payout', exact: true }).click();
  const payoutResult = await payoutResponse;
  expect(payoutResult.ok(), await payoutResult.text()).toBeTruthy();
  const payout = await payoutResult.json() as Payment;
  expect(payout).toMatchObject({
    kind: 'CLUB_TO_COACH',
    studentId: null,
    studentName: null,
    instructorId,
    instructorName: coachName,
    amount: 12_550,
    note: 'Assignment journey payout',
  });
  await expect(payoutDialog).toHaveCount(0);
  const paymentRecords = page.getByRole('region', { name: 'Payment records' });
  await expect(paymentRecords).toContainText(coachName);
  await expect(paymentRecords).toContainText('Coach payout');
  await expect(paymentRecords).toContainText('Assignment journey payout');
  await expect(page.getByText('Coach payout recorded', { exact: true })).toBeVisible();

  await logout(page);
  await responseJson(await page.request.post('/api/auth/login', {
    data: { email: coachEmail, password },
  }));

  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
  await page.getByRole('button', {
    name: `Open booking details for ${serviceName} with ${studentName}`,
    exact: true,
  }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByText('The club assigned this lesson. The student does not need to accept it, but the coach does before it is confirmed.')).toBeVisible();

  const acceptanceResponse = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/bookings/${booking.id}/accept`,
  );
  await dialog.getByRole('button', { name: 'Accept lesson', exact: true }).click();
  const acceptance = await acceptanceResponse;
  expect(acceptance.ok(), await acceptance.text()).toBeTruthy();
  const accepted = await acceptance.json() as CoachScopedBooking;
  expect(accepted).toMatchObject({ id: booking.id, status: 'CONFIRMED', coachAcceptance: 'ACCEPTED' });
  expect(accepted).not.toHaveProperty('price');
  expect(accepted.participants[0]).not.toHaveProperty('paid');
  expect(accepted.participants[0]).not.toHaveProperty('price');
  expect(accepted.participants[0]).not.toHaveProperty('packageId');

  await expect(dialog.getByText('Awaiting coach', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Accept lesson', exact: true })).toHaveCount(0);
  await expect(dialog.getByText('confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('Lesson accepted', { exact: true })).toBeVisible();

  const coachWorkspace = await responseJson<{ bookings: CoachScopedBooking[] }>(await page.request.get('/api/workspace'));
  expect(coachWorkspace.bookings.find(candidate => candidate.id === booking.id)).toMatchObject({
    status: 'CONFIRMED',
    coachAcceptance: 'ACCEPTED',
  });
  expect(clubWorkspace.business.kind).toBe('CLUB');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
