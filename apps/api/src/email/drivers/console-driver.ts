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
        `[email] ${providerId} — console driver in a non-dev environment: NOT delivering ` +
          `"${input.subject}" to ${input.to} (body withheld). Configure EMAIL_DRIVER=resend|smtp to actually send.`,
      );
    }
    return { providerId };
  }
}
