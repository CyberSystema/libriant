import { Global, Module, type Provider } from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { ConsoleEmailDriver } from './drivers/console-driver.js';
import { SmtpEmailDriver } from './drivers/smtp-driver.js';
import { EmailService } from './email.service.js';

export const EMAIL_DRIVER = Symbol('EMAIL_DRIVER');

/**
 * Picks the right driver at boot from `EMAIL_DRIVER`. `console` works
 * without network (dev default); `smtp` opens a nodemailer transport.
 *
 * @Global so callers (auth, support, announcements, …) can inject
 * `EmailService` without importing `EmailModule` everywhere.
 */
const driverProvider: Provider = {
  provide: EMAIL_DRIVER,
  useFactory: () => {
    const env = loadEnv();
    if (env.emailDriver === 'smtp') return new SmtpEmailDriver();
    return new ConsoleEmailDriver();
  },
};

@Global()
@Module({
  providers: [driverProvider, EmailService],
  exports: [EmailService, EMAIL_DRIVER],
})
export class EmailModule {}
