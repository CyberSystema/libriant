import { IsEmail, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class VerifyEmailDto {
  @IsString()
  @Length(1, 200)
  token!: string;
}

export class ChangeEmailDto {
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  newEmail!: string;
}
