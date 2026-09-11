import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Length,
  Matches,
  IsArray,
  ArrayMaxSize,
  IsIn,
  IsInt,
  Min,
} from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * MONEY ARRIVES AS A STRING OF MINOR UNITS, and that is not fussiness.
 *
 * A JSON number is an IEEE-754 double. Amounts a library handles are small
 * enough that no cent is lost today, and the moment one is — a consortium
 * settlement, a bulk write-off, a currency with three minor digits — it is lost
 * silently and the ledger balances on the wrong number. §3's convention is
 * bigint minor units paired with a char(3) currency everywhere the money is
 * stored; accepting a double at the edge would put a lossy type in the one place
 * the whole module exists to be exact about.
 *
 * So the wire type is a decimal string of MINOR units: "240" is two euros forty.
 * Not "2.40" — a major-unit string needs the currency's exponent to interpret,
 * which is a second thing to get wrong, and the exponent lives in
 * `@libriant/shared/currencies` rather than in a request body.
 */
const MINOR_UNITS = /^[1-9][0-9]{0,15}$/;
const CURRENCY = /^[A-Z]{3}$/;

export class ChargeFeeDto {
  @IsString() @Length(1, 64) patronId!: string;
  @IsString() @Length(1, 64) feeTypeId!: string;
  @IsString() @Length(1, 64) branchId!: string;
  @Matches(CURRENCY, { message: 'currency must be an ISO 4217 alphabetic code' }) currency!: string;
  @Matches(MINOR_UNITS, { message: 'amountCents must be a positive whole number of minor units' })
  amountCents!: string;
  @trim() @IsString() @Length(1, 500) reason!: string;
  @IsOptional() @IsString() @Length(1, 64) loanId?: string;
  @IsOptional() @IsString() @Length(1, 64) itemId?: string;
  @IsOptional() @IsString() @Length(1, 64) holdId?: string;
}

/**
 * The body of a payment, a waiver or a write-off.
 *
 * THE KIND IS NOT IN THE BODY. It is the route, because the permission is the
 * route: `@RequirePermission` carries one key and one optional ceiling, so a
 * single endpoint switching on a body field could only ever be guarded by the
 * weakest of the three. Three routes means `circ.fee.waive` can carry a EUR 5.00
 * ceiling that `circ.fee.pay` does not, which is the whole point of a limit
 * permission.
 */
export class SettleFeesDto {
  @IsString() @Length(1, 64) patronId!: string;
  @IsString() @Length(1, 64) branchId!: string;
  @Matches(CURRENCY) currency!: string;
  @Matches(MINOR_UNITS) amountCents!: string;
  /**
   * Which charges to settle. Omitted means "whatever is owed, oldest first",
   * which is what a reader means by paying off their fines.
   */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) feeIds?: string[];
  @IsOptional() @IsString() @Length(1, 64) paymentMethodId?: string;
  @IsOptional() @IsString() @Length(1, 64) drawerSessionId?: string;
  /** The phase-16 replay key. A retried payment must not charge twice. */
  @IsOptional() @IsString() @Length(1, 64) clientChangeId?: string;
  @IsOptional() @trim() @IsString() @Length(1, 500) note?: string;
}

export class RefundFeesDto {
  @IsString() @Length(1, 64) patronId!: string;
  @IsString() @Length(1, 64) branchId!: string;
  @Matches(CURRENCY) currency!: string;
  @Matches(MINOR_UNITS) amountCents!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) feeIds?: string[];
  @IsOptional() @IsString() @Length(1, 64) paymentMethodId?: string;
  @IsOptional() @IsString() @Length(1, 64) drawerSessionId?: string;
  @IsOptional() @trim() @IsString() @Length(1, 500) note?: string;
}

export class OpenDrawerDto {
  @IsString() @Length(1, 64) servicePointId!: string;
  @Matches(CURRENCY) currency!: string;
  /** Zero is legal here, unlike every other amount in this file. */
  @Matches(/^(0|[1-9][0-9]{0,15})$/) openingFloatCents!: string;
}

export class CloseDrawerDto {
  @Matches(/^(0|[1-9][0-9]{0,15})$/) countedCents!: string;
  @IsOptional() @trim() @IsString() @Length(1, 500) note?: string;
}

/**
 * The five values `lbr2.fee_status` can hold, spelled out because a query
 * parameter is a string and `@IsIn` needs the set.
 *
 * Hand-written rather than imported from the generated client: the Prisma enum
 * object is a value in a package this file does not otherwise depend on, and
 * `ledger.ts` already takes the same approach with `LedgerAccount`. The cost is
 * that adding a sixth status means editing here too — cheap, and a status is
 * added by a migration that nobody writes casually.
 */
export const FEE_STATUSES = ['outstanding', 'paid', 'waived', 'written_off', 'cancelled'] as const;
export type FeeStatusValue = (typeof FEE_STATUSES)[number];

/**
 * A query parameter arrives as a STRING, so `@IsInt` alone rejects `?limit=25`.
 * The transform ahead of it is what makes the declared type true. `Number('')`
 * is 0 and `Number('abc')` is NaN, so anything non-finite becomes NaN and is
 * rejected by `@IsInt` rather than reaching Prisma as `take: NaN` — which is a
 * 500, not a 400, and says nothing about what the caller got wrong.
 */
const toInt = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
  });

/**
 * What `GET /t/:slug/fees` accepts (2.0 phase 20a).
 *
 * ## `patronId` and `loanId` are both optional HERE and one is required THERE
 *
 * Neither is `@IsString()` outright, because "at least one of two" is not a
 * statement about the shape of either field — it is a statement about the
 * ledger, namely that no index and no screen exists for the whole of it. It is
 * enforced in `FeesService.list`, next to the index comment that explains it, so
 * a future caller that reaches the service without passing through this DTO gets
 * the same refusal rather than a sequential scan of every fee in the library.
 *
 * ## `includeArchived` is `'1' | 'true'`, never `@IsBoolean`
 *
 * `class-transformer` coerces the STRING `"false"` to boolean `true`, so a DTO
 * that declared this a boolean would turn `?includeArchived=false` into "yes,
 * include them" — the exact inversion of what the caller typed, with no error
 * anywhere. A string enum cannot do that.
 */
export class FeeListQueryDto {
  @IsOptional() @IsString() @Length(1, 64) patronId?: string;
  @IsOptional() @IsString() @Length(1, 64) loanId?: string;

  /**
   * `status`, not `state`: `lbr2.fees` has a `status` column of type
   * `fee_status` and nothing called a state, and a parameter named after a field
   * that does not exist is a parameter whose meaning has to be remembered.
   */
  @IsOptional() @IsIn(FEE_STATUSES as readonly string[]) status?: FeeStatusValue;

  /**
   * 1.0 SOFT-DELETES a fine and 2.0 kept that as `archived_at`. An archived fee
   * is filed away and is not owed — `owed_cents` reads the column — so the list
   * hides it by default. Showing filed-away debts beside live ones by default is
   * how a desk asks a reader to pay something the library already dropped.
   */
  @IsOptional() @IsIn(['1', 'true']) includeArchived?: string;

  /** An opaque token from a previous page, or (still) a bare fee id. */
  @IsOptional() @IsString() @Length(1, 512) after?: string;

  @IsOptional() @toInt() @IsInt() @Min(1) limit?: number;
}
