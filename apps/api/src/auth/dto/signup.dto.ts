import { IsEmail, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Same slug regex as the DB CHECK constraint.
 * Lowercase digits/letters/hyphens, 2-50 chars, no leading/trailing hyphen.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export class SignupDto {
  @IsString()
  @Length(1, 200)
  libraryName!: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  @Matches(SLUG_RE, {
    message:
      'The library URL must be 2–50 characters, lowercase letters / digits / hyphens, and cannot start or end with a hyphen.',
  })
  slug!: string;

  @IsString()
  @Length(1, 200)
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
}
