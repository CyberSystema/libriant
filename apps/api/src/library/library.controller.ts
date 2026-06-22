import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles } from '../tenancy/roles.decorator.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantActor } from '../tenancy/tenant-actor.js';
import { validateDto } from '../auth/validate-dto.js';
import { LibraryProfileService } from './library-profile.service.js';
import { ProposeCoreEditDto, UpdateFreeProfileDto } from './library.dto.js';

/**
 * Tenant-facing library profile.
 *
 *   GET   /t/:slug/library                 — profile + any pending edit request
 *   PATCH /t/:slug/library                 — edit FREE fields directly
 *   GET   /t/:slug/library/requests        — this library's edit requests
 *   POST  /t/:slug/library/requests        — propose a CORE-field change (needs approval)
 *   POST  /t/:slug/library/requests/:id/cancel — cancel a pending request
 *
 * Gated to the tenant's owner/admin (view + edit). Librarians/volunteers don't
 * manage the library's official profile.
 */
@Controller('t/:slug/library')
@UseGuards(TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class LibraryController {
  constructor(@Inject(LibraryProfileService) private readonly svc: LibraryProfileService) {}

  @Get()
  async get(@TenantCtx() tenant: TenantContext) {
    return this.svc.getProfile(tenant.id);
  }

  @Patch()
  async updateFree(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(UpdateFreeProfileDto, raw);
    return this.svc.updateFreeFields(tenant.id, dto);
  }

  @Get('requests')
  async listRequests(@TenantCtx() tenant: TenantContext) {
    return { requests: await this.svc.listRequests(tenant.id) };
  }

  @Post('requests')
  @HttpCode(201)
  async submitRequest(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(ProposeCoreEditDto, raw);
    const request = await this.svc.submitEditRequest(tenant.id, actor.userId ?? actor.actorId, dto);
    return { request };
  }

  @Post('requests/:id/cancel')
  @HttpCode(200)
  async cancel(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.cancelRequest(tenant.id, id);
  }
}
