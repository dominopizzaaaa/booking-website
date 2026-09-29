export const POLICY_EFFECTIVE_DATE = '2026-09-29' as const;
export const POLICY_EFFECTIVE_DATE_LABEL = '29 September 2026' as const;

export const CURRENT_PRIVACY_NOTICE_VERSION = POLICY_EFFECTIVE_DATE;
export const CURRENT_CHILD_PRIVACY_NOTICE_VERSION = POLICY_EFFECTIVE_DATE;
export const CURRENT_TERMS_VERSION = POLICY_EFFECTIVE_DATE;
export const CURRENT_ACCEPTABLE_USE_VERSION = POLICY_EFFECTIVE_DATE;
export const CURRENT_CANCELLATION_REFUND_POLICY_VERSION = POLICY_EFFECTIVE_DATE;
export const CURRENT_PACKAGE_TERMS_VERSION = POLICY_EFFECTIVE_DATE;

// SHA-256 of the canonical JSON value for each document in
// src/content/policies.json. Checkout records can retain these content-derived
// identifiers even when a stable policy URL later serves a newer version.
export const POLICY_CONTENT_HASHES = {
  privacy: '871e9102e55b025e294a1a31e7f5405d1f3aac80b4e27137ca8044f211949ac7',
  childPrivacy: 'd939552453c2057cc4254f9756e4c0a0880e0c153af22a0d4200dfbb245b34e7',
  terms: '58d50fd77c5131360ae1290f3c25fa4789c80d574ddc77264e80af0e58b91413',
  acceptableUse: '4f28aa8b349206328ed9d8f4fae9fdc29c7728f57e9f9e11449d2bf66cff34f1',
  cancellationRefunds: '45b76379bc6e275b2a1f9447e928f94294e170a81aee502f70d8d4365ab9c861',
  packageTerms: '5ed24344fa81f460215c6b363c3b7f5121ed85769cc56085a29dc953f0a9f4a5',
} as const;

// SHA-256 of the canonical ordered map { policyKey: { version, hash } }. The
// backend requires this exact value as well as the version before production
// acceptance paths are opened.
export const CURRENT_LEGAL_POLICY_SET_HASH = 'b976fbfacdb7f9baf2e5a6f9cfc5c7773e30a8e9a650295ec4824d3e33c3c557' as const;

export const COURTLY_CONTACT_EMAIL = 'domksj23@gmail.com' as const;

export const POLICY_PATHS = {
  privacy: '/legal/privacy',
  childPrivacy: '/legal/child-privacy',
  terms: '/legal/terms',
  acceptableUse: '/legal/acceptable-use',
  cancellationRefunds: '/legal/cancellation-refunds',
  packageTerms: '/legal/package-terms',
} as const;

export const POLICY_DOCUMENTS = [
  { key: 'privacy', title: 'Privacy Notice', shortTitle: 'Privacy', path: POLICY_PATHS.privacy, version: CURRENT_PRIVACY_NOTICE_VERSION },
  { key: 'childPrivacy', title: 'Child Privacy Notice', shortTitle: 'Child privacy', path: POLICY_PATHS.childPrivacy, version: CURRENT_CHILD_PRIVACY_NOTICE_VERSION },
  { key: 'terms', title: 'Terms of Service', shortTitle: 'Terms', path: POLICY_PATHS.terms, version: CURRENT_TERMS_VERSION },
  { key: 'acceptableUse', title: 'Acceptable Use & Safeguarding Policy', shortTitle: 'Safety and acceptable use', path: POLICY_PATHS.acceptableUse, version: CURRENT_ACCEPTABLE_USE_VERSION },
  { key: 'cancellationRefunds', title: 'Cancellation & Refund Policy', shortTitle: 'Cancellations and refunds', path: POLICY_PATHS.cancellationRefunds, version: CURRENT_CANCELLATION_REFUND_POLICY_VERSION },
  { key: 'packageTerms', title: 'Package Terms', shortTitle: 'Packages', path: POLICY_PATHS.packageTerms, version: CURRENT_PACKAGE_TERMS_VERSION },
] as const;

export type PolicyDocumentKey = (typeof POLICY_DOCUMENTS)[number]['key'];

export function policyDocument(key: PolicyDocumentKey) {
  return POLICY_DOCUMENTS.find(document => document.key === key)!;
}
