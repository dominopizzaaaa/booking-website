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
