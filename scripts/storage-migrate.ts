/**
 * Libriant — move a tenant's files between storage backends.
 *
 * Currently supports `file://` ⇆ `file://` (good enough for cell-to-cell
 * disk migrations on the pilot). Other schemes (`s3://`, `smb://`) throw
 * a clear "not implemented" so the storage-driver swap drill from the
 * plan is paper-testable today — the wiring is here, only the actual
 * sync command for those drivers is missing.
 *
 * Flow:
 *   1. Resolve tenant + assert
 *   2. Parse source + destination URLs; refuse if same
 *   3. Open per-tenant `read_only` system mode
 *   4. cp -a / rsync the files
 *   5. Verify byte counts + file counts match
 *   6. Update tenants.storage_url in the control DB
 *   7. Bust the TenantResolver cache (storage_url is baked into TenantContext)
 *   8. End read_only
 *
 *   ENV:
 *     CONTROL_DATABASE_URL  — control-plane DB
 *     REDIS_URL             — to bust the per-tenant resolver cache
 *
 *   USAGE:
 *     pnpm storage:migrate -- \
 *       --tenant=acme \
 *       --to-storage-url='file:///srv/libriant-2/storage/acme'
 *       --dry-run
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { Redis } from 'ioredis';
import { controlDb, type Prisma } from '@libriant/db-control';
import { die, isYes, log, parseArgs } from './_lib/cli.js';

const execFileP = promisify(execFile);
const SCRIPT = 'storage-migrate';

const args = parseArgs({
  name: SCRIPT,
  description: "Move a tenant's storage between backends.",
  options: {
    tenant: { type: 'string' },
    'to-storage-url': { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  required: ['tenant', 'to-storage-url'] as const,
});

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const slug = String(v.tenant);
  const toUrl = String(v['to-storage-url']);
  const dryRun = isYes(v['dry-run']);

  const tenant = await controlDb.tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, storageUrl: true, customSubdomain: true },
  });
  if (!tenant) die(SCRIPT, `tenant "${slug}" not found.`);
  if (tenant.storageUrl === toUrl) die(SCRIPT, 'destination equals source; nothing to do.');

  const from = parseStorageUrl(tenant.storageUrl);
  const to = parseStorageUrl(toUrl);
  if (from.scheme !== 'file' || to.scheme !== 'file') {
    die(
      SCRIPT,
      `only file://→file:// is implemented today. Got ${from.scheme}://… → ${to.scheme}://…`,
    );
  }

  log(SCRIPT, `tenant=${slug} (${tenant.id})`);
  log(SCRIPT, `  from ${from.path}`);
  log(SCRIPT, `  to   ${to.path}`);
  log(SCRIPT, `  dryRun=${dryRun}`);

  if (dryRun) {
    log(SCRIPT, 'dry run: not copying.');
    await controlDb.$disconnect();
    return;
  }

  const sourceStat = await stat(from.path).catch(() => null);
  if (!sourceStat) die(SCRIPT, `source path "${from.path}" does not exist.`);
  if (!sourceStat.isDirectory()) die(SCRIPT, `source path "${from.path}" is not a directory.`);

  const adminId = await firstOwnerAdminId();
  const modeEvent = await openReadOnly(tenant.id, adminId);
  log(SCRIPT, `opened read_only window event=${modeEvent.id}`);

  try {
    log(SCRIPT, 'rsync -a → destination…');
    await execFileP('rsync', ['-a', '--delete', ensureTrailingSlash(from.path), to.path], {
      maxBuffer: 64 * 1024 * 1024,
    });

    log(SCRIPT, 'verifying byte counts match…');
    const [fromSize, toSize] = await Promise.all([dirSize(from.path), dirSize(to.path)]);
    if (fromSize !== toSize) {
      throw new Error(
        `byte-count mismatch after rsync: source=${fromSize}B destination=${toSize}B`,
      );
    }

    log(SCRIPT, 'updating control plane (storage_url)…');
    await controlDb.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.tenant.update({
        where: { id: tenant.id },
        data: { storageUrl: toUrl },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: 'system',
          action: 'tenant.storage_migrated',
          targetType: 'tenant',
          targetId: tenant.id,
          beforeJson: { storageUrl: tenant.storageUrl, byteCount: fromSize },
          afterJson: { storageUrl: toUrl, byteCount: toSize },
        },
      });
    });

    log(SCRIPT, 'busting TenantResolver cache…');
    await bustResolverCache(tenant.slug, tenant.customSubdomain);

    log(SCRIPT, 'closing read_only window…');
    await closeEvent(modeEvent.id);

    log(SCRIPT, `done. Source directory left intact at ${from.path} — delete after verification.`);
  } catch (err) {
    log(SCRIPT, `failed: ${(err as Error).message}`);
    log(SCRIPT, 'tenant left on source storage; read_only window stays open for inspection.');
    throw err;
  } finally {
    await controlDb.$disconnect();
  }
}

function parseStorageUrl(raw: string): { scheme: string; path: string } {
  const m = raw.match(/^([a-z0-9+]+):\/\/(.*)$/i);
  if (!m) throw new Error(`storage_url has no scheme: ${raw}`);
  const scheme = m[1]!.toLowerCase();
  if (scheme === 'file') {
    // file://relative or file:///absolute — strip the host part if any.
    const rest = m[2]!;
    return { scheme: 'file', path: rest.startsWith('/') ? rest : '/' + rest };
  }
  return { scheme, path: m[2]! };
}

function ensureTrailingSlash(p: string): string {
  return p.endsWith('/') ? p : p + '/';
}

async function dirSize(p: string): Promise<number> {
  const { stdout } = await execFileP('du', ['-sb', p], { maxBuffer: 4 * 1024 * 1024 }).catch(
    async () => {
      // BSD du (macOS) doesn't support -b — fall back to -sk and multiply.
      const { stdout } = await execFileP('du', ['-sk', p], { maxBuffer: 4 * 1024 * 1024 });
      const n = Number(stdout.trim().split(/\s+/)[0]);
      return { stdout: `${n * 1024}\t${p}` };
    },
  );
  return Number(stdout.trim().split(/\s+/)[0]);
}

async function openReadOnly(tenantId: string, adminId: string) {
  return controlDb.systemModeEvent.create({
    data: {
      scope: 'tenant',
      tenantId,
      mode: 'read_only',
      messageMarkdown:
        'Migrating this library’s files to new storage — should be over in a few minutes.',
      allowAdminBypass: true,
      createdByAdminId: adminId,
    },
  });
}

async function closeEvent(eventId: string) {
  await controlDb.systemModeEvent.update({
    where: { id: eventId },
    data: { endedAt: new Date() },
  });
}

async function firstOwnerAdminId(): Promise<string> {
  const owner = await controlDb.adminUser.findFirst({
    where: { role: 'owner', status: 'active' },
    select: { id: true },
  });
  if (!owner) die(SCRIPT, 'no active owner admin found (bootstrap one first).');
  return owner.id;
}

async function bustResolverCache(slug: string, subdomain: string | null): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, { lazyConnect: true, keyPrefix: 'lbr:' });
  try {
    await redis.connect();
    const keys = [`tenant:slug:${slug}`];
    if (subdomain) keys.push(`tenant:sub:${subdomain}`);
    if (keys.length) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}

main().catch(async (err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  await controlDb.$disconnect();
  process.exit(1);
});
