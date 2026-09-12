import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
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

// ---------------------------------------------------------------------------
// The roster's query string (2.0 phase 20a)
// ---------------------------------------------------------------------------

/**
 * A query-string integer.
 *
 * NUMBERS ARRIVE AS STRINGS. A query string has no types, so `@IsInt` alone
 * rejects `?limit=25` outright and the declared `number` would be a lie about
 * every request that ever reaches this class. `Number('')` is 0 and
 * `Number('abc')` is NaN, so blank collapses to `undefined` (the default then
 * stands) while non-numeric collapses to NaN, which `@IsInt` refuses — rather
 * than reaching Prisma as `take: NaN`, which is an HTTP 500.
 *
 * The same transform as `BibListQueryDto`'s, deliberately spelled out again
 * rather than imported across domains: the two files are the two halves of one
 * convention, and a shared helper in `bib/` that `patrons/` imported would tie
 * the patron surface's validation to the catalogue's release.
 */
const toInt = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
  });

/**
 * The statuses a roster may be filtered to.
 *
 * These are the three values of the `patron_status` enum and nothing else.
 * `archived` is NOT among them because the archive is `archived_at` and not a
 * status — see the enum's own docblock — and it is reached through
 * `includeArchived` instead. `expired` is not among them either, and that is
 * the same decision seen from the other side: expiry is DERIVED from
 * `expires_at` against an instant, so a filter for it would be a date
 * comparison wearing a status's clothes, and a librarian who picked it would
 * get a different answer at 23:59 than at 00:01 with nothing on screen to
 * explain why. Every row carries `expiresAt` and `expired` so the screen can
 * show it honestly; narrowing the whole list by it is a filter this phase does
 * not owe.
 */
export const PATRON_ROSTER_STATUSES = ['active', 'suspended', 'closed'] as const;
export type PatronRosterStatus = (typeof PATRON_ROSTER_STATUSES)[number];

/**
 * The patron roster's query string.
 *
 * `validateDto` runs with `whitelist: true, forbidNonWhitelisted: true`, so a
 * parameter that is not declared here is a 400 rather than an ignored extra.
 * That is the right default on a list — a typo in a filter silently returning
 * the UNFILTERED roster is worse than an error, because the screen still looks
 * like it worked — but it makes this class a promise about what a caller may
 * send, and adding a control to the roster screen means adding it here in the
 * same change.
 */
export class ListPatronsQueryDto {
  /**
   * The search term, folded and measured server-side.
   *
   * Not `@Length(3, ...)`: a two-character term is a legitimate request that
   * gets a documented "keep typing" answer carrying `minQueryChars`, not a 400.
   * The floor is a search policy, and a policy belongs where the answer can
   * explain itself — see `PatronsService.list`, which also records that the
   * floor is a behaviour change from 1.0's roster.
   */
  @IsOptional() @trim() @IsString() @Length(1, 200) q?: string;

  @IsOptional() @IsIn([...PATRON_ROSTER_STATUSES]) status?: PatronRosterStatus;

  /**
   * `'1'` / `'true'`, never `@IsBoolean`.
   *
   * A query string has no booleans, and `class-transformer` coerces the STRING
   * `"false"` to the boolean `true` — so `?includeArchived=false`, which is
   * what a UI sends for an unticked box, would turn the filter ON and put every
   * archived, merged and erased record into the roster. Accepting only the
   * affirmative spellings makes the wrong one a visible 400 instead of a
   * silently inverted list. `holds.dto.ts` documents the same trap for
   * `includeClosed`.
   */
  @IsOptional() @IsIn(['1', 'true']) includeArchived?: '1' | 'true';

  /** An opaque token from a previous page, or (still) a bare patron id. */
  @IsOptional() @IsString() @Length(1, 512) after?: string;

  @IsOptional() @toInt() @IsInt() @Min(1) limit?: number;
}

/**
 * The reason an erasure was carried out (2.0 phase 20b-ii).
 *
 * Required, and not free of consequence: Article 17 gives six grounds and a
 * library refusing or granting one may be asked which it relied on. A blank
 * would make the audit row that proves compliance say nothing.
 */
export class ErasePatronDto {
  @trim() @IsString() @Length(3, 500) reason!: string;
}

/**
 * A patch to a patron record (2.0 phase 20b-ii).
 *
 * Every field optional: absent means "leave it", and only an explicit `null`
 * clears. `sortName` and `searchText` are deliberately NOT accepted — they are
 * recomputed from `fullName` through `foldGreek`, because a client folding them
 * itself would fold with whatever it had, which is the phase-1 defect returning
 * through the front door.
 */
export class UpdatePatronDto {
  @IsOptional() @trim() @IsString() @Length(1, 64) patronNumber?: string;
  @IsOptional() @trim() @IsString() @Length(1, 200) fullName?: string;
  @IsOptional() @ValidateIf((_o: unknown, v: unknown) => v !== null) @trim() @IsEmail() email?:
    string | null;
  @IsOptional()
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @trim()
  @IsString()
  @Length(1, 64)
  phone?: string | null;
  @IsOptional() @ValidateIf((_o: unknown, v: unknown) => v !== null) @IsISO8601() dateOfBirth?:
    string | null;
  @IsOptional()
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsString()
  @Length(1, 64)
  patronCategoryId?: string | null;
  @IsOptional()
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsString()
  @Length(1, 64)
  homeBranchId?: string | null;
  @IsOptional() @ValidateIf((_o: unknown, v: unknown) => v !== null) @IsISO8601() expiresAt?:
    string | null;
  @IsOptional()
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @trim()
  @IsString()
  @Length(0, 2000)
  staffNotes?: string | null;
}

/**
 * `closed` is 2.0's third value and has no 1.0 equivalent. It is not archiving:
 * a closed patron is one the library has ended the relationship with and whose
 * record it keeps, which is a different fact from a row hidden from the roster.
 */
export class SetPatronStatusDto {
  @IsIn(['active', 'suspended', 'closed']) status!: 'active' | 'suspended' | 'closed';
}
