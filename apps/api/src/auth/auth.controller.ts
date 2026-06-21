import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { AuthGuard } from './auth.guard.js';
import { CookieService } from './cookie.service.js';
import { LoginService } from './login.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { Sess } from './session-context.js';
import { SignupService } from './signup.service.js';
import { SignupDto } from './dto/signup.dto.js';
import { CompleteSetupDto, LoginDto } from './dto/login.dto.js';
import { PasswordResetCompleteDto, PasswordResetRequestDto } from './dto/password-reset.dto.js';
import { ChangeEmailDto, VerifyEmailDto } from './dto/email-verification.dto.js';
import type { SessionPayload } from './jwt-session.service.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { clientIp } from '../platform/client-ip.js';
import { validateDto } from './validate-dto.js';

/**
 * Rate-limit budgets for the unauthenticated edge. Tuned to be invisible to
 * humans but to bound automated abuse:
 *   - signup provisions a Postgres DB + forks a migration, so it is the most
 *     expensive; cap it HARD per-IP so a single host can't flood the cell.
 *   - login is cheap per request but bcrypt-amplified; cap per-IP on top of
 *     the existing per-account lockout to stop horizontal credential stuffing.
 *   - password-reset sends email; cap per-IP to stop email bombing.
 *
 * AUTH-05: the signup-global bucket is ADVISORY, not a hard reject. A blunt
 * global hard cap was itself a cheap platform-wide signup blackout — a modest
 * IP pool, each under the per-IP cap, could collectively trip the global ceiling
 * and deny ALL new-customer signups at near-zero cost. We still count it and
 * page loudly when it's exceeded (the operator's signal to bring up real
 * provisioning-side admission control), but we never refuse a signup solely on
 * the global counter, so the cap can't be weaponised into an onboarding outage.
 */
const RL = {
  signupPerIp: { limit: 5, windowSec: 600 }, // 5 / 10 min / IP (hard)
  signupGlobal: { limit: 60, windowSec: 600 }, // 60 / 10 min total (advisory alarm)
  loginPerIp: { limit: 20, windowSec: 300 }, // 20 / 5 min / IP
  resetPerIp: { limit: 5, windowSec: 900 }, // 5 / 15 min / IP
  // Email-sending, session-backed paths — modest per-IP cap on top of the
  // per-account cap inside EmailVerificationService.
  emailVerifyPerIp: { limit: 10, windowSec: 900 }, // 10 / 15 min / IP
} as const;

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
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(CookieService) private readonly cookies: CookieService,
    @Inject(SignupService) private readonly signupSvc: SignupService,
    @Inject(LoginService) private readonly loginSvc: LoginService,
    @Inject(PasswordResetService) private readonly resetSvc: PasswordResetService,
    @Inject(EmailVerificationService) private readonly emailVerify: EmailVerificationService,
    @Inject(TenantResolverService) private readonly tenantResolver: TenantResolverService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  /** Throw 429 if any of the supplied buckets is over budget. */
  private async throttle(
    buckets: Array<{ key: string; limit: number; windowSec: number }>,
    message: string,
  ): Promise<void> {
    for (const b of buckets) {
      const r = await this.rateLimit.hit(b.key, b.limit, b.windowSec);
      if (!r.allowed) {
        throw new HttpException(
          { message, retryAfterSec: r.retryAfterSec },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /**
   * AUTH-05: count a bucket for observability WITHOUT ever rejecting on it.
   * Used for the global signup ceiling — going over it pages the operator (so
   * real provisioning-side admission control can kick in) but does not block
   * signups, since a hard global reject is itself a trivial platform-wide DoS
   * lever. Never throws (a Redis blip here must not affect the signup path).
   */
  private async alarmIfOverBudget(
    bucket: { key: string; limit: number; windowSec: number },
    onTrip: string,
  ): Promise<void> {
    try {
      const r = await this.rateLimit.hit(bucket.key, bucket.limit, bucket.windowSec);
      if (!r.allowed) {
        this.logger.error(`${onTrip} (count=${r.count}, limit=${bucket.limit}).`);
      }
    } catch {
      // Advisory only — swallow so the global counter can never affect signups.
    }
  }

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  async signup(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = clientIp(req) ?? 'unknown';
    // Per-IP is the HARD cap. The global bucket is advisory only (AUTH-05) — a
    // hard global reject would let a modest IP pool blackout all signups.
    await this.throttle(
      [{ key: `signup:ip:${ip}`, ...RL.signupPerIp }],
      'Too many sign-up attempts. Please wait a few minutes and try again.',
    );
    await this.alarmIfOverBudget(
      { key: 'signup:global', ...RL.signupGlobal },
      'Global signup rate exceeded the advisory ceiling — possible distributed signup abuse; ' +
        'engage provisioning-side admission control',
    );
    const dto = await validateDto(SignupDto, raw);
    const result = await this.signupSvc.signup(dto);
    // Invalidate any negative cache entry for this slug so the next
    // /t/<slug>/... request hits the fresh row.
    await this.tenantResolver.invalidate({ slug: result.tenant.slug });
    this.cookies.setSession(res, result.token, result.expiresAt, result.remember);
    return { tenant: result.tenant, user: result.user };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = clientIp(req) ?? 'unknown';
    await this.throttle(
      [{ key: `login:ip:${ip}`, ...RL.loginPerIp }],
      'Too many sign-in attempts from your network. Please wait a few minutes and try again.',
    );
    const dto = await validateDto(LoginDto, raw);
    const result = await this.loginSvc.login({
      tenantSlug: dto.slug,
      identifier: dto.identifier,
      password: dto.password,
      remember: dto.remember,
      ip, // A1-01: per-(account+IP) lockout
    });
    this.cookies.setSession(res, result.token, result.expiresAt, result.remember);
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
          emailVerifiedAt: true,
        },
      }),
      controlDb.tenant.findUnique({
        where: { id: session.tid },
        select: {
          id: true,
          slug: true,
          name: true,
          defaultLocale: true,
          status: true,
          brandColor: true,
          brandLogoRef: true,
        },
      }),
    ]);
    if (!user || !tenant) {
      throw new NotFoundException('Session points at a record that no longer exists.');
    }
    // Surface verification state (not the timestamp) so the web can show the
    // "verify your email" banner. Staff (no email) are never "unverified".
    const { emailVerifiedAt, ...userPublic } = user;
    return {
      user: { ...userPublic, emailVerified: !user.email || emailVerifiedAt != null },
      tenant,
    };
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async passwordResetRequest(@Body() raw: unknown, @Req() req: Request) {
    const ip = clientIp(req) ?? 'unknown';
    await this.throttle(
      [{ key: `pwreset:ip:${ip}`, ...RL.resetPerIp }],
      'Too many password-reset requests. Please wait a few minutes and try again.',
    );
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

  /**
   * Consume an email-verification token (from the signup/change link). Public —
   * the token itself is the credential. Returns the mode + library slug so the
   * web can route the user back into their library.
   */
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() raw: unknown, @Req() req: Request) {
    const ip = clientIp(req) ?? 'unknown';
    await this.throttle(
      [{ key: `emailverify:ip:${ip}`, ...RL.emailVerifyPerIp }],
      'Too many verification attempts. Please wait a few minutes and try again.',
    );
    const dto = await validateDto(VerifyEmailDto, raw);
    const result = await this.emailVerify.verify(dto.token);
    if (!result.ok) {
      throw new NotFoundException('This verification link is invalid or has expired.');
    }
    return { ok: true, mode: result.mode, slug: result.slug };
  }

  /** Re-send the verification email to the signed-in user's current address. */
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthGuard)
  async resendVerification(@Sess() session: SessionPayload, @Req() req: Request) {
    const ip = clientIp(req) ?? 'unknown';
    await this.throttle(
      [{ key: `emailverify:ip:${ip}`, ...RL.emailVerifyPerIp }],
      'Too many verification requests. Please wait a few minutes and try again.',
    );
    await this.emailVerify.resend(session.sub);
    // Uniform response regardless of state (no account-state oracle).
    return { ok: true };
  }

  /**
   * Stage an email-address change: sends a verification link to the NEW address.
   * The account email only changes once that link is confirmed.
   */
  @Post('change-email')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AuthGuard)
  async changeEmail(@Sess() session: SessionPayload, @Body() raw: unknown, @Req() req: Request) {
    const ip = clientIp(req) ?? 'unknown';
    await this.throttle(
      [{ key: `emailverify:ip:${ip}`, ...RL.emailVerifyPerIp }],
      'Too many requests. Please wait a few minutes and try again.',
    );
    const dto = await validateDto(ChangeEmailDto, raw);
    await this.emailVerify.requestEmailChange(session.sub, dto.newEmail);
    return { ok: true };
  }
}
