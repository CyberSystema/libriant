import { loadEnv } from '../../config/env.js';
import { ConsoleEmailDriver } from './console-driver.js';
import type { EmailDriver } from './email-driver.js';
import { ResendEmailDriver } from './resend-driver.js';
import { SmtpEmailDriver } from './smtp-driver.js';

/**
 * Resolve the email driver from `EMAIL_DRIVER` at boot. Shared by the API
 * process (EmailModule provider) and the worker process (email-worker) so the
 * selection lives in exactly one place — adding a backend means one new arm
 * here, not two. `console` needs no network (dev default); `smtp`/`resend`
 * open their respective transports and fail fast on missing config.
 */
export function createEmailDriver(): EmailDriver {
  switch (loadEnv().emailDriver) {
    case 'smtp':
      return new SmtpEmailDriver();
    case 'resend':
      return new ResendEmailDriver();
    default:
      return new ConsoleEmailDriver();
  }
}
