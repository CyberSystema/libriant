import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

export const COPY_STATUSES = [
  'available',
  'on_loan',
  'reserved',
  'lost',
  'damaged',
  'withdrawn',
] as const;

/**
 * Mirror of nothing the DB enforces — but a reasonable shape barcode users
 * tend to enter. Letters/digits/-_/period, 1-64 chars.
 */
const BARCODE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export class CreateCopyDto {
  @IsString()
  @Matches(BARCODE_RE, {
    message: 'Barcodes use letters, digits, dashes, dots, or underscores (max 64 characters).',
  })
  barcode!: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  shelfLocation?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  conditionNotes?: string;

  @IsOptional()
  @IsDateString()
  acquiredAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateCopyDto {
  @IsOptional()
  @IsString()
  @Matches(BARCODE_RE)
  barcode?: string;

  @IsOptional()
  @IsIn(COPY_STATUSES as readonly string[])
  status?: (typeof COPY_STATUSES)[number];

  @IsOptional()
  @IsString()
  @Length(0, 200)
  shelfLocation?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  conditionNotes?: string | null;

  @IsOptional()
  @IsDateString()
  acquiredAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number | null;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
