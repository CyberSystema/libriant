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
import { Client as PgClient } from 'pg';
import { controlDb, type Prisma } from '@libriant/db-control';
import { assertSlug, dbNameForTenant, die, isYes, log, parseArgs, urlForDb } from './_lib/cli.js';

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
    log(SCRIPT, 'applying tenant migrations…');
    await applyTenantMigrations(dbUrl);

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
    log(SCRIPT, `  dbUrl=${dbUrl.replace(/:[^:@]+@/, ':***@')}`);
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

async function applyTenantMigrations(targetUrl: string): Promise<void> {
  const { stdout, stderr } = await execFileP('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: DB_TENANT_DIR,
    env: { ...process.env, TENANT_DATABASE_URL: targetUrl },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (stdout?.trim()) process.stdout.write(stdout);
  if (stderr?.trim()) process.stderr.write(stderr);
}

main().catch(async (err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : err}\n`);
  await controlDb.$disconnect();
  process.exit(1);
});
