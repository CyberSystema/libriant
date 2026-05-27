import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Length } from 'class-validator';

export class CreateAuthorDto {
  @IsString()
  @Length(1, 200)
  fullName!: string;

  @IsOptional()
  @IsBoolean()
  isOrganization?: boolean;

  @IsOptional()
  @IsInt()
  birthYear?: number;

  @IsOptional()
  @IsInt()
  deathYear?: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateAuthorDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  fullName?: string;

  @IsOptional()
  @IsBoolean()
  isOrganization?: boolean;

  @IsOptional()
  @IsInt()
  birthYear?: number;

  @IsOptional()
  @IsInt()
  deathYear?: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  /** Toggle archive on / off. Soft-delete; can be restored. */
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
