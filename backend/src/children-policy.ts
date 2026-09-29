/**
 * Pure age, child-account, and privacy policy.
 *
 * This module deliberately has no Prisma or HTTP dependency. Callers pass the
 * persisted scalar values in and intersect the returned capabilities with
 * their ordinary role, ownership, and workspace checks. Capabilities describe
 * what the subject account may do directly; guardian authority is evaluated by
 * the family routes from an active GuardianChildLink instead.
 */

export const CHILD_AGE = 13;
export const ADULT_AGE = 18;
export const SINGAPORE_TIME_ZONE = 'Asia/Singapore' as const;
export const CURRENT_PRIVACY_POLICY_VERSION = '2026-09-29' as const;
export const ACCOUNT_ACTION_REQUIRED = 'ACCOUNT_ACTION_REQUIRED' as const;

export type AccountType = 'STUDENT' | 'COACH' | 'CLUB';
export type AccountControl = 'SELF' | 'GUARDIAN_MANAGED';
export type AccountStatus = 'ACTIVE' | 'CONSENT_REQUIRED' | 'DELETION_REQUESTED';
export type ProfileVisibility = 'PRIVATE' | 'CLUBS_ONLY' | 'PUBLIC';
export type AgeBand = 'CHILD' | 'TEEN' | 'ADULT' | 'UNKNOWN';

export const GUARDIAN_CHILD_LINK_STATUSES = Object.freeze([
  'ACTIVE',
  'WITHDRAWN',
  'ENDED',
] as const);
export type GuardianChildLinkStatus = typeof GUARDIAN_CHILD_LINK_STATUSES[number];

export const GUARDIAN_PERMISSIONS = Object.freeze([
  'PROFILE_MANAGE',
  'BOOKINGS_MANAGE',
  'CREDENTIAL_RESET',
  'PRIVACY_MANAGE',
  'DATA_EXPORT',
  'CONSENT_MANAGE',
  'DELETION_REQUEST',
  'HANDOVER_MANAGE',
] as const);
export type GuardianPermission = typeof GUARDIAN_PERMISSIONS[number];
export const DEFAULT_GUARDIAN_PERMISSIONS: readonly GuardianPermission[] =
  Object.freeze([...GUARDIAN_PERMISSIONS]);

export const CHILD_CONSENT_EVENT_TYPES = Object.freeze([
  'GRANTED',
  'RENEWED',
  'WITHDRAWN',
  'HANDOVER_STARTED',
  'HANDOVER_CANCELLED',
  'HANDOVER_COMPLETED',
  'DELETION_REQUESTED',
] as const);
export type ChildConsentEventType = typeof CHILD_CONSENT_EVENT_TYPES[number];

export const CHILD_ACCOUNT_HANDOVER_STATUSES = Object.freeze([
  'PENDING',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const);
export type ChildAccountHandoverStatus = typeof CHILD_ACCOUNT_HANDOVER_STATUSES[number];

export type AccountPolicyReason =
  | 'DELETION_REQUESTED'
  | 'GUARDIAN_SESSION_STALE'
  | 'HANDOVER_REQUIRED'
  | 'CONSENT_REQUIRED'
  | 'PARENT_ACCOUNT_REQUIRED';

export type AccountCapability =
  | 'ordinaryAccess'
  | 'familyManagement'
  | 'payments'
  | 'staffAccess'
  | 'directory'
  | 'chat'
  | 'commerce'
  | 'rentals'
  | 'calendar'
  | 'workspace'
  | 'profileEdit';

export type AccountCapabilities = Readonly<Record<AccountCapability, boolean>>;

export type AgeCalculationOptions = Readonly<{
  childAge?: number;
  adultAge?: number;
}>;

export const DEFAULT_AGE_CALCULATION_OPTIONS = Object.freeze({
  childAge: CHILD_AGE,
  adultAge: ADULT_AGE,
});

export type AccountPolicyInput = {
  accountType: AccountType;
  dateOfBirth: Date | string | null;
  accountControl: AccountControl;
  accountStatus: AccountStatus;
  profileVisibility: ProfileVisibility;
  hasCurrentConsent: boolean;
  /**
   * A managed child must never have a direct login session. Presence, rather
   * than age, makes that session stale so legacy sessions fail closed.
   */
  sessionCreatedAt?: Date | null;
  now?: Date;
};

export type AccountPolicyDecision = {
  age: number | null;
  ageBand: AgeBand;
  needsAgeReview: boolean;
  needsHandover: boolean;
  sessionStale: boolean;
  accountActionRequired: boolean;
  reason: AccountPolicyReason | null;
  capabilities: AccountCapabilities;
  /** Public account-directory eligibility, separate from using the directory. */
  publiclyDiscoverable: boolean;
};

export class DateOfBirthValidationError extends Error {
  readonly code = 'INVALID_DATE_OF_BIRTH';

  constructor(message = 'Date of birth must be a valid date in YYYY-MM-DD format') {
    super(message);
    this.name = 'DateOfBirthValidationError';
  }
}

type DateParts = { year: number; month: number; day: number };

const dateOfBirthPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const singaporeDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SINGAPORE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function utcDate(year: number, month: number, day: number) {
  // Date.UTC treats years 0..99 as 1900..1999. setUTCFullYear preserves the
  // literal four-digit year accepted by the date-only parser.
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function dateParts(date: Date): DateParts {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new DateOfBirthValidationError();
  }
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function singaporeDateParts(date: Date): DateParts {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const parts = singaporeDateFormatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find(part => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function calculationAges(options: AgeCalculationOptions = {}) {
  const childAge = options.childAge ?? CHILD_AGE;
  const adultAge = options.adultAge ?? ADULT_AGE;
  if (!Number.isInteger(childAge) || childAge < 1
    || !Number.isInteger(adultAge) || adultAge <= childAge) {
    throw new RangeError('Age boundaries must be positive integers with childAge below adultAge');
  }
  return { childAge, adultAge };
}

/**
 * Parses a date-only value without letting the JavaScript runtime reinterpret
 * it in the host timezone. The returned UTC-midnight Date round-trips safely
 * through Prisma/PostgreSQL `@db.Date`.
 */
export function parseDateOfBirth(value: string): Date {
  if (typeof value !== 'string') throw new DateOfBirthValidationError();
  const match = dateOfBirthPattern.exec(value);
  if (!match) throw new DateOfBirthValidationError();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new DateOfBirthValidationError();
  }

  const parsed = utcDate(year, month, day);
  if (parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day) {
    throw new DateOfBirthValidationError();
  }
  return parsed;
}

function normalizeDateOfBirth(value: Date | string): DateParts {
  return dateParts(typeof value === 'string' ? parseDateOfBirth(value) : value);
}

/**
 * Calculates age against the civil calendar date in Singapore. A birthday is
 * reached at 00:00 Singapore time; elapsed milliseconds never enter the
 * calculation. A 29 February birthday advances on 1 March in a non-leap year.
 */
export function ageOnSingaporeDate(
  dateOfBirth: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (dateOfBirth == null) return null;
  const birth = normalizeDateOfBirth(dateOfBirth);
  const today = singaporeDateParts(now);
  let age = today.year - birth.year;
  if (today.month < birth.month || (today.month === birth.month && today.day < birth.day)) {
    age -= 1;
  }
  if (age < 0) throw new DateOfBirthValidationError('Date of birth cannot be in the future');
  return age;
}

export function ageBand(
  age: number | null | undefined,
  options: AgeCalculationOptions = {},
): AgeBand {
  if (age == null) return 'UNKNOWN';
  if (!Number.isInteger(age) || age < 0) throw new RangeError('Age must be a non-negative integer');
  const { childAge, adultAge } = calculationAges(options);
  if (age < childAge) return 'CHILD';
  if (age < adultAge) return 'TEEN';
  return 'ADULT';
}

export function isCurrentPrivacyPolicyVersion(policyVersion: string | null | undefined) {
  return policyVersion === CURRENT_PRIVACY_POLICY_VERSION;
}

const noCapabilities = (): Record<AccountCapability, boolean> => ({
  ordinaryAccess: false,
  familyManagement: false,
  payments: false,
  staffAccess: false,
  directory: false,
  chat: false,
  commerce: false,
  rentals: false,
  calendar: false,
  workspace: false,
  profileEdit: false,
});

function restrictedSelfCapabilities(): AccountCapabilities {
  return Object.freeze({ ...noCapabilities(), profileEdit: true });
}

function teenSelfCapabilities(): AccountCapabilities {
  return Object.freeze({
    ...noCapabilities(),
    ordinaryAccess: true,
    directory: true,
    chat: true,
    calendar: true,
    profileEdit: true,
  });
}

function adultSelfCapabilities(accountType: AccountType): AccountCapabilities {
  return Object.freeze({
    ordinaryAccess: true,
    familyManagement: accountType !== 'CLUB',
    payments: true,
    staffAccess: true,
    directory: true,
    chat: true,
    commerce: true,
    rentals: true,
    calendar: accountType !== 'CLUB',
    workspace: true,
    profileEdit: true,
  });
}

function policyReason(
  input: AccountPolicyInput,
  band: AgeBand,
  sessionStale: boolean,
): AccountPolicyReason | null {
  // The order is contractual. When damaged/legacy data violates more than one
  // invariant, callers receive one stable remediation reason.
  if (input.accountStatus === 'DELETION_REQUESTED') return 'DELETION_REQUESTED';
  if (sessionStale) return 'GUARDIAN_SESSION_STALE';
  if (input.accountControl === 'GUARDIAN_MANAGED' && band === 'ADULT') return 'HANDOVER_REQUIRED';
  if (input.accountStatus === 'CONSENT_REQUIRED'
    || (input.accountControl === 'GUARDIAN_MANAGED' && !input.hasCurrentConsent)) {
    return 'CONSENT_REQUIRED';
  }
  if (input.accountControl === 'SELF' && band === 'CHILD') return 'PARENT_ACCOUNT_REQUIRED';
  return null;
}

/**
 * Produces the server-owned direct-account policy decision. Unknown DOBs are a
 * legacy review state, not a lock; lifecycle and stale-session gates still
 * apply. A valid managed child has no direct-account capabilities even when no
 * remediation action is required.
 */
export function evaluateAccountPolicy(
  input: AccountPolicyInput,
  options: AgeCalculationOptions = {},
): AccountPolicyDecision {
  // Validate custom thresholds even when the DOB is unknown. This prevents an
  // invalid deployment policy from being hidden by whichever account is read.
  calculationAges(options);

  const age = ageOnSingaporeDate(input.dateOfBirth, input.now);
  const band = ageBand(age, options);
  const needsAgeReview = input.accountType !== 'CLUB' && age == null;
  const sessionStale = input.accountControl === 'GUARDIAN_MANAGED'
    && input.sessionCreatedAt != null;
  const needsHandover = input.accountControl === 'GUARDIAN_MANAGED' && band === 'ADULT';
  const reason = policyReason(input, band, sessionStale);

  let capabilities: AccountCapabilities;
  if (input.accountControl === 'GUARDIAN_MANAGED') {
    capabilities = Object.freeze(noCapabilities());
  } else if (reason) {
    capabilities = restrictedSelfCapabilities();
  } else if (band === 'TEEN') {
    capabilities = teenSelfCapabilities();
  } else {
    // Adults and SELF legacy accounts with unknown DOB retain their established
    // access while the latter are flagged for age review.
    capabilities = adultSelfCapabilities(input.accountType);
  }

  const publiclyDiscoverable = input.profileVisibility === 'PUBLIC'
    && input.accountControl === 'SELF'
    && capabilities.directory
    && reason == null;

  return Object.freeze({
    age,
    ageBand: band,
    needsAgeReview,
    needsHandover,
    sessionStale,
    accountActionRequired: reason != null,
    reason,
    capabilities,
    publiclyDiscoverable,
  });
}
