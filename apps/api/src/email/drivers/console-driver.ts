import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { EmailDriver, SendInput, SendResult } from './email-driver.js';

/**
 * Dev/test driver. Logs the envelope so a developer can see what would have
 * gone out; never opens a socket. Returns a fake provider id so the outbox row
 * gets a `providerId` like the real drivers do.
 *
 * A12-02: email bodies contain secrets — password-reset tokens, email-verify
 * links, support keys. Printing the body to stdout means it lands in the
 * container's logs (Docker/journald → shipped/retained). So OUTSIDE development
 * we log ONLY the envelope metadata (to/subject/kind), never the body. If this
 * driver is left on in production (no real mail provider configured yet) it no
 * longer leaks reset tokens into the logs.
 *
 * launch-readiness-01: withholding the body was right, but for a year it was
 * the whole answer, and "nothing is delivered AND nothing is readable" is a
 * dead end for the person on the phone. The body stays out of the log; what
 * changed is that there is now somewhere else to read it — the admin outbox
 * viewer (`/admin/emails`), which re-hydrates the one-time link from Redis for
 * an owner-level admin and writes an audit row for the read. The per-send line
 * below names it, because that line is what an operator greps when a librarian
 * says the mail never came.
 */
@Injectable()
export class ConsoleEmailDriver implements EmailDriver {
  readonly name = 'console' as const;
  private readonly logger = new Logger('ConsoleEmailDriver');
  private readonly isDev = (process.env.NODE_ENV ?? 'development') === 'development';

  async send(input: SendInput): Promise<SendResult> {
    const providerId = `console-${randomBytes(8).toString('hex')}`;
    if (this.isDev) {
      const preview = input.bodyMarkdown.split('\n').slice(0, 6).join(' ⏎ ');
      this.logger.log(
        `[email] ${providerId}\n  from: ${input.from}\n  to:   ${input.to}\n  subj: ${input.subject}\n  body: ${preview}${input.bodyMarkdown.length > 240 ? ' …' : ''}`,
      );
    } else {
      // Body withheld on purpose (may contain reset tokens / verify links).
      this.logger.warn(
        `[email] ${providerId} — NOT DELIVERED (EMAIL_DRIVER=console): ` +
          `"${input.subject}" to ${input.to}. The body is withheld from this log because it ` +
          `may carry a one-time link; read it at /admin/emails (owner admin, audited). ` +
          `Set EMAIL_DRIVER=resend|smtp to actually send.`,
      );
    }
    return { providerId };
  }
}
