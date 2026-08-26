import { Module } from '@nestjs/common';
import { RedisModule } from '../platform/redis.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/**
 * `GET /t/:slug/summary` — the tenant home page's counts (performance-11).
 *
 * Imported by LoansModule rather than listed in AppModule: the tiles this
 * exists to serve are dominated by circulation (active loans, overdue loans,
 * the hold queue), and the route it replaces was two `GET /t/:slug/loans` calls
 * per render. Nest registers the controller of any module reachable in the
 * graph, so the route is mounted either way; moving the import up to
 * AppModule's list is a one-line change if a later reader prefers it there.
 */
@Module({
  imports: [TenantModule, RedisModule],
  providers: [DashboardService],
  controllers: [DashboardController],
  exports: [DashboardService],
})
export class DashboardModule {}
