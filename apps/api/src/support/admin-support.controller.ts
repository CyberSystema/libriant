import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
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
import { ImpersonationCookieService } from './impersonation-cookie.service.js';
import { ImpersonationSessionService } from './impersonation-session.service.js';
import { MfaService } from './mfa.service.js';
import { SupportKeyService } from './support-key.service.js';
import { SupportNotificationsService } from './support-notifications.service.js';
import { SupportSessionService } from './support-session.service.js';

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
 * Redemption rate-limiting + email notifications are TODO (the schema
 * already has `SupportRedemptionAttempt` for the former; both are
 * deferred to a separate hardening step).
 */
@Controller('admin/support')
@UseGuards(AdminAuthGuard)
export class AdminSupportController {
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
    if (!this.mfa.verifyToken(secret, dto.totp)) {
      // Log the attempt + bail.
      await this.recordAttempt(admin.sub, req, false, dto.code);
      throw new UnauthorizedException('That authenticator code is wrong.');
    }

    // 2. Verify the support key.
    let matched: { keyId: string; tenantId: string };
    try {
      matched = await this.keys.verifyAndConsume({
        code: dto.code,
        adminId: admin.sub,
        redeemedFromIp: req.ip,
      });
    } catch (err) {
      await this.recordAttempt(admin.sub, req, false, dto.code);
      throw err;
    }

    // 3. Open the session + stamp the key as redeemed (one transaction).
    const session = await this.sessions.open({
      keyId: matched.keyId,
      tenantId: matched.tenantId,
      adminId: admin.sub,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // 4. Sign the impersonation cookie.
    const { token, expiresAt } = this.impJwt.sign({
      adminId: admin.sub,
      tenantId: matched.tenantId,
      sessionId: session.id,
    });
    this.impCookies.set(res, token, expiresAt);

    await this.recordAttempt(admin.sub, req, true, dto.code);

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
        ipAddress: req.ip ?? null,
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
  async sessionLog(@AdminSess() admin: AdminSessionPayload, @Req() req: Request) {
    const sessionId = req.params.id;
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
    if (admin.role !== 'owner' && session.adminId !== admin.sub) {
      throw new UnauthorizedException('You can only view your own sessions.');
    }
    return { session };
  }

  private async recordAttempt(
    adminId: string,
    req: Request,
    success: boolean,
    code: string,
  ): Promise<void> {
    const cleaned = code.replace(/^SUPPORT-/i, '').toUpperCase();
    const prefix = cleaned.slice(0, 4);
    await controlDb.supportRedemptionAttempt
      .create({
        data: {
          adminId,
          ipAddress: req.ip ?? null,
          success,
          codePrefix: prefix,
        },
      })
      .catch(() => undefined);
  }
}
