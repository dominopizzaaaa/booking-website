import type { Workspace, PublicBusiness, Slot, BookingInput, BookingResult } from './types';

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
export const loadWorkspace = () => api<Workspace>('/workspace');
export const loadPublicBusiness = (slug: string) => api<PublicBusiness>(`/public/${encodeURIComponent(slug)}`);
export const loadSlots = (slug: string, values: { serviceId: string; instructorId: string; locationId: string; date: string }) => api<{ slots: Slot[] }>(`/public/${encodeURIComponent(slug)}/slots?${new URLSearchParams(values)}`);
export const createBooking = (values: BookingInput) => api<BookingResult>('/bookings', { method: 'POST', body: JSON.stringify(values) });
export const createPublicBooking = (slug: string, values: BookingInput) => api<BookingResult>(`/public/${encodeURIComponent(slug)}/bookings`, { method: 'POST', body: JSON.stringify(values) });
export const mutate = <T = unknown>(path: string, method: 'POST' | 'PATCH' | 'DELETE', values?: unknown) => api<T>(path, { method, body: values ? JSON.stringify(values) : undefined });

export type AdminSession = { configured: boolean; authenticated: boolean };
export type AdminTotals = { businesses: number; demoBusinesses: number; realBusinesses: number; users: number; customers: number; bookings: number; upcomingBookings: number; bookingsLast7Days: number; packages: number; paymentsCount: number; paymentsTotal: number };
export type AdminOverview = { generatedAt: string; totals: AdminTotals };
export type AdminBusinessCounts = { users: number; customers: number; bookings: number; locations: number; services: number; instructors: number };
export type AdminBusiness = { id: string; name: string; slug: string; ownerName: string; email: string; currency: string; timezone: string; isDemo: boolean; createdAt: string; counts: AdminBusinessCounts };
export const adminSession = () => api<AdminSession>('/admin/session');
export const adminLogin = (password: string) => api<{ ok: true }>('/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
export const adminLogout = () => api<{ ok: true }>('/admin/logout', { method: 'POST', body: JSON.stringify({}) });
export const adminOverview = () => api<AdminOverview>('/admin/overview');
export const adminBusinesses = (params: { search?: string; filter?: 'all' | 'real' | 'demo' } = {}) => api<{ businesses: AdminBusiness[] }>(`/admin/businesses?${new URLSearchParams({ ...(params.search ? { search: params.search } : {}), filter: params.filter || 'all' })}`);
export const adminDeleteBusiness = (id: string) => api<{ ok: true }>(`/admin/businesses/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const adminPurgeDemos = () => api<{ ok: true; deleted: number }>('/admin/purge-demos', { method: 'POST', body: JSON.stringify({}) });
