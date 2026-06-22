import {
  Equals,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { LIBRARY_TYPES } from '@libriant/shared';

/**
 * Same slug regex as the DB CHECK constraint.
 * Lowercase digits/letters/hyphens, 2-50 chars, no leading/trailing hyphen.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export class SignupDto {
  @IsString()
  @Length(1, 200, { message: "Please enter your library's name." })
  libraryName!: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  @Matches(SLUG_RE, {
    message:
      'The library URL must be 2–50 characters, lowercase letters / digits / hyphens, and cannot start or end with a hyphen.',
  })
  slug!: string;

  @IsString()
  @Length(1, 200, { message: 'Please enter your full name.' })
  fullName!: string;

  @IsEmail({}, { message: "This email doesn't look right." })
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;

  @IsString()
  @MinLength(12, { message: 'Please use at least 12 characters.' })
  password!: string;

  @IsOptional()
  @IsString()
  @Length(2, 10)
  defaultLocale?: string;

  // --- Library profile (collected at signup) -------------------------------
  // Location + type are REQUIRED ("requirement details about the library");
  // public contact + description are optional.
  @IsIn(LIBRARY_TYPES, { message: 'Please choose your library type.' })
  libraryType!: string;

  @IsString()
  @Length(1, 200, { message: 'Please enter the street address.' })
  addressStreet!: string;

  @IsString()
  @Length(1, 120, { message: 'Please enter the city / town.' })
  addressCity!: string;

  @IsString()
  @Length(1, 20, { message: 'Please enter the postal code.' })
  addressPostalCode!: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  addressRegion?: string;

  @IsString()
  @Length(2, 2, { message: 'Country must be a 2-letter ISO code (e.g. GR).' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase().trim() : value))
  addressCountry!: string;

  @IsOptional()
  @IsString()
  @Length(0, 40)
  publicPhone?: string;

  @IsOptional()
  @IsEmail({}, { message: "That public email doesn't look right." })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase().trim() || undefined : value,
  )
  publicEmail?: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  website?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(2100)
  foundedYear?: number;

  /**
   * The owner must affirmatively accept the Terms of Service + Privacy Policy to
   * create a library. `@Equals(true)` rejects a missing/false value, so consent
   * is mandatory and the API records which version was accepted (see
   * SignupService + LEGAL_VERSION).
   */
  @Equals(true, {
    message: 'You must accept the Terms of Service and Privacy Policy to create a library.',
  })
  acceptLegal!: boolean;
}
