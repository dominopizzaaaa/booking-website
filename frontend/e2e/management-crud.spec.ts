import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';
import type { Availability, AvailabilityException, ManagerWorkspace, RentalLocationSaveResult, Service, Student } from '../src/lib/types';

function projectId(projectName: string) {
  if (projectName === 'desktop-1440') return 'desktop';
  if (projectName === 'phone-390') return 'phone390';
  if (projectName === 'phone-393') return 'phone393';
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function futureSingaporeDate(days = 45) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

function localTime(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return new Intl.DateTimeFormat('en-SG', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2026, 0, 5, hour, minute)));
}

async function responseJson<T>(response: APIResponse | Response): Promise<T> {
  const body = await response.json() as T;
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function workspace(page: Page) {
  return responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )).toBe(false);
}

function catalogCard(page: Page, name: string) {
  return page.locator('main article').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

function mutationResponse(page: Page, method: string, pathname: string) {
  return page.waitForResponse(response =>
    response.request().method() === method && new URL(response.url()).pathname === pathname,
  );
}

// Package sale and club-coach visibility have dedicated end-to-end journeys in
// money-admin.spec.ts and booking.spec.ts. This journey owns the remaining
// manager mutations and keeps every write inside its fresh demo tenant.
test('club management mutations persist across the responsive workspace', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));
  const initial = await workspace(page);
  expect(initial).toMatchObject({
    clubAccount: true,
    business: { kind: 'CLUB', isDemo: true },
    user: { accountType: 'CLUB' },
  });
  const instructor = initial.instructors.find(candidate => candidate.active);
  const student = initial.students.find(candidate => candidate.userId);
  expect(instructor).toBeTruthy();
  expect(student).toBeTruthy();
  if (!instructor || !student) throw new Error('Demo club needs an active coach and linked student');

  const suffix = projectId(testInfo.project.name);
  const locationName = `E2E Court ${suffix}`;
  const editedLocationName = `E2E Studio ${suffix}`;
  const serviceName = `E2E Clinic ${suffix}`;
  const editedServiceName = `E2E Performance ${suffix}`;

  await page.goto('/?tab=explore&view=locations');
  await expect(page.locator('main').getByRole('heading', { name: 'Locations', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'Add location', exact: true }).click();

  let dialog = page.getByRole('dialog', { name: 'Add a location' });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="name"]').fill(locationName);
  await dialog.locator('#location-type').selectOption('RENTED');
  await dialog.locator('input[name="travelMinutes"]').fill('25');
  await dialog.locator('input[name="address"]').fill('10 Rally Road, Singapore');
  await dialog.locator('textarea[name="notes"]').fill('Check in at the east desk.');
  await dialog.locator('input[name="requiresApproval"]').check();
  await expectNoHorizontalOverflow(page);

  let responsePromise = page.waitForResponse(response =>
    response.request().method() === 'PUT'
      && new URL(response.url()).pathname.startsWith('/api/rental-locations/rental_loc_'),
  );
  await dialog.getByRole('button', { name: 'Save location', exact: true }).click();
  let response = await responsePromise;
  const locationResult = await responseJson<RentalLocationSaveResult>(response);
  const location = locationResult.location;
  expect(new URL(response.url()).pathname).toBe(`/api/rental-locations/${location.id}`);
  expect(response.request().postDataJSON()).toMatchObject({
    mode: 'CREATE',
    location: {
      name: locationName,
      address: '10 Rally Road, Singapore',
      type: 'RENTED',
      requiresApproval: true,
      travelMinutes: 25,
      notes: 'Check in at the east desk.',
      active: true,
      source: 'MANUAL',
    },
    rental: { enabled: false },
  });
  await expect(dialog).toHaveCount(0);
  await expect(catalogCard(page, locationName)).toContainText('Venue confirmation required');
  expect((await workspace(page)).locations.find(candidate => candidate.id === location.id)).toMatchObject({
    name: locationName,
    active: true,
    requiresApproval: true,
  });

  await catalogCard(page, locationName).getByRole('button', { name: 'Edit location', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit location' });
  await dialog.locator('input[name="name"]').fill(editedLocationName);
  await dialog.locator('#location-type').selectOption('FACILITY');
  await dialog.locator('input[name="travelMinutes"]').fill('15');
  await dialog.locator('input[name="address"]').fill('20 Practice Lane, Singapore');
  await dialog.locator('textarea[name="notes"]').fill('Use the side entrance after 6pm.');
  await dialog.locator('input[name="requiresApproval"]').uncheck();
  await expect(dialog.locator('input[name="active"]')).toBeChecked();

  responsePromise = mutationResponse(page, 'PUT', `/api/rental-locations/${location.id}`);
  await dialog.getByRole('button', { name: 'Save location', exact: true }).click();
  response = await responsePromise;
  await responseJson<RentalLocationSaveResult>(response);
  expect(response.request().postDataJSON()).toMatchObject({
    mode: 'UPDATE',
    location: {
      name: editedLocationName,
      address: '20 Practice Lane, Singapore',
      type: 'FACILITY',
      requiresApproval: false,
      travelMinutes: 15,
      notes: 'Use the side entrance after 6pm.',
      active: true,
    },
    rental: { enabled: false },
  });
  await expect(dialog).toHaveCount(0);
  await expect(catalogCard(page, editedLocationName)).toContainText('Use the side entrance after 6pm.');
  expect((await workspace(page)).locations.find(candidate => candidate.id === location.id)).toMatchObject({
    name: editedLocationName,
    address: '20 Practice Lane, Singapore',
    type: 'FACILITY',
    travelMinutes: 15,
    active: true,
  });
  await expectNoHorizontalOverflow(page);

  await page.goto('/?tab=explore&view=services');
  await expect(page.locator('main').getByRole('heading', { name: 'Classes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add class', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Create a class' });
  await dialog.locator('input[name="name"]').fill(serviceName);
  await dialog.locator('input[name="category"]').fill('Racket skills');
  await dialog.locator('#service-type').selectOption('GROUP');
  await dialog.locator('textarea[name="description"]').fill('A focused small-group coaching clinic.');
  await dialog.locator('input[name="price"]').fill('72.50');
  await dialog.locator('input[name="duration"]').fill('75');
  await dialog.locator('input[name="capacity"]').fill('5');
  await dialog.locator('input[name="bufferMinutes"]').fill('10');
  await dialog.locator('input[name="noticeHours"]').fill('4');
  const locationAssignment = dialog.locator('label').filter({ hasText: editedLocationName }).locator('input[type="checkbox"]');
  await locationAssignment.check();
  const assignmentPanel = locationAssignment.locator('../..');
  await assignmentPanel.locator('label').filter({ hasText: instructor.name }).locator('input[type="checkbox"]').check();
  await expectNoHorizontalOverflow(page);

  responsePromise = mutationResponse(page, 'POST', '/api/services');
  await dialog.getByRole('button', { name: 'Create class', exact: true }).click();
  response = await responsePromise;
  const service = await responseJson<Service>(response);
  expect(response.request().postDataJSON()).toMatchObject({
    name: serviceName,
    category: 'Racket skills',
    type: 'GROUP',
    duration: 75,
    price: 7_250,
    capacity: 5,
    bufferMinutes: 10,
    noticeHours: 4,
    active: true,
    locations: [{
      locationId: location.id,
      price: 7_250,
      duration: 75,
      instructorIds: [instructor.id],
    }],
  });
  await expect(dialog).toHaveCount(0);
  await expect(catalogCard(page, serviceName)).toContainText('Group · up to 5');
  expect((await workspace(page)).services.find(candidate => candidate.id === service.id)).toMatchObject({
    name: serviceName,
    price: 7_250,
    active: true,
    locations: [{ locationId: location.id, instructorIds: [instructor.id] }],
  });

  await catalogCard(page, serviceName).getByRole('button', { name: `Edit ${serviceName}`, exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit class' });
  await dialog.locator('input[name="name"]').fill(editedServiceName);
  await dialog.locator('input[name="category"]').fill('Performance');
  await dialog.locator('textarea[name="description"]').fill('An updated clinic for tactical match play.');
  await dialog.locator('input[name="price"]').fill('84.25');
  await dialog.locator('input[name="duration"]').fill('90');
  await dialog.locator('input[name="capacity"]').fill('6');
  await dialog.locator(`input[name="price-${location.id}"]`).fill('86.50');
  await dialog.locator(`input[name="duration-${location.id}"]`).fill('90');

  responsePromise = mutationResponse(page, 'PATCH', `/api/services/${service.id}`);
  await dialog.getByRole('button', { name: 'Save class', exact: true }).click();
  response = await responsePromise;
  await responseJson<Service>(response);
  expect(response.request().postDataJSON()).toMatchObject({
    name: editedServiceName,
    category: 'Performance',
    duration: 90,
    price: 8_425,
    capacity: 6,
    active: true,
    locations: [{
      locationId: location.id,
      price: 8_650,
      duration: 90,
      instructorIds: [instructor.id],
    }],
  });
  await expect(dialog).toHaveCount(0);
  await expect(catalogCard(page, editedServiceName)).toContainText('Group · up to 6');
  expect((await workspace(page)).services.find(candidate => candidate.id === service.id)).toMatchObject({
    name: editedServiceName,
    category: 'Performance',
    price: 8_425,
    capacity: 6,
    active: true,
    locations: [{ locationId: location.id, price: 8_650, duration: 90 }],
  });

  await catalogCard(page, editedServiceName).getByRole('button', { name: `Edit ${editedServiceName}`, exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit class' });
  await dialog.locator('input[name="active"]').uncheck();
  responsePromise = mutationResponse(page, 'PATCH', `/api/services/${service.id}`);
  await dialog.getByRole('button', { name: 'Save class', exact: true }).click();
  response = await responsePromise;
  await responseJson<Service>(response);
  expect(response.request().postDataJSON()).toMatchObject({ active: false });
  await expect(dialog).toHaveCount(0);
  await expect(catalogCard(page, editedServiceName)).toHaveCount(0);
  await page.getByLabel('Filter classes', { exact: true }).selectOption('archived');
  await expect(catalogCard(page, editedServiceName)).toContainText('Archived');
  expect((await workspace(page)).services.find(candidate => candidate.id === service.id)?.active).toBe(false);
  await expectNoHorizontalOverflow(page);

  await page.goto('/?tab=explore&view=availability');
  await expect(page.locator('main').getByRole('heading', { name: 'Availability', exact: true })).toBeVisible();
  await page.locator('#availability-instructor').selectOption(instructor.id);
  await page.getByRole('button', { name: 'Add weekly hours', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Add weekly hours' });
  await dialog.locator('#hours-instructor').selectOption(instructor.id);
  await dialog.locator('#hours-location').selectOption(location.id);
  await dialog.locator('#hours-day').selectOption('2');
  await dialog.locator('input[name="startTime"]').fill('06:15');
  await dialog.locator('input[name="endTime"]').fill('06:45');

  responsePromise = mutationResponse(page, 'POST', '/api/availability');
  await dialog.getByRole('button', { name: 'Add weekly hours', exact: true }).click();
  response = await responsePromise;
  const availability = await responseJson<Availability>(response);
  expect(response.request().postDataJSON()).toEqual({
    instructorId: instructor.id,
    locationId: location.id,
    dayOfWeek: 2,
    startTime: '06:15',
    endTime: '06:45',
  });
  await expect(dialog).toHaveCount(0);
  const removeAvailabilityName = `Remove Tuesday ${localTime('06:15')} availability`;
  await expect(page.getByRole('button', { name: removeAvailabilityName, exact: true })).toBeVisible();
  expect((await workspace(page)).availability.find(candidate => candidate.id === availability.id)).toMatchObject({
    id: availability.id,
    instructorId: instructor.id,
    locationId: location.id,
    dayOfWeek: 2,
    startTime: '06:15',
    endTime: '06:45',
  });
  await expectNoHorizontalOverflow(page);

  responsePromise = mutationResponse(page, 'DELETE', `/api/availability/${availability.id}`);
  page.once('dialog', confirmation => void confirmation.accept());
  await page.getByRole('button', { name: removeAvailabilityName, exact: true }).click();
  response = await responsePromise;
  await responseJson<{ ok: true }>(response);
  await expect(page.getByRole('button', { name: removeAvailabilityName, exact: true })).toHaveCount(0);
  expect((await workspace(page)).availability.some(candidate => candidate.id === availability.id)).toBe(false);

  const blockedDate = futureSingaporeDate();
  const blockedReason = `Tournament travel ${suffix}`;
  await page.getByRole('button', { name: 'Block date', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Block a date' });
  await dialog.locator('#blocked-instructor').selectOption(instructor.id);
  await dialog.locator('input[name="date"]').fill(blockedDate);
  await dialog.locator('input[name="reason"]').fill(blockedReason);

  responsePromise = mutationResponse(page, 'POST', '/api/exceptions');
  await dialog.getByRole('button', { name: 'Block date', exact: true }).click();
  response = await responsePromise;
  const exception = await responseJson<AvailabilityException>(response);
  expect(response.request().postDataJSON()).toEqual({
    instructorId: instructor.id,
    date: blockedDate,
    reason: blockedReason,
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(blockedReason, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Remove blocked date ${blockedDate}`, exact: true })).toBeVisible();
  expect((await workspace(page)).exceptions.find(candidate => candidate.id === exception.id)).toMatchObject({
    id: exception.id,
    instructorId: instructor.id,
    date: blockedDate,
    reason: blockedReason,
  });
  await expectNoHorizontalOverflow(page);

  await page.goto('/?tab=explore&view=locations');
  await catalogCard(page, editedLocationName).getByRole('button', { name: 'Edit location', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit location' });
  await dialog.locator('input[name="active"]').uncheck();
  responsePromise = mutationResponse(page, 'PUT', `/api/rental-locations/${location.id}`);
  await dialog.getByRole('button', { name: 'Save location', exact: true }).click();
  response = await responsePromise;
  await responseJson<RentalLocationSaveResult>(response);
  expect(response.request().postDataJSON()).toMatchObject({
    mode: 'UPDATE',
    location: { active: false },
    rental: { enabled: false },
  });
  await expect(dialog).toHaveCount(0);
  await expect(catalogCard(page, editedLocationName)).toContainText('Archived');
  expect((await workspace(page)).locations.find(candidate => candidate.id === location.id)?.active).toBe(false);
  await expectNoHorizontalOverflow(page);

  await page.goto('/?tab=explore&view=students');
  await expect(page.locator('main').getByRole('heading', { name: 'Students', exact: true })).toBeVisible();
  await page.locator('input[aria-label="Search students by name, email, phone, or parent"]').fill(student.email);
  await page.getByRole('button', { name: `View ${student.name}'s profile`, exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: student.name });
  await expect(dialog).toContainText(student.notes);
  await dialog.getByRole('button', { name: 'Edit internal notes', exact: true }).click();

  dialog = page.getByRole('dialog', { name: 'Edit student' });
  await expect(dialog.locator('input[name="name"]')).toHaveCount(0);
  const updatedNotes = `Prefers a quiet warm-up before match play (${suffix}).`;
  await dialog.locator('textarea[name="notes"]').fill(updatedNotes);
  responsePromise = mutationResponse(page, 'PATCH', `/api/students/${student.id}`);
  await dialog.getByRole('button', { name: 'Save student', exact: true }).click();
  response = await responsePromise;
  const updatedStudent = await responseJson<Student>(response);
  expect(response.request().postDataJSON()).toEqual({ notes: updatedNotes });
  expect(updatedStudent).toMatchObject({
    id: student.id,
    userId: student.userId,
    name: student.name,
    email: student.email,
    notes: updatedNotes,
  });
  await expect(dialog).toHaveCount(0);
  expect((await workspace(page)).students.find(candidate => candidate.id === student.id)).toMatchObject({
    userId: student.userId,
    name: student.name,
    email: student.email,
    notes: updatedNotes,
  });

  await page.getByRole('button', { name: `View ${student.name}'s profile`, exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: student.name })).toContainText(updatedNotes);
  await expectNoHorizontalOverflow(page);
});
