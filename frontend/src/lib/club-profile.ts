import type { BookingPreselection } from './booking-links';
import type {
  BookingSource,
  ClubPublicSummary,
  CoachingAgeGroup,
  CoachingLevel,
  CoachPublicProfile,
  PublicBookingBusiness,
  PublicBusiness,
  Service,
  Slot,
} from './types';
import { dateKey } from './utils';

/*
 * Pure helpers behind the public booking page's decision header, coach cards,
 * preselection links and waitlist entry point. They hold no DOM or network
 * state so the rules can be pinned down in Vitest; the page only renders them.
 */

const levelOrder: CoachingLevel[] = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'COMPETITIVE'];
const ageGroupOrder: CoachingAgeGroup[] = ['JUNIOR', 'TEEN', 'ADULT', 'SENIOR'];

export const coachingLevelLabels: Record<CoachingLevel, string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
  COMPETITIVE: 'Competitive',
};

export const coachingAgeGroupLabels: Record<CoachingAgeGroup, string> = {
  JUNIOR: 'Juniors',
  TEEN: 'Teens',
  ADULT: 'Adults',
  SENIOR: 'Seniors',
};

/** Labels in a stable product order; values an older or newer API sends that this build does not know are skipped. */
export function coachingLevelList(levels: readonly string[] | null | undefined) {
  const present = new Set(levels ?? []);
  return levelOrder.filter(level => present.has(level)).map(level => coachingLevelLabels[level]);
}

export function coachingAgeGroupList(groups: readonly string[] | null | undefined) {
  const present = new Set(groups ?? []);
  return ageGroupOrder.filter(group => present.has(group)).map(group => coachingAgeGroupLabels[group]);
}

/** "8 years coaching · since 2018"; null when the year is missing or implausible. */
export function coachingExperienceLabel(coachingSince: number | null | undefined, currentYear: number) {
  if (typeof coachingSince !== 'number' || !Number.isInteger(coachingSince)) return null;
  if (coachingSince < 1950 || coachingSince > currentYear) return null;
  const years = currentYear - coachingSince;
  if (years < 1) return `Coaching since ${coachingSince}`;
  return `${years} year${years === 1 ? '' : 's'} coaching · since ${coachingSince}`;
}

function cleanList(values: readonly string[] | null | undefined) {
  return (values ?? []).map(value => value.trim()).filter(Boolean);
}

/** The profile fields a coach card can actually show; empty strings and lists are dropped. */
export function coachProfileDetails(profile: CoachPublicProfile | null | undefined, currentYear: number) {
  if (!profile) return null;
  const details = {
    bio: profile.bio?.trim() ?? '',
    sports: cleanList(profile.sports),
    languages: cleanList(profile.languages),
    levels: coachingLevelList(profile.coachingLevels),
    ageGroups: coachingAgeGroupList(profile.coachingAgeGroups),
    qualifications: cleanList(profile.qualifications),
    experience: coachingExperienceLabel(profile.coachingSince, currentYear),
  };
  const empty = !details.bio && !details.experience && [
    details.sports, details.languages, details.levels, details.ageGroups, details.qualifications,
  ].every(list => list.length === 0);
  return empty ? null : details;
}

/** How long the notice period is, in words a player reads at a glance. */
export function noticePeriodLabel(hours: number) {
  const value = Math.max(0, Math.round(hours));
  if (value >= 48 && value % 24 === 0) {
    const days = value / 24;
    return days % 7 === 0 ? `${days / 7} week${days === 7 ? '' : 's'}` : `${days} days`;
  }
  return `${value} hour${value === 1 ? '' : 's'}`;
}

export function plainCancellationNotice(hours: number) {
  if (!Number.isFinite(hours) || hours <= 0) return 'Cancel or reschedule any time before your session starts.';
  return `Cancel or reschedule at least ${noticePeriodLabel(hours)} before your session.`;
}

export type ClubContactLink = {
  kind: 'email' | 'phone' | 'website';
  /** Visible text: the address, number or site exactly as a person would type it. */
  label: string;
  href: string;
  external: boolean;
};

// Deliberately narrow: no whitespace, quotes, separators or query characters,
// so a club-entered value can never smuggle extra mailto headers.
const emailPattern = /^[^\s@<>()[\]"',;:?&#\\/]+@[^\s@<>()[\]"',;:?&#\\/]+\.[^\s@<>()[\]"',;:?&#\\/]+$/;

export function clubContactLinks(
  business: Pick<PublicBookingBusiness, 'supportEmail' | 'publicPhone' | 'websiteUrl'>,
): ClubContactLink[] {
  const links: ClubContactLink[] = [];
  const email = business.supportEmail?.trim() ?? '';
  if (email.length <= 254 && emailPattern.test(email)) {
    links.push({ kind: 'email', label: email, href: `mailto:${email}`, external: false });
  }
  const phone = business.publicPhone?.trim() ?? '';
  const digits = phone.replace(/\D/g, '');
  if (phone && digits.length >= 6 && digits.length <= 20 && /^[+\d\s().-]+$/.test(phone)) {
    links.push({ kind: 'phone', label: phone, href: `tel:${phone.startsWith('+') ? '+' : ''}${digits}`, external: false });
  }
  const website = business.websiteUrl?.trim() ?? '';
  if (website) {
    try {
      const url = new URL(website);
      if (url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.')) {
        const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
        links.push({
          kind: 'website',
          label: `${url.hostname.replace(/^www\./, '')}${path}`,
          href: url.href,
          external: true,
        });
      }
    } catch {
      // A malformed address is simply not offered as a link.
    }
  }
  return links;
}

type Catalogue = Pick<PublicBusiness, 'instructors' | 'locations' | 'services'>;

/** Venue/coach options of a Class that can actually be booked right now. */
export function bookableMappings(data: Catalogue, service: Service | undefined) {
  if (!service?.active) return [];
  return service.locations.filter(mapping =>
    data.locations.some(location => location.id === mapping.locationId && location.active)
    && mapping.instructorIds.some(id => data.instructors.some(coach => coach.id === id && coach.active)),
  );
}

function bookableCoachIds(data: Catalogue, mapping: Service['locations'][number] | undefined) {
  return mapping
    ? mapping.instructorIds.filter(id => data.instructors.some(coach => coach.id === id && coach.active))
    : [];
}

function distinctCaseInsensitive(values: Array<string | null | undefined>) {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const text = value?.trim();
    if (text && !byKey.has(text.toLocaleLowerCase())) byKey.set(text.toLocaleLowerCase(), text);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * The server's summary when present; otherwise the same facts derived from the
 * bookable catalogue, so an older API still gets an honest header.
 */
export function clubDecisionSummary(data: PublicBusiness): ClubPublicSummary {
  if (data.summary) {
    return {
      sports: data.summary.sports ?? [],
      priceFrom: data.summary.priceFrom ?? null,
      coachCount: data.summary.coachCount ?? 0,
      locationCount: data.summary.locationCount ?? 0,
      serviceCount: data.summary.serviceCount ?? 0,
      groupClassCount: data.summary.groupClassCount ?? 0,
      areas: data.summary.areas ?? [],
    };
  }
  const bookable = data.services
    .map(service => ({ service, mappings: bookableMappings(data, service) }))
    .filter(entry => entry.mappings.length > 0);
  const mappings = bookable.flatMap(entry => entry.mappings);
  const locationIds = new Set(mappings.map(mapping => mapping.locationId));
  return {
    sports: distinctCaseInsensitive(bookable.map(entry => entry.service.category)),
    priceFrom: mappings.length ? Math.min(...mappings.map(mapping => mapping.price)) : null,
    coachCount: new Set(mappings.flatMap(mapping => bookableCoachIds(data, mapping))).size,
    locationCount: locationIds.size,
    serviceCount: bookable.length,
    groupClassCount: bookable.filter(entry => entry.service.type === 'GROUP').length,
    areas: distinctCaseInsensitive(data.locations.filter(location => locationIds.has(location.id)).map(location => location.area)),
  };
}

export type VenueConfirmation = 'NONE' | 'SOME' | 'SELECTED';

export type AfterBookingStep = { id: 'confirmation' | 'payment' | 'changes' | 'chat'; title: string; text: string };

/** "What happens after booking": four short, honest answers. */
export function afterBookingSteps(input: {
  clubName: string;
  cancellationHours: number;
  venueConfirmation: VenueConfirmation;
}): AfterBookingStep[] {
  const confirmation = input.venueConfirmation === 'SELECTED'
    ? 'This venue needs confirming, so your booking stays pending until your coach confirms it. You’ll see the update in Courtly.'
    : input.venueConfirmation === 'SOME'
      ? 'Most bookings are confirmed straight away. A few venues need your coach to confirm first; those stay pending until then.'
      : 'Your place is confirmed straight away and appears in My bookings.';
  const changes = input.cancellationHours > 0
    ? `Cancel or reschedule from My bookings at least ${noticePeriodLabel(input.cancellationHours)} before the session.`
    : 'Cancel or reschedule from My bookings any time before the session starts.';
  return [
    { id: 'confirmation', title: 'Confirmation', text: confirmation },
    { id: 'payment', title: 'Payment', text: `Nothing is charged on this page. Payment is arranged with ${input.clubName}; any payment options appear in My bookings.` },
    { id: 'changes', title: 'Changing plans', text: changes },
    { id: 'chat', title: 'Questions', text: 'Each Class has a chat in Courtly where you can message your coach and the club.' },
  ];
}

export type ResolvedPreselection = {
  serviceId: string;
  locationId: string;
  instructorId: string;
  requested: { service: boolean; venue: boolean; coach: boolean };
  applied: { service: boolean; venue: boolean; coach: boolean };
  complete: boolean;
};

/**
 * Apply a link's Class, venue and coach only where they are still bookable.
 * A single remaining venue or coach is chosen the same way picking the Class
 * by hand would choose it; nothing stale is ever substituted silently.
 */
export function resolveBookingPreselection(data: Catalogue, preselection: BookingPreselection): ResolvedPreselection {
  const requested = {
    service: !!preselection.serviceId,
    venue: !!preselection.locationId,
    coach: !!preselection.instructorId,
  };
  const none: ResolvedPreselection = {
    serviceId: '', locationId: '', instructorId: '', requested,
    applied: { service: false, venue: false, coach: false }, complete: false,
  };
  const service = data.services.find(candidate => candidate.id === preselection.serviceId);
  const mappings = bookableMappings(data, service);
  if (!service || mappings.length === 0) return none;
  const requestedMapping = mappings.find(mapping => mapping.locationId === preselection.locationId);
  const mapping = requestedMapping ?? (mappings.length === 1 ? mappings[0] : undefined);
  const coaches = bookableCoachIds(data, mapping);
  const instructorId = preselection.instructorId && coaches.includes(preselection.instructorId)
    ? preselection.instructorId
    : coaches.length === 1 ? coaches[0] : '';
  const locationId = mapping?.locationId ?? '';
  return {
    serviceId: service.id,
    locationId,
    instructorId,
    requested,
    applied: {
      service: true,
      venue: requested.venue && locationId === preselection.locationId,
      coach: requested.coach && instructorId === preselection.instructorId,
    },
    complete: !!locationId && !!instructorId,
  };
}

/**
 * The day a link asks for. An exact start wins because the slot must sit on
 * that day in the club's timezone; past days fall back to the default.
 */
export function preselectedDate(preselection: Pick<BookingPreselection, 'date' | 'startAt'>, timezone: string, today: string) {
  const candidate = preselection.startAt ? dateKey(preselection.startAt, timezone) : preselection.date;
  return candidate && candidate >= today ? candidate : null;
}

export function sameInstant(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const left = Date.parse(a);
  return Number.isFinite(left) && left === Date.parse(b);
}

/** A group Class with no place left: the only kind of unavailable slot a waitlist can help with. */
export function isFullGroupSlot(slot: Slot, serviceType: Service['type'] | undefined) {
  return serviceType === 'GROUP' && !slot.available && slot.placesRemaining <= 0 && /\bfull\b/i.test(slot.reason ?? '');
}

export function fullGroupSlots(slots: readonly Slot[], serviceType: Service['type'] | undefined) {
  return slots.filter(slot => isFullGroupSlot(slot, serviceType));
}

/** Banner copy explaining what a link filled in. Plain shared links need no banner. */
export function preselectionBanner(input: {
  source: BookingSource;
  resolved: Pick<ResolvedPreselection, 'requested' | 'applied'>;
  serviceName?: string;
  coachName?: string;
  venueName?: string;
  when?: string;
}) {
  if (input.source === 'DIRECT') return null;
  const title = input.source === 'REBOOK' ? 'Booking again' : 'From your search';
  const { requested, applied } = input.resolved;
  if (!applied.service || !input.serviceName) {
    if (!requested.service) return null;
    return {
      title,
      text: input.source === 'REBOOK'
        ? 'That Class isn’t open for booking right now. Choose another Class below.'
        : 'That Class isn’t open for booking any more. Choose another Class below.',
    };
  }
  const parts = [input.serviceName];
  if (applied.coach && input.coachName) parts.push(`with ${input.coachName}`);
  if (applied.venue && input.venueName) parts.push(`at ${input.venueName}`);
  const origin = input.source === 'REBOOK' ? ' from your last booking' : input.when ? ` for ${input.when}` : '';
  const gaps: string[] = [];
  if (requested.coach && !applied.coach) gaps.push(input.source === 'REBOOK' ? 'Your previous coach isn’t available for this Class now, so please choose a coach.' : 'That coach isn’t available for this Class now, so please choose a coach.');
  if (requested.venue && !applied.venue) gaps.push(input.source === 'REBOOK' ? 'Your previous venue isn’t available for this Class now, so please choose a place.' : 'That venue isn’t available for this Class now, so please choose a place.');
  return {
    title,
    text: `We’ve filled in ${parts.join(' ')}${origin}. ${gaps.length ? `${gaps.join(' ')} ` : ''}You can still change anything.`,
  };
}

/** A booking-page link back to the same choices, used to return after signing in. */
export function bookingReturnPath(slug: string, values: {
  serviceId?: string; instructorId?: string; locationId?: string; date?: string; startAt?: string; source?: BookingSource;
}) {
  const params = new URLSearchParams();
  if (values.serviceId) params.set('service', values.serviceId);
  if (values.instructorId) params.set('coach', values.instructorId);
  if (values.locationId) params.set('venue', values.locationId);
  if (values.date) params.set('date', values.date);
  if (values.startAt) params.set('start', values.startAt);
  if (values.source === 'REBOOK') params.set('rebook', '1');
  if (values.source === 'SEARCH') params.set('source', 'search');
  const query = params.toString();
  return `/book/${encodeURIComponent(slug)}${query ? `?${query}` : ''}`;
}

export function signInHref(returnPath: string) {
  return `/login?${new URLSearchParams({ next: returnPath })}`;
}

/** "You’re first in line" / "3 people ahead of you" for a fresh waitlist entry. */
export function waitlistPositionText(aheadCount: number | null | undefined) {
  if (aheadCount === null || aheadCount === undefined || aheadCount < 0) return 'We’ll let you know in Courtly if a place opens.';
  if (aheadCount === 0) return 'You’re first in line.';
  return `${aheadCount} ${aheadCount === 1 ? 'person' : 'people'} ahead of you.`;
}
