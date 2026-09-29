import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_POLICIES, CHECKOUT_POLICY_VERSION, acceptedCheckoutData, assertCheckoutAcceptance,
  assertCheckoutBusinessDetailsReady, assertCurrentCheckoutMerchant,
  assertPaymentCommercialApprovalEnabled, bookingCheckoutReview, checkoutAcceptanceEvidence,
  checkoutAcceptanceSchema, packageCheckoutReview, paymentCommercialApproved,
  liveCheckoutBlockReasons, PAYMENT_COMMERCIAL_APPROVAL_VERSION, type CheckoutAcceptance, type CheckoutReview,
} from '../src/payments/compliance.js';
import { CURRENT_LEGAL_POLICY_SET_HASH, legalAcceptanceEnabled, legalDocumentsApproved } from '../src/legal-policy.js';
import { config } from '../src/config.js';

type PackageReviewInput = Parameters<typeof packageCheckoutReview>[0];

const canonicalPolicies = JSON.parse(readFileSync(
  new URL('../../frontend/src/content/policies.json', import.meta.url), 'utf8',
)) as Record<string, { version: string; effectiveDate: string; [key: string]: unknown }>;

const readyBusiness: PackageReviewInput['business'] = {
  id: 'club_1', name: 'Baseline Racket Club', legalName: 'Baseline Racket Club Pte. Ltd.',
  registrationNumber: '202612345N', supportEmail: 'payments@baseline.example',
  supportAddress: '1 Court Lane, Singapore 123456', gstRegistrationStatus: 'NOT_REGISTERED',
  gstRegistrationNumber: null, pricesIncludeGst: null, currency: 'SGD',
};

const offer: PackageReviewInput['offer'] = {
  name: 'Five Class Pack', description: 'Five eligible group Classes', price: 12_500,
  totalCredits: 5, validityDays: 90,
};

function packageReview(overrides: {
  purchaser?: Partial<PackageReviewInput['purchaser']>;
  business?: Partial<PackageReviewInput['business']>;
  offer?: Partial<PackageReviewInput['offer']>;
  scopeNames?: string[];
} = {}) {
  return packageCheckoutReview({
    purchaser: { name: 'Alex Player', email: 'alex@example.test', ...overrides.purchaser },
    business: { ...readyBusiness, ...overrides.business },
    offer: { ...offer, ...overrides.offer },
    scopeNames: overrides.scopeNames ?? ['Class: Group tennis', 'Court rental: Court 1'],
  });
}

function acceptanceFor(review: CheckoutReview): CheckoutAcceptance {
  return {
    accepted: true, reviewHash: review.reviewHash, termsVersion: CHECKOUT_POLICY_VERSION,
    cancellationRefundPolicyVersion: CHECKOUT_POLICY_VERSION,
    packageTermsVersion: review.kind === 'PACKAGE' ? CHECKOUT_POLICY_VERSION : null,
  };
}

describe('payment checkout compliance', () => {
  it('pins checkout policy versions and hashes to the canonical policy documents', () => {
    const policies = [
      ['terms', CHECKOUT_POLICIES.terms],
      ['cancellationRefunds', CHECKOUT_POLICIES.cancellationRefunds],
      ['packageTerms', CHECKOUT_POLICIES.packageTerms],
    ] as const;

    expect(CHECKOUT_POLICY_VERSION).toBe('2026-09-29');
    for (const [key, policy] of policies) {
      const canonical = canonicalPolicies[key]!;
      expect(policy.version).toBe(canonical.version);
      expect(policy.version).toBe(canonical.effectiveDate);
      expect(policy.hash).toBe(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
      expect(policy.hash).toMatch(/^[a-f0-9]{64}$/u);
    }
    const allPolicyHashes = Object.fromEntries(Object.entries(canonicalPolicies).map(([key, policy]) => [
      key, { version: policy.version, hash: createHash('sha256').update(JSON.stringify(policy)).digest('hex') },
    ]));
    expect(CURRENT_LEGAL_POLICY_SET_HASH).toBe(
      createHash('sha256').update(JSON.stringify(allPolicyHashes)).digest('hex'),
    );
  });

  it('requires exact version and full policy-set hash for production publication approval', () => {
    expect(legalDocumentsApproved({
      version: CHECKOUT_POLICY_VERSION, hash: CURRENT_LEGAL_POLICY_SET_HASH,
    })).toBe(true);
    expect(legalDocumentsApproved({
      version: CHECKOUT_POLICY_VERSION, hash: '0'.repeat(64),
    })).toBe(false);
    expect(legalDocumentsApproved({
      version: 'superseded', hash: CURRENT_LEGAL_POLICY_SET_HASH,
    })).toBe(false);
    expect(legalAcceptanceEnabled({
      version: CHECKOUT_POLICY_VERSION, hash: CURRENT_LEGAL_POLICY_SET_HASH,
    }, true)).toBe(true);
    expect(legalAcceptanceEnabled({
      version: CHECKOUT_POLICY_VERSION, hash: '0'.repeat(64),
    }, true)).toBe(false);
    expect(legalAcceptanceEnabled({ version: '', hash: '' }, false)).toBe(true);
  });

  it('fails acceptance closed when an already-running production process loses exact approval', () => {
    const originalVersion = config.legalDocumentsApprovedVersion;
    const originalHash = config.legalDocumentsApprovedHash;
    config.legalDocumentsApprovedVersion = CHECKOUT_POLICY_VERSION;
    config.legalDocumentsApprovedHash = CURRENT_LEGAL_POLICY_SET_HASH;
    expect(legalDocumentsApproved({
      version: config.legalDocumentsApprovedVersion, hash: config.legalDocumentsApprovedHash,
    })).toBe(true);
    config.legalDocumentsApprovedHash = '0'.repeat(64);
    // Non-production test processes intentionally permit draft work, but the
    // pure production predicate remains exact and is what runtime startup uses.
    expect(legalDocumentsApproved({
      version: config.legalDocumentsApprovedVersion, hash: config.legalDocumentsApprovedHash,
    })).toBe(false);
    config.legalDocumentsApprovedVersion = originalVersion;
    config.legalDocumentsApprovedHash = originalHash;
  });

  it('requires an independent exact commercial approval for production live checkout', () => {
    expect(PAYMENT_COMMERCIAL_APPROVAL_VERSION).toBe('2026-09-29');
    expect(paymentCommercialApproved({ version: PAYMENT_COMMERCIAL_APPROVAL_VERSION })).toBe(true);
    expect(paymentCommercialApproved({ version: '' })).toBe(false);
    expect(paymentCommercialApproved({ version: '2026-09-28' })).toBe(false);

    expect(() => assertPaymentCommercialApprovalEnabled(
      { version: PAYMENT_COMMERCIAL_APPROVAL_VERSION }, true,
    )).not.toThrow();
    expect(() => assertPaymentCommercialApprovalEnabled({ version: '' }, false)).not.toThrow();
    expect(() => assertPaymentCommercialApprovalEnabled({ version: '' }, true))
      .toThrowError(expect.objectContaining({
        status: 503, details: { code: 'PAYMENT_COMMERCIAL_NOT_APPROVED' },
      }));

    // Legal publication approval is a separate decision and cannot satisfy
    // the commercial/tax gate.
    expect(legalDocumentsApproved({
      version: CHECKOUT_POLICY_VERSION, hash: CURRENT_LEGAL_POLICY_SET_HASH,
    })).toBe(true);
    expect(paymentCommercialApproved({ version: '' })).toBe(false);
  });

  it('reports every production launch gate that blocks live checkout', () => {
    const original = {
      legalVersion: config.legalDocumentsApprovedVersion, legalHash: config.legalDocumentsApprovedHash,
      commercialVersion: config.paymentCommercialApprovedVersion,
    };
    try {
      config.legalDocumentsApprovedVersion = '';
      config.legalDocumentsApprovedHash = '';
      config.paymentCommercialApprovedVersion = '';
      expect(liveCheckoutBlockReasons(true)).toEqual([
        'LEGAL_DOCUMENTS_NOT_APPROVED', 'PAYMENT_COMMERCIAL_NOT_APPROVED',
      ]);
      config.legalDocumentsApprovedVersion = CHECKOUT_POLICY_VERSION;
      config.legalDocumentsApprovedHash = CURRENT_LEGAL_POLICY_SET_HASH;
      config.paymentCommercialApprovedVersion = PAYMENT_COMMERCIAL_APPROVAL_VERSION;
      expect(liveCheckoutBlockReasons(true)).toEqual([]);
      expect(liveCheckoutBlockReasons(false)).toEqual([]);
    } finally {
      config.legalDocumentsApprovedVersion = original.legalVersion;
      config.legalDocumentsApprovedHash = original.legalHash;
      config.paymentCommercialApprovedVersion = original.commercialVersion;
    }
  });

  it('states only observable club and payment-route facts in transaction reviews', () => {
    const packageResult = packageReview();
    const bookingResult = bookingCheckoutReview({
      purchaser: { name: 'Alex Player', email: 'alex@example.test' },
      business: { ...readyBusiness, timezone: 'Asia/Singapore', cancellationHours: 24 },
      booking: { startAt: new Date('2026-10-10T02:00:00.000Z'), endAt: new Date('2026-10-10T03:00:00.000Z') },
      participant: { price: 8_000 }, amount: 8_000,
      service: { name: 'Private tennis', description: 'One-hour Class' },
      instructor: { name: 'Casey Coach' }, location: { name: 'Court 1', address: '1 Court Lane' },
    });
    for (const review of [packageResult, bookingResult]) {
      expect(review.platform.role).toContain('configured connected-account payment route');
      expect(review.platform.role).toContain('do not decide');
      expect(review.platform.role).not.toContain('is the seller');
      expect(review.platform.role).not.toContain('is the service provider');
      expect(review.platform.role).not.toContain('is the payment recipient');
      expect(review.cancellation.rule).toContain('first operational contact');
      expect(review.cancellation.rule).not.toContain('selling club');
    }
  });

  it('produces a stable review hash and changes it with purchaser-visible transaction facts', () => {
    const baseline = packageReview();
    expect(packageReview().reviewHash).toBe(baseline.reviewHash);

    const changedReviews = [
      packageReview({ purchaser: { email: 'other@example.test' } }),
      packageReview({ business: { legalName: 'Another Seller Pte. Ltd.' } }),
      packageReview({ offer: { price: offer.price + 1 } }),
      packageReview({ scopeNames: ['Class: Group tennis'] }),
    ];
    for (const changed of changedReviews) expect(changed.reviewHash).not.toBe(baseline.reviewHash);
  });

  it('includes booking timing and cancellation facts in the stable review hash', () => {
    const input = {
      purchaser: { name: 'Alex Player', email: 'alex@example.test' },
      business: { ...readyBusiness, timezone: 'Asia/Singapore', cancellationHours: 24 },
      booking: {
        startAt: new Date('2026-10-10T02:00:00.000Z'),
        endAt: new Date('2026-10-10T03:00:00.000Z'),
      },
      participant: { price: 8_000 }, amount: 8_000,
      service: { name: 'Private tennis', description: 'One-hour Class' },
      instructor: { name: 'Casey Coach' },
      location: { name: 'Court 1', address: '1 Court Lane' },
    };
    const baseline = bookingCheckoutReview(input);

    expect(bookingCheckoutReview({ ...input, booking: { ...input.booking } }).reviewHash)
      .toBe(baseline.reviewHash);
    expect(bookingCheckoutReview({
      ...input, business: { ...input.business, cancellationHours: 48 },
    }).reviewHash).not.toBe(baseline.reviewHash);
    expect(bookingCheckoutReview({ ...input, amount: 7_500 }).reviewHash).not.toBe(baseline.reviewHash);
  });

  it('rejects acceptance after the review or a policy version becomes stale', () => {
    const review = packageReview();
    const acceptance = acceptanceFor(review);
    expect(() => assertCheckoutAcceptance(review, acceptance)).not.toThrow();

    const changedReview = packageReview({ offer: { price: offer.price + 1 } });
    expect(() => assertCheckoutAcceptance(changedReview, acceptance)).toThrowError(expect.objectContaining({
      status: 409, details: expect.objectContaining({ code: 'CHECKOUT_REVIEW_CHANGED', review: changedReview }),
    }));

    const staleVersion = { ...acceptance, termsVersion: '2026-01-01' };
    expect(checkoutAcceptanceSchema.safeParse(staleVersion).success).toBe(false);
    expect(() => assertCheckoutAcceptance(
      review, staleVersion as unknown as CheckoutAcceptance,
    )).toThrowError(expect.objectContaining({
      status: 409, details: expect.objectContaining({ code: 'CHECKOUT_REVIEW_CHANGED' }),
    }));
  });

  it('requires an identified merchant and an explicit GST position', () => {
    const incomplete = packageReview({ business: {
      legalName: ' ', supportEmail: '', supportAddress: '', gstRegistrationStatus: 'NOT_DECLARED',
    } });
    expect(incomplete.merchant).toMatchObject({
      identityReady: false,
      missingFields: [
        'legal business name', 'support email', 'business/support address', 'GST registration status',
      ],
    });
    expect(() => assertCheckoutBusinessDetailsReady(incomplete)).toThrowError(expect.objectContaining({
      status: 409, details: expect.objectContaining({
        code: 'MERCHANT_IDENTITY_REQUIRED', missingFields: incomplete.merchant.missingFields,
      }),
    }));

    const nonRegistered = packageReview();
    expect(nonRegistered.merchant.identityReady).toBe(true);
    expect(() => assertCheckoutBusinessDetailsReady(nonRegistered)).not.toThrow();
  });

  it('requires a registered merchant to supply its GST number and GST-inclusive displayed prices', () => {
    const incomplete = packageReview({ business: {
      gstRegistrationStatus: 'REGISTERED', gstRegistrationNumber: null, pricesIncludeGst: null,
    } });
    expect(incomplete.merchant).toMatchObject({
      identityReady: false, missingFields: ['GST registration number', 'GST-inclusive displayed prices'],
    });
    expect(() => assertCheckoutBusinessDetailsReady(incomplete))
      .toThrowError(expect.objectContaining({ status: 409 }));

    const exclusive = packageReview({ business: {
      gstRegistrationStatus: 'REGISTERED', gstRegistrationNumber: 'M91234567X', pricesIncludeGst: false,
    } });
    expect(exclusive.merchant).toMatchObject({
      identityReady: false, missingFields: ['GST-inclusive displayed prices'],
    });
    expect(() => assertCheckoutBusinessDetailsReady(exclusive))
      .toThrowError(expect.objectContaining({ status: 409 }));

    const ready = packageReview({ business: {
      gstRegistrationStatus: 'REGISTERED', gstRegistrationNumber: 'M91234567X', pricesIncludeGst: true,
    } });
    expect(ready.merchant.identityReady).toBe(true);
    expect(() => assertCheckoutBusinessDetailsReady(ready)).not.toThrow();
  });

  it('requires renewed review when current purchaser-visible merchant details changed', () => {
    const accepted = packageReview();
    expect(assertCurrentCheckoutMerchant(accepted, readyBusiness)).toEqual(accepted);

    const changedBusiness = { ...readyBusiness, supportEmail: 'new-payments@baseline.example' };
    expect(() => assertCurrentCheckoutMerchant(accepted, changedBusiness))
      .toThrowError(expect.objectContaining({
        status: 409, details: expect.objectContaining({
          code: 'CHECKOUT_REVIEW_CHANGED',
          review: expect.objectContaining({
            merchant: expect.objectContaining({ supportEmail: changedBusiness.supportEmail }),
          }),
        }),
      }));

    const unsafeTaxChange = {
      ...readyBusiness, gstRegistrationStatus: 'REGISTERED',
      gstRegistrationNumber: 'M91234567X', pricesIncludeGst: false,
    };
    expect(() => assertCurrentCheckoutMerchant(accepted, unsafeTaxChange))
      .toThrowError(expect.objectContaining({
        status: 409, details: expect.objectContaining({
          code: 'MERCHANT_IDENTITY_REQUIRED',
          missingFields: ['GST-inclusive displayed prices'],
        }),
      }));
  });

  it('stores the canonical policy evidence accepted for each checkout kind', () => {
    const review = packageReview();
    const acceptance = acceptanceFor(review);
    const acceptedAt = new Date('2026-09-29T12:00:00.000Z');
    const data = acceptedCheckoutData(review, acceptance, {
      sessionFingerprint: 'a'.repeat(64), requestFingerprint: 'b'.repeat(64),
    }, acceptedAt);

    expect(data).toMatchObject({
      acceptedAt, acceptedTermsVersion: CHECKOUT_POLICIES.terms.version,
      acceptedTermsHash: CHECKOUT_POLICIES.terms.hash,
      acceptedCancellationPolicyVersion: CHECKOUT_POLICIES.cancellationRefunds.version,
      acceptedCancellationPolicyHash: CHECKOUT_POLICIES.cancellationRefunds.hash,
      acceptedPackageTermsVersion: CHECKOUT_POLICIES.packageTerms.version,
      acceptedPackageTermsHash: CHECKOUT_POLICIES.packageTerms.hash,
      acceptedReviewHash: review.reviewHash, acceptanceEvidenceVersion: 1,
    });
  });

  it('creates deterministic session-scoped fingerprints without retaining raw request identifiers', () => {
    const request = {
      sessionId: 'f'.repeat(64), ip: '203.0.113.42',
      userAgent: 'CourtlyBrowser/1.0 raw-user-agent-marker',
    };
    const first = checkoutAcceptanceEvidence(request);
    const repeated = checkoutAcceptanceEvidence(request);
    const changedRequest = checkoutAcceptanceEvidence({ ...request, ip: '198.51.100.7' });
    const changedSession = checkoutAcceptanceEvidence({ ...request, sessionId: 'e'.repeat(64) });

    expect(repeated).toEqual(first);
    expect(first).toEqual({
      sessionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(changedRequest.sessionFingerprint).toBe(first.sessionFingerprint);
    expect(changedRequest.requestFingerprint).not.toBe(first.requestFingerprint);
    expect(changedSession.sessionFingerprint).not.toBe(first.sessionFingerprint);
    expect(changedSession.requestFingerprint).not.toBe(first.requestFingerprint);
    expect(JSON.stringify(first)).not.toContain(request.ip);
    expect(JSON.stringify(first)).not.toContain(request.userAgent);

    const boundedPrefix = { sessionId: request.sessionId, ip: 'i'.repeat(128), userAgent: 'u'.repeat(512) };
    expect(checkoutAcceptanceEvidence({
      ...boundedPrefix, ip: `${boundedPrefix.ip}first`, userAgent: `${boundedPrefix.userAgent}first`,
    })).toEqual(checkoutAcceptanceEvidence({
      ...boundedPrefix, ip: `${boundedPrefix.ip}second`, userAgent: `${boundedPrefix.userAgent}second`,
    }));
  });
});
