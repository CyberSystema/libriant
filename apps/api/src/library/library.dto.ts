import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { LIBRARY_TYPES } from '@libriant/shared';

/** Direct edit of the FREE profile fields (public contact + description) —
 *  applied immediately by a tenant owner/admin, no approval needed. */
export class UpdateFreeProfileDto {
  @IsOptional()
  @IsString()
  @Length(0, 40)
  publicPhone?: string | null;

  @IsOptional()
  @IsEmail({}, { message: "That public email doesn't look right." })
  publicEmail?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  website?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(2100)
  foundedYear?: number | null;
}

/** Proposed change to the CORE fields (name / type / address) — submitted as a
 *  request the platform owner-admin must approve. Every field optional; the
 *  service rejects an empty (no-change) request. */
export class ProposeCoreEditDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @IsIn(LIBRARY_TYPES, { message: 'Unknown library type.' })
  libraryType?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  addressStreet?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  addressCity?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  addressPostalCode?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  addressRegion?: string | null;

  @IsOptional()
  @IsString()
  @Length(2, 2, { message: 'Country must be a 2-letter ISO code.' })
  addressCountry?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  requestNote?: string;
}

/** Admin decision note (approve/reject). */
export class DecisionDto {
  @IsOptional()
  @IsString()
  @Length(0, 500)
  decisionNote?: string;
}

/** Pause / resume a library (platform owner-admin). `archived` is not offered:
 *  it is a 410-Gone retention state, not a pause. */
export class SetLibraryStatusDto {
  @IsIn(['active', 'suspended'], {
    message: 'Status must be "suspended" (pause the library) or "active" (resume it).',
  })
  status!: 'active' | 'suspended';

  /** Recorded on the audit row so the next operator can see why. */
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}
