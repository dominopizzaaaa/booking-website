import { ApiError } from '../../lib/api';

export function isFamilyBookingAuthorityError(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  const code = error.details && typeof error.details === 'object'
    ? (error.details as { code?: unknown }).code
    : undefined;
  return error.status === 403
    || (error.status === 404 && code === 'CHILD_NOT_FOUND');
}
