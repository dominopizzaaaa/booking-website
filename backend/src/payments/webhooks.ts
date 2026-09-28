import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentProviderError } from './provider.js';

const defaultToleranceSeconds = 300;

export type StripeWebhookEvent = {
  id: string;
  type: string;
  account: string;
  createdAt: Date | null;
  livemode: boolean;
  dataObject: Readonly<Record<string, unknown>>;
  payloadHash: string;
  raw: Readonly<Record<string, unknown>>;
};

export function assertStripeEventMode(event: Pick<StripeWebhookEvent, 'livemode'>, publishableKey: string) {
  const expectsLiveMode = publishableKey.startsWith('pk_live_');
  if (event.livemode !== expectsLiveMode) {
    throw new PaymentProviderError('WEBHOOK_MODE_MISMATCH', { status: 400 });
  }
}

/** Fields accepted by Prisma's PaymentProviderEvent create data contract. */
export type PaymentProviderEventRecord = {
  businessId?: string | null;
  provider: 'STRIPE';
  providerAccountReference: string;
  providerEventId: string;
  eventType: string;
  payloadHash: string;
  providerCreatedAt: Date | null;
};

/** Fields used to create or reconcile a PaymentRefund without Prisma coupling. */
export type PaymentRefundRecord = {
  businessId: string;
  paymentIntentId: string;
  paymentId?: string | null;
  amount: number;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  reason: string;
  providerRefundId?: string | null;
  requestedByUserId?: string | null;
  failureCode?: string | null;
  succeededAt?: Date | null;
};

/** Persistence-safe view of BusinessPaymentAccount provider state. */
export type BusinessPaymentAccountRecord = {
  businessId: string;
  provider: 'STRIPE';
  providerAccountId: string;
  onboardingState: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  settlementCurrency: string;
  lastSyncedAt: Date | null;
};

function signatureParts(header: string) {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[a-fA-F0-9]{64}$/.test(value)) signatures.push(value.toLowerCase());
  }
  if (!Number.isSafeInteger(timestamp) || timestamp === null || timestamp < 0 || signatures.length === 0) {
    throw new PaymentProviderError('WEBHOOK_SIGNATURE_INVALID', { status: 400 });
  }
  return { timestamp, signatures };
}

export function verifyStripeWebhookSignature(input: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  webhookSecret: string;
  toleranceSeconds?: number;
  now?: Date;
}) {
  if (!input.webhookSecret || !input.signatureHeader) {
    throw new PaymentProviderError('WEBHOOK_SIGNATURE_INVALID', { status: 400 });
  }
  const { timestamp, signatures } = signatureParts(input.signatureHeader);
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? defaultToleranceSeconds;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0
    || Math.abs(nowSeconds - timestamp) > tolerance) {
    throw new PaymentProviderError('WEBHOOK_TIMESTAMP_INVALID', { status: 400 });
  }
  const body = Buffer.isBuffer(input.rawBody)
    ? input.rawBody : Buffer.from(input.rawBody, 'utf8');
  const expected = createHmac('sha256', input.webhookSecret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body])).digest();
  const valid = signatures.some(candidate => {
    const supplied = Buffer.from(candidate, 'hex');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!valid) throw new PaymentProviderError('WEBHOOK_SIGNATURE_INVALID', { status: 400 });
  return timestamp;
}

export function constructStripeWebhookEvent(input: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  webhookSecret: string;
  toleranceSeconds?: number;
  now?: Date;
}): StripeWebhookEvent {
  verifyStripeWebhookSignature(input);
  const body = Buffer.isBuffer(input.rawBody)
    ? input.rawBody : Buffer.from(input.rawBody, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch {
    throw new PaymentProviderError('WEBHOOK_PAYLOAD_INVALID', { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PaymentProviderError('WEBHOOK_PAYLOAD_INVALID', { status: 400 });
  }
  const record = parsed as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown> : {};
  const object = data.object && typeof data.object === 'object' && !Array.isArray(data.object)
    ? data.object as Record<string, unknown> : null;
  if (typeof record.id !== 'string' || !record.id
    || typeof record.type !== 'string' || !record.type || !object) {
    throw new PaymentProviderError('WEBHOOK_PAYLOAD_INVALID', { status: 400 });
  }
  const created = record.created;
  return {
    id: record.id,
    type: record.type,
    account: typeof record.account === 'string' ? record.account : '',
    createdAt: typeof created === 'number' && Number.isSafeInteger(created)
      ? new Date(created * 1000) : null,
    livemode: record.livemode === true,
    dataObject: object,
    payloadHash: createHash('sha256').update(body).digest('hex'),
    raw: record,
  };
}

export function paymentProviderEventRecord(
  event: StripeWebhookEvent, businessId?: string | null,
): PaymentProviderEventRecord {
  return {
    businessId,
    provider: 'STRIPE',
    providerAccountReference: event.account,
    providerEventId: event.id,
    eventType: event.type,
    payloadHash: event.payloadHash,
    providerCreatedAt: event.createdAt,
  };
}
