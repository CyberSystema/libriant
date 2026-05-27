import { IsEmail, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export class LoginDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  @Matches(SLUG_RE)
  slug!: string;

  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;

  @IsString()
  @Length(1, 200)
  password!: string;
}
