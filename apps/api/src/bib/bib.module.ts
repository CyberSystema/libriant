import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { IdempotencyInterceptor } from '../platform/idempotency.interceptor.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { BibController } from './bib.controller.js';
import { BibWriteService } from './bib-write.service.js';
import { BibLockService } from './bib-lock.service.js';
import { BibProjectionService } from './bib-projection.service.js';
import { BibReadService } from './bib-read.service.js';
import { BibIngestService } from './bib-ingest.service.js';
import { MarcBodyMiddleware } from './marc-body.middleware.js';

/**
 * The MARC store.
 *
 * Mirrors FinesModule: the interceptor is a provider so the route decorator
 * resolves a DI-constructed instance (with RedisService injected) rather than a
 * standalone one that would silently fail to dedupe.
 *
 * Phase 10b added the record lock, 11a the relational projection and 11b the
 * read, serialization and ingest surface. All are additions to this module, not
 * new ones — a record, the things that guard it, the projection derived from it
 * and the bytes it came from belong together.
 */
@Module({
  imports: [TenantModule],
  providers: [
    BibWriteService,
    BibLockService,
    BibProjectionService,
    BibReadService,
    BibIngestService,
    MarcBodyMiddleware,
    IdempotencyInterceptor,
  ],
  controllers: [BibController],
  exports: [BibWriteService, BibLockService, BibProjectionService, BibReadService],
})
export class BibModule implements NestModule {
  /**
   * The `application/marc` body reader, on the ingest path and nowhere else.
   *
   * Scoped to one path deliberately: a global raw reader would buffer every
   * unrecognised content type on every route in the application, which is a
   * memory profile nobody asked for. See {@link MarcBodyMiddleware} for why the
   * bootstrap's own parsers do not cover this.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(MarcBodyMiddleware).forRoutes('t/:slug/catalog/bib/ingest');
  }
}
