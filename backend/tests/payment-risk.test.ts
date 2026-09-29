import { describe, expect, it } from 'vitest';
import {
  canApplyPaymentRiskKindTransition, canApplyPaymentRiskStatusTransition, providerRiskCaseFromWebhook,
  shouldApplyPaymentRiskUpdate,
} from '../src/payments/risk.js';
import type { StripeWebhookEvent } from '../src/payments/webhooks.js';

function webhook(type: string, dataObject: Record<string, unknown>): StripeWebhookEvent {
  return {
    id: 'evt_risk_123', type, account: 'acct_club',
    createdAt: new Date('2026-09-29T10:00:00Z'), livemode: true,
    dataObject, payloadHash: 'a'.repeat(64), raw: {},
  };
}

describe('Stripe payment risk parsing', () => {
  it('allows inquiry escalation without permitting lifecycle regression or case-family collisions', () => {
    expect(canApplyPaymentRiskKindTransition('INQUIRY', 'DISPUTE')).toBe(true);
    expect(canApplyPaymentRiskKindTransition('DISPUTE', 'INQUIRY')).toBe(false);
    expect(canApplyPaymentRiskKindTransition('DISPUTE', 'DISPUTE')).toBe(true);
    expect(canApplyPaymentRiskKindTransition('EARLY_FRAUD_WARNING', 'EARLY_FRAUD_WARNING')).toBe(true);
    expect(canApplyPaymentRiskKindTransition('EARLY_FRAUD_WARNING', 'DISPUTE')).toBe(false);
    expect(canApplyPaymentRiskKindTransition('INQUIRY', 'EARLY_FRAUD_WARNING')).toBe(false);
  });

  it.each([
    ['DISPUTE', 'WON', 'DISPUTE', 'UNDER_REVIEW'],
    ['DISPUTE', 'LOST', 'DISPUTE', 'NEEDS_RESPONSE'],
    ['DISPUTE', 'PREVENTED', 'DISPUTE', 'UNDER_REVIEW'],
    ['INQUIRY', 'WARNING_CLOSED', 'INQUIRY', 'WARNING_NEEDS_RESPONSE'],
    ['EARLY_FRAUD_WARNING', 'NOT_ACTIONABLE', 'EARLY_FRAUD_WARNING', 'ACTIONABLE'],
  ] as const)('does not regress terminal %s status %s to %s', (existingKind, existingStatus, nextKind, nextStatus) => {
    // Stripe timestamps have one-second precision, so this guard also covers an
    // older update delivered after a terminal event at the exact same second.
    expect(canApplyPaymentRiskStatusTransition(existingKind, existingStatus, nextKind, nextStatus)).toBe(false);
  });

  it('allows terminal idempotency and a closed inquiry escalating to a formal dispute', () => {
    expect(canApplyPaymentRiskStatusTransition('DISPUTE', 'WON', 'DISPUTE', 'WON')).toBe(true);
    expect(canApplyPaymentRiskStatusTransition(
      'INQUIRY', 'WARNING_CLOSED', 'DISPUTE', 'NEEDS_RESPONSE',
    )).toBe(true);
  });

  it('ignores an out-of-order nonterminal update with the same provider timestamp as a terminal event', () => {
    const timestamp = new Date('2026-09-29T10:00:00Z');
    expect(shouldApplyPaymentRiskUpdate({
      kind: 'DISPUTE', status: 'WON', lastProviderEventAt: timestamp,
    }, { kind: 'DISPUTE', status: 'UNDER_REVIEW' }, timestamp)).toBe(false);
  });

  it.each([
    ['WON', 'LOST'],
    ['LOST', 'PREVENTED'],
    ['PREVENTED', 'WON'],
  ] as const)('keeps same-second terminal %s when a conflicting %s event arrives', (existingStatus, nextStatus) => {
    const timestamp = new Date('2026-09-29T10:00:00Z');
    expect(shouldApplyPaymentRiskUpdate({
      kind: 'DISPUTE', status: existingStatus, lastProviderEventAt: timestamp,
    }, { kind: 'DISPUTE', status: nextStatus }, timestamp)).toBe(false);
    expect(shouldApplyPaymentRiskUpdate({
      kind: 'DISPUTE', status: existingStatus, lastProviderEventAt: timestamp,
    }, { kind: 'DISPUTE', status: existingStatus }, timestamp)).toBe(true);
  });

  it('extracts only the structured dispute fields needed for operations', () => {
    const parsed = providerRiskCaseFromWebhook(webhook('charge.dispute.created', {
      id: 'dp_123', status: 'needs_response', reason: 'fraudulent',
      amount: 12_500, currency: 'sgd', payment_intent: 'pi_123', charge: 'ch_123',
      created: 1_798_502_400, evidence_details: { due_by: 1_799_020_800, submission_count: 0 },
      evidence: { customer_email_address: 'private@example.test' },
      payment_method_details: { card: { last4: '4242' } },
      metadata: { internalSecret: 'do-not-retain' },
    }));

    expect(parsed).toEqual({
      providerCaseId: 'dp_123', kind: 'DISPUTE', status: 'NEEDS_RESPONSE',
      reason: 'fraudulent', amount: 12_500, currency: 'SGD',
      responseDueAt: new Date(1_799_020_800_000),
      providerPaymentIntentReference: 'pi_123', providerChargeReference: 'ch_123',
      providerCreatedAt: new Date(1_798_502_400_000), resolved: false,
    });
    expect(JSON.stringify(parsed)).not.toContain('private@example.test');
    expect(JSON.stringify(parsed)).not.toContain('4242');
    expect(JSON.stringify(parsed)).not.toContain('do-not-retain');
  });

  it.each([
    ['warning_needs_response', 'WARNING_NEEDS_RESPONSE', false],
    ['warning_under_review', 'WARNING_UNDER_REVIEW', false],
    ['warning_closed', 'WARNING_CLOSED', true],
  ] as const)('keeps inquiry status %s lossless', (sourceStatus, status, resolved) => {
    expect(providerRiskCaseFromWebhook(webhook('charge.dispute.updated', {
      id: 'dp_warning', status: sourceStatus, reason: 'fraudulent', amount: 5000, currency: 'usd',
      payment_intent: 'pi_warning', charge: 'ch_warning',
    }))).toMatchObject({ kind: 'INQUIRY', status, resolved });
  });

  it.each([
    ['won', 'WON'],
    ['lost', 'LOST'],
    ['prevented', 'PREVENTED'],
  ] as const)('marks terminal dispute status %s as resolved', (sourceStatus, status) => {
    expect(providerRiskCaseFromWebhook(webhook('charge.dispute.closed', {
      id: 'dp_closed', status: sourceStatus, reason: 'product_not_received',
      amount: 9900, currency: 'sgd', charge: 'ch_closed',
    }))).toMatchObject({ kind: 'DISPUTE', status, resolved: true });
  });

  it('maps actionable and non-actionable early fraud warnings without inventing financial fields', () => {
    const actionable = providerRiskCaseFromWebhook(webhook('radar.early_fraud_warning.created', {
      id: 'issfr_123', actionable: true, fraud_type: 'made_with_stolen_card',
      payment_intent: { id: 'pi_efw', client_secret: 'must-not-retain' },
      charge: { id: 'ch_efw', billing_details: { email: 'private@example.test' } },
      created: 1_798_502_400,
    }));
    expect(actionable).toEqual({
      providerCaseId: 'issfr_123', kind: 'EARLY_FRAUD_WARNING', status: 'ACTIONABLE',
      reason: 'made_with_stolen_card', amount: null, currency: null, responseDueAt: null,
      providerPaymentIntentReference: 'pi_efw', providerChargeReference: 'ch_efw',
      providerCreatedAt: new Date(1_798_502_400_000), resolved: false,
    });
    expect(providerRiskCaseFromWebhook(webhook('radar.early_fraud_warning.updated', {
      id: 'issfr_123', actionable: false, fraud_type: 'made_with_stolen_card',
      payment_intent: 'pi_efw', charge: 'ch_efw',
    }))).toMatchObject({ status: 'NOT_ACTIONABLE', resolved: true });
  });

  it('ignores events outside the narrow risk-event allowlist', () => {
    expect(providerRiskCaseFromWebhook(webhook('charge.updated', { id: 'ch_123' }))).toBeNull();
    expect(providerRiskCaseFromWebhook(webhook('charge.dispute.funds_withdrawn', {
      id: 'dp_123',
    }))).toBeNull();
  });

  it.each([
    ['charge.dispute.created', { status: 'needs_response', reason: 'fraudulent', amount: 5000, currency: 'sgd', charge: 'ch_1' }],
    ['charge.dispute.updated', { id: 'dp_1', status: 'future_state', reason: 'fraudulent', amount: 5000, currency: 'sgd', charge: 'ch_1' }],
    ['charge.dispute.updated', { id: 'dp_1', status: 'under_review', reason: 'fraudulent', amount: 5.5, currency: 'sgd', charge: 'ch_1' }],
    ['charge.dispute.updated', { id: 'dp_1', status: 'under_review', reason: 'fraudulent', amount: 5000, currency: 'singapore-dollar', charge: 'ch_1' }],
    ['charge.dispute.updated', { id: 'dp_1', status: 'under_review', reason: 'fraudulent', amount: 5000, currency: 'sgd' }],
    ['radar.early_fraud_warning.created', { id: 'issfr_1', actionable: 'true', fraud_type: 'misc', charge: 'ch_1' }],
    ['radar.early_fraud_warning.updated', { id: 'issfr_1', actionable: true, charge: 'ch_1' }],
    ['radar.early_fraud_warning.updated', { id: 'issfr_1', actionable: true, fraud_type: 'misc', charge: { id: 'not-a-charge' } }],
  ])('rejects malformed recognized event %s', (type, dataObject) => {
    expect(() => providerRiskCaseFromWebhook(webhook(type, dataObject)))
      .toThrowError(expect.objectContaining({ status: 400 }));
  });
});
