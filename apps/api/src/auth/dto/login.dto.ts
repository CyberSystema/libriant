import { IsBoolean, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { MaxPasswordBytes } from './password-bounds.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export class LoginDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  @Matches(SLUG_RE)
  slug!: string;

  /** Email (owners/admins) OR username (admin-created staff, e.g. `staff_3`). */
  @IsString()
  @Length(1, 254)
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  identifier!: string;

  /**
   * Deliberately looser than the password-SETTING paths, which stop at 72 UTF-8
   * bytes (input-and-files-11, see password-bounds.ts). bcrypt reads only the
   * first 72 bytes, so an account whose password predates that ceiling still
   * signs in with the full string its owner types — tightening this to match
   * would lock those people out, which is the exact harm the finding was about,
   * pointed the other way.
   */
  @IsString()
  @Length(1, 200)
  password!: string;

  /**
   * "Remember me": when true, issue a long-lived persistent cookie (survives
   * browser restarts, slides forward on activity). When false/absent, a session
   * cookie that clears when the browser closes — right for shared/desk machines.
   */
  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}

/**
 * First-login setup for staff.
 *
 * A1-04: the password floor matches signup + reset (>=12) — this is an
 * interactive login credential, so a 4-char password (the old floor) was
 * brute-forceable offline if the control-DB hashes ever leaked.
 *
 * authn-authz-07: `newPassword` is REQUIRED. It used to be `@IsOptional()`, and
 * `LoginService.completeSetup` cleared `mustChangeCredentials` whether or not a
 * password arrived — so `POST /auth/complete-setup {}` retired the forced-change
 * screen and left the admin-generated temporary password valid forever. The
 * endpoint exists only for that forced-change flow, so requiring the field here
 * is the honest contract; the service refuses an empty one as well, because a
 * DTO is a validator and not the last word.
 */
export class CompleteSetupDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  fullName?: string;

  @IsString({ message: 'Please choose a new password.' })
  @MinLength(12, { message: 'Please use at least 12 characters.' })
  @MaxPasswordBytes()
  newPassword!: string;
}
