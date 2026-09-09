/**
 * Libriant — verify (and optionally repair) the relational projection.
 *
 * `bib_records` is what the OPAC, facets, browse and every report read;
 * `marc_records` is what the catalogue actually says. They are written in ONE
 * transaction, so they cannot drift by racing — the integration suite proves
 * that by refusing a write and asserting the projection did not move.
 *
 * They drift because the PROJECTOR changes. A rule is corrected, a subfield
 * starts being read, a fold is fixed, and from that deploy every record written
 * before the change disagrees with every record written after it. Phase 11a
 * produced one such change while it was being written — classification sort keys
 * went from `''` to a real key — so this is the tool for a thing that has
 * already happened once.
 *
 * THE NIGHTLY JOB NEVER REPAIRS. `catalog-projection-verify` reports and pages;
 * `--repair` lives here, behind a person, for the same reason the fee ledger's
 * reconciliation alerts rather than self-heals (risk 7): a job that quietly
 * fixes drift also quietly hides what caused it.
 *
 * A repair re-derives through `BibProjectionService` — the same code the write
 * path uses — so a repaired row and a freshly written one cannot differ. It
 * writes ONLY the projector-owned columns, so `item_count`, `suppressed_from_opac`,
 * `custom_fields`, `cover_asset_ref` and `legacy_json` survive it.
 *
 *   ENV:
 *     CONTROL_DATABASE_URL    — control-plane DB
 *
 *   USAGE:
 *     pnpm catalog:verify                        # every active tenant, report only
 *     pnpm catalog:verify --only=acme,step18a    # specific slugs
 *     pnpm catalog:verify --repair               # re-derive what drifted
 *     pnpm catalog:verify --verbose              # every drifted record, not a sample
 *
 *   EXIT:
 *     0  nothing drifted, or everything that drifted was repaired
 *     1  a tenant was unreachable, or drift was found and not repaired
 */
import { controlDb } from '@libriant/db-control';
import { makeTenantPrismaClientV2, type TenantPrismaClientV2 } from '@libriant/db-tenant';
import { BibProjectionService } from '../apps/api/src/bib/bib-projection.service.js';
import {
  verifyTenantProjections,
  type ProjectionDrift,
} from '../apps/api/src/bib/bib-projection-verify.js';
import { TENANT_RUNTIME_SELECT, runtimeDbUrl } from '../apps/api/src/tenancy/tenant-db-url.js';
import { acquireLocks, lockKey } from '../apps/api/src/platform/locks.js';
import { die, isYes, log, parseArgs } from './_lib/cli.js';

const SCRIPT = 'catalog-verify';

const args = parseArgs({
  name: SCRIPT,
  description: 'Re-derive every bibliographic projection and report what disagrees.',
  options: {
    only: { type: 'string' },
    repair: { type: 'boolean' },
    verbose: { type: 'boolean' },
  },
});

const repair = isYes(args.values.repair);
const verbose = isYes(args.values.verbose);
const only = String(args.values.only ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Re-project one record through the service the write path uses.
 *
 * NOT a copy of the projection logic. A repair that computed the projection its
 * own way would be a second answer to the question this tool exists to detect
 * two answers to.
 *
 * The document is read here rather than passed down from the verifier, because
 * the verifier deliberately does not hold it: it reads a batch of five hundred
 * records at a time, and keeping five hundred MARC documents alive to repair the
 * handful that drifted is the one place this tool could run a catalogue out of
 * memory.
 *
 * THE READ IS INSIDE THE TRANSACTION, AND BEHIND THE SAME LOCK THE WRITE PATH
 * TAKES. An earlier draft read the document in one statement and wrote the
 * projection in a separate transaction, which loses the whole guarantee this
 * phase exists to hold: a cataloguer who saved between the two would have had
 * their edit's projection overwritten by one derived from the previous document,
 * and the CLI would have reported it repaired. `acquireLocks` here takes exactly
 * the key `BibWriteService.writeCore` takes, so a repair and a save cannot
 * interleave at all — the repair waits, then re-reads the record the save just
 * wrote, and derives the correct projection from it.
 */
async function reprojectOne(
  client: TenantPrismaClientV2,
  service: BibProjectionService,
  recordId: string,
): Promise<void> {
  const now = new Date();
  await client.$transaction(
    async (tx) => {
      await acquireLocks(tx, [lockKey('bib', recordId)]);
      const rows = await tx.$queryRaw<{ leader: string; content: unknown; kind: string }[]>`
        SELECT r.leader, r.kind::text AS kind, c.content
          FROM lbr2.marc_records r
          JOIN lbr2.marc_record_contents c ON c.record_id = r.id
         WHERE r.id = ${recordId} AND r.deleted_at IS NULL`;
      const row = rows[0];
      // Gone, or soft-deleted, between the scan and now. Nothing to repair, and
      // writing a projection for a withdrawn record would be worse than the
      // drift.
      if (!row) return;
      await service.project(tx, {
        recordId,
        kind: row.kind,
        record: { leader: row.leader, fields: row.content as never },
        now,
      });
    },
    { isolationLevel: 'ReadCommitted' },
  );
}

async function main(): Promise<void> {
  const tenants = await controlDb.tenant.findMany({
    where: { status: 'active', ...(only.length ? { slug: { in: only } } : {}) },
    // TENANT_RUNTIME_SELECT, not `{ dbUrl: true }`. `tenants.dbUrl` is the
    // SUPERUSER url and a database opened with it has no isolation from any
    // other library on the cluster — tenant-isolation-02, which the audit
    // reproduced by reading one library from another's connection string.
    // `check:tenant-db-urls` refuses this file otherwise, and it refused an
    // earlier draft of it.
    select: TENANT_RUNTIME_SELECT,
    orderBy: { slug: 'asc' },
  });
  if (only.length) {
    const found = new Set(tenants.map((t) => t.slug));
    const missing = only.filter((s) => !found.has(s));
    if (missing.length) die(SCRIPT, `no active tenant with slug: ${missing.join(', ')}`);
  }
  if (tenants.length === 0) die(SCRIPT, 'no active tenants');

  const service = new BibProjectionService();
  let totalScanned = 0;
  let totalDrift = 0;
  let totalRepaired = 0;
  let unreachable = 0;

  for (const t of tenants) {
    // `client` is declared here and ASSIGNED INSIDE THE TRY. `runtimeDbUrl`
    // throws fail-closed for a tenant with no sealed credential — that is the
    // whole point of it, tenant-isolation-02 — so evaluating it on this line
    // would let one un-backfilled library end the fan-out for every other one,
    // which is the exact failure every sweep in apps/api/src/jobs is written to
    // avoid. An earlier draft did.
    let client: TenantPrismaClientV2 | null = null;
    try {
      // One client per tenant, closed before the next. A fan-out over fifty
      // libraries that held every pool open would exhaust `max_connections`
      // before it finished, which is the same budget `TenantPrismaService`
      // computes for the long-lived processes.
      client = makeTenantPrismaClientV2({ databaseUrl: runtimeDbUrl(t), maxPoolSize: 1 });
      const onDrift = verbose
        ? (d: ProjectionDrift) =>
            log(SCRIPT, `  ${t.slug} ${d.recordId} ${d.kind}: ${d.fields.join(', ')}`)
        : undefined;
      const open = client;
      const report = await verifyTenantProjections(open, {
        repair,
        onDrift,
        reproject: (id) => reprojectOne(open, service, id),
      });
      totalScanned += report.scanned;
      totalDrift += report.drifted;
      totalRepaired += report.repaired;

      if (report.drifted === 0) {
        log(SCRIPT, `${t.slug}: ${report.scanned} record(s), every projection agrees`);
      } else {
        log(
          SCRIPT,
          `${t.slug}: ${report.drifted} of ${report.scanned} disagree` +
            (repair ? `, ${report.repaired} repaired` : ''),
        );
        if (!verbose) {
          for (const s of report.samples) {
            log(SCRIPT, `  ${s.recordId} ${s.kind}: ${s.fields.join(', ')}`);
          }
          if (report.drifted > report.samples.length) {
            log(SCRIPT, `  … and ${report.drifted - report.samples.length} more (--verbose)`);
          }
        }
      }
    } catch (err) {
      // One unreachable library must not end the fan-out for the rest — the
      // same rule every sweep in apps/api/src/jobs follows.
      unreachable++;
      log(SCRIPT, `${t.slug}: FAILED — ${String((err as Error).message).split('\n')[0]}`);
    } finally {
      await client?.$disconnect().catch(() => undefined);
    }
  }

  log(
    SCRIPT,
    `${totalScanned} record(s) across ${tenants.length} tenant(s): ${totalDrift} drifted` +
      (repair ? `, ${totalRepaired} repaired` : '') +
      (unreachable ? `, ${unreachable} tenant(s) unreachable` : ''),
  );

  // Non-zero when there is still something wrong AFTER this run. A repaired
  // drift is not a failure — it is what the operator asked for — but a drift
  // left in place is, because the alert will fire on it tonight either way.
  const outstanding = repair ? totalDrift - totalRepaired : totalDrift;
  if (outstanding > 0 || unreachable > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => die(SCRIPT, String((err as Error).message)))
  .finally(() => controlDb.$disconnect().catch(() => undefined));
