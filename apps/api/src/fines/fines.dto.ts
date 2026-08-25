import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

/** Every state a fine can be in. Mirrors the `FineStatus` enum in the tenant schema. */
export const FINE_STATUSES = ['outstanding', 'paid', 'waived'] as const;
export type FineStatusValue = (typeof FINE_STATUSES)[number];

/** Trim once, in one place, so `@Length` measures what actually gets stored. */
const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : (value as unknown)));

/**
 * Longest a librarian's free-text explanation may be. Generous enough for the
 * real sentence ("Επιστράφηκε εγκαίρως, λάθος καταχώρηση ημερομηνίας") and short
 * enough that it is a reason, not a case file.
 */
const REASON_MAX = 500;

/**
 * Record a payment taken at the desk.
 *
 * v1 is FULL SETTLEMENT ONLY. A partial payment would need a payments ledger
 * (one row per tender, the fine's balance derived from the sum); the schema has
 * no such table, and the alternative — decrementing `amountCents` — would
 * quietly rewrite what the library said the member owed, leaving no record that
 * €2.00 of a €5.00 charge was ever collected. A charge the library is willing
 * to accept less for is a WAIVER of the difference, which this module can
 * already express honestly.
 */
export class PayFineDto {
  /**
   * The amount the librarian believes they are collecting, in subunits.
   *
   * Optional, but send it. The accrual sweep grows an outstanding fine every
   * night, so the €2.40 printed on the screen at 09:00 can be €2.90 by the time
   * the member reaches the desk. Without this the API would mark that €2.90
   * fine "paid in full" on the strength of €2.40 in the drawer and no one would
   * ever know. When present it must equal the fine's CURRENT amount; when it
   * doesn't, the call is refused with the current amount so the desk can
   * re-confirm with the member.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  // ~€1,000,000 in subunits — far above any real library fine, and it keeps a
  // fat-fingered paste from reaching the database as a plausible-looking debt.
  @Max(100_000_000)
  amountCents?: number;

  /** Optional desk note ("paid in cash", receipt number). Stored on the fine. */
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;
}

/**
 * Write off money the library IS owed — goodwill, hardship, a returning member
 * whose fine outlived its usefulness.
 *
 * The reason is REQUIRED and is not decoration: this is the one operation that
 * makes money the library counted as owed stop being owed, and "who decided,
 * when, and why" is the whole of the accounting record for it.
 */
export class WaiveFineDto {
  @trim()
  @IsString()
  @Length(3, REASON_MAX, {
    message: 'Say why this fine is being waived (3–500 characters) — it goes on the record.',
  })
  reason!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;
}

/**
 * Cancel a fine that should never have existed — a mis-typed due date, a book
 * that was re-shelved by hand and never marked returned, an import that billed
 * a member for someone else's loan.
 *
 * Deliberately NOT the same call as a waiver even though both land on
 * `status = 'waived'` (the schema has three statuses and adding a fourth is a
 * tenant-wide migration nobody needs to ship for this). A waiver says the debt
 * was real and the library chose not to collect it; a void says there was never
 * a debt. Recording the second as the first puts a false statement about a
 * patron's money into a record that outlives everyone in the room — and it is
 * exactly the record that gets read out when a member disputes a charge. The
 * two are told apart by their audit action (`fine.waived` vs `fine.voided`) and
 * by the note written onto the fine.
 */
export class VoidFineDto {
  @trim()
  @IsString()
  @Length(3, REASON_MAX, {
    message: 'Say what was wrong with this fine (3–500 characters) — it goes on the record.',
  })
  reason!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;
}

/** Query shape for the list endpoint (documentation; the controller parses raw params). */
export class ListFinesQueryDto {
  @IsOptional()
  @IsIn(FINE_STATUSES as readonly string[])
  status?: FineStatusValue;

  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  loanId?: string;

  @IsOptional()
  @IsString()
  after?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
