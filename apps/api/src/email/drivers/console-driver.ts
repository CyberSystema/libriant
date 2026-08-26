import { Injectable, Logger } from '@nestjs/common';
import type { EmailDriver, SendInput, SendResult } from './email-driver.js';

/**
 * Dev/test driver. Logs that a message was composed so a developer can see the
 * pipeline run; never opens a socket, and never delivers anything.
 *
 * A12-02: email bodies contain secrets — password-reset tokens, email-verify
 * links, support keys. Printing the body to stdout means it lands in the
 * container's logs (Docker/journald → shipped/retained). So OUTSIDE development
 * we log ONLY that the message exists, never the body. If this driver is left
 * on in production (no real mail provider configured yet) it no longer leaks
 * reset tokens into the logs.
 *
 * launch-readiness-01: withholding the body was right, but for a year it was
 * the whole answer, and "nothing is delivered AND nothing is readable" is a
 * dead end for the person on the phone. The body stays out of the log; what
 * changed is that there is now somewhere else to read it — the admin outbox
 * viewer (`/admin/emails`), which re-hydrates the one-time link from Redis for
 * an owner-level admin and writes an audit row for the read. The per-send line
 * below names it, because that line is what an operator greps when a librarian
 * says the mail never came.
 *
 * privacy-legal-18, two changes on top of that:
 *
 *  1. THE LOG LINE NO LONGER NAMES THE RECIPIENT OR THE SUBJECT. Withholding
 *     the body covered the reset tokens but not the notices: a member-notice
 *     subject is `Εκπρόθεσμο: «<book title>»` (member-notifications.job.ts),
 *     so `"${subject}" to ${to}` printed a named patron's e-mail address next
 *     to the book they have out — a borrowing record, into a log with no
 *     retention rule, on a deployment where by definition nothing was sent.
 *     The outbox row id is enough to find the message in `/admin/emails`, and
 *     it is not personal data.
 *
 *  2. IT REPORTS `delivered: false`. See SendResult — the worker used to write
 *     `status: 'delivered'` for every one of these.
 *
 * REPORTED NOT-DELIVERED IN DEVELOPMENT TOO, deliberately. Making the honesty
 * of a stored row depend on NODE_ENV would mean the same driver produced
 * `delivered` rows on a laptop and `failed` rows on the box, and every test
 * asserting on the pipeline would be asserting the laptop's answer. This
 * driver never delivers anything anywhere; the row says so everywhere.
 */
@Injectable()
export class ConsoleEmailDriver implements EmailDriver {
  readonly name = 'console' as const;
  private readonly logger = new Logger('ConsoleEmailDriver');
  private readonly isDev = (process.env.NODE_ENV ?? 'development') === 'development';

  /** Written to `email_outbox.lastError`, so it is what the operator reads. */
  static readonly NOT_DELIVERED_REASON =
    'EMAIL_DRIVER=console — this message was composed and stored but never sent to anyone. ' +
    'Read it at /admin/emails; set EMAIL_DRIVER=resend|smtp to actually deliver mail.';

  async send(input: SendInput): Promise<SendResult> {
    // The outbox row id (processOne always passes it). The fallback only fires
    // for a caller that bypasses the outbox, which nothing does today.
    const ref = input.idempotencyKey ?? '(no outbox id)';
    if (this.isDev) {
      const preview = input.bodyMarkdown.split('\n').slice(0, 6).join(' ⏎ ');
      this.logger.log(
        `[email] outbox ${ref} NOT DELIVERED (EMAIL_DRIVER=console)\n  to:   ${input.to}\n  subj: ${input.subject}\n  body: ${preview}${input.bodyMarkdown.length > 240 ? ' …' : ''}`,
      );
    } else {
      // Envelope withheld on purpose: the subject names a borrowed title and
      // `to` is the patron. Body withheld too (may carry a one-time link).
      this.logger.warn(
        `[email] outbox ${ref} — NOT DELIVERED (EMAIL_DRIVER=console), recorded as ` +
          `"failed", not "delivered". Recipient, subject and body are withheld from ` +
          `this log; read the message at /admin/emails (owner admin, audited). ` +
          `Set EMAIL_DRIVER=resend|smtp to actually send.`,
      );
    }
    // No fabricated provider id: there is no provider, and a synthetic
    // `console-<hex>` in that column was the second half of the row's false
    // claim — it made a stored message look looked-up-able at a vendor.
    return {
      providerId: null,
      delivered: false,
      notDeliveredReason: ConsoleEmailDriver.NOT_DELIVERED_REASON,
    };
  }
}
