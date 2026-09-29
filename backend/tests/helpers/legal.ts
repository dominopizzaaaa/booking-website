import { CURRENT_LEGAL_POLICY_SET_HASH, CURRENT_PRIVACY_NOTICE_VERSION, CURRENT_TERMS_VERSION } from '../../src/legal-policy.js';

export const currentSignupAcceptance = Object.freeze({
  termsAccepted: true as const,
  privacyNoticeAcknowledged: true as const,
  termsVersion: CURRENT_TERMS_VERSION,
  privacyPolicyVersion: CURRENT_PRIVACY_NOTICE_VERSION,
  policySetHash: CURRENT_LEGAL_POLICY_SET_HASH,
});
