import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { FieldType } from '@libriant/db-tenant';

/** Mirror of `collections_slug_format` (DB CHECK). */
const COLLECTION_SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,48}[a-z0-9])?$/;
/** Mirror of `collection_fields_key_format`. */
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

export class CreateCollectionDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  @Matches(COLLECTION_SLUG_RE, {
    message:
      'Use lowercase letters, digits, and hyphens (2–50 characters; no leading or trailing hyphen).',
  })
  slug!: string;

  @IsObject()
  singularLabelJson!: Record<string, string>;

  @IsObject()
  pluralLabelJson!: Record<string, string>;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  iconAssetRef?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateCollectionDto {
  @IsOptional()
  @IsObject()
  singularLabelJson?: Record<string, string>;

  @IsOptional()
  @IsObject()
  pluralLabelJson?: Record<string, string>;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  iconAssetRef?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class CreateCollectionFieldDto {
  @IsString()
  @Matches(FIELD_KEY_RE, {
    message:
      'Field name must start with a letter and use lowercase letters, digits, and underscores.',
  })
  fieldKey!: string;

  @IsObject()
  labelJson!: Record<string, string>;

  @IsString()
  type!: FieldType;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsObject()
  optionsJson?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  validationJson?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  indexed?: boolean;
}

export class UpdateCollectionFieldDto {
  @IsOptional()
  @IsObject()
  labelJson?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsObject()
  optionsJson?: Record<string, unknown> | null;

  @IsOptional()
  @IsObject()
  validationJson?: Record<string, unknown> | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  indexed?: boolean;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
