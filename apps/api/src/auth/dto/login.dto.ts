import { IsBoolean, IsOptional, IsString, Length, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

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
  @Length(12, 200, { message: 'Please use at least 12 characters.' })
  newPassword!: string;
}
