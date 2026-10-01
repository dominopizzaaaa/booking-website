import { formatInTimeZone } from 'date-fns-tz';
import type { AccountRequiredAction, AgeBand, Attendance, AuthSession, ChildScheduleItem, FamilyChild, Status } from '@/lib/types';

export const familyUsernamePattern = /^[a-z0-9_]{3,30}$/;
const singaporeDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Singapore',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Return Courtly's policy date, independent of the browser or server timezone. */
export function singaporeCivilDate(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  const parts = singaporeDateFormatter.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function familySports(value: string): string[] | null {
  if (!value.trim()) return [];
  const entries = value.split(',').map(sport => sport.trim());
  if (entries.some(sport => !sport) || entries.length > 20 || entries.some(sport => sport.length > 40)) return null;
  const seen = new Set<string>();
  return entries.filter(sport => {
    const key = sport.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validPastDate(value: string, today = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.getUTCFullYear() >= 1900
    && parsed.toISOString().slice(0, 10) === value
    && value <= singaporeCivilDate(today);
}

export function ageBandLabel(value: AgeBand | string | null | undefined): string {
  if (value === 'CHILD') return 'Child';
  if (value === 'TEEN') return 'Teen';
  if (value === 'ADULT') return 'Adult';
  return 'Age not reviewed';
}

export function childStatusLabel(child: Pick<FamilyChild, 'accountStatus' | 'accountControl'>): string {
  if (child.accountStatus === 'DELETION_REQUESTED') return 'Deletion requested';
  if (child.accountStatus === 'CONSENT_REQUIRED') return 'Consent required';
  return child.accountControl === 'GUARDIAN_MANAGED' ? 'Managed by guardian' : 'Self-managed';
}

export function hasCurrentFamilyConsent(child: FamilyChild, policyVersion: string): boolean {
  return child.link.status === 'ACTIVE'
    && child.accountStatus === 'ACTIVE'
    && child.consent?.status !== 'WITHDRAWN'
    && child.consent?.withdrawnAt == null
    && child.consent?.policyVersion === policyVersion;
}

/** The API supplies the age band; the browser never calculates handover age. */
export function canStartFamilyHandover(child: FamilyChild, policyVersion: string): boolean {
  return (child.ageBand === 'TEEN' || child.ageBand === 'ADULT')
    && child.accountControl === 'GUARDIAN_MANAGED'
    && hasCurrentFamilyConsent(child, policyVersion)
    && child.link.permissions.includes('HANDOVER_MANAGE')
    && child.handover?.status !== 'PENDING';
}

export function requiredActionCopy(action: AccountRequiredAction | null | undefined) {
  switch (action) {
    case 'CONSENT_REQUIRED':
      return { title: 'Guardian consent needs attention', detail: 'A parent or guardian must renew consent in Family before this account can continue.' };
    case 'GUARDIAN_SESSION_STALE':
      return { title: 'Ask your guardian to sign in', detail: 'This managed account needs a fresh guardian session before it can continue.' };
    case 'HANDOVER_REQUIRED':
      return { title: 'Account handover required', detail: 'Finish the verified handover before using this account independently.' };
    case 'DELETION_REQUESTED':
      return { title: 'Deletion request pending', detail: 'This account is restricted immediately while the deletion request awaits separate human review.' };
    case 'PARENT_ACCOUNT_REQUIRED':
      return { title: 'A parent or guardian must create this profile', detail: 'Children under 13 cannot create an independent sign-in. An adult can add a managed child from Family.' };
    default:
      return { title: 'Account action required', detail: 'Review your account before continuing.' };
  }
}

/**
 * Mirrors the server's projection authority so the entry points appear only
 * when they can work: an active link with BOOKINGS_MANAGE, current consent,
 * and a still-managed child. The server re-checks and answers 404 otherwise.
 */
export function canViewFamilyTraining(child: FamilyChild, policyVersion: string): boolean {
  return child.accountControl === 'GUARDIAN_MANAGED'
    && child.link.permissions.includes('BOOKINGS_MANAGE')
    && hasCurrentFamilyConsent(child, policyVersion);
}

export type FamilyBookingTarget = { href: string; clubName: string | null };

/**
 * Where "Book a Class" should go. A student guardian uses the club directory in
 * the player app; a coach guardian has no player app, so offer the clubs they
 * already work with. Both reach the public booking page's "Who is playing?".
 */
export function familyBookingTargets(session: Pick<AuthSession, 'user' | 'memberships'> | null | undefined, limit = 3): FamilyBookingTarget[] {
  if (!session) return [];
  if (session.user.accountType === 'STUDENT') return [{ href: '/manage?tab=explore', clubName: null }];
  if (session.user.accountType !== 'COACH') return [];
  const seen = new Set<string>();
  const targets: FamilyBookingTarget[] = [];
  for (const membership of session.memberships ?? []) {
    const business = membership.business;
    if (!membership.active || !business || business.kind !== 'CLUB' || business.legacyReadOnly || !business.slug || seen.has(business.slug)) continue;
    seen.add(business.slug);
    targets.push({ href: `/book/${encodeURIComponent(business.slug)}`, clubName: business.name });
    if (targets.length >= limit) break;
  }
  return targets;
}

/** Upcoming soonest first (a Class in progress still counts), recent newest first. */
export function splitChildSchedule(items: ChildScheduleItem[], now = Date.now()) {
  const upcoming: ChildScheduleItem[] = [];
  const recent: ChildScheduleItem[] = [];
  for (const item of items) (new Date(item.endAt).getTime() > now ? upcoming : recent).push(item);
  const start = (item: ChildScheduleItem) => new Date(item.startAt).getTime();
  upcoming.sort((a, b) => start(a) - start(b));
  recent.sort((a, b) => start(b) - start(a));
  return { upcoming, recent };
}

function zoned(value: string, timezone: string, pattern: string) {
  try { return formatInTimeZone(value, timezone, pattern); } catch { return formatInTimeZone(value, 'Asia/Singapore', pattern); }
}

/** Date and time in the club's own timezone, never the viewer's. */
export function classWhenLabel(item: Pick<ChildScheduleItem, 'startAt' | 'endAt' | 'business'>) {
  const timezone = item.business.timezone || 'Asia/Singapore';
  return {
    date: zoned(item.startAt, timezone, 'EEE, d MMM yyyy'),
    time: `${zoned(item.startAt, timezone, 'h:mm a')} – ${zoned(item.endAt, timezone, 'h:mm a')}`,
  };
}

/** Named once above the list when any club keeps a different clock from the viewer. */
export function clubTimeZoneNote(items: Pick<ChildScheduleItem, 'business'>[], viewerZone?: string): string | null {
  const viewer = viewerZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = [...new Set(items.map(item => item.business.timezone).filter(Boolean))];
  if (!zones.length || zones.every(zone => zone === viewer)) return null;
  return zones.length === 1
    ? `Times are shown in the club’s time zone (${zones[0]}).`
    : 'Times are shown in each club’s own time zone.';
}

export function scheduleStatusLabel(status: Status): string {
  switch (status) {
    case 'CONFIRMED': return 'Confirmed';
    case 'PENDING': return 'Awaiting confirmation';
    case 'CANCELLED': return 'Cancelled';
    case 'COMPLETED': return 'Completed';
    default: return status;
  }
}

/** Attendance opens when a Class starts; before that, and for cancelled Classes, say nothing. */
export function attendanceLabel(attendance: Attendance, started: boolean, status: Status): string | null {
  if (status === 'CANCELLED') return null;
  switch (attendance) {
    case 'PRESENT': return 'Attended';
    case 'LATE': return 'Attended · arrived late';
    case 'ABSENT': return 'Absent';
    case 'EXCUSED': return 'Excused';
    default: return started ? 'Attendance not marked yet' : null;
  }
}

/** Only an absolute https link from the server becomes a Maps link. */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}
