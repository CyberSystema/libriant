import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { AuthGuard } from './auth.guard.js';
import { CookieService } from './cookie.service.js';
import { LoginService } from './login.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { Sess } from './session-context.js';
import { SignupService } from './signup.service.js';
import { SignupDto } from './dto/signup.dto.js';
import { CompleteSetupDto, LoginDto } from './dto/login.dto.js';
import { PasswordResetCompleteDto, PasswordResetRequestDto } from './dto/password-reset.dto.js';
import type { SessionPayload } from './jwt-session.service.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { validateDto } from './validate-dto.js';

/**
 * Platform-level auth endpoints (no tenant in the URL path).
 *
 *   POST /auth/signup           — create library + owner + start session
 *   POST /auth/login            — exchange (slug, email, pw) for session
 *   POST /auth/logout           — clear session cookie
 *   GET  /auth/me               — current user + tenant snapshot (requires session)
 *   POST /auth/password-reset/request   — stub: log a reset token
 *   POST /auth/password-reset/complete  — consume token, set new password
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CookieService) private readonly cookies: CookieService,
    @Inject(SignupService) private readonly signupSvc: SignupService,
    @Inject(LoginService) private readonly loginSvc: LoginService,
    @Inject(PasswordResetService) private readonly resetSvc: PasswordResetService,
    @Inject(TenantResolverService) private readonly tenantResolver: TenantResolverService,
  ) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(@Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const dto = await validateDto(SignupDto, raw);
    const result = await this.signupSvc.signup(dto);
    // Invalidate any negative cache entry for this slug so the next
    // /t/<slug>/... request hits the fresh row.
    await this.tenantResolver.invalidate({ slug: result.tenant.slug });
    this.cookies.setSession(res, result.token, result.expiresAt);
    return { tenant: result.tenant, user: result.user };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const dto = await validateDto(LoginDto, raw);
    const result = await this.loginSvc.login({
      tenantSlug: dto.slug,
      identifier: dto.identifier,
      password: dto.password,
    });
    this.cookies.setSession(res, result.token, result.expiresAt);
    return { tenant: result.tenant, user: result.user };
  }

  /**
   * First-login setup for admin-created staff: optionally set name + password,
   * then clear the forced-change flag. Requires a live session.
   */
  @Post('complete-setup')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthGuard)
  async completeSetup(@Sess() session: SessionPayload, @Body() raw: unknown) {
    const dto = await validateDto(CompleteSetupDto, raw);
    await this.loginSvc.completeSetup(session.sub, {
      fullName: dto.fullName,
      newPassword: dto.newPassword,
    });
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Res({ passthrough: true }) res: Response) {
    this.cookies.clearSession(res);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Sess() session: SessionPayload) {
    const [user, tenant] = await Promise.all([
      controlDb.user.findUnique({
        where: { id: session.sub },
        select: {
          id: true,
          email: true,
          username: true,
          fullName: true,
          role: true,
          locale: true,
          mustChangeCredentials: true,
        },
      }),
      controlDb.tenant.findUnique({
        where: { id: session.tid },
        select: { id: true, slug: true, name: true, defaultLocale: true, status: true },
      }),
    ]);
    if (!user || !tenant) {
      throw new NotFoundException('Session points at a record that no longer exists.');
    }
    return { user, tenant };
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async passwordResetRequest(@Body() raw: unknown) {
    const dto = await validateDto(PasswordResetRequestDto, raw);
    await this.resetSvc.request({ tenantSlug: dto.slug, email: dto.email });
    // Uniform response prevents email-enumeration.
    return { ok: true };
  }

  @Post('password-reset/complete')
  @HttpCode(HttpStatus.OK)
  async passwordResetComplete(@Body() raw: unknown) {
    const dto = await validateDto(PasswordResetCompleteDto, raw);
    const ok = await this.resetSvc.complete({ token: dto.token, newPassword: dto.newPassword });
    if (!ok) {
      // Surfaced as 410 Gone because the token is either consumed or expired.
      throw new NotFoundException('This reset link is invalid or has expired.');
    }
    return { ok: true };
  }
}
