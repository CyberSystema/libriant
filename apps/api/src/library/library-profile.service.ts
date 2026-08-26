import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { controlDb, type Prisma } from '@libriant/db-control';
import { CORE_PROFILE_FIELDS, type CoreProfileField } from '@libriant/shared';
import { EmailService } from '../email/email.service.js';
import { recordAdminAudit, type AdminAuditActor } from '../platform/admin-audit.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import type { ProposeCoreEditDto, UpdateFreeProfileDto } from './library.dto.js';

/** Columns that make up the public library profile. */
const PROFILE_SELECT = {
  id: true,
  slug: true,
  name: true,
  libraryType: true,
  addressStreet: true,
  addressCity: true,
  addressPostalCode: true,
  addressRegion: true,
  addressCountry: true,
  publicPhone: true,
  publicEmail: true,
  website: true,
  description: true,
  foundedYear: true,
  primaryEmail: true,
} as const;

type ProfileRow = Prisma.TenantGetPayload<{ select: typeof PROFILE_SELECT }>;

/**
 * Library-profile read/write + the owner-approved "core field" edit-request
 * workflow. The profile lives on the control-plane Tenant row, so this is a
 * plain singleton over `controlDb` (no per-tenant client).
 */
@Injectable()
export class LibraryProfileService {
  private readonly logger = new Logger(LibraryProfileService.name);

  constructor(
    @Inject(EmailService) private readonly email: EmailService,
    // tenant-isolation-07: every write in this service lands on the same row
    // TenantMiddleware caches, so the writes go through the resolver rather
    // than through `controlDb` directly.
    @Inject(TenantResolverService) private readonly tenantResolver: TenantResolverService,
  ) {}

  // ---- tenant-side --------------------------------------------------------

  async getProfile(tenantId: string) {
    const tenant = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: PROFILE_SELECT,
    });
    if (!tenant) throw new NotFoundException('Library not found.');
    const pending = await controlDb.libraryEditRequest.findFirst({
      where: { tenantId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    return { profile: this.toDto(tenant), pendingRequest: pending };
  }

  /** Update the FREE fields directly (tenant owner/admin). */
  async updateFreeFields(tenantId: string, dto: UpdateFreeProfileDto) {
    const data: Prisma.TenantUpdateInput = {};
    if (dto.publicPhone !== undefined) data.publicPhone = dto.publicPhone || null;
    if (dto.publicEmail !== undefined) data.publicEmail = dto.publicEmail || null;
    if (dto.website !== undefined) data.website = dto.website || null;
    if (dto.description !== undefined) data.description = dto.description || null;
    if (dto.foundedYear !== undefined) data.foundedYear = dto.foundedYear ?? null;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No changes to save.');
    }
    // None of the free fields is part of the cached context, so this costs no
    // Redis round trip today — but it is the same call as the one that renames
    // a library, which does, and having two ways to write this row is how the
    // rename came to be missing an invalidation in the first place.
    await this.tenantResolver.updateTenant(tenantId, data);
    return this.getProfile(tenantId);
  }

  /**
   * Submit a request to change CORE fields. Computes the real diff vs the
   * current values (so a no-op request is rejected), forbids a second pending
   * request, persists a before/after snapshot, and notifies the platform owners.
   */
  async submitEditRequest(tenantId: string, userId: string, dto: ProposeCoreEditDto) {
    const tenant = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: PROFILE_SELECT,
    });
    if (!tenant) throw new NotFoundException('Library not found.');

    const existingPending = await controlDb.libraryEditRequest.findFirst({
      where: { tenantId, status: 'pending' },
      select: { id: true },
    });
    if (existingPending) {
      throw new BadRequestException(
        'There is already a pending change request for this library. Wait for it to be reviewed or cancel it first.',
      );
    }

    // Keep only core fields the request actually CHANGES.
    const proposed: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const field of CORE_PROFILE_FIELDS) {
      const next = (dto as Record<string, unknown>)[field];
      if (next === undefined) continue;
      const current = (tenant as Record<string, unknown>)[field] ?? null;
      const normalized = next === '' ? null : next;
      if (normalized !== current) {
        proposed[field] = normalized;
        before[field] = current;
      }
    }
    if (Object.keys(proposed).length === 0) {
      throw new BadRequestException(
        'The requested values match the current ones — nothing to change.',
      );
    }

    const request = await controlDb.libraryEditRequest.create({
      data: {
        tenantId,
        requestedByUserId: userId,
        requestNote: dto.requestNote ?? null,
        proposedJson: proposed as Prisma.InputJsonValue,
        beforeJson: before as Prisma.InputJsonValue,
      },
    });

    await this.notifyOwnersOfNewRequest(tenant, request.id, proposed).catch((err: unknown) =>
      this.logger.warn(`owner notify failed for request ${request.id}: ${(err as Error).message}`),
    );
    return request;
  }

  async listRequests(tenantId: string) {
    return controlDb.libraryEditRequest.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** Tenant cancels its own pending request. */
  async cancelRequest(tenantId: string, id: string) {
    const updated = await controlDb.libraryEditRequest.updateMany({
      where: { id, tenantId, status: 'pending' },
      data: { status: 'canceled' },
    });
    if (updated.count === 0) {
      throw new NotFoundException('No pending request to cancel.');
    }
    return { canceled: true };
  }

  // ---- admin-side ---------------------------------------------------------

  async listAllRequests(status?: string) {
    const where: Prisma.LibraryEditRequestWhereInput =
      status === 'pending' ||
      status === 'approved' ||
      status === 'rejected' ||
      status === 'canceled'
        ? { status }
        : {};
    return controlDb.libraryEditRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { tenant: { select: { slug: true, name: true } } },
    });
  }

  async getRequest(id: string) {
    const req = await controlDb.libraryEditRequest.findUnique({
      where: { id },
      include: { tenant: { select: { slug: true, name: true, primaryEmail: true } } },
    });
    if (!req) throw new NotFoundException('Request not found.');
    return req;
  }

  /** Approve a pending request: apply the proposed core fields to the tenant,
   *  mark it approved, audit it, and notify the library. */
  async approve(id: string, actor: AdminAuditActor, note?: string) {
    const req = await controlDb.libraryEditRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Request not found.');
    if (req.status !== 'pending') {
      throw new BadRequestException('This request has already been decided.');
    }
    const proposed = (req.proposedJson ?? {}) as Record<string, unknown>;
    const data = this.coreUpdateFromProposed(proposed);

    await controlDb.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: req.tenantId }, data });
      // CAS on status so two concurrent approvals can't both apply.
      const decided = await tx.libraryEditRequest.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: 'approved',
          reviewedByAdminId: actor.adminId,
          decisionNote: note ?? null,
          reviewedAt: new Date(),
        },
      });
      if (decided.count === 0) {
        throw new BadRequestException('This request was just decided by someone else.');
      }
    });

    // tenant-isolation-07: `data` can carry `name`, which TenantMiddleware
    // caches for TENANT_CACHE_TTL_SEC (300s by default) and hands to every
    // request as `TenantCtx().name`. Without this, a library that has just been
    // approved for a rename keeps seeing its old name in the app header and in
    // the notification emails the outbox sends, for five minutes, on every API
    // and worker process at once. After the commit, never inside it — see
    // `invalidateById`.
    await this.tenantResolver.invalidateById(req.tenantId);

    await recordAdminAudit(actor, {
      tenantId: req.tenantId,
      action: 'library.profile.change_approved',
      targetType: 'library_edit_request',
      targetId: id,
      before: req.beforeJson as Record<string, unknown>,
      after: proposed,
    });
    await this.notifyTenantOfDecision(req.tenantId, 'approved', note).catch(() => undefined);
    return this.getRequest(id);
  }

  async reject(id: string, actor: AdminAuditActor, note?: string) {
    const decided = await controlDb.libraryEditRequest.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: 'rejected',
        reviewedByAdminId: actor.adminId,
        decisionNote: note ?? null,
        reviewedAt: new Date(),
      },
    });
    if (decided.count === 0) {
      throw new NotFoundException('No pending request to reject.');
    }
    const req = await controlDb.libraryEditRequest.findUnique({ where: { id } });
    await recordAdminAudit(actor, {
      tenantId: req?.tenantId ?? null,
      action: 'library.profile.change_rejected',
      targetType: 'library_edit_request',
      targetId: id,
      after: { decisionNote: note ?? null },
    });
    if (req)
      await this.notifyTenantOfDecision(req.tenantId, 'rejected', note).catch(() => undefined);
    return this.getRequest(id);
  }

  // ---- internals ----------------------------------------------------------

  private coreUpdateFromProposed(proposed: Record<string, unknown>): Prisma.TenantUpdateInput {
    const data: Prisma.TenantUpdateInput = {};
    for (const key of Object.keys(proposed)) {
      if (!(CORE_PROFILE_FIELDS as readonly string[]).includes(key)) continue;
      const field = key as CoreProfileField;
      const value = proposed[key];
      if (field === 'name') {
        if (typeof value === 'string' && value.trim()) data.name = value.trim();
      } else if (field === 'libraryType') {
        data.libraryType = (value as Prisma.TenantUpdateInput['libraryType']) ?? null;
      } else {
        // address* string fields
        (data as Record<string, unknown>)[field] = value == null ? null : String(value);
      }
    }
    return data;
  }

  private toDto(t: ProfileRow) {
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      libraryType: t.libraryType,
      addressStreet: t.addressStreet,
      addressCity: t.addressCity,
      addressPostalCode: t.addressPostalCode,
      addressRegion: t.addressRegion,
      addressCountry: t.addressCountry,
      publicPhone: t.publicPhone,
      publicEmail: t.publicEmail,
      website: t.website,
      description: t.description,
      foundedYear: t.foundedYear,
    };
  }

  private async notifyOwnersOfNewRequest(
    tenant: ProfileRow,
    requestId: string,
    proposed: Record<string, unknown>,
  ): Promise<void> {
    const owners = await controlDb.adminUser.findMany({
      where: { role: 'owner', status: 'active', email: { not: '' } },
      select: { email: true },
    });
    const fields = Object.keys(proposed).join(', ');
    for (const owner of owners) {
      if (!owner.email) continue;
      await this.email.enqueue({
        kind: 'library_edit_request_submitted',
        toEmail: owner.email,
        tenantId: tenant.id,
        subject: `Library change request — ${tenant.name}`,
        bodyMarkdown:
          `**${tenant.name}** (\`${tenant.slug}\`) has requested a change to core ` +
          `library details (${fields}).\n\nReview it in the admin panel under ` +
          `**Library requests**.\n\nRequest id: ${requestId}`,
        idempotencyKey: `lib-req-submit:${requestId}:${owner.email}`,
        maxAttempts: 3,
      });
    }
  }

  private async notifyTenantOfDecision(
    tenantId: string,
    decision: 'approved' | 'rejected',
    note?: string,
  ): Promise<void> {
    const tenant = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, primaryEmail: true },
    });
    if (!tenant?.primaryEmail) return;
    const verb = decision === 'approved' ? 'approved and applied' : 'not approved';
    await this.email.enqueue({
      kind: 'library_edit_request_decided',
      toEmail: tenant.primaryEmail,
      tenantId,
      subject: `Your library change request was ${decision}`,
      bodyMarkdown:
        `Your request to change your library details has been **${verb}**.` +
        (note ? `\n\nNote from the Libriant team:\n\n> ${note}` : ''),
      maxAttempts: 3,
    });
  }
}
