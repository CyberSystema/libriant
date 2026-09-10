/**
 * Libriant — admin tenant provisioning.
 *
 * Creates a brand-new library from the command line, going further than
 * `/auth/signup`: an admin can pick the plan, billing mode, cell, and
 * locale; can set `paidUntil` for manual/contract customers; can override
 * the owner password (defaults to a generated one printed once); and the
 * whole thing is idempotent on the slug — re-running with the same slug
 * refuses cleanly rather than mid-flight half-creating duplicates.
 *
 * On failure after the physical DB was created, the script tears it down
 * so we don't leak orphan resources.
 *
 *   ENV (required):
 *     CONTROL_DATABASE_URL        — control-plane DB
 *     PG_SUPERUSER_URL            — superuser URL (used to CREATE DATABASE)
 *     TENANT_DB_MASTER_KEY        — 64 hex; seals the new library's own
 *                                   Postgres password into tenant_db_credentials
 *
 *   ENV (optional):
 *     STORAGE_ROOT                — defaults to ./.dev-storage
 *     BCRYPT_COST                 — defaults to 12
 *
 *   USAGE:
 *     pnpm tenant:create \
 *       --slug=acme \
 *       --name="Acme Public Library" \
 *       --owner-email=ops@acme.org \
 *       --owner-name="Acme Operator" \
 *       --owner-password='please-rotate' \
 *       --plan=community \
 *       --billing-mode=manual \
 *       --paid-until=2027-01-01 \
 *       --default-locale=en \
 *       --dry-run
 */
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import {
  describeSeedResult,
  disconnectTenantClient,
  makeTenantPrismaClient,
  seedTenantDefaults,
  makeTenantPrismaClientV2,
  withV2Schema,
} from '@libriant/db-tenant';
import { Client as PgClient } from 'pg';
import {
  applyTenantRoleGrants,
  composeRuntimeUrl,
  controlDb,
  dropTenantRoles,
  ensureTenantRoles,
  newRuntimePassword,
  parseTenantDbMasterKey,
  sealTenantPassword,
  type Prisma,
} from '@libriant/db-control';
import { assertSlug, dbNameForTenant, die, isYes, log, parseArgs, urlForDb } from './_lib/cli.js';
import { seedItemDefaults } from '../apps/api/src/items/item-defaults.js';
import { seedCirculationDefaults } from '../apps/api/src/policy/circulation-defaults.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_TENANT_DIR = path.resolve(HERE, '..', 'packages', 'db-tenant');

const SCRIPT = 'tenant-create';

const args = parseArgs({
  name: SCRIPT,
  description: 'Provision a brand-new tenant.',
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    'owner-email': { type: 'string' },
    'owner-name': { type: 'string' },
    'owner-password': { type: 'string' },
    'primary-email': { type: 'string' },
    'default-locale': { type: 'string' },
    plan: { type: 'string' },
    'billing-mode': { type: 'string' },
    'paid-until': { type: 'string' },
    cell: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  required: ['slug', 'name', 'owner-email', 'owner-name'] as const,
});

async function main() {
  const v = args.values as Record<string, string | boolean | undefined>;
  const slug = String(v.slug);
  const name = String(v.name);
  const ownerEmail = String(v['owner-email']).toLowerCase().trim();
  const ownerName = String(v['owner-name']);
  const primaryEmail = (v['primary-email'] ? String(v['primary-email']) : ownerEmail)
    .toLowerCase()
    .trim();
  const defaultLocale = String(v['default-locale'] ?? 'el');
  const planSlug = String(v.plan ?? 'starter');
  const billingMode = String(v['billing-mode'] ?? 'manual') as 'stripe' | 'manual';
  const paidUntilRaw = v['paid-until'] ? String(v['paid-until']) : null;
  const cellOverride = v.cell ? String(v.cell) : null;
  const dryRun = isYes(v['dry-run']);

  assertSlug(slug);
  if (!/^.+@.+\..+$/.test(ownerEmail)) {
    die(SCRIPT, `--owner-email "${ownerEmail}" does not look like an email.`);
  }
  if (billingMode !== 'manual' && billingMode !== 'stripe') {
    die(SCRIPT, `--billing-mode must be 'manual' or 'stripe', got '${billingMode}'.`);
  }
  if (paidUntilRaw && billingMode !== 'manual') {
    die(SCRIPT, '--paid-until is only meaningful with --billing-mode=manual.');
  }
  const paidUntil = paidUntilRaw ? new Date(paidUntilRaw) : null;
  if (paidUntil && Number.isNaN(paidUntil.getTime())) {
    die(SCRIPT, `--paid-until "${paidUntilRaw}" is not a valid date.`);
  }

  const password = (
    v['owner-password'] ? String(v['owner-password']) : generatePassword()
  ).toString();
  if (password.length < 12) {
    die(SCRIPT, '--owner-password must be at least 12 characters.');
  }

  // 1. Pre-flight: slug must be free + plan must exist + cell must accept.
  const slugTaken = await controlDb.tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, status: true },
  });
  if (slugTaken) {
    die(SCRIPT, `Slug "${slug}" is already used (tenant id=${slugTaken.id}). Pick another.`);
  }
  const plan = await controlDb.plan.findUnique({ where: { slug: planSlug } });
  if (!plan) die(SCRIPT, `Plan "${planSlug}" not found. List them with pnpm db:psql.`);
  if (!plan.isActive) die(SCRIPT, `Plan "${planSlug}" is not active.`);
  const cell = cellOverride
    ? await controlDb.cell.findUnique({ where: { id: cellOverride } })
    : await controlDb.cell.findFirst({
        where: { acceptsNew: true },
        orderBy: { createdAt: 'asc' },
      });
  if (!cell) {
    die(
      SCRIPT,
      cellOverride ? `Cell "${cellOverride}" not found.` : 'No accepting cell available.',
    );
  }
  if (cellOverride && !cell.acceptsNew) {
    die(SCRIPT, `Cell "${cellOverride}" is not accepting new tenants.`);
  }

  log(
    SCRIPT,
    `plan="${plan.slug}" billingMode=${billingMode} cell=${cell.id} locale=${defaultLocale} dryRun=${dryRun}`,
  );

  if (dryRun) {
    log(SCRIPT, 'dry run: validation passed; not provisioning.');
    return;
  }

  // 2. Pre-allocate the tenant id so the physical DB name is set before
  //    we touch any external resource.
  const tenantId = newCuid();
  const dbName = dbNameForTenant(tenantId);
  const dbUrl = urlForDb(reqEnv('PG_SUPERUSER_URL'), dbName);
  const storageRoot = process.env.STORAGE_ROOT ?? './.dev-storage';
  const storageUrl = pathToFileURL(path.join(path.resolve(storageRoot), tenantId)).href;

  // 3. Provision physical resources first (DB + storage dir). If the
  //    control-plane TX fails downstream, we tear these down.
  log(SCRIPT, `creating database ${dbName}…`);
  await createTenantDatabase(dbName);
  try {
    // The library's own Postgres roles, created BEFORE the migrations so the
    // default-privilege rules cover every table they make (tenant-isolation-02).
    // `dbUrl` above is the ADMIN url and is what goes on `tenants.db_url`; the
    // runtime url is composed per process from the sealed password below and is
    // never persisted anywhere.
    log(SCRIPT, `creating per-tenant database roles…`);
    const runtimePassword = newRuntimePassword();
    const { loginRole } = await ensureTenantRoles({
      tenantDbUrl: dbUrl,
      tenantId,
      activeSlot: 'a',
      password: runtimePassword,
    });
    const credential = sealTenantPassword({
      tenantId,
      roleName: loginRole,
      password: runtimePassword,
      masterKey: parseTenantDbMasterKey(reqEnv('TENANT_DB_MASTER_KEY')),
    });

    log(SCRIPT, 'applying tenant migrations…');
    await applyTenantMigrations(dbUrl);
    await applyTenantRoleGrants({ tenantDbUrl: dbUrl, tenantId });

    // The same seed `/auth/signup` runs. This script ran none at all: a library
    // provisioned from the command line started with NO `tenant_settings` row —
    // no currency, no loan period, no renewal cap, no fine rate. Measured
    // 2026-09-06: `SELECT id, currency FROM tenant_settings LIMIT 1` on a
    // CLI-created tenant returned zero rows. Signup got all of it.
    //
    // Its roles were there (the authorization migration seeds all four) but had
    // never been reconciled, so it was missing every permission key added to a
    // template since that migration was written — two, on the tenant measured.
    //
    // The values live in `@libriant/db-tenant` precisely so a fifth
    // provisioning path cannot be written without finding them.
    log(SCRIPT, 'seeding tenant defaults…');
    await seedTenantDefaultsFor({
      adminUrl: dbUrl,
      roleName: loginRole,
      password: runtimePassword,
    });

    log(SCRIPT, `ensuring storage dir ${storageRoot}/${tenantId}…`);
    await mkdir(path.join(path.resolve(storageRoot), tenantId), { recursive: true });

    // 4. Single control-plane TX: tenant row, owner user, subscription,
    //    billing account, audit event.
    const passwordHash = await bcrypt.hash(password, Number(process.env.BCRYPT_COST ?? '12'));
    await controlDb.$transaction(async (tx: Prisma.TransactionClient) => {
      const tenant = await tx.tenant.create({
        data: {
          id: tenantId,
          slug,
          name,
          defaultLocale,
          status: 'active',
          cellId: cell.id,
          dbUrl,
          storageUrl,
          primaryEmail,
        },
      });
      await tx.tenantDbCredential.create({
        data: {
          tenantId: tenant.id,
          roleName: credential.roleName,
          encryptedPwd: credential.encryptedPwd,
          encryptionKeyId: credential.encryptionKeyId,
          encryptionNonce: credential.encryptionNonce,
        },
      });
      await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: ownerEmail,
          fullName: ownerName,
          role: 'owner',
          status: 'active',
          passwordHash,
        },
      });
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          billingMode,
          status: billingMode === 'manual' ? 'active' : 'trialing',
          paidUntil: paidUntil ?? undefined,
        },
      });
      await tx.billingAccount.create({
        data: {
          tenantId: tenant.id,
          billingEmail: primaryEmail,
          billingName: name,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorType: 'system',
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: tenant.id,
          afterJson: { slug, planSlug, billingMode, cellId: cell.id },
        },
      });
    });

    log(SCRIPT, `done. tenant.id=${tenantId} slug=${slug}`);
    log(SCRIPT, `  dbUrl=${dbUrl.replace(/:[^:@]+@/, ':***@')} (admin/migration only)`);
    log(SCRIPT, `  runtime role=${loginRole}`);
    log(SCRIPT, `  storageUrl=${storageUrl}`);
    if (!v['owner-password']) {
      log(SCRIPT, `  ⚠  generated owner password (record it now): ${password}`);
    }
  } catch (err) {
    log(SCRIPT, `provisioning failed: ${(err as Error).message}`);
    log(SCRIPT, `rolling back: dropping database ${dbName}…`);
    await dropTenantDatabase(dbName).catch((e) => {
      log(SCRIPT, `  teardown warning: ${(e as Error).message}`);
    });
    // Roles are cluster-wide and outlive the database. Dropped after it, so
    // the database-scoped ACLs are already gone and DROP ROLE succeeds.
    await dropTenantRoles({ adminUrl: reqEnv('PG_SUPERUSER_URL'), tenantId }).catch((e) => {
      log(SCRIPT, `  role teardown warning: ${(e as Error).message}`);
    });
    throw err;
  } finally {
    await controlDb.$disconnect();
  }
}

// ---------- helpers --------------------------------------------------------

function reqEnv(key: string): string {
  const v = process.env[key];
  if (!v || !v.trim()) die(SCRIPT, `missing required env var ${key}`);
  return v;
}

function newCuid(): string {
  // cuid-like: 25 chars, lowercase alnum, c-prefixed. We don't need
  // strict cuid semantics here — we just want a unique short token.
  return 'c' + randomBytes(12).toString('hex');
}

function generatePassword(): string {
  // 24 url-safe chars; enough entropy without ambiguity.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(24);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    out += alphabet[bytes[i]! % alphabet.length]!;
  }
  return out;
}

async function createTenantDatabase(dbName: string): Promise<void> {
  if (!/^tenant_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Refusing to CREATE DATABASE with unsafe name: ${dbName}`);
  }
  const admin = new PgClient({ connectionString: reqEnv('PG_SUPERUSER_URL') });
  await admin.connect();
  try {
    const existing = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (!existing.rowCount) {
      await admin.query(`CREATE DATABASE "${dbName}" ENCODING 'UTF8'`);
    }
  } finally {
    await admin.end();
  }
  const target = new PgClient({
    connectionString: urlForDb(reqEnv('PG_SUPERUSER_URL'), dbName),
  });
  await target.connect();
  try {
    await target.query('CREATE EXTENSION IF NOT EXISTS unaccent');
    await target.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await target.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await target.query('CREATE EXTENSION IF NOT EXISTS citext');
    // The 2.0 baseline needs both, and listing them in the Prisma datasource
    // is not enough: this block runs BEFORE any migration, so an extension
    // named only there is missing at the moment the baseline tries to use it.
    // btree_gist is what makes the calendar and booking EXCLUDE constraints
    // possible at all.
    await target.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await target.query('CREATE EXTENSION IF NOT EXISTS btree_gin');
  } finally {
    await target.end();
  }
}

async function dropTenantDatabase(dbName: string): Promise<void> {
  const admin = new PgClient({ connectionString: reqEnv('PG_SUPERUSER_URL') });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

/**
 * Seed the settings row + system roles, and say what it did.
 *
 * Through the tenant's OWN runtime credential, not the superuser url the rest
 * of this script provisions with (tenant-isolation-02). Two reasons, and the
 * second is the useful one: the role and its grants exist by this point, so
 * there is no reason to reach for the superuser — and a seed that succeeds is
 * proof the credential can actually read and write the database it was just
 * granted. `TenantProvisioningService` runs a dedicated probe for that on the
 * signup path; this script had neither the probe nor the seed.
 */
async function seedTenantDefaultsFor(credential: {
  adminUrl: string;
  roleName: string;
  password: string;
}): Promise<void> {
  // Composed AT the call to `makeTenantPrismaClient`, not passed in as an
  // opaque string: `check:tenant-db-urls` reads this line, and a url arriving
  // through a parameter is one it cannot tell from the superuser's.
  const client = makeTenantPrismaClient({
    databaseUrl: composeRuntimeUrl(credential),
    maxPoolSize: 1,
  });
  try {
    log(SCRIPT, `  ${describeSeedResult(await seedTenantDefaults(client))}`);
  } finally {
    await disconnectTenantClient(client);
  }

  // THE 2.0 HALF, which this script did not have. Phase 13's provisioning
  // service says "every provisioning path seeds the same thing" and then seeded
  // the circulation rows on the signup path only, so a library created with this
  // script got the 2.0 tables and none of their rows: it could not lend
  // (`NO_MATCHING_RULE` at the desk) and, from phase 15, could not catalogue
  // either — `items` has five NOT NULL foreign keys and nothing to point them
  // at. Closed here rather than left as a second, quieter provisioning path.
  // Composed AT the call, like the 1.0 client above — `check:tenant-db-urls`
  // reads this line, and a url arriving through anything but a bare
  // `composeRuntimeUrl(...)` is one it cannot tell from the superuser's. NOT
  // wrapped in `withV2Schema`: `makeTenantPrismaClientV2` sets `schema: lbr2` on
  // its own adapter, so wrapping the url would be the second half of a job
  // already done — and it is what made this gate fail.
  const clientV2 = makeTenantPrismaClientV2({
    databaseUrl: composeRuntimeUrl(credential),
    maxPoolSize: 1,
  });
  try {
    const now = new Date();
    const items = await seedItemDefaults(clientV2 as never, now);
    const circulation = await seedCirculationDefaults(clientV2 as never, now);
    log(
      SCRIPT,
      `  2.0 defaults: ${items ? 'branch, location, item type and material type seeded' : 'org rows already present'}; ` +
        `${circulation ? 'five policies and the wildcard rule seeded' : 'circulation rules already present'}`,
    );
  } finally {
    await clientV2.$disconnect();
  }
}

async function applyTenantMigrations(targetUrl: string): Promise<void> {
  // Both folders. The 2.0 baseline lives in its own Postgres schema with its own
  // `_prisma_migrations`; a tenant that gets only the 1.0 folder is a database
  // every 2.0 service fails against at its first query.
  await deployOneFolder(targetUrl, []);
  await deployOneFolder(withV2Schema(targetUrl), ['--config', 'prisma-v2.config.ts']);
}

async function deployOneFolder(targetUrl: string, extra: string[]): Promise<void> {
  const { stdout, stderr } = await execFileP(
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy', ...extra],
    {
      cwd: DB_TENANT_DIR,
      env: { ...process.env, TENANT_DATABASE_URL: targetUrl },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (stdout?.trim()) process.stdout.write(stdout);
  if (stderr?.trim()) process.stderr.write(stderr);
}

main().catch(async (err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  await controlDb.$disconnect();
  process.exit(1);
});
