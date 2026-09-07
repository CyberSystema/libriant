/**
 * The online migration track: schema changes that must not hold a write lock.
 *
 * MEASURED, and it is not what this repository believed. `prisma migrate
 * deploy` does NOT wrap a migration file in a transaction. Prisma 7.9.1,
 * Postgres 16.15, a file containing `CREATE TABLE probe_tx_two (...);
 * SELECT 1/0;`: the deploy fails with P3018, and `probe_tx_two` SURVIVES, with
 * a `finished_at IS NULL` row left in `_prisma_migrations` that blocks every
 * later deploy on that tenant until somebody runs `migrate resolve` by hand.
 *
 * The rule that follows from it is unchanged, but its REASON is not: a
 * transactional migration is atomic because it OPENS ITS OWN `BEGIN`/`COMMIT`
 * (measured: with the wrapper, the same failing file leaves nothing behind),
 * and CONCURRENTLY cannot run inside THAT. So an index build that must not hold
 * a write lock still belongs here, and a migration that wants atomicity still
 * has to ask for it.
 *
 * Either way, a transaction makes two necessary operations impossible:
 *
 *   CREATE INDEX CONCURRENTLY cannot run inside a transaction at all. Seven
 *   migrations in this repo say so in prose and then build the index the
 *   locking way, because there was nowhere else to put it. On a 400,000-title
 *   catalogue that is an ACCESS EXCLUSIVE lock held for the length of the
 *   build, during which the library cannot catalogue.
 *
 *   A backfill over millions of rows in ONE transaction holds every row lock
 *   it takes until the end, bloats the table with dead tuples, and gives the
 *   operator no way to stop it. Batched, it is interruptible and resumable —
 *   but batching requires committing, which the transaction forbids.
 *
 * So an online script runs OUTSIDE a transaction, statement by statement, and
 * pays for that with a state Prisma cannot represent: half done. The ledger
 * (`_libriant_online_migrations`) is what makes half done survivable — it
 * records which STEP completed, so a rerun continues instead of restarting.
 *
 * FORMAT. A script is SQL divided by step markers:
 *
 *     -- @step add-index
 *     CREATE INDEX CONCURRENTLY IF NOT EXISTS foo_idx ON bar (baz);
 *
 *     -- @step backfill repeat-until-zero
 *     UPDATE bar SET baz = … WHERE baz IS NULL AND id IN (
 *       SELECT id FROM bar WHERE baz IS NULL ORDER BY id LIMIT 1000);
 *
 * `repeat-until-zero` re-runs the step until it reports no rows affected. That
 * is the batched backfill: each pass commits on its own, `rowsDone` climbs,
 * and killing the process between passes loses nothing.
 *
 * EVERY STEP MUST BE IDEMPOTENT — `check:migration-safety` enforces the DDL
 * half (IF NOT EXISTS / IF EXISTS) and the author owns the rest. A resumed run
 * may re-execute the step it died inside, because "died" and "committed but
 * the ledger update did not" are indistinguishable from outside.
 */

export interface OnlineStep {
  readonly name: string;
  readonly sql: string;
  /** Re-run until it affects zero rows. The batched-backfill shape. */
  readonly repeatUntilZero: boolean;
}

export interface OnlineScript {
  /** File name without `.sql`. The ledger key. */
  readonly name: string;
  readonly steps: readonly OnlineStep[];
}

const STEP_RE = /^\s*--\s*@step\s+([A-Za-z0-9_-]+)([^\n]*)$/;

export function parseOnlineScript(name: string, sql: string): OnlineScript {
  const lines = sql.split('\n');
  const steps: OnlineStep[] = [];
  let current: { name: string; body: string[]; repeat: boolean } | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.body.join('\n').trim();
    if (body) {
      steps.push({ name: current.name, sql: body, repeatUntilZero: current.repeat });
    }
    current = null;
  };

  for (const line of lines) {
    const m = STEP_RE.exec(line);
    if (m) {
      flush();
      current = {
        name: m[1] as string,
        body: [],
        repeat: /\brepeat-until-zero\b/.test(m[2] ?? ''),
      };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();

  if (steps.length === 0) {
    throw new Error(
      `${name}: no steps. An online script is divided by \`-- @step <name>\` markers; ` +
        `without one there is nothing the ledger can resume from.`,
    );
  }
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.name)) {
      throw new Error(
        `${name}: duplicate step \`${s.name}\`. Step names are the resume cursor, so they ` +
          `must be unique within a script.`,
      );
    }
    seen.add(s.name);
  }
  return { name, steps };
}

/** Minimal surface of the tenant Prisma client this runner needs. */
export interface RawClient {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
}

export interface OnlineProgress {
  readonly step: string;
  readonly pass: number;
  readonly rows: number;
}

export interface RunOnlineResult {
  readonly name: string;
  readonly stepsRun: number;
  readonly stepsSkipped: number;
  readonly rowsAffected: number;
  readonly alreadyComplete: boolean;
}

/**
 * Run (or resume) one online script against one database.
 *
 * The ledger is updated AFTER each step, never before: if the process dies
 * between the statement and the ledger write, the step runs again on the next
 * pass, which is why idempotency is the contract rather than a nicety.
 */
export async function runOnlineScript(
  db: RawClient,
  script: OnlineScript,
  opts: { onProgress?: (p: OnlineProgress) => void; maxPasses?: number } = {},
): Promise<RunOnlineResult> {
  const maxPasses = opts.maxPasses ?? 100_000;

  const existing = await db.$queryRawUnsafe<
    { name: string; finishedAt: Date | null; cursor: string | null }[]
  >(
    `SELECT "name", "finishedAt", "cursor" FROM "_libriant_online_migrations" WHERE "name" = $1`,
    script.name,
  );
  const row = existing[0];
  if (row?.finishedAt) {
    return {
      name: script.name,
      stepsRun: 0,
      stepsSkipped: script.steps.length,
      rowsAffected: 0,
      alreadyComplete: true,
    };
  }

  await db.$executeRawUnsafe(
    `INSERT INTO "_libriant_online_migrations" ("name", "attempts")
     VALUES ($1, 1)
     ON CONFLICT ("name") DO UPDATE
       SET "attempts" = "_libriant_online_migrations"."attempts" + 1,
           "lastError" = NULL`,
    script.name,
  );
  await db.$executeRawUnsafe(
    `UPDATE "_libriant_schema_state" SET "onlinePending" = $1, "updatedAt" = (pg_catalog.now() AT TIME ZONE 'UTC') WHERE "id" = 1`,
    script.name,
  );

  // The cursor is the last COMPLETED step, so resume starts after it.
  const doneUpTo = row?.cursor ?? null;
  let resuming = doneUpTo !== null;
  let stepsRun = 0;
  let stepsSkipped = 0;
  let rowsAffected = 0;

  try {
    for (const step of script.steps) {
      if (resuming) {
        stepsSkipped += 1;
        if (step.name === doneUpTo) resuming = false;
        continue;
      }

      if (step.repeatUntilZero) {
        for (let pass = 1; pass <= maxPasses; pass += 1) {
          const n = await db.$executeRawUnsafe(step.sql);
          rowsAffected += n;
          opts.onProgress?.({ step: step.name, pass, rows: n });
          await db.$executeRawUnsafe(
            `UPDATE "_libriant_online_migrations"
               SET "rowsDone" = "rowsDone" + $2
             WHERE "name" = $1`,
            script.name,
            n,
          );
          if (n === 0) break;
        }
      } else {
        const n = await db.$executeRawUnsafe(step.sql);
        rowsAffected += n;
        opts.onProgress?.({ step: step.name, pass: 1, rows: n });
      }

      stepsRun += 1;
      await db.$executeRawUnsafe(
        `UPDATE "_libriant_online_migrations" SET "cursor" = $2 WHERE "name" = $1`,
        script.name,
        step.name,
      );
    }
  } catch (err) {
    const message = String((err as Error).message).slice(0, 2000);
    await db.$executeRawUnsafe(
      `UPDATE "_libriant_online_migrations" SET "lastError" = $2 WHERE "name" = $1`,
      script.name,
      message,
    );
    throw err;
  }

  await db.$executeRawUnsafe(
    `UPDATE "_libriant_online_migrations"
       SET "finishedAt" = (pg_catalog.now() AT TIME ZONE 'UTC'), "lastError" = NULL
     WHERE "name" = $1`,
    script.name,
  );
  await db.$executeRawUnsafe(
    `UPDATE "_libriant_schema_state" SET "onlinePending" = NULL, "updatedAt" = (pg_catalog.now() AT TIME ZONE 'UTC') WHERE "id" = 1`,
  );

  return { name: script.name, stepsRun, stepsSkipped, rowsAffected, alreadyComplete: false };
}
