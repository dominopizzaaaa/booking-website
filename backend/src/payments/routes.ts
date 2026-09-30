import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { requireAuth, requireStudent } from '../auth.js';
import { asyncRoute, hasClubPermission, HttpError, requireRecentAuth } from '../http.js';
import { checkoutReviewFor, createOrResumeProviderCheckout, checkoutIntentJson, prepareCheckout } from './checkout.js';
import { checkoutAcceptanceSchema, liveCheckoutBlockReasons } from './compliance.js';
import { applyProviderPaymentIntent, providerIntentFromWebhook } from './fulfillment.js';
import { disabledPaymentProvider, PaymentProviderError, type PaymentProvider } from './provider.js';
import { StripePaymentProvider } from './stripe.js';
import { assertStripeEventMode, constructStripeWebhookEvent, paymentProviderEventRecord, type StripeWebhookEvent } from './webhooks.js';
import { applyProviderRefundWebhook, providerRefundFromWebhook } from './refunds.js';
import { applyProviderRiskCaseWebhook, providerRiskCaseFromWebhook } from './risk.js';
import { paymentReceiptJson, paymentReceiptRelations, renderPaymentReceiptDocument } from './receipts.js';

const checkoutInput = z.object({
  kind: z.enum(['PACKAGE', 'BOOKING']),
  targetId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(8).max(200),
  acceptance: checkoutAcceptanceSchema,
}).strict();
const checkoutReviewQuery = checkoutInput.pick({ kind: true, targetId: true });

const accountQuery = z.object({ businessId: z.string().trim().min(1).max(200) }).strict();
const firstQueryValue = (value: unknown) => Array.isArray(value) ? value[0] : value;
const riskCasesQuery = z.object({
  kind: z.preprocess(firstQueryValue, z.enum(['DISPUTE', 'INQUIRY', 'EARLY_FRAUD_WARNING']).optional()),
  status: z.preprocess(firstQueryValue, z.string().trim().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).optional()),
  limit: z.preprocess(firstQueryValue, z.coerce.number().int().min(1).max(100).default(50)),
}).strict();

export type PaymentRuntime = {
  mode: 'disabled' | 'stripe' | 'simulated';
  publishableKey: string;
  webhookSecret: string;
  provider: PaymentProvider;
};

export function webhookClaimBlockReason(
  event: { availableAt: Date; leasedUntil: Date | null }, now = new Date(),
): 'BACKOFF' | 'LEASED' | null {
  if (event.availableAt > now) return 'BACKOFF';
  if (event.leasedUntil && event.leasedUntil >= now) return 'LEASED';
  return null;
}

export function configuredPaymentRuntime(): PaymentRuntime {
  return {
    mode: config.payments.mode, publishableKey: config.payments.publishableKey,
    webhookSecret: config.payments.webhookSecret,
    provider: config.payments.mode === 'stripe'
      ? new StripePaymentProvider({ enabled: true, secretKey: config.payments.secretKey })
      : disabledPaymentProvider,
  };
}

function providerHttpError(error: unknown): never {
  if (error instanceof PaymentProviderError) {
    const status = error.code === 'PAYMENT_PROVIDER_DISABLED' ? 503
      : error.status && error.status >= 400 && error.status < 500 ? 400 : 502;
    throw new HttpError(status, error.transient
      ? 'The payment provider is temporarily unavailable. Please retry.'
      : 'The payment provider could not complete this request.', { code: error.code });
  }
  throw error;
}

export function createPaymentsRouter(runtime: PaymentRuntime = configuredPaymentRuntime()) {
  const router = Router();

  router.get('/payments/capabilities', requireAuth, asyncRoute(async (_req, res) => {
    const blockedReasons = liveCheckoutBlockReasons();
    res.json({
      mode: runtime.mode, enabled: runtime.mode !== 'disabled',
      liveCheckout: runtime.mode === 'stripe' && runtime.provider.enabled && blockedReasons.length === 0,
      simulatedCheckout: runtime.mode === 'simulated',
      publishableKey: runtime.mode === 'stripe' ? runtime.publishableKey : null,
      blockedReasons,
    });
  }));

  router.get('/payments/account-status', requireAuth, asyncRoute(async (req, res) => {
    const query = accountQuery.parse(req.query);
    if (req.auth.business?.id !== query.businessId || !hasClubPermission(req.auth, 'PAYMENTS_VIEW')) {
      throw new HttpError(403, 'Select this club with payments view permission to continue');
    }
    const account = await prisma.businessPaymentAccount.findFirst({
      where: { businessId: query.businessId },
      select: {
        businessId: true, provider: true, onboardingState: true, chargesEnabled: true,
        payoutsEnabled: true, detailsSubmitted: true, settlementCurrency: true, lastSyncedAt: true,
      },
    });
    res.json({
      mode: runtime.mode, ready: runtime.mode === 'stripe' && Boolean(account?.chargesEnabled),
      account: account ? { ...account, lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null } : null,
    });
  }));

  router.get('/payments/risk-cases', requireAuth, asyncRoute(async (req, res) => {
    if (!req.auth.business || !hasClubPermission(req.auth, 'PAYMENTS_VIEW')) {
      throw new HttpError(403, 'Select a club with payments view permission to continue');
    }
    const query = riskCasesQuery.parse(req.query);
    const cases = await prisma.paymentRiskCase.findMany({
      where: { businessId: req.auth.business.id, kind: query.kind, status: query.status },
      select: {
        id: true, paymentIntentId: true, providerCaseId: true, kind: true, status: true, reason: true,
        amount: true, currency: true, responseDueAt: true, providerCreatedAt: true,
        lastProviderEventAt: true, resolvedAt: true, owner: { select: { name: true, username: true } },
      },
      orderBy: [{ lastProviderEventAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    res.json({ riskCases: cases.map(item => ({
      ...item, responseDueAt: item.responseDueAt?.toISOString() ?? null,
      providerCreatedAt: item.providerCreatedAt?.toISOString() ?? null,
      lastProviderEventAt: item.lastProviderEventAt.toISOString(),
      resolvedAt: item.resolvedAt?.toISOString() ?? null,
    })) });
  }));

  router.get('/payments/checkout-review', requireAuth, requireStudent, asyncRoute(async (req, res) => {
    const input = checkoutReviewQuery.parse(req.query);
    const review = await checkoutReviewFor({ userId: req.auth.user.id, ...input });
    res.json({ review });
  }));

  router.post('/payments/checkout-intents', requireAuth, requireStudent, requireRecentAuth, asyncRoute(async (req, res) => {
    if (runtime.mode !== 'stripe' || !runtime.provider.enabled) {
      throw new HttpError(503, runtime.mode === 'simulated'
        ? 'Live payment checkout is unavailable in simulated mode'
        : 'Online payments are not configured');
    }
    const input = checkoutInput.parse(req.body);
    const preparation = await prepareCheckout({
      userId: req.auth.user.id, ...input, sessionId: req.auth.session.id,
      ip: req.ip, userAgent: req.get('user-agent'),
    });
    try {
      const result = await createOrResumeProviderCheckout(runtime.provider, preparation);
      res.status(result.replay ? 200 : 201).json({
        paymentIntent: checkoutIntentJson(result.intent, result.clientSecret),
        // Direct charges belong to the club's connected Stripe account. The
        // browser needs this public account identifier when initializing
        // Stripe.js so it can confirm the returned client secret.
        connectedAccountId: preparation.providerAccountReference,
        review: preparation.review,
      });
    } catch (error) { providerHttpError(error); }
  }));

  router.get('/payments/checkout-intents/:id', requireAuth, requireStudent, asyncRoute(async (req, res) => {
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: req.params.id, userId: req.auth.user.id },
    });
    if (!intent) throw new HttpError(404, 'Payment intent not found');
    res.json({ paymentIntent: checkoutIntentJson(intent) });
  }));

  router.get('/payments/receipts', requireAuth, requireStudent, asyncRoute(async (req, res) => {
    const receipts = await prisma.paymentReceipt.findMany({
      where: { userId: req.auth.user.id }, include: paymentReceiptRelations,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }], take: 200,
    });
    res.json({ receipts: receipts.map(paymentReceiptJson) });
  }));

  router.get('/payments/receipts/:id', requireAuth, requireStudent, asyncRoute(async (req, res) => {
    const receipt = await prisma.paymentReceipt.findFirst({
      where: { id: req.params.id, userId: req.auth.user.id }, include: paymentReceiptRelations,
    });
    if (!receipt) throw new HttpError(404, 'Payment receipt not found');
    res.json({ receipt: paymentReceiptJson(receipt) });
  }));

  router.get('/payments/receipts/:id/document', requireAuth, requireStudent, asyncRoute(async (req, res) => {
    const receipt = await prisma.paymentReceipt.findFirst({
      where: { id: req.params.id, userId: req.auth.user.id }, include: paymentReceiptRelations,
    });
    if (!receipt) throw new HttpError(404, 'Payment receipt not found');
    const filename = `${receipt.receiptNumber}.html`;
    if (req.query.download === '1') res.attachment(filename);
    else res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.type('html').send(renderPaymentReceiptDocument(receipt));
  }));

  return router;
}

async function updateConnectedAccount(event: StripeWebhookEvent) {
  if (event.type !== 'account.updated') return false;
  const object = event.dataObject;
  if (typeof object.id !== 'string') throw new HttpError(400, 'Stripe account event is malformed');
  const currency = typeof object.default_currency === 'string'
    ? object.default_currency.toUpperCase() : null;
  await prisma.businessPaymentAccount.updateMany({
    where: { provider: 'STRIPE', providerAccountId: object.id },
    data: {
      chargesEnabled: object.charges_enabled === true, payoutsEnabled: object.payouts_enabled === true,
      detailsSubmitted: object.details_submitted === true,
      onboardingState: object.charges_enabled === true ? 'ACTIVE'
        : object.details_submitted === true ? 'RESTRICTED' : 'PENDING',
      ...(currency ? { settlementCurrency: currency } : {}), lastSyncedAt: new Date(),
    },
  });
  return true;
}

export async function processStripeWebhookEvent(event: StripeWebhookEvent) {
  const providerRefund = providerRefundFromWebhook(event);
  if (providerRefund) {
    await applyProviderRefundWebhook(event, providerRefund);
    return;
  }
  const providerIntent = providerIntentFromWebhook(event);
  if (providerIntent) {
    const localId = typeof event.dataObject.metadata === 'object' && event.dataObject.metadata
      ? (event.dataObject.metadata as Record<string, unknown>).courtlyPaymentIntentId : undefined;
    const providerReference = event.dataObject.id as string;
    const intent = typeof localId === 'string'
      ? await prisma.paymentIntent.findFirst({ where: {
        id: localId, provider: 'STRIPE', providerAccountReference: event.account,
        OR: [{ providerReference }, { providerReference: null }],
      } })
      : await prisma.paymentIntent.findFirst({ where: {
        provider: 'STRIPE', providerAccountReference: event.account, providerReference,
      } });
    if (!intent) throw new HttpError(404, 'Webhook payment intent is not known');
    if (intent.providerReference === null) {
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, providerReference: null }, data: { providerReference },
      });
    }
    await applyProviderPaymentIntent(intent.id, providerIntent, event.createdAt ?? new Date());
    return;
  }
  const providerRiskCase = providerRiskCaseFromWebhook(event);
  if (providerRiskCase) {
    await applyProviderRiskCaseWebhook(event, providerRiskCase);
    return;
  }
  await updateConnectedAccount(event);
}

export function createStripeWebhookHandler(runtime: PaymentRuntime = configuredPaymentRuntime()): RequestHandler {
  return asyncRoute(async (req, res) => {
    if (runtime.mode !== 'stripe' || !runtime.webhookSecret) {
      throw new HttpError(503, 'Stripe webhooks are not configured');
    }
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Stripe webhook requires a raw request body');
    let event: StripeWebhookEvent;
    try {
      event = constructStripeWebhookEvent({
        rawBody: req.body, signatureHeader: req.get('stripe-signature'),
        webhookSecret: runtime.webhookSecret,
      });
      assertStripeEventMode(event, runtime.publishableKey);
    } catch (error) { providerHttpError(error); }

    const account = event.account ? await prisma.businessPaymentAccount.findUnique({
      where: { providerAccountId: event.account }, select: { businessId: true },
    }) : null;
    const record = paymentProviderEventRecord(event, account?.businessId ?? null);
    const identity = {
      provider: record.provider, providerAccountReference: record.providerAccountReference,
      providerEventId: record.providerEventId,
    };
    const existing = await prisma.paymentProviderEvent.findUnique({
      where: { provider_providerAccountReference_providerEventId: identity },
    });
    if (existing?.payloadHash !== undefined && existing.payloadHash !== record.payloadHash) {
      throw new HttpError(409, 'Webhook event identifier was reused with different content');
    }
    const inbox = existing ?? await prisma.paymentProviderEvent.upsert({
      where: { provider_providerAccountReference_providerEventId: identity },
      create: record, update: {},
    });
    if (inbox.payloadHash !== record.payloadHash) {
      throw new HttpError(409, 'Webhook event identifier was reused with different content');
    }
    if (!inbox.processedAt) {
      const now = new Date();
      const blocked = webhookClaimBlockReason(inbox, now);
      if (blocked === 'BACKOFF') {
        throw new HttpError(503, 'Webhook processing is backing off and must be retried');
      }
      if (blocked === 'LEASED') {
        throw new HttpError(503, 'Webhook processing is already in progress; retry later');
      }
      const leaseToken = randomUUID();
      const claimed = await prisma.paymentProviderEvent.updateMany({
        where: {
          id: inbox.id, processedAt: null, availableAt: { lte: now },
          OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
        },
        data: { leaseToken, leasedUntil: new Date(Date.now() + 30_000) },
      });
      if (!claimed.count) {
        throw new HttpError(503, 'Webhook processing state changed; retry later');
      }
      try {
        await processStripeWebhookEvent(event);
        await prisma.paymentProviderEvent.updateMany({ where: { id: inbox.id, leaseToken }, data: {
          processedAt: new Date(), attempts: { increment: 1 }, lastErrorCode: null,
          leaseToken: null, leasedUntil: null,
        } });
      } catch (error) {
        const code = error instanceof HttpError ? `HTTP_${error.status}` : 'PROCESSING_FAILED';
        await prisma.paymentProviderEvent.updateMany({ where: { id: inbox.id, leaseToken }, data: {
          attempts: { increment: 1 }, lastErrorCode: code, availableAt: new Date(Date.now() + 60_000),
          leaseToken: null, leasedUntil: null,
        } });
        throw error;
      }
    }
    res.json({ received: true });
  });
}

export const paymentsRouter = createPaymentsRouter();
export const stripeWebhookHandler = createStripeWebhookHandler();
