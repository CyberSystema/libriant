import { sealTenantPassword, parseTenantDbMasterKey, tenantLoginRole } from '@libriant/db-control';

/**
 * A sealed per-tenant database credential, for specs that mock a `tenants` row.
 *
 * Since phase 4 every path that opens a tenant database composes its
 * connection string from `tenant_db_credentials` (tenant-isolation-02), and
 * `runtimeDbUrl` FAILS CLOSED when the row is absent. So a fixture tenant
 * without one is not "a tenant with less data" — it is a tenant the code
 * refuses to serve, and every spec that mocks one has to seal a credential.
 *
 * Sealing a real one rather than stubbing the composition keeps these specs
 * exercising the same code the request path runs, including the tenant id
 * being bound in as AAD.
 */
export const TEST_TENANT_DB_MASTER_KEY =
  'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

/** The `loadEnv()` fields `runtimeDbUrl` reads. Spread into a loadEnv mock. */
export const TEST_TENANT_DB_ENV = {
  tenantDbMasterKey: TEST_TENANT_DB_MASTER_KEY,
  /** Closed, as outside development — a spec must not pass by falling back. */
  tenantDbAllowSuperuserFallback: false,
} as const;

export function testSealedCredential(tenantId: string, password = 'ab'.repeat(32)) {
  return sealTenantPassword({
    tenantId,
    roleName: tenantLoginRole(tenantId, 'a'),
    password,
    masterKey: parseTenantDbMasterKey(TEST_TENANT_DB_MASTER_KEY),
  });
}
