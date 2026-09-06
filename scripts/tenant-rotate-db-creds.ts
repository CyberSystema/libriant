/**
 * Libriant — rotate (or first provision) a library's own Postgres credential.
 *
 * This is one script for two jobs, because they are the same job:
 *
 *   • BACKFILL — a tenant created before per-tenant roles existed has no row in
 *     `tenant_db_credentials`, so the API refuses to open its database at all
 *     (`runtimeDbUrl` fails closed). Running this gives it roles, grants and a
 *     sealed password. Run it once over `--all` as part of the deploy that
 *     first carries this change.
 *
 *   • ROTATION — replace a credential that has been exposed, or is simply old.
 *
 * ## Zero failed requests
 *
 * Postgres has no second-password mechanism, so re-issuing the password on the
 * live role would break every process still holding the old one, for as long as
 * its resolver cache lasts. Instead each tenant has TWO login roles — slots `a`
 * and `b`, both members of the privilege holder `tenant_<id>_app` — and a
 * rotation writes the one that is NOT in use:
 *
 *   1. set a fresh password on the standby slot, and re-issue every grant
 *   2. prove the standby can actually open the database
 *   3. point `tenant_db_credentials` at it
 *   4. bust the TenantResolver cache so every process re-resolves at once
 *   5. wait out the grace period — BOTH credentials work here, on purpose
 *   6. retire the old slot: NOLOGIN and its password removed
 *
 * A request in flight at any point in that sequence holds a credential that
 * still works. Step 5 is the only part that costs anything, and it costs time,
 * not availability.
 *
 *   ENV (required):
 *     CONTROL_DATABASE_URL   — control-plane DB
 *     TENANT_DB_MASTER_KEY   — 64 hex; seals the new password
 *   ENV (optional):
 *     REDIS_URL              — to bust the resolver cache (default localhost)
 *
 *   USAGE:
 *     pnpm tenant:rotate-db-creds --slug=acme
 *     pnpm tenant:rotate-db-creds --all --grace-seconds=120
 *     pnpm tenant:rotate-db-creds --all --dry-run
 *     pnpm tenant:rotate-db-creds --all --missing-only   # the deploy's backfill
 */
import { Client as PgClient } from 'pg';
import { Redis } from 'ioredis';
import {
  applyTenantRoleGrants,
  composeRuntimeUrl,
  controlDb,
  describeTenantRoles,
  ensureTenantRoles,
  newRuntimePassword,
  otherSlot,
  parseTenantDbMasterKey,
  redactDbUrl,
  retireTenantLoginRole,
  sealTenantPassword,
  slotOfRole,
  tenantLoginRole,
  type Prisma,
  type RoleSlot,
} from '@libriant/db-control';
import { die, isYes, log, parseArgs } from './_lib/cli.js';

const SCRIPT = 'tenant-rotate-db-creds';

/**
 * How long both credentials stay valid. Must comfortably exceed
 * TENANT_CACHE_TTL_SEC in the worst case where the cache bust below did not
 * reach a process — a straggler then keeps the old credential for the rest of
 * its TTL, and retiring the slot underneath it is the one way this script can
 * cause a failed request.
 */
const DEFAULT_GRACE_SECONDS = 60;

const args = parseArgs({
  name: SCRIPT,
  description: "Rotate or first-provision a tenant's own Postgres login role.",
  options: {
    slug: { type: 'string' },
    all: { type: 'boolean' },
    'missing-only': { type: 'boolean' },
    'grace-seconds': { type: 'string' },
    'no-retire': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  },
});

type Target = {
  id: string;
  slug: string;
  customSubdomain: string | null;
  dbUrl: string;
  currentRole: string | null;
};

/** What step 1–4 produced, so steps 5–6 can run once for the whole batch. */
type Rotated = { target: Target; fromSlot: RoleSlot | null; toSlot: RoleSlot };

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const slug = v.slug ? String(v.slug) : null;
  const all = isYes(v.all);
  const dryRun = isYes(v['dry-run']);
  const noRetire = isYes(v['no-retire']);
  const missingOnly = isYes(v['missing-only']);
  const graceSeconds = v['grace-seconds'] ? Number(v['grace-seconds']) : DEFAULT_GRACE_SECONDS;

  if (!slug && !all) die(SCRIPT, 'pass --slug=<slug> or --all.');
  if (slug && all) die(SCRIPT, 'pass either --slug or --all, not both.');
  if (!Number.isFinite(graceSeconds) || graceSeconds < 0) {
    die(SCRIPT, `--grace-seconds must be a non-negative number, got "${v['grace-seconds']}".`);
  }

  const masterKey = parseTenantDbMasterKey(reqEnv('TENANT_DB_MASTER_KEY'));

  const rows = await controlDb.tenant.findMany({
    where: slug ? { slug } : { status: { not: 'archived' } },
    select: {
      id: true,
      slug: true,
      customSubdomain: true,
      dbUrl: true,
      dbCredentials: { select: { roleName: true } },
    },
    orderBy: { slug: 'asc' },
  });
  if (!rows.length) {
    die(SCRIPT, slug ? `no tenant with slug "${slug}".` : 'no tenants to rotate.');
  }
  const targets: Target[] = rows
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      customSubdomain: r.customSubdomain,
      dbUrl: r.dbUrl,
      currentRole: r.dbCredentials?.roleName ?? null,
    }))
    // `--missing-only` makes this a BACKFILL and nothing else: it touches a
    // tenant only if that tenant has no credential at all. That is what lets
    // the deploy run it unconditionally on every release — a fleet that is
    // already backfilled gets a no-op, and nobody has to remember the step on
    // the one release where it matters.
    .filter((t) => !missingOnly || t.currentRole === null);

  if (!targets.length) {
    // Not an error, and deliberately not a `die`: this is the steady state of
    // `--missing-only` on a healthy fleet, and the deploy calls it every time.
    log(SCRIPT, 'every tenant already has a database credential — nothing to do.');
    return;
  }

  log(
    SCRIPT,
    `${targets.length} tenant(s)${missingOnly ? ' missing a credential' : ''}; ` +
      `grace=${graceSeconds}s dryRun=${dryRun}`,
  );
  for (const t of targets) {
    const from = t.currentRole ? slotOfRole(t.id, t.currentRole) : null;
    const to = from ? otherSlot(from) : 'a';
    const state = await describeTenantRoles({ adminUrl: t.dbUrl, tenantId: t.id });
    log(
      SCRIPT,
      `  ${t.slug.padEnd(20)} ${t.currentRole ?? '(no credential — BACKFILL)'} → ` +
        `${tenantLoginRole(t.id, to)}` +
        (state.privilegeRole ? '' : '  [privilege role missing, will be created]'),
    );
  }
  if (dryRun) {
    log(SCRIPT, 'dry run: nothing changed.');
    return;
  }

  const rotated: Rotated[] = [];
  let failed = 0;
  for (const t of targets) {
    try {
      rotated.push(await rotateOne(t, masterKey));
      log(SCRIPT, `  ${t.slug.padEnd(20)} ✓ now on ${rotated[rotated.length - 1]!.toSlot}`);
    } catch (err) {
      failed += 1;
      // Deliberately non-fatal across a fleet: the tenants that succeeded are
      // already live on their new credential, and stopping would leave the rest
      // on an old one for no reason. The exit code still reports the failure.
      log(SCRIPT, `  ${t.slug.padEnd(20)} ✗ ${(err as Error).message}`);
    }
  }

  // Retire only the slots we actually moved OFF. A backfill has none.
  const retirable = rotated.filter((r) => r.fromSlot !== null);
  if (noRetire || !retirable.length) {
    if (retirable.length) {
      log(
        SCRIPT,
        `--no-retire: ${retirable.length} previous slot(s) left usable. ` +
          'Retire them later, or the rotation has not actually revoked anything.',
      );
    }
  } else {
    log(SCRIPT, `waiting ${graceSeconds}s before retiring ${retirable.length} previous slot(s)…`);
    await sleep(graceSeconds * 1000);
    for (const r of retirable) {
      try {
        await retireTenantLoginRole({
          tenantDbUrl: r.target.dbUrl,
          tenantId: r.target.id,
          slot: r.fromSlot!,
        });
        log(
          SCRIPT,
          `  ${r.target.slug.padEnd(20)} retired ${tenantLoginRole(r.target.id, r.fromSlot!)}`,
        );
      } catch (err) {
        failed += 1;
        log(SCRIPT, `  ${r.target.slug.padEnd(20)} ✗ could not retire: ${(err as Error).message}`);
      }
    }
  }

  log(SCRIPT, `done. rotated=${rotated.length} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

async function rotateOne(t: Target, masterKey: Buffer): Promise<Rotated> {
  const fromSlot = t.currentRole ? slotOfRole(t.id, t.currentRole) : null;
  if (t.currentRole && fromSlot === null) {
    // The stored role is neither `_a` nor `_b`. Rotating "to the other slot"
    // is undefined, and guessing would either clobber a live role or leave the
    // real one behind. Refuse and say what was found.
    throw new Error(
      `stored role "${t.currentRole}" is not one of this tenant's two rotation slots ` +
        `(${tenantLoginRole(t.id, 'a')} / ${tenantLoginRole(t.id, 'b')}). ` +
        'Fix the control-plane row before rotating.',
    );
  }
  const toSlot: RoleSlot = fromSlot ? otherSlot(fromSlot) : 'a';
  const password = newRuntimePassword();

  const { loginRole } = await ensureTenantRoles({
    tenantDbUrl: t.dbUrl,
    tenantId: t.id,
    activeSlot: toSlot,
    password,
  });
  // Re-grant unconditionally. On a backfill the tables were created long before
  // the privilege role existed, so the default-privilege rules cover none of
  // them — without this the new credential authenticates and then cannot read a
  // single row.
  await applyTenantRoleGrants({ tenantDbUrl: t.dbUrl, tenantId: t.id });

  const runtimeUrl = composeRuntimeUrl({ adminUrl: t.dbUrl, roleName: loginRole, password });
  await verify(runtimeUrl, t.slug);

  const sealed = sealTenantPassword({
    tenantId: t.id,
    roleName: loginRole,
    password,
    masterKey,
  });
  await controlDb.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.tenantDbCredential.upsert({
      where: { tenantId: t.id },
      create: {
        tenantId: t.id,
        roleName: sealed.roleName,
        encryptedPwd: sealed.encryptedPwd,
        encryptionKeyId: sealed.encryptionKeyId,
        encryptionNonce: sealed.encryptionNonce,
      },
      update: {
        roleName: sealed.roleName,
        encryptedPwd: sealed.encryptedPwd,
        encryptionKeyId: sealed.encryptionKeyId,
        encryptionNonce: sealed.encryptionNonce,
        rotatedAt: new Date(),
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: t.id,
        actorType: 'system',
        action: fromSlot ? 'tenant.db_credential_rotated' : 'tenant.db_credential_provisioned',
        targetType: 'tenant',
        targetId: t.id,
        // Role NAMES only. The row records which credential is live, never the
        // credential — this table is readable from the admin UI.
        beforeJson: { roleName: t.currentRole },
        afterJson: { roleName: sealed.roleName },
      },
    });
  });

  await bustResolverCache(t.slug, t.customSubdomain);
  return { target: t, fromSlot, toSlot };
}

/**
 * Open the database with the credential we are about to commit.
 *
 * A rotation that writes an unusable credential takes the library down at the
 * moment the cache expires — minutes later, with nothing on screen connecting
 * the two. Reading a migrated table proves authentication, CONNECT, schema
 * USAGE and SELECT together; `SELECT 1` would prove only the first.
 */
async function verify(runtimeUrl: string, slug: string): Promise<void> {
  const c = new PgClient({ connectionString: runtimeUrl, connectionTimeoutMillis: 10_000 });
  try {
    await c.connect();
    await c.query('SELECT id FROM tenant_settings LIMIT 1');
  } catch (err) {
    throw new Error(
      `the new credential cannot use ${slug}'s database ` +
        `(${redactDbUrl(runtimeUrl)}): ${(err as Error).message}. ` +
        'Control plane NOT updated — the tenant is still on its previous credential.',
    );
  } finally {
    await c.end().catch(() => undefined);
  }
}

/**
 * Drop the TenantResolver cache entries so every API process re-resolves and
 * picks up the new credential immediately, rather than at the end of its TTL.
 *
 * Same keys and prefix the resolver writes (`SLUG_KEY` / `SUBDOMAIN_KEY` in
 * tenant-resolver.service.ts). Best-effort by design: the grace period exists
 * precisely so a Redis that refuses this is a delay and not an outage.
 */
async function bustResolverCache(slug: string, customSubdomain: string | null): Promise<void> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, { lazyConnect: true, keyPrefix: 'lbr:', retryStrategy: () => null });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    const keys = [`tenant:slug:${slug}`];
    if (customSubdomain) keys.push(`tenant:sub:${customSubdomain}`);
    await redis.del(...keys);
  } catch (err) {
    log(
      SCRIPT,
      `  warning: could not bust the resolver cache (${(err as Error).message}). ` +
        'Processes will pick up the new credential within TENANT_CACHE_TTL_SEC; ' +
        'keep --grace-seconds above that.',
    );
  } finally {
    redis.disconnect();
  }
}

function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v || !v.trim()) die(SCRIPT, `missing required env var ${key}`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main()
  .catch((err) => {
    process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  })
  .finally(() => controlDb.$disconnect());
