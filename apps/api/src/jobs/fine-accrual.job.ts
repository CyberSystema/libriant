import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { JobResult } from './jobs.types.js';

/**
 * Overdue-fine accrual sweep.
 *
 * Until now a fine was only created when a book was *returned* late. This walks
 * every active tenant and, for each still-active overdue loan, opens (or grows)
 * a single outstanding fine reflecting the amount accrued so far
 * (`daysOverdue * finePerDayCents`, capped by `fineCapCents`). That makes the
 * running total visible before return.
 *
 * One outstanding fine per loan (keyed by `loanId`), so this is idempotent — a
 * re-run just re-sets the amount. The return flow (LoansService.return)
 * finalises the same fine instead of creating a duplicate.
 *
 * Mirrors the reservation-expiry sweeper's per-tenant pattern (each tenant has
 * its own physical DB, so we need a client per tenant; the TenantPrismaService
 * LRU bounds connection counts).
 *
 * PER-JOB-TENANTPRISMA-CONN-MULTIPLY: each per-tenant sweep spins up its own
 * TenantPrismaService LRU, and several heavy sweeps fire on the same hour. To
 * keep the worker from marching toward Postgres `max_connections`, we pin the
 * worker's per-tenant pool to a SINGLE connection (`connection_limit=1`) — the
 * sweep is sequential per tenant, so one connection is plenty and a dozen
 * tenants × a few overlapping sweeps stays well under the ceiling.
 */
const MS_PER_DAY = 86_400_000;
const logger = new Logger('FineAccrualSweeper');

/** Force a 1-connection pool for worker sweeps (see PER-JOB-TENANTPRISMA-CONN-
 *  MULTIPLY). Appends `connection_limit=1` to the tenant URL if not already set. */
export function pinWorkerConnLimit(dbUrl: string): string {
  if (/[?&]connection_limit=/.test(dbUrl)) return dbUrl;
  return dbUrl + (dbUrl.includes('?') ? '&' : '?') + 'connection_limit=1';
}

export async function sweepFineAccrual(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      slug: true,
      name: true,
      defaultLocale: true,
      status: true,
      dbUrl: true,
      storageUrl: true,
      customSubdomain: true,
      tags: true,
    },
  });

  const tenantPrisma = new TenantPrismaService();
  let touched = 0;
  let failed = 0;
  try {
    for (const t of tenants) {
      const ctx: TenantContext = { ...t, dbUrl: pinWorkerConnLimit(t.dbUrl), resolvedFrom: 'path' };
      try {
        touched += await accrueOneTenant(ctx, tenantPrisma);
      } catch (err) {
        failed++;
        logger.warn(`accrual failed for tenant=${t.slug}: ${(err as Error).message}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      touched === 0
        ? `${tenants.length} tenant(s) scanned; no fines to accrue`
        : `accrued/updated ${touched} fine(s) across ${tenants.length} tenant(s)`,
    counts: { fines: touched, tenantsScanned: tenants.length, tenantsFailed: failed },
  };
}

async function accrueOneTenant(
  ctx: TenantContext,
  tenantPrisma: TenantPrismaService,
): Promise<number> {
  const client = tenantPrisma.getClient(ctx);
  const settings = await client.tenantSetting.findUnique({ where: { id: 1 } });
  const perDay = settings?.finePerDayCents ?? 0;
  // Skip libraries that switched overdue fines off, or charge nothing per day.
  if (!settings?.overdueFinesEnabled || perDay <= 0) return 0;
  const cap = settings?.fineCapCents ?? 0;
  const currency = settings?.currency ?? 'EUR';
  const now = new Date();

  const overdue = await client.loan.findMany({
    where: { status: 'active', dueAt: { lt: now } },
    select: { id: true, memberId: true, dueAt: true },
  });

  let touched = 0;
  for (const loan of overdue) {
    const daysOverdue = Math.floor((now.getTime() - loan.dueAt.getTime()) / MS_PER_DAY);
    if (daysOverdue <= 0) continue;
    const raw = daysOverdue * perDay;
    const amount = cap > 0 ? Math.min(raw, cap) : raw;
    if (amount <= 0) continue;
    const reason = `${daysOverdue} day(s) overdue`;

    // Re-read the loan: a concurrent return/lost flow may have just closed it
    // and finalised its fine. Don't resurrect or overwrite a fine for a loan
    // that's no longer active (that would revert the return-flow amount).
    const fresh = await client.loan.findUnique({
      where: { id: loan.id },
      select: { status: true },
    });
    if (!fresh || fresh.status !== 'active') continue;

    const existing = await client.fine.findFirst({
      where: { loanId: loan.id, status: 'outstanding' },
      select: { id: true, amountCents: true },
    });
    if (existing) {
      if (existing.amountCents !== amount) {
        // Status-guarded so we never touch a fine the return flow just resolved.
        const upd = await client.fine.updateMany({
          where: { id: existing.id, status: 'outstanding' },
          data: { amountCents: amount, reason },
        });
        if (upd.count > 0) touched++;
      }
    } else {
      try {
        await client.fine.create({
          data: {
            memberId: loan.memberId,
            loanId: loan.id,
            amountCents: amount,
            currency,
            reason,
            status: 'outstanding',
          },
        });
        touched++;
      } catch (err) {
        // A concurrent return/accrual won the race and created the outstanding
        // fine first (unique index fines_one_outstanding_per_loan). That's the
        // desired single fine — nothing to do.
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }
  return touched;
}

/** Prisma unique-constraint violation (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
