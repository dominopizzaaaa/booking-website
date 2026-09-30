import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { queueOutboundEmail } from '../outbound-events.js';
import type { CheckoutReview } from './compliance.js';

type Tx = Prisma.TransactionClient;
type JsonObject = Record<string, unknown>;

export type ReceiptRefundStatus = 'NONE' | 'PENDING' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'FAILED' | 'CANCELLED';

const receiptInclude = {
  payment: { select: { reversedAt: true } },
  paymentIntent: { select: {
    status: true, providerReference: true,
    refunds: { select: { amount: true, status: true, succeededAt: true, createdAt: true } },
  } },
} satisfies Prisma.PaymentReceiptInclude;

export type ReceiptWithState = Prisma.PaymentReceiptGetPayload<{ include: typeof receiptInclude }>;

function object(value: Prisma.JsonValue): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function acceptedReview(intent: { checkoutSnapshot: Prisma.JsonValue | null; acceptedReviewHash: string | null }) {
  if (!intent.checkoutSnapshot || typeof intent.checkoutSnapshot !== 'object'
    || Array.isArray(intent.checkoutSnapshot) || !('review' in intent.checkoutSnapshot)) return null;
  const review = (intent.checkoutSnapshot as JsonObject).review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const candidate = review as unknown as CheckoutReview;
  if (!intent.acceptedReviewHash || candidate.reviewHash !== intent.acceptedReviewHash
    || !['PACKAGE', 'BOOKING'].includes(candidate.kind)
    || !candidate.merchant || !candidate.purchaser || !candidate.item || !candidate.platform
    || !candidate.cancellation || !Array.isArray(candidate.policies)) return null;
  return candidate;
}

export function paymentReceiptNumber(paymentIntentId: string, issuedAt: Date) {
  const date = issuedAt.toISOString().slice(0, 10).replaceAll('-', '');
  const identity = createHash('sha256').update(`courtly-payment-receipt-v1:${paymentIntentId}`).digest('hex')
    .slice(0, 20).toUpperCase();
  return `RCT-${date}-${identity}`;
}

/**
 * Issue one immutable receipt in the same transaction as fulfillment. Older
 * checkout rows without accepted review evidence are deliberately not
 * upgraded into documents because Courtly cannot reconstruct what was shown.
 */
export async function issuePaymentReceipt(tx: Tx, input: {
  intent: {
    id: string; userId: string; businessId: string; kind: string; amount: number; currency: string;
    provider: string; checkoutSnapshot: Prisma.JsonValue | null; acceptedReviewHash: string | null;
  };
  paymentId: string;
  issuedAt: Date;
}) {
  if (!['PACKAGE', 'BOOKING'].includes(input.intent.kind)) return null;
  const review = acceptedReview(input.intent);
  if (!review) return null;
  const existing = await tx.paymentReceipt.findUnique({ where: { paymentIntentId: input.intent.id } });
  if (existing) return existing;
  const receipt = await tx.paymentReceipt.create({ data: {
    receiptNumber: paymentReceiptNumber(input.intent.id, input.issuedAt), documentVersion: 1,
    userId: input.intent.userId, businessId: input.intent.businessId,
    paymentIntentId: input.intent.id, paymentId: input.paymentId, kind: input.intent.kind,
    amount: input.intent.amount, currency: input.intent.currency, paymentProvider: input.intent.provider,
    checkoutReviewHash: review.reviewHash, merchantSnapshot: review.merchant as unknown as Prisma.InputJsonValue,
    purchaserSnapshot: review.purchaser as unknown as Prisma.InputJsonValue,
    itemSnapshot: review.item as unknown as Prisma.InputJsonValue,
    platformSnapshot: review.platform as unknown as Prisma.InputJsonValue,
    cancellationSnapshot: review.cancellation as unknown as Prisma.InputJsonValue,
    policiesSnapshot: review.policies as unknown as Prisma.InputJsonValue, issuedAt: input.issuedAt,
  } });
  if (input.intent.provider === 'STRIPE' && config.email.enabled) {
    await queueOutboundEmail(tx, {
      eventType: 'PAYMENT_RECEIPT', dedupeKey: `payment-receipt:${receipt.id}`,
      recipientEmail: review.purchaser.email, recipientName: review.purchaser.name,
      recipientUserId: input.intent.userId, businessId: input.intent.businessId,
      title: `Payment receipt ${receipt.receiptNumber}`,
      message: `Your ${review.merchant.tradingName} payment receipt for ${review.item.label} is ready. It records ${review.currency} ${(review.amount / 100).toFixed(2)} paid. It is not presented as a tax invoice.`,
      actionUrl: `${config.publicAppOrigin}/api/payments/receipts/${encodeURIComponent(receipt.id)}/document`,
      actionLabel: 'View payment receipt',
    });
  }
  return receipt;
}

export function receiptRefundState(receipt: ReceiptWithState) {
  const refundedAmount = receipt.paymentIntent.refunds
    .filter(refund => refund.status === 'SUCCEEDED')
    .reduce((total, refund) => total + refund.amount, 0);
  let refundStatus: ReceiptRefundStatus = 'NONE';
  if (refundedAmount >= receipt.amount || (receipt.payment.reversedAt && refundedAmount === 0)) refundStatus = 'REFUNDED';
  else if (refundedAmount > 0) refundStatus = 'PARTIALLY_REFUNDED';
  else if (receipt.paymentIntent.refunds.some(refund => refund.status === 'PENDING')) refundStatus = 'PENDING';
  else {
    const latest = [...receipt.paymentIntent.refunds].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (latest?.status === 'FAILED') refundStatus = 'FAILED';
    if (latest?.status === 'CANCELLED') refundStatus = 'CANCELLED';
  }
  return {
    paymentStatus: receipt.payment.reversedAt ? 'REVERSED' as const : 'PAID' as const,
    refundStatus, refundedAmount: Math.min(refundedAmount || (receipt.payment.reversedAt ? receipt.amount : 0), receipt.amount),
  };
}

export function paymentReceiptJson(receipt: ReceiptWithState) {
  return {
    id: receipt.id, receiptNumber: receipt.receiptNumber, documentVersion: receipt.documentVersion,
    kind: receipt.kind, amount: receipt.amount, currency: receipt.currency,
    paymentProvider: receipt.paymentProvider, providerReference: receipt.paymentIntent.providerReference,
    checkoutReviewHash: receipt.checkoutReviewHash,
    merchant: object(receipt.merchantSnapshot), purchaser: object(receipt.purchaserSnapshot),
    item: object(receipt.itemSnapshot), platform: object(receipt.platformSnapshot),
    cancellation: object(receipt.cancellationSnapshot),
    policies: Array.isArray(receipt.policiesSnapshot) ? receipt.policiesSnapshot : [],
    issuedAt: receipt.issuedAt.toISOString(), ...receiptRefundState(receipt),
  };
}

export const paymentReceiptRelations = receiptInclude;

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

function money(amount: number, currency: string) {
  try { return new Intl.NumberFormat('en-SG', { style: 'currency', currency }).format(amount / 100); }
  catch { return `${currency} ${(amount / 100).toFixed(2)}`; }
}

export function renderPaymentReceiptDocument(receipt: ReceiptWithState) {
  const value = paymentReceiptJson(receipt);
  const merchant = value.merchant;
  const purchaser = value.purchaser;
  const item = value.item;
  const gstStatus = merchant.gstRegistrationStatus === 'REGISTERED'
    ? `Declared GST-registered${merchant.gstRegistrationNumber ? ` · ${merchant.gstRegistrationNumber}` : ''}${merchant.pricesIncludeGst === true ? ' · displayed price declared GST-inclusive' : ''}`
    : merchant.gstRegistrationStatus === 'NOT_REGISTERED' ? 'Declared not GST-registered' : 'GST status not declared';
  const refund = value.refundStatus === 'NONE' ? 'No refund recorded'
    : `${String(value.refundStatus).replaceAll('_', ' ').toLowerCase()}${value.refundedAmount ? ` · ${money(value.refundedAmount, value.currency)}` : ''}`;
  const issued = new Intl.DateTimeFormat('en-SG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Singapore' })
    .format(new Date(value.issuedAt));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment receipt ${escapeHtml(value.receiptNumber)}</title><style>body{margin:0;background:#f4f6f1;color:#20382d;font:15px/1.55 Arial,sans-serif}.page{box-sizing:border-box;max-width:780px;margin:32px auto;padding:40px;background:#fff;border:1px solid #dfe7da;border-radius:16px}h1{margin:0;font-size:30px}h2{font-size:15px;margin:28px 0 8px}.muted{color:#59675c}.total{font-size:26px;font-weight:700;margin:12px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.row{padding:10px 0;border-bottom:1px solid #edf0e9}.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#59675c}.notice{margin-top:28px;padding:16px;background:#f0f4ec;border-radius:10px}.actions{max-width:780px;margin:20px auto}.actions a{display:inline-block;padding:10px 16px;border:1px solid #cfd8c9;border-radius:8px;color:#174c3c;text-decoration:none}@media(max-width:620px){.page{margin:0;border:0;border-radius:0;padding:24px}.grid{grid-template-columns:1fr}}@media print{body{background:#fff}.page{margin:0;max-width:none;border:0}.actions{display:none}}</style></head><body><div class="actions"><a href="?download=1">Download HTML</a></div><main class="page"><p class="muted">Courtly</p><h1>Payment receipt</h1><p><strong>${escapeHtml(value.receiptNumber)}</strong><br><span class="muted">Issued ${escapeHtml(issued)} SGT</span></p><p class="total">${escapeHtml(money(value.amount, value.currency))}</p><div class="grid"><section><h2>Merchant information shown at checkout</h2><div class="row"><span class="label">Trading name</span><br>${escapeHtml(merchant.tradingName)}</div><div class="row"><span class="label">Legal name supplied</span><br>${escapeHtml(merchant.legalName)}</div>${merchant.registrationNumber ? `<div class="row"><span class="label">Registration number supplied</span><br>${escapeHtml(merchant.registrationNumber)}</div>` : ''}<div class="row"><span class="label">Support</span><br>${escapeHtml(merchant.supportEmail)}<br>${escapeHtml(merchant.supportAddress)}</div><div class="row"><span class="label">GST declaration</span><br>${escapeHtml(gstStatus)}</div></section><section><h2>Payment</h2><div class="row"><span class="label">Purchaser</span><br>${escapeHtml(purchaser.name)}<br>${escapeHtml(purchaser.email)}</div><div class="row"><span class="label">Item</span><br>${escapeHtml(item.label)}</div><div class="row"><span class="label">Payment status</span><br>${escapeHtml(value.paymentStatus)}</div><div class="row"><span class="label">Refund status</span><br>${escapeHtml(refund)}</div></section></div><div class="notice"><strong>Receipt, not tax invoice.</strong> This document records payment processing facts and the merchant information presented and accepted at checkout. Courtly does not use it to decide or assert the contracting seller, supplier, payment recipient, refund owner, or GST supplier. Keep it with the checkout terms for your records.</div></main></body></html>`;
}
