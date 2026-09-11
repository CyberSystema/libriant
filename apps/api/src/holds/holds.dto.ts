import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { HOLD_LIST_STATES, type HoldListState } from './holds.service.js';

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

/**
 * A query-string integer, which is the only kind there is (2.0 phase 20a).
 *
 * A query string has no types: `?limit=25` arrives as the STRING `'25'`, and
 * `validateDto` runs `enableImplicitConversion: false` deliberately, so `@IsInt`
 * alone would reject every page size a client could possibly send. The transform
 * ahead of it is what makes the declared `number` true.
 *
 * `Number('')` is 0 and `Number('abc')` is NaN, so a blank param becomes
 * `undefined` and lets the default stand, while a non-numeric one becomes NaN
 * and is REFUSED by `@IsInt` — rather than reaching Prisma as `take: NaN`,
 * which is a 500 with nothing in it that names the bad parameter.
 */
const toInt = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
  });

/**
 * The hold list's query string (2.0 phase 20a).
 *
 * `validateDto` runs `whitelist: true, forbidNonWhitelisted: true`, so a
 * parameter not declared here is a 400 rather than a silently ignored extra —
 * which is the right way round, because a mistyped filter that quietly returned
 * every hold in the library is the failure a librarian cannot see.
 *
 * There is no `q`. Nothing on `holds` is text a person would search: the reader
 * and the record are named by id, and searching them by NAME is a search of
 * `patrons` or `bib_records` whose answer is then a filter here. Adding a `q`
 * that did a join would be a second patron search with different rules from the
 * one phase 14 already owns.
 */
export class HoldListQueryDto {
  @IsOptional() @IsString() @Length(1, 64) patronId?: string;
  @IsOptional() @IsString() @Length(1, 64) bibId?: string;
  @IsOptional() @IsString() @Length(1, 64) pickupBranchId?: string;

  /**
   * One of the nine derived states, spelled once in `holds.service.ts`.
   *
   * NOT a boolean `includeClosed`, which is what `PatronHoldsQueryDto` has and
   * what a list wants one more of every time somebody adds a tab. `state=closed`
   * says the same thing and leaves room for the eight answers a boolean cannot
   * give — and it sidesteps the `"false"`-is-truthy trap that forces every
   * boolean query param in this codebase to be `@IsIn(['1'])`.
   */
  @IsOptional() @IsIn(HOLD_LIST_STATES) state?: HoldListState;

  /** An opaque token from a previous page, or (still) a bare hold id. */
  @IsOptional() @IsString() @Length(1, 512) after?: string;

  @IsOptional() @toInt() @IsInt() @Min(1) limit?: number;
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
