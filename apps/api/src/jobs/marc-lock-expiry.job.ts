import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * Delete lapsed record locks, and write the audit row that says they lapsed.
 *
 * ## Why this exists at all, when correctness does not need it
 *
 * It is not what makes an expired lock acquirable. That lives in the acquire
 * predicate — `WHERE expires_at <= now() OR …` — and was measured to work with
 * no sweep in the database at all. So a stopped sweep can never freeze a record,
 * which is the property worth stating, because it is the one a reader six months
 * from now cannot re-derive from the SQL.
 *
 * What a stopped sweep costs is the AUDIT TRAIL, and only in one case.
 *
 * ## Two mechanisms, and neither covers the other
 *
 * A lock can lapse in two ways, and each is invisible to the other mechanism:
 *
 *   - LAPSED AND RE-ACQUIRED. Somebody opens the record after the TTL ran out.
 *     The acquire notices, records `displaced_reason = 'expired'` and writes the
 *     row. A sweep running every five minutes would usually be too late — the
 *     acquire got there first — so a sweep-only design writes NOTHING for this
 *     case.
 *   - LAPSED AND NEVER TOUCHED AGAIN. The cataloguer closed the laptop and
 *     nobody opens that record for a week. No acquire ever happens, so a
 *     lazy-capture-only design writes NOTHING for this case either, and "who had
 *     this record open when it was last edited" is unanswerable.
 *
 * Hence both, and this job is the second one.
 *
 * ## They cannot double-write, and that is structural
 *
 * Measured: because the sweep DELETEs the lapsed row rather than marking it, the
 * next acquire on that record is a fresh INSERT — `was_insert = true`, with
 * `displaced_holder_user_id` NULL — so it takes the "nothing was displaced"
 * branch and writes no second expiry row. Exactly one expiry row per lapse,
 * whichever mechanism gets there first, with no idempotency guard anywhere.
 * That is the reason the sweep deletes rather than flags, and it should not be
 * changed to a soft delete without re-deriving it.
 *
 * ## The sweep cannot take a live lock
 *
 * `WHERE expires_at <= now()` is re-evaluated against the updated tuple, so both
 * interleavings are safe. Sweep-first: the DELETE removes a lapsed row and a
 * blocked renew then re-INSERTs, so the true holder keeps the record.
 * Renew-first: the DELETE re-checks its predicate against the renewed row and
 * deletes nothing.
 */
const logger = new Logger('MarcLockExpiry');

type LapsedLock = { record_id: string; holder_user_id: string; session_id: string };

export async function sweepExpiredMarcLocks(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  const tenantPrisma = new TenantPrismaService('worker');
  // Constructed by hand rather than injected: a scheduled job runs outside the
  // Nest container, exactly as every other sweep in this folder does.
  const audit = new TenantAuditService(tenantPrisma);
  let total = 0;
  let failed = 0;

  try {
    for (const t of tenants) {
      // Built INSIDE the per-tenant try, per the house rule: `tenantContextFrom`
      // throws for a tenant with no sealed credential, and a throw out here
      // would end the sweep for every OTHER library at the first un-backfilled
      // one.
      try {
        const ctx: TenantContext = tenantContextFrom(t);
        total += await sweepOneTenant(ctx, tenantPrisma, audit);
      } catch (err) {
        failed++;
        logger.warn(`sweep failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      total === 0
        ? `${tenants.length} tenant(s) scanned; no lapsed record locks`
        : `released ${total} lapsed record lock(s) across ${tenants.length} tenant(s)`,
    counts: { expired: total, tenantsScanned: tenants.length, tenantsFailed: failed },
  };
}

/**
 * One tenant's lapsed locks, deleted and audited.
 *
 * `DELETE … RETURNING` rather than select-then-delete: the row has to be gone
 * and its holder known in the same statement, or two sweeps racing would each
 * write the audit row for the same lapse.
 *
 * The audit rows are written AFTER the delete commits, matching
 * `TenantAuditService`'s contract — it is best-effort by design, and a failed
 * audit write must never turn a successful sweep into a failed one. The cost is
 * stated rather than hidden: if the process dies between the delete and the
 * audit, the lock is released and the expiry row is missing. That is the right
 * way round — a lock nobody can release would freeze a record, and a missing
 * audit row is a gap in a log.
 */
async function sweepOneTenant(
  ctx: TenantContext,
  tenantPrisma: TenantPrismaService,
  audit: TenantAuditService,
) {
  const client = tenantPrisma.getClientV2(ctx);
  const lapsed = await client.$queryRaw<LapsedLock[]>`
    DELETE FROM lbr2.marc_record_locks
     WHERE expires_at <= pg_catalog.now()
    RETURNING record_id, holder_user_id, session_id`;

  for (const lock of lapsed) {
    // The SWEEP is the actor, not the person whose lock lapsed — they did
    // nothing. `actorId` names the job so the row reads "the system noticed",
    // and the lapsed holder is in `before`, which is what a reader is looking
    // for.
    await audit.record(
      ctx,
      { userId: null, actorId: 'marc-lock-expiry', actorType: 'system', supportSessionId: null },
      {
        action: 'catalog.record.lock_expired',
        targetType: 'marc_record',
        targetId: lock.record_id,
        before: { holderUserId: lock.holder_user_id, sessionId: lock.session_id },
        after: { noticedBy: 'sweep' },
      },
    );
  }
  return lapsed.length;
}
