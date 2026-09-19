import { isManagerWorkspace, type WorkspaceResponse, type WorkspaceBooking, type PublicBusiness, type Slot, type BookingInput, type PublicBookingInput, type BookingResult, type ProviderBookingResult, type AuthSession, type AccountBooking, type AccountBookingsResult, type IntegrityFlag, type Payment, type RescheduleRequest, type VenueSearchResult } from './types';

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
  const workspace = await api<WorkspaceResponse>('/workspace');
  const common = {
    rescheduleRequests: workspace.rescheduleRequests ?? [],
    notifications: (workspace.notifications ?? []).map(notification => ({
      ...notification,
      type: notification.type ?? 'NOTICE',
      actionNeeded: notification.actionNeeded ?? false,
      bookingId: notification.bookingId ?? null,
    })),
  };
  if (isManagerWorkspace(workspace)) {
    return { ...workspace, ...common, integrityFlags: workspace.integrityFlags ?? [] };
  }
  return { ...workspace, ...common, clubAccount: false, packages: [], payments: [], integrityFlags: [] };
}
export const loadPublicBusiness = (slug: string) => api<PublicBusiness>(`/public/${encodeURIComponent(slug)}`);
export const loadSlots = (slug: string, values: { serviceId: string; instructorId: string; locationId: string; date: string }) => api<{ slots: Slot[] }>(`/public/${encodeURIComponent(slug)}/slots?${new URLSearchParams(values)}`);
export const createBooking = (values: BookingInput) => api<ProviderBookingResult>('/bookings', { method: 'POST', body: JSON.stringify(values) });
export const createPublicBooking = (slug: string, values: PublicBookingInput) => api<BookingResult>(`/public/${encodeURIComponent(slug)}/bookings`, { method: 'POST', body: JSON.stringify(values) });
export const loadAuthSession = () => api<AuthSession>('/auth/me');
export const loginStudentAccount = (values: { email: string; password: string }) => api<AuthSession>('/auth/login', { method: 'POST', body: JSON.stringify(values) });
export const registerStudentAccount = (values: { name: string; email: string; password: string; phone?: string; parentName?: string }) => api<AuthSession>('/auth/register', { method: 'POST', body: JSON.stringify({ ...values, accountType: 'STUDENT' }) });
export const logoutAccount = () => api<{ ok: true }>('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
export async function loadAccountBookings(businessSlug?: string): Promise<AccountBookingsResult> {
  const query = businessSlug ? `?${new URLSearchParams({ businessSlug })}` : '';
  const value = await api<AccountBookingsResult | AccountBooking[]>(`/account/bookings${query}`);
  return Array.isArray(value) ? { bookings: value } : value;
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
export const resolveIntegrityFlag = (id: string, status: IntegrityFlag['status'], note = '') =>
  api<IntegrityFlag>(`/integrity-flags/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ status, note }),
  });
export const createOwnPractice = (name: string) =>
  api<AuthSession>('/auth/practice', { method: 'POST', body: JSON.stringify({ name }) });
export const mutate = <T = unknown>(path: string, method: 'POST' | 'PATCH' | 'DELETE', values?: unknown) => api<T>(path, { method, body: values ? JSON.stringify(values) : undefined });

export type AdminSession = { configured: boolean; authenticated: boolean };
export type AdminTotals = { businesses: number; demoBusinesses: number; realBusinesses: number; users: number; memberships: number; students: number; bookings: number; upcomingBookings: number; bookingsLast7Days: number; packages: number; paymentsCount: number; paymentsTotal: number };
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
