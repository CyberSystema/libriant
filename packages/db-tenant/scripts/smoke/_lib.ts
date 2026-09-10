/**
 * What every smoke module shares.
 *
 * Lifted verbatim out of the single 400-line `smoke-test.ts` when phase 9 split
 * it per module. The helpers are unchanged; only their home moved.
 */
import { PG_SESSION_OPTIONS } from '@libriant/shared/postgres-session';
import { type TenantPrismaClient, V2_SCHEMA } from '../../src';

export function ok(label: string) {
  console.log(`  ✓ ${label}`);
}
export function note(label: string) {
  console.log(`  • ${label}`);
}

/**
 * Run a Prisma call expected to fail, and assert that the error message
 * contains AT LEAST ONE of the provided fragments. Prisma redacts the
 * underlying PG constraint name for some error classes (notably unique
 * violations), so we accept either the named constraint OR Prisma's
 * generic phrasing.
 */
export async function expectError(
  promise: Promise<unknown>,
  expectedFragments: string | string[],
  label: string,
) {
  const fragments = Array.isArray(expectedFragments) ? expectedFragments : [expectedFragments];
  try {
    await promise;
    throw new Error(
      `[FAIL] Expected error matching ${JSON.stringify(fragments)} but call succeeded: ${label}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    const matched = fragments.some((f) => lower.includes(f.toLowerCase()));
    if (!matched) {
      throw new Error(
        `[FAIL] Expected error matching one of ${JSON.stringify(fragments)} for "${label}" but got:\n${msg}`,
      );
    }
    ok(`${label} → rejected as expected`);
  }
}

export async function cleanup(db: TenantPrismaClient) {
  // Order matters: delete dependent rows first.
  await db.auditEvent.deleteMany({});
  await db.fine.deleteMany({});
  await db.loan.deleteMany({});
  await db.reservation.deleteMany({});
  await db.collectionRecord.deleteMany({});
  await db.collectionField.deleteMany({});
  await db.collection.deleteMany({});
  await db.fieldDefinition.deleteMany({});
  await db.bookAuthor.deleteMany({});
  await db.bookCopy.deleteMany({});
  await db.book.deleteMany({});
  await db.author.deleteMany({});
  await db.member.deleteMany({});
}

/** One smoke module: a name, a sentence, the checks, and how to undo them. */
export interface SmokeModule {
  readonly name: string;
  readonly describes: string;
  run(db: TenantPrismaClient): Promise<void>;
  /**
   * Restore the empty schema. Called by the runner in a `finally`, NOT at the
   * end of `run`.
   *
   * That distinction is load-bearing and was found by breaking a constraint on
   * purpose: a module that fails part-way never reaches its own teardown, so it
   * leaves rows behind, and every later module then fails its "exists and is
   * empty" check for a reason that has nothing to do with it. One real failure
   * became three reported ones, and the two false ones pointed at innocent
   * modules. The runner owning teardown is what keeps a failure local.
   */
  reset?(db: TenantPrismaClient): Promise<void>;
}

/**
 * Run `sql` on the 2.0 schema and return its rows.
 *
 * The 2.0 modules use a raw `pg` connection rather than a generated Prisma
 * client, and that is not a shortcut: phase 9 creates the tables and NO
 * SERVICES, so there is nothing yet for a typed client to be the client OF.
 * When phase 10 brings the MARC store, these modules gain a client alongside.
 */
export async function v2Query<T = Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { Client } = await import('pg');
  // The same UTC session the application holds. The smoke fixtures write their
  // timestamps with `pg_catalog.now()` while every service writes through
  // Prisma, so until the two share a frame this harness cannot observe a
  // disagreement even in principle. See packages/shared/src/postgres-session.ts.
  const client = new Client({ connectionString: url, options: PG_SESSION_OPTIONS });
  await client.connect();
  try {
    await client.query(`SET search_path = ${V2_SCHEMA}, public`);
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Assert `sql` fails with `sqlstate`, and say what the constraint protects. */
export async function expectSqlstate(
  url: string,
  sql: string,
  sqlstate: string,
  label: string,
): Promise<void> {
  let got = 'NO_ERROR';
  try {
    await v2Query(url, sql);
  } catch (err) {
    got = (err as { code?: string }).code ?? 'NO_CODE';
  }
  if (got !== sqlstate) {
    throw new Error(`${label}: expected SQLSTATE ${sqlstate}, got ${got}`);
  }
  ok(`${label} (${sqlstate})`);
}
