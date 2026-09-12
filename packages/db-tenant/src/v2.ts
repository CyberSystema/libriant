import { PG_SESSION_OPTIONS } from '@libriant/shared/postgres-session';

/**
 * Where the Libriant 2.0 tenant schema lives, and how to point a connection at
 * it.
 *
 * ## One constant, because four places have to agree
 *
 * `scripts/tenant-create.ts`, `scripts/tenant-migrate.ts`,
 * `TenantProvisioningService.applyTenantMigrations` and
 * `maintenance-processors.ts` each run `prisma migrate deploy` for a tenant, and
 * each must now run it twice — once bare for the 1.0 folder, once with
 * `--config prisma-v2.config.ts` and this schema on the URL. A tenant that gets
 * only the first is a 1.0 database that every 2.0 service fails against at the
 * first query, and the failure surfaces on the library's machine rather than in
 * CI. Four hardcoded string literals is how three of them end up agreeing and
 * one does not.
 *
 * ## Why a separate schema at all
 *
 * Nine physical table names collide between 1.0 and 2.0, `loans` and `audit_log`
 * among them, and `loans` cannot be deferred: phase 16 builds the 2.0
 * circulation engine on it, and phase 16 precedes the phase-19/20 cutover. Two
 * Prisma schema folders solve the modelling collision (Prisma refuses two models
 * on one physical name with P1012) but not the Postgres one — `CREATE TABLE
 * loans` still fails with 42P07 against a database that has 1.0's.
 *
 * A second Postgres schema solves both, and it is what the phase-9 acceptance
 * criterion means by "applies to a 1.0 tenant DB **as a second schema**, not yet
 * cut over". Phase 20's cutover is then `ALTER SCHEMA public RENAME TO
 * v1_archive; ALTER SCHEMA lbr2 RENAME TO public;`.
 */

/**
 * Where a tenant's 2.0 tables are BEFORE `tenant-upgrade-v2.ts` promotes them.
 *
 * Still a constant, and still the right default: every database is provisioned
 * this way and stays this way until its own cutover commits. What changed in 2.0
 * phase 20f is that it stopped being the only answer — see {@link v2SchemaFor}.
 */
export const V2_SCHEMA = 'lbr2';

/** Where they are AFTER the promotion, which is `ALTER SCHEMA lbr2 RENAME TO public`. */
export const V2_SCHEMA_PROMOTED = 'public';

/**
 * Which schema THIS tenant's 2.0 tables are in (2.0 phase 20f).
 *
 * `tenant_schema_state.schemaMajor` is the fleet flag the upgrade stamps after
 * it commits: "1 = the pre-2.0 shape; the 2.0 upgrade sets 2". A promotion
 * happens one database at a time and a deploy reaches every tenant at once, so
 * for as long as the promotions take, both populations are live and the
 * application has to serve both.
 *
 * DEFAULTS TO UNPROMOTED, and the direction matters. A tenant whose flag has not
 * been read yet, or whose row does not exist, is one that has never been
 * upgraded — the upsert that writes 2 runs only after a cutover commits. Reading
 * a missing row as "probably promoted" would point a working library's client at
 * a schema it does not have.
 */
export function v2SchemaFor(schemaMajor: number | null | undefined): string {
  return (schemaMajor ?? 1) >= 2 ? V2_SCHEMA_PROMOTED : V2_SCHEMA;
}

/**
 * The Postgres session options a 2.0 connection opens with.
 *
 * `search_path` is what lets hand-written SQL in a 2.0 service name its tables
 * WITHOUT a schema and still be right for both populations — see the measured
 * note in `client.ts`. `public` is second and not optional: the extensions
 * (`citext`, `pg_trgm`, `unaccent`) live there, and an index expression or a
 * cast that cannot see them is a silently different query plan or a hard
 * `42883`.
 *
 * The timezone option is carried through unchanged; every session this product
 * opens is UTC and `postgres-session.ts` is the file that says why.
 */
export function v2SessionOptions(schema: string): string {
  if (schema === V2_SCHEMA_PROMOTED) return `${PG_SESSION_OPTIONS} -c search_path=public`;
  return `${PG_SESSION_OPTIONS} -c search_path=${schema},public`;
}

/**
 * The same tenant URL, pointed at the 2.0 schema.
 *
 * Prisma reads `?schema=` and uses it for the session `search_path` AND for
 * where it keeps `_prisma_migrations` — so the two migration ledgers are fully
 * independent rather than sharing one table and each ignoring the other's rows.
 *
 * Parsed rather than string-concatenated: tenant URLs already carry
 * `connection_limit`, `pool_timeout` and `sslmode` in places, and a naive `?` vs
 * `&` decision is the kind of thing that works on every developer machine and
 * fails on the one tenant whose URL has a parameter.
 */
export function withV2Schema(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', V2_SCHEMA);
  return parsed.toString();
}
