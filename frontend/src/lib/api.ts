import {
  isManagerWorkspace,
  isWorkspaceResponse,
  type AccountBooking,
  type AccountBookingsResult,
  type AccountDirectoryUser,
  type AccountPackage,
  type AccountSecurity,
  type AccountSecuritySession,
  type AuthSession,
  type AuditEventListResult,
  type BookingInput,
  type BookingListFilters,
  type BookingListResult,
  type BookingSeriesInput,
  type BookingSeriesResult,
  type BookingResult,
  type Business,
  type CalendarConnectionStatus,
  type CalendarPreferences,
  type CalendarReturnTo,
  type NotificationPreferences,
  type NotificationPreferencesResponse,
  type ChatProposalAction,
  type ChatProposalSchedulingChoice,
  type ChatThreadDetail,
  type ChatThreadList,
  type ChatMessage,
  type ChatReportConfirmation,
  type ChatReportInput,
  type CheckoutInput,
  type CheckoutReview,
  type CheckoutResult,
  type CoachInvitation,
  type FamilyChild,
  type FamilyBookingChildrenResponse,
  type FamilyChildBookingInput,
  type FamilyChildBookingResult,
  type FamilyConsentRenewalChild,
  type FamilyChildInput,
  type FamilyChildUpdateInput,
  type FamilyHandover,
  type FamilyHandoverPublic,
  type FamilyResponse,
  type ClubStaffAccess,
  type ClubStaffAccessInput,
  type ClubStaffInvitation,
  type ClubStaffWorkspaceAccess,
  type ClubSafeguardingReportUpdate,
  type IntegrityFlag,
  type LiveCheckoutInput,
  type LiveCheckoutResult,
  type LoginResult,
  type MfaLoginChallenge,
  type MfaMethod,
  type PackageOffer,
  type PackageOfferBusiness,
  type PackageOfferInput,
  type Payment,
  type PaymentCapabilities,
  type PaymentIntent,
  type PaymentReceipt,
  type PrivacyRequest,
  type PrivacyRequestInput,
  type PrivacyRequestPage,
  type AdminPrivacyRequest,
  type PrivacyOperatorUpdate,
  type PrivacyRequestEventPage,
  type ProviderBookingResult,
  type PublicBusiness,
  type PublicBookingInput,
  type RentalConfigInput,
  type RentalConfigUpdate,
  type RentalDetail,
  type RentalLocationSaveInput,
  type RentalLocationSaveResult,
  type RentalListing,
  type RentalReservation,
  type RentalReservationFilters,
  type RentalReservationListResult,
  type RentalReservationInput,
  type RentalReservationResult,
  type RentalSlotsResult,
  type RescheduleRequest,
  type RecentAuthentication,
  type SafeguardingAccountAction,
  type SafeguardingReport,
  type SafeguardingReportFilters,
  type SafeguardingReportList,
  type SafeguardingReportUpdate,
  type OperationsInboxCategory,
  type OperationsInboxResult,
  type Slot,
  type StudentClubDirectoryPage,
  type StudentClubDirectoryResult,
  type TotpEnrollment,
  type VenueSearchResult,
  type WorkspaceBooking,
  type WorkspaceResponse,
  type WorkspaceWireResponse,
  type AccountWaitlistEntry,
  type Attendance,
  type BookingResult as WaitlistBookingResult,
  type ChildProgress,
  type ChildSchedule,
  type CoachProfileInput,
  type FavoriteClub,
  type FeedbackInput,
  type GrowthInsights,
  type PackageActivity,
  type ProgressFilters,
  type ProgressSummary,
  type ProviderFeedback,
  type ProviderFeedbackList,
  type ProviderWaitlist,
  type ProviderWaitlistEntry,
  type SessionSearchFilters,
  type SessionSearchResponse,
  type TrainingGroup,
  type TrainingGroupInput,
  type WaitlistJoinInput,
} from './types';
import {
  normalizeChatThreadDetail,
  normalizeChatThreadList,
  type ChatThreadDetailWire,
  type ChatThreadListWire,
} from './chat-wire';
import { isRecentAuthRequired } from './account-security';
import { requestRecentAuthentication } from './recent-auth-coordinator';

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) { super(message); }
}
type ApiFetchResult = { response: Response; prefetchedJson?: unknown };

async function apiFetch(path: string, options: RequestInit = {}, allowRecentAuthRetry = true): Promise<ApiFetchResult> {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, credentials: 'include' });
  if (allowRecentAuthRetry && path !== '/account/security/recent-auth'
    && response.status === 428 && response.headers.get('content-type')?.includes('application/json')) {
    const details = await response.json().catch(() => null);
    if (isRecentAuthRequired(new ApiError(details?.error || 'Confirm your identity to continue', response.status, details))
      && await requestRecentAuthentication()) {
      return apiFetch(path, options, false);
    }
    return { response, prefetchedJson: details };
  }
  return { response };
}

export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const { response, prefetchedJson } = await apiFetch(path, options);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new ApiError('The booking service is temporarily unavailable. Please try again.', response.status);
  const data = prefetchedJson ?? await response.json();
  if (!response.ok) throw new ApiError(data.error || 'Something went wrong. Please try again.', response.status, data);
  return data;
}
/**
 * Load the workspace, tolerating an API that predates newer collections.
 *
 * The frontend and the API deploy separately, so for a few seconds after a
 * release the browser can hold new code against an older server. A missing
 * collection should not blank the page, so the arrays this build reads are
 * normalised here rather than guarded at every use.
 */
export async function loadWorkspace(): Promise<WorkspaceResponse> {
  const workspace = await api<WorkspaceWireResponse>('/workspace');
  if (!isWorkspaceResponse(workspace)) {
    throw new ApiError('This legacy practice workspace is no longer available. Choose a club workspace from your account.', 403);
  }
  const common = {
    staffAccesses: workspace.staffAccesses ?? [],
    permissions: workspace.permissions ?? [],
    rescheduleRequests: workspace.rescheduleRequests ?? [],
    notifications: (workspace.notifications ?? []).map(notification => ({
      ...notification,
      type: notification.type ?? 'NOTICE',
      actionNeeded: notification.actionNeeded ?? false,
      bookingId: notification.bookingId ?? null,
      integrityFlagId: notification.integrityFlagId ?? null,
    })),
  };
  if (isManagerWorkspace(workspace)) {
    return { ...workspace, ...common, integrityFlags: workspace.integrityFlags ?? [] };
  }
  return { ...workspace, ...common, clubAccount: false, packages: [], payments: [], integrityFlags: [] };
}

type CompatibleBusiness = Business;
type CompatibleAuthSession = Omit<AuthSession, 'user' | 'membership' | 'business' | 'memberships' | 'staffAccess' | 'staffAccesses'> & {
  user: AuthSession['user'];
  membership: (Omit<NonNullable<AuthSession['membership']>, 'business'> & { business: CompatibleBusiness }) | null;
  business: CompatibleBusiness | null;
  memberships: Array<Omit<AuthSession['memberships'][number], 'business'> & { business: CompatibleBusiness }>;
  staffAccess?: (Omit<ClubStaffWorkspaceAccess, 'business'> & { business: CompatibleBusiness }) | null;
  staffAccesses?: Array<Omit<ClubStaffWorkspaceAccess, 'business'> & { business: CompatibleBusiness }>;
};

function readableUsername(user: CompatibleAuthSession['user']) {
  if (user.username?.trim()) return user.username.trim();
  const identity = user.email?.split('@')[0] || user.legalName || user.name;
  const readable = identity.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return readable.length >= 3 ? readable : `user_${user.id.slice(0, 12).toLowerCase()}`;
}

/** Keep a rolling deployment usable while older auth payloads are still in flight. */
export function normalizeAuthSession(value: CompatibleAuthSession): AuthSession {
  const business = (candidate: CompatibleBusiness): Business => ({ ...candidate, legacyReadOnly: candidate.legacyReadOnly ?? false });
  const membership = value.membership ? { ...value.membership, business: business(value.membership.business) } : null;
  const staffAccess = value.staffAccess ? { ...value.staffAccess, business: business(value.staffAccess.business) } : null;
  return {
    ...value,
    user: {
      ...value.user,
      email: value.user.email ?? null,
      username: readableUsername(value.user),
      sports: value.user.sports ?? [],
      legalName: value.user.legalName ?? value.user.name,
      dateOfBirth: value.user.dateOfBirth ?? null,
      accountControl: value.user.accountControl ?? null,
      accountStatus: value.user.accountStatus ?? null,
      profileVisibility: value.user.profileVisibility ?? null,
      ageBand: value.user.ageBand ?? null,
      needsAgeReview: value.user.needsAgeReview ?? false,
      requiredAction: value.user.requiredAction ?? null,
      capabilities: value.user.capabilities,
    },
    membership,
    staffAccess,
    business: value.business ? business(value.business) : null,
    memberships: (value.memberships ?? []).map(membership => ({ ...membership, business: business(membership.business) })),
    staffAccesses: (value.staffAccesses ?? []).map(access => ({ ...access, business: business(access.business) })),
    accessMode: value.accessMode ?? (staffAccess ? 'STAFF' : membership ? value.user.accountType === 'CLUB' ? 'CLUB_ACCOUNT' : 'COACH' : 'NONE'),
  };
}

export const loadPublicBusiness = (slug: string) => api<PublicBusiness>(`/public/${encodeURIComponent(slug)}`);
export const loadSlots = (slug: string, values: { serviceId: string; instructorId: string; locationId: string; date: string }) => api<{ slots: Slot[] }>(`/public/${encodeURIComponent(slug)}/slots?${new URLSearchParams(values)}`);
export const createBooking = (values: BookingInput) => api<ProviderBookingResult>('/bookings', { method: 'POST', body: JSON.stringify(values) });
const filteredQuery = (values: Record<string, string | number | undefined>) => {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') parameters.set(key, String(value));
  return parameters.size ? `?${parameters}` : '';
};
export const loadBookings = (filters: BookingListFilters = {}) =>
  api<BookingListResult>(`/bookings${filteredQuery(filters)}`);
export const loadBooking = (bookingId: string) =>
  api<{ booking: WorkspaceBooking }>(`/bookings/${encodeURIComponent(bookingId)}`);
export const loadAuditEvents = (filters: { cursor?: string; limit?: number } = {}) =>
  api<AuditEventListResult>(`/audit-events${filteredQuery(filters)}`);
export async function downloadBookingsCsv(filters: Omit<BookingListFilters, 'cursor' | 'limit'>) {
  const { response, prefetchedJson } = await apiFetch(`/bookings/export.csv${filteredQuery(filters)}`, { credentials: 'include' });
  if (!response.ok) {
    let data: { error?: string } = {};
    if (response.headers.get('content-type')?.includes('application/json')) data = (prefetchedJson ?? await response.json()) as { error?: string };
    throw new ApiError(data.error || 'The booking export could not be downloaded.', response.status, data);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const filename = /filename="?([^";]+)"?/iu.exec(disposition)?.[1] || 'courtly-bookings.csv';
  return { blob: await response.blob(), filename };
}
export const loadOperationsInbox = (filters: { category?: OperationsInboxCategory; cursor?: string; limit?: number } = {}) =>
  api<OperationsInboxResult>(`/operations/inbox${filteredQuery(filters)}`);
export const createBookingSeries = (values: BookingSeriesInput) => api<BookingSeriesResult>('/booking-series', { method: 'POST', body: JSON.stringify(values) });
export const createPublicBooking = (slug: string, values: PublicBookingInput) => api<BookingResult>(`/public/${encodeURIComponent(slug)}/bookings`, { method: 'POST', body: JSON.stringify(values) });
export async function loadAuthSession(): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/me'));
}
export function isMfaLoginChallenge(value: LoginResult): value is MfaLoginChallenge {
  return 'mfaRequired' in value && value.mfaRequired === true;
}
export async function loginAccount(values: { email: string; password: string }): Promise<LoginResult> {
  const result = await api<CompatibleAuthSession | MfaLoginChallenge>('/auth/login', {
    method: 'POST', body: JSON.stringify(values),
  });
  return isMfaLoginChallenge(result as LoginResult)
    ? result as MfaLoginChallenge
    : normalizeAuthSession(result as CompatibleAuthSession);
}
export const loginStudentAccount = loginAccount;
type RegisterAccountBase = {
  name: string; username: string; sports?: string[]; email: string; password: string;
  phone?: string; parentName?: string;
  termsAccepted: true; privacyNoticeAcknowledged: true; termsVersion: string; privacyPolicyVersion: string;
  policySetHash: string;
};
export type RegisterPersonalAccountInput = RegisterAccountBase & {
  accountType: 'STUDENT' | 'COACH'; dateOfBirth: string; businessName?: never;
};
export type RegisterClubAccountInput = RegisterAccountBase & {
  accountType: 'CLUB'; businessName: string; dateOfBirth?: never;
};
export type RegisterAccountInput = RegisterPersonalAccountInput | RegisterClubAccountInput;
export async function registerAccount(values: RegisterAccountInput): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/register', { method: 'POST', body: JSON.stringify(values) }));
}
export const verifyAccountEmail = (token: string) =>
  api<{ ok: true; verifiedAt: string }>('/auth/verify-email', {
    method: 'POST', body: JSON.stringify({ token }),
  });
export const resendAccountEmailVerification = () =>
  api<{ ok: true; emailQueued: boolean; alreadyVerified: boolean; expiresAt?: string | null }>(
    '/auth/email-verification/resend', { method: 'POST', body: JSON.stringify({}) },
  );
export const requestPasswordReset = (email: string) =>
  api<{ ok: true }>('/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) });
export const resetAccountPassword = (token: string, newPassword: string) =>
  api<{ ok: true }>('/auth/password-reset/confirm', { method: 'POST', body: JSON.stringify({ token, password: newPassword }) });
export async function completeMfaLogin(challengeId: string, method: MfaMethod, code: string): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/mfa/challenge', {
    method: 'POST', body: JSON.stringify({ challengeId, method, code }),
  }));
}
export const confirmAccountEmailChange = (token: string) =>
  api<{ ok: true; email: string }>('/auth/email-change/confirm', {
    method: 'POST', body: JSON.stringify({ token }),
  });
type AccountSecuritySummaryWire = Omit<AccountSecurity, 'sessions' | 'recentAuth'> & {
  sessions?: AccountSecuritySession[] | number; currentSessionId?: string; recentAuth?: RecentAuthentication; recentAuthUntil?: string | null;
  mfa: AccountSecurity['mfa'] & { enabledAt?: string | null };
};
export async function loadAccountSecurity(): Promise<AccountSecurity> {
  const summary = await api<AccountSecuritySummaryWire>('/account/security');
  const sessions = Array.isArray(summary.sessions)
    ? summary.sessions
    : (await loadAccountSecuritySessions()).sessions;
  return {
    email: summary.email, emailVerified: summary.emailVerified, sessions,
    mfa: {
      enabled: summary.mfa.enabled,
      verifiedAt: summary.mfa.verifiedAt ?? summary.mfa.enabledAt ?? null,
      recoveryCodesRemaining: summary.mfa.recoveryCodesRemaining,
    },
    recentAuth: summary.recentAuth ?? {
      authenticatedAt: null, expiresAt: summary.recentAuthUntil ?? null,
    },
  };
}
export const requestAccountEmailChange = (email: string) =>
  api<{ ok: true; expiresAt: string }>('/account/security/email-change', {
    method: 'POST', body: JSON.stringify({ email }),
  });
export const startTotpEnrollment = () =>
  api<TotpEnrollment>('/account/security/mfa/enrollment', { method: 'POST', body: JSON.stringify({}) });
export const confirmTotpEnrollment = (enrollmentId: string, code: string) =>
  api<{ ok: true; recoveryCodes: string[] }>('/account/security/mfa/enable', {
    method: 'POST', body: JSON.stringify({ enrollmentId, code }),
  });
export const disableAccountMfa = () =>
  api<{ ok: true }>('/account/security/mfa', { method: 'DELETE', body: JSON.stringify({}) });
export const regenerateMfaRecoveryCodes = () =>
  api<{ recoveryCodes: string[] }>('/account/security/mfa/recovery-codes', {
    method: 'POST', body: JSON.stringify({}),
  });
export const loadAccountSecuritySessions = () =>
  api<{ sessions: AccountSecuritySession[] }>('/account/security/sessions');
export const revokeAccountSecuritySession = (id: string) =>
  api<{ ok: true }>(`/account/security/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE', body: JSON.stringify({}),
  });
export const revokeOtherAccountSecuritySessions = () =>
  api<{ ok: true }>('/account/security/sessions/revoke-others', {
    method: 'POST', body: JSON.stringify({}),
  });
export async function reauthenticateAccount(values: { password: string; method?: MfaMethod; code?: string }) {
  const result = await api<{ ok: true; recentAuth?: RecentAuthentication; recentAuthUntil?: string }>('/account/security/recent-auth', {
    method: 'POST', body: JSON.stringify(values),
  });
  return { ...result, recentAuth: result.recentAuth ?? { authenticatedAt: new Date().toISOString(), expiresAt: result.recentAuthUntil ?? null } };
}
export const loadPrivacyRequests = (filters: { cursor?: string; limit?: number } = {}) =>
  api<PrivacyRequestPage>(`/privacy/requests${filteredQuery(filters)}`);
export const createPrivacyRequest = (values: PrivacyRequestInput) =>
  api<{ request: PrivacyRequest }>('/privacy/requests', { method: 'POST', body: JSON.stringify(values) });
export const cancelPrivacyRequest = (id: string) =>
  api<{ request: PrivacyRequest }>(`/privacy/requests/${encodeURIComponent(id)}/cancel`, {
    method: 'POST', body: JSON.stringify({}),
  });
export const registerStudentAccount = (values: Omit<RegisterPersonalAccountInput, 'accountType' | 'businessName'>) =>
  registerAccount({ ...values, accountType: 'STUDENT' });
export type AccountProfileInput = Partial<Pick<AuthSession['user'], 'name' | 'username' | 'sports' | 'phone' | 'parentName'>> & {
  /** COACH accounts only; the API rejects it for other account types. */
  coachProfile?: CoachProfileInput;
};
export async function updateAuthAccount(values: AccountProfileInput): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/me', { method: 'PATCH', body: JSON.stringify(values) }));
}
export type ClubProfileInput = Pick<Business, 'name' | 'ownerName' | 'email' | 'tagline' | 'color' | 'cancellationHours'>
  & { username: string; sports: string[] };
export async function updateClubProfile(values: ClubProfileInput): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/club-profile', { method: 'PATCH', body: JSON.stringify(values) }));
}
export const logoutAccount = () => api<{ ok: true }>('/auth/logout', { method: 'POST', body: JSON.stringify({}) });

export async function loadFamily(): Promise<FamilyResponse> {
  type FamilyWireResponse = Omit<FamilyResponse, 'children'> & {
    children?: FamilyResponse['children'];
  };
  const family = await api<FamilyWireResponse>('/family');
  return { ...family, children: family.children ?? [] };
}
export const loadFamilyBookingChildren = () =>
  api<FamilyBookingChildrenResponse>('/family/booking-children');
export const createFamilyChildBooking = (id: string, values: FamilyChildBookingInput) =>
  api<FamilyChildBookingResult>(`/family/children/${encodeURIComponent(id)}/bookings`, {
    method: 'POST', body: JSON.stringify(values),
  });
export async function setFamilyDateOfBirth(dateOfBirth: string): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/family/date-of-birth', {
    method: 'POST', body: JSON.stringify({ dateOfBirth }),
  }));
}
export const createFamilyChild = (values: FamilyChildInput) =>
  api<{ child: FamilyChild }>('/family/children', { method: 'POST', body: JSON.stringify(values) });
export const updateFamilyChild = (id: string, values: FamilyChildUpdateInput) =>
  api<{ child: FamilyChild }>(`/family/children/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) });
export const withdrawFamilyChildConsent = (id: string) =>
  api<{ child: FamilyConsentRenewalChild }>(`/family/children/${encodeURIComponent(id)}/consent/withdraw`, { method: 'POST', body: JSON.stringify({}) });
export const renewFamilyChildConsent = (id: string, privacyPolicyVersion: string) =>
  api<{ child: FamilyChild | FamilyConsentRenewalChild }>(`/family/children/${encodeURIComponent(id)}/consent/renew`, {
    method: 'POST', body: JSON.stringify({ legalGuardianConfirmed: true, privacyPolicyVersion }),
  });
export const requestFamilyChildDeletion = (id: string) =>
  api<{ child: FamilyChild }>(`/family/children/${encodeURIComponent(id)}/deletion-request`, { method: 'POST', body: JSON.stringify({}) });
export const createFamilyHandover = (id: string, destinationEmail: string) =>
  api<{ handover: FamilyHandover; emailQueued: true }>(`/family/children/${encodeURIComponent(id)}/handovers`, { method: 'POST', body: JSON.stringify({ destinationEmail }) });
export const cancelFamilyHandover = (id: string, handoverId: string) =>
  api<{ ok: true }>(`/family/children/${encodeURIComponent(id)}/handovers/${encodeURIComponent(handoverId)}`, { method: 'DELETE', body: JSON.stringify({}) });
export async function downloadFamilyChildExport(id: string) {
  const { response, prefetchedJson } = await apiFetch(`/family/children/${encodeURIComponent(id)}/export`, { credentials: 'include' });
  if (!response.ok) {
    let data: { error?: string } = {};
    if (response.headers.get('content-type')?.includes('application/json')) data = (prefetchedJson ?? await response.json()) as { error?: string };
    throw new ApiError(data.error || 'This child data export could not be downloaded.', response.status, data);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const filename = /filename="?([^";]+)"?/iu.exec(disposition)?.[1] || 'courtly-child-data.json';
  return { blob: await response.blob(), filename };
}
export const loadFamilyHandover = (token: string) =>
  api<FamilyHandoverPublic>(`/family/handovers/${encodeURIComponent(token)}`);
export const completeFamilyHandover = (token: string, password: string) =>
  api<{ ok: true; username?: string; loginEmail?: string }>(`/family/handovers/${encodeURIComponent(token)}/complete`, { method: 'POST', body: JSON.stringify({ password }) });
export async function loadAccountBookings(businessSlug?: string): Promise<AccountBookingsResult> {
  const query = businessSlug ? `?${new URLSearchParams({ businessSlug })}` : '';
  const value = await api<AccountBookingsResult | AccountBooking[]>(`/account/bookings${query}`);
  return Array.isArray(value) ? { bookings: value } : value;
}
export async function loadAccountClubs(): Promise<StudentClubDirectoryResult> {
  const clubs: StudentClubDirectoryResult['clubs'] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const query = `?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: '50' })}`;
    const page = await api<StudentClubDirectoryPage>(`/account/clubs${query}`);
    clubs.push(...page.clubs);
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new ApiError('The club directory returned an invalid page. Please try again.', 502);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  clubs.sort((a, b) =>
    a.business.name.localeCompare(b.business.name) || a.business.slug.localeCompare(b.business.slug));
  return { clubs };
}
export const cancelAccountBooking = (participantId: string) => api(`/account/bookings/${encodeURIComponent(participantId)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
export const loadCoachInvitations = () => api<{ invitations: CoachInvitation[] }>('/coach-invitations');
export const acceptCoachInvitation = (input: { invitationId: string } | { token: string }) =>
  api<{ membershipId: string }>('/coach-invitations/accept', { method: 'POST', body: JSON.stringify(input) });
export const loadClubStaffInvitations = () => api<{ invitations: ClubStaffInvitation[] }>('/club-staff-invitations');
export const acceptClubStaffInvitation = (input: { invitationId: string } | { token: string }) =>
  api<{ staffAccess: ClubStaffAccess }>('/club-staff-invitations/accept', { method: 'POST', body: JSON.stringify(input) });
export async function switchWorkspaceAccess(source: 'MEMBERSHIP' | 'STAFF', id: string | null): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/workspace-access', {
    method: 'POST', body: JSON.stringify({ source, id }),
  }));
}
export const loadStaffInvitations = () => api<{ invitations: CoachInvitation[] }>('/staff/invitations');
export const createStaffInvitation = (values: { email: string; rescheduleNoticeHours: number }) =>
  api<{ invitation: CoachInvitation; invitePath: string }>('/staff/invitations', { method: 'POST', body: JSON.stringify(values) });
export const revokeStaffInvitation = (invitationId: string) =>
  api<{ ok: true }>(`/staff/invitations/${encodeURIComponent(invitationId)}`, { method: 'DELETE', body: JSON.stringify({}) });
export const loadClubStaffAccess = () => api<{ staff: ClubStaffAccess[] }>('/staff-access');
export const loadClubStaffAccessInvitations = () => api<{ invitations: ClubStaffInvitation[] }>('/staff-access/invitations');
export const createClubStaffAccessInvitation = (values: ClubStaffAccessInput & { email: string }) =>
  api<{ invitation: ClubStaffInvitation; invitePath: string }>('/staff-access/invitations', { method: 'POST', body: JSON.stringify(values) });
export const updateClubStaffAccess = (accessId: string, values: ClubStaffAccessInput) =>
  api<ClubStaffAccess>(`/staff-access/${encodeURIComponent(accessId)}`, { method: 'PATCH', body: JSON.stringify(values) });
export const revokeClubStaffAccess = (accessId: string) =>
  api<{ ok: true }>(`/staff-access/${encodeURIComponent(accessId)}`, { method: 'DELETE', body: JSON.stringify({}) });
export const revokeClubStaffAccessInvitation = (invitationId: string) =>
  api<{ ok: true }>(`/staff-access/invitations/${encodeURIComponent(invitationId)}`, { method: 'DELETE', body: JSON.stringify({}) });

// A student proposes a new time; the coach's side decides. Nothing moves
// until the request is accepted, so all three of these return the booking in
// its current state rather than a moved one.
export const requestAccountReschedule = (participantId: string, startAt: string, message = '') =>
  api<AccountBooking>(`/account/bookings/${encodeURIComponent(participantId)}/reschedule-requests`, {
    method: 'POST', body: JSON.stringify({ startAt, message }),
  });
export const acceptAccountReschedule = (requestId: string, message = '') =>
  api<AccountBooking>(`/account/reschedule-requests/${encodeURIComponent(requestId)}/accept`, {
    method: 'POST', body: JSON.stringify({ message }),
  });
export const declineAccountReschedule = (requestId: string, message = '') =>
  api<AccountBooking>(`/account/reschedule-requests/${encodeURIComponent(requestId)}/decline`, {
    method: 'POST', body: JSON.stringify({ message }),
  });

// Provider side of the same negotiation, plus the coach's decision on a
// lesson the club assigned to them.
export const proposeWorkspaceReschedule = (bookingId: string, startAt: string, message = '') =>
  api<RescheduleRequest>(`/bookings/${encodeURIComponent(bookingId)}/reschedule-requests`, {
    method: 'POST', body: JSON.stringify({ startAt, message }),
  });
export const respondToRescheduleRequest = (requestId: string, action: 'accept' | 'decline' | 'withdraw', message = '') =>
  api<RescheduleRequest | { request: RescheduleRequest; booking: WorkspaceBooking }>(`/reschedule-requests/${encodeURIComponent(requestId)}/${action}`, {
    method: 'POST', body: JSON.stringify(action === 'withdraw' ? {} : { message }),
  });
export const respondToAssignment = (bookingId: string, action: 'accept' | 'decline', message = '') =>
  api<WorkspaceBooking>(`/bookings/${encodeURIComponent(bookingId)}/${action}`, {
    method: 'POST', body: JSON.stringify({ message }),
  });

// Recording a payment is a human action, so it has to be undoable. The row is
// kept and marked reversed rather than deleted.
export const reversePayment = (paymentId: string, reason = '') =>
  api<{ ok: true; payment: Payment }>(`/payments/${encodeURIComponent(paymentId)}`, {
    method: 'DELETE', body: JSON.stringify({ reason }),
  });
export const recordCoachPayout = (values: { instructorId: string; amount: number; method: string; note?: string }) =>
  api<Payment>('/payouts', { method: 'POST', body: JSON.stringify(values) });

export const searchVenues = (query: string) =>
  api<VenueSearchResult>(`/venues/search?${new URLSearchParams({ q: query })}`);

export async function searchAccounts(query: string): Promise<AccountDirectoryUser[]> {
  const value = await api<AccountDirectoryUser[] | { accounts: AccountDirectoryUser[] }>(
    `/accounts/search?${new URLSearchParams({ q: query.trim() })}`,
  );
  return Array.isArray(value) ? value : value.accounts;
}

export const loadPackageOffers = () => api<{ offers: PackageOffer[] }>('/package-offers');
export const createPackageOffer = (values: PackageOfferInput) =>
  api<PackageOffer>('/package-offers', { method: 'POST', body: JSON.stringify(values) });
export const updatePackageOffer = (id: string, values: Partial<PackageOfferInput>) =>
  api<PackageOffer>(`/package-offers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) });
export const deletePackageOffer = (id: string) =>
  api<{ deleted: boolean; archived: boolean }>(`/package-offers/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const loadAccountPackageOffers = (businessSlug?: string) => {
  const query = businessSlug ? `?${new URLSearchParams({ businessSlug })}` : '';
  return api<{ business: PackageOfferBusiness; offers: PackageOffer[] }>(`/account/package-offers${query}`);
};
// These aliases match the student marketplace vocabulary used by the screens.
export const getAccountPackageOffers = loadAccountPackageOffers;
export const loadAccountPackages = () => api<{ packages: AccountPackage[] }>('/account/packages');
export const getAccountPackages = loadAccountPackages;
export async function loadCheckoutReview(kind: 'PACKAGE' | 'BOOKING', targetId: string): Promise<CheckoutReview> {
  const query = new URLSearchParams({ kind, targetId });
  const result = await api<{ review: CheckoutReview }>(`/payments/checkout-review?${query}`);
  return result.review;
}
export const checkoutPackageOffer = (id: string, values: CheckoutInput) =>
  api<CheckoutResult>(`/account/package-offers/${encodeURIComponent(id)}/checkout`, { method: 'POST', body: JSON.stringify(values) });
export const checkoutBookingParticipant = (participantId: string, values: CheckoutInput) =>
  api<CheckoutResult>(`/account/bookings/${encodeURIComponent(participantId)}/checkout`, { method: 'POST', body: JSON.stringify(values) });
export const loadPaymentCapabilities = () => api<PaymentCapabilities>('/payments/capabilities');
export const createLiveCheckoutIntent = (values: LiveCheckoutInput) =>
  api<LiveCheckoutResult>('/payments/checkout-intents', { method: 'POST', body: JSON.stringify(values) });
export const loadLiveCheckoutIntent = (id: string) =>
  api<{ paymentIntent: PaymentIntent }>(`/payments/checkout-intents/${encodeURIComponent(id)}`);
export const loadPaymentReceipts = () => api<{ receipts: PaymentReceipt[] }>('/payments/receipts');
export const paymentReceiptDocumentUrl = (id: string, download = false) =>
  `/api/payments/receipts/${encodeURIComponent(id)}/document${download ? '?download=1' : ''}`;

export const loadRentals = (filters: { query?: string; sport?: string; cursor?: string } = {}) => {
  const parameters = new URLSearchParams();
  if (filters.query) parameters.set('query', filters.query);
  if (filters.sport) parameters.set('sport', filters.sport);
  if (filters.cursor) parameters.set('cursor', filters.cursor);
  const query = parameters.size ? `?${parameters}` : '';
  return api<{ rentals: RentalListing[]; nextCursor: string | null }>(`/rentals${query}`);
};
export async function loadRental(id: string): Promise<RentalDetail> {
  const result = await api<{ rental: RentalDetail }>(`/rentals/${encodeURIComponent(id)}`);
  return result.rental;
}
export const loadRentalSlots = (id: string, values: { date: string; duration: number }) =>
  api<RentalSlotsResult>(`/rentals/${encodeURIComponent(id)}/slots?${new URLSearchParams({ date: values.date, duration: String(values.duration) })}`);
export const createRentalReservation = (id: string, values: RentalReservationInput) =>
  api<RentalReservationResult>(`/rentals/${encodeURIComponent(id)}/reservations`, { method: 'POST', body: JSON.stringify(values) });
export const loadAccountRentalReservations = () =>
  api<{ reservations: RentalReservation[] }>('/rentals/reservations/mine');
export const loadRentalReservations = (filters: RentalReservationFilters = {}) =>
  api<RentalReservationListResult>(`/rental-reservations${filteredQuery(filters)}`);
export const cancelRentalReservation = (id: string) =>
  api<{ reservation: RentalReservation }>(`/rentals/reservations/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
export async function createRental(values: RentalConfigInput): Promise<RentalDetail> {
  const result = await api<{ rental: RentalDetail }>('/rentals', { method: 'POST', body: JSON.stringify(values) });
  return result.rental;
}
export async function updateRental(id: string, values: RentalConfigUpdate): Promise<RentalDetail> {
  const result = await api<{ rental: RentalDetail }>(`/rentals/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) });
  return result.rental;
}
export const deleteRental = (id: string) =>
  api<{ ok: true }>(`/rentals/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({}) });
export const saveRentalLocation = (id: string, values: RentalLocationSaveInput) =>
  api<RentalLocationSaveResult>(`/rental-locations/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify(values),
  });

type CalendarConnectionWire = {
  configured?: boolean | null; eligible?: boolean | null; provider?: CalendarConnectionStatus['provider'];
  state?: CalendarConnectionStatus['state'] | null; connected?: boolean | null; email?: string | null; calendarName?: string | null;
  syncEnabled?: boolean | null; busyCheckEnabled?: boolean | null; connectedAt?: string | null;
  lastSyncedAt?: string | null; lastBusyAt?: string | null; busyCacheExpiresAt?: string | null; error?: string | null;
};

export function normalizeCalendarConnection(value: CalendarConnectionWire | null | undefined): CalendarConnectionStatus {
  return {
    configured: value?.configured ?? false,
    eligible: value?.eligible ?? false,
    provider: value?.provider ?? null,
    state: value?.state ?? 'DISCONNECTED',
    connected: value?.connected ?? false,
    email: value?.email ?? null,
    calendarName: value?.calendarName ?? null,
    syncEnabled: value?.syncEnabled ?? false,
    busyCheckEnabled: value?.busyCheckEnabled ?? false,
    connectedAt: value?.connectedAt ?? null,
    lastSyncedAt: value?.lastSyncedAt ?? null,
    lastBusyAt: value?.lastBusyAt ?? null,
    busyCacheExpiresAt: value?.busyCacheExpiresAt ?? null,
    error: value?.error ?? null,
  };
}

export async function loadCalendarConnection(): Promise<CalendarConnectionStatus> {
  return normalizeCalendarConnection(await api<CalendarConnectionWire | null>('/calendar/connection'));
}
export const beginGoogleCalendarConnection = (returnTo: CalendarReturnTo) =>
  api<{ authorizationUrl: string }>('/calendar/google/connect', { method: 'POST', body: JSON.stringify({ returnTo }) });
export async function updateCalendarConnection(values: Partial<CalendarPreferences>): Promise<CalendarConnectionStatus> {
  return normalizeCalendarConnection(await api<CalendarConnectionWire>('/calendar/connection', { method: 'PATCH', body: JSON.stringify(values) }));
}
export async function syncGoogleCalendar(): Promise<CalendarConnectionStatus> {
  return normalizeCalendarConnection(await api<CalendarConnectionWire>('/calendar/sync', { method: 'POST', body: JSON.stringify({}) }));
}
export async function disconnectGoogleCalendar(): Promise<CalendarConnectionStatus | null> {
  const value = await api<CalendarConnectionWire | ({ ok: true; status?: CalendarConnectionWire | null } & CalendarConnectionWire) | null>('/calendar/connection', { method: 'DELETE', body: JSON.stringify({}) });
  if (!value) return null;
  if (!('ok' in value) || !value.ok) return normalizeCalendarConnection(value);
  if (value.status) return normalizeCalendarConnection(value.status);
  const hasInlineStatus = Object.keys(value).some(key => key !== 'ok' && key !== 'status');
  return hasInlineStatus ? normalizeCalendarConnection(value) : null;
}
export const loadNotificationPreferences = () =>
  api<NotificationPreferencesResponse>('/account/notification-preferences');
export const updateNotificationPreferences = (preferences: NotificationPreferences) =>
  api<NotificationPreferencesResponse>('/account/notification-preferences', {
    method: 'PATCH', body: JSON.stringify(preferences),
  });
export const resolveIntegrityFlag = (id: string, status: IntegrityFlag['status'], note = '') =>
  api<IntegrityFlag>(`/integrity-flags/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ status, note }),
  });
export const mutate = <T = unknown>(path: string, method: 'POST' | 'PATCH' | 'DELETE', values?: unknown) => api<T>(path, { method, body: values ? JSON.stringify(values) : undefined });

// Chat belongs to the signed-in account, not a selected workspace, so the
// same calls serve booking threads and account conversations across clubs.
const chatListQuery = (params: { q?: string; cursor?: string }) => {
  const query = new URLSearchParams();
  if (params.q?.trim()) query.set('q', params.q.trim());
  if (params.cursor) query.set('cursor', params.cursor);
  return query.size ? `?${query}` : '';
};
const threadQuery = (before?: string, accountContract = false) => {
  const query = new URLSearchParams();
  if (before) query.set('before', before);
  if (accountContract) query.set('contract', 'accounts');
  return query.size ? `?${query}` : '';
};
export async function loadChatThreads(params: { q?: string; cursor?: string } = {}): Promise<ChatThreadList> {
  const query = new URLSearchParams(chatListQuery(params).slice(1));
  query.set('contract', 'accounts');
  try {
    return normalizeChatThreadList(await api<ChatThreadListWire>(`/chats?${query}`));
  } catch (error) {
    if (!(error instanceof ApiError) || ![400, 404].includes(error.status)) throw error;
    // A pre-account-chat API rejects the version marker. Keep SESSION chat
    // usable and leave discovery hidden until the matching API is live.
    return normalizeChatThreadList(await api<ChatThreadListWire>(`/chats${chatListQuery(params)}`));
  }
}
export async function loadChatUnread() {
  try {
    return await api<{ unreadThreads: number }>('/chats/unread?contract=accounts');
  } catch (error) {
    if (!(error instanceof ApiError) || ![400, 404].includes(error.status)) throw error;
    return api<{ unreadThreads: number }>('/chats/unread');
  }
}
export const openBookingChat = (bookingId: string) =>
  api<{ threadId: string }>(`/chats/bookings/${encodeURIComponent(bookingId)}`, { method: 'POST', body: JSON.stringify({}) });
export async function createAccountChat(username: string): Promise<{ threadId: string; thread?: ChatThreadDetail }> {
  const result = await api<{ threadId: string; thread?: ChatThreadDetailWire }>('/chats/accounts', {
    method: 'POST', body: JSON.stringify({ username }),
  });
  // An API that predates the inline thread returns only its ID.
  return result.thread
    ? { threadId: result.threadId, thread: normalizeChatThreadDetail(result.thread) }
    : { threadId: result.threadId };
}
export async function loadChatThread(threadId: string, before?: string): Promise<ChatThreadDetail> {
  try {
    return normalizeChatThreadDetail(await api<ChatThreadDetailWire>(
      `/chats/${encodeURIComponent(threadId)}${threadQuery(before, true)}`,
    ));
  } catch (error) {
    if (!(error instanceof ApiError) || ![400, 404].includes(error.status)) throw error;
    return normalizeChatThreadDetail(await api<ChatThreadDetailWire>(
      `/chats/${encodeURIComponent(threadId)}${threadQuery(before)}`,
    ));
  }
}
export const sendChatMessage = (threadId: string, body: string) =>
  api<{ message: ChatMessage }>(`/chats/${encodeURIComponent(threadId)}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
export function reportChatMessage(threadId: string, input: ChatReportInput): Promise<ChatReportConfirmation> {
  return api<ChatReportConfirmation>(`/chats/${encodeURIComponent(threadId)}/reports`, {
    method: 'POST', body: JSON.stringify(input),
  });
}
export async function blockChatAccount(threadId: string): Promise<ChatThreadDetail> {
  const result = await api<ChatThreadDetailWire | { thread: ChatThreadDetailWire }>(`/chats/${encodeURIComponent(threadId)}/block`, {
    method: 'POST', body: JSON.stringify({}),
  });
  return normalizeChatThreadDetail('thread' in result ? result.thread : result);
}
export async function unblockChatAccount(threadId: string): Promise<ChatThreadDetail> {
  const result = await api<ChatThreadDetailWire | { thread: ChatThreadDetailWire }>(`/chats/${encodeURIComponent(threadId)}/block`, {
    method: 'DELETE', body: JSON.stringify({}),
  });
  return normalizeChatThreadDetail('thread' in result ? result.thread : result);
}
export async function markChatRead(threadId: string) {
  const options = { method: 'POST', body: JSON.stringify({}) };
  try {
    return await api<{ ok: true; unreadThreads: number }>(
      `/chats/${encodeURIComponent(threadId)}/read?contract=accounts`, options,
    );
  } catch (error) {
    if (!(error instanceof ApiError) || ![400, 404].includes(error.status)) throw error;
    return api<{ ok: true; unreadThreads: number }>(`/chats/${encodeURIComponent(threadId)}/read`, options);
  }
}
export async function assignChatCoach(threadId: string, membershipId: string): Promise<{ thread: ChatThreadDetail }> {
  const result = await api<{ thread: ChatThreadDetailWire }>(`/chats/${encodeURIComponent(threadId)}/coach`, {
    method: 'POST', body: JSON.stringify({ membershipId }),
  });
  return { thread: normalizeChatThreadDetail(result.thread) };
}
export async function removeChatCoach(threadId: string): Promise<{ thread: ChatThreadDetail }> {
  const result = await api<{ thread: ChatThreadDetailWire }>(`/chats/${encodeURIComponent(threadId)}/coach`, {
    method: 'DELETE', body: JSON.stringify({}),
  });
  return { thread: normalizeChatThreadDetail(result.thread) };
}
export async function proposeChatSession(
  threadId: string, startAt: string, message = '', scheduling?: ChatProposalSchedulingChoice,
): Promise<{ thread: ChatThreadDetail }> {
  const result = await api<{ thread: ChatThreadDetailWire }>(`/chats/${encodeURIComponent(threadId)}/proposals`, {
    method: 'POST', body: JSON.stringify({ startAt, message, ...(scheduling ?? {}) }),
  });
  return { thread: normalizeChatThreadDetail(result.thread) };
}
export async function respondToChatProposal(proposalId: string, action: ChatProposalAction, message = ''): Promise<{ thread: ChatThreadDetail; bookingId?: string }> {
  const result = await api<{ thread: ChatThreadDetailWire; bookingId?: string }>(`/chats/proposals/${encodeURIComponent(proposalId)}/${action}`, {
    method: 'POST', body: JSON.stringify(action === 'decline' && message ? { message } : {}),
  });
  return { ...result, thread: normalizeChatThreadDetail(result.thread) };
}
export async function counterChatProposal(
  proposalId: string, startAt: string, message = '', scheduling?: ChatProposalSchedulingChoice,
): Promise<{ thread: ChatThreadDetail; proposalId: string }> {
  const result = await api<{ thread: ChatThreadDetailWire; proposalId: string }>(`/chats/proposals/${encodeURIComponent(proposalId)}/counter`, {
    method: 'POST', body: JSON.stringify({ startAt, message, ...(scheduling ?? {}) }),
  });
  return { ...result, thread: normalizeChatThreadDetail(result.thread) };
}
export async function adminChatThreads(params: { q?: string; cursor?: string } = {}): Promise<ChatThreadList> {
  const query = new URLSearchParams(chatListQuery(params).slice(1));
  query.set('contract', 'accounts');
  try {
    return normalizeChatThreadList(await api<ChatThreadListWire>(`/admin/chats?${query}`));
  } catch (error) {
    if (!(error instanceof ApiError) || ![400, 404].includes(error.status)) throw error;
    return normalizeChatThreadList(await api<ChatThreadListWire>(`/admin/chats${chatListQuery(params)}`));
  }
}
export async function adminChatThread(threadId: string, before?: string): Promise<ChatThreadDetail> {
  try {
    return normalizeChatThreadDetail(await api<ChatThreadDetailWire>(
      `/admin/chats/${encodeURIComponent(threadId)}${threadQuery(before, true)}`,
    ));
  } catch (error) {
    if (!(error instanceof ApiError) || ![400, 404].includes(error.status)) throw error;
    return normalizeChatThreadDetail(await api<ChatThreadDetailWire>(
      `/admin/chats/${encodeURIComponent(threadId)}${threadQuery(before)}`,
    ));
  }
}

function safeguardingQuery(filters: SafeguardingReportFilters = {}) {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.severity) query.set('severity', filters.severity);
  if (filters.cursor) query.set('cursor', filters.cursor);
  if (filters.q?.trim()) query.set('q', filters.q.trim());
  return query.size ? `?${query}` : '';
}
export const loadAdminSafeguardingReports = (filters: SafeguardingReportFilters = {}) =>
  api<SafeguardingReportList>(`/admin/safeguarding/reports${safeguardingQuery(filters)}`);
async function safeguardingReportRequest(path: string, options?: RequestInit): Promise<SafeguardingReport> {
  const result = await api<SafeguardingReport | { report: SafeguardingReport }>(path, options);
  return 'report' in result ? result.report : result;
}
export const loadAdminSafeguardingReport = (id: string) =>
  safeguardingReportRequest(`/admin/safeguarding/reports/${encodeURIComponent(id)}`);
export const updateAdminSafeguardingReport = (id: string, update: SafeguardingReportUpdate) =>
  safeguardingReportRequest(`/admin/safeguarding/reports/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ ...update, note: update.note.trim() }),
  });
export const applyAdminSafeguardingAccountAction = (id: string, action: SafeguardingAccountAction, note: string) =>
  safeguardingReportRequest(`/admin/safeguarding/reports/${encodeURIComponent(id)}/account-action`, {
    method: 'POST', body: JSON.stringify({ action, note }),
  });
export const loadClubSafeguardingReports = (filters: SafeguardingReportFilters = {}) =>
  api<SafeguardingReportList>(`/safeguarding/reports${safeguardingQuery(filters)}`);
export const loadClubSafeguardingReport = (id: string) =>
  safeguardingReportRequest(`/safeguarding/reports/${encodeURIComponent(id)}`);
export const updateClubSafeguardingReport = (id: string, update: ClubSafeguardingReportUpdate) =>
  safeguardingReportRequest(`/safeguarding/reports/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ ...update, note: update.note.trim() }),
  });

const privacyOperatorHeaders = { 'X-Courtly-Privacy-Operator': '1' };
export const loadAdminPrivacyRequests = (filters: { status?: string; overdue?: boolean; limit?: number; cursor?: string } = {}) =>
  api<PrivacyRequestPage<AdminPrivacyRequest>>(`/admin/privacy-requests${filteredQuery({
    status: filters.status, overdue: filters.overdue === undefined ? undefined : String(filters.overdue), limit: filters.limit, cursor: filters.cursor,
  })}`, { headers: privacyOperatorHeaders });
export const updateAdminPrivacyRequest = (id: string, update: PrivacyOperatorUpdate) =>
  api<{ request: PrivacyRequest }>(`/admin/privacy-requests/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: privacyOperatorHeaders, body: JSON.stringify(update),
  });
export const loadAdminPrivacyRequestEvents = (id: string, filters: { limit?: number; cursor?: string } = {}) =>
  api<PrivacyRequestEventPage>(`/admin/privacy-requests/${encodeURIComponent(id)}/events${filteredQuery(filters)}`, {
    headers: privacyOperatorHeaders,
  });

export type AdminOperator = { id: string; name: string; email: string };
export type AdminAuthMode = 'named' | 'legacy' | 'disabled';
export type AdminSession = {
  configured: boolean; authenticated: boolean; authMode: AdminAuthMode;
  operator: AdminOperator | null; sensitiveAccess: boolean;
  /** Named operators must submit a current authenticator code when enabled. */
  mfaRequired?: boolean;
  /** Missing only during a rolling deployment from an older API; clients must fail closed. */
  businessDeletionMode?: 'all' | 'demo-only';
};
export type AdminTotals = { businesses: number; demoBusinesses: number; realBusinesses: number; users: number; memberships: number; students: number; bookings: number; upcomingBookings: number; bookingsLast7Days: number; packages: number; paymentsCount: number; paymentsTotal: number;
  /** Optional while an older API without session chat may still answer. */
  chatThreads?: number; chatMessages?: number };
export type AdminOverview = { generatedAt: string; totals: AdminTotals };
export type AdminBusinessCounts = { users: number; students: number; bookings: number; locations: number; services: number; instructors: number };
export type AdminBusiness = { id: string; name: string; slug: string; ownerName: string; email: string; currency: string; timezone: string; isDemo: boolean; createdAt: string; counts: AdminBusinessCounts };
export const adminSession = () => api<AdminSession>('/admin/session');
export type AdminLoginInput = { password: string; email?: string; totpCode?: string };
export const adminLogin = (credentials: AdminLoginInput) =>
  api<{ ok: true; authMode: Exclude<AdminAuthMode, 'disabled'>; operator: AdminOperator | null }>('/admin/login', {
    method: 'POST', body: JSON.stringify(credentials),
  });
export const adminLogout = () => api<{ ok: true }>('/admin/logout', { method: 'POST', body: JSON.stringify({}) });
export const adminOverview = () => api<AdminOverview>('/admin/overview');
export const adminBusinesses = (params: { search?: string; filter?: 'all' | 'real' | 'demo' } = {}) => api<{ businesses: AdminBusiness[] }>(`/admin/businesses?${new URLSearchParams({ ...(params.search ? { search: params.search } : {}), filter: params.filter || 'all' })}`);
export const adminDeleteBusiness = (id: string) => api<{ ok: true }>(`/admin/businesses/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const adminPurgeDemos = () => api<{ ok: true; deleted: number }>('/admin/purge-demos', { method: 'POST', body: JSON.stringify({}) });

/* Training companion. Contract: docs/TRAINING_COMPANION.md */

function queryString(values: Record<string, string | number | undefined | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

// Discovery
export const loadNextAvailableSlots = (slug: string, values: { serviceId: string; instructorId: string; locationId: string; limit?: number }) =>
  api<{ slots: Slot[] }>(`/public/${encodeURIComponent(slug)}/next-available${queryString(values)}`);
export const searchSessions = (filters: SessionSearchFilters) =>
  api<SessionSearchResponse>(`/account/sessions/search${queryString(filters)}`);
export const loadFavoriteClubs = () => api<{ favorites: FavoriteClub[] }>('/account/favorites');
export const saveFavoriteClub = (slug: string) =>
  api<FavoriteClub>(`/account/favorites/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify({}) });
export const removeFavoriteClub = (slug: string) =>
  api<{ ok: true }>(`/account/favorites/${encodeURIComponent(slug)}`, { method: 'DELETE' });

// Progress and coach feedback
export const loadAccountProgress = (filters: ProgressFilters = {}) =>
  api<ProgressSummary>(`/account/progress${queryString(filters)}`);
export const markFeedbackViewed = (id: string) =>
  api<{ ok: true }>(`/account/feedback/${encodeURIComponent(id)}/viewed`, { method: 'POST', body: JSON.stringify({}) });
export const loadBookingFeedback = (bookingId: string) =>
  api<ProviderFeedbackList>(`/bookings/${encodeURIComponent(bookingId)}/feedback`);
export const saveParticipantFeedback = (bookingId: string, participantId: string, values: FeedbackInput) =>
  api<ProviderFeedback>(`/bookings/${encodeURIComponent(bookingId)}/participants/${encodeURIComponent(participantId)}/feedback`, {
    method: 'PUT', body: JSON.stringify(values),
  });
export const markParticipantAttendance = (bookingId: string, participantId: string, attendance: Attendance) =>
  api<{ id: string; attendance: Attendance }>(`/bookings/${encodeURIComponent(bookingId)}/participants/${encodeURIComponent(participantId)}`, {
    method: 'PATCH', body: JSON.stringify({ attendance }),
  });
export const markAllAttendance = (bookingId: string, attendance: Attendance, participantIds?: string[]) =>
  api<{ participants: Array<{ id: string; attendance: Attendance }> }>(`/bookings/${encodeURIComponent(bookingId)}/participants`, {
    method: 'PATCH', body: JSON.stringify(participantIds ? { attendance, participantIds } : { attendance }),
  });

// Family child projections
export const loadFamilyChildSchedule = (childId: string) =>
  api<ChildSchedule>(`/family/children/${encodeURIComponent(childId)}/schedule`);
export const loadFamilyChildProgress = (childId: string) =>
  api<ChildProgress>(`/family/children/${encodeURIComponent(childId)}/progress`);

// Waitlists
export const joinWaitlist = (slug: string, values: WaitlistJoinInput) =>
  api<{ entry: AccountWaitlistEntry }>(`/public/${encodeURIComponent(slug)}/waitlist`, { method: 'POST', body: JSON.stringify(values) });
export const loadAccountWaitlist = () => api<{ entries: AccountWaitlistEntry[] }>('/account/waitlist');
export const acceptWaitlistOffer = (id: string, packageId?: string) =>
  api<{ entry: AccountWaitlistEntry } & WaitlistBookingResult>(`/account/waitlist/${encodeURIComponent(id)}/accept`, {
    method: 'POST', body: JSON.stringify(packageId ? { packageId } : {}),
  });
export const declineWaitlistOffer = (id: string) =>
  api<{ entry: AccountWaitlistEntry }>(`/account/waitlist/${encodeURIComponent(id)}/decline`, { method: 'POST', body: JSON.stringify({}) });
export const leaveWaitlist = (id: string) =>
  api<{ entry: AccountWaitlistEntry }>(`/account/waitlist/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const loadBookingWaitlist = (bookingId: string) =>
  api<ProviderWaitlist>(`/bookings/${encodeURIComponent(bookingId)}/waitlist`);
export const offerWaitlistPlace = (entryId: string) =>
  api<{ entry: ProviderWaitlistEntry }>(`/waitlist/${encodeURIComponent(entryId)}/offer`, { method: 'POST', body: JSON.stringify({}) });
export const removeWaitlistEntry = (entryId: string) =>
  api<{ entry: ProviderWaitlistEntry }>(`/waitlist/${encodeURIComponent(entryId)}`, { method: 'DELETE' });

// Package credit activity
export const loadAccountPackageActivity = (packageId: string) =>
  api<PackageActivity>(`/account/packages/${encodeURIComponent(packageId)}/activity`);
export const loadPackageActivity = (packageId: string) =>
  api<PackageActivity>(`/packages/${encodeURIComponent(packageId)}/activity`);

// Training groups
export const loadTrainingGroups = () => api<{ groups: TrainingGroup[] }>('/training-groups');
export const createTrainingGroup = (values: TrainingGroupInput) =>
  api<TrainingGroup>('/training-groups', { method: 'POST', body: JSON.stringify(values) });
export const updateTrainingGroup = (id: string, values: Partial<TrainingGroupInput> & { active?: boolean }) =>
  api<TrainingGroup>(`/training-groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) });
export const setTrainingGroupMembers = (id: string, studentIds: string[]) =>
  api<TrainingGroup>(`/training-groups/${encodeURIComponent(id)}/members`, { method: 'PUT', body: JSON.stringify({ studentIds }) });
export const archiveTrainingGroup = (id: string) =>
  api<TrainingGroup>(`/training-groups/${encodeURIComponent(id)}`, { method: 'DELETE' });

// Club growth insights
export const loadGrowthInsights = (days = 30) => api<GrowthInsights>(`/insights/growth${queryString({ days })}`);
