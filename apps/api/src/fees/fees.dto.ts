import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, IsArray, ArrayMaxSize } from 'class-validator';

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
