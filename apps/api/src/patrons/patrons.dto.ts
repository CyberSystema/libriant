import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export class CreatePatronDto {
  @trim() @IsString() @Length(1, 200) fullName!: string;
  @IsOptional() @trim() @IsString() @Length(1, 200) sortName?: string;
  /// A library that runs its own numbering may supply one. The shape CHECK on
  /// the column is the same one 1.0 enforces: uppercase, because
  /// `text_pattern_ops` cannot index a case-insensitive column at all.
  @IsOptional()
  @trim()
  @Matches(/^[A-Z0-9][A-Z0-9_-]{1,29}$/, {
    message:
      'A patron number must be uppercase letters, digits, hyphens or underscores, 2–30 characters.',
  })
  patronNumber?: string;
  @IsOptional() @trim() @IsString() @Length(1, 64) barcode?: string;
  @IsOptional() @trim() @IsEmail() email?: string;
  @IsOptional() @trim() @IsString() @Length(1, 40) phone?: string;
  @IsOptional() @IsISO8601() dateOfBirth?: string;
  @IsOptional() @IsString() @Length(1, 64) patronCategoryId?: string;
  @IsOptional() @IsString() @Length(1, 64) homeBranchId?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @trim() @IsString() @Length(0, 2000) staffNotes?: string;
}

export class ResolveCardDto {
  @trim() @IsString() @Length(1, 64) barcode!: string;
}

export class MergePatronsDto {
  /// The record that is folded away. Its id keeps resolving through
  /// `merged_into_id`, which is what makes an old card still work.
  @IsString() @Length(1, 64) loserId!: string;
  /// The record that keeps its id, and therefore every permalink pointing at it.
  @IsString() @Length(1, 64) survivorId!: string;
  @IsOptional() @trim() @IsString() @Length(0, 500) reason?: string;
}

export class PlaceBlockDto {
  @trim() @IsString() @Length(1, 500) reason!: string;
  @IsOptional() @IsIn(['block', 'warn']) severity?: 'block' | 'warn';
}

export class ClearBlockDto {
  @trim() @IsString() @Length(1, 500) reason!: string;
}

export class ReplaceCardDto {
  @trim() @IsString() @Length(1, 500) reason!: string;
  @IsOptional() @trim() @IsString() @Length(1, 64) newBarcode?: string;
}

export class SetReadingHistoryDto {
  @IsIn(['anonymised', 'kept', 'none']) mode!: 'anonymised' | 'kept' | 'none';
  @IsOptional() @IsBoolean() confirm?: boolean;
}
