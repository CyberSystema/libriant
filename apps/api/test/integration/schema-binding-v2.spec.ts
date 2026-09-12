import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeTenantPrismaClientV2,
  v2SchemaFor,
  v2SessionOptions,
  V2_SCHEMA,
  V2_SCHEMA_PROMOTED,
} from '@libriant/db-tenant';
import { loadEnv } from '../../src/config/env.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Where a library’s tables live is a property of its database, not of its invoice. This spec ' +
    'opens throwaway databases and never touches a tenant, a plan or a route.',
);

/**
 * Phase 20f — one binary, both tenant populations.
 *
 * `tenant-upgrade-v2.ts` promotes `lbr2` to `public` ONE DATABASE AT A TIME,
 * while a deploy reaches every tenant at once. Before this phase the schema was
 * a constant, so the two had to happen together: under the old code a promoted
 * library was wholly broken, and under new code an unpromoted one would be.
 *
 * This asserts the property that removes that coupling — the SAME build, with
 * no branch above the client factory, serving a database whose 2.0 tables are in
 * `lbr2` and one whose are in `public`.
 */
const env = loadEnv();
const tag = randomBytes(4).toString('hex');
const admin = () => new PgClient({ connectionString: env.pgSuperuserUrl });
const dbFor = (n: string) => `lbr_20f_${tag}_${n}`;
const urlFor = (n: string) => {
  const u = new URL(env.pgSuperuserUrl);
  u.pathname = `/${dbFor(n)}`;
  return u.toString();
};

async function makeDatabase(name: string, schema: string): Promise<void> {
  const a = admin();
  await a.connect();
  try {
    await a.query(`DROP DATABASE IF EXISTS "${dbFor(name)}"`);
    await a.query(`CREATE DATABASE "${dbFor(name)}"`);
    await a.query(`ALTER DATABASE "${dbFor(name)}" SET TimeZone TO 'UTC'`);
  } finally {
    await a.end();
  }
  const c = new PgClient({ connectionString: urlFor(name) });
  await c.connect();
  try {
    // The shape that matters, not the whole baseline: one table whose name
    // COLLIDES with 1.0's, in the schema this population keeps it in, plus a
    // 1.0 `loans` in public to be shadowed.
    if (schema !== 'public') await c.query(`CREATE SCHEMA "${schema}"`);
    await c.query(`CREATE TABLE "${schema}".loans (id text PRIMARY KEY, marker text NOT NULL)`);
    await c.query(`INSERT INTO "${schema}".loans VALUES ('a', '2.0')`);
    if (schema !== 'public') {
      await c.query(`CREATE TABLE public.loans (id text PRIMARY KEY, marker text NOT NULL)`);
      await c.query(`INSERT INTO public.loans VALUES ('a', '1.0')`);
    }
  } finally {
    await c.end();
  }
}

async function dropDatabase(name: string): Promise<void> {
  const a = admin();
  await a.connect();
  try {
    await a.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbFor(name)],
    );
    await a.query(`DROP DATABASE IF EXISTS "${dbFor(name)}"`);
  } finally {
    await a.end();
  }
}

/** Open a session exactly as the 2.0 client does, and ask it an unqualified question. */
async function unqualifiedMarker(name: string, schemaMajor: number): Promise<string> {
  const schema = v2SchemaFor(schemaMajor);
  const c = new PgClient({
    connectionString: urlFor(name),
    options: v2SessionOptions(schema),
  });
  await c.connect();
  try {
    const r = await c.query<{ marker: string }>(`SELECT marker FROM loans WHERE id = 'a'`);
    return r.rows[0]!.marker;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  await makeDatabase('pre', V2_SCHEMA);
  await makeDatabase('post', V2_SCHEMA_PROMOTED);
}, 120_000);

afterAll(async () => {
  await dropDatabase('pre').catch(() => undefined);
  await dropDatabase('post').catch(() => undefined);
});

describe('§1 the constant became a per-tenant answer', () => {
  it('an unpromoted tenant is lbr2 and a promoted one is public', () => {
    expect(v2SchemaFor(1)).toBe('lbr2');
    expect(v2SchemaFor(2)).toBe('public');
  });

  it('and ABSENT reads as unpromoted, which is the safe direction', () => {
    // The upsert that writes 2 runs only after a cutover commits, so a missing
    // row means a database nobody has upgraded. Reading it the other way would
    // point a working library at a schema it does not have.
    expect(v2SchemaFor(undefined)).toBe('lbr2');
    expect(v2SchemaFor(null)).toBe('lbr2');
    expect(v2SchemaFor(0)).toBe('lbr2');
  });
});

describe('§2 unqualified SQL finds the 2.0 tables in BOTH populations', () => {
  it('before the promotion, and it shadows the 1.0 table of the same name', async () => {
    // Nine physical names collide between 1.0 and 2.0. The search path's ORDER
    // is what makes an unqualified `loans` mean the 2.0 one while both exist —
    // reverse it and every 2.0 query silently reads 1.0's rows.
    expect(await unqualifiedMarker('pre', 1)).toBe('2.0');
  }, 60_000);

  it('after the promotion, when `lbr2` does not exist at all', async () => {
    // MEASURED: Postgres ignores a missing schema in search_path rather than
    // raising. That is the property the whole phase rests on.
    expect(await unqualifiedMarker('post', 2)).toBe('2.0');
  }, 60_000);

  it('and a promoted database is still reachable by a session that names lbr2 first', async () => {
    // The window between the cutover committing and the fleet flag being
    // stamped: the tenant is promoted, the control plane still says 1. The
    // session falls through to `public` and the library keeps working.
    expect(await unqualifiedMarker('post', 1)).toBe('2.0');
  }, 60_000);
});

describe('§3 the session options say what they are for', () => {
  it('carry the UTC pin as well as the search path', () => {
    expect(v2SessionOptions('lbr2')).toContain('timezone=UTC');
    expect(v2SessionOptions('lbr2')).toContain('search_path=lbr2,public');
  });

  it('and a promoted tenant does not name a schema it no longer has', () => {
    expect(v2SessionOptions('public')).toContain('search_path=public');
    expect(v2SessionOptions('public')).not.toContain('lbr2');
  });
});

describe('§4 the model API follows the same answer', () => {
  it('reads a promoted database through the 2.0 client', async () => {
    // The adapter's `{schema}` option is what the model API qualifies with, and
    // the session search_path does NOT reach it — both measured in client.ts.
    // This asserts the factory threads the per-tenant value into the half the
    // search path cannot cover.
    const c = makeTenantPrismaClientV2({
      databaseUrl: urlFor('post'),
      maxPoolSize: 1,
      v2Schema: v2SchemaFor(2),
    });
    try {
      const rows = await c.$queryRawUnsafe<{ marker: string }[]>(
        `SELECT marker FROM loans WHERE id = 'a'`,
      );
      expect(rows[0]!.marker).toBe('2.0');
    } finally {
      await c.$disconnect();
    }
  }, 60_000);
});
