import { Module } from '@nestjs/common';
import { IdempotencyInterceptor } from '../platform/idempotency.interceptor.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { BibController } from './bib.controller.js';
import { BibWriteService } from './bib-write.service.js';
import { BibLockService } from './bib-lock.service.js';

/**
 * The MARC store.
 *
 * Mirrors FinesModule: the interceptor is a provider so the route decorator
 * resolves a DI-constructed instance (with RedisService injected) rather than a
 * standalone one that would silently fail to dedupe.
 *
 * Phase 11 adds the read/serialization surface here; phase 10b adds the record
 * lock. Both are additions to this module, not new ones — a record and the
 * things that guard it belong together.
 */
@Module({
  imports: [TenantModule],
  providers: [BibWriteService, BibLockService, IdempotencyInterceptor],
  controllers: [BibController],
  exports: [BibWriteService, BibLockService],
})
export class BibModule {}
