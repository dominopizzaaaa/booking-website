import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../src/config.js');
  vi.doUnmock('../src/legal-policy-gate.js');
  vi.resetModules();
});

describe('live payment commercial approval runtime gate', () => {
  it.each([
    ['create', null],
    ['retrieve', 'pi_prepared'],
  ] as const)('rechecks approval immediately before provider %s', async (_operation, providerReference) => {
    const runtimeConfig = { paymentCommercialApprovedVersion: '2026-09-29' };
    vi.doMock('../src/config.js', () => ({ config: runtimeConfig, production: true }));
    vi.doMock('../src/legal-policy-gate.js', () => ({ assertLegalAcceptanceEnabled: vi.fn() }));
    const { createOrResumeProviderCheckout } = await import('../src/payments/checkout.js');

    // The preparation represents a checkout prepared while approval was
    // current. Revocation before the provider call must fail closed.
    runtimeConfig.paymentCommercialApprovedVersion = '';
    const createPaymentIntent = vi.fn();
    const retrievePaymentIntent = vi.fn();
    const provider = {
      name: 'STRIPE' as const, enabled: true, createPaymentIntent, retrievePaymentIntent,
      cancelPaymentIntent: vi.fn(), createRefund: vi.fn(), retrieveRefund: vi.fn(),
      retrieveBalanceTransaction: vi.fn(),
    };

    await expect(createOrResumeProviderCheckout(provider, {
      intentId: 'intent_1', kind: 'BOOKING', amount: 8_000, currency: 'SGD',
      providerAccountReference: 'acct_club', providerReference, idempotencyKey: 'checkout-key',
      receiptEmail: 'student@example.test', review: {} as never, replay: providerReference !== null,
    }, vi.fn())).rejects.toMatchObject({
      status: 503, details: { code: 'PAYMENT_COMMERCIAL_NOT_APPROVED' },
    });
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('runs the mutable merchant and account preflight before provider create or retrieve', async () => {
    const runtimeConfig = { paymentCommercialApprovedVersion: '2026-09-29' };
    vi.doMock('../src/config.js', () => ({ config: runtimeConfig, production: true }));
    vi.doMock('../src/legal-policy-gate.js', () => ({ assertLegalAcceptanceEnabled: vi.fn() }));
    const { createOrResumeProviderCheckout } = await import('../src/payments/checkout.js');
    const provider = {
      name: 'STRIPE' as const, enabled: true, createPaymentIntent: vi.fn(), retrievePaymentIntent: vi.fn(),
      cancelPaymentIntent: vi.fn(), createRefund: vi.fn(), retrieveRefund: vi.fn(),
      retrieveBalanceTransaction: vi.fn(),
    };
    const preflight = vi.fn().mockRejectedValue(new Error('merchant changed'));
    await expect(createOrResumeProviderCheckout(provider, {
      intentId: 'intent_1', kind: 'BOOKING', amount: 8_000, currency: 'SGD',
      providerAccountReference: 'acct_club', providerReference: null, idempotencyKey: 'checkout-key',
      receiptEmail: 'student@example.test', review: {} as never, replay: false,
    }, preflight)).rejects.toThrow('merchant changed');
    expect(preflight).toHaveBeenCalledOnce();
    expect(provider.createPaymentIntent).not.toHaveBeenCalled();
    expect(provider.retrievePaymentIntent).not.toHaveBeenCalled();
  });
});
