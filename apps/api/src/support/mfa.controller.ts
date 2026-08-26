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
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import type { Request, Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminCookieService } from '../admin/admin-cookie.service.js';
import { AdminSessionService } from '../admin/admin-session.service.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { PasswordService } from '../auth/password.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { adminAuditActor, recordAdminAudit } from '../platform/admin-audit.js';
import { RedisService } from '../platform/redis.service.js';
import { MfaRecoveryService } from './mfa-recovery.service.js';
import { MfaService } from './mfa.service.js';

class VerifyTotpDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}

/**
 * Re-authentication for an admin who is ALREADY enrolled. Both fields are
 * required in that case and ignored when the admin has no second factor yet
 * (there is nothing to step up from, and demanding a code from an
 * authenticator they have not set up would make first enrollment impossible).
 */
class MfaStepUpDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  currentPassword?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Authenticator codes are 6 digits.' })
  currentTotp?: string;
}

/** Shape parked in Redis while the admin types the new secret into their app. */
type PendingEnrollment = {
  secret: string;
  /** True when the admin proved password + existing TOTP to start this. */
  steppedUp: boolean;
};

/**
 *   GET  /admin/mfa/status              — { mfaEnabled, recoveryCodesRemaining }
 *   POST /admin/mfa/setup               — start enrollment, returns secret + otpauth URL
 *   POST /admin/mfa/verify              — confirm a 6-digit code, persist secret,
 *                                         flip mfaEnabled=true, return recovery codes
 *   POST /admin/mfa/recovery-codes      — re-issue recovery codes (step-up required)
 *
 * Setup is a two-step dance: setup produces a secret the admin types into
 * their authenticator, verify confirms they typed it correctly and only
 * then do we persist + flip the flag. Until verify lands, the ciphertext
 * columns are unchanged and the account can't redeem support keys.
 *
 * ## Re-enrollment is a step-up (authn-authz-09)
 *
 * `setup` and `verify` sat behind `AdminAuthGuard` alone and neither read
 * `mfaEnabled`. A probe with nothing but a one-hour admin session cookie called
 * `POST /admin/mfa/setup` on an ENROLLED admin and was issued a fresh secret;
 * `verify` then overwrote `mfaSecretCipher`/`mfaNonce`/`mfaKeyId` for it. MFA is
 * the control that stops a stolen admin password from yielding the control
 * plane and is a hard precondition for redeeming support keys into customer
 * libraries — so re-pointing it converted a transient stolen cookie into
 * durable, MFA-blessed platform access, discovered only when the real admin's
 * own code stopped working. Replacing an existing factor now costs the current
 * password AND a live code from the factor being replaced, and lands a
 * `sessionsValidAfter` bump that kills every other admin cookie.
 *
 * (The docblock here used to advertise `POST /admin/mfa/disable` "for
 * completeness". No such route existed. It is not listed above because it still
 * does not exist — an admin who must stop using their authenticator re-enrolls
 * a new one through the step-up above.)
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
    @Inject(MfaRecoveryService) private readonly recovery: MfaRecoveryService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(AdminSessionService) private readonly adminJwt: AdminSessionService,
    @Inject(AdminCookieService) private readonly adminCookies: AdminCookieService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get('status')
  async status(@AdminSess() session: AdminSessionPayload) {
    const row = await controlDb.adminUser.findUnique({
      where: { id: session.sub },
      select: { mfaEnabled: true },
    });
    return {
      mfaEnabled: !!row?.mfaEnabled,
      // launch-readiness-13: surfaced so "we have no way back in" is visible
      // BEFORE the phone is lost rather than after.
      recoveryCodesRemaining: await this.recovery.remaining(session.sub),
    };
  }

  @Post('setup')
  @HttpCode(200)
  async setup(@AdminSess() session: AdminSessionPayload, @Body() raw: unknown) {
    const admin = await controlDb.adminUser.findUnique({
      where: { id: session.sub },
      select: {
        email: true,
        mfaEnabled: true,
        passwordHash: true,
        mfaSecretCipher: true,
        mfaNonce: true,
      },
    });
    if (!admin) throw new BadRequestException('Admin not found.');

    // First enrollment: nothing to step up from. Re-enrollment: prove both.
    if (admin.mfaEnabled) {
      const dto = await validateDto(MfaStepUpDto, raw ?? {});
      await this.assertStepUp(session.sub, admin, dto);
    }

    const { secret, otpauthUrl } = this.mfa.newSecret(admin.email);
    const pending: PendingEnrollment = { secret, steppedUp: admin.mfaEnabled };
    await this.redis.client.set(
      MfaController.pendingKey(session.sub),
      JSON.stringify(pending),
      'EX',
      MfaController.PENDING_TTL_SEC,
    );
    return { secret, otpauthUrl };
  }

  @Post('verify')
  @HttpCode(200)
  async verify(
    @AdminSess() session: AdminSessionPayload,
    @Body() raw: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const dto = await validateDto(VerifyTotpDto, raw);
    const pending = await this.readPending(session.sub);
    if (!pending) {
      throw new BadRequestException(
        'No MFA setup in progress (or it expired). Start enrollment again from the setup endpoint.',
      );
    }
    const admin = await controlDb.adminUser.findUnique({
      where: { id: session.sub },
      select: { mfaEnabled: true },
    });
    // Belt and braces for authn-authz-09: `setup` gates re-enrollment, but a
    // pending secret could have been minted before the admin enrolled (or a
    // future caller could write one). Persisting a replacement is refused
    // unless the step-up that authorised it is recorded on the pending entry
    // itself — the check cannot be skipped by going straight to this endpoint.
    const wasEnrolled = admin?.mfaEnabled === true;
    if (wasEnrolled && !pending.steppedUp) {
      await this.redis.client.del(MfaController.pendingKey(session.sub));
      throw new UnauthorizedException(
        'Replacing an authenticator needs your current password and a code from the one you are ' +
          'replacing. Start again from the setup step.',
      );
    }
    if (!this.mfa.verifyToken(pending.secret, dto.code)) {
      throw new BadRequestException('That code is wrong. Try the next one your app shows.');
    }

    const { cipher, nonce, keyId } = this.mfa.encrypt(pending.secret);
    await controlDb.adminUser.update({
      where: { id: session.sub },
      data: {
        mfaSecretCipher: cipher,
        mfaNonce: nonce,
        mfaKeyId: keyId,
        mfaEnabled: true,
        // REPLACEMENT only. Any other admin cookie for this account was minted
        // before the second factor changed, so end it — AdminAuthGuard reads
        // this column on every request and, until now, nothing ever wrote it.
        //
        // Not on a FIRST enrollment: there were no MFA-blessed cookies to
        // invalidate (the account had no second factor a moment ago), and
        // stamping it there would sign the admin out of the enrollment flow
        // they are standing in the middle of, one second later, for nothing.
        ...(wasEnrolled ? { sessionsValidAfter: new Date() } : {}),
      },
    });
    await this.redis.client.del(MfaController.pendingKey(session.sub));
    if (wasEnrolled) {
      // The bump above would kill THIS request's cookie on its next use too
      // (`iat < sessionsValidAfter`), logging the admin out of the very session
      // that just re-enrolled. Re-mint it: the caller has just proven their
      // password AND a code from the factor they replaced, which is more than a
      // cookie is worth.
      const fresh = this.adminJwt.sign({ sub: session.sub, role: session.role });
      this.adminCookies.setSession(res, fresh.token, fresh.expiresAt);
    }

    // launch-readiness-13: issued here because this is the only moment the
    // admin is provably present AND has a working authenticator. Shown once.
    const recoveryCodes = await this.recovery.issue(session.sub);

    // authn-authz-09 asked for the admin to be TOLD when their second factor
    // changes. EMAIL_DRIVER is `console` and nothing is delivered, so the
    // notice goes where a control-plane security event belongs and where an
    // operator can actually read it: the admin audit log. Best-effort, after
    // the write, like every other admin audit row.
    await recordAdminAudit(adminAuditActor(req, session), {
      action: wasEnrolled ? 'admin.mfa.replaced' : 'admin.mfa.enrolled',
      targetType: 'admin_user',
      targetId: session.sub,
      after: { mfaEnabled: true, recoveryCodesIssued: recoveryCodes.length },
    });
    return { mfaEnabled: true, recoveryCodes };
  }

  /**
   * Re-issue recovery codes (launch-readiness-13). Same step-up as replacing
   * the authenticator: whoever can mint a fresh set of one-time bypasses can
   * bypass the second factor, so holding the cookie is not enough.
   */
  @Post('recovery-codes')
  @HttpCode(200)
  async regenerateRecoveryCodes(
    @AdminSess() session: AdminSessionPayload,
    @Body() raw: unknown,
    @Req() req: Request,
  ) {
    const admin = await controlDb.adminUser.findUnique({
      where: { id: session.sub },
      select: { mfaEnabled: true, passwordHash: true, mfaSecretCipher: true, mfaNonce: true },
    });
    if (!admin?.mfaEnabled) {
      throw new BadRequestException('Set up an authenticator first — there is nothing to recover.');
    }
    const dto = await validateDto(MfaStepUpDto, raw ?? {});
    await this.assertStepUp(session.sub, admin, dto);
    const recoveryCodes = await this.recovery.issue(session.sub);
    await recordAdminAudit(adminAuditActor(req, session), {
      action: 'admin.mfa.recovery_codes_reissued',
      targetType: 'admin_user',
      targetId: session.sub,
      after: { recoveryCodesIssued: recoveryCodes.length },
    });
    return { recoveryCodes };
  }

  // --- internals ---------------------------------------------------------

  /**
   * Prove the caller is the account holder and not merely the holder of its
   * cookie: current password AND a single-use code from the CURRENTLY enrolled
   * authenticator. `verifyTokenOnce` burns the code, so a shoulder-surfed one
   * cannot be replayed into this endpoint.
   */
  private async assertStepUp(
    adminId: string,
    admin: { passwordHash: string; mfaSecretCipher: Uint8Array; mfaNonce: Uint8Array },
    dto: { currentPassword?: string; currentTotp?: string },
  ): Promise<void> {
    if (!dto.currentPassword || !dto.currentTotp) {
      throw new UnauthorizedException({
        code: 'mfa_step_up_required',
        message:
          'Enter your current password and a code from your existing authenticator to change ' +
          'your second factor.',
      });
    }
    if (!(await this.passwords.verify(dto.currentPassword, admin.passwordHash))) {
      throw new UnauthorizedException('That password is wrong.');
    }
    let currentSecret: string;
    try {
      currentSecret = this.mfa.decrypt(admin.mfaSecretCipher, admin.mfaNonce);
    } catch {
      // The stored seed cannot be read — a rotated or lost MFA_MASTER_KEY, or a
      // row whose ciphertext was written by something else. Say so instead of
      // 500ing: this is the launch-readiness-13 corner, and the way out is a
      // recovery code at sign-in, not this endpoint.
      throw new UnauthorizedException(
        'Your stored authenticator secret cannot be read on this server, so it cannot be used to ' +
          'authorise a change. Sign in with a recovery code instead.',
      );
    }
    if (!(await this.mfa.verifyTokenOnce(adminId, currentSecret, dto.currentTotp))) {
      throw new UnauthorizedException('That authenticator code is wrong or has already been used.');
    }
  }

  /**
   * Read the pending enrollment. Tolerates the pre-authn-authz-09 format (a
   * bare secret string) so an enrollment already in flight during a deploy is
   * not thrown away — but such an entry carries no step-up, so `verify` treats
   * it as un-stepped-up, which is the safe reading.
   */
  private async readPending(adminId: string): Promise<PendingEnrollment | null> {
    const raw = await this.redis.client.get(MfaController.pendingKey(adminId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<PendingEnrollment>;
      if (typeof parsed?.secret === 'string') {
        return { secret: parsed.secret, steppedUp: parsed.steppedUp === true };
      }
    } catch {
      // Legacy plain-string secret.
      return { secret: raw, steppedUp: false };
    }
    return null;
  }
}
