import { Logger } from '@nestjs/common';
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
  const env = loadEnv();
  switch (env.emailDriver) {
    case 'smtp':
      return new SmtpEmailDriver();
    case 'resend':
      return new ResendEmailDriver();
    default:
      announceUndeliveredMail(env.nodeEnv);
      return new ConsoleEmailDriver();
  }
}

/**
 * launch-readiness-01: say it at boot, in the log the operator actually reads.
 *
 * The console driver used to announce itself only per-send, at `warn`, in the
 * middle of ordinary traffic — so an operator could bring the platform up,
 * watch it come up clean, and not learn that no mail leaves the box until a
 * librarian phoned to say the reset link never arrived. This banner is the
 * thing a deploy is supposed to trip over.
 *
 * `error` level outside development on purpose: this IS an error in a
 * production deployment. It is a deliberate, documented one for the launch
 * (there is no Resend key), which is exactly why the message names the
 * supported way to work around it rather than only complaining.
 *
 * privacy-legal-18 asked for this to REFUSE TO BOOT outside development unless
 * an acknowledgement variable were set, the way scripts/backup.sh handles
 * BACKUP_ALLOW_LOCAL_ONLY. Rejected: the launch configuration IS
 * `EMAIL_DRIVER=console` with no Resend key, and no compose file sets such a
 * variable, so the refusal would stop the api and worker containers from
 * starting at all — turning "notices are not delivered" into "the library
 * cannot circulate a book". The banner plus the honest `failed` status is the
 * signal; the refusal is only correct once a real driver is the norm and
 * console is the accident. Reinstate it then, together with the compose change
 * that acknowledges it.
 */
function announceUndeliveredMail(nodeEnv: string): void {
  const logger = new Logger('EmailDriver');
  if (nodeEnv === 'development') {
    logger.log('EMAIL_DRIVER=console — mail is logged, not sent (development default).');
    return;
  }
  logger.error(
    [
      '',
      '  ┌───────────────────────────────────────────────────────────────────────┐',
      '  │  EMAIL IS NOT BEING DELIVERED.                                        │',
      '  └───────────────────────────────────────────────────────────────────────┘',
      `  EMAIL_DRIVER=console under NODE_ENV=${nodeEnv}. Every message is written to`,
      "  the email_outbox table with status='failed' and no provider id, because",
      '  NOTHING leaves this machine. No password reset, no e-mail verification,',
      '  no overdue notice, no support-access notification reaches anyone.',
      '',
      '  Bodies are NOT printed here — they carry one-time links. Read them in the',
      '  admin panel instead:  https://<ADMIN_HOST>/en/admin/emails',
      '  Recover an account without the link:  .../en/admin/account-recovery',
      '',
      '  To actually deliver mail, set EMAIL_DRIVER=resend + RESEND_API_KEY (or',
      '  EMAIL_DRIVER=smtp + SMTP_URL) and restart the api and worker services.',
      '',
    ].join('\n'),
  );
}
