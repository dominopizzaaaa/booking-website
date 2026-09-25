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
  { key: 'club', name: 'Elever Badminton Academy', username: 'elever_badminton', email: 'investors@eleverbadminton.com', password: process.env.ELEVER_CLUB_PASSWORD, accountType: 'CLUB' },
  { key: 'loh', name: 'Loh Kean Hean', username: 'loh_kean_hean', email: 'loh.kean.hean@eleverbadminton.com', password: process.env.ELEVER_LOH_PASSWORD, accountType: 'COACH' },
  { key: 'eng', name: 'Eng Chin An', username: 'eng_chin_an', email: 'eng.chin.an@eleverbadminton.com', password: process.env.ELEVER_ENG_PASSWORD, accountType: 'COACH' },
  { key: 'dominic', name: 'Dominic', username: 'elever_dominic', email: 'dominic.student@eleverbadminton.com', password: process.env.ELEVER_DOMINIC_PASSWORD, accountType: 'STUDENT' },
];
const expectedStudentNames = [
  'James', 'Julian', 'Sean', 'Lauren', 'Aaron', 'Benjamin', 'Carol', 'Dominic',
  ...Array.from({ length: 12 }, (_, index) => 'Student ' + (index + 1)),
].sort();
const expectedOctoberDates = Array.from(
  { length: 31 },
  (_, index) => '2026-10-' + String(index + 1).padStart(2, '0'),
);
const singaporeDateFormatter = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
});
function singaporeDate(value) {
  const parts = Object.fromEntries(
    singaporeDateFormatter.formatToParts(new Date(value)).map(part => [part.type, part.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day;
}
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
  const responseText = result.stdout.slice(0, index);
  let data;
  try { data = responseText ? JSON.parse(responseText) : {}; } catch { data = { error: responseText || 'Non-JSON response' }; }
  return { status, data };
}

const health = request('/health');
if (health.status !== 200 || health.data.accountModel !== 'student-coach-club-affiliations'
  || !health.data.capabilities?.simulatedStripe || !health.data.capabilities?.packageMarketplace
  || !health.data.capabilities?.venueRentals) {
  throw new Error('Production health/capability preflight failed');
}

const verified = {};
let clubJar;
for (const account of accounts) {
  const jar = join(cookieDirectory, account.key + '.txt');
  const login = request('/auth/login', 'POST', { email: account.email, password: account.password }, jar);
  if (login.status !== 200) throw new Error(account.name + ' login failed: ' + login.status + ' ' + (login.data.error || ''));
  if (login.data.user?.name !== account.name || login.data.user?.username !== account.username
    || login.data.user?.email !== account.email || login.data.user?.accountType !== account.accountType
    || JSON.stringify(login.data.user?.sports) !== JSON.stringify(['Badminton'])) {
    throw new Error(account.name + ' returned an unexpected identity, username, or sports profile');
  }

  if (account.accountType === 'STUDENT') {
    if (login.data.business !== null || login.data.membership !== null || login.data.memberships?.length !== 0) {
      throw new Error('Dominic unexpectedly received a provider workspace');
    }
    const bookings = request('/account/bookings?businessSlug=elever-badminton-academy', 'GET', undefined, jar);
    if (bookings.status !== 200 || bookings.data.bookings?.length !== 11
      || bookings.data.bookings.some(item => item.booking?.paymentRoute !== 'CLUB')) {
      throw new Error('Dominic October club booking history is incomplete');
    }
    const packages = request('/account/packages', 'GET', undefined, jar);
    if (packages.status !== 200 || packages.data.packages?.length !== 1
      || packages.data.packages[0]?.name !== 'October Class Pass'
      || packages.data.packages[0]?.offer?.name !== 'October Class Pass'
      || packages.data.packages[0]?.state !== 'ACTIVE'
      || packages.data.packages[0]?.services?.length !== 2) {
      throw new Error('Dominic purchased package snapshot is incomplete');
    }
    const offers = request('/account/package-offers?businessSlug=elever-badminton-academy', 'GET', undefined, jar);
    if (offers.status !== 200 || offers.data.offers?.length !== 3
      || !offers.data.offers.some(offer => offer.name === 'Elever Play Pass'
        && offer.serviceIds?.length === 1 && offer.rentalLocationIds?.length === 1)) {
      throw new Error('Elever package offer marketplace is incomplete');
    }
    const reservations = request('/rentals/reservations/mine', 'GET', undefined, jar);
    if (reservations.status !== 200 || reservations.data.reservations?.length !== 1
      || reservations.data.reservations[0]?.locationName !== 'Elever Kallang Courts'
      || reservations.data.reservations[0]?.paymentStatus !== 'PAID') {
      throw new Error('Dominic rental reservation history is incomplete');
    }
    const alerts = request('/account/notifications', 'GET', undefined, jar);
    if (alerts.status !== 200 || alerts.data.notifications?.length !== 2) throw new Error('Dominic account alerts are incomplete');
    const forbidden = request('/workspace', 'GET', undefined, jar);
    if (forbidden.status !== 403) throw new Error('Dominic unexpectedly accessed a provider workspace');
    verified[account.key] = {
      accountType: account.accountType, bookings: bookings.data.bookings.length, packages: packages.data.packages.length,
      reservations: reservations.data.reservations.length, alerts: alerts.data.notifications.length,
    };
    continue;
  }

  if (login.data.memberships?.length !== 1 || login.data.memberships[0]?.business?.kind !== 'CLUB'
    || login.data.memberships[0]?.business?.legacyReadOnly) {
    throw new Error(account.name + ' must have exactly one active Elever club affiliation');
  }
  const workspace = request('/workspace', 'GET', undefined, jar);
  if (workspace.status !== 200 || workspace.data.business?.slug !== 'elever-badminton-academy'
    || workspace.data.business?.kind !== 'CLUB' || workspace.data.business?.legacyReadOnly) {
    throw new Error(account.name + ' club workspace verification failed');
  }
  if (account.accountType === 'CLUB') {
    clubJar = jar;
    if (!workspace.data.clubAccount || workspace.data.user?.instructorId !== null
      || workspace.data.instructors?.length !== 2 || workspace.data.students?.length !== 20
      || workspace.data.services?.length !== 2 || workspace.data.bookings?.length !== 39) {
      throw new Error('Club workspace fixture counts are incorrect');
    }
    const studentNames = workspace.data.students.map(student => student.name).sort();
    if (JSON.stringify(studentNames) !== JSON.stringify(expectedStudentNames)) {
      throw new Error('Elever student identities are incomplete');
    }
    const bookingDates = [...new Set(workspace.data.bookings.map(booking => singaporeDate(booking.startAt)))].sort();
    const groupClasses = workspace.data.bookings.filter(booking => booking.type === 'GROUP');
    const privateClasses = workspace.data.bookings.filter(booking => booking.type === 'PRIVATE');
    if (JSON.stringify(bookingDates) !== JSON.stringify(expectedOctoberDates)
      || groupClasses.length !== 9 || privateClasses.length !== 30
      || groupClasses.some(booking => booking.serviceName !== 'Junior Performance Class'
        || booking.participants?.length !== 12)
      || privateClasses.some(booking => booking.serviceName !== '1:1 Badminton Coaching'
        || booking.participants?.length !== 1)) {
      throw new Error('Elever October 2026 class calendar is incomplete');
    }
    if (workspace.data.bookings.some(booking => booking.paymentRoute !== 'CLUB')) throw new Error('Club booking payment route mismatch');
    if (workspace.data.payments.some(payment => !['STUDENT_TO_CLUB', 'CLUB_TO_COACH'].includes(payment.kind))
      || workspace.data.payments.filter(payment => payment.kind === 'CLUB_TO_COACH').length !== 2
      || workspace.data.payments.filter(payment => payment.method === 'SIMULATED_STRIPE').length < 5) {
      throw new Error('Club payment ledger is incomplete');
    }
    if (workspace.data.integrityFlags?.length !== 1
      || !workspace.data.notifications?.some(alert => alert.type === 'INTEGRITY'
        && alert.integrityFlagId === workspace.data.integrityFlags[0].id)) {
      throw new Error('Linked historical integrity alert is incomplete');
    }
    const offers = request('/package-offers', 'GET', undefined, jar);
    if (offers.status !== 200 || offers.data.offers?.length !== 3) throw new Error('Club package offers are incomplete');
    verified[account.key] = {
      accountType: account.accountType, bookings: workspace.data.bookings.length, students: workspace.data.students.length,
      offers: offers.data.offers.length, integrityAlerts: 1,
    };
    continue;
  }

  const membership = login.data.memberships[0];
  const expectedBookings = account.key === 'loh' ? 20 : 19;
  if (!membership.instructorId || workspace.data.instructors?.length !== 1
    || workspace.data.bookings?.length !== expectedBookings
    || workspace.data.bookings?.some(booking => booking.instructorId !== membership.instructorId || booking.paymentRoute !== 'CLUB')
    || workspace.data.bookings?.some(booking => Object.hasOwn(booking, 'price'))
    || workspace.data.services?.some(service => Object.hasOwn(service, 'price')
      || service.locations.some(location => Object.hasOwn(location, 'price')))
    || workspace.data.payments?.length !== 0 || workspace.data.packages?.length !== 0
    || workspace.data.integrityFlags?.length !== 0) {
    throw new Error(account.name + ' coach-scoped club workspace is incomplete');
  }
  const forbidden = request('/staff', 'GET', undefined, jar);
  if (forbidden.status !== 403) throw new Error(account.name + ' unexpectedly accessed club-only staff controls');
  verified[account.key] = { accountType: account.accountType, clubBookings: workspace.data.bookings.length };
}

const rentals = request('/rentals', 'GET', undefined, clubJar);
if (rentals.status !== 200 || rentals.data.rentals?.length !== 1
  || rentals.data.rentals[0]?.name !== 'Elever Kallang Courts'
  || rentals.data.rentals[0]?.sport !== 'Badminton' || rentals.data.rentals[0]?.price !== 3600) {
  throw new Error('Rental marketplace listing is incomplete');
}
const rental = request('/rentals/' + encodeURIComponent(rentals.data.rentals[0].id), 'GET', undefined, clubJar);
if (rental.status !== 200 || rental.data.rental?.units?.length !== 4
  || rental.data.rental?.openingHours?.length !== 7 || rental.data.rental?.unitLabel !== 'Court'
  || rental.data.rental?.minDuration !== 60 || rental.data.rental?.maxDuration !== 120) {
  throw new Error('Rental venue configuration is incomplete');
}

const publicPage = request('/public/elever-badminton-academy');
if (publicPage.status !== 200 || publicPage.data.business?.name !== 'Elever Badminton Academy'
  || publicPage.data.instructors?.length !== 2 || publicPage.data.services?.length !== 2) {
  throw new Error('Public class booking page verification failed');
}
console.log(JSON.stringify({
  ok: true, baseUrl, month: '2026-10', verified,
  publicPage: '/book/elever-badminton-academy', rentalVenue: rentals.data.rentals[0].name,
}, null, 2));
