import express, { type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { requireAuth, requireWorkspace } from '../src/auth.js';
import { bookingsRouter } from '../src/bookings.js';
import { crudRouter } from '../src/crud.js';
import { effectiveClubPermissions, hasClubPermission, HttpError } from '../src/http.js';
import { clubStaffAccessRouter, clubStaffInvitationRouter } from '../src/staff-access.js';
import { workspaceRouter } from '../src/workspace.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { prisma, requireTestEmail, TestTenants, verifyTestDatabase } from './fixtures.js';

const testApp = express();
testApp.use(express.json());
testApp.use(cookieParser());
testApp.use('/api', requireAuth, clubStaffInvitationRouter);
testApp.use('/api', requireAuth, requireWorkspace, workspaceRouter, bookingsRouter, crudRouter, clubStaffAccessRouter);
testApp.use(((error, _req, res, _next) => {
  if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
  if (error instanceof ZodError) { res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid input' }); return; }
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
}) satisfies ErrorRequestHandler);

beforeAll(verifyTestDatabase, 15_000);
afterAll(async () => { await prisma.$disconnect(); });

describe.sequential('named club staff access', () => {
  let tenants: TestTenants;
  let fixture: Awaited<ReturnType<typeof staffFixture>>;

  async function staffFixture() {
    const id = `courtly-staff-test-${randomUUID()}`;
    tenants.own(id);
    const { business, user, membership } = await prisma.$transaction(async tx => {
      const business = await tx.business.create({ data: {
        id, slug: id, name: 'Staff Test Club', ownerName: 'Club Owner', email: `${id}@example.test`,
      } });
      const user = requireTestEmail(await tx.user.create({ data: {
        name: 'Staff Test Club', legalName: 'Staff Test Club', username: `club_${id.slice(-12).replace(/-/g, '_')}`,
        email: `${id}-club@example.test`, passwordHash: 'not-used', accountType: 'CLUB',
      } }));
      const membership = await tx.membership.create({ data: { userId: user.id, businessId: business.id } });
      return { business, user, membership };
    });
    tenants.ownUser(user.id);
    const session = await localSession(user.id, membership.id);
    return { business, user, membership, ...session };
  }

  async function localAccount(overrides: { name: string; email: string; accountType?: string }) {
    const identity = randomUUID().replace(/-/g, '');
    const user = requireTestEmail(await prisma.user.create({ data: {
      name: overrides.name, legalName: overrides.name, email: overrides.email, username: `staff_${identity.slice(0, 18)}`,
      passwordHash: 'not-used', accountType: overrides.accountType ?? 'STUDENT',
    } }));
    tenants.ownUser(user.id);
    return user;
  }

  async function localSession(userId: string, activeMembershipId: string | null = null) {
    const token = randomBytes(32).toString('base64url');
    const session = await prisma.authSession.create({ data: {
      id: createHash('sha256').update(token).digest('hex'), userId, activeMembershipId,
      recentAuthAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    return { session, cookie: `${config.sessionCookie}=${token}` };
  }

  async function grantCustomAccess(person: { id: string; email: string }, permissions: string[]) {
    const invitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: person.email, accessLevel: 'CUSTOM', permissions }).expect(201);
    const session = await localSession(person.id);
    const accepted = await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', session.cookie)
      .send({ invitationId: invitation.body.invitation.id }).expect(200);
    return { ...session, accessId: accepted.body.staffAccess.id as string };
  }

  beforeEach(async () => {
    tenants = new TestTenants();
    fixture = await staffFixture();
  });

  afterEach(async () => { await tenants.cleanup(); });

  it('invites a named account with a snapshotted preset and records attribution', async () => {
    const person = await localAccount({ name: 'Front Desk Person', email: `front-desk-${randomUUID()}@example.test` });
    const response = await request(testApp)
      .post('/api/staff-access/invitations')
      .set('Cookie', fixture.cookie)
      .send({ email: person.email, accessLevel: 'FRONT_DESK' })
      .expect(201);

    expect(response.body.invitation).toMatchObject({
      email: person.email, accessLevel: 'FRONT_DESK', status: 'PENDING',
      permissions: expect.arrayContaining(['BOOKINGS_MANAGE', 'STUDENTS_MANAGE', 'PAYMENTS_RECORD']),
    });
    const invitePath = new URL(response.body.invitePath, 'https://courtly.example');
    expect(invitePath.pathname).toBe('/signup');
    expect(invitePath.searchParams.get('next')).toMatch(/^\/account\?staffInvite=.{20,}$/u);
    expect(response.body).not.toHaveProperty('token');

    const event = await prisma.businessAuditEvent.findFirstOrThrow({
      where: { businessId: fixture.business.id, action: 'STAFF_INVITATION_CREATED' },
    });
    expect(event).toMatchObject({
      actorUserId: fixture.user.id, actorName: fixture.user.name, actorAccessKind: 'CLUB_ACCOUNT',
      resourceType: 'ClubStaffInvitation', resourceId: response.body.invitation.id,
    });
  });

  it('accepts only with the bound personal account, preserves account type, and selects staff mode', async () => {
    const person = await localAccount({ name: 'Finance Person', email: `finance-${randomUUID()}@example.test`, accountType: 'COACH' });
    const wrong = await localAccount({ name: 'Wrong Person', email: `wrong-${randomUUID()}@example.test` });
    const invitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: person.email, accessLevel: 'FINANCE' }).expect(201);
    const invitationId = invitation.body.invitation.id as string;
    const wrongSession = await localSession(wrong.id);
    await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', wrongSession.cookie)
      .send({ invitationId }).expect(403);

    const personSession = await localSession(person.id);
    const accepted = await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', personSession.cookie)
      .send({ invitationId }).expect(200);
    expect(accepted.body.staffAccess).toMatchObject({
      userId: person.id, accountType: 'COACH', accessLevel: 'FINANCE', active: true,
      permissions: expect.arrayContaining(['PAYMENTS_VIEW', 'PAYMENTS_REVERSE', 'PAYOUTS_RECORD']),
    });

    const [unchanged, session, membershipCount, event] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: person.id } }),
      prisma.authSession.findUniqueOrThrow({ where: { id: personSession.session.id } }),
      prisma.membership.count({ where: { userId: person.id, businessId: fixture.business.id } }),
      prisma.businessAuditEvent.findFirstOrThrow({ where: { businessId: fixture.business.id, action: 'STAFF_INVITATION_ACCEPTED' } }),
    ]);
    expect(unchanged.accountType).toBe('COACH');
    expect(membershipCount).toBe(0);
    expect(session.activeMembershipId).toBeNull();
    expect(session.activeStaffAccessId).toBe(accepted.body.staffAccess.id);
    expect(event).toMatchObject({ actorUserId: person.id, actorAccessKind: 'CLUB_STAFF', actorAccessLevel: 'FINANCE' });
  });

  it('loads the selected staff workspace and enforces its fine-grained route permissions', async () => {
    const [person, catalog] = await Promise.all([
      localAccount({ name: 'Catalog Reader', email: `catalog-${randomUUID()}@example.test` }),
      prisma.$transaction(async tx => {
        const instructor = await tx.instructor.create({ data: {
          businessId: fixture.business.id, name: 'Visible Coach', initials: 'VC',
        } });
        const location = await tx.location.create({ data: {
          businessId: fixture.business.id, name: 'Visible Court',
        } });
        const service = await tx.service.create({ data: {
          businessId: fixture.business.id, name: 'Visible Class', type: 'PRIVATE', capacity: 1,
          locations: { create: {
            locationId: location.id, price: 8_000, duration: 60,
            instructors: { create: { instructorId: instructor.id } },
          } },
        } });
        return { instructor, location, service };
      }),
    ]);
    const invitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: person.email, accessLevel: 'CUSTOM', permissions: ['CATALOG_VIEW'] });
    expect(invitation.status, invitation.text).toBe(201);
    const personSession = await localSession(person.id);
    const accepted = await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', personSession.cookie)
      .send({ invitationId: invitation.body.invitation.id }).expect(200);

    const workspace = await request(testApp).get('/api/workspace').set('Cookie', personSession.cookie).expect(200);
    expect(workspace.body).toMatchObject({
      business: { id: fixture.business.id },
      user: { id: person.id, accountType: 'STUDENT', instructorId: null },
      membership: null, memberships: [], accessMode: 'STAFF', permissions: ['CATALOG_VIEW'],
      staffAccess: { id: accepted.body.staffAccess.id, businessId: fixture.business.id, accessLevel: 'CUSTOM' },
      services: [{ id: catalog.service.id }], locations: [{ id: catalog.location.id }],
      instructors: [{ id: catalog.instructor.id }], bookings: [], students: [], packages: [], payments: [],
    });
    expect(workspace.body.instructors[0]).not.toHaveProperty('email');
    expect(workspace.body.instructors[0]).not.toHaveProperty('specialty');
    expect(workspace.body.services[0]).not.toHaveProperty('price');

    const services = await request(testApp).get('/api/services').set('Cookie', personSession.cookie).expect(200);
    expect(services.body).toEqual([expect.objectContaining({ id: catalog.service.id, name: 'Visible Class' })]);
    await request(testApp).post('/api/services').set('Cookie', personSession.cookie).send({}).expect(403, {
      error: 'This workspace requires catalog manage permission',
    });
    await request(testApp).get('/api/bookings').set('Cookie', personSession.cookie).expect(403, {
      error: 'This workspace requires bookings view permission',
    });
    await request(testApp).get('/api/staff-access').set('Cookie', personSession.cookie).expect(403, {
      error: 'Staff administration permission is required',
    });
    await request(testApp).get('/api/operations/inbox').set('Cookie', personSession.cookie).expect(403, {
      error: 'This workspace requires bookings, payments, or rentals view permission',
    });
  });

  it('treats every management permission as its matching view permission', () => {
    const implications = [
      ['BOOKINGS_MANAGE', 'BOOKINGS_VIEW'], ['STUDENTS_MANAGE', 'STUDENTS_VIEW'],
      ['CATALOG_MANAGE', 'CATALOG_VIEW'], ['ROSTER_MANAGE', 'ROSTER_VIEW'],
      ['PACKAGES_MANAGE', 'PACKAGES_VIEW'], ['PAYMENTS_RECORD', 'PAYMENTS_VIEW'],
      ['PAYMENTS_REVERSE', 'PAYMENTS_VIEW'], ['PAYOUTS_RECORD', 'PAYMENTS_VIEW'],
      ['INTEGRITY_REVIEW', 'INTEGRITY_VIEW'], ['RENTALS_MANAGE', 'RENTALS_VIEW'],
      ['RENTALS_MANAGE', 'CATALOG_MANAGE'],
    ] as const;
    for (const [manage, view] of implications) {
      const auth = {
        user: { accountType: 'STUDENT' },
        business: { id: fixture.business.id, kind: 'CLUB', legacyReadOnly: false },
        staffAccess: { active: true, businessId: fixture.business.id, permissions: [manage] },
      } as any;
      expect(hasClubPermission(auth, view), `${manage} should imply ${view}`).toBe(true);
      expect(effectiveClubPermissions([manage])).toContain(view);
    }
  });

  it('expands chained permission implications transitively', () => {
    const effective = effectiveClubPermissions(['RENTALS_MANAGE']);
    expect(effective).toEqual(expect.arrayContaining([
      'RENTALS_MANAGE', 'RENTALS_VIEW', 'CATALOG_MANAGE', 'CATALOG_VIEW',
    ]));

    const auth = {
      user: { accountType: 'STUDENT' },
      business: { id: fixture.business.id, kind: 'CLUB', legacyReadOnly: false },
      staffAccess: { active: true, businessId: fixture.business.id, permissions: ['RENTALS_MANAGE'] },
    } as any;
    expect(hasClubPermission(auth, 'CATALOG_VIEW')).toBe(true);
  });

  it('returns only scheduling references for booking-only staff and gates all prices behind payment view', async () => {
    const [bookingReader, bookingFinance, catalog] = await Promise.all([
      localAccount({ name: 'Booking Reader', email: `booking-${randomUUID()}@example.test` }),
      localAccount({ name: 'Booking Finance', email: `booking-finance-${randomUUID()}@example.test` }),
      prisma.$transaction(async tx => {
        const instructor = await tx.instructor.create({ data: {
          businessId: fixture.business.id, name: 'Private Coach', initials: 'PC', color: 'purple',
          email: 'private-coach@example.test', specialty: 'Private specialty', rescheduleNoticeHours: 36,
        } });
        const location = await tx.location.create({ data: {
          businessId: fixture.business.id, name: 'Private Court', address: '1 Scheduling Way',
          type: 'FACILITY', color: 'blue', requiresApproval: true, travelMinutes: 25,
          notes: 'Secret access notes', source: 'GOOGLE_MAPS', placeId: 'secret-place-id',
          mapsUrl: 'https://maps.example.test/private', latitude: 1.3, longitude: 103.8,
        } });
        const service = await tx.service.create({ data: {
          businessId: fixture.business.id, name: 'Private Class', description: 'Catalog-only copy',
          category: 'Tennis', type: 'PRIVATE', duration: 60, price: 12_000, capacity: 1,
          bufferMinutes: 15, noticeHours: 12, color: 'sage',
          locations: { create: {
            locationId: location.id, price: 13_500, duration: 75,
            instructors: { create: { instructorId: instructor.id } },
          } },
        } });
        return { instructor, location, service };
      }),
    ]);
    // These invitations both append to the same club audit stream. Create them
    // sequentially so Serializable transaction retries are not the subject of
    // this serializer-focused test.
    const readerSession = await grantCustomAccess(bookingReader, ['BOOKINGS_MANAGE']);
    const financeSession = await grantCustomAccess(bookingFinance, ['BOOKINGS_VIEW', 'PAYMENTS_VIEW']);

    const reader = (await request(testApp).get('/api/workspace').set('Cookie', readerSession.cookie).expect(200)).body;
    expect(reader.permissions).toEqual(expect.arrayContaining(['BOOKINGS_MANAGE', 'BOOKINGS_VIEW']));
    expect(reader.instructors).toEqual([{ id: catalog.instructor.id, name: 'Private Coach', active: true }]);
    expect(reader.locations).toEqual([{
      id: catalog.location.id, name: 'Private Court', type: 'FACILITY', requiresApproval: true,
      travelMinutes: 25, active: true,
    }]);
    expect(reader.services).toEqual([{
      id: catalog.service.id, name: 'Private Class', type: 'PRIVATE', duration: 60, capacity: 1, active: true,
      locations: [{ locationId: catalog.location.id, duration: 75, instructorIds: [catalog.instructor.id] }],
    }]);
    expect(JSON.stringify(reader)).not.toContain('private-coach@example.test');
    expect(JSON.stringify(reader)).not.toContain('Private specialty');
    expect(JSON.stringify(reader)).not.toContain('Secret access notes');
    expect(JSON.stringify(reader)).not.toContain('secret-place-id');
    expect(JSON.stringify(reader)).not.toContain('maps.example.test');
    expect(JSON.stringify(reader)).not.toContain('Catalog-only copy');
    expect(JSON.stringify(reader)).not.toContain('12000');
    expect(JSON.stringify(reader)).not.toContain('13500');

    const finance = (await request(testApp).get('/api/workspace').set('Cookie', financeSession.cookie).expect(200)).body;
    expect(finance.services[0]).toMatchObject({ price: 12_000, locations: [{ price: 13_500 }] });
    expect(finance.instructors[0]).not.toHaveProperty('email');
    expect(finance.locations[0]).not.toHaveProperty('notes');

    const packageManager = await localAccount({
      name: 'Package Manager', email: `package-manager-${randomUUID()}@example.test`,
    });
    const packageSession = await grantCustomAccess(packageManager, ['PACKAGES_MANAGE']);
    const packageWorkspace = (await request(testApp).get('/api/workspace')
      .set('Cookie', packageSession.cookie).expect(200)).body;
    expect(packageWorkspace.services).toEqual([]);
    expect(packageWorkspace.locations).toEqual([]);
    expect(packageWorkspace.packageScopes).toEqual({
      services: [{ id: catalog.service.id, name: catalog.service.name, active: true }],
      rentalLocations: [],
    });
    expect(JSON.stringify(packageWorkspace.packageScopes)).not.toContain('Catalog-only copy');
    expect(JSON.stringify(packageWorkspace.packageScopes)).not.toContain('12000');
  });

  it('updates and revokes access while clearing every selected staff session', async () => {
    const person = await localAccount({ name: 'Operations Person', email: `operations-${randomUUID()}@example.test` });
    const invitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: person.email, accessLevel: 'OPERATIONS' }).expect(201);
    const personSession = await localSession(person.id);
    const accepted = await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', personSession.cookie)
      .send({ invitationId: invitation.body.invitation.id }).expect(200);
    const accessId = accepted.body.staffAccess.id as string;

    const updated = await request(testApp).patch(`/api/staff-access/${accessId}`).set('Cookie', fixture.cookie)
      .send({ accessLevel: 'CUSTOM', permissions: ['BOOKINGS_VIEW', 'BOOKINGS_MANAGE'] }).expect(200);
    expect(updated.body).toMatchObject({ accessLevel: 'CUSTOM', permissions: ['BOOKINGS_MANAGE', 'BOOKINGS_VIEW'] });

    await request(testApp).delete(`/api/staff-access/${accessId}`).set('Cookie', fixture.cookie).expect(200, { ok: true });
    const [access, selectedSessions, events] = await Promise.all([
      prisma.clubStaffAccess.findUniqueOrThrow({ where: { id: accessId } }),
      prisma.authSession.count({ where: { activeStaffAccessId: accessId } }),
      prisma.businessAuditEvent.findMany({ where: { businessId: fixture.business.id, resourceId: accessId }, orderBy: { createdAt: 'asc' } }),
    ]);
    expect(access.active).toBe(false);
    expect(access.revokedByUserId).toBe(fixture.user.id);
    expect(selectedSessions).toBe(0);
    expect(events.map(event => event.action)).toEqual(['STAFF_INVITATION_ACCEPTED', 'STAFF_ACCESS_UPDATED', 'STAFF_ACCESS_REVOKED']);
  });

  it('keeps named staff administration within the actor permission set', async () => {
    const manager = await localAccount({ name: 'Limited Staff Manager', email: `limited-manager-${randomUUID()}@example.test` });
    const managerInvitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: manager.email, accessLevel: 'CUSTOM', permissions: ['BOOKINGS_MANAGE', 'STAFF_MANAGE'] }).expect(201);
    const managerSession = await localSession(manager.id);
    await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', managerSession.cookie)
      .send({ invitationId: managerInvitation.body.invitation.id }).expect(200);

    const bookingReader = await localAccount({ name: 'Booking Reader', email: `booking-reader-${randomUUID()}@example.test` });
    const bookingReaderInvitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', managerSession.cookie)
      .send({ email: bookingReader.email, accessLevel: 'CUSTOM', permissions: ['BOOKINGS_VIEW'] }).expect(201);
    const bookingReaderSession = await localSession(bookingReader.id);
    const bookingReaderAccess = await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', bookingReaderSession.cookie)
      .send({ invitationId: bookingReaderInvitation.body.invitation.id }).expect(200);
    await request(testApp).patch(`/api/staff-access/${bookingReaderAccess.body.staffAccess.id}`).set('Cookie', managerSession.cookie)
      .send({ accessLevel: 'CUSTOM', permissions: ['BOOKINGS_VIEW'] }).expect(200);
    await request(testApp).delete(`/api/staff-access/${bookingReaderAccess.body.staffAccess.id}`).set('Cookie', managerSession.cookie)
      .expect(200, { ok: true });
    await request(testApp).post('/api/staff-access/invitations').set('Cookie', managerSession.cookie)
      .send({ email: `administrator-${randomUUID()}@example.test`, accessLevel: 'ADMINISTRATOR' })
      .expect(403, { error: 'Only the club account can manage staff-management access' });
    await request(testApp).post('/api/staff-access/invitations').set('Cookie', managerSession.cookie)
      .send({ email: `delegated-manager-${randomUUID()}@example.test`, accessLevel: 'CUSTOM', permissions: ['STAFF_MANAGE'] })
      .expect(403, { error: 'Only the club account can manage staff-management access' });
    await request(testApp).post('/api/staff-access/invitations').set('Cookie', managerSession.cookie)
      .send({ email: `finance-${randomUUID()}@example.test`, accessLevel: 'CUSTOM', permissions: ['PAYMENTS_VIEW'] })
      .expect(403, { error: 'Named staff can only manage access within their own permissions' });

    const powerful = await localAccount({ name: 'Powerful Staff', email: `powerful-${randomUUID()}@example.test` });
    const powerfulInvitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: powerful.email, accessLevel: 'FINANCE' }).expect(201);
    const powerfulSession = await localSession(powerful.id);
    const powerfulAccess = await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', powerfulSession.cookie)
      .send({ invitationId: powerfulInvitation.body.invitation.id }).expect(200);

    await request(testApp).patch(`/api/staff-access/${powerfulAccess.body.staffAccess.id}`).set('Cookie', managerSession.cookie)
      .send({ accessLevel: 'CUSTOM', permissions: ['BOOKINGS_VIEW'] })
      .expect(403, { error: 'Named staff can only manage access within their own permissions' });
    await request(testApp).delete(`/api/staff-access/${powerfulAccess.body.staffAccess.id}`).set('Cookie', managerSession.cookie)
      .expect(403, { error: 'Named staff can only manage access within their own permissions' });

    const pendingFinance = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: `pending-finance-${randomUUID()}@example.test`, accessLevel: 'FINANCE' }).expect(201);
    await request(testApp).delete(`/api/staff-access/invitations/${pendingFinance.body.invitation.id}`).set('Cookie', managerSession.cookie)
      .expect(403, { error: 'Named staff can only manage access within their own permissions' });

    await request(testApp).patch(`/api/staff-access/${powerfulAccess.body.staffAccess.id}`).set('Cookie', fixture.cookie)
      .send({ accessLevel: 'ADMINISTRATOR' }).expect(200);
    await request(testApp).delete(`/api/staff-access/${powerfulAccess.body.staffAccess.id}`).set('Cookie', fixture.cookie)
      .expect(200, { ok: true });
  });

  it('admits single-domain staff to an inbox containing only authorized categories', async () => {
    const [staff, paymentStaff, renter] = await Promise.all([
      localAccount({ name: 'Rental Desk', email: `rental-desk-${randomUUID()}@example.test` }),
      localAccount({ name: 'Payment Desk', email: `payment-desk-${randomUUID()}@example.test` }),
      localAccount({ name: 'Rental Customer', email: `rental-customer-${randomUUID()}@example.test` }),
    ]);
    const invitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: staff.email, accessLevel: 'CUSTOM', permissions: ['RENTALS_VIEW'] }).expect(201);
    const staffSession = await localSession(staff.id);
    await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', staffSession.cookie)
      .send({ invitationId: invitation.body.invitation.id }).expect(200);
    const paymentInvitation = await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: paymentStaff.email, accessLevel: 'CUSTOM', permissions: ['PAYMENTS_VIEW'] }).expect(201);
    const paymentSession = await localSession(paymentStaff.id);
    await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', paymentSession.cookie)
      .send({ invitationId: paymentInvitation.body.invitation.id }).expect(200);

    const futureStart = new Date(Date.now() + 86_400_000);
    const futureEnd = new Date(futureStart.getTime() + 3_600_000);
    await prisma.$transaction(async tx => {
      const instructor = await tx.instructor.create({ data: {
        businessId: fixture.business.id, name: 'Inbox Coach', initials: 'IC',
      } });
      const teachingLocation = await tx.location.create({ data: {
        businessId: fixture.business.id, name: 'Inbox Teaching Court',
      } });
      const service = await tx.service.create({ data: {
        businessId: fixture.business.id, name: 'Inbox Class', type: 'PRIVATE', capacity: 1,
        locations: { create: {
          locationId: teachingLocation.id, price: 8_000, duration: 60,
          instructors: { create: { instructorId: instructor.id } },
        } },
      } });
      const booking = await tx.booking.create({ data: {
        businessId: fixture.business.id, serviceId: service.id, instructorId: instructor.id,
        locationId: teachingLocation.id, startAt: futureStart, endAt: futureEnd, duration: 60,
        status: 'PENDING', type: 'PRIVATE', capacity: 1, price: 8_000, coachAcceptance: 'NOT_REQUIRED',
      } });
      const student = await tx.student.create({ data: {
        businessId: fixture.business.id, userId: renter.id, name: renter.name, email: renter.email, initials: 'RC',
      } });
      await tx.participant.create({ data: { bookingId: booking.id, studentId: student.id, price: 8_000 } });
      const rentalLocation = await tx.location.create({ data: {
        businessId: fixture.business.id, name: 'Inbox Rental Court', type: 'FACILITY',
      } });
      const unit = await tx.venueUnit.create({ data: {
        businessId: fixture.business.id, locationId: rentalLocation.id, name: 'Court 1',
      } });
      await tx.venueReservation.create({ data: {
        businessId: fixture.business.id, locationId: rentalLocation.id, unitId: unit.id, userId: renter.id,
        startAt: futureStart, endAt: futureEnd, duration: 60, price: 2_400, status: 'PENDING', paymentStatus: 'UNPAID',
      } });
    });

    const inbox = await request(testApp).get('/api/operations/inbox').set('Cookie', staffSession.cookie).expect(200);
    expect(inbox.body.items).toEqual([expect.objectContaining({ category: 'rental' })]);
    expect(inbox.body.counts).toEqual({ all: 1, coach: 0, venue: 0, attendance: 0, reschedule: 0, payment: 0, rental: 1 });
    await request(testApp).get('/api/operations/inbox').query({ category: 'rental' })
      .set('Cookie', staffSession.cookie).expect(200);
    await request(testApp).get('/api/operations/inbox').query({ category: 'venue' })
      .set('Cookie', staffSession.cookie).expect(403, { error: 'This workspace requires bookings view permission' });
    await request(testApp).get('/api/operations/inbox').query({ category: 'payment' })
      .set('Cookie', staffSession.cookie).expect(403, { error: 'This workspace requires payments view permission' });

    const paymentInbox = await request(testApp).get('/api/operations/inbox').set('Cookie', paymentSession.cookie).expect(200);
    expect(paymentInbox.body.items).toEqual([expect.objectContaining({ category: 'payment' })]);
    expect(paymentInbox.body.counts).toEqual({ all: 1, coach: 0, venue: 0, attendance: 0, reschedule: 0, payment: 1, rental: 0 });
    await request(testApp).get('/api/operations/inbox').query({ category: 'rental' })
      .set('Cookie', paymentSession.cookie).expect(403, { error: 'This workspace requires rentals view permission' });
  });

  it('rejects club accounts and invalid custom permission sets', async () => {
    await request(testApp).post('/api/club-staff-invitations/accept').set('Cookie', fixture.cookie)
      .send({ invitationId: 'missing' }).expect(403);
    await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: 'person@example.test', accessLevel: 'CUSTOM', permissions: [] }).expect(400);
    await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: 'person@example.test', accessLevel: 'FRONT_DESK', permissions: ['STAFF_MANAGE'] }).expect(400);
    await request(testApp).post('/api/staff-access/invitations').set('Cookie', fixture.cookie)
      .send({ email: 'person@example.test', accessLevel: 'CUSTOM', permissions: ['RENTALS_MANAGE'] })
      .expect(400, { error: 'Managing rentals also requires manage catalogue permission' });
  });
});
