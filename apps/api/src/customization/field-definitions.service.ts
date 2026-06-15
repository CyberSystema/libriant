import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { FieldEntityKind, FieldType } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { QuotaService } from './quota.service.js';
import {
  FIELD_TYPES,
  type FieldDef,
  type FieldOptions,
  type FieldValidation,
  patternSaveError,
  validateOptions,
} from './field-types.js';

/** What the controller-facing API surfaces. */
export type FieldDefinitionDto = {
  id: string;
  entityKind: FieldEntityKind;
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

@Injectable()
export class FieldDefinitionsService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(QuotaService) private readonly quota: QuotaService,
  ) {}

  /**
   * List every definition for one entity kind, ordered by `sortOrder`.
   * Archived rows are included by default so the editor can show "recently
   * archived" too — callers can filter on `archivedAt`.
   */
  async listByEntityKind(
    tenant: TenantContext,
    entityKind: FieldEntityKind,
  ): Promise<FieldDefinitionDto[]> {
    const client = this.tenantPrisma.getClient(tenant);
    const rows = await client.fieldDefinition.findMany({
      where: { entityKind },
      orderBy: [{ sortOrder: 'asc' }, { fieldKey: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Load just the active definitions used to validate writes — never
   * returns archived rows. This is what catalog/members controllers will
   * use when validating `customFields`.
   */
  async loadActiveForValidation(
    tenant: TenantContext,
    entityKind: FieldEntityKind,
  ): Promise<FieldDef[]> {
    const client = this.tenantPrisma.getClient(tenant);
    const rows = await client.fieldDefinition.findMany({
      where: { entityKind, archivedAt: null },
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

  /**
   * Create a new field definition. Enforces:
   *   - field_key shape (also a DB CHECK; we surface a friendlier error)
   *   - type is one of the known FieldTypes
   *   - select_* fields have a valid options list
   *   - the tenant's `max_custom_fields_per_entity` quota — counts ACTIVE
   *     definitions per entity_kind (archived ones don't count)
   *   - uniqueness on (entity_kind, field_key)
   */
  async create(
    tenant: TenantContext,
    entityKind: FieldEntityKind,
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
  ): Promise<FieldDefinitionDto> {
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
    this.assertPatternSafe(input.validationJson);

    const client = this.tenantPrisma.getClient(tenant);

    // Per-entity-kind quota. Count + insert in ONE transaction, serialized by
    // an advisory lock on this entity kind, so concurrent field creates can't
    // both pass the check and overshoot the limit.
    const result = await client.$transaction(async (tx) => {
      await this.quota.enforceWithinTx(tx, {
        tenantId: tenant.id,
        featureKey: 'max_custom_fields_per_entity',
        lockContext: `entity:${entityKind}`,
        context: { entityKind },
        count: () => tx.fieldDefinition.count({ where: { entityKind, archivedAt: null } }),
      });

      // Race against the DB unique constraint — surface a 409 instead of 500.
      const existing = await tx.fieldDefinition.findUnique({
        where: { entityKind_fieldKey: { entityKind, fieldKey: input.fieldKey } },
      });
      if (existing && !existing.archivedAt) {
        throw new ConflictException(
          `A field called "${input.fieldKey}" already exists for ${entityKind}.`,
        );
      }
      // If archived row exists with the same key, restore it instead of
      // creating a duplicate. This is the gentlest UX when a librarian
      // accidentally archives a field then re-adds it.
      if (existing?.archivedAt) {
        return tx.fieldDefinition.update({
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

      return tx.fieldDefinition.create({
        data: {
          entityKind,
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
    return this.toDto(result);
  }

  /**
   * Update an existing field. Strictly limited to safe mutations:
   *   - label, sortOrder, indexed, archivedAt: free
   *   - required: free (existing values are not retro-validated)
   *   - optionsJson: free, but values must still validate
   *   - validationJson: free
   *
   * Forbidden:
   *   - changing fieldKey
   *   - changing entityKind
   *   - changing type
   *
   * Type changes that would invalidate existing data are out of scope for
   * MVP. The recommended path is: archive the old field, create a new one,
   * migrate data manually.
   */
  async update(
    tenant: TenantContext,
    entityKind: FieldEntityKind,
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
  ): Promise<FieldDefinitionDto> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.fieldDefinition.findUnique({
      where: { entityKind_fieldKey: { entityKind, fieldKey } },
    });
    if (!existing) throw new NotFoundException(`No field "${fieldKey}" on ${entityKind}.`);

    if (input.optionsJson !== undefined && input.optionsJson !== null) {
      const errs = validateOptions(input.optionsJson);
      if (errs.length) throw new BadRequestException(errs.join(' '));
    }
    // Same ReDoS / validity screen as create — an UPDATE that introduces a
    // catastrophic pattern would otherwise persist and run on every record write.
    if (input.validationJson !== undefined) this.assertPatternSafe(input.validationJson);

    const data: Record<string, unknown> = {};
    if (input.labelJson !== undefined) data.labelJson = input.labelJson;
    if (input.required !== undefined) data.required = input.required;
    if (input.optionsJson !== undefined) data.optionsJson = input.optionsJson;
    if (input.validationJson !== undefined) data.validationJson = input.validationJson;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.indexed !== undefined) data.indexed = input.indexed;
    if (input.archived !== undefined) {
      data.archivedAt = input.archived ? new Date() : null;
    }

    const updated = await client.fieldDefinition.update({
      where: { id: existing.id },
      data,
    });
    return this.toDto(updated);
  }

  /** Archive (soft-delete). Existing JSONB data is preserved. */
  async archive(
    tenant: TenantContext,
    entityKind: FieldEntityKind,
    fieldKey: string,
  ): Promise<FieldDefinitionDto> {
    return this.update(tenant, entityKind, fieldKey, { archived: true });
  }

  /**
   * Reject a field's validation pattern at save time if it doesn't compile or
   * looks catastrophic (ReDoS). Called on BOTH create and update — the pattern
   * otherwise runs on the shared event loop for every record write of this
   * entity, so one bad pattern freezes the API for all tenants. See
   * `patternLooksCatastrophic`; the match path screens again as a safety net.
   */
  private assertPatternSafe(validationJson?: FieldValidation | null): void {
    const error = patternSaveError(validationJson);
    if (error) throw new BadRequestException(error);
  }

  private toDto(row: {
    id: string;
    entityKind: FieldEntityKind;
    fieldKey: string;
    labelJson: unknown;
    type: FieldType;
    required: boolean;
    optionsJson: unknown;
    validationJson: unknown;
    sortOrder: number;
    indexed: boolean;
    archivedAt: Date | null;
  }): FieldDefinitionDto {
    return {
      id: row.id,
      entityKind: row.entityKind,
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
}
