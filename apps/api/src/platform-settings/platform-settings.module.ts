import { Module } from '@nestjs/common';
import { PlatformSettingsService } from './platform-settings.service.js';

/**
 * Leaf module on purpose: it provides the runtime-settings service and
 * nothing else. RedisModule is `@Global`, so this needs zero imports — which
 * lets PlansModule, BillingModule, and AdminModule all import it without
 * creating a dependency cycle (AdminModule already imports PlansModule).
 */
@Module({
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
