import {
  isManagerWorkspace,
  isWorkspaceResponse,
  type AccountBooking,
  type AccountBookingsResult,
  type AccountDirectoryUser,
  type AccountPackage,
  type AuthSession,
  type BookingInput,
  type BookingResult,
  type Business,
  type CalendarConnectionStatus,
  type CalendarPreferences,
  type CalendarReturnTo,
  type ChatProposalAction,
  type ChatThreadDetail,
  type ChatThreadList,
  type ChatMessage,
  type CheckoutInput,
  type CheckoutResult,
  type IntegrityFlag,
  type PackageOffer,
  type PackageOfferBusiness,
  type PackageOfferInput,
  type Payment,
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
  type RentalReservationInput,
  type RentalReservationResult,
  type RentalSlotsResult,
  type RescheduleRequest,
  type Slot,
  type StudentClubDirectoryPage,
  type StudentClubDirectoryResult,
  type VenueSearchResult,
  type WorkspaceBooking,
  type WorkspaceResponse,
  type WorkspaceWireResponse,
} from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) { super(message); }
}
export async function api<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, credentials: 'include' });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new ApiError('The booking service is temporarily unavailable. Please try again.', response.status);
  const data = await response.json();
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
type CompatibleAuthSession = Omit<AuthSession, 'user' | 'membership' | 'business' | 'memberships'> & {
  user: AuthSession['user'];
  membership: (Omit<NonNullable<AuthSession['membership']>, 'business'> & { business: CompatibleBusiness }) | null;
  business: CompatibleBusiness | null;
  memberships: Array<Omit<AuthSession['memberships'][number], 'business'> & { business: CompatibleBusiness }>;
};

function readableUsername(user: CompatibleAuthSession['user']) {
  if (user.username?.trim()) return user.username.trim();
  const fromEmail = user.email.split('@')[0]?.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30);
  return fromEmail && fromEmail.length >= 3 ? fromEmail : `user_${user.id.slice(0, 12).toLowerCase()}`;
}

/** Keep a rolling deployment usable while older auth payloads are still in flight. */
export function normalizeAuthSession(value: CompatibleAuthSession): AuthSession {
  const business = (candidate: CompatibleBusiness): Business => ({ ...candidate, legacyReadOnly: candidate.legacyReadOnly ?? false });
  return {
    ...value,
    user: { ...value.user, username: readableUsername(value.user), sports: value.user.sports ?? [] },
    membership: value.membership ? { ...value.membership, business: business(value.membership.business) } : null,
    business: value.business ? business(value.business) : null,
    memberships: (value.memberships ?? []).map(membership => ({ ...membership, business: business(membership.business) })),
  };
}

export const loadPublicBusiness = (slug: string) => api<PublicBusiness>(`/public/${encodeURIComponent(slug)}`);
export const loadSlots = (slug: string, values: { serviceId: string; instructorId: string; locationId: string; date: string }) => api<{ slots: Slot[] }>(`/public/${encodeURIComponent(slug)}/slots?${new URLSearchParams(values)}`);
export const createBooking = (values: BookingInput) => api<ProviderBookingResult>('/bookings', { method: 'POST', body: JSON.stringify(values) });
export const createPublicBooking = (slug: string, values: PublicBookingInput) => api<BookingResult>(`/public/${encodeURIComponent(slug)}/bookings`, { method: 'POST', body: JSON.stringify(values) });
export async function loadAuthSession(): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/me'));
}
export async function loginAccount(values: { email: string; password: string }): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/login', { method: 'POST', body: JSON.stringify(values) }));
}
export const loginStudentAccount = loginAccount;
export type RegisterAccountInput = {
  accountType: AuthSession['user']['accountType']; businessName?: string; name: string; username: string; sports?: string[];
  email: string; password: string; phone?: string; parentName?: string;
};
export async function registerAccount(values: RegisterAccountInput): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/register', { method: 'POST', body: JSON.stringify(values) }));
}
export const registerStudentAccount = (values: Omit<RegisterAccountInput, 'accountType' | 'businessName'>) =>
  registerAccount({ ...values, accountType: 'STUDENT' });
export type AccountProfileInput = Partial<Pick<AuthSession['user'], 'name' | 'username' | 'sports' | 'phone' | 'parentName'>>;
export async function updateAuthAccount(values: AccountProfileInput): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/me', { method: 'PATCH', body: JSON.stringify(values) }));
}
export type ClubProfileInput = Pick<Business, 'name' | 'ownerName' | 'email' | 'tagline' | 'color' | 'cancellationHours'>
  & { username: string; sports: string[] };
export async function updateClubProfile(values: ClubProfileInput): Promise<AuthSession> {
  return normalizeAuthSession(await api<CompatibleAuthSession>('/auth/club-profile', { method: 'PATCH', body: JSON.stringify(values) }));
}
export const logoutAccount = () => api<{ ok: true }>('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
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
export const checkoutPackageOffer = (id: string, values: CheckoutInput) =>
  api<CheckoutResult>(`/account/package-offers/${encodeURIComponent(id)}/checkout`, { method: 'POST', body: JSON.stringify(values) });
export const checkoutBookingParticipant = (participantId: string, values: CheckoutInput) =>
  api<CheckoutResult>(`/account/bookings/${encodeURIComponent(participantId)}/checkout`, { method: 'POST', body: JSON.stringify(values) });

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
export const resolveIntegrityFlag = (id: string, status: IntegrityFlag['status'], note = '') =>
  api<IntegrityFlag>(`/integrity-flags/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ status, note }),
  });
export const mutate = <T = unknown>(path: string, method: 'POST' | 'PATCH' | 'DELETE', values?: unknown) => api<T>(path, { method, body: values ? JSON.stringify(values) : undefined });

// Session chat belongs to the signed-in account, not a selected workspace,
// so the same calls serve students, coaches and club accounts.
const chatListQuery = (params: { q?: string; cursor?: string }) => {
  const query = new URLSearchParams();
  if (params.q?.trim()) query.set('q', params.q.trim());
  if (params.cursor) query.set('cursor', params.cursor);
  return query.size ? `?${query}` : '';
};
const threadQuery = (before?: string) => before ? `?${new URLSearchParams({ before })}` : '';
export const loadChatThreads = (params: { q?: string; cursor?: string } = {}) =>
  api<ChatThreadList>(`/chats${chatListQuery(params)}`);
export const loadChatUnread = () => api<{ unreadThreads: number }>('/chats/unread');
export const openBookingChat = (bookingId: string) =>
  api<{ threadId: string }>(`/chats/bookings/${encodeURIComponent(bookingId)}`, { method: 'POST', body: JSON.stringify({}) });
export const loadChatThread = (threadId: string, before?: string) =>
  api<ChatThreadDetail>(`/chats/${encodeURIComponent(threadId)}${threadQuery(before)}`);
export const sendChatMessage = (threadId: string, body: string) =>
  api<{ message: ChatMessage }>(`/chats/${encodeURIComponent(threadId)}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
export const markChatRead = (threadId: string) =>
  api<{ ok: true; unreadThreads: number }>(`/chats/${encodeURIComponent(threadId)}/read`, { method: 'POST', body: JSON.stringify({}) });
export const proposeChatSession = (threadId: string, startAt: string, message = '') =>
  api<{ thread: ChatThreadDetail }>(`/chats/${encodeURIComponent(threadId)}/proposals`, {
    method: 'POST', body: JSON.stringify({ startAt, message }),
  });
export const respondToChatProposal = (proposalId: string, action: ChatProposalAction, message = '') =>
  api<{ thread: ChatThreadDetail; bookingId?: string }>(`/chats/proposals/${encodeURIComponent(proposalId)}/${action}`, {
    method: 'POST', body: JSON.stringify(action === 'decline' && message ? { message } : {}),
  });
export const counterChatProposal = (proposalId: string, startAt: string, message = '') =>
  api<{ thread: ChatThreadDetail; proposalId: string }>(`/chats/proposals/${encodeURIComponent(proposalId)}/counter`, {
    method: 'POST', body: JSON.stringify({ startAt, message }),
  });
export const adminChatThreads = (params: { q?: string; cursor?: string } = {}) =>
  api<ChatThreadList>(`/admin/chats${chatListQuery(params)}`);
export const adminChatThread = (threadId: string, before?: string) =>
  api<ChatThreadDetail>(`/admin/chats/${encodeURIComponent(threadId)}${threadQuery(before)}`);

export type AdminSession = { configured: boolean; authenticated: boolean };
export type AdminTotals = { businesses: number; demoBusinesses: number; realBusinesses: number; users: number; memberships: number; students: number; bookings: number; upcomingBookings: number; bookingsLast7Days: number; packages: number; paymentsCount: number; paymentsTotal: number;
  /** Optional while an older API without session chat may still answer. */
  chatThreads?: number; chatMessages?: number };
export type AdminOverview = { generatedAt: string; totals: AdminTotals };
export type AdminBusinessCounts = { users: number; students: number; bookings: number; locations: number; services: number; instructors: number };
export type AdminBusiness = { id: string; name: string; slug: string; ownerName: string; email: string; currency: string; timezone: string; isDemo: boolean; createdAt: string; counts: AdminBusinessCounts };
export const adminSession = () => api<AdminSession>('/admin/session');
export const adminLogin = (password: string) => api<{ ok: true }>('/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
export const adminLogout = () => api<{ ok: true }>('/admin/logout', { method: 'POST', body: JSON.stringify({}) });
export const adminOverview = () => api<AdminOverview>('/admin/overview');
export const adminBusinesses = (params: { search?: string; filter?: 'all' | 'real' | 'demo' } = {}) => api<{ businesses: AdminBusiness[] }>(`/admin/businesses?${new URLSearchParams({ ...(params.search ? { search: params.search } : {}), filter: params.filter || 'all' })}`);
export const adminDeleteBusiness = (id: string) => api<{ ok: true }>(`/admin/businesses/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const adminPurgeDemos = () => api<{ ok: true; deleted: number }>('/admin/purge-demos', { method: 'POST', body: JSON.stringify({}) });
