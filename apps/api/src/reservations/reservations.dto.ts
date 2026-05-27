import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

export const RESERVATION_STATUSES = [
  'queued',
  'ready',
  'fulfilled',
  'expired',
  'canceled',
] as const;

export class PlaceHoldDto {
  /** The book the member wants. Holds are placed at the *book* level (any
   *  copy fulfills them); the system picks the actual copy at promote time. */
  @IsString()
  @Length(1, 32)
  bookId!: string;

  /** Who's placing the hold. Must be `active`, not archived, and not already
   *  hold the same book or have an active loan on it. */
  @IsString()
  @Length(1, 32)
  memberId!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;

  /** Validated against active FieldDefinitions for entity_kind='reservation'. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateReservationDto {
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string | null;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class FulfillReservationDto {
  /**
   * Optional manual due date. Falls back to `tenant_settings.loanPeriodDays`
   * as with a plain checkout.
   */
  @IsOptional()
  @IsString()
  @Length(1, 32)
  dueAt?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;

  /** Validated against active FieldDefinitions for entity_kind='loan' (the
   *  resulting Loan, not the reservation). */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class ListReservationsQueryDto {
  @IsOptional()
  @IsString()
  bookId?: string;

  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  /**
   * Include resolved holds (fulfilled / expired / canceled). Default is
   * `false` — the common case is "what's outstanding".
   */
  @IsOptional()
  @IsBoolean()
  includeResolved?: boolean;

  @IsOptional()
  @IsString()
  after?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
