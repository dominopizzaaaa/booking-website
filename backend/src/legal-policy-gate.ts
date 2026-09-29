import { HttpError } from './http.js';
import { legalAcceptanceEnabled } from './legal-policy.js';

export function assertLegalAcceptanceEnabled() {
  if (legalAcceptanceEnabled()) return;
  throw new HttpError(503, 'This action is unavailable until the exact current legal policy set is approved.', {
    code: 'LEGAL_DOCUMENTS_NOT_APPROVED',
  });
}
