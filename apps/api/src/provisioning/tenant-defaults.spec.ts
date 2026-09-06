import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_SETTINGS } from '@libriant/db-tenant';

/**
 * Every provisioning path seeds the same thing, asserted by the SHAPE of the
 * code rather than by its behaviour.
 *
 * A behavioural test cannot see this defect. Each path, tested on its own, does
 * exactly what its own copy of the defaults says — and for a while there were
 * three such copies and a fourth path with none at all. A library created with
 * `pnpm tenant:create` started with no `tenant_settings` row: no currency, no
 * loan period, no renewal cap, no fine rate. Measured 2026-09-06 on a
 * CLI-provisioned tenant, `SELECT id, currency FROM tenant_settings LIMIT 1`
 * returned zero rows.
 *
 * (Its ROLES were fine — the authorization migration seeds all four — but they
 * had never been reconciled, so it was missing every permission key added to a
 * shipped template after that migration was written. Two, on that tenant.)
 *
 * 2.0 phase 3 fixed this once already, in the same place and for the same
 * reason: two seeds drifted until a tenant provisioned through the API got no
 * role reconciliation while one seeded from the CLI did. `reconcileSystemRoles`
 * was extracted then and the settings half was left behind. So the assertion
 * that stops it happening a third time is not "the values are right", it is
 * "there is one implementation, everybody calls it, and the list of everybody
 * is DISCOVERED rather than written down" — a hand-written list is how the
 * fourth path stayed invisible.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * The implementations. Excluded from every scan below — they define the seed
 * and the reconciler, they do not call them.
 */
const IMPLEMENTATIONS = new Set([
  'packages/db-tenant/src/tenant-defaults.ts',
  'packages/db-tenant/src/system-roles.ts',
]);

const SEARCH_ROOTS = ['apps/api/src', 'packages/db-tenant', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'build', '.turbo', 'migrations']);

function sources(rel: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, rel);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (/\.ts$/.test(rel) && !/\.spec\.ts$/.test(rel)) out.push(rel);
    return out;
  }
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    sources(`${rel}/${e.name}`, out);
  }
  return out;
}

/** Comments removed, so prose about seeding is not mistaken for seeding. */
function code(rel: string): string {
  // Line comments FIRST. Stripping block comments first lets a `/*` inside a
  // `//` line open one and delete real code up to the next `*/` — 63 lines of
  // it, measured in maintenance-processors.ts.
  return read(rel)
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Every file that provisions or repairs a tenant database, DISCOVERED.
 *
 * A file qualifies if it does something only a provisioner does: create a
 * tenant database, run the tenant migrations, or write the settings row or the
 * system roles directly.
 */
const PROVISIONER_TELLS = [
  // Brings a tenant database into existence.
  /CREATE DATABASE/,
  // Writes what the shared module writes — a copy in the making.
  /tenantSetting\.(create|upsert)\(/,
  /reconcileSystemRoles\(/,
  // Already a caller, so by construction one of the paths this is about.
  /\bseedTenant(Defaults|Settings)\(/,
];

/**
 * Deliberately NOT a tell: running `prisma migrate deploy`. `tenant-migrate.ts`
 * and `tenant-relocate.ts` do that against databases that already exist and
 * already have their settings; neither provisions a library, and requiring them
 * to seed would be requiring the wrong thing.
 *
 * What this cannot see, said out loud: a future provisioner that neither
 * creates the database itself (delegating to a helper) nor touches settings or
 * roles directly. Narrower than the hand-written list it replaces, and not
 * airtight.
 */
/**
 * Files a tell matches that are NOT provisioning a new library, with the reason.
 * One entry, and it has to earn it — this is the escape hatch the hand-written
 * list was, so it stays short and every line says why.
 */
const NOT_PROVISIONERS: Record<string, string> = {
  'scripts/tenant-relocate.ts':
    'creates the DESTINATION database of a move and fills it with pg_restore from the ' +
    "source's dump — which already carries that library's settings row and roles. Seeding " +
    'it would write defaults over a restore, or collide with it.',
};

const PROVISIONERS = SEARCH_ROOTS.flatMap((r) => sources(r))
  .filter((rel) => !IMPLEMENTATIONS.has(rel) && !(rel in NOT_PROVISIONERS))
  .filter((rel) => PROVISIONER_TELLS.some((re) => re.test(code(rel))));

describe('the seed every provisioning path runs', () => {
  it('every excepted file still looks like a provisioner, so the reason still applies', () => {
    // An exception for a file that no longer matches any tell is an exception
    // nobody needs, and it would quietly cover a future file of the same name.
    for (const rel of Object.keys(NOT_PROVISIONERS)) {
      expect(
        PROVISIONER_TELLS.some((re) => re.test(code(rel))),
        `${rel} is excepted but no longer matches any tell — delete the exception`,
      ).toBe(true);
    }
  });

  it('finds the provisioners rather than trusting a list', () => {
    // If discovery stops matching, every assertion below becomes vacuous and
    // green — the failure mode a structural test is most prone to.
    expect(PROVISIONERS.length, 'discovered no provisioners at all').toBeGreaterThanOrEqual(4);
    for (const known of [
      'apps/api/src/provisioning/tenant-provisioning.service.ts', // /auth/signup
      'apps/api/src/maintenance/maintenance-processors.ts', // the operator "fix" pass
      'scripts/tenant-create.ts', // admin CLI provisioning
      'packages/db-tenant/prisma/seed-defaults.ts', // the operator seed CLI
    ]) {
      expect(PROVISIONERS, `${known} is no longer recognised as a provisioner`).toContain(known);
    }
  });

  it.each(PROVISIONERS)('%s seeds through the shared module', (rel) => {
    // `seedTenantDefaults(` or `seedTenantSettings(` — a CALL, not the bare
    // name. `toContain` on the identifier passed on a file that had deleted its
    // only call and kept a wrapper named `seedTenantDefaultsFor`: an assertion
    // believing a substring.
    expect(code(rel), `${rel} never calls the shared seed`).toMatch(
      /\bseedTenant(Defaults|Settings)\(/,
    );
  });

  it('no provisioner keeps its own copy of the settings values', () => {
    // Not one field. ANY of the settings keys written as an object property is
    // a defaults object being reconstructed — which survives a rename of the
    // one field an earlier version of this test happened to know about, and
    // survives a value being computed rather than literal.
    const keys = Object.keys(DEFAULT_TENANT_SETTINGS).filter((k) => k !== 'id');
    for (const rel of PROVISIONERS) {
      const src = code(rel);
      const present = keys.filter((k) => new RegExp(`\\b${k}\\s*:`).test(src));
      expect(
        present,
        `${rel} declares its own settings defaults (${present.join(', ')})`,
      ).toHaveLength(0);
    }
  });

  it('the values are the ones a small library would choose', () => {
    // Pinned so a change to them is a deliberate edit to a test, not a silent
    // change to what every new library starts with.
    expect(DEFAULT_TENANT_SETTINGS).toEqual({
      id: 1,
      currency: 'EUR',
      loanPeriodDays: 14,
      maxRenewals: 2,
      finePerDayCents: 10,
      fineCapCents: 500,
      holdPickupHours: 48,
      maxActiveLoans: 0,
      defaultLocale: 'el',
    });
  });

  it('two of them deliberately disagree with the Prisma column defaults', () => {
    // Not a duplicate of the schema. The schema answers "this column must have
    // a value" with 0; the seed answers "this is the rate a library would
    // choose" with €0.10/day capped at €5. `overdueFinesEnabled` stays false,
    // so the rate is inert until somebody turns fines on — and is then already
    // sensible rather than zero.
    const schema = read('packages/db-tenant/prisma/schema/02-settings.prisma');
    expect(schema).toMatch(/finePerDayCents\s+Int\s+@default\(0\)/);
    expect(schema).toMatch(/fineCapCents\s+Int\s+@default\(0\)/);
    expect(schema).toMatch(/overdueFinesEnabled\s+Boolean\s+@default\(false\)/);
    expect(DEFAULT_TENANT_SETTINGS.finePerDayCents).toBe(10);
    expect(DEFAULT_TENANT_SETTINGS.fineCapCents).toBe(500);
  });

  it('the "fix" pass takes the VALUES and not the role reconciliation', () => {
    // Deliberate, and the one place the sharing stops. `reconcileSystemRoles`
    // adds back every template key a role does not hold — including one a
    // library removed from a built-in role on purpose. Defensible when
    // provisioning a database with no history; not when an operator clicks
    // "fix" scoped to `all` to repair one unrelated library and re-grants
    // permissions across the whole fleet.
    const src = code('apps/api/src/maintenance/maintenance-processors.ts');
    expect(src).toMatch(/\bseedTenantSettings\(/);
    expect(src, 'the fleet-wide fix pass must not reconcile roles').not.toMatch(
      /\bseedTenantDefaults\(|\breconcileSystemRoles\(/,
    );
  });
});
