import {
  type CreatePaymentIntentInput,
  type CreateRefundInput,
  type PaymentIntentState,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderBalanceTransaction,
  type ProviderPaymentIntent,
  type ProviderRefund,
  type ProviderRequestContext,
  type RefundState,
} from './provider.js';

const defaultApiBase = 'https://api.stripe.com/v1';

export type StripeProviderConfig = {
  enabled: boolean;
  secretKey: string;
  requestTimeoutMs?: number;
  apiBase?: string;
};

type StripeRecord = Record<string, unknown>;

function stringField(record: StripeRecord, field: string): string;
function stringField(record: StripeRecord, field: string, required: false): string | null;
function stringField(record: StripeRecord, field: string, required = true): string | null {
  const value = record[field];
  if (typeof value === 'string' && value) return value;
  if (!required && (value === null || value === undefined || value === '')) return null;
  throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID');
}

function integerField(record: StripeRecord, field: string) {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID');
  }
  return value;
}

function stripeIntentState(status: string): PaymentIntentState {
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'canceled') return 'CANCELLED';
  if (status === 'processing') return 'PROCESSING';
  if (status === 'requires_payment_method' || status === 'requires_confirmation'
    || status === 'requires_action' || status === 'requires_capture') return 'REQUIRES_CONFIRMATION';
  throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID');
}

function stripeRefundState(status: string): RefundState {
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'failed') return 'FAILED';
  if (status === 'canceled') return 'CANCELLED';
  if (status === 'pending' || status === 'requires_action') return 'PENDING';
  throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID');
}

function paymentIntent(record: StripeRecord): ProviderPaymentIntent {
  const status = stringField(record, 'status');
  const lastError = record.last_payment_error && typeof record.last_payment_error === 'object'
    ? record.last_payment_error as StripeRecord : {};
  const latestCharge = record.latest_charge;
  return {
    id: stringField(record, 'id'),
    state: stripeIntentState(status),
    providerStatus: status,
    amount: integerField(record, 'amount'),
    currency: stringField(record, 'currency').toUpperCase(),
    clientSecret: stringField(record, 'client_secret', false),
    latestChargeId: typeof latestCharge === 'string' && latestCharge ? latestCharge : null,
    failureCode: typeof lastError.code === 'string' && lastError.code ? lastError.code : null,
  };
}

function refund(record: StripeRecord): ProviderRefund {
  const status = stringField(record, 'status');
  return {
    id: stringField(record, 'id'),
    paymentIntentId: stringField(record, 'payment_intent'),
    state: stripeRefundState(status),
    providerStatus: status,
    amount: integerField(record, 'amount'),
    currency: stringField(record, 'currency').toUpperCase(),
    failureCode: typeof record.failure_reason === 'string' && record.failure_reason
      ? record.failure_reason : null,
  };
}

function addMetadata(body: URLSearchParams, metadata?: Readonly<Record<string, string>>) {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))) {
    body.set(`metadata[${key}]`, value);
  }
}

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'STRIPE' as const;
  readonly enabled: boolean;
  private readonly apiBase: string;
  private readonly requestTimeoutMs: number;

  constructor(private readonly configuration: StripeProviderConfig) {
    this.enabled = configuration.enabled && Boolean(configuration.secretKey.trim());
    this.apiBase = (configuration.apiBase ?? defaultApiBase).replace(/\/$/, '');
    this.requestTimeoutMs = configuration.requestTimeoutMs ?? 10_000;
  }

  private assertEnabled() {
    if (!this.enabled) throw new PaymentProviderError('PAYMENT_PROVIDER_DISABLED', { status: 503 });
  }

  private async request(path: string, context: ProviderRequestContext, init: RequestInit = {}) {
    this.assertEnabled();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.apiBase}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.configuration.secretKey}`,
          ...(context.providerAccountReference
            ? { 'Stripe-Account': context.providerAccountReference } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = null; }
      }
      if (!response.ok) {
        const outer = body && typeof body === 'object' ? body as StripeRecord : {};
        const detail = outer.error && typeof outer.error === 'object'
          ? outer.error as StripeRecord : {};
        const providerCode = typeof detail.code === 'string' ? detail.code
          : typeof detail.type === 'string' ? detail.type : undefined;
        const transient = response.status === 408 || response.status === 409
          || response.status === 429 || response.status >= 500;
        throw new PaymentProviderError(
          transient ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_REJECTED',
          { status: response.status, transient, providerCode },
        );
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new PaymentProviderError('PROVIDER_RESPONSE_INVALID');
      }
      return body as StripeRecord;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      if (controller.signal.aborted) {
        throw new PaymentProviderError('PROVIDER_TIMEOUT', { status: 504, transient: true });
      }
      throw new PaymentProviderError('PROVIDER_UNAVAILABLE', { status: 502, transient: true });
    } finally {
      clearTimeout(timeout);
    }
  }

  async createPaymentIntent(input: CreatePaymentIntentInput) {
    const body = new URLSearchParams({
      amount: String(input.amount),
      currency: input.currency.toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
    });
    if (input.receiptEmail) body.set('receipt_email', input.receiptEmail);
    addMetadata(body, input.metadata);
    return paymentIntent(await this.request('/payment_intents', input, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': input.idempotencyKey,
      },
      body,
    }));
  }

  async retrievePaymentIntent(id: string, context: ProviderRequestContext) {
    return paymentIntent(await this.request(`/payment_intents/${encodeURIComponent(id)}`, context));
  }

  async cancelPaymentIntent(id: string, context: ProviderRequestContext) {
    return paymentIntent(await this.request(
      `/payment_intents/${encodeURIComponent(id)}/cancel`, context, { method: 'POST' },
    ));
  }

  async createRefund(input: CreateRefundInput) {
    const body = new URLSearchParams({
      payment_intent: input.paymentIntentId,
      amount: String(input.amount),
    });
    if (input.reason) body.set('reason', input.reason);
    addMetadata(body, input.metadata);
    return refund(await this.request('/refunds', input, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': input.idempotencyKey,
      },
      body,
    }));
  }

  async retrieveRefund(id: string, context: ProviderRequestContext) {
    return refund(await this.request(`/refunds/${encodeURIComponent(id)}`, context));
  }

  async retrieveBalanceTransaction(id: string, context: ProviderRequestContext) {
    const record = await this.request(`/balance_transactions/${encodeURIComponent(id)}`, context);
    const availableOn = record.available_on;
    const result: ProviderBalanceTransaction = {
      id: stringField(record, 'id'),
      gross: integerField(record, 'amount'),
      fee: integerField(record, 'fee'),
      net: integerField(record, 'net'),
      currency: stringField(record, 'currency').toUpperCase(),
      availableOn: typeof availableOn === 'number' && Number.isSafeInteger(availableOn)
        ? new Date(availableOn * 1000) : null,
    };
    return result;
  }
}

export function createStripePaymentProvider(configuration: StripeProviderConfig): PaymentProvider {
  return new StripePaymentProvider(configuration);
}
