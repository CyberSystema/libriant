import { Module } from '@nestjs/common';
import { ItemsModule } from '../items/items.module.js';
import { PatronsModule } from '../patrons/patrons.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { CheckinService } from './checkin.service.js';
import { CheckoutService } from './checkout.service.js';
import { CirculationController } from './circulation.controller.js';
import { LoanReadService } from './loan-read.service.js';
import { RenewService } from './renew.service.js';

/**
 * The circulation desk (2.0 phase 16).
 *
 * Its imports are the phase's dependency line made executable — §6 says
 * "_Depends on:_ 14, 15" and this is those two, plus the policy engine of
 * phase 13 that both of them already lean on:
 *
 *   `ItemsModule`   for `ItemStatusService`. A checkout's status change and its
 *                   loan row MUST commit together, so circulation calls
 *                   `applyWithin(tx, …)` inside its own transaction rather than
 *                   the standalone `transition()`. That method exists because
 *                   this module needed it, and phase 15 exported it saying so.
 *   `PatronsModule` for `PatronBlocksService`. The desk has to see the blocks in
 *                   the same transaction as the loan it is about to refuse.
 *   `PolicyModule`  for `PolicySnapshotService` and `TenantClockService`. The
 *                   snapshot is served from a process cache and costs no
 *                   statement, which is what lets a checkout resolve policy on
 *                   the hot path at all.
 *
 * NOTHING IS EXPORTED, and that is deliberate for now. Phase 17's holds, phase
 * 21's declare-lost and phase 61's SIP2 will each want a way in, and the right
 * shape for that is a decision those phases can make with a caller in front of
 * them. An export added speculatively is a boundary nobody has tested.
 */
@Module({
  imports: [TenantModule, PolicyModule, ItemsModule, PatronsModule],
  providers: [CheckoutService, CheckinService, RenewService, LoanReadService],
  controllers: [CirculationController],
})
export class CirculationModule {}
