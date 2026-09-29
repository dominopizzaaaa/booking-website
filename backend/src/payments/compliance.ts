import { createHash, createHmac } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { config, production } from '../config.js';
import { HttpError } from '../http.js';
import { assertLegalAcceptanceEnabled } from '../legal-policy-gate.js';
import { legalAcceptanceEnabled } from '../legal-policy.js';

export const CHECKOUT_POLICY_VERSION = '2026-09-29' as const;
export const PAYMENT_COMMERCIAL_APPROVAL_VERSION = CHECKOUT_POLICY_VERSION;

export const CHECKOUT_POLICIES = Object.freeze({
  terms: {
    kind: 'TERMS' as const, label: 'Terms of Service', version: CHECKOUT_POLICY_VERSION,
    hash: '58d50fd77c5131360ae1290f3c25fa4789c80d574ddc77264e80af0e58b91413',
    path: '/legal/terms',
  },
  cancellationRefunds: {
    kind: 'CANCELLATION_REFUNDS' as const, label: 'Cancellation & Refund Policy',
    version: CHECKOUT_POLICY_VERSION,
    hash: '45b76379bc6e275b2a1f9447e928f94294e170a81aee502f70d8d4365ab9c861',
    path: '/legal/cancellation-refunds',
  },
  packageTerms: {
    kind: 'PACKAGE_TERMS' as const, label: 'Package Terms', version: CHECKOUT_POLICY_VERSION,
    hash: '5ed24344fa81f460215c6b363c3b7f5121ed85769cc56085a29dc953f0a9f4a5',
    path: '/legal/package-terms',
  },
});

export const checkoutAcceptanceSchema = z.object({
  accepted: z.literal(true),
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
  termsVersion: z.literal(CHECKOUT_POLICY_VERSION),
  cancellationRefundPolicyVersion: z.literal(CHECKOUT_POLICY_VERSION),
  packageTermsVersion: z.literal(CHECKOUT_POLICY_VERSION).nullable(),
}).strict();

export type CheckoutAcceptance = z.infer<typeof checkoutAcceptanceSchema>;
export type CheckoutKind = 'PACKAGE' | 'BOOKING';
export type MerchantBusiness = {
  id: string; name: string; legalName: string; registrationNumber: string | null;
  supportEmail: string; supportAddress: string; gstRegistrationStatus: string;
  gstRegistrationNumber: string | null; pricesIncludeGst: boolean | null;
};

export type CheckoutReview = {
  reviewHash: string;
  kind: CheckoutKind;
  merchant: {
    businessId: string; tradingName: string; legalName: string; registrationNumber: string | null;
    supportEmail: string; supportAddress: string;
    gstRegistrationStatus: 'NOT_DECLARED' | 'NOT_REGISTERED' | 'REGISTERED';
    gstRegistrationNumber: string | null; pricesIncludeGst: boolean | null;
    identityReady: boolean; missingFields: string[];
  };
  platform: { name: 'Courtly'; role: string };
  purchaser: { name: string; email: string };
  item: {
    label: string; description: string | null; serviceName: string | null; coachName: string | null;
    venueName: string | null; venueAddress: string | null; startAt: string | null; endAt: string | null;
    timezone: string | null; totalCredits: number | null; validityDays: number | null; scopeNames: string[];
  };
  amount: number;
  currency: string;
  cancellation: { deadline: string | null; rule: string };
  policies: Array<(typeof CHECKOUT_POLICIES)[keyof typeof CHECKOUT_POLICIES]>;
};

type ReviewBody = Omit<CheckoutReview, 'reviewHash'>;

function merchantReview(business: MerchantBusiness): CheckoutReview['merchant'] {
  const gstRegistrationStatus = ['NOT_REGISTERED', 'REGISTERED'].includes(business.gstRegistrationStatus)
    ? business.gstRegistrationStatus as 'NOT_REGISTERED' | 'REGISTERED'
    : 'NOT_DECLARED';
  const missingFields: string[] = [];
  if (!business.legalName.trim()) missingFields.push('legal business name');
  if (!business.supportEmail.trim()) missingFields.push('support email');
  if (!business.supportAddress.trim()) missingFields.push('business/support address');
  if (gstRegistrationStatus === 'NOT_DECLARED') missingFields.push('GST registration status');
  if (gstRegistrationStatus === 'REGISTERED' && !business.gstRegistrationNumber?.trim()) {
    missingFields.push('GST registration number');
  }
  if (gstRegistrationStatus === 'REGISTERED' && business.pricesIncludeGst !== true) {
    missingFields.push('GST-inclusive displayed prices');
  }
  return {
    businessId: business.id, tradingName: business.name, legalName: business.legalName,
    registrationNumber: business.registrationNumber, supportEmail: business.supportEmail,
    supportAddress: business.supportAddress, gstRegistrationStatus,
    gstRegistrationNumber: business.gstRegistrationNumber, pricesIncludeGst: business.pricesIncludeGst,
    identityReady: missingFields.length === 0, missingFields,
  };
}

function sealReview(body: ReviewBody): CheckoutReview {
  const reviewHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { reviewHash, ...body };
}

function policySet(kind: CheckoutKind) {
  return kind === 'PACKAGE'
    ? [CHECKOUT_POLICIES.terms, CHECKOUT_POLICIES.cancellationRefunds, CHECKOUT_POLICIES.packageTerms]
    : [CHECKOUT_POLICIES.terms, CHECKOUT_POLICIES.cancellationRefunds];
}

export function packageCheckoutReview(input: {
  purchaser: { name: string; email: string };
  business: MerchantBusiness & { currency: string };
  offer: { name: string; description: string; price: number; totalCredits: number; validityDays: number };
  scopeNames: string[];
}): CheckoutReview {
  return sealReview({
    kind: 'PACKAGE', merchant: merchantReview(input.business),
    platform: {
      name: 'Courtly',
      role: 'Courtly records the selected club and uses that club’s configured connected-account payment route. These product facts do not decide the contracting seller, service provider, payment recipient, refund owner, or GST supplier.',
    },
    purchaser: input.purchaser,
    item: {
      label: input.offer.name, description: input.offer.description || null, serviceName: null, coachName: null,
      venueName: null, venueAddress: null, startAt: null, endAt: null, timezone: null,
      totalCredits: input.offer.totalCredits, validityDays: input.offer.validityDays, scopeNames: input.scopeNames,
    },
    amount: input.offer.price, currency: input.business.currency,
    cancellation: {
      deadline: null,
      rule: 'Package purchases are not automatically refunded by Courtly. Contact the identified club as the first operational contact. Courtly’s supported full-Package reversal requires that no credit has been used and no live activity relies on the Package. This product rule does not decide who legally owes a refund or limit mandatory consumer rights.',
    },
    policies: policySet('PACKAGE'),
  });
}

export function bookingCheckoutReview(input: {
  purchaser: { name: string; email: string };
  business: MerchantBusiness & { currency: string; timezone: string; cancellationHours: number };
  booking: { startAt: Date; endAt: Date };
  participant: { price: number };
  amount: number;
  service: { name: string; description: string };
  instructor: { name: string };
  location: { name: string; address: string };
}): CheckoutReview {
  const deadline = new Date(input.booking.startAt.getTime() - input.business.cancellationHours * 3_600_000);
  return sealReview({
    kind: 'BOOKING', merchant: merchantReview(input.business),
    platform: {
      name: 'Courtly',
      role: 'Courtly records the selected club and uses that club’s configured connected-account payment route. These product facts do not decide the contracting seller, service provider, payment recipient, refund owner, or GST supplier.',
    },
    purchaser: input.purchaser,
    item: {
      label: input.service.name, description: input.service.description || null, serviceName: input.service.name,
      coachName: input.instructor.name, venueName: input.location.name, venueAddress: input.location.address || null,
      startAt: input.booking.startAt.toISOString(), endAt: input.booking.endAt.toISOString(),
      timezone: input.business.timezone, totalCredits: null, validityDays: null, scopeNames: [],
    },
    amount: input.amount, currency: input.business.currency,
    cancellation: {
      deadline: deadline.toISOString(),
      rule: `Self-service cancellation closes ${input.business.cancellationHours} hours before the Class. Cancelling does not automatically trigger a money refund. Contact the identified club as the first operational contact; any legal entitlement depends on the applicable contract and law.`,
    },
    policies: policySet('BOOKING'),
  });
}

export function assertCheckoutAcceptance(review: CheckoutReview, acceptance: CheckoutAcceptance) {
  assertLegalAcceptanceEnabled();
  const packageVersion = review.kind === 'PACKAGE' ? CHECKOUT_POLICY_VERSION : null;
  if (acceptance.reviewHash !== review.reviewHash
    || acceptance.termsVersion !== CHECKOUT_POLICY_VERSION
    || acceptance.cancellationRefundPolicyVersion !== CHECKOUT_POLICY_VERSION
    || acceptance.packageTermsVersion !== packageVersion) {
    throw new HttpError(409, 'Checkout details or terms changed. Review and accept them again.', {
      code: 'CHECKOUT_REVIEW_CHANGED', review,
    });
  }
}

export function paymentCommercialApproved(input: { version: string }) {
  return input.version === PAYMENT_COMMERCIAL_APPROVAL_VERSION;
}

function configuredPaymentCommercialApprovalVersion() {
  return config.paymentCommercialApprovedVersion;
}

export function assertPaymentCommercialApprovalEnabled(
  input: { version: string } = { version: configuredPaymentCommercialApprovalVersion() },
  isProduction = production,
) {
  if (!isProduction || paymentCommercialApproved(input)) return;
  throw new HttpError(503,
    'Live checkout is unavailable until the current commercial and tax decision is approved.', {
      code: 'PAYMENT_COMMERCIAL_NOT_APPROVED',
    });
}

export type LiveCheckoutBlockReason =
  | 'LEGAL_DOCUMENTS_NOT_APPROVED'
  | 'PAYMENT_COMMERCIAL_NOT_APPROVED';

/** Configuration-derived launch gates shared by health and the authenticated
 * payment-capabilities response. Club-specific merchant/account checks happen
 * only after a purchase target has been selected. */
export function liveCheckoutBlockReasons(isProduction = production): LiveCheckoutBlockReason[] {
  if (!isProduction) return [];
  const reasons: LiveCheckoutBlockReason[] = [];
  if (!legalAcceptanceEnabled(undefined, true)) reasons.push('LEGAL_DOCUMENTS_NOT_APPROVED');
  if (!paymentCommercialApproved({ version: configuredPaymentCommercialApprovalVersion() })) {
    reasons.push('PAYMENT_COMMERCIAL_NOT_APPROVED');
  }
  return reasons;
}

/** Real-money collection is unavailable until the selected club has supplied
 * the business and GST declarations shown to the purchaser. Completeness is
 * not independent verification or a seller, supplier, or tax determination. */
export function assertCheckoutBusinessDetailsReady(review: CheckoutReview) {
  if (review.merchant.identityReady) return;
  throw new HttpError(409, 'This club must complete its merchant identity before accepting online payments.', {
    code: 'MERCHANT_IDENTITY_REQUIRED', missingFields: review.merchant.missingFields, review,
  });
}

/**
 * An idempotency key preserves the accepted transaction evidence; it must not
 * preserve stale merchant disclosures. Rebuild only the merchant portion from
 * current declarations, then require a fresh review/key if any purchaser-
 * visible merchant fact has changed.
 */
export function assertCurrentCheckoutMerchant(
  acceptedReview: CheckoutReview, business: MerchantBusiness,
): CheckoutReview {
  const { reviewHash: _acceptedReviewHash, ...acceptedBody } = acceptedReview;
  const currentReview = sealReview({ ...acceptedBody, merchant: merchantReview(business) });
  assertCheckoutBusinessDetailsReady(currentReview);
  if (currentReview.reviewHash !== acceptedReview.reviewHash) {
    throw new HttpError(409, 'Checkout details or terms changed. Review and accept them again.', {
      code: 'CHECKOUT_REVIEW_CHANGED', review: currentReview,
    });
  }
  return currentReview;
}

/** @deprecated Use assertCheckoutBusinessDetailsReady; completeness does not establish a merchant role. */
export const assertMerchantIdentityReady = assertCheckoutBusinessDetailsReady;

/**
 * Retain correlation evidence without retaining the raw IP address or browser
 * string. The high-entropy, already-digested session ID keys a one-session
 * HMAC, so the same network/device cannot be tracked between login sessions.
 */
export function checkoutAcceptanceEvidence(input: { sessionId: string; ip?: string; userAgent?: string }) {
  const sessionFingerprint = createHash('sha256')
    .update(`courtly-checkout-session-v1:${input.sessionId}`).digest('hex');
  const requestFingerprint = createHmac('sha256', input.sessionId)
    .update(JSON.stringify({ ip: input.ip?.slice(0, 128) ?? '', userAgent: input.userAgent?.slice(0, 512) ?? '' }))
    .digest('hex');
  return { sessionFingerprint, requestFingerprint };
}

export function acceptedCheckoutData(
  review: CheckoutReview, acceptance: CheckoutAcceptance,
  evidence: { sessionFingerprint: string; requestFingerprint: string }, acceptedAt = new Date(),
) {
  const packagePolicy = review.kind === 'PACKAGE' ? CHECKOUT_POLICIES.packageTerms : null;
  return {
    acceptedAt, acceptedTermsVersion: acceptance.termsVersion, acceptedTermsHash: CHECKOUT_POLICIES.terms.hash,
    acceptedCancellationPolicyVersion: acceptance.cancellationRefundPolicyVersion,
    acceptedCancellationPolicyHash: CHECKOUT_POLICIES.cancellationRefunds.hash,
    acceptedPackageTermsVersion: packagePolicy?.version ?? null, acceptedPackageTermsHash: packagePolicy?.hash ?? null,
    acceptedReviewHash: review.reviewHash, acceptanceSessionFingerprint: evidence.sessionFingerprint,
    acceptanceRequestFingerprint: evidence.requestFingerprint, acceptanceEvidenceVersion: 1,
  };
}

export function assertStoredCheckoutAcceptance(intent: {
  acceptedReviewHash: string | null; acceptedTermsVersion: string | null;
  acceptedCancellationPolicyVersion: string | null; acceptedPackageTermsVersion: string | null;
}, acceptance: CheckoutAcceptance) {
  if (intent.acceptedReviewHash !== acceptance.reviewHash
    || intent.acceptedTermsVersion !== acceptance.termsVersion
    || intent.acceptedCancellationPolicyVersion !== acceptance.cancellationRefundPolicyVersion
    || intent.acceptedPackageTermsVersion !== acceptance.packageTermsVersion) {
    throw new HttpError(409, 'This checkout attempt was created from different terms or transaction details.', {
      code: 'CHECKOUT_ACCEPTANCE_MISMATCH',
    });
  }
}

export type ComplianceTx = Prisma.TransactionClient;
