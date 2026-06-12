import { IsIn, IsOptional, IsString } from 'class-validator';
import type { ExportFormat, ExportScope } from '@libriant/db-control';

export const EXPORT_FORMATS = ['csv', 'json', 'xlsx', 'sql'] as const;
const SCOPES = ['tenant', 'control', 'all'] as const;

/** A library admin exporting their own library — scope is implicitly `tenant`. */
export class CreateTenantExportDto {
  @IsIn(EXPORT_FORMATS, { message: 'format must be one of: csv, json, xlsx, sql' })
  format!: ExportFormat;
}

/** Owner admin export — a library, the control DB, or everything. */
export class CreateAdminExportDto {
  @IsIn(EXPORT_FORMATS, { message: 'format must be one of: csv, json, xlsx, sql' })
  format!: ExportFormat;

  @IsIn(SCOPES, { message: 'scope must be one of: tenant, control, all' })
  scope!: ExportScope;

  /** Required when scope = tenant. */
  @IsOptional()
  @IsString()
  tenantId?: string;
}
