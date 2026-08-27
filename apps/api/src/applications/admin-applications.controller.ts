import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { controlDb } from '@libriant/db-control';
import type { ApplicationStatus } from '@libriant/db-control';
import { validateDto } from '../auth/validate-dto.js';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { adminAuditActor, recordAdminAudit } from '../platform/admin-audit.js';
import { OFFER_TOTAL } from './applications.service.js';

const STATUSES = ['new', 'contacted', 'accepted', 'rejected'] as const;

class SetApplicationStatusDto {
  @IsIn([...STATUSES])
  status!: (typeof STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  decisionNote?: string;
}

/** Counts per status, with every status present so the UI never renders a gap. */
type StatusCounts = Record<(typeof STATUSES)[number], number>;

async function countByStatus(): Promise<StatusCounts> {
  const rows = await controlDb.application.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = { new: 0, contacted: 0, accepted: 0, rejected: 0 };
  for (const row of rows) counts[row.status as keyof StatusCounts] = row._count._all;
  return counts;
}

/**
 * launch-readiness-03 — the commercial funnel's read side.
 *
 *   GET  /admin/applications          — the applications, newest first
 *   GET  /admin/applications/summary  — counts only, for the sidebar badge
 *   POST /admin/applications/:id/status
 *
 * Until this existed, a library's application landed in Postgres and nothing
 * told anybody. The only notification was an `application_submitted` e-mail,
 * and Libriant launches with EMAIL_DRIVER=console, which composes mail and
 * delivers none of it; the only read path was `GET /admin/applications.csv`,
 * which is linked from nowhere in the panel. Meanwhile the site promises "we
 * answer every application within two working days" and the campaign points
 * 277 Greek mailboxes at the form. An admin page with an unread count is worth
 * more than mail that cannot send, so this is the one that got built.
 *
 * OWNER-ONLY, whole controller, and for the same reason the CSV export is
 * (authn-authz-14): every row carries an applicant's name, e-mail address,
 * phone number and free-text message. That is not something to hand the
 * support tier — the lowest platform privilege, the one we would give whoever
 * answers the phone. `@AdminRoles` on the class rather than per route, so a
 * route added here later inherits the gate instead of shipping open.
 *
 * WHAT THE AUDIT ROWS MAY NOT CONTAIN — privacy-legal-04, and it bites harder
 * here than anywhere. An application has no tenant, so every row written from
 * this controller has `tenantId: null` and is reached by neither the tenant
 * delete CASCADE nor the BEFORE DELETE redaction trigger. The retention sweep
 * deletes the `applications` row itself (privacy-legal-14) — so an audit row
 * naming the applicant would be the copy of a person we had promised to forget
 * that outlives the promise. Counts, filters and the application's id only.
 */
@Controller('admin/applications')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AdminRoles('owner')
export class AdminApplicationsController {
  @Get()
  async list(
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Query('status') status?: string,
  ) {
    const filter = STATUSES.includes(status as (typeof STATUSES)[number])
      ? (status as ApplicationStatus)
      : undefined;
    const [applications, counts] = await Promise.all([
      controlDb.application.findMany({
        where: filter ? { status: filter } : undefined,
        orderBy: { createdAt: 'desc' },
        // Oldest-first is how the places are awarded ("in order of
        // application"), but newest-first is how they are READ — the operator
        // opens this page to see what arrived since they last looked. The
        // order of application is recoverable from the dates on every card.
        take: 200,
      }),
      countByStatus(),
    ]);
    // Audited like the outbox listing, and for the same reason: "who has been
    // reading the details libraries sent us?" is a fair question. The filter is
    // recorded, the rows are not — see the class comment.
    await recordAdminAudit(adminAuditActor(req, admin), {
      action: 'application.listed',
      targetType: 'application',
      after: { status: filter ?? null, returned: applications.length },
    });
    return { applications, counts, offer: offerFrom(counts, OFFER_TOTAL) };
  }

  /**
   * Counts only — no personal data, so no audit row.
   *
   * This is what the admin shell calls on EVERY page load to put the unread
   * badge in the sidebar (see apps/web/app/[locale]/admin/(authed)/layout.tsx).
   * Auditing it would write a row per page view and bury the reads that
   * actually touched an applicant's details.
   */
  @Get('summary')
  async summary() {
    const counts = await countByStatus();
    return { counts, offer: offerFrom(counts, OFFER_TOTAL) };
  }

  /**
   * Move one application along: contacted, accepted, rejected — or back to new.
   *
   * `accepted` is load-bearing beyond the label. It is what the public form's
   * gate counts (launch-readiness-11), so accepting the fifth library closes
   * the form within the minute, with no deploy. Accepting a SIXTH is not
   * refused here: five is a promise to the public, not a lock on the one
   * person running this, and a refusal whose only escape hatch is editing
   * site.config.json and redeploying would put the deploy back in the loop
   * that this change exists to take it out of. The answer says how many places
   * are taken instead, and the audit row records who took them.
   */
  @Post(':id/status')
  @HttpCode(200)
  async setStatus(
    @Param('id') id: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SetApplicationStatusDto, raw);
    const before = await controlDb.application.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!before) throw new NotFoundException('That application no longer exists.');

    const application = await controlDb.application.update({
      where: { id },
      data: {
        status: dto.status,
        decisionNote: dto.decisionNote?.trim() || null,
        reviewedByAdminId: admin.sub,
        reviewedAt: new Date(),
      },
    });

    const counts = await countByStatus();
    // No applicant name, address or note in this row — only which application
    // moved and where it moved to. See the class comment.
    await recordAdminAudit(adminAuditActor(req, admin), {
      action: 'application.status_changed',
      targetType: 'application',
      targetId: id,
      before: { status: before.status },
      after: { status: dto.status, placesTaken: counts.accepted },
    });
    return { application, counts, offer: offerFrom(counts, OFFER_TOTAL) };
  }
}

/**
 * The same arithmetic the public form's gate does, from counts already in
 * hand. Deliberately NOT `ApplicationsService.offerState()`: that one fails
 * OPEN on a database error so a blip cannot turn an applicant away, and an
 * admin screen that quietly reports "0 of 5 taken" during an outage would be
 * the same lie in the other direction. Here the counts are either real or the
 * request has already failed.
 */
function offerFrom(counts: StatusCounts, total: number) {
  return { total, taken: counts.accepted, open: counts.accepted < total };
}
