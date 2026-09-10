import { Module } from '@nestjs/common';
import { HoldArrivalModule } from '../holds/hold-arrival.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { ItemStatusService } from './item-status.service.js';
import { ItemTransfersService } from './item-transfers.service.js';
import { ItemsController } from './items.controller.js';
import { ItemsService } from './items.service.js';

/**
 * Physical copies (2.0 phase 15).
 *
 * `PolicyModule` for `TenantClockService`: §6 phase 13 made it the seam through
 * which circulation reads the clock, and a status change is stamped with an
 * instant that has to come from the same place a due date does.
 *
 * `ItemStatusService` is exported because phase 16 has to move a copy inside the
 * transaction that writes the loan — a checkout whose status change committed
 * and whose loan did not is a copy nobody can find and nobody is charged for.
 * `ItemsService` is exported for `shelfAvailableAt`, which is phase 17's
 * hold-promotion probe, and `ItemTransfersService` for phase 17's routing and
 * phase 23's transit desk.
 *
 * `HoldArrivalModule` is phase 17's, and it is the ONE direction the items/holds
 * boundary runs. A transit desk scans a barcode and does not know whether the
 * copy in its hand is a hold arrival, a float or a repair return, so
 * `ItemTransfersService.receive` has to ask — and `HoldsModule` already imports
 * THIS module for `ItemStatusService`. A `forwardRef` would close the cycle and
 * hide it; a module that imports nothing, which both sides import, keeps the
 * dependency one method wide and visible.
 *
 * THE EXPORT IS THE BOUNDARY. `ItemStatusService` being the only exported way to
 * write `items.status` is what makes `check:item-status-writer` a rule about the
 * whole application rather than about this directory: a module that wants to
 * move a copy has to import this one, and importing it is visible.
 */
@Module({
  imports: [TenantModule, PolicyModule, HoldArrivalModule],
  providers: [ItemsService, ItemStatusService, ItemTransfersService],
  controllers: [ItemsController],
  exports: [ItemsService, ItemStatusService, ItemTransfersService],
})
export class ItemsModule {}
