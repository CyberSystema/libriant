import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { loadEnv } from '../../config/env.js';
import type { EmailDriver, SendInput, SendResult } from './email-driver.js';
import { markdownToBasicHtml } from './markdown-html.js';

/**
 * Real SMTP driver via nodemailer. The transport is configured from
 * `SMTP_URL` (`smtp://user:pass@host:587`, `smtps://...`, etc.). The
 * driver verifies the transport at construction so a misconfigured host
 * fails at boot, not on the first user-triggered email.
 *
 * Body shape: we ship both `text` (plain) and `html` (rendered from the
 * stored markdown). Markdown rendering is intentionally minimal — paragraph
 * breaks + link unfurling — so we don't pay a `marked` dep for every email.
 * Rich formatting goes through a future template layer (out of MVP).
 */
@Injectable()
export class SmtpEmailDriver implements EmailDriver, OnModuleDestroy {
  readonly name = 'smtp' as const;
  private readonly logger = new Logger('SmtpEmailDriver');
  private readonly transporter: Transporter;

  constructor() {
    const env = loadEnv();
    if (!env.smtpUrl) {
      throw new Error('EMAIL_DRIVER=smtp requires SMTP_URL (e.g. smtp://user:pass@host:587).');
    }
    // Bounded timeouts so a hung/unreachable mail server can't stall an email
    // worker indefinitely (and block graceful shutdown). Without these,
    // nodemailer waits on the OS socket default (minutes).
    this.transporter = nodemailer.createTransport({
      url: env.smtpUrl,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    // Verify the transport in the background so boot stays fast. A
    // misconfigured server logs a clear error but doesn't block startup
    // — the queue will retry sends and the operator sees per-attempt
    // errors in the outbox table.
    this.transporter
      .verify()
      .then(() => this.logger.log(`SMTP transport verified against ${redactUrl(env.smtpUrl!)}`))
      .catch((err: Error) =>
        this.logger.error(`SMTP verify failed: ${err.message} — sends will retry.`),
      );
  }

  async send(input: SendInput): Promise<SendResult> {
    // A9-03: set a stable Message-ID from the outbox key so duplicate sends are
    // at least correlatable in mail logs / by dedup-aware MTAs. SMTP has no
    // portable server-side idempotency, so this path remains at-least-once: a
    // crash between a successful relay and the `delivered` DB write can re-send.
    // Prefer the Resend driver (Idempotency-Key) where exactly-once matters.
    const messageId = input.idempotencyKey
      ? `<${input.idempotencyKey}@${input.from.split('@').pop()?.replace(/>$/, '') ?? 'libriant'}>`
      : undefined;
    const info = await this.transporter.sendMail({
      from: input.from,
      to: input.to,
      replyTo: input.replyTo ?? undefined,
      subject: input.subject,
      text: input.bodyMarkdown,
      html: markdownToBasicHtml(input.bodyMarkdown),
      ...(messageId ? { messageId } : {}),
    });
    return { providerId: info.messageId ?? null };
  }

  async onModuleDestroy() {
    this.transporter.close();
  }
}

function redactUrl(u: string): string {
  return u.replace(/:[^:@/]+@/, ':***@');
}
