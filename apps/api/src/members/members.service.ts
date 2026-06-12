import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { MemberStatus, Prisma } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { FieldDefinitionsService } from '../customization/field-definitions.service.js';
import { QuotaService } from '../customization/quota.service.js';
import { validateRecordOrThrow } from '../customization/dynamic-validator.js';
import { buildSearchText, normalizeText } from '../catalog/normalize.js';
import { buildMemberNumber, nextSequenceForYear } from './member-numbers.js';

export type MemberDto = {
  id: string;
  memberNumber: string;
  fullName: string;
  sortName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  photoAssetRef: string | null;
  status: MemberStatus;
  staffNotes: string | null;
  joinedAt: Date;
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type MemberWithCirculationDto = MemberDto & {
  circulation: {
    activeLoans: number;
    activeReservations: number;
    outstandingFinesCents: number;
  };
};

export type ListMembersOptions = {
  q?: string;
  status?: MemberStatus;
  after?: string;
  limit?: number;
  includeArchived?: boolean;
};

@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(FieldDefinitionsService) private readonly fieldDefs: FieldDefinitionsService,
    @Inject(QuotaService) private readonly quota: QuotaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
  ) {}

  /** Small JSON-safe snapshot of a member for audit before/after diffs. */
  private memberSnapshot(m: {
    memberNumber: string;
    fullName: string;
    status: MemberStatus;
    email: string | null;
    archivedAt: Date | null;
  }): Record<string, unknown> {
    return {
      memberNumber: m.memberNumber,
      fullName: m.fullName,
      status: m.status,
      email: m.email,
      archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
    };
  }

  /** Audit a freshly-created member, then return its DTO (single create exit). */
  private async auditCreated(
    tenant: TenantContext,
    actorId: string,
    created: Parameters<MembersService['toDto']>[0],
  ): Promise<MemberDto> {
    await this.audit.record(tenant, {
      action: 'member.created',
      actorId,
      targetType: 'member',
      targetId: created.id,
      after: this.memberSnapshot(created),
    });
    return this.toDto(created);
  }

  async list(
    tenant: TenantContext,
    opts: ListMembersOptions = {},
  ): Promise<{ items: MemberDto[]; nextCursor: string | null }> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: Prisma.MemberWhereInput = {};
    if (!opts.includeArchived) where.archivedAt = null;
    if (opts.status) where.status = opts.status;
    if (opts.q) where.searchText = { contains: normalizeText(opts.q) };

    const rows = await client.member.findMany({
      where,
      orderBy: [{ sortName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => this.toDto(r));
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async get(tenant: TenantContext, id: string): Promise<MemberWithCirculationDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const row = await client.member.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Member not found.');
    const [activeLoans, activeReservations, outstanding] = await Promise.all([
      // "Active" = the copy is physically still with the member. Lost loans
      // also have `returnedAt IS NULL` but they're closed business — the
      // copy is gone, the fine is tracked separately, and they shouldn't
      // block archive.
      client.loan.count({ where: { memberId: id, status: 'active' } }),
      client.reservation.count({
        where: { memberId: id, status: { in: ['queued', 'ready'] } },
      }),
      client.fine.aggregate({
        where: { memberId: id, status: 'outstanding' },
        _sum: { amountCents: true },
      }),
    ]);
    return {
      ...this.toDto(row),
      circulation: {
        activeLoans,
        activeReservations,
        outstandingFinesCents: outstanding._sum.amountCents ?? 0,
      },
    };
  }

  async create(
    tenant: TenantContext,
    input: {
      memberNumber?: string;
      fullName: string;
      sortName?: string;
      email?: string;
      phone?: string;
      dateOfBirth?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      postalCode?: string;
      country?: string;
      staffNotes?: string;
      customFields?: Record<string, unknown>;
    },
    actorId: string,
  ): Promise<MemberDto> {
    // 1. Custom fields validation.
    const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'member');
    const cleanedCustom = validateRecordOrThrow(defs, input.customFields ?? {}, {
      unknownFields: 'reject',
    });

    // 2. Compute sortName + searchText.
    const sortName = input.sortName ? normalizeText(input.sortName) : normalizeText(input.fullName);
    const searchText = buildSearchText([
      input.fullName,
      sortName,
      input.email,
      input.phone,
      input.city,
    ]);

    // 3. Decide on memberNumber. If supplied, use it (uniqueness check via
    //    DB partial unique index). Otherwise auto-generate, retrying on
    //    races for up to 3 attempts.
    const client = this.tenantPrisma.getClient(tenant);
    const year = new Date().getUTCFullYear();
    const baseData = {
      fullName: input.fullName,
      sortName,
      searchText,
      email: input.email ?? null,
      phone: input.phone ?? null,
      dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      staffNotes: input.staffNotes ?? null,
      customFields: cleanedCustom as Prisma.InputJsonValue,
    } as const;

    // Enforce `max_members` and insert in ONE transaction, serialized by a
    // per-tenant advisory lock, so parallel creates can't both pass the quota
    // check and push the tenant past its plan ceiling. The lock also
    // serializes member-number assignment, but the retry loop stays as a
    // belt-and-braces guard against any residual sequence race.
    const createWithQuota = (memberNumber: string) =>
      client.$transaction(async (tx) => {
        await this.quota.enforceWithinTx(tx, {
          tenantId: tenant.id,
          featureKey: 'max_members',
          count: () =>
            tx.member.count({ where: { archivedAt: null, status: { not: 'archived' } } }),
        });
        return tx.member.create({ data: { ...baseData, memberNumber } });
      });

    if (input.memberNumber) {
      try {
        const created = await createWithQuota(input.memberNumber);
        return this.auditCreated(tenant, actorId, created);
      } catch (err) {
        throw this.translateCreateError(err);
      }
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const seq = await nextSequenceForYear(client, year);
      const memberNumber = buildMemberNumber(year, seq);
      try {
        const created = await createWithQuota(memberNumber);
        return this.auditCreated(tenant, actorId, created);
      } catch (err) {
        lastErr = err;
        if (!this.isUniqueViolation(err)) {
          throw this.translateCreateError(err);
        }
        this.logger.debug(
          `Member-number race on ${memberNumber} (attempt ${attempt + 1}); retrying.`,
        );
      }
    }
    throw this.translateCreateError(lastErr ?? new Error('Member-number generation gave up.'));
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: {
      memberNumber?: string;
      fullName?: string;
      sortName?: string;
      email?: string | null;
      phone?: string | null;
      dateOfBirth?: string | null;
      addressLine1?: string | null;
      addressLine2?: string | null;
      city?: string | null;
      postalCode?: string | null;
      country?: string | null;
      staffNotes?: string | null;
      customFields?: Record<string, unknown>;
      archived?: boolean;
    },
    actorId: string,
  ): Promise<MemberDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.member.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Member not found.');

    let cleanedCustom: Record<string, unknown> | undefined;
    if (input.customFields !== undefined) {
      const defs = await this.fieldDefs.loadActiveForValidation(tenant, 'member');
      cleanedCustom = validateRecordOrThrow(defs, input.customFields, {
        unknownFields: 'reject',
        partial: true,
      });
    }

    // Recompute sortName + searchText if any contributing field changed.
    const fullNameAfter = input.fullName ?? existing.fullName;
    const sortNameAfter =
      input.sortName !== undefined
        ? normalizeText(input.sortName)
        : input.fullName !== undefined
          ? normalizeText(input.fullName)
          : existing.sortName;
    const emailAfter = input.email === undefined ? existing.email : input.email;
    const phoneAfter = input.phone === undefined ? existing.phone : input.phone;
    const cityAfter = input.city === undefined ? existing.city : input.city;
    const searchText = buildSearchText([
      fullNameAfter,
      sortNameAfter,
      emailAfter,
      phoneAfter,
      cityAfter,
    ]);

    const data: Prisma.MemberUpdateInput = { sortName: sortNameAfter, searchText };
    if (input.memberNumber !== undefined) data.memberNumber = input.memberNumber;
    if (input.fullName !== undefined) data.fullName = input.fullName;
    if (input.email !== undefined) data.email = input.email;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.dateOfBirth !== undefined) {
      data.dateOfBirth = input.dateOfBirth === null ? null : new Date(input.dateOfBirth);
    }
    if (input.addressLine1 !== undefined) data.addressLine1 = input.addressLine1;
    if (input.addressLine2 !== undefined) data.addressLine2 = input.addressLine2;
    if (input.city !== undefined) data.city = input.city;
    if (input.postalCode !== undefined) data.postalCode = input.postalCode;
    if (input.country !== undefined) data.country = input.country;
    if (input.staffNotes !== undefined) data.staffNotes = input.staffNotes;
    if (cleanedCustom !== undefined) {
      data.customFields = {
        ...((existing.customFields as Record<string, unknown>) ?? {}),
        ...cleanedCustom,
      } as Prisma.InputJsonValue;
    }
    if (input.archived !== undefined) {
      if (input.archived) {
        // Restore-only via this flag (legacy path); the dedicated archive()
        // method runs the active-loans safety check before archiving.
        throw new BadRequestException(
          'Use DELETE /members/:id to archive (we check for active loans first). PATCH archived=true is reserved for restoring.',
        );
      }
      // archived: false → restore
      if (existing.archivedAt) {
        data.archivedAt = null;
        data.status = 'active';
      }
    }

    try {
      const updated = await client.member.update({ where: { id }, data });
      await this.audit.record(tenant, {
        action: 'member.updated',
        actorId,
        targetType: 'member',
        targetId: id,
        before: this.memberSnapshot(existing),
        after: this.memberSnapshot(updated),
      });
      return this.toDto(updated);
    } catch (err) {
      throw this.translateCreateError(err);
    }
  }

  /**
   * Set status to `active` or `suspended`. Archiving lives on the
   * dedicated `archive()` path so we can run the loans safety check.
   * Refuses `archived` here; clients must use DELETE.
   */
  async setStatus(
    tenant: TenantContext,
    id: string,
    input: { status: 'active' | 'suspended'; reason?: string },
    actorId: string,
  ): Promise<MemberDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.member.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Member not found.');
    if (existing.archivedAt) {
      throw new BadRequestException(
        'This member is archived. Restore them first (PATCH archived=false).',
      );
    }
    const noteAddition =
      input.reason && input.reason.trim().length
        ? `\n[${new Date().toISOString()}] status → ${input.status}: ${input.reason.trim()}`
        : '';
    const updated = await client.member.update({
      where: { id },
      data: {
        status: input.status,
        staffNotes: noteAddition ? (existing.staffNotes ?? '') + noteAddition : undefined,
      },
    });
    await this.audit.record(tenant, {
      action: 'member.status_changed',
      actorId,
      targetType: 'member',
      targetId: id,
      before: { status: existing.status },
      after: { status: updated.status, reason: input.reason?.trim() || null },
    });
    return this.toDto(updated);
  }

  /**
   * Archive a member. Refuses when there are open loans or active
   * reservations: the librarian must close them first. Outstanding fines
   * are flagged but do not block archive — collecting them is a separate
   * back-office flow.
   */
  async archive(tenant: TenantContext, id: string, actorId: string): Promise<MemberDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.member.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Member not found.');
    if (existing.archivedAt) {
      return this.toDto(existing);
    }

    const [activeLoans, activeReservations] = await Promise.all([
      client.loan.count({ where: { memberId: id, status: 'active' } }),
      client.reservation.count({
        where: { memberId: id, status: { in: ['queued', 'ready'] } },
      }),
    ]);
    if (activeLoans > 0 || activeReservations > 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: `Can't archive a member with open business. Resolve these first.`,
        activeLoans,
        activeReservations,
      });
    }

    const updated = await client.member.update({
      where: { id },
      data: { archivedAt: new Date(), status: 'archived' },
    });
    await this.audit.record(tenant, {
      action: 'member.archived',
      actorId,
      targetType: 'member',
      targetId: id,
      before: this.memberSnapshot(existing),
      after: this.memberSnapshot(updated),
    });
    return this.toDto(updated);
  }

  // -------- internals -----------------------------------------------------

  private translateCreateError(err: unknown): Error {
    // Let deliberate HTTP errors (e.g. the 402 from the in-transaction quota
    // gate) propagate untouched.
    if (err instanceof HttpException) return err;
    if (this.isUniqueViolation(err)) {
      return new ConflictException(
        'A member with this number (or email) already exists. Archive the old record first if you want to re-use the number.',
      );
    }
    if (typeof err === 'object' && err !== null) {
      const message = (err as { message?: string }).message ?? '';
      const m = message.match(/violates check constraint "([^"]+)"/);
      if (m) {
        return new BadRequestException(
          `The database rejected the value (${m[1]}). Please double-check the highlighted fields.`,
        );
      }
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private isUniqueViolation(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const code = (err as { code?: string }).code;
    if (code === 'P2002') return true;
    const msg = (err as { message?: string }).message ?? '';
    return /duplicate key value violates unique constraint/i.test(msg);
  }

  private toDto(row: {
    id: string;
    memberNumber: string;
    fullName: string;
    sortName: string;
    email: string | null;
    phone: string | null;
    dateOfBirth: Date | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
    photoAssetRef: string | null;
    status: MemberStatus;
    staffNotes: string | null;
    joinedAt: Date;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
  }): MemberDto {
    return {
      id: row.id,
      memberNumber: row.memberNumber,
      fullName: row.fullName,
      sortName: row.sortName,
      email: row.email,
      phone: row.phone,
      dateOfBirth: row.dateOfBirth,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      postalCode: row.postalCode,
      country: row.country,
      photoAssetRef: row.photoAssetRef,
      status: row.status,
      staffNotes: row.staffNotes,
      joinedAt: row.joinedAt,
      customFields: (row.customFields as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }
}
