import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

/** A single author binding on a book — the body of a `book_authors` row. */
export class BookAuthorLinkDto {
  @IsString()
  authorId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  role?: string;
}

export class CreateBookDto {
  @IsString()
  @Length(1, 500)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  subtitle?: string;

  /** Will be normalized to digits-only before persisting. */
  @IsOptional()
  @IsString()
  @Length(0, 20)
  isbn13?: string;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  isbn10?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  publisher?: string;

  @IsOptional()
  @IsInt()
  publicationYear?: number;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  language?: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  edition?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  numPages?: number;

  @IsOptional()
  @IsString()
  @Length(0, 10000)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  coverAssetRef?: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  classification?: string;

  /**
   * Author links. Empty array means "no authors" — explicitly allowed
   * for compilations, anonymous works, etc.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BookAuthorLinkDto)
  authors?: BookAuthorLinkDto[];

  /** Validated against active FieldDefinitions for entity_kind='book'. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateBookDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  subtitle?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  isbn13?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  isbn10?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  publisher?: string | null;

  @IsOptional()
  @IsInt()
  publicationYear?: number | null;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  language?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  edition?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  numPages?: number | null;

  @IsOptional()
  @IsString()
  @Length(0, 10000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  coverAssetRef?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  classification?: string | null;

  /** Provided → REPLACE the link list. Omitted → leave existing intact. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BookAuthorLinkDto)
  authors?: BookAuthorLinkDto[];

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
