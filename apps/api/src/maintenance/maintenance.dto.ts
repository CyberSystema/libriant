import { IsIn, IsOptional, IsString } from 'class-validator';
import type { MaintenanceKind, MaintenanceScope } from '@libriant/db-control';

const KINDS = ['diagnostics', 'migrate', 'fix', 'vacuum'] as const;
const SCOPES = ['tenant', 'control', 'all'] as const;

export class StartMaintenanceDto {
  @IsIn(KINDS, { message: 'kind must be one of: diagnostics, migrate, fix, vacuum' })
  kind!: MaintenanceKind;

  @IsIn(SCOPES, { message: 'scope must be one of: tenant, control, all' })
  scope!: MaintenanceScope;

  /** Required when scope = tenant. */
  @IsOptional()
  @IsString()
  tenantId?: string;
}
