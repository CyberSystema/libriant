import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { ConsentController } from './consent.controller.js';
import { ConsentService } from './consent.service.js';

/**
 * privacy-legal-09 — the legal-consent record, MOUNTED.
 *
 * Its own module rather than a couple of extra lines in `AuthModule` because
 * this change does not own `auth.module.ts` (another remediation is working in
 * the login/lockout path), and because a module is the smallest thing
 * `app.module.ts` can import: one line there is the entire wiring surface.
 *
 * The wiring is the point. The previous attempt at this finding shipped a
 * correct reader that no route reached, so the defect survived next to a file
 * that looked like the fix. If you are reviewing this and `ConsentModule` is
 * not in `AppModule.imports`, the finding is open again.
 */
@Module({
  imports: [TenantModule],
  providers: [ConsentService],
  controllers: [ConsentController],
  exports: [ConsentService],
})
export class ConsentModule {}
