import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { validateDto } from '../auth/validate-dto.js';
import { CollectionsService } from './collections.service.js';
import {
  CreateCollectionDto,
  CreateCollectionFieldDto,
  UpdateCollectionDto,
  UpdateCollectionFieldDto,
} from './collections.dto.js';

/**
 * Library-admin endpoints for custom collections (Layer 2 of the schema
 * customization story). Defines new entity types and their field
 * schemas. Records of those collections are CRUD'd elsewhere
 * (`/collections/:slug/records/...`).
 *
 *   GET    /t/:slug/data-model/collections
 *   POST   /t/:slug/data-model/collections
 *   GET    /t/:slug/data-model/collections/:cslug
 *   PATCH  /t/:slug/data-model/collections/:cslug
 *   DELETE /t/:slug/data-model/collections/:cslug                 (archive)
 *
 *   POST   /t/:slug/data-model/collections/:cslug/fields
 *   PATCH  /t/:slug/data-model/collections/:cslug/fields/:fkey
 *   DELETE /t/:slug/data-model/collections/:cslug/fields/:fkey    (archive)
 */
@Controller('t/:slug/data-model/collections')
@UseGuards(TenantGuard)
export class CollectionsController {
  constructor(@Inject(CollectionsService) private readonly svc: CollectionsService) {}

  @Get()
  async list(@TenantCtx() tenant: TenantContext) {
    return { collections: await this.svc.list(tenant) };
  }

  @Get(':cslug')
  async one(@TenantCtx() tenant: TenantContext, @Param('cslug') cslug: string) {
    return this.svc.getBySlug(tenant, cslug);
  }

  @Post()
  async create(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(CreateCollectionDto, raw);
    return this.svc.create(tenant, {
      slug: dto.slug,
      singularLabelJson: dto.singularLabelJson,
      pluralLabelJson: dto.pluralLabelJson,
      iconAssetRef: dto.iconAssetRef ?? null,
      sortOrder: dto.sortOrder,
    });
  }

  @Patch(':cslug')
  async update(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateCollectionDto, raw);
    return this.svc.update(tenant, cslug, {
      singularLabelJson: dto.singularLabelJson,
      pluralLabelJson: dto.pluralLabelJson,
      iconAssetRef: dto.iconAssetRef ?? null,
      sortOrder: dto.sortOrder,
      archived: dto.archived,
    });
  }

  @Delete(':cslug')
  async archive(@TenantCtx() tenant: TenantContext, @Param('cslug') cslug: string) {
    return this.svc.archive(tenant, cslug);
  }

  // -- Nested fields --------------------------------------------------------

  @Post(':cslug/fields')
  async addField(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateCollectionFieldDto, raw);
    return this.svc.createField(tenant, cslug, {
      fieldKey: dto.fieldKey,
      labelJson: dto.labelJson,
      type: dto.type,
      required: dto.required,
      optionsJson: (dto.optionsJson as never) ?? null,
      validationJson: (dto.validationJson as never) ?? null,
      sortOrder: dto.sortOrder,
      indexed: dto.indexed,
    });
  }

  @Patch(':cslug/fields/:fkey')
  async updateField(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Param('fkey') fkey: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateCollectionFieldDto, raw);
    return this.svc.updateField(tenant, cslug, fkey, {
      labelJson: dto.labelJson,
      required: dto.required,
      optionsJson: dto.optionsJson as never,
      validationJson: dto.validationJson as never,
      sortOrder: dto.sortOrder,
      indexed: dto.indexed,
      archived: dto.archived,
    });
  }

  @Delete(':cslug/fields/:fkey')
  async archiveField(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Param('fkey') fkey: string,
  ) {
    return this.svc.archiveField(tenant, cslug, fkey);
  }
}
