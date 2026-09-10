import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

const LEVELS = ['title', 'volume', 'item'] as const;
const REQUEST_TYPES = ['page', 'hold', 'recall'] as const;

/**
 * A CIVIL date, `YYYY-MM-DD`, and never an ISO 8601 instant.
 *
 * `@IsISO8601()` would accept `2026-09-15T00:00:00Z`, which is a moment and not
 * a day — and a suspension is a day: "back on the 3rd" is true in every zone,
 * while an instant makes it true at 02:00 in one and 23:00 in another. The
 * column is `@db.Date` for the same reason, so accepting an instant here would
 * mean silently discarding the half of the value the caller thought mattered.
 */
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Asking for a book.
 *
 * `bibId` OR `itemId` — a title request names the record, an item request names
 * the copy, and the level is derived when the caller does not say. Both are
 * accepted because both are real: the OPAC has a record in front of the reader
 * and a desk sometimes has the physical copy.
 */
export class PlaceHoldDto {
  @IsOptional() @IsString() @Length(1, 64) patronId?: string;
  @IsOptional() @trim() @IsString() @Length(1, 64) patronBarcode?: string;
  @IsOptional() @IsString() @Length(1, 64) bibId?: string;
  @IsOptional() @IsString() @Length(1, 64) itemId?: string;
  @IsOptional() @IsIn(LEVELS) level?: (typeof LEVELS)[number];
  @IsOptional() @trim() @IsString() @Length(1, 128) volume?: string;
  @IsString() @Length(1, 64) pickupBranchId!: string;
  @IsOptional() @IsIn(REQUEST_TYPES) requestType?: (typeof REQUEST_TYPES)[number];
  /**
   * The librarian's thumb on the scale, bounded.
   *
   * Unbounded it is an integer column a UI would eventually use as a sort key,
   * and a "move to top" button that writes `Date.now()` into it is exactly how
   * priority stops meaning anything. Small range, deliberately: it is an
   * exception mechanism, not an ordering.
   */
  @IsOptional() @IsInt() @Min(-100) @Max(100) priority?: number;
  @IsOptional() @Matches(CIVIL_DATE) suspendedUntil?: string;
  @IsOptional() @IsString() @Length(1, 64) groupId?: string;
  @IsOptional() @trim() @IsString() @Length(0, 2000) notes?: string;
}

export class CancelHoldDto {
  @IsOptional() @trim() @IsString() @Length(0, 500) reason?: string;
}

export class SuspendHoldDto {
  /** Omit for an open-ended suspension the reader lifts themselves. */
  @IsOptional() @Matches(CIVIL_DATE) until?: string;
}

export class PrioritiseHoldDto {
  @IsInt() @Min(-100) @Max(100) priority!: number;
}

export class CreateHoldGroupDto {
  @IsString() @Length(1, 64) patronId!: string;
  @IsOptional() @trim() @IsString() @Length(1, 200) name?: string;
}

export class FetchHoldDto {
  @IsString() @Length(1, 64) itemId!: string;
}

export class HoldShelfQueryDto {
  @IsString() @Length(1, 64) branchId!: string;
  /**
   * A query parameter arrives as a string, and `validateDto` runs
   * `enableImplicitConversion: false` on purpose — so the coercion is explicit
   * here rather than global. `NaN` falls through to `@IsInt`, which rejects it.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(1000)
  take?: number;
}

export class PatronHoldsQueryDto {
  @IsString() @Length(1, 64) patronId!: string;
  /**
   * `'1'` rather than a boolean, because a query string has no booleans and
   * `class-transformer`'s implicit coercion turns `"false"` into `true` — the
   * trap `ShelfListQueryDto` already documents for `afterId`.
   */
  @IsOptional() @IsIn(['1']) includeClosed?: '1';
}
