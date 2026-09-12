import { Module } from '@nestjs/common';
import { PolicyModule } from '../policy/policy.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { CashDrawerService } from './cash-drawer.service.js';
import { FeesController } from './fees.controller.js';
import { FeesService } from './fees.service.js';
import { OverdueAccrualService } from './overdue-accrual.service.js';
import { ReceiptsService } from './receipts.service.js';

/**
 * The fees ledger (2.0 phase 18).
 *
 * Its imports are the phase's dependency line — §6 says "_Depends on:_ 16" —
 * and they are deliberately thin:
 *
 *   `TenantModule` for `TenantPrismaService`.
 *   `PolicyModule` for `TenantClockService`. No `PolicySnapshotService`: the
 *                  amounts this module records are computed by whoever raises
 *                  the charge, and a ledger that resolved policy would be a
 *                  ledger with an opinion about what a fine should be.
 *
 * NOTHING FROM circulation, items OR holds, and that is the property worth
 * keeping. The dependency runs the other way: phase 21's checkin will call
 * `accrueWithin` from inside the return transaction. Importing circulation here
 * would close that loop into a cycle, and the cheap way to keep it open is for
 * the ledger to know nothing about what a loan is.
 */
@Module({
  imports: [TenantModule, PolicyModule],
  controllers: [FeesController],
  providers: [FeesService, CashDrawerService, ReceiptsService, OverdueAccrualService],
  exports: [FeesService, CashDrawerService, ReceiptsService, OverdueAccrualService],
})
export class FeesModule {}
