import { controlDb } from '@libriant/db-control';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import { verifyTenantProjections } from '../bib/bib-projection-verify.js';
import { describeError } from './job-error.js';
import type { JobResult } from './jobs.types.js';

/**
 * Re-derive every projection nightly and report the ones that disagree.
 *
 * ## What can actually drift, given the projection is transactional
 *
 * Not a race. `BibProjectionService` runs inside the write transaction, so a
 * record and its projection commit together or not at all — `bib-projection.spec.ts`
 * proves that by driving the service inside a transaction that then throws, and
 * asserting the corrupted row it was asked to repair is still corrupt. (The
 * obvious version of that test — refuse a write with a stale hash — passes on an
 * implementation that writes the projection after the commit, because the stale
 * hash is rejected before the projection is ever called.) What drifts is the PROJECTOR: a rule
 * is corrected, a subfield starts being read, a fold is fixed, and from that
 * deploy onward every record written before the change disagrees with every
 * record written after it. Phase 11a produced exactly one such change while it
 * was being built — classification sort keys went from `''` to a real key — so
 * this is a measured failure mode, not a hypothetical one.
 *
 * The second thing it catches is a record that was never projected at all,
 * which is what a write path with the hook on one branch and not the other
 * produces. That bug existed in phase 10 and nothing detected it.
 *
 * ## It never writes
 *
 * Same rule as the fee ledger's nightly reconciliation, and for the same reason
 * (risk 7): a job that silently repairs drift also silently hides the cause, and
 * "the projector changed and nobody re-ran it" is the finding, not the noise.
 * Repair is `pnpm catalog:verify --repair`, run by a person who has read what
 * drifted.
 *
 * ## Daily, and why not more often
 *
 * The only thing that introduces drift is a deploy. A cadence finer than daily
 * re-reads every record in every catalogue to find, on almost every run, exactly
 * nothing — and this is the heaviest sweep in the registry, because it projects
 * every bibliographic record in the fleet. Daily is the cadence that matches
 * what it detects.
 */
const logger = new Logger('CatalogVerify');

/**
 * The registry name and the two counter keys, in ONE place.
 *
 * Three literals used to have to agree by hand — the `name` in `registry.ts`,
 * the keys of `counts` below, and the lookups in `queues/worker-surface.ts` that
 * turn them into `libriant_catalog_projection_drift_total`. Renaming any of them
 * deleted the only series the alert reads, silently, and nothing typechecked it
 * because they were three separate strings. Exported so all three sites import
 * the same value and a rename is a compile error.
 */
export const CATALOG_VERIFY_JOB = 'catalog-projection-verify';
export const CATALOG_VERIFY_COUNTS = { drift: 'drift', scanned: 'scanned' } as const;

export async function verifyCatalogProjections(): Promise<JobResult> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active' },
    select: TENANT_CONTEXT_SELECT,
  });

  const tenantPrisma = new TenantPrismaService('worker');
  let scanned = 0;
  let drift = 0;
  let failed = 0;

  try {
    for (const t of tenants) {
      // Built INSIDE the per-tenant try, per the house rule: `tenantContextFrom`
      // throws for a tenant with no sealed credential, and a throw out here
      // would end the sweep for every OTHER library at the first one.
      try {
        const ctx: TenantContext = tenantContextFrom(t);
        const report = await verifyTenantProjections(tenantPrisma.getClientV2(ctx));
        scanned += report.scanned;
        drift += report.drifted;
        if (report.drifted > 0) {
          // The sample list, not the whole set. An operator reading this at
          // 03:00 needs the shape of the problem — "every record, sortTitle" is
          // a projector change; "one record, missing" is a lost write — and a
          // 40,000-line log entry hides both.
          const shape = report.samples
            .map((s) => `${s.recordId}:${s.kind}:${s.fields.join('+')}`)
            .join(' ');
          logger.warn(
            `tenant=${t.slug} ${report.drifted}/${report.scanned} projection(s) disagree with ` +
              `their record; first ${report.samples.length}: ${shape}`,
          );
        }
      } catch (err) {
        failed++;
        logger.warn(`verify failed for tenant=${t.slug}: ${describeError(err)}`);
      }
    }
  } finally {
    await tenantPrisma.onModuleDestroy().catch(() => undefined);
  }

  return {
    message:
      drift === 0
        ? `${scanned} record(s) across ${tenants.length} tenant(s); every projection agrees`
        : `${drift} of ${scanned} projection(s) disagree with their record — run ` +
          '`pnpm catalog:verify --repair` after checking what changed',
    counts: {
      // Keyed by the exported constants, not by shorthand, so that
      // `worker-surface.ts` reads the same names this writes. They surface as
      // libriant_worker_job_count{sweep="catalog-projection-verify",count="drift"}
      // AND as libriant_catalog_projection_drift_total; both exist on purpose,
      // since the generic gauge is `alert: false` by design and drift here is
      // not a handler statistic but the OPAC serving something the record does
      // not say.
      [CATALOG_VERIFY_COUNTS.scanned]: scanned,
      [CATALOG_VERIFY_COUNTS.drift]: drift,
      tenantsScanned: tenants.length,
      tenantsFailed: failed,
    },
  };
}
