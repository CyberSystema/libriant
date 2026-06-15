import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { loadEnv } from '../../config/env.js';
import type { EmailDriver, SendInput, SendResult } from './email-driver.js';

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
    const info = await this.transporter.sendMail({
      from: input.from,
      to: input.to,
      replyTo: input.replyTo ?? undefined,
      subject: input.subject,
      text: input.bodyMarkdown,
      html: markdownToBasicHtml(input.bodyMarkdown),
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

/**
 * Intentionally tiny markdown→HTML. We do double-newline → paragraph
 * and single-newline → <br>, plus auto-link bare URLs. This is enough
 * for the announcement / support-flow / password-reset templates we
 * actually send today.
 */
function markdownToBasicHtml(md: string): string {
  // Escape ALL five HTML-significant characters. Crucially this includes the
  // double quote: the auto-linker below drops the matched URL into an
  // href="..." attribute, so an unescaped quote in attacker-influenced text
  // (book title, member name, admin-authored template) would break out of the
  // attribute and inject markup (link/UI spoofing in a trusted email). Escaping
  // " → &quot; first means any quote inside a matched URL stays a literal.
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  const paragraphs = linked
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:540px;margin:0 auto;padding:24px">${paragraphs}</body></html>`;
}
