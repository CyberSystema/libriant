/**
 * Per-tenant Postgres runtime credentials — naming, sealing, and URL
 * composition.
 *
 * ## Why this file exists (tenant-isolation-02)
 *
 * Every tenant database used to be opened with the SAME Postgres superuser
 * role: `tenants.db_url` was `PG_SUPERUSER_URL` with the database name swapped,
 * so the only thing separating one library's records from another's was which
 * string the application happened to pick. The audit demonstrated it by
 * connecting to library B's database with the connection string held for
 * library A and counting its members.
 *
 * Now each tenant database has its own login roles, and the string the request
 * path connects with is **refused by Postgres** when pointed at any other
 * tenant's database. `assertUrlBelongsToTenant` in the API is unchanged and
 * still runs on every call — this is the second wall, not a replacement.
 *
 * ## The two URLs, which are not interchangeable
 *
 * - **Admin URL** — `tenants.db_url`. Superuser. Used ONLY to create the
 *   database, run migrations, `pg_dump`, relocate and vacuum. Never in the
 *   request path.
 * - **Runtime URL** — composed here, in-process, from the admin URL's
 *   host/port/database plus the role and password sealed in
 *   `tenant_db_credentials`. This is what `TenantPrismaService` connects with.
 *
 * A runtime URL is never persisted and never leaves the process that composed
 * it. `check:tenant-db-urls` is what keeps a future reader from reintroducing
 * the admin URL on a runtime path by accident.
 *
 * ## Why there are two login roles per tenant
 *
 * Postgres has no second-password mechanism, so a single-role rotation has an
 * unavoidable window: the instant `ALTER ROLE … PASSWORD` runs, every process
 * still holding the previous password fails to open a new connection. Two login
 * roles — `tenant_<id>_a` and `tenant_<id>_b`, both members of the privilege
 * holder `tenant_<id>_app` — remove the window entirely. Rotation writes the
 * *other* slot, repoints the control-plane row, and only then retires the one
 * it replaced. Both are valid for the grace period, which is the whole point.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** The two login-role slots a tenant alternates between when rotating. */
export const ROLE_SLOTS = ['a', 'b'] as const;
export type RoleSlot = (typeof ROLE_SLOTS)[number];

/**
 * The identifier fragment a tenant id contributes to every Postgres object
 * named after it.
 *
 * Byte-identical to `dbNameForTenant()` in scripts/_lib/cli.ts and to
 * `TenantProvisioningService.dbNameFor()`, minus the `tenant_` prefix — the DB
 * name and the role names have to agree about what a tenant id normalises to,
 * or a rotation renames a role nothing connects as.
 */
function normalizeTenantId(tenantId: string): string {
  return tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

/**
 * The NOLOGIN role that holds every privilege on the tenant database. Grants
 * are issued to it once; the login roles are members and inherit.
 */
export function tenantPrivilegeRole(tenantId: string): string {
  return `tenant_${normalizeTenantId(tenantId)}_app`;
}

/** The login role for one rotation slot. */
export function tenantLoginRole(tenantId: string, slot: RoleSlot): string {
  return `tenant_${normalizeTenantId(tenantId)}_${slot}`;
}

/** Which slot a stored role name names, or null if it names neither. */
export function slotOfRole(tenantId: string, roleName: string): RoleSlot | null {
  for (const slot of ROLE_SLOTS) {
    if (tenantLoginRole(tenantId, slot) === roleName) return slot;
  }
  return null;
}

/** The slot a rotation moves TO, given the one it is moving from. */
export function otherSlot(slot: RoleSlot): RoleSlot {
  return slot === 'a' ? 'b' : 'a';
}

/**
 * Every Postgres identifier this module produces, for the paths that need to
 * grant, revoke or drop all of them at once.
 */
export function tenantRoleNames(tenantId: string): {
  privilege: string;
  logins: readonly string[];
} {
  return {
    privilege: tenantPrivilegeRole(tenantId),
    logins: ROLE_SLOTS.map((s) => tenantLoginRole(tenantId, s)),
  };
}

/**
 * A fresh runtime password: 32 bytes, hex-encoded.
 *
 * Hex rather than base64url for the same reason `POSTGRES_PASSWORD` is
 * hex-generated in scripts/secrets.ts — the value is interpolated into a
 * `postgresql://user:pw@host/db` URL, and a character needing percent-encoding
 * is a class of bug that only shows up on the unlucky tenant.
 */
export function newRuntimePassword(): string {
  return randomBytes(32).toString('hex');
}

// --- sealing ---------------------------------------------------------------

/** The current sealing scheme. Stored per row so a future one can coexist. */
const KEY_ID = 'v1';
const GCM_TAG_BYTES = 16;
const GCM_NONCE_BYTES = 12;

export type SealedPassword = {
  roleName: string;
  encryptedPwd: Uint8Array<ArrayBuffer>;
  encryptionKeyId: string;
  encryptionNonce: Uint8Array<ArrayBuffer>;
};

/** The columns {@link openTenantPassword} needs, as Prisma returns them. */
export type SealedPasswordRow = {
  roleName: string;
  encryptedPwd: Uint8Array;
  encryptionKeyId: string;
  encryptionNonce: Uint8Array;
};

/**
 * Parse and validate the hex master key. Called once at boot (env.ts) so a
 * typo'd key fails the process rather than the first tenant request.
 */
export function parseTenantDbMasterKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('TENANT_DB_MASTER_KEY must be exactly 64 hex characters (a 32-byte key).');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * AES-256-GCM-seal a runtime password for `tenant_db_credentials`.
 *
 * The tenant id is bound in as additional authenticated data. That is not
 * decoration: without it, a control-plane write that moved one tenant's sealed
 * row onto another tenant's id would decrypt cleanly and hand out a working
 * credential for the wrong library — the very failure this whole phase exists
 * to make impossible. With it, the row simply fails to open.
 */
export function sealTenantPassword(args: {
  tenantId: string;
  roleName: string;
  password: string;
  masterKey: Buffer;
}): SealedPassword {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', args.masterKey, nonce);
  cipher.setAAD(Buffer.from(args.tenantId, 'utf8'));
  const ct = Buffer.concat([cipher.update(args.password, 'utf8'), cipher.final()]);
  return {
    roleName: args.roleName,
    // Prisma 7 types `Bytes` as `Uint8Array<ArrayBuffer>`; `Uint8Array.from`
    // copies into a plain ArrayBuffer-backed view that assigns cleanly.
    encryptedPwd: Uint8Array.from(Buffer.concat([ct, cipher.getAuthTag()])),
    encryptionKeyId: KEY_ID,
    encryptionNonce: Uint8Array.from(nonce),
  };
}

/** Open a sealed row. Throws on a tampered ciphertext or the wrong tenant. */
export function openTenantPassword(args: {
  tenantId: string;
  row: SealedPasswordRow;
  masterKey: Buffer;
}): string {
  const { row } = args;
  if (row.encryptionKeyId !== KEY_ID) {
    throw new Error(
      `tenant_db_credentials row for ${args.tenantId} was sealed with key id ` +
        `"${row.encryptionKeyId}", which this build cannot open (expected "${KEY_ID}").`,
    );
  }
  if (row.encryptedPwd.length <= GCM_TAG_BYTES) {
    throw new Error(`tenant_db_credentials ciphertext for ${args.tenantId} is truncated.`);
  }
  const tag = row.encryptedPwd.subarray(row.encryptedPwd.length - GCM_TAG_BYTES);
  const ct = row.encryptedPwd.subarray(0, row.encryptedPwd.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', args.masterKey, row.encryptionNonce);
  decipher.setAAD(Buffer.from(args.tenantId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// --- URL composition -------------------------------------------------------

/**
 * Build the RUNTIME connection string for a tenant: the admin URL's endpoint
 * and database, with the tenant's own role and password in place of the
 * superuser's.
 *
 * Everything else on the admin URL is carried over verbatim — `sslmode`,
 * `application_name`, whatever an operator has put there — because the two URLs
 * differ in exactly one thing, and a helper that quietly dropped a TLS
 * parameter while swapping credentials would be a downgrade nobody notices.
 */
export function composeRuntimeUrl(args: {
  adminUrl: string;
  roleName: string;
  password: string;
}): string {
  let u: URL;
  try {
    u = new URL(args.adminUrl);
  } catch {
    throw new Error('Cannot compose a tenant runtime URL: the stored admin URL is not a URL.');
  }
  u.username = encodeURIComponent(args.roleName);
  u.password = encodeURIComponent(args.password);
  return u.toString();
}

/**
 * Strip the password from a connection string for logging.
 *
 * Every log line, error message and metric label in this area goes through
 * here. The audit found the superuser password in a Redis value; the lesson
 * generalises — a connection string is never printed whole.
 */
export function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable database url>';
  }
}

/**
 * True when two connection strings name the same Postgres endpoint AND
 * database — i.e. one is a credential swap of the other.
 *
 * Used by the rotation script to refuse to alter a role on a host the control
 * plane no longer believes the tenant lives on.
 */
export function sameEndpointAndDatabase(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname === ub.pathname;
  } catch {
    return false;
  }
}

/**
 * Constant-time compare of two sealed ciphertexts. Only used by tests and the
 * rotation script's "did the row actually change?" assertion, but written here
 * so nobody reaches for `Buffer.equals` on a secret in a hurry.
 */
export function sealedEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
