import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * Possible physical conditions a copy can be in when handed back. Anything
 * other than `ok` triggers a non-`available` status on the copy.
 */
export const RETURN_CONDITIONS = ['ok', 'damaged'] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export class CheckoutDto {
  /** The copy being lent. Must currently be `available`. */
  @IsString()
  @Length(1, 32)
  copyId!: string;

  /** Who is borrowing. Must be `active` and not archived. */
  @IsString()
  @Length(1, 32)
  memberId!: string;

  /**
   * Optional manual due date (ISO string). When omitted, due date is computed
   * as `loanedAt + tenant_settings.loanPeriodDays`. Useful for librarians who
   * want a one-off override for a particular loan.
   */
  @IsOptional()
  @IsDateString()
  dueAt?: string;

  /**
   * Optional backdated checkout time (ISO string). Defaults to "now" on the
   * server. The DB still timestamps `createdAt` independently — this only
   * shifts the *business* event time the librarian wants recorded.
   */
  @IsOptional()
  @IsDateString()
  loanedAt?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;

  /** Validated against active FieldDefinitions for entity_kind='loan'. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class ReturnLoanDto {
  /** Defaults to "now" on the server. Override for backdated returns. */
  @IsOptional()
  @IsDateString()
  returnedAt?: string;

  /**
   * Physical state of the copy on return:
   *   - `ok`      → copy back to `available`
   *   - `damaged` → copy → `damaged` (librarian can later re-shelve once fixed)
   *
   * Lost copies don't come back at all — that flow is `POST /loans/:id/mark-lost`.
   */
  @IsOptional()
  @IsIn(RETURN_CONDITIONS as readonly string[])
  condition?: ReturnCondition;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;
}

export class RenewLoanDto {
  /**
   * Number of *additional* loan periods to extend. Defaults to 1. Capped at
   * the remaining renewals allowed by `tenant_settings.maxRenewals`.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  periods?: number;
}

export class MarkLostDto {
  /**
   * What the library wants to charge the member as replacement cost. If > 0
   * a Fine row is created and tied to this loan. 0 / omitted skips the fine.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  replacementCostCents?: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;
}

export class UpdateLoanDto {
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string | null;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class ListLoansQueryDto {
  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  copyId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  /** When `1`/`true`, list only active loans whose dueAt has passed. */
  @IsOptional()
  @IsBoolean()
  overdue?: boolean;

  @IsOptional()
  @IsString()
  after?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
