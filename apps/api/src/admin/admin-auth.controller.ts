import { Body, Controller, Get, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { validateDto } from '../auth/validate-dto.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminAuthGuard, AdminSess } from './admin-auth.guard.js';
import { AdminCookieService } from './admin-cookie.service.js';
import { AdminSessionService, type AdminSessionPayload } from './admin-session.service.js';

class AdminLoginDto {
  @IsEmail({}, { message: 'That email address looks wrong.' })
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}

/**
 *   POST /admin/auth/login   — exchange email + password for an admin cookie
 *   GET  /admin/auth/me      — current admin profile (behind AdminAuthGuard)
 *   POST /admin/auth/logout  — clear the admin cookie
 */
@Controller('admin/auth')
export class AdminAuthController {
  constructor(
    @Inject(AdminAuthService) private readonly authSvc: AdminAuthService,
    @Inject(AdminSessionService) private readonly jwt: AdminSessionService,
    @Inject(AdminCookieService) private readonly cookies: AdminCookieService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const dto = await validateDto(AdminLoginDto, raw);
    const admin = await this.authSvc.verify(dto.email.toLowerCase().trim(), dto.password);
    const { token, expiresAt } = this.jwt.sign({ sub: admin.id, role: admin.role });
    this.cookies.setSession(res, token, expiresAt);
    return {
      admin: { id: admin.id, email: admin.email, fullName: admin.fullName, role: admin.role },
      expiresAt: expiresAt.toISOString(),
    };
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  async me(@AdminSess() session: AdminSessionPayload) {
    const admin = await controlDb.adminUser.findUnique({
      where: { id: session.sub },
      select: { id: true, email: true, fullName: true, role: true, mfaEnabled: true },
    });
    return { admin };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    this.cookies.clearSession(res);
  }
}
