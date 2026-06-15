import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { validateDto } from '../auth/validate-dto.js';
import { clientIp } from '../platform/client-ip.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { MfaService } from '../support/mfa.service.js';
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

  /** Required only when the admin has MFA enabled (two-step login). */
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Authenticator codes are 6 digits.' })
  totp?: string;
}

/**
 *   POST /admin/auth/login   — exchange email + password (+ TOTP if enabled) for a cookie
 *   GET  /admin/auth/me      — current admin profile (behind AdminAuthGuard)
 *   POST /admin/auth/logout  — clear the admin cookie
 *
 * MFA gate: if the admin has `mfaEnabled`, the password alone is NOT enough —
 * a valid, single-use TOTP is required. A first attempt without a code returns
 * 401 `{ code: 'mfa_required' }` so the UI can prompt for it; a wrong code
 * returns 401 `{ code: 'mfa_invalid' }`.
 */
@Controller('admin/auth')
export class AdminAuthController {
  private static readonly LOGIN_PER_IP = { limit: 20, windowSec: 300 };

  constructor(
    @Inject(AdminAuthService) private readonly authSvc: AdminAuthService,
    @Inject(AdminSessionService) private readonly jwt: AdminSessionService,
    @Inject(AdminCookieService) private readonly cookies: AdminCookieService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = clientIp(req) ?? 'unknown';
    const rl = await this.rateLimit.hit(
      `admin-login:ip:${ip}`,
      AdminAuthController.LOGIN_PER_IP.limit,
      AdminAuthController.LOGIN_PER_IP.windowSec,
    );
    if (!rl.allowed) {
      throw new HttpException(
        { message: 'Too many sign-in attempts. Please wait a few minutes and try again.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const dto = await validateDto(AdminLoginDto, raw);
    const admin = await this.authSvc.verify(dto.email.toLowerCase().trim(), dto.password);

    // MFA gate: a password alone must not yield the control plane.
    const mfa = await controlDb.adminUser.findUnique({
      where: { id: admin.id },
      select: { mfaEnabled: true, mfaSecretCipher: true, mfaNonce: true },
    });
    if (mfa?.mfaEnabled) {
      if (!dto.totp) {
        // Incomplete login — leave the lockout counter untouched (neither
        // reset nor incremented) until a code is supplied.
        throw new UnauthorizedException({
          code: 'mfa_required',
          message: 'Enter the code from your authenticator app.',
        });
      }
      const secret = this.mfa.decrypt(mfa.mfaSecretCipher, mfa.mfaNonce);
      if (!(await this.mfa.verifyTokenOnce(admin.id, secret, dto.totp))) {
        // A wrong second factor is a failed attempt and can trip the lockout
        // (ADM-5) — otherwise a known password makes TOTP brute force free.
        await this.authSvc.recordFailure(admin.id);
        throw new UnauthorizedException({
          code: 'mfa_invalid',
          message: 'That authenticator code is wrong or has already been used.',
        });
      }
    }

    // Full login succeeded (password AND, if enabled, TOTP) → clear counters.
    await this.authSvc.recordSuccess(admin.id);
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
