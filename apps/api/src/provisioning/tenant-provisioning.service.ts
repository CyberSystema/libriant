import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client as PgClient } from 'pg';
import { makeTenantPrismaClient, disconnectTenantClient } from '@libriant/db-tenant';
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
  /** Postgres URL pointing at the freshly provisioned tenant DB. */
  dbUrl: string;
  /** Storage URL for this tenant's files. */
  storageUrl: string;
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
    const storageUrl = `file://${this.env.storageRoot}/${input.tenantId}`;

    await this.createDatabase(dbName);
    await this.applyTenantMigrations(dbUrl);
    await this.seedDefaults(dbUrl);

    return { tenantId: input.tenantId, cellId: input.cellId, dbUrl, storageUrl };
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
  }

  // --- internals ---------------------------------------------------------

  /** Build the per-tenant Postgres URL by swapping the DB name on the
   *  superuser URL. Keeps host/user/password aligned. */
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

  /** Insert the singleton `tenant_settings` row with sensible defaults. */
  private async seedDefaults(targetUrl: string): Promise<void> {
    const client = makeTenantPrismaClient({ databaseUrl: targetUrl });
    try {
      const existing = await client.tenantSetting.findUnique({ where: { id: 1 } });
      if (existing) return;
      await client.tenantSetting.create({
        data: {
          id: 1,
          currency: 'EUR',
          loanPeriodDays: 14,
          maxRenewals: 2,
          finePerDayCents: 10,
          fineCapCents: 500,
          holdPickupHours: 48,
          maxActiveLoans: 0,
          defaultLocale: 'el',
        },
      });
    } finally {
      await disconnectTenantClient(client);
    }
  }
}
