import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
import { LOAN_STATUS_VALUES, type LoanStatusValue } from './loan-read.service.js';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * THE DEVICE FIELDS ARE ABSENT FROM EVERY DTO IN THIS FILE, and that is a
 * decision rather than an omission.
 *
 * `sync_client_changes` is built, tested and reachable — from the SERVICE layer.
 * What is not reachable is a way for an HTTP body to claim a `deviceId`, because
 * §6 phase 79 owns device enrolment, attestation and revocation, and a browser
 * minting its own identity would create devices that phase then has to migrate
 * or repudiate. §3 is explicit that the Redis interceptor "stays for the
 * interactive HTTP path"; the durable table is the OFFLINE path, and the offline
 * path arrives with phase 78's batch push endpoint and an authenticated device
 * principal.
 *
 * `validateDto` runs `forbidNonWhitelisted`, so a body carrying `deviceId` is a
 * 400 naming the property rather than a silent drop — a client must not be able
 * to believe it claimed exactly-once semantics and get at-least-once.
 */

export class CheckoutDto {
  /** One of the two. A desk scans; an API caller may know the id. */
  @IsOptional() @trim() @IsString() @Length(1, 64) itemBarcode?: string;
  @IsOptional() @IsString() @Length(1, 64) itemId?: string;
  @IsOptional() @trim() @IsString() @Length(1, 64) patronBarcode?: string;
  @IsOptional() @IsString() @Length(1, 64) patronId?: string;
  /** Where the loan is being made. Defaults to where the copy is. */
  @IsOptional() @IsString() @Length(1, 64) branchId?: string;
  /**
   * When it physically happened. A librarian recording a transaction they took
   * on paper during an outage. CLAMPED to the server's instant, never later.
   */
  @IsOptional() @IsISO8601() effectiveAt?: string;
}

export class CheckinDto {
  @IsOptional() @trim() @IsString() @Length(1, 64) itemBarcode?: string;
  @IsOptional() @IsString() @Length(1, 64) itemId?: string;
  /** Where it was handed back, which is not always where it was lent. */
  @IsOptional() @IsString() @Length(1, 64) branchId?: string;
  /** A Saturday book drop, opened on Monday. */
  @IsOptional() @IsISO8601() effectiveAt?: string;
}

export class RenewDto {
  @IsOptional() @IsString() @Length(1, 64) branchId?: string;
  @IsOptional() @IsISO8601() effectiveAt?: string;
}

/**
 * Batch or whole-shelf renewal.
 *
 * `loanIds` OR `patronId`, never both — "renew these four" and "renew
 * everything this reader has" are different acts and a body that says both is a
 * client that has not decided which.
 */
export class RenewManyDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  loanIds?: string[];
  @IsOptional() @IsString() @Length(1, 64) patronId?: string;
  @IsOptional() @IsString() @Length(1, 64) branchId?: string;
  @IsOptional() @IsISO8601() effectiveAt?: string;
}

/**
 * A query param is a STRING, always.
 *
 * `@IsInt()` on the raw `'25'` is a 400 on a limit the caller spelled
 * correctly, and `validateDto` runs with `enableImplicitConversion: false` on
 * purpose — switching it on would coerce every field in every DTO in the app,
 * including the ones whose whole job is to refuse a wrong type. So the
 * conversion is per-field and visible, exactly as `BibListQueryDto` does it.
 *
 * A non-numeric value becomes `NaN` rather than `undefined`, deliberately: NaN
 * fails `@IsInt()` and the caller is told which param was wrong, where
 * `undefined` would silently fall back to the default page size and hide the
 * typo.
 */
const toInt = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
  });

/**
 * What `GET /t/:slug/circulation/loans` accepts (2.0 phase 20a).
 *
 * Every filter is optional and they compose: `?patronId=…&status=lost` is "what
 * has this reader lost", which is a real question at a desk, and none of the
 * three id filters needs its own endpoint to answer it.
 */
export class LoanListQueryDto {
  /** One reader's loans. Their whole history, not just the open ones. */
  @IsOptional() @IsString() @Length(1, 64) patronId?: string;
  /** One copy's loans — the "who had this before it came back damaged" read. */
  @IsOptional() @IsString() @Length(1, 64) itemId?: string;
  /** Every copy of one title. */
  @IsOptional() @IsString() @Length(1, 64) bibId?: string;

  /**
   * One of the SIX values `lbr2.loan_status` holds, validated against the list
   * the read service exports rather than against a second copy written here —
   * 2.0 has six states where 1.0 had three, and a hand-copied set is a set that
   * answers 400 for a status the table already contains.
   */
  @IsOptional() @IsIn(LOAN_STATUS_VALUES) status?: LoanStatusValue;

  /**
   * The overdue work queue: active, past due, most overdue first.
   *
   * `@IsIn(['1', 'true'])` and NOT `@IsBoolean()`. class-transformer turns the
   * STRING `'false'` into the boolean `true` — every non-empty string is truthy
   * — so `@IsBoolean()` here would make `?overdue=false` mean the opposite of
   * what it says and silently invert every link a client already sends. Absent
   * is false; those two spellings are true; anything else is a 400 that names
   * the param.
   */
  @IsOptional() @IsIn(['1', 'true']) overdue?: '1' | 'true';

  /** An opaque token from a previous page, or (still) a bare loan id. */
  @IsOptional() @IsString() @Length(1, 512) after?: string;

  @IsOptional() @toInt() @IsInt() @Min(1) limit?: number;
}
