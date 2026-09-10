import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsISO8601, IsOptional, IsString, Length } from 'class-validator';

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
