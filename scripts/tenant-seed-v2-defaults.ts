#!/usr/bin/env tsx
/**
 * Seed the lbr2 defaults into a tenant database, from the command line
 * (2.0 phase 20a).
 *
 * ## Why this exists, and what it is NOT
 *
 * `pnpm tenant:seed:defaults` seeds the 1.0 tenant through the 1.0 client:
 * `tenant_settings`, the system roles. It does not touch `lbr2`, and nothing
 * did from a command line — the 2.0 defaults (`branch-main`, `loc-general`,
 * `itype-book`, the always-open calendar, the five policies and the wildcard
 * `rule-default`) were written only by `TenantProvisioningService`, which runs
 * inside the API when a library signs up.
 *
 * That was fine until something outside the API needed a provisioned 2.0
 * schema. CI's migrations job applies the baseline and stops, so `lbr2` there
 * has 124 tables and no policy at all — and the phase-19 upgrade rehearsal
 * refuses to run against it, correctly, because an upgrade that seeded its own
 * defaults would be inventing a library's circulation policy.
 *
 * So this is the CLI around the SAME two functions provisioning calls. Not a
 * copy of them: `seed-defaults.ts`'s own docblock records what happened last
 * time the values were copied — a second copy appeared in
 * `maintenance-processors.ts` and a third went missing from
 * `scripts/tenant-create.ts`.
 *
 * IDEMPOTENT, because both seeders count before they write.
 */
import { seedCirculationDefaults } from '../apps/api/src/policy/circulation-defaults.js';
import { seedItemDefaults } from '../apps/api/src/items/item-defaults.js';
import { makeTenantPrismaClientV2 } from '../packages/db-tenant/src/client.js';
import { die, log, parseArgs } from './_lib/cli.js';

const NAME = 'tenant-seed-v2-defaults';

const args = parseArgs({
  name: NAME,
  description: 'Seed the lbr2 circulation and item defaults into a tenant database.',
  options: { url: { type: 'string' } },
});

async function main(): Promise<void> {
  const url = (args.values.url as string | undefined) ?? process.env['TENANT_DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    die(NAME, 'pass --url or set TENANT_DATABASE_URL');
  }

  const client = makeTenantPrismaClientV2({ databaseUrl: url });
  try {
    const now = new Date();
    // Circulation FIRST: the always-open calendar has to exist before the
    // branch that names it. Provisioning carries the same order and the same
    // comment — the dependency inverted when the calendar seed landed.
    const circulation = await seedCirculationDefaults(client as never, now);
    const items = await seedItemDefaults(client as never, now);
    log(
      NAME,
      `lbr2 defaults: circulation ${circulation ? 'seeded' : 'already present'}, ` +
        `items ${items ? 'seeded' : 'already present'}`,
    );
  } finally {
    await client.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
