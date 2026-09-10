import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTenantPrismaClientV2 } from '@libriant/db-tenant';
import {
  PG_SESSION_OPTIONS,
  PG_SESSION_TIMEZONE,
  pinDatabaseTimezoneSql,
} from '@libriant/shared/postgres-session';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Nothing here reaches a plan gate. It provisions a throwaway database and asks Postgres what ' +
    'time it thinks it is.',
);

/**
 * The Postgres session is UTC, and this is the test that can tell.
 *
 * ## WHY THE OBVIOUS TEST PROVES NOTHING
 *
 * `@prisma/adapter-pg` encodes and decodes `timestamptz` as if the session's
 * local wall clock were UTC — `packages/shared/src/postgres-session.ts` carries
 * the measurement. On a UTC session the two errors are zero, so ANY assertion
 * about instants passes whether or not the fix is present. CI's Postgres service
 * is `postgres:16-alpine` with no `TZ`, which is UTC. So a spec written the
 * obvious way is green in CI for ever, in both worlds, and says nothing.
 *
 * The four candidate designs, and why three of them fail:
 *
 *   (a) put `TZ` on the CI postgres service — protects CI only, leaves a
 *       developer's cluster and a customer's uncovered, and puts the precondition
 *       in a YAML file that has already drifted once (`LANG: el_GR.UTF-8`, which
 *       Alpine's musl silently ignored for months).
 *   (b) have the spec `SET TIME ZONE` on the connection under test — INVERTS. A
 *       session `SET` is `PGC_S_SESSION` and outranks the connection option, so
 *       the spec would fail WITH the fix and pass without it. It also lands on
 *       one of several pooled backends, so it is flaky in whichever direction.
 *   (c) give the spec its OWN database and pin THAT to a non-UTC zone. ✔
 *   (d) assert the `options` string is present — that is the GATE
 *       (`check:session-timezone`), not the test. It proves a literal, not a
 *       session.
 *
 * (c) is the one that discriminates, and it discriminates identically on a
 * developer's Athens cluster and on CI's UTC one, because the spec makes the
 * non-UTC-ness itself. No `verify.yml` change, nothing to drift.
 *
 * ## Asia/Kolkata, and why not Athens
 *
 * `+05:30` has no DST, so the expected offset is a constant rather than a value
 * that changes with the calendar — an Athens expectation would be +2 in winter
 * and +3 in summer and would rot. The half hour is not decoration either: it
 * exercises the optional-minutes branch of the adapter's own regex,
 * `/[+-]\d{2}(:\d{2})?$/`. The zone ships in `postgres:16-alpine`.
 *
 * ## Every precondition THROWS rather than skipping
 *
 * A spec that skips itself when it cannot do its job is the silently-green
 * failure this whole change exists to close.
 */
const tag = randomBytes(4).toString('hex');
const DB = `tenant_tzspec_${tag}`;
const HOSTILE_ZONE = 'Asia/Kolkata';
/** +05:30, in seconds. The whole point of a DST-free zone is that this is fixed. */
const HOSTILE_OFFSET_SECONDS = 19_800;
/** A round UTC instant, deliberately not near a day boundary in either zone. */
const PROBE = new Date('2026-10-01T03:00:00.000Z');

const superuserUrl = () => {
  const url = process.env.PG_SUPERUSER_URL;
  if (!url)
    throw new Error(
      'PG_SUPERUSER_URL is not set; this spec needs a superuser to create a database.',
    );
  return url;
};
const urlFor = (db: string) => {
  const u = new URL(superuserUrl());
  u.pathname = `/${db}`;
  return u.toString();
};

async function onAdmin<T>(fn: (c: PgClient) => Promise<T>): Promise<T> {
  const c = new PgClient({ connectionString: superuserUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** A connection with NO `options`, so it observes the database's true default. */
async function onPlain<T>(db: string, fn: (c: PgClient) => Promise<T>): Promise<T> {
  const c = new PgClient({ connectionString: urlFor(db) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await onAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${DB}"`);
    await c.query(`CREATE DATABASE "${DB}" ENCODING 'UTF8'`);
    await c.query(pinDatabaseTimezoneSql(DB));
  });
  await onPlain(DB, async (c) => {
    await c.query('CREATE SCHEMA IF NOT EXISTS lbr2');
    // One table, shaped like the columns that matter. The spec deliberately does
    // not run the migrations: it is about the connection, not the datamodel, and
    // a migration run would take minutes and drag in every other precondition.
    await c.query(`CREATE TABLE lbr2.tz_probe (id text PRIMARY KEY, at timestamptz(3) NOT NULL)`);
  });
}, 120_000);

afterAll(async () => {
  await onAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${DB}"`).catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// A. The pin itself
// ---------------------------------------------------------------------------

describe('a provisioned database is pinned to UTC', () => {
  it('records the setting on the database, where every client sees it', async () => {
    // `pg_db_role_setting` is the catalogue, so this asserts the DDL landed
    // rather than that some session happens to be UTC.
    const settings = await onAdmin(async (c) =>
      (
        await c.query<{ setconfig: string[] | null }>(
          `SELECT s.setconfig FROM pg_catalog.pg_db_role_setting s
             JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
            WHERE d.datname = $1`,
          [DB],
        )
      ).rows.map((r) => r.setconfig ?? []),
    );
    expect(settings.flat()).toContain(`TimeZone=${PG_SESSION_TIMEZONE}`);
  });

  it('is what a bare connection — psql, pg_dump, prisma migrate deploy — gets', async () => {
    // The three connections no pool option can reach. `prisma migrate deploy`
    // is the one that matters most: its Rust schema engine is tokio-postgres and
    // ignores `PGOPTIONS`, so the database default is the ONLY thing that makes
    // the partitions it creates land on UTC day boundaries.
    const tz = await onPlain(DB, async (c) => (await c.query('SHOW TimeZone')).rows[0].TimeZone);
    expect(tz).toBe(PG_SESSION_TIMEZONE);
  });
});

// ---------------------------------------------------------------------------
// B. THE DISCRIMINATOR
// ---------------------------------------------------------------------------

describe('the adapter option survives a hostile database default', () => {
  it('stores the true instant, while a client without the option is wrong by the offset', async () => {
    // Point the database at a zone that is NOT UTC. This is what makes the test
    // work identically on a UTC cluster and on a non-UTC one: the spec supplies
    // the hostility rather than inheriting it.
    await onAdmin(async (c) => c.query(`ALTER DATABASE "${DB}" SET TimeZone TO '${HOSTILE_ZONE}'`));
    try {
      // PRECONDITION, asserted rather than assumed: the zone exists in this
      // image and really is +05:30 at the probe instant.
      const offset = await onPlain(DB, async (c) =>
        Number(
          (
            await c.query<{ off: string }>(
              // `pg_catalog.date_part`, not `EXTRACT`. EXTRACT is a SQL
              // CONSTRUCT with its own grammar, so `pg_catalog.extract(… FROM …)`
              // is a syntax error — the same trap COALESCE and NULLIF set, and
              // this spec walked into it once while being written.
              `SELECT pg_catalog.date_part('timezone', TIMESTAMPTZ '2026-10-01T03:00:00Z')::text AS off`,
            )
          ).rows[0].off,
        ),
      );
      expect(
        offset,
        `${HOSTILE_ZONE} did not resolve to +05:30 on this server; the discriminator below ` +
          'cannot distinguish anything.',
      ).toBe(HOSTILE_OFFSET_SECONDS);

      // THE FIX. `makeTenantPrismaClientV2` carries `PG_SESSION_OPTIONS`, which
      // is PGC_S_CLIENT and outranks the database's PGC_S_DATABASE — MEASURED:
      // against a database pinned to Asia/Kolkata a connection carrying the
      // option still reports UTC.
      const fixedClient = makeTenantPrismaClientV2({ databaseUrl: urlFor(DB) });
      await fixedClient.$executeRaw`INSERT INTO lbr2.tz_probe (id, at) VALUES ('fixed', ${PROBE})`;

      // NEGATIVE CONTROL 1 — THE ENVIRONMENT IS REALLY HOSTILE.
      //
      // The adapter puts a NAIVE timestamp on the wire — MEASURED, a JS Date of
      // 2026-03-01T10:00:00Z arrives as the text `2026-03-01 10:00:00`, with no
      // zone, where node-pg would have sent `…+02:00`. So the write is wrong by
      // whatever the session resolves that naive string to. This asserts the
      // database does resolve it 5½ hours away, which is the only reason the
      // assertion above can fail at all. Without this, a database that quietly
      // stayed UTC would make the whole spec pass while proving nothing.
      const naive = await onPlain(
        DB,
        async (c) =>
          (await c.query<{ at: Date }>(`SELECT '2026-10-01 03:00:00'::timestamptz AS at`)).rows[0]
            .at,
      );
      expect(
        naive.getTime(),
        `A naive timestamp did not resolve ${HOSTILE_OFFSET_SECONDS}s away on this database, so ` +
          'the ALTER DATABASE above did not take effect and nothing below discriminates.',
      ).toBe(PROBE.getTime() - HOSTILE_OFFSET_SECONDS * 1000);

      // NEGATIVE CONTROL 2 — THE ADAPTER STILL BEHAVES THE WAY THIS FIX ASSUMES.
      //
      // Ask the server what it actually received for a bound Date. Today it is a
      // naive string, which is the entire defect. If a future
      // `@prisma/adapter-pg` starts sending an offset — or a UTC-normalised
      // value — this fails, and that failure is the signal to delete the
      // workaround rather than to carry it for ever.
      const onTheWire = await fixedClient.$queryRaw<{ text: string }[]>`
        SELECT ${PROBE}::text AS text`;
      expect(
        onTheWire[0]!.text,
        'The adapter no longer sends a naive timestamp. Re-read the measurement in ' +
          'packages/shared/src/postgres-session.ts: if it now sends an offset, the session-timezone ' +
          'workaround may be removable, and this spec is the place that noticed.',
      ).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      // Read the fixed write with a plain `pg` client, which is the
      // MEASURED-correct reader for timestamptz: it puts an explicit offset on
      // the wire in both directions, so it has no opinion to be wrong about.
      const stored = await onPlain(
        DB,
        async (c) =>
          (await c.query<{ at: Date }>(`SELECT at FROM lbr2.tz_probe WHERE id='fixed'`)).rows[0].at,
      );
      expect(
        stored.getTime(),
        'The client carrying PG_SESSION_OPTIONS stored the wrong instant. The option is missing, ' +
          'or something outranked it — a session-level SET TIME ZONE would.',
      ).toBe(PROBE.getTime());

      await fixedClient.$disconnect();
    } finally {
      await onAdmin(async (c) => c.query(pinDatabaseTimezoneSql(DB)));
      await onPlain(DB, async (c) => c.query(`DELETE FROM lbr2.tz_probe`));
    }
  }, 120_000);

  it('round-trips an instant that has no local wall clock, which is the one the app cannot store', async () => {
    // The spring-forward hour. Athens has no 03:30 on 2027-03-28, so the naive
    // local string the adapter sends for 03:30Z is resolved FORWARD by Postgres
    // and the reader then calls the result UTC. MEASURED without the fix:
    //     wrote 2027-03-28T03:30:00.000Z  ->  read 2027-03-28T04:30:00.000Z
    // silently, with no error. For that hour the round trip is not even
    // self-consistent, so "wrong on disk but consistent in the app" is not the
    // whole defect.
    await onAdmin(async (c) => c.query(`ALTER DATABASE "${DB}" SET TimeZone TO 'Europe/Athens'`));
    try {
      const gap = new Date('2027-03-28T03:30:00.000Z');
      const fixed = makeTenantPrismaClientV2({ databaseUrl: urlFor(DB) });
      await fixed.$executeRaw`INSERT INTO lbr2.tz_probe (id, at) VALUES ('gap', ${gap})`;
      const back = await fixed.$queryRaw<{ at: Date }[]>`
        SELECT at FROM lbr2.tz_probe WHERE id = 'gap'`;
      await fixed.$disconnect();
      expect(back[0]!.at.getTime()).toBe(gap.getTime());

      const truth = await onPlain(
        DB,
        async (c) =>
          (await c.query<{ at: Date }>(`SELECT at FROM lbr2.tz_probe WHERE id='gap'`)).rows[0].at,
      );
      expect(truth.getTime()).toBe(gap.getTime());
    } finally {
      await onAdmin(async (c) => c.query(pinDatabaseTimezoneSql(DB)));
      await onPlain(DB, async (c) => c.query(`DELETE FROM lbr2.tz_probe`));
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// C. The fixture-free invariant
// ---------------------------------------------------------------------------

describe('every timestamptz-keyed partition sits on a UTC day boundary', () => {
  it('holds for a database this suite provisioned through the real path', async () => {
    // No fixture: this reads the catalogue of whatever partitioned tables exist,
    // so a table added by a later phase is covered the day it is added.
    //
    // Run on a UTC-forced connection, because the RENDERING of a bound is the
    // session's — on an Athens session this very query falsely fails a
    // date-keyed table. Date-keyed parents are excluded by KEY TYPE rather than
    // by pattern-matching the bound: their bounds carry no zone and are immune.
    const url = process.env.CONTROL_DATABASE_URL;
    if (!url) throw new Error('CONTROL_DATABASE_URL is not set.');
    const tenantDb = await onAdmin(
      async (c) =>
        (
          await c.query<{ datname: string }>(
            `SELECT datname FROM pg_catalog.pg_database WHERE datname LIKE 'tenant_%' ORDER BY datname DESC LIMIT 1`,
          )
        ).rows[0]?.datname,
    );
    if (!tenantDb) {
      throw new Error(
        'No tenant_* database exists on this server, so the partition invariant has nothing to ' +
          'check. Run another integration spec first, or provision a tenant.',
      );
    }

    const c = new PgClient({ connectionString: urlFor(tenantDb), options: PG_SESSION_OPTIONS });
    await c.connect();
    try {
      const tz = (await c.query('SHOW TimeZone')).rows[0].TimeZone;
      expect(tz, 'the invariant query must run on a UTC session or it reports nonsense').toBe(
        PG_SESSION_TIMEZONE,
      );
      const bad = await c.query<{ parent: string; part: string; bound: string }>(
        `SELECT p.relname AS parent, ch.relname AS part,
                pg_catalog.pg_get_expr(ch.relpartbound, ch.oid) AS bound
           FROM pg_catalog.pg_inherits i
           JOIN pg_catalog.pg_class ch ON ch.oid = i.inhrelid
           JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
           JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
           JOIN pg_catalog.pg_partitioned_table pt ON pt.partrelid = p.oid
           JOIN pg_catalog.pg_attribute a
             ON a.attrelid = p.oid AND a.attnum = pt.partattrs[0]
          WHERE n.nspname = 'lbr2'
            AND ch.relkind = 'r'
            AND a.atttypid = 'timestamptz'::regtype
            AND pg_catalog.pg_get_expr(ch.relpartbound, ch.oid) !~
                '^FOR VALUES FROM \\\\(''[0-9-]+ 00:00:00\\\\+00''\\\\) TO \\\\(''[0-9-]+ 00:00:00\\\\+00''\\\\)$'`,
      );
      expect(
        bad.rows.map((r) => `${r.parent}.${r.part} ${r.bound}`),
        `${tenantDb} has partitions whose bounds are not UTC day boundaries. They were created by ` +
          'a session that was not UTC; adding a UTC-bounded partition beside them leaves a hole ' +
          'that every write into it fails with 23514. See scripts/tenant-timezone-audit.ts.',
      ).toEqual([]);
    } finally {
      await c.end();
    }
  }, 120_000);
});
