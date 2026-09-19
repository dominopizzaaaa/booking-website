import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';
import type { AuthSession, Booking, LessonPackage, ManagerWorkspace, Payment, Slot } from '../src/lib/types';

const password = 'TestingOnly!2026';
const timezone = 'Asia/Singapore';
const lessonPrice = 12_345;

type ProviderJourney = {
  businessSlug: string;
  instructorId: string;
  locationId: string;
  serviceId: string;
  serviceName: string;
  studentId: string;
  studentName: string;
  date: string;
  expectedBooking: Pick<Booking, 'status' | 'coachAcceptance' | 'createdByRole' | 'paymentRoute'>;
  venueApproval: boolean;
};

const apiContexts: APIRequestContext[] = [];

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function uniqueValue(prefix: string, projectName: string) {
  return `${prefix}-${projectId(projectName)}-${Date.now()}`;
}

function futureSingaporeDate(days = 45) {
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

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en-SG', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(value)).toUpperCase();
}

async function responseJson<T>(response: APIResponse | Response): Promise<T> {
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* Keep a non-JSON server error readable. */ }
  expect(response.ok(), typeof body === 'string' ? body : JSON.stringify(body)).toBeTruthy();
  return body as T;
}

async function isolatedApiContext(baseURL: string) {
  const context = await playwrightRequest.newContext({ baseURL });
  apiContexts.push(context);
  return context;
}

async function expectNoHorizontalOverflow(page: Page, dialog?: Locator) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
  if (!dialog) return;
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
}

async function openProviderBooking(page: Page, serviceName: string, studentName: string) {
  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
  await page.getByRole('button', {
    name: `Open booking details for ${serviceName} with ${studentName}`,
    exact: true,
  }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: serviceName, exact: true })).toBeVisible();
  return dialog;
}

async function createBookingThroughProviderUi(page: Page, journey: ProviderJourney) {
  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
  const mobileNavigation = page.getByRole('navigation', { name: 'Mobile navigation' });
  if (await mobileNavigation.isVisible()) {
    await mobileNavigation.getByRole('button', { name: 'Create', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create' });
    await expect(createDialog).toBeVisible();
    await createDialog.getByRole('button', { name: /^New booking\b/ }).click();
  } else {
    await page.locator('main').getByRole('button', { name: 'New booking', exact: true }).click();
  }

  const dialog = page.getByRole('dialog', { name: 'Add a booking' });
  await expect(dialog).toBeVisible();
  await expectNoHorizontalOverflow(page, dialog);
  await dialog.getByLabel('Service', { exact: true }).selectOption(journey.serviceId);
  await expect(dialog.getByLabel('Location', { exact: true })).toHaveValue(journey.locationId);
  await dialog.getByLabel('Location', { exact: true }).selectOption(journey.locationId);
  await expect(dialog.getByLabel('Instructor', { exact: true })).toHaveValue(journey.instructorId);
  await dialog.getByLabel('Instructor', { exact: true }).selectOption(journey.instructorId);

  const slotResponsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'GET'
      && url.pathname === `/api/public/${journey.businessSlug}/slots`
      && url.searchParams.get('serviceId') === journey.serviceId
      && url.searchParams.get('locationId') === journey.locationId
      && url.searchParams.get('instructorId') === journey.instructorId
      && url.searchParams.get('date') === journey.date;
  });
  await dialog.getByLabel('Date', { exact: true }).fill(journey.date);
  const slots = await responseJson<{ slots: Slot[] }>(await slotResponsePromise);
  const available = slots.slots.find(slot => slot.available);
  expect(available).toBeTruthy();
  if (!available) throw new Error('The isolated provider journey needs an available slot');

  await dialog.getByRole('button', { name: formatTime(available.startAt), exact: true }).click();
  await dialog.getByLabel('Registered student', { exact: true }).selectOption(journey.studentId);
  const notes = `Created from the provider booking form for ${journey.serviceName}.`;
  await dialog.getByLabel('Internal lesson notes (optional)', { exact: true }).fill(notes);
  const venueNotice = dialog.getByText(
    'This lesson will be pending venue confirmation. Scheduling does not reserve an external court or room.',
    { exact: true },
  );
  if (journey.venueApproval) await expect(venueNotice).toBeVisible();
  else await expect(venueNotice).toHaveCount(0);

  const createResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/bookings',
  );
  await dialog.getByRole('button', { name: 'Add booking', exact: true }).click();
  const createResponse = await createResponsePromise;
  const result = await responseJson<{ bookings: Booking[] }>(createResponse);
  expect(createResponse.request().postDataJSON()).toEqual({
    serviceId: journey.serviceId,
    locationId: journey.locationId,
    instructorId: journey.instructorId,
    startAt: available.startAt,
    studentId: journey.studentId,
    repeatWeeks: 1,
    notes,
    address: '',
  });
  expect(result.bookings).toHaveLength(1);
  expect(result.bookings[0]).toMatchObject({
    serviceName: journey.serviceName,
    ...journey.expectedBooking,
    notes,
    participants: [{ studentId: journey.studentId, name: journey.studentName, paid: false }],
  });
  await expect(page.getByText('Booking added to your schedule', { exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', {
    name: `Open booking details for ${journey.serviceName} with ${journey.studentName}`,
    exact: true,
  })).toBeVisible();
  return result.bookings[0];
}

test.afterEach(async () => {
  await Promise.all(apiContexts.splice(0).map(context => context.dispose()));
});

test('a club creates a booking and completes its venue, receipt, reversal, and cancellation actions', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const baseURL = String(testInfo.project.use.baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000');
  const runId = uniqueValue('provider-actions', testInfo.project.name);
  const coachName = `Provider Coach ${projectId(testInfo.project.name)}`;
  const coachEmail = `${runId}-coach@example.test`;
  const studentName = `Provider Student ${projectId(testInfo.project.name)}`;
  const studentEmail = `${runId}-student@example.test`;
  const coachAccount = await isolatedApiContext(baseURL);
  const studentAccount = await isolatedApiContext(baseURL);
  await responseJson<AuthSession>(await coachAccount.post('/api/auth/register', {
    data: { accountType: 'COACH', name: coachName, email: coachEmail, password },
  }));
  await responseJson<AuthSession>(await studentAccount.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: studentName, email: studentEmail, password },
  }));

  await responseJson<AuthSession>(await page.request.post('/api/auth/demo', { data: {} }));
  const initial = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  const affiliation = await responseJson<{ instructorId: string | null }>(await page.request.post('/api/staff', {
    data: { email: coachEmail },
  }));
  expect(affiliation.instructorId).toBeTruthy();
  const instructorId = affiliation.instructorId!;
  const coachAuth = await responseJson<AuthSession>(await coachAccount.get('/api/auth/me'));
  const coachMembership = coachAuth.memberships.find(candidate => candidate.businessId === initial.business.id);
  expect(coachMembership).toBeTruthy();
  if (!coachMembership) throw new Error('The new coach needs the club affiliation');
  await responseJson<AuthSession>(await coachAccount.post('/api/auth/switch-workspace', {
    data: { membershipId: coachMembership.id },
  }));

  const student = await responseJson<{ id: string }>(await page.request.post('/api/students', {
    data: { email: studentEmail, notes: 'Linked for the provider-created booking journey.' },
  }));
  const location = await responseJson<{ id: string }>(await page.request.post('/api/locations', {
    data: {
      name: `Provider approval court ${runId}`,
      address: '18 Browser Journey Road',
      type: 'FACILITY',
      requiresApproval: true,
      travelMinutes: 0,
    },
  }));
  const serviceName = `Provider booking ${runId}`;
  const service = await responseJson<{ id: string }>(await page.request.post('/api/services', {
    data: {
      name: serviceName,
      description: 'A private lesson used to verify provider booking operations.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: lessonPrice,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{
        locationId: location.id,
        price: lessonPrice,
        duration: 60,
        instructorIds: [instructorId],
      }],
    },
  }));
  const date = futureSingaporeDate();
  await responseJson(await page.request.post('/api/availability', {
    data: {
      instructorId,
      locationId: location.id,
      dayOfWeek: dayOfWeek(date),
      startTime: '09:00',
      endTime: '13:00',
    },
  }));

  const journey: ProviderJourney = {
    businessSlug: initial.business.slug,
    instructorId,
    locationId: location.id,
    serviceId: service.id,
    serviceName,
    studentId: student.id,
    studentName,
    date,
    expectedBooking: {
      status: 'PENDING',
      coachAcceptance: 'PENDING',
      createdByRole: 'CLUB',
      paymentRoute: 'CLUB',
    },
    venueApproval: true,
  };
  const booking = await createBookingThroughProviderUi(page, journey);

  let dialog = await openProviderBooking(page, serviceName, studentName);
  await expect(dialog.getByText('Awaiting coach', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Paid through the club', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Venue secured · confirm', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  // Club-created work waits for the assigned coach first. The acceptance UI
  // has its own dedicated spec; settle that prerequisite through the API so
  // this journey can own the manager-only venue and financial actions.
  const accepted = await responseJson<{ status: string; coachAcceptance: string }>(
    await coachAccount.post(`/api/bookings/${booking.id}/accept`, { data: { message: '' } }),
  );
  expect(accepted).toMatchObject({ status: 'PENDING', coachAcceptance: 'ACCEPTED' });

  dialog = await openProviderBooking(page, serviceName, studentName);
  await expect(dialog.getByText('Venue pending', { exact: true })).toBeVisible();
  await expect(dialog.getByText(
    'Please secure the venue separately, then confirm this session. Courtly has not reserved the court.',
    { exact: true },
  )).toBeVisible();
  const confirmationResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/bookings/${booking.id}`,
  );
  await dialog.getByRole('button', { name: 'Venue secured · confirm', exact: true }).click();
  const confirmationResponse = await confirmationResponsePromise;
  expect(confirmationResponse.request().postDataJSON()).toEqual({ status: 'CONFIRMED' });
  expect(await responseJson<Booking>(confirmationResponse)).toMatchObject({
    id: booking.id, status: 'CONFIRMED', coachAcceptance: 'ACCEPTED', paymentRoute: 'CLUB',
  });
  await expect(dialog.getByText('confirmed', { exact: true })).toBeVisible();

  await dialog.getByLabel('Payment recording method', { exact: true }).selectOption('CASH');
  const paymentResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/payments',
  );
  await dialog.getByRole('button', { name: 'Record payment', exact: true }).click();
  const paymentResponse = await paymentResponsePromise;
  expect(paymentResponse.request().postDataJSON()).toEqual({
    studentId: student.id,
    bookingId: booking.id,
    amount: lessonPrice,
    method: 'CASH',
    note: 'Lesson payment',
  });
  const payment = await responseJson<Payment>(paymentResponse);
  expect(payment).toMatchObject({
    kind: 'STUDENT_TO_CLUB',
    studentId: student.id,
    instructorId: null,
    bookingId: booking.id,
    amount: lessonPrice,
    method: 'CASH',
    reversedAt: null,
  });
  await expect(page.getByText('Booking updated', { exact: true }).last()).toBeVisible();
  await expect(dialog.getByText('Paid', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Undo payment', exact: true })).toBeVisible();

  const reversalReason = `Provider detail correction ${projectId(testInfo.project.name)}`;
  const reversalResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === `/api/payments/${payment.id}`,
  );
  const promptPromise = page.waitForEvent('dialog');
  const undoClick = dialog.getByRole('button', { name: 'Undo payment', exact: true }).click();
  const prompt = await promptPromise;
  expect(prompt.type()).toBe('prompt');
  expect(prompt.message()).toBe('Reverse this payment? Say briefly why, for the ledger.');
  await prompt.accept(reversalReason);
  await undoClick;
  const reversalResponse = await reversalResponsePromise;
  expect(reversalResponse.request().postDataJSON()).toEqual({ reason: reversalReason });
  const reversal = await responseJson<{ ok: true; payment: Payment }>(reversalResponse);
  expect(reversal.payment).toMatchObject({
    id: payment.id,
    kind: 'STUDENT_TO_CLUB',
    reversedReason: reversalReason,
  });
  expect(reversal.payment.reversedAt).toBeTruthy();
  await expect(page.getByText('Payment reversed', { exact: true }).last()).toBeVisible();
  await expect(dialog.getByText('1 reversed payment(s) kept in the ledger.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page, dialog);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  // Cancellation refunds package credits, which cannot be exercised on the
  // pay-per-session booking above. A compact companion booking isolates that
  // second contract while keeping the destructive action in the browser.
  const refundServiceName = `Refund booking ${runId}`;
  const refundService = await responseJson<{ id: string }>(await page.request.post('/api/services', {
    data: {
      name: refundServiceName,
      description: 'A package lesson used to verify credit return on cancellation.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: 20_000,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'clay',
      active: true,
      locations: [{
        locationId: location.id,
        price: 20_000,
        duration: 60,
        instructorIds: [instructorId],
      }],
    },
  }));
  const pkg = await responseJson<LessonPackage>(await page.request.post('/api/packages', {
    data: {
      studentId: student.id,
      name: `Cancellation credits ${runId}`,
      serviceId: refundService.id,
      totalCredits: 2,
      price: 40_000,
      expiresAt: new Date(`${futureSingaporeDate(120)}T23:59:59+08:00`).toISOString(),
      paid: false,
    },
  }));
  const refundResult = await responseJson<{ bookings: Booking[] }>(await page.request.post('/api/bookings', {
    data: {
      serviceId: refundService.id,
      locationId: location.id,
      instructorId,
      startAt: `${date}T12:00:00+08:00`,
      studentId: student.id,
      packageId: pkg.id,
      repeatWeeks: 1,
      notes: 'Cancel this booking to return its package credit.',
      address: '',
    },
  }));
  const refundBooking = refundResult.bookings[0];
  expect(refundBooking.participants[0]).toMatchObject({ packageId: pkg.id });
  expect((await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace')))
    .packages.find(candidate => candidate.id === pkg.id)?.usedCredits).toBe(1);

  dialog = await openProviderBooking(page, refundServiceName, studentName);
  await expect(dialog.getByText('Package credit', { exact: true })).toBeVisible();
  const cancellationResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/bookings/${refundBooking.id}`,
  );
  const confirmationPromise = page.waitForEvent('dialog');
  const cancelClick = dialog.getByRole('button', { name: 'Cancel lesson', exact: true }).click();
  const cancellationPrompt = await confirmationPromise;
  expect(cancellationPrompt.type()).toBe('confirm');
  expect(cancellationPrompt.message()).toBe(
    'Cancel this lesson for all participants? Package credits will be returned. Other recurring lessons stay unchanged.',
  );
  await cancellationPrompt.accept();
  await cancelClick;
  const cancellationResponse = await cancellationResponsePromise;
  expect(cancellationResponse.request().postDataJSON()).toEqual({ status: 'CANCELLED' });
  expect(await responseJson<Booking>(cancellationResponse)).toMatchObject({
    id: refundBooking.id, status: 'CANCELLED',
  });
  await expect(dialog.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel lesson', exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, dialog);

  const finalClub = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  expect(finalClub.packages.find(candidate => candidate.id === pkg.id)?.usedCredits).toBe(0);
  expect(finalClub.bookings.find(candidate => candidate.id === refundBooking.id)?.status).toBe('CANCELLED');
  expect(finalClub.bookings.find(candidate => candidate.id === booking.id)?.participants[0].paid).toBe(false);
  expect(finalClub.payments.find(candidate => candidate.id === payment.id)).toMatchObject({
    kind: 'STUDENT_TO_CLUB',
    reversedReason: reversalReason,
  });
});

test('a coach creates and switches into a solo practice, then books and corrects a direct receipt', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const baseURL = String(testInfo.project.use.baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000');
  const runId = uniqueValue('solo-provider', testInfo.project.name);
  const coachName = `Solo Coach ${projectId(testInfo.project.name)}`;
  const coachEmail = `${runId}-coach@example.test`;
  const studentName = `Solo Student ${projectId(testInfo.project.name)}`;
  const studentEmail = `${runId}-student@example.test`;
  const practiceName = `Solo Practice ${runId}`;
  const studentAccount = await isolatedApiContext(baseURL);
  await responseJson<AuthSession>(await studentAccount.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: studentName, email: studentEmail, password },
  }));
  await responseJson<AuthSession>(await page.request.post('/api/auth/register', {
    data: { accountType: 'COACH', name: coachName, email: coachEmail, password },
  }));

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: `Welcome, ${coachName}.`, exact: true })).toBeVisible();
  await page.getByLabel('Name your practice', { exact: true }).fill(practiceName);
  const practiceResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/auth/practice',
  );
  await page.getByRole('button', { name: 'Create practice', exact: true }).click();
  const practiceResponse = await practiceResponsePromise;
  expect(practiceResponse.request().postDataJSON()).toEqual({ name: practiceName });
  const practiceAuth = await responseJson<AuthSession>(practiceResponse);
  expect(practiceAuth).toMatchObject({
    user: { accountType: 'COACH' },
    business: { name: practiceName, kind: 'SOLO' },
  });
  expect(practiceAuth.membership).toBeTruthy();
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();

  // Reopen the account switcher and select the same practice explicitly as
  // well as relying on the create endpoint's automatic selection. Clear the
  // active workspace first so the account-page button performs a real switch.
  await responseJson<AuthSession>(await page.request.post('/api/auth/switch-workspace', {
    data: { membershipId: null },
  }));
  await page.goto('/account');
  const workspaceSection = page.locator('section[aria-labelledby="account-workspaces-heading"]');
  const practiceOption = workspaceSection.getByRole('button').filter({ hasText: practiceName });
  await expect(practiceOption).toBeVisible();
  const switchResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/auth/switch-workspace',
  );
  await practiceOption.click();
  const switchResponse = await switchResponsePromise;
  expect(switchResponse.request().postDataJSON()).toEqual({ membershipId: practiceAuth.membership!.id });
  await responseJson<AuthSession>(switchResponse);
  await expect(page.getByRole('heading', { name: /Your day, in a good place/ })).toBeVisible();

  const initial = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  expect(initial).toMatchObject({
    business: { id: practiceAuth.business!.id, kind: 'SOLO' },
    user: { accountType: 'COACH' },
  });
  expect(initial.user.instructorId).toBeTruthy();
  const instructorId = initial.user.instructorId!;
  const student = await responseJson<{ id: string }>(await page.request.post('/api/students', {
    data: { email: studentEmail, notes: 'Linked directly to the coach practice.' },
  }));
  const location = await responseJson<{ id: string }>(await page.request.post('/api/locations', {
    data: {
      name: `Solo studio ${runId}`,
      address: '27 Direct Lesson Lane',
      type: 'FACILITY',
      requiresApproval: false,
      travelMinutes: 0,
    },
  }));
  const serviceName = `Direct coaching ${runId}`;
  const service = await responseJson<{ id: string }>(await page.request.post('/api/services', {
    data: {
      name: serviceName,
      description: 'A direct lesson used to verify the solo-practice money path.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: lessonPrice,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{
        locationId: location.id,
        price: lessonPrice,
        duration: 60,
        instructorIds: [instructorId],
      }],
    },
  }));
  const date = futureSingaporeDate(55);
  await responseJson(await page.request.post('/api/availability', {
    data: {
      instructorId,
      locationId: location.id,
      dayOfWeek: dayOfWeek(date),
      startTime: '09:00',
      endTime: '13:00',
    },
  }));

  const booking = await createBookingThroughProviderUi(page, {
    businessSlug: initial.business.slug,
    instructorId,
    locationId: location.id,
    serviceId: service.id,
    serviceName,
    studentId: student.id,
    studentName,
    date,
    expectedBooking: {
      status: 'CONFIRMED',
      coachAcceptance: 'NOT_REQUIRED',
      createdByRole: 'COACH',
      paymentRoute: 'DIRECT',
    },
    venueApproval: false,
  });

  const dialog = await openProviderBooking(page, serviceName, studentName);
  await expect(dialog.getByText('Paid to the coach', { exact: true })).toBeVisible();
  await expect(dialog.getByText('confirmed', { exact: true })).toBeVisible();
  await dialog.getByLabel('Payment recording method', { exact: true }).selectOption('OTHER');
  const paymentResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/payments',
  );
  await dialog.getByRole('button', { name: 'Record payment', exact: true }).click();
  const paymentResponse = await paymentResponsePromise;
  expect(paymentResponse.request().postDataJSON()).toEqual({
    studentId: student.id,
    bookingId: booking.id,
    amount: lessonPrice,
    method: 'OTHER',
    note: 'Lesson payment',
  });
  const payment = await responseJson<Payment>(paymentResponse);
  expect(payment).toMatchObject({
    kind: 'STUDENT_TO_COACH',
    studentId: student.id,
    instructorId: null,
    bookingId: booking.id,
    amount: lessonPrice,
    method: 'OTHER',
    reversedAt: null,
  });
  await expect(dialog.getByText('Paid', { exact: true })).toBeVisible();

  const reversalReason = `Correct direct receipt ${projectId(testInfo.project.name)}`;
  const reversalResponsePromise = page.waitForResponse(response =>
    response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === `/api/payments/${payment.id}`,
  );
  const promptPromise = page.waitForEvent('dialog');
  const undoClick = dialog.getByRole('button', { name: 'Undo payment', exact: true }).click();
  const prompt = await promptPromise;
  expect(prompt.type()).toBe('prompt');
  await prompt.accept(reversalReason);
  await undoClick;
  const reversalResponse = await reversalResponsePromise;
  expect(reversalResponse.request().postDataJSON()).toEqual({ reason: reversalReason });
  const reversal = await responseJson<{ ok: true; payment: Payment }>(reversalResponse);
  expect(reversal.payment).toMatchObject({
    id: payment.id,
    kind: 'STUDENT_TO_COACH',
    reversedReason: reversalReason,
  });
  expect(reversal.payment.reversedAt).toBeTruthy();
  await expect(page.getByText('Payment reversed', { exact: true }).last()).toBeVisible();
  await expect(dialog.getByText('1 reversed payment(s) kept in the ledger.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page, dialog);

  const finalSolo = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  expect(finalSolo.bookings.find(candidate => candidate.id === booking.id)).toMatchObject({
    paymentRoute: 'DIRECT',
    createdByRole: 'COACH',
    participants: [expect.objectContaining({ paid: false })],
  });
  expect(finalSolo.payments.find(candidate => candidate.id === payment.id)).toMatchObject({
    kind: 'STUDENT_TO_COACH',
    reversedReason: reversalReason,
  });
});
