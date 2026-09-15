import { Module } from '@nestjs/common';
import { TenantModule } from '../tenancy/tenant.module.js';
import { PlansModule } from '../plans/plans.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { IsbnController } from './isbn.controller.js';
import { IsbnLookupService } from './isbn.service.js';

/**
 * ISBN lookup, moved out of `catalog/` (2.0 phase 20h).
 *
 * ## Why this module exists at all
 *
 * It has NO schema dependency — not one query, in either datamodel. `lookup`
 * validates an ISBN's shape and asks OpenLibrary; the only state it touches is
 * a cache. It lived in `apps/api/src/catalog/` because that is where the screen
 * that uses it lives, and §6's cutover deletes that whole directory.
 *
 * So the route did not need porting to 2.0. It needed to stop being inside a
 * folder that is about to be removed — which is a different problem with a much
 * cheaper answer, and one worth separating from the three routes that genuinely
 * have no 2.0 equivalent.
 *
 * The path is UNCHANGED (`/t/:slug/catalog/isbn-lookup/:isbn`). It is the
 * catalogue's route by meaning, and moving the file must not move the URL: the
 * staff form, the permission key `cat.isbn.lookup` and the
 * `isbn_lookup_enabled` plan feature all name it as it is.
 */
@Module({
  imports: [TenantModule, PlansModule, AuthzModule],
  providers: [IsbnLookupService],
  controllers: [IsbnController],
  exports: [IsbnLookupService],
})
export class IsbnModule {}
