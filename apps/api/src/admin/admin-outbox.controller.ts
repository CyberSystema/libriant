import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { adminAuditActor, recordAdminAudit } from '../platform/admin-audit.js';
import { AdminAuthGuard, AdminSess } from './admin-auth.guard.js';
import { AdminOutboxService } from './admin-outbox.service.js';
import { AdminRoles } from './admin-roles.decorator.js';
import { AdminRolesGuard } from './admin-roles.guard.js';
import type { AdminSessionPayload } from './admin-session.service.js';

/**
 * launch-readiness-01 — the operator's window onto mail that is composed but
 * never delivered.
 *
 *   GET  /admin/outbox                 — envelope-only list
 *   GET  /admin/outbox/:id             — one message WITH its body, one-time
 *                                        link re-hydrated (audited)
 *
 * OWNER-ONLY, whole controller. A message body can contain a live
 * password-reset link, which is a working credential for a library owner's
 * account — strictly more power than the support-key flow the support tier is
 * meant to use, and it would leave no `SupportActionLog` trace. `@AdminRoles`
 * is per-route by default, so it is applied to the class here deliberately:
 * a route added to this file later inherits the gate rather than shipping open.
 *
 * The list is audited too, not just the body read. "Who has been reading our
 * members' mail?" is a question a library is entitled to ask, and an
 * envelope-only listing of `toEmail` + `subject` already answers who borrowed
 * what from whom.
 *
 * WHAT THE AUDIT ROWS MAY NOT CONTAIN — privacy-legal-04. THE RULE: personal
 * data may appear in an `audit_log` row only when that row carries the real
 * `tenantId`, so the library's own erasure reaches it. A cross-tenant route —
 * the outbox list, the user directory search — must therefore record no
 * address, name or free-text term at all, only counts and filters.
 *
 * The first version of this file broke that: `detail()` recorded
 * `after.toEmail`, which for the `member_*` kinds is a library PATRON's
 * address, on a row with `tenantId: null`. `audit_log.tenantId` is
 * `onDelete: SetNull` and the BEFORE DELETE redaction trigger fires
 * `WHERE "tenantId" = OLD."id"`, so such a row is reached by neither: it
 * survives the library's own erasure request as orphaned personal data that no
 * future retention sweep can even find. A body read now identifies its subject
 * by `targetId` — the outbox row, which cascades away with the tenant —
 * instead of by prose that does not.
 */
@Controller('admin/outbox')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles('owner')
export class AdminOutboxController {
  constructor(@Inject(AdminOutboxService) private readonly outbox: AdminOutboxService) {}

  @Get()
  async list(
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('tenant') tenantSlug?: string,
    @Query('q') q?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const result = await this.outbox.list({
      status,
      kind,
      tenantSlug,
      q,
      limit: Number(limitRaw) || undefined,
    });
    await recordAdminAudit(adminAuditActor(req, admin), {
      action: 'email_outbox.listed',
      targetType: 'email_outbox',
      // `q` itself is NOT recorded. It matches against `toEmail`, so an
      // operator searching for a patron would write that patron's address into
      // this row — and this row is cross-tenant, so it has no tenantId to hang
      // off and would outlive every library it mentions (privacy-legal-04).
      // The filter facets are not personal data; the free-text term is.
      after: {
        status,
        kind,
        tenantSlug,
        searchTermChars: q?.trim().length ?? 0,
        returned: result.messages.length,
      },
    });
    return result;
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
  ) {
    const message = await this.outbox.detail(id);
    // Audit AFTER the lookup so a 404 doesn't record a read that didn't happen,
    // and record `linkState` — the difference between "read an expired notice"
    // and "read a live credential" is the whole question an auditor is asking.
    //
    // `tenantId` is the message's own tenant, NOT null (privacy-legal-04): it
    // is what puts this row inside the tenant's delete CASCADE and inside the
    // redaction trigger's `WHERE "tenantId" = OLD."id"`. And the recipient is
    // identified by `targetId` — the outbox row, which cascades away with the
    // tenant — instead of by `toEmail`, which for the `member_*` kinds is a
    // patron's address and would still be sitting here, readable, after the
    // library had been erased.
    await recordAdminAudit(adminAuditActor(req, admin), {
      tenantId: message.tenantId,
      action: 'email_outbox.body.read',
      targetType: 'email_outbox',
      targetId: message.id,
      after: {
        kind: message.kind,
        tenantSlug: message.tenantSlug,
        linkState: message.linkState,
      },
    });
    return message;
  }
}

/**
 * launch-readiness-01 — getting a person back into their library when the
 * email that was supposed to do it is sitting undelivered in the outbox.
 *
 *   GET  /admin/account-recovery/users?q=            — find the account
 *   POST /admin/account-recovery/users/:id/verify-email
 *   POST /admin/account-recovery/users/:id/reset-link
 *
 * Same owner-only gate, same reasoning, and every route writes an
 * `audit_log` row. See AdminOutboxService for why each of these exists and
 * what it costs.
 *
 * Separate controller (rather than more routes on `admin/outbox`) because the
 * URL should say what it does: an operator reaching for this in an incident is
 * not looking for "mail", they are looking for "get this librarian back in".
 */
@Controller('admin/account-recovery')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles('owner')
export class AdminAccountRecoveryController {
  constructor(@Inject(AdminOutboxService) private readonly outbox: AdminOutboxService) {}

  /**
   * A cross-tenant directory search — two characters return up to 25 people
   * from any library, with name, address, role and lock state. It went
   * unaudited while the docblock above claimed every route writes a row, which
   * is how "who has been reading our members' details?" became a question with
   * no answer. It writes one now.
   *
   * The search term is deliberately absent from that row: it is usually the
   * e-mail address of the person on the phone, and this listing spans tenants
   * so the row has no tenantId to be erased with (privacy-legal-04). Who
   * searched, when, from where, under which library filter, and how many
   * people came back is the oversight; the term itself is the leak.
   */
  @Get('users')
  async findUsers(
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Query('q') q?: string,
    @Query('tenant') tenantSlug?: string,
  ) {
    const result = await this.outbox.findUsers(q ?? '', tenantSlug);
    await recordAdminAudit(adminAuditActor(req, admin), {
      action: 'user.directory.searched',
      targetType: 'user',
      after: {
        tenantSlug: tenantSlug ?? null,
        searchTermChars: q?.trim().length ?? 0,
        returned: result.users.length,
      },
    });
    return result;
  }

  @Post('users/:id/verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Param('id') id: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
  ) {
    const result = await this.outbox.forceVerifyEmail(id);
    // Only audit a real state change. An idempotent repeat is not an event.
    if (!result.alreadyVerified) {
      await recordAdminAudit(adminAuditActor(req, admin), {
        tenantId: result.tenantId,
        action: 'user.email.force_verified',
        targetType: 'user',
        targetId: result.userId,
        before: { emailVerifiedAt: null },
        after: { emailVerifiedAt: result.verifiedAt.toISOString(), email: result.email },
      });
    }
    return result;
  }

  @Post('users/:id/reset-link')
  @HttpCode(200)
  async resetLink(
    @Param('id') id: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
  ) {
    const result = await this.outbox.issuePasswordResetLink(id);
    // The URL itself is NOT in the audit row. An audit_log that contains live
    // reset links is the same defect as an email_outbox that contains them
    // (privacy-legal-06) — it is exported by the same admin export and dumped
    // into the same backup, and unlike the outbox nothing ever sweeps it.
    // Record that a link was issued, for whom, and when it dies.
    await recordAdminAudit(adminAuditActor(req, admin), {
      tenantId: result.tenantId,
      action: 'user.password_reset_link.issued',
      targetType: 'user',
      targetId: result.userId,
      after: { identity: result.identity, expiresAt: result.expiresAt.toISOString() },
    });
    return result;
  }
}
