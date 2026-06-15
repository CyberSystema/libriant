import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { controlDb } from '@libriant/db-control';
import type { Request, Response } from 'express';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { clientIp } from '../platform/client-ip.js';
import { ImpersonationCookieService } from './impersonation-cookie.service.js';
import { ImpersonationSessionService } from './impersonation-session.service.js';
import { MfaService } from './mfa.service.js';
import { SupportKeyService } from './support-key.service.js';
import { SupportNotificationsService } from './support-notifications.service.js';
import { SupportSessionService } from './support-session.service.js';
import { evaluateRedeemRateLimit } from './support-rate-limit.js';

class RedeemDto {
  @IsString()
  @Length(10, 20)
  code!: string;

  @IsString()
  @Length(6, 6)
  totp!: string;
}

class EndSessionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Admin-side surface of the support flow.
 *
 *   POST /admin/support/redeem               — code + TOTP → opens session + impersonation cookie
 *   GET  /admin/support/sessions/me          — current impersonation session (echoed back from cookie + DB)
 *   POST /admin/support/sessions/me/end      — admin clicks "End session"
 *   GET  /admin/support/sessions             — list recent sessions (read-only history)
 *   GET  /admin/support/sessions/:id/log     — read one session's audit log
 *
 * Redemption is rate-limited (5/min/admin, 10/min/IP, 10 failed/hour →
 * temporary lockout) via `support_redemption_attempts`. The lockout
 * self-heals after the rolling hour; an explicit owner-tier unlock and a
 * lockout notification email remain documented follow-ups.
 */
@Controller('admin/support')
@UseGuards(AdminAuthGuard)
export class AdminSupportController {
  private readonly logger = new Logger(AdminSupportController.name);

  constructor(
    @Inject(SupportKeyService) private readonly keys: SupportKeyService,
    @Inject(SupportSessionService) private readonly sessions: SupportSessionService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(ImpersonationSessionService)
    private readonly impJwt: ImpersonationSessionService,
    @Inject(ImpersonationCookieService)
    private readonly impCookies: ImpersonationCookieService,
    @Inject(SupportNotificationsService)
    private readonly notifs: SupportNotificationsService,
  ) {}

  @Post('redeem')
  @HttpCode(200)
  async redeem(
    @AdminSess() admin: AdminSessionPayload,
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dto = await validateDto(RedeemDto, raw);
    // Real client IP comes from X-Real-IP (Caddy/Cloudflare); req.ip is the
    // proxy peer and would collapse every admin into one bucket.
    const ip = clientIp(req);

    // 0. Brute-force defense — throttle before any bcrypt/MFA work.
    await this.enforceRedeemRateLimit(admin.sub, ip);

    // 1. Admin must have MFA enabled. The plan: hard rule.
    const adminRow = await controlDb.adminUser.findUnique({
      where: { id: admin.sub },
      select: { mfaEnabled: true, mfaSecretCipher: true, mfaNonce: true },
    });
    if (!adminRow?.mfaEnabled) {
      throw new BadRequestException(
        'You need to set up an authenticator app before you can redeem support keys.',
      );
    }
    const secret = this.mfa.decrypt(adminRow.mfaSecretCipher, adminRow.mfaNonce);
    if (!(await this.mfa.verifyTokenOnce(admin.sub, secret, dto.totp))) {
      // Wrong OR already-used code (replay). Log the attempt + bail.
      await this.recordAttempt(admin.sub, ip, false, dto.code);
      throw new UnauthorizedException('That authenticator code is wrong or has already been used.');
    }

    // 2. Verify the support key.
    let matched: { keyId: string; tenantId: string };
    try {
      matched = await this.keys.verifyAndConsume({
        code: dto.code,
        adminId: admin.sub,
        redeemedFromIp: ip,
      });
    } catch (err) {
      await this.recordAttempt(admin.sub, ip, false, dto.code);
      throw err;
    }

    // 3. Open the session + stamp the key as redeemed (one transaction).
    const session = await this.sessions.open({
      keyId: matched.keyId,
      tenantId: matched.tenantId,
      adminId: admin.sub,
      ipAddress: ip,
      userAgent: req.headers['user-agent'],
    });

    // 4. Sign the impersonation cookie.
    const { token, expiresAt } = this.impJwt.sign({
      adminId: admin.sub,
      tenantId: matched.tenantId,
      sessionId: session.id,
    });
    this.impCookies.set(res, token, expiresAt);

    await this.recordAttempt(admin.sub, ip, true, dto.code);

    // 5. Notify the library the session is now open. Pull the admin's
    // identity in the same query so the email shows who's working.
    const adminRecord = await controlDb.adminUser.findUnique({
      where: { id: admin.sub },
      select: { email: true, fullName: true },
    });
    if (adminRecord) {
      await this.notifs.keyRedeemed({
        sessionId: session.id,
        tenantId: matched.tenantId,
        adminEmail: adminRecord.email,
        adminFullName: adminRecord.fullName,
        expiresAt,
        ipAddress: ip ?? null,
      });
    }

    // 6. Return what the UI needs to navigate.
    const tenant = await controlDb.tenant.findUnique({
      where: { id: matched.tenantId },
      select: { id: true, slug: true, name: true },
    });
    return {
      session: {
        id: session.id,
        tenantId: matched.tenantId,
        expiresAt,
      },
      tenant,
    };
  }

  @Get('sessions/me')
  async meSession(@AdminSess() admin: AdminSessionPayload) {
    const row = await controlDb.supportSession.findFirst({
      where: { adminId: admin.sub, endedAt: null },
      orderBy: { startedAt: 'desc' },
      include: { tenant: { select: { id: true, slug: true, name: true } } },
    });
    if (!row) return { session: null };
    if (row.expiresAt < new Date()) {
      const ended = await this.sessions.end(row.id, 'expired');
      if (ended) {
        await this.notifs.sessionEnded({
          sessionId: ended.id,
          tenantId: ended.tenantId,
          endedReason: 'expired',
          actionCount: ended.actionCount,
        });
      }
      return { session: null };
    }
    return {
      session: {
        id: row.id,
        tenant: row.tenant,
        startedAt: row.startedAt,
        expiresAt: row.expiresAt,
      },
    };
  }

  @Post('sessions/me/end')
  @HttpCode(204)
  async endMySession(
    @AdminSess() admin: AdminSessionPayload,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dto = await validateDto(EndSessionDto, raw ?? {});
    void dto;
    const row = await controlDb.supportSession.findFirst({
      where: { adminId: admin.sub, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    if (row) {
      const ended = await this.sessions.end(row.id, 'admin_ended');
      if (ended) {
        await this.notifs.sessionEnded({
          sessionId: ended.id,
          tenantId: ended.tenantId,
          endedReason: 'admin_ended',
          actionCount: ended.actionCount,
        });
      }
    }
    this.impCookies.clear(res);
  }

  @Get('sessions/:id/log')
  async sessionLog(@AdminSess() admin: AdminSessionPayload, @Param('id') sessionId: string) {
    const session = await controlDb.supportSession.findUnique({
      where: { id: sessionId },
      include: {
        tenant: { select: { slug: true, name: true } },
        admin: { select: { email: true, fullName: true } },
        actions: { orderBy: { ts: 'desc' }, take: 200 },
      },
    });
    if (!session) throw new BadRequestException('Session not found.');
    // Owners see everything; support role only sees their own sessions.
    // ADM-7: read the role from the DB, not the JWT claim — a just-demoted
    // admin must lose cross-session visibility immediately, not after the
    // admin-session TTL. Mirrors AdminRolesGuard's deliberate live re-read.
    if (session.adminId !== admin.sub) {
      const liveAdmin = await controlDb.adminUser.findUnique({
        where: { id: admin.sub },
        select: { role: true, status: true, disabledAt: true },
      });
      if (!liveAdmin || liveAdmin.disabledAt || liveAdmin.status !== 'active') {
        throw new UnauthorizedException('Your admin account is no longer active.');
      }
      if (liveAdmin.role !== 'owner') {
        throw new UnauthorizedException('You can only view your own sessions.');
      }
    }
    return { session };
  }

  /**
   * Reject the redemption with 429 if the admin or IP has tripped a rate
   * limit. Counts come from `support_redemption_attempts`; the verdict is
   * the pure `evaluateRedeemRateLimit` so it stays unit-testable.
   */
  private async enforceRedeemRateLimit(adminId: string, ip: string | undefined): Promise<void> {
    const now = Date.now();
    const oneMinuteAgo = new Date(now - 60_000);
    const oneHourAgo = new Date(now - 60 * 60_000);
    const [adminLastMinute, ipLastMinute, adminFailedLastHour] = await Promise.all([
      controlDb.supportRedemptionAttempt.count({
        where: { adminId, ts: { gte: oneMinuteAgo } },
      }),
      ip
        ? controlDb.supportRedemptionAttempt.count({
            where: { ipAddress: ip, ts: { gte: oneMinuteAgo } },
          })
        : Promise.resolve(0),
      controlDb.supportRedemptionAttempt.count({
        where: { adminId, success: false, ts: { gte: oneHourAgo } },
      }),
    ]);
    const decision = evaluateRedeemRateLimit({
      adminLastMinute,
      ipLastMinute,
      adminFailedLastHour,
    });
    if (!decision.allowed) {
      if (decision.reason === 'locked_out') {
        this.logger.warn(
          `Support redemption locked out: admin=${adminId} had ${adminFailedLastHour} failed attempts in the last hour.`,
        );
      }
      throw new HttpException(decision.message, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async recordAttempt(
    adminId: string,
    ip: string | undefined,
    success: boolean,
    code: string,
  ): Promise<void> {
    const cleaned = code.replace(/^SUPPORT-/i, '').toUpperCase();
    const prefix = cleaned.slice(0, 4);
    await controlDb.supportRedemptionAttempt
      .create({
        data: {
          adminId,
          ipAddress: ip ?? null,
          success,
          codePrefix: prefix,
        },
      })
      .catch(() => undefined);
  }
}
