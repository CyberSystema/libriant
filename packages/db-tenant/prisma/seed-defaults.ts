/**
 * Idempotent default-settings seed for a tenant DB.
 *
 * The provisioning script (Step 20) calls this after creating a fresh tenant
 * DB so the library has working defaults from minute one. Re-running on an
 * existing tenant DB is a no-op for the singleton row; explicit overrides
 * the librarian set will NOT be clobbered.
 *
 * Usage:
 *   TENANT_DATABASE_URL=postgres://... pnpm seed:defaults
 *
 * The defaults below match a "good first day" for a small public library:
 *   - 14-day loan period
 *   - 2 renewals allowed
 *   - €0.10/day fines, capped at €5
 *   - 48-hour hold pickup window
 */
import { makeTenantPrismaClient, disconnectTenantClient } from '../src';

const DEFAULTS = {
  id: 1,
  currency: 'EUR',
  loanPeriodDays: 14,
  maxRenewals: 2,
  finePerDayCents: 10,
  fineCapCents: 500,
  holdPickupHours: 48,
  maxActiveLoans: 0, // 0 = uncapped
  defaultLocale: 'el',
};

async function main() {
  const url = process.env.TENANT_DATABASE_URL;
  if (!url) {
    console.error('TENANT_DATABASE_URL must be set.');
    process.exit(1);
  }
  const client = makeTenantPrismaClient({ databaseUrl: url });
  try {
    const existing = await client.tenantSetting.findUnique({ where: { id: 1 } });
    if (existing) {
      console.log('tenant_settings row already exists — leaving values as-is');
      return;
    }
    await client.tenantSetting.create({ data: DEFAULTS });
    console.log(
      `tenant_settings seeded: loanPeriodDays=${DEFAULTS.loanPeriodDays}, ` +
        `maxRenewals=${DEFAULTS.maxRenewals}, ` +
        `finePerDayCents=${DEFAULTS.finePerDayCents}, ` +
        `holdPickupHours=${DEFAULTS.holdPickupHours}, ` +
        `currency=${DEFAULTS.currency}, defaultLocale=${DEFAULTS.defaultLocale}`,
    );
  } finally {
    await disconnectTenantClient(client);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
