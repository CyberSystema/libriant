import { Global, Module, type Provider } from '@nestjs/common';
import { createEmailDriver } from './drivers/create-email-driver.js';
import { EmailService } from './email.service.js';

export const EMAIL_DRIVER = Symbol('EMAIL_DRIVER');

/**
 * Picks the right driver at boot from `EMAIL_DRIVER` (`console` | `smtp` |
 * `resend`). `console` works without network (dev default); the others open
 * their transport. Selection logic is shared with the worker via
 * `createEmailDriver`.
 *
 * @Global so callers (auth, support, announcements, …) can inject
 * `EmailService` without importing `EmailModule` everywhere.
 */
const driverProvider: Provider = {
  provide: EMAIL_DRIVER,
  useFactory: () => createEmailDriver(),
};

@Global()
@Module({
  providers: [driverProvider, EmailService],
  exports: [EmailService, EMAIL_DRIVER],
})
export class EmailModule {}
