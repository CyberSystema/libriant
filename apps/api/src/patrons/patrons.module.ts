import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { PatronBlocksService } from './patron-blocks.service.js';
import { PatronMergeService } from './patron-merge.service.js';
import { PatronsController } from './patrons.controller.js';
import { PatronsService } from './patrons.service.js';
import { PatronEraseService } from './patron-erase.service.js';
import { PatronAddressesService } from './patron-addresses.service.js';
import { PatronPhotoController } from './patron-photo.controller.js';
import { PatronSubjectAccessService } from '../privacy/patron-subject-access.service.js';
import { CustomizationModule } from '../customization/customization.module.js';
import { PlansModule } from '../plans/plans.module.js';

/**
 * The record side of a patron (2.0 phase 14).
 *
 * `PolicyModule` for `TenantClockService`: §6 phase 13 made it the seam through
 * which circulation reads the clock, and a patron number's year is a civil year
 * in the library's own zone rather than the pod's.
 *
 * `PatronBlocksService` is exported because phase 16's checkout has to see the
 * blocks in the same transaction as the loan it is about to refuse, and phase 22
 * has to notice one appearing. `PatronsService` is exported for the card scan,
 * which is the first statement of every circulation transaction.
 */
@Module({
  imports: [TenantModule, PolicyModule, StorageModule, CustomizationModule, PlansModule],
  providers: [
    PatronsService,
    PatronMergeService,
    PatronBlocksService,
    PatronEraseService,
    PatronSubjectAccessService,
    PatronAddressesService,
  ],
  controllers: [PatronsController, PatronPhotoController],
  exports: [PatronsService, PatronMergeService, PatronBlocksService, PatronEraseService],
})
export class PatronsModule {}
