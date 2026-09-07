/**
 * The tenant smoke test — a runner over modules.
 *
 * ## Why it is split
 *
 * It used to be one 400-line `main()` with a hand-ordered list of thirteen
 * `deleteMany` calls at the end. That shape had three costs that phase 9 could
 * not carry: a failure anywhere stopped everything after it, so one broken
 * invariant hid every other; there was no way to run just the part you were
 * working on; and the teardown list was correct only until somebody added a
 * table, at which point the symptom is a foreign-key error in cleanup that reads
 * like a test failure.
 *
 * So: one module per schema area, each owning its own teardown, and a runner
 * that CONTINUES PAST A FAILURE so a single run reports everything that is
 * broken rather than the first thing.
 *
 *   pnpm tenant:smoke                    # every module
 *   pnpm tenant:smoke --only=v2-fees     # one
 *   pnpm tenant:smoke --list             # what there is
 *
 * `pnpm tenant:smoke` with no arguments stays CI's single entry point, and it
 * still exits non-zero if anything failed.
 *
 * ## The 1.0 module is deleted by phase 20
 *
 * `v1-workflow` is the original test, moved wholesale and otherwise unchanged.
 * It exercises `public`; the 2.0 modules exercise `lbr2`. Phase 20 drops the 1.0
 * tables and this module goes with them.
 */
import { makeTenantPrismaClient, disconnectTenantClient } from '../src';
import type { SmokeModule } from './smoke/_lib.js';
import { v1Workflow } from './smoke/v1-workflow.js';
import { v2Modules } from './smoke/v2-baseline.js';

const MODULES: SmokeModule[] = [v1Workflow, ...v2Modules];

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

if (args.includes('--list')) {
  for (const m of MODULES) console.log(`  ${m.name.padEnd(20)} ${m.describes}`);
  process.exit(0);
}

const selected = only ? MODULES.filter((m) => m.name === only) : MODULES;
if (only && selected.length === 0) {
  console.error(
    `✗ no smoke module named "${only}". Known: ${MODULES.map((m) => m.name).join(', ')}`,
  );
  process.exit(1);
}

const url = process.env.TENANT_DATABASE_URL;
if (!url) {
  console.error(
    '✗ TENANT_DATABASE_URL is not set. This test needs a migrated tenant database:\n' +
      '    pnpm db:up && TENANT_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_demo pnpm tenant:smoke',
  );
  process.exit(1);
}

const db = makeTenantPrismaClient({ databaseUrl: url, maxPoolSize: 1 });
const failures: Array<{ module: string; error: string }> = [];

try {
  for (const mod of selected) {
    console.log(`\n▸ ${mod.name} — ${mod.describes}`);
    try {
      await mod.run(db);
    } catch (err) {
      // Continue. One broken invariant must not hide the other five modules;
      // knowing everything that is wrong in one run is the difference between
      // one fix and six round trips.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${message}`);
      failures.push({ module: mod.name, error: message });
    } finally {
      // ALWAYS, including after a failure. A module that dies part-way has left
      // rows behind, and without this every later module fails its "exists and
      // is empty" check for a reason that is not its own — one real failure
      // reported as three, two of them pointing at innocent modules.
      try {
        await mod.reset?.(db);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  ✗ ${mod.name}: teardown failed — ${message}`);
        failures.push({ module: `${mod.name} (teardown)`, error: message });
      }
    }
  }
} finally {
  await disconnectTenantClient(db);
}

if (failures.length) {
  console.error(`\n✗ tenant smoke: ${failures.length} of ${selected.length} module(s) failed\n`);
  for (const f of failures) console.error(`    ${f.module}: ${f.error}`);
  process.exit(1);
}

console.log(
  `\n✓ tenant smoke: ${selected.length} module(s) green` +
    (only ? '' : ` (${MODULES.map((m) => m.name).join(', ')})`),
);
