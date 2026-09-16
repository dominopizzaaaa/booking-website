import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rawBaseUrl = process.env.INVESTOR_DEMO_BASE_URL?.trim();
if (!rawBaseUrl) throw new Error('INVESTOR_DEMO_BASE_URL is required; no deployment is targeted by default');
const targetUrl = new URL(rawBaseUrl);
if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('INVESTOR_DEMO_BASE_URL must be an HTTP(S) origin');
if (targetUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(targetUrl.hostname)) {
  throw new Error('INVESTOR_DEMO_BASE_URL must use HTTPS unless it targets a loopback development host');
}
const baseUrl = targetUrl.origin;
const useNodeHttp = process.env.INVESTOR_DEMO_NODE_HTTP === 'true';
const allowCreate = process.env.INVESTOR_DEMO_ALLOW_CREATE === 'true';
const expectedBusinessId = process.env.INVESTOR_DEMO_EXPECTED_BUSINESS_ID?.trim() || null;
const expectedBusinessSlug = process.env.INVESTOR_DEMO_EXPECTED_BUSINESS_SLUG?.trim() || null;
if (!allowCreate && (!expectedBusinessId || !expectedBusinessSlug)) {
  throw new Error('Set the exact expected business ID and slug, or explicitly set INVESTOR_DEMO_ALLOW_CREATE=true for first-time provisioning');
}
const passwords = {
  owner: process.env.INVESTOR_DEMO_OWNER_PASSWORD,
  admin: process.env.INVESTOR_DEMO_CLUB_ADMIN_PASSWORD,
  maya: process.env.INVESTOR_DEMO_COACH_PASSWORD,
  jamie: process.env.INVESTOR_DEMO_CUSTOMER_PASSWORD,
  background: process.env.INVESTOR_DEMO_BACKGROUND_PASSWORD,
};
for (const [persona, value] of Object.entries(passwords)) {
  if (!value || value.length < 12 || Buffer.byteLength(value, 'utf8') > 72) {
    throw new Error(`The ${persona} investor-demo password must contain 12-72 UTF-8 bytes`);
  }
}
if (new Set(Object.values(passwords)).size !== Object.keys(passwords).length) {
  throw new Error('Use a different password for each featured investor-demo persona');
}
const cookieDirectory = mkdtempSync(join(tmpdir(), 'courtly-investor-demo-'));
process.on('exit', () => rmSync(cookieDirectory, { recursive: true, force: true }));

class ApiError extends Error {
  constructor(status, path, data) {
    super(`${status} ${path}: ${data?.error || JSON.stringify(data)}`);
    this.status = status;
    this.data = data;
  }
}

class Client {
  static nextId = 1;
  cookieJar = join(cookieDirectory, `cookies-${Client.nextId++}.txt`);
  cookieHeader = '';

  constructor() {
    if (!useNodeHttp) writeFileSync(this.cookieJar, '');
  }

  async request(path, method = 'GET', body) {
    if (useNodeHttp) return this.nodeRequest(path, method, body);
    const marker = '__COURTLY_HTTP_STATUS__:';
    const args = [
      '--silent', '--show-error', '--http1.1', '--connect-timeout', '15', '--max-time', '120',
      '--cookie', this.cookieJar, '--cookie-jar', this.cookieJar,
      '--request', method, '--header', 'Accept: application/json', '--header', `Origin: ${baseUrl}`,
      '--write-out', `\n${marker}%{http_code}`,
    ];
    // Mutations are deliberately never retried at the HTTP layer: a response
    // can be lost after the server commits. Rerun this reconciler instead.
    if (method === 'GET') args.splice(2, 0, '--retry', '10', '--retry-all-errors', '--retry-connrefused', '--retry-delay', '1');
    if (body !== undefined) args.push('--header', 'Content-Type: application/json', '--data-binary', '@-');
    args.push(`${baseUrl}/api${path}`);
    const result = spawnSync('curl', args, {
      encoding: 'utf8', input: body === undefined ? undefined : JSON.stringify(body), maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`Network request failed for ${path}: ${(result.stderr || '').trim() || `curl exited ${result.status}`}`);
    const markerIndex = result.stdout.lastIndexOf(`\n${marker}`);
    if (markerIndex < 0) throw new Error(`No HTTP status returned for ${path}`);
    const text = result.stdout.slice(0, markerIndex);
    const status = Number(result.stdout.slice(markerIndex + marker.length + 1));
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Non-JSON response' }; }
    if (status < 200 || status >= 300) throw new ApiError(status, path, data);
    return data;
  }

  async nodeRequest(path, method, body) {
    const attempts = method === 'GET' ? 11 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const headers = { Accept: 'application/json', Origin: baseUrl };
        if (this.cookieHeader) headers.Cookie = this.cookieHeader;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(`${baseUrl}/api${path}`, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
        });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) this.cookieHeader = setCookie.split(';', 1)[0];
        const text = await response.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Non-JSON response' }; }
        if (!response.ok) throw new ApiError(response.status, path, data);
        return data;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        lastError = error;
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    }
    throw new Error(`Network request failed for ${path}: ${lastError?.message || String(lastError)}`);
  }

  get(path) { return this.request(path); }
  post(path, body) { return this.request(path, 'POST', body); }
  patch(path, body) { return this.request(path, 'PATCH', body); }
}

const people = {
  owner: { name: 'Olivia Hart', email: 'investor.owner@courtly.example', accountType: 'OWNER', phone: '+65 8100 1001' },
  admin: { name: 'Avery Morgan', email: 'investor.admin@courtly.example', accountType: 'COACH', phone: '+65 8100 1002' },
  maya: { name: 'Maya Chen', email: 'investor.coach@courtly.example', accountType: 'COACH', phone: '+65 8100 1003' },
  daniel: { name: 'Daniel Brooks', email: 'investor.coach2@courtly.example', accountType: 'COACH', phone: '+65 8100 1004' },
  jamie: { name: 'Jamie Lee', email: 'investor.customer@courtly.example', accountType: 'CUSTOMER', phone: '+65 8200 2001' },
  ethan: { name: 'Ethan Tan', email: 'investor.customer.ethan@courtly.example', accountType: 'CUSTOMER', phone: '+65 8200 2002', parentName: 'Michelle Tan' },
  priya: { name: 'Priya Shah', email: 'investor.customer.priya@courtly.example', accountType: 'CUSTOMER', phone: '+65 8200 2003' },
  noah: { name: 'Noah Williams', email: 'investor.customer.noah@courtly.example', accountType: 'CUSTOMER', phone: '+65 8200 2004', parentName: 'Rachel Williams' },
  sofia: { name: 'Sofia Martinez', email: 'investor.customer.sofia@courtly.example', accountType: 'CUSTOMER', phone: '+65 8200 2005' },
  grace: { name: 'Grace Kim', email: 'investor.customer.grace@courtly.example', accountType: 'CUSTOMER', phone: '+65 8200 2006' },
  lucas: { name: 'Lucas Wong', email: 'investor.customer.lucas@courtly.example', accountType: 'CUSTOMER', phone: '+65 8200 2007' },
  amelia: { name: 'Amelia Chen', email: 'investor.customer.amelia@courtly.example', accountType: 'CUSTOMER', phone: '+65 8200 2008', parentName: 'Samantha Chen' },
};

const clients = Object.fromEntries(Object.keys(people).map(key => [key, new Client()]));
const preflight = await new Client().get('/health');
if (preflight.accountModel !== 'global-memberships') {
  throw new Error('The target backend is not running the global-account release. Deploy the current backend before populating the showcase.');
}

let ownerWasCreated = false;
async function ensureAccount(key) {
  const person = people[key];
  const password = passwords[key] || passwords.background;
  try {
    return await clients[key].post('/auth/login', { email: person.email, password });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    if (key === 'owner' && !allowCreate) throw new Error('The expected showcase owner does not exist or its password is incorrect; refusing to create another workspace');
  }
  const state = await clients[key].post('/auth/register', {
    accountType: person.accountType,
    ...(key === 'owner' ? { businessName: 'Courtly Investor Showcase' } : {}),
    name: person.name,
    email: person.email,
    password,
    phone: person.phone,
    ...(person.parentName ? { parentName: person.parentName } : {}),
  });
  if (key === 'owner') ownerWasCreated = true;
  return state;
}

function singaporeDate(anchor, offset) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(anchor));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + offset))
    .toISOString().slice(0, 10);
}
const iso = value => new Date(value).toISOString();

let ownerState = await ensureAccount('owner');

const owner = clients.owner;
if (ownerState.user.email !== people.owner.email || ownerState.user.accountType !== 'OWNER') throw new Error('Showcase owner identity does not match the expected global owner account');
if (!ownerWasCreated && (!expectedBusinessId || !expectedBusinessSlug)) {
  throw new Error('The showcase owner already exists. Supply its exact expected business ID and slug before any mutation');
}
const targetMembership = expectedBusinessId
  ? ownerState.memberships.find(membership => membership.businessId === expectedBusinessId)
  : ownerState.membership;
if (!targetMembership || targetMembership.role !== 'OWNER' || !targetMembership.active) throw new Error('The exact active owner membership was not found');
if (expectedBusinessSlug && targetMembership.business.slug !== expectedBusinessSlug) throw new Error('The expected business slug does not match the owner membership');
if (expectedBusinessId && targetMembership.business.id !== expectedBusinessId) throw new Error('The expected business ID does not match the owner membership');
if (ownerState.membership?.id !== targetMembership.id) ownerState = await owner.post('/auth/switch-workspace', { membershipId: targetMembership.id });
if (ownerState.business?.id !== targetMembership.business.id || ownerState.membership?.role !== 'OWNER') throw new Error('Failed to select the exact showcase owner workspace');
const businessId = ownerState.business.id;
const businessSlug = ownerState.business.slug;
const anchorDate = ownerState.membership.createdAt;
const at = (offset, time) => `${singaporeDate(anchorDate, offset)}T${time}:00+08:00`;

for (const key of Object.keys(people).filter(key => key !== 'owner')) await ensureAccount(key);

await owner.patch('/business', {
  name: 'Courtly Investor Showcase',
  ownerName: people.owner.name,
  email: people.owner.email,
  timezone: 'Asia/Singapore',
  currency: 'SGD',
  color: '#214e3e',
  tagline: 'Premium coaching, effortless operations.',
  cancellationHours: 24,
});

let staff = await owner.get('/staff');
for (const entry of [
  { key: 'admin', role: 'ADMIN' },
  { key: 'maya', role: 'COACH' },
  { key: 'daniel', role: 'COACH' },
]) {
  const existing = staff.find(member => member.email === people[entry.key].email);
  if (existing && (existing.role !== entry.role || !existing.active
    || (entry.role === 'ADMIN' ? existing.instructorId !== null : existing.instructorId === null))) {
    throw new Error(`Existing ${entry.key} staff membership does not match the expected active ${entry.role} role`);
  }
  if (!existing) {
    await owner.post('/staff', { email: people[entry.key].email, role: entry.role, instructorId: null });
  }
}
staff = await owner.get('/staff');
for (const entry of [{ key: 'admin', role: 'ADMIN' }, { key: 'maya', role: 'COACH' }, { key: 'daniel', role: 'COACH' }]) {
  const member = staff.find(candidate => candidate.email === people[entry.key].email);
  if (!member || !member.active || member.role !== entry.role
    || (entry.role === 'ADMIN' ? member.instructorId !== null : member.instructorId === null)) {
    throw new Error(`Could not verify ${entry.key} as an active ${entry.role}`);
  }
}

let workspace = await owner.get('/workspace');
const instructorByEmail = email => workspace.instructors.find(instructor => instructor.email === email);
const coachProfiles = [
  { email: people.owner.email, specialty: 'Club leadership · private tennis · performance programmes', color: '#527a5b' },
  { email: people.maya.email, specialty: 'Junior tennis · confidence · technical development', color: '#5c7f91' },
  { email: people.daniel.email, specialty: 'Badminton · footwork · doubles strategy', color: '#b1854f' },
];
for (const profile of coachProfiles) {
  const instructor = instructorByEmail(profile.email);
  if (!instructor) throw new Error(`Instructor profile missing for ${profile.email}`);
  await owner.patch(`/instructors/${instructor.id}`, { specialty: profile.specialty, color: profile.color, active: true });
}

workspace = await owner.get('/workspace');
const locationDefinitions = [
  { name: 'Courtly Performance Centre', address: '10 Stadium Boulevard, Singapore 397799', type: 'FACILITY', color: '#78915e', requiresApproval: false, travelMinutes: 15, notes: 'Flagship indoor courts, reception lounge, equipment storage and player recovery area.', active: true },
  { name: 'Marina Racquet Club', address: '8 Marina Gardens Drive, Singapore 018951', type: 'RENTED', color: '#6f91a6', requiresApproval: true, travelMinutes: 30, notes: 'Partner venue. Courtly manages the lesson; the external court must be confirmed separately.', active: true },
  { name: 'East Coast Home Court', address: 'East Coast, Singapore · exact address shared after confirmation', type: 'HOME', color: '#b08a4f', requiresApproval: false, travelMinutes: 30, notes: 'Private residential court. Access instructions are shared with confirmed guests.', active: true },
  { name: 'Online Video Studio', address: 'Online · joining link shared after confirmation', type: 'ONLINE', color: '#84739c', requiresApproval: false, travelMinutes: 0, notes: 'Remote technique review with annotated video and a written follow-up plan.', active: true },
];
for (const definition of locationDefinitions) {
  if (!workspace.locations.some(location => location.name === definition.name)) await owner.post('/locations', definition);
}
workspace = await owner.get('/workspace');
const locations = Object.fromEntries(workspace.locations.map(location => [location.name, location]));
const instructors = {
  owner: instructorByEmail(people.owner.email),
  maya: instructorByEmail(people.maya.email),
  daniel: instructorByEmail(people.daniel.email),
};
// Refresh IDs from the latest workspace object.
for (const [key, personKey] of [['owner', 'owner'], ['maya', 'maya'], ['daniel', 'daniel']]) {
  instructors[key] = workspace.instructors.find(instructor => instructor.email === people[personKey].email);
}

const serviceDefinitions = [
  { name: 'Private Tennis Coaching', description: 'A focused one-to-one session built around technique, movement and match goals.', category: 'Tennis', type: 'PRIVATE', duration: 60, price: 12000, capacity: 1, bufferMinutes: 10, noticeHours: 2, color: '#78915e', locations: [
    { locationId: locations['Courtly Performance Centre'].id, price: 12000, duration: 60, instructorIds: [instructors.owner.id, instructors.maya.id] },
    { locationId: locations['East Coast Home Court'].id, price: 14500, duration: 60, instructorIds: [instructors.maya.id] },
  ] },
  { name: 'Junior Tennis Academy', description: 'Small-group coaching for young players, with movement, rally skills and confidence-building games.', category: 'Tennis', type: 'GROUP', duration: 60, price: 4800, capacity: 8, bufferMinutes: 10, noticeHours: 2, color: '#6f91a6', locations: [
    { locationId: locations['Courtly Performance Centre'].id, price: 4800, duration: 60, instructorIds: [instructors.maya.id] },
  ] },
  { name: 'Badminton Performance Squad', description: 'Footwork, serve patterns and doubles decision-making in a focused squad environment.', category: 'Badminton', type: 'GROUP', duration: 90, price: 6500, capacity: 6, bufferMinutes: 15, noticeHours: 2, color: '#b08a4f', locations: [
    { locationId: locations['Marina Racquet Club'].id, price: 6500, duration: 90, instructorIds: [instructors.daniel.id] },
    { locationId: locations['Courtly Performance Centre'].id, price: 5800, duration: 75, instructorIds: [instructors.daniel.id] },
  ] },
  { name: 'Corporate Team Clinic', description: 'A polished team session combining coaching, friendly competition and an easy social format.', category: 'Corporate', type: 'GROUP', duration: 90, price: 9000, capacity: 12, bufferMinutes: 15, noticeHours: 4, color: '#527a5b', locations: [
    { locationId: locations['Courtly Performance Centre'].id, price: 9000, duration: 90, instructorIds: [instructors.owner.id, instructors.maya.id] },
  ] },
  { name: 'Court & Equipment Rental', description: 'Reserve a court session with rackets and balls prepared for your arrival. A customer account is required.', category: 'Venue', type: 'PRIVATE', duration: 60, price: 5000, capacity: 1, bufferMinutes: 10, noticeHours: 2, color: '#84739c', locations: [
    { locationId: locations['Courtly Performance Centre'].id, price: 5000, duration: 60, instructorIds: [instructors.owner.id] },
    { locationId: locations['Marina Racquet Club'].id, price: 7200, duration: 90, instructorIds: [instructors.owner.id] },
  ] },
  { name: 'Online Video Analysis', description: 'A remote technique review with annotated clips and a practical training plan.', category: 'Online', type: 'PRIVATE', duration: 45, price: 7000, capacity: 1, bufferMinutes: 0, noticeHours: 2, color: '#5c7f91', locations: [
    { locationId: locations['Online Video Studio'].id, price: 7000, duration: 45, instructorIds: [instructors.maya.id] },
  ] },
];
for (const definition of serviceDefinitions) {
  if (!workspace.services.some(service => service.name === definition.name)) await owner.post('/services', { ...definition, active: true });
}
workspace = await owner.get('/workspace');
const services = Object.fromEntries(workspace.services.map(service => [service.name, service]));

const offeredPairs = new Set();
for (const service of workspace.services) {
  for (const mapping of service.locations) for (const instructorId of mapping.instructorIds) offeredPairs.add(`${instructorId}|${mapping.locationId}`);
}
for (const pair of offeredPairs) {
  const [instructorId, locationId] = pair.split('|');
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    if (!workspace.availability.some(block => block.instructorId === instructorId && block.locationId === locationId && block.dayOfWeek === dayOfWeek && block.startTime === '07:00')) {
      await owner.post('/availability', { instructorId, locationId, dayOfWeek, startTime: '07:00', endTime: '21:00' });
    }
  }
}

workspace = await owner.get('/workspace');
const customerNotes = {
  jamie: 'Investor-demo player profile. Prefers weekday mornings and package bookings.',
  ethan: 'Junior player. Parent collects after class. Working on rally confidence.',
  priya: 'Returning to tennis and preparing for a social doubles league.',
  noah: 'Junior player. Enjoys movement games and team challenges.',
  sofia: 'Coordinates corporate wellness sessions for her team.',
  grace: 'Competitive badminton player focused on doubles rotation.',
  lucas: 'Plays across tennis and badminton; prefers evening sessions.',
  amelia: 'Junior player. Left-handed and building serve consistency.',
};
for (const key of ['jamie', 'ethan', 'priya', 'noah', 'sofia', 'grace', 'lucas', 'amelia']) {
  const person = people[key];
  if (!workspace.customers.some(customer => customer.email === person.email)) {
    await owner.post('/customers', { name: person.name, email: person.email, phone: person.phone, parentName: person.parentName || '', notes: customerNotes[key] });
  }
}
workspace = await owner.get('/workspace');
const customers = Object.fromEntries(workspace.customers.map(customer => [customer.email, customer]));
const customer = key => customers[people[key].email];

const packageDefinitions = [
  { key: 'jamie', name: 'Private Performance · 10 lessons', service: 'Private Tennis Coaching', totalCredits: 10, price: 100000, paid: true },
  { key: 'ethan', name: 'Junior Academy · 8 sessions', service: 'Junior Tennis Academy', totalCredits: 8, price: 33600, paid: true },
  { key: 'grace', name: 'Badminton Squad · 8 sessions', service: 'Badminton Performance Squad', totalCredits: 8, price: 44000, paid: true },
  { key: 'priya', name: 'Flexible Club Pass · 5 credits', service: null, totalCredits: 5, price: 52000, paid: false },
  { key: 'lucas', name: 'Flexible Club Pass · 10 credits', service: null, totalCredits: 10, price: 95000, paid: false },
  { key: 'sofia', name: 'Corporate Wellness Bundle · 6 sessions', service: 'Corporate Team Clinic', totalCredits: 6, price: 48000, paid: false },
];
for (const definition of packageDefinitions) {
  if (!workspace.packages.some(pkg => pkg.name === definition.name && pkg.customerId === customer(definition.key).id)) {
    await owner.post('/packages', {
      customerId: customer(definition.key).id, name: definition.name,
      serviceId: definition.service ? services[definition.service].id : null,
      totalCredits: definition.totalCredits, price: definition.price,
      expiresAt: `${singaporeDate(anchorDate, 180)}T23:59:59+08:00`, paid: definition.paid,
    });
  }
}
workspace = await owner.get('/workspace');
const packageFor = key => workspace.packages.find(pkg => pkg.customerId === customer(key).id);

function mergeBookings(result) {
  for (const booking of result.bookings) {
    const index = workspace.bookings.findIndex(candidate => candidate.id === booking.id);
    if (index >= 0) workspace.bookings[index] = booking;
    else workspace.bookings.push(booking);
  }
}
async function ensureBooking({ service, coach, location, startAt, customerKey, repeatWeeks = 1, packageId, notes = '', address = '' }) {
  const target = iso(startAt);
  const serviceId = services[service].id;
  const instructorId = instructors[coach].id;
  const locationId = locations[location].id;
  const existing = workspace.bookings.find(booking => booking.serviceId === serviceId && booking.instructorId === instructorId
    && booking.locationId === locationId && booking.startAt === target
    && booking.participants.some(participant => participant.email === people[customerKey].email));
  if (existing) return existing;
  const result = await owner.post('/bookings', {
    serviceId, instructorId, locationId, startAt, customerId: customer(customerKey).id,
    repeatWeeks, ...(packageId ? { packageId } : {}), notes, address,
  });
  mergeBookings(result);
  return result.bookings[0];
}

const schedule = [
  { service: 'Private Tennis Coaching', coach: 'owner', location: 'Courtly Performance Centre', startAt: at(2, '09:00'), customerKey: 'jamie', repeatWeeks: 4, packageId: packageFor('jamie').id, notes: 'Recurring performance block · serve and first-ball patterns.' },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(2, '11:00'), customerKey: 'ethan', packageId: packageFor('ethan').id, notes: 'Junior academy group · bring water and a junior racket.' },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(2, '11:00'), customerKey: 'noah' },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(2, '11:00'), customerKey: 'amelia' },
  { service: 'Badminton Performance Squad', coach: 'daniel', location: 'Marina Racquet Club', startAt: at(2, '15:00'), customerKey: 'grace', packageId: packageFor('grace').id },
  { service: 'Badminton Performance Squad', coach: 'daniel', location: 'Marina Racquet Club', startAt: at(2, '15:00'), customerKey: 'lucas', packageId: packageFor('lucas').id },
  { service: 'Badminton Performance Squad', coach: 'daniel', location: 'Marina Racquet Club', startAt: at(2, '15:00'), customerKey: 'priya', packageId: packageFor('priya').id },
  { service: 'Court & Equipment Rental', coach: 'owner', location: 'Courtly Performance Centre', startAt: at(2, '18:00'), customerKey: 'jamie', notes: 'Court rental with two rackets and a fresh tube of balls prepared.' },
  { service: 'Private Tennis Coaching', coach: 'maya', location: 'East Coast Home Court', startAt: at(3, '08:00'), customerKey: 'priya', packageId: packageFor('priya').id },
  { service: 'Corporate Team Clinic', coach: 'owner', location: 'Courtly Performance Centre', startAt: at(3, '10:30'), customerKey: 'sofia', packageId: packageFor('sofia').id, notes: 'Leadership offsite · welcome briefing and team rotations.' },
  { service: 'Corporate Team Clinic', coach: 'owner', location: 'Courtly Performance Centre', startAt: at(3, '10:30'), customerKey: 'lucas', packageId: packageFor('lucas').id },
  { service: 'Corporate Team Clinic', coach: 'owner', location: 'Courtly Performance Centre', startAt: at(3, '10:30'), customerKey: 'jamie' },
  { service: 'Online Video Analysis', coach: 'maya', location: 'Online Video Studio', startAt: at(3, '14:00'), customerKey: 'jamie', notes: 'Review forehand clips and send a three-point practice plan.' },
  { service: 'Court & Equipment Rental', coach: 'owner', location: 'Marina Racquet Club', startAt: at(3, '17:00'), customerKey: 'sofia', notes: 'Cancelled showcase booking.' },
  { service: 'Private Tennis Coaching', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(4, '09:00'), customerKey: 'jamie', packageId: packageFor('jamie').id },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(4, '11:00'), customerKey: 'ethan', packageId: packageFor('ethan').id },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(4, '11:00'), customerKey: 'noah' },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(4, '11:00'), customerKey: 'amelia' },
  { service: 'Badminton Performance Squad', coach: 'daniel', location: 'Marina Racquet Club', startAt: at(4, '15:00'), customerKey: 'grace', packageId: packageFor('grace').id },
  { service: 'Badminton Performance Squad', coach: 'daniel', location: 'Marina Racquet Club', startAt: at(4, '15:00'), customerKey: 'lucas', packageId: packageFor('lucas').id },
  { service: 'Private Tennis Coaching', coach: 'owner', location: 'Courtly Performance Centre', startAt: at(5, '08:30'), customerKey: 'sofia' },
  { service: 'Corporate Team Clinic', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(5, '11:00'), customerKey: 'priya', packageId: packageFor('priya').id },
  { service: 'Corporate Team Clinic', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(5, '11:00'), customerKey: 'grace' },
  { service: 'Corporate Team Clinic', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(5, '11:00'), customerKey: 'lucas', packageId: packageFor('lucas').id },
  { service: 'Online Video Analysis', coach: 'maya', location: 'Online Video Studio', startAt: at(5, '16:00'), customerKey: 'jamie' },
  { service: 'Court & Equipment Rental', coach: 'owner', location: 'Marina Racquet Club', startAt: at(6, '09:30'), customerKey: 'jamie', notes: 'Partner venue approval pending.' },
  { service: 'Badminton Performance Squad', coach: 'daniel', location: 'Courtly Performance Centre', startAt: at(6, '14:00'), customerKey: 'grace', packageId: packageFor('grace').id },
  { service: 'Badminton Performance Squad', coach: 'daniel', location: 'Courtly Performance Centre', startAt: at(6, '14:00'), customerKey: 'sofia' },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(7, '10:00'), customerKey: 'ethan', packageId: packageFor('ethan').id },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(7, '10:00'), customerKey: 'noah' },
  { service: 'Junior Tennis Academy', coach: 'maya', location: 'Courtly Performance Centre', startAt: at(7, '10:00'), customerKey: 'amelia' },
  { service: 'Private Tennis Coaching', coach: 'owner', location: 'Courtly Performance Centre', startAt: at(7, '14:00'), customerKey: 'jamie', packageId: packageFor('jamie').id },
];
const created = [];
for (const definition of schedule) created.push({ definition, booking: await ensureBooking(definition) });

const cancelled = created.find(item => item.definition.customerKey === 'sofia' && item.definition.startAt === at(3, '17:00')).booking;
if (cancelled.status !== 'CANCELLED') await owner.patch(`/bookings/${cancelled.id}`, { status: 'CANCELLED' });
const approved = created.find(item => item.definition.customerKey === 'grace' && item.definition.startAt === at(2, '15:00')).booking;
if (approved.status === 'PENDING') await owner.patch(`/bookings/${approved.id}`, { status: 'CONFIRMED', notes: 'Partner court confirmed by the club administrator.' });

workspace = await owner.get('/workspace');
async function ensurePayment({ marker, customerKey, booking, amount, method, note }) {
  if (workspace.payments.some(payment => payment.note.includes(marker))) return;
  const participant = booking ? workspace.bookings.find(item => item.id === booking.id)?.participants.find(item => item.email === people[customerKey].email) : null;
  await owner.post('/payments', {
    customerId: customer(customerKey).id,
    ...(booking ? { bookingId: booking.id, participantId: participant.id } : {}),
    amount, method, note: `${marker} · ${note}`,
  });
}
const noahJunior = created.find(item => item.definition.customerKey === 'noah' && item.definition.startAt === at(2, '11:00')).booking;
const jamieVideo = created.find(item => item.definition.customerKey === 'jamie' && item.definition.startAt === at(3, '14:00')).booking;
const sofiaPrivate = created.find(item => item.definition.customerKey === 'sofia' && item.definition.startAt === at(5, '08:30')).booking;
await ensurePayment({ marker: 'INV-DEMO-PAY-001', customerKey: 'noah', booking: noahJunior, amount: 4800, method: 'BANK_TRANSFER', note: 'PayNow lesson payment' });
await ensurePayment({ marker: 'INV-DEMO-PAY-002', customerKey: 'jamie', booking: jamieVideo, amount: 7000, method: 'OTHER', note: 'Card terminal receipt' });
await ensurePayment({ marker: 'INV-DEMO-PAY-003', customerKey: 'sofia', booking: sofiaPrivate, amount: 12000, method: 'BANK_TRANSFER', note: 'Private coaching payment' });
await ensurePayment({ marker: 'INV-DEMO-PAY-004', customerKey: 'sofia', amount: 25000, method: 'BANK_TRANSFER', note: 'Unallocated corporate event deposit' });

const verification = {};
for (const key of ['owner', 'admin', 'maya', 'jamie']) {
  const check = new Client();
  const auth = await check.post('/auth/login', { email: people[key].email, password: passwords[key] });
  if (key === 'jamie') {
    if (auth.user.accountType !== 'CUSTOMER' || auth.membership !== null) throw new Error('Customer login returned provider access');
    const history = await check.get(`/account/bookings?businessSlug=${encodeURIComponent(ownerState.business.slug)}`);
    try { await check.get('/workspace'); throw new Error('Customer unexpectedly accessed a provider workspace'); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 403) throw error; }
    verification.customer = { accountType: auth.user.accountType, bookings: history.bookings.length };
  } else {
    const view = await check.get('/workspace');
    const expectedRole = key === 'owner' ? 'OWNER' : key === 'admin' ? 'ADMIN' : 'COACH';
    if (view.business.id !== businessId || view.user.role !== expectedRole) throw new Error(`${key} login returned the wrong workspace role`);
    if (key === 'admin') {
      try { await check.get('/staff'); throw new Error('Club admin unexpectedly accessed owner-only staff controls'); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 403) throw error; }
    }
    if (key === 'maya' && (view.user.instructorId !== instructors.maya.id || view.instructors.length !== 1
      || view.instructors[0].id !== instructors.maya.id || view.bookings.some(booking => booking.instructorId !== instructors.maya.id)
      || view.packages.length !== 0 || view.payments.length !== 0)) {
      throw new Error('Coach login was not scoped to the linked coach data');
    }
    verification[key === 'maya' ? 'coach' : key] = { role: view.user.role, bookings: view.bookings.length, customers: view.customers.length };
  }
}

const publicPage = await owner.get(`/public/${encodeURIComponent(ownerState.business.slug)}`);
const finalWorkspace = await owner.get('/workspace');
console.log(JSON.stringify({
  baseUrl,
  business: { id: finalWorkspace.business.id, name: finalWorkspace.business.name, slug: finalWorkspace.business.slug, isDemo: finalWorkspace.business.isDemo },
  cleanup: { method: 'Delete this exact workspace from the platform admin console', businessId, businessSlug },
  counts: {
    staff: (await owner.get('/staff')).length,
    instructors: finalWorkspace.instructors.length, locations: finalWorkspace.locations.length, services: finalWorkspace.services.length,
    customers: finalWorkspace.customers.length, packages: finalWorkspace.packages.length, bookings: finalWorkspace.bookings.length,
    participants: finalWorkspace.bookings.reduce((sum, booking) => sum + booking.participants.length, 0),
    payments: finalWorkspace.payments.length, notifications: finalWorkspace.notifications.length,
    publicServices: publicPage.services.length, publicCoaches: publicPage.instructors.length,
  },
  statuses: Object.fromEntries(['CONFIRMED', 'PENDING', 'CANCELLED', 'COMPLETED'].map(status => [status, finalWorkspace.bookings.filter(booking => booking.status === status).length])),
  verification,
}, null, 2));
