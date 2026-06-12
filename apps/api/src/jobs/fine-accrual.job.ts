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
 */
const MS_PER_DAY = 86_400_000;
const logger = new Logger('FineAccrualSweeper');

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
      const ctx: TenantContext = { ...t, resolvedFrom: 'path' };
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

    const existing = await client.fine.findFirst({
      where: { loanId: loan.id, status: 'outstanding' },
      select: { id: true, amountCents: true },
    });
    if (existing) {
      if (existing.amountCents !== amount) {
        await client.fine.update({
          where: { id: existing.id },
          data: { amountCents: amount, reason },
        });
        touched++;
      }
    } else {
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
    }
  }
  return touched;
}
