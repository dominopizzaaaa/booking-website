import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertStripeEventMode, constructStripeWebhookEvent, paymentProviderEventRecord, verifyStripeWebhookSignature,
} from '../src/payments/webhooks.js';
import { webhookClaimBlockReason } from '../src/payments/routes.js';

const secret = 'whsec_test_secret';
const timestamp = 1_790_553_600;
const now = new Date(timestamp * 1000);

function signature(body: Buffer | string, at = timestamp) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const digest = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${at}.`), bytes])).digest('hex');
  return `t=${at},v1=old${'0'.repeat(61)},v1=${digest}`;
}

describe('Stripe webhook verification', () => {
  it('verifies the exact raw bytes and builds the idempotent persistence record', () => {
    const body = Buffer.from(JSON.stringify({
      id: 'evt_123', type: 'payment_intent.succeeded', account: 'acct_club',
      created: timestamp - 10, livemode: true,
      data: { object: { id: 'pi_123', amount: 5_000 } },
    }));
    const event = constructStripeWebhookEvent({
      rawBody: body, signatureHeader: signature(body), webhookSecret: secret, now,
    });

    expect(event).toMatchObject({
      id: 'evt_123', type: 'payment_intent.succeeded', account: 'acct_club',
      createdAt: new Date((timestamp - 10) * 1000), livemode: true,
      dataObject: { id: 'pi_123', amount: 5_000 },
    });
    expect(event.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(paymentProviderEventRecord(event, 'business-1')).toEqual({
      businessId: 'business-1', provider: 'STRIPE',
      providerAccountReference: 'acct_club', providerEventId: 'evt_123',
      eventType: 'payment_intent.succeeded', payloadHash: event.payloadHash,
      providerCreatedAt: new Date((timestamp - 10) * 1000),
    });
  });

  it('rejects a signature for semantically equal but byte-different JSON', () => {
    const signed = '{"id":"evt_123","type":"x","data":{"object":{}}}';
    const changed = '{ "id": "evt_123", "type": "x", "data": {"object": {}} }';
    expect(() => verifyStripeWebhookSignature({
      rawBody: changed, signatureHeader: signature(signed), webhookSecret: secret, now,
    })).toThrowError(expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_INVALID', status: 400 }));
  });

  it('rejects expired signatures before parsing the payload', () => {
    const body = 'not-json';
    const stale = timestamp - 301;
    expect(() => constructStripeWebhookEvent({
      rawBody: body, signatureHeader: signature(body, stale), webhookSecret: secret, now,
    })).toThrowError(expect.objectContaining({ code: 'WEBHOOK_TIMESTAMP_INVALID', status: 400 }));
  });

  it('rejects a signed payload without the required Stripe event shape', () => {
    const body = JSON.stringify({ id: 'evt_123', type: 'payment_intent.succeeded', data: {} });
    expect(() => constructStripeWebhookEvent({
      rawBody: body, signatureHeader: signature(body), webhookSecret: secret, now,
    })).toThrowError(expect.objectContaining({ code: 'WEBHOOK_PAYLOAD_INVALID', status: 400 }));
  });

  it('rejects webhook events from the opposite Stripe mode', () => {
    expect(() => assertStripeEventMode({ livemode: true }, 'pk_test_example'))
      .toThrowError(expect.objectContaining({ code: 'WEBHOOK_MODE_MISMATCH', status: 400 }));
    expect(() => assertStripeEventMode({ livemode: false }, 'pk_live_example'))
      .toThrowError(expect.objectContaining({ code: 'WEBHOOK_MODE_MISMATCH', status: 400 }));
    expect(() => assertStripeEventMode({ livemode: true }, 'pk_live_example')).not.toThrow();
    expect(() => assertStripeEventMode({ livemode: false }, 'pk_test_example')).not.toThrow();
  });

  it('keeps unprocessed webhook deliveries retryable while leased or backing off', () => {
    const at = new Date('2026-09-28T10:00:00Z');
    expect(webhookClaimBlockReason({ availableAt: new Date(at.getTime() + 1), leasedUntil: null }, at)).toBe('BACKOFF');
    expect(webhookClaimBlockReason({ availableAt: at, leasedUntil: new Date(at.getTime() + 1) }, at)).toBe('LEASED');
    expect(webhookClaimBlockReason({ availableAt: at, leasedUntil: new Date(at.getTime() - 1) }, at)).toBeNull();
  });
});
