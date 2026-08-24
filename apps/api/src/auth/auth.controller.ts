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
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { AuthGuard } from './auth.guard.js';
import { CookieService } from './cookie.service.js';
import { LoginService } from './login.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { Sess } from './session-context.js';
import type { LibraryType } from '@libriant/shared';
import { SignupService } from './signup.service.js';
import { SignupDto } from './dto/signup.dto.js';
import { CompleteSetupDto, LoginDto } from './dto/login.dto.js';
import { PasswordResetCompleteDto, PasswordResetRequestDto } from './dto/password-reset.dto.js';
import { ChangeEmailDto, VerifyEmailDto } from './dto/email-verification.dto.js';
import type { SessionPayload } from './jwt-session.service.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { RedisService } from '../platform/redis.service.js';
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
 *
 * input-and-files-03: that left NOTHING that refuses a signup once the per-IP
 * key is defeated, and each accepted signup is a CREATE DATABASE plus a
 * migration fork. The backstop is {@link PROVISIONING} — a hard cap on how many
 * signups may be provisioning AT THE SAME MOMENT. It is a concurrency gate, not
 * a window counter, and that difference is the whole point: slots are released
 * ~1s later, so it bounds the damage a flood can do without being weaponisable
 * into a lasting outage the way a fixed-window global cap is. It cannot be
 * gated on an emailed verification link instead — EMAIL_DRIVER is `console`
 * and nothing is delivered, so that would refuse every real signup.
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
 * Provisioning admission control (input-and-files-03).
 *
 * `staleMs` is the self-heal: a process killed between acquire and release
 * would otherwise strand a slot forever, so an entry older than this is swept.
 * 120s is ~100x the real hold time, so a sweep can only ever free a slot that
 * is genuinely gone.
 */
const PROVISIONING = {
  key: 'signup:provisioning',
  maxConcurrent: provisioningCeiling(),
  staleMs: 120_000,
} as const;

/**
 * How many tenant databases may be under construction AT THE SAME MOMENT,
 * across every replica (the counter is a Redis sorted set, so it is global).
 *
 * This started at 4, reasoned from cost alone: provisioning measures ~1.1s of
 * DDL + migration, so 4 in flight is ~3 new libraries/second. What that
 * reasoning left out is that the number is also a HARD REFUSAL of genuine
 * customers, globally, with no per-IP component — and the launch campaign is
 * one email to 277 Greek libraries offering twelve free months to the first
 * five. Five people opening the form in the same second is the SUCCESS case,
 * and at 4 the fifth got "we're setting up several libraries right now".
 *
 * 16 is the ceiling now, and the reasoning has to hold from both sides:
 *   • as a limit on damage — the per-IP cap is 5 signups / 10 min, so filling
 *     16 concurrent slots takes at least four distinct source addresses acting
 *     within the same second, and holding it takes a sustained botnet rather
 *     than a laptop. The box (4 cores / 8 threads, 62 GiB) carries 16
 *     concurrent migration forks; they simply take longer each, which throttles
 *     the flood further by lengthening the hold time. This gate was never the
 *     only control — it is the backstop behind the per-IP cap.
 *   • as a limit on customers — 16 simultaneous genuine signups is triple the
 *     entire launch offer. If we ever refuse one, the log line below is the
 *     event to act on.
 *
 * Override with SIGNUP_MAX_CONCURRENT_PROVISIONING when the shape of a
 * campaign is known in advance. Read from process.env directly rather than
 * through loadEnv() for the same reason RateLimitService reads
 * RATE_LIMIT_DISABLED that way: this is an operational dial, not part of the
 * validated boot config, and a bad value must not stop the API from starting.
 */
function provisioningCeiling(): number {
  const raw = process.env.SIGNUP_MAX_CONCURRENT_PROVISIONING?.trim();
  if (!raw) return 16;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    // Don't throw: a typo in an operational dial must not take signup down.
    console.error(
      `[auth] SIGNUP_MAX_CONCURRENT_PROVISIONING="${raw}" is not a positive integer — using 16.`,
    );
    return 16;
  }
  return n;
}

/**
 * Claim one provisioning slot, atomically: sweep expired holders, refuse if the
 * cap is already reached, otherwise record this holder. Returns 1 on admission,
 * 0 when full. A sorted set (member = holder id, score = start time) rather than
 * a counter, because a counter that misses a decrement is a permanent capacity
 * loss, while a stale member sweeps itself.
 */
const ACQUIRE_PROVISIONING_SLOT_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`;

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
    @Inject(RedisService) private readonly redis: RedisService,
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
   * Take one of the {@link PROVISIONING} slots, or refuse.
   *
   * Returns the release function — the caller MUST call it in a `finally`,
   * otherwise the slot is held until the stale sweep reclaims it. Fails CLOSED
   * on a Redis error, matching the signup buckets in RateLimitService (REM-2):
   * an unmetered provisioning path during a Redis outage is exactly the DoS
   * this gate exists to close. What changed is WHAT WE SAY when it does —
   * see {@link provisioningUnavailable}.
   */
  private async enterProvisioningSlot(): Promise<() => Promise<void>> {
    // AUTH-07 parity with RateLimitService.hit(): the integration suite runs
    // many signups against a shared Redis and must not be gated, but a stray
    // RATE_LIMIT_DISABLED in a prod env file must never disable admission
    // control. (main.ts additionally refuses to boot in production with it
    // set, so this branch is unreachable there — belt and braces, because the
    // first version of this gate was simply absent from that escape hatch and
    // nobody noticed until a test suite deadlocked on it.)
    if (process.env.RATE_LIMIT_DISABLED === 'true' && process.env.NODE_ENV !== 'production') {
      return async () => undefined;
    }
    const holder = randomUUID();
    const now = Date.now();
    let admitted: number;
    try {
      admitted = (await this.redis.client.eval(
        ACQUIRE_PROVISIONING_SLOT_LUA,
        1,
        PROVISIONING.key,
        String(now),
        String(now - PROVISIONING.staleMs),
        String(PROVISIONING.maxConcurrent),
        holder,
        String(PROVISIONING.staleMs * 2),
      )) as number;
    } catch (err) {
      this.logger.error(
        `provisioning admission check failed (DENYING — signup fails closed): ${(err as Error).message}`,
      );
      throw this.provisioningUnavailable();
    }
    if (admitted !== 1) {
      // Not an error condition — this is the backstop doing its job. Logged at
      // warn so a sustained flood is visible without paging on a single burst.
      this.logger.warn(
        `Signup refused: ${PROVISIONING.maxConcurrent} tenant databases are already being ` +
          'provisioned. If this is not an attack, raise SIGNUP_MAX_CONCURRENT_PROVISIONING.',
      );
      throw this.provisioningBusy();
    }
    return async () => {
      await this.redis.client.zrem(PROVISIONING.key, holder).catch(() => undefined);
    };
  }

  /** Genuinely at capacity: {@link PROVISIONING.maxConcurrent} databases really
   *  are being built right now. This message is TRUE, and only this path may
   *  use it. */
  private provisioningBusy(): HttpException {
    return new HttpException(
      {
        message: "We're setting up several libraries right now. Please try again in a moment.",
        retryAfterSec: 30,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Redis is unreachable, so we cannot tell how many provisions are in flight
   * and refuse rather than run unmetered.
   *
   * A separate exception from {@link provisioningBusy} on purpose. Both used to
   * be the capacity message, which told a prospective customer — during a
   * campaign whose whole promise is "you are one of the first five" — that we
   * were busy with other libraries, when in reality a component of ours was
   * down. That is a lie in the one place we are asking for trust, and it also
   * mislabels an outage as demand: 429s look like traffic on a dashboard, so
   * the Redis failure would have hidden inside a graph that looked like
   * success.
   *
   * 503 is the honest status. HttpExceptionFilter re-skins 5xx into the generic
   * "something went wrong on our end … here is a support code" envelope, which
   * is exactly the right thing to say here — our fault, logged, retryable, with
   * a code the customer can quote — so the message below is what lands in the
   * server-side record rather than in the browser.
   */
  private provisioningUnavailable(): HttpException {
    return new HttpException(
      {
        message:
          'Sign-ups are temporarily unavailable: the service that meters new libraries is ' +
          'unreachable. Nothing was created. Please try again in a minute.',
        retryAfterSec: 60,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
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
      'Global signup rate exceeded the advisory ceiling — possible distributed signup abuse. ' +
        `Provisioning is capped at ${PROVISIONING.maxConcurrent} concurrent, so the cell is not ` +
        'at risk; this is the signal to look at who is signing up',
    );
    const dto = await validateDto(SignupDto, raw);
    // The hard backstop the per-IP bucket cannot be: a cap on how many tenant
    // databases may be under construction at once (input-and-files-03). Held
    // across the whole signup because CREATE DATABASE + the migration fork is
    // what we are rationing, and released in `finally` so a failed signup — a
    // duplicate slug, a provisioning error — hands its slot straight back.
    const releaseSlot = await this.enterProvisioningSlot();
    let result;
    try {
      // `@IsIn(LIBRARY_TYPES)` already validated libraryType; narrow the DTO's
      // `string` to the LibraryType union for the typed service input.
      result = await this.signupSvc.signup({
        ...dto,
        ip,
        libraryType: dto.libraryType as LibraryType,
      });
    } finally {
      await releaseSlot();
    }
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
