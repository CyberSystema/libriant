import { IsString } from 'class-validator';

/**
 * Hard-delete confirmation. The caller must echo back the tenant's exact slug
 * — a typed-confirmation gate so a destructive, irreversible delete can't fire
 * on a stray click or a wrong id.
 */
export class DeleteTenantDto {
  @IsString()
  confirmSlug!: string;
}
