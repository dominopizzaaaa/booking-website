import { CURRENT_LEGAL_POLICY_SET_HASH, POLICY_EFFECTIVE_DATE } from './policies';

type LegalPublicationPayload = {
  legalPublication?: { approved?: unknown; version?: unknown; contentHash?: unknown };
};

export function isExactLegalPublicationApproval(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const publication = (value as LegalPublicationPayload).legalPublication;
  return publication?.approved === true
    && publication.version === POLICY_EFFECTIVE_DATE
    && publication.contentHash === CURRENT_LEGAL_POLICY_SET_HASH;
}

export async function loadLegalPublicationApproval() {
  const configured = (process.env.BACKEND_URL || 'http://127.0.0.1:4000').trim().replace(/\/+$/u, '');
  const origin = /^https?:\/\//iu.test(configured) ? configured : `https://${configured}`;
  try {
    const response = await fetch(`${origin}/api/public/compliance`, { cache: 'no-store' });
    if (!response.ok) return false;
    return isExactLegalPublicationApproval(await response.json());
  } catch {
    return false;
  }
}
