export type EmailMessage = {
  deliveryId: string;
  to: { email: string; name?: string };
  from: { email: string; name: string };
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
};

export type EmailReceipt = { providerMessageId: string; acceptedAt: Date };

export interface EmailProvider {
  readonly kind: 'disabled' | 'capture' | 'resend';
  send(message: EmailMessage): Promise<EmailReceipt>;
}

export class EmailProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly transient: boolean,
    readonly retryAfterMs?: number,
  ) { super(message); }
}

export class DisabledEmailProvider implements EmailProvider {
  readonly kind = 'disabled' as const;
  async send(_message: EmailMessage): Promise<EmailReceipt> {
    throw new EmailProviderError('Transactional email is disabled', 'EMAIL_DISABLED', false);
  }
}

export class CaptureEmailProvider implements EmailProvider {
  readonly kind = 'capture' as const;
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<EmailReceipt> {
    this.messages.push(structuredClone(message));
    return { providerMessageId: `capture_${message.deliveryId}`, acceptedAt: new Date() };
  }
}

export type ResendEmailProviderOptions = {
  apiKey: string;
  fetch?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
};

function retryAfterMs(response: Response) {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export class ResendEmailProvider implements EmailProvider {
  readonly kind = 'resend' as const;
  private readonly request: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ResendEmailProviderOptions) {
    if (!options.apiKey.trim()) throw new Error('Resend API key is required');
    this.request = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? 'https://api.resend.com/emails';
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(message: EmailMessage): Promise<EmailReceipt> {
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.deliveryId,
        },
        body: JSON.stringify({
          from: `${message.from.name} <${message.from.email}>`,
          to: [message.to.name ? `${message.to.name} <${message.to.email}>` : message.to.email],
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          subject: message.subject, text: message.text, html: message.html,
          headers: { 'X-Courtly-Delivery-ID': message.deliveryId, ...(message.headers ?? {}) },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const code = error instanceof Error && error.name === 'TimeoutError' ? 'EMAIL_TIMEOUT' : 'EMAIL_NETWORK';
      throw new EmailProviderError('Email provider request failed', code, true);
    }
    if (!response.ok) {
      const transient = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      throw new EmailProviderError('Email provider rejected the request', `RESEND_HTTP_${response.status}`, transient, retryAfterMs(response));
    }
    const body = await response.json().catch(() => null) as { id?: unknown } | null;
    if (!body || typeof body.id !== 'string' || !body.id) {
      throw new EmailProviderError('Email provider returned an invalid response', 'RESEND_INVALID_RESPONSE', true);
    }
    return { providerMessageId: body.id, acceptedAt: new Date() };
  }
}

export function createEmailProvider(options: { mode: 'disabled' | 'capture' | 'resend'; apiKey?: string; fetch?: typeof fetch }) {
  if (options.mode === 'capture') return new CaptureEmailProvider();
  if (options.mode === 'resend') return new ResendEmailProvider({ apiKey: options.apiKey ?? '', fetch: options.fetch });
  return new DisabledEmailProvider();
}
