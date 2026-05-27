import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Matches, Min } from 'class-validator';
import { FieldType } from '@libriant/db-tenant';

/**
 * `field_key` regex matches the DB CHECK constraint exactly:
 *   start with [a-z], then [a-z0-9_], 2-50 chars total.
 */
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,49}$/;

export class CreateFieldDefinitionDto {
  @IsString()
  @Matches(FIELD_KEY_RE, {
    message:
      'Field name must start with a letter and use lowercase letters, digits, and underscores (e.g. "shelf_section").',
  })
  fieldKey!: string;

  /**
   * `{ en: "Shelf section", el: "Τομέας ραφιού" }`. We don't strictly
   * require both locales — the UI will fall back to whichever exists.
   */
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

export class UpdateFieldDefinitionDto {
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

  /** Set to true to archive (hide from new records); false to restore. */
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
