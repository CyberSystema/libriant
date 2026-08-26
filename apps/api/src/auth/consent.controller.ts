import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsIn } from 'class-validator';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles } from '../tenancy/roles.decorator.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantActor } from '../tenancy/tenant-actor.js';
import { clientIp } from '../platform/client-ip.js';
import { validateDto } from './validate-dto.js';
import { LEGAL_LOCALES, type LegalLocale } from './consent-locales.js';
import { ConsentService } from './consent.service.js';

export class AcceptLegalDto {
  /**
   * Which language of the documents was on screen. Required for the same
   * reason the signup DTO now requires it: an acceptance that guesses the
   * corpus is a record of the wrong text, which is worse than no record.
   */
  @IsIn(LEGAL_LOCALES, {
    message: 'locale must be "el" or "en" — the language of the documents you were shown.',
  })
  locale!: LegalLocale;
}

/**
 * The library's own legal-consent record (privacy-legal-09).
 *
 *   GET  /t/:slug/legal/consent           — which version this library accepted,
 *                                           and whether the published text has
 *                                           since moved on
 *   GET  /t/:slug/legal/consent/evidence  — the full record: who accepted, when,
 *                                           from which IP, and THE EXACT TEXT of
 *                                           every document in that version
 *   POST /t/:slug/legal/consent/accept    — accept the current version
 *
 * ## Why this controller is the fix and the service alone was not
 *
 * The first attempt at this finding shipped a reader (`readLegalAcceptance`)
 * that no route mounted — it even said so in its own doc comment. That is the
 * failure mode this remediation keeps repeating: machinery built and never
 * mounted. So the acceptance criterion here is not "a function exists that
 * could produce the text", it is "an operator can ask a running Libriant, for a
 * given library, what that library agreed to, and get the words back". These
 * three routes are that, and `test/integration/consent-evidence.spec.ts` drives
 * them over HTTP through the real AppModule.
 *
 * ## Who may read it
 *
 * Owner and admin of the library itself. This is the library's own contract
 * record and its own signature; a librarian or volunteer has no business
 * reading who bound the organisation, and the IP address on the record is
 * personal data. Accepting is owner-only — under Terms §2.4 the person who
 * binds a public body warrants authority to do so, and delegating that to an
 * admin account would make the warranty meaningless.
 */
@Controller('t/:slug/legal')
@UseGuards(TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class ConsentController {
  constructor(@Inject(ConsentService) private readonly consent: ConsentService) {}

  @Get('consent')
  async state(@TenantCtx() tenant: TenantContext) {
    return this.consent.stateFor(tenant.id);
  }

  @Get('consent/evidence')
  async evidence(@TenantCtx() tenant: TenantContext) {
    return this.consent.evidenceFor(tenant.id);
  }

  @Post('consent/accept')
  @Roles('owner')
  @HttpCode(200)
  async accept(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Body() raw: unknown,
    @Req() req: Request,
  ) {
    const dto = await validateDto(AcceptLegalDto, raw);
    // `actor.userId` is NULL under support impersonation on purpose (see
    // TenantActor): a Libriant admin is not the library and cannot sign its
    // contract. Falling back to the tenant owner here would forge a signature,
    // so the route refuses instead.
    if (!actor.userId) {
      throw new ForbiddenException(
        'A support session cannot accept the terms on a library’s behalf — the library owner must.',
      );
    }
    return this.consent.recordAcceptance({
      tenantId: tenant.id,
      userId: actor.userId,
      locale: dto.locale,
      ip: clientIp(req) ?? null,
    });
  }
}
