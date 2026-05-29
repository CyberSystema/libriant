import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { EmailDriver, SendInput, SendResult } from './email-driver.js';

/**
 * Dev/test driver. Logs the envelope at info level so a developer can
 * see what would have gone out; never opens a socket. Returns a fake
 * provider id so the outbox row gets a `providerId` like the real
 * drivers do — keeps the read shape consistent across environments.
 */
@Injectable()
export class ConsoleEmailDriver implements EmailDriver {
  readonly name = 'console' as const;
  private readonly logger = new Logger('ConsoleEmailDriver');

  async send(input: SendInput): Promise<SendResult> {
    const providerId = `console-${randomBytes(8).toString('hex')}`;
    const preview = input.bodyMarkdown.split('\n').slice(0, 6).join(' ⏎ ');
    this.logger.log(
      `[email] ${providerId}\n  from: ${input.from}\n  to:   ${input.to}\n  subj: ${input.subject}\n  body: ${preview}${input.bodyMarkdown.length > 240 ? ' …' : ''}`,
    );
    return { providerId };
  }
}
