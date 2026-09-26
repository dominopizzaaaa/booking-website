import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import type { AccountBookingsResult, ManagerWorkspace } from '../src/lib/types';

const password = 'TestingOnly!2026';

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function futureSingaporeDate(days: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

async function responseJson<T>(response: APIResponse): Promise<T> {
  const body = await response.json() as T;
  expect(response.ok(), JSON.stringify(body)).toBeTruthy();
  return body;
}

async function signInAs(page: Page, email: string) {
  await responseJson(await page.request.post('/api/auth/logout', { data: {} }));
  await responseJson(await page.request.post('/api/auth/login', { data: { email, password } }));
}

async function expectNoWcagViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze();
  expect(violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) })),
    'Expected no WCAG A/AA accessibility violations').toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
}

/** Open one session's conversation from the chat list, at any viewport. */
async function openThread(page: Page, serviceName: string) {
  await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();
  await page.getByRole('list', { name: 'Chats' }).getByRole('button', { name: new RegExp(serviceName) }).click();
  const log = page.getByRole('log');
  await expect(log).toBeVisible();
  return log;
}

function proposalCard(page: Page, heading: RegExp): Locator {
  return page.getByRole('article', { name: heading });
}

test('a coach and student agree the next session in chat and it lands on the calendar', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const run = `${projectId(testInfo.project.name)}-${Date.now()}`;
  const handle = run.replace(/-/g, '_').slice(-24);
  const coachEmail = `chat-coach-${run}@example.test`;
  const studentEmail = `chat-student-${run}@example.test`;
  const coachName = `Chat Coach ${projectId(testInfo.project.name)}`;
  const studentName = `Chat Student ${projectId(testInfo.project.name)}`;
  const serviceName = `Chat lesson ${run}`;

  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'COACH', name: coachName, username: `cc_${handle}`, email: coachEmail, password },
  }));
  await responseJson(await page.request.post('/api/auth/logout', { data: {} }));
  await responseJson(await page.request.post('/api/auth/register', {
    data: { accountType: 'STUDENT', name: studentName, username: `cs_${handle}`, email: studentEmail, password },
  }));
  await responseJson(await page.request.post('/api/auth/logout', { data: {} }));

  // An isolated demo club rosters the coach on a private class they can teach
  // every day, so the student's first lesson and the proposals are bookable.
  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));
  const club = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  const { instructorId } = await responseJson<{ instructorId: string }>(await page.request.post('/api/staff', { data: { email: coachEmail } }));
  const location = await responseJson<{ id: string }>(await page.request.post('/api/locations', {
    data: { name: `Chat court ${run}`, address: '1 Chat Way', type: 'FACILITY', requiresApproval: false },
  }));
  const service = await responseJson<{ id: string }>(await page.request.post('/api/services', {
    data: {
      name: serviceName, description: 'A private lesson used to verify session chat.', category: 'Tennis',
      type: 'PRIVATE', duration: 60, price: 9_000, capacity: 1, bufferMinutes: 0, noticeHours: 0, color: 'sage', active: true,
      locations: [{ locationId: location.id, price: 9_000, duration: 60, instructorIds: [instructorId] }],
    },
  }));
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    await responseJson(await page.request.post('/api/availability', {
      data: { instructorId, locationId: location.id, dayOfWeek, startTime: '08:00', endTime: '20:00' },
    }));
  }

  await signInAs(page, studentEmail);
  const firstDate = futureSingaporeDate(10);
  await responseJson(await page.request.post(`/api/public/${club.business.slug}/bookings`, {
    data: { serviceId: service.id, instructorId, locationId: location.id, startAt: `${firstDate}T10:00:00+08:00` },
  }));

  // The coach proposes the next session with the + button.
  const nextDate = futureSingaporeDate(17);
  await signInAs(page, coachEmail);
  await page.goto('/?tab=home');
  const coachNavigation = page.getByRole('navigation', { name: /^(Primary|Mobile navigation)$/ }).filter({ visible: true });
  await coachNavigation.getByRole('button', { name: /^Chat/ }).click();
  await expect(page).toHaveURL(/[?&]tab=chat/);
  let log = await openThread(page, serviceName);
  await expect(log.getByText(/This is the chat for/)).toBeVisible();
  await page.getByRole('button', { name: 'Propose the next session' }).click();
  let dialog = page.getByRole('dialog', { name: 'Propose the next session' });
  await dialog.getByLabel('Date').fill(nextDate);
  await dialog.getByRole('button', { name: '10:00 AM', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '10:00 AM', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByLabel(/^Note/).fill('Same time next week?');
  await dialog.getByRole('button', { name: 'Send proposal' }).click();
  await expect(dialog).toBeHidden();
  const firstCard = proposalCard(page, /10:00 AM – 11:00 AM/);
  await expect(firstCard).toContainText(`Waiting for ${studentName}`);
  await expect(firstCard.getByRole('button', { name: 'Withdraw proposal' })).toBeVisible();
  await expect(firstCard.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  // The student answers with Edit: a different time travels back.
  await signInAs(page, studentEmail);
  await page.goto('/manage?tab=home');
  const studentNavigation = page.getByRole('navigation', { name: 'Student navigation' });
  await expect(studentNavigation.getByRole('button')).toHaveCount(5);
  await expect(page.getByRole('banner').getByRole('button', { name: /^Alerts/ })).toBeVisible();
  await studentNavigation.getByRole('button', { name: /^Chat, 1 unread chat$/ }).click();
  log = await openThread(page, serviceName);
  await expect(firstCard).toContainText('Your answer is needed');
  await expect(firstCard).toContainText('“Same time next week?”');
  await expectNoWcagViolations(page);
  await firstCard.getByRole('button', { name: 'Edit' }).click();
  dialog = page.getByRole('dialog', { name: 'Suggest a different time' });
  await expect(dialog.getByLabel('Date')).toHaveValue(nextDate);
  await expect(dialog.getByRole('button', { name: '10:00 AM', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '11:00 AM', exact: true })).toBeVisible();
  await expectNoWcagViolations(page);
  await dialog.getByRole('button', { name: '11:00 AM', exact: true }).click();
  await dialog.getByRole('button', { name: 'Send new time' }).click();
  await expect(dialog).toBeHidden();
  await expect(firstCard).toContainText('You suggested another time');
  const counterCard = proposalCard(page, /11:00 AM – 12:00 PM/);
  await expect(counterCard).toContainText('New time suggested');
  await expect(counterCard).toContainText(`Waiting for ${coachName}`);
  await page.screenshot({ path: `.data/screenshots/session-chat-student-${testInfo.project.name}.png`, fullPage: true });

  // The coach, who asked first, confirms the edited time.
  await signInAs(page, coachEmail);
  await page.goto('/?tab=chat');
  log = await openThread(page, serviceName);
  await expect(counterCard).toContainText('Your answer is needed');
  await counterCard.getByRole('button', { name: 'Accept' }).click();
  await expect(log.getByText(new RegExp(`${studentName} is booked for ${serviceName}.*added to the calendar`))).toBeVisible();
  await expect(counterCard).toContainText(`${studentName} is booked`);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `.data/screenshots/session-chat-coach-${testInfo.project.name}.png`, fullPage: true });

  await signInAs(page, studentEmail);
  const { bookings } = await responseJson<AccountBookingsResult>(await page.request.get('/api/account/bookings'));
  const next = bookings.find(item => item.booking.startAt === new Date(`${nextDate}T11:00:00+08:00`).toISOString());
  expect(next?.booking).toMatchObject({ status: 'CONFIRMED', serviceName, coachAcceptance: 'NOT_REQUIRED' });
});

test('the club opens a session chat from its booking detail and messages everyone in it', async ({ page }) => {
  test.setTimeout(90_000);
  await responseJson(await page.request.post('/api/auth/demo', { data: {} }));
  const club = await responseJson<ManagerWorkspace>(await page.request.get('/api/workspace'));
  const booking = club.bookings.find(candidate => candidate.status === 'CONFIRMED' && candidate.participants.length > 0);
  test.skip(!booking, 'This demo workspace has no confirmed session to message.');
  const participants = booking!.participants.map(participant => participant.name).join(', ');

  await page.goto('/?tab=explore&view=bookings');
  await expect(page.locator('main').getByRole('heading', { name: 'Bookings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Open booking details for ${booking!.serviceName} with ${participants}` }).first().click();
  const detail = page.getByRole('dialog');
  await detail.getByRole('button', { name: 'Message', exact: true }).click();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'chat' && url.searchParams.has('thread'));
  const log = page.getByRole('log');
  await expect(log).toBeVisible();
  await expect(log.getByText(/This is the chat for/)).toBeVisible();

  // Clubs read along and message, but next sessions are agreed by the
  // coach and students themselves.
  await expect(page.getByRole('button', { name: 'Propose the next session' })).toHaveCount(0);
  const message = `Courts are ready ${Date.now()}`;
  await page.getByLabel('Message', { exact: true }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(log.getByText(message)).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
  await expectNoHorizontalOverflow(page);
  await expectNoWcagViolations(page);

  // A conversation opened from the list is its own history entry, so Back
  // returns to the list on every layout.
  await page.goto('/?tab=chat');
  const thread = page.getByRole('list', { name: 'Chats' }).getByRole('button', { name: new RegExp(message) });
  await thread.click();
  await expect(page).toHaveURL(url => url.searchParams.has('thread'));
  await expect(page.getByRole('log').getByText(message)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'chat' && !url.searchParams.has('thread'));
  await expect(thread).toBeVisible();

  // Where the conversation replaces the list, its back arrow pops that entry
  // rather than stacking another list, so Back never reopens the thread.
  await thread.click();
  await expect(page.getByRole('log').getByText(message)).toBeVisible();
  const openedLength = await page.evaluate(() => window.history.length);
  const backArrow = page.getByRole('button', { name: 'Back to chats' });
  if (await backArrow.isVisible()) {
    await backArrow.click();
    await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'chat' && !url.searchParams.has('thread'));
    await expect(thread).toBeVisible();
    expect(await page.evaluate(() => window.history.length)).toBe(openedLength);
  }
});
