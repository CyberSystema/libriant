import { IsEmail, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class VerifyEmailDto {
  @IsString()
  @Length(1, 200)
  token!: string;
}

/**
 * authn-authz-08: `currentPassword` is required.
 *
 * The endpoint used to take `{ newEmail }` alone behind AuthGuard — no
 * password, no TOTP, no re-authentication of any kind — and confirm the change
 * from a link sent only to the NEW address. A probe pointed an owner account at
 * `attacker@evil.test` in one request (202) with nothing but a session cookie.
 * Chained with the un-revocable logout of authn-authz-02, a borrowed
 * circulation-desk session became permanent ownership of the library: change
 * the address, confirm it from your own inbox, then use the ordinary password
 * reset. Re-proving the password turns "hold a cookie for a minute" back into
 * "know the password".
 */
export class ChangeEmailDto {
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  newEmail!: string;

  @IsString({ message: 'Enter your current password to change your email address.' })
  @Length(1, 200)
  currentPassword!: string;
}
