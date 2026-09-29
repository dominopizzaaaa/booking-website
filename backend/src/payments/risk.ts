import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../http.js';
import type { StripeWebhookEvent } from './webhooks.js';

type Tx = Prisma.TransactionClient;
type JsonObject = Readonly<Record<string, unknown>>;

export type PaymentRiskCaseKind = 'DISPUTE' | 'INQUIRY' | 'EARLY_FRAUD_WARNING';

export type PaymentRiskCaseStatus =
  | 'NEEDS_RESPONSE'
  | 'UNDER_REVIEW'
  | 'WON'
  | 'LOST'
  | 'PREVENTED'
  | 'WARNING_NEEDS_RESPONSE'
  | 'WARNING_UNDER_REVIEW'
  | 'WARNING_CLOSED'
  | 'ACTIONABLE'
  | 'NOT_ACTIONABLE';

export function canApplyPaymentRiskKindTransition(
  existing: PaymentRiskCaseKind, next: PaymentRiskCaseKind,
) {
  return existing === next || (existing === 'INQUIRY' && next === 'DISPUTE');
}

/** Minimal provider data that is safe to retain in the operational risk case. */
export type ProviderRiskCase = {
  providerCaseId: string;
  kind: PaymentRiskCaseKind;
  status: PaymentRiskCaseStatus;
  reason: string;
  amount: number | null;
  currency: string | null;
  responseDueAt: Date | null;
  providerPaymentIntentReference: string | null;
  providerChargeReference: string | null;
  providerCreatedAt: Date | null;
  resolved: boolean;
};

const disputeEventTypes = new Set([
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
]);
const earlyFraudWarningEventTypes = new Set([
  'radar.early_fraud_warning.created',
  'radar.early_fraud_warning.updated',
]);
const disputeStatuses = new Set([
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
]);
const terminalDisputeStatuses = new Set(['won', 'lost', 'prevented', 'warning_closed']);
const terminalRiskStatuses = new Set<PaymentRiskCaseStatus>([
  'WON', 'LOST', 'PREVENTED', 'WARNING_CLOSED', 'NOT_ACTIONABLE',
]);

export function canApplyPaymentRiskStatusTransition(
  existingKind: PaymentRiskCaseKind, existingStatus: PaymentRiskCaseStatus,
  nextKind: PaymentRiskCaseKind, nextStatus: PaymentRiskCaseStatus,
) {
  if (!terminalRiskStatuses.has(existingStatus)) return true;
  // A pre-dispute inquiry may legitimately become a formal dispute. Within a
  // case family, provider delivery order must never reopen a terminal case.
  if (existingKind === 'INQUIRY' && nextKind === 'DISPUTE') return true;
  return terminalRiskStatuses.has(nextStatus);
}

export function shouldApplyPaymentRiskUpdate(existing: {
  kind: PaymentRiskCaseKind; status: PaymentRiskCaseStatus; lastProviderEventAt: Date;
}, next: { kind: PaymentRiskCaseKind; status: PaymentRiskCaseStatus }, eventAt: Date) {
  const order = eventAt.getTime() - existing.lastProviderEventAt.getTime();
  if (order < 0 || !canApplyPaymentRiskStatusTransition(
    existing.kind, existing.status, next.kind, next.status,
  )) return false;
  if (order > 0) return true;
  // Stripe event timestamps have only one-second precision. Preserve an
  // already-recorded terminal outcome when another, different terminal result
  // shares that timestamp; otherwise delivery order would decide the outcome.
  if (terminalRiskStatuses.has(existing.status) && terminalRiskStatuses.has(next.status)
    && existing.kind === next.kind && existing.status !== next.status) return false;
  return true;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(object: JsonObject, field: string, label: string, maximum = 255) {
  const value = object[field];
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new HttpError(400, `${label} event is malformed`);
  }
  return value;
}

function optionalStripeReference(
  object: JsonObject, field: string, prefix: 'pi_' | 'ch_', label: string,
): string | null {
  const value = object[field];
  if (value === null || value === undefined) return null;
  const reference = typeof value === 'string'
    ? value
    : isObject(value) && typeof value.id === 'string' ? value.id : null;
  if (!reference || !reference.startsWith(prefix) || reference.length > 255) {
    throw new HttpError(400, `${label} event is malformed`);
  }
  return reference;
}

function optionalUnixDate(object: JsonObject, field: string, label: string): Date | null {
  const value = object[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, `${label} event is malformed`);
  }
  const result = new Date(value * 1000);
  if (Number.isNaN(result.getTime())) throw new HttpError(400, `${label} event is malformed`);
  return result;
}

function paymentReferences(object: JsonObject, label: string) {
  const providerPaymentIntentReference = optionalStripeReference(object, 'payment_intent', 'pi_', label);
  const providerChargeReference = optionalStripeReference(object, 'charge', 'ch_', label);
  if (!providerPaymentIntentReference && !providerChargeReference) {
    throw new HttpError(400, `${label} event is malformed`);
  }
  return { providerPaymentIntentReference, providerChargeReference };
}

function parseDispute(object: JsonObject): ProviderRiskCase {
  const label = 'Stripe dispute';
  const providerCaseId = requiredString(object, 'id', label);
  const status = requiredString(object, 'status', label);
  if (!disputeStatuses.has(status)) {
    throw new HttpError(400, 'Stripe dispute event has an unsupported status');
  }
  const amount = object.amount;
  const currency = object.currency;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0
    || typeof currency !== 'string' || !/^[a-z]{3}$/iu.test(currency)) {
    throw new HttpError(400, `${label} event is malformed`);
  }
  const evidenceDetails = object.evidence_details;
  if (evidenceDetails !== null && evidenceDetails !== undefined && !isObject(evidenceDetails)) {
    throw new HttpError(400, `${label} event is malformed`);
  }
  const reason = requiredString(object, 'reason', label, 100);
  const normalizedStatus = status.toUpperCase() as PaymentRiskCaseStatus;
  return {
    providerCaseId,
    kind: status.startsWith('warning_') ? 'INQUIRY' : 'DISPUTE',
    status: normalizedStatus,
    reason, amount, currency: currency.toUpperCase(),
    responseDueAt: evidenceDetails ? optionalUnixDate(evidenceDetails, 'due_by', label) : null,
    ...paymentReferences(object, label),
    providerCreatedAt: optionalUnixDate(object, 'created', label),
    resolved: terminalDisputeStatuses.has(status),
  };
}

function parseEarlyFraudWarning(object: JsonObject): ProviderRiskCase {
  const label = 'Stripe early fraud warning';
  const providerCaseId = requiredString(object, 'id', label);
  if (typeof object.actionable !== 'boolean') {
    throw new HttpError(400, `${label} event is malformed`);
  }
  return {
    providerCaseId, kind: 'EARLY_FRAUD_WARNING',
    status: object.actionable ? 'ACTIONABLE' : 'NOT_ACTIONABLE',
    reason: requiredString(object, 'fraud_type', label, 100),
    amount: null, currency: null, responseDueAt: null,
    ...paymentReferences(object, label),
    providerCreatedAt: optionalUnixDate(object, 'created', label),
    resolved: !object.actionable,
  };
}

/**
 * Parse only Stripe risk events. The returned value deliberately omits raw
 * evidence, card/customer data, metadata, and all other webhook fields.
 */
export function providerRiskCaseFromWebhook(event: StripeWebhookEvent): ProviderRiskCase | null {
  if (disputeEventTypes.has(event.type)) return parseDispute(event.dataObject);
  if (earlyFraudWarningEventTypes.has(event.type)) return parseEarlyFraudWarning(event.dataObject);
  return null;
}

function eventTime(event: StripeWebhookEvent, now: Date) {
  const value = event.createdAt ?? now;
  if (Number.isNaN(value.getTime())) throw new HttpError(400, 'Stripe risk event is malformed');
  return value;
}

async function exactLocalIntent(tx: Tx, input: {
  businessId: string; providerAccountReference: string; riskCase: ProviderRiskCase;
}) {
  const referenceFilters: Prisma.PaymentIntentWhereInput[] = [];
  if (input.riskCase.providerPaymentIntentReference) {
    referenceFilters.push({ providerReference: input.riskCase.providerPaymentIntentReference });
  }
  if (input.riskCase.providerChargeReference) {
    referenceFilters.push({ providerChargeReference: input.riskCase.providerChargeReference });
  }
  const matches = await tx.paymentIntent.findMany({
    where: {
      businessId: input.businessId, provider: 'STRIPE',
      providerAccountReference: input.providerAccountReference, OR: referenceFilters,
    },
    select: { id: true, providerReference: true, providerChargeReference: true },
    take: 3,
  });
  if (matches.length === 0) throw new HttpError(404, 'Webhook payment intent is not known');
  if (matches.length > 1) throw new HttpError(409, 'Webhook payment references are ambiguous');

  const [intent] = matches;
  if (!intent
    || (input.riskCase.providerPaymentIntentReference && intent.providerReference
      && input.riskCase.providerPaymentIntentReference !== intent.providerReference)
    || (input.riskCase.providerChargeReference && intent.providerChargeReference
      && input.riskCase.providerChargeReference !== intent.providerChargeReference)) {
    throw new HttpError(404, 'Webhook payment intent is not known');
  }
  return intent;
}

/**
 * Resolve a signed Stripe event to one exact connected-account payment and
 * upsert its safe operational snapshot. Unknown or ambiguous payments fail
 * closed; provider updates never overwrite the locally assigned owner.
 */
export async function applyProviderRiskCaseWebhook(
  event: StripeWebhookEvent, riskCase: ProviderRiskCase, now = new Date(),
) {
  if (!event.account) throw new HttpError(400, 'Stripe risk event has no connected account');
  const lastProviderEventAt = eventTime(event, now);
  const identity = {
    provider: 'STRIPE', providerAccountReference: event.account, providerCaseId: riskCase.providerCaseId,
  } as const;

  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-risk:STRIPE:${event.account}:${riskCase.providerCaseId}`}, 0))`;
    const account = await tx.businessPaymentAccount.findFirst({
      where: { provider: 'STRIPE', providerAccountId: event.account },
      select: { businessId: true },
    });
    if (!account) throw new HttpError(404, 'Webhook payment account is not known');
    const intent = await exactLocalIntent(tx, {
      businessId: account.businessId, providerAccountReference: event.account, riskCase,
    });
    const existing = await tx.paymentRiskCase.findUnique({
      where: { provider_providerAccountReference_providerCaseId: identity },
    });
    if (existing && (existing.businessId !== account.businessId
      || (existing.paymentIntentId && existing.paymentIntentId !== intent.id)
      || !canApplyPaymentRiskKindTransition(
        existing.kind as PaymentRiskCaseKind, riskCase.kind,
      ))) {
      throw new HttpError(409, 'Webhook risk case does not match its existing record');
    }
    if (existing && !shouldApplyPaymentRiskUpdate({
      kind: existing.kind as PaymentRiskCaseKind, status: existing.status as PaymentRiskCaseStatus,
      lastProviderEventAt: existing.lastProviderEventAt,
    }, riskCase, lastProviderEventAt)) return existing;

    const resolvedAt = riskCase.resolved ? existing?.resolvedAt ?? lastProviderEventAt : null;
    return tx.paymentRiskCase.upsert({
      where: { provider_providerAccountReference_providerCaseId: identity },
      create: {
        ...identity, businessId: account.businessId, paymentIntentId: intent.id,
        kind: riskCase.kind, status: riskCase.status, reason: riskCase.reason,
        amount: riskCase.amount, currency: riskCase.currency, responseDueAt: riskCase.responseDueAt,
        providerCreatedAt: riskCase.providerCreatedAt, lastProviderEventAt, resolvedAt,
      },
      update: {
        paymentIntentId: intent.id, kind: riskCase.kind, status: riskCase.status, reason: riskCase.reason,
        amount: riskCase.amount, currency: riskCase.currency, responseDueAt: riskCase.responseDueAt,
        providerCreatedAt: existing?.providerCreatedAt ?? riskCase.providerCreatedAt,
        lastProviderEventAt, resolvedAt,
      },
    });
  }, { timeout: 30_000 });
}
