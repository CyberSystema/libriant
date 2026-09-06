import { Logger } from '@nestjs/common';
import {
  composeRuntimeUrl,
  openTenantPassword,
  parseTenantDbMasterKey,
  type SealedPasswordRow,
} from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import type { TenantContext } from './tenant-context.js';

/**
 * The one place a tenant's RUNTIME connection string is produced.
 *
 * ## Two URLs, one of which is a superuser credential
 *
 * `tenants.db_url` is the **admin** URL. It carries the Postgres superuser and
 * is the credential the audit dumped out of Redis and used to read another
 * library's members (tenant-isolation-02/03). Since phase 4 it is used for
 * four things only — `CREATE DATABASE`, `prisma migrate deploy`, `pg_dump` and
 * relocate/vacuum — none of which are on a request path.
 *
 * Everything else composes the **runtime** URL here: the same host, port and
 * database, with the tenant's own login role and its sealed password. That
 * string is refused by Postgres against any other tenant's database, so the
 * demonstration in the audit no longer reproduces even with the string in hand.
 *
 * `check:tenant-db-urls` is what stops the next reader reintroducing the admin
 * URL on a runtime path: reading `.dbUrl` anywhere outside a short, reasoned
 * allowlist fails the build, and this file is on it.
 */
const logger = new Logger('TenantDbUrl');

/** The credential columns {@link runtimeDbUrl} needs. */
export const TENANT_CREDENTIAL_SELECT = {
  roleName: true,
  encryptedPwd: true,
  encryptionKeyId: true,
  encryptionNonce: true,
} as const;

/**
 * The tenant columns any caller that intends to OPEN a tenant database must
 * select. Named so a reviewer can tell at the call site which of the two URLs
 * the query is after.
 */
export const TENANT_RUNTIME_SELECT = {
  id: true,
  slug: true,
  dbUrl: true,
  dbCredentials: { select: TENANT_CREDENTIAL_SELECT },
} as const;

export type TenantRuntimeRow = {
  id: string;
  dbUrl: string;
  dbCredentials: SealedPasswordRow | null;
};

/**
 * The master key, parsed once. `loadEnv()` has already validated the hex at
 * boot; this only avoids re-parsing it on every cache miss.
 */
let cachedKey: Buffer | null = null;
function masterKey(): Buffer {
  cachedKey ??= parseTenantDbMasterKey(loadEnv().tenantDbMasterKey);
  return cachedKey;
}

/** Reset for tests that swap the env between cases. */
export function __resetTenantDbKeyCache(): void {
  cachedKey = null;
}

/** Warned-about tenants, so a backfill window logs once per tenant, not once per request. */
const warned = new Set<string>();

/**
 * Compose the runtime connection string for a tenant.
 *
 * Fails CLOSED when the tenant has no sealed credential and
 * `TENANT_DB_ALLOW_SUPERUSER_FALLBACK` is off — which is the default outside
 * development. Serving a library over the superuser URL is not a degraded
 * mode, it is the defect; a 500 that names the backfill command is the honest
 * outcome, and there are no libraries in production to be surprised by it.
 *
 * The thrown message carries the tenant id and the role name only. Never a URL:
 * this error lands in the same log the audit found a password in.
 */
export function runtimeDbUrl(row: TenantRuntimeRow): string {
  if (!row.dbCredentials) {
    const env = loadEnv();
    if (!env.tenantDbAllowSuperuserFallback) {
      throw new Error(
        `Tenant ${row.id} has no row in tenant_db_credentials, so it has no runtime database ` +
          'role of its own. Refusing to open its database with the superuser URL — that is ' +
          'tenant-isolation-02, and it is the thing this credential exists to prevent. ' +
          'Run `pnpm tenant:rotate-db-creds --all` to provision the missing roles, or set ' +
          'TENANT_DB_ALLOW_SUPERUSER_FALLBACK=true for the length of that backfill.',
      );
    }
    if (!warned.has(row.id)) {
      warned.add(row.id);
      logger.warn(
        `Tenant ${row.id} has no per-tenant database role; falling back to the superuser URL ` +
          'because TENANT_DB_ALLOW_SUPERUSER_FALLBACK is set. This tenant has NO ' +
          'database-level isolation. Run `pnpm tenant:rotate-db-creds --all`.',
      );
    }
    return row.dbUrl;
  }
  const password = openTenantPassword({
    tenantId: row.id,
    row: row.dbCredentials,
    masterKey: masterKey(),
  });
  return composeRuntimeUrl({
    adminUrl: row.dbUrl,
    roleName: row.dbCredentials.roleName,
    password,
  });
}

/**
 * The ADMIN url, named out loud.
 *
 * There is nothing to compute here — it is `row.dbUrl` — and that is exactly
 * why it exists: a caller that genuinely needs the superuser (migrations,
 * `pg_dump`, relocate) says so at the call site, and the gate's allowlist has
 * one line per such caller instead of a repository-wide guess.
 */
export function adminDbUrl(row: { dbUrl: string }): string {
  return row.dbUrl;
}

/**
 * The full {@link TenantContext} shape, plus the sealed credential.
 *
 * Every background sweep resolves its own tenants (there is no HTTP request to
 * hang a resolver off), and each of them used to carry its own copy of this
 * column list with `dbUrl: true` in the middle of it. One list, one
 * composition function: a sweep cannot now open a tenant database over the
 * superuser URL by copying the select that was next to it.
 */
export const TENANT_CONTEXT_SELECT = {
  id: true,
  slug: true,
  name: true,
  defaultLocale: true,
  status: true,
  dbUrl: true,
  storageUrl: true,
  customSubdomain: true,
  tags: true,
  dbCredentials: { select: TENANT_CREDENTIAL_SELECT },
} as const;

export type TenantContextRow = Omit<TenantContext, 'resolvedFrom'> & {
  dbCredentials: SealedPasswordRow | null;
};

/**
 * Turn a {@link TENANT_CONTEXT_SELECT} row into a context whose `dbUrl` is the
 * tenant's own runtime credential — the same transformation
 * `TenantResolverService` applies on the request path, so a sweep and a request
 * open the identical connection.
 */
export function tenantContextFrom(
  row: TenantContextRow,
  resolvedFrom: TenantContext['resolvedFrom'] = 'path',
): TenantContext {
  const { dbCredentials, ...rest } = row;
  return {
    ...rest,
    dbUrl: runtimeDbUrl({ id: row.id, dbUrl: row.dbUrl, dbCredentials }),
    resolvedFrom,
  };
}
