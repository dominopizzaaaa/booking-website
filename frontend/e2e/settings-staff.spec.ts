import { expect, test, type APIResponse, type Page, type Response } from '@playwright/test';
import type { ManagerWorkspace } from '../src/lib/types';

const password = 'TestingOnly!2026';

type StaffAccess = {
  id: string;
  userId: string;
  name: string;
  email: string;
  accountType: 'COACH' | 'CLUB';
  instructorId: string | null;
  active: boolean;
  createdAt: string;
};

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function responseJson<T>(response: APIResponse | Response): Promise<T> {
  const body = await response.json() as T;
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function workspace(page: Page) {
  return responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
}

function mutationResponse(page: Page, method: string, pathname: string) {
  return page.waitForResponse(response =>
    response.request().method() === method && new URL(response.url()).pathname === pathname,
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )).toBe(false);
}

test('club settings and coach access persist through the responsive UI', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const suffix = `${projectId(testInfo.project.name)}-${Date.now()}`;
  const coachName = `Settings Coach ${projectId(testInfo.project.name)}`;
  const coachEmail = `settings-staff-${suffix}@example.test`;

  // Account and tenant creation are setup. Every policy or access change below
  // is submitted through the same controls a club account uses.
  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'COACH', name: coachName, username: `stc_${coachEmail.split('@')[0].replace(/-/g, '_').slice(-26)}`, email: coachEmail, password },
  }));
  await responseJson(await page.request.post('/api/auth/logout', { data: {} }));
  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));

  const initial = await workspace(page);
  expect(initial).toMatchObject({
    clubAccount: true,
    business: { kind: 'CLUB', isDemo: true },
    user: { accountType: 'CLUB' },
  });
  const added = await responseJson<StaffAccess>(await page.request.post('/api/staff', {
    data: { email: coachEmail },
  }));
  expect(added).toMatchObject({ name: coachName, email: coachEmail, accountType: 'COACH', active: true });
  expect(added.instructorId).toBeTruthy();
  if (!added.instructorId) throw new Error('Coach setup needs an automatically created roster profile');
  const originalInstructorId = added.instructorId;

  await test.step('the club saves its cancellation policy', async () => {
    const cancellationHours = 36;
    await page.goto('/?tab=profile&view=settings');

    const main = page.getByRole('main', { name: 'Settings workspace view' });
    await expect(main.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    const businessDetails = main.locator('section').filter({
      has: page.getByRole('heading', { name: 'Business details', exact: true }),
    });
    await businessDetails.getByRole('button', { name: 'Edit', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Edit business details' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('spinbutton', { name: 'Cancellation notice (hours)', exact: true }).fill(String(cancellationHours));
    await expectNoHorizontalOverflow(page);

    const responsePromise = mutationResponse(page, 'PATCH', '/api/business');
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    const response = await responsePromise;
    const business = await responseJson<ManagerWorkspace['business']>(response);
    expect(response.request().postDataJSON()).toEqual({
      name: initial.business.name,
      ownerName: initial.business.ownerName,
      color: initial.business.color,
      tagline: initial.business.tagline,
      cancellationHours,
    });
    expect(business).toMatchObject({ id: initial.business.id, cancellationHours });

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Business details updated', { exact: true })).toBeVisible();
    await expect(businessDetails.getByText(`${cancellationHours} hours before the lesson`, { exact: true })).toBeVisible();
    expect((await workspace(page)).business.cancellationHours).toBe(cancellationHours);
  });

  await test.step('the club saves a coach reschedule window', async () => {
    const rescheduleNoticeHours = 48;
    await page.goto('/?tab=explore&view=availability');

    const main = page.getByRole('main', { name: 'Availability workspace view' });
    await expect(main.getByRole('heading', { name: 'Availability', exact: true })).toBeVisible();
    await main.getByLabel('Instructor', { exact: true }).selectOption(originalInstructorId);
    const rescheduleWindow = main.locator('section').filter({
      has: page.getByRole('heading', { name: 'Latest time to reschedule', exact: true }),
    });
    const hoursInput = rescheduleWindow.getByLabel('Hours before', { exact: true });
    await hoursInput.fill(String(rescheduleNoticeHours));
    await expect(rescheduleWindow.getByRole('button', { name: 'Save window', exact: true })).toBeEnabled();
    await expectNoHorizontalOverflow(page);

    const responsePromise = mutationResponse(page, 'PATCH', `/api/instructors/${originalInstructorId}`);
    await rescheduleWindow.getByRole('button', { name: 'Save window', exact: true }).click();
    const response = await responsePromise;
    const instructor = await responseJson<{ id: string; rescheduleNoticeHours: number }>(response);
    expect(response.request().postDataJSON()).toEqual({ rescheduleNoticeHours });
    expect(instructor).toMatchObject({ id: originalInstructorId, rescheduleNoticeHours });

    await expect(page.getByText('Reschedule window saved', { exact: true })).toBeVisible();
    await expect(hoursInput).toHaveValue(String(rescheduleNoticeHours));
    await expect(rescheduleWindow.getByText(`Requests close ${rescheduleNoticeHours} hours before a session starts.`, { exact: true })).toBeVisible();
    expect((await workspace(page)).instructors.find(candidate => candidate.id === originalInstructorId))
      .toMatchObject({ rescheduleNoticeHours });
  });

  await test.step('coach access can be edited, confirmed for removal, and restored', async () => {
    await page.goto('/?tab=explore&view=team');

    const main = page.getByRole('main', { name: 'My coaches workspace view' });
    await expect(main.getByRole('heading', { name: 'My coaches', exact: true })).toBeVisible();
    const accessSection = main.locator('section').filter({
      has: page.getByRole('heading', { name: 'Coach access', exact: true }),
    });
    const coachRow = accessSection.getByRole('listitem').filter({ hasText: coachEmail });
    await expect(coachRow).toContainText(coachName);
    await coachRow.getByRole('button', { name: `Edit coach access for ${coachName}`, exact: true }).click();

    let dialog = page.getByRole('dialog', { name: 'Edit coach access' });
    const profileSelect = dialog.getByLabel('Coach profile (optional)', { exact: true });
    await expect(profileSelect).toHaveValue(originalInstructorId);
    await profileSelect.selectOption('');
    await expectNoHorizontalOverflow(page);

    let responsePromise = mutationResponse(page, 'PATCH', `/api/staff/${added.id}`);
    await dialog.getByRole('button', { name: 'Save coach access', exact: true }).click();
    let response = await responsePromise;
    const edited = await responseJson<StaffAccess>(response);
    expect(response.request().postDataJSON()).toEqual({ instructorId: null });
    expect(edited).toMatchObject({ id: added.id, userId: added.userId, active: true });
    expect(edited.instructorId).toBeTruthy();
    expect(edited.instructorId).not.toBe(originalInstructorId);
    if (!edited.instructorId) throw new Error('Edited coach access needs its replacement roster profile');
    const retainedInstructorId = edited.instructorId;

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Coach access updated', { exact: true })).toBeVisible();
    const afterEdit = await workspace(page);
    expect(afterEdit.instructors.find(candidate => candidate.id === originalInstructorId))
      .toMatchObject({ active: false });
    expect(afterEdit.instructors.find(candidate => candidate.id === retainedInstructorId))
      .toMatchObject({ active: true });

    await coachRow.getByRole('button', { name: `Remove coach access for ${coachName}`, exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Remove coach access?' });
    await expect(dialog).toContainText(`${coachName} (${coachEmail}) will lose access to this club workspace.`);
    await expect(dialog.getByRole('button', { name: 'Keep access', exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    responsePromise = mutationResponse(page, 'DELETE', `/api/staff/${added.id}`);
    await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
    response = await responsePromise;
    expect(await responseJson<{ ok: boolean }>(response)).toEqual({ ok: true });

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Coach access removed from this club.', { exact: true })).toBeVisible();
    await expect(coachRow).toHaveCount(0);
    const activeStaff = await responseJson<StaffAccess[]>(await page.request.get('/api/staff'));
    expect(activeStaff.some(candidate => candidate.id === added.id)).toBe(false);
    expect((await workspace(page)).instructors.find(candidate => candidate.id === retainedInstructorId))
      .toMatchObject({ active: false, accountLinkAvailable: false });

    await accessSection.getByRole('button', { name: 'Add coach', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Add coach access' });
    await dialog.getByRole('searchbox', { name: 'Courtly coach account', exact: true }).fill(coachEmail);
    const restoredNoticeHours = 72;
    await dialog.getByRole('spinbutton', { name: 'Reschedule notice (hours)', exact: true })
      .fill(String(restoredNoticeHours));
    const readdProfileSelect = dialog.getByLabel('Coach profile (optional)', { exact: true });
    const retainedProfile = readdProfileSelect.locator(`option[value="${retainedInstructorId}"]`);
    await expect(retainedProfile).toBeDisabled();
    await expect(retainedProfile).toContainText('identity retained');

    responsePromise = mutationResponse(page, 'POST', '/api/staff');
    await dialog.getByRole('button', { name: 'Add coach', exact: true }).click();
    response = await responsePromise;
    const restored = await responseJson<StaffAccess>(response);
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toEqual({
      instructorId: null,
      query: coachEmail,
      rescheduleNoticeHours: restoredNoticeHours,
    });
    expect(restored).toMatchObject({
      id: added.id,
      userId: added.userId,
      instructorId: retainedInstructorId,
      active: true,
    });

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Coach added', { exact: true })).toBeVisible();
    await expect(coachRow).toContainText(`Coach profile: ${coachName}`);
    expect((await workspace(page)).instructors.find(candidate => candidate.id === retainedInstructorId))
      .toMatchObject({ active: true, accountLinkAvailable: false, rescheduleNoticeHours: restoredNoticeHours });
    await expectNoHorizontalOverflow(page);
  });
});
