import { config, production } from './config.js';

export const CURRENT_TERMS_VERSION = '2026-09-29' as const;
export const CURRENT_PRIVACY_NOTICE_VERSION = '2026-09-29' as const;
export const CURRENT_CHILD_PRIVACY_POLICY_VERSION = '2026-09-29' as const;
export const CURRENT_LEGAL_POLICY_SET_HASH = 'b976fbfacdb7f9baf2e5a6f9cfc5c7773e30a8e9a650295ec4824d3e33c3c557' as const;

export const LEGAL_ROUTES = Object.freeze({
  terms: '/legal/terms',
  privacy: '/legal/privacy',
  childPrivacy: '/legal/child-privacy',
  acceptableUse: '/legal/acceptable-use',
  cancellationRefunds: '/legal/cancellation-refunds',
  packageTerms: '/legal/package-terms',
});

export const DATA_PROTECTION_OFFICER = Object.freeze({
  email: 'domksj23@gmail.com',
});

export function legalDocumentsApproved(input: { version: string; hash: string }) {
  return input.version === CURRENT_TERMS_VERSION && input.hash === CURRENT_LEGAL_POLICY_SET_HASH;
}

export function legalAcceptanceEnabled(
  input: { version: string; hash: string } = {
    version: config.legalDocumentsApprovedVersion, hash: config.legalDocumentsApprovedHash,
  },
  isProduction = production,
) {
  return !isProduction || legalDocumentsApproved(input);
}

export const LEGAL_DOCUMENTS_APPROVED = legalDocumentsApproved({
  version: config.legalDocumentsApprovedVersion,
  hash: config.legalDocumentsApprovedHash,
});
