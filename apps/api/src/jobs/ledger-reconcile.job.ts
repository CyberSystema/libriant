import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import {
  TENANT_CONTEXT_SELECT,
  tenantContextFrom,
  readSchemaMajors,
} from '../tenancy/tenant-db-url.js';
import type { TxV2 } from '../tenancy/tenant-tx-v2.js';
import {
  findAccountBalanceDrift,
  findFeeCounterDrift,
  findUnbalancedTransactions,
  type Drift,
} from '../fees/ledger-identities.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * The nightly ledger reconciliation (2.0 phase 18).
 *
 * ## IT ALERTS. IT DOES NOT SELF-HEAL.
 *
 * §8 risk 7 names this directly: a self-healing reconciler hides the bug that
 * caused the drift. The temptation is real — every drift this finds has an
 * obvious repair, and writing it would make the number right tonight. It would
 * also delete the only evidence of why the number was wrong, and the bug would
 * keep running.
 *
 * So the job writes a row and emits a metric, and a human decides. The only
 * UPDATE it issues is against `ledger_discrepancies` itself, and only to avoid
 * writing 365 copies of one unfixed problem: `ledger_discrepancies_one_open_per_subject`
 * makes a repeat finding a no-op rather than a new row. Nothing here closes a
 * row — a discrepancy is resolved by somebody who looked at it, which is what
 * the CHECK requiring a note alongside `resolved_at` is for.
 *
 * ## Why it re-checks something the database already guarantees
 *
 * I1 is enforced by a statement-level trigger, so an unbalanced transaction is
 * unwritable through this application. It is checked anyway: a row here means
 * the trigger was dropped by a migration, bypassed by a superuser, or the data
 * arrived from somewhere that is not this application — and phase 19's
 * PL/pgSQL copy-forward is exactly such a somewhere. A tripwire on a guarantee
 * costs one query a night.
 */
export const LEDGER_RECONCILE_JOB = 'ledger-reconcile';
export const LEDGER_RECONCILE_COUNTS = {
  tenants: 'tenants',
  tenantsFailed: 'tenantsFailed',
  unbalanced: 'unbalanced',
  feeCounterDrift: 'feeCounterDrift',
  accountBalanceDrift: 'accountBalanceDrift',
} as const;

const KINDS = {
  unbalanced: 'transaction_unbalanced',
  feeCounter: 'fee_allocation_mismatch',
  accountBalance: 'account_balance_mismatch',
} as const;

/**
 * Record what was found, once per subject.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique, so a problem that is
 * still there tomorrow night does not become a second row. The consequence
 * worth stating: the numbers on an open row are the FIRST measurement, not the
 * latest. That is deliberate — an operator wants to know when the drift started
 * and how big it was then, and a row that silently rewrote itself every night
 * would lose exactly that.
 */
async function record(tx: TxV2, kind: string, drifts: readonly Drift[], now: Date): Promise<void> {
  for (const d of drifts) {
    await tx.$executeRaw`
      INSERT INTO ledger_discrepancies (
        id, kind, subject_id, currency, expected_cents, actual_cents, detail, detected_at
      )
      VALUES (
        pg_catalog.gen_random_uuid()::text,
        CAST(${kind} AS ledger_discrepancy_kind),
        ${d.subjectId}, ${d.currency}, ${d.expectedCents}, ${d.actualCents},
        CAST(${JSON.stringify(d.detail)} AS jsonb), ${now}
      )
      ON CONFLICT (kind, subject_id, currency) WHERE resolved_at IS NULL DO NOTHING`;
  }
}

export async function reconcileLedger(): Promise<JobResult> {
  const log = new Logger(LEDGER_RECONCILE_JOB);
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  // 2.0 phase 20f: one query for which libraries have been cut over.
  const schemaMajors = await readSchemaMajors(tenants.map((x) => x.id));

  const tenantPrisma = new TenantPrismaService('worker');
  const now = new Date();

  let tenantsFailed = 0;
  let unbalanced = 0;
  let feeCounterDrift = 0;
  let accountBalanceDrift = 0;

  for (const row of tenants) {
    const tenant = tenantContextFrom(row, 'path', schemaMajors.get(row.id));
    try {
      const client = tenantPrisma.getClientV2(tenant);
      // One transaction per tenant so all three identities see ONE snapshot. A
      // drift computed across three moments would report a payment that landed
      // between two of the queries as a discrepancy, every night, for ever.
      const found = await client.$transaction(async (tx) => {
        const i1 = await findUnbalancedTransactions(tx);
        const i2 = await findFeeCounterDrift(tx);
        const i3 = await findAccountBalanceDrift(tx);
        await record(tx, KINDS.unbalanced, i1, now);
        await record(tx, KINDS.feeCounter, i2, now);
        await record(tx, KINDS.accountBalance, i3, now);
        return { i1: i1.length, i2: i2.length, i3: i3.length };
      });

      unbalanced += found.i1;
      feeCounterDrift += found.i2;
      accountBalanceDrift += found.i3;

      if (found.i1 + found.i2 + found.i3 > 0) {
        log.error(
          `${tenant.slug}: ledger drift — ${found.i1} unbalanced transaction(s), ` +
            `${found.i2} fee(s) whose counters disagree with their allocations, ` +
            `${found.i3} account(s) whose balance disagrees with the fees behind it. ` +
            `Recorded in ledger_discrepancies; NOTHING has been repaired.`,
        );
      }
    } catch (err: unknown) {
      tenantsFailed += 1;
      log.error(`${tenant.slug}: reconciliation failed — ${describeError(err)}`);
    }
  }

  const total = unbalanced + feeCounterDrift + accountBalanceDrift;
  return {
    message:
      total === 0
        ? `ledger reconciled across ${tenants.length} tenant(s): all three identities hold`
        : `LEDGER DRIFT across ${tenants.length} tenant(s): ${total} discrepancy/ies recorded`,
    counts: {
      [LEDGER_RECONCILE_COUNTS.tenants]: tenants.length,
      [LEDGER_RECONCILE_COUNTS.tenantsFailed]: tenantsFailed,
      [LEDGER_RECONCILE_COUNTS.unbalanced]: unbalanced,
      [LEDGER_RECONCILE_COUNTS.feeCounterDrift]: feeCounterDrift,
      [LEDGER_RECONCILE_COUNTS.accountBalanceDrift]: accountBalanceDrift,
    },
  };
}
