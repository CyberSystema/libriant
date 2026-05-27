import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** Mirror of the DB CHECK `members_member_number_format`. */
const MEMBER_NUMBER_RE = /^[A-Z0-9][A-Z0-9_-]{1,29}$/;

export const MEMBER_STATUSES = ['active', 'suspended', 'archived'] as const;
/** Statuses the user can SET directly. Archive goes through DELETE. */
export const MEMBER_SET_STATUSES = ['active', 'suspended'] as const;

export class CreateMemberDto {
  /** Optional — auto-generated as `M-YYYY-NNNN` if omitted. */
  @IsOptional()
  @IsString()
  @Matches(MEMBER_NUMBER_RE, {
    message:
      'Member number must use uppercase letters / digits / dashes / underscores (2–30 characters).',
  })
  memberNumber?: string;

  @IsString()
  @Length(1, 200)
  fullName!: string;

  /** Optional override for the auto-derived (lowercased + accent-folded) sort key. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  sortName?: string;

  @IsOptional()
  @IsEmail({}, { message: "This email doesn't look right." })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email?: string;

  @IsOptional()
  @IsString()
  @Length(0, 40)
  phone?: string;

  /** ISO date string (YYYY-MM-DD). Stored as a DATE in Postgres. */
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressLine1?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressLine2?: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(0, 30)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  country?: string;

  /** Notes visible to library staff; not surfaced to the member. */
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  staffNotes?: string;

  /** Validated against active FieldDefinitions for entity_kind='member'. */
  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;
}

export class UpdateMemberDto {
  @IsOptional()
  @IsString()
  @Matches(MEMBER_NUMBER_RE)
  memberNumber?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  fullName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  sortName?: string;

  @IsOptional()
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 40)
  phone?: string | null;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressLine1?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressLine2?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  city?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 30)
  postalCode?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 100)
  country?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  staffNotes?: string | null;

  @IsOptional()
  @IsObject()
  customFields?: Record<string, unknown>;

  /** Restore from archive (true → null archivedAt + status=active). */
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class SetMemberStatusDto {
  /**
   * Only the two librarian-set statuses are accepted here. Archiving
   * goes through DELETE so we can run the active-loans safety check
   * separately.
   */
  @IsIn(MEMBER_SET_STATUSES as readonly string[], {
    message: `Status must be one of: ${MEMBER_SET_STATUSES.join(', ')}.`,
  })
  status!: (typeof MEMBER_SET_STATUSES)[number];

  /** Optional free-form reason — goes into staffNotes (appended). */
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  reason?: string;
}
