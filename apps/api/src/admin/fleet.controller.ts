import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { FleetService } from './fleet.service.js';

/**
 * Operator capacity view — admin-only, read-only.
 *
 *   GET /admin/fleet/overview
 *
 * Returns the tenant census (counts by status / plan / cell, total since
 * launch — not just active), per-tenant DB + storage sizes, and host
 * capacity signals (Postgres connections vs. max, cache hit ratio, Redis
 * memory, disk on the storage volume). Use it to decide when to tune,
 * relocate a heavy tenant, or scale the box.
 */
@Controller('admin/fleet')
@UseGuards(AdminAuthGuard)
export class FleetController {
  constructor(@Inject(FleetService) private readonly fleet: FleetService) {}

  @Get('overview')
  async overview() {
    return this.fleet.getOverview();
  }
}
