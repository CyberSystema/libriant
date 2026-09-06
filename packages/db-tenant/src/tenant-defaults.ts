import type { TenantPrismaClient } from './client.js';
import { reconcileSystemRoles, type ReconcileResult } from './system-roles.js';

/**
 * The values a brand-new library starts with, and the one function that puts
 * them there.
 *
 * WHY THIS EXISTS. There were FOUR provisioning paths and three copies of this
 * object:
 *
 *   `TenantProvisioningService.seedDefaults`  — signup. Settings + roles.
 *   `prisma/seed-defaults.ts`                 — the operator CLI. Settings + roles.
 *   `maintenance-processors.ts#fixTenant`     — the "fix" pass. Settings only,
 *                                               with a comment reading "mirrors
 *                                               provisioning.seedDefaults".
 *   `scripts/tenant-create.ts`                — admin provisioning. NEITHER.
 *
 * A library created with `pnpm tenant:create` therefore had no `tenant_settings`
 * row at all: no currency, no loan period, no renewal cap, no fine rate or cap,
 * while the same library created through `/auth/signup` got all of them.
 * Measured 2026-09-06 on a CLI-provisioned tenant:
 * `SELECT id, currency FROM tenant_settings LIMIT 1` returned zero rows.
 *
 * Its ROLES were there — the authorization migration seeds all four — but they
 * were never RECONCILED, so the library was missing every permission key added
 * to a template after that migration was written. Two, measured on the same
 * tenant. Small today, and the number only grows.
 *
 * That is the same defect 2.0 phase 3 fixed once already, in the same place:
 * two copies of "seed a tenant's defaults" drifted until a tenant provisioned
 * through the API got no role reconciliation while one seeded from the CLI did.
 * `reconcileSystemRoles` was extracted here for exactly that reason, and the
 * settings half was left behind. So it follows it: one implementation, four
 * callers, and a fifth provisioning path cannot be written without finding it.
 *
 * The "fix" pass is NOT one of the callers of the full seed, deliberately — see
 * {@link seedTenantSettings}. It takes the values and leaves the roles alone.
 */

/**
 * A "good first day" for a small public library.
 *
 * Every column here also carries a Prisma `@default`, and two of these
 * deliberately DISAGREE with it: `finePerDayCents` and `fineCapCents` are 0 in
 * the schema and €0.10/day capped at €5 here. That is not a duplicate of the
 * schema — it is the difference between "the column must have a value" and
 * "this is the rate a library would choose". `overdueFinesEnabled` stays false,
 * so the rate is inert until somebody turns fines on and is then already
 * sensible rather than zero.
 */
export const DEFAULT_TENANT_SETTINGS = {
  id: 1,
  currency: 'EUR',
  loanPeriodDays: 14,
  maxRenewals: 2,
  finePerDayCents: 10,
  fineCapCents: 500,
  holdPickupHours: 48,
  /** 0 = uncapped. */
  maxActiveLoans: 0,
  defaultLocale: 'el',
} as const;

export type SeedTenantResult = {
  /** False when the row already existed — an operator's edits are never touched. */
  readonly settingsCreated: boolean;
  readonly roles: ReconcileResult;
};

/**
 * Bring a tenant database up to a usable initial state. Idempotent.
 *
 * Roles are reconciled FIRST and UNCONDITIONALLY, before the early return on an
 * existing settings row. That ordering is load-bearing and is the shape of the
 * phase-3 bug: a re-provision of a tenant that already had settings used to
 * skip the reconciler entirely, so an owner stayed one permission short of
 * their own template for as long as nobody looked.
 *
 * The settings row is created only when absent. A librarian who set a 21-day
 * loan period has made a decision, and a seed that reset it on the next
 * provisioning re-run would be the worst kind of bug — invisible, periodic, and
 * about how long a patron may keep a book.
 */
export async function seedTenantDefaults(client: TenantPrismaClient): Promise<SeedTenantResult> {
  const roles = await reconcileSystemRoles(client);
  return { settingsCreated: await seedTenantSettings(client), roles };
}

/**
 * The settings half ALONE. Returns whether a row was created.
 *
 * This exists for the operator "fix" pass, which repairs an existing library
 * rather than provisioning a new one, and the distinction is not academic.
 * `reconcileSystemRoles` adds every key a shipped template holds that a role
 * does not — including one a library deliberately REMOVED from a built-in role
 * after, say, a cash-handling incident. That is defensible when provisioning a
 * database with no history behind it; doing it across every tenant because an
 * operator clicked "fix" to repair one unrelated library is not, and the
 * maintenance panel describes that button as touching settings and a cache.
 *
 * So the fix pass shares the VALUES — which is what kept drifting — and not the
 * role reconciliation, which is what would surprise somebody. A library whose
 * roles genuinely need reconciling gets `pnpm tenant:seed:defaults`: deliberate,
 * one library at a time, and already what `PermissionsService` tells an
 * operator to run when a role is missing.
 */
export async function seedTenantSettings(client: TenantPrismaClient): Promise<boolean> {
  const existing = await client.tenantSetting.findUnique({ where: { id: 1 } });
  if (existing) return false;
  await client.tenantSetting.create({ data: { ...DEFAULT_TENANT_SETTINGS } });
  return true;
}

/** One line an operator can read, for the CLI paths that print their work. */
export function describeSeedResult(result: SeedTenantResult): string {
  const settings = result.settingsCreated
    ? `tenant_settings seeded (loanPeriodDays=${DEFAULT_TENANT_SETTINGS.loanPeriodDays}, ` +
      `maxRenewals=${DEFAULT_TENANT_SETTINGS.maxRenewals}, ` +
      `finePerDayCents=${DEFAULT_TENANT_SETTINGS.finePerDayCents}, ` +
      `holdPickupHours=${DEFAULT_TENANT_SETTINGS.holdPickupHours}, ` +
      `currency=${DEFAULT_TENANT_SETTINGS.currency}, ` +
      `defaultLocale=${DEFAULT_TENANT_SETTINGS.defaultLocale})`
    : 'tenant_settings already existed — values left as-is';
  return (
    `${settings}; system roles: ${result.roles.created} created, ` +
    `${result.roles.permissionsAdded} permission(s) added ` +
    "(none removed — a library's own narrowing is kept)"
  );
}
