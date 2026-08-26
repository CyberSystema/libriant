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
  /**
   * privacy-legal-18: did this message actually leave the machine?
   *
   * This field exists because `email_outbox.status` used to be written from
   * "did `send()` throw?" alone, and the console driver does not throw — it
   * does nothing. So on the shipped configuration (`EMAIL_DRIVER=console`,
   * no mail provider) every overdue notice was stored as `delivered` with a
   * fabricated provider id. A librarian who checks whether the notice went out
   * — in `/admin/emails`, in a support call, in an HDPA file — was reading a
   * row that asserted a fact that never happened, about a patron who never got
   * the message and is now accruing a fine.
   *
   * REQUIRED, not optional-defaulting-to-true, on purpose: a driver that can
   * fail to deliver without throwing has to say so, and a new backend must not
   * be able to inherit "delivered" by forgetting a field.
   */
  delivered: boolean;
  /**
   * Why not, when `delivered` is false. Written verbatim to
   * `email_outbox.lastError`, so it is what an operator reads next to the row.
   */
  notDeliveredReason?: string;
};

export interface EmailDriver {
  readonly name: 'console' | 'smtp' | 'resend';
  send(input: SendInput): Promise<SendResult>;
}
