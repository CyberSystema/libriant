import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { normalizeText } from './normalize.js';

export type AuthorDto = {
  id: string;
  fullName: string;
  sortName: string;
  isOrganization: boolean;
  birthYear: number | null;
  deathYear: number | null;
  notes: string | null;
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type ListAuthorsOptions = {
  /** Fuzzy match on `sortName` (lowercased + accent-folded by writers). */
  q?: string;
  after?: string;
  limit?: number;
  includeArchived?: boolean;
};

@Injectable()
export class AuthorsService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  async list(
    tenant: TenantContext,
    opts: ListAuthorsOptions = {},
  ): Promise<{ items: AuthorDto[]; nextCursor: string | null }> {
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: Prisma.AuthorWhereInput = {};
    if (!opts.includeArchived) where.archivedAt = null;
    if (opts.q) where.sortName = { contains: normalizeText(opts.q) };
    const rows = await client.author.findMany({
      where,
      orderBy: [{ sortName: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => this.toDto(r));
    return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
  }

  async get(tenant: TenantContext, id: string): Promise<AuthorDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const row = await client.author.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Author not found.');
    return this.toDto(row);
  }

  async create(
    tenant: TenantContext,
    input: {
      fullName: string;
      isOrganization?: boolean;
      birthYear?: number;
      deathYear?: number;
      notes?: string;
      customFields?: Record<string, unknown>;
    },
  ): Promise<AuthorDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const created = await client.author.create({
      data: {
        fullName: input.fullName,
        sortName: normalizeText(input.fullName),
        isOrganization: input.isOrganization ?? false,
        birthYear: input.birthYear ?? null,
        deathYear: input.deathYear ?? null,
        notes: input.notes ?? null,
        customFields: (input.customFields ?? {}) as Prisma.InputJsonValue,
      },
    });
    return this.toDto(created);
  }

  async update(
    tenant: TenantContext,
    id: string,
    input: {
      fullName?: string;
      isOrganization?: boolean;
      birthYear?: number;
      deathYear?: number;
      notes?: string;
      customFields?: Record<string, unknown>;
      archived?: boolean;
    },
  ): Promise<AuthorDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.author.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Author not found.');
    const data: Prisma.AuthorUpdateInput = {};
    if (input.fullName !== undefined) {
      data.fullName = input.fullName;
      data.sortName = normalizeText(input.fullName);
    }
    if (input.isOrganization !== undefined) data.isOrganization = input.isOrganization;
    if (input.birthYear !== undefined) data.birthYear = input.birthYear;
    if (input.deathYear !== undefined) data.deathYear = input.deathYear;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.customFields !== undefined) {
      data.customFields = input.customFields as Prisma.InputJsonValue;
    }
    if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;
    const updated = await client.author.update({ where: { id }, data });
    return this.toDto(updated);
  }

  async archive(tenant: TenantContext, id: string): Promise<AuthorDto> {
    return this.update(tenant, id, { archived: true });
  }

  /** Used by BooksService to verify supplied author IDs exist + are active. */
  async requireExist(tenant: TenantContext, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const client = this.tenantPrisma.getClient(tenant);
    const rows = await client.author.findMany({
      where: { id: { in: ids }, archivedAt: null },
      select: { id: true },
    });
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new NotFoundException(
        `These authors don't exist (or were archived): ${missing.join(', ')}.`,
      );
    }
  }

  private toDto(row: {
    id: string;
    fullName: string;
    sortName: string;
    isOrganization: boolean;
    birthYear: number | null;
    deathYear: number | null;
    notes: string | null;
    customFields: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
  }): AuthorDto {
    return {
      id: row.id,
      fullName: row.fullName,
      sortName: row.sortName,
      isOrganization: row.isOrganization,
      birthYear: row.birthYear,
      deathYear: row.deathYear,
      notes: row.notes,
      customFields: (row.customFields as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }
}
