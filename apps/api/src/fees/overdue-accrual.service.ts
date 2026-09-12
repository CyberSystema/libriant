import { Inject, Injectable, Logger } from '@nestjs/common';
import { accrueOverdue, type Calendar } from '@libriant/circ-policy';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { PolicySnapshotService } from '../policy/policy-snapshot.service.js';
import { readPinnedPolicy } from '../circulation/policy-pinning.js';
import { accrueWithin } from './fee-accrual.js';
import type { LedgerAccount } from './ledger.js';

/**
 * Price the overdue books that are still out (2.0 phase 20b-ii).
 *
 * ## The defect
 *
 * 2.0 accrues an overdue fine in exactly one place: inside the checkin
 * transaction. So until a reader brings the book back, they owe nothing — and
 * `deskSummary` and the fee list both say so. A patron three weeks overdue
 * walks up to the desk and the screen shows a zero balance.
 *
 * 1.0 had a sweep for this and the 2.0 build never replaced it, which the phase
 * 20b-ii mapping found: "no 2.0 overdue-fine sweep — a patron with an
 * unreturned overdue book shows a zero balance at the desk."
 *
 * ## Why this is safe to run every hour
 *
 * Because of the shape phase 18 chose, and this is the payoff for it. The
 * accrual RECOMPUTES THE TOTAL from `dueAt` and posts
 * `total − what the receivable already carries` — it is not a window, and
 * running it twice in a minute moves nothing the second time. Phase 18 measured
 * the alternative: composed as a windowed `accrueOverdue({since})`, four of
 * seven policy shapes diverge and "every 3 days, intervalEnd" charges ZERO, with
 * no reconciliation identity able to catch it.
 *
 * That is what makes a periodic sweep possible at all. A windowed accrual could
 * not be re-run.
 *
 * ## The policy is the one PINNED ON THE LOAN
 *
 * Not today's. `policy_snapshot` is frozen at checkout precisely so that editing
 * a rule cannot retroactively re-price an open loan, and a sweep reading live
 * policy would be the loudest possible violation of that — it would re-price
 * every open loan in the library the moment a librarian adjusted a fine.
 *
 * The CALENDAR comes from the live snapshot, and that is deliberate and
 * different: a calendar records when the library was actually shut, and a
 * closure added after a loan went out is a day the reader genuinely could not
 * return the book. Pinning that would charge somebody for a bank holiday
 * declared last week.
 *
 * ## It never throws for one loan
 *
 * `accrueOverdue` refuses when the calendar does not reach far enough
 * (`CALENDAR_NOT_DEFINED_FOR`), and a loan carrying a snapshot this build cannot
 * read raises `PinnedSnapshotError`. Neither is a reason to abandon the other
 * two hundred loans in the sweep, so each is counted and named and the sweep
 * continues — the same position `checkin` takes, where a refusal returns the
 * book and leaves the money unpriced rather than refusing the return.
 */
export type SweepOutcome = {
  readonly loansConsidered: number;
  readonly feesTouched: number;
  readonly centsPosted: bigint;
  readonly refused: number;
  /**
   * Why the first refusal happened, when there was one.
   *
   * A count alone is not actionable: "refused 412" tells an operator that
   * something is wrong with the whole library and nothing about what. The log
   * carries every one, but a job result that has to be read in a dashboard
   * should carry the first reason with it.
   */
  readonly firstRefusal?: string;
};

@Injectable()
export class OverdueAccrualService {
  private readonly logger = new Logger(OverdueAccrualService.name);

  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(PolicySnapshotService) private readonly snapshots: PolicySnapshotService,
  ) {}

  async sweep(tenant: TenantContext, now: Date): Promise<SweepOutcome> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const snapshot = await this.snapshots.get(tenant);

    // The fee type owns its revenue account — `fees.service.ts` reads it the
    // same way. Hard-coding `fine_revenue` here would be a second opinion about
    // a library's chart of accounts, and the one that never gets updated.
    const feeType = await client.feeType.findFirst({
      where: { code: 'OVERDUE', archivedAt: null },
      select: { id: true, revenueAccount: true },
    });
    if (feeType === null) {
      this.logger.warn(`${tenant.slug}: no OVERDUE fee type, so nothing can be accrued`);
      return { loansConsidered: 0, feesTouched: 0, centsPosted: 0n, refused: 0 };
    }

    // Open, overdue, and not already anonymised — an anonymised loan has no
    // patron to charge and its reading history is deliberately gone.
    const loans = await client.$queryRaw<
      {
        id: string;
        patron_id: string;
        item_id: string;
        due_at: Date;
        checkout_branch_id: string;
        policy_snapshot: unknown;
        replacement_cost_cents: bigint | null;
      }[]
    >`
      SELECT l.id, l.patron_id, l.item_id, l.due_at, l.checkout_branch_id, l.policy_snapshot,
             i.replacement_cost_cents
        FROM lbr2.loans l
        JOIN lbr2.items i ON i.id = l.item_id
       WHERE l.closed_at IS NULL
         AND l.patron_id IS NOT NULL
         AND l.due_at < ${now}
       ORDER BY l.due_at`;

    let feesTouched = 0;
    let centsPosted = 0n;
    let refused = 0;
    let firstRefusal: string | undefined;

    for (const loan of loans) {
      try {
        const pinned = readPinnedPolicy(loan.id, loan.policy_snapshot);
        const calendar: Calendar | undefined =
          (pinned.calendarId === null ? undefined : snapshot.calendars[pinned.calendarId]) ??
          Object.values(snapshot.calendars)[0];
        if (calendar === undefined) {
          refused += 1;
          firstRefusal ??= `loan ${loan.id}: this library has no opening calendar`;
          continue;
        }

        const priced = accrueOverdue({
          policy: pinned.overdueFine,
          calendar,
          dueAt: loan.due_at,
          asOf: now,
          ...(loan.replacement_cost_cents === null
            ? {}
            : {
                replacementCost: {
                  minorUnits: Number(loan.replacement_cost_cents),
                  currency: pinned.overdueFine.amountPerInterval.currency,
                },
              }),
        });
        const totalCents = BigInt(priced.amount.amount);
        if (totalCents <= 0n) continue;

        // One transaction per loan, not one for the sweep. A library with four
        // thousand overdue books would otherwise hold every row it touched for
        // the length of the run, and a single unreadable snapshot would roll
        // back the other three thousand nine hundred.
        const outcome = await client.$transaction(async (tx) => {
          const account = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM lbr2.patron_accounts
             WHERE patron_id = ${loan.patron_id} AND currency = ${priced.amount.currency}
             LIMIT 1`;
          const accountId = account[0]?.id;
          if (accountId === undefined) return null;

          return accrueWithin(tx, {
            loanId: loan.id,
            patronId: loan.patron_id,
            accountId,
            feeTypeId: feeType.id,
            revenueAccount: feeType.revenueAccount as LedgerAccount,
            branchId: loan.checkout_branch_id,
            currency: priced.amount.currency,
            itemId: loan.item_id,
            totalCents,
            accruedThrough: now,
            reason: 'overdue accrual sweep',
            now,
          });
        });

        if (outcome !== null && outcome.deltaCents !== 0n) {
          feesTouched += 1;
          centsPosted += outcome.deltaCents;
        }
      } catch (err) {
        // Named, counted, and the sweep goes on. See the docblock.
        refused += 1;
        firstRefusal ??= `loan ${loan.id}: ${(err as Error).message}`;
        this.logger.warn(`loan ${loan.id}: ${(err as Error).message}`);
      }
    }

    return {
      loansConsidered: loans.length,
      feesTouched,
      centsPosted,
      refused,
      ...(firstRefusal === undefined ? {} : { firstRefusal }),
    };
  }
}
