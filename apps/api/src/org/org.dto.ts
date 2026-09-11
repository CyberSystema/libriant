import { IsIn, IsOptional, IsString, Length } from 'class-validator';

/**
 * `'1' | 'true'`, and nothing else (2.0 phase 20a).
 *
 * NOT `@IsBoolean`. A query string has no types, and class-transformer's boolean
 * coercion turns the STRING `"false"` into `true` — so `?includeArchived=false`
 * would mean the opposite of what it says. Every 1.0 controller accepts exactly
 * these two literals and the 2.0 routes match them, so a link that works today
 * works after the cutover.
 */
export const TRUTHY = ['1', 'true'] as const;

export class BranchListQueryDto {
  @IsOptional() @IsIn(TRUTHY) includeArchived?: string;
}

export class LocationListQueryDto {
  @IsOptional() @IsString() @Length(1, 64) branchId?: string;
  @IsOptional() @IsIn(TRUTHY) includeArchived?: string;
}
