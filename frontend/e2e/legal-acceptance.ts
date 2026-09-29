import {
  CURRENT_LEGAL_POLICY_SET_HASH,
  CURRENT_PRIVACY_NOTICE_VERSION,
  CURRENT_TERMS_VERSION,
} from '../src/lib/policies';

/** Canonical evidence sent by browser-test setup registrations. */
export const currentLegalAcceptance = {
  termsAccepted: true as const,
  privacyNoticeAcknowledged: true as const,
  termsVersion: CURRENT_TERMS_VERSION,
  privacyPolicyVersion: CURRENT_PRIVACY_NOTICE_VERSION,
  policySetHash: CURRENT_LEGAL_POLICY_SET_HASH,
};
