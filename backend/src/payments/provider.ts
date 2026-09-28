export type PaymentProviderName = 'STRIPE';

export type PaymentIntentState =
  | 'REQUIRES_CONFIRMATION'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export type RefundState = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export type ProviderRequestContext = {
  providerAccountReference: string;
};

export type CreatePaymentIntentInput = ProviderRequestContext & {
  amount: number;
  currency: string;
  idempotencyKey: string;
  metadata?: Readonly<Record<string, string>>;
  receiptEmail?: string;
};

export type ProviderPaymentIntent = {
  id: string;
  state: PaymentIntentState;
  providerStatus: string;
  amount: number;
  currency: string;
  clientSecret: string | null;
  latestChargeId: string | null;
  failureCode: string | null;
};

export type CreateRefundInput = ProviderRequestContext & {
  paymentIntentId: string;
  amount: number;
  idempotencyKey: string;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  metadata?: Readonly<Record<string, string>>;
};

export type ProviderRefund = {
  id: string;
  paymentIntentId: string;
  state: RefundState;
  providerStatus: string;
  amount: number;
  currency: string;
  failureCode: string | null;
};

export type ProviderBalanceTransaction = {
  id: string;
  gross: number;
  fee: number;
  net: number;
  currency: string;
  availableOn: Date | null;
};

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  readonly enabled: boolean;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent>;
  retrievePaymentIntent(id: string, context: ProviderRequestContext): Promise<ProviderPaymentIntent>;
  cancelPaymentIntent(id: string, context: ProviderRequestContext): Promise<ProviderPaymentIntent>;
  createRefund(input: CreateRefundInput): Promise<ProviderRefund>;
  retrieveRefund(id: string, context: ProviderRequestContext): Promise<ProviderRefund>;
  retrieveBalanceTransaction(
    id: string, context: ProviderRequestContext,
  ): Promise<ProviderBalanceTransaction>;
}

export type PaymentProviderErrorOptions = {
  status?: number;
  transient?: boolean;
  providerCode?: string;
};

/**
 * A deliberately data-minimal error. Provider response bodies, request
 * bodies, API keys and client secrets must never be attached to this object.
 */
export class PaymentProviderError extends Error {
  readonly status: number | undefined;
  readonly transient: boolean;
  readonly providerCode: string | undefined;

  constructor(public readonly code: string, options: PaymentProviderErrorOptions = {}) {
    super(code);
    this.name = 'PaymentProviderError';
    this.status = options.status;
    this.transient = options.transient ?? false;
    this.providerCode = options.providerCode;
  }
}

function disabled(): never {
  throw new PaymentProviderError('PAYMENT_PROVIDER_DISABLED', { status: 503 });
}

/** Fail-closed provider used unless a deployment explicitly enables Stripe. */
export class DisabledPaymentProvider implements PaymentProvider {
  readonly name = 'STRIPE' as const;
  readonly enabled = false;

  async createPaymentIntent(_input: CreatePaymentIntentInput): Promise<ProviderPaymentIntent> { return disabled(); }
  async retrievePaymentIntent(_id: string, _context: ProviderRequestContext): Promise<ProviderPaymentIntent> { return disabled(); }
  async cancelPaymentIntent(_id: string, _context: ProviderRequestContext): Promise<ProviderPaymentIntent> { return disabled(); }
  async createRefund(_input: CreateRefundInput): Promise<ProviderRefund> { return disabled(); }
  async retrieveRefund(_id: string, _context: ProviderRequestContext): Promise<ProviderRefund> { return disabled(); }
  async retrieveBalanceTransaction(
    _id: string, _context: ProviderRequestContext,
  ): Promise<ProviderBalanceTransaction> { return disabled(); }
}

export const disabledPaymentProvider: PaymentProvider = new DisabledPaymentProvider();
