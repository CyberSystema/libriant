import { IsIn, IsOptional, IsString, Length } from 'class-validator';

/** Roles an admin can assign. `owner` is the signup creator and isn't assignable. */
export const STAFF_ROLES = ['admin', 'librarian', 'volunteer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export class CreateStaffDto {
  @IsIn(STAFF_ROLES, { message: 'role must be one of: admin, librarian, volunteer' })
  role!: StaffRole;

  /** Optional display name; defaults to the generated username. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  fullName?: string;
}

export class SetStaffRoleDto {
  @IsIn(STAFF_ROLES, { message: 'role must be one of: admin, librarian, volunteer' })
  role!: StaffRole;
}
