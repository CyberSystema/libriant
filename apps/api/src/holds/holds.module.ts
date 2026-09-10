import { Module } from '@nestjs/common';
import { ItemsModule } from '../items/items.module.js';
import { PatronsModule } from '../patrons/patrons.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { HoldArrivalModule } from './hold-arrival.module.js';
import { HoldShelfService } from './hold-shelf.service.js';
import { HoldsController } from './holds.controller.js';
import { HoldsService } from './holds.service.js';

/**
 * Holds 2.0 (2.0 phase 17).
 *
 * Its imports are the phase's dependency line made executable — §6 says
 * "_Depends on:_ 13, 15, 16", and this is those three:
 *
 *   `ItemsModule`   for `ItemStatusService` (a copy going onto the hold shelf is
 *                   a status change like any other, through the single writer)
 *                   and `ItemTransfersService.openWithin` (a copy wanted at
 *                   another branch goes in a van in the same transaction).
 *   `PatronsModule` for `PatronBlocksService.liveBlocksWithin`. A placement has
 *                   to see the blocks in the same transaction as the request it
 *                   is about to refuse — and calling the non-`Within` form from
 *                   inside a transaction self-deadlocks against the one-connection
 *                   tenant pool, which phase 16 paid for.
 *   `PolicyModule`  for `PolicySnapshotService` and `TenantClockService`.
 *
 * ## THE ONE THAT LOOKS REDUNDANT AND IS NOT
 *
 * `HoldArrivalModule` is imported here AND by `ItemsModule`, and that is the
 * whole point of it. `ItemsModule` cannot import THIS module — it would close a
 * cycle — so the one question items has to ask holds lives in a module that
 * imports nothing and both sides import it. Nest gives both the same singleton,
 * so `HoldShelfService` and `ItemTransfersService` shelve a copy through the
 * identical code.
 *
 * ## NOTHING IS EXPORTED YET
 *
 * The same position phase 16 took, for the same reason. Phase 22's notices,
 * phase 32's OPAC and phase 61's SIP2 will each want a way in, and the right
 * shape for that is a decision those phases can make with a caller in front of
 * them. An export added speculatively is a boundary nobody has tested.
 */
@Module({
  imports: [TenantModule, PolicyModule, ItemsModule, PatronsModule, HoldArrivalModule],
  providers: [HoldsService, HoldShelfService],
  controllers: [HoldsController],
})
export class HoldsModule {}
