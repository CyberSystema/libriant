/**
 * Every Postgres session this product opens is UTC, and this is the file that
 * says so.
 *
 * ## THE PRECONDITION NOBODY WROTE DOWN
 *
 * `@prisma/adapter-pg` requires a UTC session and does not say so. Both halves
 * of its `timestamptz` handling assume it, and both are silent when it is false.
 * MEASURED against `@prisma/adapter-pg@7.9.1` on a session whose `TimeZone` is
 * `Europe/Athens`:
 *
 * ```
 *   WRITE — a JS Date of 2026-03-01T10:00:00.000Z reaches the server as
 *     Prisma      2026-03-01 10:00:00              <- naive, NO zone
 *     node-pg     2026-03-01T12:00:00.000+02:00    <- an explicit offset
 *   so Postgres resolves Prisma's value in the SESSION zone and stores
 *     2026-03-01 10:00:00+02   =  08:00Z, two hours EARLY.
 *
 *   READ — the adapter's own normaliser, verbatim:
 *     function normalize_timestamptz(time) {
 *       return time.replace(" ", "T").replace(/[+-]\d{2}(:\d{2})?$/, "+00:00");
 *     }
 *   Postgres renders a timestamptz in the session zone WITH its real offset;
 *   this strips that offset and asserts "+00:00" — it declares the local wall
 *   clock to be UTC.
 * ```
 *
 * The two errors are equal and opposite, so a Prisma-only round trip agrees with
 * itself and every comparison in the application is correct. That is why nothing
 * caught this: it is invisible from inside Prisma. What is wrong is
 *
 *   - the instant PHYSICALLY STORED, by the session's offset AT THAT INSTANT —
 *     so it is two hours in winter and three in summer, and every reader that is
 *     not Prisma (psql, a report, a restored dump, a trigger, a CHECK, a
 *     partition bound) sees the wrong time;
 *   - and, once a year, the data itself. On the spring-forward night the naive
 *     local time Prisma sends DOES NOT EXIST, so Postgres moves it. MEASURED:
 *
 *         wrote  2027-03-28T03:30:00.000Z
 *         read   2027-03-28T04:30:00.000Z     silently, with no error
 *
 *     For that one hour the round trip is not self-consistent either: the
 *     application cannot store those instants at all.
 *
 * ## WHY IT HAS NEVER BITTEN
 *
 * Every deployed cluster is already UTC, by accident rather than by decision:
 * `postgres:16-alpine` in both compose files and in CI defaults to UTC, so the
 * offset is zero and both halves of the bug cancel to nothing. The one cluster
 * that is NOT UTC is a developer's local Postgres — which is exactly where the
 * test suites run. Nothing stated the precondition and nothing enforced it, so
 * "correct" and "correct on this host" were indistinguishable.
 *
 * ## WHY THIS IS A CONSTANT AND NOT A LITERAL AT EACH CALL SITE
 *
 * There are two Prisma client factories in `@libriant/db-tenant` and one in
 * `@libriant/db-control`, and both packages depend on this one while it depends
 * on nothing. Three copies of a string is three chances for one of them to be
 * edited, and the failure mode of the odd one out is silent — it is this whole
 * docblock, on one connection pool.
 *
 * `scripts/check-pg-session.ts` is the gate: it refuses any `PrismaPg`
 * constructed without this option.
 *
 * ## WHY THE CONNECTION AND NOT ONLY THE DATABASE
 *
 * `ALTER DATABASE … SET TimeZone TO 'UTC'` is also applied at provisioning, and
 * it is the layer that covers everything which is not this application —
 * `prisma migrate deploy`, `psql`, `pg_dump`, the smoke harness. But it is a
 * DEFAULT: it can be overridden, it is absent from any database this product did
 * not create, and it says nothing about a customer's own Postgres in a
 * self-hosted install. A startup option is `PGC_S_CLIENT` and OUTRANKS
 * `PGC_S_DATABASE` — MEASURED: a database set to `Asia/Kolkata` still yields
 * `UTC` on a connection carrying this option — so this is the layer that makes
 * the application correct wherever it is pointed.
 *
 * Verified to survive pgbouncer 1.25.2 in TRANSACTION pooling mode, which is
 * what `docker-compose.prod.yml` runs. The control plane connects through it.
 */

/**
 * The zone every session must report. `SHOW TimeZone` returns exactly this.
 *
 * Postgres echoes the spelling it was given, so the assertion is a string
 * comparison rather than an offset computation — which is the point: an offset
 * of zero is also what a correctly-configured Iceland gives you, and that is not
 * the same claim.
 */
export const PG_SESSION_TIMEZONE = 'UTC';

/**
 * The `options` startup parameter for every Postgres connection this product
 * opens, Prisma or otherwise.
 *
 * `-c timezone=UTC` and nothing else. Anything added here reaches every pool in
 * the product, including the one a library's circulation desk is holding.
 */
export const PG_SESSION_OPTIONS = `-c timezone=${PG_SESSION_TIMEZONE}`;

/**
 * `ALTER DATABASE … SET TimeZone TO 'UTC'` — the MECHANISM, of which
 * {@link PG_SESSION_OPTIONS} is only the backstop.
 *
 * A per-database default reaches every connection to that database, including
 * the three this application cannot put an option on:
 *
 *   `prisma migrate deploy`   a subprocess whose Rust schema engine is
 *                             tokio-postgres and IGNORES libqp environment
 *                             variables — `PGOPTIONS` does nothing, which is
 *                             the first thing the next person will try;
 *   `psql`, `pg_dump`         the runbook, the DR drill, an operator at 03:00;
 *   the smoke harness         and anything else holding a bare `pg` client.
 *
 * Provisioning runs it BEFORE the migrations, which is what makes the partition
 * bounds those migrations create land on UTC day boundaries.
 *
 * ## It is per-DATABASE, and that is a per-site obligation
 *
 * MEASURED: `CREATE DATABASE child TEMPLATE pinned` does NOT inherit the
 * setting — the child came back `Europe/Athens`. So every place that creates a
 * database has to pin it, which is why `check:session-timezone` refuses a
 * `CREATE DATABASE` with no pin beside it rather than trusting a template.
 *
 * ## Not `ALTER SYSTEM`, and not `postgresql.conf`
 *
 * Neither is in a backup, and a DR rebuild drops both silently — which is the
 * exact shape of failure this whole change exists to close. The compose
 * `command:` flag is the version-controlled equivalent for our own cluster.
 *
 * The identifier cannot be parameterised in DDL, so it is validated here rather
 * than at three call sites — the same guard the `CREATE DATABASE` sites carry.
 */
export function pinDatabaseTimezoneSql(dbName: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName)) {
    throw new Error(
      `Refusing to build ALTER DATABASE DDL with the identifier ${JSON.stringify(dbName)}.`,
    );
  }
  return `ALTER DATABASE "${dbName}" SET TimeZone TO '${PG_SESSION_TIMEZONE}'`;
}

/**
 * Refuse a session that is not UTC, with a sentence somebody can act on.
 *
 * PURE — the caller runs its own `SHOW TimeZone` / `current_setting('TimeZone')`
 * and passes the answer — so this file keeps its zero dependencies and stays
 * unit-testable without a database.
 *
 * The call that matters is on a connection carrying NO `options`, because that
 * is the only one that can still see the database's true default. A probe made
 * through the application's own pool would be told UTC by the backstop and would
 * therefore never notice a database that was never pinned.
 */
export function assertSessionTimezone(actual: string, where: string): void {
  if (actual === PG_SESSION_TIMEZONE) return;
  throw new Error(
    `${where}: the Postgres session reports TimeZone=${actual}, not ${PG_SESSION_TIMEZONE}. ` +
      '@prisma/adapter-pg encodes and decodes timestamptz as if the session local wall clock ' +
      'were UTC, in BOTH directions — so on this session every instant Prisma writes is stored ' +
      'wrong by the offset, and once a year, on the spring-forward night, the value is silently ' +
      'moved by an hour. Run ' +
      `\`${pinDatabaseTimezoneSql('<database>')}\` and reconnect. ` +
      'See packages/shared/src/postgres-session.ts for the measurement.',
  );
}
