import { Body, Controller, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { PlatformSettingsService } from './platform-settings.service.js';
import { SetSubscriptionsEnabledDto } from './subscriptions.dto.js';

/**
 * Owner control plane for the master subscriptions switch.
 *
 *   GET  /admin/subscriptions          — current switch + how many libraries
 *                                        still owe a plan choice
 *   POST /admin/subscriptions          — flip the switch ({ enabled: bool })
 *
 * Flipping ON means every library without an explicit plan choice (including
 * brand-new signups) is sent through the full-page chooser before they can
 * use the app; flipping OFF makes the whole product free again.
 */
@Controller('admin/subscriptions')
@UseGuards(AdminAuthGuard)
export class AdminSubscriptionsController {
  constructor(
    @Inject(PlatformSettingsService) private readonly settings: PlatformSettingsService,
  ) {}

  @Get()
  async status() {
    return this.settings.subscriptionsStatus();
  }

  @Post()
  @HttpCode(200)
  async set(@AdminSess() admin: AdminSessionPayload, @Body() raw: unknown) {
    const dto = await validateDto(SetSubscriptionsEnabledDto, raw);
    const before = await this.settings.billingEnabled();
    await this.settings.setBillingEnabled(dto.enabled);
    if (before !== dto.enabled) {
      await controlDb.auditEvent.create({
        data: {
          tenantId: null, // platform-wide
          actorType: 'admin',
          actorId: admin.sub,
          action: 'subscriptions.toggled',
          targetType: 'platform_setting',
          targetId: 'billing.enabled',
          beforeJson: { enabled: before },
          afterJson: { enabled: dto.enabled },
        },
      });
    }
    return this.settings.subscriptionsStatus();
  }
}
