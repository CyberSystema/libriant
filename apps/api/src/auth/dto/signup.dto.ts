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
import { LEGAL_LOCALES, type LegalLocale } from '../consent-locales.js';
import { MaxPasswordBytes } from './password-bounds.js';

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
  @MaxPasswordBytes()
  password!: string;

  /**
   * The locale the signup form was rendered in — and therefore WHICH LANGUAGE
   * OF THE TERMS the owner was shown.
   *
   * privacy-legal-09: this was `@IsString() @Length(2, 10)`, so `"fr"` (or
   * `"klingon"`) validated fine and then `acceptanceLocale()` quietly turned it
   * into 'el' — producing a record that asserted the owner had accepted the
   * GREEK documents. A consent record naming the wrong text is worse than no
   * record, because it looks like evidence. It is now closed to the locales the
   * legal corpus is actually PUBLISHED in.
   *
   * Still optional, deliberately: every shipped caller sends it (SignupForm.tsx
   * sends `defaultLocale: n`), but nineteen integration suites create libraries
   * without it, and turning that into a 400 would be a breaking API change
   * bought for an edge case. Instead, an acceptance recorded without it is
   * flagged `localeAsserted: false` and does not claim which translation was
   * read — see `legalAcceptanceAuditData`. Both translations are archived for
   * every version regardless, so either can still be produced.
   */
  @IsOptional()
  @IsIn(LEGAL_LOCALES, {
    message:
      'defaultLocale must be "el" or "en" — the Terms of Service and Privacy Policy are only published in those languages.',
  })
  defaultLocale?: LegalLocale;

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
