/**
 * Creating, granting, retiring and dropping the per-tenant Postgres roles.
 *
 * Every statement here runs as the SUPERUSER, connected to the tenant's own
 * database, on exactly four paths: provisioning a new library, applying
 * migrations to an existing one, rotating a credential, and tearing a library
 * down. Nothing on the request path calls into this file.
 *
 * The shape, per tenant database:
 *
 *   tenant_<id>_app   NOLOGIN.  Holds every privilege. Grants are issued to it
 *                     once, and the default-privilege rules point at it so a
 *                     table created by a future migration is granted without
 *                     anybody remembering to.
 *   tenant_<id>_a     LOGIN, member of the above. One of the two rotation
 *   tenant_<id>_b     slots; exactly one is the live credential at a time, and
 *                     the other is NOLOGIN until a rotation moves onto it.
 *
 * `PUBLIC` loses CONNECT on the database and USAGE on the schema, so a role
 * that is not a member of `tenant_<id>_app` cannot reach the data even if it
 * somehow authenticates against the cluster.
 */
import { Client as PgClient } from 'pg';
import {
  ROLE_SLOTS,
  tenantLoginRole,
  tenantPrivilegeRole,
  tenantRoleNames,
  type RoleSlot,
} from './tenant-db-credentials.js';

/** Defaults for the per-role limits. Overridable so an operator can widen them. */
export const DEFAULT_ROLE_LIMITS = {
  /**
   * Ceiling on concurrent connections for ONE login role. The API's own budget
   * (`resolveTenantPoolPlan`) is well under this per tenant; the limit is here
   * so a runaway process starves one library rather than the whole cluster.
   */
  connectionLimit: 40,
  /**
   * A runtime query that runs longer than this is a bug, and a bug that holds a
   * connection is how one library takes the box down for the others. Raise it
   * per session with `SET statement_timeout` where a job genuinely needs to —
   * the setting is USERSET, so a long sweep can opt out explicitly and the
   * default stays tight for the request path.
   */
  statementTimeout: '15s',
  /** An open transaction nobody is advancing holds locks. Kill it. */
  idleInTransactionTimeout: '60s',
} as const;

export type TenantRoleLimits = {
  connectionLimit?: number;
  statementTimeout?: string;
  idleInTransactionTimeout?: string;
};

/**
 * Identifiers are derived from a normalised tenant id and interpolated into
 * DDL that cannot take parameters, so the shape is asserted at every boundary
 * rather than trusted because of where it came from.
 */
function assertIdentifier(name: string): string {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) {
    throw new Error(`Refusing to issue DDL with an unsafe identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/** A Postgres interval literal, for the two timeout settings. */
function assertInterval(value: string): string {
  if (!/^[0-9]+(ms|s|min|h)?$/.test(value.trim())) {
    throw new Error(`Refusing to set a timeout to an unparseable value: ${JSON.stringify(value)}`);
  }
  return value.trim();
}

/** Runtime passwords are hex by construction; anything else is a bug upstream. */
function assertPassword(password: string): string {
  if (!/^[0-9a-f]{32,128}$/.test(password)) {
    throw new Error(
      'Refusing to set a tenant role password that is not lowercase hex — see ' +
        'newRuntimePassword(). A password needing URL- or SQL-escaping is a defect, not a case ' +
        'to handle.',
    );
  }
  return password;
}

async function withTenantDb<T>(tenantDbUrl: string, fn: (c: PgClient) => Promise<T>): Promise<T> {
  const client = new PgClient({ connectionString: tenantDbUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function roleExists(c: PgClient, name: string): Promise<boolean> {
  const r = await c.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [name]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Create (or reconcile) the privilege role and both login slots, set the
 * password on ONE slot, and issue every grant.
 *
 * Idempotent by construction: it is called on every provision, on every
 * rotation, and by the backfill, and each of those may find any subset of the
 * roles already present.
 *
 * `activeSlot` is the slot whose password is being set. The other slot is
 * created but left NOLOGIN — it exists so the first rotation has somewhere to
 * go without needing DDL under time pressure.
 */
export async function ensureTenantRoles(args: {
  /** Superuser URL pointing at THIS tenant's database. */
  tenantDbUrl: string;
  tenantId: string;
  activeSlot: RoleSlot;
  password: string;
  limits?: TenantRoleLimits;
}): Promise<{ privilegeRole: string; loginRole: string }> {
  const dbName = new URL(args.tenantDbUrl).pathname.replace(/^\//, '');
  assertIdentifier(dbName);
  const { privilege, logins } = tenantRoleNames(args.tenantId);
  assertIdentifier(privilege);
  logins.forEach(assertIdentifier);
  const activeRole = assertIdentifier(tenantLoginRole(args.tenantId, args.activeSlot));
  const password = assertPassword(args.password);
  const limits = { ...DEFAULT_ROLE_LIMITS, ...args.limits };
  const connectionLimit = Math.max(1, Math.floor(limits.connectionLimit));
  const statementTimeout = assertInterval(limits.statementTimeout);
  const idleTxTimeout = assertInterval(limits.idleInTransactionTimeout);

  await withTenantDb(args.tenantDbUrl, async (c) => {
    const owner = (await c.query('SELECT current_user AS u')).rows[0].u as string;
    assertIdentifier(owner);

    if (!(await roleExists(c, privilege))) {
      await c.query(`CREATE ROLE "${privilege}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    }
    for (const login of logins) {
      if (!(await roleExists(c, login))) {
        // Created NOLOGIN. The active slot is given LOGIN and a password
        // below; the standby stays unusable until a rotation moves onto it,
        // so a half-finished provision never leaves a passwordless login role
        // behind.
        await c.query(`CREATE ROLE "${login}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      }
      await c.query(`GRANT "${privilege}" TO "${login}"`);
      await c.query(`ALTER ROLE "${login}" CONNECTION LIMIT ${connectionLimit}`);
      await c.query(
        `ALTER ROLE "${login}" IN DATABASE "${dbName}" SET statement_timeout = '${statementTimeout}'`,
      );
      await c.query(
        `ALTER ROLE "${login}" IN DATABASE "${dbName}" ` +
          `SET idle_in_transaction_session_timeout = '${idleTxTimeout}'`,
      );
    }

    // The password is the one value that must not reach a log or an error
    // message, so it is the one statement that is built and discarded here
    // rather than assembled by a caller.
    await c.query(`ALTER ROLE "${activeRole}" LOGIN PASSWORD '${password}'`);

    await grantOn(c, { dbName, privilege, owner });
  });

  return { privilegeRole: privilege, loginRole: activeRole };
}

/**
 * Re-issue every grant. Separate from {@link ensureTenantRoles} because it runs
 * again after every migration: `ALTER DEFAULT PRIVILEGES` only covers objects
 * created AFTER it was set, and a table created by a migration that ran before
 * the roles existed would otherwise be invisible to the runtime role forever.
 */
export async function applyTenantRoleGrants(args: {
  tenantDbUrl: string;
  tenantId: string;
}): Promise<void> {
  const dbName = new URL(args.tenantDbUrl).pathname.replace(/^\//, '');
  assertIdentifier(dbName);
  const privilege = assertIdentifier(tenantPrivilegeRole(args.tenantId));
  await withTenantDb(args.tenantDbUrl, async (c) => {
    if (!(await roleExists(c, privilege))) return;
    const owner = (await c.query('SELECT current_user AS u')).rows[0].u as string;
    await grantOn(c, { dbName, privilege, owner: assertIdentifier(owner) });
  });
}

async function grantOn(
  c: PgClient,
  ids: { dbName: string; privilege: string; owner: string },
): Promise<void> {
  const { dbName, privilege, owner } = ids;
  // Database. TEMPORARY so a session can use pg_temp; CONNECT so it can get in
  // at all. PUBLIC loses both — this is the statement that makes a stolen
  // credential for another cluster role useless against this database.
  await c.query(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`);
  await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${dbName}" TO "${privilege}"`);
  // Schema. USAGE only, deliberately NOT CREATE: every table in a tenant
  // database is created by `prisma migrate deploy` as the superuser, so the
  // runtime role having DDL rights would buy nothing and cost the ability to
  // say the runtime cannot alter the schema.
  await c.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  await c.query(`GRANT USAGE ON SCHEMA public TO "${privilege}"`);
  await c.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${privilege}"`);
  await c.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${privilege}"`);
  await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${privilege}"`);
  // …and everything a future migration creates, without a follow-up step.
  await c.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT ALL ON TABLES TO "${privilege}"`,
  );
  await c.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT ALL ON SEQUENCES TO "${privilege}"`,
  );
  await c.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO "${privilege}"`,
  );
}

/**
 * Take a login slot out of service. Existing connections survive — Postgres
 * checks the password at connect time only — which is what makes the grace
 * period in the rotation script a real one rather than a hope.
 */
export async function retireTenantLoginRole(args: {
  tenantDbUrl: string;
  tenantId: string;
  slot: RoleSlot;
}): Promise<void> {
  const role = assertIdentifier(tenantLoginRole(args.tenantId, args.slot));
  await withTenantDb(args.tenantDbUrl, async (c) => {
    if (!(await roleExists(c, role))) return;
    // NOLOGIN and a password nobody holds. Either alone would do; both mean a
    // credential captured before the rotation is dead even if someone later
    // flips LOGIN back on to debug something.
    await c.query(`ALTER ROLE "${role}" NOLOGIN`);
    await c.query(`ALTER ROLE "${role}" PASSWORD NULL`);
  });
}

/**
 * Drop every role belonging to a tenant. Call AFTER `DROP DATABASE`: the
 * database-scoped ACLs and the `ALTER ROLE … IN DATABASE` settings are removed
 * with the database, which is what lets these drops succeed without a
 * `DROP OWNED BY` sweep.
 *
 * Connects to the ADMIN database (the superuser URL as given), not the tenant's
 * — by this point the tenant's database is gone.
 */
export async function dropTenantRoles(args: {
  adminUrl: string;
  tenantId: string;
}): Promise<string[]> {
  const { privilege, logins } = tenantRoleNames(args.tenantId);
  const dropped: string[] = [];
  const client = new PgClient({ connectionString: args.adminUrl });
  await client.connect();
  try {
    // Login roles first: the privilege role cannot be dropped while it has
    // members.
    for (const name of [...logins, privilege]) {
      assertIdentifier(name);
      if (!(await roleExists(client, name))) continue;
      await client.query(`DROP ROLE IF EXISTS "${name}"`);
      dropped.push(name);
    }
  } finally {
    await client.end();
  }
  return dropped;
}

/**
 * Which slots currently exist and can log in. Used by the rotation script to
 * report state and by the isolation tests to assert the standby really is
 * unusable.
 */
export async function describeTenantRoles(args: { adminUrl: string; tenantId: string }): Promise<{
  privilegeRole: string | null;
  logins: Array<{ slot: RoleSlot; role: string; canLogin: boolean }>;
}> {
  const client = new PgClient({ connectionString: args.adminUrl });
  await client.connect();
  try {
    const privilege = tenantPrivilegeRole(args.tenantId);
    const has = await roleExists(client, privilege);
    const logins: Array<{ slot: RoleSlot; role: string; canLogin: boolean }> = [];
    for (const slot of ROLE_SLOTS) {
      const role = tenantLoginRole(args.tenantId, slot);
      const r = await client.query<{ rolcanlogin: boolean }>(
        'SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = $1',
        [role],
      );
      if (r.rowCount) logins.push({ slot, role, canLogin: r.rows[0]!.rolcanlogin });
    }
    return { privilegeRole: has ? privilege : null, logins };
  } finally {
    await client.end();
  }
}
