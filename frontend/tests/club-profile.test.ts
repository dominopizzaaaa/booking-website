import { describe, expect, it } from 'vitest';
import {
  afterBookingSteps,
  bookingReturnPath,
  clubContactLinks,
  clubDecisionSummary,
  coachingAgeGroupList,
  coachingExperienceLabel,
  coachingLevelList,
  coachProfileDetails,
  fullGroupSlots,
  isFullGroupSlot,
  noticePeriodLabel,
  plainCancellationNotice,
  preselectedDate,
  preselectionBanner,
  resolveBookingPreselection,
  sameInstant,
  signInHref,
  waitlistPositionText,
} from '../src/lib/club-profile';
import { parseBookingPreselection } from '../src/lib/booking-links';
import type { CoachPublicProfile, PublicBusiness, Service, Slot } from '../src/lib/types';

const service = (overrides: Partial<Service>): Service => ({
  id: 'private', name: 'Private lesson', description: '', category: 'Tennis', type: 'PRIVATE', duration: 60,
  price: 8_000, capacity: 1, bufferMinutes: 0, noticeHours: 0, color: 'sage', active: true, locations: [], ...overrides,
});

function catalogue(): PublicBusiness {
  return {
    business: {
      name: 'Rally Club', slug: 'rally', ownerName: 'Rally', timezone: 'Asia/Singapore', currency: 'SGD',
      color: '#174c3c', tagline: '', cancellationHours: 24, kind: 'CLUB',
    },
    instructors: [
      { id: 'casey', name: 'Casey Coach', initials: 'CC', color: '#000', specialty: '', active: true },
      { id: 'drew', name: 'Drew Coach', initials: 'DC', color: '#000', specialty: '', active: true },
      { id: 'gone', name: 'Former Coach', initials: 'FC', color: '#000', specialty: '', active: false },
    ],
    locations: [
      { id: 'east', name: 'East Court', address: '', area: 'Tampines · East', type: 'FACILITY', color: '#000', requiresApproval: false, active: true },
      { id: 'central', name: 'Central Court', address: '', area: 'bishan', type: 'FACILITY', color: '#000', requiresApproval: false, active: true },
      { id: 'closed', name: 'Closed Court', address: '', area: 'Closed', type: 'FACILITY', color: '#000', requiresApproval: false, active: false },
    ],
    services: [
      service({
        id: 'private',
        locations: [
          { locationId: 'east', price: 8_000, duration: 60, instructorIds: ['casey', 'drew'] },
          { locationId: 'central', price: 6_500, duration: 60, instructorIds: ['casey'] },
          { locationId: 'closed', price: 1_000, duration: 60, instructorIds: ['casey'] },
        ],
      }),
      service({
        id: 'group', name: 'Group clinic', category: 'badminton', type: 'GROUP', capacity: 4,
        locations: [{ locationId: 'east', price: 4_500, duration: 90, instructorIds: ['casey'] }],
      }),
      service({
        id: 'unstaffed', name: 'Unstaffed', category: 'Squash',
        locations: [{ locationId: 'east', price: 500, duration: 60, instructorIds: ['gone'] }],
      }),
    ],
  };
}

describe('coach profile labels', () => {
  it('labels levels and age groups in product order and ignores unknown values', () => {
    expect(coachingLevelList(['ADVANCED', 'BEGINNER', 'WIZARD'])).toEqual(['Beginner', 'Advanced']);
    expect(coachingAgeGroupList(['SENIOR', 'JUNIOR', 'TEEN'])).toEqual(['Juniors', 'Teens', 'Seniors']);
    expect(coachingLevelList(undefined)).toEqual([]);
  });

  it('describes coaching experience from the starting year', () => {
    expect(coachingExperienceLabel(2018, 2026)).toBe('8 years coaching · since 2018');
    expect(coachingExperienceLabel(2025, 2026)).toBe('1 year coaching · since 2025');
    expect(coachingExperienceLabel(2026, 2026)).toBe('Coaching since 2026');
    expect(coachingExperienceLabel(2027, 2026)).toBeNull();
    expect(coachingExperienceLabel(1900, 2026)).toBeNull();
    expect(coachingExperienceLabel(null, 2026)).toBeNull();
  });

  it('keeps only the profile fields a card can show and drops an empty profile', () => {
    const profile: CoachPublicProfile = {
      bio: '  Footwork first.  ', languages: ['English', ' '], coachingLevels: ['INTERMEDIATE'],
      coachingAgeGroups: ['ADULT'], qualifications: ['Level 2 coach'], coachingSince: 2020, sports: ['Tennis'],
    };
    expect(coachProfileDetails(profile, 2026)).toEqual({
      bio: 'Footwork first.', sports: ['Tennis'], languages: ['English'], levels: ['Intermediate'],
      ageGroups: ['Adults'], qualifications: ['Level 2 coach'], experience: '6 years coaching · since 2020',
    });
    expect(coachProfileDetails({
      bio: '', languages: [], coachingLevels: [], coachingAgeGroups: [], qualifications: [], coachingSince: null, sports: [],
    }, 2026)).toBeNull();
    expect(coachProfileDetails(null, 2026)).toBeNull();
  });
});

describe('club decision header', () => {
  it('states the cancellation notice in plain words', () => {
    expect(noticePeriodLabel(1)).toBe('1 hour');
    expect(noticePeriodLabel(24)).toBe('24 hours');
    expect(noticePeriodLabel(36)).toBe('36 hours');
    expect(noticePeriodLabel(48)).toBe('2 days');
    expect(noticePeriodLabel(168)).toBe('1 week');
    expect(plainCancellationNotice(24)).toBe('Cancel or reschedule at least 24 hours before your session.');
    expect(plainCancellationNotice(0)).toBe('Cancel or reschedule any time before your session starts.');
  });

  it('offers only well-formed contact links and opens the website safely', () => {
    expect(clubContactLinks({
      supportEmail: ' hello@rally.example ', publicPhone: '+65 6123 4567', websiteUrl: 'https://www.rally.example/coaching/',
    })).toEqual([
      { kind: 'email', label: 'hello@rally.example', href: 'mailto:hello@rally.example', external: false },
      { kind: 'phone', label: '+65 6123 4567', href: 'tel:+6561234567', external: false },
      { kind: 'website', label: 'rally.example/coaching', href: 'https://www.rally.example/coaching/', external: true },
    ]);
  });

  it('drops unsafe or malformed contact values instead of linking them', () => {
    expect(clubContactLinks({
      supportEmail: 'hello@rally.example?bcc=x@y.example', publicPhone: 'call us', websiteUrl: 'javascript:alert(1)',
    })).toEqual([]);
    expect(clubContactLinks({ websiteUrl: 'http://rally.example' })).toEqual([]);
    expect(clubContactLinks({ websiteUrl: 'https://user:pw@rally.example' })).toEqual([]);
    expect(clubContactLinks({ supportEmail: '', publicPhone: '', websiteUrl: '' })).toEqual([]);
  });

  it('uses the server summary when present', () => {
    const data = { ...catalogue(), summary: {
      sports: ['Tennis'], priceFrom: 4_000, coachCount: 3, locationCount: 2, serviceCount: 2, groupClassCount: 1, areas: ['East'],
    } };
    expect(clubDecisionSummary(data)).toEqual(data.summary);
  });

  it('derives an honest summary from the bookable catalogue for an older API', () => {
    expect(clubDecisionSummary(catalogue())).toEqual({
      sports: ['badminton', 'Tennis'],
      priceFrom: 4_500,
      coachCount: 2,
      locationCount: 2,
      serviceCount: 2,
      groupClassCount: 1,
      areas: ['bishan', 'Tampines · East'],
    });
  });

  it('explains what happens after booking, including pending venues', () => {
    const steps = afterBookingSteps({ clubName: 'Rally Club', cancellationHours: 48, venueConfirmation: 'NONE' });
    expect(steps.map(step => step.id)).toEqual(['confirmation', 'payment', 'changes', 'chat']);
    expect(steps[0].text).toContain('confirmed straight away');
    expect(steps[1].text).toContain('Payment is arranged with Rally Club');
    expect(steps[2].text).toContain('at least 2 days before');
    expect(afterBookingSteps({ clubName: 'Rally Club', cancellationHours: 0, venueConfirmation: 'SOME' })[0].text)
      .toContain('stay pending');
    expect(afterBookingSteps({ clubName: 'Rally Club', cancellationHours: 24, venueConfirmation: 'SELECTED' })[0].text)
      .toContain('stays pending until your coach confirms');
  });
});

describe('booking preselection', () => {
  it('applies a still-bookable Class, venue and coach', () => {
    const resolved = resolveBookingPreselection(catalogue(), parseBookingPreselection(
      new URLSearchParams('service=private&coach=drew&venue=east&rebook=1'),
    ));
    expect(resolved).toEqual({
      serviceId: 'private', locationId: 'east', instructorId: 'drew',
      requested: { service: true, venue: true, coach: true },
      applied: { service: true, venue: true, coach: true },
      complete: true,
    });
  });

  it('never substitutes a stale coach or venue, but keeps a single remaining choice', () => {
    const staleCoach = resolveBookingPreselection(catalogue(), { serviceId: 'private', locationId: 'east', instructorId: 'gone', source: 'REBOOK' });
    expect(staleCoach).toMatchObject({ locationId: 'east', instructorId: '', complete: false, applied: { coach: false, venue: true } });
    const closedVenue = resolveBookingPreselection(catalogue(), { serviceId: 'private', locationId: 'closed', instructorId: 'casey', source: 'REBOOK' });
    expect(closedVenue).toMatchObject({ locationId: '', instructorId: '', complete: false, applied: { venue: false, coach: false } });
    const onlyOption = resolveBookingPreselection(catalogue(), { serviceId: 'group', source: 'DIRECT' });
    expect(onlyOption).toMatchObject({ locationId: 'east', instructorId: 'casey', complete: true });
  });

  it('ignores a Class that is no longer bookable', () => {
    for (const serviceId of ['unstaffed', 'missing', undefined]) {
      expect(resolveBookingPreselection(catalogue(), { serviceId, locationId: 'east', instructorId: 'casey', source: 'SEARCH' }))
        .toMatchObject({ serviceId: '', locationId: '', instructorId: '', complete: false });
    }
  });

  it('chooses the requested day from the exact start in the club timezone and refuses past days', () => {
    expect(preselectedDate({ startAt: '2026-10-08T17:30:00.000Z', date: '2026-10-08' }, 'Asia/Singapore', '2026-10-01')).toBe('2026-10-09');
    expect(preselectedDate({ date: '2026-10-08' }, 'Asia/Singapore', '2026-10-01')).toBe('2026-10-08');
    expect(preselectedDate({ date: '2026-09-30' }, 'Asia/Singapore', '2026-10-01')).toBeNull();
    expect(preselectedDate({}, 'Asia/Singapore', '2026-10-01')).toBeNull();
  });

  it('compares slot instants regardless of ISO spelling', () => {
    expect(sameInstant('2026-10-08T02:00:00Z', '2026-10-08T02:00:00.000Z')).toBe(true);
    expect(sameInstant('2026-10-08T02:00:00Z', '2026-10-08T02:30:00.000Z')).toBe(false);
    expect(sameInstant('', '2026-10-08T02:00:00.000Z')).toBe(false);
  });

  it('explains what a re-booking or search link filled in', () => {
    const all = { requested: { service: true, venue: true, coach: true }, applied: { service: true, venue: true, coach: true } };
    expect(preselectionBanner({ source: 'REBOOK', resolved: all, serviceName: 'Private lesson', coachName: 'Casey Coach', venueName: 'East Court' }))
      .toEqual({
        title: 'Booking again',
        text: 'We’ve filled in Private lesson with Casey Coach at East Court from your last booking. You can still change anything.',
      });
    expect(preselectionBanner({ source: 'SEARCH', resolved: all, serviceName: 'Private lesson', coachName: 'Casey Coach', venueName: 'East Court', when: 'Thu, 8 Oct at 10:00 AM' })?.text)
      .toContain('for Thu, 8 Oct at 10:00 AM');
    expect(preselectionBanner({ source: 'DIRECT', resolved: all, serviceName: 'Private lesson' })).toBeNull();
  });

  it('says when the previous coach or Class can no longer be booked', () => {
    const partial = { requested: { service: true, venue: true, coach: true }, applied: { service: true, venue: true, coach: false } };
    expect(preselectionBanner({ source: 'REBOOK', resolved: partial, serviceName: 'Private lesson', venueName: 'East Court' })?.text)
      .toContain('Your previous coach isn’t available for this Class now');
    const missing = { requested: { service: true, venue: false, coach: false }, applied: { service: false, venue: false, coach: false } };
    expect(preselectionBanner({ source: 'REBOOK', resolved: missing })?.text).toContain('Choose another Class');
    const nothing = { requested: { service: false, venue: false, coach: false }, applied: { service: false, venue: false, coach: false } };
    expect(preselectionBanner({ source: 'REBOOK', resolved: nothing })).toBeNull();
  });
});

describe('waitlist entry point', () => {
  const slot = (overrides: Partial<Slot>): Slot => ({
    startAt: '2026-10-08T04:00:00.000Z', endAt: '2026-10-08T05:00:00.000Z', available: false, placesRemaining: 0, ...overrides,
  });

  it('treats only a full group Class as waitlistable', () => {
    expect(isFullGroupSlot(slot({ reason: 'This group is full' }), 'GROUP')).toBe(true);
    expect(isFullGroupSlot(slot({ reason: 'This group is full' }), 'PRIVATE')).toBe(false);
    expect(isFullGroupSlot(slot({ reason: 'Coach already has a session or preparation buffer' }), 'GROUP')).toBe(false);
    expect(isFullGroupSlot(slot({ available: true, placesRemaining: 2 }), 'GROUP')).toBe(false);
    expect(isFullGroupSlot(slot({ reason: 'Not fully staffed', placesRemaining: 1 }), 'GROUP')).toBe(false);
    expect(fullGroupSlots([
      slot({ startAt: 'a', available: true, placesRemaining: 1 }),
      slot({ startAt: 'b', reason: 'This group is full' }),
    ], 'GROUP').map(item => item.startAt)).toEqual(['b']);
  });

  it('returns a signed-out visitor to the same choices and source', () => {
    const path = bookingReturnPath('rally club', {
      serviceId: 'group', instructorId: 'casey', locationId: 'east', date: '2026-10-08', startAt: '2026-10-08T04:00:00.000Z', source: 'REBOOK',
    });
    expect(path).toBe('/book/rally%20club?service=group&coach=casey&venue=east&date=2026-10-08&start=2026-10-08T04%3A00%3A00.000Z&rebook=1');
    expect(parseBookingPreselection(new URL(path, 'https://courtly.test').searchParams)).toEqual({
      serviceId: 'group', instructorId: 'casey', locationId: 'east', date: '2026-10-08', startAt: '2026-10-08T04:00:00.000Z', source: 'REBOOK',
    });
    expect(bookingReturnPath('rally', { source: 'SEARCH' })).toBe('/book/rally?source=search');
    expect(bookingReturnPath('rally', { source: 'DIRECT' })).toBe('/book/rally');
    expect(signInHref('/book/rally?service=group')).toBe('/login?next=%2Fbook%2Frally%3Fservice%3Dgroup');
  });

  it('describes a new waitlist position', () => {
    expect(waitlistPositionText(0)).toBe('You’re first in line.');
    expect(waitlistPositionText(1)).toBe('1 person ahead of you.');
    expect(waitlistPositionText(3)).toBe('3 people ahead of you.');
    expect(waitlistPositionText(null)).toBe('We’ll let you know in Courtly if a place opens.');
  });
});
