import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client as PgClient } from 'pg';
import {
  makeTenantPrismaClient,
  disconnectTenantClient,
  seedTenantDefaults,
} from '@libriant/db-tenant';
import {
  applyTenantRoleGrants,
  composeRuntimeUrl,
  dropTenantRoles,
  ensureTenantRoles,
  newRuntimePassword,
  parseTenantDbMasterKey,
  sealTenantPassword,
  tenantLoginRole,
  type SealedPassword,
} from '@libriant/db-control';
import { loadEnv } from '../config/env.js';

const execFileP = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** repo-root/packages/db-tenant, used as the cwd for prisma migrate deploy. */
const DB_TENANT_DIR = path.resolve(HERE, '..', '..', '..', '..', 'packages', 'db-tenant');

export type TenantPlacement = {
  /** Tenant id used to compose the DB name and storage path. */
  tenantId: string;
  /** Cell that owns this tenant (currently always `cell-eu-1` in dev). */
  cellId: string;
  /**
   * The ADMIN url for this tenant's database — superuser, migration-only.
   * Stored on `tenants.db_url`. It is NOT what the request path connects with;
   * see `credential` below and `tenancy/tenant-db-url.ts`.
   */
  dbUrl: string;
  /** Storage URL for this tenant's files. */
  storageUrl: string;
  /**
   * The sealed per-tenant runtime password, ready to be written to
   * `tenant_db_credentials`.
   *
   * Returned rather than written here because that table has an FK to
   * `tenants`, and the tenant row does not exist yet — the caller owns the
   * transaction that creates both. A tenant row committed WITHOUT this
   * credential is a tenant the API will refuse to serve (fail-closed in
   * `runtimeDbUrl`), which is the correct way round: the failure is loud and
   * at signup, not silent and at superuser privilege.
   */
  credential: SealedPassword;
};

/**
 * Creates the physical resources a new tenant needs: a Postgres database,
 * the tenant schema applied, default settings seeded, and a storage URL
 * reserved.
 *
 * In MVP/dev, all tenants share one Postgres server, so `CREATE DATABASE`
 * is a control-plane raw query and migrations run via `prisma migrate
 * deploy`. The same interface stays the same when a cell points at a
 * different Postgres host later — only the URLs change.
 *
 * Lifecycle:
 *   • `dbNameFor()`     — deterministic DB name from a tenantId.
 *   • `provision()`     — full happy-path setup, returning the placement.
 *   • `teardown()`      — drop the DB (used on signup failure / cleanup).
 */
@Injectable()
export class TenantProvisioningService {
  private readonly logger = new Logger(TenantProvisioningService.name);
  private readonly env = loadEnv();

  /** `cmlxxxxxx` → `tenant_cmlxxxxxx`. Safe for Postgres identifier. */
  dbNameFor(tenantId: string): string {
    return `tenant_${tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  }

  /**
   * Full provisioning: CREATE DATABASE, apply tenant migrations, seed
   * default settings. Returns the URLs to store on `tenants.dbUrl` and
   * `tenants.storageUrl`.
   *
   * Caller should call `teardown(tenantId)` if anything downstream fails.
   */
  async provision(input: { tenantId: string; cellId: string }): Promise<TenantPlacement> {
    const dbName = this.dbNameFor(input.tenantId);
    const dbUrl = this.urlForDb(dbName);
    // `storageRoot` may be relative (the dev default is `./.dev-storage`).
    // Resolve it to an absolute path and build the file URL with
    // `pathToFileURL` so we never emit a malformed `file://./…` URL whose
    // first path segment is parsed as a host (which `fileURLToPath` rejects
    // on POSIX). Mirrors the CLI provisioner in `scripts/tenant-create.ts`.
    const storageUrl = pathToFileURL(
      path.join(path.resolve(this.env.storageRoot), input.tenantId),
    ).href;

    await this.createDatabase(dbName);
    // Roles BEFORE migrations, so `ALTER DEFAULT PRIVILEGES` is already in
    // force while `prisma migrate deploy` creates the tables — and grants
    // AFTER them too, because default privileges only cover objects created
    // after they were set and this database may already carry some.
    const credential = await this.createRuntimeRoles(input.tenantId, dbUrl);
    await this.applyTenantMigrations(dbUrl);
    await applyTenantRoleGrants({ tenantDbUrl: dbUrl, tenantId: input.tenantId });
    await this.seedDefaults(dbUrl);
    // The seed above ran as the superuser. Prove the tenant's OWN credential
    // can open the database it was just granted, here, while there is still a
    // teardown path — rather than at the first request of a library that was
    // told its signup succeeded.
    await this.verifyRuntimeCredential(input.tenantId, dbUrl, credential.password);

    return {
      tenantId: input.tenantId,
      cellId: input.cellId,
      dbUrl,
      storageUrl,
      credential: credential.sealed,
    };
  }

  /**
   * Drop the tenant's database. Used during signup-failure rollback and
   * as part of admin-level tenant deletion (a much later step).
   */
  async teardown(tenantId: string): Promise<void> {
    const dbName = this.dbNameFor(tenantId);
    const admin = new PgClient({ connectionString: this.env.pgSuperuserUrl });
    await admin.connect();
    try {
      // Terminate any lingering connections first so DROP DATABASE succeeds.
      await admin.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      this.logger.warn(`Tore down tenant DB ${dbName} for tenant ${tenantId}`);
    } finally {
      await admin.end();
    }
    // Roles are cluster-wide, so dropping the database does not remove them.
    // Left behind they accumulate for the life of the cluster and — worse —
    // a tenant id that came round again would inherit a role whose password
    // somebody else's control-plane row still seals. Dropped AFTER the
    // database, which is what removes the ACLs and per-database settings that
    // would otherwise make DROP ROLE fail.
    try {
      const dropped = await dropTenantRoles({
        adminUrl: this.env.pgSuperuserUrl,
        tenantId,
      });
      if (dropped.length) {
        this.logger.warn(`Dropped ${dropped.length} database role(s) for tenant ${tenantId}.`);
      }
    } catch (err) {
      // Never fatal: teardown is the rollback path for a signup that already
      // failed, and a leftover role is an operational annoyance while a thrown
      // error here would mask the original cause.
      this.logger.warn(
        `Could not drop database roles for tenant ${tenantId}: ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // --- internals ---------------------------------------------------------

  /**
   * Create this tenant's privilege role and its two login slots, set a fresh
   * password on slot `a`, and seal it for `tenant_db_credentials`.
   *
   * The plaintext exists only inside this call and the verification below; it
   * is never returned to the caller, never logged, and never written anywhere
   * but Postgres's own `pg_authid` and the AES-GCM ciphertext.
   */
  private async createRuntimeRoles(
    tenantId: string,
    dbUrl: string,
  ): Promise<{ sealed: SealedPassword; password: string }> {
    const password = newRuntimePassword();
    const { loginRole } = await ensureTenantRoles({
      tenantDbUrl: dbUrl,
      tenantId,
      activeSlot: 'a',
      password,
      limits: {
        connectionLimit: this.env.tenantDbConnectionLimit,
        statementTimeout: this.env.tenantDbStatementTimeout,
        idleInTransactionTimeout: this.env.tenantDbIdleTxTimeout,
      },
    });
    const sealed = sealTenantPassword({
      tenantId,
      roleName: loginRole,
      password,
      masterKey: parseTenantDbMasterKey(this.env.tenantDbMasterKey),
    });
    this.logger.log(`Created database role ${loginRole} for tenant ${tenantId}.`);
    return { sealed, password };
  }

  /**
   * Connect once as the tenant's own role and read a table only the grants make
   * readable.
   *
   * `SELECT 1` would prove authentication and nothing else — a role that can
   * log in but was granted nothing produces a database that looks fine until
   * the first query. Reading `tenant_settings`, which `seedDefaults` has just
   * written, proves CONNECT, USAGE on the schema and SELECT on a migrated
   * table in one round trip.
   */
  private async verifyRuntimeCredential(
    tenantId: string,
    dbUrl: string,
    password: string,
  ): Promise<void> {
    const runtimeUrl = composeRuntimeUrl({
      adminUrl: dbUrl,
      roleName: tenantLoginRole(tenantId, 'a'),
      password,
    });
    const probe = new PgClient({ connectionString: runtimeUrl });
    try {
      await probe.connect();
      await probe.query('SELECT id FROM tenant_settings LIMIT 1');
    } catch (err) {
      throw new Error(
        `Tenant ${tenantId} was provisioned but its own database role cannot use the ` +
          `database: ${err instanceof Error ? err.message : err}. Refusing to finish ` +
          'provisioning — the alternative is a library whose every request 500s.',
        { cause: err },
      );
    } finally {
      await probe.end().catch(() => undefined);
    }
  }

  /** Build the per-tenant ADMIN Postgres URL by swapping the DB name on the
   *  superuser URL. Migration-only — see tenancy/tenant-db-url.ts. */
  private urlForDb(dbName: string): string {
    const u = new URL(this.env.pgSuperuserUrl);
    u.pathname = `/${dbName}`;
    return u.toString();
  }

  private async createDatabase(dbName: string): Promise<void> {
    const admin = new PgClient({ connectionString: this.env.pgSuperuserUrl });
    await admin.connect();
    try {
      // CREATE DATABASE can't be parameterised; we whitelist the identifier
      // shape in dbNameFor() above to keep this safe.
      if (!/^tenant_[a-z0-9_]+$/.test(dbName)) {
        throw new Error(`Refusing to CREATE DATABASE with unsafe name: ${dbName}`);
      }
      // IF NOT EXISTS guard via lookup → CREATE so the call is idempotent.
      const existing = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
      if (existing.rowCount && existing.rowCount > 0) {
        this.logger.debug(`Database ${dbName} already exists — reusing.`);
        return;
      }
      await admin.query(`CREATE DATABASE "${dbName}" ENCODING 'UTF8'`);
      this.logger.log(`Created tenant database ${dbName}.`);
    } finally {
      await admin.end();
    }
    // Required extensions must be installed inside the new DB.
    const target = new PgClient({ connectionString: this.urlForDb(dbName) });
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

  /**
   * Apply every pending tenant migration to `targetUrl` using Prisma's
   * migrate-deploy CLI. We shell out so we benefit from Prisma's tracking
   * table (`_prisma_migrations`) and from its in-tx replay logic.
   */
  private async applyTenantMigrations(targetUrl: string): Promise<void> {
    const { stderr, stdout } = await execFileP('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: DB_TENANT_DIR,
      env: { ...process.env, TENANT_DATABASE_URL: targetUrl },
      maxBuffer: 8 * 1024 * 1024,
    });
    if (stdout) this.logger.debug(`prisma migrate deploy: ${stdout.trim()}`);
    if (stderr) this.logger.debug(`prisma migrate deploy (stderr): ${stderr.trim()}`);
  }

  /**
   * Bring the fresh tenant database to a usable state: the singleton
   * `tenant_settings` row, and the four system roles reconciled against the
   * shipped templates. Both live in `@libriant/db-tenant` so every provisioning
   * path seeds the same thing.
   */
  private async seedDefaults(targetUrl: string): Promise<void> {
    const client = makeTenantPrismaClient({ databaseUrl: targetUrl });
    try {
      // The values and the ordering (roles first and unconditionally, settings
      // only when absent) live in `@libriant/db-tenant` — this used to be one
      // of three copies of the same defaults object, beside a fourth
      // provisioning path that had none.
      await seedTenantDefaults(client);
    } finally {
      await disconnectTenantClient(client);
    }
  }
}
