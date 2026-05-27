import { Module } from '@nestjs/common';
import { PlansModule } from '../plans/plans.module.js';
import { TenantModule } from '../tenancy/tenant.module.js';
import { CollectionRecordsController } from './collection-records.controller.js';
import { CollectionRecordsService } from './collection-records.service.js';
import { CollectionsController } from './collections.controller.js';
import { CollectionsService } from './collections.service.js';
import { FieldDefinitionsController } from './field-definitions.controller.js';
import { FieldDefinitionsService } from './field-definitions.service.js';
import { QuotaService } from './quota.service.js';

/**
 * Schema customization — both layers in one module so they can share the
 * QuotaService and the dynamic validator without circular imports.
 *
 *   Layer 1: per-entity custom fields (book/member/loan/...)
 *   Layer 2: custom entity types ("collections") + their records
 */
@Module({
  imports: [TenantModule, PlansModule],
  providers: [QuotaService, FieldDefinitionsService, CollectionsService, CollectionRecordsService],
  controllers: [FieldDefinitionsController, CollectionsController, CollectionRecordsController],
  exports: [QuotaService, FieldDefinitionsService, CollectionsService, CollectionRecordsService],
})
export class CustomizationModule {}
