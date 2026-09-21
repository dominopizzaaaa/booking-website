import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const rawBaseUrl = process.env.ELEVER_BASE_URL?.trim();
if (!rawBaseUrl) throw new Error('ELEVER_BASE_URL is required');
const parsed = new URL(rawBaseUrl);
if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
  throw new Error('ELEVER_BASE_URL must use HTTPS unless it targets loopback');
}
const baseUrl = parsed.origin;
const accounts = [
  { key: 'club', name: 'Elever Badminton Academy', email: 'investors@eleverbadminton.com', password: process.env.ELEVER_CLUB_PASSWORD, accountType: 'CLUB' },
  { key: 'loh', name: 'Loh Kean Hean', email: 'loh.kean.hean@eleverbadminton.com', password: process.env.ELEVER_LOH_PASSWORD, accountType: 'COACH' },
  { key: 'eng', name: 'Eng Chin An', email: 'eng.chin.an@eleverbadminton.com', password: process.env.ELEVER_ENG_PASSWORD, accountType: 'COACH' },
  { key: 'dominic', name: 'Dominic', email: 'dominic.student@eleverbadminton.com', password: process.env.ELEVER_DOMINIC_PASSWORD, accountType: 'STUDENT' },
];
for (const account of accounts) if (!account.password) throw new Error('Missing ' + account.key + ' password');

const cookieDirectory = mkdtempSync(join(tmpdir(), 'courtly-elever-verify-'));
process.on('exit', () => rmSync(cookieDirectory, { recursive: true, force: true }));

function request(path, method = 'GET', body, cookieJar = join(cookieDirectory, 'anonymous.txt')) {
  writeFileSync(cookieJar, '', { flag: 'a' });
  const marker = '__COURTLY_HTTP_STATUS__:';
  const args = [
    '--silent', '--show-error', '--http1.1', '--connect-timeout', '15', '--max-time', '60',
    '--cookie', cookieJar, '--cookie-jar', cookieJar, '--request', method,
    '--header', 'Accept: application/json', '--header', 'Origin: ' + baseUrl,
    '--write-out', '\n' + marker + '%{http_code}',
  ];
  if (body !== undefined) args.push('--header', 'Content-Type: application/json', '--data-binary', '@-');
  args.push(baseUrl + '/api' + path);
  const result = spawnSync('curl', args, { encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body) });
  if (result.status !== 0) throw new Error('Network request failed for ' + path + ': ' + (result.stderr || '').trim());
  const index = result.stdout.lastIndexOf('\n' + marker);
  if (index < 0) throw new Error('No HTTP status returned for ' + path);
  const status = Number(result.stdout.slice(index + marker.length + 1));
  const text = result.stdout.slice(0, index);
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Non-JSON response' }; }
  return { status, data };
}

const health = request('/health');
if (health.status !== 200 || health.data.accountModel !== 'student-coach-club-affiliations') {
  throw new Error('Production health/version preflight failed');
}

const verified = {};
const groupStudentNames = ['Aaron', 'Benjamin', 'James', 'Julian', 'Lauren', 'Sean'];
const hasFinancialFields = booking => Object.hasOwn(booking, 'price')
  || booking.participants.some(participant => ['paid', 'price', 'packageId'].some(field => Object.hasOwn(participant, field)));
for (const account of accounts) {
  const jar = join(cookieDirectory, account.key + '.txt');
  const login = request('/auth/login', 'POST', { email: account.email, password: account.password }, jar);
  if (login.status !== 200) throw new Error(account.name + ' login failed: ' + login.status + ' ' + (login.data.error || ''));
  if (login.data.user?.name !== account.name || login.data.user?.email !== account.email || login.data.user?.accountType !== account.accountType) {
    throw new Error(account.name + ' returned an unexpected identity');
  }
  if (account.accountType === 'STUDENT') {
    if (login.data.business !== null || login.data.membership !== null) throw new Error('Dominic unexpectedly received a provider workspace');
    const bookings = request('/account/bookings?businessSlug=eng-chin-an-private-coaching', 'GET', undefined, jar);
    if (bookings.status !== 200 || bookings.data.bookings?.length !== 11
      || bookings.data.bookings.some(item => item.booking?.instructorName !== 'Eng Chin An')) {
      throw new Error('Dominic private booking history is incomplete');
    }
    const alerts = request('/account/notifications', 'GET', undefined, jar);
    if (alerts.status !== 200 || alerts.data.notifications?.length !== 2) throw new Error('Dominic account alerts are incomplete');
    const forbidden = request('/workspace', 'GET', undefined, jar);
    if (forbidden.status !== 403) throw new Error('Dominic unexpectedly accessed a provider workspace');
    verified[account.key] = { accountType: account.accountType, bookings: bookings.data.bookings.length, alerts: alerts.data.notifications.length };
    continue;
  }

  const expectedMemberships = account.accountType === 'CLUB' ? 1 : 2;
  if (login.data.memberships?.length !== expectedMemberships) throw new Error(account.name + ' has the wrong number of workspaces');
  if (account.accountType === 'CLUB') {
    const workspace = request('/workspace', 'GET', undefined, jar);
    if (workspace.status !== 200 || workspace.data.business?.slug !== 'elever-badminton-academy' || workspace.data.business?.kind !== 'CLUB') {
      throw new Error('Club workspace verification failed');
    }
    if (!workspace.data.clubAccount || workspace.data.user?.instructorId !== null) throw new Error('Club account shape verification failed');
    if (workspace.data.instructors?.length !== 2 || workspace.data.students?.length !== 6 || workspace.data.bookings?.length !== 30) {
      throw new Error('Club workspace fixture counts are incorrect');
    }
    if (workspace.data.bookings.some(booking => booking.paymentRoute !== 'CLUB')) throw new Error('Club booking payment route mismatch');
    if (workspace.data.bookings.some(booking => JSON.stringify(booking.participants.map(participant => participant.name).sort()) !== JSON.stringify(groupStudentNames))) {
      throw new Error('Club group participant relationships are incorrect');
    }
    if (workspace.data.payments.some(payment => !['STUDENT_TO_CLUB', 'CLUB_TO_COACH'].includes(payment.kind))
      || workspace.data.payments.filter(payment => payment.kind === 'CLUB_TO_COACH').length !== 2) {
      throw new Error('Club payment parties are incorrect');
    }
    if (!workspace.data.bookings.some(booking => new Date(booking.startAt) < new Date())
      || !workspace.data.bookings.some(booking => new Date(booking.startAt) > new Date())) {
      throw new Error('Club fixture must include both historical and upcoming lessons');
    }
    verified[account.key] = { accountType: account.accountType, bookings: workspace.data.bookings.length, students: workspace.data.students.length };
    continue;
  }

  const clubMembership = login.data.memberships.find(item => item.business?.slug === 'elever-badminton-academy');
  const soloMembership = login.data.memberships.find(item => item.business?.kind === 'SOLO');
  if (!clubMembership?.instructorId || !soloMembership?.instructorId) throw new Error(account.name + ' affiliations are incomplete');
  let switchResult = request('/auth/switch-workspace', 'POST', { membershipId: clubMembership.id }, jar);
  if (switchResult.status !== 200) throw new Error(account.name + ' could not select Elever');
  let workspace = request('/workspace', 'GET', undefined, jar);
  if (workspace.status !== 200 || workspace.data.business?.slug !== 'elever-badminton-academy' || workspace.data.instructors?.length !== 1
    || workspace.data.bookings?.some(booking => booking.instructorId !== clubMembership.instructorId)
    || workspace.data.bookings?.some(hasFinancialFields)
    || workspace.data.services?.some(service => Object.hasOwn(service, 'price')
      || service.locations.some(location => Object.hasOwn(location, 'price')))
    || workspace.data.payments?.length !== 0 || workspace.data.packages?.length !== 0) {
    throw new Error(account.name + ' club scope verification failed');
  }
  const clubBookings = workspace.data.bookings.length;
  const forbidden = request('/staff', 'GET', undefined, jar);
  if (forbidden.status !== 403) throw new Error(account.name + ' unexpectedly accessed club-only staff controls');
  switchResult = request('/auth/switch-workspace', 'POST', { membershipId: soloMembership.id }, jar);
  if (switchResult.status !== 200) throw new Error(account.name + ' could not select private practice');
  workspace = request('/workspace', 'GET', undefined, jar);
  const privateStudent = account.key === 'loh' ? 'Carol' : 'Dominic';
  if (workspace.status !== 200 || workspace.data.business?.kind !== 'SOLO' || workspace.data.bookings?.length !== 11
    || workspace.data.bookings.some(booking => booking.paymentRoute !== 'DIRECT'
      || booking.instructorName !== account.name
      || booking.participants.length !== 1
      || booking.participants[0].name !== privateStudent)
    || workspace.data.payments.some(payment => payment.kind !== 'STUDENT_TO_COACH')) {
    throw new Error(account.name + ' private practice verification failed');
  }
  verified[account.key] = { accountType: account.accountType, clubBookings, privateBookings: workspace.data.bookings.length };
}

const publicPage = request('/public/elever-badminton-academy');
if (publicPage.status !== 200 || publicPage.data.business?.name !== 'Elever Badminton Academy'
  || publicPage.data.instructors?.length !== 2 || publicPage.data.services?.length !== 1) {
  throw new Error('Public booking page verification failed');
}

console.log(JSON.stringify({ ok: true, baseUrl, verified, publicPage: '/book/elever-badminton-academy' }, null, 2));
