import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@libriant/db-tenant';
import { normalizeText } from '../catalog/normalize.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { CollectionsService } from './collections.service.js';
import { QuotaService } from './quota.service.js';
import { validateRecordOrThrow } from './dynamic-validator.js';

export type CollectionRecordDto = {
  id: string;
  collectionId: string;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type ListRecordsOptions = {
  /** Cursor — `id` of the last record from the previous page. */
  after?: string;
  /** 1-100, defaults to 25. */
  limit?: number;
  /** Plain-text search against `searchText` (lowercased + accent-folded by the writer). */
  q?: string;
  /** Default behavior is to hide archived records. */
  includeArchived?: boolean;
};

@Injectable()
export class CollectionRecordsService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  /**
   * Paged list. Cursor-based on `id` for stable pagination as new records
   * arrive. Trigram search on `searchText` is GIN-indexed at the DB level.
   */
  async list(
    tenant: TenantContext,
    cslug: string,
    opts: ListRecordsOptions = {},
  ): Promise<{ items: CollectionRecordDto[]; nextCursor: string | null }> {
    const collectionId = await this.requireCollection(tenant, cslug);
    const client = this.tenantPrisma.getClient(tenant);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
    const where: Prisma.CollectionRecordWhereInput = { collectionId };
    if (!opts.includeArchived) where.archivedAt = null;
    if (opts.q) {
      // The writer normalizes to lowercase + NFD + diacritic-strip; the
      // reader has to do the same fold or Greek queries like "πατα" miss
      // records containing "πάτα". The GIN trigram index on the column
      // accelerates the contains lookup.
      where.searchText = { contains: normalizeText(opts.q) };
    }
    const rows = await client.collectionRecord.findMany({
      where,
      orderBy: { id: 'asc' },
      take: limit + 1,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => this.toDto(r));
    const nextCursor = hasMore ? items[items.length - 1]!.id : null;
    return { items, nextCursor };
  }

  async get(tenant: TenantContext, cslug: string, id: string): Promise<CollectionRecordDto> {
    const collectionId = await this.requireCollection(tenant, cslug);
    const client = this.tenantPrisma.getClient(tenant);
    const row = await client.collectionRecord.findFirst({ where: { id, collectionId } });
    if (!row) throw new NotFoundException(`Record not found.`);
    return this.toDto(row);
  }

  /**
   * Create. Validates the payload against the collection's ACTIVE field
   * definitions, enforces `max_records_per_collection`, then inserts.
   */
  async create(
    tenant: TenantContext,
    cslug: string,
    rawBody: unknown,
    createdByUserId: string | null,
  ): Promise<CollectionRecordDto> {
    const collectionId = await this.requireCollection(tenant, cslug);
    const defs = await this.collections.loadActiveFieldsForValidation(tenant, cslug);
    const cleaned = validateRecordOrThrow(defs, rawBody);

    const client = this.tenantPrisma.getClient(tenant);
    // Count + insert in ONE transaction, serialized by an advisory lock on
    // this collection, so concurrent record creates can't both pass the
    // per-collection limit check and overshoot it.
    const created = await client.$transaction(async (tx) => {
      await this.quota.enforceWithinTx(tx, {
        tenantId: tenant.id,
        featureKey: 'max_records_per_collection',
        lockContext: collectionId,
        context: { collectionSlug: cslug },
        count: () => tx.collectionRecord.count({ where: { collectionId, archivedAt: null } }),
      });
      return tx.collectionRecord.create({
        data: {
          collectionId,
          data: cleaned as Prisma.InputJsonValue,
          searchText: this.buildSearchText(cleaned),
          createdByUserId,
        },
      });
    });
    return this.toDto(created);
  }

  /**
   * Patch. Partial updates respect each field's current definitions — but
   * we relax `required` so the client doesn't have to repeat unchanged
   * values. Unknown keys are still rejected.
   */
  async update(
    tenant: TenantContext,
    cslug: string,
    id: string,
    rawBody: unknown,
  ): Promise<CollectionRecordDto> {
    const collectionId = await this.requireCollection(tenant, cslug);
    const defs = await this.collections.loadActiveFieldsForValidation(tenant, cslug);
    const cleaned = validateRecordOrThrow(defs, rawBody, { partial: true });

    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.collectionRecord.findFirst({ where: { id, collectionId } });
    if (!existing) throw new NotFoundException(`Record not found.`);

    // Merge into existing data so partial updates don't wipe other fields.
    const merged = {
      ...((existing.data as Record<string, unknown>) ?? {}),
      ...cleaned,
    };
    const updated = await client.collectionRecord.update({
      where: { id },
      data: {
        data: merged as Prisma.InputJsonValue,
        searchText: this.buildSearchText(merged),
      },
    });
    return this.toDto(updated);
  }

  /** Archive (soft-delete). */
  async archive(tenant: TenantContext, cslug: string, id: string): Promise<CollectionRecordDto> {
    const collectionId = await this.requireCollection(tenant, cslug);
    const client = this.tenantPrisma.getClient(tenant);
    const updated = await client.collectionRecord.updateMany({
      where: { id, collectionId },
      data: { archivedAt: new Date() },
    });
    if (updated.count !== 1) throw new NotFoundException(`Record not found.`);
    const row = await client.collectionRecord.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Record not found.`);
    return this.toDto(row);
  }

  // -------- internals -----------------------------------------------------

  private async requireCollection(tenant: TenantContext, cslug: string): Promise<string> {
    const c = await this.collections.getBySlug(tenant, cslug);
    return c.id;
  }

  /**
   * Lowercased + accent-folded composite of all string-ish field values.
   * Used by the GIN trigram index for fuzzy search. The accent fold runs
   * on the JS side via the shared `normalizeText` helper so the reader
   * and writer always agree on the canonical form.
   */
  private buildSearchText(data: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const v of Object.values(data)) {
      if (typeof v === 'string') parts.push(v);
      else if (typeof v === 'number') parts.push(String(v));
      else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
    }
    return normalizeText(parts.join(' '));
  }

  private toDto(row: {
    id: string;
    collectionId: string;
    data: unknown;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
  }): CollectionRecordDto {
    return {
      id: row.id,
      collectionId: row.collectionId,
      data: (row.data as Record<string, unknown>) ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      archivedAt: row.archivedAt,
    };
  }
}
