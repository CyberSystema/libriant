import { defineConfig } from 'prisma/config';
import { withV2Schema } from './src/v2.js';

/**
 * The SECOND tenant datamodel: Libriant 2.0, in its own Postgres schema.
 *
 * ## The collision, and why a second schema rather than a second folder
 *
 * Nine physical table names collide between 1.0 and 2.0 — `loans`, `roles`,
 * `role_permissions`, `staff_profiles`, `staff_role_grants`,
 * `staff_permission_overrides`, `audit_log`, `tenant_settings`. Eight could be
 * deferred to the phase-20 cutover. `loans` cannot: phase 16 builds the 2.0
 * circulation engine on 2.0 `loans`, and phase 16 comes BEFORE the cutover. So
 * the two datamodels coexist for eleven phases.
 *
 * That collides twice over, and the two are different problems:
 *
 *   - IN PRISMA. Two models mapped to one physical name is refused outright
 *     (measured on 7.9.1: `P1012 — The model with database name "roles" could
 *     not be defined because another model or view with this name exists`).
 *     A second schema FOLDER fixes that much.
 *   - IN POSTGRES. 1.0's `loans` physically exists in every tenant database, so
 *     `CREATE TABLE loans` fails with 42P07 no matter how many Prisma folders
 *     there are. A second folder does not help at all.
 *
 * The acceptance criterion for phase 9 says the baseline must apply to a 1.0
 * tenant DB "as a second schema, not yet cut over", and that turns out to be
 * literal and to solve both problems at once. Measured end to end:
 *
 *   - `prisma migrate deploy` against `…/db?schema=lbr2` CREATES the schema,
 *     puts `_prisma_migrations` INSIDE it, and creates the tables there. The
 *     two ledgers are therefore fully independent — better than sharing one,
 *     where each folder would have to ignore rows it did not write.
 *   - `public.loans` and `lbr2.loans` coexist with different columns.
 *   - An `EXCLUDE USING gist` in `lbr2` resolves `btree_gist` installed in
 *     `public` and raises 23P01 correctly.
 *   - Phase 20's cutover is then `ALTER SCHEMA public RENAME TO v1_archive;
 *     ALTER SCHEMA lbr2 RENAME TO public;` — which is the exact shape §10 of
 *     the master architecture already specifies for the rollback, and which
 *     leaves every 2.0 constraint working.
 *
 * So all nine collisions vanish, `audit_log` included: the 2.0 one is created
 * partitioned from scratch in `lbr2` rather than rebuilt in place.
 *
 * ## What the folder additionally buys
 *
 * It is the SCOPE DISCRIMINATOR for `check:schema-conventions`. The 1.0
 * datamodel violates every §3 convention (measured: all 60 instant columns are
 * `timestamp` WITHOUT time zone, all 7 money columns are `INTEGER` or `TEXT`,
 * every physical column is camelCase). With one folder the gate would need a
 * `LEGACY_MODELS` allowlist naming essentially the whole schema, which is a
 * gate that checks nothing. With two, "is this held to the 2.0 conventions?" is
 * answered by which directory the file is in, and there is no list to go stale.
 *
 * ## The URL carries `?schema=lbr2`, and THIS FILE is what guarantees it
 *
 * `scripts/tenant-migrate.ts`, `scripts/tenant-create.ts`,
 * `TenantProvisioningService.applyTenantMigrations` and
 * `maintenance-processors.ts` each run `prisma migrate deploy` once today and
 * must run it twice — bare for the 1.0 folder, then `--config
 * prisma-v2.config.ts`. A tenant that gets only the first is a 1.0 database
 * that every 2.0 service fails against at its first query, so
 * `tenant-schema-v2.spec.ts` provisions through the real service and asserts
 * the `lbr2` tables are there.
 *
 * The SCHEMA, though, is applied here rather than by each caller. It was a
 * caller's job for about an hour, and in that hour the CI step that runs
 * `prisma:migrate:deploy:v2` from a shell — where there is no `withV2Schema` to
 * call — would have deployed the whole baseline into `public`, on top of the 1.0
 * schema, and reported success. `withV2Schema` is idempotent (it sets a search
 * parameter rather than appending one), so the callers that do apply it are
 * still correct; this is the guarantee that the ones that forget are too.
 *
 * Deleted by phase 20, which promotes `lbr2` to `public` and leaves this as the
 * only datamodel.
 */
export default defineConfig({
  schema: 'prisma/schema-v2',
  migrations: {
    path: 'prisma/migrations-v2',
  },
  datasource: {
    // `?? ''` keeps `prisma generate` working with no env var set, and an empty
    // string is not a URL, so it must not go through `withV2Schema`.
    url: process.env.TENANT_DATABASE_URL ? withV2Schema(process.env.TENANT_DATABASE_URL) : '',
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
});
