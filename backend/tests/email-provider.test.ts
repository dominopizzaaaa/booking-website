import { describe, expect, it, vi } from 'vitest';
import { CaptureEmailProvider, DisabledEmailProvider, EmailProviderError, ResendEmailProvider } from '../src/email-provider.js';

function message() {
  return { deliveryId: 'delivery-1', to: { email: 'student@example.test', name: 'Avery' }, from: { email: 'updates@courtly.test', name: 'Courtly' }, subject: 'Booking confirmed', text: 'Confirmed', html: '<p>Confirmed</p>' };
}

describe('email providers', () => {
  it('captures an immutable copy without network access', async () => {
    const provider = new CaptureEmailProvider();
    const email = message();
    const receipt = await provider.send(email);
    email.to.name = 'Changed';
    expect(provider.messages[0].to.name).toBe('Avery');
    expect(receipt.providerMessageId).toBe('capture_delivery-1');
  });

  it('reports disabled delivery as a permanent error', async () => {
    await expect(new DisabledEmailProvider().send(message())).rejects.toMatchObject({ code: 'EMAIL_DISABLED', transient: false });
  });

  it('sends Resend payloads with an idempotency key', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ id: 'resend-1' }), { status: 200 }));
    const receipt = await new ResendEmailProvider({ apiKey: 'secret', fetch: request }).send(message());
    expect(receipt.providerMessageId).toBe('resend-1');
    const init = request.mock.calls[0][1]!;
    expect(new Headers(init.headers).get('idempotency-key')).toBe('delivery-1');
    expect(JSON.parse(String(init.body))).toMatchObject({ to: ['Avery <student@example.test>'], subject: 'Booking confirmed' });
  });

  it('classifies retryable responses without retaining provider bodies', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('private provider detail', { status: 429, headers: { 'retry-after': '12' } }));
    await expect(new ResendEmailProvider({ apiKey: 'secret', fetch: request }).send(message())).rejects.toEqual(expect.objectContaining<Partial<EmailProviderError>>({ code: 'RESEND_HTTP_429', transient: true, retryAfterMs: 12_000 }));
  });
});
