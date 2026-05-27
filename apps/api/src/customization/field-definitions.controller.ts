import {
  BadRequestException,
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
import { FieldEntityKind } from '@libriant/db-tenant';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { validateDto } from '../auth/validate-dto.js';
import { FieldDefinitionsService, type FieldDefinitionDto } from './field-definitions.service.js';
import { CreateFieldDefinitionDto, UpdateFieldDefinitionDto } from './field-definitions.dto.js';

/**
 * Library-admin endpoints for the data-model editor.
 *
 *   GET    /t/:slug/data-model/fields/:entityKind
 *   POST   /t/:slug/data-model/fields/:entityKind
 *   PATCH  /t/:slug/data-model/fields/:entityKind/:fieldKey
 *   DELETE /t/:slug/data-model/fields/:entityKind/:fieldKey   (= archive)
 *
 * All routes are TenantGuard-protected — same-tenant only. Role-based
 * access (only owners can edit the schema) lands with the user-role
 * polish in a later step; for now any authenticated tenant user can edit.
 */
@Controller('t/:slug/data-model/fields/:entityKind')
@UseGuards(TenantGuard)
export class FieldDefinitionsController {
  constructor(@Inject(FieldDefinitionsService) private readonly svc: FieldDefinitionsService) {}

  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Param('entityKind') entityKind: string,
  ): Promise<{ entityKind: FieldEntityKind; fields: FieldDefinitionDto[] }> {
    const ek = this.parseEntityKind(entityKind);
    const rows = await this.svc.listByEntityKind(tenant, ek);
    return { entityKind: ek, fields: rows };
  }

  @Post()
  async create(
    @TenantCtx() tenant: TenantContext,
    @Param('entityKind') entityKind: string,
    @Body() raw: unknown,
  ) {
    const ek = this.parseEntityKind(entityKind);
    const dto = await validateDto(CreateFieldDefinitionDto, raw);
    return this.svc.create(tenant, ek, {
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

  @Patch(':fieldKey')
  async update(
    @TenantCtx() tenant: TenantContext,
    @Param('entityKind') entityKind: string,
    @Param('fieldKey') fieldKey: string,
    @Body() raw: unknown,
  ) {
    const ek = this.parseEntityKind(entityKind);
    const dto = await validateDto(UpdateFieldDefinitionDto, raw);
    return this.svc.update(tenant, ek, fieldKey, {
      labelJson: dto.labelJson,
      required: dto.required,
      optionsJson: dto.optionsJson as never,
      validationJson: dto.validationJson as never,
      sortOrder: dto.sortOrder,
      indexed: dto.indexed,
      archived: dto.archived,
    });
  }

  @Delete(':fieldKey')
  async archive(
    @TenantCtx() tenant: TenantContext,
    @Param('entityKind') entityKind: string,
    @Param('fieldKey') fieldKey: string,
  ) {
    const ek = this.parseEntityKind(entityKind);
    return this.svc.archive(tenant, ek, fieldKey);
  }

  /** Validate the URL segment against the FieldEntityKind enum. */
  private parseEntityKind(raw: string): FieldEntityKind {
    const valid: FieldEntityKind[] = ['book', 'book_copy', 'member', 'loan', 'reservation', 'fine'];
    if ((valid as string[]).includes(raw)) return raw as FieldEntityKind;
    throw new BadRequestException(`Unknown entity "${raw}". Valid options: ${valid.join(', ')}.`);
  }
}
