import { IsIn, IsOptional, IsString } from 'class-validator';
import type { ExportFormat, ExportScope } from '@libriant/db-control';

/**
 * Every value of the `ExportFormat` enum, by hand.
 *
 * It duplicates the Prisma enum because `class-validator`'s `@IsIn` needs a
 * runtime array and a Prisma enum is a type. `export-format.spec.ts` asserts the
 * two agree as sets, so the drift this invites — a value the database accepts
 * and the DTO refuses, which surfaces as an unexplainable 400 — is a build
 * failure instead.
 */
export const EXPORT_FORMATS = ['csv', 'json', 'xlsx', 'sql', 'catalog_marc'] as const;
const SCOPES = ['tenant', 'control', 'all'] as const;

/** The message both DTOs give, derived rather than restated. */
const FORMAT_MESSAGE = `format must be one of: ${EXPORT_FORMATS.join(', ')}`;

/** A library admin exporting their own library — scope is implicitly `tenant`. */
export class CreateTenantExportDto {
  @IsIn(EXPORT_FORMATS, { message: FORMAT_MESSAGE })
  format!: ExportFormat;
}

/** Owner admin export — a library, the control DB, or everything. */
export class CreateAdminExportDto {
  @IsIn(EXPORT_FORMATS, { message: FORMAT_MESSAGE })
  format!: ExportFormat;

  @IsIn(SCOPES, { message: 'scope must be one of: tenant, control, all' })
  scope!: ExportScope;

  /** Required when scope = tenant. */
  @IsOptional()
  @IsString()
  tenantId?: string;
}
