import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { CookieService } from './cookie.service.js';
import { JwtSessionService } from './jwt-session.service.js';
import { LoginService } from './login.service.js';
import { PasswordService } from './password.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { EmailVerificationService } from './email-verification.service.js';
import { EmailVerifiedGuard } from './email-verified.guard.js';
import { SignupService } from './signup.service.js';
import { TenantProvisioningService } from '../provisioning/tenant-provisioning.service.js';
import { TenantModule } from '../tenancy/tenant.module.js';

@Module({
  imports: [TenantModule],
  providers: [
    AuthGuard,
    CookieService,
    JwtSessionService,
    LoginService,
    PasswordService,
    PasswordResetService,
    EmailVerificationService,
    EmailVerifiedGuard,
    SignupService,
    TenantProvisioningService,
  ],
  controllers: [AuthController],
  exports: [
    AuthGuard,
    CookieService,
    JwtSessionService,
    LoginService,
    PasswordService,
    PasswordResetService,
    EmailVerificationService,
    EmailVerifiedGuard,
    SignupService,
  ],
})
export class AuthModule {}
