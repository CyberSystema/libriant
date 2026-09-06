/**
 * Idempotent default-settings seed for a tenant DB, from the command line.
 *
 * The VALUES and the seeding logic live in `src/tenant-defaults.ts` — this is
 * the CLI wrapper around them, and nothing more. It used to carry its own copy
 * of the defaults object, which is how `maintenance-processors.ts` came to
 * carry a third and `scripts/tenant-create.ts` came to carry none at all.
 *
 * Re-running against an existing tenant DB is safe: the singleton settings row
 * is left exactly as the librarian set it, and the system roles are reconciled
 * additively.
 *
 * Usage:
 *   TENANT_DATABASE_URL=postgres://... pnpm seed:defaults
 */
import {
  describeSeedResult,
  disconnectTenantClient,
  makeTenantPrismaClient,
  seedTenantDefaults,
} from '../src';

async function main() {
  const url = process.env.TENANT_DATABASE_URL;
  if (!url) {
    console.error('TENANT_DATABASE_URL must be set.');
    process.exit(1);
  }
  const client = makeTenantPrismaClient({ databaseUrl: url });
  try {
    console.log(describeSeedResult(await seedTenantDefaults(client)));
  } finally {
    await disconnectTenantClient(client);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
