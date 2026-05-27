import { IsEmail, IsString, Length, Matches, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export class PasswordResetRequestDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  @Matches(SLUG_RE)
  slug!: string;

  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;
}

export class PasswordResetCompleteDto {
  @IsString()
  @Length(1, 200)
  token!: string;

  @IsString()
  @MinLength(12, { message: 'Please use at least 12 characters.' })
  newPassword!: string;
}
