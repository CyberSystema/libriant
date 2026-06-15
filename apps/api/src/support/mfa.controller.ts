import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { RedisService } from '../platform/redis.service.js';
import { MfaService } from './mfa.service.js';

class VerifyTotpDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}

/**
 *   GET  /admin/mfa/status              — { mfaEnabled }
 *   POST /admin/mfa/setup               — start enrollment, returns secret + otpauth URL
 *   POST /admin/mfa/verify              — confirm a 6-digit code, persist secret + flip mfaEnabled=true
 *   POST /admin/mfa/disable             — undo (out of MVP, but exposed for completeness)
 *
 * Setup is a two-step dance: setup produces a secret the admin types into
 * their authenticator, verify confirms they typed it correctly and only
 * then do we persist + flip the flag. Until verify lands, the ciphertext
 * columns are unchanged and the account can't redeem support keys.
 */
@Controller('admin/mfa')
@UseGuards(AdminAuthGuard)
export class MfaController {
  /**
   * Pending-secret TTL while the admin types the code into their app. Stored in
   * Redis keyed by admin id (AUTH-09) — shared across instances and surviving
   * deploys, unlike the old in-process Map which silently broke enrollment
   * after any restart or under horizontal scaling.
   */
  private static readonly PENDING_TTL_SEC = 600;
  private static pendingKey(adminId: string): string {
    return `mfa:setup:${adminId}`;
  }

  constructor(
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get('status')
  async status(@AdminSess() session: AdminSessionPayload) {
    const row = await controlDb.adminUser.findUnique({
      where: { id: session.sub },
      select: { mfaEnabled: true },
    });
    return { mfaEnabled: !!row?.mfaEnabled };
  }

  @Post('setup')
  @HttpCode(200)
  async setup(@AdminSess() session: AdminSessionPayload) {
    const admin = await controlDb.adminUser.findUnique({
      where: { id: session.sub },
      select: { email: true },
    });
    if (!admin) throw new BadRequestException('Admin not found.');
    const { secret, otpauthUrl } = this.mfa.newSecret(admin.email);
    await this.redis.client.set(
      MfaController.pendingKey(session.sub),
      secret,
      'EX',
      MfaController.PENDING_TTL_SEC,
    );
    return { secret, otpauthUrl };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@AdminSess() session: AdminSessionPayload, @Body() raw: unknown) {
    const dto = await validateDto(VerifyTotpDto, raw);
    const secret = await this.redis.client.get(MfaController.pendingKey(session.sub));
    if (!secret) {
      throw new BadRequestException(
        'No MFA setup in progress (or it expired). Start enrollment again from the setup endpoint.',
      );
    }
    if (!this.mfa.verifyToken(secret, dto.code)) {
      throw new BadRequestException('That code is wrong. Try the next one your app shows.');
    }
    const { cipher, nonce, keyId } = this.mfa.encrypt(secret);
    await controlDb.adminUser.update({
      where: { id: session.sub },
      data: {
        mfaSecretCipher: cipher,
        mfaNonce: nonce,
        mfaKeyId: keyId,
        mfaEnabled: true,
      },
    });
    await this.redis.client.del(MfaController.pendingKey(session.sub));
    return { mfaEnabled: true };
  }
}
