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

/** The Postgres schema holding the 2.0 tenant tables until the phase-20 cutover. */
export const V2_SCHEMA = 'lbr2';

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
