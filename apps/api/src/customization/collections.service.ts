import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { FieldType } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { QuotaService } from './quota.service.js';
import {
  FIELD_TYPES,
  type FieldDef,
  type FieldOptions,
  type FieldValidation,
  validateOptions,
} from './field-types.js';

export type CollectionFieldDto = {
  id: string;
  fieldKey: string;
  labelJson: Record<string, string>;
  type: FieldType;
  required: boolean;
  optionsJson: FieldOptions | null;
  validationJson: FieldValidation | null;
  sortOrder: number;
  indexed: boolean;
  archivedAt: Date | null;
};

export type CollectionDto = {
  id: string;
  slug: string;
  singularLabelJson: Record<string, string>;
  pluralLabelJson: Record<string, string>;
  iconAssetRef: string | null;
  sortOrder: number;
  archivedAt: Date | null;
  fields: CollectionFieldDto[];
};

@Injectable()
export class CollectionsService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  // -------- Collections ---------------------------------------------------

  async list(tenant: TenantContext): Promise<CollectionDto[]> {
    const client = this.tenantPrisma.getClient(tenant);
    const rows = await client.collection.findMany({
      include: { fields: { orderBy: [{ sortOrder: 'asc' }, { fieldKey: 'asc' }] } },
      orderBy: [{ sortOrder: 'asc' }, { slug: 'asc' }],
    });
    return rows.map((r) => this.toCollectionDto(r));
  }

  async getBySlug(tenant: TenantContext, slug: string): Promise<CollectionDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const row = await client.collection.findFirst({
      where: { slug, archivedAt: null },
      include: { fields: { orderBy: [{ sortOrder: 'asc' }, { fieldKey: 'asc' }] } },
    });
    if (!row) throw new NotFoundException(`No collection "${slug}".`);
    return this.toCollectionDto(row);
  }

  /**
   * Resolve a collection id from its slug.
   *
   * Default behavior is to ignore archived collections (matches the public
   * routes — a librarian shouldn't be able to add fields or write records
   * to an archived collection). Pass `{ includeArchived: true }` for the
   * restore path, where we need to find the archived row by slug so we
   * can flip its `archivedAt` back to null.
   */
  private async resolveCollectionId(
    tenant: TenantContext,
    slug: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<string> {
    const client = this.tenantPrisma.getClient(tenant);
    const where: { slug: string; archivedAt?: null } = { slug };
    if (!opts.includeArchived) where.archivedAt = null;
    const row = await client.collection.findFirst({ where, select: { id: true } });
    if (!row) throw new NotFoundException(`No collection "${slug}".`);
    return row.id;
  }

  async create(
    tenant: TenantContext,
    input: {
      slug: string;
      singularLabelJson: Record<string, string>;
      pluralLabelJson: Record<string, string>;
      iconAssetRef?: string | null;
      sortOrder?: number;
    },
  ): Promise<CollectionDto> {
    const client = this.tenantPrisma.getClient(tenant);

    // Count + insert in ONE transaction, serialized by a per-tenant advisory
    // lock, so parallel collection creates can't both pass the global
    // `max_custom_collections` check and overshoot it.
    const created = await client.$transaction(async (tx) => {
      await this.quota.enforceWithinTx(tx, {
        tenantId: tenant.id,
        featureKey: 'max_custom_collections',
        count: () => tx.collection.count({ where: { archivedAt: null } }),
      });

      // Slug uniqueness among active collections (DB has a partial unique index).
      const existing = await tx.collection.findFirst({
        where: { slug: input.slug, archivedAt: null },
      });
      if (existing) {
        throw new ConflictException(`A collection with the URL "${input.slug}" already exists.`);
      }

      return tx.collection.create({
        data: {
          slug: input.slug,
          singularLabelJson: input.singularLabelJson,
          pluralLabelJson: input.pluralLabelJson,
          iconAssetRef: input.iconAssetRef ?? null,
          sortOrder: input.sortOrder ?? 0,
        },
        include: { fields: true },
      });
    });
    return this.toCollectionDto(created);
  }

  async update(
    tenant: TenantContext,
    slug: string,
    input: {
      singularLabelJson?: Record<string, string>;
      pluralLabelJson?: Record<string, string>;
      iconAssetRef?: string | null;
      sortOrder?: number;
      archived?: boolean;
    },
  ): Promise<CollectionDto> {
    const client = this.tenantPrisma.getClient(tenant);
    // Restoring (archived: false) needs to find the archived row — every
    // other path is scoped to active rows only.
    const isRestore = input.archived === false;
    const id = await this.resolveCollectionId(tenant, slug, { includeArchived: isRestore });

    if (isRestore) {
      // The partial unique index `collections_slug_unique_active` is keyed
      // on `slug WHERE archivedAt IS NULL`. If another active collection
      // already claimed the slug while this one was archived, the unique
      // index would 23505 — surface a friendly error first.
      const clash = await client.collection.findFirst({
        where: { slug, archivedAt: null, NOT: { id } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(
          `Can't restore "${slug}" — another active collection already uses that URL. Rename or archive it first.`,
        );
      }
    }

    const data: Record<string, unknown> = {};
    if (input.singularLabelJson !== undefined) data.singularLabelJson = input.singularLabelJson;
    if (input.pluralLabelJson !== undefined) data.pluralLabelJson = input.pluralLabelJson;
    if (input.iconAssetRef !== undefined) data.iconAssetRef = input.iconAssetRef;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;

    const include = {
      fields: { orderBy: [{ sortOrder: 'asc' as const }, { fieldKey: 'asc' as const }] },
    };

    // Un-archiving consumes a max_custom_collections seat exactly like a create
    // — enforce it inside the same tx (archive → create → un-archive would
    // otherwise be an unlimited bypass).
    const updated = isRestore
      ? await client.$transaction(async (tx) => {
          await this.quota.enforceWithinTx(tx, {
            tenantId: tenant.id,
            featureKey: 'max_custom_collections',
            count: () => tx.collection.count({ where: { archivedAt: null } }),
          });
          return tx.collection.update({ where: { id }, data, include });
        })
      : await client.collection.update({ where: { id }, data, include });
    return this.toCollectionDto(updated);
  }

  async archive(tenant: TenantContext, slug: string): Promise<CollectionDto> {
    return this.update(tenant, slug, { archived: true });
  }

  // -------- Collection fields --------------------------------------------

  /** Active fields, formatted for the validator. */
  async loadActiveFieldsForValidation(tenant: TenantContext, slug: string): Promise<FieldDef[]> {
    const collectionId = await this.resolveCollectionId(tenant, slug);
    const client = this.tenantPrisma.getClient(tenant);
    const rows = await client.collectionField.findMany({
      where: { collectionId, archivedAt: null },
      select: {
        fieldKey: true,
        type: true,
        required: true,
        optionsJson: true,
        validationJson: true,
      },
    });
    return rows.map((r) => ({
      fieldKey: r.fieldKey,
      type: r.type,
      required: r.required,
      optionsJson: (r.optionsJson as FieldOptions | null) ?? null,
      validationJson: (r.validationJson as FieldValidation | null) ?? null,
    }));
  }

  async createField(
    tenant: TenantContext,
    slug: string,
    input: {
      fieldKey: string;
      labelJson: Record<string, string>;
      type: FieldType;
      required?: boolean;
      optionsJson?: FieldOptions | null;
      validationJson?: FieldValidation | null;
      sortOrder?: number;
      indexed?: boolean;
    },
  ): Promise<CollectionFieldDto> {
    if (!FIELD_TYPES.includes(input.type)) {
      throw new BadRequestException(`Unknown field type "${input.type}".`);
    }
    if (input.type === 'select_one' || input.type === 'select_many') {
      const errs = validateOptions(input.optionsJson ?? null);
      if (errs.length) throw new BadRequestException(errs.join(' '));
      if (!input.optionsJson?.options?.length) {
        throw new BadRequestException('Select fields need at least one option.');
      }
    }

    const collectionId = await this.resolveCollectionId(tenant, slug);
    const client = this.tenantPrisma.getClient(tenant);

    // Per-collection field quota (collection fields share the same setting as
    // built-in entities' custom fields). Count + insert in ONE transaction,
    // serialized by an advisory lock on this collection, so parallel field
    // creates can't both pass the check and overshoot the limit.
    const result = await client.$transaction(async (tx) => {
      await this.quota.enforceWithinTx(tx, {
        tenantId: tenant.id,
        featureKey: 'max_custom_fields_per_entity',
        lockContext: `collection:${collectionId}`,
        context: { collectionSlug: slug },
        count: () => tx.collectionField.count({ where: { collectionId, archivedAt: null } }),
      });

      const existing = await tx.collectionField.findUnique({
        where: { collectionId_fieldKey: { collectionId, fieldKey: input.fieldKey } },
      });
      if (existing && !existing.archivedAt) {
        throw new ConflictException(
          `A field called "${input.fieldKey}" already exists on this collection.`,
        );
      }
      if (existing?.archivedAt) {
        return tx.collectionField.update({
          where: { id: existing.id },
          data: {
            archivedAt: null,
            labelJson: input.labelJson,
            type: input.type,
            required: input.required ?? false,
            optionsJson: (input.optionsJson ?? null) as never,
            validationJson: (input.validationJson ?? null) as never,
            sortOrder: input.sortOrder ?? 0,
            indexed: input.indexed ?? false,
          },
        });
      }

      return tx.collectionField.create({
        data: {
          collectionId,
          fieldKey: input.fieldKey,
          labelJson: input.labelJson,
          type: input.type,
          required: input.required ?? false,
          optionsJson: (input.optionsJson ?? undefined) as never,
          validationJson: (input.validationJson ?? undefined) as never,
          sortOrder: input.sortOrder ?? 0,
          indexed: input.indexed ?? false,
        },
      });
    });
    return this.toFieldDto(result);
  }

  async updateField(
    tenant: TenantContext,
    slug: string,
    fieldKey: string,
    input: {
      labelJson?: Record<string, string>;
      required?: boolean;
      optionsJson?: FieldOptions | null;
      validationJson?: FieldValidation | null;
      sortOrder?: number;
      indexed?: boolean;
      archived?: boolean;
    },
  ): Promise<CollectionFieldDto> {
    const collectionId = await this.resolveCollectionId(tenant, slug);
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.collectionField.findUnique({
      where: { collectionId_fieldKey: { collectionId, fieldKey } },
    });
    if (!existing) throw new NotFoundException(`No field "${fieldKey}" on collection "${slug}".`);

    if (input.optionsJson !== undefined && input.optionsJson !== null) {
      const errs = validateOptions(input.optionsJson);
      if (errs.length) throw new BadRequestException(errs.join(' '));
    }

    const data: Record<string, unknown> = {};
    if (input.labelJson !== undefined) data.labelJson = input.labelJson;
    if (input.required !== undefined) data.required = input.required;
    if (input.optionsJson !== undefined) data.optionsJson = input.optionsJson;
    if (input.validationJson !== undefined) data.validationJson = input.validationJson;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.indexed !== undefined) data.indexed = input.indexed;
    if (input.archived !== undefined) data.archivedAt = input.archived ? new Date() : null;

    const updated = await client.collectionField.update({
      where: { id: existing.id },
      data,
    });
    return this.toFieldDto(updated);
  }

  async archiveField(
    tenant: TenantContext,
    slug: string,
    fieldKey: string,
  ): Promise<CollectionFieldDto> {
    return this.updateField(tenant, slug, fieldKey, { archived: true });
  }

  // -------- DTO mappers --------------------------------------------------

  private toFieldDto(row: {
    id: string;
    fieldKey: string;
    labelJson: unknown;
    type: FieldType;
    required: boolean;
    optionsJson: unknown;
    validationJson: unknown;
    sortOrder: number;
    indexed: boolean;
    archivedAt: Date | null;
  }): CollectionFieldDto {
    return {
      id: row.id,
      fieldKey: row.fieldKey,
      labelJson: (row.labelJson as Record<string, string>) ?? {},
      type: row.type,
      required: row.required,
      optionsJson: (row.optionsJson as FieldOptions | null) ?? null,
      validationJson: (row.validationJson as FieldValidation | null) ?? null,
      sortOrder: row.sortOrder,
      indexed: row.indexed,
      archivedAt: row.archivedAt,
    };
  }

  private toCollectionDto(row: {
    id: string;
    slug: string;
    singularLabelJson: unknown;
    pluralLabelJson: unknown;
    iconAssetRef: string | null;
    sortOrder: number;
    archivedAt: Date | null;
    fields: Array<Parameters<CollectionsService['toFieldDto']>[0]>;
  }): CollectionDto {
    return {
      id: row.id,
      slug: row.slug,
      singularLabelJson: (row.singularLabelJson as Record<string, string>) ?? {},
      pluralLabelJson: (row.pluralLabelJson as Record<string, string>) ?? {},
      iconAssetRef: row.iconAssetRef,
      sortOrder: row.sortOrder,
      archivedAt: row.archivedAt,
      fields: row.fields.map((f) => this.toFieldDto(f)),
    };
  }
}
