import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTenantPrismaClient, type TenantPrismaClient } from '@libriant/db-tenant';
import { TenantProvisioningService } from '../../src/provisioning/tenant-provisioning.service.js';
import { parseOnlineScript, runOnlineScript } from '../../../../scripts/_lib/online-track.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'This provisions a database and runs migration machinery. No plan gate is exercised.',
);

/**
 * The online migration track, proved on a real database.
 *
 * `prisma migrate deploy` wraps every migration in a transaction, which makes
 * two necessary things impossible: CREATE INDEX CONCURRENTLY cannot run inside
 * one at all, and a multi-million-row backfill in a single transaction holds
 * every lock it takes until the end. Seven migrations in this repo already say
 * so in prose and then build the index the locking way, because there was
 * nowhere else to put it.
 *
 * The online track is that somewhere: statements run outside a transaction,
 * one at a time, with a ledger recording which STEP completed so a rerun
 * continues instead of restarting. That buys the capability and pays for it
 * with a state Prisma cannot represent — HALF DONE — and half done is only
 * survivable if resume actually works.
 *
 * So these are the assertions that matter, and every one of them is about a
 * failure rather than a success: a crash records the last completed step, the
 * barrier is RAISED while a script is unfinished (which is what stops
 * `tenant:migrate` piling migrations on top of a half-backfilled table), and a
 * resume does not re-enter work that already succeeded.
 */

const SCRIPT = `
-- @step build-index
CREATE INDEX CONCURRENTLY IF NOT EXISTS onl_probe_idx ON onl_probe (val);

-- @step backfill repeat-until-zero
UPDATE onl_probe SET val = 'done'
 WHERE id IN (SELECT id FROM onl_probe WHERE val IS NULL ORDER BY id LIMIT 100);
`;

const provisioning = new TenantProvisioningService();
const tenantId = `onl${randomBytes(6).toString('hex')}`;

let db: TenantPrismaClient;

beforeAll(async () => {
  const placement = await provisioning.provision({ tenantId, cellId: 'cell-eu-1' });
  db = makeTenantPrismaClient({ databaseUrl: placement.dbUrl, maxPoolSize: 2 });
  await db.$executeRawUnsafe('CREATE TABLE onl_probe (id serial PRIMARY KEY, val text)');
  await db.$executeRawUnsafe(
    'INSERT INTO onl_probe (val) SELECT NULL FROM generate_series(1, 450)',
  );
}, 120_000);

afterAll(async () => {
  await db?.$disconnect().catch(() => undefined);
  await provisioning.teardown(tenantId).catch(() => undefined);
});

describe('the online migration track', () => {
  it('parses steps and rejects a script it could never resume', () => {
    const s = parseOnlineScript('x', SCRIPT);
    expect(s.steps.map((v) => v.name)).toEqual(['build-index', 'backfill']);
    expect(s.steps[1]?.repeatUntilZero).toBe(true);
    // No steps means no cursor means no resume; that has to be loud.
    expect(() => parseOnlineScript('x', 'SELECT 1;')).toThrow(/no steps/);
    // Step names ARE the cursor, so duplicates would make resume ambiguous.
    expect(() => parseOnlineScript('x', '-- @step a\nSELECT 1;\n-- @step a\nSELECT 2;')).toThrow(
      /duplicate step/,
    );
  });

  it('builds an index CONCURRENTLY and backfills in batches', async () => {
    const passes: number[] = [];
    const result = await runOnlineScript(db, parseOnlineScript('probe', SCRIPT), {
      onProgress: (p) => passes.push(p.rows),
    });

    expect(result.stepsRun).toBe(2);
    expect(result.rowsAffected).toBe(450);
    // 450 rows at 100 a pass: four full batches, one of 50, then the zero that
    // ends the loop. Batching is the whole point — one transaction would hold
    // every row lock until the end.
    expect(passes.filter((n) => n > 0)).toEqual([100, 100, 100, 100, 50]);

    const remaining = await db.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*)::bigint AS n FROM onl_probe WHERE val IS NULL',
    );
    expect(Number(remaining[0]?.n)).toBe(0);

    // An index left INVALID by a failed CONCURRENTLY build is the failure mode
    // the whole ledger exists to make recoverable, so assert it is valid.
    const idx = await db.$queryRawUnsafe<{ valid: boolean }[]>(
      `SELECT x.indisvalid AS valid FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        WHERE i.relname = 'onl_probe_idx'`,
    );
    expect(idx[0]?.valid).toBe(true);
  }, 120_000);

  it('is a no-op once complete, and leaves no barrier', async () => {
    const again = await runOnlineScript(db, parseOnlineScript('probe', SCRIPT));
    expect(again.alreadyComplete).toBe(true);
    expect(again.stepsRun).toBe(0);

    const state = await db.$queryRawUnsafe<{ onlinePending: string | null }[]>(
      'SELECT "onlinePending" FROM "_libriant_schema_state" WHERE "id" = 1',
    );
    expect(state[0]?.onlinePending).toBeNull();
  });

  it('records where it died, raises the barrier, and resumes without redoing work', async () => {
    await db.$executeRawUnsafe('UPDATE onl_probe SET val = NULL');
    const failing = parseOnlineScript('probe2', `${SCRIPT}\n-- @step will-fail\nSELECT 1 / 0;\n`);

    await expect(runOnlineScript(db, failing)).rejects.toThrow();

    const ledger = await db.$queryRawUnsafe<
      {
        cursor: string | null;
        finishedAt: Date | null;
        lastError: string | null;
        attempts: number;
      }[]
    >(
      `SELECT "cursor", "finishedAt", "lastError", "attempts"
         FROM "_libriant_online_migrations" WHERE "name" = 'probe2'`,
    );
    // The cursor is the last COMPLETED step. It is written AFTER the step, so
    // a crash between statement and ledger re-runs that step — which is why
    // every step must be idempotent, and why that is a documented contract
    // rather than a hope.
    expect(ledger[0]?.cursor).toBe('backfill');
    expect(ledger[0]?.finishedAt).toBeNull();
    expect(ledger[0]?.lastError).toMatch(/division by zero/);

    const barrier = await db.$queryRawUnsafe<{ onlinePending: string | null }[]>(
      'SELECT "onlinePending" FROM "_libriant_schema_state" WHERE "id" = 1',
    );
    // THIS is what stops `tenant:migrate` applying the next migration on top of
    // a half-backfilled table.
    expect(barrier[0]?.onlinePending).toBe('probe2');

    const entered: string[] = [];
    const fixed = parseOnlineScript(
      'probe2',
      `${SCRIPT}\n-- @step will-fail\nCREATE INDEX IF NOT EXISTS onl_probe_idx2 ON onl_probe (id);\n`,
    );
    const resumed = await runOnlineScript(db, fixed, {
      onProgress: (p) => entered.push(p.step),
    });

    expect(resumed.stepsSkipped).toBe(2);
    expect(resumed.stepsRun).toBe(1);
    expect(entered).not.toContain('backfill');
    expect(entered).not.toContain('build-index');

    const after = await db.$queryRawUnsafe<{ attempts: number; finishedAt: Date | null }[]>(
      `SELECT "attempts", "finishedAt" FROM "_libriant_online_migrations" WHERE "name" = 'probe2'`,
    );
    expect(after[0]?.attempts).toBe(2);
    expect(after[0]?.finishedAt).not.toBeNull();
  }, 120_000);
});
