import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Patch for a library's circulation policy + feature switches. Every field is
 * optional — the UI sends only what changed. Mutating this is admin-only
 * (RolesGuard, owner/admin); reading it is open to all staff.
 *
 * Money is in currency subunits (cents). Bounds are deliberately generous —
 * just enough to reject nonsense / overflow, not to encode policy.
 */
export class UpdateTenantSettingsDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'Currency must be a 3-letter ISO 4217 code, e.g. EUR.' })
  currency?: string;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Loan period must be at least 1 day.' })
  @Max(3650)
  loanPeriodDays?: number;

  // --- Renewals -------------------------------------------------------------
  @IsOptional()
  @IsBoolean()
  renewalsEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxRenewals?: number;

  // --- Overdue fines --------------------------------------------------------
  @IsOptional()
  @IsBoolean()
  overdueFinesEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  finePerDayCents?: number;

  @IsOptional()
  @IsInt()
  @Min(0, { message: 'Fine cap cannot be negative (use 0 for uncapped).' })
  @Max(10_000_000)
  fineCapCents?: number;

  // --- Lost-item fees -------------------------------------------------------
  @IsOptional()
  @IsBoolean()
  lostItemFeesEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  lostItemDefaultFeeCents?: number;

  // --- Reservations / holds -------------------------------------------------
  @IsOptional()
  @IsBoolean()
  reservationsEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Hold pickup window must be at least 1 hour.' })
  @Max(8760)
  holdPickupHours?: number;

  // --- Borrowing limit ------------------------------------------------------
  @IsOptional()
  @IsInt()
  @Min(0, { message: 'Max active loans cannot be negative (use 0 for unlimited).' })
  @Max(100_000)
  maxActiveLoans?: number;

  // --- Member email reminders (opt-in) -------------------------------------
  @IsOptional()
  @IsBoolean()
  notifyDueSoon?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Due-soon lead time must be at least 1 day.' })
  @Max(60)
  dueSoonDays?: number;

  @IsOptional()
  @IsBoolean()
  notifyOverdue?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyHoldReady?: boolean;
}
