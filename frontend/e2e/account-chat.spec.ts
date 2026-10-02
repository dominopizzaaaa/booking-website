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
import type {
  AuthSession,
  ChatMessage,
  ChatThreadDetail,
  ChatThreadList,
  Slot,
} from '../src/lib/types';
import { money } from '../src/lib/utils';
import { currentLegalAcceptance } from './legal-acceptance';
import { openDisclosure } from './progressive-disclosure';

const password = 'TestingOnly!2026';
const timezone = 'Asia/Singapore';
const apiContexts: APIRequestContext[] = [];

function projectId(projectName: string) {
  return projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function futureSingaporeDate(days: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
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

async function signInAs(page: Page, email: string) {
  await responseJson(await page.request.post('/api/auth/logout', { data: {} }));
  await responseJson(await page.request.post('/api/auth/login', { data: { email, password } }));
}

function mutationResponse(page: Page, method: string, pathname: string) {
  return page.waitForResponse(response =>
    response.request().method() === method && new URL(response.url()).pathname === pathname,
  );
}

async function openAccountThread(page: Page, title: string) {
  const thread = page.getByRole('list', { name: 'Chats' }).getByRole('button').filter({ hasText: title });
  await expect(thread).toBeVisible();
  await thread.click();
  const log = page.getByRole('log');
  await expect(log).toBeVisible();
  return log;
}

async function sendMessage(page: Page, message: string, threadId: string) {
  await page.getByLabel('Message', { exact: true }).fill(message);
  const sent = mutationResponse(page, 'POST', `/api/chats/${threadId}/messages`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await responseJson(await sent);
  await expect(page.getByRole('log').getByText(message, { exact: true })).toBeVisible();
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);
}

function asAdminMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    mine: false,
    proposal: message.proposal ? {
      ...message.proposal,
      proposedByYou: false,
      forYou: false,
      actions: { accept: false, decline: false, counter: false, withdraw: false },
      responses: message.proposal.responses.map(response => ({ ...response, forYou: false, byYou: false })),
    } : message.proposal,
  };
}

test.afterEach(async () => {
  await Promise.all(apiContexts.splice(0).map(context => context.dispose()));
});

test('a club can bring its coach into an account conversation and plan a session', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390', 'This is the dedicated 390px account-conversation journey.');
  test.setTimeout(180_000);

  const baseURL = String(testInfo.project.use.baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000');
  const run = `${projectId(testInfo.project.name)}_${Date.now().toString(36)}`;
  const studentName = `Account Student ${run}`;
  const studentUsername = `student_${run}`.slice(0, 30);
  const studentEmail = `account-student-${run}@example.test`;
  const coachName = `Account Coach ${run}`;
  const coachUsername = `coach_${run}`.slice(0, 30);
  const coachEmail = `account-coach-${run}@example.test`;
  const clubName = `Account Club ${run}`;
  const clubUsername = `club_${run}`.slice(0, 30);
  const clubEmail = `account-club-${run}@example.test`;
  const locationName = `Account Court ${run}`;
  const serviceName = `Account lesson ${run}`;

  const studentAccount = await isolatedApiContext(baseURL);
  const coachAccount = await isolatedApiContext(baseURL);
  const clubAccount = await isolatedApiContext(baseURL);

  await responseJson<AuthSession>(await studentAccount.post('/api/auth/register', {
    data: {
      accountType: 'STUDENT', name: studentName, username: studentUsername, email: studentEmail, password, sports: ['Tennis'], dateOfBirth: '1990-01-01', ...currentLegalAcceptance,
    },
  }));
  await responseJson<AuthSession>(await coachAccount.post('/api/auth/register', {
    data: {
      accountType: 'COACH', name: coachName, username: coachUsername, email: coachEmail, password, sports: ['Tennis'], dateOfBirth: '1990-01-01', ...currentLegalAcceptance,
    },
  }));
  const clubAuth = await responseJson<AuthSession>(await clubAccount.post('/api/auth/register', {
    data: {
      accountType: 'CLUB', businessName: clubName, name: `Operator ${run}`, username: clubUsername,
      email: clubEmail, password, sports: ['Tennis'], ...currentLegalAcceptance,
    },
  }));
  expect(clubAuth.business).not.toBeNull();
  const club = clubAuth.business!;
  const phoneViewport = page.viewportSize()!;

  const roster = await responseJson<{ instructorId: string | null }>(await clubAccount.post('/api/staff', {
    data: { email: coachEmail },
  }));
  expect(roster.instructorId).toBeTruthy();
  const instructorId = roster.instructorId!;
  const location = await responseJson<{ id: string }>(await clubAccount.post('/api/locations', {
    data: { name: locationName, address: '39 Conversation Road', type: 'FACILITY', requiresApproval: false },
  }));
  const service = await responseJson<{ id: string }>(await clubAccount.post('/api/services', {
    data: {
      name: serviceName,
      description: 'A private class used by the generalized account-chat journey.',
      category: 'Tennis',
      type: 'PRIVATE',
      duration: 60,
      price: 9_500,
      capacity: 1,
      bufferMinutes: 0,
      noticeHours: 0,
      color: 'sage',
      active: true,
      locations: [{ locationId: location.id, price: 9_500, duration: 60, instructorIds: [instructorId] }],
    },
  }));
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    await responseJson(await clubAccount.post('/api/availability', {
      data: { instructorId, locationId: location.id, dayOfWeek, startTime: '08:00', endTime: '20:00' },
    }));
  }
  await responseJson(await clubAccount.patch('/api/business', { data: { currency: 'USD' } }));
  club.currency = 'USD';

  expect(page.viewportSize()?.width).toBe(390);

  await test.step('the student searches for the club and starts its durable account conversation', async () => {
    await signInAs(page, studentEmail);
    await page.goto('/manage?tab=chat');
    await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeVisible();

    const searchRequests: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/accounts/search') searchRequests.push(request.url());
    });
    await page.locator('.chat-list-header').getByRole('button', { name: 'New conversation', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New conversation' });
    await expect(dialog).toBeVisible();
    await expectInsideViewport(page, dialog);
    await expect(dialog).toContainText('Enter at least 3 characters');

    const search = dialog.getByRole('searchbox', { name: 'Find an account', exact: true });
    await search.fill(clubUsername.slice(0, 2));
    await page.waitForTimeout(400);
    expect(searchRequests).toHaveLength(0);
    await expect(dialog.getByText('Search results will appear here.', { exact: true })).toBeVisible();

    const resultResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/accounts/search' && url.searchParams.get('q') === clubUsername;
    });
    await search.fill(clubUsername);
    await responseJson(await resultResponse);
    expect(searchRequests).toHaveLength(1);
    const results = dialog.getByRole('list', { name: 'Account search results' });
    const clubResult = results.getByRole('button').filter({ hasText: clubName });
    await expect(clubResult).toContainText(`@${clubUsername}`);
    await expect(clubResult).toContainText('Club');

    const created = mutationResponse(page, 'POST', '/api/chats/accounts');
    await clubResult.click();
    const creation = await created;
    expect(creation.request().postDataJSON()).toEqual({ username: clubUsername });
    const { threadId: createdThreadId } = await responseJson<{ threadId: string }>(creation);
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'chat' && url.searchParams.get('thread') === createdThreadId);
    await expect(page.getByRole('heading', { name: clubName, exact: true })).toBeFocused();

    const message = `Student context before coach access ${run}`;
    await sendMessage(page, message, createdThreadId);
    await openDisclosure(page, 'Conversation details');
    await expect(page.getByText(/Visible to the people in this conversation/)).toBeVisible();
    await expectInsideViewport(page, page.locator('.chat-thread-pane'));

    testInfo.annotations.push({ type: 'threadId', description: createdThreadId });
  });

  const threadId = new URL(page.url()).searchParams.get('thread');
  expect(threadId).toBeTruthy();
  const studentMessage = `Student context before coach access ${run}`;
  const clubMessage = `Club reply before coach access ${run}`;

  await test.step('the club confirms that its active coach receives the existing history', async () => {
    await signInAs(page, clubEmail);
    await page.goto('/?tab=chat');
    const log = await openAccountThread(page, studentName);
    await expect(log.getByText(studentMessage, { exact: true })).toBeVisible();
    await sendMessage(page, clubMessage, threadId!);

    await page.getByRole('button', { name: 'Manage conversation coach', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Manage conversation coach' });
    await expect(dialog).toBeVisible();
    await expectInsideViewport(page, dialog);
    await expect(dialog.getByRole('heading', { name: 'Manage conversation coach', exact: true })).toBeFocused();
    await expect(dialog.getByText('You will confirm history access before the coach is added.', { exact: true })).toBeVisible();
    const coachChoice = dialog.getByRole('button').filter({ hasText: coachName });
    await coachChoice.click();
    const confirmation = dialog.getByRole('heading', { name: `Add ${coachName}?`, exact: true });
    await expect(confirmation).toBeFocused();
    await expect(dialog).toContainText(`${coachName} will be able to read the full conversation history, including every message sent before they joined.`);
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(coachChoice).toBeFocused();
    await coachChoice.click();
    await expect(confirmation).toBeFocused();

    const assignment = mutationResponse(page, 'POST', `/api/chats/${threadId}/coach`);
    await dialog.getByRole('button', { name: 'Add coach', exact: true }).click();
    await responseJson(await assignment);
    await expect(dialog).toBeHidden();
    await expect(log).toContainText(`${coachName} was assigned to this conversation.`);
    await expect(page.getByText('Conversation coach updated', { exact: true })).toBeVisible();
  });

  await test.step('the assigned coach reads that history and sends a generalized session proposal', async () => {
    await signInAs(page, coachEmail);
    await page.goto('/?tab=chat');
    const log = await openAccountThread(page, studentName);
    await expect(log.getByText(studentMessage, { exact: true })).toBeVisible();
    await expect(log.getByText(clubMessage, { exact: true })).toBeVisible();
    await openDisclosure(page, 'Conversation details');
    await expect(page.getByText(`Visible to the people in this conversation, including ${coachName}. Courtly does not monitor every message; authorized reviewers can review relevant context after a report.`, { exact: true })).toBeVisible();

    const slotsResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/public/${club.slug}/slots`
        && url.searchParams.get('serviceId') === service.id
        && url.searchParams.get('instructorId') === instructorId
        && url.searchParams.get('locationId') === location.id;
    });
    await page.getByRole('button', { name: 'Propose a session', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Propose a session' });
    await expect(dialog).toBeVisible();
    await expectInsideViewport(page, dialog);
    await expect(dialog.getByLabel('Club', { exact: true })).toHaveValue(club.slug);
    await expect(dialog.getByLabel('Club', { exact: true })).toContainText(clubName);
    await expect(dialog.getByLabel('Class', { exact: true })).toHaveValue(service.id);
    await expect(dialog.getByLabel('Class', { exact: true })).toContainText(serviceName);
    await expect(dialog.getByLabel('Location', { exact: true })).toHaveValue(location.id);
    await expect(dialog.getByLabel('Location', { exact: true })).toContainText(locationName);
    await expect(dialog).toContainText(`Coach ${coachName}`);

    const slots = await responseJson<{ slots: Slot[] }>(await slotsResponse);
    expect(slots.slots.some(slot => slot.available)).toBe(true);
    const proposalDate = futureSingaporeDate(2);
    const reloadedSlots = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `/api/public/${club.slug}/slots` && url.searchParams.get('date') === proposalDate;
    });
    await dialog.getByLabel('Date', { exact: true }).fill(proposalDate);
    const available = await responseJson<{ slots: Slot[] }>(await reloadedSlots);
    const proposedSlot = available.slots.find(slot => slot.available);
    expect(proposedSlot).toBeTruthy();
    const startLabel = new Intl.DateTimeFormat('en-SG', {
      hour: 'numeric', minute: '2-digit', timeZone: timezone,
    }).format(new Date(proposedSlot!.startAt)).toUpperCase();
    await dialog.getByRole('button', { name: startLabel, exact: true }).click();
    await expect(dialog.getByRole('button', { name: startLabel, exact: true })).toHaveAttribute('aria-pressed', 'true');
    const proposalNote = `Let us use the account conversation ${run}`;
    await dialog.getByLabel(/^Note/).fill(proposalNote);

    const proposalResponse = mutationResponse(page, 'POST', `/api/chats/${threadId}/proposals`);
    await dialog.getByRole('button', { name: 'Send proposal', exact: true }).click();
    const proposed = await proposalResponse;
    expect(proposed.request().postDataJSON()).toMatchObject({
      startAt: proposedSlot!.startAt,
      message: proposalNote,
      businessSlug: club.slug,
      serviceId: service.id,
      locationId: location.id,
    });
    await responseJson(proposed);
    await expect(dialog).toBeHidden();
    const card = page.locator('article.chat-proposal').filter({ hasText: serviceName });
    await expect(card).toContainText(locationName);
    await expect(card).toContainText(proposalNote);
    await expect(card).toContainText(`Waiting for ${studentName}`);
  });

  await test.step('the proposal keeps its quoted price and currency when the club catalog changes', async () => {
    // The browser deliberately signed the club out before switching to the
    // coach, which revokes every session for that account. Refresh this
    // isolated API context before using the club's catalog controls again.
    await responseJson<AuthSession>(await clubAccount.post('/api/auth/login', {
      data: { email: clubEmail, password },
    }));
    await responseJson(await clubAccount.patch(`/api/services/${service.id}`, {
      data: {
        price: 12_500,
        locations: [{ locationId: location.id, price: 12_500, duration: 60, instructorIds: [instructorId] }],
      },
    }));
    await responseJson(await clubAccount.patch('/api/business', { data: { currency: 'EUR' } }));

    await signInAs(page, studentEmail);
    await page.goto('/manage?tab=chat');
    await openAccountThread(page, clubName);
    const card = page.locator('article.chat-proposal').filter({ hasText: serviceName });
    await expect(card).toContainText(money(9_500, 'USD'));
    await expect(card).not.toContainText(money(12_500, 'USD'));
    await expect(card).not.toContainText(money(9_500, 'EUR'));
    await expect(card).not.toContainText(money(12_500, 'EUR'));
    await page.screenshot({ path: `.data/screenshots/account-chat-student-${testInfo.project.name}.png`, fullPage: true });
  });

  await test.step('removing the assigned coach purges the open transcript from that browser', async () => {
    // Exercise revocation while both panes are present: removing the focused
    // conversation must return keyboard focus to the surviving inbox.
    await page.setViewportSize({ width: 1_440, height: 900 });
    await signInAs(page, coachEmail);
    await page.goto(`/?tab=chat&thread=${encodeURIComponent(threadId!)}`);
    await expect(page.locator('.chat-inbox')).toHaveClass(/chat-inbox-split/);
    await expect(page.getByRole('log').getByText(studentMessage, { exact: true })).toBeVisible();

    await responseJson(await clubAccount.delete(`/api/chats/${threadId}/coach`, { data: {} }));

    await expect(page).toHaveURL(url => url.searchParams.get('tab') === 'chat' && !url.searchParams.has('thread'));
    await expect(page.getByRole('log')).toHaveCount(0);
    await expect(page.getByText(studentMessage, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Chats' }).getByRole('button').filter({ hasText: studentName })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Chats', exact: true })).toBeFocused();
    await page.setViewportSize(phoneViewport);
  });

  await test.step('the platform safety view renders the real account thread without write controls', async () => {
    await signInAs(page, studentEmail);
    const participantList = await responseJson<ChatThreadList>(await page.request.get('/api/chats?contract=accounts'));
    const summary = participantList.threads.find(thread => thread.id === threadId);
    expect(summary?.kind).toBe('ACCOUNT');
    const participantDetail = await responseJson<ChatThreadDetail>(
      await page.request.get(`/api/chats/${threadId}?contract=accounts`),
    );
    const adminDetail: ChatThreadDetail = {
      ...participantDetail,
      viewer: { role: 'ADMIN', canPost: false, canPropose: false, canAssignCoach: false },
      messages: participantDetail.messages.map(asAdminMessage),
    };
    const adminMutations: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/admin/chats') && request.method() !== 'GET') {
        adminMutations.push(`${request.method()} ${request.url()}`);
      }
    });

    await page.route('**/api/admin/session', route => route.fulfill({
      json: { configured: true, authenticated: true, authMode: 'named', sensitiveAccess: true, operator: { id: 'ops_chat', name: 'Chat Operator', email: 'chat@example.test' } },
    }));
    await page.route('**/api/admin/overview', route => route.fulfill({
      json: {
        generatedAt: new Date().toISOString(),
        totals: {
          businesses: 1, demoBusinesses: 0, realBusinesses: 1, users: 3, memberships: 2, students: 0,
          bookings: 0, upcomingBookings: 0, bookingsLast7Days: 0, packages: 0, paymentsCount: 0, paymentsTotal: 0,
          chatThreads: 1, chatMessages: participantDetail.messages.filter(message => message.kind !== 'SYSTEM').length,
        },
      },
    }));
    await page.route(/\/api\/admin\/businesses(?:\?.*)?$/, route => route.fulfill({ json: { businesses: [] } }));
    await page.route(/\/api\/admin\/chats(?:\?.*)?$/, route => route.fulfill({
      json: {
        threads: [{
          ...summary!,
          unreadCount: 0,
          lastMessage: summary!.lastMessage ? asAdminMessage(summary!.lastMessage) : null,
          messageCount: participantDetail.messages.filter(message => message.kind !== 'SYSTEM').length,
        }],
        nextCursor: null,
        accountChatAvailable: true,
      } satisfies ChatThreadList,
    }));
    await page.route(/\/api\/admin\/chats\/[^/?]+(?:\?.*)?$/, route => route.fulfill({ json: adminDetail }));

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Every workspace, at a glance', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Conversation records', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
    const log = await openAccountThread(page, studentName);
    await expect(log.getByText(studentMessage, { exact: true })).toBeVisible();
    await expect(log.getByText(clubMessage, { exact: true })).toBeVisible();
    await expect(page.getByText('Read-only view for platform safety review', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Propose a session', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Manage conversation coach', exact: true })).toHaveCount(0);
    expect(adminMutations).toEqual([]);
    await expectInsideViewport(page, page.locator('.chat-thread-pane'));
  });
});

test('a session talked through in chat becomes a ready-made proposal', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const baseURL = String(testInfo.project.use.baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000');
  const run = `${projectId(testInfo.project.name)}_${Date.now().toString(36)}`.slice(-24);
  const studentName = `Plan Student ${run}`;
  const studentEmail = `plan-student-${run}@example.test`;
  const coachName = `Plan Coach ${run}`;
  const coachUsername = `pcoach_${run}`.slice(0, 30);
  const coachEmail = `plan-coach-${run}@example.test`;
  const clubEmail = `plan-club-${run}@example.test`;
  const serviceName = `Plan lesson ${run}`;

  const studentAccount = await isolatedApiContext(baseURL);
  const coachAccount = await isolatedApiContext(baseURL);
  const clubAccount = await isolatedApiContext(baseURL);
  await responseJson(await studentAccount.post('/api/auth/register', {
    data: {
      accountType: 'STUDENT', name: studentName, username: `pstudent_${run}`.slice(0, 30), email: studentEmail,
      password, sports: ['Tennis'], dateOfBirth: '1990-01-01', ...currentLegalAcceptance,
    },
  }));
  await responseJson(await coachAccount.post('/api/auth/register', {
    data: {
      accountType: 'COACH', name: coachName, username: coachUsername, email: coachEmail,
      password, sports: ['Tennis'], dateOfBirth: '1990-01-01', ...currentLegalAcceptance,
    },
  }));
  const clubAuth = await responseJson<AuthSession>(await clubAccount.post('/api/auth/register', {
    data: {
      accountType: 'CLUB', businessName: `Plan Club ${run}`, name: `Plan Operator ${run}`,
      username: `pclub_${run}`.slice(0, 30), email: clubEmail, password, sports: ['Tennis'], ...currentLegalAcceptance,
    },
  }));
  expect(clubAuth.business).not.toBeNull();
  const roster = await responseJson<{ instructorId: string | null }>(await clubAccount.post('/api/staff', { data: { email: coachEmail } }));
  const instructorId = roster.instructorId!;
  const location = await responseJson<{ id: string }>(await clubAccount.post('/api/locations', {
    data: { name: `Plan Court ${run}`, address: '12 Planning Road', type: 'FACILITY', requiresApproval: false },
  }));
  await responseJson(await clubAccount.post('/api/services', {
    data: {
      name: serviceName, description: 'A private class used by the chat suggestion journey.', category: 'Tennis',
      type: 'PRIVATE', duration: 60, price: 9_000, capacity: 1, bufferMinutes: 0, noticeHours: 0, color: 'sage', active: true,
      locations: [{ locationId: location.id, price: 9_000, duration: 60, instructorIds: [instructorId] }],
    },
  }));
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    await responseJson(await clubAccount.post('/api/availability', {
      data: { instructorId, locationId: location.id, dayOfWeek, startTime: '08:00', endTime: '20:00' },
    }));
  }

  const { threadId } = await responseJson<{ threadId: string }>(await studentAccount.post('/api/chats/accounts', {
    data: { username: coachUsername },
  }));
  const day = futureSingaporeDate(3);
  const dayWords = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: timezone })
    .format(new Date(`${day}T04:00:00Z`));
  const say = async (context: APIRequestContext, body: string) => responseJson(
    await context.post(`/api/chats/${threadId}/messages`, { data: { body } }),
  );
  await say(coachAccount, 'hello');
  await say(coachAccount, `Do you want to have a session on ${dayWords} 9am-1030am?`);
  await say(studentAccount, 'Can shift to 12pm? i got stuff at 10am');

  const suggestionCard = page.getByRole('region', { name: 'Sounds like you’re planning a session' });

  await test.step('the student sees the counter-offer, not the original time, and sends it', async () => {
    await signInAs(page, studentEmail);
    await page.goto(`/manage?tab=chat&thread=${encodeURIComponent(threadId)}`);
    await expect(suggestionCard).toBeVisible();
    await expect(suggestionCard).toContainText('12:00 PM – 1:30 PM');
    await expect(suggestionCard).toContainText('venue not mentioned');
    await expect(suggestionCard).toContainText(`${serviceName} runs 1 h, so the proposal ends at 1:00 PM.`);
    await expect(suggestionCard).toContainText('Open to book');
    await expectInsideViewport(page, suggestionCard);

    await suggestionCard.getByRole('button', { name: 'Propose this time', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Propose a session' });
    await expect(dialog).toContainText('Filled in from your conversation');
    await expect(dialog.getByLabel('Date', { exact: true })).toHaveValue(day);
    await expect(dialog.getByRole('button', { name: '12:00 PM', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expectInsideViewport(page, dialog);

    const proposal = mutationResponse(page, 'POST', `/api/chats/${threadId}/proposals`);
    await dialog.getByRole('button', { name: 'Send proposal', exact: true }).click();
    const sent = await proposal;
    expect(sent.request().postDataJSON()).toMatchObject({
      startAt: new Date(`${day}T04:00:00.000Z`).toISOString(), serviceId: expect.any(String), locationId: location.id,
    });
    await responseJson(sent);
    await expect(dialog).toBeHidden();
    await expect(page.locator('article.chat-proposal').filter({ hasText: serviceName })).toContainText('Waiting for');
    await expect(suggestionCard).toHaveCount(0);
  });

  await test.step('a dismissed plan stays dismissed on another device, for that person only', async () => {
    await say(coachAccount, `also free ${dayWords} 4pm at Plan Court ${run} if you want a second one`);
    await page.reload();
    await expect(suggestionCard).toContainText('4:00 PM');
    await expect(suggestionCard).not.toContainText('venue not mentioned');
    const dismissal = mutationResponse(page, 'POST', `/api/chats/${threadId}/schedule-suggestion/dismiss`);
    await suggestionCard.getByRole('button', { name: 'Dismiss suggested session', exact: true }).click();
    await responseJson(await dismissal);
    await expect(suggestionCard).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('log')).toBeVisible();
    await expect(suggestionCard).toHaveCount(0);

    const otherDevice = await responseJson<ChatThreadDetail>(await studentAccount.get(`/api/chats/${threadId}?contract=accounts`));
    expect(otherDevice.scheduleSuggestion).toBeNull();
    const coachView = await responseJson<ChatThreadDetail>(await coachAccount.get(`/api/chats/${threadId}?contract=accounts`));
    expect(coachView.scheduleSuggestion?.startAt).toBe(new Date(`${day}T08:00:00.000Z`).toISOString());
  });

  await test.step('a sent message shows one tick on Singapore time, then two once the coach reads it', async () => {
    await expect(page.locator('.chat-thread-header')).toContainText('Times in SGT');
    const note = `Ticks check ${run}`;
    await page.getByLabel('Message', { exact: true }).fill(note);
    const posted = mutationResponse(page, 'POST', `/api/chats/${threadId}/messages`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const { message } = await responseJson<{ message: ChatMessage }>(await posted);
    const bubble = page.getByRole('log').getByRole('listitem').filter({ hasText: note });
    await expect(bubble.getByText('Sent', { exact: true })).toBeAttached();
    // The browser runs on its own zone; the chat still reads Singapore time.
    const singaporeTime = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timezone,
    }).format(new Date(message.createdAt)).replace(/\s+/g, ' ');
    await expect(bubble.locator('time')).toHaveText(singaporeTime);
    await expectInsideViewport(page, bubble);

    await responseJson(await coachAccount.post(`/api/chats/${threadId}/read?contract=accounts`, { data: {} }));
    await expect(bubble.getByText('Read', { exact: true })).toBeAttached({ timeout: 15_000 });
    await expect(bubble.getByText('Sent', { exact: true })).toHaveCount(0);
  });
});
