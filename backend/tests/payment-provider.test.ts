import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisabledPaymentProvider, PaymentProviderError } from '../src/payments/provider.js';
import { StripePaymentProvider } from '../src/payments/stripe.js';

afterEach(() => vi.restoreAllMocks());

describe('payment provider boundary', () => {
  it('fails closed when the provider is disabled', async () => {
    const provider = new DisabledPaymentProvider();
    await expect(provider.createPaymentIntent({
      amount: 5_000, currency: 'SGD', idempotencyKey: 'checkout-1',
      providerAccountReference: 'acct_club',
    })).rejects.toMatchObject({
      name: 'PaymentProviderError', code: 'PAYMENT_PROVIDER_DISABLED', status: 503,
    });
  });

  it('also stays disabled when enabled is true but the secret is blank', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const provider = new StripePaymentProvider({ enabled: true, secretKey: '  ' });
    await expect(provider.retrievePaymentIntent('pi_123', {
      providerAccountReference: 'acct_club',
    })).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_DISABLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Stripe payment provider', () => {
  it('creates an account-scoped intent with idempotency and integer minor units', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'pi_123', status: 'requires_action', amount: 5_000, currency: 'sgd',
      client_secret: 'pi_123_secret_sensitive', latest_charge: null,
    }), { status: 200 }));
    const provider = new StripePaymentProvider({ enabled: true, secretKey: 'sk_test_sensitive' });

    const result = await provider.createPaymentIntent({
      amount: 5_000, currency: 'SGD', idempotencyKey: 'checkout-1',
      providerAccountReference: 'acct_club', receiptEmail: 'student@example.com',
      metadata: { courtlyPaymentIntentId: 'local-intent' },
    });

    expect(result).toEqual({
      id: 'pi_123', state: 'REQUIRES_CONFIRMATION', providerStatus: 'requires_action',
      amount: 5_000, currency: 'SGD', clientSecret: 'pi_123_secret_sensitive',
      latestChargeId: null, failureCode: null,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.stripe.com/v1/payment_intents');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer sk_test_sensitive',
      'Stripe-Account': 'acct_club',
      'Idempotency-Key': 'checkout-1',
    });
    expect(String(init?.body)).toContain('amount=5000');
    expect(String(init?.body)).toContain('metadata%5BcourtlyPaymentIntentId%5D=local-intent');
  });

  it('creates a partial refund with a separate idempotency key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 're_123', payment_intent: 'pi_123', status: 'succeeded', amount: 2_000, currency: 'sgd',
    }), { status: 200 }));
    const provider = new StripePaymentProvider({ enabled: true, secretKey: 'sk_test_sensitive' });

    await expect(provider.createRefund({
      paymentIntentId: 'pi_123', amount: 2_000, idempotencyKey: 'refund-local-1',
      providerAccountReference: 'acct_club', reason: 'requested_by_customer',
    })).resolves.toMatchObject({
      id: 're_123', state: 'SUCCEEDED', paymentIntentId: 'pi_123', amount: 2_000,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ 'Idempotency-Key': 'refund-local-1' });
    expect(String(init?.body)).toBe(
      'payment_intent=pi_123&amount=2000&reason=requested_by_customer',
    );
  });

  it('returns only a sanitized provider error and classifies retryable failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: {
      type: 'api_error', code: 'lock_timeout', message: 'secret provider detail',
      payment_intent: { client_secret: 'pi_secret_leak' },
    } }), { status: 503 }));
    const provider = new StripePaymentProvider({ enabled: true, secretKey: 'sk_secret_leak' });

    let error: unknown;
    try {
      await provider.retrievePaymentIntent('pi_123', { providerAccountReference: 'acct_club' });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE', status: 503, transient: true, providerCode: 'lock_timeout',
    });
    expect(JSON.stringify(error)).not.toMatch(/secret provider detail|pi_secret_leak|sk_secret_leak/);
  });

  it('rejects malformed successful responses instead of guessing their state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'pi_123', status: 'succeeded', currency: 'sgd',
    }), { status: 200 }));
    const provider = new StripePaymentProvider({ enabled: true, secretKey: 'sk_test' });
    await expect(provider.retrievePaymentIntent('pi_123', {
      providerAccountReference: 'acct_club',
    })).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });

  it('rejects unknown provider statuses instead of converting them to a terminal state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'pi_123', status: 'future_status', amount: 5_000, currency: 'sgd',
    }), { status: 200 }));
    const provider = new StripePaymentProvider({ enabled: true, secretKey: 'sk_test' });
    await expect(provider.retrievePaymentIntent('pi_123', {
      providerAccountReference: 'acct_club',
    })).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });
});
