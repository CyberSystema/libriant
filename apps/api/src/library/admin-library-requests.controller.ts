import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { adminAuditActor } from '../platform/admin-audit.js';
import { validateDto } from '../auth/validate-dto.js';
import { LibraryProfileService } from './library-profile.service.js';
import { DecisionDto } from './library.dto.js';

/**
 * Platform owner-admin review of tenant library-profile change requests.
 *
 *   GET  /admin/library-requests?status=pending  — list (reads open to any admin)
 *   GET  /admin/library-requests/:id             — one request (current vs proposed)
 *   POST /admin/library-requests/:id/approve     — apply the change (owner only)
 *   POST /admin/library-requests/:id/reject      — reject the change (owner only)
 */
@Controller('admin/library-requests')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminLibraryRequestsController {
  constructor(@Inject(LibraryProfileService) private readonly svc: LibraryProfileService) {}

  @Get()
  async list(@Query('status') status?: string) {
    return { requests: await this.svc.listAllRequests(status) };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return { request: await this.svc.getRequest(id) };
  }

  @Post(':id/approve')
  @AdminRoles('owner')
  @HttpCode(200)
  async approve(
    @Param('id') id: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(DecisionDto, raw ?? {});
    return { request: await this.svc.approve(id, adminAuditActor(req, admin), dto.decisionNote) };
  }

  @Post(':id/reject')
  @AdminRoles('owner')
  @HttpCode(200)
  async reject(
    @Param('id') id: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(DecisionDto, raw ?? {});
    return { request: await this.svc.reject(id, adminAuditActor(req, admin), dto.decisionNote) };
  }
}
