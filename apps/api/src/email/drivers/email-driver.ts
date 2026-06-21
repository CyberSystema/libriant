/**
 * Driver interface every email backend implements.
 *
 *   ConsoleEmailDriver — logs the rendered envelope. Dev default; lets
 *                        the rest of the pipeline (outbox, queue, retry,
 *                        stats) run without network.
 *   SmtpEmailDriver    — nodemailer + `SMTP_URL`. Production path.
 *
 * Adding a Postmark / SES / Resend driver later is a single new class
 * implementing this interface plus a switch arm in `EmailModule`.
 */
export type SendInput = {
  to: string;
  from: string;
  replyTo: string | null;
  subject: string;
  bodyMarkdown: string;
  /**
   * A9-03: stable per-message key (the outbox row id). The outbox is at-least-
   * once — a crash between a successful provider send and the `delivered` DB
   * write makes the worker retry and re-send. A provider that honours this key
   * (Resend's `Idempotency-Key`) dedups that retry server-side. SMTP has no
   * portable dedup, so it stays at-least-once (documented in smtp-driver).
   */
  idempotencyKey?: string;
};

export type SendResult = {
  /** Provider-assigned identifier we can look up later (Message-ID, etc.). */
  providerId: string | null;
};

export interface EmailDriver {
  readonly name: 'console' | 'smtp' | 'resend';
  send(input: SendInput): Promise<SendResult>;
}
