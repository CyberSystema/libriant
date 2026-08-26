import { Injectable, Logger } from '@nestjs/common';
import { loadEnv } from '../../config/env.js';
import type { EmailDriver, SendInput, SendResult } from './email-driver.js';
import { markdownToBasicHtml } from './markdown-html.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Bound the HTTP call so a hung Resend edge can't stall the email worker. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * Resend driver — posts to the Resend HTTP API (https://resend.com). Chosen
 * over the SMTP relay when you want the provider's message id stored on the
 * outbox row and clearer per-send errors.
 *
 * Dependency-free on purpose: a plain `fetch` keeps the supply-chain surface
 * small (no SDK). The sender domain must be VERIFIED in Resend and match
 * `EMAIL_FROM`, or the API rejects the send.
 *
 * Failures throw; the email worker records the error on the outbox row and
 * retries per `maxAttempts` (the durable outbox is the source of truth).
 */
@Injectable()
export class ResendEmailDriver implements EmailDriver {
  readonly name = 'resend' as const;
  private readonly logger = new Logger('ResendEmailDriver');
  private readonly apiKey: string;

  constructor() {
    const env = loadEnv();
    if (!env.resendApiKey) {
      throw new Error('EMAIL_DRIVER=resend requires RESEND_API_KEY (re_...).');
    }
    this.apiKey = env.resendApiKey;
  }

  async send(input: SendInput): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // A9-03: dedup a retry whose prior send succeeded but whose DB write
          // didn't. Resend honours `Idempotency-Key`; the outbox row id is
          // stable across retries of the same message.
          ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: input.from,
          to: input.to,
          subject: input.subject,
          text: input.bodyMarkdown,
          html: markdownToBasicHtml(input.bodyMarkdown),
          // Resend's REST API expects snake_case `reply_to` (the JS SDK uses
          // camelCase — we're on raw fetch). Omit when there's no reply-to.
          ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error / timeout — surface for the outbox retry. The API key is
      // only ever in the request header, never in this message.
      throw new Error(`Resend request failed: ${(err as Error).message}`, { cause: err });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend send failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    // privacy-legal-18: Resend returned 2xx with an id, so the message is
    // handed off. `delivered` means "it left this machine", not "it reached
    // the inbox" — a later bounce arrives by webhook, not from this call.
    return { providerId: json.id ?? null, delivered: true };
  }
}
